# Diagnostics Panel Redesign — Design

Date: 2026-07-02
Status: approved (delegated task, design compressed — see note below)

## Note on process

This task arrived as a fully-specified delegated brief (problem statement, files to
read, explicit open-ended creative latitude, verification steps, constraints) rather
than an open-ended idea needing interactive discovery. Auto Mode is active and there
is no user available for iterative Q&A on visual specifics. This doc records the
design decisions and reasoning directly instead of a multi-turn brainstorming
transcript, per the brief's instruction to "use your judgment on ambiguous design
decisions and document your reasoning."

**Base-commit correction:** the brief describes the panel as already living inside
the "Living Circuit" design-system pass (CSS custom properties `var(--color-*)`,
`themeMode`, `theme.ts` token names like `DARK_COLORS`/`CATEGORY_COLORS.accent`).
This worktree's actual base commit (`c5fd7b4`) predates that entire pass — `theme.ts`
here still exports the original flat `COLORS`/`CATEGORY_COLORS` hex objects, there is
no `themeMode` in `ui.store.ts`, no light/dark toggle, and `DiagnosticsPanel.module.css`
is still hardcoded hex (`#0F1116`, `#2A2E38`, etc.), matching every other panel at
this point in history. Other sibling worktrees are further along on that pass and
one has already begun touching Diagnostics independently ("merge Diagnostics +
Reports into a single tabbed dock"). Per the standing instruction to work with what's
actually in front of me, this redesign targets the **real current state of this
worktree** — hardcoded hex tokens sourced from `theme.ts`'s `COLORS`/`CATEGORY_COLORS`,
single (dark) theme, no `themeMode` — rather than the design-system vocabulary the
brief assumed. The verification step asking for light/dark-mode screenshots is
adjusted accordingly: there is only one theme to screenshot here (no toggle exists
to switch into a "light mode" — the light/dark pass hasn't reached this worktree).
This keeps the change mergeable against its actual base rather than introducing a
parallel, conflicting theme system inside a task that isn't supposed to touch
theming at all.

## Problem

The diagnostics panel (`DiagnosticsPanel.tsx`) is functionally complete — severity
filtering, click-to-select — but visually reads as a placeholder: a flat scrolling
list of cards with no grouping, no visual differentiation between issue *kinds*, no
canvas linkage beyond selecting a node (no pan/focus), and chain-shaped issues
(`circularDependency`, `deepSyncChain`) show their path as a text string
("A → B → C") rather than a visual.

## Goals

1. Group issues so the panel reads as organized triage, not a dump.
2. Give chain-type issues (cycle, deep sync chain) an actual inline path visualization.
3. Make clicking an issue *do more* — select AND pan/center the canvas on the
   affected node(s), with a visible pulse so the user's eye finds it.
4. Make the all-clear state feel like a reward, not a blank panel.
5. Stay inside the existing Living Circuit visual language — CSS custom properties,
   restrained motion, JetBrains Mono / existing type scale. No new color values
   outside `theme.ts` tokens.

## Non-goals

- Changing lint rule detection logic (`rules.ts`, `lintGraph.ts` stay behaviorally
  identical — verified by not touching existing test expectations in
  `rules.test.ts`).
- Continuous/background linting — stays on-demand via the toolbar button.
- Touching PacketEditor/CostTracker/EventLogPanel/ReportsPanel.

## Design

### 1. Data model addition (additive only)

`LintIssue` gains one optional field:

```ts
path?: string[]   // ordered node ids for chain-shaped issues (cycle / deep sync chain)
```

Populated in `circularDependency` (the cycle array is already exactly this) and
`deepSyncChain` (requires tracking the actual longest-path predecessor chain
alongside the existing `maxDepth` map — today the rule only tracks depth as a
number, not the path that produced it). Both rules keep emitting the exact same
`LintIssue[]` shape/count/message/recommendation they do today; `path` is a new,
optional, purely-additive field, so `rules.test.ts` is unaffected and no consumer
that ignores `path` breaks.

### 2. Grouping

Issues are grouped by `ruleId` into collapsible sections, each with:
- The rule's icon (reuse category-appropriate lucide icon — e.g. `RefreshCcw` for
  circular dependency, `Unplug` for isolated node, `ShieldAlert` for exposed DB) and
  a short human title ("Circular Dependencies", "Exposed Databases", ...).
- A count badge and the group's worst severity color as an accent bar.
- Sections sorted: any section containing an `error` issue first, then `warn`-only
  sections; stable-sorted by first-seen order within each tier so it doesn't jitter
  between runs with the same issues.
- Sections default **expanded** (this app has ≤9 rules, never a huge list — collapse
  would just add clicks) but are individually collapsible for a large-graph run with
  many hits of one kind.

The severity filter chips (All/Errors/Warnings) already in the toolbar-adjacent
header stay, now filtering within groups (a group with 0 visible issues after
filtering collapses out entirely).

### 3. Chain path visualization

For any issue with a `path`, render a horizontal chip strip inline in the issue
card: `[icon] Label  →  [icon] Label  →  [icon] Label`, using each node's real
`NODE_CONFIG` icon and category accent color, truncating the middle with a `+N more`
chip if the path is long (>5 nodes) so a 7-hop deep-sync chain doesn't blow out the
340px panel width. Clicking a chip focuses that specific node (see §4); clicking
elsewhere on the card focuses the primary `nodeId` and highlights the whole path.

### 4. Canvas linkage

New minimal, additive state in `ui.store.ts`:

```ts
highlightedNodeIds: string[]   // nodes to render a pulse-highlight ring on
setHighlightedNodes: (ids: string[]) => void
```

Clicking an issue card:
1. `setSelectedNode(issue.nodeId)` (existing behavior, unchanged).
2. `setHighlightedNodes(issue.path ?? [issue.nodeId])` — the whole cycle/chain if
   present, else just the one node.
3. Dispatches a pan-to-node request that `Canvas.tsx` picks up via a small
   `useEffect` on `highlightedNodeIds`, using React Flow's `fitView({ nodes, padding
  : 0.3, duration: 400 })` scoped to just the highlighted node ids — centers and
   zooms to fit the affected node(s) without wrenching zoom to fit the entire graph.
4. Highlight auto-clears after ~2.2s (CSS animation `animationend`-driven or a timer)
   so it reads as a pointer/pulse, not a permanent state that fights the user's own
   selection.

`BaseNode.tsx` reads `highlightedNodeIds.includes(id)` and applies a new
`.diagnosticPulse` class — a ring in `var(--color-accent)` (severity is already
conveyed by the node's own lint badge/dot; the pulse's job is purely "look here,"
not re-communicating severity) — animated via CSS `@keyframes` (respects
`prefers-reduced-motion` globally, same as the existing `breathe` keyframe).

This is additive to `ui.store.ts` and a small `useEffect` + one CSS class in
`Canvas.tsx`/`BaseNode.tsx` — no restructuring of canvas state, no touching
`canvas.store.ts`.

### 5. Summary strip

Below the header, above the filter chips: a one-line health summary —
"3 issues found · 1 critical" (error-count-aware phrasing) or, when zero, nothing
(the empty state below takes over the whole body). This reuses `SEVERITY_COLOR`
already in the panel; no new tokens.

### 6. Empty state

Replace the current static "No anti-patterns detected" block with:
- A `ShieldCheck` icon inside a soft radial glow (`color-mix` with
  `var(--color-success)`, same pattern `BaseNode`'s breathing glow already uses)
  that does one gentle scale/opacity entrance via framer-motion (spring, matches
  `BaseNode`'s existing entrance transition for consistency) — not a looping
  animation, so it doesn't compete for attention or violate reduced-motion norms
  beyond what's already accepted elsewhere in the app.
- Title stays "No anti-patterns detected", subtitle becomes slightly more specific:
  shows the count of rules actually checked ("9 checks passed") so it reads as
  *evidence* of a real pass, not a generic placeholder.

### 7. Visual/interaction summary of card anatomy (per issue)

```
┌───────────────────────────────────────────┐
│ ⚠  Exposed Databases                    2 │  ← group header (collapsible)
├───────────────────────────────────────────┤
│  ✕  API Gateway connects directly to df    │  ← existing message
│     Insert a cache or queue between them   │  ← existing recommendation
│     [🗄 orders-db]                          │  ← existing single-node ref (unchanged
│                                             │     shape when no `path`)
├───────────────────────────────────────────┤
│  ✕  Circular dependency: A → B → C → A     │
│     Break the cycle by introducing...      │
│     [⚙A]→[⚙B]→[⚙C]→[⚙A]                    │  ← NEW: path chip strip
└───────────────────────────────────────────┘
```

## Testing / verification

- `npm run build` (typecheck) and `npx vitest run --exclude '**/.claude/**'` (must
  stay at ≥80 passing, `rules.test.ts` untouched/still green — the `path`
  computation is exercised indirectly by the existing `circularDependency`/
  `deepSyncChain` tests since they check `.nodeId`/`.length`, not `path`, so no test
  changes are needed, but I will eyeball the new `path` output manually against
  those same fixtures.).
- Manual Playwright pass: load a constructed graph with an isolated node + exposed
  database + circular dependency, run diagnostics, screenshot panel in dark and
  light mode, click an issue and confirm pan + pulse.
