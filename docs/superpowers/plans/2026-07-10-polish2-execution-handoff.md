# Polish 2 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Polish 2 of Scalemap: in-scene command
overlays with the hold-to-enter drill gesture, the guided-console dock (world summary,
traffic hero, plain-language sentences), and the app-wide motion pass. Polish 1 (the hybrid
panel kit + examples vault) is merged; create branch `polish2-overlays-motion` from `main`
(≥ `4a0cdf7`) and work there. Do not use a more expensive model than you are; dispatch
cheaper subagents per the skeleton's model tags.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-10-polish2-config-ux-design.md` — the 9 design decisions.
3. **Open `docs/superpowers/specs/mockups/config-overlays-v1.html` in a browser** — the
   binding visual truth, and it is interactive: press-and-hold the green pin (the drill
   gesture you are building), click the amber/teal pins (overlay variants), drag both
   sliders, expand the sentence rows, hover every motion-inventory card. The "✓ DECIDED"
   footer states the binding nav semantics.
4. `docs/superpowers/plans/polish2/skeleton.md` — 7 task specs (files, exact signatures,
   binding semantics, named test cases, model tags, Global Constraints, File Structure).
5. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN; this phase
   touches NOTHING under `src/lib/worldEngine/`. Forced drift →
   `.superpowers/sdd/contract-drift.md` `## POLISH 2`, never silently.
6. Skim `docs/superpowers/plans/polish1/fragments/tasks-01-04.md` as fragment-format
   precedent (Polish 1 shipped exactly this way).

## 2. State you inherit

NO pre-written plan fragments — expected; Step 0 below writes them. `.superpowers/sdd/
progress.md` holds every prior phase; append under `## POLISH 2`. Environment facts:
(a) the user's own dev server may already be running on the strict port 1420 — if
`npm run dev` fails with port-in-use, that server serves the same working tree via HMR and
your Playwright session can use it directly; (b) the theme toggle is live (⚙ Settings) —
every new surface gets dark AND light screenshots; (c) the globe already has: an
`autoRotate` prop on GlobeScene, a rotation-lock button in GlobeView, fixed-10px pin labels
with an `isFrontFacing` horizon test in RegionPin's `useFrame` — your hold-ring and overlay
work composes with all three (do not regress them; drei Html `occlude` is KNOWN BROKEN in
this scene — never reintroduce it); (d) `SpecBar` in the kit is built-but-unconsumed — if a
capacity bar you build fits it, consuming it retires a Polish 1 carry-forward (optional,
note it in the ledger either way).

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–7, write its full plan section (complete code, failing-test-first,
   exact commands with expected output, live-smoke checklist where the skeleton names one,
   commit step) from the skeleton's task spec. Ground everything in real source FIRST:
   - the current `RegionPins.tsx`/`PopulationMarkers.tsx`/`GlobeView.tsx` (the gesture and
     overlay wiring build on this month's exact code, not on memory);
   - `TopologyPanel.tsx`'s role-select dispatch (T4 copies it byte-for-byte) and
     `TrafficPanel.tsx`'s NumberField commit discipline + existing dispatch tests;
   - `WorldPanel.tsx`'s pendingPanelTab initializer + the three vault tests that depend on
     it (T4 must leave them passing untouched);
   - `ui.store.ts`, `derived.ts`, `kit.tsx`'s injected-stylesheet pattern;
   - the compiled world's routing-table shape for the "lands on <region>" hints, and
     `worldEngine/index.ts`'s entry-blueprint predicate (READ ONLY — T5 reimplements it
     purely);
   - `InspectorRail.tsx`'s firewall rows, captions, and their existing tests;
   - the CostTab's cost rollup helper (T5's summary strip reuses it);
   - the mockup's CSS blocks (transcribe hex/spacing/timing values from the file, don't
     eyeball).
   For `frontlineCapacityRps` expected numbers and the ruleSentence copy, verify with a
   scratch Node script before baking into tests. Write sections to
   `docs/superpowers/plans/polish2/fragments/` (tasks-01-04.md, tasks-05-07.md). You may
   write them yourself or dispatch sonnet writers — your budget, your call; review any
   subagent output against the skeleton before accepting.
2. Concatenate: plan header (`# Polish 2: Command Overlays + Guided Console + Motion
   Implementation Plan`, the standard agentic-workers preamble, Goal/Architecture/Tech
   Stack one-liners, then the skeleton's **Global Constraints** and **File Structure**
   verbatim) + fragments in task order →
   `docs/superpowers/plans/2026-07-10-polish2-overlays-motion.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan; (b) cross-task
   consistency — T3/T4 use T2's `HoldRing`/`holdProgress` and T1's kit classes with the
   exact exported names, T4's overlays mount inside T3's shells, T5 imports T1's
   `useRollingNumber`; (c) NOTHING under `src/lib/worldEngine/` is modified anywhere;
   (d) every relocated control's dispatch is byte-identical to its source (the skeleton
   names each source); (e) the R3F pieces have live-smoke checklists, not fake jsdom tests.
4. Commit: `docs: assemble Polish 2 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as prior phases (ledger and
per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer per task; task-reviewer after each; fix subagents for
  Critical/Important; re-review; ledger line per task under `## POLISH 2`.
- Implementer models: all sonnet. Reviewers: sonnet. Final whole-branch review: the most
  capable model available — instruct it to check three lenses: the relocated-dispatch
  contract (byte-identical store writes from new places), mockup fidelity, and the nav
  semantics (tap = overlay, hold = drill, esc/click-away, a11y paths intact).
- Live smokes REQUIRED for T2/T3/T4/T5/T6 and the T7 phase gate (port 1420, zero app
  console errors, dark + light screenshots per new surface, reduced-motion spot-check on
  T2 and T7 — stop the server after unless it is the user's, per §2(a)).
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7. T2 deliberately keeps tap = navigate as an
  interim so the app never loses drill-down between tasks; T3 flips tap to overlay.
- Do not pause between tasks; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Polish 2 exit)

1. Full suite + `npm run build` green.
2. Final whole-branch review (spec + mockup + the three lenses above) verdict "Ready", one
   consolidated fix wave if needed.
3. The spec's phase-gate story live end-to-end with zero console errors (multi-region
   example: tap-overlay → chips/role/kill → hold-drill → population slider → traffic hero
   warning → sim running with rolling numbers/ripples/ink/shimmer → reduced-motion pass →
   light-mode pass, all screenshotted to `.superpowers/sdd/screenshots/polish2-*`).
4. `docs/module-boundaries.md` §Q updated (T7 owns it).
5. Append to `.superpowers/sdd/progress.md`: phase summary + open items + drift state
   (expected: none). The user then merges `polish2-overlays-motion` → main.

## 6. After Polish 2

Remaining backlog: the umbrella §9 parked list, the ledger's accumulated Minors, and the
natural follow-up this phase sets up — mounting `HoldToEnter` on the deeper levels
(region → AZ → server) once the globe pattern proves out. Each is a fresh brainstorm/spec
cycle; new UI work keeps building on `src/app/world/ui/`.
