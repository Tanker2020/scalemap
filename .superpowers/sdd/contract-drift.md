# Contract Drift Log

## 2026-08-01 — Fault injection (FEAT-001)

`setOutage(scope, id, down: boolean)` on `WorldEngineApi` is superseded by `setFault(scope, id, spec: FaultSpec | null)`. `setOutage` survives as a documented alias implemented in terms of `setFault`. New `FaultKind`/`FaultSpec`/`FaultScope` types added. New `EngineEventKind` members `fault_injected`/`fault_cleared` added.

## 2026-08-01 — Task 7: `MetricsBatch.activeFaultCount`

Added `activeFaultCount?: number` to `MetricsBatch` (additive-optional, `worldEngine/types.ts`) — the count of currently-active operator-injected faults (`FaultState.active.size`), populated by `buildBatch`'s new trailing optional parameter and threaded from `index.ts`'s `s.faults.active.size` at the sole `buildBatch` call site. Backs the new `fault-injected` capacity analysis rule (`src/lib/analysis/rules/capacity.ts`), which fires an info-severity finding so operators can tell deliberately-injected degradation apart from an architectural finding.

## 2026-08-01 — Task 9: `LinkEndpoint`/`PartitionFault` types + `impairmentFor` (FEAT-002)

New `worldEngine/types.ts` types: `LinkEndpoint` (`{ kind: 'region'|'az'|'server'; id: string } | { kind: 'internet' }`) and `PartitionFault` (`from`/`to: LinkEndpoint`, `mode: 'drop'|'loss'|'delay'`, optional `lossFraction`/`delayMs`, `symmetric: boolean`) — the network-partition authoring shape for FEAT-002. New `EngineEventKind` members `partition_started`/`partition_healed` added.

`FaultState` (`faults.ts`) extended with `partitions: PartitionFault[]`, initialized to `[]` in `createFaultState()`. New pure exports: `addPartition(state, fault, simMs): EngineEvent`, `removePartition(state, index, simMs): EngineEvent | null` (returns `null` rather than throwing on an out-of-range index — the brief's literal `EngineEvent`-only signature was widened since `splice` on an invalid index yields `undefined`), and `impairmentFor(fromIds: EndpointIds, toIds: EndpointIds, partitions): { blocked; lossFraction; delayMs }`. `EndpointIds` (`{ regionId?; azId?; serverId? }`) is a plain, already-resolved identity triple — `impairmentFor` stays decoupled from `CompiledPath`/`compiled.instances` entirely (matching `flows.ts`'s `faultErrorFractionByServer` discipline); resolving a path's from/to instance/managed-service into `EndpointIds` is the caller's job (Task 10/11/12), not this module's.

Side effect: adding the two new `EngineEventKind` members made `src/lib/aiChat/eventCausality.ts`'s `decodeAffected` switch (exhaustive over `EngineEventKind`) fail `tsc` with "Function lacks ending return statement" — added `case 'partition_started': case 'partition_healed':` there, matching the existing default `{ primaryId: affected[0] ?? '', secondaryId: affected[1] || null }` shape used by sibling two-id events.
