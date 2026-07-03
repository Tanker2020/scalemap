# Toolbar Declutter — Design

## Problem

`Toolbar.tsx` currently renders ~18 top-level controls (New, Open, Save, Export▾,
Import▾, Provider▾, Select/Hand/Connect, theme toggle, Undo/Redo, a 4-button Panels
group, an optional ScaleScript pill, and a Simulate split-button) in a single 42px
row. At real laptop widths this exceeds the window width, and the only mitigation
today is `overflow-x: auto` on `.toolbar` (`Toolbar.module.css:10-15`), explicitly
documented in a comment as a stopgap: "the full button set... can exceed the
window's width... Scroll rather than clip/squish so every button stays reachable."

A scrollable toolbar hides controls (including the Simulate/End buttons) off the
visible edge, which is the bug this spec fixes. Two prior decluttering passes
already moved other chrome off the canvas edges (node palette → icon rail,
Properties/SimConfig → floating top-right card, Diagnostics+Reports → unified
bottom-right dock, see `docs/superpowers/specs/2026-07-02-panel-clutter-ia-design.md`
and `2026-07-02-canvas-first-overlay-layout-design.md`) — the top toolbar itself is
the one area not yet addressed.

## Goals

- Eliminate horizontal scrolling on the toolbar at realistic window widths (≥1024px),
  with a guaranteed fallback so it never scrolls at any width.
- Reduce idle-state top-level control count from ~18 to ~9 by consolidating file
  operations behind one menu and making the tool cluster icon-only.
- While a simulation is running or paused, hide controls that are already
  functionally locked (they're currently `disabled` but still take up full width),
  freeing space for the controls that matter during a run.
- No behavior change to simulation locking itself — only the *visibility* of
  already-disabled controls changes, driven by the same `running` flag that
  already gates them.

## Non-goals

- No changes to `simulation.store.ts`, `canvas.store.ts`, or any state shape —
  this is presentation-only.
- No new automated test infra introduced for this change (matches the rest of the
  UI layer today — verified manually per the project's UI-testing convention).
- Not addressing the broader product/feature brainstorm from the same conversation
  (audience expansion, simulation realism) — that's tracked separately.

## Design

### Three toolbar states

Driven entirely by existing `running` / `paused` booleans from `useSimulationStore`
and the existing `showHome` flag from `useFileStore` — no new state.

**1. Idle** (`!showHome && !running`)

```
[📁 File ▾]  [☁ Provider ▾]   |   ▻ ⊞ ⚡ (icon-only Select/Hand/Connect)   |   ↶ ↷        [spacer]        [Panels: Inspect · Dock · Packets · Diagnostics]   [⚙ script pill]   [▶ SIMULATE ▾]          ☀/☾
```

- `File ▾` is a new single dropdown replacing today's separate `Save` button,
  `ExportMenu`, and `ImportMenu` components: New, Open, Save, an `Export ▸` submenu
  (Terraform / ScaleScript), an `Import ▸` submenu (ScaleScript / Terraform, disabled
  while `running` as today).
- `Provider ▾` (existing `ProviderMenu`) stays a separate top-level button — it's a
  graph-wide mutation, not file I/O, kept distinct per design discussion.
- Select/Hand/Connect become icon-only (drop the text label, keep the icon);
  tooltips carry the label + existing keyboard shortcut (V/H/C, unchanged).
- Undo/Redo, the Panels group, the ScaleScript pill, and the Simulate split-button
  are unchanged in content and behavior — only their horizontal position shifts as
  a result of the space freed up to their left.
- Theme toggle moves out of the main control flow entirely, to a fixed position at
  the far right of the toolbar (outside the flex flow that can overflow) — it's
  not diagram-related and shouldn't compete with action controls for space.

**2. Simulating / Paused** (`!showHome && running`)

```
[🔒 <filename>]                                                      [spacer]      [Panels: Inspect · Dock · Packets · Diagnostics]   [⚙ script pill]   [■ Pause | ▶ Resume]  [⏹ End]          ☀/☾
```

- `File ▾`, `Provider ▾`, Select/Hand/Connect, and Undo/Redo are removed from the
  DOM (not just `disabled`) — every one of them is already a no-op while running
  (see `Toolbar.tsx`'s existing `disabled={running}` / `title={running ? 'Editing
  locked...' : ...}` props on these exact controls).
- A new `LockedIndicator` component fills that space: a small chip showing a lock
  icon + the current file name (falls back to "Untitled" when `fileName` is null,
  matching `SaveButton`'s existing `fileName?.replace('.scalemap', '') || 'diagram'`
  fallback pattern), so file context isn't lost while the bar is shorter. Not
  interactive (no click behavior) — purely informational.
- Panels group stays fully live and interactive — Inspect/Dock/Packets/Diagnostics
  already work while running today and that doesn't change.
- The existing Simulate split-button's running-state rendering (Pause/Resume +
  End) is unchanged; it just has more room now.
- Theme toggle stays pinned in its fixed corner regardless of state.

Paused is treated identically to running for this layout (both are `running ===
true` in the store; `paused` only changes which sub-button renders inside the
existing split-button, as it does today).

### Overflow safety net

Even after consolidation, a pathologically narrow window (roughly <900px) could
still in theory not fit every remaining control. Add a lightweight `⋯ More`
overflow button to the toolbar's flex container: any direct child that doesn't fit
in the available width collapses into a dropdown behind `⋯` instead of being
clipped or forcing a scrollbar. This is a safety net, not the primary fix — in the
common case (≥1024px) nothing should ever land in it.

Implementation approach: a `useToolbarOverflow`-style measurement (ResizeObserver
on the toolbar container + child refs, comparing cumulative width against
available width) is the standard pattern here since there's no existing
overflow-detection utility in the codebase to reuse. Keep this isolated to
`Toolbar.tsx`/a new small hook — it has no reason to touch any store.

### Component/file changes

| File | Change |
|---|---|
| `src/app/toolbar/Toolbar.tsx` | Replace `SaveButton`/`ExportMenu`/`ImportMenu` call sites with one new `FileMenu` component (keeps `ProviderMenu` separate, unchanged). Add `LockedIndicator` component. Convert Select/Hand/Connect buttons to icon-only. Move theme toggle button to a fixed-position slot outside the scrollable/overflow-managed flex group. Split the existing `{!showHome && (...)}` block into idle-only vs always-visible-while-editing groups keyed additionally on `running`. |
| `src/app/toolbar/Toolbar.module.css` | New classes for icon-only tool buttons (drop text, keep padding/hit-target size), `.lockedIndicator` chip styling (reuse existing chip/pill visual language from `.scriptPill`/`.reportsBadge`), fixed-position theme toggle slot, `.toolbarOverflow`/`.overflowMenu` for the `⋯ More` fallback. Remove the now-unnecessary `overflow-x: auto`/scrollbar styles once the overflow-menu fallback lands (or keep as a final fallback — decide during implementation if the measurement approach ever has a gap). Existing `.panelGroup`, `.btnSimulate`, `.simSplitGroup` etc. styles untouched. |
| New: `src/app/toolbar/FileMenu.tsx` (or inline in `Toolbar.tsx`, TBD at implementation time based on resulting file size) | Consolidates New/Open/Save/Export/Import into one dropdown with submenus. |
| New: `LockedIndicator` (inline in `Toolbar.tsx` given its small size, similar to existing inline `SaveButton`/`ExportMenu`) | Renders the 🔒 filename chip. |

No changes to any Zustand store, `particleEngine.ts`, `serializer.ts`, or any
non-toolbar file.

### Testing / verification

No automated toolbar tests exist today (matches the rest of the UI layer per
`CLAUDE.md`'s Known Issues). Verify manually via `npm run tauri dev`:

- Idle state at 1440px, 1024px, and 900px window widths, both themes — confirm no
  scrollbar, all controls reachable, File/Provider menus open/close correctly,
  icon-only tools show correct tooltips.
- Start a simulation, confirm File/Provider/Tools/Undo-Redo disappear and the
  locked-filename chip appears with the correct name (including the no-file/new
  diagram case).
- Pause → Resume → End, confirming the split-button's existing behavior is
  unaffected by the surrounding layout change.
- Force a narrow width (~700px) to confirm the `⋯ More` overflow catches whatever
  doesn't fit, with no scrollbar appearing at any width.
- Toggle theme in both idle and running states to confirm the corner-pinned toggle
  remains reachable and styled correctly in both.

## Out of scope / follow-ups

- A fully context-aware toolbar that reflows per *diagram state* (e.g. empty
  canvas vs. populated) was not requested — this design only reacts to
  `running`/`paused`, not diagram content.
- Broader product/audience-expansion ideas and simulation-realism work
  (`SRE_Critique.txt` blueprints) are a separate conversation thread, not part of
  this spec.
