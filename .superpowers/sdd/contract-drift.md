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
