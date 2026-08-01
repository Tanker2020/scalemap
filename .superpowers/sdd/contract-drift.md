# Contract Drift Log

## 2026-08-01 — Fault injection (FEAT-001)

`setOutage(scope, id, down: boolean)` on `WorldEngineApi` is superseded by `setFault(scope, id, spec: FaultSpec | null)`. `setOutage` survives as a documented alias implemented in terms of `setFault`. New `FaultKind`/`FaultSpec`/`FaultScope` types added. New `EngineEventKind` members `fault_injected`/`fault_cleared` added.

## 2026-08-01 — Task 7: `MetricsBatch.activeFaultCount`

Added `activeFaultCount?: number` to `MetricsBatch` (additive-optional, `worldEngine/types.ts`) — the count of currently-active operator-injected faults (`FaultState.active.size`), populated by `buildBatch`'s new trailing optional parameter and threaded from `index.ts`'s `s.faults.active.size` at the sole `buildBatch` call site. Backs the new `fault-injected` capacity analysis rule (`src/lib/analysis/rules/capacity.ts`), which fires an info-severity finding so operators can tell deliberately-injected degradation apart from an architectural finding.
