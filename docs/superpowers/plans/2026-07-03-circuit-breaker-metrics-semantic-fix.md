# Circuit-Breaker Metrics/SLO Semantic Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tripped circuit breaker produce a visibly degraded picture instead of a metrics collapse — the caller's `errorRate`/SLO reflect fail-fast rejections, half-open probes with a bounded trial instead of a permanent throttle, and a protected node's outbound trickles from its in-flight backlog instead of snapping to zero.

**Architecture:** All changes live in `src/app/canvas/simulation/particleEngine.ts` (the per-frame simulation loop) and its `particleEngine/circuitBreakers.ts` sibling module (per-edge breaker state machine). No new Zustand store fields, no new SLO config, no new files — this is additive bookkeeping on the existing `EdgePath` per-edge record and the existing `CircuitBreakerEntry` per-breaker record, consumed by the existing `updateAllNodeMetrics`/`spawnParticles` functions.

**Tech Stack:** TypeScript, Vitest (`@vitest-environment jsdom` for particleEngine integration tests, matching `effectiveRps.test.ts`'s established pattern of mocking `requestAnimationFrame` and driving frames manually).

## Global Constraints

- No new Zustand store fields (`simulation.store.ts` is unchanged) and no new SLO config fields — `SimulationOverlay.tsx:219-231`'s existing SLO check (reads `p90LatencyMs`/`errorRate`/`utilization`) is not modified by this plan; it becomes correct because the `errorRate` it reads becomes correct.
- Keep the flow-rate model. Do not introduce a queue/Little's-Law rewrite of the simulation engine.
- `effectiveRps` semantics are unchanged for every existing consumer (queue integration, DB utilization, etc.) — new fields (`offeredRps`, `breakerRejectedRps`) are additive, read only by the new code this plan adds.
- Do not touch the circuit-breaker edge visualization (`particleEngine/circuitVisual.ts`, shipped separately) — it reads only `CircuitBreakerEntry.state` via `getAllBreakers()`, which this plan does not change the meaning of. Adding `trialPending` to `CircuitBreakerEntry` must not affect it.
- Full reference: `docs/superpowers/specs/2026-07-03-circuit-breaker-metrics-semantic-fix-design.md` — read it before Task 1 for the complete root-cause narrative; each task below is self-contained and doesn't require re-reading it, but it's the source of truth if anything here is ambiguous.

---

### Task 1: Caller-side rejection accounting (offered/rejected bookkeeping + errorRate composition)

Implements WI-1 and WI-2 from the spec together — WI-1's bookkeeping has no
observable effect on its own; it only becomes testable once WI-2 consumes it
into `errorRate`, so they're one task.

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (`EdgePath` interface `:379-387`, `spawnParticles` breaker branch `:695-726` and rate assignment `:809-810`, `updateAllNodeMetrics` `:1613-1616` and `:1914`)
- Test: `src/app/canvas/simulation/particleEngine/breakerRejectionAccounting.test.ts` (new)

**Interfaces:**
- Produces: `EdgePath.offeredRps?: number`, `EdgePath.breakerRejectedRps?: number` — read by Task 3 (WI-4) as well; both optional fields, default-absent for edges with no breaker config, mirroring how `effectiveRps` is already optional.
- Consumes: nothing from other tasks — this task is self-contained.

- [ ] **Step 1: Write the failing test**

Create `src/app/canvas/simulation/particleEngine/breakerRejectionAccounting.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'

// Minimal 2-node, 1-edge fixture: a loadBalancer (no circuitBreaker config of its own, no
// inbound edges — a pure entry point) calling an ec2 server (has a default circuitBreaker
// config per NODE_SIM_DEFAULTS.ec2). Forcing this edge's breaker open lets us isolate the
// caller-side errorRate contribution without any other error/utilization signal in play.
const nodes: Node<NodeData>[] = [
  { id: 'lb', type: 'loadBalancer', position: { x: 0, y: 0 }, data: { label: 'lb', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'srv', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'srv', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'lb', target: 'srv', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
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

describe('breaker rejection accounting (caller-side errorRate)', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearBreakers()
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', 300)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('raises the caller (lb) errorRate to ~1 when its only outbound edge breaker is open', () => {
    // Force the breaker open before the very first frame — spawnParticles reads
    // getBreaker(ep.id).state directly, so this takes effect immediately.
    getBreaker('e1').state = 'open'

    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    // METRICS_THROTTLE is 4 — run 4 frames to get exactly one published batch. The very
    // first published batch is unsmoothed (no EMA yet, see particleEngine.ts:2003's
    // `prev ? {...ema...} : rawMetrics`), so we can assert an exact value.
    let t = performance.now()
    for (let i = 0; i < 4; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    expect(batches.length).toBe(1)
    const lbMetrics = batches[0].get('lb')
    expect(lbMetrics).toBeDefined()
    // lb has no inbound edges (pure entry point) so baseErrorRate/cascadePressure/
    // clientErrorRate are all 0 — the only contribution is breakerRejectionRate, which
    // should be ~1 since 100% of lb's single outbound edge's offered load is rejected.
    expect(lbMetrics!.errorRate).toBeCloseTo(1, 5)
  })

  it('does not raise errorRate when the breaker is closed', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => batches.push(new Map(batch)), () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    for (let i = 0; i < 4; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    const lbMetrics = batches[0].get('lb')
    expect(lbMetrics!.errorRate).toBeCloseTo(0, 5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/breakerRejectionAccounting.test.ts`
Expected: FAIL — the first test's `lbMetrics!.errorRate` is `0`, not close to `1` (the breaker-open rejection never reaches `lb`'s errorRate today).

- [ ] **Step 3: Add `offeredRps`/`breakerRejectedRps` to `EdgePath`**

In `src/app/canvas/simulation/particleEngine.ts`, find (around line 379):

```ts
interface EdgePath {
  id: string
  edgeType: string
  sourceNodeType?: NodeType
  targetNodeType?: NodeType
  rps: number
  geoLatencyMs: number  // inter-region hop penalty; 0 for same-region or no region tags
  effectiveRps?: number // live actual RPS flowing over this edge, updated every frame
}
```

Replace with:

```ts
interface EdgePath {
  id: string
  edgeType: string
  sourceNodeType?: NodeType
  targetNodeType?: NodeType
  rps: number
  geoLatencyMs: number  // inter-region hop penalty; 0 for same-region or no region tags
  effectiveRps?: number // live actual RPS flowing over this edge, updated every frame
  offeredRps?: number         // ungated rps * mult, before any downstream gate is applied
  breakerRejectedRps?: number // portion of offeredRps shed specifically by this edge's own
                              // circuit breaker (open/half-open), before other gates (queue
                              // backpressure, idle-RPS, stall) apply on top — feeds the
                              // caller-side errorRate contribution in updateAllNodeMetrics
}
```

- [ ] **Step 4: Capture the breaker-only factor in `spawnParticles`**

In the same file, find the breaker branch (around line 695):

```ts
    const sourceNodeId = _edgesData.find(e => e.id === ep.id)?.source
    let downstreamFactor = 1.0
    if (sourceNodeId) {
```

Replace with:

```ts
    const sourceNodeId = _edgesData.find(e => e.id === ep.id)?.source
    let downstreamFactor = 1.0
    // Captured only by the breaker branch below (open/half-open) — stays 1 for every other
    // path (chaos, saturated-forward, no breaker config), meaning "nothing rejected by a
    // breaker specifically." Read by the offeredRps/breakerRejectedRps bookkeeping below.
    let breakerFactor = 1.0
    if (sourceNodeId) {
```

Then find:

```ts
      } else {
        const breaker = getBreaker(ep.id)
        if (breaker?.state === 'open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0         // circuit open: no traffic; periodic scan handles probing
        } else if (breaker?.state === 'half-open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0.1       // probe rate: small trickle tests recovery
        } else if (ep.edgeType !== 'request' && _saturatedNodes.has(sourceNodeId)) {
          // Partial degradation: saturated node forwards at reduced rate (stream/event edges only)
          const stall = _downstreamStallPressure.get(sourceNodeId) ?? 0
          downstreamFactor = Math.max(0.1, 1 - stall * 0.8)
        }
      }
```

Replace with:

```ts
      } else {
        const breaker = getBreaker(ep.id)
        if (breaker?.state === 'open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0         // circuit open: no traffic; periodic scan handles probing
          breakerFactor = 0
        } else if (breaker?.state === 'half-open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0.1       // probe rate: small trickle tests recovery
          breakerFactor = 0.1
        } else if (ep.edgeType !== 'request' && _saturatedNodes.has(sourceNodeId)) {
          // Partial degradation: saturated node forwards at reduced rate (stream/event edges only)
          const stall = _downstreamStallPressure.get(sourceNodeId) ?? 0
          downstreamFactor = Math.max(0.1, 1 - stall * 0.8)
        }
      }
```

(Task 2 will rewrite the half-open branch again — this intermediate `breakerFactor = 0.1` is correct for this task alone and is superseded, not duplicated, by Task 2.)

- [ ] **Step 5: Write `offeredRps`/`breakerRejectedRps` before `effectiveRps`**

Find (around line 809):

```ts
    const rps = ep.rps * mult * downstreamFactor
    ep.effectiveRps = rps
```

Replace with:

```ts
    ep.offeredRps = ep.rps * mult
    ep.breakerRejectedRps = breakerFactor < 1 ? ep.offeredRps * (1 - breakerFactor) : 0
    const rps = ep.rps * mult * downstreamFactor
    ep.effectiveRps = rps
```

- [ ] **Step 6: Fold rejection rate into the caller's errorRate**

In `updateAllNodeMetrics`, find (around line 1613):

```ts
    const inEdges  = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(d => d.id === ep.id)?.target === nodeId)
    const outEdges = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(d => d.id === ep.id)?.source === nodeId)
    const inRps  = inEdges.reduce((s, e) => s + (e.effectiveRps ?? (e.rps * mult)), 0)
    const outRps = outEdges.reduce((s, e) => s + (e.effectiveRps ?? (e.rps * mult)), 0)
```

Replace with:

```ts
    const inEdges  = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(d => d.id === ep.id)?.target === nodeId)
    const outEdges = _edgePaths.filter(ep => ep.edgeType !== 'dependency' && _edgesData.find(d => d.id === ep.id)?.source === nodeId)
    const inRps  = inEdges.reduce((s, e) => s + (e.effectiveRps ?? (e.rps * mult)), 0)
    const outRps = outEdges.reduce((s, e) => s + (e.effectiveRps ?? (e.rps * mult)), 0)
    // Caller-side rejection: how much of this node's own offered outbound load is being
    // shed by a breaker it's calling through. Computed from offeredRps/breakerRejectedRps
    // (Task 1's bookkeeping) rather than relying on particles actually arriving and being
    // dropped — under sustained-open, spawning is suppressed at the source, so almost
    // nothing ever arrives to trigger the existing discrete-drop path.
    const outOfferedRps  = outEdges.reduce((s, e) => s + (e.offeredRps ?? e.effectiveRps ?? (e.rps * mult)), 0)
    const outRejectedRps = outEdges.reduce((s, e) => s + (e.breakerRejectedRps ?? 0), 0)
    const breakerRejectionRate = outOfferedRps > 0 ? Math.min(1, outRejectedRps / outOfferedRps) : 0
```

Then find (around line 1914):

```ts
    const rawErrorRate = Math.min(1, baseErrorRate + cascadePressure * 0.15 + clientErrorRate)
```

Replace with:

```ts
    const rawErrorRate = Math.min(1, baseErrorRate + cascadePressure * 0.15 + clientErrorRate + breakerRejectionRate)
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/breakerRejectionAccounting.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — all prior tests (90 as of this plan's writing) plus the 2 new ones.

- [ ] **Step 9: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/breakerRejectionAccounting.test.ts
git commit -m "fix: caller's errorRate rises when its outbound circuit breaker rejects load

Adds EdgePath.offeredRps/breakerRejectedRps bookkeeping and folds the
resulting breakerRejectionRate into updateAllNodeMetrics' errorRate
composition, so a tripped breaker breaches the caller's SLO immediately
instead of the metrics collapsing to 0 while spawning is suppressed at
the source."
```

---

### Task 2: Half-open admits a fixed trial request, not a steady throttle

Implements WI-3. Depends on Task 1's `breakerFactor` local variable existing
in the breaker branch (this task edits the same branch again).

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` (`CircuitBreakerEntry` `:9-13`, `getBreaker` `:17-24`, `checkBreakerTransition` `:89-117`, `recordBreakerResult` `:44-87`)
- Modify: `src/app/canvas/simulation/particleEngine.ts` (spawn breaker branch — as edited by Task 1 — and the `n` computation right after it; arrival breaker check `:1182-1191`)
- Test: `src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts` (extend, pure unit)
- Test: `src/app/canvas/simulation/particleEngine/halfOpenTrial.test.ts` (new, integration)

**Interfaces:**
- Consumes: nothing from Task 1's `EdgePath` fields directly, but edits the same `spawnParticles` breaker branch Task 1 touched — apply this task's diff against the file *after* Task 1's commit.
- Produces: `CircuitBreakerEntry.trialPending: boolean` — not consumed by any other task in this plan (the visualization module `circuitVisual.ts` only reads `.state`, unaffected).

- [ ] **Step 1: Write the failing pure-unit tests for `trialPending`**

In `src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts`, add (inside the existing top-level `describe('circuitBreakers', ...)` block, after the last existing `it(...)` and before the closing `describe('force-open on config-less node types (C1)', ...)` block — order doesn't matter, vitest doesn't require declaration order to match execution grouping):

```ts
  it('getBreaker creates a fresh breaker with trialPending false', () => {
    const b = getBreaker('e1')
    expect(b.trialPending).toBe(false)
  })

  it('checkBreakerTransition resets trialPending to false when opening into half-open', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const nodeHealthStates = new Map<string, 'healthy' | 'degraded' | 'down'>()
    const b = getBreaker('e1')
    b.state = 'open'
    b.openedAt = 0
    b.trialPending = true // stale from a previous half-open window
    checkBreakerTransition('e1', configWithBreaker, 5000, edgesData, nodesMap, nodeHealthStates, noop)
    expect(getBreaker('e1').trialPending).toBe(false)
  })

  it('recordBreakerResult clears trialPending when a half-open trial succeeds (closes)', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const b = getBreaker('e1')
    b.state = 'half-open'
    b.trialPending = true
    recordBreakerResult('e1', false, configWithBreaker, 100, edgesData, nodesMap, new Map(), new Map(), noop)
    expect(getBreaker('e1').state).toBe('closed')
    expect(getBreaker('e1').trialPending).toBe(false)
  })

  it('recordBreakerResult clears trialPending when a half-open trial fails (reopens)', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const b = getBreaker('e1')
    b.state = 'half-open'
    b.trialPending = true
    recordBreakerResult('e1', true, configWithBreaker, 100, edgesData, nodesMap, new Map(), new Map(), noop)
    expect(getBreaker('e1').state).toBe('open')
    expect(getBreaker('e1').trialPending).toBe(false)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts`
Expected: FAIL — `CircuitBreakerEntry` has no `trialPending` field yet (TypeScript error / `undefined` !== `false`).

- [ ] **Step 3: Add `trialPending` to `CircuitBreakerEntry` and `getBreaker`**

In `src/app/canvas/simulation/particleEngine/circuitBreakers.ts`, find:

```ts
export interface CircuitBreakerEntry {
  state: CircuitState
  openedAt: number
  errorWindow: number[]
}

const _circuitBreakers = new Map<string, CircuitBreakerEntry>()

export function getBreaker(edgeId: string): CircuitBreakerEntry {
  let b = _circuitBreakers.get(edgeId)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [] }
    _circuitBreakers.set(edgeId, b)
  }
  return b
}
```

Replace with:

```ts
export interface CircuitBreakerEntry {
  state: CircuitState
  openedAt: number
  errorWindow: number[]
  // While state === 'half-open': whether the one allowed trial request has already been
  // authorized/is in flight for this half-open window. Only meaningful in that state — reset
  // to false whenever the breaker enters half-open, and whenever it leaves half-open (closed
  // or reopened) so the next half-open window starts clean.
  trialPending: boolean
}

const _circuitBreakers = new Map<string, CircuitBreakerEntry>()

export function getBreaker(edgeId: string): CircuitBreakerEntry {
  let b = _circuitBreakers.get(edgeId)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [], trialPending: false }
    _circuitBreakers.set(edgeId, b)
  }
  return b
}
```

- [ ] **Step 4: Reset `trialPending` on every half-open transition**

In the same file, find (in `checkBreakerTransition`, around line 106):

```ts
  if (
    b.state === 'open' &&
    (targetNodeId === undefined || nodeHealthStates.get(targetNodeId) !== 'down') &&
    now - b.openedAt > cb.resetMs
  ) {
    b.state = 'half-open'
    const srcLabel = edgeData?.source ? ((nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source) : edgeId
    const tgtLabel = targetNodeId    ? ((nodesMap.get(targetNodeId)?.data    as NodeData)?.label ?? targetNodeId)    : edgeId
    onEvent('circuit_half_open', targetNodeId, `Circuit half-open: ${srcLabel} → ${tgtLabel} (testing)`, 'warn')
  }
```

Replace with:

```ts
  if (
    b.state === 'open' &&
    (targetNodeId === undefined || nodeHealthStates.get(targetNodeId) !== 'down') &&
    now - b.openedAt > cb.resetMs
  ) {
    b.state = 'half-open'
    b.trialPending = false // fresh half-open window — no trial authorized yet
    const srcLabel = edgeData?.source ? ((nodesMap.get(edgeData.source)?.data as NodeData)?.label ?? edgeData.source) : edgeId
    const tgtLabel = targetNodeId    ? ((nodesMap.get(targetNodeId)?.data    as NodeData)?.label ?? targetNodeId)    : edgeId
    onEvent('circuit_half_open', targetNodeId, `Circuit half-open: ${srcLabel} → ${tgtLabel} (testing)`, 'warn')
  }
```

Then find (in `recordBreakerResult`, around line 77):

```ts
  } else if (b.state === 'half-open') {
    if (!isError) {
      b.state       = 'closed'
      b.errorWindow = []
      onEvent('circuit_close', targetNodeId, `Circuit closed: ${srcLabel} → ${tgtLabel}`, 'info')
    } else {
      b.state    = 'open'
      b.openedAt = now
    }
  }
```

Replace with:

```ts
  } else if (b.state === 'half-open') {
    b.trialPending = false // the trial resolved one way or the other — clear it either way
    if (!isError) {
      b.state       = 'closed'
      b.errorWindow = []
      onEvent('circuit_close', targetNodeId, `Circuit closed: ${srcLabel} → ${tgtLabel}`, 'info')
    } else {
      b.state    = 'open'
      b.openedAt = now
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts`
Expected: PASS (all tests in this file, including the 4 new ones)

- [ ] **Step 6: Write the failing integration test for the spawn-side trial gate**

Create `src/app/canvas/simulation/particleEngine/halfOpenTrial.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks, getParticleCountForEdge } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'

const nodes: Node<NodeData>[] = [
  { id: 'lb', type: 'loadBalancer', position: { x: 0, y: 0 }, data: { label: 'lb', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'srv', type: 'ec2', position: { x: 200, y: 0 }, data: { label: 'srv', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'lb', target: 'srv', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
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

describe('half-open admits exactly one trial request', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearBreakers()
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    // High rps — without the trial gate this would mint many particles per frame
    // (particlesPerSec = 100_000 / 10 = 10_000; even one 16ms frame at downstreamFactor=1
    // computes spawnChance ≈ 160, far more than 1).
    useSimulationStore.getState().setEdgeRps('e1', 100_000)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('never has more than 1 particle in flight on a half-open edge', () => {
    getBreaker('e1').state = 'half-open'
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    for (let i = 0; i < 20; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
      expect(getParticleCountForEdge('e1')).toBeLessThanOrEqual(1)
    }
  })

  it('authorizes exactly one trial on entry, not zero', () => {
    getBreaker('e1').state = 'half-open'
    setCallbacks(() => {}, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    let t = performance.now()
    let sawAParticle = false
    for (let i = 0; i < 20; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
      if (getParticleCountForEdge('e1') >= 1) sawAParticle = true
    }
    expect(sawAParticle).toBe(true)
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/halfOpenTrial.test.ts`
Expected: FAIL on the first test — today's half-open logic (`downstreamFactor = 0.1` at spawn) mints many more than 1 particle at 100k rps.

- [ ] **Step 8: Rewrite the half-open spawn branch to authorize exactly one trial**

In `src/app/canvas/simulation/particleEngine.ts`, find (this is Task 1's already-applied version of the breaker branch):

```ts
        if (breaker?.state === 'open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0         // circuit open: no traffic; periodic scan handles probing
          breakerFactor = 0
        } else if (breaker?.state === 'half-open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0.1       // probe rate: small trickle tests recovery
          breakerFactor = 0.1
        } else if (ep.edgeType !== 'request' && _saturatedNodes.has(sourceNodeId)) {
```

Replace with:

```ts
        if (breaker?.state === 'open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          downstreamFactor = 0         // circuit open: no traffic; periodic scan handles probing
          breakerFactor = 0
        } else if (breaker?.state === 'half-open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
          if (breaker.trialPending) {
            downstreamFactor = 0       // a trial is already in flight — hold everything else back
          } else {
            breaker.trialPending = true
            downstreamFactor = 1       // let the forced n=1 override below size exactly one particle
            halfOpenTrialEdgesThisFrame.add(ep.id)
          }
          breakerFactor = 0            // half-open still counts as ~fully rejected for the caller's
                                        // errorRate — only one internal probe gets through, so from
                                        // the caller's perspective its offered load is still shed
        } else if (ep.edgeType !== 'request' && _saturatedNodes.has(sourceNodeId)) {
```

This introduces `halfOpenTrialEdgesThisFrame`, a per-frame scratch set. Find the top of `spawnParticles` (around line 680):

```ts
function spawnParticles(now: number, delta: number) {
  let total = 0
  for (const arr of state.particles.values()) total += arr.length
```

Replace with:

```ts
function spawnParticles(now: number, delta: number) {
  let total = 0
  for (const arr of state.particles.values()) total += arr.length
  // Edges whose half-open trial was freshly authorized this frame (set just below, in the
  // per-edge loop) — read right after `n` is computed for that same edge to force exactly
  // one particle to mint, overriding the edge's own batch-rate math. Rebuilt every call;
  // never read across frames.
  const halfOpenTrialEdgesThisFrame = new Set<string>()
```

Then find (around line 809-814, this is Task 1's version):

```ts
    ep.offeredRps = ep.rps * mult
    ep.breakerRejectedRps = breakerFactor < 1 ? ep.offeredRps * (1 - breakerFactor) : 0
    const rps = ep.rps * mult * downstreamFactor
    ep.effectiveRps = rps
    const particlesPerSec = rps / PARTICLE_REQUEST_RATIO
    const spawnChance = particlesPerSec * (delta / 1000) * _speed
    const n = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0)
    if (n === 0) continue
```

Replace with:

```ts
    ep.offeredRps = ep.rps * mult
    ep.breakerRejectedRps = breakerFactor < 1 ? ep.offeredRps * (1 - breakerFactor) : 0
    const rps = ep.rps * mult * downstreamFactor
    ep.effectiveRps = rps
    const particlesPerSec = rps / PARTICLE_REQUEST_RATIO
    const spawnChance = particlesPerSec * (delta / 1000) * _speed
    let n = Math.floor(spawnChance) + (Math.random() < (spawnChance % 1) ? 1 : 0)
    // A freshly authorized half-open trial must mint exactly once this frame regardless of
    // the edge's own rate math — a low-rps edge can legitimately round spawnChance down to 0,
    // which would otherwise leave trialPending stuck true forever with nothing left to ever
    // resolve it (every later frame sees trialPending=true → downstreamFactor=0 → n=0 again).
    if (halfOpenTrialEdgesThisFrame.has(ep.id)) n = 1
    if (n === 0) continue
```

- [ ] **Step 9: Remove the arrival-time double-throttle**

In the same file, find (around line 1182):

```ts
  const breakerState = checkBreakerTransitionLocal(ep.id, config, now)
  if (breakerState === 'open') {
    dropParticle(ep, targetNodeId, particle)
    recordBreakerResultLocal(ep.id, true, config, now)
    return
  }
  if (breakerState === 'half-open' && Math.random() > 0.1) {
    dropParticle(ep, targetNodeId, particle)
    return
  }
```

Replace with:

```ts
  const breakerState = checkBreakerTransitionLocal(ep.id, config, now)
  if (breakerState === 'open') {
    dropParticle(ep, targetNodeId, particle)
    recordBreakerResultLocal(ep.id, true, config, now)
    return
  }
  // A particle reaching here on a half-open edge IS the one trial the spawn-side gate
  // authorized (particleEngine.ts's spawnParticles) — no additional admission throttle.
  // It proceeds through the normal downstream checks below exactly like a closed-breaker
  // particle would; recordBreakerResultLocal on its eventual success/drop resolves
  // half-open → closed/open (see circuitBreakers.ts's recordBreakerResult).
```

- [ ] **Step 10: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/halfOpenTrial.test.ts`
Expected: PASS (both tests)

- [ ] **Step 11: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — all prior tests plus the 4 new `circuitBreakers.test.ts` cases and the 2 new `halfOpenTrial.test.ts` cases.

- [ ] **Step 12: Commit**

```bash
git add src/app/canvas/simulation/particleEngine/circuitBreakers.ts src/app/canvas/simulation/particleEngine/circuitBreakers.test.ts src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/halfOpenTrial.test.ts
git commit -m "fix: half-open admits one fixed trial request instead of a steady throttle

Replaces the double-throttled ~1% steady probe (0.1 spawn factor AND a
separate 0.1 arrival admission probability) with a bounded trial gate:
exactly one particle is authorized per half-open window via a new
CircuitBreakerEntry.trialPending flag, cleared on transition into or out
of half-open. Matches Hystrix/resilience4j/Polly semantics instead of
throttling forever."
```

---

### Task 3: Outbound trickles from the accepted in-flight backlog

Implements WI-4. Independent of Tasks 1 and 2's specific edits (different
code region), but written against the file state after both are committed.

**Files:**
- Modify: `src/app/canvas/simulation/particleEngine.ts` (idle-RPS gate `:733-747`)
- Test: `src/app/canvas/simulation/particleEngine/outboundBacklogDrain.test.ts` (new)

**Interfaces:**
- Consumes: `_lbActiveRequests` (existing module-level map, already populated by `trackRequest`) — no new field needed.
- Produces: nothing consumed by later tasks — this is the last task in this plan.

- [ ] **Step 1: Write the failing test**

Create `src/app/canvas/simulation/particleEngine/outboundBacklogDrain.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, Edge } from '@xyflow/react'
import type { NodeData, EdgeData } from '../../../../lib/nodeConfig'
import { useSimulationStore, type NodeMetrics } from '../../../store/simulation.store'
import { startSimulation, stopSimulation, setCallbacks } from '../particleEngine'
import { getBreaker, clearBreakers } from './circuitBreakers'

// 3-node chain: lb -> srv -> db. srv's inbound edge (lb->srv) breaker will be forced open,
// cutting srv's live inRps to 0 — srv's OWN outbound edge (srv->db) is what we're checking:
// it should trickle from srv's accepted backlog rather than snap to 0 in the same frame.
const nodes: Node<NodeData>[] = [
  { id: 'lb',  type: 'loadBalancer', position: { x: 0, y: 0 },   data: { label: 'lb',  subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'srv', type: 'ec2',          position: { x: 200, y: 0 }, data: { label: 'srv', subtitle: '', status: 'healthy', notes: '', warnings: [] } },
  { id: 'db',  type: 'dbSql',        position: { x: 400, y: 0 }, data: { label: 'db',  subtitle: '', status: 'healthy', notes: '', warnings: [] } },
]
const edges: Edge<EdgeData>[] = [
  { id: 'e1', source: 'lb',  target: 'srv', type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
  { id: 'e2', source: 'srv', target: 'db',  type: 'request', data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } },
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

describe('outbound trickles from the accepted backlog when inbound is breaker-gated', () => {
  let rafCallback: ((t: number) => void) | null = null
  let rafSpy: ReturnType<typeof vi.spyOn>
  let cafSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearBreakers()
    rafCallback = null
    rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      rafCallback = cb as unknown as (t: number) => void
      return 1
    })
    cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    useSimulationStore.getState().setRunning(true)
    useSimulationStore.getState().setPaused(false)
    useSimulationStore.getState().setEdgeRps('e1', 500)
    useSimulationStore.getState().setEdgeRps('e2', 500)
  })

  afterEach(() => {
    stopSimulation()
    useSimulationStore.getState().setRunning(false)
    rafSpy.mockRestore()
    cafSpy.mockRestore()
  })

  it('keeps srv->db outRps above 0 for a beat after lb->srv breaker opens (backlog draining)', () => {
    const batches: Map<string, NodeMetrics>[] = []
    setCallbacks((batch) => { for (const [k, v] of batch) batches.push(new Map([[k, v]])) }, () => {}, () => {})

    const canvas = makeFakeCanvas()
    startSimulation(canvas, nodes, edges, 1)

    // Run long enough for srv to accept real in-flight requests (trackRequest increments
    // _lbActiveRequests on arrival) before the breaker trips, so there's a genuine backlog.
    let t = performance.now()
    for (let i = 0; i < 20; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }

    // Now trip srv's inbound breaker open and immediately check the very next published tick.
    getBreaker('e1').state = 'open'
    let sawNonZeroOutRpsWhileGated = false
    for (let i = 0; i < 4; i++) {
      const cb = rafCallback!
      rafCallback = null
      t += 16
      cb(t)
    }
    for (const batch of batches) {
      const srv = batch.get('srv')
      if (srv && srv.outRps > 0) sawNonZeroOutRpsWhileGated = true
    }
    expect(sawNonZeroOutRpsWhileGated).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/outboundBacklogDrain.test.ts`
Expected: FAIL — today, the instant `lb->srv` opens, `srv`'s `inRps` reads ~0 next tick, the idle-RPS gate zeroes `srv`'s outbound (`srv->db`) in the same tick with no backlog-aware trickle, so `outRps` for `srv` reads 0 across all captured batches.

- [ ] **Step 3: Make the idle-RPS gate trickle from the backlog**

In `src/app/canvas/simulation/particleEngine.ts`, find (around line 733):

```ts
    const IDLE_RPS_THRESHOLD = 5  // below this the node is considered effectively idle
    if (downstreamFactor > 0 && sourceNodeId && ep.sourceNodeType
        && !_INBOUND_GATE_EXEMPT_TYPES.has(ep.sourceNodeType)) {
      const hasInbound = _edgesData.some(e => e.target === sourceNodeId)
      if (hasInbound) {
        // Treat missing metrics as 0 RPS (simulation just started) rather than skipping the gate.
        // Without this, all downstream nodes fire at 100% for the first metrics cycle (~200ms).
        const inRps = _smoothedMetrics.get(sourceNodeId)?.inRps ?? 0
        if (inRps < IDLE_RPS_THRESHOLD) {
          // Soft fade: 0 RPS → 0%, 5 RPS → 100%. Saturates immediately above the threshold.
          downstreamFactor *= inRps / IDLE_RPS_THRESHOLD
        }
        // Above the threshold: no scaling — configured outbound flows freely.
      }
    }
```

Replace with:

```ts
    const IDLE_RPS_THRESHOLD = 5  // below this the node is considered effectively idle
    if (downstreamFactor > 0 && sourceNodeId && ep.sourceNodeType
        && !_INBOUND_GATE_EXEMPT_TYPES.has(ep.sourceNodeType)) {
      const hasInbound = _edgesData.some(e => e.target === sourceNodeId)
      if (hasInbound) {
        // Treat missing metrics as 0 RPS (simulation just started) rather than skipping the gate.
        // Without this, all downstream nodes fire at 100% for the first metrics cycle (~200ms).
        const inRps = _smoothedMetrics.get(sourceNodeId)?.inRps ?? 0
        if (inRps < IDLE_RPS_THRESHOLD) {
          const backlog = _lbActiveRequests.get(sourceNodeId) ?? 0
          if (backlog > 0) {
            // Still draining accepted work (e.g. inbound just got breaker-gated) — trickle
            // outbound proportional to the decaying backlog instead of snapping to 0 in the
            // same tick as inbound. `?? 200` matches the thread-pool fallback already used for
            // this class of source node elsewhere in this file (maxConcurrency default below).
            const maxBacklogRef = Math.max(1, effectiveConfig(sourceNodeId, ep.sourceNodeType).maxConcurrency ?? 200)
            downstreamFactor *= Math.max(inRps / IDLE_RPS_THRESHOLD, Math.min(1, backlog / maxBacklogRef))
          } else {
            // Soft fade: 0 RPS → 0%, 5 RPS → 100%. Saturates immediately above the threshold.
            downstreamFactor *= inRps / IDLE_RPS_THRESHOLD
          }
        }
        // Above the threshold: no scaling — configured outbound flows freely.
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/canvas/simulation/particleEngine/outboundBacklogDrain.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — all prior tests plus the 1 new test in this file. Pay particular attention to `threadPoolAcquireRelease.test.ts` and `queueDepth.test.ts`, which also exercise the idle-RPS gate's surrounding code path.

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/simulation/particleEngine.ts src/app/canvas/simulation/particleEngine/outboundBacklogDrain.test.ts
git commit -m "fix: outbound trickles from the accepted backlog instead of snapping to 0

_lbActiveRequests already tracked accepted in-flight work and already
reached the UI as NodeMetrics.activeRequests, but nothing used it to
shape outbound RPS. The idle-RPS gate now checks a source node's live
backlog before zeroing its outbound edges, so a node whose inbound
breaker just tripped keeps visibly draining for a beat instead of
instantly going dark."
```

---

## Manual verification (after all 3 tasks)

Automated coverage above exercises the engine's pure math in isolation.
Before considering this plan done, verify the full picture end-to-end via
`npm run dev` + Playwright against the "Load Balanced Cluster" vault
template (matches this project's established convention — no automated
visual-regression tooling exists for the simulation canvas):

- Start the simulation, saturate `app-server-1` (e.g. via Chaos traffic
  mode) until its inbound breaker trips open; confirm the **App Load
  Balancer's** `errorRate`/SLO status visibly degrade within one metrics
  tick (Properties/Analytics panel), while `app-server-1`'s outbound traffic
  to RDS Postgres fades rather than instantly snapping to 0.
- Let the breaker's `resetMs` elapse; confirm exactly one particle probes
  the half-open edge at a time (watch the circuit-breaker sheath
  visualization — it should show sparse single-particle traffic, not a
  steady trickle), and that a single success/failure closes/reopens it.
- Confirm the circuit-breaker edge visualization (sheath/scan/pulse, shipped
  separately) still renders correctly in all three states — this plan adds
  `trialPending` to `CircuitBreakerEntry` but does not change `.state`
  semantics, which is all that visualization reads.
