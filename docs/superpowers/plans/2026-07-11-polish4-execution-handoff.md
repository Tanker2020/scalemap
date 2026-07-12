# Polish 4 Execution Handoff — Contextual Dock / Drawers / Timeline v2 / Globe Traffic

**You are a fresh Claude session executing Polish 4 of Scalemap.** You have no prior context;
this runbook bootstraps you. Work autonomously; do not check in between tasks.

## Step 0 — Bootstrap (do these in order, before any task)

1. Read `CLAUDE.md` (repo root) — project overview, architecture, laws.
2. Read the spec: `docs/superpowers/specs/2026-07-11-polish4-contextual-dock-design.md`
   (decisions D1–D12 — the requirements).
3. Read the skeleton: `docs/superpowers/plans/polish4/skeleton.md` (tasks T1–T8, exact files
   and signatures — the plan).
4. Open the binding mockups in a browser (visual truth):
   - `docs/superpowers/specs/mockups/polish4-dock-v2.html` — docks + drawers (interactive).
   - `docs/superpowers/specs/mockups/polish4-round1-locked.html` — timeline §3 (with causality
     arrows) + globe traffic §4 ONLY (its §1–§2 are superseded by v2).
5. Check the ledger: `cat .superpowers/sdd/progress.md` — if a `## POLISH 4` section exists,
   resume at the first task not marked complete; NEVER re-dispatch completed tasks.
6. Verify a clean start: `git status` clean; `git log --oneline -1` at or after `34742c2`.
7. Create the branch: `git checkout -b polish4-contextual-dock` (from main). If it already
   exists, `git checkout polish4-contextual-dock` and reconcile with the ledger.
8. Baseline: run `npx vitest run` once — record the passing count (expected ≥ 615); this is
   the floor every task must preserve.

## Execution method

Use **superpowers:subagent-driven-development**: fresh implementer subagent per task
(`scripts/task-brief` on the skeleton file — each `## T<N>` section is one task), task review
after each (spec compliance + code quality), fix loops for Critical/Important, Minors to the
ledger, ONE final whole-branch review at the end on the most capable model.

- **Models:** implementers on Sonnet (the skeleton specs are complete); reviewers on Sonnet;
  final whole-branch review on the most capable available model.
- **Task order:** T1 first (everything depends on scope/rail/selection). Then T2 → T3 → T4
  sequentially (all three modify `WorldPanel.tsx` — the hub file this phase; do NOT
  parallelize them). T5 after T4. T6 and T7 are independent of T2–T5 and of each other —
  slot them anywhere after T1. T8 last.
- **Every dispatch carries the skeleton's Global Constraints block verbatim** plus the one-line
  scene-setting ("Polish 4: the dock scopes itself to nav + selection; you are building task
  T<N>").
- Implementer contract: implement, add the named tests, run the covering test files AND
  `npx vitest run` (full suite — WorldPanel is high-fan-in), self-review, commit
  (`feat(dock): …` / `feat(region): …` / `feat(globe): …` per task; end commits with the
  standard co-author line), report status.
- Ledger after each clean review:
  `T<N>: complete (commits <base7>..<head7>, review clean)` under `## POLISH 4`.

## Review lenses (give these to every task reviewer)

1. **Frozen contracts:** zero diffs under `src/lib/worldEngine/`; `nav.store.ts` untouched;
   `world.store.ts` no new actions; ui.store gains only `selectedServerId`;
   `routing.test.ts` unmodified-and-passing (T7's refactor is behavior-identical).
2. **Relocated-dispatch:** every moved/restyled control calls the pre-existing store action
   with the same arguments — diff the dispatch call sites against their origins (InspectorV2,
   TopologyPanel, PlacementPanel, floor toolbar).
3. **Laws:** price token on every money value; no emojis; edit-lock/run-lock titles verbatim;
   motion budget (one ambient stroke per dock, timeline zero, ratified exceptions only);
   reduced-motion on every animation; singular-aware copy; tokens below instrument headers.
4. **Test honesty:** new tests assert behavior (dispatch fired, pv re-voiced, scope derived),
   not implementation details; migrated tests (InspectorV2 → faceplate, TimelineStrip →
   TimelineV2) keep their original assertions.

## Done bar (all must hold before you report READY TO MERGE)

- All eight tasks complete in the ledger; full suite green (count ≥ baseline; expect it to
  GROW); `npm run build` green.
- `git diff main --stat -- src/lib/worldEngine/` is EMPTY.
- Live smoke (`npm run dev`, browser): dock follows globe → region → AZ → server; selecting a
  floor server flips the dock to the faceplate; rail pills widen; drawers open one-at-a-time
  with readouts visible closed; start the sim → watchband + gauges + 2.2s pulse + kill lights
  up; kill an AZ → timeline shows lanes/bands/markers/narration; stop → click a marker scrubs;
  arm "+ traffic" → city snap + preview card + ghost arc → click places + overlay opens; esc
  cancels. Check light theme once.
- `docs/module-boundaries.md` updated (T8).
- Ledger closes with `## POLISH 4 COMPLETE` summarizing commits, test count, deviations.

**Do not merge.** Leave the branch pushed-or-local per your environment and report READY TO
MERGE with the ledger summary; the maintainer verifies and merges.

## Escalation

If a skeleton signature can't work as written (missing export, type mismatch), prefer the
smallest faithful adaptation and record it in the ledger under `Deviations`. If a spec decision
conflicts with observed reality (e.g. a metrics field doesn't exist), STOP that task and record
BLOCKED in the ledger rather than inventing engine changes.
