# Phase 3 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Phase 3 (server-interior "living circuit
board") of Scalemap's world-model rebuild. Everything you need is in this repo. Phases 1–2
are merged to `main` (Phase-2 head `3063952`); create branch `phase3-server-interior` from
`main` and work there. Do not use a more expensive model than you are; dispatch cheaper
subagents per the model assignments below.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN interfaces
   (server-scope particle vocabulary amended 2026-07-09). Additive-optional extension
   only; forced changes go to `.superpowers/sdd/contract-drift.md` under a
   `## PHASE 3` heading, with what/why — never silently.
3. `docs/superpowers/specs/2026-07-09-phase3-server-interior-design.md` — the 12 design
   decisions (D1–D12).
4. `docs/superpowers/plans/phase3/skeleton.md` — 9 task specs (exact signatures,
   semantics, named test cases, per-task implementer model tags).
5. `docs/superpowers/plans/phase3/fragments/controller-rulings.md` — IF IT EXISTS:
   binding dispositions of fragment-writer concerns; apply all of them. If absent (see
   §2), skip.
6. Open the mockup `docs/superpowers/specs/mockups/serverview-hybrid-v3.html` in a browser
   once — it is the binding visual truth the fragments implement.
7. Skim `docs/superpowers/plans/phase2/fragments/tasks-13-18.md` (format precedent) and
   the umbrella spec `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md`
   §5 Level 4 (the D-decisions the phase spec cites).

## 2. State you inherit

Pre-written plan fragments MAY exist in `docs/superpowers/plans/phase3/fragments/`
(tasks-01-02.md, tasks-03-05.md, tasks-06-09.md — full Phase-2-style task sections with
complete code). The planning session's fragment writers were lost to a usage limit, so
**the directory may be empty or absent — that is an expected state, not an error.**
Where fragments do exist: a file ending `<!-- COMPLETE -->` is finished; one ending
`<!-- APPEND:NEXT -->` was cut off (its final line notes what remains). A fragment may
open with a `## SKELETON CONCERNS` block; if a rulings file exists it disposes of every
item — apply the ruling, not the writer's workaround, wherever they differ.

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–9 not covered by a `<!-- COMPLETE -->` fragment, write its plan
   section yourself at full fidelity (complete code, failing-test-first, exact commands
   with expected output, live-smoke checklist where the skeleton names one, commit step)
   from the skeleton's task spec. The skeleton's signatures, semantics, and named test
   cases are exact — expand them, don't redesign. Match the format of
   `docs/superpowers/plans/phase2/fragments/tasks-13-18.md`. Ground every import and
   store call in the real source first (the skeleton names the files); for Task 1's
   geometry and `attributeCores` expected values, verify your arithmetic with a scratch
   Node script before baking numbers into tests. Write task sections into
   `docs/superpowers/plans/phase3/fragments/` as you go (tasks-01-02.md, tasks-03-05.md,
   tasks-06-09.md) so partial work survives interruption. You may write each fragment
   yourself or dispatch sonnet subagent writers — your budget, your call; review whatever
   a subagent writes against the skeleton before accepting it.
2. Concatenate: plan header (`# Phase 3: Server Interior Implementation Plan`, the
   standard agentic-workers preamble, Goal/Architecture/Tech Stack one-liners, then the
   skeleton's **Global Constraints** and **File Structure** blocks verbatim) + the three
   fragments in task order, sentinels and SKELETON CONCERNS blocks removed →
   `docs/superpowers/plans/2026-07-09-phase3-server-interior.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan — no TBD/todo/
   "similar to task N"; (b) cross-fragment type consistency — every import a later task
   makes from an earlier task's module must match the earlier task's export names and
   signatures exactly (highest-risk seams: T3–T6's use of T1's `BoardLayout`/
   `StaticTrace`/`attributeCores`, T5's use of T2's particle vocabulary, T7's use of T6's
   `BoardSelection` and rail structure); (c) every `ServerMetrics` field is rendered
   somewhere in T4 (coreUtilization, stealFraction, burstCredits, ramByInstance,
   ramUsedMb/ramTotalMb, nicIn/OutMbps, diskIoFraction, health); (d) rulings all applied;
   (e) no fragment invents world.store actions that don't exist (`updateServer`,
   `updateBlueprint`, `updatePlacement` are the write surface).
4. Commit: `docs: assemble Phase 3 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as Phases 1–2 were run
(ledger + per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer subagent per task; task-reviewer subagent after each; fix subagents
  for Critical/Important findings; re-review after fixes; ledger line per task appended
  to `.superpowers/sdd/progress.md` under a `## PHASE 3` heading.
- Implementer models: per the skeleton's tags (haiku: T8; sonnet: T1–T7, T9).
  Reviewers: sonnet. Final whole-branch review: the most capable model available to you.
- Every implementer prompt carries: the task's brief (skill's `task-brief` script), the
  frozen-contracts constraint, the strict-tsc and border-shorthand lessons (plan Global
  Constraints), and the report-file contract.
- UI tasks T3/T4/T5/T7 REQUIRE their live Playwright smokes (dev server strict port 1420,
  zero app console errors, screenshots, stop the server after). Phases 1–2 both caught
  real bugs jsdom missed this way. T9's full end-to-end smoke is the phase gate.
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 (T2 and T8 are movable but
  serial execution in this order is simplest; T5 needs T2 landed).
- Do not pause between tasks for the user; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Phase 3 exit)

1. Full suite + `npm run build` green.
2. Final whole-branch review (vs the Phase-3 spec + contracts + mockup) verdict "Ready",
   one consolidated fix wave if needed.
3. Live end-to-end smoke (the spec's Testing section script): author world with a compose
   stack and a firewall-blocked dependency → server board renders all zones → static
   blocked trace with rule label → Simulate → packets traverse, hardware platform live
   (cores/ring/steal, RAM strata, disk scanner, NIC bar), gate counts blocks → Stop →
   fix the firewall via the inspector rail → trace flips permitted → hover
   cross-highlight works → scrub shows historical strata. Zero console errors.
4. `docs/module-boundaries.md` §L updated (T9 owns it).
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + contract-drift
   state. The user then merges `phase3-server-interior` → main or proceeds to Phase 4
   planning.

## 6. After Phase 3 (for whichever session plans Phase 4)

Phase 4 (region flow page + rack frames/chassis on the AZ canvas) planning needs: umbrella
spec §5 Levels 2–3, the approved mockup `docs/superpowers/specs/mockups/views-overview-v2.html`
(binding for region + rack), the contracts doc (`AzMetrics.healthScore`,
`RegionMetrics.inboundByPopulation`, failover events, `attachRenderer({level:'region'})` —
whose payload the engine still ships EMPTY; Phase 4 fills it the way Phase 3 filled server
scope), `.superpowers/sdd/contract-drift.md` (reconcile first), and the Phase-2/3 open-items
lists in the ledger. Standing deferrals available to Phase 4 if its views need them: fold
hop latency into instance p50/p99, wire `applyNicCap` shed/queue, AzSimOverlay re-subscribe
churn on pan/zoom, per-step grouping-map caching at `start()`.
