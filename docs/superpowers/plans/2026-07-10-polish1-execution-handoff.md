# Polish 1 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing the first post-rebuild polish phase of
Scalemap: the user-approved HYBRID panel design system, the examples vault, and one
carried replay bug. The six-phase world-model rebuild is complete and merged; create
branch `polish-panels-vault` from `main` (≥ `bf0b78e`) and work there. Do not use a more
expensive model than you are; dispatch cheaper subagents per the model assignments below.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-10-polish-panels-vault-design.md` — the 7 design
   decisions.
3. **Open `docs/superpowers/specs/mockups/panels-hybrid-v1.html` in a browser** — the
   binding visual truth. The user approved the HYBRID option: Direction A's skin
   (section rules, edge-lit rows, chips, glow) carrying Direction B's widgets (derived-
   hint fields, preset cards, segmented controls, explainers). The "Today, for
   reference" block is the anti-goal. The vault grid at the bottom is the home-screen
   design verbatim.
4. `docs/superpowers/plans/polish1/skeleton.md` — 8 task specs (exact signatures,
   semantics, named test cases, model tags).
5. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN; this phase
   touches NOTHING under `src/lib/worldEngine/` (D7). Forced drift →
   `.superpowers/sdd/contract-drift.md` `## POLISH 1`, never silently.
6. Skim a recent fragment (`docs/superpowers/plans/phase6/fragments/tasks-05-08.md`) as
   format precedent.

## 2. State you inherit

NO pre-written plan fragments — expected (the skeleton is the complete source; Phases
3–6 shipped this way). `.superpowers/sdd/progress.md` holds all prior phases + the
post-Phase-6 note. Environment facts: (a) the theme toggle is LIVE (Settings ⚙) — every
restyled panel gets dark AND light screenshots; (b) the user's own dev server may be
running on the strict port 1420 — if `npm run dev` fails with port-in-use, the running
server serves the same working tree via HMR and your Playwright session can use it
directly (a planning session did exactly that); (c) the analysis engine
(`src/lib/analysis/`) is the oracle for the vault's findings contracts — read its rule
triggers before building the teaching world.

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–8, write its full plan section (complete code, failing-test-first,
   exact commands with expected output, live-smoke checklist where the skeleton names
   one, commit step) from the skeleton's task spec. Ground everything in real source
   FIRST: the current panel files and their EXISTING test files (the restyle contract —
   same dispatches, same patches — depends on reading them); `INSTANCE_CATALOG`;
   `src/lib/world/factories.ts` and an analysis-test fixture for the vault's
   doc-building idiom; `newWorld`'s file-store resets (T6 mirrors them); the mockup's
   CSS blocks (transcribe hex/spacing values from the file, don't eyeball). For
   `derived.ts` expected numbers and the teaching world's findings count, verify with a
   scratch Node script before baking into tests. Write sections to
   `docs/superpowers/plans/polish1/fragments/` as you go (tasks-01-04.md, tasks-05-08.md).
   You may write them yourself or dispatch sonnet subagent writers — your budget, your
   call; review any subagent output against the skeleton before accepting.
2. Concatenate: plan header (`# Polish 1: Hybrid Panel System + Examples Vault
   Implementation Plan`, standard agentic-workers preamble, Goal/Architecture/Tech
   Stack one-liners, then the skeleton's **Global Constraints** and **File Structure**
   verbatim) + fragments in task order →
   `docs/superpowers/plans/2026-07-10-polish1-panels-vault.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan; (b) cross-task
   consistency — T2–T4 import T1's kit components with the exact props, T6 imports T5's
   `VAULT`/`VaultEntry`, T7's `resetSession` callers; (c) NOTHING under
   `src/lib/worldEngine/` is modified anywhere; (d) every restyle task extends its
   panel's existing test file and keeps every existing dispatch assertion; (e) the four
   vault worlds' findings contracts match the spec exactly (0/0/0/≥10-spanning-families).
4. Commit: `docs: assemble Polish 1 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as prior phases (ledger
and per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer per task; task-reviewer after each; fix subagents for
  Critical/Important; re-review; ledger line per task under `## POLISH 1`.
- Implementer models: all sonnet. Reviewers: sonnet. Final whole-branch review: the most
  capable model available — instruct it to check the restyle contract (unchanged store
  semantics) and mockup fidelity as its two lenses.
- Live smokes REQUIRED for T2/T3/T4/T6 and the T8 phase gate (port 1420, zero app
  console errors, dark + light screenshots per restyled panel, stop the server after —
  unless it is the user's, per §2(b)).
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8.
- Do not pause between tasks; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Polish 1 exit)

1. Full suite + `npm run build` green.
2. Final whole-branch review (vs the spec + mockup + restyle contract) verdict "Ready",
   one consolidated fix wave if needed.
3. The spec's phase-gate live story end-to-end with zero console errors: home →
   "Everything wrong at once" opens on the Analysis tab with ≥10 grouped findings → fix
   one via the restyled firewall stack → 3-tier example simulating with live topology
   bars → workload slider hint updates live → New leaves no stale scrubber →
   multi-region kill still tells the TTL story → every panel screenshotted dark + light.
4. `docs/module-boundaries.md` §P updated (T8 owns it).
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + drift state
   (expected: none). The user then merges `polish-panels-vault` → main.

## 6. After Polish 1

Remaining backlog: the umbrella §9 parked list (k8s/ECS schedulers, ScaleScript v2,
Terraform v2, AI watch-mode, spot instances, managed-service internals) and the ledger's
accumulated cosmetic Minors — each a fresh brainstorm/spec cycle. No further polish
phase is planned; new UI work should reuse the `src/app/world/ui/` kit this phase
establishes.
