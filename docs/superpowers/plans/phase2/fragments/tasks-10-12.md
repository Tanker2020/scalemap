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

### Task 12: Engine facade + simulation.store v2 + integration test

**Files:**
- Create: `src/lib/worldEngine/index.ts` (implements `WorldEngineApi` exactly, + a `createWorldEngine` factory and a module singleton `worldEngine`)
- Create: `src/lib/worldEngine/index.test.ts` (headless integration test via the exported `__test_step` hook)
- Rewrite: `src/app/store/simulation.store.ts` (v2 shape per the frozen contracts §"Store publication")
- Create (build-green shim, SKELETON CONCERNS #5): `src/app/store/simulationLegacy.store.ts` (verbatim copy of the current legacy store), and re-point every current legacy importer of the old store to it.

**Interfaces (facade — implements the frozen `WorldEngineApi` verbatim):**
- Consumes EVERYTHING from Tasks 1–11 (this is the composition seam). Exact imports:
  `createRng, Rng` (`./rng`); `createClock, ClockHandle` (`./engineClock`);
  `populationDemandRps, baselineDemands` (`./demand`); `createRoutingState, resolveRegion,
  runHealthChecks, azSplit, pickInstance, RoutingState` (`./routingRuntime`); `stepHost,
  InstanceLoad, HostStepResult` (`./hostScheduler`); `createVpsState, stepVps, VpsState`
  (`./vpsModel`); `createNicState, applyNicCap, NicState` (`./networkRuntime`); `getBreaker,
  recordResult, transition, admitRequest, pathKey, Breaker, BreakerState` (`./breakers`);
  `solveFlows, InstanceFlow, BYTES_PER_REQUEST_EACH_WAY` (`./flows`); `createFailoverState,
  setOutage, computeHealth, promoteReplicas, drainFactor, beginDrain, clearDrain,
  DEFAULT_HYSTERESIS, FailoverState` (`./failover`); `createMetricsState, accumulateStep,
  buildBatch, MetricsState, RoutingSnapshot, VpsPublish` (`./metrics`); `createEventRing,
  mkEvent, EventRing` (`./events`); `createReplayBuffer, createTracer, scopeKey, ReplayBuffer,
  Tracer` (`./replay`); all contract types from `./types`; world types from `../world/types`.
- Produces:

```ts
createWorldEngine(seed?: number): WorldEngineApi & { __test_step: (steps?: number) => void }
worldEngine: WorldEngineApi & { __test_step: (steps?: number) => void }   // shared singleton the store drives
```

**Facade step order (documented in code, spec decision 1 + skeleton T12):** per fixed step —
OOM-restart timers → demand → routing (health checks + TTL resolve; **baseline
`baseline:<regionId>` populations bypass DNS and route straight to their own region**,
controller ruling) → host scheduling (uses the PREVIOUS step's flows for load; documented
one-step lag) → VPS (uses this step's host utilization; produces next step's vCPU factor) →
flows → NIC caps → breaker record/transition → failover & health propagation (+ replica
promotion, rate-limited `connection_refused`) → metrics accumulate. Once per simulated second:
`buildBatch` → `onMetrics` + replay push + tracer sample; and the **perf-degradation watch**
(controller ruling: T12 owns it) — rolling mean step cost > 4ms sustained 3s → `stepMs`
100→200 + one `engine_degraded` info event + the store `degraded` flag. Render payloads are
built per animation frame for every attached scope, cap-enforced engine-side (AZ particles
sampled at `PARTICLE_RATIO = 10` rps/particle, ≤ `MAX_AZ_PARTICLES`; globe arcs ≤ 200; server
≤ 50).

**Store v2 (`simulation.store.ts`) — contracts §"Store publication" (with the sanctioned
additive fields `scrubIndex`/`scrubBatch`/`degraded`, per SKELETON CONCERNS #3 and the
controller ruling that T12 owns the degradation store flag):** holds `running`, `timeScale`,
`latestBatch`, `events` (ring, 500), `healthOverrides`, `scrubIndex`, `scrubBatch`,
`degraded`, and actions `start`/`stop`/`setTimeScale`/`setOutage`/`setScrubIndex`/
`attachRenderer`/`getReplayFrames`/`getTracedRequests` that mirror `WorldEngineApi`. Views
read the store; only these actions call the facade.

**Build-green legacy shim (SKELETON CONCERNS #5, grep-verified against the repo):** rewriting
`simulation.store.ts` breaks every file that imports its old exports (`NodeMetrics`,
`useSimulationStore` old shape, `CostSummary`-bearing `SimState`, …). Grep shows those are the
`src/app/{canvas,simulation,sidebar,toolbar,dock,analytics,reports}/**` trees + `StatusBar.tsx`
+ `src/lib/costModel.ts` + `src/lib/scalescript.ts` (all on Task 17's deletion list) plus the
legacy `particleEngine/**` test files. Because `src/lib/costModel.ts` is imported for *values*
(`computeCost`, `formatUsd`, …) by four legacy files also on the T17 list, deleting it early
would break *their* compile — so the safe, provably-green move is a **verbatim-copy shim**:
copy the old store to `simulationLegacy.store.ts` and mechanically re-point all current
old-store importers at it; `costModel.ts` rides to T17 pointing at the copy. This keeps
`npm run build` green from this commit through T16, and T17 deletes the copy with the rest.
(See `.superpowers/sdd/contract-drift.md` — the handoff's "delete costModel.ts in T12"
mechanism was reconciled to this shim after grep showed early deletion would red the build it
was meant to keep green; the *purpose*, a green build through T16, is met.)

- [ ] **Step 1: Write the failing integration test**

```ts
// src/lib/worldEngine/index.test.ts
import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { WorldDoc } from '../world/types'
import type { MetricsBatch, EngineEvent } from './types'

// A public-facing entry blueprint: the facade routes client demand only to blueprints that
// expose a 'public' port (documented entry rule).
function publicBlueprint(name: string, colorIndex: number) {
  const bp = createBlueprint(name, colorIndex)
  bp.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  return bp
}

// 2 regions / 3 AZ / 4 servers / 3 blueprints (web[entry] -> api -> db). One US population.
function e2eFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false          // isolate the authored population for clean asserts
  doc.routing.policy = 'geo'
  doc.routing.dnsTtlSec = 5                  // short TTL so the failover lag is observable within 30s

  const r1 = createRegion('us-east-1')
  const r2 = createRegion('eu-west-1')
  const az1a = createAz(r1.id, 'us-east-1a')
  const az1b = createAz(r1.id, 'us-east-1b')
  const az2a = createAz(r2.id, 'eu-west-1a')
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
  Object.assign(doc.azs, { [az1a.id]: az1a, [az1b.id]: az1b, [az2a.id]: az2a })

  const s1 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s2 = createServer(az1b.id, getPreset('dedicated-8')!)
  const s3 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s4 = createServer(az2a.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3, [s4.id]: s4 })

  const web = publicBlueprint('web', 0)
  const api = createBlueprint('api', 1)
  const db = createBlueprint('db', 2)
  web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })

  // web + api + db present in both region-1 AZs and in region-2 (so failover has somewhere to land).
  const place = (bpId: string, serverId: string) => {
    const pl = createPlacement(bpId, serverId)
    doc.placements[pl.id] = pl
    return pl
  }
  const web1a = place(web.id, s1.id); place(api.id, s1.id); place(db.id, s3.id)
  const web1b = place(web.id, s2.id); place(api.id, s2.id)
  const web2 = place(web.id, s4.id); place(api.id, s4.id); place(db.id, s4.id)

  const pop = createPopulation('nyc', 40.7, -74.0)   // near us-east-1
  pop.peakRps = 120
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2, az1a, az1b, pop, web1aInst: instanceId(web1a.id, 0), web1bInst: instanceId(web1b.id, 0), web2Inst: instanceId(web2.id, 0) }
}

function drive(doc: WorldDoc, compiled: ReturnType<typeof compileWorld>) {
  const engine = createWorldEngine(1)
  const batches: MetricsBatch[] = []
  const events: EngineEvent[] = []
  engine.start(doc, compiled, {
    onMetrics: b => batches.push(b),
    onEvent: e => events.push(e),
    onHealthChange: () => {},
  })
  const stepFor = (seconds: number) => engine.__test_step(seconds * 10)  // 100ms steps
  return { engine, batches, events, stepFor, latest: () => batches[batches.length - 1] }
}

describe('world engine integration', () => {
  it('flows client rps end-to-end through the compiled world', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    const b = sim.latest()
    expect(b).toBeDefined()
    expect(b.world.totalRps).toBeGreaterThan(0)
    expect(b.regions[f.r1.id].rps).toBeGreaterThan(0)            // US population lands in us-east-1
    expect(b.world.populationRoutes.find(r => r.populationId === f.pop.id)?.regionId).toBe(f.r1.id)
    sim.engine.stop()
  })

  it('redistributes within 3s when an AZ is killed (region keeps serving)', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(4)
    const before = sim.latest().regions[f.r1.id].rps
    expect(before).toBeGreaterThan(0)
    sim.engine.setOutage('az', f.az1a.id, true)
    sim.stepFor(3)
    const after = sim.latest().regions[f.r1.id].rps
    // az1b still carries region-1 traffic — region rps is not wiped out
    expect(after).toBeGreaterThan(before * 0.3)
    expect(sim.latest().azs[f.az1a.id].health).toBe('down')
    sim.engine.stop()
  })

  it('honors DNS TTL: killing a region shifts populationRoutes only after dnsTtlSec', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)                                    // warm the DNS cache -> us-east-1
    const routeOf = () => sim.latest().world.populationRoutes.find(r => r.populationId === f.pop.id)?.regionId
    expect(routeOf()).toBe(f.r1.id)
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(2)                                    // still inside the 5s TTL -> cache lags
    expect(routeOf()).toBe(f.r1.id)                   // the OBSERVABLE failover lag (spec D8)
    sim.stepFor(6)                                    // past TTL -> re-resolves to eu-west-1
    expect(routeOf()).toBe(f.r2.id)
    expect(sim.events.some(e => e.kind === 'ttl_lag_expired')).toBe(true)
    expect(sim.events.some(e => e.kind === 'failover_started')).toBe(true)
    sim.engine.stop()
  })

  it('OOM-kills the largest consumer under a RAM-starved fixture and restarts it', () => {
    const doc = createWorld()
    doc.traffic.autoBaseline = false
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    // Tiny-RAM server + a RAM-hungry entry blueprint under heavy client load -> host OOM.
    const server = createServer(az.id, getPreset('vps-small')!)
    server.specs.ramMb = 256
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    // Base alone (220) fits in 256, but even a fraction of a connection pushes it over — a
    // deterministic host-OOM regardless of the sampled service latency.
    web.workload = { cpuMsPerRequest: 2, ramBaseMb: 220, ramPerConnMb: 150, diskIoPerRequest: 0 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 400
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    sim.stepFor(2)
    expect(sim.events.some(e => e.kind === 'oom_kill')).toBe(true)
    sim.stepFor(6)                                    // > 5s restart delay
    expect(sim.events.some(e => e.kind === 'instance_restarted')).toBe(true)
    sim.engine.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/index.test.ts`
Expected: FAIL — `Cannot find module './index'`

- [ ] **Step 3: Write `index.ts` (the facade)**

```ts
// src/lib/worldEngine/index.ts
// The WorldEngineApi facade — the single composition point that ticks the whole compiled
// world. It owns no simulation math itself; it sequences Tasks 1–11 in the documented step
// order, publishes the metrics pyramid / events / replay at 1 Hz, feeds per-scope render
// payloads to attached views, and enforces the render caps. Headless: never imports from
// src/app/. Determinism: all randomness flows through the seeded rng built here.
import type {
  WorldEngineApi, EngineCallbacks, MetricsBatch, EngineEvent, EngineEventKind, HealthState,
  RenderScope, FramePayload, DetachFn, ReplayFrame, TracedRequest, VisualParticle, VisualArc,
} from './types'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId,
} from '../world/types'
import { createRng, type Rng } from './rng'
import { createClock, type ClockHandle } from './engineClock'
import { populationDemandRps, baselineDemands } from './demand'
import {
  createRoutingState, resolveRegion, runHealthChecks, azSplit, pickInstance, type RoutingState,
} from './routingRuntime'
import { stepHost, type InstanceLoad, type HostStepResult } from './hostScheduler'
import { createVpsState, stepVps, type VpsState } from './vpsModel'
import { createNicState, applyNicCap, type NicState } from './networkRuntime'
import {
  getBreaker, recordResult, transition, admitRequest, pathKey, type Breaker,
} from './breakers'
import { solveFlows, type InstanceFlow, BYTES_PER_REQUEST_EACH_WAY } from './flows'
import {
  createFailoverState, setOutage as failoverSetOutage, computeHealth, promoteReplicas,
  drainFactor, beginDrain, clearDrain, DEFAULT_HYSTERESIS, type FailoverState,
} from './failover'
import {
  createMetricsState, accumulateStep, buildBatch, type MetricsState, type RoutingSnapshot,
  type VpsPublish,
} from './metrics'
import { createEventRing, mkEvent, type EventRing } from './events'
import { createReplayBuffer, createTracer, scopeKey, type ReplayBuffer, type Tracer } from './replay'

const DEFAULT_STEP_MS = 100
const OOM_RESTART_MS = 5000                 // spec decision 3: instance_restarted after 5s
const PARTICLE_RATIO = 10                    // rps per sampled AZ particle (skeleton T12)
const MAX_AZ_PARTICLES = 400                 // az render cap (contracts "≤ current particle cap")
const MAX_GLOBE_ARCS = 200
const REFUSED_EVENT_MIN_GAP_MS = 1000        // ≤1 connection_refused per pathKey per second
const DEGRADE_THRESHOLD_MS = 4               // spec decision 9 / Global Constraints
const DEGRADE_WINDOW_STEPS = 30              // 3s of 100ms steps
const DEGRADED_STEP_MS = 200
const RENDER_PROGRESS_PER_MS = 1 / 1200      // particle sweeps a pair in ~1.2s wall-time

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

interface Attached { scope: RenderScope; onFrame: (p: FramePayload) => void }

interface EngineState {
  running: boolean
  seed: number
  rng: Rng
  clock: ClockHandle
  stepMs: number
  timeScale: number
  doc: WorldDoc
  compiled: CompiledWorld
  callbacks: EngineCallbacks
  entryBlueprintIds: BlueprintId[]           // blueprints with a 'public' port = client entry points

  routing: RoutingState
  failover: FailoverState
  vpsStates: Map<ServerId, VpsState | null>
  vpsFactor: Map<ServerId, number>           // previous step's effective vCPU factor
  breakers: Map<string, Breaker>
  metrics: MetricsState
  events: EventRing
  replay: ReplayBuffer
  tracer: Tracer

  prevFlows: Record<InstanceId, InstanceFlow>
  windowTotals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number }
  lastRoutingSnapshot: RoutingSnapshot
  popRegion: Map<PopulationId, RegionId>
  pendingFailover: Map<PopulationId, RegionId>
  checkFailedPrev: Map<string, boolean>
  instanceHealth: Map<InstanceId, HealthState>
  oomRestartAt: Map<InstanceId, number>
  refusedRateLimit: Map<string, number>

  idSeq: number
  lastBatchMs: number
  stepCosts: number[]
  degraded: boolean
  rafId: number | null
  lastFrameMs: number | null
  renderers: Map<number, Attached>
  rendererSeq: number
}

export function createWorldEngine(seed = 0x9e3779b9): WorldEngineApi & { __test_step: (steps?: number) => void } {
  // Constructed lazily on start(); this placeholder keeps the closure typed before the first run.
  let state: EngineState | null = null

  const entryBlueprints = (doc: WorldDoc): BlueprintId[] =>
    Object.values(doc.blueprints).filter(bp => bp.ports.some(p => p.visibility === 'public')).map(bp => bp.id)

  const emitEvent = (e: EngineEvent): void => {
    if (!state) return
    state.events.push(e)
    state.callbacks.onEvent(e)
  }
  const emit = (kind: EngineEventKind, severity: EngineEvent['severity'], message: string, affected: string[], simMs: number): void => {
    if (!state) return
    emitEvent(mkEvent(kind, severity, message, affected, simMs, state.idSeq++))
  }

  const healthOfScope = (id: string): HealthState => state!.failover.healthByScope.get(id) ?? 'healthy'

  const healthOfInstance = (iid: InstanceId): HealthState => {
    const s = state!
    if (s.oomRestartAt.has(iid)) return 'down'
    const inst = s.compiled.instances[iid]
    if (inst) {
      const worst = [inst.serverId, inst.azId, inst.regionId]
        .map(healthOfScope)
        .reduce((w, h) => (SEVERITY[h] > SEVERITY[w] ? h : w), 'healthy' as HealthState)
      if (worst !== 'healthy') return worst
    }
    return s.instanceHealth.get(iid) ?? 'healthy'
  }

  // Distribute a region's inbound rps to entry-blueprint instances: healthy AZs (equal shares)
  // → entry blueprints present in the AZ (equal shares) → round-robin instance.
  const distributeToEntries = (regionId: RegionId, rps: number, simMs: number, into: Record<InstanceId, number>): void => {
    const s = state!
    if (rps <= 0) return
    const azIds = azSplit(s.compiled.routing.regionAzSpread[regionId] ?? [], healthOfScope)
    if (azIds.length === 0) return
    const perAz = rps / azIds.length
    for (const azId of azIds) {
      const byBp = s.compiled.routing.azBlueprintTargets[azId] ?? {}
      const entriesHere = s.entryBlueprintIds.filter(bpId => (byBp[bpId]?.length ?? 0) > 0)
      if (entriesHere.length === 0) continue
      const perBp = perAz / entriesHere.length
      for (const bpId of entriesHere) {
        const inst = pickInstance(s.routing, azId, bpId, byBp[bpId], healthOfInstance)
        if (inst) into[inst] = (into[inst] ?? 0) + perBp
      }
    }
    void simMs   // reserved for future drain-aware ingest; drain currently applied at the flow layer
  }

  const applyHealth = (scope: 'server' | 'az' | 'region', id: string, inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean }, simMs: number): void => {
    const s = state!
    const before = s.failover.healthByScope.get(id) ?? 'healthy'
    const after = computeHealth(s.failover, id, inputs, simMs, DEFAULT_HYSTERESIS)
    if (after !== before) {
      s.callbacks.onHealthChange(scope, id, after)
      if (scope === 'az') {
        if (after === 'down') beginDrain(s.failover, id, simMs)
        else if (before === 'down') clearDrain(s.failover, id)
      }
    }
  }

  const emitBreakerTransition = (from: Breaker['state'], to: Breaker['state'], affected: string[], simMs: number): void => {
    if (from === to) return
    if (to === 'open') emit('breaker_open', 'warning', 'circuit opened', affected, simMs)
    else if (to === 'half-open') emit('breaker_half_open', 'info', 'circuit half-open', affected, simMs)
    else if (to === 'closed') emit('breaker_closed', 'info', 'circuit closed', affected, simMs)
  }

  function runStep(simMs: number): void {
    const s = state!
    const { doc, compiled } = s
    const stepMs = s.stepMs
    const stepSec = stepMs / 1000

    // ── 0. OOM restart timers ──
    for (const [iid, restartAt] of [...s.oomRestartAt]) {
      if (simMs >= restartAt) {
        s.oomRestartAt.delete(iid)
        s.instanceHealth.set(iid, 'healthy')
        emit('instance_restarted', 'info', `instance ${iid} restarted`, [iid], simMs)
      }
    }

    // ── 1. demand ──
    const demandByPop: Record<PopulationId, number> = {}
    for (const pop of Object.values(doc.populations)) demandByPop[pop.id] = populationDemandRps(pop, simMs, s.rng)
    const baseline = baselineDemands(doc.traffic, doc.populations, doc.regions)

    // ── 2. routing: health checks ──
    const scopes = [
      ...Object.values(doc.regions).map(r => ({ id: r.id, health: healthOfScope(r.id) })),
      ...Object.values(doc.azs).map(a => ({ id: a.id, health: healthOfScope(a.id) })),
    ]
    const checkResults = runHealthChecks(s.routing, doc.routing, simMs, scopes)
    const checkFailedById = new Map(checkResults.map(c => [c.id, c.checkFailed]))
    for (const c of checkResults) {
      if (c.checkFailed && !s.checkFailedPrev.get(c.id)) emit('health_check_failed', 'warning', `health check failed for ${c.id}`, [c.id], simMs)
      s.checkFailedPrev.set(c.id, c.checkFailed)
    }

    // ── 3. routing: resolve + build entry demand ──
    const populationRoutes: RoutingSnapshot['populationRoutes'] = []
    const entryDemand: Record<InstanceId, number> = {}
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      const prevRegion = s.popRegion.get(pop.id) ?? null
      const region = resolveRegion(s.routing, pop.id, order, healthOfScope, doc.routing, simMs, s.rng)
      if (!region) continue
      if (prevRegion && prevRegion !== region) {
        emit('ttl_lag_expired', 'info', `${pop.label} DNS re-resolved ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        emit('failover_started', 'warning', `${pop.label} failing over ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        s.pendingFailover.set(pop.id, region)
      } else if (s.pendingFailover.get(pop.id) === region) {
        emit('failover_completed', 'info', `${pop.label} now served by ${region}`, [pop.id, region], simMs)
        s.pendingFailover.delete(pop.id)
      }
      s.popRegion.set(pop.id, region)
      populationRoutes.push({ populationId: pop.id, regionId: region, rps: demandByPop[pop.id] })
      distributeToEntries(region, demandByPop[pop.id], simMs, entryDemand)
    }
    // baseline synthetic populations bypass DNS — straight to their own region (controller ruling)
    for (const [popId, rps] of Object.entries(baseline)) {
      const regionId = popId.slice('baseline:'.length)
      if (!doc.regions[regionId] || healthOfScope(regionId) === 'down') continue
      populationRoutes.push({ populationId: popId, regionId, rps })
      distributeToEntries(regionId, rps, simMs, entryDemand)
    }
    s.lastRoutingSnapshot = { populationRoutes }

    // ── 4/5. host scheduling (prev-step load) + VPS ──
    const admittedScaleByServer: Record<ServerId, number> = {}
    const latencyMultiplierByServer: Record<ServerId, number> = {}
    const hostResults: Record<ServerId, HostStepResult> = {}
    const vpsPublish: Record<ServerId, VpsPublish> = {}
    const nicByServer: Record<ServerId, NicState> = {}

    for (const server of Object.values(doc.servers)) {
      const resident = Object.values(compiled.instances).filter(i => i.serverId === server.id)
      const loads: InstanceLoad[] = resident.map(i => {
        const pf = s.prevFlows[i.id]
        const bp = doc.blueprints[i.blueprintId]
        const admitted = pf?.admittedRps ?? 0
        const latency = pf?.serviceLatencyMs ?? bp?.workload.cpuMsPerRequest ?? 1
        const runtime = doc.placements[i.placementId]?.runtime
        return {
          instanceId: i.id,
          cpuMsPerRequest: bp?.workload.cpuMsPerRequest ?? 1,
          admittedRps: admitted,
          activeConnections: admitted * (latency / 1000),
          ramBaseMb: bp?.workload.ramBaseMb ?? 0,
          ramPerConnMb: bp?.workload.ramPerConnMb ?? 0,
          memLimitMb: runtime && runtime.type === 'container' ? runtime.memLimitMb : null,
        }
      })
      const effectiveVcpu = server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1)
      const host = stepHost(server, loads, effectiveVcpu, s.rng)
      hostResults[server.id] = host
      admittedScaleByServer[server.id] = host.admittedScale
      latencyMultiplierByServer[server.id] = host.latencyMultiplier
      nicByServer[server.id] = createNicState()

      if (host.oomVictim && !s.oomRestartAt.has(host.oomVictim)) {
        s.oomRestartAt.set(host.oomVictim, simMs + OOM_RESTART_MS)
        s.instanceHealth.set(host.oomVictim, 'down')
        emit('oom_kill', 'critical', `${host.oomVictim} OOM-killed on ${server.label}`, [host.oomVictim, server.id], simMs)
      }

      const vpsState = s.vpsStates.get(server.id) ?? null
      if (vpsState) {
        const vps = stepVps(vpsState, server, Math.min(1, host.cpuPressure), stepMs, s.rng)
        s.vpsFactor.set(server.id, vps.effectiveVcpuFactor)
        vpsPublish[server.id] = { steal: vps.steal, effectiveVcpuFactor: vps.effectiveVcpuFactor, creditsFraction: vps.creditsFraction }
        if (vps.noisySpikeStarted) emit('noisy_neighbor', 'warning', `noisy-neighbor steal spike on ${server.label}`, [server.id], simMs)
        if (vps.creditsJustExhausted) emit('burst_credits_exhausted', 'warning', `${server.label} burst credits exhausted`, [server.id], simMs)
      } else {
        s.vpsFactor.set(server.id, 1)
        vpsPublish[server.id] = { steal: 0, effectiveVcpuFactor: 1, creditsFraction: null }
      }
    }

    // ── 6. flows ──
    const breakerOpen = (key: string): boolean => {
      const b = s.breakers.get(key)
      if (!b) return false
      transition(b, simMs)
      return !admitRequest(b)
    }
    const { flows, totals } = solveFlows({
      compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
      breakerOpen, healthOf: healthOfInstance, rng: s.rng,
    })

    // ── 7. NIC caps (per-server byte accounting from this step's flows) ──
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      const nic = inst ? nicByServer[inst.serverId] : undefined
      if (!inst || !nic) continue
      const bytes = f.admittedRps * BYTES_PER_REQUEST_EACH_WAY * stepSec
      applyNicCap(nic, doc.servers[inst.serverId], bytes, bytes, stepMs)
    }

    // ── 8. breaker record + transition ──
    for (const f of Object.values(flows)) {
      for (const row of f.downstream) {
        if (row.rps <= 0) continue
        const key = pathKey(f.instanceId, row.dependencyId)
        const b = getBreaker(s.breakers, key)
        const from = b.state
        recordResult(b, row.blocked, simMs)
        transition(b, simMs)
        emitBreakerTransition(from, b.state, [f.instanceId, row.toInstanceId ?? row.toManagedServiceId ?? ''], simMs)
      }
    }

    // ── 9. failover / health propagation ──
    const serverAgg = new Map<ServerId, { offered: number; errors: number }>()
    for (const f of Object.values(flows)) {
      const inst = compiled.instances[f.instanceId]
      if (!inst) continue
      const agg = serverAgg.get(inst.serverId) ?? { offered: 0, errors: 0 }
      agg.offered += f.offeredRps
      agg.errors += f.errorRps + f.refusedRps
      serverAgg.set(inst.serverId, agg)
    }
    const rate = (a?: { offered: number; errors: number }): number => (a && a.offered > 0 ? a.errors / a.offered : 0)
    for (const server of Object.values(doc.servers)) {
      applyHealth('server', server.id, {
        errorRate: rate(serverAgg.get(server.id)),
        cpuPressure: hostResults[server.id]?.cpuPressure ?? 0,
        checkFailed: false,
        manualDown: s.failover.manualOutages.has(server.id),
      }, simMs)
    }
    for (const az of Object.values(doc.azs)) {
      const srv = Object.values(doc.servers).filter(v => v.azId === az.id)
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, hostResults[v.id]?.cpuPressure ?? 0), 0)
      applyHealth('az', az.id, { errorRate: offered > 0 ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(az.id) ?? false, manualDown: s.failover.manualOutages.has(az.id) }, simMs)
    }
    for (const region of Object.values(doc.regions)) {
      const azsIn = Object.values(doc.azs).filter(a => a.regionId === region.id)
      const srv = Object.values(doc.servers).filter(v => azsIn.some(a => a.id === v.azId))
      const offered = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.offered ?? 0), 0)
      const errors = srv.reduce((n, v) => n + (serverAgg.get(v.id)?.errors ?? 0), 0)
      const cpu = srv.reduce((m, v) => Math.max(m, hostResults[v.id]?.cpuPressure ?? 0), 0)
      applyHealth('region', region.id, { errorRate: offered > 0 ? errors / offered : 0, cpuPressure: cpu, checkFailed: checkFailedById.get(region.id) ?? false, manualDown: s.failover.manualOutages.has(region.id) }, simMs)
    }
    const downInstances = Object.values(compiled.instances).filter(i => healthOfInstance(i.id) === 'down').map(i => i.id)
    for (const e of promoteReplicas(s.failover, compiled, doc, downInstances, simMs)) emitEvent(e)

    // rate-limited connection_refused (blocked/breaker attempts are live failures, spec D6)
    for (const f of Object.values(flows)) {
      for (const row of f.downstream) {
        if (!row.blocked) continue
        const key = pathKey(f.instanceId, row.dependencyId)
        const last = s.refusedRateLimit.get(key) ?? -Infinity
        if (simMs - last >= REFUSED_EVENT_MIN_GAP_MS) {
          s.refusedRateLimit.set(key, simMs)
          emit('connection_refused', 'warning', `${f.instanceId} refused on ${row.dependencyId}`, [f.instanceId, row.toInstanceId ?? row.toManagedServiceId ?? ''], simMs)
        }
      }
    }

    // ── 10. metrics accumulate ──
    accumulateStep(s.metrics, flows, hostResults, vpsPublish, nicByServer, healthOfInstance, simMs)
    s.windowTotals.crossAzBytes += totals.crossAzBytes * stepSec
    s.windowTotals.crossRegionBytes += totals.crossRegionBytes * stepSec
    s.windowTotals.internetBytes += totals.internetBytes * stepSec
    s.prevFlows = flows

    // ── 11. 1 Hz batch + replay + trace ──
    if (simMs - s.lastBatchMs >= 1000) {
      s.lastBatchMs = simMs
      const batch = buildBatch(s.metrics, doc, compiled, s.lastRoutingSnapshot, { ...s.windowTotals }, simMs)
      s.callbacks.onMetrics(batch)
      s.replay.push({ simMs, batch, events: s.events.drain() })
      s.tracer.sample(flows, compiled, doc, simMs, entryId => populationForEntry(entryId))
      s.windowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 }
    }
  }

  // Which population currently feeds a given entry instance (for TracedRequest.populationId).
  const populationForEntry = (entryInstanceId: InstanceId): PopulationId | null => {
    const inst = state!.compiled.instances[entryInstanceId]
    if (!inst) return null
    const route = state!.lastRoutingSnapshot.populationRoutes.find(r => r.regionId === inst.regionId && !r.populationId.startsWith('baseline:'))
    return route?.populationId ?? null
  }

  // Advance the fixed-step clock by a real frame and run every whole step it produced.
  function runFrame(frameMs: number): void {
    const s = state!
    const steps = s.clock.advance(frameMs, s.timeScale)
    if (steps === 0) return
    const endMs = s.clock.simMs
    for (let i = steps; i >= 1; i--) {
      const stepSimMs = endMs - (i - 1) * s.stepMs
      const t0 = perfNow()
      runStep(stepSimMs)
      recordStepCost(perfNow() - t0, stepSimMs)
    }
  }

  function recordStepCost(costMs: number, simMs: number): void {
    const s = state!
    s.stepCosts.push(costMs)
    if (s.stepCosts.length > DEGRADE_WINDOW_STEPS) s.stepCosts.shift()
    if (!s.degraded && s.stepCosts.length >= DEGRADE_WINDOW_STEPS) {
      const mean = s.stepCosts.reduce((a, b) => a + b, 0) / s.stepCosts.length
      if (mean > DEGRADE_THRESHOLD_MS) {
        s.degraded = true
        s.stepMs = DEGRADED_STEP_MS
        s.clock = createClock(DEGRADED_STEP_MS)
        emit('engine_degraded', 'info', `engine degraded: mean step ${mean.toFixed(1)}ms > ${DEGRADE_THRESHOLD_MS}ms — halving step rate to ${DEGRADED_STEP_MS}ms`, [], simMs)
      }
    }
  }

  // ── Render payloads (per animation frame, cap-enforced) ──
  function buildPayload(scope: RenderScope, wallMs: number): FramePayload {
    const s = state!
    const simMs = s.clock.simMs
    if (scope.level === 'globe') return { simMs, particles: [], arcs: buildArcs() }
    if (scope.level === 'az') return { simMs, particles: buildAzParticles(scope.azId, wallMs), arcs: [] }
    // region/server rich particle surfaces arrive in Phases 4/3; Phase 2 ships empty-but-valid payloads.
    return { simMs, particles: [], arcs: [] }
  }

  function buildArcs(): VisualArc[] {
    const s = state!
    const routes = s.lastRoutingSnapshot.populationRoutes
    const maxRps = Math.max(1, ...routes.map(r => r.rps))
    const arcs: VisualArc[] = []
    for (const r of routes) {
      if (r.populationId.startsWith('baseline:')) continue
      const pop = s.doc.populations[r.populationId]
      const region = s.doc.regions[r.regionId]
      const geo = region ? REGION_GEO_LOCAL[region.catalogId] : undefined
      if (!pop || !geo) continue
      arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geo.lat, geo.lon], intensity: Math.min(1, r.rps / maxRps), kind: 'client' })
      if (arcs.length >= MAX_GLOBE_ARCS) break
    }
    return arcs
  }

  function buildAzParticles(azId: AzId, wallMs: number): VisualParticle[] {
    const s = state!
    const phase = (wallMs * RENDER_PROGRESS_PER_MS)
    const particles: VisualParticle[] = []
    let pid = 0
    const drain = s.failover.drainUntil.has(azId) ? drainFactor(s.failover, azId, s.clock.simMs) : 1
    for (const f of Object.values(s.prevFlows)) {
      const from = s.compiled.instances[f.instanceId]
      if (!from || from.azId !== azId) continue
      const bp = s.doc.blueprints[from.blueprintId]
      const isEntry = s.entryBlueprintIds.includes(from.blueprintId)
      // entry ingress particles from the client edge
      if (isEntry && f.offeredRps > 0) {
        const n = Math.min(MAX_AZ_PARTICLES, Math.round((f.offeredRps / PARTICLE_RATIO) * drain))
        for (let k = 0; k < n && particles.length < MAX_AZ_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: 'edge:client', toId: from.serverId, progress: frac(phase + k * 0.137), protocol: 'http', blocked: false, colorHint: bp?.color ?? null })
        }
      }
      for (const row of f.downstream) {
        const toId = row.toInstanceId ? s.compiled.instances[row.toInstanceId]?.serverId : row.toManagedServiceId
        if (!toId) continue
        const dep = bp?.dependencies.find(d => d.id === row.dependencyId)
        const n = Math.min(MAX_AZ_PARTICLES, Math.max(row.blocked ? 1 : 0, Math.round(row.rps / PARTICLE_RATIO)))
        for (let k = 0; k < n && particles.length < MAX_AZ_PARTICLES; k++) {
          particles.push({ id: pid++, fromId: from.serverId, toId, progress: frac(phase + k * 0.191), protocol: dep?.protocol ?? 'http', blocked: row.blocked, colorHint: bp?.color ?? null })
        }
      }
    }
    return particles
  }

  function renderAll(wallMs: number): void {
    const s = state!
    for (const { scope, onFrame } of s.renderers.values()) onFrame(buildPayload(scope, wallMs))
  }

  function tick(nowMs: number): void {
    const s = state
    if (!s || !s.running) return
    const frameMs = s.lastFrameMs === null ? s.stepMs : Math.min(250, nowMs - s.lastFrameMs)
    s.lastFrameMs = nowMs
    runFrame(frameMs)
    renderAll(nowMs)
    if (typeof requestAnimationFrame === 'function') s.rafId = requestAnimationFrame(tick)
  }

  const api: WorldEngineApi & { __test_step: (steps?: number) => void } = {
    start(doc, compiled, callbacks) {
      state = {
        running: true, seed, rng: createRng(seed), clock: createClock(DEFAULT_STEP_MS), stepMs: DEFAULT_STEP_MS,
        timeScale: 1, doc, compiled, callbacks, entryBlueprintIds: entryBlueprints(doc),
        routing: createRoutingState(), failover: createFailoverState(),
        vpsStates: new Map(Object.values(doc.servers).map(sv => [sv.id, createVpsState(sv)])),
        vpsFactor: new Map(), breakers: new Map(), metrics: createMetricsState(),
        events: createEventRing(500), replay: createReplayBuffer(300), tracer: createTracer(createRng(seed ^ 0x1234)),
        prevFlows: {}, windowTotals: { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 },
        lastRoutingSnapshot: { populationRoutes: [] }, popRegion: new Map(), pendingFailover: new Map(),
        checkFailedPrev: new Map(), instanceHealth: new Map(), oomRestartAt: new Map(), refusedRateLimit: new Map(),
        idSeq: 0, lastBatchMs: -1000, stepCosts: [], degraded: false, rafId: null, lastFrameMs: null,
        renderers: new Map(), rendererSeq: 0,
      }
      if (typeof requestAnimationFrame === 'function') state.rafId = requestAnimationFrame(tick)
    },
    stop() {
      if (!state) return
      state.running = false
      if (state.rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(state.rafId)
      state.rafId = null
    },
    isRunning() {
      return state?.running ?? false
    },
    setTimeScale(scale) {
      if (state) state.timeScale = scale
    },
    setOutage(scope, id, down) {
      if (!state) return
      for (const e of failoverSetOutage(state.failover, scope, id, down, state.clock.simMs)) emitEvent(e)
    },
    attachRenderer(scope, onFrame) {
      if (!state) return () => {}
      const key = state.rendererSeq++
      state.renderers.set(key, { scope, onFrame })
      const s = state
      return () => { s.renderers.delete(key) }
    },
    getReplayFrames() {
      return state?.replay.getFrames() ?? []
    },
    getTracedRequests(scope) {
      return state?.tracer.getTraced(scope) ?? []
    },
    __test_step(steps = 1) {
      for (let i = 0; i < steps; i++) runFrame(state!.stepMs)
    },
  }
  return api
}

// Great-circle region coordinates for globe arcs (mirror of world/regionGeo — imported to keep
// the layering rule that worldEngine does not reach into app/, but regionGeo lives in lib/world
// which IS allowed; imported below).
import { REGION_GEO as REGION_GEO_LOCAL } from '../world/regionGeo'

const frac = (x: number): number => x - Math.floor(x)
const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// Shared singleton the store drives; tests construct their own via createWorldEngine().
export const worldEngine = createWorldEngine()
```

> Note: the `import { REGION_GEO ... }` sits mid-file above only for readability of the arc
> builder; when writing the file, hoist it into the import block at the top with the other
> `../world/*` imports (ESM hoists it either way — grouping keeps tsc/style clean).

- [ ] **Step 4: Write the build-green legacy shim, then rewrite the store**

First preserve the legacy store under a new name and re-point its importers (keeps `tsc` green
through T16 — the trees are deleted wholesale in T17):

```bash
# 1) verbatim copy under the legacy name (git mv preserves history; the v2 file is written fresh next)
git mv src/app/store/simulation.store.ts src/app/store/simulationLegacy.store.ts

# 2) re-point every current importer of the old store at the copy (grep-verified list)
grep -rl "store/simulation.store" src \
  | grep -v "src/app/store/simulation.store.ts" \
  | while read -r f; do
      sed -i '' "s#store/simulation\\.store#store/simulationLegacy.store#g; s#\\.\\./simulation\\.store#../simulationLegacy.store#g" "$f"
    done
```

Then verify nothing still points at the (soon to be v2) `simulation.store` except code you are
about to write:

```bash
grep -rl "store/simulation.store\b" src | grep -v "simulationLegacy" || echo "clean"
```

Now write the v2 store fresh at `src/app/store/simulation.store.ts`:

```ts
// src/app/store/simulation.store.ts — v2 (Phase 2). The legacy shape retired here with the
// legacy engine; the old store lives on verbatim as simulationLegacy.store.ts until Task 17
// deletes it with the rest of the legacy tree. Views read this store; only its actions call
// the worldEngine facade. Shape: frozen contracts §"Store publication" + the sanctioned
// additive fields scrubIndex/scrubBatch (T15 consumer) and degraded (perf watch — T12 owns it).
import { create } from 'zustand'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type {
  MetricsBatch, EngineEvent, RenderScope, FramePayload, DetachFn, ReplayFrame, TracedRequest,
} from '../../lib/worldEngine/types'
import { worldEngine } from '../../lib/worldEngine'

const EVENT_CAP = 500

interface SimulationStoreV2 {
  running: boolean
  timeScale: number
  latestBatch: MetricsBatch | null
  events: EngineEvent[]
  healthOverrides: Record<string, boolean>
  scrubIndex: number | null
  scrubBatch: MetricsBatch | null
  degraded: boolean

  start: (doc: WorldDoc, compiled: CompiledWorld) => void
  stop: () => void
  setTimeScale: (scale: number) => void
  setOutage: (scope: 'server' | 'az' | 'region', id: string, down: boolean) => void
  setScrubIndex: (i: number | null) => void
  attachRenderer: (scope: RenderScope, onFrame: (p: FramePayload) => void) => DetachFn
  getReplayFrames: () => ReplayFrame[]
  getTracedRequests: (scope: RenderScope) => TracedRequest[]
}

export const useSimulationStore = create<SimulationStoreV2>((set) => ({
  running: false,
  timeScale: 1,
  latestBatch: null,
  events: [],
  healthOverrides: {},
  scrubIndex: null,
  scrubBatch: null,
  degraded: false,

  start: (doc, compiled) => {
    set({ running: true, latestBatch: null, events: [], degraded: false, scrubIndex: null, scrubBatch: null })
    worldEngine.start(doc, compiled, {
      onMetrics: (batch) => set({ latestBatch: batch }),
      onEvent: (event) =>
        set((s) => {
          const next = s.events.length >= EVENT_CAP ? [...s.events.slice(s.events.length - EVENT_CAP + 1), event] : [...s.events, event]
          return event.kind === 'engine_degraded' ? { events: next, degraded: true } : { events: next }
        }),
      onHealthChange: () => {},
    })
  },
  stop: () => {
    worldEngine.stop()
    set({ running: false })
  },
  setTimeScale: (scale) => {
    worldEngine.setTimeScale(scale)
    set({ timeScale: scale })
  },
  setOutage: (scope, id, down) => {
    worldEngine.setOutage(scope, id, down)
    set((s) => ({ healthOverrides: { ...s.healthOverrides, [id]: down } }))
  },
  setScrubIndex: (i) => {
    const frames = worldEngine.getReplayFrames()
    set({ scrubIndex: i, scrubBatch: i === null ? null : frames[i]?.batch ?? null })
  },
  attachRenderer: (scope, onFrame) => worldEngine.attachRenderer(scope, onFrame),
  getReplayFrames: () => worldEngine.getReplayFrames(),
  getTracedRequests: (scope) => worldEngine.getTracedRequests(scope),
}))
```

- [ ] **Step 5: Run the integration test**

Run: `npx vitest run src/lib/worldEngine/index.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Run the whole engine suite + full suite + tsc**

Run: `npx vitest run src/lib/worldEngine/`
Expected: PASS — every engine suite green including index (4).

Run: `npx vitest run`
Expected: PASS — the legacy `particleEngine/**` suites still pass (they import the verbatim
`simulationLegacy.store`), the world suites pass, zero failures.

Run: `npm run build`
Expected: succeeds — the shim keeps every legacy importer resolving.

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts \
  src/app/store/simulation.store.ts src/app/store/simulationLegacy.store.ts \
  src/app/canvas src/app/simulation src/app/sidebar src/app/toolbar src/app/dock \
  src/app/analytics src/app/reports src/app/StatusBar.tsx src/lib/costModel.ts src/lib/scalescript.ts
git commit -m "feat(engine): add WorldEngineApi facade, simulation.store v2, and integration test"
```

