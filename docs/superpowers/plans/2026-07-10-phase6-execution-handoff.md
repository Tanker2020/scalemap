# Phase 6 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Phase 6 — the FINAL phase of
Scalemap's world-model rebuild: the deterministic analysis rule engine, the
BYO-endpoint LLM reviewer, and the global Settings surface (live theme toggle).
Phases 1–5 are merged to `main`; create branch `phase6-analysis` from `main` and work
there. Do not use a more expensive model than you are; dispatch cheaper subagents per
the model assignments below.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN. Phase 6 is a
   read-only consumer (latest `MetricsBatch` as analysis/LLM input); the only engine
   touch is Task 9's sanctioned `export MAX_GLOBE_ARCS` one-liner. Forced drift →
   `.superpowers/sdd/contract-drift.md` `## PHASE 6`, never silently.
3. `docs/superpowers/specs/2026-07-10-phase6-analysis-llm-design.md` — the 11 design
   decisions. D6's key-security invariants are non-negotiable and appear in the
   skeleton's Global Constraints — carry them into EVERY implementer prompt for T5–T8.
4. `docs/superpowers/plans/phase6/skeleton.md` — 9 task specs (exact signatures,
   semantics, named test cases, model tags).
5. Umbrella spec §7 (`docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md`)
   — the rule families and D14 the phase spec implements.
6. Skim a Phase-5 fragment (`docs/superpowers/plans/phase5/fragments/tasks-06-07.md`)
   as format precedent.

## 2. State you inherit

NO pre-written plan fragments — expected, not an error (the skeleton is the complete
source; Phases 3–5 shipped this way). `.superpowers/sdd/progress.md` holds Phases 1–5
precedent + the Phase-5 open items Task 9 absorbs. Environment facts: (a) the theme
system (LIGHT_COLORS, App.tsx `useThemeBootstrap`, persisted `ui.store.themeMode`) is
fully wired but has never had UI — T7's toggle makes it live for the first time, so
expect the light-mode smoke to surface hardcoded-hex stragglers (fix them in T9);
(b) Rust commands live in ONE file (`src-tauri/src/commands.rs`) by repo convention —
append, don't modularize; (c) the browser dev server uses `src/lib/tauriMock.ts` —
your Playwright smokes exercise the MOCK transport; the Rust transport's gate is
`cargo test`/`cargo build`; (d) an antivirus false-positive once deleted Vite
pre-bundle entries mid-phase (Phase 5) — if the dev server 504-thrashes on new deps,
suspect that before blaming code (there are no new npm deps this phase, so it should
not recur).

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–9, write its full plan section (complete code,
   failing-test-first, exact commands with expected output, live-smoke checklist where
   the skeleton names one, commit step) from the skeleton's task spec. Ground
   everything in real source FIRST: `compileWorld`/`CompiledWorld`/`CompileFinding`
   and `src/lib/world/network.ts`'s exported helpers (T1–T3); the engine test fixtures
   (`src/lib/worldEngine/index.test.ts`) as the fixture-builder style; `WorldPanel.tsx`
   and its test (T4); `commands.rs`/`lib.rs`/`tauri.ts`/`tauriMock.ts` patterns and
   Tauri v2's actual arg/struct casing behavior (T5 — verify, don't assume);
   `WorldShell.tsx` header + key handling (T7); `theme.ts` exports (T7/T8);
   `REGION_GEO` (T3). For rule-trigger and haversine expected values, verify arithmetic
   with a scratch Node script before baking numbers into tests. Write sections to
   `docs/superpowers/plans/phase6/fragments/` as you go (tasks-01-04.md, tasks-05-08.md,
   task-09.md). You may write them yourself or dispatch sonnet subagent writers — your
   budget, your call; review any subagent output against the skeleton before accepting.
2. Concatenate: plan header (`# Phase 6: Analysis Engine + LLM Reviewer Implementation
   Plan`, standard agentic-workers preamble, Goal/Architecture/Tech Stack one-liners,
   then the skeleton's **Global Constraints** and **File Structure** verbatim) + the
   fragments in task order → `docs/superpowers/plans/2026-07-10-phase6-analysis-llm.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan; (b) cross-task
   consistency — T2/T3 rules registered in T1's `ANALYSIS_RULES`, T4 imports
   `runAnalysis`/`AnalysisFinding` exactly, T6's `LlmSettings` matches T5's TS wrapper,
   T8 imports T4's `navigateToEntity` and T6's client, T7/T8 share the
   `openSettings` prop chain; (c) key-security invariants each have at least one
   asserting test or smoke step (context canary scan, redaction test, masked render
   test, saved-file grep); (d) no new npm dependency anywhere; (e) the only
   `worldEngine/` edit in the plan is the T9 export.
4. Commit: `docs: assemble Phase 6 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as Phases 1–5 (ledger and
per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer per task; task-reviewer after each; fix subagents for
  Critical/Important; re-review; ledger line per task under `## PHASE 6`.
- Implementer models: per skeleton tags (all sonnet). Reviewers: sonnet. Final
  whole-branch review: the most capable model available to you — instruct it to
  specifically audit the D6 key-security invariants end-to-end as its first pass.
- Rust tasks (T5): run `cargo build` AND `cargo test` from `src-tauri/` in the task's
  verify steps; a green frontend build does not gate Rust.
- Live smokes REQUIRED for T4/T7/T8 (strict port 1420, ZERO app console errors,
  screenshots, stop the dev server AND the T8 stub after). T7's theme flip and T8's
  two-hit retry proof are the load-bearing checks.
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9.
- Do not pause between tasks; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Phase 6 exit — and rebuild completion)

1. Full suite + `npm run build` + `cargo build` + `cargo test` green.
2. Final whole-branch review (vs the Phase-6 spec + contracts + D6 security
   invariants) verdict "Ready", one consolidated fix wave if needed.
3. The spec's phase-gate live story end-to-end with zero console errors: multi-family
   findings with working navigation chips → Settings-configured stub endpoint →
   review with live retry proof → AI cards beside deterministic findings → masked key +
   no key in the saved file → live light-mode flip with a screenshot pass over
   globe/region/AZ/server (stragglers fixed).
4. `CLAUDE.md` rewritten for the world-model app; `docs/module-boundaries.md` §O.
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + drift state +
   a REBUILD COMPLETE note (six of six phases shipped; the umbrella's parked list is
   what remains). The user then merges `phase6-analysis` → main.

## 6. After Phase 6

The rebuild is feature-complete. Whatever comes next (parked-list items: k8s/ECS
schedulers, ScaleScript v2, Terraform v2, AI watch-mode, spot instances,
managed-service pseudo-internals; or the accumulated backlog Minors in the ledger)
starts from a fresh brainstorm/spec cycle against the umbrella spec — there is no
Phase 7 to plan.
