# Polish 3 Execution Handoff — Runbook for a Fresh Session (Opus/Sonnet controller)

You are a session with NO prior context executing Polish 3 of Scalemap: the per-level design
overhaul — Region v4, the Option A isometric datacenter floor (replacing the React Flow AZ
canvas), Server Board v5 (RJ45 intake, rule-slat shield, substrate instruments), Dock v2
signature headers, the rack document model, and the app-wide motion budget + price token.
Polish 1 and Polish 2 are merged; create branch `polish3-level-redesign` from `main`
(≥ `5a54022`) and work there. Do not use a more expensive model than you are; dispatch
cheaper subagents per the skeleton's model tags.

## 1. Read these, in order (nothing else is required context)

1. This file, fully.
2. `docs/superpowers/specs/2026-07-11-polish3-level-redesign-design.md` — the 12 design
   decisions (D1–D12) and the testing posture.
3. **Open `docs/superpowers/specs/mockups/level-redesign-v5.html` in a browser** — the
   binding visual truth, locked with the user over five rounds. It is interactive: hover the
   region's DB rows (replica-rail reveal), press ▶ on the datacenter floor (the add-server
   boot animation you are building), watch the RJ45 jack's pin ripple + ACT LED and the
   shield's edge-dot/sparks. The "Round 5 — everything is LOCKED" footer is the decision
   record. Transcribe CSS from this file; never eyeball.
4. `docs/superpowers/plans/polish3/skeleton.md` — 8 task specs (files, exact signatures,
   binding semantics, named test cases, model tags, Global Constraints, File Structure).
5. `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — FROZEN; this phase touches
   NOTHING under `src/lib/worldEngine/`. Forced drift → `.superpowers/sdd/contract-drift.md`
   `## POLISH 3`, never silently.

## 2. State you inherit

NO pre-written plan fragments — expected; Step 0 below writes them. `.superpowers/sdd/
progress.md` holds every prior phase; append under `## POLISH 3`. Environment facts:
(a) the user's own dev server may already be running on the strict port 1420 — if
`npm run dev` fails with port-in-use, that server serves the same working tree via HMR and
your Playwright session can use it directly; (b) the theme toggle is live (⚙ Settings) —
every new surface gets dark AND light screenshots; (c) Polish 2 shipped `HoldToEnter`
(`holdProgress`/`HoldRing`, `HOLD_DURATION_MS = 700`) and `SceneOverlay`/`sceneOverlay` on
the globe — T3/T4 reuse those primitives, never fork them; the tap = overlay / hold = drill
grammar is app law; (d) drei Html `occlude` is KNOWN BROKEN in the globe scene — irrelevant
to this phase unless you touch the globe: don't; (e) `Server.rack` is currently REQUIRED and
`factories.createServer` seeds `rack-1/unit 1` — T2 changes exactly that, and `layoutRacks.ts`
/ `AzCanvas.tsx` need only a `rack !== null` filter shim until T4 deletes them; (f) a parked
engine follow-up (dependency fan-out health-filtering) exists in the ledger — NOT yours.

## 3. Step 0 — write and assemble the plan (before any implementation)

1. For every task 1–8, write its full plan section (complete code, failing-test-first, exact
   commands with expected output, live-smoke checklist where the skeleton names one, commit
   step) from the skeleton's task spec. Ground everything in real source FIRST:
   - `src/lib/theme.ts` + `useThemeBootstrap` in `App.tsx` (T1 — confirm tokens are written
     generically), and `grep -rn '\$' src/app/world --include='*.tsx'` for the money sweep;
   - `src/lib/world/types.ts`, `factories.ts`, `serializer.ts`, `world.store.ts`'s `mutate()`
     pattern and its existing tests (T2 copies the CRUD/undo discipline exactly);
   - the current `region/` components + `regionData.ts` and their tests (T3 restyles the
     shipped structure — the user explicitly said fix the existing shape, don't replace it);
   - `AzCanvas.tsx`'s aggregation block (T4's `aggregateFlows` ports it verbatim, tests
     included), `InspectorV2.tsx`'s selection seam, `WorldShell.tsx`'s level mount,
     `HoldToEnter.tsx`'s exports, and `grep -rn '@xyflow' src/` before touching package.json;
   - `server/`'s `NicBlock/FirewallGate/HardwarePlatform/ServiceChip/TraceLayer/
     InspectorRail` + `gateStats.ts`/`useServerDisplayMetrics.ts`/`boardLayout.ts` and ALL
     their tests (T5/T6 must name the exact metric fields they bind — throughput, per-core
     utilization, steal, disk-IO, queue/connections — from what those files already surface;
     if a metric isn't surfaced, extend the app-side hook additively, NEVER the engine);
   - `WorldPanel.tsx` + every tab file and the Polish 1/2 tests around `pendingPanelTab`,
     tab ink, and the summary strip (T7 must leave them passing untouched);
   - the mockup's CSS blocks per view (transcribe hex/clip-paths/keyframes/timings).
   Write sections to `docs/superpowers/plans/polish3/fragments/` (tasks-01-03.md,
   tasks-04-05.md, tasks-06-08.md). You may write them yourself or dispatch sonnet writers —
   review any subagent output against the skeleton before accepting.
2. Concatenate: plan header (`# Polish 3: Per-Level Design Overhaul Implementation Plan`,
   the standard agentic-workers preamble, Goal/Architecture/Tech Stack one-liners, then the
   skeleton's **Global Constraints** and **File Structure** verbatim) + fragments in task
   order → `docs/superpowers/plans/2026-07-11-polish3-level-redesign.md`.
3. Self-review the assembled plan (fix inline): (a) placeholder scan; (b) cross-task
   consistency — T4 consumes T2's exact store action names and `rackModel` signatures, T4
   reuses `HoldToEnter`'s exact exports, T5/T6 bind metric fields that actually exist, T8's
   inventory covers every animation T3–T7 added; (c) NOTHING under `src/lib/worldEngine/` is
   modified anywhere; (d) every restyled control's dispatch is byte-identical to its source
   (the skeleton names each); (e) serializer compat: a pre-Polish-3 `.scalemap` fixture loads
   in a test; (f) animation/isometric work gates on live smokes, not fake jsdom assertions.
4. Commit: `docs: assemble Polish 3 implementation plan` (include the fragments dir).

## 4. Execute

Use the superpowers subagent-driven-development skill exactly as prior phases (ledger and
per-task reports in `.superpowers/sdd/` are precedent):

- Fresh implementer per task; task-reviewer after each; fix subagents for Critical/Important;
  re-review; ledger line per task under `## POLISH 3`.
- Implementer models: all sonnet (T4 is the largest — if it BLOCKS or thrashes, split its
  dispatch into layout/data-pure vs. scene-assembly halves rather than escalating models
  first). Reviewers: sonnet. Final whole-branch review: the most capable model available —
  instruct it to check four lenses: the relocated-dispatch contract, mockup fidelity per
  view, the motion budget (≤ ~8 strokes/view, reduced-motion clean), and doc-model/serializer
  backward compatibility.
- Live smokes REQUIRED for T3/T4/T5/T6/T7 and the T8 phase gate (port 1420, zero app console
  errors, dark + light screenshots per view, reduced-motion spot-checks — stop the server
  after unless it is the user's, per §2(a)).
- Task order: T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8. T2's shim keeps the old AZ canvas alive
  until T4 lands its replacement — the app never loses the AZ level between tasks.
- Do not pause between tasks; stop only for BLOCKED or genuine ambiguity.

## 5. Done bar (Polish 3 exit)

1. Full suite + `npm run build` green (build also proves @xyflow/react is gone).
2. Final whole-branch review (spec + mockup + the four lenses above) verdict "Ready", one
   consolidated fix wave if needed.
3. The T8 phase-gate story live end-to-end with zero console errors, screenshotted to
   `.superpowers/sdd/screenshots/polish3-*`.
4. `docs/module-boundaries.md` §R + CLAUDE.md Key Dependencies updated (T8 owns both).
5. A pre-Polish-3 `.scalemap` file (any example/vault world) opens, edits, saves, reopens.
6. Append to `.superpowers/sdd/progress.md`: phase summary + open items + drift state
   (expected: none). The user then merges `polish3-level-redesign` → main.

## 6. After Polish 3

Remaining backlog: Option B (issue #23), drag-to-rack on the floor (deferred by D5), the
parked dependency fan-out engine fix, the umbrella §9 parked list, and the ledger's
accumulated Minors. Each is a fresh brainstorm/spec cycle.
