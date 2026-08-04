# Contract Drift Log

## 2026-08-01 — Fault injection (FEAT-001)

`setOutage(scope, id, down: boolean)` on `WorldEngineApi` is superseded by `setFault(scope, id, spec: FaultSpec | null)`. `setOutage` survives as a documented alias implemented in terms of `setFault`. New `FaultKind`/`FaultSpec`/`FaultScope` types added. New `EngineEventKind` members `fault_injected`/`fault_cleared` added.

## 2026-08-01 — Task 7: `MetricsBatch.activeFaultCount`

Added `activeFaultCount?: number` to `MetricsBatch` (additive-optional, `worldEngine/types.ts`) — the count of currently-active operator-injected faults (`FaultState.active.size`), populated by `buildBatch`'s new trailing optional parameter and threaded from `index.ts`'s `s.faults.active.size` at the sole `buildBatch` call site. Backs the new `fault-injected` capacity analysis rule (`src/lib/analysis/rules/capacity.ts`), which fires an info-severity finding so operators can tell deliberately-injected degradation apart from an architectural finding.

## 2026-08-01 — Task 9: `LinkEndpoint`/`PartitionFault` types + `impairmentFor` (FEAT-002)

New `worldEngine/types.ts` types: `LinkEndpoint` (`{ kind: 'region'|'az'|'server'; id: string } | { kind: 'internet' }`) and `PartitionFault` (`from`/`to: LinkEndpoint`, `mode: 'drop'|'loss'|'delay'`, optional `lossFraction`/`delayMs`, `symmetric: boolean`) — the network-partition authoring shape for FEAT-002. New `EngineEventKind` members `partition_started`/`partition_healed` added.

`FaultState` (`faults.ts`) extended with `partitions: PartitionFault[]`, initialized to `[]` in `createFaultState()`. New pure exports: `addPartition(state, fault, simMs): EngineEvent`, `removePartition(state, index, simMs): EngineEvent | null` (returns `null` rather than throwing on an out-of-range index — the brief's literal `EngineEvent`-only signature was widened since `splice` on an invalid index yields `undefined`), and `impairmentFor(fromIds: EndpointIds, toIds: EndpointIds, partitions): { blocked; lossFraction; delayMs }`. `EndpointIds` (`{ regionId?; azId?; serverId? }`) is a plain, already-resolved identity triple — `impairmentFor` stays decoupled from `CompiledPath`/`compiled.instances` entirely (matching `flows.ts`'s `faultErrorFractionByServer` discipline); resolving a path's from/to instance/managed-service into `EndpointIds` is the caller's job (Task 10/11/12), not this module's.

Side effect: adding the two new `EngineEventKind` members made `src/lib/aiChat/eventCausality.ts`'s `decodeAffected` switch (exhaustive over `EngineEventKind`) fail `tsc` with "Function lacks ending return statement" — added `case 'partition_started': case 'partition_healed':` there, matching the existing default `{ primaryId: affected[0] ?? '', secondaryId: affected[1] || null }` shape used by sibling two-id events.

## 2026-08-01 — Task 12: `setPartition`/`healPartition` on `WorldEngineApi` (FEAT-002)

New `WorldEngineApi` methods: `setPartition(fault: PartitionFault): void` (thin wrapper over `faults.ts`'s `addPartition`, re-sequencing and emitting the returned `partition_started` event) and `healPartition(index: number): void` (thin wrapper over `faults.ts`'s `removePartition`, a no-op that emits nothing when `index` is out of range, matching `removePartition`'s own `null`-on-invalid-index contract; emits `partition_healed` on success). Both additive-only.

Added a task early: this facade surface was originally planned for Task 13 (the full partition-authoring API), but Task 12's directional-health/split-brain test needed a way to drive a real partition through a *running* engine (`engine.step()` over wall-time, to exercise the health-check consecutive-failure debounce) rather than poking at `state.faults.partitions` directly, and nothing exposed partitions to a running engine yet. Task 13 should extend this minimal pair (e.g. listing/inspecting active partitions, or a by-value removal instead of by-index) rather than duplicating it.

## 2026-08-01 — Task 13 (review fix): `MetricsBatch.instances[id].effectiveRole` (FEAT-002)

Added `effectiveRole?: PlacementRole` to `InstanceMetrics` (additive-optional, `worldEngine/types.ts`; `PlacementRole` added to the file's `world/types` import). Populated by `metrics.ts`'s `buildBatch` via a new trailing optional parameter `roleOf?: (id: InstanceId) => PlacementRole`, threaded from `index.ts`'s sole `buildBatch` call site using the ALREADY-MEMOIZED `roleOf`/`s.roleResolver` built earlier in the same step (§6, `failover.ts`'s `effectiveRoleResolver(compiled, s.failover.promotedAt)`, memoized on `promoKey`) — never re-derived, so the published role can never disagree with the role the flow solver actually routed writes to that step.

Reason: code review of Task 13's first commit (`045ba57`) found `analysis/rules/structural.ts`'s `split-brain-risk` rule read only the STATIC authored `compiled.instances[id].role`, which never changes at runtime — a partition-induced promotion only ever mutates the engine's internal `state.failover.promotedAt`, and nothing published to `MetricsBatch` could see it before this fix, so the rule could only ever fire on a hand-authored double-primary, never a genuine live split-brain (the exact scenario Task 12's own split-brain test produces, and Task 14's planned live-smoke-test step depends on). `split-brain-risk` now reads `lastBatch?.instances[id]?.effectiveRole ?? compiled.instances[id].role`. Absent `roleOf`/no batch yet ⇒ every existing direct-`buildBatch` caller/test and the rule's own doc-only fallback are unchanged by omission.

## 2026-08-02 — Task 18: `scenario_step_applied` `EngineEventKind` + `EngineState.scenarioSteps`/`scenarioCursor`/`demandOverlay` (FEAT-003)

New `EngineEventKind` member `scenario_step_applied` (`worldEngine/types.ts`) — emitted once per
scenario step, in addition to whatever domain event the step's own action produces (e.g. a
`'inject-fault'` step fires both `fault_injected` AND `scenario_step_applied`). Side effect: the
same exhaustive-switch fallout as Task 9/12's new event kinds — `src/lib/aiChat/eventCausality.ts`'s
`decodeAffected` needed a new case (`{ primaryId: affected[0] ?? '', secondaryId: affected[1] ||
null }`, matching the general two-id shape; `affected` is always `[]` for this event today).

`index.ts`'s `EngineState` gained three FEAT-003 fields, all engine-internal (not part of the
frozen `WorldEngineApi` contract): `scenarioSteps: ScenarioStep[]` (sorted once by `atMs` in
`start()`), `scenarioCursor: number` (monotonic apply cursor, 0 at start), and `demandOverlay:
Map<PopulationId, { multiplier; targetMultiplier; rampStartMs; rampSec }>` — an engine-owned
demand-shaping overlay written by the `'demand-multiplier'`/`'set-population-rps'` scenario
actions. This task (18) only WRITES the overlay; Task 19 makes `demand.ts`'s
`populationDemandRps` read it. `runStep`'s top-of-step cursor loop applies every step whose
`atMs <= simMs` exactly once (`<=` so same-boundary steps all fire that step, sorted order breaks
ties among steps sharing an `atMs`), dispatching through `applyScenarioAction`, which reuses the
EXACT existing code paths — `api.setFault` for `inject-fault`/`clear-fault` (same facade a
UI-driven call uses, so `down`/failover-outage/`applyAzOutageToManaged` wiring all fire
identically) and `api.setPartition`/`api.healPartition` for `partition`/`heal-partition` (thin
wrappers already built in Task 12 over `faults.ts`'s `addPartition`/`removePartition`) — no
duplicated fault/partition logic.

`doc.scenario?.seed`, when present, now REPLACES `createWorldEngine`'s constructor-seed default
(both `state.rng` and the tracer's independent rng derive from the same `effectiveSeed = doc.
scenario?.seed ?? seed`) rather than adding a second rng source — verified by a test constructing
two engines with different default seeds but the same `scenario.seed`, asserting byte-identical
output. A `doc` with no `scenario` is unaffected (`scenarioSteps: []`, `effectiveSeed === seed`),
preserving pre-feature determinism byte-for-byte.

## 2026-08-02 — Final-review fix wave, I3: `PartitionFault.id` + `WorldEngineApi.healPartition` addresses by id, not index (FEAT-002)

Added `id?: string` to `PartitionFault` (`worldEngine/types.ts`, additive-optional). `faults.ts`'s
`addPartition` now auto-assigns one (`partition-${FaultState.nextPartitionId++}`, a new counter
field on `FaultState`) when the caller didn't supply one, so every partition that ever lands in
`FaultState.partitions` carries a real id.

**Breaking, deliberately, on reviewer instruction:** `WorldEngineApi.healPartition`'s signature
changed from `(index: number) => void` to `(id: string) => void`, and `faults.ts`'s
`removePartition` changed from `(state, index: number, simMs)` to `(state, id: string, simMs)` —
both now resolve the target partition by `p.id === id` (a no-op returning `null`/nothing on an
unknown id) rather than array position. Reason: `PartitionsSection.tsx`'s partition-authoring UI
is usable WHILE the sim is running (`ChaosControl`'s inverse edit-lock), so a hand-authored
partition or heal mid-run could shift every LATER partition's array index out from under a
scenario's `heal-partition` step, silently healing the wrong one — array position was never a
safe identity for a live-mutable list. `src/lib/world/types.ts`'s `ScenarioAction`'s
`heal-partition` variant changed from `{ index: number }` to `{ partitionId: string }` to match;
every call site updated in lockstep: `simulation.store.ts`'s `healPartition` action (and its local
`partitions` mirror, which now assigns the id itself via a module-level counter so the mirror
stays self-consistent even when the engine isn't running — see that file's own comment),
`PartitionsSection.tsx`'s heal button (`p.id`, not the row index), and `ScenarioPanel.tsx`'s
`AddStepForm` (a `partition` step can now author an explicit id to pair with a later
`heal-partition` step; left blank, the engine auto-assigns one at apply time, which a
same-scenario `heal-partition` step then cannot reference by name).

Landed alongside audit finding C1's fix (the cross-region self-promotion promote/failback flap —
see the "Fault & Scenario Substrate — Wave 1" section of `docs/module-boundaries.md` for the full
writeup) and I1 (scenario-driven fault/partition actions now thread the STEP's own `simMs`
explicitly through internal `doSetFault`/`doSetPartition`/`doHealPartition` helpers, rather than
each reading `state.clock.simMs` — which, mid-replay of a multi-step frame batch, holds the
batch's LAST step's time, not the step actually being applied. The public `WorldEngineApi`
facade methods (`setFault`/`setPartition`/`healPartition`) are unaffected — UI-driven calls are
never backdated, so they still read `state.clock.simMs` at the call site).

## 2026-08-03 — Task 4: `InstanceMetrics.cacheHitRatio` (FEAT-004)

Added `cacheHitRatio?: number` to `InstanceMetrics` (additive-optional, `worldEngine/types.ts`) —
published only for an instance whose blueprint carries a `CacheConfig`. Computed in `metrics.ts`'s
`buildBatch` by calling `cache.ts`'s `effectiveHitRatio(bp.cacheConfig, warmSinceMs?.get(inst.id),
simMs)` — the SAME pure function and, critically, the SAME `warmSinceMs` map (`EngineState.
warmSinceMs`, Task 3) that `index.ts`'s `runStep` already reads via `cacheAsideIndexByDepId` to
build `cacheMissFractionByInstance` for the flow solver each step. `buildBatch` gained a new
trailing optional parameter, `warmSinceMs?: Map<string, number>`, following the same
additive-by-omission pattern as `roleOf`/`leakAccumMb`/etc. — every existing direct-`buildBatch`
caller/test is unaffected, and `cacheHitRatio` stays unpublished whenever the map is omitted. The
sole engine call site (`index.ts`, the 1 Hz batch build inside `runStep`) now passes `s.
warmSinceMs` as that trailing argument.

No signature break — this is a pure additive contract change. The divergence-guard discipline
here mirrors `activeConnections`/`ramMb`/`effectiveRole` above: a cache's published hit ratio can
never disagree with the miss fraction the flow solver actually applied that same step, because
both read the identical `warmSinceMs` entry through the identical `cache.ts` formula. Covered by
`index.test.ts`'s `FEAT-004 cache hit ratio` describe block, including a `DIVERGENCE GUARD` test
that restarts a cache mid-run and independently recomputes the expected mid-warmup ratio via
`effectiveHitRatio` fed the same restart timestamp the engine itself used, asserting equality with
the published value.

## 2026-08-03 — Task 5: `cache_cold`/`cache_warm` `EngineEventKind` (FEAT-004)

Added two new `EngineEventKind` variants (additive-only, `worldEngine/types.ts`, appended after
`'scenario_step_applied'`):

- `cache_cold` — emitted at the exact two sites Task 3 already writes `EngineState.warmSinceMs`
  for a cache-configured instance: the OOM-restart-completion block in `runStep` ("── 0. OOM
  restart timers ──") and `doSetFault`'s `!down` (fault-clear-back-to-running) branch. Both sites
  now also clear the new `EngineState.warmEmitted: Set<string>` guard for that instance id, so the
  next warm-cycle's `cache_warm` can fire again.
- `cache_warm` — emitted from the SAME per-step loop that already reads `s.warmSinceMs` to build
  `cacheMissFractionByInstance` for the flow solver (`runStep`, the `hasAnyCache` block) — no
  second loop over instances was added, per the task brief's explicit constraint. Fires exactly
  once per cold cycle, the first step `simMs - warmSinceMs >= cfg.warmupSec * 1000` (i.e. the step
  `effectiveHitRatio` first reaches `cfg.hitRatio` again), guarded by the new `warmEmitted` Set so
  it does not re-fire every subsequent step while the cache stays warm. Wired for both shapes:
  blueprint-level caches (keyed by instance id) and managed-service caches (keyed by
  `managed:${id}`) — though in practice a managed cache's `warmSinceMs` entry is never written
  (Task 3's documented scope cut: `ManagedService` has no restart concept today), so the managed
  branch is inert until that changes.

Both are pure additions to the frozen `EngineEventKind` union — no signature break. One incidental
fix surfaced by `tsc --noEmit`: `src/lib/aiChat/eventCausality.ts`'s `decodeAffected` has an
exhaustive `switch (kind)` with no `default`, so it required a new case for the two kinds
(`{ primaryId: affected[0] ?? '', secondaryId: null }`, matching the pattern used for other
single-entity info-severity events like `fault_injected`). No other exhaustive switch over
`EngineEventKind` exists in the app — `EventsTab.tsx` renders `e.kind` generically as text, so it
needed no change (confirmed by inspection before assuming otherwise, per the task brief).

Covered by `index.test.ts`'s `FEAT-004 cache hit ratio` describe block, a new test asserting
`cache_cold` fires exactly once on a `down`→clear restart cycle and `cache_warm` fires exactly
once after stepping well past `warmSinceMs + warmupSec * 1000`.
