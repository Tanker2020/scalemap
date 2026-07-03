# Canvas-first overlay layout

Date: 2026-07-02
Status: approved, not yet implemented

## Problem

`App.tsx`'s `.body` is a flex row: `NodePalette | canvasColumn | Properties/SimConfig | UtilityDock`. Every one of these siblings permanently reserves horizontal space, whether or not it's currently useful — the Node Palette is always present even though it's only needed while placing nodes, and when Properties/Inspector and the Dock are both open they can leave less than half the window for the actual diagram on a laptop-sized screen (confirmed by user screenshot: three ~19%-wide columns squeezing the canvas into a strip down the middle). This supersedes the "leave Inspector/Properties in the flex row, not a fixed overlay" decision from `2026-07-02-panel-clutter-ia-design.md` #2 — that call was correct for fixing the Diagnostics/Reports stacking bug, but it's the reserved-column behavior itself that's now the problem.

Confirmed via brainstorming with the user (visual mockup comparison — see conversation): direction chosen is "canvas-first overlay," where the canvas is always the full size of the window and every side panel becomes a floating overlay instead of a layout column.

## Decision

### Canvas fills the window

`App.tsx`'s `.body` drops the flex-row of side columns. `Canvas` (plus `MetricsDrawer`, unchanged, still docked under it) is the only element that participates in `.body`'s layout flow and always renders at 100% of the available width/height under the `Toolbar`. `NodePalette`, `PropertiesPanel`/`SimConfigPanel`, and `UtilityDock` become `position: fixed` siblings, anchored to a corner/edge of the canvas area, rendered on top rather than pushing it — the same pattern `PacketEditor` already uses (`position: fixed; inset: 0` centered modal, unchanged by this spec).

### NodePalette → icon rail + flyout

Collapses to a ~44px icon rail fixed to the left edge, one icon per existing category (Compute, Network, Storage, Messaging, Caching, Orchestration, Grouping). Two ways to open the full flyout (search box + draggable node list, same content as today):

- **Hover** a category icon → flyout peeks open immediately; moving the pointer away (with a ~150ms grace delay to avoid flicker crossing from rail to flyout) closes it again.
- **Click** a category icon (or the rail itself) → flyout **pins** open; stays open until the user clicks elsewhere on the canvas or clicks the rail again.

Dragging a node out of a hover-peeked (unpinned) flyout works the same as from a pinned one — pin state only controls whether the flyout stays open with no pointer interaction, not whether drag works. The flyout auto-closes after a node is successfully dropped onto the canvas.

**Auto-collapse during simulation:** while `useSimulationStore.getState().running` is true, the rail forces itself back to icon-only and ignores hover/click — matches "you shouldn't be creating nodes mid-run" and reuses the fact that node/edge editing is already locked while running. Implemented as local state (`pinned: boolean`) plus an effect inside `NodePalette.tsx` watching `simulation.store`'s `running`; no new global store field, since nothing else needs this state.

### PropertiesPanel / SimConfigPanel → floating card, top-right

Same content, same mutually-exclusive `AnimatePresence` swap between Properties and the Inspector (`simConfigOpen`) that exists today — only the container becomes a `position: fixed` card anchored to the canvas's top-right corner instead of a flex column. Mounts only when there's something to show (`selectedNodeId`, `selectedEdgeId`, or `simConfigOpen` truthy); unmounts otherwise, freeing that corner entirely when nothing is selected. Stays visible (already read-only via the existing `fieldset disabled={running}`) during a run — per explicit user decision, only the Palette auto-hides on run start, not Properties.

### UtilityDock → bottom drawer

Same tab strip (`Diagnostics | Reports`), same toggle from the Toolbar's Dock button, same `dockOpen`/`dockTab` state in `ui.store.ts` — only the container changes from a flex column to a `position: fixed` drawer anchored to the bottom edge, sliding up over the canvas instead of shifting it left. Its max-height is capped so that on narrow windows it can't grow tall enough to overlap the Properties card's bottom-right corner — a fixed safety margin, not new coordination logic between the two components.

### Left unchanged

- `PacketEditor` — already a fixed-overlay modal (verified: `position: fixed; inset: 0; z-index: 9996`).
- `MetricsDrawer` (the "Live Metrics" strip docked under the canvas) and the bottom `StatusBar` — both stay exactly as they are today, per explicit user decision.
- All panel *internals* — Identity/Status/Cost fields, Diagnostics rule groups, Reports run list, node palette search/categories — untouched. This is a chrome/positioning refactor only.

### Z-index order (top to bottom)

1. `PacketEditor` modal (existing `9996`)
2. `Toolbar` (existing sticky/fixed top bar)
3. `NodePalette` flyout / `PropertiesPanel` card / `UtilityDock` drawer (new fixed-overlay layer, all equal — they don't overlap by design per corner/edge placement + the Dock height cap above)
4. `Canvas` (ReactFlow pane + particle canvas)

## Rejected alternatives

- **Collapsible-rail-but-same-columns** (keep the three-column mental model, just make each column collapse to a thin rail in place). Shown to the user alongside the chosen overlay approach as a visual mockup comparison; rejected in favor of the overlay model, which guarantees full canvas width/height at all times rather than "canvas width minus whatever rails are currently expanded."
- **Auto-collapsing Properties and/or the Dock during a run**, considered as a broader auto-hide rule. Rejected per explicit user choice: Properties should stay available to inspect live node state during a run, and Diagnostics/Reports are exactly the things worth watching mid-run.
- **Packets editor and Live Metrics bar as opt-in overlays.** Considered making both on-demand to further maximize canvas space. Rejected per explicit user choice: Packets already behaves correctly as a modal (no change needed) and the Live Metrics bar is compact enough to leave always-visible.
- **Properties panel follows the selected node** (tooltip/callout style). Rejected per explicit user choice in favor of a fixed top-right anchor — predictable location, never covers the node just clicked, no drift.

## Non-goals

- No change to `particleEngine.ts`, lint rule logic, cost model, packet registry data model, or any simulation/business logic.
- No change to `PacketEditor.tsx` internals or its known bugs (out of scope, per `2026-07-02-panel-clutter-ia-design.md`).
- No new persistence and no new global `ui.store.ts` fields beyond what's already there — the only new state is local to `NodePalette.tsx`.
- No command palette / discoverability feature (previously rejected in `2026-07-02-panel-clutter-ia-design.md`, still out of scope here).

## Files touched

- `src/App.tsx` — remove the `.body` flex-row composition of `NodePalette`/`Properties`+`SimConfigPanel`/`UtilityDock`; `Canvas` becomes the sole flex child; the other three mount as fixed-position siblings.
- `src/app/sidebar/NodePalette.tsx` / `NodePalette.module.css` — icon rail + hover-peek/click-pin flyout, run-triggered auto-collapse effect.
- `src/app/sidebar/PropertiesPanel.tsx` (and the `SimConfigPanel` wrapper currently in `App.tsx`) / associated `.module.css` — swap flex-column chrome for a `position: fixed` top-right card.
- `src/app/dock/UtilityDock.tsx` / `UtilityDock.module.css` — swap flex-column chrome for a `position: fixed` bottom drawer with a capped max-height; update the file's existing comment (written when the flex-row placement was deliberate) to reflect the new fixed-overlay approach.
- `docs/module-boundaries.md` — update to reflect that Palette/Properties/Dock are now fixed-overlay siblings of Canvas rather than flex-row columns.

## Verification

This is a layout/positioning refactor, not new business logic (aside from the small run-triggered auto-collapse effect in NodePalette) — so verification is primarily driving the running app rather than unit tests:

- Playwright pass at a simulated laptop viewport (~1280×800): confirm the canvas fills the full window with no panels open; confirm each panel's hover/click/pin/auto-close behavior; confirm the Palette force-collapses and ignores interaction once a simulation is running; confirm Properties stays interactive-but-read-only and the Dock stays fully usable during a run.
- Full existing test suite (`npx vitest run --exclude '**/.claude/**'`) must stay green — this refactor shouldn't touch any file that suite currently covers, but confirms no accidental regression.
- User will also do their own manual pass on real hardware before considering this done, and may request further, more drastic changes based on that pass — this spec covers the first iteration, not necessarily the final word.
