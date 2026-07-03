# Module Boundaries & Ownership Map

Goal: let multiple people work in this codebase at once with minimal merge conflicts,
by making explicit which files belong to which feature area, which files are shared
"hubs" that everyone touches (and therefore need a light-touch convention), and what
the blast radius of a change in each area actually is.

This is a *code organization* map, not a service-decomposition proposal — see the
note at the bottom on why microservices aren't the fix for merge conflicts here.
Findings below were pulled from CodeGraph's call-graph/blast-radius index
(`.codegraph/`), not just file layout, so "who imports this" is call-verified,
not guessed from folder structure.

---

## 1. Feature modules (safe to own independently)

Each block below is a vertical slice — one person/PR can usually work entirely
inside it without touching another slice's files.

### A. Canvas graph editing
Nodes/edges CRUD, undo-redo, packet registry, drag/drop.

| File | Role |
|---|---|
| `src/app/store/canvas.store.ts` (249 lines) | Nodes/edges state, history/future undo stack, packet registry |
| `src/app/canvas/Canvas.tsx` | React Flow wrapper, registers node/edge types — `MiniMap`/`Background` are configured via inline props (not `Canvas.module.css`), so their colors are `var(--color-*)` CSS-variable strings passed directly as prop values rather than class-based; touch alongside `Canvas.module.css` if the canvas-chrome palette changes again (design-system task 9). **Simulation lock (2026-07-02):** every structural-edit entry point (`onNodeContextMenu`, the global keydown handler's Delete/Backspace/undo/redo, `onNodeDragStopHandler`) now gates on `useSimulationStore.getState().running` — this was previously only enforced by ReactFlow's `nodesDraggable`/`nodesConnectable`/`nodesFocusable` props, which don't cover context menus, keyboard shortcuts, or `NodeResizer`. If you add a new node/edge mutation trigger anywhere in the canvas (new keyboard shortcut, new context-menu action, new toolbar button that touches `canvas.store`), it must independently check `running` — there is no single choke point that catches all of them |
| `src/app/canvas/nodes/BaseNode.tsx` | Compute/network/storage node rendering — `statusColor`/`saturationBorderColor`/`lintColor` (lines ~69-92) already resolve through `var(--color-*)` tokens, so they're theme-reactive. `utilColor`'s low-utilization fallback was fixed (final-review-fix-round, see `.superpowers/sdd/final-review-fix-report.md`) to use the component's existing `accentColor` (theme-aware, resolves `CATEGORY_COLORS[category].accent` in dark / `.foreground.light` in light) instead of the raw dark-mode-only `colors.accent` — one-line swap, `colors.accent` itself is still read elsewhere in this file for the `--node-bg`/`--node-border` CSS custom properties (unaffected, those are deliberately category-tinted not theme-tinted) |
| `src/app/canvas/nodes/GroupNode.tsx` | Container node rendering (VPC/subnet/cluster/etc) — deliberately static: same 12px corner-radius family as `BaseNode` (visual resemblance), but no breathing glow/hover-lift/per-category saturation, so containers stay recessive relative to the nodes placed inside them (design-system task 7) |
| `src/app/canvas/edges/BaseEdge.tsx` | Edge rendering |
| `src/app/sidebar/PropertiesPanel.tsx`, `ContextMenu.tsx`, `EdgeConfigForm.tsx` | Node/edge property editing UI |

**Blast radius:** `BaseNode` has 1 caller (`Canvas.tsx`), `GroupNode` has 1 caller — low fan-out, safe to edit in isolation. `canvas.store.ts`'s packet-registry actions (`addPacketTemplate`/`updatePacketTemplate`/`removePacketTemplate`) are read by `PacketEditor.tsx` and `serializer.ts` — touch those three together.

### B. Simulation engine & live metrics
The particle physics loop and everything that reads its output.

| File | Role |
|---|---|
| `src/app/canvas/simulation/particleEngine.ts` (**~2,450 lines**) | rAF loop, `spawnParticles`, `handleParticleArrival`, `updateAllNodeMetrics` orchestration, `buildSnapshot` — imports the three sub-modules below rather than owning their state directly |
| `src/app/canvas/simulation/particleEngine/circuitBreakers.ts` (169 lines) | `CircuitBreakerEntry`, `getBreaker`/`getAllBreakers`, `recordBreakerResult`, `checkBreakerTransition`, `forceOpenBreakersForNode`, `resetBreakersIfRecovered`, `clearBreakers` |
| `src/app/canvas/simulation/particleEngine/backpressure.ts` (96 lines) | `_activeWorkers`/`_activeConnections`/lambda warm-instance maps, `acquireWorkers`/`releaseWorkerNow`/`scheduleWorkerRelease`, `acquireConnection`/`scheduleConnectionRelease`, `clearBackpressureState` |
| `src/app/canvas/simulation/particleEngine/chaos.ts` (114 lines) | `effectiveMultiplier`, spike/chaos state (`ChaosEntry`, `getChaosFailures`), `clearChaosState` |
| `src/app/canvas/simulation/SimulationOverlay.tsx` | Canvas overlay, batches engine output up to `simulation.store` |
| `src/app/canvas/simulation/useDisplayMetrics.ts` | Live-vs-replay metric resolution hook |
| `src/app/canvas/simulation/PlaybackScrubber.tsx`, `RequestInspector.tsx` | Replay UI, single-particle inspector |
| `src/app/store/simulation.store.ts` (257 lines) | `NodeMetrics`, events, SLO status, inspected request |
| `src/app/store/replay.store.ts`, `metricsHistory.store.ts` | 300-frame health snapshot ring buffer, per-node timeseries |

**Blast radius — still the highest-conflict area in the repo, now split into four files.** `particleEngine.ts` was 2,617 lines in one file with no internal module split; it has since been split (pure code motion, no behavior change) along the lines its own state maps already implied: `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, and `particleEngine/chaos.ts` each export pure(r) functions that the main rAF loop in `particleEngine.ts` calls, passing in the node/edge snapshots and callbacks those functions need rather than the sub-modules importing engine-internal state directly. (`tokenBuckets.ts` was considered but not created — no current logic owns token-bucket state yet; add it only when a fix actually needs it.) The four files are still a fan-in of one (only `particleEngine.ts` imports from the three sub-modules; nothing outside the `particleEngine/` directory imports them directly yet), so this split reduces *internal* merge conflict between concurrent changes to breaker/backpressure/chaos logic, not the file's external blast radius. `useDisplayMetrics` has 7 callers (`BaseNode.tsx`, `PropertiesPanel.tsx`, `SimConfigPanel.tsx`) — safe to extend (new fields), risky to change its signature.

**Event log (`EventLogPanel.tsx` + `EventLogPanel.module.css`, 2026-07-02 pass):** `EventCard` — the per-event card component — is defined in `SimConfigPanel.tsx` (~line 189), not `EventLogPanel.tsx`; **3 importers** (`EventLogPanel.tsx`, `PropertiesPanel.tsx`'s inline events strip, `ReportsPanel.tsx`'s exported summary), so any change to `EventCard`'s external shape (props) fans out to all three — this pass only changed its *internal* rendering (entry animation, critical pulse, semantic icon in place of the plain severity dot), which is safe/additive for all three callers with zero prop changes. `EventLogPanel.tsx` itself gained two purely-internal helpers with no external callers: `collapseRuns()` (run-length-collapses consecutive same-type/same-node events so chaos-mode volume — observed 130+ repeats of one event type in a single run during testing — stays scannable) and `EventRunCard` (renders a run as a collapsed "×N" card, expandable). Both are file-local, not exported. `IncidentCard`'s severity colors were migrated from hardcoded hex (missed by the 2026-07-02 token-migration sweep documented under `theme.ts` below, since that sweep covered CSS modules and most `.tsx` inline styles but this file's incident-card inline styles were added after the sweep's grep pass) to `var(--color-*)`/`color-mix()` in the same commit. No `SimEvent` data model changes — the whole redesign works off fields already captured (`causedByNodeId`, `metricsSnapshot`, `severity`, `type`).

### C. Structural linter
Self-contained, already well-factored for parallel work.

| File | Role |
|---|---|
| `src/lib/lint/types.ts` | `LintIssue`/`LintRule`/`LintContext` types — `LintIssue` gained an optional `path?: string[]` field (2026-07-02, diagnostics redesign) — ordered node ids for chain-shaped issues, purely additive, no existing consumer needs updating to keep compiling |
| `src/lib/lint/rules.ts` (~310 lines) | 9 rules + `LINT_RULES` registry array. `circularDependency` now populates `path` with the detected cycle (data it already computed); `deepSyncChain` now tracks the actual longest-path predecessor chain (previously only tracked `depth` as a number) and populates `path` with it. Neither rule's *detection* logic changed — same issues, same count, same existing fields; `rules.test.ts` required no changes |
| `src/lib/lint/lintGraph.ts` | Builds adjacency once, runs registry |
| `src/lib/lint/classify.ts` | Node-type classification helpers (`isCompute`, `isDatabase`, ...) |
| `src/app/diagnostics/DiagnosticsPanel.tsx` | Redesigned 2026-07-02: groups issues by `ruleId` into collapsible sections (`RULE_META` presentation table maps `ruleId` → title/icon — update this alongside `rules.ts` if a rule's `ruleId` changes, else it silently falls back to a generic "Other Findings" group), renders a severity summary strip, an inline chip-strip path visualization for any issue with a `path` (click a chip to focus just that node), and a rewarding empty-state (glow ring + "N checks passed"). Clicking an issue now calls `useUiStore.setHighlightedNodes()` in addition to the existing `setSelectedNode()`. **No longer owns its own right-edge chrome** (position, header, close button, Escape-to-close) — mounted inside `UtilityDock.tsx`'s shared shell, see §H below |
| `src/app/store/diagnostics.store.ts` | Issue list + nodeId index |

**Blast radius:** low and well-isolated. `lintGraph` has 2 callers (`Toolbar.tsx`). Each rule in `rules.ts` is an independent pure function appended to one array — **two people adding two different rules will only conflict on the `LINT_RULES = [...]` array line**, not on rule logic. Good candidate for genuinely parallel work with near-zero conflict risk already. **New cross-boundary link (2026-07-02):** `DiagnosticsPanel.tsx` now reaches into `src/app/store/ui.store.ts` (`highlightedNodeIds`/`setHighlightedNodes`, additive fields) and that state is read by `src/app/canvas/nodes/BaseNode.tsx` (renders a `.diagnosticPulse` ring, see `BaseNode.module.css`) and `src/app/canvas/Canvas.tsx` (a small `useEffect` calls React Flow's `fitView` scoped to the highlighted node ids on change). This is a one-way, additive dependency — Diagnostics writes, Canvas/BaseNode read — not a restructuring of canvas state; nothing in §A above changed shape.

### D. Cost modeling & cloud pricing
| File | Role |
|---|---|
| `src/lib/costModel.ts` (144 lines) | Simulation traffic → monthly cost |
| `src/lib/cloudRegistry.ts` (~295 lines) | Per-provider service/pricing catalog, egress tiers, provider-aware label rewrite (`resolveProviderLabel`) |
| `src/lib/regionConfig.ts` (58 lines) | Region metadata |
| `src/app/simulation/CostTracker.tsx` | Renders cost output |

**Blast radius:** `costModel.ts` is imported by `BaseNode.tsx`, `particleEngine.ts`, `nodeConfig.ts`, `PropertiesPanel.tsx` — changing its exported function *signatures* ripples into simulation and node rendering; adding new provider pricing data does not.

**Provider-driven label rewrite (2026-07-02):** `cloudRegistry.ts` exports `resolveProviderLabel(nodeType, provider, currentLabel, genericLabel)`, called from the Cloud Provider `<select>`'s `onChange` in `PropertiesPanel.tsx`'s `NodePanel` (~line 385) alongside the existing `updateNodeData(id, { provider })` call — it now also passes `label: resolveProviderLabel(...)` in the same `updateNodeData` call, so provider and label change atomically (one history/undo entry, not two). No new field was added to `CloudServiceSpec`; the rewrite reuses the existing `serviceName` (e.g. `CLOUD_REGISTRY.ec2.aws.serviceName === 'Amazon EC2'`) that was already there for the "Mapped service" hint text. **Overwrite rule:** the label is only rewritten if it currently equals a "known default" for that node type — either `NODE_CONFIG[nodeType].label` (generic) or any provider's `serviceName` for that node type (so aws → gcp → azure hops keep auto-updating). The instant a user types anything else into the Identity/Label field, that string stops matching any known default and every subsequent provider switch leaves it alone — this is a value-equality heuristic, not a dirty-flag, so a user-typed name that happens to collide with a real service name (e.g. typing "Amazon EC2" by hand) is indistinguishable from an auto-set one and remains rewritable; considered acceptable given how unlikely that collision is. Node types with no `CLOUD_REGISTRY` entry (grouping/orchestration types) never render the Cloud Provider section at all, so they're unaffected. Covered by `src/lib/cloudRegistry.test.ts` (10 cases: default rewrite, provider-hop rewrite, revert-to-generic, custom-label preservation across one and multiple switches, unmapped-type fallback, and three real nodeType×provider mappings). `BaseNode.tsx`'s existing `providerBadge` (small colored pill showing `PROVIDER_LABELS[provider]`) is unrelated and untouched — the badge still shows the short provider name (AWS/GCP/Azure) alongside the now-rewritten main label.

### E. Packet system (Flyweight templates)
| File | Role |
|---|---|
| `src/app/simulation/PacketEditor.tsx` | **Redesigned (2026-07-02) as an interactive "packet anatomy" card** — no longer a plain form. Structure: modal shell (manifest list + sliding Generic/Custom segmented toggle, unchanged data flow) → `PacketCard` (header strip with inline-editable name + protocol badge + delete, `PayloadBody` — a draggable/click-to-expand bar whose width is a log-scaled function of `sizeKb`, doubling as the color-override picker) → per-protocol `Pin` rows (`HttpPins`/`EventPins`/`StreamPins`/`DbPins`), where each field is a click-to-flip chip (framer-motion `rotateY`, cross-fades instead under `useReducedMotion()`) rather than a labeled input row. All 4 protocols' fields are unchanged in substance, only presentation. Verified via Playwright: add/edit/delete for all 4 protocols, mode toggle, light+dark, and `prefers-reduced-motion` emulation all confirmed working end-to-end. Fixed a real bug found during the pre-work verification pass: `PROTOCOL_COLOR` hardcoded the pre-harmonization palette (`#4A9EFF`/`#2DD4BF`/`#A78BFA`/`#F5A623`) with no light-mode variant — protocol badges/dots never matched the rest of the app's harmonized `CATEGORY_COLORS` hues or adapted to the theme toggle; now derives dark/light pairs per protocol matching the compute/network/messaging/storage hue families |
| `src/app/simulation/PacketEditor.module.css` | Styles for the above — new: `.card`/`.cardHeader`/`.payloadTrack`/`.payloadFill`/`.pin`/`.pinFlip`/`.pinFace`/`.pinEdit`/`.modeSlider`/`.swatchRow`, all theme-token-driven (`var(--color-*)`, `color-mix()`) per the design-system convention, no hardcoded hex except the curated payload color-swatch values (`#5B9CF6`/`#3FC7B8`/`#9C8CE0`/`#E0A552`/`#EF4444`/`#22C55E` — intentional fixed palette choices, same category as `PacketEditor.tsx`'s own harmonized protocol colors, not a hardcoding violation of the theme-token rule which governs chrome/surface colors) |
| `src/app/store/canvas.store.ts` (packet slice only, lines ~27–103) | Template storage, `packetMode` toggle — untouched by the redesign, same CRUD actions (`addPacketTemplate`/`updatePacketTemplate`/`removePacketTemplate`/`setPacketMode`) |
| `nodeConfig.ts` packet types (`PacketTemplate`, `PacketMode`, `PacketRegistry`, etc.) | Shared types — untouched, no data-model changes were needed for the visual redesign |

**Blast radius:** `PacketRegistry` type has 5 callers spanning `canvas.store.ts` and `serializer.ts` — packet-format changes must update both together or `.scalemap` file round-tripping breaks silently. The redesign only touched `PacketEditor.tsx`/`.module.css` (presentation layer) — `canvas.store.ts`'s packet slice and `nodeConfig.ts`'s packet types are unchanged, so `particleEngine.ts` (which reads `PacketTemplate` to size/color/route particles) and `serializer.ts` (round-tripping) are unaffected.

### F. Terraform export / Vault templates / ScaleScript / Serialization
Each is a narrow, single-direction module with few callers — good isolated-PR candidates.

| File | Role | Callers |
|---|---|---|
| `src/lib/terraform/exportTerraform.ts` (177 lines) | Diagram → HCL string, export-only | Toolbar export action |
| `src/lib/vault/templates.ts` (145 lines) | Prebuilt starter diagrams | `HomeScreen.tsx` |
| `src/lib/scalescript.ts` (205 lines) | DSL types + `applyScaleScript()` resolver | `simulation.store.ts` (`activeScript`) |
| `src/lib/serializer.ts` (36 lines) | `.scalemap` JSON read/write | `file.store.ts`, `tauri.ts` |

### G. Rust / Tauri backend
| File | Role |
|---|---|
| `src-tauri/src/commands.rs` (132 lines) | All Tauri commands: save/load diagram, file dialogs, recent files |
| `src-tauri/src/lib.rs`, `main.rs` | Entrypoint wiring |

Entirely separate language/toolchain from the TS frontend — zero merge-conflict overlap with anything above by construction. Good area for someone to own if they're doing file-persistence work (e.g. wiring up `ReportsPanel.tsx` disk export, a roadmap item).

### H. Utility dock (Diagnostics + Reports) — 2026-07-02, re-anchored 2026-07-02 (canvas-first overlay pass)

Panel-clutter fix: unifies two formerly-independent right-edge overlays into one dock with
tabs. Full rationale (including rejected alternatives — left-side dock, command palette) in
`docs/superpowers/specs/2026-07-02-panel-clutter-ia-design.md`. The canvas-first overlay
layout pass (`docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md`, task
3 of 4 — tasks 1-2 moved `NodePalette` to an icon rail and `PropertiesPanel`/`SimConfigPanel`
to a floating top-right card) subsequently converted this dock from a flex child into a fixed
bottom-right drawer; see below for why that supersedes the original "flex child, not fixed"
rule.

| File | Role |
|---|---|
| `src/app/dock/UtilityDock.tsx` | Owns the single dock shell (header, `Diagnostics \| Reports` tab strip, close button, Escape-to-close) and mounts whichever of `DiagnosticsPanel`/`ReportsPanel` is active. **Self-gated**: reads `useUiStore(s => s.dockOpen)` itself and wraps its own return in `AnimatePresence`/`motion.aside` (mount/unmount handled internally) — `App.tsx` just renders `<UtilityDock />` unconditionally and no longer reads `dockOpen` or imports `motion`. `position: fixed`, anchored bottom-right. |
| `src/app/dock/UtilityDock.module.css` | Tab strip + shell styling; `.dock` is `position: fixed; right: 16px; bottom: 44px`, `width: 340px`, `max-height: min(480px, calc(100vh - 42px - 28px - 32px))` (capped to reduce the chance it reaches the top-right Properties/SimConfig card — not a hard guarantee at very short window heights, see §H note below), `z-index: 500`, rounded card with border + shadow |
| `src/app/diagnostics/DiagnosticsPanel.tsx`, `src/app/reports/ReportsPanel.tsx` | Content-only — filters/issue cards and run list/`RunDetailOverlay` respectively (see §C above for `DiagnosticsPanel`'s linter-side role). Unaffected by the 2026-07-02 re-anchor; only `UtilityDock`'s own chrome/positioning changed |
| `src/app/store/ui.store.ts` | `dockOpen` + `dockTab: 'diagnostics' \| 'reports'`. `openDockTab(tab)` opens the dock on a specific tab (switches tab even if already open) — this is what `Toolbar.tsx`'s single "Dock" button and `MetricsDrawer.tsx`'s "last run" pill both call |

**Why fixed bottom-right now, not a flex child:** the original rule ("make it a flex child of `.body`, not `position: fixed`") was fixing a *different* bug — two *uncoordinated* fixed panels (the pre-unification DiagnosticsPanel/ReportsPanel) silently stacking at the same screen position. Once `UtilityDock` unified them into one panel, that specific collision was already gone; the flex-child approach was solving it a second, redundant way by reserving row space. The 2026-07-02 canvas-first pass revisited this because a flex child still pushes/shrinks the canvas whenever the dock opens, which fights the "canvas is the permanent surface, panels float over it" direction taken for `PropertiesPanel`/`SimConfigPanel` (see §1 tasks 1-2) and `NodePalette` (icon rail). `UtilityDock` is now `position: fixed`, anchored bottom-right, while `PropertiesPanel`/`SimConfigPanel` anchor top-right — different corners, and `.dock`'s `max-height` is capped to reduce the chance it reaches the other panel's corner. This is coordination **by construction** (disjoint corners + height cap) in the sense that it's deliberate, not accidental — but it's not a hard geometric guarantee: both caps resolve from the same `calc(100vh - 42px - 28px - 32px)` formula, so at very short window heights (roughly ≤580px tall) with both panels open and both filled with enough content to hit their max-height cap, they could occupy the same vertical span. That's a narrow edge case (unusually short window + both panels open + both at max content height, all at once), not something that happens in normal desktop use, so it doesn't reintroduce the original uncoordinated-stacking bug in practice. **If you add another floating panel, pick a corner that doesn't collide with an already-open one, and cap its size the same way** — don't fall back to a flex child by default.

**Blast radius:** low. `UtilityDock` has 1 caller (`App.tsx`), which now just mounts it unconditionally (no ternary/`AnimatePresence` wrapper at the call site — the mount-gating moved inside `UtilityDock.tsx` itself). `DiagnosticsPanel`/`ReportsPanel` are each imported only by `UtilityDock.tsx`.

---

## 2. Shared "hub" files (everyone touches these — high conflict risk)

These aren't feature modules; they're registries other code plugs into. The fix
isn't to avoid them, it's to **only ever append/extend, never restructure, in a
routine PR** — restructure them in their own dedicated PR when nobody else has
in-flight changes.

| File | Why it's a hub | Fan-in (CodeGraph-verified) |
|---|---|---|
| `src/lib/nodeConfig.ts` (~380 lines) | `NODE_CONFIG` registry — every node type's icon/category/label | **31 files import it** — the single largest fan-in in the repo. `NodeSimConfig` gained two append-only optional fields (`consistencyLevel`, `replicationLagMs`, GitHub #12) — fan-in count unchanged (no new importers), verified via `grep -rln "from '.*nodeConfig'" src` before/after |
| `src/lib/theme.ts` (120 lines) | `ColorTokens`/`DARK_COLORS`/`LIGHT_COLORS`/`CATEGORY_COLORS`/`FONT_*`/`SPACING`/`MOTION` — small file, but touched by any node/edge visual change. Only the 16 `ColorTokens` keys (`canvas`, `canvasDots`, `nodeBase`, `nodeBorder`, `surface`, `surfaceHover`, `toolbar`, `toolbarBorder`, `textPrimary`, `textSecondary`, `textMuted`, `danger`, `success`, `successText`, `warning`, `accent`) are exposed as `--color-*` CSS custom properties by `App.tsx`'s `useThemeBootstrap` and mirrored in `src/index.css`'s static `:root` fallback. `CATEGORY_COLORS` (messaging/network/storage/etc per-category accents) is **not** exposed to CSS — only consumed directly in `.tsx` via inline styles (`BaseNode.tsx`, `GroupNode.tsx`). **2026-07-02 bug-fix sweep migrated every remaining panel CSS module** (SimConfigPanel, PacketEditor, EventLogPanel, ReportsPanel, PropertiesPanel, MetricGraphOverlay, RequestInspector, DiagnosticsPanel, PlaybackScrubber, MetricsDrawer, CostTracker, HomeScreen, ContextMenu, NodePalette, StatusBar, BaseNode/GroupNode leftover fallbacks, Canvas.module.css, edges.module.css — ~545 hardcoded hex values total) to `var(--color-*)`/`color-mix()`, closing the "stuck in dark mode" bug these panels had after the original design-system foundation only covered canvas/node/edge/toolbar chrome. Also resolved the `Toolbar.module.css` Reports/Inspect/chaos-mode purple-accent decision that a prior review had left pending (`.superpowers/sdd/final-review-fix-report.md`): rather than promoting `CATEGORY_COLORS.messaging` into `ColorTokens`, these now blend the brand purple against the theme's own surface via `color-mix()` with text on `var(--color-accent)` — the previous "self-contained, legible in both modes" assessment for the near-black bg/pale-text combo was wrong (reads as a dark blob on a light toolbar). **Deliberately still hardcoded** (grep `#[0-9A-Fa-f]{3,8}` in any `*.module.css` before assuming otherwise): protocol-type/provider/category brand accents (PacketEditor protocol badges, CostTracker's storage `#F5A623`, messaging `#A78BFA` accents in RequestInspector/MetricsDrawer/MetricGraphOverlay), and Toolbar's self-contained gradient CTA buttons (`.btnSimulate`/`.btnResume`/`.btnEnd`/`.btnInspect`) which are intentionally theme-invariant saturated pills, not chrome. Alpha/translucent variants use the `color-mix(in srgb, var(--color-x) N%, transparent)` pattern established in `BaseNode.module.css` (`.lintBadge`/`.bottleneckBadge`/`.circuitBadge`) | Node rendering, group nodes, panels, toolbar |
| `src/index.css` | `:root` holds a **static copy of `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION`** (restored final-review-fix-round to close a first-paint FOUC gap — before this, the block was empty and every `var(--color-*)` reference was undefined until `App.tsx`'s `useThemeBootstrap` `useEffect` ran post-first-paint). This is a values-only fallback, not a second source of truth — if `theme.ts`'s `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION` change, update this block to match (nothing enforces the two staying in sync; no test covers this — worth adding a `theme.test.ts` case that parses `index.css` and diffs against `DARK_COLORS` if this drifts) | Every CSS module transitively (first paint only — overridden by the bootstrap effect on mount) |
| `src/app/store/ui.store.ts` | `themeMode: 'dark' \| 'light'` + `setThemeMode` — drives a runtime CSS custom-property bootstrap in `App.tsx` that every panel's CSS module reads via `var(--color-*)`. Persisted to `localStorage` (`scalemap-theme-mode`). Toggled from `Toolbar.tsx` (Sun/Moon button in the Select/Hand/Connect tool cluster) — the only current writer besides the initial bootstrap read | `App.tsx` (bootstrap), `Toolbar.tsx` (toggle UI); read transitively by every CSS module via custom properties, not by direct import. **Also directly imported** by `BaseNode.tsx` and `GroupNode.tsx` (design-system tasks 6/7) — both read `themeMode` to resolve `CATEGORY_COLORS[category].accent` (dark) vs `.foreground.light` (light) into a per-instance `--accent`/`--node-accent` inline style, since `CATEGORY_COLORS` itself isn't theme-mode-aware the way `DARK_COLORS`/`LIGHT_COLORS` are. **Also** (2026-07-02) holds the floating-panel toggle state consumed by `Toolbar.tsx`/`App.tsx`/the panels themselves: `simConfigOpen` (top-right Inspector/Properties card) and `dockOpen`/`dockTab` (bottom-right Diagnostics+Reports drawer, see §H) — this file is the single source of truth for "which floating panel(s) are open," so any new floating panel should add its open-state here rather than a local `useState`, to keep panel-coordination centralized instead of re-fragmenting. As of the 2026-07-02 canvas-first pass, panels read their own open-state directly from this store and self-gate (own `AnimatePresence`/mount-guard) rather than `App.tsx` reading the flag and conditionally rendering — see §H |
| `src/app/store/simulation.store.ts` | `NodeMetrics`/`SimEvent`/`SloStatus` shape — anyone adding a new metric touches this | particleEngine, BaseNode, SimConfigPanel, ReportsPanel |
| `src/app/canvas/simulation/particleEngine.ts` | See §1B — also a hub in the sense that *any* new sim behavior lands here today | N/A (internal, but everyone's diff passes through it) |

**Convention to adopt:** when adding a new node type, only add to `NODE_CONFIG` (one new key) — don't reorder existing keys or reformat the file. Same for `LINT_RULES` and `NODE_SIM_DEFAULTS`. Append-only registries plus small, frequent PRs are what actually reduce conflicts here — restructuring these files is the thing to schedule as its own solo PR.

---

## 3. Suggested ownership split for parallel work

If splitting a sprint's work across people to avoid stepping on each other:

1. **Simulation realism** (per `SRE_Critique.txt`'s blueprints — circuit breakers on edges, thread-pool exhaustion, token-bucket gateways, chaos gray-failures) → §1B. `particleEngine.ts` has been split into `particleEngine/circuitBreakers.ts`, `particleEngine/backpressure.ts`, and `particleEngine/chaos.ts`, so separate fixes to breaker/backpressure/chaos logic can now land in disjoint files instead of one shared 2.6k-line file.
2. **Lint rules** → §1C, already safe for concurrent work, no changes needed.
3. **Packet editor** → §1E, isolated to `PacketEditor.tsx`/`.module.css` + the packet slice of `canvas.store.ts`. Redesigned 2026-07-02 into an interactive card visualization (no longer just "bug fixes" — see §1E for details); still isolated and safe for concurrent work since the data model didn't change.
4. **Cost/pricing model work** → §1D, isolated unless changing `costModel.ts` function signatures.
5. **Terraform/Vault/ScaleScript/Rust persistence** → §1F/G, narrowest blast radius in the repo, good for onboarding or solo side-quests.
6. **Floating panel/IA work** (new panels, further discoverability fixes) → §1H, isolated to `dock/` + the panel-open fields in `ui.store.ts`. Read the "why fixed bottom-right now, not a flex child" note in §1H before adding another floating panel — pick a corner that doesn't collide with `PropertiesPanel`/`SimConfigPanel` (top-right) or `UtilityDock` (bottom-right), and cap its max size.

---

## 4. Why this is a codebase-organization fix, not a microservices one

Scalemap is a single-process Tauri desktop app: canvas state, the particle engine,
and the Zustand stores all run in one JS runtime because the simulation loop reads
and mutates them synchronously every frame. There's no network boundary to split
services along, so introducing microservices would mean standing up inter-process
communication purely to solve a code-ownership problem — real added complexity
(serialization, latency, deployment) without the deployment-independence benefit
that normally justifies it. The module boundaries above get most of the
conflict-reduction benefit without that cost.
