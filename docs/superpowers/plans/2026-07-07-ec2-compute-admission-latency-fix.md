# EC2 Compute Admission/Latency/Thread-Pool Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an EC2 node's real-time CPU saturation actually slow down its simulated thread-hold time (not just a displayed number), unify its caller-side and server-side thread-pool models so downstream calls consume the same physical capacity as inbound admission, and make non-blocking (event-loop) servers degrade via backlog/latency and genuine OOM instead of the same thread-count-based 503 gate blocking servers use.

**Architecture:** All changes live in `particleEngine/compute.ts` (pure resource math, already this codebase's designated home for it), `particleEngine.ts` (the rAF loop that calls into `compute.ts`), and `nodeConfig.ts` (one new optional `ComputeProfile` field). No new files, no new Zustand store fields, no new node types. Every change is gated exactly like the rest of the EC2 compute model: `resolveEc2Resources(config) !== null`, i.e. absent for any node without a `computeProfile`.

**Tech Stack:** TypeScript, Vitest (`compute.test.ts` for pure-function unit tests; `@vitest-environment jsdom` + mocked `requestAnimationFrame` for engine-level integration tests, matching this session's established pattern in `effectiveRps.test.ts`/`outboundBacklogDrain.test.ts`/`saturationLatency.test.ts`).

## Global Constraints

- **EC2-only, same scope boundary as the original compute-model plan.** `container`, `pod`, `lambda`, DBs, queues, network, grouping nodes keep their current capacity semantics untouched, except where a task explicitly says otherwise (Task 2 touches the shared `THREAD_POOL_TYPES` gate, but only branches new behavior for `ec2`/`container` — `pod`/`k8sCluster`/`ecsCluster`'s existing path is unchanged).
- **Default behavior for a blocking (thread-per-request) EC2 node without `allowMemoryOvercommit` must not change**: it must still shed via `drop-503` under any load, never crash. This is directly verified by an *existing* test in `compute.test.ts` (`ec2AdmissionDecision(100000, W, P)).toBe('drop-503')`) that must keep passing unmodified through every task in this plan.
- **No new Zustand store fields, no new SLO config fields.**
- Keep the flow-rate model. Task 2's thread-pool unification is a deliberate, documented conservative simplification (may over-count occupancy in the nested-call sub-case) rather than per-request causal tracking — see the design spec's Decision 3.
- Only the CPU-compute term of wall time is amplified by saturation — the IO/base latency term (`baseLatencyMs`) is never touched by `saturationLatencyMultiplier`.
- Full reference: `docs/superpowers/specs/2026-07-07-ec2-compute-admission-latency-fix-design.md` — read it before Task 1 for the complete root-cause narrative and the three Decisions it locks in; each task below is self-contained and doesn't require re-reading it, but it's the source of truth if anything here is ambiguous.

---

### Task 1: Real, live CPU-saturation-driven hold time (#19)

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/compute.ts` (add `saturationLatencyMultiplier`, extend `wallTimeMs` to take a `rho` parameter)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (import line `:30`; delete the local `saturationLatencyMultiplier` definition `:341-350` and re-export the one from `compute.ts` instead; update `trackRequest` `:725-739` to compute and pass live `rho`)
- Test: `src/app/canvas/simulation/particleEngine/compute.test.ts` (extend)

**Interfaces:**
- Produces: `saturationLatencyMultiplier(rawUtilization: number): number` now lives in and is exported from `compute.ts` (unchanged formula/behavior); `wallTimeMs(baseLatencyMs, w, p, rho): number` (signature grows by one required parameter — every existing call site must be updated in this task, there is exactly one: `trackRequest`).
- Consumes: nothing from other tasks — self-contained. Tasks 2 and 3 don't depend on this task's changes to compile or run correctly (they call `wallTimeMs`/`hardThreadCap` with their own arguments), but Task 2 benefits from it landing first since its unified caller-side acquisitions will then automatically get realistic, saturation-aware hold times.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/canvas/simulation/particleEngine/compute.test.ts`, after the existing imports (extend the import list at the top):

```ts
import {
  cpuTimeSec, maxThreadsCPU, maxThreadsMem, hardThreadCap,
  cpuUtilization, currentRamMb, nodeUtilization, ec2AdmissionDecision,
  resolveEc2Resources, saturationLatencyMultiplier, wallTimeMs,
} from './compute'
```

Then add these two new `describe` blocks at the end of the file (after the existing `resolveEc2Resources` block):

```ts
describe('saturationLatencyMultiplier', () => {
  it('matches the queueing-theoretic 1/(1-rho) formula, clamped at 0.99', () => {
    expect(saturationLatencyMultiplier(0)).toBeCloseTo(1, 5)
    expect(saturationLatencyMultiplier(0.5)).toBeCloseTo(2, 5)
    expect(saturationLatencyMultiplier(0.9)).toBeCloseTo(10, 5)
    // Clamped at 0.99 for numerical safety near rho=1 — must never divide by (near-)zero.
    expect(saturationLatencyMultiplier(1)).toBeCloseTo(100, 5)
  })
})

describe('wallTimeMs scales the CPU term with live utilization', () => {
  it('amplifies only the CPU-time component as rho rises -- base latency is untouched', () => {
    // cpuTimeSec(W, P) = 0.05 / (3.0 * 2.0) = 0.0083333s = 8.3333ms
    const atIdle = wallTimeMs(20, W, P, 0)    // 20 + 8.3333 * 1  = 28.3333
    const atHalf = wallTimeMs(20, W, P, 0.5)  // 20 + 8.3333 * 2  = 36.6667
    const atHot  = wallTimeMs(20, W, P, 0.9)  // 20 + 8.3333 * 10 = 103.333
    expect(atIdle).toBeCloseTo(28.333, 2)
    expect(atHalf).toBeCloseTo(36.667, 2)
    expect(atHot).toBeCloseTo(103.333, 2)
    // The CPU-time component (total minus the untouched 20ms base) scales exactly with the
    // multiplier; the base latency term itself never changes.
    expect(atHot - 20).toBeCloseTo((atIdle - 20) * 10, 1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: FAIL — `saturationLatencyMultiplier`/is not exported from `./compute` yet, and `wallTimeMs`'s current 3-argument signature ignores a 4th `rho` argument (it isn't defined at all yet), so `atHot` would equal `atIdle` instead of differing by 10×.

- [ ] **Step 3: Move `saturationLatencyMultiplier` into `compute.ts` and extend `wallTimeMs`**

In `src/app/canvas/simulation/particleEngine/compute.ts`, find:

```ts
// Wall-clock hold time for a request: the IO/base latency (from latencyModel, passed in) is the
// dominant term; CPU compute time adds on top. ioBoundFraction is intentionally NOT used to rebuild
// latency here (a fraction can't regenerate absolute IO time from near-zero CPU time) — it lives in
// maxThreadsCPU only. p/w kept in the signature so the release/hold path has one source of truth.
export function wallTimeMs(baseLatencyMs: number, w: WorkloadDemand, p: ComputeProfile): number {
  return Math.max(1, baseLatencyMs + cpuTimeSec(w, p) * 1000)
}
```

Replace with:

```ts
// Queueing-theoretic (M/M/1-style) saturation latency multiplier: latency should blow up
// hyperbolically as utilization (rho) approaches 1, not plateau at a fixed ceiling. `1 / (1 - rho)`,
// clamped at rho=0.99 purely for numerical safety (never divide by zero/near-zero). Moved here from
// particleEngine.ts so wallTimeMs below can share it -- particleEngine.ts re-exports this symbol
// unchanged so existing imports (e.g. saturationLatency.test.ts) keep working without modification.
export function saturationLatencyMultiplier(rawUtilization: number): number {
  const clamped = Math.min(rawUtilization, 0.99)
  return 1 / (1 - clamped)
}

// Wall-clock hold time for a request: the IO/base latency (from latencyModel, passed in) is the
// dominant term; CPU compute time adds on top, amplified by the node's CURRENT CPU saturation
// (rho) via saturationLatencyMultiplier -- a request processed while the CPU is 90% saturated
// really does take longer than one processed idle, and this now feeds the REAL scheduled hold
// time (not just a displayed percentile), so thread-pool occupancy reflects real compute
// pressure. Only the CPU term is amplified -- baseLatencyMs (IO/base latency) is untouched, since
// CPU-scheduler contention slows CPU-bound work, not IO waiting. ioBoundFraction is intentionally
// NOT used to rebuild latency here (a fraction can't regenerate absolute IO time from near-zero
// CPU time) — it lives in maxThreadsCPU only.
export function wallTimeMs(baseLatencyMs: number, w: WorkloadDemand, p: ComputeProfile, rho: number): number {
  return Math.max(1, baseLatencyMs + cpuTimeSec(w, p) * 1000 * saturationLatencyMultiplier(rho))
}
```

- [ ] **Step 4: Re-export `saturationLatencyMultiplier` from `particleEngine.ts` and delete the local copy**

In `src/app/canvas/simulation/particleEngine.ts`, find the import line (around line 30):

```ts
import { ec2AdmissionDecision, resolveEc2Resources, nodeUtilization, wallTimeMs } from './particleEngine/compute'
```

Replace with:

```ts
import { ec2AdmissionDecision, resolveEc2Resources, nodeUtilization, wallTimeMs, saturationLatencyMultiplier, cpuUtilization } from './particleEngine/compute'
export { saturationLatencyMultiplier }
```

(Do not add `hardThreadCap` to this import yet — Task 2 needs it, but this
project's `tsconfig.json` has `noUnusedLocals: true`, so an unused import
would fail `tsc --noEmit` between this task's commit and Task 2's. Task 2
adds it to this same line when it's actually used.)

Then find the local definition (around line 341-350) and delete it entirely:

```ts
// Queueing-theoretic (M/M/1-style) saturation latency multiplier: latency should blow up
// hyperbolically as utilization (rho) approaches 1, not plateau at a fixed ceiling. Replaces the
// old capped polynomial (`1 + ((util-0.7)/0.3)^2 * 3`, which topped out at 4x at 100% utilization
// and only applied to compute node types) with `1 / (1 - rho)`, clamped at rho=0.99 purely for
// numerical safety (never divide by zero/near-zero) — applied uniformly across compute, storage,
// and messaging node types (see the `isCompute`/`isStorage`/`isMessaging` gate at its call site).
export function saturationLatencyMultiplier(rawUtilization: number): number {
  const clamped = Math.min(rawUtilization, 0.99)
  return 1 / (1 - clamped)
}
```

Delete this whole block (all 10 lines, comment included) — the symbol is now supplied by the import + re-export above. The existing call site further down the file (`cpuFactor = ... saturationLatencyMultiplier(rawUtilization)`, around line 2125-2126) needs no change — it resolves to the same function via the new import.

- [ ] **Step 5: Update `trackRequest` to compute and pass live `rho`**

Find (around line 725):

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  // EC2-with-profile holds a thread for the request's WALL time (base latency + CPU compute), so
  // pool occupancy reflects real compute pressure — not the static processingMs. Other types keep
  // the legacy processingMs-based hold.
  const ec2res = nodeType === 'ec2' ? resolveEc2Resources(config) : null
  const baseMs = effectiveProcessingMs(nodeId, config)
  const holdMs = ec2res
    ? wallTimeMs(config.latencyModel?.p50Ms ?? baseMs, ec2res.workload, ec2res.profile)
    : baseMs
  scheduleGenericRelease(nodeId, Math.max(50, holdMs), _simulatedTimeMs, () => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  })
}
```

Replace with:

```ts
function trackRequest(nodeId: string, nodeType: NodeType, config: NodeSimConfig) {
  if (_LB_SKIP_TYPES.has(nodeType) || GROUPING_TYPES.has(nodeType)) return
  _lbActiveRequests.set(nodeId, (_lbActiveRequests.get(nodeId) ?? 0) + 1)
  // EC2-with-profile holds a thread for the request's WALL time (base latency + CPU compute,
  // amplified by the node's CURRENT CPU saturation rho), so pool occupancy reflects real, live
  // compute pressure — not a static per-request cost. Other types keep the legacy
  // processingMs-based hold. rho is read from the same smoothed inRps signal other live-load
  // checks in this file already use. A longer hold time at a steady arrival rate legitimately
  // raises _lbActiveRequests further (Little's Law), which can in turn push the RAM-derived
  // hardThreadCap gate — an intended cascade (CPU saturation -> slower processing -> backlog ->
  // memory pressure -> shedding), not a bug. No feedback into rho itself: cpuUtilization is a
  // pure function of inRps (arrival rate), never of _lbActiveRequests (occupancy).
  const ec2res = nodeType === 'ec2' ? resolveEc2Resources(config) : null
  const baseMs = effectiveProcessingMs(nodeId, config)
  const holdMs = ec2res
    ? wallTimeMs(
        config.latencyModel?.p50Ms ?? baseMs,
        ec2res.workload,
        ec2res.profile,
        cpuUtilization(_smoothedMetrics.get(nodeId)?.inRps ?? 0, ec2res.workload, ec2res.profile),
      )
    : baseMs
  scheduleGenericRelease(nodeId, Math.max(50, holdMs), _simulatedTimeMs, () => {
    _lbActiveRequests.set(nodeId, Math.max(0, (_lbActiveRequests.get(nodeId) ?? 1) - 1))
  })
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: PASS (all tests, including the 2 new ones).

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS — pay particular attention to `saturationLatency.test.ts` (must still pass unmodified — confirms the moved function is byte-identical and the re-export works) and any test that exercises EC2 hold time.
Run: `npx tsc --noEmit`
Expected: clean, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/compute.ts src/app/canvas/simulation/particleEngine/compute.test.ts src/app/canvas/simulation/particleEngine.ts
git commit -m "fix(compute): EC2 thread-hold time scales with live CPU saturation, not just displayed percentiles

saturationLatencyMultiplier (1/(1-rho)) previously only touched the
UI-reported p50/p90/p99 percentiles -- the actual scheduled thread-hold
time (wallTimeMs, driving _lbActiveRequests occupancy) was a static
function of workload/profile alone, with zero dependence on how loaded
the node currently was. wallTimeMs now takes the node's live rho and
amplifies its CPU-compute term the same way the display already did,
so real congestion actually slows real thread occupancy (issue #19)."
```

---

### Task 2: Unify caller-side and server-side thread pools for ec2/container (#21, critical)

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (per-particle thread-pool acquisition `:998-1009`)
- Test: `src/app/canvas/simulation/particleEngine/threadPoolUnification.test.ts` (new)

**Interfaces:**
- Consumes: `hardThreadCap` (imported fresh in this task's Step 3 — not imported in Task 1, to avoid an unused-import `tsc` failure between tasks; see that step), `resolveEc2Resources`, `trackRequest`, `computeMaxThreads`, `isTargetThreadPoolCompute`, `_lbActiveRequests` (all pre-existing in this file).
- Produces: nothing new consumed by Task 3 — independent code region.

- [ ] **Step 1: Write the failing test**

Create `src/app/canvas/simulation/particleEngine/threadPoolUnification.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'

// caller: ec2 with NO inbound edges (a pure outbound source) and no explicit simConfig, so it
// gets NODE_SIM_DEFAULTS.ec2's default computeProfile/workload -- hardThreadCap for that default
// profile is 108 (see compute.test.ts's DEFAULT_EC2_COMPUTE_PROFILE-derived expectations).
// downstream: a plain dbSql target, just something for the request edge to point at.
const nodes: Node<NodeData>[] = [
  { id: 'caller', type: 'ec2', position: { x: 0, y: 0 }, data: { label: 'caller', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'downstream', type: 'dbSql', position: { x: 200, y: 0 }, data: { label: 'downstream', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'caller', target: 'downstream', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
]

function makeFakeCanvas(): HTMLCanvasElement {
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, arcTo() {}, stroke() {}, fill() {},
    clearRect() {}, setLineDash() {},
    strokeStyle: '', fillStyle: '', lineWidth: 0, globalAlpha: 1,
    shadowColor: '', shadowBlur: 0,
  }
  const canvas = {
    width: 800, height: 600,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} }),
  }
  return canvas as unknown as HTMLCanvasElement
}

describe('caller-side thread pool unifies with ec2 server-side capacity', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    // Far exceeds 108 threads' worth of throughput -- particlesPerSec = 5000/10 = 500/s, so ~8
    // particles attempt to mint per 16ms frame, reaching the 108 cap well within 60 frames.
    useSimulationStore.getState().setEdgeRps('e1', 5000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('bounds caller.activeRequests at its own hardThreadCap (108), not the old independent 200-default pool', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    for (let i = 0; i < 60; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    const callerActiveSeries = batches.map(b => b.get('caller')?.activeRequests ?? 0)
    const maxObserved = Math.max(...callerActiveSeries)
    // Before the fix: outbound calls acquired from an entirely separate _activeWorkers pool and
    // never touched _lbActiveRequests at all, so caller.activeRequests would stay 0 regardless of
    // outbound load. After the fix: outbound calls are tracked via the same counter/cap as inbound
    // admission, so it rises and is bounded at the node's REAL hardThreadCap (108), never the old
    // arbitrary 200 default.
    expect(maxObserved).toBeGreaterThan(0)
    expect(maxObserved).toBeLessThanOrEqual(108)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/threadPoolUnification.test.ts`
Expected: FAIL — `maxObserved` is `0` (today's `acquireWorkers` path never touches `_lbActiveRequests` for the caller).

- [ ] **Step 3: Import `hardThreadCap`**

In `src/app/canvas/simulation/particleEngine.ts`, find the import line Task 1 left (around line 30):

```ts
import { ec2AdmissionDecision, resolveEc2Resources, nodeUtilization, wallTimeMs, saturationLatencyMultiplier, cpuUtilization } from './particleEngine/compute'
```

Replace with:

```ts
import { ec2AdmissionDecision, resolveEc2Resources, nodeUtilization, wallTimeMs, saturationLatencyMultiplier, cpuUtilization, hardThreadCap } from './particleEngine/compute'
```

- [ ] **Step 4: Unify the acquisition**

In `src/app/canvas/simulation/particleEngine.ts`, find (around line 998):

```ts
      // Acquire exactly one thread-pool worker per particle actually minted, after the
      // MAX_PARTICLES cap check above — 1:1 with the scheduleWorkerRelease call each minted
      // particle's arrival handler later makes. Reject overflow explicitly (fast-fail 503-style
      // drop) instead of silently under-acquiring and minting anyway.
      if (isThreadPoolEdge) {
        const admitted = acquireWorkers(sourceNodeId!, 1, maxThreads)
        if (admitted === 0) {
          spawnErrorFlash(sourceNodeId!)
          _droppedCounts.set(sourceNodeId!, (_droppedCounts.get(sourceNodeId!) ?? 0) + 1)
          continue
        }
      }
```

Replace with:

```ts
      // Acquire exactly one thread-pool worker per particle actually minted, after the
      // MAX_PARTICLES cap check above — 1:1 with the scheduleWorkerRelease call each minted
      // particle's arrival handler later makes. Reject overflow explicitly (fast-fail 503-style
      // drop) instead of silently under-acquiring and minting anyway.
      //
      // ec2/container sources unify with their OWN server-side thread pool
      // (_lbActiveRequests/hardThreadCap, via trackRequest) instead of the independent,
      // arbitrarily-capped acquireWorkers pool -- see the compute admission/latency fix design
      // spec's WI-B / Decision 3 for why this deliberately over-counts (conservatively) in the
      // nested-call sub-case rather than attempting full per-request causal tracking.
      // pod/k8sCluster/ecsCluster have no server-side model to unify against and keep the
      // independent acquireWorkers pool unchanged.
      if (isThreadPoolEdge) {
        let admitted: number
        if (isTargetThreadPoolCompute(ep.sourceNodeType as NodeType)) {
          const srcConfig = effectiveConfig(sourceNodeId!, ep.sourceNodeType as NodeType)
          const ec2res = ep.sourceNodeType === 'ec2' ? resolveEc2Resources(srcConfig) : null
          const cap = ec2res ? hardThreadCap(ec2res.workload, ec2res.profile) : computeMaxThreads(srcConfig)
          const active = _lbActiveRequests.get(sourceNodeId!) ?? 0
          if (active < cap) {
            trackRequest(sourceNodeId!, ep.sourceNodeType as NodeType, srcConfig)
            admitted = 1
          } else {
            admitted = 0
          }
        } else {
          admitted = acquireWorkers(sourceNodeId!, 1, maxThreads)
        }
        if (admitted === 0) {
          spawnErrorFlash(sourceNodeId!)
          _droppedCounts.set(sourceNodeId!, (_droppedCounts.get(sourceNodeId!) ?? 0) + 1)
          continue
        }
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/threadPoolUnification.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS. Specifically re-run `threadPoolAcquireRelease.test.ts` (exercises the unchanged `pod`/`k8sCluster`/`ecsCluster` path via `acquireWorkers`) and confirm it's unaffected.
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/threadPoolUnification.test.ts
git commit -m "fix(compute): unify ec2/container caller-side and server-side thread pools

An ec2/container node making outbound synchronous calls previously
acquired from an entirely independent _activeWorkers pool capped at an
arbitrary maxConcurrency ?? 200, with zero effect on its own
_lbActiveRequests/hardThreadCap server-side admission gate -- the same
physical threads were modeled as two disconnected, differently-capped
resources. Outbound calls from ec2/container now go through the same
trackRequest/_lbActiveRequests/hardThreadCap path inbound admission
already uses (issue #21). pod/k8sCluster/ecsCluster, which have no
server-side compute model to unify against, keep the independent pool
unchanged.

Note: this is an intended behavior change, not a regression -- nodes
with heavy downstream fan-out will now show lower effective capacity,
correctly reflecting that outbound-blocked threads are unavailable for
new inbound work (previously invisible to the node's own admission
gate)."
```

---

### Task 3: IO-model-aware admission — non-blocking queues instead of dropping (#22, folds in #20's opt-in overcommit)

**Files:**
- Modify: `src/lib/nodeConfig.ts` (`ComputeProfile` interface, add `allowMemoryOvercommit?: boolean`)
- Modify: `src/app/canvas/simulation/particleEngine/compute.ts` (`hardThreadCap`, `ec2AdmissionDecision`)
- Test: `src/app/canvas/simulation/particleEngine/compute.test.ts` (extend)

**Interfaces:**
- Produces: `ComputeProfile.allowMemoryOvercommit?: boolean`; `hardThreadCap`/`ec2AdmissionDecision` behavior changes as specified (both keep their existing signatures — no call-site changes needed anywhere else in the codebase).
- Consumes: nothing from Tasks 1/2 — independent code region (`hardThreadCap`/`ec2AdmissionDecision` in `compute.ts`, separate from `wallTimeMs` and the spawn-loop acquisition).

- [ ] **Step 1: Write the failing tests**

Add to `src/app/canvas/simulation/particleEngine/compute.test.ts`, at the end of the file:

```ts
describe('IO-model-aware admission (#22) and opt-in memory overcommit (#20)', () => {
  it('non-blocking admits past what a blocking server would already be shedding at, since it has no thread-count gate', () => {
    const asyncP = { ...P, blockingIoModel: false }
    // A blocking equivalent would already be at drop-503 here (hardThreadCap = 108, the
    // stack-inclusive figure). Non-blocking has no thread-count gate at all.
    expect(ec2AdmissionDecision(108, W, asyncP)).toBe('admit')
    // maxThreadsMem(W, asyncP) = floor((4096-512)/32) = 112 (no thread-stack term for async) --
    // still admits exactly at that boundary (currentRamMb == ramGiB*1024 is not '>').
    expect(ec2AdmissionDecision(112, W, asyncP)).toBe('admit')
    // One past it: currentRamMb(113, W, asyncP) = 512 + 113*32 = 4128 > 4096 -- genuinely out of RAM.
    expect(ec2AdmissionDecision(113, W, asyncP)).toBe('oom-crash')
  })

  it('allowMemoryOvercommit lets maxThreadsOverride exceed the memory-safe ceiling, enabling genuine OOM under load', () => {
    const overcommitP = { ...P, maxThreadsOverride: 200, allowMemoryOvercommit: true }
    expect(hardThreadCap(W, overcommitP)).toBe(200) // uncapped by the 108 memory-safe ceiling
    // Below the override cap (200) but currentRamMb(150, W, P) = 512 + 150*33 = 5462 > 4096 --
    // already past physical RAM. Decision 2's opt-in OOM path.
    expect(ec2AdmissionDecision(150, W, overcommitP)).toBe('oom-crash')
  })

  it('without allowMemoryOvercommit, maxThreadsOverride still clamps to the memory-safe ceiling (default unchanged)', () => {
    const overrideOnlyP = { ...P, maxThreadsOverride: 200 }
    expect(hardThreadCap(W, overrideOnlyP)).toBe(108) // unaffected -- still clamped
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: FAIL — `allowMemoryOvercommit` doesn't exist on `ComputeProfile` yet (type error), and `ec2AdmissionDecision`'s current implementation doesn't branch on `blockingIoModel` at all (the first test's `ec2AdmissionDecision(108, W, asyncP)` would return `'drop-503'` today, not `'admit'`, since the existing function ignores `blockingIoModel` entirely).

- [ ] **Step 3: Add `allowMemoryOvercommit` to `ComputeProfile`**

In `src/lib/nodeConfig.ts`, find:

```ts
export interface ComputeProfile {
  vCpu: number                       // linear compute units (1 vCPU ≈ 1 hardware thread)
  ramGiB: number
  architecture: 'x86_64' | 'arm64'   // v1: affects cost only (arm cheaper)
  cpuFamily: string                  // cosmetic in v1 (IPC fixed at COMPUTE_IPC)
  baseClockGhz: number
  blockingIoModel: boolean           // true: thread-per-request (a blocked thread holds a stack);
                                     // false: async/event-loop (no thread stack per in-flight req)
  osBaseMemoryMb?: number            // reserved RAM floor; default 512
  threadStackMb?: number             // per-in-flight thread stack (blocking only); default 1
  maxThreadsOverride?: number        // optional Tomcat-style artificial pool cap below RAM limit
}
```

Replace with:

```ts
export interface ComputeProfile {
  vCpu: number                       // linear compute units (1 vCPU ≈ 1 hardware thread)
  ramGiB: number
  architecture: 'x86_64' | 'arm64'   // v1: affects cost only (arm cheaper)
  cpuFamily: string                  // cosmetic in v1 (IPC fixed at COMPUTE_IPC)
  baseClockGhz: number
  blockingIoModel: boolean           // true: thread-per-request (a blocked thread holds a stack);
                                     // false: async/event-loop (no thread stack per in-flight req)
  osBaseMemoryMb?: number            // reserved RAM floor; default 512
  threadStackMb?: number             // per-in-flight thread stack (blocking only); default 1
  maxThreadsOverride?: number        // optional Tomcat-style artificial pool cap below RAM limit
  allowMemoryOvercommit?: boolean    // when true, maxThreadsOverride may exceed the memory-safe
                                     // ceiling instead of being clamped to it -- deliberately
                                     // models an overcommitted pool that can genuinely OOM under
                                     // load. Default/absent: today's safe behavior (cap always <=
                                     // memory-safe ceiling for blocking servers).
}
```

- [ ] **Step 4: Update `hardThreadCap` and `ec2AdmissionDecision`**

In `src/app/canvas/simulation/particleEngine/compute.ts`, find:

```ts
// The real hard admission cap: memory-bound, optionally clamped by an explicit pool size.
export function hardThreadCap(w: WorkloadDemand, p: ComputeProfile): number {
  const mem = maxThreadsMem(w, p)
  return p.maxThreadsOverride !== undefined ? Math.min(p.maxThreadsOverride, mem) : mem
}
```

Replace with:

```ts
// The real hard admission cap: memory-bound, optionally clamped by an explicit pool size. When
// allowMemoryOvercommit is set, an explicit maxThreadsOverride is allowed to exceed the
// memory-safe ceiling instead of being clamped to it -- see ec2AdmissionDecision below for how
// that then produces genuine dynamic OOM under sustained load (opt-in, Decision 2).
export function hardThreadCap(w: WorkloadDemand, p: ComputeProfile): number {
  const mem = maxThreadsMem(w, p)
  if (p.maxThreadsOverride === undefined) return mem
  return p.allowMemoryOvercommit ? p.maxThreadsOverride : Math.min(p.maxThreadsOverride, mem)
}
```

Then find:

```ts
export type Ec2Admission = 'admit' | 'drop-503' | 'oom-crash'

// Admission decision for one arriving request, given current in-flight count.
//
// Overload degrades GRACEFULLY: because the admission cap (hardThreadCap) is memory-derived, a
// correctly-provisioned node reaches its cap and sheds 503s while RAM is still (just) within
// bounds — so sustained overload manifests as rejections + rising latency, never a crash. OOM is
// reserved for a genuine, unrecoverable breach: the box cannot hold even ONE request's footprint
// (`maxThreadsMem <= 0` — e.g. osBase alone already exceeds RAM, or a single footprint overflows).
// CPU pressure never appears here — it is a latency effect, not a rejection.
export function ec2AdmissionDecision(
  activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
): Ec2Admission {
  if (maxThreadsMem(w, p) <= 0) return 'oom-crash'
  if (activeRequests >= hardThreadCap(w, p)) return 'drop-503'
  return 'admit'
}
```

Replace with:

```ts
export type Ec2Admission = 'admit' | 'drop-503' | 'oom-crash'

// Admission decision for one arriving request, given current in-flight count. Branches on
// blockingIoModel (issue #22):
//
// - Blocking (thread-per-request): overload degrades GRACEFULLY by default -- the admission cap
//   (hardThreadCap) is memory-derived, so a correctly-provisioned node reaches its cap and sheds
//   503s while RAM is still (just) within bounds. This MUST stay the default contract: an
//   existing test (ec2AdmissionDecision(100000, ...)) verifies drop-503 wins even at a wildly
//   pathological active-request count. Dynamic OOM is only reachable when the user explicitly
//   opts into allowMemoryOvercommit AND load has genuinely pushed accumulated memory past
//   physical RAM despite being under the (then-raised) cap (Decision 2).
// - Non-blocking (event-loop): no thread-count gate at all -- a real event-loop server has no
//   OS-thread-per-connection limit, it queues (socket backlog / event-loop lag) and degrades via
//   rising latency (see wallTimeMs's rho-awareness, issue #19) as the backlog grows. The only
//   hard failure is genuinely running out of memory from that accumulated backlog -- this IS the
//   primary overload mode for an event-loop server by default, not a rare opt-in edge case.
//
// CPU pressure never appears here — it is a latency effect (wallTimeMs), not a rejection.
export function ec2AdmissionDecision(
  activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
): Ec2Admission {
  if (maxThreadsMem(w, p) <= 0) return 'oom-crash'  // can't hold even one request — always fatal
  if (!p.blockingIoModel) {
    if (currentRamMb(activeRequests, w, p) > p.ramGiB * 1024) return 'oom-crash'
    return 'admit'
  }
  if (activeRequests >= hardThreadCap(w, p)) return 'drop-503'
  if (p.allowMemoryOvercommit && currentRamMb(activeRequests, w, p) > p.ramGiB * 1024) return 'oom-crash'
  return 'admit'
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/compute.test.ts`
Expected: PASS (all tests, including the 3 new ones and every pre-existing one — especially `ec2AdmissionDecision(100000, W, P)).toBe('drop-503')`, which must still pass unmodified).

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/nodeConfig.ts src/app/canvas/simulation/particleEngine/compute.ts src/app/canvas/simulation/particleEngine/compute.test.ts
git commit -m "fix(compute): branch EC2 admission on blockingIoModel, add opt-in memory overcommit

ec2AdmissionDecision applied the same binary thread-count 503 gate to
blocking and non-blocking servers alike, even though a real event-loop
server has no thread-per-connection limit and should instead queue and
degrade via latency, only failing on genuine memory exhaustion (issue
#22). Non-blocking now has no hardThreadCap admission gate; blocking
keeps today's default graceful-shedding contract unchanged (verified
by the existing 100000-active-requests drop-503 test) unless the new
opt-in ComputeProfile.allowMemoryOvercommit flag is set, in which case
an explicit maxThreadsOverride may exceed the memory-safe ceiling and
genuinely OOM under sustained load (issue #20, scoped as a narrower
secondary failure mode per the design spec's Decision 2 rather than
reverting the deliberate graceful-shedding change from commit 3257dae)."
```

---

## Manual verification (after all 3 tasks)

Via `npm run dev` + Playwright against a diagram with a couple of EC2 nodes
in a caller→callee chain (no automated visual-regression tooling exists for
the simulation canvas, matching this project's established convention):

- Drive a blocking EC2 node toward saturation and confirm reported latency
  climbs in step with the same curve now driving real thread-hold time
  (previously the graph moved but nothing else did).
- Confirm a default (no `allowMemoryOvercommit`) blocking EC2 node still
  never crashes from load alone, only sheds 503s.
- Configure a non-blocking EC2 node (`blockingIoModel: false` via
  `SimConfigPanel`'s IO Model selector) and confirm it degrades via rising
  latency/backlog rather than 503s under load, eventually OOM-crashing
  under sustained extreme overload.
- Wire an EC2 caller node with heavy downstream fan-out (several outbound
  request edges to slow targets) and confirm its own reported
  utilization/`activeRequests` now visibly rises with outbound load,
  where previously outbound calls had zero effect on the caller's own
  admission gate.

## Self-Review

**Spec coverage:** WI-A (#19) → Task 1 ✓. WI-B (#21) → Task 2 ✓. WI-C (#22,
folding in #20's Decision 2) → Task 3 ✓. All three Decisions from the design
spec are directly encoded: Decision 1 (blocking stays graceful by default)
is enforced by an existing test that must keep passing through every task;
Decision 2 (non-blocking OOM always, blocking OOM only opt-in) is Task 3's
exact branch structure; Decision 3 (conservative over-counting, no causal
rewrite) is Task 2's documented design.

**Placeholder scan:** No "TBD"/vague steps. Every code block is the literal
diff to apply, verified line-by-line against the actual current file
contents (not the original compute-model plan's now-superseded draft code —
several details, e.g. the real `ec2AdmissionDecision` OOM-check ordering,
differ from that earlier plan document and were re-derived from the actual
shipped code and its existing test suite).

**Type consistency:** `wallTimeMs`'s new 4th parameter (`rho: number`) is
used identically in Task 1's `trackRequest` call site — the only call site
in the codebase. `hardThreadCap`'s signature is unchanged (still
`(w, p) => number`) across Tasks 2 and 3 despite both modifying/depending on
it. `ComputeProfile.allowMemoryOvercommit` (Task 3) doesn't affect Task 2's
`hardThreadCap(ec2res.workload, ec2res.profile)` call, which correctly picks
up the new field automatically since it just calls the (Task-3-updated)
function.

**Known open item (intentional, not in scope):** issue #18 (move
`WorkloadDemand` from node config to packet config) is a separate,
lower-priority follow-up per the sequencing decision made alongside the
design spec — not addressed by this plan.
