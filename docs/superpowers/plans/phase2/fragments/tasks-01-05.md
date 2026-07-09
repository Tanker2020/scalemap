## Fragment: Tasks 1–5 (engine types/rng/clock, traffic demand, routing runtime, host scheduler, VPS model)

**Source binding docs (read before touching these tasks):**
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md` (frozen types),
`docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md` (decisions 1–5 govern
Tasks 1–5), `.superpowers/sdd/phase2-plan-skeleton.md` (T1–T5 specs this fragment expands).

**Run commands throughout:** `npx vitest run <path>` for a single suite; `npm run build`
(runs `tsc` over the whole repo, per CLAUDE.md) as the tsc check before each commit.

### SKELETON CONCERNS

1. **T2 `baselineDemands` returns bare numbers, not located populations.** The skeleton's
   locked signature is `baselineDemands(traffic, populations, regions): Record<PopulationId,
   number>` — a demand map only. But the prose says synthetic baseline populations are
   "located at the region's geo," which implies a lat/lon-bearing `ClientPopulation`-shaped
   entity for whatever later routes/renders them. This fragment honors the signature exactly
   (see `demand.ts` below) and documents the convention that `baseline:<regionId>` ids are
   always understood to resolve to their own region of origin (no geo-routing needed for
   them). Whichever task actually constructs the live population set for the engine loop
   (likely T12's facade) will need to either synthesize a `ClientPopulation` object per
   baseline id itself, or special-case the `baseline:` prefix in routing. Flagging so that
   task's author doesn't assume `demand.ts` already produces something routable.

2. **T3 "healthy" is used loosely against a 3-state `HealthState`.** The skeleton says
   weighted routing draws "among HEALTHY regions" and `azSplit` keeps "healthy only," but
   `HealthState` has three values (`healthy | degraded | down`). A literal reading would
   make `degraded` scopes permanently unroutable, which conflicts with decision 3's treatment
   of degraded load as a queuing/latency problem, not an ejection. This fragment implements
   "healthy" uniformly as **not down** everywhere in `routingRuntime.ts` (degraded scopes
   still receive/route traffic; only `down` scopes are excluded) — see the comments in
   `resolveRegion`/`azSplit`/`pickInstance` below. If the intended semantics is stricter
   (excluding `degraded` too), the fix is a one-line predicate change in three places — no
   signature impact.

3. **T1 `ClockHandle` (this fragment's `createClock`) is not the frozen `EngineClock`.** The
   contracts' `EngineClock` interface carries `simMs`, `stepMs`, and `timeScale` as fields.
   T1's own spec asks for `createClock(stepMs=100): { advance(frameMs, timeScale): number;
   simMs: number }` — a narrower engine-loop helper where `timeScale` is an argument to
   `advance()`, not stored state. This fragment implements exactly that narrower shape.
   Whoever builds the facade (T12) composing the public `EngineClock` shape needs to hold
   `timeScale` itself (e.g., in store/facade state) and pass it into `advance()` each frame —
   `engineClock.ts`'s `ClockHandle` is not a drop-in `EngineClock`.

---

### Task 1: Engine types (contracts verbatim), seeded RNG, fixed-step clock

**Files:**
- Create: `src/lib/worldEngine/types.ts`
- Create: `src/lib/worldEngine/rng.ts`
- Create: `src/lib/worldEngine/engineClock.ts`
- Test: `src/lib/worldEngine/rng.test.ts`
- Test: `src/lib/worldEngine/engineClock.test.ts`

**Interfaces:**
- Consumes: `InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId, CompiledWorld,
  WorldDoc` from `../world/types` (types.ts only).
- Produces: every contract type in `docs/superpowers/specs/2026-07-08-world-engine-contracts.md`
  (verbatim), plus `Rng` interface + `createRng(seed?: number): Rng`, plus `ClockHandle`
  interface + `createClock(stepMs?: number): ClockHandle`.

This is the only leaf task with zero dependencies on other Task-1–5 modules — everything
else in this fragment imports `Rng` from `./rng`.

- [ ] **Step 1: Transcribe the frozen contracts verbatim**

```ts
// src/lib/worldEngine/types.ts
// World engine contracts (FROZEN) — transcribed verbatim from
// docs/superpowers/specs/2026-07-08-world-engine-contracts.md. Do not redefine/reshape;
// additive-optional extension only. Governs every module in src/lib/worldEngine/.
import type {
  InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId,
  CompiledWorld, WorldDoc,
} from '../world/types'

// ─── Time ────────────────────────────────────────────────────────────────────
// The engine runs a fixed-step simulation clock (default 100ms steps) driven by
// requestAnimationFrame with an accumulator; rendering interpolates between steps.
// All engine timestamps are simMs (milliseconds since engine start), never wall time.

export interface EngineClock {
  simMs: number
  stepMs: number          // fixed step, default 100
  timeScale: number       // 1 = realtime; UI may offer 2x/4x later (engine supports it now)
}

// ─── Health ──────────────────────────────────────────────────────────────────

export type HealthState = 'healthy' | 'degraded' | 'down'

// ─── Per-scope metrics (published at 1 Hz, EMA-smoothed) ─────────────────────

export interface InstanceMetrics {
  instanceId: InstanceId
  rps: number                    // admitted requests/sec
  errorRate: number              // 0..1
  p50Ms: number
  p99Ms: number
  activeConnections: number
  cpuCoresUsed: number           // e.g. 1.2 = 1.2 cores of demand
  ramMb: number                  // base + per-connection
  health: HealthState
}

export interface ServerMetrics {
  serverId: ServerId
  // One entry per vCPU, 0..1 utilization. Phase 3's CPU die reads this directly.
  coreUtilization: number[]
  // VPS only: fraction of CPU stolen by co-tenants this second (0 on dedicated).
  stealFraction: number
  // Burstable VPS only: 0..1 credit balance; null when not burstable.
  burstCredits: number | null
  // RAM strata by instance — Phase 3's reservoir renders these slices in order.
  ramByInstance: { instanceId: InstanceId; blueprintId: BlueprintId; ramMb: number }[]
  ramUsedMb: number
  ramTotalMb: number
  nicInMbps: number
  nicOutMbps: number
  diskIoFraction: number         // 0..1
  health: HealthState
}

export interface AzMetrics {
  azId: AzId
  rps: number
  errorRate: number
  p50Ms: number
  healthScore: number            // 0..100 composite — Phase 4's health ring reads this
  health: HealthState
  serverCount: number
  instanceCount: number
}

export interface RegionMetrics {
  regionId: RegionId
  rps: number
  errorRate: number
  p50Ms: number
  healthScore: number
  health: HealthState
  // Live inbound share per population routed here (Phase 4 split-lines, Phase 5 arcs).
  inboundByPopulation: { populationId: PopulationId; rps: number }[]
}

export interface WorldMetrics {
  totalRps: number
  errorRate: number
  // Per-population → current target region + rps (Phase 5 arc rendering).
  populationRoutes: { populationId: PopulationId; regionId: RegionId; rps: number }[]
  // Cross-scope transfer accounting for cost v2 (bytes/sec, EMA).
  crossAzBytesPerSec: number
  crossRegionBytesPerSec: number
  internetEgressBytesPerSec: number
}

export interface MetricsBatch {
  simMs: number
  instances: Record<InstanceId, InstanceMetrics>
  servers: Record<ServerId, ServerMetrics>
  azs: Record<AzId, AzMetrics>
  regions: Record<RegionId, RegionMetrics>
  world: WorldMetrics
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type EngineEventKind =
  | 'connection_refused'         // blocked path attempted (carries blockReason kind in message)
  | 'oom_kill'                   // instance killed by host RAM pressure
  | 'instance_restarted'
  | 'noisy_neighbor'             // VPS steal spike started
  | 'burst_credits_exhausted'
  | 'breaker_open' | 'breaker_half_open' | 'breaker_closed'
  | 'health_check_failed'
  | 'failover_started'           // population/AZ traffic moving (carries from/to in affected)
  | 'failover_completed'
  | 'ttl_lag_expired'            // a population's DNS cache expired and re-resolved
  | 'replica_promoted'
  | 'outage_triggered' | 'outage_cleared'   // manual switches
  | 'engine_degraded'            // perf watch halved the step rate (spec decision 9); info severity

export interface EngineEvent {
  id: string
  simMs: number
  kind: EngineEventKind
  severity: 'info' | 'warning' | 'critical'
  message: string
  // Entity ids at any scope (instanceId/serverId/azId/regionId/populationId).
  affected: string[]
}

// ─── Render attachment (headless engine; views subscribe per scope) ─────────
// A view calls attachRenderer for its scope; the engine invokes onFrame every
// animation frame with ONLY that scope's visual payload. Detach on unmount.
// Budgets (plan Global Constraints): az ≤ current particle cap, server ≤ 50 traces,
// globe ≤ 200 arcs. The engine enforces the caps, not the view.

export type RenderScope =
  | { level: 'globe' }
  | { level: 'region'; regionId: RegionId }
  | { level: 'az'; azId: AzId }
  | { level: 'server'; serverId: ServerId }

export interface VisualParticle {
  id: number
  // Path endpoints as entity ids; the VIEW owns geometry (screen positions).
  fromId: string                 // serverId | managedServiceId | 'edge:<populationId>'
  toId: string
  progress: number               // 0..1 along the view's path for this pair
  protocol: 'http' | 'db' | 'event' | 'stream'
  blocked: boolean               // render as refused burst at gate/target
  colorHint: string | null       // blueprint signature color when known
}

export interface VisualArc {                 // globe scope
  fromLatLon: [number, number]
  toLatLon: [number, number]
  intensity: number              // 0..1, scaled by rps share
  kind: 'client' | 'inter-region' | 'drain'
}

export interface FramePayload {
  simMs: number
  particles: VisualParticle[]    // az/server/region scopes
  arcs: VisualArc[]              // globe scope only, else []
}

export type DetachFn = () => void

// ─── Control API (the engine facade's exported surface) ─────────────────────

export interface EngineCallbacks {
  onMetrics: (batch: MetricsBatch) => void        // 1 Hz
  onEvent: (event: EngineEvent) => void
  onHealthChange: (scope: 'server' | 'az' | 'region', id: string, health: HealthState) => void
}

export interface WorldEngineApi {
  start: (doc: WorldDoc, compiled: CompiledWorld, callbacks: EngineCallbacks) => void
  stop: () => void
  isRunning: () => boolean
  setTimeScale: (scale: number) => void
  // Manual failure switches (spec D8). Idempotent; emit outage_triggered/cleared.
  setOutage: (scope: 'server' | 'az' | 'region', id: string, down: boolean) => void
  attachRenderer: (scope: RenderScope, onFrame: (p: FramePayload) => void) => DetachFn
  // Replay: scope-aware 1 Hz snapshots, ring buffer of 300 (5 min).
  getReplayFrames: () => ReplayFrame[]
  // Request inspector: engine samples ≤1 traced request per second per scope.
  getTracedRequests: (scope: RenderScope) => TracedRequest[]
}

export interface ReplayFrame {
  simMs: number
  batch: MetricsBatch            // full pyramid — scrubbing any level reads one frame
  events: EngineEvent[]          // events that occurred within this 1s window
}

export interface TracedRequest {
  id: string
  populationId: PopulationId | null
  hops: {
    fromId: string; toId: string
    hopClass: 'localhost' | 'same-az' | 'cross-az' | 'cross-region' | 'internet'
    latencyMs: number
    outcome: 'ok' | 'refused' | 'error' | 'timeout'
  }[]
  totalMs: number
  outcome: 'ok' | 'refused' | 'error' | 'timeout'
}
```

No test for `types.ts` itself (pure declarations) — its correctness is enforced by every
other module in this fragment importing from it and by the tsc check below.

- [ ] **Step 2: Write the failing rng test**

```ts
// src/lib/worldEngine/rng.test.ts
import { describe, it, expect } from 'vitest'
import { createRng } from './rng'

describe('rng', () => {
  it('same seed produces the same sequence', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = [a.next(), a.next(), a.next(), a.next()]
    const seqB = [b.next(), b.next(), b.next(), b.next()]
    expect(seqA).toEqual(seqB)
  })

  it('different seeds produce different sequences', () => {
    const a = createRng(1)
    const b = createRng(2)
    expect(a.next()).not.toBe(b.next())
  })

  it('next() stays within [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('range(min, max) stays within bounds', () => {
    const rng = createRng(9)
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(-5, 10)
      expect(v).toBeGreaterThanOrEqual(-5)
      expect(v).toBeLessThan(10)
    }
  })

  it('pick() always returns an element of the array, seeded reproducibly', () => {
    const arr = ['a', 'b', 'c', 'd']
    const a = createRng(123)
    const b = createRng(123)
    const picksA = Array.from({ length: 20 }, () => a.pick(arr))
    const picksB = Array.from({ length: 20 }, () => b.pick(arr))
    expect(picksA).toEqual(picksB)
    for (const p of picksA) expect(arr).toContain(p)
  })

  it('createRng() with no seed still produces a deterministic default sequence', () => {
    const a = createRng()
    const b = createRng()
    expect(a.next()).toBe(b.next())
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/rng.test.ts`
Expected: FAIL — `Cannot find module './rng'`

- [ ] **Step 4: Write `rng.ts`**

```ts
// src/lib/worldEngine/rng.ts
// Seeded PRNG (mulberry32) — every stochastic draw anywhere in src/lib/worldEngine/ must
// flow through this; Math.random is never called there. Determinism section,
// docs/superpowers/specs/2026-07-08-world-engine-contracts.md.

export interface Rng {
  next(): number                          // [0, 1)
  range(min: number, max: number): number  // [min, max)
  pick<T>(arr: T[]): T
}

// Fixed default so an un-seeded engine run is still reproducible run-to-run.
const DEFAULT_SEED = 0x9e3779b9

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createRng(seed: number = DEFAULT_SEED): Rng {
  const next = mulberry32(seed)
  return {
    next,
    range(min: number, max: number): number {
      return min + next() * (max - min)
    },
    pick<T>(arr: T[]): T {
      const idx = Math.floor(next() * arr.length)
      return arr[Math.min(idx, arr.length - 1)]
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/rng.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Write the failing clock test**

```ts
// src/lib/worldEngine/engineClock.test.ts
import { describe, it, expect } from 'vitest'
import { createClock } from './engineClock'

describe('engineClock', () => {
  it('starts at simMs 0', () => {
    const clock = createClock()
    expect(clock.simMs).toBe(0)
  })

  it('accumulates fractional frames: 16.7ms x 6 -> 1 step, remainder carries', () => {
    const clock = createClock(100)
    let totalSteps = 0
    for (let i = 0; i < 6; i++) totalSteps += clock.advance(16.7, 1)
    expect(totalSteps).toBe(1)
    expect(clock.simMs).toBe(100)
    // the ~0.2ms remainder carries: one more 16.7ms frame isn't enough for a second step
    expect(clock.advance(16.7, 1)).toBe(0)
    expect(clock.simMs).toBe(100)
  })

  it('timeScale 2 doubles the step rate', () => {
    const realtime = createClock(100)
    const doubled = createClock(100)
    let realSteps = 0
    let doubledSteps = 0
    for (let i = 0; i < 10; i++) {
      realSteps += realtime.advance(100, 1)
      doubledSteps += doubled.advance(100, 2)
    }
    expect(realSteps).toBe(10)
    expect(doubledSteps).toBe(20)
    expect(realtime.simMs).toBe(1000)
    expect(doubled.simMs).toBe(2000)
  })

  it('advance returns the exact whole-step count for a large frame', () => {
    const clock = createClock(100)
    expect(clock.advance(350, 1)).toBe(3)
    expect(clock.simMs).toBe(300)
  })

  it('a custom stepMs is honored', () => {
    const clock = createClock(50)
    expect(clock.advance(120, 1)).toBe(2)
    expect(clock.simMs).toBe(100)
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/engineClock.test.ts`
Expected: FAIL — `Cannot find module './engineClock'`

- [ ] **Step 8: Write `engineClock.ts`**

```ts
// src/lib/worldEngine/engineClock.ts
// Fixed-step accumulator clock (default 100ms) turning rAF frame deltas into a whole number
// of simulation steps. Spec decision 1, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// NOTE: this is a narrower helper than the frozen `EngineClock` contract type in ./types —
// see SKELETON CONCERNS #3 at the top of this fragment.

export interface ClockHandle {
  readonly simMs: number
  /** Feed a real elapsed-frame duration (ms) and a timeScale multiplier; returns how many
   *  fixed steps the caller should run this frame. Leftover time carries to the next call. */
  advance(frameMs: number, timeScale: number): number
}

export function createClock(stepMs: number = 100): ClockHandle {
  let simMs = 0
  let accumulatorMs = 0
  return {
    get simMs() {
      return simMs
    },
    advance(frameMs: number, timeScale: number): number {
      accumulatorMs += frameMs * timeScale
      let steps = 0
      while (accumulatorMs >= stepMs) {
        accumulatorMs -= stepMs
        simMs += stepMs
        steps++
      }
      return steps
    },
  }
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/engineClock.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 10: tsc check**

Run: `npm run build`
Expected: succeeds (no type errors)

- [ ] **Step 11: Commit**

```bash
git add src/lib/worldEngine/types.ts src/lib/worldEngine/rng.ts src/lib/worldEngine/rng.test.ts src/lib/worldEngine/engineClock.ts src/lib/worldEngine/engineClock.test.ts
git commit -m "feat(engine): add engine contracts, seeded rng, and fixed-step clock"
```

---

### Task 2: Traffic demand

**Files:**
- Create: `src/lib/worldEngine/demand.ts`
- Test: `src/lib/worldEngine/demand.test.ts`

**Interfaces:**
- Consumes: `ClientPopulation, TrafficConfig, PopulationId, RegionId, Region` from
  `../world/types`; `Rng` from `./rng`.
- Produces: `populationDemandRps(pop: ClientPopulation, simMs: number, rng: Rng): number`,
  `baselineDemands(traffic: TrafficConfig, populations: Record<PopulationId, ClientPopulation>,
  regions: Record<RegionId, Region>): Record<PopulationId, number>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/demand.test.ts
import { describe, it, expect } from 'vitest'
import { populationDemandRps, baselineDemands } from './demand'
import { createRng } from './rng'
import { createPopulation, createRegion } from '../world/factories'
import type { TrafficConfig } from '../world/types'

describe('populationDemandRps', () => {
  it('flat pattern stays at peakRps within the +-3% jitter band, independent of simMs', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 1000, diurnal: 'flat' as const }
    const rng = createRng(1)
    for (const simMs of [0, 10_000, 60_000, 500_000]) {
      const v = populationDemandRps(pop, simMs, rng)
      expect(v).toBeGreaterThanOrEqual(1000 * 0.97)
      expect(v).toBeLessThanOrEqual(1000 * 1.03)
    }
  })

  it('day-night pattern envelopes between ~10% and ~100% of peakRps over one compressed day', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 1000, diurnal: 'day-night' as const }
    const rng = createRng(2)
    const DAY_MS = 120_000
    let min = Infinity
    let max = -Infinity
    for (let simMs = 0; simMs <= DAY_MS; simMs += 500) {
      const v = populationDemandRps(pop, simMs, rng)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    // envelope factors are 0.55 +- 0.45 => [0.1, 1.0] of peakRps, +-3% jitter on top
    expect(min).toBeGreaterThanOrEqual(1000 * 0.1 * 0.9)
    expect(min).toBeLessThanOrEqual(1000 * 0.1 * 1.1)
    expect(max).toBeGreaterThanOrEqual(1000 * 1.0 * 0.95)
    expect(max).toBeLessThanOrEqual(1000 * 1.0 * 1.05)
  })

  it('jitter never pushes demand outside the documented +-3% band', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 200, diurnal: 'flat' as const }
    const rng = createRng(3)
    for (let i = 0; i < 500; i++) {
      const v = populationDemandRps(pop, i * 1000, rng)
      expect(v).toBeGreaterThanOrEqual(200 * 0.97)
      expect(v).toBeLessThanOrEqual(200 * 1.03)
    }
  })
})

describe('baselineDemands', () => {
  const traffic = (autoBaseline: boolean, baselineTotalRps = 900): TrafficConfig => ({ autoBaseline, baselineTotalRps })

  it('splits baselineTotalRps evenly across regions with baseline:<regionId> keys', () => {
    const r1 = createRegion('us-east-1')
    const r2 = createRegion('eu-west-1')
    const r3 = createRegion('ap-southeast-1')
    const regions = { [r1.id]: r1, [r2.id]: r2, [r3.id]: r3 }
    const result = baselineDemands(traffic(true, 900), {}, regions)
    expect(Object.keys(result).sort()).toEqual([`baseline:${r1.id}`, `baseline:${r2.id}`, `baseline:${r3.id}`].sort())
    for (const regionId of [r1.id, r2.id, r3.id]) {
      expect(result[`baseline:${regionId}`]).toBe(300)
    }
  })

  it('returns {} when autoBaseline is off', () => {
    const r1 = createRegion('us-east-1')
    expect(baselineDemands(traffic(false), {}, { [r1.id]: r1 })).toEqual({})
  })

  it('returns {} for an empty region set (no divide-by-zero)', () => {
    expect(baselineDemands(traffic(true), {}, {})).toEqual({})
  })

  it('does not clobber an authored population that already owns a baseline:<regionId> id', () => {
    const r1 = createRegion('us-east-1')
    const clashId = `baseline:${r1.id}`
    const authored = { [clashId]: { ...createPopulation('manual', 1, 1), id: clashId } }
    const result = baselineDemands(traffic(true, 500), authored, { [r1.id]: r1 })
    expect(result[clashId]).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/demand.test.ts`
Expected: FAIL — `Cannot find module './demand'`

- [ ] **Step 3: Write `demand.ts`**

```ts
// src/lib/worldEngine/demand.ts
// Population traffic demand: diurnal curves + auto-baseline synthetic per-region populations.
// Spec decision 5, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { ClientPopulation, TrafficConfig, PopulationId, RegionId, Region } from '../world/types'
import type { Rng } from './rng'

// A compressed 2-minute "day" so the day-night curve is visible within a short demo run.
const DAY_MS = 120_000
const JITTER_FRACTION = 0.03

export function populationDemandRps(pop: ClientPopulation, simMs: number, rng: Rng): number {
  const base =
    pop.diurnal === 'flat'
      ? pop.peakRps
      : pop.peakRps * (0.55 + 0.45 * Math.sin((2 * Math.PI * simMs) / DAY_MS - Math.PI / 2))
  const jitter = 1 + rng.range(-JITTER_FRACTION, JITTER_FRACTION)
  return Math.max(0, base * jitter)
}

// Synthetic ambient traffic: one population per region, `baselineTotalRps / regionCount`
// each, keyed `baseline:<regionId>` (views may filter by this prefix — see SKELETON
// CONCERNS #1 at the top of this fragment for what this map does and doesn't carry: it's
// numeric demand only, no lat/lon anchoring).
export function baselineDemands(
  traffic: TrafficConfig,
  populations: Record<PopulationId, ClientPopulation>,
  regions: Record<RegionId, Region>,
): Record<PopulationId, number> {
  const result: Record<PopulationId, number> = {}
  if (!traffic.autoBaseline) return result
  const regionIds = Object.keys(regions)
  if (regionIds.length === 0) return result
  const share = traffic.baselineTotalRps / regionIds.length
  for (const regionId of regionIds) {
    const id = `baseline:${regionId}`
    if (populations[id]) continue // an authored population already claims this id — don't clobber it
    result[id] = share
  }
  return result
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/demand.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/demand.ts src/lib/worldEngine/demand.test.ts
git commit -m "feat(engine): add population traffic demand model"
```

---

### Task 3: Routing runtime — DNS/TTL, health checks, targeting

**Files:**
- Create: `src/lib/worldEngine/routingRuntime.ts`
- Test: `src/lib/worldEngine/routingRuntime.test.ts`

**Interfaces:**
- Consumes: `RegionId, AzId, PopulationId, BlueprintId, InstanceId, RoutingConfig` from
  `../world/types`; `HealthState` from `./types`; `Rng` from `./rng`.
- Produces:

```ts
interface RoutingState { /* per-population TTL cache + health-check counters + instance cursors */ }
createRoutingState(): RoutingState
resolveRegion(state, popId, orderedRegions: RegionId[], healthOf: (id: RegionId) => HealthState, policy: RoutingConfig, simMs, rng): RegionId | null
runHealthChecks(state, config: RoutingConfig, simMs, scopes: { id: string; health: HealthState }[]): { id: string; checkFailed: boolean }[]
azSplit(azIds: AzId[], healthOf: (id: AzId) => HealthState): AzId[]
pickInstance(state, azId, blueprintId, targets: InstanceId[], healthyOf: (id: InstanceId) => HealthState): InstanceId | null
```

Semantics per spec decisions 5 and 7 (see also SKELETON CONCERNS #2 above for the "healthy"
= not-down interpretation used uniformly below): weighted policy re-draws on each fresh
resolution among not-down regions by weight; priority/latency/geo take the first not-down
region in `orderedRegions` (that order already encodes the policy and sorts passive regions
last — `compileWorld`'s job, Phase 1); the TTL cache returns the cached region until
`expiresAtMs` even if it has since gone down (the observable failover lag) and emits nothing
itself — the facade (Task 12) diffs cache changes to emit `ttl_lag_expired`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/routingRuntime.test.ts
import { describe, it, expect } from 'vitest'
import { createRoutingState, resolveRegion, runHealthChecks, azSplit, pickInstance } from './routingRuntime'
import { createRng } from './rng'
import type { RoutingConfig } from '../world/types'
import type { HealthState } from './types'

const basePolicy = (overrides: Partial<RoutingConfig> = {}): RoutingConfig => ({
  policy: 'priority',
  weights: {},
  priorityOrder: [],
  healthCheckIntervalMs: 10_000,
  healthCheckFailureThreshold: 3,
  dnsTtlSec: 30,
  ...overrides,
})

describe('resolveRegion', () => {
  it('picks the first healthy region in order on a fresh cache', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    const healthOf = (): HealthState => 'healthy'
    const region = resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, basePolicy(), 0, rng)
    expect(region).toBe('A')
  })

  it('honors the TTL cache: a region gone down stays targeted until expiry (the observable lag)', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    let aHealth: HealthState = 'healthy'
    const healthOf = (id: string): HealthState => (id === 'A' ? aHealth : 'healthy')
    const policy = basePolicy({ dnsTtlSec: 30 })

    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 0, rng)).toBe('A')
    aHealth = 'down'
    // still within TTL (30s) — cache returns 'A' even though it is now down
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 5_000, rng)).toBe('A')
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 29_999, rng)).toBe('A')
    // TTL expired — re-resolves, skipping the down region
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, policy, 30_000, rng)).toBe('B')
  })

  it('returns null when every candidate region is down', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    const healthOf = (): HealthState => 'down'
    expect(resolveRegion(state, 'pop-1', ['A', 'B'], healthOf, basePolicy(), 0, rng)).toBeNull()
  })

  it('passive-last activation: only reached once every earlier region in the order is down', () => {
    const state = createRoutingState()
    const rng = createRng(1)
    // orderedRegions already carries active-before-passive ordering (compileWorld's job)
    const order = ['active-1', 'active-2', 'passive-1']
    const down = new Set(['active-1', 'active-2'])
    const healthOf = (id: string): HealthState => (down.has(id) ? 'down' : 'healthy')
    expect(resolveRegion(state, 'pop-1', order, healthOf, basePolicy(), 0, rng)).toBe('passive-1')
  })

  it('weighted policy draws proportionally to configured weights over many independent resolutions', () => {
    const rng = createRng(42)
    const policy = basePolicy({ policy: 'weighted', weights: { A: 3, B: 1 }, dnsTtlSec: 30 })
    const healthOf = (): HealthState => 'healthy'
    let countA = 0
    let countB = 0
    for (let i = 0; i < 2000; i++) {
      // fresh state + a distinct popId per draw so the TTL cache never short-circuits it
      const state = createRoutingState()
      const region = resolveRegion(state, `pop-${i}`, ['A', 'B'], healthOf, policy, 0, rng)
      if (region === 'A') countA++
      else if (region === 'B') countB++
    }
    // expected ~1500/500 (75%/25%); generous tolerance for a seeded stochastic draw
    expect(countA).toBeGreaterThan(1300)
    expect(countA).toBeLessThan(1700)
    expect(countB).toBe(2000 - countA)
  })
})

describe('runHealthChecks', () => {
  it('marks checkFailed only after consecutive failures reach the threshold', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 3 })
    let results = runHealthChecks(state, config, 0, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }]) // 1 failure
    results = runHealthChecks(state, config, 1_000, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }]) // 2 failures, still below threshold 3
    results = runHealthChecks(state, config, 2_000, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: true }]) // 3 failures, threshold reached
  })

  it('a healthy result resets the consecutive-failure counter', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 1_000, healthCheckFailureThreshold: 2 })
    runHealthChecks(state, config, 0, [{ id: 'srv-1', health: 'down' }])
    runHealthChecks(state, config, 1_000, [{ id: 'srv-1', health: 'healthy' }])
    const results = runHealthChecks(state, config, 2_000, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }])
  })

  it('the interval gate skips extra checks — repeated calls within one interval only count once', () => {
    const state = createRoutingState()
    const config = basePolicy({ healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 5 })
    for (let t = 0; t < 5; t++) {
      runHealthChecks(state, config, t * 100, [{ id: 'srv-1', health: 'down' }]) // all within one interval
    }
    // only the first call (t=0) should have counted — 1 failure, well below threshold 5
    const results = runHealthChecks(state, config, 400, [{ id: 'srv-1', health: 'down' }])
    expect(results).toEqual([{ id: 'srv-1', checkFailed: false }])
  })
})

describe('azSplit', () => {
  it('keeps healthy and degraded AZs, drops down ones', () => {
    const health: Record<string, HealthState> = { a: 'healthy', b: 'down', c: 'degraded' }
    expect(azSplit(['a', 'b', 'c'], id => health[id])).toEqual(['a', 'c'])
  })

  it('returns [] when every AZ is down', () => {
    expect(azSplit(['a', 'b'], () => 'down')).toEqual([])
  })
})

describe('pickInstance', () => {
  it('round-robins across healthy targets and wraps around', () => {
    const state = createRoutingState()
    const targets = ['i-1', 'i-2', 'i-3']
    const healthyOf = (): HealthState => 'healthy'
    const picks = Array.from({ length: 7 }, () => pickInstance(state, 'az-1', 'bp-1', targets, healthyOf))
    expect(picks).toEqual(['i-1', 'i-2', 'i-3', 'i-1', 'i-2', 'i-3', 'i-1'])
  })

  it('keeps a separate cursor per (az, blueprint) pair', () => {
    const state = createRoutingState()
    const targets = ['i-1', 'i-2']
    const healthyOf = (): HealthState => 'healthy'
    expect(pickInstance(state, 'az-1', 'bp-1', targets, healthyOf)).toBe('i-1')
    expect(pickInstance(state, 'az-1', 'bp-2', targets, healthyOf)).toBe('i-1') // different blueprint, own cursor
    expect(pickInstance(state, 'az-1', 'bp-1', targets, healthyOf)).toBe('i-2') // bp-1's cursor advanced independently
  })

  it('skips down instances and returns null when none are healthy', () => {
    const state = createRoutingState()
    const health: Record<string, HealthState> = { 'i-1': 'down', 'i-2': 'healthy' }
    const healthyOf = (id: string): HealthState => health[id]
    expect(pickInstance(state, 'az-1', 'bp-1', ['i-1', 'i-2'], healthyOf)).toBe('i-2')
    expect(pickInstance(state, 'az-1', 'bp-2', ['i-1'], healthyOf)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/routingRuntime.test.ts`
Expected: FAIL — `Cannot find module './routingRuntime'`

- [ ] **Step 3: Write `routingRuntime.ts`**

```ts
// src/lib/worldEngine/routingRuntime.ts
// DNS/TTL population->region resolution, health-check consecutive-failure debounce, and
// AZ/instance targeting (region LB -> AZ split -> round-robin instance pick).
// Spec decision 5 (traffic & routing) + decision 7 (failover: TTL lag is the observable
// delay), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { RegionId, AzId, PopulationId, BlueprintId, InstanceId, RoutingConfig } from '../world/types'
import type { HealthState } from './types'
import type { Rng } from './rng'

interface PopulationCacheEntry {
  regionId: RegionId
  expiresAtMs: number
}

interface HealthCheckCounter {
  consecutiveFailures: number
  lastCheckMs: number | null
}

export interface RoutingState {
  popCache: Map<PopulationId, PopulationCacheEntry>
  healthCheckCounters: Map<string, HealthCheckCounter>
  instanceCursors: Map<string, number> // keyed `${azId}:${blueprintId}`
}

export function createRoutingState(): RoutingState {
  return { popCache: new Map(), healthCheckCounters: new Map(), instanceCursors: new Map() }
}

function pickWeighted(candidates: RegionId[], weights: Record<RegionId, number>, rng: Rng): RegionId {
  const weighted = candidates.map(id => ({ id, w: Math.max(0, weights[id] ?? 1) }))
  const total = weighted.reduce((sum, x) => sum + x.w, 0)
  if (total <= 0) return rng.pick(candidates)
  let r = rng.range(0, total)
  for (const x of weighted) {
    r -= x.w
    if (r <= 0) return x.id
  }
  return weighted[weighted.length - 1].id
}

// Honors the TTL cache: a cached region is returned until `expiresAtMs`, even if it has
// since gone down — that lag IS the observable failover delay (decision 7). Re-resolution
// picks the first not-down region in `orderedRegions` (priority/latency/geo — the order
// already encodes the policy and sorts passive regions last, per compileWorld), or a
// weighted not-down draw. Emits nothing itself; the facade (Task 12) diffs cache changes to
// emit `ttl_lag_expired`.
export function resolveRegion(
  state: RoutingState,
  popId: PopulationId,
  orderedRegions: RegionId[],
  healthOf: (id: RegionId) => HealthState,
  policy: RoutingConfig,
  simMs: number,
  rng: Rng,
): RegionId | null {
  const cached = state.popCache.get(popId)
  if (cached && simMs < cached.expiresAtMs) return cached.regionId

  // "healthy" candidate == not down (see SKELETON CONCERNS #2): degraded regions still serve.
  const candidates = orderedRegions.filter(id => healthOf(id) !== 'down')
  if (candidates.length === 0) return null

  const chosen = policy.policy === 'weighted' ? pickWeighted(candidates, policy.weights, rng) : candidates[0]

  state.popCache.set(popId, { regionId: chosen, expiresAtMs: simMs + policy.dnsTtlSec * 1000 })
  return chosen
}

// Per-scope consecutive-failure debounce, gated by `healthCheckIntervalMs` — a scope not yet
// due for a check reports its last-known `checkFailed` state unchanged.
export function runHealthChecks(
  state: RoutingState,
  config: RoutingConfig,
  simMs: number,
  scopes: { id: string; health: HealthState }[],
): { id: string; checkFailed: boolean }[] {
  return scopes.map(({ id, health }) => {
    let counter = state.healthCheckCounters.get(id)
    if (!counter) {
      counter = { consecutiveFailures: 0, lastCheckMs: null }
      state.healthCheckCounters.set(id, counter)
    }
    const due = counter.lastCheckMs === null || simMs - counter.lastCheckMs >= config.healthCheckIntervalMs
    if (due) {
      counter.consecutiveFailures = health === 'healthy' ? 0 : counter.consecutiveFailures + 1
      counter.lastCheckMs = simMs
    }
    return { id, checkFailed: counter.consecutiveFailures >= config.healthCheckFailureThreshold }
  })
}

// Region LB -> healthy AZ spread. "Healthy" here means not-down: a degraded AZ still takes a
// share (only a down AZ is excluded) — consistent with resolveRegion's filter above.
export function azSplit(azIds: AzId[], healthOf: (id: AzId) => HealthState): AzId[] {
  return azIds.filter(id => healthOf(id) !== 'down')
}

// AZ LB -> round-robin instance pick, one cursor per (az, blueprint) pair so different
// blueprints in the same AZ don't share rotation state.
export function pickInstance(
  state: RoutingState,
  azId: AzId,
  blueprintId: BlueprintId,
  targets: InstanceId[],
  healthyOf: (id: InstanceId) => HealthState,
): InstanceId | null {
  const healthy = targets.filter(id => healthyOf(id) !== 'down')
  if (healthy.length === 0) return null
  const key = `${azId}:${blueprintId}`
  const cursor = state.instanceCursors.get(key) ?? 0
  const chosen = healthy[cursor % healthy.length]
  state.instanceCursors.set(key, cursor + 1)
  return chosen
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/routingRuntime.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/routingRuntime.ts src/lib/worldEngine/routingRuntime.test.ts
git commit -m "feat(engine): add routing runtime (DNS/TTL, health checks, targeting)"
```

---

### Task 4: Host scheduler — CPU/RAM/OOM

**Files:**
- Create: `src/lib/worldEngine/hostScheduler.ts`
- Create: `src/lib/worldEngine/latency.ts`
- Test: `src/lib/worldEngine/hostScheduler.test.ts` (covers both modules)

**Interfaces:**
- Consumes: `Server, InstanceId` from `../world/types`; `Rng` from `./rng`.
- Produces:

```ts
interface InstanceLoad { instanceId: InstanceId; cpuMsPerRequest: number; admittedRps: number; activeConnections: number; ramBaseMb: number; ramPerConnMb: number; memLimitMb: number | null }
interface HostStepResult {
  cpuPressure: number
  coreUtilization: number[]
  latencyMultiplier: number
  admittedScale: number
  ramUsedMb: number
  oomVictim: InstanceId | null
}
stepHost(server: Server, loads: InstanceLoad[], effectiveVcpu: number, rng: Rng): HostStepResult
sampleLatencyMs(p50: number, p99: number, rng: Rng): number
```

Semantics per spec decision 3: CPU demand (cores) = Σ over loads of
`admittedRps × cpuMsPerRequest / 1000`; `cpuPressure = demandCores / effectiveVcpu`;
`latencyMultiplier = max(1, cpuPressure)`; `admittedScale = min(1, 1/cpuPressure)`.
`coreUtilization` has one entry per physical vCPU (`server.specs.vcpu`), filled in index
order up to `min(demandCores, effectiveVcpu)` so partial cores read left-to-right. RAM per
instance = `ramBaseMb + ramPerConnMb × activeConnections`, capped at the instance's own
`memLimitMb` first if it has one (that instance becomes `oomVictim`, killed individually);
only if no container limit fired and total `ramUsedMb > server.specs.ramMb` does the host
pick the largest over-base consumer as `oomVictim` (rng breaks exact ties, never biased to
array order — a legitimate, tested use of the injected `Rng`).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/hostScheduler.test.ts
import { describe, it, expect } from 'vitest'
import { stepHost } from './hostScheduler'
import type { InstanceLoad } from './hostScheduler'
import { sampleLatencyMs } from './latency'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

function testServer(vcpu: number, ramMb: number) {
  const server = createServer('az-1', getPreset('vps-medium')!)
  server.specs.vcpu = vcpu
  server.specs.ramMb = ramMb
  return server
}

const load = (over: Partial<InstanceLoad> & { instanceId: string }): InstanceLoad => ({
  cpuMsPerRequest: 10,
  admittedRps: 0,
  activeConnections: 0,
  ramBaseMb: 100,
  ramPerConnMb: 0.5,
  memLimitMb: null,
  ...over,
})

describe('stepHost', () => {
  it('under capacity: multiplier 1, cores partially filled in order', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 150 })], 4, rng)
    // demand = 150 * 10 / 1000 = 1.5 cores
    expect(result.cpuPressure).toBeCloseTo(0.375)
    expect(result.latencyMultiplier).toBe(1)
    expect(result.admittedScale).toBe(1)
    expect(result.coreUtilization).toEqual([1, 0.5, 0, 0])
  })

  it('2x overload: multiplier 2, admittedScale 0.5, every core saturated', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 800 })], 4, rng)
    // demand = 800 * 10 / 1000 = 8 cores against 4 effective vCPU
    expect(result.cpuPressure).toBe(2)
    expect(result.latencyMultiplier).toBe(2)
    expect(result.admittedScale).toBe(0.5)
    expect(result.coreUtilization).toEqual([1, 1, 1, 1])
  })

  it('RAM grows with active connections (base + per-conn)', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', ramBaseMb: 100, ramPerConnMb: 2, activeConnections: 50 })], 4, rng)
    expect(result.ramUsedMb).toBe(200) // 100 + 2*50
    expect(result.oomVictim).toBeNull()
  })

  it('a container memLimit kills that instance individually, capped at the limit', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(
      server,
      [load({ instanceId: 'i1', ramBaseMb: 100, ramPerConnMb: 2, activeConnections: 500, memLimitMb: 300 })],
      4,
      rng,
    )
    // raw would be 100 + 2*500 = 1100, capped at its own 300MB limit
    expect(result.ramUsedMb).toBe(300)
    expect(result.oomVictim).toBe('i1')
  })

  it('host OOM picks the largest over-base consumer when total RAM exceeds the host', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(
      server,
      [
        load({ instanceId: 'small', ramBaseMb: 100, ramPerConnMb: 1, activeConnections: 10 }),
        load({ instanceId: 'big', ramBaseMb: 100, ramPerConnMb: 200, activeConnections: 10 }),
      ],
      4,
      rng,
    )
    // small: 110MB (overBase 10) ; big: 2100MB (overBase 2000) ; total 2210 > 2048 host RAM
    expect(result.ramUsedMb).toBe(2210)
    expect(result.oomVictim).toBe('big')
  })
})

describe('sampleLatencyMs', () => {
  it('median over 2000 seeded samples lands within +-10% of p50', () => {
    const rng = createRng(11)
    const samples: number[] = []
    for (let i = 0; i < 2000; i++) samples.push(sampleLatencyMs(50, 200, rng))
    samples.sort((a, b) => a - b)
    const median = samples[1000]
    expect(median).toBeGreaterThanOrEqual(50 * 0.9)
    expect(median).toBeLessThanOrEqual(50 * 1.1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/hostScheduler.test.ts`
Expected: FAIL — `Cannot find module './hostScheduler'`

- [ ] **Step 3: Write `latency.ts`**

```ts
// src/lib/worldEngine/latency.ts
// Log-normal latency sampling (Box-Muller), ported from legacy particleEngine.ts with
// Math.random replaced by rng injection. Spec decision 2: ports, not rewrites.
import type { Rng } from './rng'

export function sampleLatencyMs(p50: number, p99: number, rng: Rng): number {
  const mu = Math.log(Math.max(p50, 0.001))
  const sigma = (Math.log(Math.max(p99, p50 + 0.001)) - mu) / 2.326
  const u1 = Math.max(1e-10, rng.next())
  const u2 = rng.next()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(mu + sigma * z)
}
```

- [ ] **Step 4: Write `hostScheduler.ts`**

```ts
// src/lib/worldEngine/hostScheduler.ts
// Per-server CPU/RAM scheduling: demand vs effective capacity, OOM victim selection.
// Spec decision 3, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { Server, InstanceId } from '../world/types'
import type { Rng } from './rng'

export interface InstanceLoad {
  instanceId: InstanceId
  cpuMsPerRequest: number
  admittedRps: number
  activeConnections: number
  ramBaseMb: number
  ramPerConnMb: number
  memLimitMb: number | null
}

export interface HostStepResult {
  cpuPressure: number
  coreUtilization: number[]
  latencyMultiplier: number
  admittedScale: number
  ramUsedMb: number
  oomVictim: InstanceId | null
}

export function stepHost(server: Server, loads: InstanceLoad[], effectiveVcpu: number, rng: Rng): HostStepResult {
  const demandCores = loads.reduce((sum, l) => sum + (l.admittedRps * l.cpuMsPerRequest) / 1000, 0)
  const safeEffectiveVcpu = Math.max(effectiveVcpu, 0.0001)
  const cpuPressure = demandCores / safeEffectiveVcpu
  const latencyMultiplier = Math.max(1, cpuPressure)
  const admittedScale = Math.min(1, 1 / Math.max(cpuPressure, 0.0001))

  // Fill cores in order for readability (Phase 3's CPU die renders index 0 first).
  const usedCores = Math.min(demandCores, safeEffectiveVcpu)
  const coreCount = Math.max(1, Math.round(server.specs.vcpu))
  const coreUtilization: number[] = []
  let remaining = usedCores
  for (let i = 0; i < coreCount; i++) {
    const fill = Math.max(0, Math.min(1, remaining))
    coreUtilization.push(fill)
    remaining -= fill
  }

  // RAM: base + per-connection growth; a container's own memLimitMb caps (and kills) it
  // individually before any host-level accounting — the host never sees more than the cap.
  let ramUsedMb = 0
  let oomVictim: InstanceId | null = null
  const ramRows: { instanceId: InstanceId; overBase: number }[] = []
  for (const l of loads) {
    let instanceRam = l.ramBaseMb + l.ramPerConnMb * l.activeConnections
    if (l.memLimitMb !== null && instanceRam > l.memLimitMb) {
      instanceRam = l.memLimitMb
      if (oomVictim === null) oomVictim = l.instanceId
    }
    ramUsedMb += instanceRam
    ramRows.push({ instanceId: l.instanceId, overBase: instanceRam - l.ramBaseMb })
  }
  // Host-level OOM only fires when no container limit already claimed a victim this step:
  // kill the largest over-base consumer (rng breaks exact ties, never biased to array order).
  if (oomVictim === null && ramUsedMb > server.specs.ramMb && ramRows.length > 0) {
    const maxOverBase = Math.max(...ramRows.map(r => r.overBase))
    const tied = ramRows.filter(r => r.overBase === maxOverBase)
    oomVictim = rng.pick(tied).instanceId
  }

  return { cpuPressure, coreUtilization, latencyMultiplier, admittedScale, ramUsedMb, oomVictim }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/hostScheduler.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/hostScheduler.ts src/lib/worldEngine/latency.ts src/lib/worldEngine/hostScheduler.test.ts
git commit -m "feat(engine): add host scheduler (CPU/RAM/OOM) and latency sampling"
```

---

### Task 5: VPS model — steal walk + burst credits

**Files:**
- Create: `src/lib/worldEngine/vpsModel.ts`
- Test: `src/lib/worldEngine/vpsModel.test.ts`

**Interfaces:**
- Consumes: `Server` from `../world/types`; `Rng` from `./rng`.
- Produces:

```ts
interface VpsState { steal: number; credits: number }
createVpsState(server: Server): VpsState | null   // null for dedicated
stepVps(state: VpsState, server: Server, hostUtilization: number, stepMs: number, rng: Rng): {
  steal: number; effectiveVcpuFactor: number; creditsFraction: number | null
  noisySpikeStarted: boolean; creditsJustExhausted: boolean
}
```

Semantics per spec decision 4: steal random-walks toward mean `(oversubscriptionRatio − 1) ×
0.02`, clamped to `[0, 0.4]`; a spike is crossing `0.15` upward (`noisySpikeStarted`).
Burstable hosts accrue credits `+stepMs/1000 × 2` per step below 40% host utilization, drain
`−stepMs/1000 × 5 × (util − 0.4)/0.6` above it; `effectiveVcpuFactor` clamps to `0.4` (base
share) whenever `credits ≤ 10`, and reads `1 − steal` otherwise — this is a stateless
threshold band evaluated fresh each step (no separate hysteresis flag needed; see the
`VpsState` shape above, which is exactly the skeleton's two fields). Non-burstable VPS never
touches credits (`creditsFraction` stays `null`, factor is always `1 − steal`). Dedicated
hosts have no `VpsState` at all.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/vpsModel.test.ts
import { describe, it, expect } from 'vitest'
import { createVpsState, stepVps } from './vpsModel'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

function vpsServer(overrides: { oversubscriptionRatio?: number; burstable?: boolean } = {}) {
  const server = createServer('az-1', getPreset('vps-medium')!)
  if (overrides.oversubscriptionRatio !== undefined) server.oversubscriptionRatio = overrides.oversubscriptionRatio
  if (overrides.burstable !== undefined) server.burstable = overrides.burstable
  return server
}

function dedicatedServer() {
  return createServer('az-1', getPreset('dedicated-8')!)
}

describe('createVpsState', () => {
  it('returns null for a dedicated server', () => {
    expect(createVpsState(dedicatedServer())).toBeNull()
  })

  it('returns an initial steal-0 state for a vps server', () => {
    const state = createVpsState(vpsServer())
    expect(state).not.toBeNull()
    expect(state!.steal).toBe(0)
  })
})

describe('stepVps — steal walk', () => {
  it('mean steal over 5000 seeded steps approximates (ratio-1) x 0.02 within +-30%', () => {
    const server = vpsServer({ oversubscriptionRatio: 4, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(7)
    const target = (4 - 1) * 0.02 // 0.06
    let sum = 0
    const N = 5000
    for (let i = 0; i < N; i++) {
      const r = stepVps(state, server, 0.5, 1000, rng)
      sum += r.steal
    }
    const mean = sum / N
    expect(mean).toBeGreaterThan(target * 0.7)
    expect(mean).toBeLessThan(target * 1.3)
  })

  it('clamps steal to [0, 0.4] even under extreme oversubscription', () => {
    const server = vpsServer({ oversubscriptionRatio: 50, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(3)
    for (let i = 0; i < 3000; i++) {
      const r = stepVps(state, server, 0.5, 1000, rng)
      expect(r.steal).toBeGreaterThanOrEqual(0)
      expect(r.steal).toBeLessThanOrEqual(0.4)
    }
    expect(state.steal).toBeCloseTo(0.4, 5)
  })

  it('flags noisySpikeStarted when steal crosses 0.15 upward', () => {
    const server = vpsServer({ oversubscriptionRatio: 10, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(4)
    let spikes = 0
    for (let i = 0; i < 2000; i++) {
      const r = stepVps(state, server, 0.5, 1000, rng)
      if (r.noisySpikeStarted) spikes++
    }
    expect(spikes).toBeGreaterThan(0)
  })
})

describe('stepVps — burst credits', () => {
  it('drains credits under sustained high utilization until exhausted, then clamps effectiveVcpuFactor to 0.4', () => {
    const server = vpsServer({ oversubscriptionRatio: 2, burstable: true })
    const state = createVpsState(server)!
    const rng = createRng(6)
    let sawExhaustedEvent = false
    for (let i = 0; i < 20; i++) {
      const r = stepVps(state, server, 1.0, 1000, rng)
      if (r.creditsJustExhausted) sawExhaustedEvent = true
    }
    expect(state.credits).toBe(0)
    expect(sawExhaustedEvent).toBe(true)
    const throttled = stepVps(state, server, 1.0, 1000, rng)
    expect(throttled.effectiveVcpuFactor).toBe(0.4)
    expect(throttled.creditsFraction).toBe(0)
  })

  it('recovers effectiveVcpuFactor once credits climb back above 10', () => {
    const server = vpsServer({ oversubscriptionRatio: 2, burstable: true })
    const state = createVpsState(server)!
    const rng = createRng(6)
    for (let i = 0; i < 20; i++) stepVps(state, server, 1.0, 1000, rng) // drain to exhaustion
    let last = stepVps(state, server, 1.0, 1000, rng)
    expect(last.effectiveVcpuFactor).toBe(0.4)
    for (let i = 0; i < 6; i++) last = stepVps(state, server, 0.0, 1000, rng) // recover, low utilization
    expect(state.credits).toBeGreaterThan(10)
    expect(last.effectiveVcpuFactor).not.toBe(0.4)
    expect(last.effectiveVcpuFactor).toBeCloseTo(1 - state.steal, 5)
  })

  it('non-burstable VPS never reports a credits fraction and is never credit-throttled', () => {
    const server = vpsServer({ oversubscriptionRatio: 2, burstable: false })
    const state = createVpsState(server)!
    const rng = createRng(6)
    for (let i = 0; i < 30; i++) {
      const r = stepVps(state, server, 1.0, 1000, rng)
      expect(r.creditsFraction).toBeNull()
      expect(r.effectiveVcpuFactor).not.toBe(0.4)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/vpsModel.test.ts`
Expected: FAIL — `Cannot find module './vpsModel'`

- [ ] **Step 3: Write `vpsModel.ts`**

```ts
// src/lib/worldEngine/vpsModel.ts
// VPS noisy-neighbor steal random walk + burstable credit accrual/drain.
// Spec decision 4, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { Server } from '../world/types'
import type { Rng } from './rng'

const STEAL_MIN = 0
const STEAL_MAX = 0.4
const STEAL_WALK_STEP = 0.02        // random-walk noise magnitude per step
const STEAL_REVERSION = 0.1         // pull-toward-mean strength per step (keeps the walk bounded)
const SPIKE_THRESHOLD = 0.15        // crossing this upward = a "noisy neighbor" spike

const CREDIT_LOW_UTIL = 0.4
const CREDIT_HIGH_HEADROOM = 0.6    // 1 - CREDIT_LOW_UTIL
const CREDIT_ACCRUE_PER_SEC = 2
const CREDIT_DRAIN_PER_SEC = 5
const CREDIT_RECOVER_THRESHOLD = 10
const BASE_SHARE_FACTOR = 0.4       // effective vCPU factor while credit-throttled

export interface VpsState {
  steal: number
  credits: number
}

export function createVpsState(server: Server): VpsState | null {
  if (server.kind === 'dedicated') return null
  return { steal: 0, credits: 100 }
}

export interface VpsStepResult {
  steal: number
  effectiveVcpuFactor: number
  creditsFraction: number | null
  noisySpikeStarted: boolean
  creditsJustExhausted: boolean
}

export function stepVps(
  state: VpsState,
  server: Server,
  hostUtilization: number,
  stepMs: number,
  rng: Rng,
): VpsStepResult {
  const ratio = server.oversubscriptionRatio ?? 1
  const meanSteal = Math.max(0, (ratio - 1) * 0.02)
  const prevSteal = state.steal
  const walk = rng.range(-STEAL_WALK_STEP, STEAL_WALK_STEP)
  const reversion = (meanSteal - state.steal) * STEAL_REVERSION
  state.steal = Math.min(STEAL_MAX, Math.max(STEAL_MIN, state.steal + walk + reversion))
  const noisySpikeStarted = prevSteal < SPIKE_THRESHOLD && state.steal >= SPIKE_THRESHOLD

  let creditsFraction: number | null = null
  let creditsJustExhausted = false
  if (server.burstable) {
    const prevCredits = state.credits
    if (hostUtilization < CREDIT_LOW_UTIL) {
      state.credits = Math.min(100, state.credits + (stepMs / 1000) * CREDIT_ACCRUE_PER_SEC)
    } else {
      const drain =
        (stepMs / 1000) * CREDIT_DRAIN_PER_SEC * ((hostUtilization - CREDIT_LOW_UTIL) / CREDIT_HIGH_HEADROOM)
      state.credits = Math.max(0, state.credits - drain)
    }
    creditsJustExhausted = prevCredits > 0 && state.credits <= 0
    creditsFraction = state.credits / 100
  }

  const throttled = server.burstable && state.credits <= CREDIT_RECOVER_THRESHOLD
  const effectiveVcpuFactor = throttled ? BASE_SHARE_FACTOR : 1 - state.steal

  return { steal: state.steal, effectiveVcpuFactor, creditsFraction, noisySpikeStarted, creditsJustExhausted }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/vpsModel.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/vpsModel.ts src/lib/worldEngine/vpsModel.test.ts
git commit -m "feat(engine): add VPS steal walk and burst credit model"
```

---

### End-of-fragment verification (Tasks 1–5 combined)

- [ ] Run: `npx vitest run src/lib/worldEngine/`
  Expected: PASS (45 tests: 6 rng + 5 engineClock + 7 demand + 13 routingRuntime + 6
  hostScheduler + 8 vpsModel)
- [ ] Run: `npm run build`
  Expected: succeeds — confirms the whole repo (including still-mounted legacy code) still
  type-checks with `src/lib/worldEngine/` in the tree.

At this point `src/lib/worldEngine/` contains five pure, leaf modules (`types.ts`, `rng.ts`,
`engineClock.ts`, `demand.ts`, `routingRuntime.ts`, `hostScheduler.ts`, `latency.ts`,
`vpsModel.ts`) with no imports from `src/app/` and no `Math.random`. Task 6 (network runtime)
and onward build on top of these.
