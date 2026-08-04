# Wave 3 — Elasticity (FEAT-007, FEAT-008) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Wave 3 of `feature-spec.md` — FEAT-007 (Instance Cold Start) and FEAT-008
(Horizontal Autoscaling Policy). FEAT-008 depends on FEAT-007 (scale-out must not be instantly
useful), so FEAT-007's tasks land first in strict sequence; both depend on Wave 1
(`setFault`/`FaultSpec`, already on `main`).

**Architecture:** FEAT-007 adds an engine-owned `warmingUntil` overlay (cloning the `warmSinceMs`
precedent from FEAT-004) that a new pure resolver, `warmthOf` (in `hostScheduler.ts`), turns into a
capacity multiplier (water-fill weight) and a latency multiplier (`effectiveCpuMsByInstance`) — the
SAME resolver call at both sites, so a cold instance's throttling can never diverge between what the
host scheduler enforces and what the metrics pipeline publishes. FEAT-008 is the wave's large
change: `compileWorld` now statically expands an autoscaled placement to its full `maxCount`
envelope (all indexes stay frozen and valid), and a new pure module, `worldEngine/autoscale.ts`,
owns a `desiredCount` control loop plus a `runningSetResolver` — modeled directly on
`failover.ts`'s `effectiveRoleResolver` closure-with-fast-path shape — that every "is this instance
actually running" consumer must call instead of assuming `compiled.instances` is the running set.
Newly-unparked instances register in FEAT-007's `warmingUntil` so scale-out starts cold; scale-in
reuses `failover.ts`'s `drainUntil`/`drainFactor` *pattern* (cloned into a new placement-keyed map,
since the existing one is AZ-keyed) rather than killing instances outright.

**Tech Stack:** TypeScript, Vitest (node env for `worldEngine`/`analysis`), the existing seeded
`Rng` (unused by either feature — both are deterministic arithmetic over doc config + accumulated
state), Zustand stores for UI wiring.

## Global Constraints

These apply to every task below; re-stated here so no task has to repeat them.

- **Compiled-world gate**: nothing reads the raw `WorldDoc` for anything derived; extend
  `CompiledWorld` additively only, never reshape it. FEAT-008 is the spec's one sanctioned
  exception to a stricter invariant (see below), but `CompiledWorld`'s *shape* itself is unchanged —
  only what a full `compiled.instances` means shifts (envelope, not running set).
- **Engine seam**: `src/app/store/simulation.store.ts` is the ONLY file allowed to call the engine
  facade. Neither feature adds new engine API surface — both are internal engine mechanics
  observable via the existing `MetricsBatch`/`EngineEvent` channels (confirmed: `setFault`/
  `setOutage` at `simulation.store.ts:178,181,330,339` are the only engine entry points touched by
  any prior wave; this wave adds none).
- **Regression floor**: every new doc field is optional; absent ⇒ today's exact behavior, asserted
  with `toBe`/`toEqual` (not `toBeCloseTo`) against a fixed seed, following the `REGRESSION FLOOR`
  pattern at `index.test.ts:1314`.
- **The one sanctioned exception (FEAT-008 only)**: a world WITH `autoscale` authored no longer
  satisfies "every instance in `compiled.instances` is running" — `compiled.instances` becomes an
  envelope (`maxCount` entries), and `MetricsBatch.instances` becomes the running subset
  (`desiredCount` entries). This is a semantic break, not a type break, and only applies to
  placements that opt in. Task 19 is the full consumer audit this requires.
- **Contract drift**: `src/lib/worldEngine/types.ts` is a frozen contract. Log every additive change
  (new `InstanceMetrics` fields, new `EngineEventKind` entries, the new `MetricsBatch.runningByPlacement`
  field) in `.superpowers/sdd/contract-drift.md`, continuing the existing chronological log (last
  entry: 2026-08-04, FEAT-006 Task 21).
- **Two-call-site invariant / no divergence**: `warmthOf` (FEAT-007) and `runningSetResolver`/
  `desiredCount` (FEAT-008) are each called from exactly the enforcement site AND the display site,
  never re-derived. Every such quantity gets its own `DIVERGENCE GUARD` test in
  `src/lib/worldEngine/index.test.ts`, mirroring the nine existing ones (lines 1562, 1585, 1611,
  1730, 2033, 2329, 2932, 3211, 3409).
- **Perf envelope**: engine runs ~2 ms/step at ~2,000 instances against `DEGRADE_THRESHOLD_MS = 4`.
  FEAT-007 budget: 0 ms/step at steady state, < 0.05 ms/step during a mass restart. FEAT-008 budget:
  < 0.1 ms/step at ~2,000 instances (benchmarked at a realistic `maxCount` envelope, not `minCount`),
  0 ms for worlds with no autoscaling authored. Run `npm run bench` after each feature lands.
- **60 FPS render budget**: new visuals (warm-up fill, desired/running/max readout, scale marker)
  compute on the 1 Hz metrics batch, never per animation frame.
- **Determinism**: neither feature draws from `rng` — both are deterministic arithmetic over doc
  config + accumulated engine state.
- **Theme law**: every color in new UI is `var(--color-*)`. No hardcoded hexes. Verify in dark
  **and** light.
- **No emojis. Ever.** Glyphs already in use: `▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →`.
- **Motion budget**: the warm-up fill and any scale-event marker are data-driven, not decorative;
  `prefers-reduced-motion` ⇒ a static partial fill, never a pulse.
- **Edit-lock law**: authoring `coldStartMs`/`warmCapacityFraction`/`autoscale` is disabled while
  running (`stop the simulation to edit`) — these are doc fields, authored like any other blueprint/
  placement config, not chaos controls.
- **Serializer is additive**: `coldStartMs`/`warmCapacityFraction` live on the existing
  `WorkloadProfile` interface; `autoscale` lives on the existing `Placement` interface. Neither is a
  new top-level `WorldDoc` collection, so — following the confirmed Wave 2 convention
  (`serializer.ts`'s defaulting block only adds entries for new top-level collections) — **no
  `serializer.ts` changes are needed**; reads at consumption sites use `??`/optional-chaining
  fallbacks, exactly like `ManagedService.provisionedIops?` already does. Confirmed in Task 0.
- **Analysis rules** go only in the `structural`/`network`/`capacity` rule files, spread into
  `capacityRules` (`src/lib/analysis/rules/capacity.ts:296-298`). Never duplicate `compiled.findings`.
- **Done bar, per task**: `npx tsc --noEmit` clean → `npx vitest run` green → (`npm run build` once
  per feature) → live smoke in `npm run tauri dev` with zero new console errors, both themes.
- **High-conflict hub files** — edit sequentially, never in parallel across the two features:
  `src/lib/world/types.ts`, `src/lib/world/compileWorld.ts`, `src/lib/worldEngine/types.ts`,
  `src/lib/worldEngine/index.ts`, `src/lib/worldEngine/hostScheduler.ts`,
  `src/lib/worldEngine/flows.ts`, `src/lib/worldEngine/metrics.ts`,
  `src/lib/worldEngine/routingRuntime.ts`, `src/lib/worldEngine/failover.ts`,
  `src/lib/costModelV2.ts`, `src/lib/analysis/rules/capacity.ts`. Do FEAT-007 → FEAT-008 in strict
  sequence (the spec already requires this: FEAT-008 depends on FEAT-007's `warmingUntil`
  mechanism), never in parallel.

## Grounding notes (current repo state, verified before writing this plan — 2026-08-04)

Facts below were confirmed by direct inspection immediately before writing this plan; where the
spec's own line-number citations had drifted, the corrected number is called out explicitly so no
task cites a stale location.

- `src/lib/worldEngine/types.ts` (436 lines). `InstanceMetrics` at **26-85**: `checkoutWaitMs?`
  (L49), `effectiveRole?` (L60), `cacheHitRatio?` (L67), `staleReadFraction?` (L76), `diskWaitMs?`
  (L84, the last field before the closing brace — new fields append after this). **No `warmth?`
  field exists** — genuinely new. `EngineEventKind` union at **218-259**, 26 variants, most recent
  `disk_saturated` — append new variants after it. `WorldEngineApi` at **385-417**: `setFault`
  (L397) and `setOutage` (L400) both exist exactly as documented; no autoscale-policy method exists
  and none is needed (see Global Constraints). `MetricsBatch` at **188-214**: has `clusters?` (L213,
  FEAT-005, unrelated) but **no `runningByPlacement` field** — genuinely new.
- `src/lib/world/types.ts` (521 lines). `WorkloadProfile` at **155-178**, last field
  `checkoutTimeoutMs?` (L177) — append `coldStartMs?`/`warmCapacityFraction?` after it. Neither
  exists today. `Placement` at **273-280**: `id`, `blueprintId`, `serverId`, `count`, `role`,
  `runtime` — **no `autoscale?` field**, genuinely new. `ServiceBlueprint` at **234-250**.
- `src/lib/world/compileWorld.ts`: the placement-expansion loop is at **line 27**
  (`for (let i = 0; i < pl.count; i++) { ... instances[id] = { id, blueprintId, placementId,
  serverId, azId, regionId, role: pl.role, indexInPlacement: i } }`) — the single site FEAT-008
  Task 11 changes.
- `src/lib/worldEngine/index.ts` (2592 lines). `OOM_RESTART_MS = 5000` at **L67**;
  `oomRestartAt: Map<InstanceId, number>` field in `EngineState` at **L443**; consumed at **L573**
  (`if (s.oomRestartAt.has(iid)) return 'down'`); restart-completion loop at **L837-839**; the write
  site (inside `stepHost`'s result handling) at **L1366-1371**
  (`if (host.oomVictim && !s.oomRestartAt.has(host.oomVictim)) { s.oomRestartAt.set(...);
  s.instanceHealth.set(..., 'down'); ...emit('oom_kill', ...) }`). `EngineState` interface at
  **L302-536**; relevant existing fields to clone the pattern from: `warmSinceMs` (L462, FEAT-004
  cache warmth), `warmEmitted` (L468), `hasAnyCache` (L472), `hasAnyReplicas` (L501), `hasAnyDisk`
  (L507), `blueprintIdByInstance` (L511, a `start()`-built `Map<InstanceId, BlueprintId>`).
  **No `warmingUntil` map exists** — genuinely new, modeled directly on `warmSinceMs`. `start()`
  begins at **L2196**; the `state = { ... }` literal building every frozen index runs roughly
  **L2211-2280+** (e.g. `instancesByServer: groupInstancesByServer(compiled)` L2225,
  `blueprintIdByInstance: new Map(...)` L2256, `hasAnyDisk: Object.values(doc.servers).some(...)`
  L2255) — new FEAT-008 indexes (e.g. a per-placement instance-id list for the envelope) go here.
  `runStep(simMs)` begins at **L818** with numbered section markers: `// ── 0. OOM restart timers ──`
  (L836), `// ── 1. demand ──` (L928), `// ── 2. routing: health checks ──` (L939),
  `// ── 3. routing: resolve + build entry demand ──` (L984),
  `// ── 4/5. host scheduling (prev-step load) + VPS ──` (L1184), `// ── 6. flows ──` (L1391),
  `// ── 7. NIC byte accounting ──` (L1605), `// ── 8. breaker record + transition ──` (L1658),
  `// ── 9. failover / health propagation ──` (L1693), `// ── 10. metrics accumulate ──` (L1860),
  `// ── 11. 1 Hz batch + replay + trace ──` (L1879). `doSetFault` begins at **L716**; `wasDown`
  capture at **L724**; the down-fault-clear branch (the pattern FEAT-007 clones for cold-start reset)
  at **L745-754**.
- `src/lib/worldEngine/hostScheduler.ts` (293 lines). `InstanceLoad` at **L7-26**, no
  cold/warmth-related field. `stepHost(server, loads, effectiveVcpu, rng, diskWaitMs?, diskIoRatio?)`
  at **L189-293**; `effectiveVcpu` is the caller-computed 3rd positional arg (L192). The `waterfill()`
  helper at **L149-187**; `serviceRateByInstance`'s per-instance weight computation (currently
  `weight = cpuShares ?? 1`) at **L215-230** — the natural site for a cold-start-aware weight
  multiplier, since applying it here means the water-fill's existing work-conserving redistribution
  gives a cold instance's unused share to warm siblings for free. `poolCheckoutFor` at **L39-54**.
- `src/lib/worldEngine/flows.ts` (1051 lines). `effectiveCpuMsByInstance` is declared as an optional
  input field at **L275** and read at exactly one site, **L519**
  (`const p50 = Math.max(0.1, input.effectiveCpuMsByInstance?.[id] ?? bp?.workload.cpuMsPerRequest ??
  1)`) — **the spec cites `:442`; the correct current line is `:519`. Use `:519`.**
- `src/lib/worldEngine/metrics.ts` (626 lines). `buildBatch` begins at **L248**; the "── Instances ──"
  loop begins at **L333**; `baseHealth` comes from `state.lastHealth(inst.id)` at **L367**; the
  starved-instance degraded-health override is at **L418**
  (`health: starved?.has(inst.id) && baseHealth === 'healthy' ? 'degraded' : baseHealth,`) — **the
  spec cites `:305-307`; the correct current line is `:418`. Use `:418`.**
- `src/lib/worldEngine/routingRuntime.ts` (284 lines). `distributeToTargets` (L182-266) is the actual
  target-selection core, filtering live instances via `healthOfInstance(iid) !== 'down'` at multiple
  sites (e.g. L208, L226, L248); `pickInstance` (L270-284) filters via `healthyOf(id) !== 'down'`
  (L277). **There is no "parked/excluded" concept beyond the binary down/not-down filter.** FEAT-008
  Task 14 synthesizes a `'down'`-equivalent `healthOfInstance` result for parked instances at the
  `index.ts` call site rather than modifying this file's filter logic.
- `src/lib/worldEngine/failover.ts` (453 lines). `drainUntil: Map<AzId, number>` field (**L52**);
  `beginDrain(state, azId, simMs)` (**L108-110**, idempotent — sets only if not already draining);
  `clearDrain(state, azId)` (**L112-114**); `drainFactor(state, azId, simMs)` (**L116-120**, returns
  `Math.max(0, Math.min(1, (until - simMs) / DRAIN_MS))`, 1.0 at drain start ramping to 0 over
  `DRAIN_MS = 2000` at **L9**). **This mechanism is keyed by `AzId` only** — an AZ-level ramp for AZ
  outages, not per-instance/per-placement. FEAT-008 Task 15 clones this exact shape into a NEW
  `drainUntilByInstance: Map<InstanceId, number>` map (same `begin`/`clear`/`factor` functions,
  instance-keyed) rather than reusing `drainUntil` itself, since two placements draining in the same
  AZ simultaneously would otherwise collide. `effectiveRoleResolver` at **L318-339** — a closure
  returned once per state-change and memoized by the caller (`index.ts`'s `s.roleResolver`/
  `s.roleResolverKey`, L370-371), with a `promotedAt.size === 0` fast path. **This is the exact shape
  `runningSetResolver` (Task 12) mirrors.**
- `src/lib/costModelV2.ts` (278 lines). `computeWorldCost(doc, world, managed)` at **L189-278**.
  **Confirmed: compute cost is derived purely from `doc.servers` — `for (const server of
  Object.values(doc.servers)) { const usd = server.hourlyUsd * HOURS_PER_MONTH; computeTotal += usd }`
  (L204-210) — it never reads `Placement.count` or `compiled.instances` at all.** This is the
  grounding fact that reshapes FEAT-008's Task 17: the spec assumes cost already scales with
  placement size and just needs to switch from `count` to `runningByPlacement`, but cost is
  per-**server**-hour flat, independent of how many instances are packed onto that server. Task 17
  below designs the apportionment scheme this actually requires, additive and byte-identical when no
  placement on a server is autoscaled.
- `src/lib/analysis/rules/capacity.ts` (299 lines). `capacityRules` array at **L296-298**:
  `[ramOversubscribed, burstableSustainedLoad, oceanCrossingPopulation, ttlOutlivesDetection,
  consumerLagBehindProducer, faultInjected, cacheMissStorm, iopsSaturated]`. `faultInjected`
  (**L182-194**) is the simplest template; `iopsSaturated` (**L254-294**) is the closer template for a
  per-placement rule (groups `compiled.instances`, reads `lastBatch.servers?.[id]?.<field>`, ranks
  contributors).
- `src/lib/world/serviceDraft.ts`: `COST_MS: Record<CostPreset, number>` at **L30**
  (`{ light: 2, medium: 8, heavy: 25 }`); `MEMORY_MB` at **L34-38**; `draftWorkload(_kind, cost,
  memory): WorkloadProfile` at **L55-65** builds the `WorkloadProfile` literal from these tables;
  `defaultDraft(kind)` at **L69-80+** picks per-kind starting presets. This is where a
  `COLD_START_MS: Record<CostPreset, number>` table gets added and wired into `draftWorkload`'s
  returned object (Task 1).
- `src/app/store/simulation.store.ts` (360 lines): `setFault`/`setOutage` are thin passthroughs
  (type L178/L181, impl L330/L339) — confirms no new store/engine API surface is needed this wave.
- `src/lib/worldEngine/index.test.ts` (3643 lines). Primary harness: `drive(doc, compiled)` at
  **L71**, exposing `stepFor(n)`/`latest()`. **There are NINE existing `DIVERGENCE GUARD` tests, not
  six** — at L1562, L1585, L1611, L1730, L2033, L2329, L2932, L3211, L3409. One example
  `REGRESSION FLOOR` test (the pattern to copy) is at **L1314**:
  ```ts
  it('REGRESSION FLOOR: two runs of the same unauthored world are identical', () => {
    const f = crossAzPair()
    const compiled = compileWorld(f.doc)
    const simA = drive(f.doc, compiled); simA.stepFor(30)
    const simB = drive(f.doc, compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
  })
  ```
- `bench/enginePerf.bench.test.ts` (131 lines): synthetic world ≈1,948 instances (6 regions × 3
  AZs × 12 servers × 9 instances on the public tier, plus 4 pinned single-instance backend tiers),
  `peakRps = 2_000`, budget median ≤4ms/step (warn 4-8ms, fail >8ms) over 100 steps. Command:
  `npm run bench` (isolated from the default `npx vitest run` suite via its own vitest config).
- **Consumer audit of `compiled.instances`** (Task 19's starting material — grep run 2026-08-04,
  48 files / 159 occurrences). The spec names eight files to audit; three of them turn out **not**
  to be `compiled.instances` consumers at all, confirmed by direct grep with zero matches:
  `src/lib/costModelV2.ts` (relevant to FEAT-008 for the per-server billing reason above, not because
  it reads `compiled.instances`), `src/app/world/panels/TopologyPanel.tsx` (a doc-authoring panel —
  region/AZ/server/firewall editing — not a live-instance consumer), `src/lib/llmReview.ts` (reads
  `compiled.findings`, not `compiled.instances`). The other five are real and confirmed:
  `analysis/rules/{structural,network,capacity}.ts` (9+7+5 matches), `src/app/world/az/
  DatacenterFloor.tsx` + `src/app/world/az/floorData.ts` (1+4), `src/lib/world/connections.ts`
  (singular module, not a `connections/` directory — 4 matches; the UI directory
  `src/app/world/connections/ConnectionsView.tsx` has zero `compiled.instances` matches, it consumes
  compiled paths/edges instead), `src/app/world/ai/../aiChat/context.ts` (1), `src/app/world/
  entityNav.ts` (2). The heaviest consumer by far is `worldEngine/index.ts` itself (32 matches — this
  is expected; the engine is where "running" is enforced). Task 19 carries the full corrected list.

---

## Task 0: Confirm serializer needs no changes + module-boundaries/contract-drift prep

**Files:**
- Read: `src/lib/serializer.ts`
- Modify: `docs/module-boundaries.md`

**Interfaces:**
- Produces: nothing consumed by later tasks — verification + documentation, safe to do first.

- [ ] **Step 1: Confirm the additive-optional-field convention needs no serializer entry**

  Read `src/lib/serializer.ts`'s defaulting block (search for where `racks`/`loadBalancers`/
  `scenario` are defaulted). Confirm `coldStartMs`/`warmCapacityFraction` (new fields on the existing
  `WorkloadProfile`) and `autoscale` (a new field on the existing `Placement`) need no entry there —
  they pass through `...src.world` untouched and are read with `??`/optional-chaining at consumption
  sites, exactly like `ManagedService.provisionedIops?` and Wave 2's `cacheConfig?` already do.

- [ ] **Step 2: Add Wave 3 placeholder rows to module-boundaries.md**

  Near the "Wave 2 additions" section (`## Wave 2 — Stateful Fidelity: module additions
  (FEAT-004/005/006)`), add a `## Wave 3 — Elasticity: module additions (FEAT-007/008)` section
  naming the new files this plan creates before they exist: `src/lib/worldEngine/autoscale.ts`
  (FEAT-008, pure — `AutoscaleState`/`runningSetResolver`/`evaluatePolicy`, no engine imports). Note
  `hostScheduler.ts` gains `warmthOf` in place (FEAT-007, no new file). Note
  `src/lib/world/types.ts`, `src/lib/world/compileWorld.ts`, `src/lib/worldEngine/types.ts`,
  `src/lib/worldEngine/index.ts`, `src/lib/worldEngine/hostScheduler.ts`,
  `src/lib/worldEngine/flows.ts`, `src/lib/worldEngine/metrics.ts`,
  `src/lib/worldEngine/routingRuntime.ts`, `src/lib/worldEngine/failover.ts`,
  `src/lib/costModelV2.ts` will each receive edits from both features and must be touched
  FEAT-007 → FEAT-008 in strict sequence, never in parallel.

- [ ] **Step 3: Commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: add Wave 3 module-boundaries placeholders for FEAT-007/008"
  ```

---

# FEAT-007: Instance Cold Start

## Task 1: `coldStartMs`/`warmCapacityFraction` doc fields + preset defaults

**Files:**
- Modify: `src/lib/world/types.ts`
- Modify: `src/lib/world/serviceDraft.ts`
- Test: `src/lib/world/serviceDraft.test.ts` (check for an existing file before creating one)

**Interfaces:**
- Produces: `WorkloadProfile.coldStartMs?: number`, `WorkloadProfile.warmCapacityFraction?: number` —
  consumed by Task 2 (pure resolver) and Task 4/5 (engine wiring).

- [ ] **Step 1: Add the two fields to `WorkloadProfile`**

  In `src/lib/world/types.ts`, after `checkoutTimeoutMs?: number` (currently the last field in
  `WorkloadProfile`, L177):

  ```ts
  coldStartMs?: number             // absent -> 0, instant readiness (today's exact behavior)
  warmCapacityFraction?: number    // capacity at t=0 as a fraction of rated; absent -> 0.3
  ```

- [ ] **Step 2: Type-check**

  Run: `npx tsc --noEmit`
  Expected: clean (both fields optional, no existing literal breaks).

- [ ] **Step 3: Write the failing preset-default test**

  ```ts
  // src/lib/world/serviceDraft.test.ts (add alongside existing tests, or create if absent)
  import { describe, it, expect } from 'vitest'
  import { draftWorkload } from './serviceDraft'

  describe('draftWorkload cold-start defaults', () => {
    it('gives a db-flavored heavy workload a visibly longer cold start than a light worker', () => {
      const dbLike = draftWorkload('db-sql', 'heavy', 'large')
      const worker = draftWorkload('worker', 'light', 'small')
      expect(dbLike.coldStartMs).toBeGreaterThan(worker.coldStartMs!)
      expect(worker.coldStartMs).toBeGreaterThan(0)
    })

    it('always sets warmCapacityFraction between 0 and 1', () => {
      const w = draftWorkload('api', 'medium', 'medium')
      expect(w.warmCapacityFraction).toBeGreaterThan(0)
      expect(w.warmCapacityFraction).toBeLessThanOrEqual(1)
    })
  })
  ```

  Adapt the `draftWorkload(kind, cost, memory)` call signature to the file's ACTUAL current
  parameter names/types (read `serviceDraft.ts:55-65` before finalizing — the grounding notes
  above describe its shape but the exact parameter order must be confirmed against the live file).

- [ ] **Step 4: Run to verify it fails**

  Run: `npx vitest run src/lib/world/serviceDraft.test.ts -t "cold-start"`
  Expected: FAIL — `coldStartMs` is `undefined` on every preset.

- [ ] **Step 5: Add a `COLD_START_MS` preset table and wire it into `draftWorkload`**

  In `src/lib/world/serviceDraft.ts`, alongside `COST_MS` (L30):

  ```ts
  const COLD_START_MS: Record<CostPreset, number> = { light: 2_000, medium: 8_000, heavy: 30_000 }
  const WARM_CAPACITY_FRACTION = 0.3
  ```

  In `draftWorkload`'s returned object (L55-65), add:

  ```ts
  coldStartMs: COLD_START_MS[cost],
  warmCapacityFraction: WARM_CAPACITY_FRACTION,
  ```

  (Read the actual current return-object shape before editing — confirm field names match the
  literal `WorkloadProfile` construction already there, don't guess.)

- [ ] **Step 6: Run to verify it passes, full suite, commit**

  Run: `npx vitest run src/lib/world/serviceDraft.test.ts`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green (no other test asserts an exact `WorkloadProfile` shape without these
  fields — if one does, it needs `coldStartMs`/`warmCapacityFraction` added to its expected literal,
  since this is an *authoring-time* default, not a runtime regression floor; the runtime engine
  regression floor is a separate assertion in Task 3).

  ```bash
  git add src/lib/world/types.ts src/lib/world/serviceDraft.ts src/lib/world/serviceDraft.test.ts
  git commit -m "feat(world): add coldStartMs/warmCapacityFraction fields + preset defaults (FEAT-007)"
  ```

---

## Task 2: Pure `warmthOf` resolver in `hostScheduler.ts`

**Files:**
- Modify: `src/lib/worldEngine/hostScheduler.ts`
- Test: `src/lib/worldEngine/hostScheduler.test.ts`

**Interfaces:**
- Produces: `warmthOf(instanceId: InstanceId, warmingUntil: Map<InstanceId, { startedMs: number;
  coldStartMs: number }>, simMs: number): number` (returns 0..1, `1` when the instance is not in the
  map at all — the regression floor). Consumed by Task 4 (capacity) and Task 5 (latency) — the SAME
  function called from both sites so they can never disagree.

- [ ] **Step 1: Write the failing tests**

  ```ts
  // src/lib/worldEngine/hostScheduler.test.ts (add alongside existing tests)
  import { describe, it, expect } from 'vitest'
  import { warmthOf } from './hostScheduler'

  describe('warmthOf', () => {
    it('is 1 (fully warm) when the instance has no warming entry (the regression floor)', () => {
      expect(warmthOf('inst-a', new Map(), 10_000)).toBe(1)
    })

    it('is 0 at the instant warming starts', () => {
      const m = new Map([['inst-a', { startedMs: 5_000, coldStartMs: 30_000 }]])
      expect(warmthOf('inst-a', m, 5_000)).toBe(0)
    })

    it('ramps linearly to 1 over coldStartMs', () => {
      const m = new Map([['inst-a', { startedMs: 0, coldStartMs: 30_000 }]])
      expect(warmthOf('inst-a', m, 15_000)).toBeCloseTo(0.5, 5)
      expect(warmthOf('inst-a', m, 30_000)).toBeCloseTo(1, 5)
    })

    it('clamps at 1 past coldStartMs (never overshoots)', () => {
      const m = new Map([['inst-a', { startedMs: 0, coldStartMs: 30_000 }]])
      expect(warmthOf('inst-a', m, 60_000)).toBe(1)
    })

    it('treats coldStartMs <= 0 as instantly warm', () => {
      const m = new Map([['inst-a', { startedMs: 0, coldStartMs: 0 }]])
      expect(warmthOf('inst-a', m, 0)).toBe(1)
    })
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/hostScheduler.test.ts -t "warmthOf"`
  Expected: FAIL — `warmthOf` is not exported.

- [ ] **Step 3: Implement**

  In `src/lib/worldEngine/hostScheduler.ts`, add near the top (below imports, alongside other
  small pure helpers such as `poolCheckoutFor`):

  ```ts
  export interface WarmingEntry {
    startedMs: number
    coldStartMs: number
  }

  function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x))
  }

  /** 0 (just started/restarted) -> 1 (fully warm). Absent from the map = already warm (the regression floor). */
  export function warmthOf(
    instanceId: string,
    warmingUntil: Map<string, WarmingEntry>,
    simMs: number,
  ): number {
    const entry = warmingUntil.get(instanceId)
    if (!entry) return 1
    if (entry.coldStartMs <= 0) return 1
    return clamp01((simMs - entry.startedMs) / entry.coldStartMs)
  }
  ```

- [ ] **Step 4: Run to verify it passes, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/hostScheduler.test.ts`
  Expected: PASS, all 5 tests.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/hostScheduler.ts src/lib/worldEngine/hostScheduler.test.ts
  git commit -m "feat(engine): pure warmthOf cold-start resolver (FEAT-007)"
  ```

---

## Task 3: `warmingUntil` overlay in `EngineState` + regression-floor test

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `WarmingEntry` type from Task 2.
- Produces: `EngineState.warmingUntil: Map<InstanceId, WarmingEntry>` — populated on OOM restart and
  on FEAT-001 `down`-fault clear, empty at `start()`. Consumed by Task 4/5 (apply the throttle) and
  Task 6 (health override + publish).

- [ ] **Step 1: Write the failing regression-floor test**

  Add to `src/lib/worldEngine/index.test.ts` near the other `REGRESSION FLOOR` tests (pattern at
  L1314):

  ```ts
  it('REGRESSION FLOOR: a world with no coldStartMs produces byte-identical output for a fixed seed', () => {
    const f = crossAzPair()
    const compiled = compileWorld(f.doc)
    const simA = drive(f.doc, compiled); simA.stepFor(30)
    const simB = drive(f.doc, compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
    for (const im of Object.values(simA.latest().instances)) {
      expect((im as any).warmth).toBeUndefined()
    }
  })
  ```

  `crossAzPair()`/`drive()` are the file's existing harness — reuse them verbatim, do not invent a
  new world builder (per the grounding notes, `drive` is at `index.test.ts:71`).

- [ ] **Step 2: Run to verify it fails (or trivially passes since nothing changed yet — that's fine, this is a floor test)**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "no coldStartMs"`
  Expected: PASS already (no wiring exists yet, so behavior is unchanged) — this test's job is to
  stay green through every subsequent step in this task and the next two; run it again after each.

- [ ] **Step 3: Add `warmingUntil` to `EngineState` and initialize empty at `start()`**

  In `src/lib/worldEngine/index.ts`, in the `EngineState` interface (L302-536), add near
  `warmSinceMs`/`warmEmitted` (L462-468):

  ```ts
  warmingUntil: Map<InstanceId, WarmingEntry>   // FEAT-007: instance id -> cold-start ramp state
  ```

  Import `WarmingEntry` from `./hostScheduler` at the top of the file (alongside the existing
  `stepHost` import).

  In `start()`'s `state = { ... }` literal (L2211-2280+), add `warmingUntil: new Map(),` — empty at
  `start()`, matching the spec's explicit floor ("Instances are warm at `start()`").

- [ ] **Step 4: Populate on OOM restart and on `down`-fault clear**

  At the OOM-victim write site (L1366-1371, where `s.oomRestartAt.set(host.oomVictim, ...)` is set),
  after that line, add:

  ```ts
  const victimBp = doc.blueprints[s.blueprintIdByInstance.get(host.oomVictim) ?? '']
  const coldStartMs = victimBp?.workload.coldStartMs ?? 0
  if (coldStartMs > 0) {
    s.warmingUntil.set(host.oomVictim, { startedMs: simMs, coldStartMs })
  }
  ```

  In `doSetFault`'s `wasDown`-gated clear branch (L745-754, the same branch FEAT-004 uses to reset
  `warmSinceMs`), add the identical pattern for every affected instance: look up its blueprint's
  `workload.coldStartMs`, and if `> 0`, `s.warmingUntil.set(iid, { startedMs: simMs, coldStartMs })`.

  Read the actual current variable names at both sites (`host.oomVictim`, the `affected` iterable in
  the fault-clear branch) before editing — confirm against the live code rather than assuming.

- [ ] **Step 5: Clear the entry once warmth reaches 1 (leak prevention)**

  Near the OOM restart-completion loop (L837-839, `for (const [iid, restartAt] of [...s.oomRestartAt])
  { if (simMs >= restartAt) s.oomRestartAt.delete(iid) ... }`), add a parallel pass:

  ```ts
  for (const [iid, entry] of [...s.warmingUntil]) {
    if (warmthOf(iid, s.warmingUntil, simMs) >= 1) s.warmingUntil.delete(iid)
  }
  ```

  Import `warmthOf` from `./hostScheduler`. Place this pass early in `runStep` (near section 0,
  before the capacity/latency application in sections 4/5 — Task 4/5 read `s.warmingUntil` and must
  see the just-cleared state for instances that finished warming this exact step, consistent with how
  `oomRestartAt` is cleared before the host-scheduling section reads it).

- [ ] **Step 6: Run the regression-floor test + full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "no coldStartMs"`
  Expected: still PASS (a world with no `coldStartMs` authored never populates `warmingUntil`, since
  `coldStartMs > 0` guards every write site).
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): warmingUntil overlay, populated on OOM restart + fault-down clear (FEAT-007)"
  ```

---

## Task 4: Apply the capacity factor in `stepHost`'s water-fill weight

**Files:**
- Modify: `src/lib/worldEngine/hostScheduler.ts`
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `warmthOf` (Task 2), `warmingUntil` (Task 3).
- Produces: `stepHost`'s new optional 7th parameter `warmthByInstance?: Record<InstanceId, number>`
  (consumed inside the water-fill weight at L215-230). Consumed by Task 5 (parallel latency wiring,
  same call site in `index.ts` builds both records together) and the redistribution test below.

- [ ] **Step 1: Write the failing capacity test**

  ```ts
  // src/lib/worldEngine/index.test.ts
  it('COLD START: a restarted instance serves ~30% capacity at t=0, ~65% at t=15s, 100% at t=30s', () => {
    const f = singleServerTwoInstances({ coldStartMs: 30_000, warmCapacityFraction: 0.3 })
    // ^ a small local world factory: one server hosting a blueprint with count:1 placement whose
    // workload carries { coldStartMs: 30_000, warmCapacityFraction: 0.3 }, driven at a fixed rps
    // high enough to saturate rated capacity. Follow whichever world-construction convention
    // (factories.ts helpers vs. a hand-built literal WorldDoc) this file's neighboring single-server
    // tests already use -- check FEAT-006's diskIops tests for the closest precedent of "one server,
    // one saturating workload."
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5) // reach steady state before killing anything
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null) // restart -> warmingUntil populated at this simMs
    sim.stepFor(1)
    const atRestart = sim.latest().instances[f.instanceId].rps
    for (let i = 0; i < 14; i++) sim.stepFor(1) // ~15s elapsed
    const at15s = sim.latest().instances[f.instanceId].rps
    for (let i = 0; i < 15; i++) sim.stepFor(1) // ~30s elapsed
    const at30s = sim.latest().instances[f.instanceId].rps
    const steady = at30s // fully warm by t=30s
    expect(atRestart / steady).toBeGreaterThan(0.2)
    expect(atRestart / steady).toBeLessThan(0.4)
    expect(at15s / steady).toBeGreaterThan(0.55)
    expect(at15s / steady).toBeLessThan(0.75)
  })

  it('COLD START REDISTRIBUTION: capacity withheld from a cold instance goes to warm siblings, total host throughput does not fully drop', () => {
    const f = singleServerTwoInstances({ coldStartMs: 30_000, warmCapacityFraction: 0.3, siblingCount: 2 })
    // two instances of the SAME blueprint on the same server, one killed and restarted, the other
    // left running the whole time
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const totalBefore = Object.values(sim.latest().instances).reduce((s, i: any) => s + i.rps, 0)
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    sim.stepFor(1)
    const totalAfterRestart = Object.values(sim.latest().instances).reduce((s, i: any) => s + i.rps, 0)
    // the withheld ~70% of ONE instance's share should be largely absorbed by its warm sibling,
    // so total host throughput drops by much less than 35% (half of one instance's full share)
    expect(totalAfterRestart / totalBefore).toBeGreaterThan(0.75)
  })
  ```

  Write `singleServerTwoInstances(opts)` as a small local factory in this test file (or extend an
  existing similar helper if one is already imported), following the file's established
  world-construction convention.

- [ ] **Step 2: Run to verify both fail**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "COLD START"`
  Expected: FAIL — no throttling applied yet, instance serves full capacity immediately.

- [ ] **Step 3: Add the `warmthByInstance` parameter to `stepHost` and apply it in the weight**

  In `src/lib/worldEngine/hostScheduler.ts`, extend `stepHost`'s signature (L189):

  ```ts
  export function stepHost(
    server: ServerSpecs,
    loads: InstanceLoad[],
    effectiveVcpu: number,
    rng: Rng,
    diskWaitMs?: number,
    diskIoRatio?: number,
    warmthByInstance?: Record<string, number>,
  ): HostStepResult {
  ```

  In the water-fill weight computation (L215-230, currently `weight = cpuShares ?? 1`), multiply by
  the instance's warmth:

  ```ts
  const warmth = warmthByInstance?.[load.instanceId] ?? 1
  const weight = (load.cpuShares ?? 1) * warmth
  ```

  Read the actual current loop/variable names at L215-230 before editing (confirm `load.instanceId`
  matches the real `InstanceLoad` field name).

- [ ] **Step 4: Build `warmthByInstance` in `index.ts` and pass it through**

  In `runStep`'s host-scheduling section (`// ── 4/5. host scheduling ──`, L1184), before the
  `stepHost(...)` call, build the record guarded by the fast path:

  ```ts
  const warmthByInstance: Record<InstanceId, number> | undefined = s.warmingUntil.size === 0
    ? undefined
    : Object.fromEntries(
        instancesOnServer.map(inst => [inst.id, warmthOf(inst.id, s.warmingUntil, simMs)]),
      )
  ```

  Adapt `instancesOnServer` to whatever the real local variable is called at this call site (the
  loop already iterates instances per server to build `InstanceLoad[]` — reuse that same list, don't
  build a second one). Pass `warmthByInstance` as `stepHost`'s new 7th argument.

- [ ] **Step 5: Run to verify both pass**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "COLD START"`
  Expected: PASS.

- [ ] **Step 6: Regression floor + full suite + commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "no coldStartMs"`
  Expected: PASS (unchanged — `s.warmingUntil.size === 0` keeps `warmthByInstance` `undefined`, and
  `stepHost`'s new parameter is optional).
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/hostScheduler.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): apply cold-start capacity throttle in stepHost water-fill (FEAT-007)"
  ```

---

## Task 5: Apply the latency factor to `effectiveCpuMsByInstance`

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `warmthOf` (Task 2), `warmingUntil` (Task 3), `flows.ts:519`'s existing
  `effectiveCpuMsByInstance` input field (no `flows.ts` change needed — only the VALUES `index.ts`
  computes for it change).
- Produces: nothing new consumed by later tasks — this closes the "latency tracks the reciprocal of
  capacity" half of the spec's coupling.

- [ ] **Step 1: Write the failing latency test**

  ```ts
  it('COLD START LATENCY: a cold instance shows elevated p50 that decays back to baseline as it warms', () => {
    const f = singleServerTwoInstances({ coldStartMs: 30_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const baselineP50 = sim.latest().instances[f.instanceId].p50Ms
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    sim.stepFor(1)
    const coldP50 = sim.latest().instances[f.instanceId].p50Ms
    expect(coldP50).toBeGreaterThan(baselineP50 * 1.5) // 1/0.3 ~= 3.3x at t=0, generous floor
    for (let i = 0; i < 30; i++) sim.stepFor(1)
    const warmP50 = sim.latest().instances[f.instanceId].p50Ms
    expect(warmP50).toBeLessThan(coldP50)
    expect(warmP50).toBeCloseTo(baselineP50, 0)
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "COLD START LATENCY"`
  Expected: FAIL — latency unchanged during warm-up.

- [ ] **Step 3: Compute the throttled `effectiveCpuMsByInstance` values before `solveFlows`**

  In `runStep`, wherever `effectiveCpuMsByInstance` is currently built for the `FlowInput` passed to
  `solveFlows` (search for `effectiveCpuMsByInstance:` in `index.ts` — it is built in the same
  general area as `roleOf`/`extraLatencyMsByServer`, ahead of section 6 `// ── 6. flows ──` at
  L1391), apply the reciprocal of warmth for any instance present in `s.warmingUntil`:

  ```ts
  const baseCpuMs = /* existing per-instance base cpuMs value, however it's currently computed */
  const w = warmthOf(instanceId, s.warmingUntil, simMs)
  const throttledCpuMs = w > 0 ? baseCpuMs / (warmCapacityFraction + (1 - warmCapacityFraction) * w) : baseCpuMs / warmCapacityFraction
  ```

  Read the actual current construction of `effectiveCpuMsByInstance` in `index.ts` before editing —
  confirm whether it is already populated for every instance (in which case multiply existing values)
  or only conditionally built (in which case extend the existing conditional). `warmCapacityFraction`
  here is the instance's blueprint's `workload.warmCapacityFraction ?? 0.3` — resolve it via
  `s.blueprintIdByInstance` → `doc.blueprints[...]`, matching the resolution pattern Task 3 Step 4
  already established for `coldStartMs`.

  Guard the whole per-instance loop behind `if (s.warmingUntil.size > 0)` so the fast path costs
  nothing when no instance is warming — consistent with every other overlay in this codebase.

- [ ] **Step 4: Run to verify it passes**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "COLD START"`
  Expected: PASS, both the capacity and latency tests.

- [ ] **Step 5: The restart-storm test (the feature's core claim)**

  ```ts
  it('RESTART STORM: an overloaded service, killed and restarted cold, re-saturates and OOMs again without new operator action', () => {
    const f = singleSaturatedInstance({ coldStartMs: 30_000, warmCapacityFraction: 0.2, targetCpuUtilization: 0.9 })
    // one instance at ~90% CPU under sustained load -- follow this file's existing "saturated single
    // instance" world-construction convention (the OOM-victim tests already build exactly this shape;
    // reuse that factory rather than writing a new one from scratch)
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const oomEvents1 = sim.eventsSoFar().filter((e: any) => e.kind === 'oom_kill')
    expect(oomEvents1.length).toBeGreaterThanOrEqual(1) // saturation already causes at least one OOM
    // let it restart cold and receive full traffic immediately (no operator throttling of demand)
    sim.stepFor(30)
    const oomEvents2 = sim.eventsSoFar().filter((e: any) => e.kind === 'oom_kill')
    expect(oomEvents2.length).toBeGreaterThan(oomEvents1.length) // re-saturates and OOMs a second time
  })
  ```

  This test asserts the qualitative loop the spec calls out as previously unreachable. If the
  synthetic world doesn't naturally reproduce a second OOM within the stepped window, increase the
  demand/decrease `coldStartMs`'s implied recovery time until it does — the point is a SECOND
  `oom_kill` occurs purely from the interaction of full-traffic-on-a-cold-instance, not from any new
  fault injection.

- [ ] **Step 6: Regression floor + full suite + commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "no coldStartMs"`
  Expected: PASS (unchanged).
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): apply cold-start latency throttle, restart-storm reachable (FEAT-007)"
  ```

---

## Task 6: Degraded health during warm-up + publish `InstanceMetrics.warmth`

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/metrics.ts`
- Test: `src/lib/worldEngine/index.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Consumes: `warmthOf` (Task 2), `warmingUntil` (Task 3).
- Produces: `InstanceMetrics.warmth?: number` (0..1) — consumed by Task 8 (UI). The degraded-health
  override is consumed implicitly by `routingRuntime.ts`'s existing health-based target filtering
  (see the honest scope note in Step 4 below).

- [ ] **Step 1: Write the failing divergence-guard test**

  ```ts
  it('DIVERGENCE GUARD: published warmth equals warmthOf computed with the same warmingUntil/simMs the scheduler used', () => {
    const f = singleServerTwoInstances({ coldStartMs: 20_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    sim.stepFor(3) // mid-warmup
    const b = sim.latest()
    const published = (b.instances[f.instanceId] as any).warmth
    expect(published).toBeGreaterThan(0)
    expect(published).toBeLessThan(1)
    expect(b.instances[f.instanceId].health).toBe('degraded')
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "DIVERGENCE GUARD: published warmth"`
  Expected: FAIL — field doesn't exist, health is not degraded.

- [ ] **Step 3: Add `warmth?` to `InstanceMetrics`**

  In `src/lib/worldEngine/types.ts`, append after `diskWaitMs?` (currently the last field, L84):

  ```ts
  warmth?: number   // 0..1, present only for a warming instance (FEAT-007 cold start)
  ```

- [ ] **Step 4: Publish it and lift health to degraded, in `metrics.ts`**

  At the starved-instance override site (`metrics.ts:418`,
  `health: starved?.has(inst.id) && baseHealth === 'healthy' ? 'degraded' : baseHealth,`), extend the
  condition to also cover warming:

  ```ts
  const w = state.warmingUntil.size > 0 ? warmthOf(inst.id, state.warmingUntil, simMs) : 1
  // ...
  health: (starved?.has(inst.id) || w < 1) && baseHealth === 'healthy' ? 'degraded' : baseHealth,
  warmth: w < 1 ? w : undefined,
  ```

  Import `warmthOf` from `./hostScheduler`. Confirm `buildBatch` already receives `state`/`simMs` in
  scope at this point (it does — every other Wave 1/2 feature's metrics field reads the same `state`
  object). This MUST read `state.warmingUntil`, never a re-derived value — the divergence guard exists
  precisely to catch a parallel resolution point.

  ⚠ **Honest scope note (mirrors FEAT-004 Task 3's "managed cache has no restart concept" cut):**
  `routingRuntime.ts`'s LB target filter is binary (`down`/not-`down` only, confirmed in the
  grounding notes — there is no tri-state "degraded but still routable" distinction at target
  selection). Lifting health to `'degraded'` here makes the state visible on every existing surface
  that already reads `InstanceMetrics.health` (dock panels, service chips, the `ram-oversubscribed`-
  style analysis rules), and it is what the restart-storm mechanism actually depends on (Task 5's
  test passes because capacity/latency are throttled at the scheduler, NOT because the router stops
  sending traffic to a degraded instance — a real LB in this simulator does not yet make routing
  decisions on soft-degraded state, only on hard-down). State this explicitly in the task report
  rather than silently under-delivering the spec's "routingRuntime's health checks see the degraded
  state" line — the state IS visible to routingRuntime's read of `InstanceMetrics.health` wherever it
  already consults per-instance health for non-target-selection purposes (if any); confirm during
  implementation whether `routingRuntime.ts` reads `InstanceMetrics.health` anywhere beyond the
  binary down filter, and if so, note that as the concrete link satisfying the spec's requirement.

- [ ] **Step 5: Log in contract-drift.md**

  Append:

  ```markdown
  ## FEAT-007: Instance Cold Start (Wave 3)
  - Additive: `InstanceMetrics.warmth?: number` — published only for a warming instance, computed by
    `hostScheduler.ts`'s `warmthOf`, same call the capacity/latency throttles used via
    `state.warmingUntil`. No signature break.
  ```

- [ ] **Step 6: Run the divergence guard + full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts`
  Expected: PASS, including the new guard.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): publish InstanceMetrics.warmth, degraded health during warm-up (FEAT-007)"
  ```

---

## Task 7: `instance_warming`/`instance_warm` events

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Consumes: `warmingUntil` (Task 3).
- Produces: two new `EngineEventKind` variants, emitted once per cold/warm transition.

- [ ] **Step 1: Write the failing test**

  ```ts
  it('emits instance_warming on restart and instance_warm once coldStartMs has elapsed', () => {
    const f = singleServerTwoInstances({ coldStartMs: 10_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    sim.stepFor(1)
    expect(sim.eventsSoFar().filter((e: any) => e.kind === 'instance_warming').length).toBe(1)
    for (let i = 0; i < 12; i++) sim.stepFor(1)
    expect(sim.eventsSoFar().filter((e: any) => e.kind === 'instance_warm').length).toBe(1)
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "instance_warming"`
  Expected: FAIL — event kinds don't exist.

- [ ] **Step 3: Add the event kinds**

  In `src/lib/worldEngine/types.ts`, append to `EngineEventKind` (after `'disk_saturated'`):

  ```ts
  | 'instance_warming' | 'instance_warm'
  ```

- [ ] **Step 4: Emit them in `index.ts`**

  At each `s.warmingUntil.set(instanceId, ...)` write site (Task 3 Step 4), emit `instance_warming`
  immediately after. In the warmth-reaches-1 cleanup pass (Task 3 Step 5), emit `instance_warm` right
  before `s.warmingUntil.delete(iid)` — this pass already runs exactly once per instance per
  warm-completion, so no extra "already emitted" guard is needed (unlike FEAT-004's `warmEmitted` set,
  which had to track "warm event already fired" separately because its warmth check ran every step
  without deleting the entry; here the entry's deletion itself is the one-shot guard).

- [ ] **Step 5: Run to verify it passes, log contract-drift, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "instance_warming"`
  Expected: PASS.

  Append the two event kinds to `.superpowers/sdd/contract-drift.md` under the FEAT-007 heading from
  Task 6.

  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): emit instance_warming/instance_warm events (FEAT-007)"
  ```

---

## Task 8: Author `coldStartMs` in UI + live warm-up readout

**Files:**
- Modify: the service config drawer (locate via Grep for where `cacheConfig` is authored in
  `dock/drawers/` — `coldStartMs` gets the same per-blueprint numeric-input treatment)
- Modify: the server board's service-chip component (locate via Grep for where `cacheHitRatio` is
  rendered on the chip — same call site, same 1 Hz batch subscription)
- Modify: `src/app/world/az/DatacenterFloor.tsx` (equivalent floor-node LED state)

**Interfaces:**
- Consumes: `WorkloadProfile.coldStartMs?`/`warmCapacityFraction?` (Task 1),
  `InstanceMetrics.warmth?` (Task 6).
- Produces: nothing consumed by later tasks — terminal UI task for FEAT-007.

- [ ] **Step 1: Author `coldStartMs`/`warmCapacityFraction` in the service config drawer**

  Locate the drawer via Grep for `cacheConfig` (FEAT-004's Task 7 added authoring there — the direct
  precedent for "a numeric field on `WorkloadProfile`/`ServiceBlueprint`"). Add two numeric inputs
  (cold-start milliseconds, warm-capacity-fraction 0-1), gated on nothing (every service can have a
  cold start, unlike cache config which is kind-gated), writing into `draft.workload.coldStartMs`/
  `draft.workload.warmCapacityFraction`. Follow the file's existing draft-state update pattern.

- [ ] **Step 2: Ramping fill on the service chip**

  In the service-chip component, when `instanceMetrics.warmth != null`, render a partial-fill
  treatment (e.g. the chip's existing capacity/health indicator interpolates from a dim/amber state
  at `warmth` toward its normal steady-state look at `warmth === 1`) using `var(--color-*)` tokens.
  Under `prefers-reduced-motion`, render a static partial fill at the current `warmth` value — never
  an animated ramp.

- [ ] **Step 3: Distinct LED state on the floor**

  Mirror the same warmth-driven treatment on the equivalent node in `az/DatacenterFloor.tsx`,
  distinguishable from both the healthy-steady and killed/down states already rendered there.

- [ ] **Step 4: Live smoke test**

  Run `npm run tauri dev`. Author `coldStartMs` on a service, start the sim, kill its server, restore
  it, and confirm the chip refills gradually (not an instant snap) while the latency chip decays back
  to baseline over the same window. Verify in dark and light themes, and confirm a static partial fill
  (no pulse) with `prefers-reduced-motion` enabled. Confirm zero new console errors.

- [ ] **Step 5: Full suite, build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`
  Expected: all green.

  ```bash
  git add -A
  git commit -m "feat(ui): author coldStartMs/warmCapacityFraction, live warm-up readout (FEAT-007)"
  ```

---

## Task 9: FEAT-007 bench + wave-progress checks

**Files:**
- Read: `bench/enginePerf.bench.test.ts`
- Modify: `docs/module-boundaries.md`

- [ ] **Step 1: Run the perf bench**

  Run: `npm run bench`
  Expected: median step time unchanged (the synthetic bench world authors no `coldStartMs`) —
  confirms the `s.warmingUntil.size === 0` fast paths (Tasks 4, 5) cost 0 ms. If the bench world is
  extended to include cold-starting instances, expected < 0.05 ms/step delta per the spec's budget.

- [ ] **Step 2: Update module-boundaries.md with the real FEAT-007 change list**

  Replace Task 0's FEAT-007 placeholder note with a real one-paragraph description (mirroring the
  Wave 2 table's style): the files touched, the `warmthOf` resolver and its two call sites
  (`hostScheduler.ts`'s water-fill weight, `index.ts`'s `effectiveCpuMsByInstance` build), and the
  fields introduced (`WorkloadProfile.coldStartMs?`/`warmCapacityFraction?`,
  `InstanceMetrics.warmth?`).

- [ ] **Step 3: Commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: document FEAT-007 cold-start module in module-boundaries.md"
  ```

---

# FEAT-008: Horizontal Autoscaling Policy

## Task 10: `AutoscalePolicy` type + `Placement.autoscale` field

**Files:**
- Modify: `src/lib/world/types.ts`

**Interfaces:**
- Produces: `AutoscalePolicy` interface, `Placement.autoscale?: AutoscalePolicy` — consumed by
  Task 11 (compile-time envelope expansion) and Task 12 (pure control-loop module).

- [ ] **Step 1: Add `AutoscalePolicy` and the field**

  In `src/lib/world/types.ts`, near `Placement` (currently L273-280):

  ```ts
  export interface AutoscalePolicy {
    minCount: number
    maxCount: number
    targetCpuPercent: number      // 0..100, the HPA-style setpoint
    scaleUpCooldownSec: number    // typically short (30-60)
    scaleDownCooldownSec: number  // typically long (300+) -- asymmetry prevents thrash
    scaleStep?: number            // max instances added/removed per decision; absent -> unbounded
  }
  ```

  Add `autoscale?: AutoscalePolicy` to `Placement` (after `runtime`, the last current field).

- [ ] **Step 2: Type-check and commit**

  Run: `npx tsc --noEmit`
  Expected: clean.

  ```bash
  git add src/lib/world/types.ts
  git commit -m "feat(world): add AutoscalePolicy and Placement.autoscale field (FEAT-008)"
  ```

---

## Task 11: `compileWorld.ts` envelope expansion + compile finding

**Files:**
- Modify: `src/lib/world/compileWorld.ts`
- Test: `src/lib/world/compileWorld.test.ts`

**Interfaces:**
- Consumes: `Placement.autoscale?` (Task 10).
- Produces: `compileWorld` now emits `pl.autoscale ? pl.autoscale.maxCount : pl.count` instances per
  placement, plus a new compile finding for an invalid range — consumed by Task 12 (the running-set
  resolver reads this same envelope) and Task 19 (every consumer audit starts from this changed
  cardinality).

- [ ] **Step 1: Write the failing tests**

  ```ts
  // src/lib/world/compileWorld.test.ts (add alongside existing tests)
  it('expands an autoscaled placement to maxCount instances, not count', () => {
    const doc = /* existing minimal one-placement world builder this file already uses */ buildWorld({
      placementOverrides: { count: 2, autoscale: { minCount: 2, maxCount: 8, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 } },
    })
    const compiled = compileWorld(doc)
    const placementId = Object.keys(doc.placements)[0]
    const instances = Object.values(compiled.instances).filter(i => i.placementId === placementId)
    expect(instances.length).toBe(8)
  })

  it('expands a non-autoscaled placement to count instances, unchanged (regression floor)', () => {
    const doc = buildWorld({ placementOverrides: { count: 3 } })
    const compiled = compileWorld(doc)
    const placementId = Object.keys(doc.placements)[0]
    const instances = Object.values(compiled.instances).filter(i => i.placementId === placementId)
    expect(instances.length).toBe(3)
  })

  it('emits a compile finding when minCount > maxCount', () => {
    const doc = buildWorld({
      placementOverrides: { count: 2, autoscale: { minCount: 8, maxCount: 2, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 } },
    })
    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f => f.id.includes('autoscale') || f.message?.includes('minCount'))).toBe(true)
  })

  it('emits a compile finding when count is outside [minCount, maxCount]', () => {
    const doc = buildWorld({
      placementOverrides: { count: 20, autoscale: { minCount: 2, maxCount: 8, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 } },
    })
    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f => f.id.includes('autoscale'))).toBe(true)
  })
  ```

  Adapt `buildWorld(...)`'s shape to this test file's ACTUAL existing world-builder helper and
  `CompileFinding`'s actual field names (`id`/`message` or whatever the real interface uses) — read
  `compileWorld.test.ts`'s existing finding-assertion tests before finalizing.

- [ ] **Step 2: Run to verify they fail**

  Run: `npx vitest run src/lib/world/compileWorld.test.ts -t "autoscale"`
  Expected: FAIL — `autoscale` has no effect yet.

- [ ] **Step 3: Change the expansion loop**

  At `compileWorld.ts:27`, change:

  ```ts
  for (let i = 0; i < pl.count; i++) {
  ```

  to:

  ```ts
  const envelopeCount = pl.autoscale ? pl.autoscale.maxCount : pl.count
  for (let i = 0; i < envelopeCount; i++) {
  ```

- [ ] **Step 4: Add the compile findings**

  In the same placement loop (before or after the expansion, following this file's existing pattern
  for other structural findings — search for how an existing finding, e.g. a firewall or capacity
  compile finding, is pushed), add:

  ```ts
  if (pl.autoscale) {
    if (pl.autoscale.minCount > pl.autoscale.maxCount) {
      findings.push({
        id: `autoscale-invalid-range:${pl.id}`,
        severity: 'error',
        message: `Placement ${pl.id}'s autoscale minCount (${pl.autoscale.minCount}) exceeds maxCount (${pl.autoscale.maxCount})`,
        // ... whatever other fields CompileFinding actually requires, matched to an existing finding literal
      })
    }
    if (pl.count < pl.autoscale.minCount || pl.count > pl.autoscale.maxCount) {
      findings.push({
        id: `autoscale-count-out-of-range:${pl.id}`,
        severity: 'warning',
        message: `Placement ${pl.id}'s authored count (${pl.count}) is outside its autoscale range [${pl.autoscale.minCount}, ${pl.autoscale.maxCount}]`,
      })
    }
  }
  ```

  Match the real `CompileFinding` interface's field names exactly — read it in `world/types.ts`
  before finalizing this snippet.

- [ ] **Step 5: Run to verify they pass, full suite, commit**

  Run: `npx vitest run src/lib/world/compileWorld.test.ts`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green (this WILL surface breakage in any existing test/consumer that assumed
  `compiled.instances`'s cardinality always equals `pl.count` for every placement in the synthetic
  worlds those tests build — none of them author `autoscale`, so none should break; if one does,
  that is a real, useful signal to fix at the source, not to work around).

  ```bash
  git add src/lib/world/compileWorld.ts src/lib/world/compileWorld.test.ts
  git commit -m "feat(world): compile autoscaled placements to their maxCount envelope (FEAT-008)"
  ```

---

## Task 12: Pure `worldEngine/autoscale.ts` — state, running-set resolver, control loop

**Files:**
- Create: `src/lib/worldEngine/autoscale.ts`
- Test: `src/lib/worldEngine/autoscale.test.ts`

**Interfaces:**
- Consumes: `AutoscalePolicy` (Task 10), `CompiledWorld` (existing).
- Produces: `AutoscaleState`, `createAutoscaleState(doc: WorldDoc): AutoscaleState`,
  `runningSetResolver(compiled: CompiledWorld, desiredCount: Map<PlacementId, number>): (instanceId:
  InstanceId) => boolean`, `evaluatePolicy(placement: Placement, observedCpuPercent: number, state:
  AutoscaleState, simMs: number): { next: number; scaled: 'out' | 'in' | null }`. Consumed by
  Task 13 (engine wiring), Task 14 (routing exclusion), Task 16 (metrics publishing).

- [ ] **Step 1: Write the failing tests**

  ```ts
  // src/lib/worldEngine/autoscale.test.ts
  import { describe, it, expect } from 'vitest'
  import { createAutoscaleState, runningSetResolver, evaluatePolicy } from './autoscale'
  import type { CompiledWorld } from '../world/types'

  const policy = {
    minCount: 2, maxCount: 8, targetCpuPercent: 60,
    scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
  }

  describe('createAutoscaleState', () => {
    it('initializes desiredCount to minCount for every autoscaled placement, to count for every static one', () => {
      const doc = {
        placements: {
          p1: { id: 'p1', blueprintId: 'b', serverId: 's', count: 3, role: 'primary', runtime: 'container', autoscale: policy },
          p2: { id: 'p2', blueprintId: 'b', serverId: 's', count: 5, role: 'primary', runtime: 'container' },
        },
      } as any
      const state = createAutoscaleState(doc)
      expect(state.desiredCount.get('p1')).toBe(2) // minCount, not count
      expect(state.desiredCount.get('p2')).toBe(5) // count, unchanged
    })
  })

  describe('runningSetResolver', () => {
    it('fast path: with an empty desiredCount overlay change-set, every compiled instance is running', () => {
      const compiled = { instances: {
        a: { id: 'a', placementId: 'p1', indexInPlacement: 0 },
        b: { id: 'b', placementId: 'p1', indexInPlacement: 1 },
      } } as any
      const desiredCount = new Map([['p1', 2]])
      const resolver = runningSetResolver(compiled, desiredCount)
      expect(resolver('a')).toBe(true)
      expect(resolver('b')).toBe(true)
    })

    it('parks instances whose indexInPlacement >= desiredCount', () => {
      const compiled = { instances: {
        a: { id: 'a', placementId: 'p1', indexInPlacement: 0 },
        b: { id: 'b', placementId: 'p1', indexInPlacement: 1 },
        c: { id: 'c', placementId: 'p1', indexInPlacement: 2 },
      } } as any
      const desiredCount = new Map([['p1', 2]])
      const resolver = runningSetResolver(compiled, desiredCount)
      expect(resolver('a')).toBe(true)
      expect(resolver('b')).toBe(true)
      expect(resolver('c')).toBe(false) // parked -- envelope index 2 >= desired 2
    })
  })

  describe('evaluatePolicy', () => {
    it('scales out when observed CPU exceeds the target, respecting scaleStep', () => {
      const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 2, autoscale: { ...policy, scaleStep: 2 } } } } as any)
      const placement = { id: 'p1', autoscale: { ...policy, scaleStep: 2 } } as any
      // observed 90% against a 60% target -> ratio 1.5 -> proposed = ceil(2 * 1.5) = 3, but scaleStep caps the delta to +2
      const result = evaluatePolicy(placement, 90, state, 0)
      expect(result.scaled).toBe('out')
      expect(result.next).toBeLessThanOrEqual(4) // 2 + scaleStep(2)
      expect(result.next).toBeGreaterThan(2)
    })

    it('does not scale again within scaleUpCooldownSec of the last scale-out', () => {
      const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 2, autoscale: policy } } } as any)
      const placement = { id: 'p1', autoscale: policy } as any
      const first = evaluatePolicy(placement, 90, state, 0)
      expect(first.scaled).toBe('out')
      const second = evaluatePolicy(placement, 95, state, 5_000) // 5s later, well within 30s cooldown
      expect(second.scaled).toBe(null)
      expect(second.next).toBe(first.next)
    })

    it('scales in after scaleDownCooldownSec when observed CPU is below target, never below minCount', () => {
      const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 8, autoscale: { ...policy, minCount: 2, maxCount: 8 } } } } as any)
      state.desiredCount.set('p1', 8)
      const placement = { id: 'p1', autoscale: { ...policy, minCount: 2, maxCount: 8 } } as any
      const result = evaluatePolicy(placement, 10, state, 400_000) // far past any cooldown, CPU well under target
      expect(result.scaled).toBe('in')
      expect(result.next).toBeGreaterThanOrEqual(2)
      expect(result.next).toBeLessThan(8)
    })

    it('never exceeds maxCount or drops below minCount', () => {
      const state = createAutoscaleState({ placements: { p1: { id: 'p1', count: 8, autoscale: policy } } } as any)
      state.desiredCount.set('p1', 8)
      const placement = { id: 'p1', autoscale: policy } as any
      const result = evaluatePolicy(placement, 500, state, 400_000) // absurdly high CPU, would propose way past maxCount
      expect(result.next).toBeLessThanOrEqual(policy.maxCount)
    })
  })
  ```

- [ ] **Step 2: Run to verify they fail**

  Run: `npx vitest run src/lib/worldEngine/autoscale.test.ts`
  Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

  ```ts
  // src/lib/worldEngine/autoscale.ts
  import type { AutoscalePolicy, PlacementId, WorldDoc, Placement } from '../world/types'
  import type { CompiledWorld, InstanceId } from '../world/types'

  export interface AutoscaleState {
    desiredCount: Map<PlacementId, number>
    lastScaleUpAt: Map<PlacementId, number>
    lastScaleDownAt: Map<PlacementId, number>
  }

  export function createAutoscaleState(doc: WorldDoc): AutoscaleState {
    const desiredCount = new Map<PlacementId, number>()
    for (const pl of Object.values(doc.placements)) {
      desiredCount.set(pl.id, pl.autoscale ? pl.autoscale.minCount : pl.count)
    }
    return { desiredCount, lastScaleUpAt: new Map(), lastScaleDownAt: new Map() }
  }

  /**
   * (instanceId) -> is this instance currently in the running set (vs. parked past desiredCount).
   * Mirrors failover.ts's effectiveRoleResolver: a closure built once per desiredCount change,
   * with a fast path when nothing has ever scaled away from the compiled envelope.
   */
  export function runningSetResolver(
    compiled: CompiledWorld,
    desiredCount: Map<PlacementId, number>,
  ): (instanceId: InstanceId) => boolean {
    if (desiredCount.size === 0) return () => true
    return (instanceId: InstanceId) => {
      const inst = compiled.instances[instanceId]
      if (!inst) return false
      const desired = desiredCount.get(inst.placementId)
      if (desired === undefined) return true // not an autoscaled/tracked placement -> always running
      return inst.indexInPlacement < desired
    }
  }

  export function evaluatePolicy(
    placement: Placement,
    observedCpuPercent: number,
    state: AutoscaleState,
    simMs: number,
  ): { next: number; scaled: 'out' | 'in' | null } {
    const policy = placement.autoscale as AutoscalePolicy
    const current = state.desiredCount.get(placement.id) ?? policy.minCount
    const ratio = observedCpuPercent / policy.targetCpuPercent
    const proposedRaw = Math.ceil(current * ratio)
    const clamp = (n: number) => Math.max(policy.minCount, Math.min(policy.maxCount, n))

    if (proposedRaw > current) {
      const lastUp = state.lastScaleUpAt.get(placement.id) ?? -Infinity
      if (simMs - lastUp < policy.scaleUpCooldownSec * 1000) return { next: current, scaled: null }
      const stepped = policy.scaleStep ? Math.min(proposedRaw, current + policy.scaleStep) : proposedRaw
      const next = clamp(stepped)
      if (next === current) return { next, scaled: null }
      state.desiredCount.set(placement.id, next)
      state.lastScaleUpAt.set(placement.id, simMs)
      return { next, scaled: 'out' }
    }

    if (proposedRaw < current) {
      const lastDown = state.lastScaleDownAt.get(placement.id) ?? -Infinity
      if (simMs - lastDown < policy.scaleDownCooldownSec * 1000) return { next: current, scaled: null }
      const stepped = policy.scaleStep ? Math.max(proposedRaw, current - policy.scaleStep) : proposedRaw
      const next = clamp(stepped)
      if (next === current) return { next, scaled: null }
      state.desiredCount.set(placement.id, next)
      state.lastScaleDownAt.set(placement.id, simMs)
      return { next, scaled: 'in' }
    }

    return { next: current, scaled: null }
  }
  ```

  Adjust the exact import paths/type names (`PlacementId`, `InstanceId`, `CompiledWorld`'s
  `indexInPlacement`/`placementId` field names on `ServiceInstance`) to match the real current
  `world/types.ts` — the grounding notes confirm `compileWorld.ts:27`'s literal already sets
  `indexInPlacement: i` and `placementId`, so these field names are correct, but double-check the
  exact type each is declared as (`string` vs. a branded `InstanceId`/`PlacementId`) before finalizing
  imports.

- [ ] **Step 4: Run to verify they pass, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/autoscale.test.ts`
  Expected: PASS, all tests.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/autoscale.ts src/lib/worldEngine/autoscale.test.ts
  git commit -m "feat(engine): pure AutoscaleState/runningSetResolver/evaluatePolicy (FEAT-008)"
  ```

---

## Task 13: Wire `AutoscaleState` into `index.ts` — exclude parked from `InstanceLoad`, run the control loop

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `createAutoscaleState`/`runningSetResolver`/`evaluatePolicy` (Task 12), `warmingUntil`
  (FEAT-007 Task 3).
- Produces: `EngineState.autoscale: AutoscaleState`, `EngineState.runningSet: (instanceId:
  InstanceId) => boolean` (memoized like `roleResolver`, rebuilt only when `desiredCount` changes) —
  consumed by Task 14 (routing exclusion) and Task 16 (metrics publishing).

- [ ] **Step 1: Write the failing test — zero CPU/RAM/cost for parked instances**

  ```ts
  it('AUTOSCALE PARKING: parked instances contribute zero CPU and zero RAM', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 })
    // one server hosting a placement with count:1, autoscale.minCount:1/maxCount:4 -- follow this
    // file's existing world-construction convention; compiled.instances will contain 4 envelope
    // instances but only 1 should be "running" at start
    const compiled = compileWorld(f.doc)
    expect(Object.values(compiled.instances).filter(i => i.placementId === f.placementId).length).toBe(4)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const b = sim.latest()
    const runningInstanceIds = Object.keys(b.instances).filter(id => f.instanceIdsForPlacement.includes(id))
    expect(runningInstanceIds.length).toBe(1) // only desiredCount (minCount=1) instances published
    for (const parkedId of f.instanceIdsForPlacement.slice(1)) {
      expect(b.instances[parkedId]).toBeUndefined() // parked instances omitted from MetricsBatch entirely (Task 16)
    }
  })
  ```

  Note: this test's final assertion (parked instances OMITTED from `MetricsBatch.instances`) depends
  on Task 16's metrics-publishing change, which lands after this task — if run before Task 16 lands,
  expect this specific assertion to fail; keep the test but mark it as covering both tasks, and only
  require it fully green once Task 16 is also complete (this task's own scope is the CPU/RAM
  exclusion inside `InstanceLoad[]`, verifiable independently via the host-level RAM/CPU total, not
  via `MetricsBatch.instances` membership).

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE PARKING"`
  Expected: FAIL (as expected, since neither this task nor Task 16 exist yet).

- [ ] **Step 3: Add `AutoscaleState` and a memoized `runningSet` resolver to `EngineState`**

  In `EngineState` (L302-536), add near `roleResolver`/`roleResolverKey` (L370-371):

  ```ts
  autoscale: AutoscaleState
  runningSet: (instanceId: InstanceId) => boolean
  runningSetKey: string   // memo key, e.g. serialized desiredCount snapshot
  ```

  Import `AutoscaleState`, `createAutoscaleState`, `runningSetResolver`, `evaluatePolicy` from
  `./autoscale`.

  In `start()`'s state literal, initialize:

  ```ts
  autoscale: createAutoscaleState(doc),
  runningSet: () => true,   // rebuilt on first use below
  runningSetKey: '',
  ```

  Add a helper (near wherever `roleResolver` is rebuilt/memoized — follow that exact pattern) that
  rebuilds `s.runningSet` whenever `s.autoscale.desiredCount`'s contents change since the last build
  (a cheap key: join `[...desiredCount.entries()].map(([k,v]) => k+':'+v).join(',')`), called once at
  the top of `runStep` before section 4/5 (host scheduling) reads it.

- [ ] **Step 4: Exclude parked instances when building `InstanceLoad[]`**

  In the host-scheduling section (`// ── 4/5. host scheduling ──`, L1184), wherever the per-server
  `InstanceLoad[]` array is assembled from `instancesOnServer`, filter through `s.runningSet(inst.id)`
  before the array is built — a parked instance contributes no `InstanceLoad` entry at all, which
  `stepHost` already treats as "not present ⇒ zero CPU, zero RAM" for free (no `stepHost` change
  needed; it only ever sees the loads it's handed).

- [ ] **Step 5: Run `evaluatePolicy` on cooldown boundaries**

  Near section 10 (`// ── 10. metrics accumulate ──`, L1860) or section 4/5 (either works since the
  control loop only needs the previous step's observed CPU, which is already available from
  `HostStepResult` by that point in `runStep` — place it wherever the per-server `HostStepResult` is
  already in scope), for every autoscaled placement, compute `observedCpu = mean(cpuCoresUsed /
  vcpuShare)` over that placement's currently-running instances (per the spec's formula), then call
  `evaluatePolicy(placement, observedCpu, s.autoscale, simMs)`. Emit `scale_out`/`scale_in` events
  (Task 17 adds these to `EngineEventKind` — coordinate: land Task 17's type addition first if this
  step needs to compile, or stub the emit as a TODO comment resolved in Task 17; prefer landing
  Task 17's type change first to avoid a broken intermediate commit).

  Guard the entire evaluation loop behind `if (s.autoscale.desiredCount.size === 0) return` — though
  in practice `desiredCount` always has an entry per placement (Task 12's `createAutoscaleState`
  seeds it for every placement, autoscaled or not), so the real fast-path guard should instead check
  "does ANY placement have `autoscale` authored" — build a `hasAnyAutoscale: boolean` flag at
  `start()` (mirroring `hasAnyCache`/`hasAnyDisk`) and guard on that instead.

- [ ] **Step 6: Register newly-unparked instances in FEAT-007's `warmingUntil`**

  When `evaluatePolicy` returns `scaled: 'out'`, for every NEWLY-running instance (the ones whose
  `indexInPlacement` falls between the old and new `desiredCount`), call the same registration Task 3
  established for OOM restarts: `s.warmingUntil.set(instanceId, { startedMs: simMs, coldStartMs })`
  where `coldStartMs` comes from the placement's blueprint's `workload.coldStartMs ?? 0` (skip if 0).
  This is the concrete FEAT-007→FEAT-008 dependency the spec calls out — implement it here, not as a
  follow-up.

- [ ] **Step 7: Run to verify the CPU/RAM exclusion half of the test passes**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE PARKING"`
  Expected: the CPU/RAM assertions pass; the `MetricsBatch.instances` membership assertion still
  fails until Task 16 — acceptable per Step 1's note.

- [ ] **Step 8: Regression floor + full suite + commit**

  ```ts
  it('REGRESSION FLOOR: a placement with no autoscale compiles to exactly count instances and simulates byte-identically', () => {
    const f = crossAzPair()
    const compiled = compileWorld(f.doc)
    const simA = drive(f.doc, compiled); simA.stepFor(30)
    const simB = drive(f.doc, compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
  })
  ```

  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green (this floor test should already pass by construction — `createAutoscaleState`
  sets `desiredCount` to `pl.count` for every non-autoscaled placement, so `runningSet` never parks
  anything in a world with no `autoscale` authored).

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): wire AutoscaleState, exclude parked instances from host load (FEAT-008)"
  ```

---

## Task 14: Exclude parked instances from LB target selection

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `s.runningSet` (Task 13).
- Produces: nothing new consumed by later tasks — closes the "parked instances never receive new
  traffic" requirement.

- [ ] **Step 1: Write the failing test**

  ```ts
  it('AUTOSCALE ROUTING: a parked instance never receives routed traffic', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const b = sim.latest()
    for (const parkedId of f.instanceIdsForPlacement.slice(1)) {
      // whether the batch omits the entry (Task 16) or still includes it, rps must be 0 for any
      // parked instance that IS present in this intermediate state
      const im = (b.instances as any)[parkedId]
      if (im) expect(im.rps).toBe(0)
    }
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE ROUTING"`
  Expected: FAIL — parked instances still receive their fair share of routed traffic.

- [ ] **Step 3: Synthesize a `'down'`-equivalent health result for parked instances at the call site**

  Per the grounding notes, `routingRuntime.ts`'s `distributeToTargets`/`pickInstance` filter targets
  via `healthOfInstance(iid) !== 'down'` — a caller-supplied function, not a file-internal state read.
  Find where `index.ts` constructs the `healthOfInstance` (or equivalently-named) callback passed into
  `routingRuntime.ts`'s functions (in `// ── 3. routing: resolve + build entry demand ──`, L984), and
  wrap it:

  ```ts
  const baseHealthOfInstance = /* existing callback */
  const healthOfInstance = (iid: InstanceId) =>
    s.runningSet(iid) ? baseHealthOfInstance(iid) : 'down'
  ```

  Pass the wrapped version to `routingRuntime.ts`'s functions instead of the base one. This changes
  ZERO lines in `routingRuntime.ts` itself, per the grounding notes' recommended approach.

- [ ] **Step 4: Run to verify it passes, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE"`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): exclude parked instances from LB target selection (FEAT-008)"
  ```

---

## Task 15: Scale-in drain (clone `failover.ts`'s `drainUntil` pattern, instance-keyed)

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `runningSet`/`evaluatePolicy` scale-in result (Task 13).
- Produces: `EngineState.drainUntilByInstance: Map<InstanceId, number>`, plus `beginInstanceDrain`/
  `clearInstanceDrain`/`instanceDrainFactor` helpers (a straight instance-keyed clone of
  `failover.ts`'s `beginDrain`/`clearDrain`/`drainFactor` — same `DRAIN_MS` constant, same formula).
  Consumed by Task 14's routing exclusion (draining ⇒ excluded from NEW traffic, same as parked) and
  by whatever in-flight-connection accounting already respects a fractional serving factor.

- [ ] **Step 1: Write the failing test**

  ```ts
  it('AUTOSCALE DRAIN: a scaled-in instance stops receiving new traffic but its errorRate does not spike', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 4, targetCpuPercent: 10, scaleUpCooldownSec: 1, scaleDownCooldownSec: 1 })
    // targetCpuPercent set absurdly low + tiny cooldowns so a scale-in triggers quickly in the test
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(2) // let it scale out under initial synthetic load if the factory ramps demand, then...
    // (exact drive sequence depends on the factory's demand shape -- the assertion that matters is:)
    sim.stepFor(60) // long enough for at least one scale-in decision under low load
    const b = sim.latest()
    const errorRates = Object.values(b.instances).map((i: any) => i.errorRate)
    expect(Math.max(...errorRates, 0)).toBeLessThan(0.05) // no error spike from an abrupt drop
  })
  ```

- [ ] **Step 2: Run to verify it fails (or passes trivially if the world never scales in during the window — tune the factory's demand curve so a scale-in provably occurs, asserted via a `scale_in` event count > 0 in the same test)**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE DRAIN"`

- [ ] **Step 3: Add the drain map and helper functions**

  In `src/lib/worldEngine/index.ts` (or, to keep parity with `failover.ts`'s file organization, add a
  small exported set of pure functions directly in `autoscale.ts` from Task 12 — prefer this, since it
  keeps `autoscale.ts` the single home for every FEAT-008 pure mechanic):

  ```ts
  // src/lib/worldEngine/autoscale.ts (addition)
  const INSTANCE_DRAIN_MS = 2000   // mirrors failover.ts's DRAIN_MS

  export function beginInstanceDrain(drainUntilByInstance: Map<InstanceId, number>, instanceId: InstanceId, simMs: number): void {
    if (!drainUntilByInstance.has(instanceId)) drainUntilByInstance.set(instanceId, simMs + INSTANCE_DRAIN_MS)
  }

  export function clearInstanceDrain(drainUntilByInstance: Map<InstanceId, number>, instanceId: InstanceId): void {
    drainUntilByInstance.delete(instanceId)
  }

  export function instanceDrainFactor(drainUntilByInstance: Map<InstanceId, number>, instanceId: InstanceId, simMs: number): number {
    const until = drainUntilByInstance.get(instanceId)
    if (until === undefined) return 0
    return Math.max(0, Math.min(1, (until - simMs) / INSTANCE_DRAIN_MS))
  }
  ```

  Add `drainUntilByInstance: Map<InstanceId, number>` to `EngineState`, initialized empty at
  `start()`.

- [ ] **Step 4: Wire it into the scale-in path**

  In Task 13 Step 5's `evaluatePolicy` call site, when `scaled === 'in'`, for every instance that just
  transitioned from running to parked (`oldDesired` → `newDesired`, the instances with
  `newDesired <= indexInPlacement < oldDesired`), call `beginInstanceDrain(s.drainUntilByInstance,
  instanceId, simMs)` INSTEAD of parking it immediately in `s.runningSet` — the instance must remain
  in the running set (still gets an `InstanceLoad` entry, still counted in `MetricsBatch.instances`)
  until its drain completes.

  This means `runningSetResolver`'s pure `indexInPlacement < desired` check (Task 12) is not quite
  sufficient on its own for the DRAINING window — during drain, an instance below the new lower
  `desiredCount` line is still "running" for CPU/RAM/publishing purposes but excluded from NEW
  traffic. Resolve this by having Task 14's `healthOfInstance` wrapper ALSO return `'down'` for any
  instance currently draining (`s.drainUntilByInstance.has(iid)`), independent of `runningSet`:

  ```ts
  const healthOfInstance = (iid: InstanceId) =>
    (!s.runningSet(iid) || s.drainUntilByInstance.has(iid)) ? 'down' : baseHealthOfInstance(iid)
  ```

  And have the periodic cleanup pass (alongside Task 3's `warmingUntil` cleanup, near section 0) also
  clear completed drains and THEN actually park the instance:

  ```ts
  for (const [iid, until] of [...s.drainUntilByInstance]) {
    if (simMs >= until) {
      s.drainUntilByInstance.delete(iid)
      // instance is now genuinely parked -- runningSet's indexInPlacement check already excludes it
      // once desiredCount was lowered; no further action needed here beyond clearing the drain map
    }
  }
  ```

- [ ] **Step 5: Run to verify it passes, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE"`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/autoscale.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): drain scaled-in instances instead of dropping them (FEAT-008)"
  ```

---

## Task 16: Publish `runningByPlacement`, omit parked from `MetricsBatch.instances`, divergence guard

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/metrics.ts`
- Test: `src/lib/worldEngine/index.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Consumes: `s.runningSet` (Task 13).
- Produces: `MetricsBatch.runningByPlacement?: Record<PlacementId, number>` — consumed by Task 17
  (cost model) and Task 20 (UI's desired/running/max readout).

- [ ] **Step 1: Write the failing tests (this completes Task 13/14's deferred assertions)**

  Re-run and extend the "AUTOSCALE PARKING" test from Task 13 Step 1 to assert full omission:

  ```ts
  it('DIVERGENCE GUARD: MetricsBatch.instances contains only running instances, runningByPlacement matches', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 })
    const compiled = compileWorld(f.doc)
    expect(Object.keys(compiled.instances).filter(id => f.instanceIdsForPlacement.includes(id)).length).toBe(4)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const b = sim.latest()
    const publishedForPlacement = Object.keys(b.instances).filter(id => f.instanceIdsForPlacement.includes(id))
    expect(publishedForPlacement.length).toBe((b as any).runningByPlacement[f.placementId])
    expect((b as any).runningByPlacement[f.placementId]).toBe(1) // still at minCount, no load yet to trigger scale-out
  })
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "MetricsBatch.instances contains only running"`
  Expected: FAIL — `MetricsBatch.instances` currently includes every compiled instance regardless of
  running-set membership; `runningByPlacement` doesn't exist.

- [ ] **Step 3: Add `runningByPlacement` to `MetricsBatch`**

  In `src/lib/worldEngine/types.ts`, add to `MetricsBatch` (near `clusters?`, L213):

  ```ts
  runningByPlacement?: Record<PlacementId, number>
  ```

- [ ] **Step 4: Skip parked/draining instances in `buildBatch`'s instances loop, publish the map**

  In `metrics.ts`'s "── Instances ──" loop (L333 onward), at the top of each iteration, skip entirely
  when the instance is not running:

  ```ts
  if (!state.runningSet(inst.id)) continue
  ```

  (A draining instance IS still running per Task 15's design — it keeps its `MetricsBatch` entry
  until the drain completes and it's genuinely parked — so this check alone is correct; draining
  instances are excluded from NEW routing via Task 15's `healthOfInstance` wrapper, not from
  publishing.)

  Build `runningByPlacement` once, guarded by `state.autoscale.desiredCount.size > 0` (which per Task
  12 is always true — reuse the `hasAnyAutoscale` flag from Task 13 Step 5 as the real guard):

  ```ts
  const runningByPlacement: Record<string, number> | undefined = state.hasAnyAutoscale
    ? Object.fromEntries(state.autoscale.desiredCount)
    : undefined
  ```

  This MUST be built from the SAME `state.autoscale.desiredCount` map `runningSetResolver` (used just
  above to filter the loop) reads from — never a re-derived count — so the published number and the
  actual number of published instance entries can never diverge. Attach `runningByPlacement` to the
  returned `MetricsBatch` literal.

- [ ] **Step 5: Log in contract-drift.md**

  Append:

  ```markdown
  ## FEAT-008: Horizontal Autoscaling Policy (Wave 3)
  - Additive: `MetricsBatch.runningByPlacement?: Record<PlacementId, number>` — published from the
    same `state.autoscale.desiredCount` map `runningSetResolver` filters `MetricsBatch.instances`
    with. No signature break.
  - Semantic (not type) break, sanctioned by the spec: for an autoscaled placement,
    `compiled.instances` is now an envelope (`maxCount` entries) rather than the running set;
    `MetricsBatch.instances` is the running subset. Non-autoscaled placements are unaffected.
  ```

- [ ] **Step 6: Run to verify the tests pass, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE"`
  Expected: PASS, including Task 13's deferred assertion.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): publish runningByPlacement, omit parked instances from MetricsBatch (FEAT-008)"
  ```

---

## Task 17: `scale_out`/`scale_in`/`autoscale_ceiling` events

**Files:**
- Modify: `src/lib/worldEngine/types.ts`
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Consumes: `evaluatePolicy`'s return value (Task 13 Step 5).
- Produces: three new `EngineEventKind` variants.

- [ ] **Step 1: Write the failing test**

  ```ts
  it('emits scale_out when a placement scales up under sustained load', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 4, targetCpuPercent: 20, scaleUpCooldownSec: 1, scaleDownCooldownSec: 300 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(10) // enough for at least one evaluation past the 1s cooldown under saturating load
    expect(sim.eventsSoFar().filter((e: any) => e.kind === 'scale_out').length).toBeGreaterThan(0)
  })

  it('emits autoscale_ceiling when sustained overload holds the placement at maxCount', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 2, targetCpuPercent: 5, scaleUpCooldownSec: 1, scaleDownCooldownSec: 300 })
    // maxCount deliberately tiny + target deliberately low so saturation is guaranteed even at maxCount
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(15)
    expect(sim.eventsSoFar().filter((e: any) => e.kind === 'autoscale_ceiling').length).toBeGreaterThan(0)
  })
  ```

- [ ] **Step 2: Run to verify they fail**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "scale_out"`
  Expected: FAIL — event kinds don't exist.

- [ ] **Step 3: Add the event kinds**

  In `src/lib/worldEngine/types.ts`, append to `EngineEventKind` (after FEAT-007's
  `'instance_warm'`):

  ```ts
  | 'scale_out' | 'scale_in' | 'autoscale_ceiling'
  ```

- [ ] **Step 4: Emit them in `index.ts`**

  At Task 13 Step 5's `evaluatePolicy` call site, emit `scale_out`/`scale_in` when `result.scaled` is
  non-null. Emit `autoscale_ceiling` when `result.scaled === null` AND `current === policy.maxCount`
  AND the proposed ratio was still `> 1` (i.e., the policy WANTED to scale out further but is pinned
  at the ceiling) — rate-limit this one the same way other sustained-condition events in this file
  already are (grep for an existing rate-limit map like `s.refusedRateLimit`/
  `s.diskSaturatedRateLimit` and clone that pattern, don't emit every single step).

- [ ] **Step 5: Run to verify they pass, log contract-drift, full suite, commit**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "scale_out"`
  Expected: PASS.

  Append the three event kinds to `.superpowers/sdd/contract-drift.md` under the FEAT-008 heading
  from Task 16.

  Run: `npx tsc --noEmit && npx vitest run`

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): emit scale_out/scale_in/autoscale_ceiling events (FEAT-008)"
  ```

---

## Task 18: `costModelV2.ts` — apportioned per-server cost by running-instance share

**Files:**
- Modify: `src/lib/costModelV2.ts`
- Test: `src/lib/costModelV2.test.ts` (check for an existing file before creating one)

**Interfaces:**
- Consumes: `MetricsBatch.runningByPlacement?` (Task 16).
- Produces: `computeWorldCost` gains an updated behavior when `world?.runningByPlacement` is present
  — consumed by nothing further (terminal for the cost model), but Task 20's UI reads
  `computeWorldCost`'s output directly.

  **Design note (read before implementing — this deviates from the spec's literal Task 10 wording,
  for the reason recorded in the Grounding notes):** the spec says "have `computeWorldCost` prefer
  `runningByPlacement` over `Placement.count` when present," which assumes cost already scales with
  instance count. It does not — `computeWorldCost` bills a flat `server.hourlyUsd` per server,
  independent of how many instances are packed onto it (confirmed: `costModelV2.ts:204-210` iterates
  `doc.servers`, never `doc.placements`). Making autoscaling move the cost number therefore requires
  a genuinely new apportionment step, not a `count`→`runningByPlacement` substitution. The scheme
  below is additive and byte-identical when no placement on a server is autoscaled:

  For each server, gather its resident placements (via `doc.placements` filtered by `serverId ===
  server.id`). If NONE of them carry `autoscale`, bill `server.hourlyUsd` in full, exactly as today
  (this is the regression floor — the common case, and every existing test's synthetic worlds).
  If ANY of them do, and `world.runningByPlacement` is present, apportion `server.hourlyUsd` across
  the server's resident placements in proportion to each placement's **running share of its own
  envelope** — `runningByPlacement[pl.id] ?? pl.count` for an autoscaled placement, `pl.count` for a
  static one — normalized so a server hosting only fully-scaled-out autoscaled placements (or only
  static ones) still bills its full `hourlyUsd`, while a server whose autoscaled placement has scaled
  down bills proportionally less. Concretely: `serverBilledFraction = sum(placementRunningWeight) /
  sum(placementMaxWeight)`, where `placementMaxWeight` is `pl.autoscale ? pl.autoscale.maxCount :
  pl.count` (the same envelope `compileWorld` now expands to) and `placementRunningWeight` is
  `runningByPlacement[pl.id] ?? pl.count`. This makes a server hosting exactly one autoscaled
  placement bill `hourlyUsd × (running/maxCount)` — the direct FinOps signal the spec wants — while a
  server hosting a mix of static and autoscaled placements bills somewhere between (a static
  placement's own weight never shrinks, so it acts as a cost floor for that server, which is the
  physically honest outcome: the static workload's reserved capacity is paid for regardless).

- [ ] **Step 1: Write the failing tests**

  ```ts
  // src/lib/costModelV2.test.ts
  it('REGRESSION FLOOR: a server with no autoscaled placement bills its full hourlyUsd regardless of runningByPlacement', () => {
    const doc = buildDocWithOneServerOnePlacement({ hourlyUsd: 10, count: 3 }) // no autoscale
    const world = { runningByPlacement: { 'the-placement-id': 1 } } as any // present but irrelevant
    const result = computeWorldCost(doc, world, null)
    expect(result.monthlyUsd).toBeCloseTo(10 * HOURS_PER_MONTH, 2)
  })

  it('apportions a server hosting one fully-autoscaled placement by running/maxCount', () => {
    const doc = buildDocWithOneServerOnePlacement({ hourlyUsd: 10, count: 4, autoscale: { minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 } })
    const placementId = Object.keys(doc.placements)[0]
    const world = { runningByPlacement: { [placementId]: 1 } } as any // scaled down to minCount
    const result = computeWorldCost(doc, world, null)
    expect(result.monthlyUsd).toBeCloseTo(10 * HOURS_PER_MONTH * (1 / 4), 1)
  })

  it('with no metrics (pre-run state), bills the full server cost using count/maxCount as the fallback ratio', () => {
    const doc = buildDocWithOneServerOnePlacement({ hourlyUsd: 10, count: 2, autoscale: { minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 } })
    const result = computeWorldCost(doc, null, null) // Cost tab renders before a run starts
    expect(result.monthlyUsd).toBeCloseTo(10 * HOURS_PER_MONTH * (2 / 4), 1) // uses authored count, not minCount
  })
  ```

  Write `buildDocWithOneServerOnePlacement(opts)` following this test file's existing world-builder
  convention (or `costModelV2.ts`'s existing test doc helper if one already exists — check before
  writing a new one). `HOURS_PER_MONTH` is the existing exported/internal constant this file already
  uses (confirm its actual name/location before importing it into the test).

- [ ] **Step 2: Run to verify they fail**

  Run: `npx vitest run src/lib/costModelV2.test.ts -t "REGRESSION FLOOR"`
  Run: `npx vitest run src/lib/costModelV2.test.ts -t "apportions"`
  Expected: the apportionment tests FAIL (today's flat billing ignores `autoscale`/`runningByPlacement`
  entirely); the regression-floor test may already trivially PASS (nothing changed yet) — that's fine,
  it must stay green through the rest of this task.

- [ ] **Step 3: Implement the apportionment in `computeWorldCost`**

  In `src/lib/costModelV2.ts`, replace the flat per-server loop (L204-210,
  `for (const server of Object.values(doc.servers)) { const usd = server.hourlyUsd * HOURS_PER_MONTH;
  computeTotal += usd; ... }`) with:

  ```ts
  const placementsByServer = new Map<ServerId, Placement[]>()
  for (const pl of Object.values(doc.placements)) {
    const list = placementsByServer.get(pl.serverId) ?? []
    list.push(pl)
    placementsByServer.set(pl.serverId, list)
  }

  for (const server of Object.values(doc.servers)) {
    const residents = placementsByServer.get(server.id) ?? []
    const anyAutoscaled = residents.some(pl => pl.autoscale)
    let billedFraction = 1
    if (anyAutoscaled) {
      let runningWeight = 0
      let maxWeight = 0
      for (const pl of residents) {
        const maxW = pl.autoscale ? pl.autoscale.maxCount : pl.count
        const runningW = pl.autoscale
          ? (world?.runningByPlacement?.[pl.id] ?? pl.count) // pl.count fallback = pre-run authored count
          : pl.count
        maxWeight += maxW
        runningWeight += runningW
      }
      billedFraction = maxWeight > 0 ? runningWeight / maxWeight : 1
    }
    const usd = server.hourlyUsd * HOURS_PER_MONTH * billedFraction
    computeTotal += usd
    // ... preserve whatever per-region/per-az breakdown accumulation already follows this line,
    // scaled by the same billedFraction
  }
  ```

  Read the ACTUAL surrounding code at L189-278 before finalizing — confirm the exact variable names
  (`computeTotal`, any `byRegion`/`byAz` accumulator objects that also need the `billedFraction`
  scaling applied so the breakdown sums back to the new total) and `ServerId`/`Placement` import
  availability in this file.

- [ ] **Step 4: Run to verify they pass, full suite, commit**

  Run: `npx vitest run src/lib/costModelV2.test.ts`
  Expected: PASS, all three.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green (confirm no other test asserts an exact `monthlyUsd` for a world that
  happens to author `autoscale` without expecting this apportionment — none should, since this is
  wave-3-new).

  ```bash
  git add src/lib/costModelV2.ts src/lib/costModelV2.test.ts
  git commit -m "feat(cost): apportion server cost by running-instance share for autoscaled placements (FEAT-008)"
  ```

---

## Task 19: Consumer audit — classify every `compiled.instances` reader as "running" or "possible"

**Files:**
- Modify: `src/lib/analysis/rules/structural.ts`
- Modify: `src/lib/analysis/rules/network.ts`
- Modify: `src/lib/analysis/rules/capacity.ts`
- Modify: `src/app/world/az/floorData.ts`
- Modify: `src/app/world/az/DatacenterFloor.tsx`
- Modify: `src/lib/world/connections.ts`
- Modify: `src/app/world/ai/../aiChat/context.ts` (i.e. `src/lib/aiChat/context.ts` — confirm the
  real path via Grep before editing; the grounding notes' item 12 table used a relative shorthand)
- Modify: `src/app/world/entityNav.ts`
- Read (audit only, likely no change needed): every other file in the 48-file grep list from the
  Grounding notes that is NOT one of the eight above

**Interfaces:**
- Consumes: `s.runningSet` is engine-internal (Task 13) — UI-layer / analysis-layer consumers instead
  receive the running set implicitly via `MetricsBatch.instances`'s membership (Task 16 already
  omits parked instances there) or explicitly via a new exported helper if a consumer needs to reason
  about "running vs possible" from `compiled` + `lastBatch` alone (see Step 2).
- Produces: a documented classification (recorded in the PR/task report, per the spec's explicit
  instruction to "list the outcome of this audit") plus the actual code changes for any file
  classified "must route through the running set."

  **This task's real deliverable is the classification table below, verified against the live code,
  plus the fixes it implies.** The spec calls this "the feature's main risk surface" — do not treat it
  as a checkbox formality.

- [ ] **Step 1: Establish the two ways a UI/analysis consumer learns "is this instance running"**

  There is no free-standing `isRunning(instanceId)` export from the engine (the resolver lives inside
  `EngineState`, which is engine-private). Downstream consumers have exactly two legitimate signals:
  (a) **membership in the latest `MetricsBatch.instances`** — the correct signal for anything that
  means "currently running" (a live dashboard, a health rollup, a cost estimate driven off live
  metrics); (b) **iterating `compiled.instances` directly** — the correct signal for anything that
  means "structurally possible" (capacity planning against the authored ceiling, the topology graph
  showing what COULD run, firewall/network-isolation structural analysis that must hold for every
  potential instance regardless of current scale). A file needs a code change only if it currently
  does (b) while semantically meaning (a).

- [ ] **Step 2: Classify and fix `analysis/rules/{structural,network,capacity}.ts`**

  For each of the three rule files, read every rule that iterates `compiled.instances`
  (structural.ts: 9 matches; network.ts: 7; capacity.ts: 5, per the grounding grep) and classify:

  - Rules checking **structural** properties (firewall exposure, network isolation, SPOF topology,
    dependency-path existence) mean "possible" — iterate `compiled.instances` unchanged, since a
    structural defect exists whether or not that instance happens to be running right now (e.g. an
    exposed-database finding on a parked replica is still worth surfacing once it scales back out).
  - Rules checking **live capacity/load** (RAM oversubscription, burstable credit exhaustion,
    consumer lag, IOPS saturation, cache-miss-storm, replication-lag-exceeds-rpo — every rule reading
    `lastBatch.instances[id]` for a metric value) already implicitly mean "running," because
    `lastBatch.instances` (Task 16) no longer contains parked entries — **these rules need NO code
    change**, since a parked instance's absence from `lastBatch.instances` already makes `lastBatch
    .instances[inst.id]` come back `undefined`, and every such rule already guards on that (`if
    (observed == null) continue`, confirmed pattern from FEAT-004/005/006's rules).
  - Add ONE new rule pair per the spec: `autoscale-ceiling-reached` and `autoscale-thrash` (built out
    fully in Task 20 below, not here — this step is audit + fixing pre-existing rules only).

  Fix any rule found actually broken by the envelope-vs-running split (e.g. a rule that counts
  `compiled.instances` per blueprint to assert "at least N replicas for HA" would now overcount an
  autoscaled placement's parked capacity as if it were live replication — if found, gate that specific
  rule's count on `lastBatch.instances` membership instead of raw `compiled.instances`).

- [ ] **Step 3: Classify and fix `az/floorData.ts` + `az/DatacenterFloor.tsx`**

  The datacenter floor renders physical rack occupancy — this is fundamentally a "possible" view (it
  shows the server's provisioned slots), BUT the per-instance LED/service-chip state it draws for each
  occupied slot must reflect whether that specific envelope slot is currently running, warming,
  draining, or parked. Read `floorData.ts`'s single `compiled.instances` match and `DatacenterFloor
  .tsx`'s single match: if the floor iterates `compiled.instances` to decide WHICH slots to render
  (structural — correct, keep), but reads warmth/health/rps FROM the live `MetricsBatch` for each
  rendered instance already (the existing FEAT-007 Task 8 wiring already does this per-instance
  lookup), then a parked instance simply renders with whatever "no live data" fallback state the floor
  already uses for an instance that hasn't reported yet (e.g. at `simMs === 0` before the first batch)
  — add a distinct "parked" visual treatment (dim/hatched, distinguishable from both healthy and
  killed) if no such fallback treatment already reads as "parked" cleanly; otherwise no change needed
  beyond confirming the existing fallback is not misleading (e.g. it must not render as "dead/killed,"
  which would conflate operator-triggered chaos with normal elastic scale-in).

- [ ] **Step 4: Classify and fix `world/connections.ts`**

  This module resolves the Connections graph's structural dependency edges between blueprints/
  instances — a "possible" concern (the graph shows what CAN connect, authored topology, independent
  of current scale). Read its 4 `compiled.instances` matches; if any of them aggregate a LIVE quantity
  (e.g. summing live rps across all instances of a blueprint for an edge's displayed throughput) rather
  than pure structure, that aggregation must instead read from `lastBatch.instances` (or accept
  `undefined`/0 for a fully-parked placement) — audit and fix only if found; if all 4 matches are pure
  topology (edge existence, port/protocol resolution), no change is needed.

- [ ] **Step 5: Classify and fix `aiChat/context.ts`, `entityNav.ts`**

  `aiChat/context.ts`'s 1 match: the AI chat's world-context digest should describe the RUNNING state
  the user is actually looking at (an LLM narrating "you have 8 instances of X" when only 2 are
  currently running would mislead the model and the user) — if this match builds a live-state summary,
  route it through `lastBatch.instances`; if it's describing authored topology, leave it.
  `entityNav.ts`'s 2 matches: this file resolves "what entity does this id refer to, for navigation
  purposes" (e.g. clicking an affected-entity chip) — this is correctly a "possible" lookup, since a
  user must be able to navigate to a parked instance's detail view to see WHY it's parked; no change
  needed unless a match is actually computing a live aggregate rather than an existence lookup.

- [ ] **Step 6: Spot-check the remaining files from the 48-file grep list**

  For every file in the Grounding notes' full list NOT already covered above or in Tasks 13-16
  (`worldEngine/index.ts`, `flows.ts`, `failover.ts`, `metrics.ts` are the engine-internal ones
  already handled by Tasks 13-16's wiring), skim its `compiled.instances` usage and note in the task
  report whether it's a "possible" (topology/authoring) or "running" (live dashboard) consumer. Fix
  only files found genuinely broken by the split — do not preemptively rewrite files whose current
  behavior is already correct for their actual semantic meaning. Pay particular attention to
  `app/world/region/regionData.ts` (8 matches, the heaviest UI consumer after the floor) and
  `app/world/server/boardLayout.ts` (6 matches) since both plausibly render live per-instance state.

- [ ] **Step 7: Write regression tests for any fix made in Steps 2-6**

  For each file where Steps 2-6 identified and fixed a genuine "running vs possible" bug, add a
  targeted test in that file's existing test suite proving the fix (e.g. "a parked instance is
  excluded from the live rps sum on its Connections edge" for `connections.ts`, if that fix was
  needed). If no file needed a fix beyond the three explicitly built in Tasks 13/14/16, state that
  finding plainly in the task report — a clean audit is a valid, complete outcome, not a shortcut.

- [ ] **Step 8: Full suite, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add -A
  git commit -m "fix(audit): route compiled.instances consumers through the running set where semantically required (FEAT-008)"
  ```

  (If Steps 2-6 found nothing to fix, this commit may be a no-op beyond the task report — in that
  case, record the audit finding in `.superpowers/sdd/wave3-elasticity/progress.md`'s Task 19 ledger
  entry instead of creating an empty commit.)

---

## Task 20: `autoscale-ceiling-reached` and `autoscale-thrash` analysis rules

**Files:**
- Modify: `src/lib/analysis/rules/capacity.ts`
- Test: `src/lib/analysis/rules/capacity.test.ts`

**Interfaces:**
- Consumes: `MetricsBatch.runningByPlacement?` (Task 16), `autoscale_ceiling` events (Task 17) or
  `AutoscaleState`'s scale-direction history (whichever is actually accessible from an
  `AnalysisRule`'s `{ doc, compiled, lastBatch }` context — analysis rules do NOT have direct access
  to engine-internal `AutoscaleState`, only to `doc`/`compiled`/the latest `MetricsBatch`, so
  `autoscale-thrash` needs a different signal than raw state history; see Step 3).
- Produces: two rules appended to `capacityRules`.

- [ ] **Step 1: Write the failing tests**

  ```ts
  it('autoscale-ceiling-reached fires when a placement sits at maxCount while its instances are above target CPU', () => {
    const ctx = buildAutoscaleCeilingFixture({ maxCount: 4, runningCount: 4, targetCpuPercent: 60, observedCpuPercent: 90 })
    // fixture: doc has one placement with autoscale.maxCount:4, lastBatch.runningByPlacement reports 4
    // running, and lastBatch.servers/instances report >90% CPU utilization for those instances
    const findings = autoscaleCeilingReached.run(ctx)
    expect(findings.length).toBe(1)
  })

  it('does not fire when running below maxCount', () => {
    const ctx = buildAutoscaleCeilingFixture({ maxCount: 4, runningCount: 2, targetCpuPercent: 60, observedCpuPercent: 90 })
    expect(autoscaleCeilingReached.run(ctx).length).toBe(0)
  })

  it('autoscale-thrash fires when activeFaultCount-independent scale event churn exceeds N in the recent event window', () => {
    const ctx = buildAutoscaleThrashFixture({ recentScaleEvents: 6 }) // e.g. 6 scale_out/scale_in in the tracer window
    expect(autoscaleThrash.run(ctx).length).toBe(1)
  })
  ```

  Follow `analysis/rules/capacity.test.ts`'s existing fixture-building convention (the closest
  precedent is `iopsSaturated`'s own test, per the grounding notes).

- [ ] **Step 2: Run to verify they fail**

  Run: `npx vitest run src/lib/analysis/rules/capacity.test.ts -t "autoscale"`
  Expected: FAIL — rules don't exist.

- [ ] **Step 3: Confirm what signal `autoscale-thrash` actually has available**

  Before implementing, read `AnalysisRule`'s context type (`{ doc, compiled, lastBatch }`, confirmed
  by every existing rule's signature) and confirm whether `lastBatch` (a single `MetricsBatch`) or
  some ambient recent-events list is available to an analysis rule. If analysis rules have no access
  to a rolling event window (likely — `MetricsBatch` is a single 1 Hz snapshot, not a history), the
  spec's "fires when `desiredCount` changes direction more than N times in a window" needs a
  different implementation: either (a) thread a small rolling scale-event counter into
  `MetricsBatch` itself (an additive field, e.g. `MetricsBatch.recentScaleEventCount?: Record
  <PlacementId, number>`, maintained engine-side over a fixed trailing window and published each
  batch — mirroring how `activeFaultCount` is already a batch-level rollup of engine-side state), or
  (b) scope `autoscale-thrash` down to what IS observable from a single batch (e.g. "desiredCount
  is below maxCount but above minCount AND running below target" as a thrash-adjacent proxy — weaker,
  but honest about the real constraint). **Prefer (a)**: it is a small, additive, single-purpose
  counter that follows the exact precedent `activeFaultCount` already set, and gives the rule the
  literal signal the spec describes rather than a proxy. Implement (a):

  In `EngineState`, add `scaleEventHistory: Map<PlacementId, number[]>` (a bounded ring of recent
  scale-event `simMs` timestamps per placement, trimmed to the last 5 minutes each time an event is
  recorded — mirror whatever bounded-history pattern the existing event ring (`s.events`) already
  uses for its own trimming). At each `scale_out`/`scale_in` emission (Task 17), push `simMs` into
  the placement's history and trim entries older than 5 minutes. In `metrics.ts`'s `buildBatch`,
  publish `recentScaleEventCount: Record<PlacementId, number>` (the trimmed array's length per
  placement) as an additive `MetricsBatch` field, guarded by `hasAnyAutoscale`.

- [ ] **Step 4: Implement both rules**

  In `src/lib/analysis/rules/capacity.ts`, mirroring `iopsSaturated`'s per-placement grouping shape
  (L254-294):

  ```ts
  const autoscaleCeilingReached: AnalysisRule = {
    id: 'autoscale-ceiling-reached', family: 'capacity',
    run: ({ doc, lastBatch }) => {
      if (!lastBatch?.runningByPlacement) return []
      const findings: AnalysisFinding[] = []
      for (const pl of Object.values(doc.placements)) {
        if (!pl.autoscale) continue
        const running = lastBatch.runningByPlacement[pl.id]
        if (running == null || running < pl.autoscale.maxCount) continue
        // reuse whichever existing per-server/per-instance CPU-utilization read iopsSaturated uses
        // to decide "above target" -- do not re-derive a capacity fraction here
        const aboveTarget = /* existing capacity-check helper, mirroring iopsSaturated's pattern */ false
        if (!aboveTarget) continue
        findings.push({
          id: `autoscale-ceiling-reached:${pl.id}`,
          rule: 'autoscale-ceiling-reached',
          severity: 'warning',
          message: `Placement ${pl.id} is pinned at its autoscale ceiling (${pl.autoscale.maxCount}) and still above its CPU target — no runway left`,
          affectedEntities: [],
        })
      }
      return findings
    },
  }

  const autoscaleThrash: AnalysisRule = {
    id: 'autoscale-thrash', family: 'capacity',
    run: ({ doc, lastBatch }) => {
      if (!lastBatch?.recentScaleEventCount) return []
      const THRASH_THRESHOLD = 4
      const findings: AnalysisFinding[] = []
      for (const pl of Object.values(doc.placements)) {
        if (!pl.autoscale) continue
        const count = lastBatch.recentScaleEventCount[pl.id] ?? 0
        if (count < THRASH_THRESHOLD) continue
        findings.push({
          id: `autoscale-thrash:${pl.id}`,
          rule: 'autoscale-thrash',
          severity: 'warning',
          message: `Placement ${pl.id} has scaled ${count} times in the last 5 minutes — its cooldowns may be too tight for this load pattern`,
          affectedEntities: [],
        })
      }
      return findings
    },
  }
  ```

  Match the real `AnalysisRule`/`AnalysisFinding` field names exactly (read an existing rule's
  literal before finalizing). Add both to the `capacityRules` array export (L296-298).

- [ ] **Step 5: Run to verify they pass, full suite, commit**

  Run: `npx vitest run src/lib/analysis/rules/capacity.test.ts`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/lib/worldEngine/metrics.ts src/lib/analysis/rules/capacity.ts src/lib/analysis/rules/capacity.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(analysis): add autoscale-ceiling-reached and autoscale-thrash rules (FEAT-008)"
  ```

---

## Task 21: Author the policy in the placement drawer + live desired/running/max readout + scale marker

**Files:**
- Modify: `src/app/world/dock/drawers/` (the placement drawer — locate via Grep for `Placement.count`
  authoring, likely `PlacementDrawer.tsx` or similar; confirm exact filename before editing)
- Modify: the placement's dock row (wherever the placement summary is listed — same directory)
- Modify: `src/app/world/region/` (the region timeline component — likely `TimelineV2.tsx`, per the
  Grounding notes' description of the failover timeline; confirm before editing)

**Interfaces:**
- Consumes: `AutoscalePolicy` (Task 10), `MetricsBatch.runningByPlacement?` (Task 16), `scale_out`/
  `scale_in` events (Task 17).
- Produces: nothing consumed by later tasks — terminal UI task for FEAT-008.

- [ ] **Step 1: Author `AutoscalePolicy` fields in the placement drawer**

  Locate the placement authoring surface via Grep for `Placement`'s `count` field being edited. Add a
  toggle ("static count" vs "autoscale") and, when autoscale is selected, five numeric inputs
  (`minCount`, `maxCount`, `targetCpuPercent`, `scaleUpCooldownSec`, `scaleDownCooldownSec`) plus an
  optional `scaleStep`. Follow the file's existing draft-state update pattern. Per the edit-lock law,
  this entire drawer section is disabled while running.

- [ ] **Step 2: Live `desired / running / max` readout on the placement's dock row**

  When `lastBatch.runningByPlacement?.[pl.id] != null` and `pl.autoscale` is set, render
  `desiredCount / runningCount / maxCount` (in this simulator's design, `desiredCount ===
  runningByPlacement[pl.id]` except during an in-flight drain window, where running still includes
  the draining instance briefly — render the drain state distinctly if visible, e.g. a small
  "draining" suffix) using `var(--color-*)` tokens, updated off the 1 Hz batch.

- [ ] **Step 3: Scale marker on the region timeline**

  In the region timeline component, render a small marker at each `scale_out`/`scale_in` event's
  `simMs` (mirroring however existing event markers, e.g. `fault_injected`/`oom_kill`, are already
  rendered on this timeline — reuse that exact marker-rendering path, do not add a second one),
  distinguishing scale-out from scale-in (e.g. an up vs. down glyph from the approved glyph set).

- [ ] **Step 4: Live smoke test**

  Run `npm run tauri dev`. Author an autoscaled placement (minCount 1, maxCount 4, targetCpuPercent
  60), load or author a Black Friday-style demand ramp if FEAT-003's scenario system is available in
  this build (skip if not — a manually-authored high-rps population is sufficient), run the sim, and
  confirm: the desired/running/max readout climbs under load, new instances appear cold (dim/ramping)
  on the server board per FEAT-007's Task 8 UI, the region timeline shows scale markers, and the Cost
  tab's number moves as the fleet grows and shrinks. Verify in both themes. Confirm zero new console
  errors.

- [ ] **Step 5: Full suite, build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`
  Expected: all green.

  ```bash
  git add -A
  git commit -m "feat(ui): author AutoscalePolicy, live desired/running/max readout, scale markers (FEAT-008)"
  ```

---

## Task 22: FEAT-008 bench, asymmetry/cold-start-interaction tests, wave-close checks

**Files:**
- Read: `bench/enginePerf.bench.test.ts`
- Modify: `docs/module-boundaries.md`

- [ ] **Step 1: Write the asymmetry test (proves `scaleDownCooldownSec` is a real, independent knob)**

  ```ts
  it('AUTOSCALE ASYMMETRY: a shorter scaleDownCooldownSec produces more scale events under oscillating load than a longer one', () => {
    const tightPolicy = { minCount: 1, maxCount: 6, targetCpuPercent: 50, scaleUpCooldownSec: 10, scaleDownCooldownSec: 20 }
    const loosePolicy = { minCount: 1, maxCount: 6, targetCpuPercent: 50, scaleUpCooldownSec: 10, scaleDownCooldownSec: 300 }
    const runWith = (policy: typeof tightPolicy) => {
      const f = oscillatingLoadAutoscaledWorld(policy) // demand alternates high/low every ~15s
      const compiled = compileWorld(f.doc)
      const sim = drive(f.doc, compiled)
      sim.stepFor(120)
      return sim.eventsSoFar().filter((e: any) => e.kind === 'scale_in' || e.kind === 'scale_out').length
    }
    const tightCount = runWith(tightPolicy)
    const looseCount = runWith(loosePolicy)
    expect(tightCount).toBeGreaterThan(looseCount)
  })
  ```

  Write `oscillatingLoadAutoscaledWorld(policy)` as a small local factory producing a population
  whose demand curve genuinely oscillates on a ~15s period (e.g. a `custom` diurnal curve if FEAT-003
  landed and is usable from `worldEngine` tests directly, or a manually-stepped demand override via
  whatever test-only demand-injection hook `index.test.ts` already uses elsewhere in the file — check
  for one before inventing a new mechanism).

- [ ] **Step 2: Write the cold-start-interaction test**

  ```ts
  it('AUTOSCALE + COLD START INTERACTION: a scale-out event does not reduce p99 for ~coldStartMs, and the autoscaler may over-provision in the interim', () => {
    const f = autoscaledPlacementWorld({ minCount: 1, maxCount: 6, targetCpuPercent: 50, scaleUpCooldownSec: 5, scaleDownCooldownSec: 300, coldStartMs: 60_000 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5) // baseline
    // apply a sudden load spike (however this file's existing demand-spike tests trigger one)
    sim.stepFor(1)
    const p99AtSpike = sim.latest().instances[f.instanceIdsForPlacement[0]].p99Ms
    sim.stepFor(10) // well within coldStartMs=60s, after at least one scale_out has fired
    const p99At10s = sim.latest().instances[f.instanceIdsForPlacement[0]].p99Ms
    expect(sim.eventsSoFar().some((e: any) => e.kind === 'scale_out')).toBe(true)
    expect(p99At10s).toBeGreaterThan(p99AtSpike * 0.7) // has NOT meaningfully recovered yet -- new capacity is still cold
  })
  ```

- [ ] **Step 3: Run both, full suite**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "AUTOSCALE"`
  Expected: PASS.
  Run: `npx tsc --noEmit && npx vitest run`
  Expected: clean / green.

- [ ] **Step 4: Run the perf bench at a realistic `maxCount` envelope**

  Extend (or confirm) `bench/enginePerf.bench.test.ts`'s synthetic world includes at least one
  autoscaled placement with a `maxCount` several times its `minCount`, so the bench measures the
  ~2,000-instance envelope's real cost, not an artificially small `minCount`-only world (per the
  spec's explicit warning: "Note that `maxCount` envelopes make `compiled` larger, so bench with a
  realistic envelope, not with `minCount`"). If the existing bench world authors no `autoscale` at
  all, add one placement's worth, keeping total instance count within the file's existing
  `1800 < n <= 2000` assertion band (adjust other placements' counts down to compensate if needed).

  Run: `npm run bench`
  Expected: median step time delta < 0.1 ms/step versus the pre-Wave-3 baseline; 0 ms delta if the
  bench world is left with no `autoscale` authored (confirms the `hasAnyAutoscale` fast path).

- [ ] **Step 5: Update module-boundaries.md with the real FEAT-008 file list + consumer-audit summary**

  Replace Task 0's FEAT-008 placeholder note with a real description: `autoscale.ts`'s exports and
  its two call sites (`index.ts`'s host-scheduling exclusion + routing exclusion, `metrics.ts`'s
  publish), the compile-time envelope change (`compileWorld.ts:27`), the cost apportionment scheme
  (`costModelV2.ts`), and a condensed version of Task 19's consumer-audit findings (which files were
  changed, which were confirmed already-correct as "possible" consumers).

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/worldEngine/index.test.ts bench/enginePerf.bench.test.ts docs/module-boundaries.md
  git commit -m "test(engine): autoscale asymmetry + cold-start interaction tests; docs: close out Wave 3 (FEAT-007/008)"
  ```

---
