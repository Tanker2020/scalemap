# Phase 4 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Phase 4 (region flow page + rack
chassis) of Scalemap's world-model rebuild. Everything you need is in this repo. Phases
1–3 are merged to `main`; create branch `phase4-region-rack` from `main` and work there.
Do not use a more expensive model than you are; dispatch cheaper subagents per the model
assignments below.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN interfaces.
   Phase 4 makes NO contract or engine change (spec D2); if implementation truly forces
   one, record it in `.superpowers/sdd/contract-drift.md` under `## PHASE 4` with
   what/why — never silently.
3. `docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md` — the 11 design
   decisions (D1–D11).
4. `docs/superpowers/plans/phase4/skeleton.md` — 8 task specs (exact signatures,
   semantics, named test cases, model tags).
5. Open `docs/superpowers/specs/mockups/views-overview-v2.html` in a browser once — the
   Level-2 region panel and Level-3 rack panel are the binding visual truth (ignore the
   Level-1 globe panel; that is Phase 5).
6. Skim a Phase-3 fragment (`docs/superpowers/plans/phase3/fragments/tasks-03-05.md`) as
   the format precedent for the plan sections you will write, and the umbrella spec
   `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md` §5
   Levels 2–3.

## 2. State you inherit

There are NO pre-written plan fragments for Phase 4 — this is expected, not an error
(planning deliberately shifted fragment-writing to you after usage limits killed the
Phase-3 fragment writers; the skeleton carries everything they would have needed).
`.superpowers/sdd/progress.md` holds Phases 1–3 as precedent, including per-task ledger
format and the Phase-3 open items this phase's Task 7 absorbs.

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–8, write its full plan section (complete code, failing-test-first,
   exact commands with expected output, live-smoke checklist where the skeleton names
   one, commit step) from the skeleton's task spec. Signatures, semantics, and named test
   cases are exact — expand them, don't redesign. Ground every import in real source
   FIRST: the mockup hexes, `costModelV2`'s actual per-AZ export names,
   `worldEngine/latency.ts`'s actual constant names, `@xyflow/react` v12's actual
   `getInternalNode`/`positionAbsolute`/`measured` typings, the actual
   `addManagedService` caller panel, and `server.rack` seeding in
   `src/lib/world/factories.ts`. For `layoutRacks` and `regionData` expected test values,
   verify the arithmetic with a scratch Node script before baking numbers into tests.
   Write sections to `docs/superpowers/plans/phase4/fragments/` as you go (tasks-01-03.md,
   tasks-04-06.md, tasks-07-08.md) so partial work survives interruption. You may write
   them yourself or dispatch sonnet subagent writers — your budget, your call; review any
   subagent output against the skeleton before accepting it.
2. Concatenate: plan header (`# Phase 4: Region Flow Page + Rack Chassis Implementation
   Plan`, the standard agentic-workers preamble, Goal/Architecture/Tech Stack one-liners,
   then the skeleton's **Global Constraints** and **File Structure** blocks verbatim) +
   the fragments in task order → `docs/superpowers/plans/2026-07-09-phase4-region-rack.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan; (b) cross-task type
   consistency — T2/T3's imports from T1's `regionData`, T5's from T4's `layoutRacks`,
   exact names and signatures; (c) NOTHING under `src/lib/worldEngine/` is code-modified
   anywhere in the plan (comment-only exception per D2 if taken); (d) every carry-forward
   in spec D10 appears in T7; (e) the AzCanvas edge-aggregation block in T5 is verbatim
   from the current source, only its node-building changed.
4. Commit: `docs: assemble Phase 4 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as Phases 1–3 (ledger and
per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer subagent per task; task-reviewer subagent after each; fix subagents
  for Critical/Important findings; re-review after fixes; ledger line per task under
  `## PHASE 4`.
- Implementer models: per the skeleton's tags (all sonnet this phase — no
  transcription-grade tasks survived decomposition). Reviewers: sonnet. Final
  whole-branch review: the most capable model available to you.
- Every implementer prompt carries: the task brief (skill's `task-brief` script), the
  no-engine-changes constraint, the strict-tsc and border-shorthand lessons, and the
  report-file contract.
- UI tasks T2/T3/T5/T6 REQUIRE their live Playwright smokes (strict port 1420, zero app
  console errors, screenshots, stop the server after). T6's pan/zoom drift check is the
  one most likely to catch a real bug — do not skip it.
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8.
- Do not pause between tasks for the user; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Phase 4 exit)

1. Full suite + `npm run build` green.
2. Final whole-branch review (vs the Phase-4 spec + contracts + mockup) verdict "Ready",
   one consolidated fix wave if needed.
3. The spec's phase-gate live story end-to-end with zero console errors: region flow
   under load → AZ kill via its row switch → ribbon + split re-share + drain line +
   timeline events → Stop → timeline click scrubs the app → rack frame with live chassis
   (LEDs, micro-bars, differing U-heights) → chassis click opens the server interior.
4. `docs/module-boundaries.md` §M updated (T8 owns it).
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + drift state
   (expected: none). The user then merges `phase4-region-rack` → main or proceeds to
   Phase 5 planning.

## 6. After Phase 4 (for whichever session plans Phase 5)

Phase 5 (r3f globe) planning needs: umbrella §5 Level 1 + the mockup's Level-1 globe
panel (`views-overview-v2.html`), the contracts doc (`WorldMetrics.populationRoutes`,
`VisualArc` payloads via `attachRenderer({level:'globe'})` — the engine ALREADY builds
capped arc payloads (`buildArcs`, ≤200), unlike the empty region scope), new deps
`three`/`@react-three/fiber`/`@react-three/drei` (umbrella §9 row 5), NASA Blue/Black
Marble textures to source and bundle (public domain), `.superpowers/sdd/contract-drift.md`
(expect no Phase-4 entries), and the Phase-4 open-items list. Parked items that stay
parked: replication-lag modeling, recovery countdown, region-scope particles.
