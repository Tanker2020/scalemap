// ─── Backpressure / concurrency state ──────────────────────────────────────────
// Owns the in-flight synchronous request thread pool (request-edge thread pool model), the
// connection pool tracking, and the lambda warm-instance maps. Moved verbatim out of
// particleEngine.ts (Task 0 — pure code motion, no behavior change).
//
// Release scheduling (C2 fix): every pool/concurrency release used to be scheduled via wall-clock
// `setTimeout(..., delay / _speed)`, never cancelled. That broke three ways: releases kept firing
// while the simulation was paused (setTimeout doesn't know about pause state), mid-flight `_speed`
// changes didn't rescale an already-scheduled release, and stopSimulation/startSimulation cleared
// the counters but not the pending timers, so a stale timer from a previous run could decrement a
// fresh run's counters for a node id that exists in both. Fixed by replacing setTimeout with an
// in-memory list of pending releases keyed on simulated time (`_simulatedTimeMs`), drained once per
// frame from the main rAF loop via `drainScheduledReleases` — the same drain-once-per-frame pattern
// the file already uses for `_retryQueue`. `_simulatedTimeMs` already advances at the `_speed`-scaled
// rate elsewhere in the loop, so scheduling releases in simulated-ms is speed-correct and pause-safe
// by construction; no `/ _speed` division belongs here anymore.

// In-flight synchronous request threads held at source nodes (request-edge thread pool model)
const _activeWorkers = new Map<string, number>()

// Connection pool tracking (7a)
const _activeConnections = new Map<string, number>()

// Lambda warm instance tracking (7b)
const _warmInstances    = new Map<string, number>()  // nodeId → warm count
const _warmLastActivity = new Map<string, number>()  // nodeId → last request ts

export function getActiveWorkers(nodeId: string): number {
  return _activeWorkers.get(nodeId) ?? 0
}

export function setActiveWorkers(nodeId: string, count: number): void {
  _activeWorkers.set(nodeId, count)
}

export function getActiveConnections(nodeId: string): number {
  return _activeConnections.get(nodeId) ?? 0
}

export function setActiveConnections(nodeId: string, count: number): void {
  _activeConnections.set(nodeId, count)
}

export function getWarmInstances(nodeId: string): number {
  return _warmInstances.get(nodeId) ?? 0
}

export function setWarmInstances(nodeId: string, count: number): void {
  _warmInstances.set(nodeId, count)
}

export function getWarmLastActivity(nodeId: string): number {
  return _warmLastActivity.get(nodeId) ?? 0
}

export function setWarmLastActivity(nodeId: string, ts: number): void {
  _warmLastActivity.set(nodeId, ts)
}

// Acquire up to `n` worker threads for `nodeId`, capped at `maxThreads`. Mirrors the thread-pool
// gate previously inlined in spawnParticles: callers that find `active >= maxThreads` before
// calling should treat the acquisition as rejected (this function does not itself signal
// rejection — see spawnParticles's own capacity check, moved verbatim alongside this call).
export function acquireWorkers(nodeId: string, n: number, maxThreads: number): number {
  const active = _activeWorkers.get(nodeId) ?? 0
  const acquired = Math.min(Math.max(0, maxThreads - active), n)
  _activeWorkers.set(nodeId, Math.min(maxThreads, active + acquired))
  return acquired
}

// Release one worker thread immediately (fast-fail 503 / drop path, or after simulated-latency
// elapses via scheduleWorkerRelease below).
export function releaseWorkerNow(nodeId: string): void {
  _activeWorkers.set(nodeId, Math.max(0, (_activeWorkers.get(nodeId) ?? 1) - 1))
}

// Acquire one connection slot for `nodeId`, capped at `max`. Returns true if acquired.
export function acquireConnection(nodeId: string, max: number): boolean {
  const active = _activeConnections.get(nodeId) ?? 0
  if (active >= max) return false
  _activeConnections.set(nodeId, active + 1)
  return true
}

// Release one connection slot immediately.
export function releaseConnectionNow(nodeId: string): void {
  _activeConnections.set(nodeId, Math.max(0, (_activeConnections.get(nodeId) ?? 1) - 1))
}

// ─── Simulated-time release scheduler ──────────────────────────────────────────
// Unsorted array; drained via linear scan each frame — release volume per frame is small
// (bounded by MAX_PARTICLES) so a full min-heap is unnecessary overhead here.

type ReleaseKind = 'worker' | 'connection' | 'generic'

interface ScheduledRelease {
  nodeId: string
  kind: ReleaseKind
  fireAtSimMs: number
  onRelease?: () => void // used by 'generic' releases whose target state lives outside this module
}

const _scheduledReleases: ScheduledRelease[] = []

// Schedule a worker-thread release once simulated time reaches `simNowMs + delayMs`. `delayMs` is
// a simulated-time duration (already speed-scaled by the caller's use of `_simulatedTimeMs`) — do
// not further divide by `_speed` here.
export function scheduleWorkerRelease(nodeId: string, delayMs: number, simNowMs: number): void {
  _scheduledReleases.push({ nodeId, kind: 'worker', fireAtSimMs: simNowMs + delayMs })
}

// Schedule a connection-pool release once simulated time reaches `simNowMs + delayMs`.
export function scheduleConnectionRelease(nodeId: string, delayMs: number, simNowMs: number): void {
  _scheduledReleases.push({ nodeId, kind: 'connection', fireAtSimMs: simNowMs + delayMs })
}

// Schedule an arbitrary release callback once simulated time reaches `simNowMs + delayMs`. Used by
// particleEngine.ts for pool/concurrency state that lives outside this module (e.g. the
// least-active-connections `_lbActiveRequests` counter and lambda `nodeConcurrency`), so those call
// sites get the same pause/speed-safe, leak-free scheduling without this module importing the
// main loop's state.
export function scheduleGenericRelease(nodeId: string, delayMs: number, simNowMs: number, onRelease: () => void): void {
  _scheduledReleases.push({ nodeId, kind: 'generic', fireAtSimMs: simNowMs + delayMs, onRelease })
}

// Drain every pending release whose scheduled simulated time has been reached. Called once per
// frame from the main rAF loop, right after `_simulatedTimeMs` advances and before spawnParticles
// runs — mirrors the existing processRetryQueue drain-then-spawn ordering.
export function drainScheduledReleases(simNowMs: number): void {
  for (let i = _scheduledReleases.length - 1; i >= 0; i--) {
    const r = _scheduledReleases[i]
    if (r.fireAtSimMs > simNowMs) continue
    if (r.kind === 'worker') releaseWorkerNow(r.nodeId)
    else if (r.kind === 'connection') releaseConnectionNow(r.nodeId)
    else r.onRelease?.()
    _scheduledReleases.splice(i, 1)
  }
}

export function clearBackpressureState(): void {
  _activeWorkers.clear()
  _activeConnections.clear()
  _warmInstances.clear()
  _warmLastActivity.clear()
  _scheduledReleases.length = 0 // critical fix — wipes pending releases so a stale one from a
                                 // previous run cannot fire and decrement a fresh run's counters
}
