# Task 13 report — RPO at promotion: least-lagged selection + `replica_promoted` payload

## Working directory confirmation

Before the first edit:
```
$ git rev-parse --show-toplevel
C:/Users/rishi/Desktop/scalemap/.claude/worktrees/wave2-stateful-fidelity
$ git branch --show-current
worktree-wave2-stateful-fidelity
```
Matches the required worktree/branch. Re-confirmed identical before the final commit (see below).

## What I did

1. Read the REAL current `promoteReplicas` in `src/lib/worldEngine/failover.ts` (not the brief's
   guessed line numbers — actual function spans ~350-396 in the pre-change file, matching closely
   enough) and the real call site in `index.ts`'s `runStep` (line 1649 pre-change).
2. Found the existing test file at `src/lib/worldEngine/failover.test.ts` (29 tests, including a
   dedicated `describe('promoteReplicas', ...)` block) — no new test file created, per the brief's
   instruction to check first.
3. Captured the **pre-change baseline**: `git stash` (stashing my in-progress edits), ran
   `npx vitest run src/lib/worldEngine/failover.test.ts`, recorded the result, `git stash pop` to
   restore my edits. Baseline: **29/29 passing**.
4. Added `EngineEvent.payload?: { dataLossWindowSec?: number; estimatedLostWrites?: number }` to
   `src/lib/worldEngine/types.ts` (additive-optional).
5. Extended `promoteReplicas` in `failover.ts` with two additive-optional trailing params —
   `lagByInstance?: Map<InstanceId, number>` and `writeRpsByReplica?: Map<InstanceId, number>` —
   changed the candidate sort to `HEALTH_RANK` → ascending lag (`lagByInstance?.get(id) ?? 0`) →
   id, and stamped `payload` onto the `replica_promoted` event **only when `lagByInstance` is
   supplied** (so omitting it produces no `payload` key at all, not a zeroed one).
6. Wrote the two required tests (least-lagged selection, RPO payload) plus one extra test asserting
   the payload is absent when the new params are omitted (guards the "byte-identical when omitted"
   claim directly, not just by inference from the unrelated pre-existing tests still passing).
7. Wired the real call site in `index.ts`: built `writeRpsByReplicaInstance` (per-instance write
   rps, approximated as each replica's cluster's TOTAL `writeRpsByCluster[clusterId]` — Task 11's
   own design already treats a cluster's write stream as shared, not partitioned per replica) in
   the same block as the `promoteReplicas` call, guarded by `s.hasAnyReplicas`; passed
   `s.replication.lagSecByInstance` and this new map as the two new trailing args.
8. Updated `.superpowers/sdd/contract-drift.md` (appended, did not rewrite prior entries).

## Re-baseline discipline (the specifically-flagged risk)

Per the plan's closing notes: *"Preferring the least-lagged replica alters an existing code path
that current tests pin. Re-baseline deliberately and state in the commit which assertions moved
and why."*

**Baseline (before change, `git stash` + run + `git stash pop`):**
```
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

**Post-change (`npx vitest run src/lib/worldEngine/failover.test.ts`):**
```
 Test Files  1 passed (1)
      Tests  32 passed (32)
```
(29 pre-existing + 3 new: least-lagged selection, RPO payload, payload-absent-when-omitted.)

**Which pre-existing assertions could have moved, and why they didn't:**

- `'prefers a healthier replica over the lexically-first one (audit ISSUE-007)'` — calls
  `promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000, healthOf)` with **no**
  `lagByInstance` argument. With the param omitted, every candidate's lag reads `?? 0` inside the
  sort, so the new `(lagOf(a) - lagOf(b))` term is always `0 - 0 = 0` and the sort falls straight
  through to the unchanged id tiebreak — identical to pre-change behavior. Still asserts the same
  replica (`second`) is promoted. **Unchanged, confirmed by the post-change run, not assumed.**
- `'re-promotes a second replica when the promoted one later fails (audit ISSUE-007)'` — same
  shape, no `lagByInstance` passed, same reasoning. **Unchanged.**
- `'promotes the same-blueprint same-region replica and emits replica_promoted once'` — no lag/
  writeRps args passed; asserts `events[0]` via `toMatchObject({ kind, simMs })`, which does not
  check for absence of extra keys, so the new (in this case absent, since `lagByInstance` is
  omitted) `payload` field is a non-issue either way. **Unchanged.**
- No other pre-existing test in the file passes `lagByInstance`/`writeRpsByReplica`, so no other
  assertion's promoted-replica identity could possibly have moved.

**Conclusion:** zero pre-existing assertions changed outcome. The re-baseline was a genuine
verification (not a formality) — I ran the actual baseline and the actual post-change suite and
diffed the counts/content, rather than assuming omission-safety from reading the code alone.

## Full verification

```
$ npx tsc --noEmit
(clean, no output)

$ npx vitest run src/lib/worldEngine/failover.test.ts
 Test Files  1 passed (1)
      Tests  32 passed (32)

$ npx vitest run src/lib/worldEngine/index.test.ts
 Test Files  1 passed (1)
      Tests  109 passed (109)

$ npx vitest run
 Test Files  150 passed (150)
      Tests  1870 passed (1870)
```
(The `canvas`/`getContext` warnings in the full-suite run are pre-existing jsdom noise from
unrelated globe-rendering tests, not failures — 150/150 files and 1870/1870 tests passed.)

## Files changed

- `src/lib/worldEngine/types.ts` — added `EngineEvent.payload?: { dataLossWindowSec?; estimatedLostWrites? }`.
- `src/lib/worldEngine/failover.ts` — `promoteReplicas` gained `lagByInstance?`/`writeRpsByReplica?`
  trailing params; sort key extended; `replica_promoted` event conditionally carries `payload`.
- `src/lib/worldEngine/index.ts` — the `runStep` failover-section call site now builds
  `writeRpsByReplicaInstance` and passes it plus `s.replication.lagSecByInstance` into
  `promoteReplicas`.
- `src/lib/worldEngine/failover.test.ts` — 3 new tests (least-lagged selection, RPO payload,
  payload-absence-on-omission) appended to the existing `describe('promoteReplicas', ...)` block.
- `.superpowers/sdd/contract-drift.md` — appended a new dated entry documenting the additive
  signature extension and the re-baseline result.

## Deviations from the brief

- The brief's illustrative test snippet referenced a hypothetical `promoteReplicasWithEvents`
  wrapper "in case a separate emit step exists." Reading the real code confirmed `promoteReplicas`
  itself directly builds and returns `EngineEvent[]` — there is no separate emit-wrapper function —
  so both new tests call `promoteReplicas` directly, matching the brief's own fallback guidance
  ("adapt to failover.ts's ACTUAL exported function names").
- Added a third test (payload-absence-on-omission) beyond the two the brief asked for, since the
  "additive, byte-identical when omitted" claim for the `payload` field specifically needed its own
  direct assertion rather than relying only on the pre-existing tests' unrelated assertions.
- The brief's step-4 pseudocode always computes `dataLossWindowSec: lagByInstance?.get(id) ?? 0`
  (defaulting to `0` rather than being absent). I instead omit the `payload` key entirely when
  `lagByInstance` is not supplied, per the task's own overview line 3 ("stamp ... onto the event
  payload **when both maps are supplied**"), which reads as a stricter and more useful contract —
  a caller with no lag data gets no payload rather than a spuriously precise `{dataLossWindowSec: 0,
  estimatedLostWrites: 0}` that looks like "confirmed zero data loss" rather than "unknown."  This
  does not affect any existing test (none inspect `payload`) and is exercised directly by the new
  absence test.

## Commit

Committed as a single commit (see below for hash) touching exactly the files listed above plus the
contract-drift doc.

## Concerns

- The per-replica write-rps approximation (whole-cluster total assigned to every replica) means
  `estimatedLostWrites` in a multi-replica cluster is not "writes this specific replica would have
  applied" but "writes the whole cluster's primary received" — consistent with Task 11's existing
  shared-write-stream model, but worth flagging in case a later task wants a true per-replica split
  (there's no per-replica write-share signal anywhere in the engine today to derive one from).
- `s.hasAnyReplicas` gates `writeRpsByReplicaInstance` construction, but `lagByInstance` itself
  (`s.replication.lagSecByInstance`) is passed unconditionally (it's just an always-existing, maybe-
  empty Map on `EngineState`) — this matches the existing pattern for that field elsewhere in the
  file (e.g. line ~1390's `staleReadFractionByReplica` block guards on `hasAnyReplicas` but the map
  itself is unconditional) and produces no behavior difference (`Map.get` on an empty map returns
  `undefined`, same as omitting the whole param), so this is a non-issue but noted for review.
