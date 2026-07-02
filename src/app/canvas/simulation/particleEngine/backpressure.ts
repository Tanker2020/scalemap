// ─── Backpressure / concurrency state ──────────────────────────────────────────
// Owns the in-flight synchronous request thread pool (request-edge thread pool model), the
// connection pool tracking, and the lambda warm-instance maps. Moved verbatim out of
// particleEngine.ts (Task 0 — pure code motion, no behavior change). The release scheduling
// below is still the original wall-clock `setTimeout` model — replacing it with a simulated-time
// scheduler (`scheduleRelease`/`drainScheduledReleases`) is a follow-up task (C2), not this one.

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

// Release one worker thread immediately (fast-fail 503 / drop path, or after latency elapses via
// the still-buggy setTimeout below — moved verbatim, not fixed in this task).
export function releaseWorkerNow(nodeId: string): void {
  _activeWorkers.set(nodeId, Math.max(0, (_activeWorkers.get(nodeId) ?? 1) - 1))
}

// Schedule a worker-thread release after `delayMs` wall-clock ms (scaled by `speed`). This is
// the original (buggy) setTimeout-based model, moved verbatim — see module comment above.
export function scheduleWorkerRelease(nodeId: string, delayMs: number, speed: number): void {
  setTimeout(() => {
    _activeWorkers.set(nodeId, Math.max(0, (_activeWorkers.get(nodeId) ?? 1) - 1))
  }, delayMs / speed)
}

// Acquire one connection slot for `nodeId`, capped at `max`. Returns true if acquired.
export function acquireConnection(nodeId: string, max: number): boolean {
  const active = _activeConnections.get(nodeId) ?? 0
  if (active >= max) return false
  _activeConnections.set(nodeId, active + 1)
  return true
}

// Schedule a connection-pool release after `delayMs` wall-clock ms (scaled by `speed`). Moved
// verbatim from particleEngine.ts's connection-pool check — original (buggy) setTimeout model.
export function scheduleConnectionRelease(nodeId: string, delayMs: number, speed: number): void {
  setTimeout(() => {
    _activeConnections.set(nodeId, Math.max(0, (_activeConnections.get(nodeId) ?? 1) - 1))
  }, delayMs / speed)
}

export function clearBackpressureState(): void {
  _activeWorkers.clear()
  _activeConnections.clear()
  _warmInstances.clear()
  _warmLastActivity.clear()
}
