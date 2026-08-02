# Task 13 Report: `split-brain-risk` analysis rule + `setPartition`/`healPartition` store actions

**Branch:** `worktree-fault-injection-wave1`
**Base:** `0e183a0` (docs: log setPartition/healPartition in contract-drift.md — Task 12's last commit)
**This task's commit:** `045ba57` feat: add split-brain-risk rule and setPartition/healPartition store actions

## Step 1 correction — verified, not re-done

Confirmed `setPartition`/`healPartition` already exist on `WorldEngineApi`
(`src/lib/worldEngine/types.ts:325,329`) with the exact signatures specified:
`setPartition: (fault: PartitionFault) => void` and `healPartition: (index: number) => void`.
Implemented in `index.ts:1777-1785`, delegating to `addPartition`/`removePartition` from
`faults.ts` and emitting the returned event. `contract-drift.md` has the matching
"2026-08-01 — Task 12" entry. Did not touch `worldEngine/types.ts`, `index.ts`, or
`contract-drift.md` — out of scope per the correction, used as-is.

## Step 2-5 — `split-brain-risk` rule

Added to `src/lib/analysis/rules/structural.ts`, spread into `structuralRules` (now 7 rules).

**Field-name finding (as flagged by the brief):** the brief's pseudocode read
`lastBatch?.instances?.[inst.id]?.role`, but `InstanceMetrics` (worldEngine/types.ts:26-50) has
**no `role` field at all** — no effective-role/promoted-role data is published to the metrics
batch; the promotion overlay (`promotedAt`) lives only in the engine's internal `FailoverState`.
The only `role` available to a pure `AnalysisRule` (which only gets `{ doc, compiled, lastBatch }`)
is the AUTHORED `PlacementRole` on `ServiceInstance` (`compiled.instances[id].role`,
world/types.ts:396). The rule reads `inst.role` from `compiled.instances` instead.

**Cluster key:** `${blueprintId}|${regionId}`, derived inline — matches `promoteReplicas`'s own
inline derivation at `failover.ts:351`. There's no exported/shared helper for it (failover.ts
derives it inline at both of its own call sites too), so the rule doesn't introduce a new
convention, it just repeats the existing one.

**Bug caught during Step 7's full-suite run (not in the brief, found by testing):** the initial
version (no `stateful` gate) false-fired on the vault example worlds — `role` defaults to
`'primary'` for EVERY placement regardless of blueprint, so a plain horizontally-scaled stateless
tier (e.g. `web` with 2 placements, or a `worker`/`store`-style placement with `count > 1`) trips
"two primaries in one cluster" despite having no primary/replica replication semantics at all.
Fixed by gating on `doc.blueprints[inst.blueprintId]?.stateful`, mirroring
`replicas-colocated`'s existing convention exactly. Re-ran the full suite after the fix — clean.

Tests added (`structural.test.ts`): fires with two authored primaries in one
`blueprintId|regionId` cluster (critical, both instance ids in `affected`); silent with exactly one
primary + a replica; silent for two primaries of the same blueprint in DIFFERENT regions (asserts
the accepted cross-region gap explicitly, so a future "fix" to the cluster key doesn't
accidentally break an intentionally-scoped test).

## Step 6 — store actions

Added `setPartition`/`healPartition` to `SimulationStore` (`simulation.store.ts`) as thin
delegations to `worldEngine.setPartition`/`worldEngine.healPartition` — no store-side bookkeeping
(no local active-partitions list; the facade owns that state). Tests in
`simulation.store.test.ts` mirror the existing `setFault`/`setOutage` mocking pattern (`vi.spyOn`
the facade method, assert the store action calls it with the same argument).

## Step 7 — verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — **145 test files passed, 1771 tests passed**, 0 failed (includes the 2
  vault `exampleWorlds.test.ts` regressions caught and fixed above, and the 5 new
  structural-rule/store tests).

## Docs

Updated `docs/module-boundaries.md`: the Wave-1 table entries for `worldEngine/types.ts` and
`simulation.store.ts` now note Task 13's confirmation/consumption of the Task-12 facade methods
and the new store actions; the Phase 6 D2 analysis-rules table entry for `structural.ts` now
documents `split-brain-risk`'s field-name finding, the `stateful` gate (and why), and the accepted
cross-region gap.

## Observation for the controller (not acted on, per instructions)

`split-brain-risk`'s `blueprintId|regionId` cluster key can only ever catch two primaries within
the SAME region. Task 12's split-brain test produces a genuine CROSS-region split brain (untouched
primary in region A + a replica in a different region B that self-promotes via the new
directional-health path) — different `regionId` ⇒ different cluster key ⇒ this rule never groups
them together and will not flag that scenario. This is the brief's own literal scope ("two
effective primaries exist in ONE blueprintId|regionId cluster") and is left as-is; flagging only,
not fixed.

## Status

DONE. No blockers, no open questions. Full suite green, typecheck clean.

---

## Fix-round addendum (review finding, Critical)

**Reviewer's finding:** `split-brain-risk` read only the static authored `compiled.instances[id].role`,
which never changes at runtime — a real partition-induced promotion (Task 12's mechanism) only
mutates the engine's internal `state.failover.promotedAt`, resolved into `s.roleResolver`
(`effectiveRoleResolver(compiled, promotedAt)`) inside `index.ts`'s step loop, and that resolved
role was never published anywhere an `AnalysisRule` could see it. The committed rule could
therefore only ever fire on a hand-authored double-primary WorldDoc, never a genuine live
split-brain — which would make Task 14's planned live-smoke-test step (partition → Analysis tab
shows the finding) fail silently.

**Fix applied, exactly as directed:**

1. **`src/lib/worldEngine/types.ts`** — added `effectiveRole?: PlacementRole` to `InstanceMetrics`
   (additive-optional; `PlacementRole` added to the file's `world/types` import). Logged in
   `.superpowers/sdd/contract-drift.md` under "2026-08-01 — Task 13 (review fix)".
2. **`src/lib/worldEngine/metrics.ts`** — `buildBatch` gained a new trailing optional param
   `roleOf?: (id: InstanceId) => PlacementRole`, matching the exact convention of the existing
   `starved`/`connProfiles`/`effectiveCpuMsByInstance`/`leakAccumMb` optional params right above it
   (documented, additive, absent ⇒ unchanged behavior). Populates
   `instances[inst.id].effectiveRole` via `...(roleOf ? { effectiveRole: roleOf(inst.id) } : {})`.
3. **`src/lib/worldEngine/index.ts`** — the sole `buildBatch` call site (~line 1418, now 1421 after
   the added comment) now passes the ALREADY-MEMOIZED `roleOf` local (bound to `s.roleResolver` at
   line 1081, rebuilt only when `promotedAt`'s contents change) — no new computation, no
   duplicate resolver.
4. **`src/lib/analysis/rules/structural.ts`** — `split-brain-risk` now reads
   `lastBatch?.instances?.[inst.id]?.effectiveRole ?? inst.role` instead of the static field alone.
   Also fixed the Minor: the `why` string no longer computes `regionIds`/a dead pluralization
   branch — every instance in one `blueprintId|regionId` cluster shares one regionId by
   construction, so it now just reads `instances[0].regionId` directly.
5. **Test added** (`structural.test.ts`): `'fires when lastBatch reports a live promotion
   (effectiveRole), even though the authored roles are a normal primary+replica pair'` — builds a
   normal authored primary+replica fixture (asserts it's silent under `lastBatch: null`, i.e. the
   static-role fallback path), then constructs a `MetricsBatch` (partial cast, matching
   `capacity.test.ts`'s existing convention) reporting BOTH instances' `effectiveRole: 'primary'`,
   and asserts `split-brain-risk` now fires with both instance ids in `affected`.

**Verification:**
- `npx tsc --noEmit` — clean.
- `npx vitest run` — **145 test files passed, 1772 tests passed** (1 more than the prior round —
  the new live-promotion test), 0 failed.

**Docs updated:** `.superpowers/sdd/contract-drift.md` (new entry) and `docs/module-boundaries.md`
(the `worldEngine/types.ts`, new `metrics.ts` row, `index.ts`, and the D2 `structural.ts` rules-table
entries all updated to describe the `effectiveRole` plumbing and why it was needed).

**New commit:** `a65530b` (fix commit on top of the original `045ba57`).
Confirmed `git rev-parse --abbrev-ref HEAD` prints `worktree-fault-injection-wave1`.

Status: **DONE** (fix-round complete, no further open findings).
