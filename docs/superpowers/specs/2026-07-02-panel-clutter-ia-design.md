# Panel clutter / information-architecture fix

Date: 2026-07-02
Status: implemented

## Problem

`App.tsx` mounts `PropertiesPanel`/`SimConfigPanel` (Inspector), `ReportsPanel`,
and `DiagnosticsPanel` as independent right-edge overlays, each toggled by its
own Toolbar button with no coordination between them. Both `ReportsPanel` and
`DiagnosticsPanel` use `position: fixed; right: 0; width: 340px` — identical
screen real estate — so opening both stacks one directly on top of the other
(confirmed via a user screenshot showing Diagnostics rendered on top of the
Simulation Inspector). Separately, real working features (Packet templates,
ScaleScript import/export, region/provider config) are only reachable through
small dropdown menus a first-time user has no reason to open.

## Decision

1. **Merge Reports + Diagnostics into one tabbed dock (`UtilityDock`).** Both
   panels are structurally near-identical already — header with title/count,
   optional filter chips, scrollable list of cards, click-a-row to select the
   related node on canvas. A single dock with a `Diagnostics | Reports` tab
   strip removes the overlap entirely (only one tab visible at a time), keeps
   both panels' full functionality unchanged (no logic touched, only the
   shell around them), and gives each tab its own count badge so neither
   becomes less discoverable than before. One toolbar button ("Dock") opens
   it; clicking a tab switches instead of opening a second overlay.

2. **Leave Inspector (`SimConfigPanel`) / `PropertiesPanel` as-is.** They are
   already mutually exclusive via `AnimatePresence mode="wait"` in `App.tsx`
   and occupy the body flex row (not a fixed overlay), so they don't
   contribute to the stacking bug. They also serve a different purpose
   (live/pre-run node & system configuration, 480px/260px wide) than the Dock
   (post-hoc diagnostics/report review, 340px) — folding them into the same
   tab strip would force the wider Inspector into a narrow tab panel and hurt
   both. Kept as a separate concern.

3. **`PacketEditor` stays a centered modal.** It was never part of the
   right-edge stacking bug (it's `position: fixed; inset: 0` with a backdrop,
   `PacketEditor.module.css`). Its own CRUD bugs are explicitly out of scope
   for this pass (CLAUDE.md Roadmap item: "actively buggy, verify before
   extending"). To address the "cool features nobody finds" half of the
   complaint, the toolbar's panel-toggle buttons are visually grouped and
   consistently styled as a distinct cluster from one-shot actions (Undo,
   Export, Simulate), so Packets/Inspect/Dock read as "persistent UI you can
   open," not stray buttons.

4. **Toolbar regrouping.** Inspect / Dock / Packets become one visually
   labeled "Panels" group with consistent active-state affordance (each is a
   toggle, not an action). The former separate Reports + Diagnostics buttons
   become a single Dock button carrying both badges (error/warn count and run
   count) so neither piece of information is lost by merging the buttons.

## Rejected alternatives

- **Left-side dock for Diagnostics/Reports.** Considered moving one of the
  two to the left, opposite the node palette. Rejected: both panels operate
  on "the currently selected/relevant node," and users' eyes are already on
  the right side of the screen where Properties/Inspector live — moving only
  one of the two would still leave two independent toggles with no shared
  state, reintroducing the "which of these 3 buttons is open" confusion this
  fix targets. A single dock with tabs is a strictly smaller cognitive load.
- **Command palette.** Would help discoverability of ScaleScript/Terraform
  import-export, but is a bigger, separate feature (new keybinding, fuzzy
  search UI, its own interaction model) than this pass's scope justifies.
  Left as a natural follow-up, not attempted here.

## Non-goals

- No change to `particleEngine.ts`, lint rule logic, cost model, or the
  packet registry's data model.
- No change to `PacketEditor.tsx` internals/bugs.
- No new persistence (Reports still in-memory only, per existing TODO).

## Files touched

- `src/app/store/ui.store.ts` — replace `reportsPanelOpen`/`diagnosticsOpen`
  with a single `dockOpen` + `dockTab: 'diagnostics' | 'reports'`.
- `src/app/toolbar/Toolbar.tsx` / `Toolbar.module.css` — collapse two buttons
  into one Dock toggle with dual badges; group Inspect/Dock/Packets visually
  under a "Panels" label.
- New `src/app/dock/UtilityDock.tsx` + `UtilityDock.module.css` — tab shell
  hosting the existing `DiagnosticsPanel`/`ReportsPanel` content, unchanged.
- `src/app/diagnostics/DiagnosticsPanel.tsx`, `src/app/reports/ReportsPanel.tsx`
  — drop their own `position: fixed` chrome (header/close button now owned by
  the dock shell); internals (filters, cards, run detail overlay) unchanged.
- `src/App.tsx` — mount `UtilityDock` instead of the two separate panels.
- `docs/module-boundaries.md` — document the new `dock/` module and the
  removed direct Toolbar → panel wiring.
