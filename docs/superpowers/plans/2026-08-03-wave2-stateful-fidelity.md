# Wave 2 — Stateful Fidelity (FEAT-004, FEAT-005, FEAT-006) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Wave 2 of `feature-spec.md` — FEAT-004 (Cache Hit Ratio & Cold-Cache Thundering Herd),
FEAT-005 (Replication Lag & RPO), FEAT-006 (Disk & IOPS as a Real Capacity Axis). All three are
independent of each other and depend only on Wave 1 (FEAT-001/002/003, already landed on `main` as of
`d557ece`) for their fault-driven demos.

**Architecture:** Each feature follows the same shape Wave 1 established: an optional, additive field
on an existing doc entity (`ServiceBlueprint`/`ManagedService`/`BlueprintDependency` for caching,
`DbConfig` for replication, `ServerSpecs` for disk) drives a new **pure** resolver module
(`worldEngine/cache.ts`, `worldEngine/replication.ts`, extensions to `hostScheduler.ts` for disk) with
no engine imports, consumed from exactly one place in the step path so enforcement and display can
never diverge. Every new per-step cost is guarded behind a `size === 0` / "nothing configured" fast
path, mirroring `s.faults.active.size === 0` in `index.ts`. FEAT-006 contributes a sixth `FaultSpec`
variant (`disk-stall`) back to FEAT-001's union — the only cross-feature coupling in this wave.

**Tech Stack:** TypeScript, Vitest (node env for `worldEngine`/`analysis`), the existing seeded `Rng`
(unused by any of these three — none of them draw randomness), Zustand stores for UI wiring.

## Global Constraints

These apply to every task below; re-stated here so no task has to repeat them.

- **Compiled-world gate**: nothing reads the raw `WorldDoc` for anything derived; extend
  `CompiledWorld` additively only, never reshape it. None of these three features need a
  `CompiledWorld` change — they are runtime-only (engine-owned overlays), same as Wave 1's faults.
- **Engine seam**: `src/app/store/simulation.store.ts` is the ONLY file allowed to call the engine
  facade. These three features add no new engine API surface (no new `setX` calls) — they are
  read-only fidelity improvements driven by doc config and existing chaos controls (`setFault`).
- **Regression floor**: every new doc field is optional; absent ⇒ today's exact behavior, asserted
  with `toBe` (not `toBeCloseTo`) against a fixed seed. This is the single most-repeated assertion in
  this plan — every task that touches the step path has a "byte-identical when absent" test.
- **Contract drift**: `src/lib/worldEngine/types.ts` is a frozen contract. Log every additive change
  (new `InstanceMetrics`/`ServerMetrics` fields, new `EngineEventKind` entries, the `disk-stall`
  `FaultSpec` variant) in `.superpowers/sdd/contract-drift.md`.
- **Two-call-site invariant / no divergence**: any new quantity computed once for enforcement
  (capacity gating in `flows.ts`/`hostScheduler.ts`) and once for display (`metrics.ts`) MUST be
  computed by calling the SAME pure function from both sites, never re-derived. Every such quantity in
  this plan gets its own `DIVERGENCE GUARD` test in `src/lib/worldEngine/index.test.ts`, mirroring the
  six existing ones (lines 1561, 1584, 1610, 1729, 2032, 2328).
- **Perf envelope**: engine runs ~2 ms/step at ~2,000 instances against `DEGRADE_THRESHOLD_MS = 4`
  (`index.ts:71`). Each feature's budget: FEAT-004 < 0.05 ms/step with caches, FEAT-005 < 0.02 ms/step,
  FEAT-006 < 0.05 ms/step; all three effectively 0 ms/step when unconfigured. Run `npm run bench`
  after each feature lands.
- **60 FPS render budget**: new visuals (hit-ratio readout, lag band, disk saturation bar) compute on
  the 1 Hz metrics batch, never per animation frame.
- **Determinism**: none of these three features draw from `rng` — they are all deterministic
  arithmetic over doc config + accumulated state. If a future variant needs randomness it must use the
  seeded `Rng`, never `Math.random()`.
- **Theme law**: every color in new UI is `var(--color-*)`. No hardcoded hexes. Verify new UI in dark
  **and** light.
- **No emojis. Ever.** Glyphs already in use: `▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →`.
- **Motion budget**: a cache warming ramp / disk saturation bar is data-driven, not decorative;
  `prefers-reduced-motion` ⇒ fully static (no pulsing).
- **Edit-lock law**: authoring `cacheConfig`/`replicationMode`/`diskIops` is disabled while running
  (`stop the simulation to edit`) — these are doc fields, authored like any other blueprint/server
  config, not chaos controls.
- **Serializer is additive**: all new fields are optional-on-load; because they live on *existing*
  entities (`ServiceBlueprint`, `ManagedService`, `BlueprintDependency`, `DbConfig`, `ServerSpecs`),
  **no new top-level `WorldDoc` collection is created**, so `serializer.ts`'s defaulting block needs NO
  new lines — reads at consumption sites use `??` fallbacks (the `provisionedIops?` convention),
  exactly like every other optional field on those interfaces already does. Confirm this in Task 0.
- **Analysis rules** go only in the `structural`/`network`/`capacity` rule files, spread into
  `ANALYSIS_RULES` (`src/lib/analysis/runAnalysis.ts`). Never duplicate `compiled.findings`.
- **Done bar, per task**: `npx tsc --noEmit` clean → `npx vitest run` green → (`npm run build` once per
  feature) → live smoke in `npm run tauri dev` with zero new console errors, both themes.
- **High-conflict hub files** — edit sequentially, never in parallel across the three features:
  `src/lib/world/types.ts`, `src/lib/worldEngine/types.ts`, `src/lib/worldEngine/index.ts`,
  `src/lib/worldEngine/flows.ts`, `src/lib/worldEngine/hostScheduler.ts`, `src/lib/worldEngine/metrics.ts`,
  `src/lib/worldEngine/failover.ts`, `src/app/world/panels/WorldPanel.tsx`,
  `src/lib/analysis/runAnalysis.ts`. Because all three features touch `index.ts`/`metrics.ts`/
  `types.ts`, **do FEAT-004 → FEAT-005 → FEAT-006 in strict sequence, not in parallel**, even though
  the spec calls them independent — "independent in design" does not mean "safe to co-edit the same
  hub file simultaneously." Each feature's tasks are self-contained and separately committable.

## Grounding notes (current repo state, verified before writing this plan)

- `src/lib/worldEngine/types.ts` (376 lines): `FaultSpec` union at lines 277-284 (five variants);
  `EngineEventKind` union at 186-209 (no Wave-2 kinds yet); `InstanceMetrics` at 26-61 (no
  `cacheHitRatio`/`staleReadFraction`/`diskWaitMs` yet); `ServerMetrics` at 63-79 (`diskIoFraction`
  already exists but is display-only, fed by nothing enforced); `MetricsBatch` at 164-182 (no
  `clusters?` map yet).
- `src/lib/worldEngine/faults.ts` (166 lines): pure, no engine imports — `FaultState`, `setFault`,
  `faultsForServer`, `stepLeaks`, `impairmentFor`, `addPartition`/`removePartition`. Generic over
  `FaultSpec`, so adding `disk-stall` to the union requires no faults.ts logic change beyond the type
  — the multiplier application happens where `cpu-brownout` is applied today (index.ts).
- `src/lib/worldEngine/hostScheduler.ts` (194 lines): `InstanceLoad` (7-26), `poolCheckoutFor` (39-54),
  `stepHost` (117-194, 5-step body: demand/pressure, water-fill `serviceRateByInstance`, per-core
  utilization, RAM loop w/ `checkoutByInstance`, `HostStepResult`). `effectiveVcpu` is computed by the
  CALLER (index.ts:1146) and passed in — this is where `disk-stall`'s multiplier composes exactly like
  `cpu-brownout` does today.
- `src/lib/worldEngine/flows.ts` (951 lines): dependency loop around line 695
  (`splitDependencyShares`), `depBytesById`/`writeFraction` resolution feeding it, structural-refusal
  branch at 712-721, error-inject fault application at 853-871 (the pattern every new impairment
  multiplier in this wave should read from, though FEAT-004/005/006 apply multiplicatively to `share`
  rather than diverting to `errorRps`).
- `src/lib/worldEngine/failover.ts` (434 lines): `promoteReplicas` (350-396) clusters by
  `${blueprintId}|${regionId}` (line 366), currently sorts candidates by `HEALTH_RANK` only — this is
  the exact spot FEAT-005 changes to prefer least-lagged.
- `src/lib/worldEngine/metrics.ts` (534 lines): `buildBatch` (223-534), labeled loops per pyramid
  level; `diskIoFraction` computed at 372-388 as `Math.min(1, diskIo/100)` — display-only today,
  FEAT-006 gives it real teeth while preserving this exact branch for servers with no ceiling
  authored.
- `src/lib/worldEngine/index.ts` (2098 lines): `runStep` (703-1618) with numbered `// ── N. ──`
  markers; host scheduling loop at 1061-1213 (faults resolved via `faultsForServer`, `effectiveVcpu`
  built at 1146, `stepHost` called, NIC-cap applied 1161-1173); OOM-restart set at 1190-1195, cleared
  at 721-728; `start()` builds frozen indexes at 1868-1918 (`serversByAz`, `azsByRegion`,
  `instancesByServer`, etc.) — every new `start()`-time index in this wave (cluster→replica index,
  cache-aside resolution index) goes here, following that exact precedent.
- `src/lib/world/types.ts` (502 lines): `ServiceBlueprint` (220-235), `ManagedService` (271-310),
  `BlueprintDependency` (182-202, no `cacheAsideVia` yet), `ServerSpecs` (84-90, no IOPS field at all),
  `DbConfig` (215-218, currently just `{ engine, storageGb }`), `WorkloadProfile` (153-176).
- `src/lib/serializer.ts` (165 lines): defaulting block at 121-158 adds new TOP-LEVEL `WorldDoc`
  collections (`racks`, `loadBalancers`, `scenario`, etc.). None of this wave's fields need an entry
  here — they live on existing entities and are read with `??` at the point of use, exactly like
  `ManagedService.provisionedIops?` already is.
- `bench/enginePerf.bench.test.ts` exists, run via `npm run bench` (excluded from default `vitest run`
  — CPU contention inflates in-suite timings). Hard budget: median step time ≤ 8 ms; soft warn above
  4 ms. ~1,948 instances / 216 servers synthetic world.
- `src/lib/worldEngine/index.test.ts` has six existing `DIVERGENCE GUARD` tests (1561, 1584, 1610,
  1729, 2032, 2328) — the pattern to copy: build a targeted world, run it, read the same quantity from
  both the scheduler side and the metrics side, assert they agree within a bounded ratio (not exact —
  EMA/rounding skew is expected), never `toBeCloseTo` on the regression-floor assertions themselves.
- `src/lib/analysis/runAnalysis.ts` spreads `structuralRules`/`networkRules`/`capacityRules`. New rules
  in this wave: `cache-miss-storm` (capacity.ts), `replication-lag-exceeds-rpo` (structural.ts),
  `iops-saturated` (capacity.ts).

---

## Task 0: Confirm serializer needs no changes + add module-boundaries placeholder rows

**Files:**
- Read: `src/lib/serializer.ts`
- Modify: `docs/module-boundaries.md`

**Interfaces:**
- Produces: nothing consumed by later tasks — this is a verification + documentation step, safe to do
  first.

- [ ] **Step 1: Confirm the additive-optional-field convention needs no serializer entry**

  Read `src/lib/serializer.ts:121-158`. Confirm that fields like `ManagedService.provisionedIops?`
  (an existing optional field on an existing entity, not a new top-level `WorldDoc` collection) appear
  nowhere in the defaulting block — they simply pass through `...src.world` untouched and are read
  with `??` at consumption sites (e.g. `costModelV2.ts`'s use of `provisionedIops`). This confirms
  Task 1/6/12/16 below (new optional fields on `ServiceBlueprint`/`ManagedService`/
  `BlueprintDependency`/`DbConfig`/`ServerSpecs`) need zero serializer changes.

- [ ] **Step 2: Add Wave 2 placeholder rows to module-boundaries.md**

  In `docs/module-boundaries.md`, near the Wave 1 additions table, add a short "Wave 2 additions"
  subsection naming the new files this plan creates before they exist:
  `src/lib/worldEngine/cache.ts` (FEAT-004, pure — hit-ratio/miss-fraction resolver, no engine
  imports), `src/lib/worldEngine/replication.ts` (FEAT-005, pure — lag/backlog/RPO resolver, no engine
  imports). Note that `hostScheduler.ts` gains disk-IOPS functions in place (FEAT-006, no new file).
  Note `src/lib/world/types.ts`, `src/lib/worldEngine/types.ts`, `src/lib/worldEngine/index.ts`,
  `src/lib/worldEngine/metrics.ts`, `src/lib/worldEngine/flows.ts`, `src/lib/worldEngine/failover.ts`
  will each receive edits from all three features and must be touched in the FEAT-004 → FEAT-005 →
  FEAT-006 sequence, never in parallel.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: add Wave 2 module-boundaries placeholders for FEAT-004/005/006"
  ```

---

# FEAT-004: Cache Hit Ratio & Cold-Cache Thundering Herd

## Task 1: `CacheConfig` type + doc fields

**Files:**
- Modify: `src/lib/world/types.ts`

**Interfaces:**
- Produces: `CacheConfig` interface, `ServiceBlueprint.cacheConfig?`, `ManagedService.cacheConfig?`,
  `BlueprintDependency.cacheAsideVia?` — consumed by Task 2 (the pure resolver) and Task 3 (engine
  wiring).

- [ ] **Step 1: Add `CacheConfig` and the three field additions**

  In `src/lib/world/types.ts`, add near `DbConfig` (currently lines 215-218):

  ```ts
  export interface CacheConfig {
    hitRatio: number       // 0..1 steady-state hit ratio
    warmupSec: number      // seconds from cold (0%) to steady-state hitRatio
    ttlSec: number         // entry lifetime; drives the ambient miss floor
  }
  ```

  Add `cacheConfig?: CacheConfig` to `ServiceBlueprint` (after `dbConfig: DbConfig | null`, line
  ~233). Add `cacheConfig?: CacheConfig` to `ManagedService` (after `promotionTier?`, end of the
  interface, ~line 309). Add `cacheAsideVia?: string` to `BlueprintDependency` (after
  `writeFraction?: number`, ~line 201) — the doc comment: `// dependency id of the sibling cache edge
  on the same blueprint; when set, this edge's share is reduced by that cache's miss fraction`.

- [ ] **Step 2: Type-check**

  Run: `npx tsc --noEmit`
  Expected: clean (all three fields are optional, no existing literal breaks).

- [ ] **Step 3: Commit**

  ```bash
  git add src/lib/world/types.ts
  git commit -m "feat(world): add CacheConfig and cacheAsideVia doc fields (FEAT-004)"
  ```

---

## Task 2: Pure cache resolver (`worldEngine/cache.ts`)

**Files:**
- Create: `src/lib/worldEngine/cache.ts`
- Test: `src/lib/worldEngine/cache.test.ts`

**Interfaces:**
- Consumes: `CacheConfig` from Task 1.
- Produces: `effectiveMissFraction(cfg: CacheConfig, warmSinceMs: number | undefined, simMs: number,
  stepSec: number): number` and `effectiveHitRatio(cfg: CacheConfig, warmSinceMs: number | undefined,
  simMs: number): number` — consumed by Task 3 (flows.ts wiring) and Task 4 (metrics publishing).
  **Both must be called from a single site type** (see Task 4) so display can never diverge from
  enforcement — this is the whole point of factoring the resolver out as pure functions here instead
  of inlining the math at each call site.

- [ ] **Step 1: Write the failing tests**

  ```ts
  // src/lib/worldEngine/cache.test.ts
  import { describe, it, expect } from 'vitest'
  import { effectiveHitRatio, effectiveMissFraction } from './cache'
  import type { CacheConfig } from '../world/types'

  const cfg: CacheConfig = { hitRatio: 0.95, warmupSec: 60, ttlSec: 300 }

  describe('effectiveHitRatio', () => {
    it('is 0 at simMs === warmSinceMs (just restarted)', () => {
      expect(effectiveHitRatio(cfg, 10_000, 10_000)).toBe(0)
    })

    it('ramps linearly to the configured hitRatio over warmupSec', () => {
      // warmSinceMs = 0, warmupSec = 60 -> full warmth at simMs = 60_000
      expect(effectiveHitRatio(cfg, 0, 30_000)).toBeCloseTo(0.475, 5) // half warm * 0.95
      expect(effectiveHitRatio(cfg, 0, 60_000)).toBeCloseTo(0.95, 5)
    })

    it('clamps at the configured hitRatio past warmupSec (never overshoots)', () => {
      expect(effectiveHitRatio(cfg, 0, 120_000)).toBeCloseTo(0.95, 5)
    })

    it('is exactly hitRatio when warmSinceMs is undefined (warm at start(), the regression floor)', () => {
      expect(effectiveHitRatio(cfg, undefined, 0)).toBeCloseTo(0.95, 5)
    })
  })

  describe('effectiveMissFraction', () => {
    it('equals 1 - effectiveHitRatio away from the TTL floor', () => {
      // hitRatio 0.5, well above the TTL floor (stepSec/ttlSec is tiny)
      const c: CacheConfig = { hitRatio: 0.5, warmupSec: 0, ttlSec: 300 }
      expect(effectiveMissFraction(c, undefined, 0, 0.1)).toBeCloseTo(0.5, 5)
    })

    it('the TTL floor holds: an aggressive hitRatio never reaches a physically-impossible zero miss', () => {
      const c: CacheConfig = { hitRatio: 0.999, warmupSec: 0, ttlSec: 10 }
      const stepSec = 0.1
      const floor = stepSec / c.ttlSec // 0.01
      expect(effectiveMissFraction(c, undefined, 0, stepSec)).toBeGreaterThanOrEqual(floor)
      expect(effectiveMissFraction(c, undefined, 0, stepSec)).toBeCloseTo(floor, 5) // floor dominates 1-0.999=0.001
    })

    it('is 1 (100% miss) at the instant of restart', () => {
      expect(effectiveMissFraction(cfg, 10_000, 10_000, 0.1)).toBeCloseTo(1, 5)
    })

    it('decays toward the steady-state miss fraction as warmth ramps', () => {
      const early = effectiveMissFraction(cfg, 0, 5_000, 0.1)
      const later = effectiveMissFraction(cfg, 0, 55_000, 0.1)
      expect(early).toBeGreaterThan(later)
      expect(later).toBeCloseTo(1 - 0.95, 2)
    })
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/cache.test.ts`
  Expected: FAIL — `./cache` module does not exist.

- [ ] **Step 3: Implement**

  ```ts
  // src/lib/worldEngine/cache.ts
  import type { CacheConfig } from '../world/types'

  function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x))
  }

  /** 0 (cold, just restarted) -> 1 (fully warm) over warmupSec. undefined warmSinceMs = already warm. */
  function warmth(cfg: CacheConfig, warmSinceMs: number | undefined, simMs: number): number {
    if (warmSinceMs === undefined) return 1
    if (cfg.warmupSec <= 0) return 1
    return clamp01((simMs - warmSinceMs) / (cfg.warmupSec * 1000))
  }

  export function effectiveHitRatio(
    cfg: CacheConfig,
    warmSinceMs: number | undefined,
    simMs: number,
  ): number {
    return cfg.hitRatio * warmth(cfg, warmSinceMs, simMs)
  }

  export function effectiveMissFraction(
    cfg: CacheConfig,
    warmSinceMs: number | undefined,
    simMs: number,
    stepSec: number,
  ): number {
    const hit = effectiveHitRatio(cfg, warmSinceMs, simMs)
    const ttlFloor = cfg.ttlSec > 0 ? stepSec / cfg.ttlSec : 0
    return Math.max(1 - hit, ttlFloor)
  }
  ```

- [ ] **Step 4: Run to verify it passes**

  Run: `npx vitest run src/lib/worldEngine/cache.test.ts`
  Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/worldEngine/cache.ts src/lib/worldEngine/cache.test.ts
  git commit -m "feat(engine): pure cache hit-ratio/miss-fraction resolver (FEAT-004)"
  ```

---

## Task 3: Wire cache multiplier into `flows.ts` + `warmSinceMs` overlay in `index.ts`

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Modify: `src/lib/worldEngine/flows.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `effectiveMissFraction`/`effectiveHitRatio` from Task 2.
- Produces: `EngineState.warmSinceMs: Map<string, number>` (keyed by cache instance id, or
  `managed:${managedServiceId}` for a managed cache target), a `hasAnyCache: boolean` `start()`-time
  flag, and a `FlowInput.cacheMissByInstance?: Record<InstanceId, number>` /
  `FlowInput.cacheAsideMissByDep?: Record<DependencyId, number>` (whichever shape matches the actual
  `FlowInput` object literal you find at the `solveFlows(...)` call site — read `flows.ts`'s current
  `FlowInput` interface before choosing the field name; do not guess a shape that doesn't match its
  neighbors). Consumed by Task 4 (metrics publishing) and Task 8 (analysis rule).

- [ ] **Step 1: Write the failing regression-floor test**

  Add to `src/lib/worldEngine/index.test.ts` (near the other regression-floor tests — search the file
  for an existing `'byte-identical'` or `'no fault'` test and place this alongside it for consistency
  of pattern):

  ```ts
  it('REGRESSION FLOOR: a world with no cacheConfig produces byte-identical output to pre-FEAT-004 for a fixed seed', () => {
    // Build the SAME world twice via the existing test-world factory used by this file's other
    // regression-floor tests (do not invent a new builder — reuse whichever `run(w)` / world-factory
    // helper this file already uses, e.g. the one FEAT-001's own regression floor test at the top of
    // this file uses). Neither blueprint nor any dependency sets cacheConfig/cacheAsideVia.
    const w = /* existing minimal api->db world factory from this file, unmodified */ null as any
    const a = run(w)
    const b = run(w)
    expect(a.latest()).toEqual(b.latest())
    // and specifically: no instance should ever carry a defined cacheHitRatio when no blueprint
    // configures caching (Task 4 adds this field; assert it stays undefined here)
    for (const im of Object.values(a.latest().instances)) {
      expect((im as any).cacheHitRatio).toBeUndefined()
    }
    a.engine.stop()
    b.engine.stop()
  })
  ```

  Note: replace the `null as any` placeholder with this test file's ACTUAL existing minimal
  two-service world builder — inspect the top of `index.test.ts` for the helper it already uses
  (the six DIVERGENCE GUARD tests all call some `run(w)` against a world built by a local factory or
  `connWorld`-style helper; reuse that exact function, do not write a parallel one).

- [ ] **Step 2: Write the failing economics-invert test (the feature's core claim)**

  ```ts
  it('CACHE ECONOMICS: api -> cache -> db at hitRatio 0.9 sends ~10% of cache traffic to db', () => {
    // Build a three-tier world: api (no cache) -> cache (kind: 'cache', cacheConfig: {hitRatio: 0.9,
    // warmupSec: 0, ttlSec: 300}) -> db. warmupSec: 0 means fully warm immediately (no ramp to wait
    // out in this test). Drive a fixed rps of client demand at the api tier.
    const w = buildCacheProxyWorld({ hitRatio: 0.9, warmupSec: 0, ttlSec: 300 }) // see Step 3 note
    const st = run(w)
    // advance enough steps for steady state
    for (let i = 0; i < 50; i++) st.engine.__test_step(1)
    const b = st.latest()
    const cacheRps = b.instances[w.cacheInstanceId].rps
    const dbRps = b.instances[w.dbInstanceId].rps
    expect(dbRps / cacheRps).toBeGreaterThan(0.08)
    expect(dbRps / cacheRps).toBeLessThan(0.12)
    st.engine.stop()
  })

  it('THUNDERING HERD: restarting a warm cache spikes downstream db to ~1/(1-hitRatio) then decays', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.95, warmupSec: 60, ttlSec: 300 })
    const st = run(w)
    for (let i = 0; i < 60; i++) st.engine.__test_step(1) // reach steady state, ~95% hit
    const steadyDbRps = st.latest().instances[w.dbInstanceId].rps
    st.engine.setFault('server', w.cacheServerId, { kind: 'down' })
    st.engine.__test_step(1)
    st.engine.setFault('server', w.cacheServerId, null) // clear -> restart, warmSinceMs resets
    st.engine.__test_step(1)
    const justAfterRestartDbRps = st.latest().instances[w.dbInstanceId].rps
    expect(justAfterRestartDbRps / steadyDbRps).toBeGreaterThan(10) // "20x" per spec, tolerant floor
    for (let i = 0; i < 60; i++) st.engine.__test_step(1) // ride out warmupSec
    const recoveredDbRps = st.latest().instances[w.dbInstanceId].rps
    expect(recoveredDbRps / steadyDbRps).toBeLessThan(1.3) // decayed back near steady state
    st.engine.stop()
  })
  ```

  Note: `buildCacheProxyWorld(cfg)` is a small local test-world factory you write in this same test
  file (or a shared `__fixtures__` helper if `index.test.ts` already imports one for other multi-tier
  tests) returning `{ ...world doc fields, cacheInstanceId, dbInstanceId, cacheServerId }` — three
  blueprints (api/cache/db) each on their own server/AZ/region, api depends on cache, cache depends on
  db (the "cache instance itself has dependencies" proxy shape from the spec), cache blueprint carries
  `cacheConfig: cfg`. Follow whichever world-construction convention (`factories.ts` helpers vs. a
  hand-built literal `WorldDoc`) the surrounding tests in this file already use.

- [ ] **Step 3: Run to verify both new tests fail**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "CACHE"`
  Expected: FAIL — `cacheConfig` has no effect yet, ratios come out at 100% (no reduction).

- [ ] **Step 4: Add the `warmSinceMs` overlay and `hasAnyCache` flag to `index.ts`**

  Near the `FaultState`/`oomRestartAt` declarations inside `EngineState` (search for
  `oomRestartAt: Map<InstanceId, number>`), add:

  ```ts
  warmSinceMs: Map<string, number>   // cache instance id, or `managed:${id}` for a managed cache
  hasAnyCache: boolean               // start()-time fast-path flag
  ```

  In `start()` (the block building `serversByAz`/`azsByRegion`/etc., ~lines 1868-1918), compute
  `hasAnyCache` once:

  ```ts
  const hasAnyCache = Object.values(doc.blueprints).some(bp => bp.cacheConfig != null)
    || Object.values(doc.managedServices).some(ms => ms.cacheConfig != null)
  ```

  Initialize `warmSinceMs: new Map()` (empty — every cache is warm at `start()`, the regression floor,
  per Task 2's `warmSinceMs === undefined ⇒ effectiveHitRatio === cfg.hitRatio` behavior).

  In the OOM-restart handler (where `s.oomRestartAt.set(host.oomVictim, simMs + OOM_RESTART_MS)` is
  set, ~line 1191) and wherever a `down` fault is cleared (`doSetFault`'s null-spec branch, ~line
  625-648), if the restarting/cleared instance's blueprint has a `cacheConfig`, set
  `s.warmSinceMs.set(instanceId, simMs)`. For a managed cache, `ManagedService` has no restart concept
  today — skip managed warm-reset wiring in this task (managed caches start warm and stay warm; this
  is consistent with `ManagedService` being a black-box terminal node per `CLAUDE.md`'s parked-scope
  note, and is a smaller, honest scope cut worth stating explicitly in the PR description).

- [ ] **Step 5: Wire the proxy-shape multiplier in `flows.ts`**

  In the dependency loop (around line 695, where `shares = splitDependencyShares(...)` is computed),
  before `addDownstream` is called with the computed `share`, check whether the CALLING instance's
  blueprint carries a `cacheConfig`:

  ```ts
  const callerBp = doc.blueprints[compiled.instances[fromId]?.blueprintId ?? '']
  if (callerBp?.cacheConfig) {
    const missFraction = input.cacheMissFractionByInstance?.[fromId] ?? 1
    share = share * missFraction
  }
  ```

  `input.cacheMissFractionByInstance` is a NEW `FlowInput` field you add, of type
  `Record<InstanceId, number> | undefined`, built in `index.ts` right before `solveFlows` is called
  (same section that builds `roleOf`/`extraLatencyMsByServer`): for every instance whose blueprint has
  `cacheConfig`, compute `effectiveMissFraction(bp.cacheConfig, s.warmSinceMs.get(instanceId), simMs,
  stepSec)` and put it in the record — guarded by `if (s.hasAnyCache)`, else pass `undefined` and skip
  the whole loop (the 0-ms-when-unconfigured path).

  Read `flows.ts`'s actual current dependency-loop variable names (`fromId`/`share`/`shares` may not
  match exactly — confirm against the real code at the loop around line 695 before editing) and adapt
  the snippet to the real local variable names rather than copy-pasting blind.

- [ ] **Step 6: Wire the cache-aside multiplier**

  In the same loop, when `dep.cacheAsideVia` is set on the dependency being walked: resolve the
  sibling dependency via `callerBp.dependencies.find(d => d.id === dep.cacheAsideVia)`, resolve ITS
  target's `cacheConfig` (service blueprint's `cacheConfig`, or — for a managed target — the
  `ManagedService.cacheConfig`), and apply the same `share = share * missFraction` using a warm-key of
  either the resolved cache instance id (service target) or `managed:${managedServiceId}` (managed
  target) looked up in `s.warmSinceMs`. Build the sibling-dependency resolution as a `start()`-time
  index (`Map<DependencyId, { cacheConfig: CacheConfig; warmKey: string }>`) rather than doing a
  `.find()` per row per step — follow the existing "build once at `start()`, read every step" pattern
  `index.ts` already uses for `downstreamAdj`/`crossRegionOrphanReplicaIds`.

- [ ] **Step 7: Run the tests again**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "CACHE"`
  Expected: PASS — the economics-invert and thundering-herd tests both go green.

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "REGRESSION FLOOR"`
  Expected: PASS.

- [ ] **Step 8: Full suite + type-check**

  Run: `npx tsc --noEmit`
  Expected: clean.
  Run: `npx vitest run`
  Expected: all green, no regressions elsewhere.

- [ ] **Step 9: Commit**

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/flows.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): wire cache hit-ratio into flow solver, both topologies (FEAT-004)"
  ```

---

## Task 4: Publish `cacheHitRatio` on `InstanceMetrics` + divergence guard

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/metrics.ts`
- Test: `src/lib/worldEngine/index.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Consumes: `effectiveHitRatio` from Task 2, `warmSinceMs` map from Task 3.
- Produces: `InstanceMetrics.cacheHitRatio?: number` — consumed by Task 7 (UI) and Task 8 (analysis
  rule).

- [ ] **Step 1: Write the failing divergence guard test**

  ```ts
  it('DIVERGENCE GUARD: published cacheHitRatio equals the value the flow solver applied this step', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.8, warmupSec: 20, ttlSec: 300 })
    const st = run(w)
    for (let i = 0; i < 5; i++) st.engine.__test_step(1) // mid-warmup, not yet steady
    const b = st.latest()
    const published = b.instances[w.cacheInstanceId].cacheHitRatio
    // Recompute independently via the SAME pure function Task 2 exposed, using the same warmSinceMs
    // the engine used (undefined here, since this instance never restarted -> full hitRatio expected
    // once warmupSec has elapsed from start(), or partial before that if warmSinceMs was seeded at 0
    // by convention -- assert against whatever Task 3 actually decided warmSinceMs is at start() for
    // a freshly-started cache: either "absent" (fully warm) or "= 0" (ramps from t=0). Pin down the
    // real behavior from Task 3's Step 4 and assert THAT value here, not an assumed one.)
    expect(published).toBeCloseTo(0.8, 5) // if the convention is "warm at start()" per the spec's floor
    st.engine.stop()
  })
  ```

  Reconcile this test with Task 3's actual `start()` behavior (the spec is explicit: *"Instances are
  warm at `start()`... Cold start applies to instances that come back or come new"* — same convention
  reused here for cache warmth) before finalizing the assertion.

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "cacheHitRatio"`
  Expected: FAIL — field does not exist / is undefined.

- [ ] **Step 3: Add the field to the frozen contract**

  In `src/lib/worldEngine/types.ts`, add to `InstanceMetrics` (after `checkoutWaitMs?: number`, line
  ~59):

  ```ts
  cacheHitRatio?: number   // only present for instances whose blueprint carries a CacheConfig
  ```

- [ ] **Step 4: Publish it in `metrics.ts` from the SAME call the solver used**

  In `buildBatch`'s instances loop (~289 onward), when building each `InstanceMetrics`, if the
  instance's blueprint has `cacheConfig`, compute
  `cacheHitRatio: effectiveHitRatio(bp.cacheConfig, state.warmSinceMs.get(inst.id), simMs)` — this
  MUST read from `state.warmSinceMs` (the same map `index.ts` populated and passed through, exactly
  how `state.lastHost[...]` is threaded to `checkoutWaitMs` today) and call the same
  `effectiveHitRatio` from `cache.ts`, never a re-derived inline formula. Confirm `metrics.ts`
  receives `warmSinceMs` as part of whatever state object `buildBatch` already takes (thread it
  through the function's parameter list if it isn't already reachable there, following the same
  pattern the existing `roleOf` optional trailing param uses per `module-boundaries.md`'s note on
  Wave 1's `metrics.ts` change).

- [ ] **Step 5: Log in contract-drift.md**

  Append an entry to `.superpowers/sdd/contract-drift.md`:

  ```markdown
  ## FEAT-004: Cache Hit Ratio (Wave 2)
  - Additive: `InstanceMetrics.cacheHitRatio?: number` — published only for cache-configured
    instances, computed by `cache.ts`'s `effectiveHitRatio`, same call the flow solver used via
    `state.warmSinceMs`. No signature break.
  ```

- [ ] **Step 6: Run the divergence guard and full suite**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts`
  Expected: PASS, including the new divergence guard.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

- [ ] **Step 7: Commit**

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): publish InstanceMetrics.cacheHitRatio, divergence-guarded (FEAT-004)"
  ```

---

## Task 5: `cache_cold`/`cache_warm` events

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `warmSinceMs` map from Task 3.
- Produces: two new `EngineEventKind` variants, emitted once per warm/cold transition (not every
  step) — consumed by the Events tab (no code change needed there; it already renders unknown-but-
  typed event kinds generically, confirm this before assuming a UI change is needed).

- [ ] **Step 1: Write the failing test**

  ```ts
  it('emits cache_cold on restart and cache_warm once warmupSec has elapsed', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.9, warmupSec: 10, ttlSec: 300 })
    const st = run(w)
    for (let i = 0; i < 5; i++) st.engine.__test_step(1)
    st.engine.setFault('server', w.cacheServerId, { kind: 'down' })
    st.engine.__test_step(1)
    st.engine.setFault('server', w.cacheServerId, null)
    st.engine.__test_step(1)
    const coldEvents = st.eventsSoFar().filter((e: any) => e.kind === 'cache_cold')
    expect(coldEvents.length).toBe(1)
    for (let i = 0; i < 12; i++) st.engine.__test_step(1) // past warmupSec=10s
    const warmEvents = st.eventsSoFar().filter((e: any) => e.kind === 'cache_warm')
    expect(warmEvents.length).toBe(1)
    st.engine.stop()
  })
  ```

  Adapt `st.eventsSoFar()` to whatever accessor `index.test.ts` already uses to inspect emitted
  events (the file's Wave-1 fault tests already assert on `fault_injected`/`fault_cleared` — copy that
  exact accessor pattern).

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "cache_cold"`
  Expected: FAIL — event kinds don't exist yet.

- [ ] **Step 3: Add the event kinds**

  In `src/lib/worldEngine/types.ts`, append to `EngineEventKind` (after `'scenario_step_applied'`):

  ```ts
  | 'cache_cold' | 'cache_warm'
  ```

- [ ] **Step 4: Emit them in `index.ts`**

  Where `s.warmSinceMs.set(instanceId, simMs)` is written (Task 3 Step 4's restart/fault-clear sites),
  emit a `cache_cold` event. Track a per-instance "already emitted warm for this warm-cycle" guard (a
  `Set<InstanceId>` alongside `warmSinceMs`, cleared when a new cold cycle starts) so `cache_warm`
  fires exactly once when `effectiveHitRatio` first reaches `cfg.hitRatio` (i.e. `simMs - warmSinceMs
  >= cfg.warmupSec * 1000`), checked in the same per-step loop that already reads `warmSinceMs` for
  the `FlowInput` build in Task 3 Step 5 — do not add a second loop over instances just for this.

- [ ] **Step 5: Run to verify it passes**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "cache_cold"`
  Expected: PASS.

- [ ] **Step 6: Log in contract-drift.md, full suite, commit**

  Append the two new `EngineEventKind` entries to `.superpowers/sdd/contract-drift.md` under the
  FEAT-004 heading from Task 4.

  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): emit cache_cold/cache_warm events (FEAT-004)"
  ```

---

## Task 6: `cache-miss-storm` analysis rule

**Files:**
- Modify: `src/lib/analysis/rules/capacity.ts`
- Test: `src/lib/analysis/rules/capacity.test.ts` (or wherever this file's sibling tests live — check
  for an existing `capacity.test.ts`/`capacity.rules.test.ts` before creating a new one)

**Interfaces:**
- Consumes: `InstanceMetrics.cacheHitRatio` from Task 4.
- Produces: a rule object appended to `capacityRules`, already spread into `ANALYSIS_RULES` by
  `runAnalysis.ts` — no registry change needed.

- [ ] **Step 1: Write the failing test**

  ```ts
  it('cache-miss-storm fires when a cache is <50% of its configured hit ratio and its downstream is >80% capacity', () => {
    // Construct a minimal { doc, compiled, lastBatch } fixture (reuse this test file's existing
    // fixture-building convention -- e.g. analysis/__fixtures__/worlds.ts) where:
    //  - a 'cache' blueprint carries cacheConfig.hitRatio = 0.9
    //  - lastBatch reports that instance's cacheHitRatio = 0.3 (well under half of 0.9)
    //  - the downstream db instance's metrics show >80% CPU/capacity utilization
    const ctx = buildCacheMissStormFixture({ configuredHitRatio: 0.9, observedHitRatio: 0.3, downstreamUtilization: 0.85 })
    const findings = cacheMissStorm.run(ctx)
    expect(findings.length).toBe(1)
    expect(findings[0].severity).toBe('warning')
  })

  it('does not fire when the cache is warm', () => {
    const ctx = buildCacheMissStormFixture({ configuredHitRatio: 0.9, observedHitRatio: 0.88, downstreamUtilization: 0.85 })
    expect(cacheMissStorm.run(ctx).length).toBe(0)
  })
  ```

  Write `buildCacheMissStormFixture` following whatever fixture-builder convention
  `analysis/rules/capacity.test.ts`'s neighboring tests already use (check `faultInjected`'s own test,
  since it's the closest existing precedent per the grounding notes).

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/analysis/rules/capacity.test.ts -t "cache-miss-storm"`
  Expected: FAIL — rule doesn't exist.

- [ ] **Step 3: Implement the rule**

  In `src/lib/analysis/rules/capacity.ts`, add (mirroring `faultInjected`'s shape, lines 182-194):

  ```ts
  export const cacheMissStorm: AnalysisRule = {
    id: 'cache-miss-storm',
    family: 'capacity',
    run: ({ doc, compiled, lastBatch }) => {
      if (!lastBatch) return []
      const findings: AnalysisFinding[] = []
      for (const inst of Object.values(compiled.instances)) {
        const bp = doc.blueprints[inst.blueprintId]
        if (!bp?.cacheConfig) continue
        const observed = lastBatch.instances[inst.id]?.cacheHitRatio
        if (observed == null || observed >= bp.cacheConfig.hitRatio * 0.5) continue
        // find this cache instance's downstream dependency utilization -- reuse whichever
        // downstream-lookup helper flows.ts/metrics.ts already exposes for "is X above 80% capacity"
        // (do not re-derive a capacity fraction here; read the same value the capacity rules already
        // use elsewhere in this file, e.g. ramOversubscribed's utilization source).
        const downstreamOverloaded = /* existing capacity-check helper, see ramOversubscribed for the pattern */ false
        if (!downstreamOverloaded) continue
        findings.push({
          id: `cache-miss-storm:${inst.id}`,
          rule: 'cache-miss-storm',
          severity: 'warning',
          message: `${bp.name} is ${Math.round(observed * 100)}% warm (target ${Math.round(bp.cacheConfig.hitRatio * 100)}%); its downstream dependency is absorbing the excess load`,
          affectedEntities: [{ kind: 'server', id: inst.serverId }],
        })
      }
      return findings
    },
  }
  ```

  Adjust the `AnalysisFinding` shape and `affectedEntities` construction to match this file's actual
  current type — read `faultInjected`'s real implementation before finalizing field names.

  Add `cacheMissStorm` to the `capacityRules` array export.

- [ ] **Step 4: Run to verify it passes, full suite, commit**

  Run: `npx vitest run src/lib/analysis/rules/capacity.test.ts`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/analysis/rules/capacity.ts src/lib/analysis/rules/capacity.test.ts
  git commit -m "feat(analysis): add cache-miss-storm rule (FEAT-004)"
  ```

---

## Task 7: Author `cacheConfig`/`cacheAsideVia` in UI + live hit-ratio readout

**Files:**
- Modify: `src/app/world/panels/BlueprintModal.tsx`
- Modify: the managed-service editor (locate via Grep for where `provisionedIops` is authored, since
  `cacheConfig` on `ManagedService` follows the identical gating-by-`nodeType` pattern)
- Modify: the Connections graph's `EdgeInspector` (locate via Grep for `packetMix`/`writeFraction`
  authoring, since `cacheAsideVia` is authored the same way — a dropdown listing sibling deps)
- Modify: `src/app/world/server/` service-chip component (wherever the chip renders per-instance
  metrics today, e.g. alongside CPU/latency chips)
- Modify: `src/app/world/az/DatacenterFloor.tsx` (floor node equivalent readout)

**Interfaces:**
- Consumes: `CacheConfig` (Task 1), `InstanceMetrics.cacheHitRatio` (Task 4).
- Produces: nothing consumed by later tasks — this is the terminal UI task for FEAT-004.

- [ ] **Step 1: Add `cacheConfig` fields to `BlueprintModal.tsx`, shown only when `kind === 'cache'`**

  Find the existing kind-conditional field rendering in `BlueprintModal.tsx` (the `db-sql`/`db-nosql`
  branch that shows `dbConfig` fields is the direct precedent — copy its conditional-render shape).
  Add three numeric inputs (hit ratio 0-1, warmup seconds, TTL seconds) visible only when
  `draft.kind === 'cache'`, writing into `draft.cacheConfig`. Follow this file's existing draft-state
  update pattern (`updateDraft` or equivalent) rather than introducing a new one.

- [ ] **Step 2: Add `cacheConfig` authoring to the managed-service editor, gated on redis/memcached `nodeType`**

  Locate the managed-service editor via `Grep` for `provisionedIops` (its existing gp3-shaped IOPS
  field is the closest precedent for "a field meaningful only for certain `nodeType`s"). Add the same
  three fields, gated on the node type being a cache type (check `ManagedService.nodeType`'s actual
  enum values before assuming `'redis'`/`'memcached'` literal strings — grep `cloudRegistry.ts` for
  the authoritative list).

- [ ] **Step 3: Add `cacheAsideVia` as a dropdown in `EdgeInspector`**

  Locate `EdgeInspector` via Grep in the Connections graph directory. Add a dropdown listing sibling
  dependencies of the same blueprint whose target resolves to a cache (service with `cacheConfig` or
  managed service with `cacheConfig`), writing the selected dependency's `id` into the edited
  dependency's `cacheAsideVia`. Only render this control for `db`-protocol dependencies (the shape the
  cache-aside pattern targets per the spec).

- [ ] **Step 4: Live hit-ratio readout on the service chip and floor node**

  In the server board's service chip component, when `instanceMetrics.cacheHitRatio != null`, render
  a small readout (e.g. `⌬ 87%`) using `var(--color-*)` tokens, with a distinct visual treatment while
  warming (e.g. a lower-opacity or amber-tinted state) vs. steady-state — driven off the 1 Hz batch
  the chip already reads, no new per-frame subscription. Mirror this on the equivalent floor node in
  `az/DatacenterFloor.tsx`.

- [ ] **Step 5: Live smoke test**

  Run `npm run tauri dev`. Build an `api -> cache -> db` topology, author `cacheConfig` on the cache
  blueprint, run the sim, confirm the hit-ratio readout appears and climbs from the restart value.
  Kill the cache server, confirm the db's CPU/latency chips spike and the cache's readout resets to
  warming, then climbs back. Verify in both dark and light themes. Confirm zero new console errors.

- [ ] **Step 6: Full suite, build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`
  Expected: all green.

  ```bash
  git add -A
  git commit -m "feat(ui): author cacheConfig/cacheAsideVia, live hit-ratio readout (FEAT-004)"
  ```

---

## Task 8: FEAT-004 bench + wave-close checks

**Files:**
- Read: `bench/enginePerf.bench.test.ts`
- Modify: `docs/module-boundaries.md`

- [ ] **Step 1: Run the perf bench**

  Run: `npm run bench`
  Expected: median step time unchanged (no caches in the synthetic bench world) — confirms the
  `hasAnyCache` fast path costs 0 ms. If the bench world DOES include cache blueprints, expected < 0.05
  ms/step delta per the spec's budget; if it regresses beyond the 4 ms soft-warn band, profile the
  cache-aside sibling-dependency resolution (Task 3 Step 6) — that is the only O(deps) per-step cost
  this feature adds, and it must be `start()`-time-indexed, not recomputed per row per step.

- [ ] **Step 2: Update module-boundaries.md with the real FEAT-004 file list**

  Replace Task 0's placeholder row for `cache.ts` with a real one-paragraph description (mirroring the
  Wave 1 table's style): file, purpose, "pure, no engine imports", its two call sites
  (`flows.ts`'s dependency loop, `metrics.ts`'s instance loop), and the fields it introduced
  (`CacheConfig`, `cacheConfig?`, `cacheAsideVia?`, `InstanceMetrics.cacheHitRatio?`).

- [ ] **Step 3: Commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: document FEAT-004 cache module in module-boundaries.md"
  ```

---

# FEAT-005: Replication Lag & RPO

## Task 9: `DbConfig` field additions

**Files:**
- Modify: `src/lib/world/types.ts`

**Interfaces:**
- Produces: four new optional `DbConfig` fields — consumed by Task 10 (pure resolver) and Task 11
  (engine wiring).

- [ ] **Step 1: Extend `DbConfig`**

  In `src/lib/world/types.ts`, extend `DbConfig` (currently lines 215-218, just
  `{ engine: DbEngine; storageGb: number }`):

  ```ts
  export interface DbConfig {
    engine: DbEngine
    storageGb: number
    replicationMode?: 'async' | 'semi-sync'   // absent -> 'async'
    applyRatePerReplica?: number              // writes/sec a replica can apply; absent -> derived
    rpoTargetSec?: number                     // authored objective; drives the analysis rule
    hotKeyCount?: number                      // stale-read model denominator; absent -> 1000
  }
  ```

- [ ] **Step 2: Type-check and commit**

  Run: `npx tsc --noEmit`

  ```bash
  git add src/lib/world/types.ts
  git commit -m "feat(world): extend DbConfig with replication lag/RPO fields (FEAT-005)"
  ```

---

## Task 10: Pure replication resolver (`worldEngine/replication.ts`)

**Files:**
- Create: `src/lib/worldEngine/replication.ts`
- Test: `src/lib/worldEngine/replication.test.ts`

**Interfaces:**
- Consumes: `interRegionLatencyMs` from `src/lib/regionConfig.ts` (the PURE, deterministic variant —
  NOT the deleted `sampleInterRegionLatencyMs`; confirm the Housekeeping deletion from Wave 1 already
  landed before importing).
- Produces: `ReplicationState`, `createReplicationState()`, `stepReplication(state, clusters,
  writeRpsByCluster, stepSec): void` (mutates state in place, mirroring `stepLeaks`'s signature shape
  from `faults.ts`), `localityFloorSec(primaryLocality, replicaLocality, primaryRegionId,
  replicaRegionId): number`, `staleReadFraction(writeRps, lagSec, hotKeyCount): number`. Consumed by
  Task 11 (engine wiring) and Task 13 (`failover.ts` selection change).

- [ ] **Step 1: Write the failing tests**

  ```ts
  // src/lib/worldEngine/replication.test.ts
  import { describe, it, expect } from 'vitest'
  import {
    createReplicationState, stepReplication, localityFloorSec, staleReadFraction,
  } from './replication'

  describe('localityFloorSec', () => {
    it('is 5ms same-AZ, 20ms cross-AZ, and interRegionLatencyMs/1000 cross-region', () => {
      expect(localityFloorSec('same-az')).toBeCloseTo(0.005, 5)
      expect(localityFloorSec('cross-az')).toBeCloseTo(0.02, 5)
      // cross-region uses the real interRegionLatencyMs(from, to) -- assert against that function
      // directly so the two never diverge, not against a hardcoded number:
      const { interRegionLatencyMs } = require('../regionConfig') as typeof import('../regionConfig')
      expect(localityFloorSec('cross-region', 'us-east', 'eu-west'))
        .toBeCloseTo(interRegionLatencyMs('us-east', 'eu-west') / 1000, 5)
    })
  })

  describe('stepReplication', () => {
    it('backlog grows monotonically when writeRps exceeds applyCapacity', () => {
      const state = createReplicationState()
      const clusterId = 'blueprint-a|region-1'
      const replica = { id: 'inst-r1', locality: 'cross-az' as const, applyCapacity: 100 }
      stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 200 }, 1)
      const lag1 = state.lagSecByInstance.get('inst-r1')!
      stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 200 }, 1)
      const lag2 = state.lagSecByInstance.get('inst-r1')!
      expect(lag2).toBeGreaterThan(lag1)
    })

    it('drains back toward the locality floor when write load drops below apply capacity', () => {
      const state = createReplicationState()
      const clusterId = 'blueprint-a|region-1'
      const replica = { id: 'inst-r1', locality: 'same-az' as const, applyCapacity: 100 }
      for (let i = 0; i < 10; i++) stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 200 }, 1)
      const grown = state.lagSecByInstance.get('inst-r1')!
      for (let i = 0; i < 50; i++) stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 0 }, 1)
      const drained = state.lagSecByInstance.get('inst-r1')!
      expect(drained).toBeLessThan(grown)
      expect(drained).toBeCloseTo(0.005, 2) // back near the same-AZ floor
    })

    it('at zero write load, lag equals exactly the locality floor', () => {
      const state = createReplicationState()
      const clusterId = 'c'
      const replica = { id: 'r1', locality: 'cross-az' as const, applyCapacity: 100 }
      stepReplication(state, { [clusterId]: [replica] }, { [clusterId]: 0 }, 1)
      expect(state.lagSecByInstance.get('r1')).toBeCloseTo(0.02, 5)
    })
  })

  describe('staleReadFraction', () => {
    it('matches the Poisson collision formula to the digit', () => {
      // 100 writes/sec, 2s lag, 1000 hot keys -> ~18%
      const f = staleReadFraction(100, 2, 1000)
      expect(f).toBeCloseTo(1 - Math.exp(-(100 * 2) / 1000), 10)
      expect(f).toBeCloseTo(0.1813, 3)
    })

    it('is 0 at zero lag', () => {
      expect(staleReadFraction(100, 0, 1000)).toBe(0)
    })
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/replication.test.ts`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

  ```ts
  // src/lib/worldEngine/replication.ts
  import { interRegionLatencyMs } from '../regionConfig'

  export type ReplicaLocality = 'same-az' | 'cross-az' | 'cross-region'

  const SAME_AZ_FLOOR_SEC = 0.005
  const CROSS_AZ_FLOOR_SEC = 0.02
  const WRITE_APPLY_EFFICIENCY = 0.7
  const EPSILON = 1e-6

  export function localityFloorSec(
    locality: ReplicaLocality,
    fromRegionId?: string,
    toRegionId?: string,
  ): number {
    if (locality === 'same-az') return SAME_AZ_FLOOR_SEC
    if (locality === 'cross-az') return CROSS_AZ_FLOOR_SEC
    if (!fromRegionId || !toRegionId) return CROSS_AZ_FLOOR_SEC
    return interRegionLatencyMs(fromRegionId, toRegionId) / 1000
  }

  export interface ReplicaRef {
    id: string
    locality: ReplicaLocality
    applyCapacity: number   // writes/sec this replica can apply
    fromRegionId?: string
    toRegionId?: string
  }

  export interface ReplicationState {
    backlogWritesByInstance: Map<string, number>
    lagSecByInstance: Map<string, number>
  }

  export function createReplicationState(): ReplicationState {
    return { backlogWritesByInstance: new Map(), lagSecByInstance: new Map() }
  }

  export function stepReplication(
    state: ReplicationState,
    replicasByCluster: Record<string, ReplicaRef[]>,
    writeRpsByCluster: Record<string, number>,
    stepSec: number,
  ): void {
    for (const [clusterId, replicas] of Object.entries(replicasByCluster)) {
      const writeRps = writeRpsByCluster[clusterId] ?? 0
      for (const replica of replicas) {
        const prevBacklog = state.backlogWritesByInstance.get(replica.id) ?? 0
        const delta = (writeRps - replica.applyCapacity) * stepSec
        const nextBacklog = Math.max(0, prevBacklog + delta)
        state.backlogWritesByInstance.set(replica.id, nextBacklog)
        const floor = localityFloorSec(replica.locality, replica.fromRegionId, replica.toRegionId)
        const lagSec = nextBacklog / Math.max(replica.applyCapacity, EPSILON) + floor
        state.lagSecByInstance.set(replica.id, lagSec)
      }
    }
  }

  export function staleReadFraction(writeRps: number, lagSec: number, hotKeyCount: number): number {
    if (lagSec <= 0 || writeRps <= 0) return 0
    return 1 - Math.exp(-(writeRps * lagSec) / Math.max(hotKeyCount, 1))
  }

  export const WRITE_APPLY_EFFICIENCY_CONST = WRITE_APPLY_EFFICIENCY
  ```

  Note: `WRITE_APPLY_EFFICIENCY` is exported so Task 11 can derive `applyCapacity` from a replica's
  `serviceRateByInstance` when `DbConfig.applyRatePerReplica` is absent, per the spec's formula
  `applyCapacity = applyRatePerReplica ?? (replica's serviceRateByInstance × writeApplyEfficiency)` —
  that derivation itself happens in `index.ts` (Task 11), not here, since it needs the live
  `serviceRateByInstance` from `HostStepResult`, which this pure module has no access to.

- [ ] **Step 4: Run to verify it passes**

  Run: `npx vitest run src/lib/worldEngine/replication.test.ts`
  Expected: PASS, all tests.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/worldEngine/replication.ts src/lib/worldEngine/replication.test.ts
  git commit -m "feat(engine): pure replication lag/backlog/RPO resolver (FEAT-005)"
  ```

---

## Task 11: Wire replication lag into `index.ts` + stale reads into `flows.ts`

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Modify: `src/lib/worldEngine/flows.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `stepReplication`/`ReplicaRef`/`staleReadFraction` from Task 10.
- Produces: `EngineState.replication: ReplicationState`, a `start()`-time
  `replicasByCluster: Record<string, ReplicaRef[]>` index (cluster key `${blueprintId}|${regionId}`,
  matching `failover.ts`'s existing convention exactly), a `FlowInput.staleReadFractionByReplica?`
  (or equivalent field — confirm real `FlowInput` shape before naming) consumed by Task 12's metrics
  publishing.

- [ ] **Step 1: Write the failing regression-floor test**

  ```ts
  it('REGRESSION FLOOR: a world with no replicas is byte-identical for a fixed seed', () => {
    const w = /* existing minimal single-instance-per-blueprint world from this file */ null as any
    const a = run(w); const b = run(w)
    expect(a.latest()).toEqual(b.latest())
    a.engine.stop(); b.engine.stop()
  })

  it('LOCALITY FLOOR: at zero write load, same-AZ replica shows ~5ms lag, cross-region shows interRegionLatencyMs/1000', () => {
    const w = buildReplicaWorld({ primaryRegion: 'us-east', replicaRegion: 'eu-west', writeLoad: 0 })
    const st = run(w)
    for (let i = 0; i < 5; i++) st.engine.__test_step(1)
    // lag needs to be surfaced -- via MetricsBatch.clusters? per Task 12, or directly inspectable via
    // a test-only engine accessor; use whichever this task's own Step 4 decides to expose.
    const clusterLag = st.latest().clusters?.[w.clusterId]?.lagSec
    const { interRegionLatencyMs } = require('../regionConfig')
    expect(clusterLag).toBeCloseTo(interRegionLatencyMs('us-east', 'eu-west') / 1000, 2)
    st.engine.stop()
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "LOCALITY FLOOR"`
  Expected: FAIL.

- [ ] **Step 3: Build the `start()`-time cluster→replica index**

  In `start()`, alongside the other frozen indexes, build:

  ```ts
  const replicasByCluster: Record<string, ReplicaRef[]> = {}
  for (const inst of Object.values(compiled.instances)) {
    const bp = doc.blueprints[inst.blueprintId]
    if (bp?.kind !== 'db-sql' && bp?.kind !== 'db-nosql') continue
    if (inst.role !== 'replica') continue   // primaries don't apply lag to themselves
    const clusterId = `${inst.blueprintId}|${inst.regionId}`
    const primary = /* the compiled primary instance for this same cluster -- reuse whatever lookup
      failover.ts's promoteReplicas already performs to find "the primary for this cluster" (search
      for how it resolves primary/replica pairs at compile time before writing a new lookup) */
    const locality = /* same-az | cross-az | cross-region, derived by comparing inst.azId/regionId
      to primary's azId/regionId -- same three-way branch localityFloorSec expects */
    ;(replicasByCluster[clusterId] ??= []).push({
      id: inst.id,
      locality,
      applyCapacity: bp.dbConfig?.applyRatePerReplica ?? 0, // 0 here; real value derived per-step below
      fromRegionId: primary?.regionId,
      toRegionId: inst.regionId,
    })
  }
  ```

  Store `replicasByCluster` on `EngineState`. Also store `s.replication = createReplicationState()`.

- [ ] **Step 4: Call `stepReplication` per step, deriving live `applyCapacity`**

  After the flow solve (so `serviceRateByInstance` for the step is known — follow the sequencing
  FEAT-005's own spec text: *"call `stepReplication` after the flow solve"*), for each replica in
  `replicasByCluster`, resolve its live `applyCapacity` as
  `dbConfig.applyRatePerReplica ?? (serviceRateByInstance[replica.id] * WRITE_APPLY_EFFICIENCY_CONST)`
  and its `writeRps` as the SAME resolved `dep.writeFraction` value the flow solver used for that
  cluster's incoming write dependency (do not re-derive — thread it out of the flow-solve result, the
  same way `depBytesById`/`writeFraction` already flow through `packetResolve`). Call
  `stepReplication(s.replication, replicasByCluster, writeRpsByCluster, stepSec)`.

  Compute cluster-level lag by taking the resolved `s.replication.lagSecByInstance` value(s) for the
  cluster (if a cluster has multiple replicas, publish e.g. the max, matching "sustained lag" language
  in the acceptance criteria — confirm against Task 14's analysis rule wording before finalizing the
  aggregation choice).

- [ ] **Step 5: Apply `staleReadFraction` to replica-targeted reads in `flows.ts`**

  In the dependency loop's read-routing branch (`splitDependencyShares`'s replica pool, or wherever
  reads are attributed to a specific replica instance — read the current `isReadTarget`/replica-pool
  code before editing), for each read row landing on a replica instance, compute
  `staleReadFraction(writeRps, lagSec, dbConfig.hotKeyCount ?? 1000)` (importing from `replication.ts`)
  and attach it to the row as a NEW published attribute — **not** folded into `errorRps` (a stale read
  succeeds, per the spec). Follow whatever row-attribute mechanism `flows.ts` already uses for
  per-row metadata (e.g. however `hopClass`/`reason` are attached to a downstream row today).

- [ ] **Step 6: `semi-sync` mode**

  When `dbConfig.replicationMode === 'semi-sync'`, clamp `lagSec` to the replication RTT (use
  `localityFloorSec`'s own value as the RTT proxy — the same locality-derived latency, doubled if you
  want a round-trip rather than one-way; state the choice explicitly in a code comment since the spec
  doesn't pin the exact RTT-vs-floor relationship) and ADD that same RTT to the primary's write latency
  in the flow solver's composed-latency pass — this needs a hook into `computeTotalLatencyMs`'s
  network-ms composition (`networkMs = baseHopLatencyMs(...) + impairmentDelayMs`); add a third
  additive term, `semiSyncMs`, sourced the same way `impairmentDelayMs` already is.

- [ ] **Step 7: Run tests, fix, iterate until green**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "LOCALITY FLOOR"`
  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "REGRESSION FLOOR"`
  Expected: both PASS.

- [ ] **Step 8: Full suite, type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/flows.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): wire replication lag backlog + stale reads + semi-sync (FEAT-005)"
  ```

---

## Task 12: Publish `MetricsBatch.clusters`, `staleReadFraction`, divergence guard

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/metrics.ts`
- Test: `src/lib/worldEngine/index.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Consumes: `s.replication.lagSecByInstance` and the per-row `staleReadFraction` from Task 11.
- Produces: `MetricsBatch.clusters?: Record<string, { lagSec: number }>`,
  `InstanceMetrics.staleReadFraction?: number` — consumed by Task 15 (UI), Task 14 (analysis rule).

- [ ] **Step 1: Write the failing test**

  ```ts
  it('DIVERGENCE GUARD: published cluster lagSec equals the value stepReplication computed', () => {
    const w = buildReplicaWorld({ primaryRegion: 'us-east', replicaRegion: 'us-east', writeLoad: 500 })
    const st = run(w)
    for (let i = 0; i < 10; i++) st.engine.__test_step(1)
    const b = st.latest()
    const publishedLag = b.clusters?.[w.clusterId]?.lagSec
    const publishedStale = b.instances[w.replicaInstanceId].staleReadFraction
    expect(publishedLag).toBeGreaterThan(0.005) // above the same-AZ floor under load
    expect(publishedStale).toBeGreaterThan(0)
    expect(publishedStale).toBeLessThanOrEqual(1)
    st.engine.stop()
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "cluster lagSec"`
  Expected: FAIL.

- [ ] **Step 3: Add the fields to the frozen contract**

  In `src/lib/worldEngine/types.ts`:

  ```ts
  // on MetricsBatch, after topics?:
  clusters?: Record<string, { lagSec: number }>
  ```

  And on `InstanceMetrics` (after `cacheHitRatio?` from FEAT-004):

  ```ts
  staleReadFraction?: number
  ```

- [ ] **Step 4: Publish both in `metrics.ts`**

  In `buildBatch`'s instances loop, when the instance is a lagging replica, read
  `state.replication.lagSecByInstance.get(inst.id)` — wait, `staleReadFraction` needs `writeRps` and
  `hotKeyCount` too; publish it from the SAME per-row value Task 11 Step 5 attached to the read row in
  `flows.ts` (thread it through the flow-solve result the way `checkoutWaitMs` is threaded from
  `HostStepResult`, per this file's existing convention — never recompute
  `staleReadFraction(...)` a second time in `metrics.ts` with independently-sourced inputs, that IS
  the divergence class this repo's constraints exist to prevent).

  Add a new labeled loop (`// ── Clusters ──`, following the file's `// ── N ──` comment convention)
  building `clusters` from `state.replication.lagSecByInstance` grouped by cluster id (reuse
  `replicasByCluster`'s keys).

- [ ] **Step 5: Log in contract-drift.md, run tests, commit**

  ```markdown
  ## FEAT-005: Replication Lag & RPO (Wave 2)
  - Additive: `MetricsBatch.clusters?: Record<string, {lagSec:number}>`.
  - Additive: `InstanceMetrics.staleReadFraction?: number`.
  - Both sourced from the single `replication.ts` resolver / the flow-solve row it annotated — no
    parallel computation.
  ```

  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): publish cluster lag + staleReadFraction, divergence-guarded (FEAT-005)"
  ```

---

## Task 13: RPO at promotion — least-lagged selection + `replica_promoted` payload

**Files:**
- Modify: `src/lib/worldEngine/failover.ts`
- Modify: `src/lib/worldEngine/types.ts` (event payload)
- Test: `src/lib/worldEngine/failover.test.ts` (or wherever `promoteReplicas` is already tested — check
  before creating a new file)

**Interfaces:**
- Consumes: `s.replication.lagSecByInstance` (needs to be passed into `promoteReplicas`, a new
  parameter — this is the one intentional signature change in this feature; existing callers that
  don't care about lag can pass an empty map).
- Produces: `replica_promoted` events now carry `dataLossWindowSec`/`estimatedLostWrites` in their
  payload.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it('promoteReplicas selects the least-lagged healthy replica, not merely the first healthy one', () => {
    // Two healthy replicas in the same cluster, r1 with 0.5s lag and r2 with 3s lag (both HEALTHY,
    // so today's health-only sort is indifferent between them and would pick by id/array order).
    const lagByInstance = new Map([['inst-r1', 0.5], ['inst-r2', 3]])
    const promoted = promoteReplicas(state, compiled, doc, [primaryId], simMs, healthOf, lagByInstance)
    expect(promoted.find(p => p.primaryId === primaryId)?.replicaId).toBe('inst-r1')
  })

  it('RPO TEST: replica_promoted event carries dataLossWindowSec matching the promoted replica lag, and estimatedLostWrites = lagSec * writeRps', () => {
    const lagByInstance = new Map([['inst-r1', 2]])
    const writeRpsByReplica = new Map([['inst-r1', 150]])
    const { events } = promoteReplicasWithEvents(state, compiled, doc, [primaryId], simMs, healthOf, lagByInstance, writeRpsByReplica)
    const ev = events.find(e => e.kind === 'replica_promoted')!
    expect(ev.payload.dataLossWindowSec).toBeCloseTo(2, 5)
    expect(ev.payload.estimatedLostWrites).toBeCloseTo(300, 5)
  })
  ```

  Adapt these to `failover.ts`'s ACTUAL exported function names/signatures for the event-emitting
  wrapper around `promoteReplicas` (the grounding notes show `promoteReplicas` itself at lines
  350-396 — confirm whether it directly returns events or whether a separate emit step exists before
  finalizing `promoteReplicasWithEvents` as a placeholder name).

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/failover.test.ts -t "least-lagged"`
  Expected: FAIL (or compile error — `promoteReplicas` doesn't accept a `lagByInstance` param yet).

- [ ] **Step 3: Change the candidate sort**

  In `promoteReplicas` (350-396), add an optional trailing parameter
  `lagByInstance?: Map<InstanceId, number>` (additive, so existing callers compile unchanged with
  `undefined`). Change the candidate sort (currently `HEALTH_RANK` then id, lines 374-377) to sort by
  `HEALTH_RANK` first, then by `lagByInstance?.get(id) ?? 0` ascending, then by id as the final
  tiebreak — preserving the existing tiebreak for the case where lag data isn't available (today's
  exact behavior when the new param is omitted).

- [ ] **Step 4: Stamp the promotion event payload**

  Where `replica_promoted` is emitted (inside `promoteReplicas`, wherever it constructs the event
  object), add `dataLossWindowSec: lagByInstance?.get(chosenReplicaId) ?? 0` and
  `estimatedLostWrites: (lagByInstance?.get(chosenReplicaId) ?? 0) * (writeRpsByReplica?.get(chosenReplicaId) ?? 0)`
  to its payload (add a second optional `writeRpsByReplica?: Map<InstanceId, number>` parameter
  alongside `lagByInstance`).

- [ ] **Step 5: Wire the new parameters from `index.ts`'s call site**

  Where `promoteReplicas(...)` is called in `runStep`'s failover section, pass
  `s.replication.lagSecByInstance` and a `writeRpsByReplica` map derived the same way Task 11 Step 4
  derived `writeRpsByCluster` (per-instance rather than per-cluster this time — build it alongside the
  cluster-level map in the same pass, not as a second computation).

- [ ] **Step 6: Note this as a deliberate behavior change to a pinned code path**

  Per the spec's closing notes: *"FEAT-005's promotion-order change... alters an existing code path
  that current tests pin. Re-baseline deliberately and state in the commit which assertions moved and
  why."* Run the existing `failover.test.ts` suite BEFORE this change (`git stash`, run, note failing/
  passing baseline, `git stash pop`) if any existing test asserts a specific replica is chosen among
  multiple healthy candidates with no lag data — those tests should still pass unchanged (lag
  defaults to 0 for all candidates when `lagByInstance` is omitted, preserving the id-tiebreak), but
  confirm this explicitly rather than assuming it.

- [ ] **Step 7: Run tests, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/failover.test.ts`
  Expected: PASS, including pre-existing tests (unchanged) and the two new ones.
  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/failover.ts src/lib/worldEngine/index.ts src/lib/worldEngine/failover.test.ts
  git commit -m "feat(engine): least-lagged replica promotion + RPO event payload (FEAT-005)"
  ```

---

## Task 14: `replication_lag_high`/`stale_read_served` events + `replication-lag-exceeds-rpo` rule

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/index.ts`
- Modify: `src/lib/analysis/rules/structural.ts`
- Test: `src/lib/worldEngine/index.test.ts`, `src/lib/analysis/rules/structural.test.ts`

**Interfaces:**
- Consumes: `s.replication.lagSecByInstance`, `DbConfig.rpoTargetSec`.
- Produces: two new `EngineEventKind` entries, one new analysis rule appended to `structuralRules`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  // index.test.ts
  it('emits rate-limited replication_lag_high when sustained lag exceeds rpoTargetSec', () => {
    const w = buildReplicaWorld({ primaryRegion: 'us-east', replicaRegion: 'eu-west', writeLoad: 1000, rpoTargetSec: 1 })
    const st = run(w)
    for (let i = 0; i < 30; i++) st.engine.__test_step(1)
    const events = st.eventsSoFar().filter((e: any) => e.kind === 'replication_lag_high')
    expect(events.length).toBeGreaterThan(0)
    // rate-limited: not one per step over 30 steps
    expect(events.length).toBeLessThan(10)
    st.engine.stop()
  })
  ```

  ```ts
  // structural.test.ts
  it('replication-lag-exceeds-rpo fires above the authored target and clears below it', () => {
    const overCtx = buildLagFixture({ lagSec: 5, rpoTargetSec: 2 })
    expect(replicationLagExceedsRpo.run(overCtx).length).toBe(1)
    const underCtx = buildLagFixture({ lagSec: 1, rpoTargetSec: 2 })
    expect(replicationLagExceedsRpo.run(underCtx).length).toBe(0)
  })
  ```

- [ ] **Step 2: Run to verify both fail**

  Run: `npx vitest run -t "replication_lag_high"`
  Run: `npx vitest run -t "replication-lag-exceeds-rpo"`
  Expected: FAIL.

- [ ] **Step 3: Add event kinds**

  In `EngineEventKind`, append `| 'replication_lag_high' | 'stale_read_served'`.

- [ ] **Step 4: Emit `replication_lag_high`, rate-limited**

  In `index.ts`, mirror `REFUSED_EVENT_MIN_GAP_MS`'s existing rate-limit pattern (grep for that
  constant's usage to find the exact mechanism — a `lastEmittedAtMs: Map<key, number>` gate checked
  before pushing an event). Apply the same gate to `replication_lag_high`, checked once per cluster
  per step where `lagSec > (dbConfig.rpoTargetSec ?? Infinity)`. Emit `stale_read_served` the same way,
  gated on `staleReadFraction > 0` for a row (also rate-limited — this could fire every step
  otherwise).

- [ ] **Step 5: Implement the analysis rule**

  In `src/lib/analysis/rules/structural.ts`, add (mirroring `splitBrainRisk`'s shape as the closest
  Wave-1 precedent for a cluster-scoped structural finding):

  ```ts
  export const replicationLagExceedsRpo: AnalysisRule = {
    id: 'replication-lag-exceeds-rpo',
    family: 'structural',
    run: ({ doc, compiled, lastBatch }) => {
      if (!lastBatch?.clusters) return []
      const findings: AnalysisFinding[] = []
      for (const [clusterId, cluster] of Object.entries(lastBatch.clusters)) {
        const [blueprintId] = clusterId.split('|')
        const bp = doc.blueprints[blueprintId]
        const target = bp?.dbConfig?.rpoTargetSec
        if (target == null || cluster.lagSec <= target) continue
        findings.push({
          id: `replication-lag-exceeds-rpo:${clusterId}`,
          rule: 'replication-lag-exceeds-rpo',
          severity: 'warning',
          message: `${bp?.name ?? blueprintId} replication lag (${cluster.lagSec.toFixed(1)}s) exceeds its RPO target (${target}s)`,
          affectedEntities: [],
        })
      }
      return findings
    },
  }
  ```

  Adjust field names/`affectedEntities` construction to match this file's real current
  `AnalysisFinding`/`AnalysisRule` types (read `splitBrainRisk`'s actual implementation before
  finalizing). Add to `structuralRules`.

- [ ] **Step 6: Run tests, log contract-drift, full suite, commit**

  Run: `npx vitest run`
  Expected: green.

  Append to `.superpowers/sdd/contract-drift.md` under the FEAT-005 heading: the two new
  `EngineEventKind` entries and the `promoteReplicas` additive-optional signature extension.

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/lib/analysis/rules/structural.ts src/lib/worldEngine/index.test.ts src/lib/analysis/rules/structural.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat: replication lag events + replication-lag-exceeds-rpo rule (FEAT-005)"
  ```

---

## Task 15: Author `replicationMode`/`rpoTargetSec` in UI + timeline band + live lag readout

**Files:**
- Modify: the DB blueprint's config drawer (locate via Grep for where existing `DbConfig` fields —
  `engine`, `storageGb` — are authored today)
- Modify: `src/app/world/region/TimelineV2.tsx`
- Modify: server/floor replica chip readout (same components touched in Task 7 Step 4)

**Interfaces:**
- Consumes: `DbConfig` fields (Task 9), `replica_promoted` event payload (Task 13),
  `InstanceMetrics.staleReadFraction`/`MetricsBatch.clusters` (Task 12).

- [ ] **Step 1: Author `replicationMode`/`applyRatePerReplica`/`rpoTargetSec`/`hotKeyCount` in the DB config drawer**

  Add the four fields (a mode toggle, three numeric inputs) to whatever component currently authors
  `dbConfig.engine`/`storageGb`, following its existing layout/validation conventions.

- [ ] **Step 2: Render the data-loss window as a labelled band in `TimelineV2.tsx`**

  Find `TimelineV2.tsx`'s existing causality-swimlane band rendering (used for failover events per
  Wave 1). Add a band variant for `replica_promoted` events carrying `dataLossWindowSec > 0`, labeled
  with the seconds value and `estimatedLostWrites`, using `var(--color-warning)` or
  `var(--color-danger)` depending on severity threshold (pick one, document the choice).

- [ ] **Step 3: Live lag readout on replica chips**

  On `ServerView`'s service chip and the floor's equivalent node, when the instance is a replica with
  a resolvable cluster lag (`MetricsBatch.clusters?.[clusterId]?.lagSec`), render a small lag readout
  (e.g. `⏎ 1.2s`) using theme tokens, updated on the 1 Hz batch.

- [ ] **Step 4: Live smoke test**

  `npm run tauri dev`: build a cross-region primary+replica DB topology under sustained write load,
  author an `rpoTargetSec` below the load's natural lag, confirm the analysis tab fires
  `replication-lag-exceeds-rpo`, kill the primary, confirm the timeline shows the promotion band with
  seconds and lost-writes labels. Both themes, zero new console errors.

- [ ] **Step 5: Full suite, build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`

  ```bash
  git add -A
  git commit -m "feat(ui): author replication config, RPO timeline band, live lag readout (FEAT-005)"
  ```

---

## Task 16: FEAT-005 bench + wave-close checks

**Files:**
- Read: `bench/enginePerf.bench.test.ts`
- Modify: `docs/module-boundaries.md`

- [ ] **Step 1: Run the perf bench**

  Run: `npm run bench`
  Expected: < 0.02 ms/step delta with replicas configured; ~0 ms/step delta for the (replica-less)
  synthetic bench world.

- [ ] **Step 2: Update module-boundaries.md**

  Replace the FEAT-005 placeholder with a real description: `replication.ts`'s purpose/exports, the
  cluster-key convention it shares with `failover.ts` (`${blueprintId}|${regionId}`), and the
  `promoteReplicas` signature extension.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: document FEAT-005 replication module in module-boundaries.md"
  ```

---

# FEAT-006: Disk & IOPS as a Real Capacity Axis

## Task 17: `ServerSpecs` IOPS fields + `disk-stall` fault variant

**Files:**
- Modify: `src/lib/world/types.ts`
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/world/instanceCatalog.ts`

**Interfaces:**
- Produces: `ServerSpecs.diskIops?`, `ServerSpecs.diskType?`, and the sixth `FaultSpec` variant
  `{ kind: 'disk-stall'; iopsFraction: number }` — consumed by Task 18 (hostScheduler functions) and
  Task 19 (engine wiring).

- [ ] **Step 1: Add the two `ServerSpecs` fields**

  In `src/lib/world/types.ts`, extend `ServerSpecs` (currently lines 84-90):

  ```ts
  export interface ServerSpecs {
    vcpu: number
    threadsPerCore: number
    ramMb: number
    diskGb: number
    nicMbps: number
    diskIops?: number
    diskType?: 'hdd' | 'ssd' | 'nvme'
  }
  ```

- [ ] **Step 2: Add `disk-stall` to `FaultSpec`**

  In `src/lib/worldEngine/types.ts`, extend the union (currently lines 277-284):

  ```ts
  export type FaultKind = 'down' | 'latency-add' | 'cpu-brownout' | 'memory-leak' | 'error-inject' | 'disk-stall'

  export type FaultSpec =
    | { kind: 'down' }
    | { kind: 'latency-add'; ms: number }
    | { kind: 'cpu-brownout'; capacityFraction: number }
    | { kind: 'memory-leak'; mbPerMinute: number }
    | { kind: 'error-inject'; errorFraction: number }
    | { kind: 'disk-stall'; iopsFraction: number }
  ```

- [ ] **Step 3: Add `diskType` to server presets**

  In `src/lib/world/instanceCatalog.ts`, add a sensible `diskType` to each existing server preset (a
  DB-oriented preset should default to `'ssd'` or `'nvme'`; a generic compute preset can default to
  `'ssd'` or omit it — check the file's actual preset list before deciding per-preset defaults, and
  match the intent "new servers get a sensible ceiling without authoring").

- [ ] **Step 4: Type-check, log contract-drift, commit**

  Run: `npx tsc --noEmit`
  Expected: clean.

  Append to `.superpowers/sdd/contract-drift.md`:

  ```markdown
  ## FEAT-006: Disk & IOPS (Wave 2)
  - Additive: `FaultSpec` gains `{ kind: 'disk-stall'; iopsFraction: number }` (sixth variant, no
    signature break — the union widens, `setFault`'s existing signature is unchanged).
  ```

  ```bash
  git add src/lib/world/types.ts src/lib/worldEngine/types.ts src/lib/world/instanceCatalog.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(world): ServerSpecs diskIops/diskType fields + disk-stall fault variant (FEAT-006)"
  ```

---

## Task 18: `diskIoDemandFor`/`diskWaitFor` in `hostScheduler.ts`

**Files:**
- Modify: `src/lib/worldEngine/hostScheduler.ts`
- Test: `src/lib/worldEngine/hostScheduler.test.ts` (check for an existing file at this path before
  creating a new one — `poolCheckoutFor` almost certainly already has tests here)

**Interfaces:**
- Consumes: `InstanceLoad[]`, `ServiceBlueprint`/`WorkloadProfile.diskIoPerRequest` (existing field),
  `ServerSpecs.diskIops`/`diskType`.
- Produces: `diskIoDemandFor(loads: InstanceLoad[], blueprintByInstance: Map<InstanceId, BlueprintId>,
  doc: WorldDoc): number` and `diskWaitFor(demandIops: number, diskIops: number | undefined,
  diskType: 'hdd'|'ssd'|'nvme'|undefined): number | null` — consumed by Task 19.

- [ ] **Step 1: Write the failing tests**

  ```ts
  describe('diskWaitFor', () => {
    it('returns null when neither diskIops nor diskType is resolvable (unbounded, the regression floor)', () => {
      expect(diskWaitFor(500, undefined, undefined)).toBeNull()
    })

    it('returns 0 when demand is at or below the ceiling', () => {
      expect(diskWaitFor(100, 200, 'ssd')).toBe(0)
      expect(diskWaitFor(200, 200, 'ssd')).toBe(0)
    })

    it('matches BASE_DISK_MS / (1 - overshoot) above saturation, to the digit, sharing poolCheckoutFor\'s curve shape', () => {
      // ssd BASE_DISK_MS = 0.5; demand 300 vs ceiling 200 -> rho = 1.5, overshoot = 0.5
      const wait = diskWaitFor(300, 200, 'ssd')
      expect(wait).toBeCloseTo(0.5 / (1 - 0.5), 10) // = 1.0
    })

    it('derives BASE_DISK_MS from diskType when diskIops is absent but diskType is present', () => {
      // e.g. diskType 'hdd' alone implies a 150 IOPS default ceiling per the spec's table
      expect(diskWaitFor(300, undefined, 'hdd')).not.toBeNull()
    })
  })

  describe('diskIoDemandFor', () => {
    it('sums rps * diskIoPerRequest across resident instances, matching the existing metrics.ts shape', () => {
      const loads = [{ instanceId: 'i1', admittedRps: 10 } as InstanceLoad, { instanceId: 'i2', admittedRps: 5 } as InstanceLoad]
      const blueprintByInstance = new Map([['i1', 'bp-db'], ['i2', 'bp-api']])
      const doc = { blueprints: { 'bp-db': { workload: { diskIoPerRequest: 4 } }, 'bp-api': { workload: { diskIoPerRequest: 0 } } } } as any
      expect(diskIoDemandFor(loads, blueprintByInstance, doc)).toBe(40) // 10*4 + 5*0
    })
  })
  ```

- [ ] **Step 2: Run to verify failure**

  Run: `npx vitest run src/lib/worldEngine/hostScheduler.test.ts -t "diskWaitFor"`
  Expected: FAIL — functions don't exist.

- [ ] **Step 3: Implement, next to `poolCheckoutFor`**

  ```ts
  // near poolCheckoutFor (hostScheduler.ts:39)
  const BASE_DISK_MS: Record<'hdd' | 'ssd' | 'nvme', number> = { hdd: 8, ssd: 0.5, nvme: 0.1 }
  const DEFAULT_DISK_IOPS: Record<'hdd' | 'ssd' | 'nvme', number> = { hdd: 150, ssd: 16_000, nvme: 100_000 }
  const MAX_SATURATION_FOR_DISK_WAIT = 0.98

  export function diskIoDemandFor(
    loads: InstanceLoad[],
    blueprintByInstance: Map<InstanceId, BlueprintId>,
    doc: WorldDoc,
  ): number {
    let sum = 0
    for (const load of loads) {
      const bp = doc.blueprints[blueprintByInstance.get(load.instanceId) ?? '']
      sum += load.admittedRps * (bp?.workload.diskIoPerRequest ?? 0)
    }
    return sum
  }

  export function diskWaitFor(
    demandIops: number,
    diskIops: number | undefined,
    diskType: 'hdd' | 'ssd' | 'nvme' | undefined,
  ): number | null {
    const resolvedCeiling = diskIops ?? (diskType ? DEFAULT_DISK_IOPS[diskType] : undefined)
    if (resolvedCeiling == null) return null
    const rho = demandIops / resolvedCeiling
    if (rho <= 1) return 0
    const baseMs = diskType ? BASE_DISK_MS[diskType] : BASE_DISK_MS.ssd
    const overshoot = Math.min(rho - 1, MAX_SATURATION_FOR_DISK_WAIT)
    return baseMs / (1 - overshoot)
  }
  ```

- [ ] **Step 4: Run to verify pass, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/hostScheduler.test.ts`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/hostScheduler.ts src/lib/worldEngine/hostScheduler.test.ts
  git commit -m "feat(engine): diskIoDemandFor/diskWaitFor sharing the base/(1-saturation) curve (FEAT-006)"
  ```

---

## Task 19: Thread `diskWaitMs` into service latency + both RAM call sites

**Files:**
- Modify: `src/lib/worldEngine/hostScheduler.ts` (`HostStepResult`)
- Modify: `src/lib/worldEngine/index.ts`
- Modify: `src/lib/worldEngine/faults.ts` usage in `index.ts` (the `disk-stall` multiplier — no
  `faults.ts` file change needed, per the grounding notes: it's generic over `FaultSpec`)
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `diskIoDemandFor`/`diskWaitFor` from Task 18.
- Produces: `HostStepResult.diskWaitMsByInstance?: Record<InstanceId, number>`, threaded into
  `extraLatencyMsByServer` alongside NIC-queue/latency-fault ms (composing additively, per the same
  "must ADD not assign" discipline FEAT-001 established for `latency-add`), and into BOTH RAM call
  sites via the connection-count path (`checkoutWaitMs`-equivalent flow) — consumed by Task 20.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it('REGRESSION FLOOR: a server with neither diskIops nor diskType is byte-identical for a fixed seed', () => {
    const w = /* existing minimal world, no diskIops/diskType authored */ null as any
    const a = run(w); const b = run(w)
    expect(a.latest()).toEqual(b.latest())
    a.engine.stop(); b.engine.stop()
  })

  it('a disk-bound DB (high diskIoPerRequest, low diskIops) fails on disk while CPU stays moderate', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 20; i++) st.engine.__test_step(1)
    const b = st.latest()
    const server = b.servers[w.dbServerId]
    expect(server.diskIoFraction).toBeGreaterThan(0.9)
    expect(Math.max(...server.coreUtilization)).toBeLessThan(0.6) // CPU stays moderate
    st.engine.stop()
  })

  it('DIVERGENCE GUARD: disk-driven activeConnections agree between scheduler and metrics', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 20; i++) st.engine.__test_step(1)
    const b = st.latest()
    const schedulerConns = /* the enforced value the scheduler used this step -- read via whatever
      test-only accessor the existing DIVERGENCE GUARD tests use for scheduler-side state */ 0
    const metricsConns = b.instances[w.dbInstanceId].activeConnections
    expect(schedulerConns / metricsConns).toBeGreaterThan(0.5)
    expect(schedulerConns / metricsConns).toBeLessThan(2)
    st.engine.stop()
  })

  it('disk-stall at iopsFraction 0.1 drives an unsaturated server into disk saturation', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 1000, diskType: 'nvme', diskIoPerRequest: 5 })
    const st = run(w)
    for (let i = 0; i < 5; i++) st.engine.__test_step(1)
    expect(st.latest().servers[w.dbServerId].diskIoFraction).toBeLessThan(0.5)
    st.engine.setFault('server', w.dbServerId, { kind: 'disk-stall', iopsFraction: 0.1 })
    for (let i = 0; i < 5; i++) st.engine.__test_step(1)
    expect(st.latest().servers[w.dbServerId].diskIoFraction).toBeGreaterThan(0.9)
    st.engine.stop()
  })
  ```

- [ ] **Step 2: Run to verify all fail**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "disk"`
  Expected: FAIL / not-yet-meaningful (diskIoFraction stays on the legacy `diskIo/100` branch).

- [ ] **Step 3: Compute demand and wait per server in the host-scheduling loop**

  In `index.ts`'s host-scheduling loop (1061-1213), after `InstanceLoad[]` is built for a server,
  compute:

  ```ts
  const demandIops = diskIoDemandFor(loadsForServer, blueprintByInstance, doc)
  const diskFault = faultsForServer(...).find(f => f.kind === 'disk-stall') // reuse the existing faultsForServer call already made for cpu-brownout/etc in this loop, do not call it twice
  const stalledIops = server.specs.diskIops != null
    ? server.specs.diskIops * (diskFault ? diskFault.iopsFraction : 1)
    : server.specs.diskIops
  const diskWaitMs = diskWaitFor(demandIops, stalledIops, server.specs.diskType)
  ```

  (`disk-stall` multiplies effective `diskIops`, the precise analogue of `cpu-brownout` multiplying
  `effectiveVcpu` — same composition discipline, multiply don't replace.)

- [ ] **Step 4: Fold `diskWaitMs` into `extraLatencyMsByServer` additively**

  At the site where `extraLatencyMsByServer[server.id] = queuedMs + faultMs` is currently written
  (Wave 1's FEAT-001 change), extend to:

  ```ts
  const total = queuedMs + faultMs + (diskWaitMs ?? 0)
  if (total > 0) extraLatencyMsByServer[server.id] = total
  ```

- [ ] **Step 5: Thread `diskWaitMs` through `HostStepResult` to both RAM call sites**

  Add `diskWaitMsByInstance?: Record<InstanceId, number>` to `HostStepResult` in
  `hostScheduler.ts`. Populate it inside `stepHost` (or from the caller in `index.ts` if `stepHost`
  doesn't have server-level `diskWaitMs` visibility — check whether `stepHost` is called per-server
  already, which the grounding notes confirm it is, so it CAN receive `diskWaitMs` as a parameter and
  broadcast the same per-server value to every resident instance's entry in the returned record).
  Feed it into the SAME `effectiveConnections`/RAM computation `poolCheckoutFor`'s `checkoutWaitMs`
  already feeds (the RAM loop at hostScheduler.ts:160-188) — disk wait extends effective service time
  exactly like checkout wait does, so it belongs in the same additive latency term feeding Little's
  law, not a separate parallel term.

- [ ] **Step 6: Run tests, iterate to green**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "disk"`
  Expected: PASS.

- [ ] **Step 7: Full suite, type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/hostScheduler.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): thread diskWaitMs into latency + both RAM call sites, disk-stall fault (FEAT-006)"
  ```

---

## Task 20: `diskIoFraction` dual behavior + `diskWaitMs`/`ManagedService.provisionedIops` wiring

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/metrics.ts`
- Modify: `src/lib/worldEngine/index.ts` (or wherever `managedDbRuntimeFor` lives — confirm file before
  editing; grounding notes reference it but did not pin its exact file)
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `diskWaitFor`/`diskIoDemandFor` (Task 18), `HostStepResult.diskWaitMsByInstance` (Task 19).
- Produces: `InstanceMetrics.diskWaitMs?: number`, `ServerMetrics.diskIoFraction`'s dual-behavior
  computation, `ManagedService.provisionedIops` becomes a real ceiling for managed DBs.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it('a server with no ceiling authored keeps diskIoFraction === diskIo/100 exactly (legacy branch preserved)', () => {
    const w = /* existing world, no diskIops/diskType */ null as any
    const st = run(w)
    for (let i = 0; i < 5; i++) st.engine.__test_step(1)
    // manually compute the legacy formula from the same inputs and assert exact equality
    const b = st.latest()
    // (assertion body depends on this file's existing world-fixture accessors for rps/diskIoPerRequest)
    expect(b.servers[w.serverId].diskIoFraction).toBeCloseTo(/* diskIo/100 recomputed by hand */ 0, 10)
    st.engine.stop()
  })

  it('a server with a resolvable ceiling publishes min(1, rho) instead of the legacy norm', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 5; i++) st.engine.__test_step(1)
    expect(st.latest().servers[w.dbServerId].diskIoFraction).toBeLessThanOrEqual(1)
  })

  it('raising provisionedIops on a managed DB raises its admitted rps ceiling', () => {
    const low = buildManagedDbWorld({ provisionedIops: 100 })
    const high = buildManagedDbWorld({ provisionedIops: 5000 })
    const stLow = run(low); const stHigh = run(high)
    for (let i = 0; i < 10; i++) { stLow.engine.__test_step(1); stHigh.engine.__test_step(1) }
    expect(stHigh.latest().managedServices![low.managedId].saturation)
      .toBeLessThan(stLow.latest().managedServices![low.managedId].saturation!)
    stLow.engine.stop(); stHigh.engine.stop()
  })
  ```

- [ ] **Step 2: Run to verify failure**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "diskIoFraction"`
  Expected: FAIL for the ceiling-aware case (legacy case may already accidentally pass — confirm which
  before writing the implementation).

- [ ] **Step 3: Add `InstanceMetrics.diskWaitMs?`**

  In `src/lib/worldEngine/types.ts`: `diskWaitMs?: number` on `InstanceMetrics`.

- [ ] **Step 4: Implement the dual-behavior `diskIoFraction`**

  In `metrics.ts`'s server loop (the existing `diskIoFraction: Math.min(1, diskIo / 100)` line),
  branch:

  ```ts
  const ceilingResolvable = server.specs.diskIops != null || server.specs.diskType != null
  const diskIoFraction = ceilingResolvable
    ? Math.min(1, /* the SAME demandIops/effective-ceiling ratio Task 19 Step 3 computed for this
        server this step -- read it from wherever HostStepResult/state threaded it through, do not
        recompute independently */ 0)
    : Math.min(1, diskIo / 100)   // legacy branch, byte-identical to pre-feature
  ```

  Publish `InstanceMetrics.diskWaitMs` from the same `HostStepResult.diskWaitMsByInstance` Task 19
  populated (single source, no re-derivation).

- [ ] **Step 5: Route `ManagedService.provisionedIops` into the managed-DB runtime's saturation math**

  Locate `managedDbRuntimeFor` (grep for it — the grounding notes confirm it exists and shares the
  `base/(1-saturation)` curve but did not pin its file; likely `hostScheduler.ts` or a dedicated
  `managedDb.ts`). Add an IOPS ceiling input alongside its existing capacity/connection ceiling
  inputs, sourced from `ManagedService.provisionedIops`, composed into the SAME saturation formula it
  already uses (do not add a second saturation curve) — when `provisionedIops` is absent, behavior is
  unchanged (today's exact path).

- [ ] **Step 6: Extend the divergence guard**

  Add an assertion (in the Task 19 divergence guard test, or a new one) confirming enforced disk-driven
  `activeConnections`/RAM on the scheduler side agrees with `InstanceMetrics.activeConnections`/`ramMb`
  published — same bounded-ratio pattern as the six existing guards.

- [ ] **Step 7: Run tests, log contract-drift, full suite, commit**

  Run: `npx vitest run`
  Expected: green.

  Append to `.superpowers/sdd/contract-drift.md` under the FEAT-006 heading:
  `InstanceMetrics.diskWaitMs?: number` (additive), `ServerMetrics.diskIoFraction`'s now-dual
  computation (documented as intentional, legacy branch preserved for the regression floor).

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): dual-behavior diskIoFraction, managed provisionedIops ceiling (FEAT-006)"
  ```

---

## Task 21: `disk_saturated` event + `iops-saturated` analysis rule

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/index.ts`
- Modify: `src/lib/analysis/rules/capacity.ts`
- Test: `src/lib/worldEngine/index.test.ts`, `src/lib/analysis/rules/capacity.test.ts`

**Interfaces:**
- Consumes: `ServerMetrics.diskIoFraction` (Task 20).
- Produces: `disk_saturated` event (rate-limited), `iops-saturated` rule appended to `capacityRules`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it('emits rate-limited disk_saturated above 90% sustained', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 30; i++) st.engine.__test_step(1)
    const events = st.eventsSoFar().filter((e: any) => e.kind === 'disk_saturated')
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThan(10) // rate-limited, not one per step
    st.engine.stop()
  })
  ```

  ```ts
  it('iops-saturated fires above 90% sustained and names the top diskIoPerRequest contributors', () => {
    const ctx = buildIopsSaturatedFixture({ diskIoFraction: 0.95 })
    const findings = iopsSaturated.run(ctx)
    expect(findings.length).toBe(1)
    expect(findings[0].message).toMatch(/\d/) // names a contributor by some identifying detail
  })
  ```

- [ ] **Step 2: Run to verify both fail**

  Run: `npx vitest run -t "disk_saturated"`
  Run: `npx vitest run -t "iops-saturated"`
  Expected: FAIL.

- [ ] **Step 3: Add the event kind, emit rate-limited**

  Append `'disk_saturated'` to `EngineEventKind`. Emit it using the SAME rate-limit gate pattern used
  for `replication_lag_high` (Task 14) — reuse the gate helper if one was factored out there, or mirror
  its shape if it's still inline.

- [ ] **Step 4: Implement `iops-saturated`**

  In `capacity.ts`, mirroring `ramOversubscribed`'s shape: iterate `lastBatch.servers`, fire when
  `server.diskIoFraction > 0.9` (sustained — check whether this file's other "sustained" rules track a
  rolling window or just check the latest batch; match whichever convention `ramOversubscribed`/
  `burstableSustainedLoad` already use rather than inventing a new sustained-detection mechanism), name
  the server and rank its resident instances by `workload.diskIoPerRequest` descending in the message.
  Add to `capacityRules`.

- [ ] **Step 5: Run tests, log contract-drift, full suite, commit**

  Run: `npx vitest run`
  Expected: green.

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/lib/analysis/rules/capacity.ts src/lib/worldEngine/index.test.ts src/lib/analysis/rules/capacity.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat: disk_saturated event + iops-saturated analysis rule (FEAT-006)"
  ```

---

## Task 22: Author `diskIops`/`diskType` in Hardware drawer + live disk saturation on the board

**Files:**
- Modify: `src/app/world/dock/drawers/Hardware.tsx` (or the equivalent Hardware drawer file — confirm
  exact filename via Glob before editing)
- Modify: the server board's hardware-platform component (wherever CPU/NIC saturation already render)

**Interfaces:**
- Consumes: `ServerSpecs.diskIops`/`diskType` (Task 17), `ServerMetrics.diskIoFraction` (Task 20).

- [ ] **Step 1: Author `diskIops`/`diskType` in the Hardware drawer**

  Add a `diskType` selector (hdd/ssd/nvme, or "auto/unbounded") and a numeric `diskIops` override
  input, following this drawer's existing field-authoring conventions (likely adjacent to `diskGb`).

- [ ] **Step 2: Show live disk saturation on the hardware platform**

  Find where CPU core utilization and NIC saturation already render on the server board's
  `HardwarePlatform` component. Add a disk saturation bar/gauge using `ServerMetrics.diskIoFraction`,
  same visual language (bar fill + `var(--color-danger)` past a threshold), driven off the 1 Hz batch.

- [ ] **Step 3: Live smoke test**

  `npm run tauri dev`: set a DB server to `hdd`, drive write load, watch disk saturation redline while
  CPU sits low; switch to `nvme`, watch the bottleneck move off disk. Both themes, zero new console
  errors.

- [ ] **Step 4: Full suite, build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`

  ```bash
  git add -A
  git commit -m "feat(ui): author diskIops/diskType, live disk saturation on hardware platform (FEAT-006)"
  ```

---

## Task 23: FEAT-006 bench + Wave 2 close-out

**Files:**
- Read: `bench/enginePerf.bench.test.ts`
- Modify: `docs/module-boundaries.md`
- Read: `.superpowers/sdd/contract-drift.md`

- [ ] **Step 1: Run the perf bench**

  Run: `npm run bench`
  Expected: aggregate median step time still under `DEGRADE_THRESHOLD_MS = 4` ms (the hard 8 ms gate
  applies per the file's own assertion); FEAT-006's own delta < 0.05 ms/step at ~2,000 instances if the
  bench world is extended to include disk-bound servers, else ~0 ms/step.

- [ ] **Step 2: Full Wave 2 regression pass**

  Run: `npx tsc --noEmit`
  Run: `npx vitest run`
  Run: `npm run build`
  Expected: all green — this is the wave-level gate, not just the per-feature one.

- [ ] **Step 3: Update module-boundaries.md with the real FEAT-006 description**

  Replace the placeholder with `hostScheduler.ts`'s new disk functions, the `diskIoFraction` dual-
  behavior note (documented so a future firewall-style "two paths, keep both in sync" gotcha doesn't
  repeat FEAT-014's warning from the spec's closing notes), and the `disk-stall` fault variant.

- [ ] **Step 4: Confirm contract-drift.md has all three features' entries**

  Read `.superpowers/sdd/contract-drift.md` and confirm FEAT-004/005/006 each have a heading with every
  additive field/event/signature-extension listed (cross-check against this plan's Tasks 4, 5, 12, 14,
  17, 20, 21).

- [ ] **Step 5: Live smoke, both themes, all three features in one session**

  `npm run tauri dev`: build a topology exercising all three — a cache in front of a cross-region
  replicated DB on disk-constrained hardware. Run it, inject a cache-kill fault, watch the herd; kill
  the DB primary, watch the RPO-labelled promotion; drive write load past the disk ceiling, watch
  latency climb. Confirm the Analysis tab surfaces all three new rule kinds when applicable. Both
  themes, zero new console errors.

- [ ] **Step 6: Final commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: close out Wave 2 module-boundaries (FEAT-004/005/006)"
  ```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** Task 1-8 cover FEAT-004's full execution-step list (types, resolver, flows wiring,
  metrics, events, analysis, UI, bench). Task 9-16 cover FEAT-005's full list (DbConfig, resolver,
  index.ts/flows.ts wiring, metrics/divergence, failover.ts promotion + RPO payload, events/rule, UI,
  bench). Task 17-23 cover FEAT-006's full list (ServerSpecs + disk-stall, hostScheduler functions,
  latency/RAM threading, dual diskIoFraction + managed IOPS, event/rule, UI, bench). Task 0 covers the
  spec's implicit serializer-audit step. All nine acceptance-criteria "the X test" callouts (cache
  economics-invert, thundering-herd, RPO, least-lagged selection, TTL floor, disk-bound-not-CPU-bound,
  provisionedIops-changes-behavior, disk-stall) have a corresponding named test in this plan.
- **Known imprecision, flagged rather than hidden:** several steps (Task 3 Steps 5-6's exact `FlowInput`
  field names, Task 11 Step 3's primary-lookup helper, Task 13's exact `promoteReplicas` event-emission
  wrapper name, Task 18/20's exact `managedDbRuntimeFor` file location) could not be pinned to exact
  current line numbers/signatures without reading the full 900+/2000+-line files in question beyond
  what the grounding-research pass captured. Each such step explicitly instructs the implementer to
  read the real current code before finalizing the edit, rather than presenting a guess as fact — this
  is deliberate, not an oversight; a subagent executing this task should treat those call-outs as "stop
  and verify," not "skip."
- **Type consistency:** `CacheConfig`, `effectiveMissFraction`/`effectiveHitRatio`, `ReplicaRef`,
  `stepReplication`, `localityFloorSec`, `staleReadFraction`, `diskIoDemandFor`, `diskWaitFor` are used
  with the same signatures everywhere they appear across tasks (defined once in Task 2/10/18, consumed
  identically in every later task that references them).
