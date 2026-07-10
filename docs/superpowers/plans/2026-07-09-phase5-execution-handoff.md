# Phase 5 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Phase 5 (r3f globe + traffic authoring)
of Scalemap's world-model rebuild. Everything you need is in this repo. Phases 1–4 are
merged to `main`; create branch `phase5-globe` from `main` and work there. Do not use a
more expensive model than you are; dispatch cheaper subagents per the model assignments
below.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN. Phase 5's only
   engine change is extending `buildArcs` inside `src/lib/worldEngine/index.ts` (spec
   D4 / skeleton T2); `VisualArc` already defines all three arc kinds, so no type edits.
   Forced drift → `.superpowers/sdd/contract-drift.md` `## PHASE 5`, never silently.
3. `docs/superpowers/specs/2026-07-09-phase5-globe-design.md` — the 10 design decisions.
4. `docs/superpowers/plans/phase5/skeleton.md` — 7 task specs (exact signatures,
   semantics, named test cases, model tags).
5. `docs/superpowers/specs/mockups/views-overview-v2.html` — the Level-1 globe panel is
   the binding visual truth (the region/rack panels shipped in Phase 4; ignore them).
6. Skim a Phase-4 fragment (`docs/superpowers/plans/phase4/fragments/tasks-01-03.md`) as
   format precedent, and the umbrella spec §5 Level 1.

## 2. State you inherit

NO pre-written plan fragments for Phase 5 — expected, not an error (the skeleton carries
what fragment writers would have needed; Phases 3–4 shipped fine this way).
`.superpowers/sdd/progress.md` holds Phases 1–4 precedent, including the Phase-4 open
items this phase's Task 7 absorbs. Note two environment facts: (a) populations/traffic/
routing currently have NO authoring UI — the Phase-2/4 smokes used the DEV
`window.__scalemapDebug` hook, which remains available to you for smoke setup until T6
ships the real UI; (b) `three`/`@react-three/fiber`/`@react-three/drei` are NOT installed
until T1.

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–7, write its full plan section (complete code, failing-test-first,
   exact commands with expected output, live-smoke checklist where the skeleton names
   one, commit step) from the skeleton's task spec. Ground everything in real source
   FIRST: resolve actual `three`/`r3f`/`drei` versions against the registry (React 19
   host); read the current `vite.config.ts` before adding `manualChunks`; quote the
   current `buildArcs` verbatim in T2's Modify step and read the failover fixtures in
   `src/lib/worldEngine/index.test.ts` before writing T2's tests; read `REGION_GEO`
   (`src/lib/world/regionGeo.ts`) for the pin coordinate shape; read `WorldPanel.tsx` and
   an existing panel for the T6 conventions. For `geo.ts` expected values, verify the
   spherical math with a scratch Node harness before baking numbers into tests. Write
   sections to `docs/superpowers/plans/phase5/fragments/` as you go (tasks-01-02.md,
   tasks-03-05.md, tasks-06-07.md). You may write them yourself or dispatch sonnet
   subagent writers — your budget, your call; review any subagent output against the
   skeleton before accepting.
2. Concatenate: plan header (`# Phase 5: R3F Globe + Traffic Authoring Implementation
   Plan`, standard agentic-workers preamble, Goal/Architecture/Tech Stack one-liners,
   then the skeleton's **Global Constraints** and **File Structure** verbatim) + the
   fragments in task order → `docs/superpowers/plans/2026-07-09-phase5-globe.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan; (b) cross-task
   consistency — T3/T4/T5 imports from T1's `geo.ts`, T6's props into T3's
   `GlobeSceneProps`, exact names; (c) the ONLY `src/lib/worldEngine/` modification in
   the whole plan is T2's `buildArcs` (+ its test file and the one internal Map the
   skeleton sanctions); (d) every R3F component the plan declines to jsdom-test says so
   explicitly and names its live-smoke gate; (e) spec D10 carry-forwards all appear in T7.
4. Commit: `docs: assemble Phase 5 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as Phases 1–4 (ledger and
per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer per task; task-reviewer after each; fix subagents for
  Critical/Important; re-review; ledger line per task under `## PHASE 5`.
- Implementer models: per skeleton tags (all sonnet). Reviewers: sonnet. Final
  whole-branch review: the most capable model available to you.
- Every implementer prompt carries: the task brief, the engine-scope constraint (T2 only),
  the R3F frame-loop discipline (refs not setState, no per-frame allocations, dispose on
  unmount), strict-tsc + border-shorthand lessons, and the report-file contract.
- Live smokes REQUIRED for T3/T4/T5/T6 (strict port 1420, zero app console errors,
  screenshots, stop server after). Two smoke gates deserve extra care: T3/T4's texture
  orientation + pin calibration (a mirrored or offset texture puts us-east-1 in the
  ocean — this is THE most likely real bug of the phase), and T7's fps probe.
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7.
- Do not pause between tasks; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Phase 5 exit)

1. Full suite + `npm run build` green (three vendor chunk in place; no new chunk-size
   regressions beyond it).
2. Final whole-branch review (vs the Phase-5 spec + contracts + mockup) verdict "Ready",
   one consolidated fix wave if needed.
3. The spec's phase-gate live story end-to-end with zero console errors: author regions +
   population via the NEW Traffic tab (globe place-mode included) → night globe with
   calibrated pins and markers → client arc under load → region kill → red pulsing pin +
   drain arc → TTL expiry re-points the arc → pin click → region page. Plus: fps probe
   ≥30, reduced-motion pass, WebGL-fallback pass.
4. `docs/module-boundaries.md` §N updated (T7 owns it).
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + drift state
   (expected: one informational engine-internal item from T2). The user then merges
   `phase5-globe` → main or proceeds to Phase 6 planning.

## 6. After Phase 5 (for whichever session plans Phase 6)

Phase 6 (analysis rule engine + LLM reviewer) planning needs: umbrella §7 (the three
deterministic rule families over the COMPILED world + the D14 BYO-endpoint LLM reviewer
with schema-forced JSON), the contracts doc (`ReplayFrame`s + latest `MetricsBatch` as
LLM context, per its "What Phases 3–5 may rely on" §), `CompiledWorld`/`CompileFinding`
in `src/lib/world/types.ts` (the compile findings pipeline the rule engine extends — note
`WorldPanel`'s Findings tab renders them today), the Tauri store decision for API keys
(spec D14: keys via Tauri local store, NEVER serialized into `.scalemap` — a Rust-side
`commands.rs` addition), and the Phase-5 open-items list. Phase 6 is the last phase; the
parked list after it (umbrella §9) stays parked.
