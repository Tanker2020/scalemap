# Warning Issues — Spec & Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to work this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Hard dependency:** [`critical-issues-spec.md`](./critical-issues-spec.md) Task 0 (the `particleEngine.ts` → `circuitBreakers.ts`/`backpressure.ts`/`chaos.ts` split) must be merged before starting W1, W2, or W5 below. W6/W7 (lint rules) have no dependency on the split and can start anytime. Do not begin this document's work until you've confirmed Task 0 is merged (`git log --oneline -- src/app/canvas/simulation/particleEngine/circuitBreakers.ts` should show a commit).

**Goal:** Fix seven warning-level correctness/stability issues (GitHub issues #4–#10, labeled `warning`) across the simulation engine and structural linter.

**Architecture:** Five issues (W1–W5) land in the post-split `particleEngine.ts`/`particleEngine/*` modules from the Critical spec; two issues (W6, W7) land in `src/lib/lint/rules.ts`, which `docs/module-boundaries.md` §1C already documents as low-conflict, independently-owned rule functions.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- No new npm dependencies.
- `npm run build` must pass after every task.
- Every task adds a Vitest test co-located with the file it changes.
- Do not change `LintRule`/`LintIssue`/`LintContext` signatures in `src/lib/lint/types.ts` (hub-adjacent per module-boundaries.md — extend behavior inside existing rule functions, don't restructure the registry).

---

## Merge-Conflict Prevention Strategy

| Task | File(s) | Depends on | Can run parallel with |
|---|---|---|---|
| W1 | `particleEngine/backpressure.ts` | Critical Task 0 **and** Critical Task 2 (C2) merged — same file, sequence after it | W2, W3, W4, W5, W6, W7 |
| W2 | `particleEngine/chaos.ts` | Critical Task 0 merged | W1, W3, W4, W5, W6, W7 |
| W3 | `particleEngine.ts` (queue arrival + consumer-spawn gating) | Critical Task 3 (C3) merged — both touch `spawnParticles` | W1, W2, W4, W5, W6, W7 |
| W4 | `particleEngine.ts` (`updateAllNodeMetrics` health scoring) | Critical Task 0 merged | W1, W2, W3, W5, W6, W7 — **but see coordination note below** |
| W5 | `particleEngine.ts` (`processRetryQueue`) + reads `circuitBreakers.ts`/`backpressure.ts` | Critical Tasks 0, 1 (C1), 2 (C2) merged | W1, W2, W3, W4, W6, W7 |
| W6 | `src/lib/lint/rules.ts` (`deepSyncChain`) | none | everything, including all of the Critical doc |
| W7 | `src/lib/lint/rules.ts` (`circularDependency`) | none | everything — but see note in W7 below re: touching the same file as W6 |

**Coordination note for the Optimization doc:** W4 rewrites part of the utilization/health formula in `updateAllNodeMetrics`. The Optimization doc's O3 (saturation latency curve) touches the same function immediately downstream of where W4 writes. **O3 must not start until W4 has merged** — this is called out again in the Optimization doc, but the constraint originates here.

**W6/W7 same-file note:** both rules live in `rules.ts`. Per `docs/module-boundaries.md` §1C, two people/agents adding or editing *different* rule functions in this file "will only conflict on the `LINT_RULES = [...]` array line, not on rule logic" — but W6 and W7 each *edit an existing* rule body (not append a new one), so if run as literally parallel subagents, stage them as two separate small commits rather than one combined diff, to keep the array-line conflict (if any) trivial to resolve.

---

### Task W1: Thread-pool acquire clamped but release unclamped

**GitHub issue:** #4 — `[W1] Thread-pool acquire clamped but release unclamped -- over-release + leak`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/backpressure.ts`
- Modify: `src/app/canvas/simulation/particleEngine.ts` (the per-particle mint loop in `spawnParticles`)
- Test: `src/app/canvas/simulation/particleEngine/backpressure.test.ts` (extend the file created in the Critical doc's Task 2)

**Interfaces:**
- Consumes: `acquireWorkers(nodeId, n, maxThreads)` from the Critical doc's Task 0/2 — this task changes its call-site usage pattern, not its signature.
- Produces: worker acquisition and release must now be 1:1 per actually-minted particle — anything relying on `getActiveWorkers` (e.g. `PropertiesPanel`'s concurrency readout) sees a bounded value that never exceeds `maxThreads` or drifts negative.

**Root cause:** acquisition clamps the *ceiling* (`Math.min(maxThreads, active + n)`) but still releases exactly `n` times regardless of how many were actually admitted under the clamp — over time this drives `_activeWorkers` below true occupancy. Separately, if `MAX_PARTICLES` (fixed by the Critical doc's C3) truncates the mint loop mid-batch, workers acquired for particles that were never minted never release — a leak in the other direction that only clears on restart.

**Fix:** acquire exactly what is minted — move the worker increment inside the per-particle mint loop (after the `MAX_PARTICLES`/cap check from C3), incrementing by 1 per actually-created particle, and reject overflow via the existing `spawnErrorFlash`/503 path instead of silently under-acquiring.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/backpressure.test.ts (append to existing describe blocks)
describe('acquire/release symmetry under pool clamping', () => {
  beforeEach(() => clearBackpressureState())

  it('never leaves activeWorkers above maxThreads after a batch that exceeds the pool', () => {
    const maxThreads = 5
    const acquired = acquireWorkers('node-1', /* requested */ 8, maxThreads)
    expect(acquired).toBeLessThanOrEqual(maxThreads)
    expect(getActiveWorkers('node-1')).toBe(acquired)
  })

  it('releasing exactly `acquired` times returns activeWorkers to zero, never negative', () => {
    const maxThreads = 5
    const acquired = acquireWorkers('node-1', 8, maxThreads)
    for (let i = 0; i < acquired; i++) scheduleRelease('node-1', 'worker', 0, 0)
    drainScheduledReleases(1)
    expect(getActiveWorkers('node-1')).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/backpressure.test.ts`
Expected: FAIL if `acquireWorkers` doesn't yet return the actually-acquired count (current signature per the Critical doc returns a number already — verify it returns `min(maxThreads, active+n) - active`, the *actual* delta, not `n`).

- [ ] **Step 3: Implement the fix**

```typescript
// backpressure.ts
export function acquireWorkers(nodeId: string, requested: number, maxThreads: number): number {
  const active = _activeWorkers.get(nodeId) ?? 0
  const admitted = Math.max(0, Math.min(maxThreads, active + requested) - active)
  _activeWorkers.set(nodeId, active + admitted)
  return admitted   // caller must schedule exactly `admitted` releases, not `requested`
}
```

In `particleEngine.ts`'s mint loop (`spawnParticles`), call `acquireWorkers` **per actually-minted particle** (one call per particle, requesting 1) rather than once per batch requesting `n` — this makes the "acquire what you mint" property structural rather than relying on the caller to reconcile counts:

```typescript
for (let i = 0; i < particlesToMint; i++) {
  if (THREAD_POOL_TYPES.has(sourceNodeType)) {
    const admitted = acquireWorkers(sourceNodeId, 1, maxThreads)
    if (admitted === 0) { triggerSpawnErrorFlash(sourceNodeId); continue }  // reject overflow explicitly
    scheduleRelease(sourceNodeId, 'worker', releaseDelayMs, _simulatedTimeMs)
  }
  // ...existing Particle object creation...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/backpressure.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/backpressure.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "fix: acquire exactly one thread-pool worker per minted particle (#4)"
```

---

### Task W2: Side-effectful effectiveMultiplier called per-arrival

**GitHub issue:** #5 — `[W2] Side-effectful effectiveMultiplier called per-arrival`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/chaos.ts`
- Modify: `src/app/canvas/simulation/particleEngine.ts` (call sites: `spawnParticles`, `handleParticleArrival` ~`:1111`, `updateAllNodeMetrics` ~`:1534`, and the main `loop()`)
- Test: `src/app/canvas/simulation/particleEngine/chaos.test.ts`

**Interfaces:**
- Produces: `trafficMultiplier(now: number): number` (pure, no state writes — safe to call any number of times per frame) and `advanceChaosSchedule(now: number): void` (impure, mutates `_spikeEndAt`/`_spikeNextAt`/chaos victims and emits `chaos_failure`/`chaos_recovery` events — called exactly once per frame).
- Consumes: existing `_chaosFailures`, `_spikeNextAt`, `_spikeEndAt` state from Task 0 of the Critical doc.

**Root cause:** `effectiveMultiplier` both reads *and mutates* chaos/spike scheduling state, but is called multiple times per frame (once per particle arrival, for the glow-RPS calculation, plus once each in `spawnParticles` and `updateAllNodeMetrics`). Internal "next-fire" gates happen to make repeated calls idempotent today, but nothing enforces that — any future change to the gating logic, or a chaos mode whose schedule isn't self-advancing, silently double-fires failure/recovery events.

**Fix:** split into a pure getter used everywhere reads happen, and a single mutation entry point called once per frame from the main loop.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/chaos.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { trafficMultiplier, advanceChaosSchedule, clearChaosState } from './chaos'

describe('trafficMultiplier purity', () => {
  beforeEach(() => clearChaosState())

  it('calling trafficMultiplier many times with the same `now` does not change chaos schedule state', () => {
    advanceChaosSchedule(1000)
    const before = trafficMultiplier(1000)
    for (let i = 0; i < 50; i++) trafficMultiplier(1000)  // simulates per-arrival calls in one frame
    const after = trafficMultiplier(1000)
    expect(after).toBe(before)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/chaos.test.ts`
Expected: FAIL — `trafficMultiplier`/`advanceChaosSchedule` don't exist yet (`effectiveMultiplier` is a single impure function per the Critical doc's Task 0 move).

- [ ] **Step 3: Implement the split**

Read the current `effectiveMultiplier` body (`chaos.ts` post-split, originally `particleEngine.ts:569`) and separate its state-mutating branches (advancing `_spikeEndAt`/`_spikeNextAt`, rolling chaos victims, emitting events) from its return-value computation:

```typescript
// chaos.ts
export function advanceChaosSchedule(now: number): void {
  // ...existing gated logic that rolls _spikeNextAt/_spikeEndAt forward and picks new chaos
  // victims/emits chaos_failure/chaos_recovery, moved here verbatim from effectiveMultiplier...
}

export function trafficMultiplier(now: number): number {
  // ...existing pure computation of the multiplier value based on current _spikeEndAt/_chaosFailures
  // state, with all mutating branches removed...
}
```

Update call sites: `handleParticleArrival` and any other per-arrival/per-edge read site call `trafficMultiplier(now)` only. The main `loop()` function calls `advanceChaosSchedule(_simulatedTimeMs)` exactly once per frame, before `spawnParticles` runs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/chaos.test.ts`
Expected: PASS

- [ ] **Step 5: Regression check**

Run: `npm run tauri dev`, switch traffic mode to `chaos`, confirm `chaos_failure`/`chaos_recovery` events in `EventLogPanel` fire at the same cadence as before this change (once per schedule tick, not once per particle arrival).

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/chaos.ts src/app/canvas/simulation/particleEngine/chaos.test.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "refactor: split effectiveMultiplier into pure trafficMultiplier + advanceChaosSchedule (#5)"
```

---

### Task W3: Queues decoupled from particles; delivery guarantees cosmetic

**GitHub issue:** #6 — `[W3] Queues decoupled from particles; delivery guarantees cosmetic`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (queue arrival handler ~`:1207-1223`, consumer-edge spawn gating in `spawnParticles`, depth integration in `updateAllNodeMetrics` ~`:1582-1595`)
- Test: `src/app/canvas/simulation/particleEngine/queueDepth.test.ts`

**Interfaces:**
- Consumes: `state.queueDepths` (existing `EngineState` field from the Critical doc's Task 0 — unchanged shape).
- Produces: consumer-edge spawn rate must now read as zero whenever `queueDepth <= 0` for the source queue node — any downstream code reading `NodeMetrics.queueDepth` or `outRps` for a queue's consumer edge sees this new gating.

**Root cause:** a queue's consumer edge spawns its own particles at a free-running configured RPS, entirely decoupled from the producer→queue arrivals that are supposed to "fill" it — so a queue with zero producers still emits consumer traffic ("messages from nothing"), and `deliveryMode` (`at-least-once`/`exactly-once`) is cosmetic (inspector-only, never affects engine behavior).

**Fix (minimum viable per the issue's own recommendation):** gate consumer-edge spawn on `queueDepth > 0`, so an empty queue produces no downstream traffic. (Full delivery-guarantee modeling — dedup, differentiated redelivery — is out of scope for this warning-level fix; note it as a follow-up if picked up later, but do not implement it here to avoid scope creep into what is effectively O2-in-the-optimization-doc's territory of state-consistency modeling.)

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/queueDepth.test.ts
// Uses the same minimal-fixture approach introduced in the Critical doc's Task 3 test
// (2-3 node diagram: producer -> queue -> consumer, no producer traffic).
import { describe, it, expect } from 'vitest'

describe('queue consumer-edge gating on depth', () => {
  it('emits zero consumer-edge outRps when queueDepth is zero and no producer feeds it', () => {
    // Arrange: queue node with a consumer edge configured at some maxRps, zero producer edges.
    // Act: run spawnParticles/updateAllNodeMetrics for several ticks.
    // Assert: the consumer edge's effectiveRps/outRps stays at 0 — no "messages from nothing".
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/queueDepth.test.ts`
Expected: FAIL — consumer edge currently spawns at its configured RPS regardless of depth.

- [ ] **Step 3: Implement the fix**

In `spawnParticles`'s consumer-edge branch (edges sourced from a queue-type node), read the queue's current depth from `state.queueDepths` before computing the mint count:

```typescript
// spawnParticles, consumer-edge branch
if (isQueueConsumerEdge(ep)) {
  const depth = state.queueDepths.get(ep.source) ?? 0
  if (depth <= 0) { ep.effectiveRps = 0; continue }  // keep effectiveRps bookkeeping honest (per C3) —
                                                       // zero it explicitly rather than freezing stale
  // ...existing mint logic, optionally capping mint rate so depth doesn't go negative this tick...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/queueDepth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/queueDepth.test.ts
git commit -m "fix: gate queue consumer-edge spawn on queueDepth > 0 (#6)"
```

---

### Task W4: Stall pressure double-counted through utilization + error rate

**GitHub issue:** #7 — `[W4] Stall pressure double-counted through utilization + error rate`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`updateAllNodeMetrics`, health score computation ~`:1810`, ~`:1866`, ~`:1907-1911`)
- Test: `src/app/canvas/simulation/particleEngine/healthScore.test.ts`

**Interfaces:**
- Produces: the health-score `utilPenalty` term must read from `rawUtilization` (pre-stall-inflation), matching the convention the file already uses for the bottleneck threshold — this is a behavior change to `NodeMetrics.healthScore` values under cascading-stall scenarios; anything displaying health score (`BaseNode.tsx` node coloring, `EventLogPanel`) will show less-inflated severity for pure downstream-stall cascades.

**Root cause:** downstream stall pressure inflates `utilization` (`utilization = min(1, utilization + stallPressure*0.3)`), which then feeds the health score's `utilPenalty`. Separately, upstream/cascade pressure independently inflates `errorRate` via `cascadePressure`, feeding `errorContrib`. A single downstream failure pushes both terms even though there's one underlying cause — the file already correctly uses pre-stall `rawUtilization` for the *bottleneck* threshold, just not for the *health* path.

**Fix:** per the issue's own recommendation, use `rawUtilization` for the health `utilPenalty` term too, so stall pressure's effect on health flows through the error-rate/`cascadePressure` channel only, not both.

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/healthScore.test.ts
// Fixture: two nodes where the downstream node is failing/stalled, producing both elevated
// cascadePressure (upstream errorRate) and elevated stallPressure (upstream utilization) on the
// same upstream node in the same tick.
import { describe, it, expect } from 'vitest'

describe('health score does not double-count a single stall cause', () => {
  it('utilPenalty is computed from rawUtilization, not the stall-inflated utilization', () => {
    // Arrange: drive a downstream stall scenario.
    // Act: read the upstream node's NodeMetrics after a tick.
    // Assert: healthScore reflects errorContrib (from cascadePressure) but utilPenalty's
    // contribution matches what rawUtilization alone would produce, not the inflated utilization.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/healthScore.test.ts`
Expected: FAIL — `utilPenalty` currently derives from the stall-inflated `utilization`.

- [ ] **Step 3: Implement the fix**

Locate the health-score block in `updateAllNodeMetrics` (anchor on `utilPenalty`/`errorContrib` identifiers via `codegraph explore "utilPenalty errorContrib rawUtilization healthScore"` since exact line numbers drift) and change its utilization input from the stall-inflated value to `rawUtilization`:

```typescript
// updateAllNodeMetrics — health score block
const utilPenalty = computeUtilPenalty(rawUtilization)   // was: computeUtilPenalty(utilization)
const errorContrib = computeErrorContrib(errorRate)      // unchanged — this is the one channel
                                                          // stall pressure should flow through
const healthScore = 1 - Math.max(utilPenalty, errorContrib)  // (or existing combination formula —
                                                               // do not change how the two terms
                                                               // combine, only utilPenalty's input)
```

Leave the *bottleneck* threshold's existing use of `rawUtilization` untouched — it's already correct per the issue.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/healthScore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/healthScore.test.ts
git commit -m "fix: health score utilPenalty uses rawUtilization to avoid double-counting stall pressure (#7)"
```

---

### Task W5: Retries bypass circuit/thread/backpressure gating

**GitHub issue:** #8 — `[W5] Retries bypass circuit/thread/backpressure gating`

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`processRetryQueue`, verified present at `:2084`)
- Test: `src/app/canvas/simulation/particleEngine/retryGating.test.ts`

**Interfaces:**
- Consumes: `checkBreakerTransition`/`getBreaker` from `circuitBreakers.ts` and `acquireWorkers` from `backpressure.ts` (both from the Critical doc's Task 0 — **this task cannot start until those modules exist**, hence the hard dependency on Critical Tasks 0/1/2 noted above).

**Root cause:** `processRetryQueue` mints retry particles directly into `state.particles`, skipping every admission check `spawnParticles` applies for fresh spawns — circuit-open suppression, thread-pool acquisition, and the `down`/chaos `downstreamFactor` gate. This under-models the "retry storm amplifies an outage" dynamic the retry-storm detector is trying to surface: retries don't feel backpressure on the way in.

**Fix:** route retry re-spawns through the same circuit-open and thread-pool admission checks fresh spawns use, per the issue's recommendation ("at least the circuit-open and thread-pool gates").

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/canvas/simulation/particleEngine/retryGating.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { clearBreakers, getBreaker } from './circuitBreakers'
// processRetryQueue is currently internal to particleEngine.ts — export it for this test if not
// already exported, or drive it via startSimulation + a fixture that forces a retry then opens
// the circuit before the retry's backoff elapses.

describe('retry admission checks', () => {
  beforeEach(() => clearBreakers())

  it('does not re-spawn a retried particle onto an edge whose circuit is open', () => {
    // Arrange: enqueue a retry entry for edge 'e1', then force getBreaker('e1').state = 'open'.
    // Act: process the retry queue at the retry's scheduled time.
    // Assert: no new particle appears on edge 'e1' — the retry was suppressed, not silently minted.
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/retryGating.test.ts`
Expected: FAIL — `processRetryQueue` currently mints unconditionally.

- [ ] **Step 3: Implement the fix**

In `processRetryQueue`, before minting a retried particle, check the same gates `spawnParticles` checks for a fresh spawn on that edge:

```typescript
// processRetryQueue
for (const retryEntry of dueRetries) {
  const breakerState = checkBreakerTransition(retryEntry.edgeId, _simulatedTimeMs)
  if (breakerState === 'open') { dropParticle(retryEntry, 'circuit_open'); continue }
  const admitted = acquireWorkers(retryEntry.sourceNodeId, 1, maxThreadsFor(retryEntry.sourceNodeId))
  if (admitted === 0) { dropParticle(retryEntry, 'pool_exhausted'); continue }
  scheduleRelease(retryEntry.sourceNodeId, 'worker', /* ...same latency calc as fresh spawns... */, _simulatedTimeMs)
  // ...existing particle re-mint logic...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/retryGating.test.ts`
Expected: PASS

- [ ] **Step 5: Regression check on retry-storm detector**

Run: `npm run tauri dev`, trigger a scenario that causes retries to storm an already-degraded node (per `SRE_Critique.md`'s retry-storm blueprint), confirm the retry-storm detector event still fires and now that retries visibly back off / drop once the circuit opens, rather than continuing to hammer the node.

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/retryGating.test.ts
git commit -m "fix: route retry re-spawns through circuit-open and thread-pool admission checks (#8)"
```

---

### Task W6: deepSyncChain reports shortest, not longest, sync path

**GitHub issue:** #9 — `[W6] deepSyncChain reports shortest, not longest, sync path`

**Files:**
- Modify: `src/lib/lint/rules.ts` (`deepSyncChain`, confirmed at `:242-283`, BFS guard confirmed at `:265`)
- Test: `src/lib/lint/rules.test.ts` (new — first test file for the lint module)

**Interfaces:**
- Consumes: `LintContext.nodes`/`.edges`, `isEntry` from `classify.ts` — unchanged.
- Produces: `deepSyncChain`'s returned `LintIssue[]` now reflects the longest sync path per node, not the shortest — no signature change to the exported `LintRule`.

**Root cause (confirmed against current source):** the BFS in `deepSyncChain` (`rules.ts:242-283`) tracks minimum hop count via `seen.set(target, newDepth)` guarded by `if ((seen.get(target) ?? Infinity) <= newDepth) continue` (`:265`) — a standard shortest-path BFS visited-guard. In a diamond/mesh graph where a node is reachable by both a short and a long sync path, the short path wins and, if it's under the 5-hop threshold, the long chain is never flagged — a false negative in a correctness linter whose whole purpose is to flag long chains.

**Fix:** replace the BFS with a longest-path DFS over the sync-only adjacency (`request`/`dependency` edges), guarding against cycles since longest-path is only well-defined on a DAG — reuse the existing `circularDependency` rule's cycle detection as the guard (see W7 below; this rule already builds its own sync-only adjacency separately from `circularDependency`'s all-edges adjacency, so no shared-state coupling is introduced).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/lint/rules.test.ts
import { describe, it, expect } from 'vitest'
import { deepSyncChain } from './rules'
import type { LintContext } from './types'

function makeCtx(nodes: string[], edges: [string, string][]): LintContext {
  // Build a minimal LintContext: entry node 'a', a short 2-hop path and a long 6-hop path both
  // reaching node 'f', all edges typed 'request'.
  // (Implementing agent: construct this using the real LintContext shape from types.ts —
  // nodeById, outEdges maps, plus a node with type that satisfies isEntry().)
  throw new Error('fixture not yet implemented')
}

describe('deepSyncChain reports the longest sync path, not the shortest', () => {
  it('flags a node reachable via both a 2-hop and a 6-hop sync path as a deep chain', () => {
    // Diamond: entry -> a -> f (short, 2 hops) AND entry -> b -> c -> d -> e -> f (long, 6 hops)
    const ctx = makeCtx(
      ['entry', 'a', 'f', 'b', 'c', 'd', 'e'],
      [['entry', 'a'], ['a', 'f'], ['entry', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f']],
    )
    const issues = deepSyncChain(ctx)
    expect(issues.some(i => i.nodeId === 'f')).toBe(true)  // currently false — shortest path (2) wins
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lint/rules.test.ts`
Expected: FAIL — current BFS records depth 2 for `f`, below the 5-hop threshold, so no issue is emitted.

- [ ] **Step 3: Implement the longest-path DFS**

Replace the BFS in `deepSyncChain` with a DFS that tracks the longest depth seen per node, guarding against cycles with a `visiting` set (mirroring `detectCycles`'s pattern in the same file at `:145-168`, confirmed present):

```typescript
export const deepSyncChain: LintRule = (ctx) => {
  const syncOut = new Map<string, { target: string }[]>()
  for (const e of ctx.edges) {
    const data = e.data as EdgeData | undefined
    const et = data?.edgeType ?? 'request'
    if (et !== 'request' && et !== 'dependency') continue
    if (!syncOut.has(e.source)) syncOut.set(e.source, [])
    syncOut.get(e.source)!.push({ target: e.target })
  }

  const maxDepth = new Map<string, number>()
  const visiting = new Set<string>()  // cycle guard — a cycle here would make longest-path undefined;
                                       // circularDependency already flags cycles separately, so this
                                       // guard only needs to stop infinite recursion, not report the cycle

  function dfs(id: string, depth: number): void {
    if (visiting.has(id)) return  // cycle — bail without recording, circularDependency owns that report
    visiting.add(id)
    if (depth >= DEEP_SYNC_THRESHOLD) {
      const prev = maxDepth.get(id) ?? 0
      if (depth > prev) maxDepth.set(id, depth)
    }
    for (const { target } of syncOut.get(id) ?? []) dfs(target, depth + 1)
    visiting.delete(id)
  }

  const entryNodes = ctx.nodes.filter(n => isEntry(n.type as NodeType))
  for (const entry of entryNodes) dfs(entry.id, 0)

  return Array.from(maxDepth.entries()).map(([nodeId, depth]) => {
    // ...existing issue-construction logic, unchanged...
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lint/rules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/lint/rules.ts src/lib/lint/rules.test.ts
git commit -m "fix: deepSyncChain computes longest sync path via DFS, not shortest via BFS (#9)"
```

---

### Task W7: circularDependency flags async-decoupled cycles

**GitHub issue:** #10 — `[W7] circularDependency flags async-decoupled cycles`

**Files:**
- Modify: `src/lib/lint/rules.ts` (`detectCycles`, confirmed at `:145-168`; edge traversal at `:160`)
- Test: `src/lib/lint/rules.test.ts` (same file as W6 — see same-file note in the strategy section above)

**Interfaces:**
- Produces: `circularDependency`'s cycle detection now only traverses `request`/`dependency` edges, matching `deepSyncChain`'s adjacency construction (post-W6, both rules build near-identical sync-only adjacency — do not factor this into a shared helper as part of this fix; that's a nice-to-have refactor outside this issue's scope, and doing it here would create an artificial dependency between W6 and W7 landing together).

**Root cause (confirmed against current source):** `detectCycles`'s DFS at `:160` — `for (const e of ctx.outEdges.get(id) ?? []) dfs(e.target)` — traverses every edge in `ctx.outEdges` with no type filter, including `event`/`stream` edges. The rule's own remediation text (`:185`, confirmed: `"Break the cycle by introducing an event/queue edge..."`) tells the user to add the exact kind of edge the detector will then flag as still-circular — a service graph already broken by an event bus gets flagged anyway.

**Fix:** restrict `detectCycles`'s traversal to synchronous edge types (`request`/`dependency`), per the issue's recommendation.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/lint/rules.test.ts (append)
import { circularDependency } from './rules'

describe('circularDependency does not flag cycles broken by an async edge', () => {
  it('does not flag a -> b (request) -> a (event) as a circular dependency', () => {
    const ctx = makeCtx(/* nodes */ ['a', 'b'], /* edges with types */ [
      // a -request-> b, b -event-> a
    ])
    // (Implementing agent: extend the makeCtx fixture helper from the W6 test above to accept
    // per-edge edgeType, defaulting to 'request' if unspecified, so both tests share one helper.)
    const issues = circularDependency(ctx)
    expect(issues.length).toBe(0)
  })

  it('still flags a -> b -> a when both edges are request/dependency', () => {
    const ctx = makeCtx(['a', 'b'], [/* a -request-> b, b -request-> a */])
    const issues = circularDependency(ctx)
    expect(issues.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/lint/rules.test.ts`
Expected: FAIL on the first case — current `detectCycles` flags the event-broken cycle too.

- [ ] **Step 3: Implement the fix**

```typescript
// rules.ts — detectCycles
function dfs(id: string) {
  if (done.has(id)) return
  if (visitingSet.has(id)) {
    const start = visiting.indexOf(id)
    if (start !== -1) cycles.push([...visiting.slice(start), id])
    return
  }
  visiting.push(id)
  visitingSet.add(id)
  for (const e of ctx.outEdges.get(id) ?? []) {
    const data = e.data as EdgeData | undefined
    const et = data?.edgeType ?? 'request'
    if (et !== 'request' && et !== 'dependency') continue  // async edges break the cycle by design
    dfs(e.target)
  }
  visiting.pop()
  visitingSet.delete(id)
  done.add(id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/lint/rules.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/lint/rules.ts src/lib/lint/rules.test.ts
git commit -m "fix: circularDependency only traverses sync edges, matching its own remediation advice (#10)"
```

---

## Sequencing Summary

```
Critical Task 0 (split, merged)
   │
   ├──► W1 (backpressure.ts, after Critical Task 2 merges)
   ├──► W2 (chaos.ts)
   ├──► W5 (particleEngine.ts, after Critical Tasks 1+2 merge)
   └──► W4 (particleEngine.ts health scoring) ──► [blocks Optimization doc's O3]

Critical Task 3 (C3, merged)
   └──► W3 (particleEngine.ts, spawnParticles consumer-edge gating)

No dependency:
   W6, W7 (rules.ts — commit separately even if run as parallel subagents)
```

## Definition of Done

- [ ] All seven tasks' tests pass: `npx vitest run src/app/canvas/simulation/particleEngine src/lib/lint`
- [ ] `npm run build` passes
- [ ] Manual smoke test in `npm run tauri dev` covering: thread-pool exhaustion scenario (W1), chaos-mode event cadence (W2), an idle queue with no producers (W3), a downstream-stall cascade's health-score display (W4), a retry-storm scenario (W5), and the diagnostics panel for a diamond-shaped sync chain and an event-broken cycle (W6/W7)
- [ ] GitHub issues #4–#10 closed with references to the merged commits
