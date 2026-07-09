# Phase 2 Plan Fragment — Tasks 10–12 (metrics pyramid + events, replay + tracing, engine facade + simulation.store v2 + integration test)

> Expands skeleton specs T10–T12. Format follows the Phase 1 plan
> (`docs/superpowers/plans/2026-07-08-phase1-world-model-shell.md`): Files / Interfaces /
> checkbox TDD steps with complete code / exact run commands / commit step.
> Contracts are FROZEN (`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`);
> `src/lib/worldEngine/types.ts` (T1) is their verbatim transcription and is never reshaped here.

## SKELETON CONCERNS

1. **`TracedRequest.hops[].hopClass` includes `'internet'` but `lib/world`'s `HopClass` does not.**
   T8's `InstanceFlow.downstream[].hopClass` is the world `HopClass` (no `'internet'`), so a
   Phase-2 trace can never emit an `'internet'` hop — the client→edge hop is not traced.
   Contract type transcribed verbatim regardless; the union member simply goes unused until a
   later phase traces the client leg. Not deviated from.
2. **T10's `accumulateStep(state, flows, hostResults, vps, nic, health, simMs)` and
   `buildBatch(state, doc, compiled, routingSnapshot, totals, simMs)` leave parameter types
   unspecified.** This fragment defines them precisely (`RoutingSnapshot`, `VpsPublish`,
   window-`totals` = bytes since last batch) as additive type definitions inside `metrics.ts`;
   parameter names and order match the skeleton exactly.
3. **Contracts' "Store publication" says the v2 store holds *exactly* running/timeScale/
   latestBatch/events/healthOverrides + control actions, but skeleton T15 requires the store to
   also gain `scrubIndex`.** T12 includes `scrubIndex`/`scrubBatch` from the start (the
   skeleton's own sanctioned additive extension) so T15 does not have to reshape the store.
4. **T11's `createTracer(rng)` gives no signature for the per-window sampling call.** Defined
   here as `sample(flows, compiled, doc, simMs, populationOf?)` — additive; `getTraced(scope)`
   matches the skeleton verbatim.
5. **The store rewrite orphans ~45 legacy files that still import the old
   `simulation.store` exports and are only deleted in T17.** Resolved concretely in T12 Step 5
   (verbatim `simulationLegacy.store.ts` copy + mechanical import-specifier rename) so
   `npm run build` stays green at the T12 commit; fallback contingency spelled out there.
6. **Baseline synthetic populations bypass DNS** (controller ruling, incorporated in T12's
   facade step order): populations with ids `baseline:<regionId>` are never passed through
   `resolveRegion` — the facade routes them directly to their own region. They model in-region
   ambient load, not geo clients, so TTL/failover semantics do not apply to them.
7. **T7/T9 construction:** the skeleton lists no `createFailoverState()`/breaker-map factory.
   The facade constructs the `FailoverState` literal and a plain `new Map()` breaker map itself,
   matching the T9/T7 interfaces exactly rather than assuming unlisted exports. It does assume
   the ported breaker object exposes `.state: 'closed' | 'open' | 'half-open'` (that is the
   ported legacy shape T7 specifies as its state machine).

---

### Task 10: Metrics pyramid + events ring

**Files:**
- Create: `src/lib/worldEngine/metrics.ts`
- Create: `src/lib/worldEngine/events.ts`
- Test: `src/lib/worldEngine/metrics.test.ts`
- Test: `src/lib/worldEngine/events.test.ts`

**Interfaces:**
- Consumes: contract types from `./types` (`MetricsBatch`, `InstanceMetrics`, `ServerMetrics`,
  `AzMetrics`, `RegionMetrics`, `WorldMetrics`, `EngineEvent`, `EngineEventKind`,
  `HealthState`); `InstanceFlow` from `./flows` (T8); `HostStepResult` from `./hostScheduler`
  (T4); `NicState` from `./networkRuntime` (T6); world types from `../world/types`.
- Produces (skeleton-exact):
  - `createMetricsState(): MetricsState`
  - `accumulateStep(state, flows, hostResults, vps, nic, health, simMs): void` — every step
  - `buildBatch(state, doc, compiled, routingSnapshot, totals, simMs): MetricsBatch` — 1 Hz, EMA α=0.3
  - `createEventRing(cap = 500): { push(e: EngineEvent): void; drain(): EngineEvent[]; all(): EngineEvent[] }`
  - `mkEvent(kind, severity, message, affected, simMs, idSeq): EngineEvent`
  - Supporting types defined here and reused by T12: `RoutingSnapshot`, `VpsPublish`, `EventRing`.
- Batch population rules (skeleton verbatim): every contracts field populated —
  `coreUtilization` from host results, `ramByInstance` ordered by ramMb desc,
  `healthScore = 100 × (1 − errorRate) × healthFactor` with healthFactor 1 / 0.6 / 0.15,
  `inboundByPopulation` + `populationRoutes` from the routing snapshot, byte rates from
  window-totals EMA. **No field is ever `undefined`.**

Semantics locked for this task:

- **Windows:** `accumulateStep` accumulates per-step sums into a 1-second window
  (10 × 100ms steps). `buildBatch` converts the window to per-second values, blends them into
  the published values with EMA α = 0.3 (`published = 0.3·window + 0.7·prevPublished`; the
  first window seeds `published = window` directly), then resets the window. p50/p99 come from
  the sorted per-window latency samples, then EMA-blend like every other published value.
- **Derived fields:** `activeConnections = admittedRps × avgLatencyMs / 1000` (Little's law);
  `cpuCoresUsed = admittedRps × cpuMsPerRequest / 1000`; `ramMb = ramBaseMb +
  ramPerConnMb × activeConnections`; `diskIoFraction = min(1, Σ(admittedRps ×
  diskIoPerRequest) / 100)` (documented normalization: 100 io-units/sec = saturated);
  `nicInMbps/nicOutMbps = windowBytes × 8 / 1e6` (window is exactly 1s).
- **Health lookup retention:** `accumulateStep` stores its latest `hostResults`/`vps`/`health`
  arguments on the state so `buildBatch` (whose skeleton signature does not receive them) reads
  the most recent step's values. This is why the last three positional params exist on
  `accumulateStep` and not on `buildBatch`.
- **`totals` param of `buildBatch`** = `{ crossAzBytes, crossRegionBytes, internetBytes }`
  bytes accumulated by the caller since the last batch (T12 sums T8's per-step totals over the
  window). Published as bytes/sec (window is 1s) with the same EMA.
- **Ring:** `push` appends and drops oldest past cap; `drain()` returns (and clears) only the
  events pushed since the previous `drain()` — T12 uses this for `ReplayFrame.events` windows;
  `all()` returns the retained ring oldest→newest.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/worldEngine/metrics.test.ts
import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { createMetricsState, accumulateStep, buildBatch, type RoutingSnapshot, type VpsPublish } from './metrics'
import type { InstanceFlow } from './flows'
import type { HostStepResult } from './hostScheduler'
import type { NicState } from './networkRuntime'
import type { HealthState } from './types'

// 1 region / 1 AZ / 2 servers / 1 blueprint / 2 single-count placements → 2 instances.
function fixture() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const s1 = createServer(az.id, getPreset('vps-medium')!)
  const s2 = createServer(az.id, getPreset('vps-medium')!)
  const bp = createBlueprint('api', 0)
  const p1 = createPlacement(bp.id, s1.id)
  const p2 = createPlacement(bp.id, s2.id)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })
  doc.blueprints[bp.id] = bp
  Object.assign(doc.placements, { [p1.id]: p1, [p2.id]: p2 })
  const pop = { id: 'pop-1', label: 'us', lat: 40, lon: -75, peakRps: 100, diurnal: 'flat' as const }
  doc.populations[pop.id] = pop
  const compiled = compileWorld(doc)
  const i1 = instanceId(p1.id, 0)
  const i2 = instanceId(p2.id, 0)
  return { doc, compiled, region, az, s1, s2, bp, i1, i2 }
}

function flow(id: string, rps: number, over: Partial<InstanceFlow> = {}): InstanceFlow {
  return {
    instanceId: id, offeredRps: rps, admittedRps: rps, errorRps: 0, refusedRps: 0,
    serviceLatencyMs: 10, downstream: [], ...over,
  }
}

function host(vcpu = 4): HostStepResult {
  return {
    cpuPressure: 0.5, coreUtilization: Array.from({ length: vcpu }, (_, i) => (i < 2 ? 0.5 : 0)),
    latencyMultiplier: 1, admittedScale: 1, ramUsedMb: 1024, oomVictim: null,
  }
}

const healthy: (id: string) => HealthState = () => 'healthy'
const nic: NicState = { inBytesThisStep: 125_000, outBytesThisStep: 250_000 }

function accumulate1s(state: ReturnType<typeof createMetricsState>, f: ReturnType<typeof fixture>, rps1: number, rps2: number, health = healthy, errorRps = 0) {
  for (let step = 0; step < 10; step++) {
    accumulateStep(
      state,
      { [f.i1]: flow(f.i1, rps1, { errorRps }), [f.i2]: flow(f.i2, rps2) },
      { [f.s1.id]: host(), [f.s2.id]: host() },
      { [f.s1.id]: { steal: 0.05, effectiveVcpuFactor: 1, creditsFraction: 0.8 } as VpsPublish, [f.s2.id]: { steal: 0, effectiveVcpuFactor: 1, creditsFraction: null } as VpsPublish },
      { [f.s1.id]: nic, [f.s2.id]: nic },
      health,
      step * 100,
    )
  }
}

const snapshot = (f: ReturnType<typeof fixture>, rps: number): RoutingSnapshot => ({
  populationRoutes: [{ populationId: 'pop-1', regionId: f.region.id, rps }],
})
const totals = { crossAzBytes: 1_000_000, crossRegionBytes: 2_000_000, internetBytes: 500_000 }

describe('metrics pyramid', () => {
  it('sums the pyramid: az rps = Σ instance rps, region and world follow', () => {
    const f = fixture()
    const state = createMetricsState()
    accumulate1s(state, f, 60, 40)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    expect(batch.instances[f.i1].rps).toBeCloseTo(60, 1)
    expect(batch.instances[f.i2].rps).toBeCloseTo(40, 1)
    expect(batch.azs[f.az.id].rps).toBeCloseTo(100, 1)
    expect(batch.regions[f.region.id].rps).toBeCloseTo(100, 1)
    expect(batch.world.totalRps).toBeCloseTo(100, 1)
    expect(batch.azs[f.az.id].serverCount).toBe(2)
    expect(batch.azs[f.az.id].instanceCount).toBe(2)
  })

  it('EMA-smooths across batches with α=0.3 (first window seeds directly)', () => {
    const f = fixture()
    const state = createMetricsState()
    accumulate1s(state, f, 100, 0)
    const b1 = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    expect(b1.instances[f.i1].rps).toBeCloseTo(100, 1)      // seeded, not 0.3×100
    accumulate1s(state, f, 0, 0)
    const b2 = buildBatch(state, f.doc, f.compiled, snapshot(f, 0), totals, 2000)
    expect(b2.instances[f.i1].rps).toBeCloseTo(70, 1)       // 0.3·0 + 0.7·100
  })

  it('computes healthScore = 100 × (1 − errorRate) × healthFactor', () => {
    const f = fixture()
    const state = createMetricsState()
    // 20 err of 100 admitted on i1, i2 idle → az errorRate 0.2; az degraded.
    const health: (id: string) => HealthState = (id) => (id === f.az.id ? 'degraded' : 'healthy')
    accumulate1s(state, f, 100, 0, health, 20)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    expect(batch.azs[f.az.id].errorRate).toBeCloseTo(0.2, 2)
    expect(batch.azs[f.az.id].healthScore).toBeCloseTo(100 * 0.8 * 0.6, 1)   // 48
    expect(batch.azs[f.az.id].health).toBe('degraded')
  })

  it('populates every contract field — nothing undefined anywhere in the batch', () => {
    const f = fixture()
    const state = createMetricsState()
    accumulate1s(state, f, 60, 40)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    const assertDefined = (obj: unknown, path: string) => {
      expect(obj, path).not.toBeUndefined()
      if (obj !== null && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) assertDefined(v, `${path}.${k}`)
      }
    }
    assertDefined(batch, 'batch')
    // Spot-check the tricky contract fields.
    expect(batch.servers[f.s1.id].coreUtilization).toHaveLength(4)
    expect(batch.servers[f.s1.id].burstCredits).toBeCloseTo(0.8, 2)
    expect(batch.servers[f.s2.id].burstCredits).toBeNull()
    expect(batch.servers[f.s1.id].stealFraction).toBeCloseTo(0.05, 2)
    expect(batch.servers[f.s1.id].nicInMbps).toBeCloseTo((125_000 * 10 * 8) / 1e6, 1)
    expect(batch.regions[f.region.id].inboundByPopulation).toEqual([{ populationId: 'pop-1', rps: 100 }])
    expect(batch.world.populationRoutes).toEqual([{ populationId: 'pop-1', regionId: f.region.id, rps: 100 }])
    expect(batch.world.crossAzBytesPerSec).toBeCloseTo(1_000_000, -3)
    expect(batch.world.crossRegionBytesPerSec).toBeCloseTo(2_000_000, -3)
    expect(batch.world.internetEgressBytesPerSec).toBeCloseTo(500_000, -3)
  })

  it('orders ramByInstance by ramMb descending', () => {
    const f = fixture()
    // Put both instances on s1 by moving p2's placement server: simplest — build flows with
    // differing connection loads on the same server via a second placement fixture.
    const state = createMetricsState()
    // i1 heavy (100 rps → more conns/ram), i2 idle but still resident on its own server.
    accumulate1s(state, f, 100, 1)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 101), totals, 1000)
    const strata = batch.servers[f.s1.id].ramByInstance
    expect(strata.length).toBeGreaterThan(0)
    for (let i = 1; i < strata.length; i++) expect(strata[i - 1].ramMb).toBeGreaterThanOrEqual(strata[i].ramMb)
    expect(strata[0]).toMatchObject({ instanceId: f.i1, blueprintId: f.bp.id })
  })
})
```

```ts
// src/lib/worldEngine/events.test.ts
import { describe, it, expect } from 'vitest'
import { createEventRing, mkEvent } from './events'

describe('engine event ring', () => {
  it('mkEvent builds a contract-complete EngineEvent with a sequenced id', () => {
    const e = mkEvent('oom_kill', 'critical', 'instance x killed', ['inst-1', 'srv-1'], 4200, 7)
    expect(e).toEqual({
      id: 'evt-7', simMs: 4200, kind: 'oom_kill', severity: 'critical',
      message: 'instance x killed', affected: ['inst-1', 'srv-1'],
    })
  })

  it('caps the ring at cap, dropping oldest', () => {
    const ring = createEventRing(5)
    for (let i = 0; i < 8; i++) ring.push(mkEvent('health_check_failed', 'warning', `e${i}`, [], i * 100, i))
    const all = ring.all()
    expect(all).toHaveLength(5)
    expect(all[0].id).toBe('evt-3')     // oldest retained
    expect(all[4].id).toBe('evt-7')     // newest last
  })

  it('drain returns only events since the previous drain, without emptying the ring', () => {
    const ring = createEventRing(500)
    ring.push(mkEvent('outage_triggered', 'critical', 'a', [], 0, 0))
    ring.push(mkEvent('outage_cleared', 'info', 'b', [], 100, 1))
    expect(ring.drain().map(e => e.id)).toEqual(['evt-0', 'evt-1'])
    expect(ring.drain()).toEqual([])                       // window emptied
    ring.push(mkEvent('breaker_open', 'warning', 'c', [], 200, 2))
    expect(ring.drain().map(e => e.id)).toEqual(['evt-2']) // only the new window
    expect(ring.all()).toHaveLength(3)                     // ring keeps everything ≤ cap
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/worldEngine/metrics.test.ts src/lib/worldEngine/events.test.ts`
Expected: FAIL — `Cannot find module './metrics'` / `Cannot find module './events'`

- [ ] **Step 3: Write `events.ts`**

```ts
// src/lib/worldEngine/events.ts
// EngineEvent construction + bounded ring. The facade owns the id sequence (idSeq param)
// so event ids stay monotonic across subsystems.
import type { EngineEvent, EngineEventKind } from './types'

export interface EventRing {
  push(e: EngineEvent): void
  drain(): EngineEvent[]   // events pushed since the last drain (ReplayFrame windows)
  all(): EngineEvent[]     // retained ring, oldest → newest
}

export function createEventRing(cap = 500): EventRing {
  const ring: EngineEvent[] = []
  let pending: EngineEvent[] = []
  return {
    push(e) {
      ring.push(e)
      if (ring.length > cap) ring.splice(0, ring.length - cap)
      pending.push(e)
    },
    drain() {
      const out = pending
      pending = []
      return out
    },
    all() {
      return [...ring]
    },
  }
}

export function mkEvent(
  kind: EngineEventKind,
  severity: EngineEvent['severity'],
  message: string,
  affected: string[],
  simMs: number,
  idSeq: number,
): EngineEvent {
  return { id: `evt-${idSeq}`, simMs, kind, severity, message, affected }
}
```

- [ ] **Step 4: Write `metrics.ts`**

```ts
// src/lib/worldEngine/metrics.ts
// The metrics pyramid: per-step accumulation into 1s windows, published as a MetricsBatch
// at 1 Hz with EMA smoothing (α = 0.3, ported legacy constant). Every contract field is
// populated — no field is ever left undefined.
import type {
  MetricsBatch, InstanceMetrics, ServerMetrics, AzMetrics, RegionMetrics, WorldMetrics,
  HealthState,
} from './types'
import type { InstanceFlow } from './flows'
import type { HostStepResult } from './hostScheduler'
import type { NicState } from './networkRuntime'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId,
} from '../world/types'

const EMA_ALPHA = 0.3
const HEALTH_FACTOR: Record<HealthState, number> = { healthy: 1, degraded: 0.6, down: 0.15 }

// What the facade publishes per server per step from T5's stepVps result (steady fields only).
export interface VpsPublish {
  steal: number
  effectiveVcpuFactor: number
  creditsFraction: number | null
}

// Routing attribution captured by the facade at batch time. Single source for BOTH
// WorldMetrics.populationRoutes and RegionMetrics.inboundByPopulation.
export interface RoutingSnapshot {
  populationRoutes: { populationId: PopulationId; regionId: RegionId; rps: number }[]
}

interface InstanceWindow {
  steps: number
  admittedSum: number
  errorSum: number
  latencies: number[]   // per-step sampled service latencies (window-local, sorted at batch)
}

interface ServerWindow { inBytes: number; outBytes: number }

export interface MetricsState {
  window: Map<InstanceId, InstanceWindow>
  serverWindow: Map<ServerId, ServerWindow>
  // EMA-published values, keyed per entity. Missing key = first window seeds directly.
  published: Map<string, number>
  // Latest step's side-channel values, retained for buildBatch (its skeleton signature
  // does not receive them — see plan Semantics).
  lastHost: Record<ServerId, HostStepResult>
  lastVps: Record<ServerId, VpsPublish>
  lastHealth: (id: string) => HealthState
}

export function createMetricsState(): MetricsState {
  return {
    window: new Map(),
    serverWindow: new Map(),
    published: new Map(),
    lastHost: {},
    lastVps: {},
    lastHealth: () => 'healthy',
  }
}

export function accumulateStep(
  state: MetricsState,
  flows: Record<InstanceId, InstanceFlow>,
  hostResults: Record<ServerId, HostStepResult>,
  vps: Record<ServerId, VpsPublish>,
  nic: Record<ServerId, NicState>,
  health: (id: string) => HealthState,
  _simMs: number,
): void {
  for (const f of Object.values(flows)) {
    let w = state.window.get(f.instanceId)
    if (!w) {
      w = { steps: 0, admittedSum: 0, errorSum: 0, latencies: [] }
      state.window.set(f.instanceId, w)
    }
    w.steps++
    w.admittedSum += f.admittedRps
    w.errorSum += f.errorRps + f.refusedRps
    w.latencies.push(f.serviceLatencyMs)
  }
  for (const [serverId, n] of Object.entries(nic)) {
    let sw = state.serverWindow.get(serverId)
    if (!sw) {
      sw = { inBytes: 0, outBytes: 0 }
      state.serverWindow.set(serverId, sw)
    }
    sw.inBytes += n.inBytesThisStep
    sw.outBytes += n.outBytesThisStep
  }
  state.lastHost = hostResults
  state.lastVps = vps
  state.lastHealth = health
}

// EMA blend; missing previous value seeds directly with the window value.
function ema(state: MetricsState, key: string, windowValue: number): number {
  const prev = state.published.get(key)
  const next = prev === undefined ? windowValue : EMA_ALPHA * windowValue + (1 - EMA_ALPHA) * prev
  state.published.set(key, next)
  return next
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

export function buildBatch(
  state: MetricsState,
  doc: WorldDoc,
  compiled: CompiledWorld,
  routingSnapshot: RoutingSnapshot,
  totals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number },
  simMs: number,
): MetricsBatch {
  const instances: Record<InstanceId, InstanceMetrics> = {}
  const servers: Record<ServerId, ServerMetrics> = {}
  const azs: Record<AzId, AzMetrics> = {}
  const regions: Record<RegionId, RegionMetrics> = {}

  // ── Instances ──
  for (const inst of Object.values(compiled.instances)) {
    const bp = doc.blueprints[inst.blueprintId]
    const w = state.window.get(inst.id) ?? { steps: 1, admittedSum: 0, errorSum: 0, latencies: [0] }
    const windowRps = w.admittedSum / Math.max(1, w.steps)
    const windowErrRate = w.admittedSum + w.errorSum > 0 ? w.errorSum / (w.admittedSum + w.errorSum) : 0
    const sorted = [...w.latencies].sort((a, b) => a - b)
    const rps = ema(state, `i:${inst.id}:rps`, windowRps)
    const errorRate = ema(state, `i:${inst.id}:err`, windowErrRate)
    const p50Ms = ema(state, `i:${inst.id}:p50`, percentile(sorted, 0.5))
    const p99Ms = ema(state, `i:${inst.id}:p99`, percentile(sorted, 0.99))
    const activeConnections = rps * (p50Ms / 1000)          // Little's law
    const workload = bp?.workload ?? { cpuMsPerRequest: 0, ramBaseMb: 0, ramPerConnMb: 0, diskIoPerRequest: 0 }
    instances[inst.id] = {
      instanceId: inst.id,
      rps,
      errorRate,
      p50Ms,
      p99Ms,
      activeConnections,
      cpuCoresUsed: rps * workload.cpuMsPerRequest / 1000,
      ramMb: workload.ramBaseMb + workload.ramPerConnMb * activeConnections,
      health: state.lastHealth(inst.id),
    }
  }

  // ── Servers ──
  for (const server of Object.values(doc.servers)) {
    const resident = Object.values(compiled.instances).filter(i => i.serverId === server.id)
    const host = state.lastHost[server.id]
    const vps = state.lastVps[server.id]
    const sw = state.serverWindow.get(server.id) ?? { inBytes: 0, outBytes: 0 }
    const ramByInstance = resident
      .map(i => ({ instanceId: i.id, blueprintId: i.blueprintId, ramMb: instances[i.id]?.ramMb ?? 0 }))
      .sort((a, b) => b.ramMb - a.ramMb)
    const diskIo = resident.reduce((sum, i) => {
      const w = doc.blueprints[i.blueprintId]?.workload
      return sum + (instances[i.id]?.rps ?? 0) * (w?.diskIoPerRequest ?? 0)
    }, 0)
    servers[server.id] = {
      serverId: server.id,
      coreUtilization: host?.coreUtilization ?? Array.from({ length: server.specs.vcpu }, () => 0),
      stealFraction: vps?.steal ?? 0,
      burstCredits: server.kind === 'vps' && server.burstable ? (vps?.creditsFraction ?? 0) : null,
      ramByInstance,
      ramUsedMb: host?.ramUsedMb ?? ramByInstance.reduce((s, r) => s + r.ramMb, 0),
      ramTotalMb: server.specs.ramMb,
      nicInMbps: ema(state, `s:${server.id}:nicIn`, (sw.inBytes * 8) / 1e6),
      nicOutMbps: ema(state, `s:${server.id}:nicOut`, (sw.outBytes * 8) / 1e6),
      diskIoFraction: Math.min(1, diskIo / 100),   // documented norm: 100 io-units/sec = saturated
      health: state.lastHealth(server.id),
    }
  }

  // ── AZs ──
  for (const az of Object.values(doc.azs)) {
    const inAz = Object.values(compiled.instances).filter(i => i.azId === az.id)
    const rps = inAz.reduce((s, i) => s + instances[i.id].rps, 0)
    const errWeighted = inAz.reduce((s, i) => s + instances[i.id].errorRate * instances[i.id].rps, 0)
    const errorRate = rps > 0 ? errWeighted / rps : 0
    const p50 = inAz.length > 0
      ? inAz.reduce((s, i) => s + instances[i.id].p50Ms * (instances[i.id].rps || 1), 0) /
        Math.max(1, inAz.reduce((s, i) => s + (instances[i.id].rps || 1), 0))
      : 0
    const health = state.lastHealth(az.id)
    azs[az.id] = {
      azId: az.id,
      rps,
      errorRate,
      p50Ms: p50,
      healthScore: 100 * (1 - errorRate) * HEALTH_FACTOR[health],
      health,
      serverCount: Object.values(doc.servers).filter(s => s.azId === az.id).length,
      instanceCount: inAz.length,
    }
  }

  // ── Regions ──
  for (const region of Object.values(doc.regions)) {
    const inRegion = Object.values(doc.azs).filter(a => a.regionId === region.id).map(a => azs[a.id])
    const rps = inRegion.reduce((s, a) => s + a.rps, 0)
    const errWeighted = inRegion.reduce((s, a) => s + a.errorRate * a.rps, 0)
    const errorRate = rps > 0 ? errWeighted / rps : 0
    const p50 = inRegion.length > 0
      ? inRegion.reduce((s, a) => s + a.p50Ms * (a.rps || 1), 0) / Math.max(1, inRegion.reduce((s, a) => s + (a.rps || 1), 0))
      : 0
    const health = state.lastHealth(region.id)
    regions[region.id] = {
      regionId: region.id,
      rps,
      errorRate,
      p50Ms: p50,
      healthScore: 100 * (1 - errorRate) * HEALTH_FACTOR[health],
      health,
      inboundByPopulation: routingSnapshot.populationRoutes
        .filter(r => r.regionId === region.id)
        .map(r => ({ populationId: r.populationId, rps: r.rps })),
    }
  }

  // ── World ──
  const totalRps = Object.values(regions).reduce((s, r) => s + r.rps, 0)
  const errWeighted = Object.values(regions).reduce((s, r) => s + r.errorRate * r.rps, 0)
  const world: WorldMetrics = {
    totalRps,
    errorRate: totalRps > 0 ? errWeighted / totalRps : 0,
    populationRoutes: routingSnapshot.populationRoutes,
    crossAzBytesPerSec: ema(state, 'w:xaz', totals.crossAzBytes),
    crossRegionBytesPerSec: ema(state, 'w:xregion', totals.crossRegionBytes),
    internetEgressBytesPerSec: ema(state, 'w:inet', totals.internetBytes),
  }

  // Reset windows for the next second.
  state.window.clear()
  state.serverWindow.clear()

  return { simMs, instances, servers, azs, regions, world }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/worldEngine/metrics.test.ts src/lib/worldEngine/events.test.ts`
Expected: PASS (5 tests in metrics.test.ts, 3 tests in events.test.ts)

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/metrics.ts src/lib/worldEngine/events.ts src/lib/worldEngine/metrics.test.ts src/lib/worldEngine/events.test.ts
git commit -m "feat(engine): add metrics pyramid with EMA batching and engine event ring"
```

---

### Task 11: Replay ring buffer + traced requests

**Files:**
- Create: `src/lib/worldEngine/replay.ts`
- Test: `src/lib/worldEngine/replay.test.ts`

**Interfaces:**
- Consumes: `ReplayFrame`, `TracedRequest`, `RenderScope` from `./types`; `Rng` from `./rng`
  (T1); `InstanceFlow` from `./flows` (T8); world types from `../world/types`.
- Produces (skeleton-exact):
  - `createReplayBuffer(cap = 300): { push(f: ReplayFrame): void; getFrames(): ReplayFrame[] }`
  - `createTracer(rng: Rng): Tracer` where `Tracer = { sample(flows, compiled, doc, simMs, populationOf?): void; getTraced(scope: RenderScope): TracedRequest[] }`
  - `scopeKey(scope: RenderScope): string` — shared scope keying, reused by T12's renderer map.

Semantics locked for this task:

- **Replay ring:** plain bounded array, oldest dropped past cap (300 frames = 5 min at 1 Hz).
  `getFrames()` returns a copy, oldest→newest. The buffer stores whatever `events` array the
  facade puts in each frame (the facade fills it from `EventRing.drain()`, which is exactly
  the events of that 1s window — tested here as frame integrity, produced correctly in T12).
- **Tracer:** called by the facade once per 1s window. Entry instances = flow keys with
  `offeredRps > 0` that never appear as a `toInstanceId` in any other flow's `downstream`
  (i.e. nothing upstream feeds them). For each scope a trace touches, at most ONE trace is
  recorded per window (guarded by a per-scope `lastSampleMs`); each scope bucket keeps the
  last 10, oldest→newest (views reverse for display).
- **Walk:** starting at one rng-picked entry instance, repeatedly rng-pick ONE downstream row
  and hop until: a blocked row (hop outcome `'refused'`, walk stops), a managed target
  (terminal, latency 3ms per T8's managed model), no downstream rows, or depth 8. Hop
  `latencyMs` = the target instance flow's `serviceLatencyMs` (0 for a refused hop);
  `totalMs` = entry's `serviceLatencyMs` + Σ hop latencies. Request `outcome` = `'refused'`
  if any hop was refused, else `'ok'` (`'error'`/`'timeout'` outcomes arrive when a later
  phase traces richer failure data; the contract union stays as-is).
- **Scopes touched by a trace:** `globe`, the entry instance's region, the AZ of every
  instance on the walk, and the server of every instance on the walk.
- **`populationOf`** (optional param, see SKELETON CONCERNS #4): the facade passes its
  routing attribution so `TracedRequest.populationId` is real; when omitted (unit tests) it
  is `null` — the contract field is `PopulationId | null`, so it is still populated.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/replay.test.ts
import { describe, it, expect } from 'vitest'
import { createReplayBuffer, createTracer, scopeKey } from './replay'
import { createRng } from './rng'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { InstanceFlow } from './flows'
import type { MetricsBatch, ReplayFrame } from './types'

const emptyBatch = (simMs: number): MetricsBatch => ({
  simMs, instances: {}, servers: {}, azs: {}, regions: {},
  world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
})
const frame = (simMs: number, eventIds: string[] = []): ReplayFrame => ({
  simMs, batch: emptyBatch(simMs),
  events: eventIds.map(id => ({ id, simMs, kind: 'oom_kill' as const, severity: 'critical' as const, message: id, affected: [] })),
})

describe('replay buffer', () => {
  it('wraps at 300 frames, dropping oldest', () => {
    const buf = createReplayBuffer()
    for (let i = 0; i < 305; i++) buf.push(frame(i * 1000))
    const frames = buf.getFrames()
    expect(frames).toHaveLength(300)
    expect(frames[0].simMs).toBe(5000)
    expect(frames[299].simMs).toBe(304_000)
  })

  it('keeps each frame\'s event window intact and separate', () => {
    const buf = createReplayBuffer(10)
    buf.push(frame(1000, ['evt-1', 'evt-2']))
    buf.push(frame(2000, ['evt-3']))
    const [f1, f2] = buf.getFrames()
    expect(f1.events.map(e => e.id)).toEqual(['evt-1', 'evt-2'])
    expect(f2.events.map(e => e.id)).toEqual(['evt-3'])
  })
})

// api on web-server → pg on db-server (permitted, same az). One entry, one hop.
function tracedFixture() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const web = createServer(az.id, getPreset('vps-medium')!)
  const db = createServer(az.id, getPreset('dedicated-8')!)
  const api = createBlueprint('api', 0)
  const pg = createBlueprint('pg', 1)
  pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  Object.assign(doc.servers, { [web.id]: web, [db.id]: db })
  Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
  const plApi = createPlacement(api.id, web.id)
  const plPg = createPlacement(pg.id, db.id)
  Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })
  const compiled = compileWorld(doc)
  const apiInst = instanceId(plApi.id, 0)
  const pgInst = instanceId(plPg.id, 0)
  const flows: Record<string, InstanceFlow> = {
    [apiInst]: {
      instanceId: apiInst, offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0, serviceLatencyMs: 8,
      downstream: [{ dependencyId: 'dep-1', toInstanceId: pgInst, rps: 100, hopClass: 'same-az', blocked: false }],
    },
    [pgInst]: {
      instanceId: pgInst, offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0, serviceLatencyMs: 4,
      downstream: [],
    },
  }
  return { doc, compiled, az, web, db, apiInst, pgInst, flows }
}

describe('tracer', () => {
  it('walks a real permitted path from an entry instance', () => {
    const f = tracedFixture()
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    const traces = tracer.getTraced({ level: 'az', azId: f.az.id })
    expect(traces).toHaveLength(1)
    const t = traces[0]
    expect(t.hops).toHaveLength(1)
    expect(t.hops[0]).toMatchObject({ fromId: f.apiInst, toId: f.pgInst, hopClass: 'same-az', outcome: 'ok', latencyMs: 4 })
    expect(t.outcome).toBe('ok')
    expect(t.totalMs).toBeCloseTo(12, 5)   // entry 8 + hop 4
    expect(t.populationId).toBeNull()
    // The traced hop corresponds to a compiled permitted path.
    expect(f.compiled.paths.some(p =>
      p.verdict === 'permitted' && p.fromInstanceId === t.hops[0].fromId &&
      p.to.kind === 'instance' && p.to.instanceId === t.hops[0].toId)).toBe(true)
  })

  it('marks a blocked hop and the whole request as refused', () => {
    const f = tracedFixture()
    f.flows[f.apiInst].downstream[0].blocked = true
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    const [t] = tracer.getTraced({ level: 'server', serverId: f.web.id })
    expect(t.hops[0].outcome).toBe('refused')
    expect(t.hops[0].latencyMs).toBe(0)
    expect(t.outcome).toBe('refused')
  })

  it('samples at most one trace per scope per 1s window, keeping the last 10', () => {
    const f = tracedFixture()
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    tracer.sample(f.flows, f.compiled, f.doc, 1000)   // same window → no second trace
    expect(tracer.getTraced({ level: 'az', azId: f.az.id })).toHaveLength(1)
    for (let s = 2; s <= 14; s++) tracer.sample(f.flows, f.compiled, f.doc, s * 1000)
    const traces = tracer.getTraced({ level: 'az', azId: f.az.id })
    expect(traces).toHaveLength(10)                    // capped
    expect(traces[9].id).not.toBe(traces[0].id)        // oldest → newest, distinct ids
  })
})

describe('scopeKey', () => {
  it('keys every RenderScope level distinctly', () => {
    expect(scopeKey({ level: 'globe' })).toBe('globe')
    expect(scopeKey({ level: 'region', regionId: 'r1' })).toBe('region:r1')
    expect(scopeKey({ level: 'az', azId: 'a1' })).toBe('az:a1')
    expect(scopeKey({ level: 'server', serverId: 's1' })).toBe('server:s1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/replay.test.ts`
Expected: FAIL — `Cannot find module './replay'`

- [ ] **Step 3: Write `replay.ts`**

```ts
// src/lib/worldEngine/replay.ts
// 1 Hz replay ring (300 frames = 5 min) + per-scope synthetic request tracer.
// The facade pushes one ReplayFrame per second (batch + that second's event window) and
// calls tracer.sample() in the same tick.
import type { ReplayFrame, TracedRequest, RenderScope } from './types'
import type { Rng } from './rng'
import type { InstanceFlow } from './flows'
import type { WorldDoc, CompiledWorld, InstanceId, PopulationId } from '../world/types'

export interface ReplayBuffer {
  push(f: ReplayFrame): void
  getFrames(): ReplayFrame[]
}

export function createReplayBuffer(cap = 300): ReplayBuffer {
  const frames: ReplayFrame[] = []
  return {
    push(f) {
      frames.push(f)
      if (frames.length > cap) frames.splice(0, frames.length - cap)
    },
    getFrames() {
      return [...frames]
    },
  }
}

export function scopeKey(scope: RenderScope): string {
  switch (scope.level) {
    case 'globe': return 'globe'
    case 'region': return `region:${scope.regionId}`
    case 'az': return `az:${scope.azId}`
    case 'server': return `server:${scope.serverId}`
  }
}

const MAX_TRACES_PER_SCOPE = 10
const MAX_TRACE_DEPTH = 8

export interface Tracer {
  sample(
    flows: Record<InstanceId, InstanceFlow>,
    compiled: CompiledWorld,
    doc: WorldDoc,
    simMs: number,
    populationOf?: (entryInstanceId: InstanceId) => PopulationId | null,
  ): void
  getTraced(scope: RenderScope): TracedRequest[]
}

export function createTracer(rng: Rng): Tracer {
  const byScope = new Map<string, TracedRequest[]>()
  const lastSampleMs = new Map<string, number>()
  let traceSeq = 0

  function record(key: string, trace: TracedRequest, simMs: number) {
    if ((lastSampleMs.get(key) ?? -1) >= simMs) return   // ≤1 per scope per window
    lastSampleMs.set(key, simMs)
    const list = byScope.get(key) ?? []
    list.push(trace)
    if (list.length > MAX_TRACES_PER_SCOPE) list.splice(0, list.length - MAX_TRACES_PER_SCOPE)
    byScope.set(key, list)
  }

  return {
    sample(flows, compiled, doc, simMs, populationOf) {
      // Entry instances: offered demand and nothing upstream feeding them.
      const fedByOthers = new Set<string>()
      for (const f of Object.values(flows)) {
        for (const row of f.downstream) if (row.toInstanceId) fedByOthers.add(row.toInstanceId)
      }
      const entries = Object.values(flows)
        .filter(f => f.offeredRps > 0 && !fedByOthers.has(f.instanceId) && compiled.instances[f.instanceId])
      if (entries.length === 0) return

      const entry = rng.pick(entries)
      const hops: TracedRequest['hops'] = []
      const touchedInstances = [entry.instanceId]
      let cur = entry.instanceId
      let refused = false
      for (let depth = 0; depth < MAX_TRACE_DEPTH; depth++) {
        const f = flows[cur]
        if (!f || f.downstream.length === 0) break
        const row = rng.pick(f.downstream)
        const toId = row.toInstanceId ?? row.toManagedServiceId ?? ''
        const latencyMs = row.blocked ? 0 : row.toInstanceId ? (flows[row.toInstanceId]?.serviceLatencyMs ?? 1) : 3
        hops.push({
          fromId: cur,
          toId,
          hopClass: row.hopClass,
          latencyMs,
          outcome: row.blocked ? 'refused' : 'ok',
        })
        if (row.blocked) { refused = true; break }
        if (!row.toInstanceId) break                     // managed target is terminal
        cur = row.toInstanceId
        touchedInstances.push(cur)
      }

      const trace: TracedRequest = {
        id: `trace-${simMs}-${traceSeq++}`,
        populationId: populationOf ? populationOf(entry.instanceId) : null,
        hops,
        totalMs: entry.serviceLatencyMs + hops.reduce((s, h) => s + h.latencyMs, 0),
        outcome: refused ? 'refused' : 'ok',
      }

      // Record into every scope the walk touched.
      const keys = new Set<string>(['globe'])
      const entryInst = compiled.instances[entry.instanceId]
      keys.add(`region:${entryInst.regionId}`)
      for (const id of touchedInstances) {
        const inst = compiled.instances[id]
        if (!inst) continue
        keys.add(`az:${inst.azId}`)
        keys.add(`server:${inst.serverId}`)
      }
      for (const key of keys) record(key, trace, simMs)
    },

    getTraced(scope) {
      return [...(byScope.get(scopeKey(scope)) ?? [])]
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/replay.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/worldEngine/replay.ts src/lib/worldEngine/replay.test.ts
git commit -m "feat(engine): add replay ring buffer and per-scope request tracer"
```

---

<!-- CONTINUE -->


