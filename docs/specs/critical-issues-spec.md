# Critical Issues — Spec & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to work this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This document must be executed FIRST**, before [`warning-issues-spec.md`](./warning-issues-spec.md) or [`optimization-issues-spec.md`](./optimization-issues-spec.md). Task 0 below performs a file split that the other two specs assume already exists. Do not start those specs until Task 0 has merged.

**Goal:** Fix three critical stability/correctness bugs in the simulation engine (GitHub issues #1, #2, #3 — labeled `critical`), and split `particleEngine.ts` into sub-modules first so this fix (and the 13 warning/optimization fixes queued behind it) don't all collide in the same 2,617-line file.

**Architecture:** All three bugs live in `src/app/canvas/simulation/particleEngine.ts`, the `requestAnimationFrame` particle loop described in `CLAUDE.md` §"Simulation particles". Per `docs/module-boundaries.md` §1B, this file is already flagged as **"the highest-conflict area in the repo"** with an explicit recommendation to split it before more than one person (or agent) works there concurrently. That threshold is now crossed — three severity tracks, 14 of 16 total issues, all land in this one file. Task 0 executes the split module-boundaries.md already prescribes; Tasks 1–3 land in the resulting sub-modules.

**Tech Stack:** TypeScript, Vitest (configured, currently zero test files in the repo — this plan's tests will be the first).

## Global Constraints

- No new npm dependencies.
- `npm run build` (tsc + vite build) must pass after every task.
- Public API of `particleEngine.ts` (`startSimulation`, `stopSimulation`, `setCallbacks`, and anything imported by `SimulationOverlay.tsx`, `BaseNode.tsx`, `RequestInspector.tsx`, `PlaybackScrubber.tsx`) must not change signature. Internal extraction only.
- Simulation-time semantics (`_simulatedTimeMs`, not wall-clock) must be preserved/extended, per the existing convention documented at `particleEngine.ts:392-395`.
- Every new file gets a co-located `*.test.ts` using Vitest + `@testing-library/react` (already installed, per `package.json`).
- Follow the append-only convention for hub files (`nodeConfig.ts`, `theme.ts`, `simulation.store.ts`) per `docs/module-boundaries.md` §2 — none of these three tasks should need to touch them.

---

## Merge-Conflict Prevention Strategy

`docs/module-boundaries.md` §1B already names the target decomposition:

> `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, `particleEngine/chaos.ts`, `particleEngine/tokenBuckets.ts` — each exporting pure functions the main rAF loop calls.

This plan implements exactly that (minus `tokenBuckets.ts` — no current issue touches token buckets; do not create a speculative module for it). Once split:

| New file | Owns | Fixes landing here |
|---|---|---|
| `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` | `CircuitBreakerEntry`, `getBreaker`, `checkBreakerTransition`, force-open/reset logic | **C1** (this doc), W5 (warning doc, reads this module) |
| `src/app/canvas/simulation/particleEngine/backpressure.ts` | `_activeWorkers`, `_activeConnections`, lambda concurrency, thread-pool acquire/release, the new simulated-time release scheduler | **C2** (this doc), W1 (warning doc) |
| `src/app/canvas/simulation/particleEngine/chaos.ts` | `effectiveMultiplier`/`trafficMultiplier` split, spike/chaos state, `ChaosEntry` | W2 (warning doc), O1 (optimization doc) |
| `particleEngine.ts` (remainder) | rAF loop, `spawnParticles`, `handleParticleArrival`, `updateAllNodeMetrics` orchestration, `buildSnapshot` | **C3** (this doc), W3/W4 (warning doc), O3/O4/O5/O6 (optimization doc) |

Because Task 0 is a pure extraction (no behavior change), it is **not parallelized** — one agent, one PR, reviewed and merged before anything else touches the file. Tasks 1–3 touch disjoint regions (a different new file each, plus one narrow edit to the `particleEngine.ts` remainder for C3) and **can run as parallel subagents** once Task 0 has merged.

**Cross-document coordination note (read this before starting the Warning/Optimization docs):**
- The Warning doc's W1 lands in `backpressure.ts` right after this doc's C2 — sequence W1 after C2 merges, don't run them concurrently against the same new file on day one.
- The Warning doc's W4 and the Optimization doc's O3 both touch the utilization/health block that remains in `particleEngine.ts` (`updateAllNodeMetrics`) — Optimization must not start O3 until Warning's W4 has merged.
- The Optimization doc's O5 touches `spawnParticles`, which this doc's C3 also touches — O5 must start after C3 merges, not in parallel with it.

---

### Task 0: Split `particleEngine.ts` into sub-modules (pure refactor)

**Files:**
- Create: `src/app/canvas/simulation/particleEngine/circuitBreakers.ts`
- Create: `src/app/canvas/simulation/particleEngine/backpressure.ts`
- Create: `src/app/canvas/simulation/particleEngine/chaos.ts`
- Modify: `src/app/canvas/simulation/particleEngine.ts` (remove extracted code, import from the three new files)
- Modify: `docs/module-boundaries.md` (update §1B to show the split has landed, not just been recommended)

**Interfaces:**
- `circuitBreakers.ts` exports: `interface CircuitBreakerEntry { state: CircuitState; openedAt: number; errorWindow: number[] }`, `getBreaker(edgeId: string): CircuitBreakerEntry`, `checkBreakerTransition(edgeId: string, now: number): CircuitState`, `forceOpenBreakersForNode(nodeId: string, edges: Edge<EdgeData>[], now: number): void`, `resetBreakersIfRecovered(nodeId: string, edges: Edge<EdgeData>[], now: number): void`, `clearBreakers(): void` (called from `stopSimulation`/`startSimulation`).
- `backpressure.ts` exports: `acquireWorkers(nodeId: string, n: number, maxThreads: number): number` (returns actually-acquired count), `scheduleRelease(nodeId: string, kind: 'worker' | 'connection' | 'lambda', delayMs: number, simNowMs: number): void`, `drainScheduledReleases(simNowMs: number): void` (called once per frame from the main loop), `getActiveWorkers(nodeId: string): number`, `getActiveConnections(nodeId: string): number`, `clearBackpressureState(): void`.
- `chaos.ts` exports (this task only *moves* the existing `effectiveMultiplier`, unchanged — W2 in the Warning doc is the one that splits it into pure/impure halves): `effectiveMultiplier(now: number, trafficMode: TrafficMode): number`, `clearChaosState(): void`.
- Consumes: nothing new — this is pure code motion from `particleEngine.ts`.
- Produces: the three module boundaries every subsequent task (C1, C2, W1, W2, W5, O1) depends on.

- [ ] **Step 1: Read the full current source of the four state/logic clusters before moving anything**

Run `codegraph explore "CircuitBreakerEntry getBreaker checkBreakerTransition _activeWorkers _activeConnections trackRequest effectiveMultiplier _chaosFailures _spikeNextAt"` (or open `particleEngine.ts` directly) and note every call site of each symbol — the "Blast radius" section of the codegraph output lists caller counts; confirm none are missed before deleting code from `particleEngine.ts`.

- [ ] **Step 2: Create `circuitBreakers.ts`**

Move `CircuitBreakerEntry` (currently `particleEngine.ts:46-50`), the `_circuitBreakers` map (currently `:137`), `getBreaker` (`:636`), `checkBreakerTransition` (`:680`), and the force-open loop currently inlined in `updateAllNodeMetrics` around `:1934-1947` (extract it into `forceOpenBreakersForNode`) and the periodic recovery scan currently inlined around `:2072` (extract into `resetBreakersIfRecovered`). Import `CircuitState` from `../../../store/simulation.store` as it does today. Add a `clearBreakers()` that empties `_circuitBreakers`, called from both `startSimulation` and `stopSimulation` in `particleEngine.ts`.

- [ ] **Step 3: Create `backpressure.ts`**

Move `_activeWorkers` (`:107`), `_activeConnections` (`:411`), the lambda warm-instance maps (`_warmInstances`, `_warmLastActivity`, `:427-429`), and the acquire/release logic currently spread across `trackRequest` (`:729`) and the release call sites (`:935`, `:982`, `:1294`, `:1350`, `:1386` per issue #4/#2's "Where" references — verify exact current line numbers with `codegraph explore "trackRequest THREAD_POOL_TYPES"` since this plan's C2/W1 fixes change this file's internals anyway). Do not change behavior yet — this step only moves the existing (buggy) `setTimeout`-based release code verbatim; C2 (Task 2 below) is what fixes the scheduling model. Add `clearBackpressureState()` wired into `startSimulation`/`stopSimulation`.

- [ ] **Step 4: Create `chaos.ts`**

Move `effectiveMultiplier` (`:569`), `_spikeNextAt`/`_spikeEndAt` (`:398-399`), `ChaosEntry`/`_chaosFailures`/`_chaosNextFailAt` (`:401-408`). Add `clearChaosState()` wired into `startSimulation`/`stopSimulation`.

- [ ] **Step 5: Update `particleEngine.ts` imports and call sites**

Replace the moved code with `import { ... } from './particleEngine/circuitBreakers'` etc. Call `clearBreakers()`, `clearBackpressureState()`, `clearChaosState()` from `stopSimulation` (`:2524`) alongside the existing map-clearing.

- [ ] **Step 6: Typecheck and build**

Run: `npm run build`
Expected: no TypeScript errors, no missing-import errors.

- [ ] **Step 7: Manual smoke test**

Run: `npm run tauri dev`
Load any vault template (Toolbar → Templates), start a simulation, confirm particles animate, metrics update, and circuit-breaker/chaos behavior looks unchanged from before the split (this is a refactor — nothing should look different yet).

- [ ] **Step 8: Update `docs/module-boundaries.md`**

Edit §1B's table to list the four files (`particleEngine.ts`, `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, `particleEngine/chaos.ts`) in place of the single-file row, and change the "Recommendation" sentence from future tense ("if more than one person... split") to past tense describing the landed layout. Update the fan-in note if any of the new files are now imported directly by non-`particleEngine.ts` code (they shouldn't be yet — main loop still re-exports what it needs).

- [ ] **Step 9: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/circuitBreakers.ts src/app/canvas/simulation/particleEngine/backpressure.ts src/app/canvas/simulation/particleEngine/chaos.ts docs/module-boundaries.md
git commit -m "refactor: split particleEngine.ts into circuitBreakers/backpressure/chaos modules"
```

---

### Task 1: Fix C1 — circuit breakers on config-less node types latch open forever

**GitHub issue:** #1 — `[C1] Circuit breakers on config-less node types latch open forever`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` (created in Task 0)
- Test: `src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts`

**Interfaces:**
- Consumes: `CircuitBreakerEntry`, `getBreaker(edgeId)` from Task 0.
- Produces: `forceOpenBreakersForNode` and `resetBreakersIfRecovered` must now agree on when a force-opened, config-less breaker can close — anything in `particleEngine.ts` calling these two functions needs no signature change.

**Root cause (confirmed against current source):** `updateAllNodeMetrics` force-opens the inbound-edge breaker for *any* node that goes `down`, with no check for whether that node type has a `circuitBreaker` config (`NODE_SIM_DEFAULTS` in `src/app/simulation/defaults.ts` — many types, e.g. `redis`, `objectStorage`, all queue types, ship with none). Both reset paths (`checkBreakerTransition`'s `if (!cb) return 'closed'` guard, and the periodic recovery scan's `if (!cb || ...) continue`) bail out early specifically when `circuitBreaker` config is `undefined` — so a force-opened breaker on a config-less node type can never be found and reset. `spawnParticles` reads `breaker.state === 'open'` to zero out `downstreamFactor`, so traffic to that node stays permanently suppressed post-recovery.

**Fix:** Take the "Better" option from the issue's own recommendation — never force-open a breaker for a node type that has no `circuitBreaker` config in the first place. Config-less node types already get dropped correctly via the existing `down` hard-gate at arrival time (`particleEngine.ts` ~`:1120`), so suppressing new spawns via a breaker is redundant for them and is exactly what's creating the latch.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { forceOpenBreakersForNode, resetBreakersIfRecovered, getBreaker, clearBreakers } from './circuitBreakers'
import type { Edge } from '@xyflow/react'
import type { EdgeData } from '../../../../lib/nodeConfig'

const redisEdge: Edge<EdgeData> = {
  id: 'e1', source: 'api-1', target: 'redis-1', type: 'request',
  data: { label: '', edgeType: 'request', throughput: 0, latency: 0 },
}

describe('circuit breaker force-open on config-less node types', () => {
  beforeEach(() => clearBreakers())

  it('does not open a breaker for a node type with no circuitBreaker config (redis)', () => {
    forceOpenBreakersForNode('redis-1', [redisEdge], /* hasBreakerConfig */ false, Date.now())
    expect(getBreaker('e1').state).not.toBe('open')
  })

  it('can still close a breaker that was already force-opened before this fix shipped', () => {
    const breaker = getBreaker('e1')
    breaker.state = 'open'
    breaker.openedAt = Date.now() - 10_000
    resetBreakersIfRecovered('redis-1', [redisEdge], /* hasBreakerConfig */ false, Date.now())
    expect(getBreaker('e1').state).not.toBe('open')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts`
Expected: FAIL — `forceOpenBreakersForNode` doesn't yet accept a `hasBreakerConfig` parameter (or, if signature already matches, FAIL because the breaker still opens).

- [ ] **Step 3: Implement the fix**

In `circuitBreakers.ts`, change `forceOpenBreakersForNode` to accept whether the target node type has a `circuitBreaker` config, and no-op when it doesn't:

```typescript
export function forceOpenBreakersForNode(
  nodeId: string,
  inboundRequestEdges: Edge<EdgeData>[],
  hasBreakerConfig: boolean,
  now: number,
): void {
  if (!hasBreakerConfig) return  // no breaker semantically exists for this node type — the
                                 // down-state hard-gate at arrival time already suppresses traffic
  for (const e of inboundRequestEdges) {
    const breaker = getBreaker(e.id)
    if (breaker.state !== 'open') { breaker.state = 'open'; breaker.openedAt = now }
  }
}

export function resetBreakersIfRecovered(
  nodeId: string,
  inboundRequestEdges: Edge<EdgeData>[],
  hasBreakerConfig: boolean,
  now: number,
): void {
  for (const e of inboundRequestEdges) {
    const breaker = getBreaker(e.id)
    if (breaker.state !== 'open') continue
    // Belt-and-suspenders: close any breaker force-opened before this fix landed, or by a
    // config path change mid-run, even if hasBreakerConfig is now false.
    if (!hasBreakerConfig) { breaker.state = 'closed'; continue }
    // ...existing half-open/closed transition logic for config-bearing node types goes here...
  }
}
```

At the call site in `updateAllNodeMetrics` (`particleEngine.ts`), pass `hasBreakerConfig = effectiveConfig(nodeId, nodeType).circuitBreaker !== undefined` (the same `effectiveConfig` helper already used elsewhere in the file, `:535`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts`
Expected: PASS

- [ ] **Step 5: Manual repro check**

Run: `npm run tauri dev`, build a diagram with an `apiGateway` → `redis` edge, force the redis node's health to `down` (e.g. via a chaos scenario or by exceeding its `maxRps`), let it recover, and confirm traffic resumes (previously it stayed dark forever per the issue's repro steps).

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/circuitBreakers.ts src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "fix: never force-open circuit breakers for node types with no breaker config (#1)"
```

---

### Task 2: Fix C2 — setTimeout releases ignore pause/speed and leak across runs

**GitHub issue:** #2 — `[C2] setTimeout releases ignore pause/speed and leak across runs`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/backpressure.ts` (created in Task 0)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (call `drainScheduledReleases` once per frame from the main loop; remove the `setTimeout` call sites)
- Test: `src/app/canvas/simulation/particleEngine/backpressure.test.ts`

**Interfaces:**
- Consumes: `_simulatedTimeMs` (the existing simulation-time clock, `particleEngine.ts:395`) — passed into `backpressure.ts` functions as a parameter rather than imported, to keep `backpressure.ts` a pure/testable module with no dependency on the main loop's module-level state.
- Produces: `scheduleRelease(nodeId, kind, delayMs, simNowMs)` and `drainScheduledReleases(simNowMs)`, called once per frame from the main rAF loop in `particleEngine.ts` right after `_simulatedTimeMs` is advanced.

**Root cause:** every pool/concurrency release (`trackRequest`, connection-pool, lambda, thread-pool) is scheduled with wall-clock `setTimeout(..., delay / _speed)` and never cancelled. This breaks in three ways documented in the issue: releases keep firing while `paused`, they don't rescale on mid-flight speed changes, and `stopSimulation`/`startSimulation` clear the counters but not the pending timers — so a timer from run A can decrement run B's counters for a node id that exists in both diagrams.

**Fix:** replace wall-clock `setTimeout` with an in-memory min-heap keyed on `_simulatedTimeMs`, drained once per frame inside the rAF loop — the same pattern the file already uses for `_retryQueue`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/backpressure.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { acquireWorkers, scheduleRelease, drainScheduledReleases, getActiveWorkers, clearBackpressureState } from './backpressure'

describe('simulated-time release scheduling', () => {
  beforeEach(() => clearBackpressureState())

  it('does not release before the scheduled simulated time has elapsed', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleRelease('node-1', 'worker', /* delayMs */ 500, /* simNowMs */ 0)
    drainScheduledReleases(/* simNowMs */ 300)
    expect(getActiveWorkers('node-1')).toBe(1)
  })

  it('releases once simulated time passes the scheduled point, regardless of wall clock', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleRelease('node-1', 'worker', 500, 0)
    drainScheduledReleases(600)
    expect(getActiveWorkers('node-1')).toBe(0)
  })

  it('clearBackpressureState wipes pending releases so a stale one cannot fire in the next run', () => {
    acquireWorkers('node-1', 1, 10)
    scheduleRelease('node-1', 'worker', 500, 0)
    clearBackpressureState()
    acquireWorkers('node-1', 1, 10)   // fresh run, same node id
    drainScheduledReleases(10_000)    // far past the old run's schedule
    expect(getActiveWorkers('node-1')).toBe(1) // only the fresh-run acquire should be active
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/backpressure.test.ts`
Expected: FAIL — `scheduleRelease`/`drainScheduledReleases` don't exist yet (Task 0 moved the old `setTimeout`-based code verbatim).

- [ ] **Step 3: Implement the simulated-time scheduler**

```typescript
// src/app/canvas/simulation/particleEngine/backpressure.ts (additions)
type ReleaseKind = 'worker' | 'connection' | 'lambda'
interface ScheduledRelease { nodeId: string; kind: ReleaseKind; fireAtSimMs: number }

const _scheduledReleases: ScheduledRelease[] = []  // unsorted array; drained via filter — release
                                                    // volume per frame is small (bounded by MAX_PARTICLES)
                                                    // so a full heap is unnecessary overhead here

export function scheduleRelease(nodeId: string, kind: ReleaseKind, delayMs: number, simNowMs: number): void {
  _scheduledReleases.push({ nodeId, kind, fireAtSimMs: simNowMs + delayMs })
}

export function drainScheduledReleases(simNowMs: number): void {
  for (let i = _scheduledReleases.length - 1; i >= 0; i--) {
    const r = _scheduledReleases[i]
    if (r.fireAtSimMs > simNowMs) continue
    releaseOne(r.nodeId, r.kind)
    _scheduledReleases.splice(i, 1)
  }
}

function releaseOne(nodeId: string, kind: ReleaseKind): void {
  if (kind === 'worker') _activeWorkers.set(nodeId, Math.max(0, (_activeWorkers.get(nodeId) ?? 1) - 1))
  else if (kind === 'connection') _activeConnections.set(nodeId, Math.max(0, (_activeConnections.get(nodeId) ?? 1) - 1))
  // lambda: decrement warm-instance concurrency counter analogously
}

export function clearBackpressureState(): void {
  _activeWorkers.clear()
  _activeConnections.clear()
  _scheduledReleases.length = 0   // the critical fix — Task 0's move alone did not add this
}
```

Replace every `setTimeout(() => { ...release... }, (sampledLatency + ep.geoLatencyMs) / _speed)` call site (moved into this file in Task 0) with `scheduleRelease(sourceNodeId, 'worker', sampledLatency + ep.geoLatencyMs, _simulatedTimeMs)` — note `/ _speed` is dropped: `_simulatedTimeMs` already advances at `_speed`-scaled rate elsewhere in the loop, so scheduling in simulated-ms is speed-correct by construction, fixing the "mid-flight speed changes don't rescale" half of the bug for free.

In `particleEngine.ts`'s main `loop()` function, call `drainScheduledReleases(_simulatedTimeMs)` once per frame, immediately after `_simulatedTimeMs` is advanced and before `spawnParticles` runs (so releases from this frame are visible to this frame's spawn decisions, matching `_retryQueue`'s existing drain-then-spawn ordering).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/backpressure.test.ts`
Expected: PASS

- [ ] **Step 5: Manual repro check**

Run: `npm run tauri dev`, start a high-load simulation, pause it mid-load, confirm `_activeWorkers`/pool counters (visible via the node's concurrency metric in `PropertiesPanel`) stop draining while paused, then stop and restart the simulation and confirm counters start at zero with no delayed decrements from the previous run.

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/backpressure.ts src/app/canvas/simulation/particleEngine/backpressure.test.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "fix: model pool/concurrency releases in simulated time instead of wall-clock setTimeout (#2)"
```

---

### Task 3: Fix C3 — 500-particle cap freezes effectiveRps, flatlining metrics under high load

**GitHub issue:** #3 — `[C3] 500-particle cap freezes effectiveRps, flatlining metrics under high load`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`spawnParticles`, verified present at `:742`, `MAX_PARTICLES` at `:740`)
- Test: `src/app/canvas/simulation/particleEngine/effectiveRps.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ep.effectiveRps` must be written for every edge on every call to `spawnParticles`, independent of whether the visual particle cap is hit — this is what Task-3-in-the-Optimization-doc's O5 (egress attribution) and the Warning doc's W3 (queue depth integration) both read, so do not change `effectiveRps`'s meaning, only when it's written.

**Root cause (confirmed):** `spawnParticles` sums current particle count and does an early `return` when `total >= MAX_PARTICLES` (`:742-745`), before the per-edge loop that writes `ep.effectiveRps` (`:850-851`) ever runs. Under sustained overload, `effectiveRps` freezes at its last pre-cap value, so `inRps`/`outRps`/`utilization`/queue-depth integration all read a stale rate — the system looks healthier the more it's overloaded.

**Fix:** move the `MAX_PARTICLES` check so it only gates the visual particle-minting sub-loop, not the `effectiveRps` bookkeeping loop, per the issue's own recommendation.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/effectiveRps.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
// Exact harness setup (canvas.store fixture with N nodes/edges driving > MAX_PARTICLES concurrent
// particles) depends on test fixtures introduced alongside this task — build a minimal 2-node,
// 1-edge diagram fixture with maxRps set high enough that particle count exceeds MAX_PARTICLES
// (500) within a few simulated seconds, per the repro in issue #3.

describe('effectiveRps under particle-cap saturation', () => {
  it('keeps advancing edge effectiveRps after the 500-particle visual cap is hit', () => {
    // Arrange: diagram with a single high-throughput edge, run until particle count > 500.
    // Act: capture NodeMetrics.inRps via setCallbacks(onNodeMetrics) before and after the cap engages.
    // Assert: inRps continues to track the offered load rather than freezing at its pre-cap value.
  })
})
```

Note for the implementing agent: flesh out the fixture using the existing `canvas.store.ts` node/edge shape (see `serializer.ts` for the JSON shape, or `vault/templates.ts` for a ready-made high-throughput diagram to adapt) — this is the first test file for `particleEngine.ts`, so there is no existing harness to copy; keep the fixture minimal (2 nodes, 1 edge) rather than importing a full vault template.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/effectiveRps.test.ts`
Expected: FAIL — `inRps` freezes once particle count exceeds 500.

- [ ] **Step 3: Implement the fix**

In `spawnParticles`, split the existing single early-return into two independent checks — read the current code at `:742-745` and `:850-851` first (line numbers drift; anchor on the `MAX_PARTICLES` and `effectiveRps` identifiers via `codegraph explore "spawnParticles MAX_PARTICLES effectiveRps"`), then restructure so the per-edge loop that computes and stores `ep.effectiveRps` always runs, and only the inner particle-object-minting step is skipped once the global cap is reached:

```typescript
function spawnParticles(/* ...existing params... */) {
  let totalParticles = 0
  for (const arr of state.particles.values()) totalParticles += arr.length
  const atCap = totalParticles >= MAX_PARTICLES

  for (const ep of /* ...existing per-edge iteration... */) {
    // ...existing effectiveRps computation, now unconditional...
    ep.effectiveRps = /* existing formula, unchanged */

    if (atCap) continue  // still bookkeeping rate correctly; just skip minting a visual particle
    // ...existing particle-minting logic (Particle object creation, push to state.particles)...
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/effectiveRps.test.ts`
Expected: PASS

- [ ] **Step 5: Regression check on existing render behavior**

Run: `npm run tauri dev`, drive a diagram past 500 concurrent particles (high `maxRps`, `steady` traffic mode), and confirm the canvas still visually caps particle rendering (no runaway particle count / frame drop) while `PropertiesPanel`'s live utilization/RPS readouts keep climbing instead of flatlining.

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/effectiveRps.test.ts
git commit -m "fix: decouple effectiveRps bookkeeping from the visual particle cap (#3)"
```

---

## Sequencing Summary

```
Task 0 (split, solo agent)
   │
   ├──► Task 1 (C1, circuitBreakers.ts)     ─┐
   ├──► Task 2 (C2, backpressure.ts)         ├─ parallel-safe once Task 0 merges
   └──► Task 3 (C3, particleEngine.ts core) ─┘
```

## Definition of Done

- [ ] All four tasks' tests pass: `npx vitest run src/app/canvas/simulation/particleEngine`
- [ ] `npm run build` passes with no new TypeScript errors
- [ ] `docs/module-boundaries.md` §1B reflects the landed split (Task 0, Step 8)
- [ ] Manual smoke test in `npm run tauri dev`: load a vault template, run a simulation, confirm no visual/behavioral regression beyond the three intended bug fixes
- [ ] GitHub issues #1, #2, #3 closed with a reference to the merged commits
