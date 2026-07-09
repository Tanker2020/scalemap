# Phase 2 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Phase 2 of Scalemap's world-model
rebuild. Everything you need is in this repo. Work on branch `world-rebuild` (currently
at the reviewed Phase-1 head + planning commits). Do not use a more expensive model than
you are; dispatch cheaper subagents per the model assignments below.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN interfaces. You may extend additively (optional fields); you may NOT rename or reshape. If implementation truly forces a change, record it in `.superpowers/sdd/contract-drift.md` (create it) with what/why, and continue — the Phase-3 planning session reviews that file.
3. `docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md` — the 11 engineering decisions.
4. `docs/superpowers/plans/phase2/skeleton.md` — 18 task specs (signatures, semantics, named test cases, per-task implementer model).
5. `docs/superpowers/plans/phase2/fragments/controller-rulings.md` — binding rulings resolving every ambiguity fragment writers found. Apply ALL of them.
6. Skim `docs/superpowers/plans/2026-07-08-phase1-world-model-shell.md` (format precedent) and `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md` (umbrella; D-decisions cited by the spec).

## 2. State you inherit

Plan fragments in `docs/superpowers/plans/phase2/fragments/` (full Phase-1-style task sections
with complete code):

| File | Covers | State |
|---|---|---|
| tasks-01-05.md | Tasks 1–5 | COMPLETE (numerics verified by a Node harness) |
| tasks-06-09.md | Tasks 6–8 | **Task 9 MISSING** — append at the `<!-- APPEND:NEXT -->` sentinel |
| tasks-10-12.md | Tasks 10–11 | **Task 12 MISSING** — append at the `<!-- CONTINUE -->` sentinel |
| tasks-13-18.md | Tasks 13–18 | COMPLETE |

Each fragment may open with a SKELETON CONCERNS block — those are the writers' flags; the
rulings file disposes of every one. Do not re-litigate them.

## 3. Step 0 — finish and assemble the plan (before any implementation)

1. Write the two missing sections at their sentinels, at the same fidelity as their
   neighbors (complete code, failing-test-first, exact commands, commit steps):
   - **Task 9 (failover machinery)** per skeleton T9. Interfaces are exact.
   - **Task 12 (engine facade + simulation.store v2 + integration test)** per skeleton
     T12 — the keystone. It MUST additionally include, per the rulings: (a) baseline
     populations (`baseline:<regionId>` ids) bypass DNS resolution and route straight to
     their own region; (b) the same commit that rewrites `simulation.store.ts` deletes
     `src/lib/costModel.ts` + its tests + any other old-store importers outside Task 17's
     deletion tree (grep first; this is the sanctioned early deletion that keeps the build
     green through T13–16); (c) the perf-degradation hook lives HERE: rolling mean step
     cost >4ms for 3s → stepMs 100→200 + `engine_degraded` info event + a store flag
     (Task 18 only adds the bench, threshold verification, and the SimControls chip).
2. Concatenate: plan header (Goal/Architecture/Tech Stack + the skeleton's Global
   Constraints and File Structure blocks verbatim) + fragments in order, sentinels and
   per-fragment SKELETON CONCERNS blocks removed → `docs/superpowers/plans/2026-07-08-phase2-substrate-engine.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan (no TBD/todo/"similar
   to task N"); (b) cross-fragment type consistency — every import a later task makes from
   an earlier task's module must match the earlier task's export names/signatures exactly;
   the highest-risk seams are T8's use of T3/T4/T6/T7 outputs and T12's use of everything;
   (c) every contracts field is populated somewhere in T10–T12; (d) rulings all applied.
4. Commit: `docs: assemble Phase 2 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as Phase 1 was run (its
ledger and per-task reports are in `.superpowers/sdd/` as precedent):

- Fresh implementer subagent per task; task-reviewer subagent after each; fix subagents
  for Critical/Important findings; re-review after fixes; ledger line per task appended to
  `.superpowers/sdd/progress.md` under a `## PHASE 2` heading.
- Implementer models: per the skeleton's per-task tags (haiku for transcription-grade
  tasks T1/T2/T5/T7/T11; sonnet for the rest). Reviewers: sonnet. Final whole-branch
  review: the most capable model available to you.
- Every implementer prompt carries: the task's brief (extract with the skill's
  `task-brief` script), the constraint that contract types are frozen, the strict-tsc
  and style-spread lessons (see plan Global Constraints), and the report-file contract.
- UI tasks T13/T14/T15/T18 REQUIRE the live Playwright smoke written into their sections
  (dev server strict port 1420, zero console errors, screenshots, stop server after).
  Phase 1's history shows why: the live checks caught two real bugs jsdom tests missed.
- Task 17 (legacy deletion) runs only after T13–T16 are approved.
- Do not pause between tasks for the user; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Phase 2 exit)

1. Full suite + `npm run build` green; perf bench inside budget (or degradation path
   demonstrably works).
2. Final whole-branch review (vs the Phase-2 spec + contracts) verdict "Ready", with one
   consolidated fix wave if needed.
3. Live end-to-end smoke: author world → simulate → AZ kill redistributes → region kill
   honors DNS TTL lag (via the dev debug hook from T18) → scrub replay → open a trace →
   cost tab → save/reload.
4. `docs/module-boundaries.md` §J updated (T18 owns it).
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + contract-drift
   log state. The user then merges `world-rebuild` → main or proceeds to Phase 3.

## 6. After Phase 2 (for whichever session plans Phase 3)

Phase 3 (server-interior "living circuit board") planning needs: the umbrella spec §5,
the approved mockup `docs/superpowers/specs/mockups/serverview-hybrid-v3.html`
(binding visual direction), the contracts doc (Phase 3 reads `ServerMetrics`,
`attachRenderer({level:'server'})`, `getTracedRequests`), `.superpowers/sdd/contract-drift.md`
(reconcile first), and the Phase-2 final review's open-items list. Phase-3 cleanup item
already queued: align `PlacementPanel`'s `MANAGED_TYPES` with `CLOUD_REGISTRY` keys
(see rulings item 5).
