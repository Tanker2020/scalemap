# Phase 2 Implementation Plan — Substrate Engine

**Date:** 2026-07-08 · **Branch:** `world-rebuild` (continues Phase-1 head `df21aab`)
**Binding specs:** `docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md`
(the 11 engineering decisions) and the FROZEN
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`. Umbrella:
`docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md` (D-decisions).

> Assembled from the reviewed Phase-2 fragments (Tasks 1–18,
> `docs/superpowers/plans/phase2/fragments/`). Fragment-writer scaffolding (per-fragment
> SKELETON CONCERNS blocks, `<!-- APPEND -->`/`<!-- CONTINUE -->` sentinels, fragment
> preambles) was removed at assembly; every concern was dispositioned by
> `docs/superpowers/plans/phase2/fragments/controller-rulings.md` and folded into the task
> text (inline `SKELETON CONCERNS #N` comments in code are the surviving trace). Forced drift
> from the frozen contracts / handoff is logged in `.superpowers/sdd/contract-drift.md`.

## Goal

Build `src/lib/worldEngine/` — a single headless engine ticking the whole compiled world:
host CPU/RAM scheduling (dedicated vs VPS), runtime traversal of permitted network paths, geo
traffic with routing policies and TTL-lagged failover, breakers, the metrics pyramid, events,
replay, and request tracing — plus AZ-scope particle rendering re-attached and cost model v2.
After this phase the app simulates again and the branch becomes mergeable to `main`.

## Architecture

- **`src/lib/worldEngine/`** — headless, deterministic (one seeded `mulberry32`), never imports
  from `src/app/`. Subsystems (Tasks 1–11) are pure functions/state objects composed by the
  `WorldEngineApi` facade (`index.ts`, Task 12) in a fixed-step loop. The facade publishes the
  1 Hz `MetricsBatch` pyramid, `EngineEvent`s, `ReplayFrame`s, and per-scope render payloads;
  it enforces the render caps.
- **`src/app/store/simulation.store.ts` v2** (Task 12) — the single Zustand seam between the
  facade and the world views. Views read the store; only its actions call the facade.
- **`src/app/world/**` UI** (Tasks 13–16) — Simulate/Stop + timeScale, live health/rps cards,
  AZ particle overlay, scrubber + traced-request inspector, cost tab. Minimal and
  contracts-shaped; rich Phase 3–5 views come later.
- **Legacy retirement** (Task 17) — `particleEngine` + old `simulation.store` + the old UI
  trees are deleted once their ports land (sequenced after the new UI mounts). Survivors:
  `theme.ts`, `nodeConfig.ts`, `cloudRegistry.ts`, `regionConfig.ts`, packet types,
  `tauri.ts`/mock, and everything under `world/` / `worldEngine/` / `app/world/`.

## Tech stack

Tauri 2 + React 19 + TypeScript, Zustand (one store per domain), `@xyflow/react` (canvas),
`framer-motion`, `lucide-react`, `vitest` + Testing Library. **No new dependencies** — the
engine is hand-written; determinism is a local seeded PRNG, not a library.

## Global Constraints

- Branch: `world-rebuild`, continuing from Phase-1 head `df21aab`.
- No new dependencies.
- FROZEN contracts: `src/lib/worldEngine/types.ts` is transcribed verbatim from the contracts doc in Task 1; later tasks import from it and NEVER redefine/reshape contract types. Additive-optional extension only, escalate otherwise.
- `src/lib/worldEngine/` never imports from `src/app/` (same layering rule as `lib/world/`). The facade is consumed via `src/app/store/simulation.store.ts` (rewritten, Task 12).
- Determinism: no `Math.random` inside `src/lib/worldEngine/` — all randomness through the seeded `rng.ts` (Task 1). Tests reseed per case.
- Fixed-step clock: 100ms steps, rAF+accumulator, `timeScale` multiplier (spec decision 1).
- Theme via `var(--color-*)`; JetBrains Mono via `--font-mono`; `prefers-reduced-motion` respected in all new animation.
- Strict `noUnusedLocals`/`noUnusedParameters`; never spread bare `borderColor`/`borderWidth` over shorthand `border`.
- Component tests: `// @vitest-environment jsdom` pragma; jest-dom via vitest.setup.ts (already wired).
- Commit per task: `feat(engine): …` (deletion task: `refactor(engine)!: …`).
- UI tasks (13–15) REQUIRE a live Playwright smoke step (dev server on strict port 1420, stop after, zero console errors, screenshots).
- Perf budget: ≤4ms/step at 2,000 instances; over budget → step-rate degradation + UI notice (Task 18 verifies).

## File structure

```
src/lib/worldEngine/
  types.ts           # contracts, verbatim (T1)
  rng.ts             # mulberry32 + helpers (T1)
  engineClock.ts     # fixed-step accumulator (T1)
  demand.ts          # population diurnal + baseline demand (T2)
  routingRuntime.ts  # DNS/TTL cache, health checks, region/AZ/instance targeting (T3)
  hostScheduler.ts   # CPU/RAM/OOM per-server per-step math (T4)
  vpsModel.ts        # steal walk + burst credits (T5)
  networkRuntime.ts  # hop latency, refused paths, NIC caps (T6)
  breakers.ts        # per-dependency circuit breakers (port) (T7)
  flows.ts           # per-step flow solver across instances (T8)
  failover.ts        # outages, health propagation, drain, promotion (T9)
  metrics.ts         # MetricsBatch pyramid + EMA (T10)
  events.ts          # EngineEvent emission ring (T10)
  replay.ts          # ReplayFrame ring + traced requests (T11)
  index.ts           # WorldEngineApi facade (T12)
  latency.ts         # log-normal sampling port (T4 helper, shared)
  *.test.ts          # colocated suites
src/app/store/simulation.store.ts   # REWRITTEN v2 (T12)
src/app/world/
  SimControls.tsx    # Simulate/Stop/timeScale in WorldShell header (T13)
  EventsTab.tsx      # events feed tab in WorldPanel (T13)
  AzSimOverlay.tsx   # particle canvas overlay + health tint plumbing (T14)
  ScrubberV2.tsx     # playback scrubber (T15)
  InspectorV2.tsx    # traced-request inspector (T15)
  CostTab.tsx        # cost tracker v2 tab (T16)
src/lib/costModelV2.ts               # (T16)
bench/enginePerf.bench.ts            # (T18)
DELETED (T17): src/app/canvas/** , src/app/simulation/** , src/app/sidebar/** ,
  src/app/toolbar/** , src/app/dock/** , src/app/analytics/** , src/app/reports/** ,
  src/app/StatusBar.tsx, src/app/store/{simulation-legacy remnants, replay.store.ts,
  metricsHistory.store.ts, costHistory.store.ts, canvas.store.ts, ui.store legacy fields},
  src/lib/costModel.ts, src/lib/scalescript.ts, src/lib/terraform/**, src/lib/vault/**
  (exact list re-derived by grep in the task; keep nodeConfig/theme/cloudRegistry/
  regionConfig/packets/tauri)
```

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

### Task 6: Network runtime — hop latency, refused paths, NIC caps

**Files:**
- Create: `src/lib/worldEngine/networkRuntime.ts`
- Test: `src/lib/worldEngine/networkRuntime.test.ts`

**Interfaces:**
- Consumes: `HopClass, CompiledPath, BlueprintDependency, Server` from `../world/types`;
  `Rng` from `./rng`; `interRegionLatencyMs` from `../regionConfig` (pure base — see
  SKELETON CONCERNS #1); `greatCircleKm` from `../world/regionGeo`.
- Produces:

```ts
hopLatencyMs(hopClass: HopClass | 'internet', fromRegionCatalogId: string | null, toRegionCatalogId: string | null, popLatLon: [number, number] | null, regionGeo: Record<string, { lat: number; lon: number }>, rng: Rng): number
interface NicState { inBytesThisStep: number; outBytesThisStep: number }
createNicState(): NicState                       // facade zeroes/replaces per step
applyNicCap(state: NicState, server: Server, addInBytes: number, addOutBytes: number, stepMs: number): { deliveredFraction: number; queuedLatencyMs: number }
refusedAttemptRate(dep: BlueprintDependency, blockedPaths: CompiledPath[], demandRps: number): number
```

Semantics (spec decision 6): localhost 0.1ms / same-az 0.5ms / cross-az 1.5ms, each ±10%
jitter; cross-region = `interRegionLatencyMs` base ±10% (deterministic port of
`sampleInterRegionLatencyMs`, concern #1); internet = great-circle km / 100 ms ±10%. NIC:
per-direction step budget from `specs.nicMbps`; ≤cap delivers free, cap..2×cap delivers
fully with queued latency proportional to the overage, >2×cap sheds to 2×cap. Blocked-path
demand still fires and is refused in full (misconfig is a live failure mode).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/networkRuntime.test.ts
import { describe, it, expect } from 'vitest'
import { hopLatencyMs, applyNicCap, createNicState, refusedAttemptRate } from './networkRuntime'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { interRegionLatencyMs } from '../regionConfig'
import { REGION_GEO, greatCircleKm } from '../world/regionGeo'
import type { CompiledPath, BlueprintDependency } from '../world/types'

const GEO = REGION_GEO

describe('hopLatencyMs', () => {
  it('localhost ~0.1ms within +-10% jitter', () => {
    const rng = createRng(1)
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('localhost', null, null, null, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(0.09 - 1e-9)
      expect(v).toBeLessThanOrEqual(0.11 + 1e-9)
    }
  })

  it('same-az ~0.5ms and cross-az ~1.5ms within +-10% jitter', () => {
    const rng = createRng(2)
    for (let i = 0; i < 300; i++) {
      const az = hopLatencyMs('same-az', null, null, null, GEO, rng)
      expect(az).toBeGreaterThanOrEqual(0.45 - 1e-9)
      expect(az).toBeLessThanOrEqual(0.55 + 1e-9)
      const xaz = hopLatencyMs('cross-az', null, null, null, GEO, rng)
      expect(xaz).toBeGreaterThanOrEqual(1.35 - 1e-9)
      expect(xaz).toBeLessThanOrEqual(1.65 + 1e-9)
    }
  })

  it('cross-region uses the pure inter-region base +-10% (deterministic port)', () => {
    const rng = createRng(3)
    const base = interRegionLatencyMs('us-east-1', 'eu-west-1')
    expect(base).toBeGreaterThan(0)
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('cross-region', 'us-east-1', 'eu-west-1', null, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(base * 0.9 - 1e-9)
      expect(v).toBeLessThanOrEqual(base * 1.1 + 1e-9)
    }
  })

  it('internet = great-circle km / 100 ms +-10% from the population to the region', () => {
    const rng = createRng(4)
    const nyc: [number, number] = [40.7, -74.0]
    const geo = GEO['us-east-1']
    const expected = greatCircleKm(nyc[0], nyc[1], geo.lat, geo.lon) / 100
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('internet', null, 'us-east-1', nyc, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(expected * 0.9 - 1e-9)
      expect(v).toBeLessThanOrEqual(expected * 1.1 + 1e-9)
    }
  })

  it('is deterministic under the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    expect(hopLatencyMs('cross-region', 'us-east-1', 'ap-southeast-2', null, GEO, a))
      .toBe(hopLatencyMs('cross-region', 'us-east-1', 'ap-southeast-2', null, GEO, b))
  })

  it('falls back to documented constants when geo inputs are missing', () => {
    const rng = createRng(5)
    for (let i = 0; i < 100; i++) {
      const xr = hopLatencyMs('cross-region', null, 'eu-west-1', null, GEO, rng)
      expect(xr).toBeGreaterThanOrEqual(72 - 1e-9)   // 80 +-10%
      expect(xr).toBeLessThanOrEqual(88 + 1e-9)
      const inet = hopLatencyMs('internet', null, 'us-east-1', null, GEO, rng)
      expect(inet).toBeGreaterThanOrEqual(36 - 1e-9) // 40 +-10%
      expect(inet).toBeLessThanOrEqual(44 + 1e-9)
    }
  })
})

describe('applyNicCap', () => {
  // vps-medium: nicMbps 1000 -> per-100ms-step budget = 1000e6/8 * 0.1 = 12_500_000 bytes
  const server = () => createServer('az-1', getPreset('vps-medium')!)
  const CAP = 12_500_000

  it('under cap: full delivery, no queued latency', () => {
    const state = createNicState()
    expect(applyNicCap(state, server(), CAP * 0.4, CAP * 0.4, 100))
      .toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
  })

  it('between cap and 2x cap: full delivery with proportional queued latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server(), CAP * 1.5, 0, 100)
    expect(r.deliveredFraction).toBe(1)
    expect(r.queuedLatencyMs).toBeCloseTo(50, 5) // (1.5 - 1) * 100ms
  })

  it('beyond 2x cap: sheds to 2x cap with saturated queue latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server(), 0, CAP * 4, 100)
    expect(r.deliveredFraction).toBeCloseTo(0.5, 5) // 2 / 4
    expect(r.queuedLatencyMs).toBe(100)
  })

  it('accumulates within a step: two adds that jointly cross the cap start queueing', () => {
    const state = createNicState()
    expect(applyNicCap(state, server(), CAP * 0.7, 0, 100).queuedLatencyMs).toBe(0)
    const second = applyNicCap(state, server(), CAP * 0.7, 0, 100)
    expect(second.deliveredFraction).toBe(1)
    expect(second.queuedLatencyMs).toBeCloseTo(40, 5) // cumulative 1.4x cap -> (0.4)*100ms
  })
})

describe('refusedAttemptRate', () => {
  const mkPath = (dependencyId: string, verdict: 'permitted' | 'blocked', n: number): CompiledPath => ({
    id: `p-${dependencyId}-${n}`,
    dependencyId,
    fromInstanceId: 'i-1',
    to: { kind: 'instance', instanceId: `t-${n}` },
    hopClass: 'same-az',
    verdict,
    blockReason: verdict === 'blocked' ? { kind: 'firewall-deny', detail: 'test', firewallRuleId: null } : null,
  })
  const dep: BlueprintDependency = {
    id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-t' },
    port: 8080, protocol: 'http', packetTemplateId: null,
  }

  it('refuses the full demand when every target path is blocked', () => {
    const paths = [mkPath('dep-1', 'blocked', 0), mkPath('dep-1', 'blocked', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(200)
  })

  it('refuses the blocked share when only some targets are blocked', () => {
    const paths = [mkPath('dep-1', 'blocked', 0), mkPath('dep-1', 'permitted', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(100)
  })

  it('returns 0 with no blocked paths, and ignores other dependencies\' paths', () => {
    const paths = [mkPath('dep-1', 'permitted', 0), mkPath('dep-other', 'blocked', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(0)
    expect(refusedAttemptRate(dep, [], 200)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/networkRuntime.test.ts`
Expected: FAIL — `Cannot find module './networkRuntime'`

- [ ] **Step 3: Write `networkRuntime.ts`**

```ts
// src/lib/worldEngine/networkRuntime.ts
// Runtime network model: per-hop latency sampling, NIC throughput caps, blocked-path
// refusals. Spec decision 6, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { HopClass, CompiledPath, BlueprintDependency, Server } from '../world/types'
import type { Rng } from './rng'
import { interRegionLatencyMs } from '../regionConfig'
import { greatCircleKm } from '../world/regionGeo'

const LOCALHOST_MS = 0.1
const SAME_AZ_MS = 0.5
const CROSS_AZ_MS = 1.5
const HOP_JITTER_FRACTION = 0.1     // every hop class jitters +-10%
const INTERNET_KM_PER_MS = 100      // client->region: ~1ms per 100km great-circle
const INTERNET_FALLBACK_MS = 40     // population/geo unknown — plausible mid-continent RTT half
const CROSS_REGION_FALLBACK_MS = 80 // catalog id unknown — AMER<->EMEA-magnitude default

const jitter = (base: number, rng: Rng): number =>
  Math.max(0, base * (1 + rng.range(-HOP_JITTER_FRACTION, HOP_JITTER_FRACTION)))

// Cross-region intentionally uses the PURE interRegionLatencyMs + rng jitter rather than
// regionConfig's sampleInterRegionLatencyMs (which calls Math.random — forbidden inside
// worldEngine). Identical distribution, deterministic under seed. SKELETON CONCERNS #1.
export function hopLatencyMs(
  hopClass: HopClass | 'internet',
  fromRegionCatalogId: string | null,
  toRegionCatalogId: string | null,
  popLatLon: [number, number] | null,
  regionGeo: Record<string, { lat: number; lon: number }>,
  rng: Rng,
): number {
  switch (hopClass) {
    case 'localhost':
      return jitter(LOCALHOST_MS, rng)
    case 'same-az':
      return jitter(SAME_AZ_MS, rng)
    case 'cross-az':
      return jitter(CROSS_AZ_MS, rng)
    case 'cross-region': {
      if (!fromRegionCatalogId || !toRegionCatalogId) return jitter(CROSS_REGION_FALLBACK_MS, rng)
      const base = interRegionLatencyMs(fromRegionCatalogId, toRegionCatalogId)
      return jitter(base > 0 ? base : CROSS_REGION_FALLBACK_MS, rng)
    }
    case 'internet': {
      const geo = toRegionCatalogId ? regionGeo[toRegionCatalogId] : undefined
      if (!popLatLon || !geo) return jitter(INTERNET_FALLBACK_MS, rng)
      const km = greatCircleKm(popLatLon[0], popLatLon[1], geo.lat, geo.lon)
      return jitter(km / INTERNET_KM_PER_MS, rng)
    }
  }
}

// ─── NIC caps ─────────────────────────────────────────────────────────────────

export interface NicState {
  inBytesThisStep: number
  outBytesThisStep: number
}

export function createNicState(): NicState {
  return { inBytesThisStep: 0, outBytesThisStep: 0 }
}

// Accumulates this call's bytes into the step's running totals, then evaluates the
// cumulative load against the per-step budget (worst direction governs):
//   <= cap        -> deliveredFraction 1, no added latency
//   cap .. 2xcap  -> still delivers fully; excess waits, queuedLatencyMs grows linearly
//                    from 0 at cap to stepMs at 2xcap
//   >  2xcap      -> sheds to 2xcap (deliveredFraction = 2xcap / load), queue saturated
export function applyNicCap(
  state: NicState,
  server: Server,
  addInBytes: number,
  addOutBytes: number,
  stepMs: number,
): { deliveredFraction: number; queuedLatencyMs: number } {
  state.inBytesThisStep += addInBytes
  state.outBytesThisStep += addOutBytes
  const capBytes = ((server.specs.nicMbps * 1e6) / 8) * (stepMs / 1000)
  if (capBytes <= 0) return { deliveredFraction: 0, queuedLatencyMs: stepMs }
  const load = Math.max(state.inBytesThisStep, state.outBytesThisStep)
  const ratio = load / capBytes
  if (ratio <= 1) return { deliveredFraction: 1, queuedLatencyMs: 0 }
  if (ratio <= 2) return { deliveredFraction: 1, queuedLatencyMs: (ratio - 1) * stepMs }
  return { deliveredFraction: 2 / ratio, queuedLatencyMs: stepMs }
}

// ─── Blocked-path refusals ────────────────────────────────────────────────────

// Demand attempted down blocked paths still fires (spec decision 6) — misconfig is a live
// failure mode, not just a compile finding. Convention (SKELETON CONCERNS #2): pass EVERY
// compiled path for this (caller, dependency) pair; demand splits evenly across them and
// the share landing on blocked targets is refused in full.
export function refusedAttemptRate(
  dep: BlueprintDependency,
  blockedPaths: CompiledPath[],
  demandRps: number,
): number {
  const depPaths = blockedPaths.filter(p => p.dependencyId === dep.id)
  if (depPaths.length === 0) return 0
  const blocked = depPaths.filter(p => p.verdict === 'blocked').length
  return demandRps * (blocked / depPaths.length)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/networkRuntime.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/networkRuntime.ts src/lib/worldEngine/networkRuntime.test.ts
git commit -m "feat(engine): add network runtime (hop latency, NIC caps, refused paths)"
```

---

### Task 7: Circuit breakers (port)

**Files:**
- Create: `src/lib/worldEngine/breakers.ts`
- Test: `src/lib/worldEngine/breakers.test.ts`

**Interfaces:**
- Consumes: nothing engine-side (leaf state machine; pure port of
  `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` semantics, re-keyed per
  `pathKey`, `simMs` injected instead of `Date.now()`, no event emission — the facade
  (T12) emits `breaker_open/half_open/closed` by observing state changes).
- Produces:

```ts
type BreakerState = 'closed' | 'open' | 'half-open'
interface BreakerConfig { errorThreshold: number; windowSize: number; resetMs: number }
DEFAULT_BREAKER_CONFIG: BreakerConfig            // { errorThreshold: 0.5, windowSize: 20, resetMs: 10_000 }
interface Breaker { state: BreakerState; openedAt: number; errorWindow: number[]; trialPending: boolean; config: BreakerConfig }
pathKey(fromInstanceId: string, dependencyId: string): string   // `${fromInstanceId}->${dependencyId}`
getBreaker(map: Map<string, Breaker>, key: string, config?: BreakerConfig): Breaker
recordResult(breaker: Breaker, failed: boolean, simMs: number): void
transition(breaker: Breaker, simMs: number): BreakerState
admitRequest(breaker: Breaker): boolean          // additive helper — see SKELETON CONCERNS #6
clearBreakers(map: Map<string, Breaker>): void
```

Ported semantics (keep exactly): closed→open when windowed error rate ≥ `errorThreshold`
AND at least `MIN_SAMPLES_TO_OPEN` (10) samples exist (window capped at `windowSize` 20,
oldest dropped); open→half-open after `resetMs` elapses (via `transition`); half-open
admits exactly ONE trial (`trialPending` claimed by `admitRequest`): trial success →
closed + window cleared, trial failure → open with fresh `openedAt`; `trialPending`
resets whenever the breaker enters or leaves half-open. Legacy's force-open-on-down and
health-gated reset are NOT ported here — the flow solver already zeroes a down target's
subtree and failover owns health; the facade composes those behaviors.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/breakers.test.ts
import { describe, it, expect } from 'vitest'
import {
  getBreaker, recordResult, transition, admitRequest, clearBreakers, pathKey,
  DEFAULT_BREAKER_CONFIG,
} from './breakers'
import type { Breaker } from './breakers'

function freshBreaker(): { map: Map<string, Breaker>; b: Breaker } {
  const map = new Map<string, Breaker>()
  const b = getBreaker(map, pathKey('i-1', 'dep-1'))
  return { map, b }
}

describe('breakers — state cycle', () => {
  it('runs the full cycle: closed -> open -> half-open -> closed on trial success', () => {
    const { b } = freshBreaker()
    expect(b.state).toBe('closed')
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(1000)

    expect(transition(b, 5_000)).toBe('open')          // resetMs (10s) not yet elapsed
    expect(transition(b, 11_001)).toBe('half-open')    // > openedAt + resetMs

    expect(admitRequest(b)).toBe(true)                 // the single trial
    recordResult(b, false, 11_100)                     // trial succeeds
    expect(b.state).toBe('closed')
    expect(b.errorWindow).toEqual([])                  // window cleared on close
  })

  it('reopens with a fresh openedAt when the half-open trial fails', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    transition(b, 11_001)
    expect(b.state).toBe('half-open')
    admitRequest(b)
    recordResult(b, true, 11_200)                      // trial fails
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(11_200)
    expect(transition(b, 21_000)).toBe('open')         // new resetMs window from 11_200
    expect(transition(b, 21_201)).toBe('half-open')
  })

  it('half-open admits exactly one trial until it resolves', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    transition(b, 10_001)
    expect(admitRequest(b)).toBe(true)    // claims the trial
    expect(admitRequest(b)).toBe(false)   // second caller refused
    expect(admitRequest(b)).toBe(false)
    recordResult(b, false, 10_100)        // trial resolves -> closed
    expect(admitRequest(b)).toBe(true)    // closed admits freely again
  })

  it('closed always admits; open never admits', () => {
    const { b } = freshBreaker()
    expect(admitRequest(b)).toBe(true)
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    expect(b.state).toBe('open')
    expect(admitRequest(b)).toBe(false)
    expect(admitRequest(b)).toBe(false)
  })
})

describe('breakers — window behavior', () => {
  it('never opens below the 10-sample minimum even at 100% errors', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 9; i++) recordResult(b, true, 0)
    expect(b.state).toBe('closed')
    recordResult(b, true, 0)              // 10th sample crosses the minimum
    expect(b.state).toBe('open')
  })

  it('stays closed under the error threshold and caps the window at 20 samples', () => {
    const { b } = freshBreaker()
    // 20 successes, then 9 failures: window holds the last 20 -> 9/20 = 0.45 < 0.5
    for (let i = 0; i < 20; i++) recordResult(b, false, 0)
    for (let i = 0; i < 9; i++) recordResult(b, true, 0)
    expect(b.errorWindow.length).toBe(20)
    expect(b.state).toBe('closed')
    recordResult(b, true, 0)              // 10/20 = 0.5 >= threshold
    expect(b.state).toBe('open')
  })

  it('getBreaker creates once and reuses; clearBreakers empties the map', () => {
    const map = new Map<string, Breaker>()
    const a = getBreaker(map, 'k1')
    expect(getBreaker(map, 'k1')).toBe(a)
    expect(a.config).toEqual(DEFAULT_BREAKER_CONFIG)
    getBreaker(map, 'k2', { errorThreshold: 0.2, windowSize: 20, resetMs: 5_000 })
    expect(map.size).toBe(2)
    expect(getBreaker(map, 'k2').config.errorThreshold).toBe(0.2)
    clearBreakers(map)
    expect(map.size).toBe(0)
  })

  it('pathKey formats `${fromInstanceId}->${dependencyId}`', () => {
    expect(pathKey('pl-1#0', 'dep-9')).toBe('pl-1#0->dep-9')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/breakers.test.ts`
Expected: FAIL — `Cannot find module './breakers'`

- [ ] **Step 3: Write `breakers.ts`**

```ts
// src/lib/worldEngine/breakers.ts
// Circuit breaker state machine — a pure port of the legacy
// src/app/canvas/simulation/particleEngine/circuitBreakers.ts semantics (spec decision 2:
// ports, not rewrites), with three deliberate changes and NO behavioral ones:
//   1. keyed per pathKey `${fromInstanceId}->${dependencyId}` instead of per edge id,
//   2. simMs injected instead of Date.now(),
//   3. no event emission / node lookups — the facade (Task 12) observes state changes and
//      emits breaker_open / breaker_half_open / breaker_closed itself.
// Legacy force-open-on-down and health-gated reset are intentionally not here: flows.ts
// zeroes a down target's subtree and failover.ts owns health.

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface BreakerConfig {
  errorThreshold: number   // windowed error rate that opens the breaker
  windowSize: number       // rolling sample window length
  resetMs: number          // open -> half-open cooldown
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  errorThreshold: 0.5,
  windowSize: 20,
  resetMs: 10_000,
}

// Legacy guard (circuitBreakers.ts:74): never open on a thin window — at least this many
// samples must exist before the threshold check can trip.
const MIN_SAMPLES_TO_OPEN = 10

export interface Breaker {
  state: BreakerState
  openedAt: number         // simMs when last opened
  errorWindow: number[]    // 1 = failure, 0 = success; capped at config.windowSize
  // While half-open: whether the single allowed trial has been claimed (admitRequest) and
  // is in flight. Reset on every entry to/exit from half-open.
  trialPending: boolean
  config: BreakerConfig
}

export function pathKey(fromInstanceId: string, dependencyId: string): string {
  return `${fromInstanceId}->${dependencyId}`
}

export function getBreaker(
  map: Map<string, Breaker>,
  key: string,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): Breaker {
  let b = map.get(key)
  if (!b) {
    b = { state: 'closed', openedAt: 0, errorWindow: [], trialPending: false, config }
    map.set(key, b)
  }
  return b
}

export function recordResult(breaker: Breaker, failed: boolean, simMs: number): void {
  breaker.errorWindow.push(failed ? 1 : 0)
  if (breaker.errorWindow.length > breaker.config.windowSize) {
    breaker.errorWindow.splice(0, breaker.errorWindow.length - breaker.config.windowSize)
  }

  if (breaker.state === 'closed') {
    const errRate =
      breaker.errorWindow.reduce((s, v) => s + v, 0) / breaker.errorWindow.length
    if (errRate >= breaker.config.errorThreshold && breaker.errorWindow.length >= MIN_SAMPLES_TO_OPEN) {
      breaker.state = 'open'
      breaker.openedAt = simMs
      breaker.trialPending = false
    }
  } else if (breaker.state === 'half-open') {
    breaker.trialPending = false // the trial resolved one way or the other
    if (!failed) {
      breaker.state = 'closed'
      breaker.errorWindow = []
    } else {
      breaker.state = 'open'
      breaker.openedAt = simMs
    }
  }
}

export function transition(breaker: Breaker, simMs: number): BreakerState {
  if (breaker.state === 'open' && simMs - breaker.openedAt > breaker.config.resetMs) {
    breaker.state = 'half-open'
    breaker.trialPending = false // fresh half-open window — no trial claimed yet
  }
  return breaker.state
}

// May a request proceed through this breaker right now? closed: always. open: never.
// half-open: exactly once — the first caller claims the trial (side effect: sets
// trialPending), everyone else is refused until recordResult resolves it.
// This is the gate flows.ts's breakerOpen callback inverts. SKELETON CONCERNS #6.
export function admitRequest(breaker: Breaker): boolean {
  if (breaker.state === 'closed') return true
  if (breaker.state === 'half-open' && !breaker.trialPending) {
    breaker.trialPending = true
    return true
  }
  return false
}

export function clearBreakers(map: Map<string, Breaker>): void {
  map.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/breakers.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 6: Commit**

```bash
git add src/lib/worldEngine/breakers.ts src/lib/worldEngine/breakers.test.ts
git commit -m "feat(engine): port circuit breakers keyed per dependency path"
```

---

### Task 8: Flow solver

**Files:**
- Create: `src/lib/worldEngine/flows.ts`
- Test: `src/lib/worldEngine/flows.test.ts`

**Interfaces:**
- Consumes: `CompiledWorld, WorldDoc, CompiledPath, InstanceId, ServerId, HopClass` from
  `../world/types`; `HealthState` from `./types`; `Rng` from `./rng`; `sampleLatencyMs`
  from `./latency` (T4); `pathKey` from `./breakers` (T7). Tests build fixtures with the
  real `../world/factories` + `compileWorld`.
- Produces (shapes verbatim from the skeleton):

```ts
interface FlowInput {
  compiled: CompiledWorld; doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  rng: Rng
}
interface InstanceFlow {
  instanceId: InstanceId
  offeredRps: number; admittedRps: number; errorRps: number; refusedRps: number
  serviceLatencyMs: number                          // sampled, multiplied
  downstream: { dependencyId: string; toInstanceId?: InstanceId; toManagedServiceId?: string; rps: number; hopClass: HopClass; blocked: boolean }[]
}
solveFlows(input: FlowInput): { flows: Record<InstanceId, InstanceFlow>; totals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number } }
BYTES_PER_REQUEST_EACH_WAY = 2048                  // named const, both directions counted
MANAGED_SERVICE_LATENCY_MS = 3                     // for T10/T11 consumers
```

Semantics (spec decision 6 + skeleton T8, all load-bearing):

- **BFS from entry instances** (keys of `entryDemand`) along compiled paths, contribution
  by contribution. Depth capped at **8**: a contribution arriving at depth 8 still lands on
  the instance (offered/admitted accounted) but fans out no further. Cycles guarded by a
  **visited set per request chain** ("request class" = the chain from one entry
  contribution): a downstream row is still recorded for a back-edge, but the demand is not
  re-propagated into an already-visited instance.
- **Admission:** `admitted = offered × admittedScaleByServer[serverId] (default 1) ×
  healthFactor` where healthFactor is down→0, degraded→0.7, healthy→1.
  `errorRps = offered − admitted` (shed + down demand errors at this instance). A down
  instance therefore zeroes its whole subtree.
- **Fan-out:** every dependency receives the FULL admitted rps (call-per-request model,
  like legacy), split **evenly across all of that dependency's compiled target paths —
  blocked ones included** (the caller can't see the misconfig; that's decision 6).
- **Blocked paths:** the blocked share adds to the CALLER's `refusedRps` and produces a
  `blocked: true` downstream row (events/particles render the refused burst from it); no
  bytes, no propagation.
- **Breakers:** `breakerOpen(pathKey(instanceId, dep.id))` short-circuits the ENTIRE
  dependency (per-dependency key): full admitted rps added to `refusedRps`, no downstream
  rows for that dependency.
- **Managed targets:** downstream row with `toManagedServiceId`, no capacity model in
  Phase 2 (fixed `MANAGED_SERVICE_LATENCY_MS = 3` exported for metrics/tracing); bytes
  bucketed like any hop.
- **Bytes:** `BYTES_PER_REQUEST_EACH_WAY = 2048` (2KB) per request **in each direction**
  (request + response ⇒ ×2) — a deliberately simple Phase-2 constant; packet templates
  refine per-protocol sizes in a later phase. Bucketed by hopClass: `cross-az` →
  `crossAzBytes`, `cross-region` → `crossRegionBytes`; localhost/same-az transfer is free
  and uncounted. Entry demand rides the public internet → `internetBytes`. Totals are
  bytes **per second** (inputs are rps); the facade integrates per step.
- **serviceLatencyMs:** sampled once per instance on first touch via
  `sampleLatencyMs(p50, p99, rng)` with `p50 = workload.cpuMsPerRequest`,
  `p99 = SERVICE_P99_OVER_P50 × p50` (see SKELETON CONCERNS #5), then multiplied by
  `latencyMultiplierByServer[serverId]`.
- Deterministic: BFS order is fixed by `entryDemand` key order + compiled path order, so a
  seeded rng reproduces identical outputs.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/flows.test.ts
import { describe, it, expect } from 'vitest'
import { solveFlows, BYTES_PER_REQUEST_EACH_WAY, MANAGED_SERVICE_LATENCY_MS } from './flows'
import type { FlowInput } from './flows'
import { pathKey } from './breakers'
import { createRng } from './rng'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { WorldDoc, ServiceBlueprint, BlueprintDependency } from '../world/types'
import type { HealthState } from './types'

// ─── Fixture helpers (real lib/world factories through a real compile) ────────

function dep(id: string, targetBpId: string): BlueprintDependency {
  return { id, target: { kind: 'blueprint', blueprintId: targetBpId }, port: 8080, protocol: 'http', packetTemplateId: null }
}

// One region, one AZ, one server; blueprints wired by the caller. Default factory
// blueprints bind port 8080 and the default firewall allows all internal traffic, so
// same-server paths compile permitted with hopClass 'localhost'.
function oneServerWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('dedicated-8')!)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  return { doc, region, az, server }
}

function addService(doc: WorldDoc, name: string, serverId: string, colorIndex = 0) {
  const bp = createBlueprint(name, colorIndex)
  doc.blueprints[bp.id] = bp
  const pl = createPlacement(bp.id, serverId)
  doc.placements[pl.id] = pl
  return { bp, pl, iid: instanceId(pl.id, 0) }
}

function baseInput(doc: WorldDoc, entryDemand: Record<string, number>, overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    compiled: compileWorld(doc),
    doc,
    entryDemand,
    admittedScaleByServer: {},
    latencyMultiplierByServer: {},
    breakerOpen: () => false,
    healthOf: () => 'healthy',
    rng: createRng(11),
    ...overrides,
  }
}

describe('solveFlows — propagation', () => {
  it('propagates full rps down a linear chain (api -> svc -> db)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const svc = addService(doc, 'svc', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-svc', svc.bp.id)]
    svc.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[api.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0 })
    expect(flows[svc.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100 })
    expect(flows[db.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100 })
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-svc', toInstanceId: svc.iid, rps: 100, hopClass: 'localhost', blocked: false },
    ])
    expect(flows[db.iid].downstream).toEqual([])
  })

  it('fans out the FULL admitted rps to every dependency (call-per-request model)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const cache = addService(doc, 'cache', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-cache', cache.bp.id), dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[cache.iid].offeredRps).toBe(100)   // duplicated, not split across deps
    expect(flows[db.iid].offeredRps).toBe(100)
    expect(flows[api.iid].downstream).toHaveLength(2)
  })

  it('splits one dependency\'s demand evenly across multiple target instances', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const bp = createBlueprint('svc', 1)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    doc.placements[pl.id] = pl
    api.bp.dependencies = [dep('d-svc', bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[instanceId(pl.id, 0)].offeredRps).toBe(50)
    expect(flows[instanceId(pl.id, 1)].offeredRps).toBe(50)
    const rows = flows[api.iid].downstream
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.rps).toBe(50)
  })

  it('applies the server admittedScale and books the shed demand as errorRps', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, {
      admittedScaleByServer: { [server.id]: 0.5 },
    }))
    expect(flows[api.iid].admittedRps).toBe(50)
    expect(flows[api.iid].errorRps).toBe(50)
    // downstream fans out the ADMITTED rps, then db admits 0.5 of ITS offered again
    expect(flows[api.iid].downstream[0].rps).toBe(50)
    expect(flows[db.iid].offeredRps).toBe(50)
    expect(flows[db.iid].admittedRps).toBe(25)
  })

  it('a degraded instance admits 0.7x of offered', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const healthOf = (id: string): HealthState => (id === api.iid ? 'degraded' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[api.iid].admittedRps).toBeCloseTo(70, 9)
    expect(flows[api.iid].errorRps).toBeCloseTo(30, 9)
  })

  it('a down instance zeroes its whole subtree', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const svc = addService(doc, 'svc', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-svc', svc.bp.id)]
    svc.bp.dependencies = [dep('d-db', db.bp.id)]
    const healthOf = (id: string): HealthState => (id === svc.iid ? 'down' : 'healthy')

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[svc.iid]).toMatchObject({ offeredRps: 100, admittedRps: 0, errorRps: 100 })
    expect(flows[svc.iid].downstream).toEqual([])   // nothing fans out of a down instance
    expect(flows[db.iid]).toBeUndefined()           // subtree never reached
  })
})

describe('solveFlows — refusals', () => {
  it('blocked paths refuse at the CALLER, emit a blocked row, and never reach the target', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    // db as a separate server so the target firewall applies, then deny its port.
    const db2srv = createServer(doc.servers[server.id].azId, getPreset('dedicated-8')!)
    db2srv.firewall = [{ id: 'deny-all', action: 'deny', port: 'any', protocol: 'any', source: 'any' }]
    doc.servers[db2srv.id] = db2srv
    const db = addService(doc, 'db', db2srv.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const input = baseInput(doc, { [api.iid]: 100 })
    expect(input.compiled.paths[0].verdict).toBe('blocked')   // fixture sanity
    const { flows, totals } = solveFlows(input)
    expect(flows[api.iid].refusedRps).toBe(100)
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-db', toInstanceId: db.iid, rps: 100, hopClass: 'same-az', blocked: true },
    ])
    expect(flows[db.iid]).toBeUndefined()
    expect(totals.crossAzBytes).toBe(0)   // refused attempts carry no payload
  })

  it('an open breaker short-circuits the whole dependency: refused, NO downstream rows', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, {
      breakerOpen: key => key === pathKey(api.iid, 'd-db'),
    }))
    expect(flows[api.iid].refusedRps).toBe(100)
    expect(flows[api.iid].downstream).toEqual([])
    expect(flows[db.iid]).toBeUndefined()
  })
})

describe('solveFlows — depth, cycles, managed', () => {
  it('caps propagation at depth 8: the 9th hop lands, the 10th is never offered', () => {
    const { doc, server } = oneServerWorld()
    // Chain of 11 services: s0 -> s1 -> ... -> s10. Depths: s0=0 ... s10=10.
    const services = Array.from({ length: 11 }, (_, i) => addService(doc, `s${i}`, server.id, i))
    for (let i = 0; i < 10; i++) {
      services[i].bp.dependencies = [dep(`d-${i}`, services[i + 1].bp.id)]
    }
    const { flows } = solveFlows(baseInput(doc, { [services[0].iid]: 100 }))
    expect(flows[services[8].iid]).toMatchObject({ offeredRps: 100 })  // depth 8 still lands
    expect(flows[services[8].iid].downstream).toEqual([])              // but fans out no further
    expect(flows[services[9].iid]).toBeUndefined()
    expect(flows[services[10].iid]).toBeUndefined()
  })

  it('guards cycles: a -> b -> a terminates and never re-inflates the entry', () => {
    const { doc, server } = oneServerWorld()
    const a = addService(doc, 'a', server.id, 0)
    const b = addService(doc, 'b', server.id, 1)
    a.bp.dependencies = [dep('d-ab', b.bp.id)]
    b.bp.dependencies = [dep('d-ba', a.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [a.iid]: 100 }))
    expect(flows[a.iid].offeredRps).toBe(100)   // the back-edge did NOT re-offer demand
    expect(flows[b.iid].offeredRps).toBe(100)
    // the back-edge is still visible as a downstream row (particles/edges render it)
    expect(flows[b.iid].downstream).toEqual([
      { dependencyId: 'd-ba', toInstanceId: a.iid, rps: 100, hopClass: 'localhost', blocked: false },
    ])
  })

  it('managed targets get a downstream row, no flow record, and a fixed-latency export', () => {
    const { doc, server, az } = oneServerWorld()
    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'RDS', nodeType: 'rds',
      scope: { kind: 'az', azId: az.id }, provider: 'aws', port: 5432,
    }
    const api = addService(doc, 'api', server.id, 0)
    api.bp.dependencies = [{ id: 'd-ms', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null }]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-ms', toManagedServiceId: 'ms-1', rps: 100, hopClass: 'same-az', blocked: false },
    ])
    expect(flows['ms-1']).toBeUndefined()
    expect(MANAGED_SERVICE_LATENCY_MS).toBe(3)
  })
})

describe('solveFlows — byte totals and latency', () => {
  it('buckets bytes by hopClass at 2KB per request both directions; entry demand is internet', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const region2 = createRegion('eu-west-1')
    const az1 = createAz(region.id, 'us-east-1a')
    const az2 = createAz(region.id, 'us-east-1b')
    const azEu = createAz(region2.id, 'eu-west-1a')
    Object.assign(doc.regions, { [region.id]: region, [region2.id]: region2 })
    Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2, [azEu.id]: azEu })
    const s1 = createServer(az1.id, getPreset('dedicated-8')!)
    const s2 = createServer(az2.id, getPreset('dedicated-8')!)
    const s3 = createServer(azEu.id, getPreset('dedicated-8')!)
    Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3 })

    const api = addService(doc, 'api', s1.id, 0)
    const svc = addService(doc, 'svc', s2.id, 1)     // cross-az from api
    const repl = addService(doc, 'repl', s3.id, 2)   // cross-region from api
    api.bp.dependencies = [dep('d-svc', svc.bp.id), dep('d-repl', repl.bp.id)]

    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    const perHop = 100 * BYTES_PER_REQUEST_EACH_WAY * 2   // rps x 2KB x both directions
    expect(totals.internetBytes).toBe(perHop)             // client -> entry
    expect(totals.crossAzBytes).toBe(perHop)
    expect(totals.crossRegionBytes).toBe(perHop)
  })

  it('same-az and localhost hops cost no bytes', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)   // same server: localhost
    api.bp.dependencies = [dep('d-db', db.bp.id)]
    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(totals.crossAzBytes).toBe(0)
    expect(totals.crossRegionBytes).toBe(0)
    expect(totals.internetBytes).toBe(100 * BYTES_PER_REQUEST_EACH_WAY * 2)
  })

  it('serviceLatencyMs scales with the server latency multiplier (same seed, 2x multiplier)', () => {
    const mkWorld = () => {
      const { doc, server } = oneServerWorld()
      const api = addService(doc, 'api', server.id, 0)
      return { doc, server, api }
    }
    const w1 = mkWorld()
    const base = solveFlows(baseInput(w1.doc, { [w1.api.iid]: 100 }, { rng: createRng(5) }))
    const w2 = mkWorld()
    const doubled = solveFlows(baseInput(w2.doc, { [w2.api.iid]: 100 }, {
      rng: createRng(5),
      latencyMultiplierByServer: { [w2.server.id]: 2 },
    }))
    const l1 = base.flows[w1.api.iid].serviceLatencyMs
    const l2 = doubled.flows[w2.api.iid].serviceLatencyMs
    expect(l1).toBeGreaterThan(0)
    expect(l2).toBeCloseTo(l1 * 2, 9)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/flows.test.ts`
Expected: FAIL — `Cannot find module './flows'`

- [ ] **Step 3: Write `flows.ts`**

```ts
// src/lib/worldEngine/flows.ts
// Per-step flow solver: contribution-based BFS from entry instances across compiled paths.
// The heart of the engine — everything downstream (host loads, metrics, particles, cost
// bytes) reads this module's output. Spec decision 6 + skeleton T8 semantics:
//   admitted = offered x admittedScale(server) x healthFactor (down 0 / degraded 0.7)
//   every dependency fans out the FULL admitted rps (call-per-request, like legacy),
//   split evenly across the dependency's compiled targets — blocked ones included
//   (the caller can't see the misconfig; attempts on blocked paths are LIVE failures)
//   blocked share -> caller refusedRps + blocked downstream row (no bytes, no propagation)
//   breakerOpen(pathKey) short-circuits the whole dependency (refused, no rows)
//   depth cap 8; cycles guarded per request chain (visited set carried on each item)
import type {
  CompiledWorld, WorldDoc, CompiledPath, InstanceId, ServerId, HopClass,
} from '../world/types'
import type { HealthState } from './types'
import type { Rng } from './rng'
import { sampleLatencyMs } from './latency'
import { pathKey } from './breakers'

// 2KB per request in EACH direction (request out + response back, so every hop books
// 2 x 2048 bytes per request). A deliberately simple Phase-2 constant — packet templates
// refine per-protocol sizes in a later phase. Totals are bytes/sec (inputs are rps).
export const BYTES_PER_REQUEST_EACH_WAY = 2048

// Managed targets have no capacity model in Phase 2: fixed service latency, always
// admits. Exported for metrics (T10) and tracing (T11) to attribute managed-hop time.
export const MANAGED_SERVICE_LATENCY_MS = 3

const MAX_DEPTH = 8                 // hop-depth cap; demand landing at depth 8 stops there
const DEGRADED_ADMIT_FACTOR = 0.7   // degraded instances still serve most of their load
const EPSILON_RPS = 1e-9            // below this, a contribution is dead — don't propagate
// Blueprints carry no authored latency model (only workload.cpuMsPerRequest), so service
// latency samples log-normal with p50 = cpuMsPerRequest and this p99 spread — legacy
// NODE_SIM_DEFAULTS spreads ran 10-12.5x. SKELETON CONCERNS #5.
const SERVICE_P99_OVER_P50 = 10

export interface FlowInput {
  compiled: CompiledWorld
  doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  rng: Rng
}

export interface DownstreamFlow {
  dependencyId: string
  toInstanceId?: InstanceId
  toManagedServiceId?: string
  rps: number
  hopClass: HopClass
  blocked: boolean
}

export interface InstanceFlow {
  instanceId: InstanceId
  offeredRps: number
  admittedRps: number
  errorRps: number
  refusedRps: number
  serviceLatencyMs: number                          // sampled, multiplied
  downstream: DownstreamFlow[]
}

export interface FlowTotals {
  crossAzBytes: number
  crossRegionBytes: number
  internetBytes: number
}

interface QueueItem {
  instanceId: InstanceId
  offered: number
  depth: number
  visited: Set<InstanceId>   // instances already on this request chain (cycle guard)
}

export function solveFlows(input: FlowInput): { flows: Record<InstanceId, InstanceFlow>; totals: FlowTotals } {
  const {
    compiled, doc, entryDemand, admittedScaleByServer, latencyMultiplierByServer,
    breakerOpen, healthOf, rng,
  } = input

  // Index candidate paths once: fromInstanceId -> dependencyId -> CompiledPath[]
  // (compiled.paths order is deterministic, so the even split is too).
  const pathsByFromDep = new Map<InstanceId, Map<string, CompiledPath[]>>()
  for (const p of compiled.paths) {
    let byDep = pathsByFromDep.get(p.fromInstanceId)
    if (!byDep) {
      byDep = new Map()
      pathsByFromDep.set(p.fromInstanceId, byDep)
    }
    const list = byDep.get(p.dependencyId)
    if (list) list.push(p)
    else byDep.set(p.dependencyId, [p])
  }

  const flows: Record<InstanceId, InstanceFlow> = {}
  const totals: FlowTotals = { crossAzBytes: 0, crossRegionBytes: 0, internetBytes: 0 }

  // First-touch flow record; serviceLatencyMs is sampled exactly once per instance, in
  // BFS creation order (deterministic under a seeded rng).
  const getFlow = (id: InstanceId): InstanceFlow => {
    let f = flows[id]
    if (!f) {
      const inst = compiled.instances[id]
      const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
      const p50 = Math.max(0.1, bp?.workload.cpuMsPerRequest ?? 1)
      const multiplier = inst ? (latencyMultiplierByServer[inst.serverId] ?? 1) : 1
      f = {
        instanceId: id,
        offeredRps: 0,
        admittedRps: 0,
        errorRps: 0,
        refusedRps: 0,
        serviceLatencyMs: sampleLatencyMs(p50, p50 * SERVICE_P99_OVER_P50, rng) * multiplier,
        downstream: [],
      }
      flows[id] = f
    }
    return f
  }

  // Contributions from different entries/chains can land on the same downstream row —
  // aggregate rps into one row per (dependency, target, blocked) triple.
  const addDownstream = (
    f: InstanceFlow,
    dependencyId: string,
    target: { toInstanceId?: InstanceId; toManagedServiceId?: string },
    rps: number,
    hopClass: HopClass,
    blocked: boolean,
  ): void => {
    const row = f.downstream.find(d =>
      d.dependencyId === dependencyId &&
      d.toInstanceId === target.toInstanceId &&
      d.toManagedServiceId === target.toManagedServiceId &&
      d.blocked === blocked)
    if (row) row.rps += rps
    else f.downstream.push({ dependencyId, ...target, rps, hopClass, blocked })
  }

  const bucketBytes = (hopClass: HopClass, rps: number): void => {
    const bytes = rps * BYTES_PER_REQUEST_EACH_WAY * 2   // request + response
    if (hopClass === 'cross-az') totals.crossAzBytes += bytes
    else if (hopClass === 'cross-region') totals.crossRegionBytes += bytes
    // localhost / same-az transfer is free — no cost line for it
  }

  const queue: QueueItem[] = []
  for (const [instanceId, rps] of Object.entries(entryDemand)) {
    if (rps <= 0) continue
    queue.push({ instanceId, offered: rps, depth: 0, visited: new Set([instanceId]) })
    // Client -> entry traffic rides the public internet.
    totals.internetBytes += rps * BYTES_PER_REQUEST_EACH_WAY * 2
  }

  // BFS via head index (no O(n) shift; perf budget is 4ms/step at 2,000 instances).
  let head = 0
  while (head < queue.length) {
    const item = queue[head++]
    const inst = compiled.instances[item.instanceId]
    if (!inst) continue   // stale entry id — routing/compile drift, skip defensively
    const flow = getFlow(item.instanceId)
    flow.offeredRps += item.offered

    const health = healthOf(item.instanceId)
    const healthFactor = health === 'down' ? 0 : health === 'degraded' ? DEGRADED_ADMIT_FACTOR : 1
    const admittedScale = admittedScaleByServer[inst.serverId] ?? 1
    const admitted = item.offered * admittedScale * healthFactor
    flow.admittedRps += admitted
    flow.errorRps += item.offered - admitted   // shed + down demand errors HERE

    if (admitted <= EPSILON_RPS) continue      // a down instance zeroes its whole subtree
    if (item.depth >= MAX_DEPTH) continue      // landed, but fans out no further

    const bp = doc.blueprints[inst.blueprintId]
    if (!bp) continue
    const byDep = pathsByFromDep.get(item.instanceId)

    for (const dep of bp.dependencies) {
      // Per-dependency breaker short-circuit: whole call volume refused, no rows.
      if (breakerOpen(pathKey(item.instanceId, dep.id))) {
        flow.refusedRps += admitted
        continue
      }
      const candidates = byDep?.get(dep.id)
      if (!candidates || candidates.length === 0) continue   // dangling dep: compile emitted nothing
      // Call-per-request: the dependency sees the FULL admitted rps, split evenly across
      // ALL compiled targets — blocked ones included (the caller can't see the misconfig).
      const share = admitted / candidates.length
      if (share <= EPSILON_RPS) continue

      for (const path of candidates) {
        const target = path.to.kind === 'instance'
          ? { toInstanceId: path.to.instanceId }
          : { toManagedServiceId: path.to.managedServiceId }

        if (path.verdict === 'blocked') {
          // Refused ON THE CALLER; the blocked row is what events/particles render.
          flow.refusedRps += share
          addDownstream(flow, dep.id, target, share, path.hopClass, true)
          continue   // refused attempts carry no payload and reach nothing
        }

        addDownstream(flow, dep.id, target, share, path.hopClass, false)
        bucketBytes(path.hopClass, share)

        if (path.to.kind === 'managed') continue   // no capacity model in Phase 2
        const toId = path.to.instanceId
        if (item.visited.has(toId)) continue        // cycle guard: row recorded, no re-entry
        const visited = new Set(item.visited)
        visited.add(toId)
        queue.push({ instanceId: toId, offered: share, depth: item.depth + 1, visited })
      }
    }
  }

  return { flows, totals }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/flows.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Run the whole engine suite (guards against cross-module drift)**

Run: `npx vitest run src/lib/worldEngine/`
Expected: PASS — rng 6, engineClock (per T1), demand (per T2), routingRuntime 13,
hostScheduler 6, vpsModel (per T5), networkRuntime 13, breakers 8, flows 14; zero failures.

- [ ] **Step 6: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/flows.ts src/lib/worldEngine/flows.test.ts
git commit -m "feat(engine): add per-step flow solver across instances"
```

---

### Task 9: Failover machinery — outages, health propagation, drain, promotion

**Files:**
- Create: `src/lib/worldEngine/failover.ts`
- Test: `src/lib/worldEngine/failover.test.ts`

**Interfaces:**
- Consumes: `AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc` from `../world/types`;
  `EngineEvent, HealthState` from `./types`.
- Produces (skeleton-exact, plus the additive members flagged in SKELETON CONCERNS #3, #4, #8):

```ts
interface FailoverState {
  manualOutages: Set<string>                 // scope ids forced down via setOutage
  healthByScope: Map<string, HealthState>    // last committed health per scope id (hysteresis output)
  drainUntil: Map<AzId, number>              // simMs at which a down AZ's drain completes
  promotedAt: Map<PlacementId, number>       // replica placement -> simMs it was promoted (emit-once guard)
  // additive (SKELETON CONCERNS #4): per-scope hysteresis timers
  onsetPendingSince: Map<string, number>     // first simMs a scope started worsening
  recoveryUntil: Map<string, number>         // simMs a scope may recover at (recovery lock)
}
interface HealthHysteresis { onsetMs: number; recoveryMs: number }
DEFAULT_HYSTERESIS: HealthHysteresis          // { onsetMs: 3000, recoveryMs: 5000 }
createFailoverState(): FailoverState          // additive factory (T12 uses it; SKELETON CONCERNS #7 in tasks-10-12 reconciled — this export exists)
setOutage(state, scope: 'server' | 'az' | 'region', id: string, down: boolean, simMs?: number): EngineEvent[]   // simMs optional=0, SKELETON CONCERNS #3
computeHealth(state, scopeId: string, inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean }, simMs: number, hysteresis: HealthHysteresis): HealthState
promoteReplicas(state, compiled: CompiledWorld, doc: WorldDoc, downInstanceIds: InstanceId[], simMs: number): EngineEvent[]
drainFactor(state, azId: AzId, simMs: number): number   // 1 -> 0 across DRAIN_MS after the AZ goes down; 0 when not draining
beginDrain(state, azId: AzId, simMs: number): void       // additive (SKELETON CONCERNS #8): facade calls on organic AZ->down
clearDrain(state, azId: AzId): void
```

Semantics (spec decision 7 + skeleton T9):

- **`setOutage`** is idempotent and returns events only on an actual state change: `down`
  adds the id to `manualOutages`, pins `healthByScope[id] = 'down'`, and (AZ scope only)
  `beginDrain`s; clearing removes it and (AZ scope) `clearDrain`s. Event ids are
  deterministic content-derived strings (SKELETON CONCERNS #3) — T10's ring may re-sequence.
- **`computeHealth`** ports the legacy onset-debounce / recovery-lock hysteresis (spec
  decision 2). `manualDown` forces `'down'` immediately (and clears both timers). Otherwise an
  instantaneous severity is derived from the live signals (`checkFailed` or high
  `errorRate`/`cpuPressure` → `'down'`; moderate → `'degraded'`; else `'healthy'`) and blended
  against the last committed state: **worsening** transitions must persist for `onsetMs` before
  they commit (`onsetPendingSince`); **improving** transitions must hold for `recoveryMs`
  before they commit (`recoveryUntil`). The committed state is written back to
  `healthByScope[scopeId]` and returned.
- **`promoteReplicas`**: for each down instance that is a `primary`, promote the oldest
  eligible `replica` of the same blueprint in the same **region** (deterministic: lowest
  instance id), emit `replica_promoted` exactly once per (blueprint, region) — guarded by
  `promotedAt`. Phase 2 is visual/event-only: no data ownership is modeled (spec decision 7).
- **`drainFactor`**: `max(0, min(1, (drainUntil − simMs) / DRAIN_MS))`; `0` when the AZ has no
  drain entry (not draining, or already fully drained). Existing traffic on a downed AZ ramps
  out over `DRAIN_MS = 2000`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/worldEngine/failover.test.ts
import { describe, it, expect } from 'vitest'
import {
  createFailoverState, setOutage, computeHealth, promoteReplicas, drainFactor,
  beginDrain, DEFAULT_HYSTERESIS,
} from './failover'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'

const healthy = { errorRate: 0, cpuPressure: 0.5, checkFailed: false, manualDown: false }
const bad = { errorRate: 0.9, cpuPressure: 3, checkFailed: true, manualDown: false }

describe('setOutage', () => {
  it('forces a scope down, emits outage_triggered once, and is idempotent', () => {
    const state = createFailoverState()
    const events = setOutage(state, 'az', 'az-1', true, 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'outage_triggered', severity: 'critical', affected: ['az-1'], simMs: 1000 })
    expect(state.manualOutages.has('az-1')).toBe(true)
    expect(state.healthByScope.get('az-1')).toBe('down')
    // idempotent — no second event for an already-down scope
    expect(setOutage(state, 'az', 'az-1', true, 2000)).toEqual([])
    // manualDown forces 'down' through computeHealth regardless of signals
    expect(computeHealth(state, 'az-1', { ...healthy, manualDown: true }, 3000, DEFAULT_HYSTERESIS)).toBe('down')
  })

  it('clears an outage and emits outage_cleared exactly once', () => {
    const state = createFailoverState()
    setOutage(state, 'region', 'r-1', true, 0)
    const cleared = setOutage(state, 'region', 'r-1', false, 5000)
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ kind: 'outage_cleared', affected: ['r-1'], simMs: 5000 })
    expect(state.manualOutages.has('r-1')).toBe(false)
    expect(setOutage(state, 'region', 'r-1', false, 6000)).toEqual([]) // already cleared
  })
})

describe('computeHealth — hysteresis', () => {
  it('debounces onset: two bad ticks inside onsetMs keep the scope healthy', () => {
    const state = createFailoverState()
    expect(computeHealth(state, 's-1', bad, 0, DEFAULT_HYSTERESIS)).toBe('healthy')       // pending starts
    expect(computeHealth(state, 's-1', bad, 2000, DEFAULT_HYSTERESIS)).toBe('healthy')     // 2s < 3s
    expect(computeHealth(state, 's-1', bad, 3001, DEFAULT_HYSTERESIS)).toBe('down')        // >= onsetMs -> commit
  })

  it('locks recovery: a healed scope stays down until recoveryMs elapses', () => {
    const state = createFailoverState()
    // drive it down first
    computeHealth(state, 's-2', bad, 0, DEFAULT_HYSTERESIS)
    computeHealth(state, 's-2', bad, 3001, DEFAULT_HYSTERESIS)
    expect(state.healthByScope.get('s-2')).toBe('down')
    // now healthy signals — recovery lock holds
    expect(computeHealth(state, 's-2', healthy, 4000, DEFAULT_HYSTERESIS)).toBe('down')    // lock starts
    expect(computeHealth(state, 's-2', healthy, 8000, DEFAULT_HYSTERESIS)).toBe('down')    // 4s < 5s
    expect(computeHealth(state, 's-2', healthy, 9001, DEFAULT_HYSTERESIS)).toBe('healthy') // >= recoveryMs
  })
})

describe('drainFactor', () => {
  it('ramps 1 -> 0 across DRAIN_MS (2000) after the AZ goes down', () => {
    const state = createFailoverState()
    beginDrain(state, 'az-9', 0)
    expect(drainFactor(state, 'az-9', 0)).toBeCloseTo(1, 5)
    expect(drainFactor(state, 'az-9', 1000)).toBeCloseTo(0.5, 5)
    expect(drainFactor(state, 'az-9', 2000)).toBeCloseTo(0, 5)
    expect(drainFactor(state, 'az-9', 2500)).toBe(0)
    expect(drainFactor(state, 'az-other', 0)).toBe(0)   // no drain entry
  })
})

describe('promoteReplicas', () => {
  // 1 region, 2 AZs; a primary in az-a and a replica of the same blueprint in az-b.
  function replicaFixture() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    const bp = createBlueprint('db', 0)
    bp.stateful = true
    const primary = createPlacement(bp.id, sA.id)          // role 'primary' by default
    const replica = createPlacement(bp.id, sB.id)
    replica.role = 'replica'
    doc.regions[region.id] = region
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB })
    Object.assign(doc.servers, { [sA.id]: sA, [sB.id]: sB })
    doc.blueprints[bp.id] = bp
    Object.assign(doc.placements, { [primary.id]: primary, [replica.id]: replica })
    const compiled = compileWorld(doc)
    return { doc, compiled, primaryInst: instanceId(primary.id, 0), replicaInst: instanceId(replica.id, 0) }
  }

  it('promotes the same-blueprint same-region replica and emits replica_promoted once', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'replica_promoted', simMs: 1000 })
    expect(events[0].affected).toContain(f.replicaInst)
    expect(events[0].affected).toContain(f.primaryInst)
    // called again while still promoted -> no duplicate event
    expect(promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 2000)).toEqual([])
  })

  it('does nothing when the down instance is not a primary', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    expect(promoteReplicas(state, f.compiled, f.doc, [f.replicaInst], 1000)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/failover.test.ts`
Expected: FAIL — `Cannot find module './failover'`

- [ ] **Step 3: Write `failover.ts`**

```ts
// src/lib/worldEngine/failover.ts
// Failover machinery: manual outage switches, ported health onset/recovery hysteresis,
// AZ drain ramp, and stateful replica promotion. Spec decision 7 (and decision 2 for the
// hysteresis port), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// Emits contract EngineEvents; the facade (Task 12) owns id re-sequencing and observation.
import type { AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc } from '../world/types'
import type { EngineEvent, HealthState } from './types'

const DRAIN_MS = 2000               // existing traffic on a downed AZ ramps out over 2s (spec decision 7)

// Instantaneous-severity thresholds (ported approximations of the legacy health signals).
// Only the hysteresis timing is behaviourally load-bearing; these bands classify a single tick.
const DOWN_ERROR_RATE = 0.5
const DOWN_CPU_PRESSURE = 2
const DEGRADED_ERROR_RATE = 0.1
const DEGRADED_CPU_PRESSURE = 1

export interface HealthHysteresis {
  onsetMs: number     // a worsening must persist this long before it commits
  recoveryMs: number  // an improvement must hold this long before it commits
}

// Legacy onset debounce 3000ms / recovery lock 5000ms (skeleton T9; legacy used an 8s
// recovery lock — SKELETON CONCERNS #7 keeps the skeleton's 5s since it's a parameter).
export const DEFAULT_HYSTERESIS: HealthHysteresis = { onsetMs: 3000, recoveryMs: 5000 }

export interface FailoverState {
  manualOutages: Set<string>
  healthByScope: Map<string, HealthState>
  drainUntil: Map<AzId, number>
  promotedAt: Map<PlacementId, number>
  onsetPendingSince: Map<string, number>
  recoveryUntil: Map<string, number>
}

export function createFailoverState(): FailoverState {
  return {
    manualOutages: new Set(),
    healthByScope: new Map(),
    drainUntil: new Map(),
    promotedAt: new Map(),
    onsetPendingSince: new Map(),
    recoveryUntil: new Map(),
  }
}

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

function outageEvent(
  kind: 'outage_triggered' | 'outage_cleared',
  scope: 'server' | 'az' | 'region',
  id: string,
  simMs: number,
): EngineEvent {
  const down = kind === 'outage_triggered'
  return {
    id: `outage-${scope}-${id}-${down ? 'down' : 'up'}-${simMs}`,
    simMs,
    kind,
    severity: down ? 'critical' : 'info',
    message: `${scope} ${id} manually ${down ? 'taken down' : 'restored'}`,
    affected: [id],
  }
}

export function beginDrain(state: FailoverState, azId: AzId, simMs: number): void {
  if (!state.drainUntil.has(azId)) state.drainUntil.set(azId, simMs + DRAIN_MS)
}

export function clearDrain(state: FailoverState, azId: AzId): void {
  state.drainUntil.delete(azId)
}

export function drainFactor(state: FailoverState, azId: AzId, simMs: number): number {
  const until = state.drainUntil.get(azId)
  if (until === undefined) return 0
  return Math.max(0, Math.min(1, (until - simMs) / DRAIN_MS))
}

// Idempotent manual switch: an event is returned ONLY when the outage set actually changes.
export function setOutage(
  state: FailoverState,
  scope: 'server' | 'az' | 'region',
  id: string,
  down: boolean,
  simMs = 0,
): EngineEvent[] {
  const already = state.manualOutages.has(id)
  if (down && !already) {
    state.manualOutages.add(id)
    state.healthByScope.set(id, 'down')
    if (scope === 'az') beginDrain(state, id, simMs)
    return [outageEvent('outage_triggered', scope, id, simMs)]
  }
  if (!down && already) {
    state.manualOutages.delete(id)
    if (scope === 'az') clearDrain(state, id)
    return [outageEvent('outage_cleared', scope, id, simMs)]
  }
  return []
}

export function computeHealth(
  state: FailoverState,
  scopeId: string,
  inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean },
  simMs: number,
  hysteresis: HealthHysteresis,
): HealthState {
  if (inputs.manualDown) {
    state.healthByScope.set(scopeId, 'down')
    state.onsetPendingSince.delete(scopeId)
    state.recoveryUntil.delete(scopeId)
    return 'down'
  }

  const instant: HealthState =
    inputs.checkFailed || inputs.errorRate >= DOWN_ERROR_RATE || inputs.cpuPressure >= DOWN_CPU_PRESSURE
      ? 'down'
      : inputs.errorRate >= DEGRADED_ERROR_RATE || inputs.cpuPressure >= DEGRADED_CPU_PRESSURE
        ? 'degraded'
        : 'healthy'

  const prev = state.healthByScope.get(scopeId) ?? 'healthy'
  let next = prev

  if (SEVERITY[instant] > SEVERITY[prev]) {
    // worsening — debounce onset
    state.recoveryUntil.delete(scopeId)
    const since = state.onsetPendingSince.get(scopeId)
    if (since === undefined) {
      state.onsetPendingSince.set(scopeId, simMs)
    } else if (simMs - since >= hysteresis.onsetMs) {
      next = instant
      state.onsetPendingSince.delete(scopeId)
    }
  } else if (SEVERITY[instant] < SEVERITY[prev]) {
    // improving — hold the recovery lock
    state.onsetPendingSince.delete(scopeId)
    const until = state.recoveryUntil.get(scopeId)
    if (until === undefined) {
      state.recoveryUntil.set(scopeId, simMs + hysteresis.recoveryMs)
    } else if (simMs >= until) {
      next = instant
      state.recoveryUntil.delete(scopeId)
    }
  } else {
    // stable at the current severity — cancel any pending transition
    state.onsetPendingSince.delete(scopeId)
    state.recoveryUntil.delete(scopeId)
  }

  state.healthByScope.set(scopeId, next)
  return next
}

// Primary down -> promote the oldest same-blueprint, same-region replica (spec decision 7).
// Visual/event semantics only in Phase 2: no data ownership is modeled. Emits once per
// (blueprint, region) via the promotedAt guard.
export function promoteReplicas(
  state: FailoverState,
  compiled: CompiledWorld,
  doc: WorldDoc,
  downInstanceIds: InstanceId[],
  simMs: number,
): EngineEvent[] {
  const events: EngineEvent[] = []
  const downSet = new Set(downInstanceIds)

  for (const downId of downInstanceIds) {
    const primary = compiled.instances[downId]
    if (!primary || primary.role !== 'primary') continue

    const siblingReplicas = Object.values(compiled.instances).filter(
      i => i.role === 'replica' && i.blueprintId === primary.blueprintId && i.regionId === primary.regionId,
    )
    // already promoted a replica for this (blueprint, region)? emit-once guard.
    if (siblingReplicas.some(i => state.promotedAt.has(i.placementId))) continue

    const chosen = siblingReplicas
      .filter(i => !downSet.has(i.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!chosen) continue

    state.promotedAt.set(chosen.placementId, simMs)
    const bpName = doc.blueprints[primary.blueprintId]?.name ?? primary.blueprintId
    events.push({
      id: `promote-${chosen.id}-${simMs}`,
      simMs,
      kind: 'replica_promoted',
      severity: 'warning',
      message: `${bpName} replica ${chosen.id} promoted to primary after ${downId} failed`,
      affected: [chosen.id, downId],
    })
  }

  return events
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/failover.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the whole engine suite (guards against cross-module drift)**

Run: `npx vitest run src/lib/worldEngine/`
Expected: PASS — rng 6, engineClock (per T1), demand (per T2), routingRuntime 13,
hostScheduler 6, vpsModel 8, networkRuntime 13, breakers 8, flows 14, failover 7; zero failures.

- [ ] **Step 6: tsc check**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 7: Commit**

```bash
git add src/lib/worldEngine/failover.ts src/lib/worldEngine/failover.test.ts
git commit -m "feat(engine): add failover machinery (outages, health hysteresis, drain, promotion)"
```

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

### Task 13: UI — sim controls, events tab, live metrics cards [sonnet + live smoke]

**Files:**
- Create: `src/app/world/SimControls.tsx`
- Create: `src/app/world/SimControls.test.tsx`
- Create: `src/app/world/EventsTab.tsx`
- Modify: `src/app/world/panels/WorldPanel.tsx` (add `Events` tab, add a `running` editing-lock gate)
- Modify: `src/app/world/WorldShell.tsx` (mount `<SimControls />` in the header, pass `running` to `WorldPanel`)
- Modify: `src/app/world/GlobeView.tsx` (live rps/err/health per region card)
- Modify: `src/app/world/RegionView.tsx` (live rps/err/health per AZ card)

**Interfaces:**
- Consumes: `useSimulationStore` (assumed v2 surface above), `useWorldStore`, `useCompiledWorld`.
- Produces: `<SimControls />` (Simulate/Stop + timeScale select + running dot), `<EventsTab />`
  (severity-colored event feed, newest first), `WorldPanel`'s new `running: boolean` prop that
  disables every authoring control while a sim is running (same editing-lock *intent* as the
  legacy `canvas.store`'s `running` gate documented in `docs/module-boundaries.md` §1A, but
  implemented with a single `<fieldset disabled={running}>` wrapper rather than per-action
  checks — `TopologyPanel`/`BlueprintPanel`/`PlacementPanel`'s controls are all native
  `<button>`/`<input>`/`<select>` elements, which HTML's `fieldset disabled` already cascades
  into automatically with zero changes to those three files).

- [ ] **Step 1: Write the failing `SimControls` test**

```tsx
// src/app/world/SimControls.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false, timeScale: 1 })
})

describe('SimControls', () => {
  it('calls start with the current doc + compiled world when clicking Simulate', () => {
    const startSpy = vi.spyOn(useSimulationStore.getState(), 'start').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.click(screen.getByText('Simulate'))
    expect(startSpy).toHaveBeenCalledTimes(1)
    const [doc, compiled] = startSpy.mock.calls[0]
    expect(doc).toBe(useWorldStore.getState().doc)
    expect(compiled.instances).toEqual({})   // fresh world → compileWorld returns no instances
  })

  it('shows Stop and calls stop() when running', () => {
    useSimulationStore.setState({ running: true })
    const stopSpy = vi.spyOn(useSimulationStore.getState(), 'stop').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.click(screen.getByText('Stop'))
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('changes timeScale via the select while running', () => {
    useSimulationStore.setState({ running: true })
    const setTimeScaleSpy = vi.spyOn(useSimulationStore.getState(), 'setTimeScale').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.change(screen.getByLabelText('time-scale'), { target: { value: '4' } })
    expect(setTimeScaleSpy).toHaveBeenCalledWith(4)
  })

  it('disables the timeScale select while stopped', () => {
    render(<SimControls />)
    expect(screen.getByLabelText('time-scale')).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: FAIL — `Cannot find module './SimControls'`

- [ ] **Step 3: Write `SimControls.tsx`**

```tsx
// src/app/world/SimControls.tsx
// Simulate/Stop + timeScale controls for WorldShell's header. Never touches the engine facade
// directly — contracts: "views... read this store; only control actions call the facade."
// (T18 later adds a `degraded` amber chip here once simulation.store gains that field — not
// this task's job; see Task 18.)
import type { CSSProperties } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'
import { useCompiledWorld } from './useCompiledWorld'

const btn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const btnRunning: CSSProperties = { ...btn, color: 'var(--color-danger)', border: '1px solid var(--color-danger)' }
const selectStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 6px', font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function SimControls() {
  const running = useSimulationStore(s => s.running)
  const timeScale = useSimulationStore(s => s.timeScale)
  const start = useSimulationStore(s => s.start)
  const stop = useSimulationStore(s => s.stop)
  const setTimeScale = useSimulationStore(s => s.setTimeScale)
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const reduced = useReducedMotion()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {running && (
        <motion.span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-success)' }}
          animate={reduced ? { opacity: 1 } : { opacity: [1, 0.35, 1] }}
          transition={reduced ? undefined : { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <button
        style={running ? btnRunning : btn}
        onClick={() => (running ? stop() : start(doc, compiled))}
      >
        {running ? 'Stop' : 'Simulate'}
      </button>
      <select
        aria-label="time-scale"
        style={selectStyle}
        value={timeScale}
        disabled={!running}
        onChange={e => setTimeScale(Number(e.target.value))}
      >
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
      </select>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Write `EventsTab.tsx`**

```tsx
// src/app/world/EventsTab.tsx
// WorldPanel's Events tab: the store's `events` ring (contracts: cap 500, oldest→newest),
// rendered newest-first with severity-colored left borders.
import { useSimulationStore } from '../store/simulation.store'
import { sectionLabel } from './panels/panelStyles'

const SEVERITY_COLOR: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--color-text-muted)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
}

export function EventsTab() {
  const events = useSimulationStore(s => s.events)
  const ordered = [...events].reverse()

  return (
    <div>
      <div style={sectionLabel}>Events ({events.length})</div>
      {ordered.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)' }}>No events yet — start the simulation.</div>
      )}
      {ordered.map(e => (
        <div key={e.id} style={{
          marginBottom: 6, borderLeft: `2px solid ${SEVERITY_COLOR[e.severity]}`, paddingLeft: 6,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: SEVERITY_COLOR[e.severity] }}>
            <span>{e.kind}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{(e.simMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)' }}>{e.message}</div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Add the Events tab + running gate to `WorldPanel.tsx`**

Current `src/app/world/panels/WorldPanel.tsx` (from Phase 1 Task 11/final-review batch):

```tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'findings'

export function WorldPanel() {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'findings', label: `Findings (${findings.length})` },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', border: '1px solid var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'topology' && <TopologyPanel />}
      {tab === 'blueprints' && <BlueprintPanel />}
      {tab === 'placements' && <PlacementPanel />}
      {tab === 'findings' && (
        <div>
          <div style={sectionLabel}>Findings</div>
          {findings.length === 0 && (
            <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
          )}
          {findings.map(f => (
            <div key={f.id} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)',
                  color: '#fff',
                  background: f.severity === 'error' ? 'var(--color-danger)' : 'var(--color-warning)',
                }}>{f.severity}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{f.kind}</span>
              </div>
              <div style={{ marginTop: 2 }}>{f.message}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
```

Replace it wholesale with:

```tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { EventsTab } from '../EventsTab'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'findings' | 'events'

export function WorldPanel({ running }: { running: boolean }) {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'findings', label: `Findings (${findings.length})` },
    { id: 'events', label: 'Events' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', border: '1px solid var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {/* Native fieldset-disabled cascades into every descendant button/input/select with zero
          changes to TopologyPanel/BlueprintPanel/PlacementPanel. Findings/Events have no form
          controls, so wrapping them here too is a harmless no-op — kept uniform on purpose. */}
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
        {tab === 'topology' && <TopologyPanel />}
        {tab === 'blueprints' && <BlueprintPanel />}
        {tab === 'placements' && <PlacementPanel />}
        {tab === 'findings' && (
          <div>
            <div style={sectionLabel}>Findings</div>
            {findings.length === 0 && (
              <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
            )}
            {findings.map(f => (
              <div key={f.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)',
                    color: '#fff',
                    background: f.severity === 'error' ? 'var(--color-danger)' : 'var(--color-warning)',
                  }}>{f.severity}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{f.kind}</span>
                </div>
                <div style={{ marginTop: 2 }}>{f.message}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'events' && <EventsTab />}
      </fieldset>
    </aside>
  )
}
```

- [ ] **Step 7: Mount `SimControls` and pass `running` in `WorldShell.tsx`**

In `src/app/world/WorldShell.tsx`, add two imports:

```ts
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
```

Add inside the component body (alongside the existing `dirty`/`fileError` state):

```ts
const running = useSimulationStore(s => s.running)
```

Change the header's `<Breadcrumb />` line to render `SimControls` between the breadcrumb and
the existing right-side file-actions cluster:

```tsx
<Breadcrumb />
<SimControls />
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  {/* ...unchanged: esc hint, dirty dot, New/Open/Save/Save As... */}
</div>
```

And change the `<WorldPanel />` call at the bottom to:

```tsx
<WorldPanel running={running} />
```

- [ ] **Step 8: Live metrics on `GlobeView.tsx`'s region cards**

In `src/app/world/GlobeView.tsx`, add the import and a health-color map:

```ts
import { useSimulationStore } from '../store/simulation.store'
```

```ts
const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const
```

Inside `GlobeView()`, add:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

Change the region card's body from:

```tsx
<button key={r.id} style={card} onClick={() => goRegion(r.id)}>
  <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
  <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
  </div>
</button>
```

to:

```tsx
<button key={r.id} style={card} onClick={() => goRegion(r.id)}>
  <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
  <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
  </div>
  {latestBatch?.regions[r.id] && (
    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
      <span style={{ color: HEALTH_COLOR[latestBatch.regions[r.id].health] }}>● {latestBatch.regions[r.id].health}</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.regions[r.id].rps.toFixed(0)} rps</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.regions[r.id].errorRate * 100).toFixed(1)}% err</span>
    </div>
  )}
</button>
```

- [ ] **Step 9: Live metrics on `RegionView.tsx`'s AZ cards**

Same pattern in `src/app/world/RegionView.tsx` — add the `useSimulationStore` import and
`HEALTH_COLOR` map, add `const latestBatch = useSimulationStore(s => s.latestBatch)`, and change
the AZ card body from:

```tsx
<button key={az.id} style={card} onClick={() => goAz(regionId, az.id)}>
  <div style={{ fontWeight: 600 }}>{az.label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} instance{instanceCount === 1 ? '' : 's'}
  </div>
</button>
```

to:

```tsx
<button key={az.id} style={card} onClick={() => goAz(regionId, az.id)}>
  <div style={{ fontWeight: 600 }}>{az.label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} instance{instanceCount === 1 ? '' : 's'}
  </div>
  {latestBatch?.azs[az.id] && (
    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
      <span style={{ color: HEALTH_COLOR[latestBatch.azs[az.id].health] }}>● {latestBatch.azs[az.id].health}</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.azs[az.id].rps.toFixed(0)} rps</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.azs[az.id].errorRate * 100).toFixed(1)}% err</span>
    </div>
  )}
</button>
```

- [ ] **Step 10: Verify build + tests**

Run: `npx vitest run src/app/world/SimControls.test.tsx` → PASS (4 tests)
Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green (see Task 17's SKELETON CONCERN #1 if `costModel.test.ts` fails here)

- [ ] **Step 11: Live Playwright smoke** (dev server, strict port 1420)

1. Start the dev server in the background: Bash `npm run dev` with `run_in_background: true`.
   Wait for `Local:   http://localhost:1420/` in its output before proceeding.
2. `browser_navigate` → `http://localhost:1420`.
3. `browser_snapshot` → confirm the Home screen ("scalemap" logo, "New World" button).
4. `browser_click` "New World" → confirm the breadcrumb reads "World" and GlobeView shows
   "No regions yet".
5. In the WorldPanel's Topology tab: `browser_select_option` the `add-region-select` to
   `us-east-1`, `browser_click` "+ Region"; `browser_click` "+ AZ" (under the new region card);
   `browser_click` "+ Server" (uses the default `vps-medium` preset).
6. Switch WorldPanel to the Blueprints tab (`browser_click` "Blueprints"); `browser_type` "web"
   into the "new blueprint name" field, `browser_click` "+ Blueprint".
7. Switch to the Placements tab (`browser_click` "Placements"); `browser_click` "+ Place" under
   the `web` blueprint card.
8. `browser_click` "Simulate" in the header. `browser_snapshot` → confirm the button now reads
   "Stop" and a running dot is present; confirm the Topology/Blueprints/Placements tab controls
   are now disabled (fieldset gate).
9. `browser_wait_for` ~3 seconds (allow at least one 1Hz metrics batch to publish).
10. `browser_snapshot` → confirm the GlobeView's region card now shows a health dot + "N rps" +
    "N% err" line that wasn't there before starting.
11. Switch WorldPanel to the new "Events" tab (`browser_click` "Events") → confirm at least one
    event row is rendered (any kind is fine — this world has no failure conditions configured,
    so events may just be routine health-check/breaker info-level entries; absence of ANY event
    after several seconds of a running sim would indicate a wiring bug worth investigating before
    proceeding).
12. `browser_console_messages` → assert zero `error`-level entries.
13. `browser_take_screenshot` → save to the scratchpad (e.g. `task13-running.png`).
14. `browser_click` "Stop" → confirm the button reads "Simulate" again and the running dot is
    gone; confirm the Topology tab controls are enabled again.
15. `browser_console_messages` again → assert zero new errors from the stop transition.
16. Stop the dev server (terminate the background Bash shell from step 1).

- [ ] **Step 12: Commit**

```bash
git add src/app/world/SimControls.tsx src/app/world/SimControls.test.tsx \
        src/app/world/EventsTab.tsx src/app/world/panels/WorldPanel.tsx \
        src/app/world/WorldShell.tsx src/app/world/GlobeView.tsx src/app/world/RegionView.tsx
git commit -m "feat(engine): add sim controls, events tab, and live metrics cards"
```

---

### Task 14: AZ canvas sim overlay [sonnet + live smoke]

**Files:**
- Create: `src/app/world/AzSimOverlay.tsx`
- Modify: `src/app/world/AzCanvas.tsx` (mount the overlay; pass live `health`/`cpuPct`/`ramUsedMb`/`ramTotalMb` into server node data)
- Modify: `src/app/world/WorldServerNode.tsx` (extend `WorldServerNodeData` additively; render health-tinted border + a CPU/RAM line)
- Modify: `src/app/world/RegionView.tsx` (add a manual region-outage toggle — see note below)

**Design note (documented, not a skeleton concern):** decision 11's Phase-2 UI list doesn't
itemize a manual-outage control, but the contracts' `setOutage` is a first-class part of
`WorldEngineApi`, Global Constraints line 21 requires step-rate degradation to be *observable*,
and — more concretely — Task 15's and Task 18's live smokes both require an "outage moment" to
scrub back to / a failover to demonstrate. A single region-level toggle is the smallest UI
surface that exercises this: region scope (rather than AZ or server) is what actually produces
the TTL-gated cross-region re-resolution decision 7 describes, and `RegionView.tsx` is the
existing page for "this region." AZ-internal drain (down AZ → same-region re-split, ~2s) doesn't
need a manual switch for Task 14's own smoke below — that one uses the *already-existing*
Phase-1 firewall "deny" rule to produce a blocked path, which is a different (and already-built)
mechanism.

**Interfaces:**
- Consumes: `attachRenderer({level:'az', azId}, onFrame)` from `simulation.store` (per-frame
  `FramePayload`), `@xyflow/react`'s `useReactFlow()`/`useViewport()`, `latestBatch.servers`.
- Produces: `<AzSimOverlay azId={string} />` — an absolutely-positioned `<canvas>` drawing
  `VisualParticle`s along server-pair screen positions; `WorldServerNodeData` additively gains
  `health?: HealthState`, `cpuPct?: number`, `ramUsedMb?: number`, `ramTotalMb?: number`.

- [ ] **Step 1: Write `AzSimOverlay.tsx`**

```tsx
// src/app/world/AzSimOverlay.tsx
// Canvas overlay for the focused AZ: draws live particles from the engine's per-frame
// attachRenderer payload along the same server-pair positions AzCanvas lays its nodes out at.
// Read-only, pointer-events: none — all real interaction stays on the ReactFlow pane underneath.
import { useEffect, useRef } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { VisualParticle } from '../../lib/worldEngine/types'

// Approximate on-screen footprint of WorldServerNode/WorldManagedNode. React Flow only reports
// *measured* dimensions once a node has actually painted; this overlay must be able to draw on
// frame 1, so a fixed approximation is used instead of waiting on measurement. Good enough for a
// Phase-2 "minimal, contracts-shaped" overlay — Phase 4/5 can read real measured dimensions.
const SERVER_W = 220, SERVER_H = 96
const MANAGED_W = 170, MANAGED_H = 60

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

interface Props { azId: string }

export function AzSimOverlay({ azId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { getNode } = useReactFlow()
  const viewport = useViewport()
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)

  // Keep the canvas's pixel buffer matched to its container — avoids CSS-stretch distortion,
  // which would otherwise throw off the screen-space math below.
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const resize = () => { canvas.width = parent.clientWidth; canvas.height = parent.clientHeight }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }

    const detach = useSimulationStore.getState().attachRenderer({ level: 'az', azId }, (payload) => {
      // Reduced-motion: throttle redraws to ~2/sec (still shows real, current state, just not
      // smooth motion) rather than fully suppressing the visualization — this canvas IS the
      // simulation's primary information channel here, not decorative chrome.
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const toScreen = (id: string, fallback: { x: number; y: number }) => {
        if (id.startsWith('edge:')) return { x: -40 * viewport.zoom + viewport.x, y: fallback.y }
        const node = getNode(id)
        if (!node) return fallback
        const w = node.type === 'worldManaged' ? MANAGED_W : SERVER_W
        const h = node.type === 'worldManaged' ? MANAGED_H : SERVER_H
        return {
          x: (node.position.x + w / 2) * viewport.zoom + viewport.x,
          y: (node.position.y + h / 2) * viewport.zoom + viewport.y,
        }
      }

      for (const p of payload.particles) {
        const to = toScreen(p.toId, { x: canvas.width / 2, y: canvas.height / 2 })
        const from = toScreen(p.fromId, to)
        const x = from.x + (to.x - from.x) * p.progress
        const y = from.y + (to.y - from.y) * p.progress

        if (p.blocked && p.progress > 0.85) {
          const burst = (p.progress - 0.85) / 0.15
          ctx.beginPath()
          ctx.arc(to.x, to.y, 4 + burst * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239, 68, 68, ${1 - burst})`   // var(--color-danger) #EF4444
          ctx.lineWidth = 2
          ctx.stroke()
          continue
        }

        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]
        ctx.fill()
      }
    })

    return detach
  }, [running, azId, getNode, viewport, reduced])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
```

- [ ] **Step 2: Extend `WorldServerNodeData` and render health tint + CPU/RAM in `WorldServerNode.tsx`**

Current `src/app/world/WorldServerNode.tsx`:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Server } from '../../lib/world/types'

export interface WorldServerNodeData {
  server: Server
  chips: { color: string; name: string; role: string; runtime: string }[]
  internalBlocked: number
  [key: string]: unknown
}

export function WorldServerNode({ data }: NodeProps) {
  const { server, chips, internalBlocked } = data as WorldServerNodeData
  return (
    <div style={{
      width: 220, background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>{server.label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{server.kind}</span>
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
        {server.specs.vcpu} vCPU · {Math.round(server.specs.ramMb / 1024)} GB · {server.firewall.length} fw rules
      </div>
      {chips.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
          <span>{c.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{c.role} · {c.runtime}</span>
        </div>
      ))}
      {chips.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>empty</div>}
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 10, marginTop: 4 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
```

(`WorldManagedNode` below it is unchanged.) Replace `WorldServerNodeData` and `WorldServerNode` with:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Server } from '../../lib/world/types'
import type { HealthState } from '../../lib/worldEngine/types'

export interface WorldServerNodeData {
  server: Server
  chips: { color: string; name: string; role: string; runtime: string }[]
  internalBlocked: number
  health?: HealthState
  cpuPct?: number
  ramUsedMb?: number
  ramTotalMb?: number
  [key: string]: unknown
}

const HEALTH_BORDER: Record<HealthState, string> = {
  healthy: '1px solid var(--color-node-border)',
  degraded: '1px solid var(--color-warning)',
  down: '1px solid var(--color-danger)',
}

export function WorldServerNode({ data }: NodeProps) {
  const { server, chips, internalBlocked, health, cpuPct, ramUsedMb, ramTotalMb } = data as WorldServerNodeData
  return (
    <div style={{
      width: 220, background: 'var(--color-node-base)', border: HEALTH_BORDER[health ?? 'healthy'],
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>{server.label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{server.kind}</span>
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
        {server.specs.vcpu} vCPU · {Math.round(server.specs.ramMb / 1024)} GB · {server.firewall.length} fw rules
      </div>
      {cpuPct !== undefined && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
          CPU {cpuPct.toFixed(0)}% · RAM {Math.round(ramUsedMb ?? 0)}/{Math.round(ramTotalMb ?? 0)} MB
        </div>
      )}
      {chips.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
          <span>{c.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{c.role} · {c.runtime}</span>
        </div>
      ))}
      {chips.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>empty</div>}
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 10, marginTop: 4 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
```

- [ ] **Step 3: Mount the overlay and feed live server data in `AzCanvas.tsx`**

In `src/app/world/AzCanvas.tsx`, add imports:

```ts
import { useSimulationStore } from '../store/simulation.store'
import { AzSimOverlay } from './AzSimOverlay'
```

Inside `AzCanvas()`, add:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

and add it to the `useMemo`'s dependency array (`[doc, compiled, azId, regionId, latestBatch]`).
Inside the server-node-building `.map`, extend the `data` object from:

```tsx
data: {
  server,
  chips: Object.values(compiled.instances)
    .filter(i => i.serverId === server.id)
    .map(i => {
      const bp = doc.blueprints[i.blueprintId]
      const pl = doc.placements[i.placementId]
      return { color: bp?.color ?? '#888', name: bp?.name ?? '?', role: i.role, runtime: pl?.runtime.type ?? 'process' }
    }),
  internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
},
```

to:

```tsx
data: {
  server,
  chips: Object.values(compiled.instances)
    .filter(i => i.serverId === server.id)
    .map(i => {
      const bp = doc.blueprints[i.blueprintId]
      const pl = doc.placements[i.placementId]
      return { color: bp?.color ?? '#888', name: bp?.name ?? '?', role: i.role, runtime: pl?.runtime.type ?? 'process' }
    }),
  internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
  health: latestBatch?.servers[server.id]?.health,
  cpuPct: latestBatch?.servers[server.id]
    ? (latestBatch.servers[server.id].coreUtilization.reduce((a, b) => a + b, 0) /
       Math.max(1, latestBatch.servers[server.id].coreUtilization.length)) * 100
    : undefined,
  ramUsedMb: latestBatch?.servers[server.id]?.ramUsedMb,
  ramTotalMb: latestBatch?.servers[server.id]?.ramTotalMb,
},
```

Finally, change the returned JSX from:

```tsx
return (
  <div style={{ width: '100%', height: '100%' }}>
    <ReactFlow ...>
      <Background gap={24} color="var(--color-canvas-dots)" />
    </ReactFlow>
  </div>
)
```

to:

```tsx
return (
  <div style={{ width: '100%', height: '100%', position: 'relative' }}>
    <ReactFlow ...>
      <Background gap={24} color="var(--color-canvas-dots)" />
    </ReactFlow>
    <AzSimOverlay azId={azId} />
  </div>
)
```

(`...` = the existing `nodes`/`edges`/`nodeTypes`/`fitView`/`nodesDraggable`/`nodesConnectable`/
`onNodeClick`/`proOptions` props, unchanged.)

- [ ] **Step 4: Region-outage toggle in `RegionView.tsx`**

In `src/app/world/RegionView.tsx`, add the import:

```ts
import { useSimulationStore } from '../store/simulation.store'
```

Inside `RegionView()`, add:

```ts
const running = useSimulationStore(s => s.running)
const isDown = useSimulationStore(s => s.healthOverrides[regionId ?? ''] ?? false)
const setOutage = useSimulationStore(s => s.setOutage)
```

Change the region title line from:

```tsx
<div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 16 }}>
  {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
</div>
```

to:

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
  <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)' }}>
    {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
  </div>
  {running && (
    <button
      style={{
        background: 'var(--color-node-base)',
        border: `1px solid ${isDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
        borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
        font: '11px var(--font-mono)', color: isDown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
      }}
      onClick={() => setOutage('region', regionId, !isDown)}
    >
      {isDown ? '✓ Clear region outage' : '⚡ Simulate region outage'}
    </button>
  )}
</div>
```

- [ ] **Step 5: Verify build**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green

- [ ] **Step 6: Live Playwright smoke**

1. Start the dev server in the background: `npm run dev`. Wait for the ready URL.
2. `browser_navigate` → `http://localhost:1420`.
3. `browser_click` "New World"; author a small AZ with two dependent blueprints so a path
   exists to break: add region `us-east-1` → "+ AZ" → "+ Server" twice (two servers in the AZ);
   Blueprints tab: create `api` and `pg`; expand `api`'s "▸ deps", click "+ Dependency" (defaults
   to targeting `pg` on port 8080/http — leave it, the block only needs SOME dependency path to
   exist); Placements tab: "+ Place" `api` onto server 1, "+ Place" `pg` onto server 2.
4. Navigate into the AZ (breadcrumb: click the region, then click an AZ card, or click "+ AZ"'s
   resulting AZ card from RegionView) so `AzCanvas`/`AzSimOverlay` are mounted.
   `browser_snapshot` → confirm two server nodes render with instance chips.
5. `browser_click` "Simulate" in the header.
6. `browser_wait_for` ~3 seconds. `browser_take_screenshot` → confirm particles are visible
   moving between the two server nodes (dots along the edge line) — save as
   `task14-particles-flowing.png`.
7. While still running, go back to the WorldPanel's Topology tab (fieldset-disabled per Task
   13 — confirm via snapshot that its controls are indeed disabled, then Stop the simulation via
   the header "Stop" button to re-enable editing), expand server 2 (`pg`'s server), add a
   firewall rule `deny :8080 tcp from any` ABOVE the default allow-all (use the `↑` reorder
   button so it evaluates first), then `browser_click` "Simulate" again to restart with the new
   topology.
8. `browser_wait_for` ~3 seconds. `browser_take_screenshot` → confirm a red burst animation is
   visible at the target server node (the now-blocked path) — save as
   `task14-blocked-path-burst.png`. Confirm the target server node's border reflects the block
   via the `internalBlocked`/edge styling already present from Phase 1 (same-server vs
   cross-server blocking renders per `AzCanvas.tsx`'s existing aggregation — since these two
   servers are different, this renders as a red dashed edge with `✕ firewall-deny`, consistent
   with Phase 1's AzCanvas behavior; `AzSimOverlay`'s red burst is the additional live-particle
   evidence this task adds).
9. `browser_console_messages` → assert zero errors.
10. Click "Stop". Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/AzSimOverlay.tsx src/app/world/AzCanvas.tsx \
        src/app/world/WorldServerNode.tsx src/app/world/RegionView.tsx
git commit -m "feat(engine): render AZ canvas particle overlay with health-tinted nodes"
```

---

### Task 15: Scrubber v2 + inspector v2 [sonnet + live smoke]

**Files:**
- Modify: `src/app/store/simulation.store.ts` (additive: `scrubIndex`, `scrubBatch`, `setScrubIndex`)
- Create: `src/app/world/ScrubberV2.tsx`
- Create: `src/app/world/InspectorV2.tsx`
- Modify: `src/app/world/WorldShell.tsx` (mount `<ScrubberV2 />` as a bottom bar)
- Modify: `src/app/world/AzCanvas.tsx` (mount `<InspectorV2 azId={azId} />`; swap `latestBatch` reads to `scrubBatch ?? latestBatch`)
- Modify: `src/app/world/GlobeView.tsx`, `src/app/world/RegionView.tsx` (swap `latestBatch` reads to `scrubBatch ?? latestBatch`, so scrubbing replays health/rps across every view, not just the AZ canvas)

**Interfaces:**
- Consumes: `getReplayFrames()`, `getTracedRequests(scope)` (both plain, non-reactive methods on
  the store per the assumed T12 surface — this task polls/snapshots them locally rather than
  expecting them to be reactive state).
- Produces: `store.scrubIndex: number | null`, `store.scrubBatch: MetricsBatch | null`,
  `store.setScrubIndex(i)` (looks up `getReplayFrames()[i]?.batch` and sets both fields
  atomically); `<ScrubberV2 />` — a bottom bar, visible only when `!running && frames.length > 0`,
  a horizontal strip of ticks colored by that frame's worst-AZ `healthScore`, click/drag to
  scrub; `<InspectorV2 azId={string} />` — lists `getTracedRequests({level:'az', azId})`,
  refreshed on a 1s poll, click a row to expand its hop table.

- [ ] **Step 1: Extend `simulation.store.ts` (additive)**

This is a modification to the file T12 already produced. Add to the store's public interface:

```ts
scrubIndex: number | null
scrubBatch: MetricsBatch | null
setScrubIndex: (i: number | null) => void
```

Add to its initial state:

```ts
scrubIndex: null,
scrubBatch: null,
```

Add the action (reads the facade's `getReplayFrames()` — already exposed on the store per the
assumed T12 surface):

```ts
setScrubIndex: (i) => {
  if (i == null) return set({ scrubIndex: null, scrubBatch: null })
  const frames = get().getReplayFrames()
  set({ scrubIndex: i, scrubBatch: frames[i]?.batch ?? null })
},
```

In whichever existing action resets run state on `start()` (T12's `start` action), add
`scrubIndex: null, scrubBatch: null` to that action's `set(...)` call, so starting a fresh run
always exits scrub mode.

- [ ] **Step 2: Write `ScrubberV2.tsx`**

```tsx
// src/app/world/ScrubberV2.tsx
// Bottom-bar playback scrubber. Shown only once replay frames exist and the sim is stopped
// (contracts: replay is a 1Hz, 300-frame ring — "scrubbing any level reads one frame").
import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { ReplayFrame } from '../../lib/worldEngine/types'

const HEALTH_TICK_COLOR = (score: number): string => {
  if (score >= 80) return 'var(--color-success)'
  if (score >= 40) return 'var(--color-warning)'
  return 'var(--color-danger)'
}

function worstAzHealthScore(frame: ReplayFrame): number {
  const scores = Object.values(frame.batch.azs).map(az => az.healthScore)
  return scores.length === 0 ? 100 : Math.min(...scores)
}

export function ScrubberV2() {
  const running = useSimulationStore(s => s.running)
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  const [frames, setFrames] = useState<ReplayFrame[]>([])
  const reduced = useReducedMotion()

  useEffect(() => {
    if (running) return
    setFrames(useSimulationStore.getState().getReplayFrames())
  }, [running])

  if (running || frames.length === 0) return null

  const pick = (clientX: number, target: HTMLDivElement) => {
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setScrubIndex(Math.min(frames.length - 1, Math.floor(ratio * frames.length)))
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px',
      borderTop: '1px solid var(--color-toolbar-border)', background: 'var(--color-toolbar)',
      font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
    }}>
      <span>Replay</span>
      <div
        role="slider"
        aria-label="replay-scrubber"
        aria-valuemin={0}
        aria-valuemax={frames.length - 1}
        aria-valuenow={scrubIndex ?? frames.length - 1}
        style={{
          flex: 1, height: 18, display: 'flex', cursor: 'pointer', borderRadius: 3, overflow: 'hidden',
          border: '1px solid var(--color-node-border)',
        }}
        onClick={e => pick(e.clientX, e.currentTarget)}
      >
        {frames.map((f, i) => (
          <div
            key={f.simMs}
            style={{
              flex: 1, background: HEALTH_TICK_COLOR(worstAzHealthScore(f)),
              opacity: scrubIndex === i ? 1 : 0.55,
              transition: reduced ? undefined : 'opacity 120ms ease',
            }}
          />
        ))}
      </div>
      <span>{scrubIndex == null ? 'live' : `${(frames[scrubIndex].simMs / 1000).toFixed(1)}s`}</span>
      {scrubIndex != null && (
        <button
          style={{
            background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
          }}
          onClick={() => setScrubIndex(null)}
        >
          Exit scrub
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Write `InspectorV2.tsx`**

```tsx
// src/app/world/InspectorV2.tsx
// AZ-view overlay listing traced requests for the focused AZ (contracts: "engine samples ≤1
// traced request per second per scope" — polled locally since getTracedRequests is a plain
// method, not reactive state).
import { useEffect, useState } from 'react'
import { useSimulationStore } from '../store/simulation.store'
import type { TracedRequest } from '../../lib/worldEngine/types'

const OUTCOME_COLOR: Record<TracedRequest['outcome'], string> = {
  ok: 'var(--color-success)', refused: 'var(--color-danger)',
  error: 'var(--color-danger)', timeout: 'var(--color-warning)',
}

interface Props { azId: string }

export function InspectorV2({ azId }: Props) {
  const [traces, setTraces] = useState<TracedRequest[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const poll = () => setTraces(useSimulationStore.getState().getTracedRequests({ level: 'az', azId }))
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [azId])

  if (traces.length === 0) return null

  return (
    <div style={{
      position: 'absolute', left: 12, bottom: 12, width: 260, maxHeight: 260, overflowY: 'auto',
      background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
      pointerEvents: 'auto',
    }}>
      <div style={{ font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
        Traced requests
      </div>
      {traces.map(t => (
        <div key={t.id} style={{ marginBottom: 6 }}>
          <button
            style={{
              display: 'flex', justifyContent: 'space-between', width: '100%',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: OUTCOME_COLOR[t.outcome], font: '11px var(--font-mono)',
            }}
            onClick={() => setExpandedId(id => id === t.id ? null : t.id)}
          >
            <span>{t.outcome}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{t.totalMs.toFixed(1)}ms</span>
          </button>
          {expandedId === t.id && (
            <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
              {t.hops.map((h, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-text-secondary)' }}>
                  <span>{h.fromId} → {h.toId} ({h.hopClass})</span>
                  <span style={{ color: OUTCOME_COLOR[h.outcome] }}>{h.outcome} · {h.latencyMs.toFixed(1)}ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Mount `ScrubberV2` in `WorldShell.tsx`**

Add the import `import { ScrubberV2 } from './ScrubberV2'`. Change the outer return from:

```tsx
return (
  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
    <header>...</header>
    {fileError && (...)}
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <main>...</main>
      <WorldPanel running={running} />
    </div>
  </div>
)
```

to:

```tsx
return (
  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
    <header>...</header>
    {fileError && (...)}
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <main>...</main>
      <WorldPanel running={running} />
    </div>
    <ScrubberV2 />
  </div>
)
```

- [ ] **Step 5: Mount `InspectorV2` and switch to `scrubBatch ?? latestBatch` in `AzCanvas.tsx`**

Add the import `import { InspectorV2 } from './InspectorV2'`. Change the batch selector from:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

to:

```ts
const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
```

and update every `latestBatch?.servers[...]` reference added in Task 14 to `batch?.servers[...]`
(three occurrences: `health`, `cpuPct`'s condition + computation, `ramUsedMb`/`ramTotalMb`).
Update the `useMemo` dependency array's `latestBatch` entry to `batch`. Change the returned JSX
from:

```tsx
<div style={{ width: '100%', height: '100%', position: 'relative' }}>
  <ReactFlow ...>
    <Background gap={24} color="var(--color-canvas-dots)" />
  </ReactFlow>
  <AzSimOverlay azId={azId} />
</div>
```

to:

```tsx
<div style={{ width: '100%', height: '100%', position: 'relative' }}>
  <ReactFlow ...>
    <Background gap={24} color="var(--color-canvas-dots)" />
  </ReactFlow>
  <AzSimOverlay azId={azId} />
  <InspectorV2 azId={azId} />
</div>
```

- [ ] **Step 6: Switch `GlobeView.tsx` and `RegionView.tsx` to `scrubBatch ?? latestBatch`**

In both files, change:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

to:

```ts
const latestBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
```

(No other changes needed — both files already read `latestBatch` by that name from Task 13; this
swaps what the selector returns without touching the render logic below it. `RegionView.tsx`'s
Task 14 outage-toggle code stays reading `running`/`healthOverrides`/`setOutage` directly from
the store, unaffected by this swap.)

- [ ] **Step 7: Verify build**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green

- [ ] **Step 8: Live Playwright smoke**

1. Start the dev server in the background: `npm run dev`. Wait for the ready URL.
2. `browser_navigate` → `http://localhost:1420`. Author the same small two-server AZ world as
   Task 14's smoke (region → AZ → 2 servers → `api`/`pg` blueprints with a dependency → 2
   placements), and navigate into the AZ.
3. `browser_click` "Simulate". While running, go to RegionView (breadcrumb: click the region
   segment) and `browser_click` "⚡ Simulate region outage".
4. `browser_wait_for` ~10 seconds (accumulates ≥1 replay frame at the outage and several
   afterward — replay snapshots at 1Hz per contracts).
5. `browser_click` "Stop". `browser_snapshot` → confirm a bottom "Replay" scrubber bar is now
   present with colored ticks (it wasn't visible while running).
6. `browser_click` on an early (left-ish) tick in the scrubber strip — pick one that should
   correspond to the outage window. `browser_snapshot`/`browser_take_screenshot` → confirm at
   least one tick renders red/amber (worst-AZ healthScore dip) and that the label next to the
   strip shows a simulated-time value, not "live" — save as `task15-scrubbed-outage.png`.
7. Navigate back into the AZ (breadcrumb) → confirm the server nodes' health border reflects the
   scrubbed frame (not necessarily "live" state) and `InspectorV2`'s traced-request list is
   present in the bottom-left corner. `browser_click` one of its rows → confirm it expands into a
   hop table with `hopClass`/latency/outcome columns. `browser_take_screenshot` → save as
   `task15-trace-expanded.png`.
8. `browser_click` "Exit scrub" → confirm the scrubber label reads "live" again.
9. `browser_console_messages` → assert zero errors across the whole sequence.
10. Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add src/app/store/simulation.store.ts src/app/world/ScrubberV2.tsx \
        src/app/world/InspectorV2.tsx src/app/world/WorldShell.tsx \
        src/app/world/AzCanvas.tsx src/app/world/GlobeView.tsx src/app/world/RegionView.tsx
git commit -m "feat(engine): add replay scrubber v2 and traced-request inspector v2"
```

---

### Task 16: Cost model v2 + Cost tab [sonnet]

**Files:**
- Create: `src/lib/costModelV2.ts`
- Create: `src/lib/costModelV2.test.ts`
- Create: `src/app/world/CostTab.tsx`
- Create: `src/app/world/CostTab.test.tsx`
- Modify: `src/app/world/panels/WorldPanel.tsx` (add a `Cost` tab)

**Interfaces:**
- Consumes: `WorldDoc`, `WorldMetrics` (from `worldEngine/types`), `getServiceSpec`/
  `egressMonthlyCost` from `cloudRegistry.ts`.
- Produces: `computeWorldCost(doc: WorldDoc, world: WorldMetrics | null): { monthlyUsd,
  byRegion, byAz, egress }` exactly per the skeleton's signature; `<CostTab />`.

- [ ] **Step 1: Write the failing `costModelV2` test**

```ts
// src/lib/costModelV2.test.ts
import { describe, it, expect } from 'vitest'
import { computeWorldCost } from './costModelV2'
import { createWorld, createRegion, createAz, createServer } from './world/factories'
import { getPreset } from './world/instanceCatalog'
import type { WorldDoc } from './world/types'

function twoServerWorld(): { doc: WorldDoc; regionId: string; azId: string } {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  const s1 = createServer(az.id, getPreset('vps-medium')!)   // 0.036 usd/hr
  const s2 = createServer(az.id, getPreset('dedicated-8')!)  // 0.34 usd/hr
  doc.servers[s1.id] = s1
  doc.servers[s2.id] = s2
  return { doc, regionId: region.id, azId: az.id }
}

describe('computeWorldCost', () => {
  it('sums server hourly costs exactly (× 730 hr/mo), same total in byRegion and byAz', () => {
    const { doc, regionId, azId } = twoServerWorld()
    const result = computeWorldCost(doc, null)
    const expected = (0.036 + 0.34) * 730
    expect(result.monthlyUsd).toBeCloseTo(expected, 5)
    expect(result.byRegion).toEqual([{ regionId, monthlyUsd: expect.closeTo(expected, 5) }])
    expect(result.byAz).toEqual([{ azId, monthlyUsd: expect.closeTo(expected, 5) }])
  })

  it('null world metrics → egress is all zero', () => {
    const { doc } = twoServerWorld()
    const result = computeWorldCost(doc, null)
    expect(result.egress).toEqual({ crossAzUsd: 0, crossRegionUsd: 0, internetUsd: 0 })
  })

  it('resolves managed-service pricing via the rds/s3/sqs alias map, ignores generic provider', () => {
    const { doc, regionId, azId } = twoServerWorld()
    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'db', nodeType: 'rds', provider: 'aws',
      scope: { kind: 'az', azId }, port: 5432,
    }
    doc.managedServices['ms-2'] = {
      id: 'ms-2', label: 'generic-thing', nodeType: 'rds', provider: 'generic',
      scope: { kind: 'region', regionId }, port: 5432,
    }
    const withMs = computeWorldCost(doc, null)
    const withoutMs = computeWorldCost({ ...doc, managedServices: {} }, null)
    // ms-1 (aws/rds → dbSql) contributes a nonzero instanceHourly cost; ms-2 (generic) contributes $0.
    expect(withMs.monthlyUsd).toBeGreaterThan(withoutMs.monthlyUsd)
    const azDelta = withMs.byAz.find(a => a.azId === azId)!.monthlyUsd - withoutMs.byAz.find(a => a.azId === azId)!.monthlyUsd
    expect(azDelta).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: FAIL — `Cannot find module './costModelV2'`

- [ ] **Step 3: Write `costModelV2.ts`**

```ts
// src/lib/costModelV2.ts
// World-level monthly cost projection (spec decision 8): Σ server hourlyUsd×730 + managed
// service pricing (reused from cloudRegistry) + egress from live WorldMetrics byte rates.
import type { WorldDoc, RegionId, AzId } from './world/types'
import type { WorldMetrics } from './worldEngine/types'
import { getServiceSpec, egressMonthlyCost, type CloudProvider } from './cloudRegistry'

const HOURS_PER_MONTH = 730
const CROSS_AZ_USD_PER_GB = 0.01
const CROSS_REGION_USD_PER_GB = 0.02
const BYTES_PER_GB = 1024 ** 3
const SECONDS_PER_MONTH = 2_630_000   // spec decision 8's documented ~30.4-day constant

// PlacementPanel.tsx's managed-service picker (Phase 1) stores a handful of short,
// human-friendly nodeType strings ('rds', 's3', 'sqs') that predate — and don't match —
// CLOUD_REGISTRY's actual keys ('dbSql', 'objectStorage', 'queue'). This alias table bridges
// the two so managed-service pricing actually resolves instead of silently pricing at $0. If
// PlacementPanel's MANAGED_TYPES ever changes to use canonical NodeTypes directly, every entry
// below becomes an identity no-op.
const MANAGED_TYPE_ALIASES: Record<string, string> = {
  rds: 'dbSql', s3: 'objectStorage', sqs: 'queue',
  redis: 'redis', cdn: 'cdn', apiGateway: 'apiGateway', lambda: 'lambda',
}

export interface WorldCostResult {
  monthlyUsd: number
  byRegion: { regionId: RegionId; monthlyUsd: number }[]
  byAz: { azId: AzId; monthlyUsd: number }[]
  egress: { crossAzUsd: number; crossRegionUsd: number; internetUsd: number }
}

function managedServiceMonthlyUsd(nodeType: string, provider: CloudProvider): number {
  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[nodeType] ?? nodeType, provider)
  if (!spec) return 0   // 'generic' provider or unmapped nodeType — documented Phase-2 $0
  let usd = 0
  for (const c of spec.pricing) {
    if (c.kind === 'instanceHourly') usd += c.defaultRateUsdHr * c.defaultCount * HOURS_PER_MONTH
    else if (c.kind === 'fixedMonthly') usd += c.usd
    // requestsPerMillion / storageGbMonth / computeResource / egress: skipped in Phase 2 — no
    // per-service traffic volume or provisioned capacity is modeled on ManagedService yet.
  }
  return usd
}

export function computeWorldCost(doc: WorldDoc, world: WorldMetrics | null): WorldCostResult {
  const byRegionMap = new Map<RegionId, number>()
  const byAzMap = new Map<AzId, number>()
  const bump = (map: Map<string, number>, key: string, usd: number) => map.set(key, (map.get(key) ?? 0) + usd)

  for (const server of Object.values(doc.servers)) {
    const usd = server.hourlyUsd * HOURS_PER_MONTH
    bump(byAzMap, server.azId, usd)
    const az = doc.azs[server.azId]
    if (az) bump(byRegionMap, az.regionId, usd)
  }

  for (const ms of Object.values(doc.managedServices)) {
    const usd = managedServiceMonthlyUsd(ms.nodeType, ms.provider)
    if (usd === 0) continue
    if (ms.scope.kind === 'az') {
      bump(byAzMap, ms.scope.azId, usd)
      const az = doc.azs[ms.scope.azId]
      if (az) bump(byRegionMap, az.regionId, usd)
    } else {
      bump(byRegionMap, ms.scope.regionId, usd)
    }
  }

  const crossAzUsd = world ? (world.crossAzBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_AZ_USD_PER_GB : 0
  const crossRegionUsd = world ? (world.crossRegionBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_REGION_USD_PER_GB : 0
  // Internet egress bills at PROVIDER_EGRESS.aws's tiered schedule regardless of the world's
  // actual provider mix — Phase 2 doesn't yet attribute egress cost per-provider (that requires
  // tracking which provider's traffic produced which bytes, not modeled yet). Documented
  // simplification; a future phase can split this once egress is attributed per-provider.
  const internetGbMonth = world ? (world.internetEgressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB : 0
  const internetUsd = world ? egressMonthlyCost('aws', internetGbMonth) : 0

  // byRegionMap already sums every server + every managed service exactly once (each managed
  // service contributes to exactly one region, directly or via its AZ's region) — safe to use
  // directly as the compute total, no need to re-walk doc.servers/managedServices again.
  const computeTotal = [...byRegionMap.values()].reduce((a, b) => a + b, 0)
  const monthlyUsd = computeTotal + crossAzUsd + crossRegionUsd + internetUsd

  return {
    monthlyUsd,
    byRegion: [...byRegionMap.entries()].map(([regionId, monthlyUsd]) => ({ regionId, monthlyUsd })),
    byAz: [...byAzMap.entries()].map(([azId, monthlyUsd]) => ({ azId, monthlyUsd })),
    egress: { crossAzUsd, crossRegionUsd, internetUsd },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing `CostTab` test**

```tsx
// src/app/world/CostTab.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CostTab } from './CostTab'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null })
})

describe('CostTab', () => {
  it('renders exact monthly math for a server-only world', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // 0.036 usd/hr
    render(<CostTab />)
    expect(screen.getByText('$26.28 /mo')).toBeInTheDocument()   // 0.036 * 730
  })

  it('shows a zero-state before any regions exist', () => {
    render(<CostTab />)
    expect(screen.getByText('$0.00 /mo')).toBeInTheDocument()
    expect(screen.getByText('no regions yet')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: FAIL — `Cannot find module './CostTab'`

- [ ] **Step 7: Write `CostTab.tsx`**

```tsx
// src/app/world/CostTab.tsx
// WorldPanel's Cost tab: monthly total, per-region/per-AZ breakdown, egress line-items from
// live byte rates. Reads scrubBatch ?? latestBatch (Task 15) so scrubbing replays cost too.
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost } from '../../lib/costModelV2'
import { sectionLabel, row } from './panels/panelStyles'

export function CostTab() {
  const doc = useWorldStore(s => s.doc)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const cost = computeWorldCost(doc, batch?.world ?? null)

  return (
    <div>
      <div style={sectionLabel}>Monthly cost</div>
      <div style={{ font: '600 16px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 12 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo
      </div>

      <div style={sectionLabel}>By region</div>
      {cost.byRegion.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no regions yet</div>}
      {cost.byRegion.map(r => (
        <div key={r.regionId} style={row}>
          <span style={{ flex: 1 }}>{doc.regions[r.regionId]?.catalogId ?? r.regionId}</span>
          <span>${r.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>By AZ</div>
      {cost.byAz.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no AZs yet</div>}
      {cost.byAz.map(a => (
        <div key={a.azId} style={row}>
          <span style={{ flex: 1 }}>{doc.azs[a.azId]?.label ?? a.azId}</span>
          <span>${a.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>Egress {batch ? '' : '(simulate to populate)'}</div>
      <div style={row}><span style={{ flex: 1 }}>Cross-AZ</span><span>${cost.egress.crossAzUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Cross-region</span><span>${cost.egress.crossRegionUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Internet</span><span>${cost.egress.internetUsd.toFixed(2)}</span></div>
    </div>
  )
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Add the Cost tab to `WorldPanel.tsx`**

Add the import `import { CostTab } from '../CostTab'`. Change `type Tab` from
`'topology' | 'blueprints' | 'placements' | 'findings' | 'events'` to
`'topology' | 'blueprints' | 'placements' | 'findings' | 'events' | 'cost'`, append
`{ id: 'cost', label: 'Cost' }` to the `tabs` array, and add `{tab === 'cost' && <CostTab />}`
alongside the other tab bodies inside the `<fieldset>`.

- [ ] **Step 10: Verify full build**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green

- [ ] **Step 11: Commit**

```bash
git add src/lib/costModelV2.ts src/lib/costModelV2.test.ts \
        src/app/world/CostTab.tsx src/app/world/CostTab.test.tsx \
        src/app/world/panels/WorldPanel.tsx
git commit -m "feat(engine): add cost model v2 and cost tab"
```

---

### Task 17: Legacy engine + UI deletion [sonnet]

Same discipline as Phase 1 Task 9. Runs after Task 16 so nothing mounted references legacy
code. All grep/enumerate commands below were run against the actual repo (`world-rebuild`
branch, current HEAD) while authoring this fragment — the "Expected" output is the real,
verified result, not a guess.

**Files:**
- Delete: `src/app/canvas/` (entire directory — `Canvas.tsx`/`.module.css`, `edges/`, `nodes/`, `simulation/` incl. `particleEngine.ts` + `particleEngine/*.ts` + all its `*.test.ts`)
- Delete: `src/app/simulation/` (entire directory — `CostDashboard.tsx`/`.module.css`, `CostTracker.tsx`/`.module.css`, `EventLogPanel.tsx`/`.module.css`, `PacketEditor.tsx`/`.module.css`, `SimConfigPanel.tsx`/`.module.css`, `computeDefaults.test.ts`, `defaults.ts`)
- Delete: `src/app/sidebar/` (entire directory — `ContextMenu.tsx`/`.module.css`, `EdgeConfigForm.tsx`, `NodePalette.tsx`/`.module.css`, `PropertiesPanel.tsx`/`.module.css`, `Sparkline.tsx`)
- Delete: `src/app/toolbar/` (entire directory — `FileMenu.tsx`, `Toolbar.tsx`/`.module.css`)
- Delete: `src/app/dock/` (entire directory — `UtilityDock.tsx`/`.module.css`)
- Delete: `src/app/analytics/` (entire directory — `MetricGraphOverlay.tsx`/`.module.css`, `MetricsDrawer.tsx`/`.module.css`)
- Delete: `src/app/reports/` (entire directory — `ReportsPanel.tsx`/`.module.css`)
- Delete: `src/app/StatusBar.tsx`, `src/app/StatusBar.module.css`
- Delete: `src/app/hooks/useSaveDiagram.ts` (dead code — imports `useCanvasStore`/v1 `serialize`; unreferenced since Phase 1 Task 12 rewired `HomeScreen.tsx` to `fileOps.ts`, verified by grep below)
- Delete: `src/app/store/canvas.store.ts`, `src/app/store/replay.store.ts`, `src/app/store/metricsHistory.store.ts`, `src/app/store/costHistory.store.ts`
- Delete: `src/app/store/simulationLegacy.store.ts` — the verbatim build-green shim Task 12 introduced (a copy of the retired v1 `simulation.store`). Nothing outside the legacy trees deleted here imports it, and it itself imports `costModel`/`scalescript` (also deleted this task), so it MUST go with them or tsc breaks. (Step 1's grep surfaces it via those imports; it is on the list.)
- Delete: `src/lib/costModel.ts`, `src/lib/costModel.test.ts`, `src/lib/costModel.compute.test.ts`
- Delete: `src/lib/scalescript.ts`
- Delete: `src/lib/terraform/` (entire directory — `exportTerraform.ts`)
- Delete: `src/lib/vault/` (entire directory — `templates.ts`)
- Modify (trim, not delete): `src/app/store/ui.store.ts` (down to `themeMode`/`setThemeMode` only — see SKELETON CONCERN #6)
- Modify (trim, not delete): `src/lib/serializer.ts` (remove the v1 `DiagramFile` interface + `serialize`/`deserialize` functions — their only callers, `FileMenu.tsx` and `useSaveDiagram.ts`, are both deleted above)
- Modify (cleanup): `src/App.module.css` (remove the now-fully-dead `.canvasColumn` class — its only remaining reference was a comment inside `MetricsDrawer.module.css`, itself deleted above)

**Survivors (explicitly untouched):** `src/lib/theme.ts`, `src/lib/nodeConfig.ts` (types + icons,
including the packet types `PacketTemplate`/`PacketMode`/`PacketRegistry`/etc. — still actively
used by `WorldDoc`'s `BlueprintDependency.packetTemplateId` and `ScalemapFileV2.packets`),
`src/lib/cloudRegistry.ts`, `src/lib/regionConfig.ts`, `src/lib/tauri.ts`/`tauriMock.ts`,
everything under `src/lib/world/`, `src/lib/worldEngine/`, `src/app/world/`, `src/app/home/`,
`src/app/store/{world,nav,file,ui(trimmed),simulation(v2)}.store.ts`, `src/App.tsx` (already
clean — verified below, imports nothing from any deleted path).

**Interfaces:** Consumes: nothing new. Produces: a tree with zero references to any deleted
module, and a green `npm run build` + `npx vitest run`.

- [ ] **Step 1: Enumerate every reference before deleting**

Run (exactly as executed while authoring this plan):

```bash
grep -rln "app/canvas\|app/simulation\|app/sidebar\|app/toolbar\|app/dock\|app/analytics\|app/reports\|StatusBar\|store/canvas.store\|store/replay.store\|store/metricsHistory.store\|store/costHistory.store\|lib/costModel'\|lib/scalescript\|lib/terraform\|lib/vault" src/ --include='*.ts' --include='*.tsx' | grep -v -E "^src/(app/canvas|app/simulation|app/sidebar|app/toolbar|app/dock|app/analytics|app/reports)/"
```

Expected (verified real output — every hit is itself something on the deletion list above, so
none of these are "stragglers" requiring a separate fix):
```
src/lib/costModel.ts                    (imports app/simulation/defaults — both deleted together)
src/lib/costModel.compute.test.ts       (same)
src/app/hooks/useSaveDiagram.ts         (imports store/canvas.store — both deleted together)
```

Also run, to enumerate every remaining `NodeMetrics`/old-`simulation.store`-shape reference:

```bash
grep -rln "useSimulationStore\|NodeMetrics" src/ --include='*.ts' --include='*.tsx' | grep -v -E "^src/(app/canvas|app/simulation|app/sidebar|app/toolbar|app/dock|app/analytics|app/reports)/"
```

Expected: `src/lib/costModel.ts`, `src/lib/costModel.test.ts`, `src/lib/scalescript.ts` — all on
the deletion list. (`src/app/store/simulation.store.ts` and `src/app/world/*.tsx` also match
`useSimulationStore` textually, but that's the *v2* store and its legitimate consumers from
Tasks 13–16 — not a straggler.)

If either grep surfaces anything NOT already on this task's deletion list (e.g. a file introduced
between authoring this plan and executing it), treat it the same way Phase 1 Task 9 did: remove
the dead import/usage in that file — never resurrect a deleted module to satisfy it.

- [ ] **Step 2: Delete the legacy directories and files**

```bash
git rm -r src/app/canvas src/app/simulation src/app/sidebar src/app/toolbar \
          src/app/dock src/app/analytics src/app/reports \
          src/app/StatusBar.tsx src/app/StatusBar.module.css \
          src/app/hooks/useSaveDiagram.ts \
          src/app/store/canvas.store.ts src/app/store/replay.store.ts \
          src/app/store/metricsHistory.store.ts src/app/store/costHistory.store.ts \
          src/app/store/simulationLegacy.store.ts \
          src/lib/costModel.ts src/lib/costModel.test.ts src/lib/costModel.compute.test.ts \
          src/lib/scalescript.ts src/lib/terraform src/lib/vault
```

- [ ] **Step 3: Trim `ui.store.ts` to `themeMode` only**

Replace the entire file with:

```ts
// src/app/store/ui.store.ts
// Trimmed 2026-07-08 (Phase 2 Task 17): every field except themeMode was read only by legacy
// canvas/simulation/sidebar/toolbar/dock/reports UI, all deleted this task (verified by grep —
// see SKELETON CONCERN #6). If a future phase wants a "focus this node" pulse or similar, re-add
// the relevant field then rather than resurrecting the whole old surface.
import { create } from 'zustand'

interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
}

export const useUiStore = create<UiStore>((set) => ({
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
  setThemeMode: (mode) => {
    localStorage.setItem('scalemap-theme-mode', mode)
    set({ themeMode: mode })
  },
}))
```

- [ ] **Step 4: Trim `serializer.ts` to v2-only**

In `src/lib/serializer.ts`, remove the `DiagramFile` interface and the `serialize`/`deserialize`
functions (lines 5–37 of the current file) along with the now-stale comment above the v2 section
referencing "v1 exports above are retained ONLY so unmounted legacy UI keeps compiling" (replace
it with a short note that v1 support was removed in Task 17). The file's `NodeData`/`EdgeData`/
`PacketRegistry` type import from `./nodeConfig` becomes partially unused — check with
`noUnusedLocals`; if `NodeData`/`EdgeData` are no longer referenced anywhere in the trimmed file,
remove them from the import, keeping only `PacketRegistry` (still used by `ScalemapFileV2`).
`@xyflow/react`'s `Viewport`/`Node`/`Edge` type imports also become unused once `DiagramFile` is
gone — remove them too. Result: the file starts directly with the `WorldViewState`/
`ScalemapFileV2` interfaces and `serializeWorld`/`deserializeWorld`, unchanged in substance from
today.

- [ ] **Step 5: Remove dead CSS**

In `src/App.module.css`, delete the `.canvasColumn` rule (no longer referenced by any `.tsx`
after this task, and its only remaining textual mention — a comment in
`MetricsDrawer.module.css` — was deleted with `src/app/analytics/` in Step 2).

- [ ] **Step 6: Verify no references remain and the build is green**

```bash
grep -rn "useCanvasStore\|useReplayStore\|useMetricsHistoryStore\|useCostHistoryStore\|particleEngine\|NodeMetrics\|DiagramFile\|exportTerraform\|parseScaleScript\|applyScaleScript\|VAULT_TEMPLATES" src/
```
Expected: prints nothing (exit 1).

```bash
npm run build
```
Expected: succeeds. (If this fails on a straggler not caught by Step 1's greps, fix that file's
dead import per Step 1's fallback instruction, then re-run.)

```bash
npx vitest run
```
Expected: PASS — every deleted `*.test.ts` simply no longer runs (`particleEngine/*.test.ts`,
`costModel*.test.ts`, `cloudRegistry.test.ts` if it referenced deleted exports — check; it should
not, `cloudRegistry.ts` itself survives); all remaining suites green, including
`src/lib/serializer.test.ts` (already v2-only per Phase 1, unaffected by Step 4's trim) and every
Task 13–16 suite from this fragment.

- [ ] **Step 7: Live smoke — confirm the app still runs with only the world UI mounted**

1. Start the dev server in the background: `npm run dev`. Wait for the ready URL.
2. `browser_navigate` → `http://localhost:1420`. `browser_snapshot` → Home screen renders.
3. `browser_click` "New World" → WorldShell renders (breadcrumb, SimControls in the header,
   WorldPanel with all six tabs including the new Events/Cost tabs, empty ScrubberV2 correctly
   absent since there are no replay frames yet).
4. `browser_console_messages` → assert zero errors (this is the most important check here — a
   missed straggler import typically shows up as a console error or blank page, not necessarily
   a build failure, since some legacy references could be inside code paths `tsc`/`vitest` don't
   exercise but the running app does).
5. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(engine)!: delete legacy canvas/simulation UI and engine, keep world model"
```

---

### Task 18: Perf benchmark + degradation + final verify [sonnet]

**Files:**
- Create: `bench/enginePerf.bench.test.ts` (see SKELETON CONCERN #4 for the naming fix vs. the skeleton's literal `bench/enginePerf.bench.ts`)
- Modify: `tsconfig.json` (add `"bench"` to `include`, mirroring the `vitest.setup.ts` precedent from Phase 1 Task 10 — otherwise `npm run build`'s `tsc` step never type-checks this new top-level directory)
- Modify: `src/app/store/simulation.store.ts` (additive: `degraded: boolean`, set from the facade's `engine_degraded` event, reset on `start()`)
- Modify: `src/app/world/SimControls.tsx` (amber "degraded tick" chip)
- Modify: `src/app/world/SimControls.test.tsx` (one more test for the chip)
- Modify: `src/app/world/WorldShell.tsx` (dev-only debug hook — see SKELETON CONCERN #7)
- Modify: `docs/module-boundaries.md` (§J Phase-2 update + mark deleted sections)

**Interfaces:**
- Consumes: `src/lib/worldEngine/index.ts`'s exported facade. This plan assumes it exports a
  factory `createWorldEngine(): WorldEngineApi` (for isolated instances in this bench, and for
  T12's own integration test which per its spec text "export[s] a `__test_step` hook") alongside
  a standalone `__test_step(engine, stepMs)` helper that drives one fixed step directly,
  bypassing `requestAnimationFrame`. If T12 instead exports a bare module-level singleton with
  `__test_step` as a method on the returned API object, adjust the two import lines in Step 1
  below accordingly — the bench's assertions and structure are unaffected either way.
- Produces: a perf-budget regression test in the normal suite; `simulation.store.degraded`;
  `SimControls`'s degraded chip; the dev-only `window.__scalemapDebug` hook; a fully updated
  `docs/module-boundaries.md`.

- [ ] **Step 1: Write `bench/enginePerf.bench.test.ts`**

```ts
// bench/enginePerf.bench.test.ts
// Perf budget (Global Constraints / spec decision 9): ≤4ms mean step at 2,000 instances.
// This is a correctness-style assertion test using plain describe/it/expect, run under the
// normal `npx vitest run` suite so CI catches regressions — NOT vitest's separate `bench()`
// benchmarking API (see this fragment's SKELETON CONCERN #4 for why the file is named
// `*.bench.test.ts` rather than the skeleton's literal `*.bench.ts`). CI-tolerant per spec:
// only FAILS above 8ms/step (2× budget); 4–8ms warns via console.warn so a loaded CI box
// doesn't flake the build.
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../src/lib/world/factories'
import { getPreset } from '../src/lib/world/instanceCatalog'
import { compileWorld } from '../src/lib/world/compileWorld'
import { createWorldEngine, __test_step } from '../src/lib/worldEngine'
import type { WorldDoc } from '../src/lib/world/types'

const REGIONS = 6, AZS_PER_REGION = 3, SERVERS_PER_AZ = 12, INSTANCE_BUDGET = 2000

function buildSyntheticWorld(): WorldDoc {
  const doc = createWorld()
  const blueprints = Array.from({ length: 5 }, (_, i) => createBlueprint(`svc-${i}`, i))
  for (const bp of blueprints) doc.blueprints[bp.id] = bp
  // Chain each blueprint to the next so flows.ts has real fan-out work to do per hop.
  for (let i = 0; i < blueprints.length - 1; i++) {
    blueprints[i].dependencies = [{
      id: `dep-${i}`, target: { kind: 'blueprint', blueprintId: blueprints[i + 1].id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
  }

  let remaining = INSTANCE_BUDGET
  for (let r = 0; r < REGIONS && remaining > 0; r++) {
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    for (let a = 0; a < AZS_PER_REGION && remaining > 0; a++) {
      const az = createAz(region.id, `bench-${r}${String.fromCharCode(97 + a)}`)
      doc.azs[az.id] = az
      for (let s = 0; s < SERVERS_PER_AZ && remaining > 0; s++) {
        const server = createServer(az.id, getPreset('vps-medium')!)
        doc.servers[server.id] = server
        for (const bp of blueprints) {
          if (remaining <= 0) break
          const pl = createPlacement(bp.id, server.id)
          doc.placements[pl.id] = pl
          remaining--
        }
      }
    }
  }
  const pop = createPopulation('bench-clients', 38.9, -77.5)
  pop.peakRps = 50_000
  doc.populations[pop.id] = pop
  return doc
}

describe('engine perf budget', () => {
  it('averages ≤4ms/step over 100 steps at ~2,000 instances (fails only above 8ms; 4–8ms warns)', () => {
    const doc = buildSyntheticWorld()
    const compiled = compileWorld(doc)
    const instanceCount = Object.keys(compiled.instances).length
    expect(instanceCount).toBeGreaterThan(1800)   // sanity: fixture actually hits the target scale
    expect(instanceCount).toBeLessThanOrEqual(2000)

    const engine = createWorldEngine()
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })

    const durationsMs: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      __test_step(engine, 100)
      durationsMs.push(performance.now() - t0)
    }
    engine.stop()

    const mean = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length
    if (mean > 4 && mean <= 8) {
      console.warn(`[enginePerf] mean step ${mean.toFixed(2)}ms exceeds the 4ms budget (still under the 8ms CI-fail line) at ${instanceCount} instances`)
    }
    expect(mean).toBeLessThanOrEqual(8)
  }, 30_000)
})
```

- [ ] **Step 2: Include `bench/` in `tsconfig.json`**

Change:

```json
"include": ["src", "vitest.setup.ts"],
```

to:

```json
"include": ["src", "vitest.setup.ts", "bench"],
```

- [ ] **Step 3: Run the bench test**

Run: `npx vitest run bench/enginePerf.bench.test.ts`
Expected: PASS (1 test). If it prints the `[enginePerf]` warning, that's an accepted "over
budget but under the CI-fail line" result, not a failure — investigate the regression before the
next release but don't block this task on it.

- [ ] **Step 4: Wire the `degraded` store flag**

In `src/app/store/simulation.store.ts` (already extended once in Task 15), add to the interface:

```ts
degraded: boolean
```

Add to initial state:

```ts
degraded: false,
```

In the store's `onEvent` callback (the one T12 wires into `EngineCallbacks.onEvent`, which
already pushes into the `events` ring per the contracts), fold in the flag:

```ts
onEvent: (event) => {
  set(state => ({
    events: [...state.events, event].slice(-500),
    degraded: state.degraded || event.kind === 'engine_degraded',
  }))
  // ...whatever else this callback already does (e.g. onHealthChange plumbing) is unchanged
},
```

In the `start()` action, add `degraded: false` to its reset `set(...)` call (alongside the
`scrubIndex: null, scrubBatch: null` reset Task 15 added), so every fresh run starts un-degraded.

- [ ] **Step 5: Add the degraded chip to `SimControls.tsx`**

Add to the destructured store reads:

```ts
const degraded = useSimulationStore(s => s.degraded)
```

Add this constant near the other style constants:

```ts
const degradedChip: CSSProperties = {
  padding: '2px 6px', borderRadius: 3, font: '10px var(--font-mono)',
  color: 'var(--color-warning)', border: '1px solid var(--color-warning)',
}
```

Add, as the last child of the returned `<div>`:

```tsx
{degraded && (
  <span style={degradedChip} title="Sustained step-cost overrun — the engine halved its tick rate to keep up (see Events)">
    degraded tick
  </span>
)}
```

- [ ] **Step 6: Extend `SimControls.test.tsx`**

Add one test to the existing `describe('SimControls', ...)` block:

```tsx
it('shows the degraded chip when the store flag is set', () => {
  useSimulationStore.setState({ running: true, degraded: true })
  render(<SimControls />)
  expect(screen.getByText('degraded tick')).toBeInTheDocument()
})
```

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 7: Add the dev-only debug hook to `WorldShell.tsx`**

Add the import:

```ts
import { useWorldStore } from '../store/world.store'
```

(if not already imported by that exact name — Task 14 onward may already import it; check
before duplicating.) Add a one-time effect inside `WorldShell()`:

```ts
useEffect(() => {
  if (!import.meta.env.DEV) return
  // Dev/test-only: lets a scripted Playwright smoke seed a real, cross-region-eligible
  // ClientPopulation via the *already-built* world.store action (no population-authoring UI
  // exists in Phase 2 by design — see this fragment's SKELETON CONCERN #7) and call setOutage
  // directly as a fallback if a UI control is awkward to click reliably. Never present in a
  // production build (import.meta.env.DEV is false under `vite build`/`tauri build`).
  ;(window as unknown as { __scalemapDebug: unknown }).__scalemapDebug = { useWorldStore, useSimulationStore }
}, [])
```

- [ ] **Step 8: Verify build + full suite**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green, including `bench/enginePerf.bench.test.ts` and the
updated `SimControls.test.tsx` (5 tests)

- [ ] **Step 9: Update `docs/module-boundaries.md`**

The current file has sections `### A` through `### J` (§J already covers Phase 1's world model).
Apply these edits:

**9a. Mark fully-deleted sections.** Replace the ENTIRE body of `### A. Canvas graph editing`
(everything from its `| File | Role |` table through its "Blast radius" paragraph, i.e. from
just after the section heading down to — but not including — `### B. Simulation engine & live
metrics`) with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `src/app/canvas/` (Canvas.tsx, edges/, nodes/,
simulation/ incl. particleEngine.ts) and `src/app/sidebar/` (PropertiesPanel/ContextMenu/
EdgeConfigForm/NodePalette/Sparkline) were removed outright — the world model
(`src/lib/world/`) plus the new engine (`src/lib/worldEngine/`, §J) replace this whole layer.
See `docs/superpowers/plans/2026-07-08-phase2-substrate-engine-design.md` Task 17.
```

Similarly replace `### B. Simulation engine & live metrics`'s entire body with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `particleEngine.ts` and every `particleEngine/*.ts`
submodule (circuitBreakers/backpressure/chaos/lbRouting/compute/circuitVisual),
`SimulationOverlay.tsx`, `useDisplayMetrics.ts`, `PlaybackScrubber.tsx`, `RequestInspector.tsx`,
`replay.store.ts`, `metricsHistory.store.ts` were removed outright — `src/lib/worldEngine/`
(§J) is their replacement, ported per spec decision 2 (log-normal latency, breaker state
machine, EMA smoothing, health hysteresis) rather than rewritten from scratch.
`simulation.store.ts` was not deleted — it was rewritten in place to the v2 shape (contracts:
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`).
```

Replace `### D. Cost modeling & cloud pricing`'s table + blast-radius paragraph (keep the
section heading) with:

```markdown
| File | Role |
|---|---|
| `src/lib/costModelV2.ts` (Phase 2 Task 16) | World-level monthly cost: Σ server hourlyUsd×730 + managed-service pricing (reused from `cloudRegistry.ts`) + egress from live `WorldMetrics` byte rates |
| `src/lib/cloudRegistry.ts` (~295 lines) | Per-provider service/pricing catalog, egress tiers, provider-aware label rewrite (`resolveProviderLabel`) — **survived Task 17 unchanged**, now consumed by `costModelV2.ts` instead of the deleted `costModel.ts` |
| `src/lib/regionConfig.ts` (58 lines) | Region metadata — survived Task 17 unchanged |
| `src/app/world/CostTab.tsx` (Phase 2 Task 16) | WorldPanel's Cost tab — replaces the deleted `CostTracker.tsx`/`CostDashboard.tsx` |

**DELETED 2026-07-08 (Phase 2 Task 17):** `src/lib/costModel.ts` (v1), `src/app/simulation/
CostTracker.tsx`, `src/app/simulation/CostDashboard.tsx`.

**Blast radius:** `costModelV2.ts` is imported only by `CostTab.tsx` today — far narrower fan-in
than the deleted v1 `costModel.ts` had (which touched `BaseNode.tsx`/`particleEngine.ts`/
`nodeConfig.ts`/`PropertiesPanel.tsx`, all also deleted).
```

Replace `### E. Packet system (Flyweight templates)`'s table + blast-radius paragraph with:

```markdown
| File | Role |
|---|---|
| `nodeConfig.ts` packet types (`PacketTemplate`, `PacketMode`, `PacketRegistry`, `BasePacketTemplate`, `HttpTemplate`/`EventTemplate`/`StreamTemplate`/`DbTemplate`) | **Survived Task 17** — still referenced by `WorldDoc`'s `BlueprintDependency.packetTemplateId` and `ScalemapFileV2.packets` (`src/lib/serializer.ts`) |

**DELETED 2026-07-08 (Phase 2 Task 17):** `src/app/simulation/PacketEditor.tsx` (the "packet
anatomy" card editor) and `canvas.store.ts`'s packet-registry CRUD slice — no packet-authoring
UI exists in Phase 2; the types remain load-bearing for the file format and blueprint
dependencies, but editing a packet template is not yet possible again (Phase 3+ can reintroduce
an editor over the world model if needed).
```

Replace `### F. Terraform export / Vault templates / ScaleScript / Serialization`'s table with:

```markdown
| File | Role | Callers |
|---|---|---|
| `src/lib/serializer.ts` (trimmed, Phase 2 Task 17) | `.scalemap` v2 JSON read/write only — the v1 `serialize`/`deserialize`/`DiagramFile` exports were removed once their only callers (`FileMenu.tsx`, `useSaveDiagram.ts`) were deleted | `file.store.ts` (indirectly via `fileOps.ts`), `tauri.ts` |

**DELETED 2026-07-08 (Phase 2 Task 17):** `src/lib/terraform/exportTerraform.ts` (HCL export),
`src/lib/vault/templates.ts` (prebuilt starter diagrams), `src/lib/scalescript.ts` (the v1 DSL +
`applyScaleScript()`). None have a Phase 2 replacement yet — Terraform/vault/ScaleScript v2 are
explicitly out of scope for this phase (spec "Out of scope").
```

Leave `### G. Rust / Tauri backend` entirely unchanged (nothing there was touched).

Replace `### H. Utility dock (Reports)`'s entire body (from just after its heading through its
final "Blast radius" line) with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `src/app/dock/UtilityDock.tsx` and
`src/app/reports/ReportsPanel.tsx` were removed outright — Phase 2 has no dock/reports
equivalent; `WorldPanel`'s tab strip (§J) is the only floating-panel-style UI that survives, and
it was never part of this dock.
```

Replace `### I. Toolbar declutter`'s entire body with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `src/app/toolbar/Toolbar.tsx` and
`src/app/toolbar/FileMenu.tsx` were removed outright. This section's 2026-07-08 "orphaned from
the app root" note (Phase 1 Task 10) is now moot — the files it described as "unmounted but
still compiling" no longer exist. `WorldShell.tsx`'s header (breadcrumb + `SimControls`, §J +
Phase 2 Task 13 + this task) is the toolbar's replacement; it has no theme toggle yet (Phase 1's
`ui.store.themeMode`/`setThemeMode` survived Task 17 — see §2 — but nothing currently calls
`setThemeMode`; a future task should add a toggle button back to `WorldShell.tsx`'s header,
flagged here rather than silently left dead).
```

**9b. Append the Phase 2 subsection to `### J. World model & navigation shell`.** After its
existing "Blast radius" paragraph (the one ending "...would fully restore the old app if ever
needed."), append:

```markdown
#### Phase 2 update (2026-07-08+): the substrate engine

Branch: `world-rebuild` (unchanged). Spec:
`docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md`; contracts (FROZEN):
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`; plan:
`docs/superpowers/plans/2026-07-08-phase2-substrate-engine.md`. The app simulates again after
this phase (spec's stated goal) — `particleEngine.ts` and everything that rendered its output
were deleted (§C's sibling notes on §A/§B/§D/§E/§F/§H/§I above) once `src/lib/worldEngine/`'s
ports of the same math (log-normal latency, circuit breakers, EMA smoothing, health hysteresis
— spec decision 2) landed and every consumer was rebuilt against the new contracts.

| File | Role |
|---|---|
| `src/lib/worldEngine/types.ts` | Contracts transcribed verbatim (Task 1) — `MetricsBatch`/`EngineEvent`/`WorldEngineApi`/`RenderScope`/`VisualParticle`/`VisualArc`/`ReplayFrame`/`TracedRequest`. FROZEN — additive-optional extension only |
| `src/lib/worldEngine/{rng,engineClock,demand,routingRuntime,hostScheduler,vpsModel,networkRuntime,breakers,flows,failover,metrics,events,replay,latency}.ts` | One headless fixed-step (100ms) engine subsystem per file (Tasks 1–11) — seeded RNG only, no `Math.random`, no `src/app/` imports |
| `src/lib/worldEngine/index.ts` | `WorldEngineApi` facade (Task 12) — the ONLY thing `simulation.store.ts` imports from `worldEngine/`; step order documented in-file (clock → demand → routing → host scheduler (prev-step flows) → vps → flows → NIC → breakers → failover/health → metrics → 1Hz batch+replay+trace → render payload) |
| `src/app/store/simulation.store.ts` | REWRITTEN (Task 12) to the v2 shape: `running`/`timeScale`/`latestBatch`/`events`/`healthOverrides`, plus `scrubIndex`/`scrubBatch` (Task 15) and `degraded` (Task 18) as sanctioned additive extensions beyond the contracts' literal "exactly" list (see the Phase 2 plan fragment's SKELETON CONCERN #2). Views never import the engine directly — only this store's control actions (`start`/`stop`/`setTimeScale`/`setOutage`/`setScrubIndex`) call the facade |
| `src/app/world/SimControls.tsx` (Task 13) | Simulate/Stop + timeScale select + running dot in `WorldShell`'s header; also renders the Task 18 "degraded tick" amber chip |
| `src/app/world/EventsTab.tsx` (Task 13) | `WorldPanel`'s Events tab — the store's `events` ring, newest-first, severity-colored |
| `src/app/world/panels/WorldPanel.tsx` | Gained a `running: boolean` prop (Task 13) — wraps every tab body in `<fieldset disabled={running}>` (the Phase 2 equivalent of the legacy `canvas.store` "simulation lock" §A used to describe, implemented via native HTML cascade instead of per-action checks) and two new tabs (Events, Task 13; Cost, Task 16) |
| `src/app/world/AzSimOverlay.tsx` (Task 14) | Absolutely-positioned `<canvas>` over `AzCanvas`'s ReactFlow viewport, drawn from `attachRenderer({level:'az'})`'s per-frame `VisualParticle[]`; refused particles burst red at their target |
| `src/app/world/WorldServerNode.tsx` | `WorldServerNodeData` gained `health?`/`cpuPct?`/`ramUsedMb?`/`ramTotalMb?` (Task 14, additive) — health-tinted border + a CPU/RAM readout line |
| `src/app/world/RegionView.tsx` | Gained a manual "Simulate region outage" toggle (Task 14, calls `setOutage('region', id, down)`) — the only manual-failure UI in Phase 2 (see the Phase 2 plan fragment's SKELETON CONCERN #7 for why this exists despite decision 11 not itemizing it) |
| `src/app/world/ScrubberV2.tsx` (Task 15) | Bottom-bar replay scrubber — visible only when stopped and replay frames exist; ticks colored by each frame's worst-AZ `healthScore` |
| `src/app/world/InspectorV2.tsx` (Task 15) | AZ-view floating panel listing `getTracedRequests({level:'az'})`, polled at 1Hz; click a row for its hop table |
| `src/lib/costModelV2.ts` (Task 16) | `computeWorldCost(doc, world)` — server + managed-service (aliased through a small `rds`→`dbSql`-style table, since `PlacementPanel.tsx`'s `MANAGED_TYPES` predates `CLOUD_REGISTRY`'s canonical keys) + egress cost |
| `src/app/world/CostTab.tsx` (Task 16) | `WorldPanel`'s Cost tab — monthly total, by-region/by-AZ rows, egress line items |
| `bench/enginePerf.bench.test.ts` (Task 18) | Perf-budget regression: ≤4ms mean step (fails >8ms, warns 4–8ms) at ~2,000 instances, run under the normal suite (not `vitest bench` — see the plan fragment's SKELETON CONCERN #4) |

**What did NOT survive Task 17** (Phase 1's "unmounted but still compiling" legacy tree — see
§A/§B/§D/§E/§F/§H/§I above, all now marked DELETED): `src/app/canvas/`, `src/app/simulation/`,
`src/app/sidebar/`, `src/app/toolbar/`, `src/app/dock/`, `src/app/analytics/`,
`src/app/reports/`, `src/app/StatusBar.tsx`, `src/app/store/{canvas,replay,metricsHistory,
costHistory}.store.ts`, `src/lib/costModel.ts`, `src/lib/scalescript.ts`,
`src/lib/terraform/`, `src/lib/vault/`. Reverting `App.tsx` alone no longer restores the old
app (Phase 1's §J note above is now stale) — the old UI is actually gone, not just unmounted.

**`ui.store.ts` is now themeMode-only** (Task 17) — every other field it used to hold
(`activeTool`, sidebar/dock/panel-open booleans, `contextMenu`, `highlightedNodeIds`, etc.) was
read exclusively by deleted files; Phase 1's §C note that `highlightedNodeIds` "survived...for
reuse by whatever panel wants that behavior next" never actually got reused and is gone too.

**Blast radius:** `worldEngine/types.ts` is imported by every engine subsystem AND by
`simulation.store.ts` AND transitively by every Task 13–16 view/panel — it is now the single
highest-fan-in file in the repo (surpassing even `nodeConfig.ts`, §2), and it's FROZEN by
contract: extend additively, never reshape. `simulation.store.ts` is the sole bridge between
`worldEngine/` and every `app/world/` consumer — the same "never import the engine directly"
rule Phase 1 applied to `compileWorld`'s output now applies one layer up.
```

**9c. Update §2 hub-file entries.** In `## 2. Shared "hub" files`, replace the
`src/app/store/simulation.store.ts` row's description from `NodeMetrics`/`SimEvent`/
`SloStatus`... to:

```markdown
| `src/app/store/simulation.store.ts` | v2 shape (contracts, Phase 2): `running`/`timeScale`/`latestBatch: MetricsBatch`/`events`/`healthOverrides` + `scrubIndex`/`scrubBatch` (Task 15) + `degraded` (Task 18) | every `app/world/*.tsx` view/panel that reads live metrics |
```

Remove the `src/app/canvas/simulation/particleEngine.ts` row entirely (file deleted). Update the
`src/app/store/ui.store.ts` row's description to just: `themeMode: 'dark' \| 'light'` +
`setThemeMode` — every other field this row used to describe was trimmed in Task 17 (see §J's
Phase 2 update above)`.

**9d. Update §3's ownership-split list.** Strike or annotate items 1, 3, 6 (they describe
`particleEngine.ts`, `PacketEditor.tsx`, and dock/floating-panel work — all deleted); item 4
("Cost/pricing model work → §1D") now reads "isolated unless changing `costModelV2.ts`'s
`computeWorldCost` signature."

- [ ] **Step 10: Final whole-phase verification checklist**

```bash
npm run build
npx vitest run
```
Expected: build green; full suite green, including every subsystem test from Tasks 1–12
(assumed already passing), this fragment's `SimControls.test.tsx` (5 tests), `costModelV2.test.ts`
(3 tests), `CostTab.test.tsx` (2 tests), and `bench/enginePerf.bench.test.ts` (1 test, may warn
but not fail).

Full live-smoke checklist (dev server, strict port 1420; screenshots at each starred step):

1. `npm run dev` in the background; `browser_navigate` → `http://localhost:1420`.
2. **Author:** "New World" → add region `us-east-1` + region `eu-west-1`, one AZ each, one
   server each (`vps-medium`); Blueprints: `web` (no dependencies needed); Placements: "+ Place"
   `web` onto both servers; Managed services: add one `redis` (aws) scoped to the `us-east-1`
   AZ, to exercise a nonzero managed-service cost line. ★ `browser_take_screenshot` →
   `task18-authored-world.png`.
3. **Simulate:** set timeScale to `4x`, click "Simulate". `browser_wait_for` ~5s.
   ★ `browser_take_screenshot` of GlobeView showing both regions' live rps/health →
   `task18-simulating.png`.
4. **Seed a real population + failover with TTL lag visible:** via `browser_evaluate`, call
   `window.__scalemapDebug.useWorldStore.getState().addPopulation('bench-clients', 38.9, -77.5)`
   (seeds a real, cross-region-eligible population — see SKELETON CONCERN #7 for why this can't
   be done through real UI in Phase 2). Navigate to the `us-east-1` RegionView and click "⚡
   Simulate region outage". `browser_wait_for` ~10 real seconds (≥30 simulated seconds at 4x —
   the default `dnsTtlSec: 30`). ★ Open the Events tab, `browser_take_screenshot` → confirm a
   `ttl_lag_expired` and/or `failover_started`/`failover_completed` event is present with a
   `simMs` timestamp ≥30_000ms after the outage → `task18-failover-events.png`. Confirm
   `eu-west-1`'s GlobeView rps increased relative to step 3's screenshot.
5. **Scrub:** click "Stop". ★ Drag/click the ScrubberV2 strip back to a tick at or before the
   outage; confirm the region-outage red state is visible → `task18-scrub-outage.png`.
6. **Trace:** navigate into the `us-east-1` AZ; click a row in InspectorV2's traced-request list;
   confirm the hop table expands → `task18-trace.png`.
7. **Cost tab:** click "Exit scrub"; open the Cost tab; confirm a nonzero monthly total, two
   by-region rows, one by-AZ-with-redis-attributed row, and (if the sim ran long enough to
   produce nonzero cross-region bytes) a nonzero egress line → `task18-cost.png`.
8. **Save/reload:** click "Save" (tauriMock auto-generates a filename in browser-dev mode);
   click "New" (world resets to empty); click "Open" (tauriMock's `open_file_dialog` returns the
   most-recently-saved path automatically); confirm both regions/AZs/servers/blueprints/
   placements/managed service/population reappear exactly as authored.
9. `browser_console_messages` → assert zero errors across the entire sequence above.
10. Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add bench/enginePerf.bench.test.ts tsconfig.json \
        src/app/store/simulation.store.ts src/app/world/SimControls.tsx \
        src/app/world/SimControls.test.tsx src/app/world/WorldShell.tsx \
        docs/module-boundaries.md
git commit -m "feat(engine): add perf benchmark, step-rate degradation UI, and finish Phase 2 verification"
```
