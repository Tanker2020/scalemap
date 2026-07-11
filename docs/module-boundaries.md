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

### A. Canvas graph editing — deleted 2026-07-08 (Phase 2 Task 17)

`src/app/canvas/` (`Canvas.tsx`, `nodes/`, `edges/`, `simulation/`), `src/app/sidebar/`
(`PropertiesPanel.tsx`, `ContextMenu.tsx`, `EdgeConfigForm.tsx`, `NodePalette.tsx`,
`Sparkline.tsx`), and `src/app/store/canvas.store.ts` were removed outright — the legacy React
Flow canvas, its custom node/edge renderers, and the nodes/edges CRUD + undo/redo +
packet-registry store they depended on. The world model's equivalents are
`src/app/world/AzCanvas.tsx` (§J) for the live AZ-level React Flow render and
`src/app/store/world.store.ts` (§J) for document CRUD + undo/redo — a different data model
(`WorldDoc` entities, not `Node<NodeData>`/`Edge<EdgeData>`), not a drop-in replacement.

### B. Simulation engine & live metrics — deleted 2026-07-08 (Phase 2 Task 17)

`src/app/canvas/simulation/` (`particleEngine.ts` + `particleEngine/*.ts` and all their `*.test.ts`
files, `SimulationOverlay.tsx`, `useDisplayMetrics.ts`, `PlaybackScrubber.tsx`,
`RequestInspector.tsx`), `src/app/store/replay.store.ts`, `src/app/store/metricsHistory.store.ts`,
`src/app/store/costHistory.store.ts`, and `src/app/store/simulationLegacy.store.ts` (the Task 12
build-green shim, deleted alongside the tree it existed only to keep compiling) were removed
outright. This was the ~2,450-line rAF particle-physics loop plus its circuit-breaker/
backpressure/chaos/LB-routing/compute sub-modules and every panel that read its output — several
months' worth of incremental fixes (circuit-breaker metrics semantics, forward-only node types,
reservoir/thread-pool admission models, the EC2 CPU/RAM compute model) are preserved only in git
history now, not in this file (see git log for `src/app/canvas/simulation/particleEngine.ts` up
to commit before Task 17 if that history is ever needed). The world engine
(`src/lib/worldEngine/`, §K) is its from-scratch replacement — built as a deliberate **port, not
a rewrite**, of several of this engine's mechanisms (see e.g. `worldEngine/breakers.ts`'s and
`worldEngine/latency.ts`'s header comments, which cite the legacy file paths by name as their
porting reference and are intentionally left in place as historical provenance even though those
paths no longer exist — do not "fix" those comments into dangling-reference errors, they're
deliberate).

### C. Structural linter — deleted 2026-07-08

`src/lib/lint/` (`types.ts`, `rules.ts`, `lintGraph.ts`, `classify.ts`), `src/app/diagnostics/DiagnosticsPanel.tsx`,
and `src/app/store/diagnostics.store.ts` were removed outright (not deprecated/shimmed — zero
importers remain). The Phase 6 Analysis system (see the top-level spec) replaces this
functionality; nothing in Phases 1-5 needed a compatibility shim. Toolbar.tsx's "Diagnostics"
button/`runDiagnostics()` and the dock's Diagnostics tab (§H) were removed along with it.
`ui.store.ts`'s `highlightedNodeIds`/`setHighlightedNodes` fields **survived** the deletion —
they were diagnostics-agnostic (a generic "focus this node" signal read by `BaseNode.tsx`'s
pulse ring and `Canvas.tsx`'s `fitView` effect) and are kept for reuse by whatever panel wants
that behavior next.

### D. Cost modeling & cloud pricing
| File | Role |
|---|---|
| `src/lib/cloudRegistry.ts` (~295 lines) | Per-provider service/pricing catalog, egress tiers, provider-aware label rewrite (`resolveProviderLabel`) |
| `src/lib/regionConfig.ts` (58 lines) | Region metadata |

**`src/lib/costModel.ts` and `src/app/simulation/CostTracker.tsx` were deleted 2026-07-08 (Phase 2 Task 17)** — the legacy simulation-traffic → monthly-cost model and its renderer, along with the rest of the tree that imported them (`BaseNode.tsx`, `particleEngine.ts`, `PropertiesPanel.tsx`, §A/§B). Cost modeling now lives entirely in `src/lib/costModelV2.ts` / `src/app/world/CostTab.tsx` (§J, Task 16), which read `cloudRegistry.ts` directly. **2026-07-08 (Phase 2 Task 16):** `cloudRegistry.ts` gained this second consumer family — `costModelV2.ts` reads `getServiceSpec`/`egressMonthlyCost`/`CloudProvider` only. `CLOUD_REGISTRY` entries are keyed by canonical `NodeType` (`dbSql`/`objectStorage`/`queue`/…); at the time this note was first written, `ManagedService.nodeType` (§1J's `types.ts`) stored `PlacementPanel.tsx`'s short `MANAGED_TYPES` strings (`rds`/`s3`/`sqs`/…) instead, requiring an alias table to price correctly. **2026-07-09 (Phase 3 Task 8) fixed this at the source:** `PlacementPanel.tsx`'s managed-service picker (D12) now authors new services with `CLOUD_REGISTRY`'s canonical keys directly (`dbSql`/`objectStorage`/`queue`/`redis`/`cdn`/`apiGateway`/`lambda` — see §J's `PlacementPanel.tsx` row), so new documents need no alias at all. `costModelV2.ts`'s `MANAGED_TYPE_ALIASES` table still exists but is now **legacy-doc compatibility only** — it maps the old short strings (`rds→dbSql`, `s3→objectStorage`, `sqs→queue`, the rest already identity) so a `.scalemap` file saved before Task 8 still prices correctly on load; `costModelV2.test.ts` covers both the new direct-key path and the legacy-alias path explicitly. **Going forward: adding a new managed-service type to `PlacementPanel.tsx`'s `MANAGED_TYPES` list without a matching `CLOUD_REGISTRY` key still silently prices that service at $0** (`getServiceSpec` returns `undefined`, no error/warning) — keep the two in sync when either changes; the alias table itself no longer needs touching for new types since authoring is canonical-key-direct now.

**Provider-driven label rewrite (2026-07-02) — orphaned from live UI by Task 17, exercised only by its unit test now:** `cloudRegistry.ts` still exports `resolveProviderLabel(nodeType, provider, currentLabel, genericLabel)`/`providerLabelForNode(...)`; their only production caller was `PropertiesPanel.tsx`'s Cloud Provider `<select>` `onChange` handler (deleted, §A). Neither function has a replacement caller in `src/app/world/` yet — `PlacementPanel.tsx`'s managed-service editor doesn't do provider-driven label rewriting today. Left in place (not deleted) since `cloudRegistry.ts` is a Task 17 survivor and the functions are still correct/tested (`src/lib/cloudRegistry.test.ts`, 10 cases) — pick this back up if/when a world-model panel wants the same "label follows provider until the user types something custom" behavior, rather than reimplementing it from scratch. `BaseNode.tsx`'s `providerBadge` companion concept (small colored pill showing `PROVIDER_LABELS[provider]`) no longer exists at all (`BaseNode.tsx` deleted, §A).

### E. Packet system (Flyweight templates) — editor UI and CRUD store deleted 2026-07-08 (Phase 2 Task 17)

`src/app/simulation/PacketEditor.tsx`/`.module.css` (the interactive "packet anatomy" card editor)
and `src/app/store/canvas.store.ts`'s packet slice (template storage, `packetMode` toggle,
`addPacketTemplate`/`updatePacketTemplate`/`removePacketTemplate`/`setPacketMode`) were deleted
along with the rest of §A/§B. **The packet *types* survive** — `nodeConfig.ts`'s
`PacketTemplate`/`PacketMode`/`PacketRegistry` are still actively used by `WorldDoc`'s
`BlueprintDependency.packetTemplateId` and `serializer.ts`'s `ScalemapFileV2.packets` (§J) — only
the editing UI and the old store-based CRUD are gone. There is currently no world-model UI for
authoring packet templates; a future phase that wants one should add a new store slice (or a
field on `world.store.ts`) rather than resurrecting `canvas.store.ts`.

### F. Terraform export / Vault templates / ScaleScript — deleted 2026-07-08 (Phase 2 Task 17)

`src/lib/terraform/exportTerraform.ts` (diagram → HCL string, export-only — no import path ever
existed, see `CLAUDE.md`), `src/lib/vault/templates.ts` (prebuilt starter diagrams, formerly read
by the legacy `HomeScreen.tsx` vault picker), and `src/lib/scalescript.ts` (DSL types +
`applyScaleScript()` resolver, formerly read by the legacy `simulation.store`'s `activeScript`)
were all deleted along with the legacy tree that was their only caller. None have a Phase-2
replacement yet — Terraform import/export, starter templates, and declarative scenario scripting
are future-phase concerns, not ported forward. `src/lib/serializer.ts` survives, trimmed to
v2-only (see §J's entry for it) — its v1 `DiagramFile`/`serialize`/`deserialize` exports were
removed in the same task, since `FileMenu.tsx` and `useSaveDiagram.ts` (both deleted) were their
only callers.

### G. Rust / Tauri backend
| File | Role |
|---|---|
| `src-tauri/src/commands.rs` (317 lines) | All Tauri commands: save/load diagram, file dialogs, recent files, **and (2026-07-10, Phase 6 Task 5) LLM settings persistence + chat transport** |
| `src-tauri/src/lib.rs`, `main.rs` | Entrypoint wiring |

Entirely separate language/toolchain from the TS frontend — zero merge-conflict overlap with anything above by construction. Good area for someone to own if they're doing file-persistence work (the legacy `ReportsPanel.tsx` disk-export roadmap item was deleted with the rest of the legacy tree 2026-07-08, §H — a Phase-2+ reports surface would need this backend work again from scratch).

**2026-07-10 (Phase 6 Task 5 — LLM settings + chat, D5/D6):** added `LlmSettings { base_url, api_key, model }` persisted to a brand-new `llm_settings.json` in the app data dir — mirrors `recent_files.json`'s exact pattern (`app_data_dir()` + `fs::create_dir_all` + `serde_json`, default-on-any-error reads) but is a **completely separate file**, never touched by `save_diagram`/`load_diagram`/`serializer.ts` — the API key must never end up inside a `.scalemap` document (D6). Three new commands: `save_llm_settings`, `load_llm_settings` (both sync, same shape as `get_recent_files`), and `llm_chat(base_url, api_key, body) -> Result<String, String>` (`async`, `reqwest` POST to `{base_url}/chat/completions` with a Bearer header, 60s timeout, returns raw response text for any HTTP status — only transport failures are `Err`). `reqwest` (`default-features = false`, `["json", "rustls-tls"]`) is the **only new Cargo dependency this whole phase adds**; `tauri::async_runtime::block_on` in the Rust test suite needed no additional dev-dependency (tokio already arrives transitively via tauri/reqwest). **D6 key-security invariant:** every `llm_chat` error path is piped through a pure `redact(msg, key)` helper (plain `str::replace(key, "•••")`, no-op passthrough for an empty key to dodge `replace("", …)`'s insert-between-every-char footgun) before it's returned — verified by two asserting tests (`redact_masks_key_everywhere_and_short_keys_entirely`, `llm_chat_redacts_key_from_connection_refused_error`, the latter against a real closed-port TCP connection refusal). This paragraph is the Rust-side inventory only; the `src/lib/tauri.ts`/`tauriMock.ts` TS-wrapper module boundary (snake↔camel field mapping, the mock's localStorage/fetch fallback) is documented once, in §O, not duplicated here.

### H. Utility dock (Reports) — deleted 2026-07-08 (Phase 2 Task 17)

`src/app/dock/UtilityDock.tsx`/`.module.css` and `src/app/reports/ReportsPanel.tsx`/`.module.css`
were deleted along with the rest of the legacy tree. The dock unified Diagnostics+Reports into
one bottom-right drawer (design rationale in
`docs/superpowers/specs/2026-07-02-panel-clutter-ia-design.md` and
`docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md`, if that history is
ever needed) — Diagnostics was already removed with the structural linter (§C) before this task.
`ui.store.ts`'s `dockOpen`/`dockTab`/`openDockTab` fields, which only this dock read, were
removed in the same task's `ui.store.ts` trim (see §J/§2 — the store is now `themeMode` only).
`ReportsPanel.tsx`'s disk-export TODO from `CLAUDE.md`'s Roadmap is moot until a Phase-2+ reports
surface is designed from scratch.

### I. Toolbar declutter — deleted 2026-07-08 (Phase 2 Task 17)

`src/app/toolbar/Toolbar.tsx`/`FileMenu.tsx`/`.module.css` were deleted along with the rest of
the legacy tree — already orphaned from the app root since Task 10 of Phase 1 (§J), this task
removed the dead files themselves. The world shell's equivalent file operations live in
`src/app/world/fileOps.ts` and `WorldShell.tsx`'s header buttons (§J), not a toolbar component —
there is no dropdown/menu UI in the world shell today, just direct New/Open/Save/Save As buttons.

### J. World model & navigation shell (Phase 1 of the world rebuild, 2026-07-08)

Branch: `world-rebuild`. Spec: `docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md`;
plan: `docs/superpowers/plans/2026-07-08-phase1-world-model-shell.md`. Built incrementally across
Tasks 9-14 (Tasks 1-9 built `src/lib/world/`'s pure model/compiler/serializer and deleted the
structural linter — see §C; Task 10 swapped `App.tsx`'s mounted tree from the legacy
Toolbar/Canvas/panels stack, §I's note above, to `<WorldShell />`; Task 11 added the `WorldPanel`
authoring dock's `Topology` tab; Task 12 added `Blueprints`/`Placements`; Task 13 added the AZ
canvas; Task 14 — this entry's final pass — added file operations, dirty tracking, and autosave).
This section describes the final Phase-1 state, not any single task's snapshot. **Phase 2 (see
§K) continues extending these same files as the substrate engine lands real live data**: Task 13
added `SimControls.tsx`/`EventsTab.tsx` and a live metrics row on `GlobeView`/`RegionView`
cards; Task 14 (disambiguated below as "Phase 2 Task 14" — the number repeats because each phase
restarts its own task numbering) added a live particle canvas over the AZ view, health-tinted
server-node borders + a CPU/RAM line, and a manual region-outage toggle; Task 15 added a
bottom-bar replay scrubber (`ScrubberV2.tsx`, mounted in `WorldShell.tsx`) and an AZ-scoped
traced-request inspector (`InspectorV2.tsx`, mounted in `AzCanvas.tsx`), and switched every
`latestBatch` read in `AzCanvas.tsx`/`GlobeView.tsx`/`RegionView.tsx` to
`scrubBatch ?? latestBatch` so scrubbing replays health/rps/CPU/RAM across all three views, not
just the AZ canvas; Task 16 added a sixth `WorldPanel` tab, `Cost` (`CostTab.tsx`), backed by a
new pure module `src/lib/costModelV2.ts` — the first Phase-2 file to read `cloudRegistry.ts`
(§1D) directly, and the first to also read `scrubBatch ?? latestBatch` outside `AzCanvas`/
`GlobeView`/`RegionView`.

| File | Role |
|---|---|
| `src/lib/world/types.ts` | `WorldDoc` entities + `CompiledWorld` output types — the schema of `.scalemap` v2 |
| `src/lib/world/factories.ts`, `instanceCatalog.ts`, `regionGeo.ts` | Entity constructors, server presets, region coordinates |
| `src/lib/world/compileWorld.ts` (+ `network.ts`, `routing.ts`) | Pure resolver: blueprints × placements → instances, permitted/blocked paths (firewall/ports/docker networks), routing tables, findings. Golden-tested; every consumer (views now, engine in Phase 2, analysis in Phase 6) reads its output, never the raw doc, for derived facts |
| `src/lib/world/layoutAz.ts` (Task 13) | `layoutAzGrid(serverIds, managedIds)` — deterministic grid-position assignment for the static AZ canvas (3-column grid, managed services on their own row below). Positions are recomputed per render, not persisted on the doc — Phase 1 has no drag-persistence for AZ-level layout |
| `src/app/store/world.store.ts` | Document store + undo/redo + cascading CRUD. Every mutation funnels through the internal `mutate()` helper, which (Task 14) now also calls `useFileStore.getState().setDirty(true)` after pushing history and applying the doc transform — so every CRUD action (`addServer`, `updateBlueprint`, `updateRouting`, …) marks the open file dirty with no per-action wiring needed. **2026-07-08 (final review fix batch):** `undo`/`redo` bypass `mutate()` (they're not doc-transform actions, they swap in a `history`/`future` snapshot directly) and so were missing the same dirty-marking — both now call `useFileStore.getState().setDirty(true)` after their `set(...)`, guarded implicitly by their existing early-return when `history`/`future` is empty (a no-op undo/redo at the boundary doesn't falsely mark dirty) |
| `src/app/store/nav.store.ts` | Independent Zustand store — `WorldLevel = 'globe' \| 'region' \| 'az' \| 'server'` plus `regionId`/`azId`/`serverId` focus and `goGlobe`/`goRegion`/`goAz`/`goServer`/`up()`. Deliberately has no dependency on `world.store` — pure UI focus/breadcrumb state, decoupled from the document so navigating never itself pushes undo/redo history. `up()` climbs exactly one level and clears only the level(s) below the new one |
| `src/app/world/WorldShell.tsx` | The app's entire post-home body: a header (`Breadcrumb` + `SimControls` (Phase 2 Task 13) + "esc = up one level" hint + (Task 14) a right-side file-actions cluster — dirty dot, New/Open/Save/Save As buttons — plus a dismissible error ribbon under the header for failed open/save) over a `flex` row of the active level view (`GlobeView`/`RegionView`/`AzCanvas`/`ServerView`, chosen by `nav.level`) and `WorldPanel`. AZ level renders the real `AzCanvas` (Task 13) — not a placeholder. Wraps the level view in `framer-motion`'s `AnimatePresence mode="wait"` keyed by the full `level:regionId:azId:serverId` path (so re-entering the same level with a different focus still re-animates) and respects `useReducedMotion()`. Owns a window-level `Escape` listener calling `useNavStore.getState().up()`. **2026-07-08 (final review fix batch):** the keydown handler now bails immediately if `e.defaultPrevented` or the event target is an `INPUT`/`TEXTAREA`/`SELECT`/`isContentEditable` element — previously Escape while typing in any `WorldPanel` form field (server label, firewall port, etc.) would also pop the nav level, discarding focus mid-edit. Same handler now also owns `⌘Z`/`Ctrl+Z` → `useWorldStore.getState().undo()` and `⇧⌘Z`/`Ctrl+Shift+Z` → `redo()` (both `preventDefault()`d and subject to the same input-guard) — this is the only keyboard entry point for undo/redo in the world shell; there is no menu-item equivalent yet. **2026-07-08 (Phase 2 Task 13 — sim controls):** now reads `useSimulationStore(s => s.running)` and passes it straight through as `<WorldPanel running={running} />`'s only prop — `WorldShell` itself does no gating, it's purely a pass-through from store to prop. **2026-07-08 (Phase 2 Task 15):** mounts `<ScrubberV2 />` as the last child of the shell's outer flex column, below the `main`/`WorldPanel` row — a bottom bar, not inside `main`, so it spans the full shell width regardless of which level view is active. **2026-07-08 (Phase 2 Task 18):** gained a one-time `useEffect` that, only when `import.meta.env.DEV` is true, assigns `window.__scalemapDebug = { useWorldStore, useSimulationStore }` — a dev/test-only escape hatch letting a scripted Playwright smoke call `useWorldStore.getState().addPopulation(...)` (there is still no population-authoring UI in Phase 2 — see §J's Task-14 `RegionView` outage-toggle note for the same "no UI control exists yet" reasoning) or `setOutage(...)` directly. Guarded so it never runs under `vite build`/`tauri build` (`import.meta.env.DEV` is statically `false` there) |
| `src/app/world/SimControls.tsx` (Phase 2 Task 13) | Header-mounted Simulate/Stop button + timeScale `<select>` (1x/2x/4x, disabled while stopped) + a pulsing running dot (`framer-motion`, `useReducedMotion()`-aware). Reads `running`/`timeScale` and the `start`/`stop`/`setTimeScale` actions from `useSimulationStore`, and `doc`/`useCompiledWorld()` from `world.store` — `start(doc, compiled)` is the only place in `world/` that assembles both arguments the engine facade needs. Never imports `worldEngine` directly, per the store-seam contract (§K). **2026-07-08 (Phase 2 Task 18):** also reads `degraded` from `useSimulationStore` and renders an amber "degraded tick" chip (`var(--color-warning)` text + border, matching `theme.ts`'s token convention) as the row's last child whenever it's true — the store already carried this flag since Task 12 (contract-sanctioned additive field, `.superpowers/sdd/contract-drift.md` §3); this task only added the UI reader |
| `src/app/world/EventsTab.tsx` (Phase 2 Task 13) | `WorldPanel`'s `Events` tab content — renders `useSimulationStore(s => s.events)` newest-first (`[...events].reverse()`; the store itself keeps the ring oldest→newest, cap 500) with a severity-colored left border (`info`/`warning`/`critical` → muted/`var(--color-warning)`/`var(--color-danger)`) and an explicit "no events yet" empty state |
| `src/app/world/fileOps.ts` (Task 14) | Shared v2 file flows used by both `WorldShell` and `HomeScreen`: `openWorldFromPath(path)` (load → `deserializeWorld` → `replaceWorld` → restore `createdIso` + `viewState`'s level/focus → `markSaved`), `openWorldViaDialog()` (wraps the above behind `openFileDialog()`), and `saveWorld({ forceDialog? })` (reuses the current `filePath` unless forced or absent, in which case it prompts via `saveFileDialog()`; serializes with the current nav focus as `viewState` so save-then-reopen restores position). The single place that knows how to round-trip a `.scalemap` v2 file end-to-end — anything else needing to open/save a world should call these, not reimplement the load/serialize calls inline |
| `src/app/world/Breadcrumb.tsx` | Reads `useNavStore` + `useWorldStore(s => s.doc)` directly (no props) and renders `World › <region.catalogId> › <az.label> › <server.label>` up to the current level, each non-current segment a clickable button jumping straight to that level (skips intermediate `goAz`/`goRegion` calls) |
| `src/app/world/GlobeView.tsx`, `RegionView.tsx`, `ServerView.tsx` | Phase-1 placeholders — deliberately spartan grid/card layouts, not the approved mockup designs (those land in Phases 3-5). All three call `useCompiledWorld()` so findings/instance counts are already live end-to-end, not stubbed. **2026-07-08 (Phase 2 Task 13):** `GlobeView`'s region cards and `RegionView`'s AZ cards each gained a live metrics row (health dot + rps + err%) sourced from `useSimulationStore(s => s.latestBatch)` — `latestBatch?.regions[r.id]`/`latestBatch?.azs[az.id]` optional-chained so the row renders nothing at all (not a placeholder/zero row) before the first 1 Hz batch or while stopped. `ServerView.tsx` was **not** touched this task — no live-metrics card added there yet. **2026-07-08 (Phase 2 Task 14):** `RegionView.tsx` gained a manual region-outage toggle next to the region title — visible only while `running` (`useSimulationStore(s => s.running)`), reads `healthOverrides[regionId] ?? false` and calls `setOutage('region', regionId, !isDown)` on click. This is the UI surface for the engine's `setOutage` control (contracts §"Control API"); region scope specifically (not AZ/server) is what exercises the TTL-gated cross-region re-resolution path (spec decision 7) that Task 15/18's live smokes need an outage moment for. `ServerView.tsx`/`GlobeView.tsx` were **not** touched this task. **2026-07-08 (Phase 2 Task 15):** both `GlobeView.tsx`'s and `RegionView.tsx`'s `latestBatch` selector changed from `s.latestBatch` to `s.scrubBatch ?? s.latestBatch` — same variable name, same render logic below it, but now resolves to whichever replay frame `ScrubberV2` last scrubbed to while stopped (or live data while running/never scrubbed, since `scrubBatch` is `null` in both those cases). `RegionView.tsx`'s outage toggle still reads `running`/`healthOverrides`/`setOutage` directly, unaffected by this swap. `ServerView.tsx` remains untouched |
| `src/app/world/AzCanvas.tsx` (Task 13) | Read-only static React Flow render of the focused AZ — servers + in-scope managed services as nodes (`WorldServerNode`/`WorldManagedNode`, positioned via `layoutAzGrid`), instance-level compiled paths aggregated to one edge per server pair (any blocked path turns the whole aggregate edge red/dashed; same-server-internal blocks surface as a node badge instead of an edge). Reads `useCompiledWorld()` + `world.store`/`nav.store`; clicking a server node calls `goServer(...)`. **2026-07-08 (Phase 2 Task 14):** now also reads `useSimulationStore(s => s.latestBatch)` and folds `latestBatch?.servers[server.id]`'s `health`/`cpuPct` (derived: mean of `coreUtilization`, ×100)/`ramUsedMb`/`ramTotalMb` into each server node's `data` (added to the `useMemo` dep array); mounts `<AzSimOverlay azId={azId} />` as an absolutely-positioned canvas sibling of `<ReactFlow>`. **Load-bearing fix vs. the task brief's literal code:** the whole return was wrapped in an explicit `<ReactFlowProvider>` — verified empirically (jsdom probe) that `<ReactFlow>`'s own internal provider only covers elements passed as *its* `children` (e.g. `<Background>`), not later JSX siblings, so `AzSimOverlay`'s `useReactFlow()`/`useViewport()` calls throw `"Seems like you have not used a ReactFlowProvider..."` immediately on mount without this wrap. Nothing else in `world/` currently establishes a `ReactFlowProvider` ancestor (the only other usage is the unrelated legacy `src/app/canvas/Canvas.tsx`). **2026-07-08 (Phase 2 Task 15):** the `latestBatch` selector was renamed `batch` and its source changed to `useSimulationStore(s => s.scrubBatch ?? s.latestBatch)` — every one of the Task-14-added `latestBatch?.servers[...]` reads (`health`, `cpuPct`'s condition + computation, `ramUsedMb`/`ramTotalMb`) and the layout `useMemo`'s dependency array were updated to the new `batch` name, so scrubbing to a replay frame now repaints the server nodes' health border/CPU/RAM from that frame instead of always showing live data. Also mounts `<InspectorV2 azId={azId} />` as a second absolutely-positioned sibling of `<ReactFlow>`, alongside `<AzSimOverlay azId={azId} />` — both live inside the same `<ReactFlowProvider>` wrap, though `InspectorV2` itself doesn't call any React Flow hooks (it only needs `azId`, passed as a prop, not derived from viewport state) |
| `src/app/world/WorldServerNode.tsx` (Task 13) | `WorldServerNode`/`WorldManagedNode` — the two custom React Flow node renderers `AzCanvas` registers via `nodeTypes`. Presentation-only; no store access of their own, everything comes in via node `data`. **2026-07-08 (Phase 2 Task 14):** `WorldServerNodeData` additively gained `health?: HealthState`/`cpuPct?`/`ramUsedMb?`/`ramTotalMb?`. The node's `border` is now `HEALTH_BORDER[health ?? 'healthy']` — a full `border` shorthand string per health value (never a separate `borderColor` override, per the project's shorthand-mixing anti-pattern rule) — and a "CPU N% · RAM used/total MB" line renders whenever `cpuPct !== undefined` |
| `src/app/world/AzSimOverlay.tsx` (Phase 2 Task 14) | Absolutely-positioned, `pointerEvents: 'none'` `<canvas>` mounted as a sibling of `AzCanvas`'s `<ReactFlow>`. Calls `useSimulationStore.getState().attachRenderer({level:'az', azId}, onFrame)` inside a `useEffect` (imperative `getState()` call, not a reactive selector — same store-action pattern `SimControls` uses for `start`/`stop`; still never imports `worldEngine` directly) and returns the detach fn as the effect's cleanup. Each frame: clears the canvas, then for every `VisualParticle` resolves `fromId`/`toId` (`serverId`/`managedServiceId`/`'edge:<populationId>'`) to screen coordinates via `useReactFlow().getNode(id).position` + `useViewport()`'s zoom/x/y (fixed `SERVER_W/H`/`MANAGED_W/H` footprints, since React Flow only reports *measured* node size post-paint and the overlay must draw from frame 1), draws a dot at `progress` along the line, or — when `p.blocked && p.progress > 0.85` — an expanding, fading red ring at the target ("refused" burst) instead of a dot. Canvas pixel buffer is kept matched to its parent via `ResizeObserver` (avoids CSS-stretch skewing the screen-space math). Respects `prefers-reduced-motion` by throttling redraws to ~2/sec rather than suppressing the canvas — per Global Constraints, degradation/blocking must stay *observable*, and this canvas is the primary channel for it at AZ scope. No test file (see Concerns below) |
| `src/app/world/ScrubberV2.tsx` (Phase 2 Task 15) | Bottom bar mounted in `WorldShell.tsx`, below the `main`/`WorldPanel` row. Renders `null` unless `!running && frames.length > 0` — `frames` is a **local** `useState`, snapshotted imperatively from `useSimulationStore.getState().getReplayFrames()` inside a `useEffect` keyed on `running` (the replay ring is a plain method return, not reactive store state, so this component polls it once per stop/start transition rather than subscribing). A horizontal strip of one flex-tick per frame, colored by that frame's worst-AZ `healthScore` (`Math.min` across `Object.values(frame.batch.azs)`, green ≥80/amber ≥40/red below), full opacity on the currently-scrubbed tick and 55% elsewhere. Click/drag-click on the strip computes a ratio from `clientX` against the strip's bounding rect and calls `useSimulationStore(s => s.setScrubIndex)` with the corresponding frame index; an "Exit scrub" button (visible only while `scrubIndex != null`) calls `setScrubIndex(null)`. The label next to the strip reads `live` while unscrubbed or `${simMs/1000}s` once scrubbed. Respects `prefers-reduced-motion` by dropping the tick-opacity CSS transition (not the tick colors themselves). **2026-07-10 (Polish 1 Task 7 — doc-swap session reset, §P):** the render gate grew a third leg — was `!running && frames.length > 0`, now `!(running \|\| frames.length === 0 \|\| latestBatch === null)` (a new `latestBatch` selector was added alongside the four pre-existing ones). The engine's 300-frame replay ring survives a plain `stop()` by design (that's what makes post-stop scrubbing possible at all) and is NOT proactively cleared by the new `resetSession()` either (`simulation.store.ts`, §K) — so immediately after a New/Open doc swap, `getReplayFrames()` can still return the DISCARDED world's frames for one render if the gate only checked `frames.length`. `latestBatch`, by contrast, is reset to `null` by both `start()` and `resetSession()` and is only ever repopulated by a live `onMetrics` callback, so "`latestBatch` is null" reliably means "this session hasn't produced a frame since the last reset" — exactly the moment the scrubber must stay hidden even though `frames.length` is stale-nonzero. Covered by `ScrubberV2.test.tsx`'s new `'ScrubberV2 session gate'` describe block (shown after a normal stop; hidden after a doc swap even though the engine still holds frames) |
| `src/app/world/InspectorV2.tsx` (Phase 2 Task 15) | AZ-scoped overlay mounted inside `AzCanvas.tsx`, absolutely positioned bottom-left. Polls `useSimulationStore.getState().getTracedRequests({level:'az', azId})` on a 1s `setInterval` (same "plain method, not reactive state" reasoning as `ScrubberV2` — the contracts note the engine samples ≤1 traced request/sec/scope, so a 1Hz poll can't miss anything the engine itself wouldn't have missed) into local `useState`; re-polls (new effect) whenever `azId` changes. Renders `null` when there are zero traces for the scope — no persistent empty-state chrome. Each traced request is a clickable row (outcome + total latency, outcome-colored) that toggles a hop-table expansion showing `fromId → toId (hopClass)` and `outcome · latencyMs` per hop, both colored by the same `OUTCOME_COLOR` map (`ok`→success, `refused`/`error`→danger, `timeout`→warning) |
| `src/app/world/panels/WorldPanel.tsx` | Authoring dock — a 300px right-side `<aside>` with a `Topology \| Blueprints \| Placements` tab strip (local `useState<Tab>`, not `nav.store` — tab selection is presentation-only and never needs to survive a level change). All three tabs render real content as of Task 12. **2026-07-08 (final review fix batch):** added a fourth `Findings` tab (`` `Findings (${count})` ``, `count = useCompiledWorld().findings.length` — same live compiler output `GlobeView`/`RegionView`/`ServerView` already read, not a separate computation) listing each finding as a severity chip (`error`/`warning` → `var(--color-danger)`/`var(--color-warning)`) + `kind` + message, with an explicit "clean" empty state. This is the first `WorldPanel` tab that reads `useCompiledWorld()` itself rather than only doc-level CRUD state. **2026-07-08 (Phase 2 Task 13):** gained a fifth `Events` tab (`EventsTab.tsx`) and a new required `running: boolean` prop (from `WorldShell`, sourced from `useSimulationStore`) — the tab strip and all four content tabs now sit inside a single `<fieldset disabled={running}>` wrapper, which cascades into every native `<button>`/`<input>`/`<select>` in `TopologyPanel`/`BlueprintPanel`/`PlacementPanel` with zero changes to those three files (same editing-lock intent as the legacy `canvas.store`'s `running` gate, §1A, implemented as one choke point instead of per-action checks). Findings/Events have no form controls, so wrapping them in the same `fieldset` is a harmless no-op, kept for uniformity. **Breaking-ish change:** `WorldPanel` now requires a `running` prop — `WorldPanel.test.tsx`'s two existing `render(<WorldPanel />)` calls were updated to `render(<WorldPanel running={false} />)` alongside this task, since neither the brief's file list nor its commit list called that test file out but `tsc` (whole-repo, `npm run build`) type-checks it via `tsconfig.json`'s `include: ["src", ...]` and fails on a missing required prop otherwise. **2026-07-08 (Phase 2 Task 16):** gained a sixth `Cost` tab (`CostTab.tsx`) inside the same `<fieldset disabled={running}>` wrapper as the other five — `Tab` widened to include `'cost'`, `tabs` array gained `{ id: 'cost', label: 'Cost' }`. Like Findings/Events, Cost has no form controls, so the fieldset wrap is a no-op for it too |
| `src/app/world/panels/TopologyPanel.tsx` (Task 11) | Region → AZ → server authoring. Add-region `<select>` is filtered to `WORLD_REGIONS` entries not yet used by any `doc.region`; `+ AZ` auto-suffixes the label (`${catalogId}${a,b,c…}`, recomputed from `doc.azs` every render, not stored); `+ Server` reads a per-AZ preset choice (local `Record<azId, presetId>` state) via `getPreset()` and calls `store.addServer`. Per-server `ServerRow` expands into label/firewall/compose-stack editors, edited as whole-array replacements (`store.updateServer({ firewall: [...] })`/`{ stacks: [...] }`). **Intentional exception to "always go through a store action":** the region-role `<select>` writes via `useWorldStore.setState(...)` directly (a deliberate two-value toggle with no undo/redo push, documented inline — **2026-07-08:** now additionally calls `useFileStore.getState().setDirty(true)` right after, since the history bypass was never meant to also skip dirty-marking). **2026-07-08 (final review fix batch):** each firewall rule row gained `↑`/`↓` reorder buttons (disabled at index 0 / the last index respectively), swapping the rule with its immediate neighbor via an immutably-rebuilt array passed to `upd({ firewall: swapped })` — necessary because firewall evaluation is first-match-wins and `+ Rule` always appends after the default allow-all, so a `deny` rule added later is otherwise permanently unreachable. Clicking a server's `→` calls `useNavStore.getState().goServer(...)`. **2026-07-10 (Polish 1 Task 2 — hybrid instrument restyle):** presentation-only pass onto the Task-1 shared kit (`src/app/world/ui/kit.tsx`) — every dispatch above is byte-for-byte unchanged. Each region block now renders as a `SectionHeader` (`label` = `` `▸ ${catalogId.toUpperCase()} · ${METRO}` ``, the metro parsed from the matching `WORLD_REGIONS` label's parenthesized city, uppercased; `trailing` carries a live health dot text — `● healthy`/`degraded`/`down` from `displayBatch?.regions[id]?.health`, muted `● —` at rest — then the unchanged role `<select>` and `×` button). Each AZ's `+ Server` row gained a `ChipValue`-styled toggle (`aria-label="choose server preset"`, wrapped in an `all: unset` `<button>` so the chip keeps its look while the button carries the aria-label/onClick) that expands a `PresetCardGrid` fed from `INSTANCE_CATALOG`; the grid's `onChange` only writes the existing local `presetByAz` state (no store dispatch) — `+ Server` itself is unchanged and still always visible. `ServerRow` now renders as an `EdgeRow` (`status`/dot = batch health or `null`; `edgeColor` = `var(--color-accent)`, or `var(--color-warning)`/`var(--color-danger)` when degraded/down) whose content is the unchanged expand-toggle button (`▸/▾ label (kind)`, still the `getByText(/server-N/)` test hook) plus a new muted meta line (`kind · vcpu c/ram G · azSuffix`, azSuffix = the AZ label's last char) and, only when `displayBatch` has that server, a 4px `data-testid="topo-util-fill"` utilization bar (width = mean `coreUtilization` rounded to %, amber past 75%); `trailing` carries `MicroBars` (batch-only), a muted `$hourlyUsd/hr` chip, then the unchanged `→`/`×` buttons. Firewall/compose-stack section captions became `SectionHeader`s (default teal, no `accent` override — the amber firewall treatment is Task 4's, in the server view); their inputs/aria-labels (`fw-port-*`/`stack-*`/`server-label`) are untouched. Added 3 tests (`TopologyPanel.test.tsx`'s `'TopologyPanel — instrument restyle'` block: batch-driven micro-bars/util-fill, at-rest absence of both, preset-grid selection feeding `addServer`) alongside the 4 pre-existing dispatch tests, all 7 green. **2026-07-10 (Polish 2 Task 6 — plain words):** `ServerRow`'s trailing cluster gained a `healthWord(cpuMean, ramFrac)` chip (`src/app/world/ui/derived.ts`, T1) right after the batch-only `MicroBars`, same `metrics &&` guard so it's absent at rest — `comfortable`/`tight`/`straining` colored `var(--color-success\|warning\|danger)`. Two new tests in the instrument-restyle describe (`healthWord chip appears only with metrics and uses the status color`, `no health word at rest`) alongside the 7 pre-existing; every firewall/compose-stack dispatch in this file is untouched by this task |
| `src/app/world/panels/BlueprintPanel.tsx` (Task 12) | Service-blueprint CRUD — name/runtime/port config plus a dependency editor (`BlueprintDependency` targets either another blueprint or a managed service). **2026-07-10 (Polish 1 Task 3 — hybrid instrument restyle):** presentation-only pass onto the shared kit (`src/app/world/ui/kit.tsx`) and derived-hint math (`src/app/world/ui/derived.ts`) — every dispatch is byte-for-byte unchanged. Each card is now a `.b-card`-token shell (`--color-node-base`/`--color-node-border`, 8px radius) whose head row gained an editable `<input type="color" aria-label="signature color">` swatch (`upd({ color })`, new — the pre-restyle card had no color editor) and a `ChipValue title="placed instances"` (`×N` from `useCompiledWorld()`'s `instances` filtered by `blueprintId`), plus a muted meta line (`:port :port · N deps`) under the head. Ports/deps editors are unchanged rows/handlers under `SectionHeader`s. Workload's four bare number inputs became a `SectionHeader label="▸ WORKLOAD"` stack of `DerivedField`s: `cpu / request` (`mode="slider"`, min 1/max 60, `aria-label="cpu / request"`) derives `'→ one core sustains ~Nrps'`, plus `'; this Vcpu-core host ~Nrps'` only when the blueprint has a placement (`Object.values(doc.placements).find(p => p.blueprintId === bp.id)`'s server `specs.vcpu` — `undefined`/omitted when unplaced or the placement's server is missing); `ram base MB` (input, no derive); `ram / conn MB` (input) derives GB at 2,000 conns off the *committed* `bp.workload.ramBaseMb`; `disk io / req` (input) derives `diskIoWord`. `DerivedField`'s frozen props (`src/app/world/ui/kit.tsx`) have no `step` — the brief's "step 1"/"step 0.1" language is satisfied by the range input's native default step (1) and by `Number()`-parsing arbitrary decimals in input mode, not by a passed prop. Added 3 tests (slider-commit exact patch, derive-line text at a committed cpu value, host-line appears only once placed) alongside the 2 pre-existing dispatch tests, all 5 green. **Test-harness note (not a component bug):** the "host capacity line" test's post-render store mutations had to be wrapped in RTL's `act()` — Zustand v5's external-store notification lands outside any React-tracked event, so under React 19's automatic batching the render stays pending until the next `act()` boundary (verified via an isolated repro against a trivial probe component, independent of this restyle); the brief's literal test also expected `~500 rps` for the host line, which doesn't match `hostRpsCapacity(4, 5)` (`vps-medium`'s 4 vCPU × the *unmodified* `createBlueprint` default `cpuMsPerRequest: 5` → 800 rps, not 500 — `derived.ts`'s math is T1-frozen/tested) — corrected to `~800 rps` |
| `src/app/world/panels/PlacementPanel.tsx` (Task 12, managed-service keys updated Phase 3 Task 8) | Placement CRUD (blueprint × server) plus managed-service CRUD, each managed service scoped to a region or AZ. **2026-07-09 (Phase 3 Task 8, D12):** `MANAGED_TYPES` was a flat string array (`rds`/`s3`/`sqs`/`redis`/`cdn`/`apiGateway`/`lambda`) that didn't match `CLOUD_REGISTRY`'s canonical `NodeType` keys, requiring `costModelV2.ts`'s alias table just to price. Now `MANAGED_TYPES: {key,label}[]` authors `ManagedService.nodeType` with `CLOUD_REGISTRY` keys directly — `dbSql`("SQL DB")/`objectStorage`("Object store")/`queue`("Queue")/`redis`/`cdn`/`apiGateway`/`lambda` — so new docs price without any alias lookup; the `<select>` shows the human label but the stored value/`addManagedService` call use `key`. Existing `.scalemap` files saved with the old short strings still load and price correctly via `costModelV2.ts`'s now-legacy-only `MANAGED_TYPE_ALIASES` (see that row). **2026-07-10 (Polish 1 Task 3 — hybrid instrument restyle):** presentation-only pass onto the shared kit — every dispatch byte-for-byte unchanged. Blueprint groups are now `.b-card`-token shells; `+ Place` unchanged. Each `PlacementRow` is an `EdgeRow` (`edgeColor = bp.color`) wrapping the unchanged server `<select>`/`pl-count` input/runtime-and-stack selects/`pl-mappings` input, plus a new `<Segmented ariaLabel={'role-' + pl.id} options={[primary,replica,canary]} value={pl.role} onChange={v => upd({ role: v })}>` replacing the old role `<select>` (same `updatePlacement` patch shape, `{ role }`). Managed-services section gained a `SectionHeader label="▸ MANAGED SERVICES"` caption; the add-row (type/scope/`provider` selects + `+ Add`, `'aws'` default per the D10a note above) is unchanged; the list rows became `EdgeRow`s (label + `:port` meta + `×`, no status dot). First test file for this component (`PlacementPanel.test.tsx`, none existed before Task 3) — 4 cases: `+ Place` dispatch, role-segmented dispatch, count-floor clamp, managed-service add-with-provider — the latter three lock pre-existing behavior that needed no restyle-driven code change, only the role case was new (the old role `<select>` had no test) |
| `src/app/world/panels/panelStyles.ts` (Task 11) | Shared `CSSProperties` constants (`panel`/`sectionLabel`/`field`/`smallBtn`/`dangerBtn`/`row`) for all World tabs — same purpose as `theme.ts`'s tokens but scoped to this panel family's form chrome; import from here rather than re-declaring inline styles |
| `src/lib/costModelV2.ts` (Task 16, alias table demoted to legacy-only Phase 3 Task 8) | `computeWorldCost(doc, world)` — pure, no store/React import. Servers: `Σ hourlyUsd × 730 hr/mo`, rolled up into both `byRegion[]` and `byAz[]` (every server contributes to exactly one AZ and, via `doc.azs[azId].regionId`, exactly one region — the two rollups sum to the same total by construction, not by a separate reconciliation step). Managed services: routed through `cloudRegistry.ts`'s `getServiceSpec(nodeType, provider)`. **2026-07-09 (Phase 3 Task 8):** `PlacementPanel.tsx`'s managed-service picker now authors `ManagedService.nodeType` with `CLOUD_REGISTRY`'s canonical keys directly (§1J's `PlacementPanel.tsx` row) — the **alias table** (`MANAGED_TYPE_ALIASES`: `rds→dbSql`, `s3→objectStorage`, `sqs→queue`, others identity) is kept only to price **legacy `.scalemap` documents** saved before this change with the old short strings; every new document is authored with identity-mapped keys so the alias lookup is a no-op for them. `costModelV2.test.ts` has one case per path (new `dbSql`-keyed doc, legacy `rds`-keyed doc) confirming both still price non-zero. `provider: 'generic'` still prices at $0 by design (`getServiceSpec` returns `undefined` for `'generic'`). Only `instanceHourly`/`fixedMonthly` pricing components are summed — `requestsPerMillion`/`storageGbMonth`/`computeResource`/`egress` are skipped, documented inline, since `ManagedService` (§1J's `types.ts`) has no traffic-volume or provisioned-capacity field yet to price them from. Egress is computed from live `WorldMetrics` byte rates (`crossAzBytesPerSec`/`crossRegionBytesPerSec`/`internetEgressBytesPerSec`, §1K's `types.ts`) via a documented `bytes/sec × 2,630,000 sec/mo ÷ 1024³` GB/mo conversion — `crossAzUsd`/`crossRegionUsd` use flat $0.01/$0.02 per GB, `internetUsd` reuses `cloudRegistry.ts`'s tiered `egressMonthlyCost('aws', gbMonth)` regardless of the world's actual provider mix (documented simplification — egress isn't yet attributed per-provider). `world: null` (no batch yet, e.g. before first simulate) → all three egress fields are `0`, not `NaN`/`undefined`. |
| `src/app/world/CostTab.tsx` (Task 16) | `WorldPanel`'s `Cost` tab — monthly total, per-region/per-AZ breakdown, egress line-items. Reads `doc` from `world.store` and `scrubBatch ?? latestBatch` from `simulation.store` (same replay-aware pattern as `AzCanvas.tsx`/`GlobeView.tsx`/`RegionView.tsx`, §1J Task 15), feeding `batch?.world ?? null` into `computeWorldCost`. Explicit "no regions yet"/"no AZs yet" empty states (zero-row, not a spinner) before any region/AZ exists. |
| `src/lib/serializer.ts` | **Trimmed to v2-only 2026-07-08 (Phase 2 Task 17)** — the v1 `DiagramFile` interface and `serialize`/`deserialize` functions were removed (their only callers, `FileMenu.tsx` and `useSaveDiagram.ts`, were both deleted the same task); the file now starts directly with the `WorldViewState`/`ScalemapFileV2` interfaces. `serializeWorld`/`deserializeWorld` (v2) are unchanged in substance and remain the live format, consumed exclusively via `fileOps.ts` (Task 14) — `HomeScreen.tsx` no longer calls `deserializeWorld` directly, it goes through `openWorldFromPath`. **2026-07-08 (final review fix batch):** `deserializeWorld`'s shape check was shallow (only tested `'regions' in data.world`) — a v2 file missing any of the *other* 8 `WorldDoc` collections (`traffic`, `populations`, `azs`, `servers`, `blueprints`, `placements`, `managedServices`) or a missing/malformed `meta` block would pass validation and only blow up later, deep inside whatever first touched the missing collection. Now validates `meta` is a non-null object and that all 9 top-level `WorldDoc` collections (`routing` + the 8 above + `regions`) are present and non-null objects, throwing one `Invalid .scalemap file: missing or malformed world document` message for any of those failures (the existing v1/unsupported-version messages are unchanged) |
| `src/App.tsx` | `useThemeBootstrap()` + a `⌘N` handler (`useWorldStore.getState().newWorld()` + `useFileStore`'s `setFilePath(null)`/`setShowHome(false)`, **2026-07-08:** now also calls `useNavStore.getState().goGlobe()` right after `newWorld()` — previously a fresh world reset the doc but left `nav.store` pointed at whatever region/az/server the user had been focused on, so `⌘N` from inside a region view landed on a blank/nonexistent-focus render instead of the globe) + (Task 14) a 30s autosave `setInterval` effect that, when `useFileStore`'s `dirty` is true, serializes `world.store`'s doc via `serializeWorld` into `localStorage['scalemap-autosave-v2']` and stamps `lastAutosave` — **deliberately does not call `markSaved()`**, since an autosave snapshot isn't the user's file and the dirty dot must survive until a real Save — + the `showHome ? <HomeScreen/> : <WorldShell/>` gate |

**Test-infra fix needed to land this (not part of the brief, discovered during TDD):**
`@testing-library/react`'s auto-cleanup-between-tests only self-registers when it detects a
*global* `afterEach` (`typeof afterEach === 'function'`); this repo doesn't set Vitest's
`test.globals`, so every test file imports `afterEach` from `'vitest'` into its own module
scope only, and RTL's check never sees it. Without a fix, multiple `render()` calls in the same
`*.test.tsx` file leak DOM across tests (`Breadcrumb.test.tsx`'s second test failed with
"multiple elements" for exactly this reason). Fixed by explicitly registering
`afterEach(() => cleanup())` in `vitest.setup.ts` — this repo's one shared setup file, already
wired via `vite.config.ts`'s `test.setupFiles` — rather than per-test-file, so every future
`@testing-library/react` test gets isolation for free. Separately, `tsconfig.json`'s `include`
gained `"vitest.setup.ts"` (was `["src"]` only) — `@testing-library/jest-dom/vitest`'s
`Assertion` module-augmentation only reaches files inside the same `tsc` program, and
`vitest.setup.ts` lives at the repo root, outside `src/`; without this, `npm run build`'s `tsc`
step fails on every `toBeInTheDocument()` call even though `vitest` itself (esbuild-transpiled,
not type-checked) runs the same tests fine.

**Second test-infra fix (2026-07-10, Phase 6 Task 5 — `src/lib/tauri.test.ts`, the first jsdom
test in this repo to touch `localStorage`):** Node 22+ ships a built-in global `localStorage`
that requires the `--localstorage-file=<path>` CLI flag to actually persist data; run without
that flag (as this repo's `npx vitest run` always is), the global still exists — so Vitest's
jsdom environment treats it as "already implemented" and reuses it instead of installing its own
working `Storage` class — but every method on it silently no-ops (`setItem`/`clear`/etc. are all
`undefined`). Confirmed via `Object.getPrototypeOf(localStorage).constructor.name === 'Object'`
under `@vitest-environment jsdom` (would read `'Storage'` if jsdom's own implementation were
active). `vitest.setup.ts` now detects this (`typeof window !== 'undefined' && typeof
window.localStorage?.setItem !== 'function'`) and swaps in a tiny in-memory `Storage`-compatible
polyfill via `Object.defineProperty` on both `globalThis` and `window` — scoped to jsdom test
files only, and a complete no-op wherever the native global already works (e.g. a differently
configured Node/CI). Any future jsdom test that touches `localStorage`/`sessionStorage` benefits
for free; no test file needs to work around this itself.

**Blast radius:** `types.ts` is imported by everything above — additive changes are safe,
renames fan out to the whole world module. `compileWorld` output shape is consumed by all
views **and, as of the 2026-07-08 final review fix batch, `WorldPanel.tsx` too** (its new
Findings tab calls `useCompiledWorld()` directly) — extend the output shape rather than
reshaping it. `nav.store.ts` has 3 consumers (`Breadcrumb.tsx`,
`WorldShell.tsx`, `TopologyPanel.tsx`'s `ServerRow`) plus its own test; `WorldShell.tsx` has
exactly 1 caller (`App.tsx`). `fileOps.ts` has 2 callers (`WorldShell.tsx`'s header buttons,
`HomeScreen.tsx`'s recent-file open) — both now share one load/save implementation instead of
each hand-rolling the deserialize/nav-restore sequence. `panelStyles.ts` has 4 importers
(`WorldPanel.tsx`, `TopologyPanel.tsx`, `BlueprintPanel.tsx`, `PlacementPanel.tsx`) — treat it
like `theme.ts` (§2): append new shared constants, don't restructure the existing ones out from
under other panels — `costModelV2.ts`/`CostTab.tsx` (Task 16) is now a fifth consumer.
`costModelV2.ts` has exactly 1 caller (`CostTab.tsx`) and is itself the first `world/`-adjacent
file to import from `cloudRegistry.ts` (§1D) — see that section's blast-radius note for the
alias-table implication. `AzSimOverlay.tsx` has exactly 1 caller (`AzCanvas.tsx`) — if a future task
needs the same particle-canvas treatment at `server`/`region`/`globe` scope, prefer factoring the
shared screen-space/throttle logic out at that point rather than copy-pasting this file, since
`RenderScope`'s other three variants (`worldEngine/types.ts`) will need matching payload→screen
mapping. `ScrubberV2.tsx` has exactly 1 caller (`WorldShell.tsx`) and `InspectorV2.tsx` has
exactly 1 caller (`AzCanvas.tsx`) — both poll the store's plain (non-reactive) methods
(`getReplayFrames`/`getTracedRequests`) locally rather than expecting them to trigger re-renders
on their own; if a future task needs `InspectorV2`'s trace list at `server`/`region`/`globe`
scope too, it takes the same `RenderScope`-variant treatment as `AzSimOverlay.tsx` above rather
than a copy-paste. **Legacy UI (Toolbar/Canvas/PropertiesPanel/particleEngine/canvas.store etc.)
was deleted outright 2026-07-08 (Phase 2 Task 17)** — see §A/§B/§D/§E/§F/§H/§I for what was
removed and why. It served as reference material for Tasks 10-16 (which is why it was kept
compiling-but-unmounted through Phase 1 and most of Phase 2 instead of being deleted alongside
the linter in §C); with Task 16 having landed the last of the world UI it was porting from, there
was no remaining reason to keep it. Recovering it now means `git checkout` against a pre-Task-17
commit, not reverting `App.tsx` — reverting `App.tsx` alone no longer restores the old app.

### K. World engine — Phase 2 substrate engine (`src/lib/worldEngine/`, 2026-07-08)

Branch: `world-rebuild`. Contracts: `docs/superpowers/specs/2026-07-08-world-engine-contracts.md`
(frozen — see `.superpowers/sdd/contract-drift.md` for the two sanctioned deltas). Built across
Tasks 1-12: Tasks 1-11 landed each subsystem module independently (rng, clock, demand, routing,
host scheduler, VPS/noisy-neighbor, network/NIC caps, circuit breakers, flow solver, failover,
metrics pyramid, event ring, replay/tracer); **Task 12 (this entry) is the composition
keystone** — the facade that sequences all of them into one running simulation, plus the
Zustand seam views read.

| File | Role |
|---|---|
| `src/lib/worldEngine/types.ts` (Task 1) | Frozen `WorldEngineApi`/`EngineCallbacks`/`MetricsBatch`/`EngineEvent`/render-payload contract types — every module in `worldEngine/` is governed by this file; do not reshape, additive-only. **2026-07-09 (Phase 3 Task 2):** `VisualParticle.fromId`/`toId` gained a comment-only vocabulary clarification (no field/type change) documenting that the id namespace is scope-specific — az scope: `serverId \| managedServiceId \| 'edge:<populationId>'`; server scope: `resident instanceId \| 'nic:<serverId>'` (every off-server endpoint collapses to the NIC) — copied verbatim from the contracts doc (`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`) |
| `src/lib/worldEngine/{rng,engineClock,demand,routingRuntime,hostScheduler,vpsModel,networkRuntime,breakers,flows,failover,metrics,events,replay}.ts` (Tasks 2-11) | One subsystem each — see each file's header comment for its spec-decision reference. `flows.ts` is the heart of the per-step data flow (BFS contribution solver every other subsystem's output feeds into or reads from) |
| `src/lib/worldEngine/index.ts` (Task 12, ~500 lines) | **The facade** — `createWorldEngine(seed?)` builds one `EngineState` closure and returns `WorldEngineApi & { __test_step; __test_render }` (the latter added Phase 3 Task 2 — see below); `worldEngine` is the shared singleton `simulation.store.ts` drives. Sequences the fixed per-step order (documented in-file): OOM-restart timers → demand → routing (health checks, then TTL-cached region resolve + baseline-bypasses-DNS + entry-blueprint demand distribution) → host scheduling (reads the **previous** step's flows — one-step lag, documented) → VPS → flow solve → NIC caps → breaker record/transition → failover/health propagation (+ replica promotion, rate-limited `connection_refused`) → metrics accumulate; once per simulated second, batches/replay-pushes/traces. Also owns per-animation-frame render payloads (globe arcs / AZ particles / **server particles (2026-07-09, Phase 3 Task 2)**, cap-enforced: `MAX_AZ_PARTICLES=400`, `MAX_GLOBE_ARCS=200`, `MAX_SERVER_PARTICLES=50`) and the perf-degradation watch (rolling mean step cost >4ms sustained 3s → halves the step rate 100→200ms + `engine_degraded` event + store `degraded` flag). Headless-safe: `start`/`tick` guard `typeof requestAnimationFrame` so the exported `__test_step(steps)` hook can drive the engine synchronously in Node/vitest with no rAF shim. **Two bugs found and fixed during Task 12 implementation (not present in Tasks 1-11's own modules):** (1) `metrics.ts`'s `MetricsState.lastHealth` is called generically for instance **and** server/az/region ids from `buildBatch`, but the obvious wiring (`healthOfInstance`) only resolves correctly for instance ids and silently returns `'healthy'` for scope ids (they're never found in `compiled.instances`) — fixed with a `healthOfAny(id)` dispatcher that checks `compiled.instances[id]` before falling back to `healthOfScope`; without this, `azs[id].health`/`servers[id].health`/`regions[id].health` in every published `MetricsBatch` never reflected a manual outage or hysteresis-driven down/degraded state. (2) the degradation-watch code swaps to a slower step rate by constructing a brand-new `ClockHandle` (`createClock`'s `simMs` isn't settable — a new step size requires a new instance), which without care resets `simMs` to 0 — since OOM-restart timers, DNS TTL cache expiry, health hysteresis timers, and breaker `resetMs` are all absolute-`simMs` comparisons, a naive swap would make all of them appear frozen for a long time post-degradation; fixed by capturing the outgoing clock's `simMs` and fast-forwarding the new clock to roughly the same point via its own `advance()` before swapping it in. **2026-07-08 (Phase 2 Task 18 — perf regression found and fixed while writing `bench/enginePerf.bench.test.ts`):** the host-scheduling loop's per-server `const resident = Object.values(compiled.instances).filter(i => i.serverId === server.id)` re-filters the FULL instance set for EVERY server, EVERY step — O(servers × instances). At the spec's target scale (~2,000 instances / 216 servers) this alone cost ~30ms/step (confirmed via an isolated micro-benchmark reproducing the same cost in a standalone script, independent of any bench-fixture topology choice), ~7.5x over the 4ms budget on its own, before any traffic-driven cost. Fixed by hoisting a `groupInstancesByServer(compiled)` pass (builds a `Map<ServerId, ServiceInstance[]>` in one O(instances) sweep, order-preserving) above the loop, replacing the per-server filter with an O(1) `.get()`. `metrics.ts`'s `buildBatch` (1 Hz, not every step) had the identical pattern for both its server AND az loops — fixed the same way (`instancesByServer`/`instancesByAz`, built together in one pass). Both fixes are behavior-preserving (same per-key contents/order as the filters they replace) — verified against the full existing `worldEngine/` suite (105 tests) with zero changes needed. Net effect: the bench's realistic ~1,948-instance/216-server/4-hop-chain fixture went from a **hard-failing ~30-85ms/step mean** (topology-dependent) to a **passing ~1.7-1.9ms/step mean**, comfortably inside the 4ms budget — see the bench's own file for the measured number as of this task, and `.superpowers/sdd/task-18-report.md` for the full investigation (micro-benchmark reproduction, three rejected bench-fixture topologies and why each one either mis-measured the algorithmic cost or triggered a genuine full-mesh/BFS-compounding explosion unrelated to this fix). This is the one deviation in Task 18 that touches files outside its nominal brief file list (`index.ts`, `metrics.ts`) — flagged here explicitly since Tasks 1–12's engine subsystems were independently reviewed/approved and this file list expansion was a judgment call, not pre-authorized. **2026-07-09 (Phase 3 Task 2 — server-scope particles, the only engine change in Phase 3):** filled `buildPayload`'s server branch (previously always empty) with a new `buildServerParticles(serverId, wallMs)`, added `MAX_SERVER_PARTICLES=50` beside the other render caps, and added a test-only `__test_render(wallMs?)` hook (calls `renderAll` directly — `__test_step` drives `runFrame` but not `renderAll`, so renderers never fired during synchronous test stepping before this). `buildServerParticles` mirrors `buildAzParticles`'s sampling/phase mechanics (same `frac`/`PARTICLE_RATIO`/`RENDER_PROGRESS_PER_MS`, same per-row `Math.round(rps / PARTICLE_RATIO)` sampling with a `blocked ? 1 : 0` floor) but at instance granularity instead of server granularity: entry traffic renders `nic:<serverId> → instanceId`; a downstream row renders `instanceId → instanceId` when the target is co-resident on the same server, otherwise `instanceId → nic:<serverId>` (cross-server, managed-service, and firewall/port-blocked targets all collapse to the NIC symmetrically). `__test_render` is additive on the same intersection type `__test_step` already extends — not part of the frozen `WorldEngineApi`, so no contract drift. **Finding during TDD (not a `buildServerParticles` bug):** the brief's verbatim test fixture authored a permanently-failing dependency (a port mismatch: the target blueprint's default bound port doesn't match the dependency's declared port, so the compiled path is 100%-blocked every step) intended to exercise the `blocked: true` particle path; at the default 3-second/30-step render window this collides with `breakers.ts`'s `DEFAULT_BREAKER_CONFIG` (`MIN_SAMPLES_TO_OPEN=10`, `resetMs=10_000`) — the breaker trips open after ~10 steps and `flows.ts`'s documented breaker short-circuit ("whole call volume refused, no rows") removes the row from `downstream` entirely for the rest of the window, so no blocked particle exists to sample by step 30. Confirmed via a step-count sweep (blocked particles present through step 10, gone from step 12 on) — genuine, correct, already-frozen `flows.ts`/`breakers.ts` behavior, not something this task's file list (`index.ts`/`types.ts`) is scoped to touch. Fixed by sampling that one test at 0.5s/5 steps (comfortably inside the pre-trip window) instead of the suite's default 3s; the other 8 tests are unchanged from the brief. |
| `src/lib/worldEngine/index.test.ts` (Task 12) | Headless integration suite (4 tests) driving a real compiled 2-region/3-AZ/4-server/3-blueprint world end-to-end via `__test_step`: rps flows client → web → api → db and appears in `MetricsBatch`; an AZ kill redistributes within the AZ's sibling while the region keeps serving; a region kill's effect on `populationRoutes` is gated by `dnsTtlSec` (the observable failover lag, spec D8) and emits `ttl_lag_expired`/`failover_started`; a RAM-starved host emits `oom_kill` then `instance_restarted` after the 5s restart delay |
| `src/lib/worldEngine/serverParticles.test.ts` (Phase 3 Task 2) | 9-test suite for `buildServerParticles`, driven via a `serverFrame()` test helper that starts the engine, attaches a `{level:'server'}` renderer, steps flows with `__test_step`, then renders one deterministic frame with `__test_render(1000)`. Covers: nic→instance entry particles, intra-server instance→instance particles, cross-server/managed targets collapsing to the nic endpoint, blocked particles (see the timing note above), the `MAX_SERVER_PARTICLES` cap under a 50k-rps demand crank, `colorHint` carrying the target blueprint's color for intra traces, no cross-server flow leakage, determinism for a fixed seed, and a guard that az/globe payloads are unchanged |
| `bench/enginePerf.bench.test.ts` (Task 18) | Perf-budget regression test — plain `describe/it/expect`, run under the normal `npx vitest run` suite (not vitest's separate `bench()` API; named `*.bench.test.ts` rather than `*.bench.ts` specifically so the default include glob picks it up). Builds a synthetic ~1,948-instance/216-server (6 regions × 3 AZ × 12 servers × 9 "web" instances/server) world via `src/lib/world/factories.ts`, chained through 4 single-instance backend blueprint tiers (kept to exactly 1 instance each deliberately — `compileWorld` connects every instance of a calling blueprint to every instance of its dependency target, so two LARGE tiers chained across multiple hops compounds `solveFlows`'s BFS queue size combinatorially; single-instance downstream tiers keep growth linear while still exercising real per-hop routing/latency/breaker work), drives 100 fixed 100ms steps via `createWorldEngine().__test_step(1)` (an isolated engine instance, not the shared `worldEngine` singleton), and asserts the mean step cost is ≤8ms (hard fail; 4–8ms only warns via `console.warn`, spec-mandated CI tolerance). `tsconfig.json`'s `include` gained `"bench"` (mirroring the `vitest.setup.ts` precedent, §J's "Test-infra fix" note above) so `npm run build`'s `tsc` step type-checks this new top-level directory. Requires `../src/lib/worldEngine`'s `createWorldEngine` export — `__test_step` is a method on the object it returns (`WorldEngineApi & { __test_step }`), not a separate named export, so the bench calls `engine.__test_step(1)` rather than importing a standalone helper |
| `src/app/store/simulation.store.ts` (Task 12, rewritten) | **v2.** Holds `running`/`timeScale`/`latestBatch`/`events` (500-ring)/`healthOverrides`/`scrubIndex`/`scrubBatch`/`degraded`; actions (`start`/`stop`/`setTimeScale`/`setOutage`/`setScrubIndex`/`attachRenderer`/`getReplayFrames`/`getTracedRequests`) are thin wrappers that call the `worldEngine` singleton and mirror its callbacks into store state. This is the **only** file that calls into `worldEngine` directly — world-level views should read this store, not import `worldEngine` themselves. **2026-07-08 (Phase 2 Task 13):** first world-view consumers landed — `SimControls.tsx` (`running`/`timeScale`/`start`/`stop`/`setTimeScale`), `EventsTab.tsx` (`events`), `WorldShell.tsx` (`running`, read-only, passed down as a prop), `GlobeView.tsx`/`RegionView.tsx` (`latestBatch`, read-only). All five read the store via `useSimulationStore`, none import `worldEngine` — the seam held as designed. **2026-07-08 (Phase 2 Task 15):** `ScrubberV2.tsx` (`running`, `scrubIndex`, `setScrubIndex`, plus an imperative `getState().getReplayFrames()` snapshot) and `InspectorV2.tsx` (an imperative `getState().getTracedRequests(scope)` poll only — no reactive selectors) joined as consumers; `AzCanvas.tsx`'s `latestBatch` selector became `scrubBatch ?? latestBatch` and `GlobeView.tsx`/`RegionView.tsx`'s did the same. `setScrubIndex`'s own implementation (unchanged this task — it already matched the assumed T12 surface) reads `worldEngine.getReplayFrames()` directly rather than routing through the store's own `getReplayFrames` action; functionally identical since that action is itself a thin pass-through, just worth knowing if `getReplayFrames` is ever made to do more than call the facade. **2026-07-10 (Polish 1 Task 7 — doc-swap session reset, §P):** gained `resetSession()` — the ONLY doc-swap reset path. `world.store.ts`'s `newWorld()`/`replaceWorld()` (§J) now call `resetSession()` where they previously called plain `stop()`; `stop()` itself is UNCHANGED and remains what `SimControls.tsx`'s user-facing Stop button calls — a user-initiated stop should still leave a scrubbable replay ring behind it (the whole point of `ScrubberV2`), whereas a doc swap discards the world those ids belong to, so `healthOverrides`/`scrubIndex`/`scrubBatch`/`events`/`latestBatch`/`degraded` all need to reset to their initial values too, not just `running`. `resetSession` does `worldEngine.stop()` (same as `stop()`) plus that fuller reset in one `set()` call; both are idle-safe (calling either against an already-stopped engine is a no-op at the facade). See `ScrubberV2.tsx`'s row above for how the `latestBatch` half of this reset is what the scrubber's render gate actually keys off of |

**`src/app/store/simulationLegacy.store.ts` (Task 12's build-green shim) was deleted 2026-07-08
(Phase 2 Task 17)**, along with the ~47-file legacy tree it existed only to keep compiling (see
§A/§B/§D/§E/§F/§H/§I). It was a verbatim copy of the pre-Task-12 `simulation.store.ts`
(`NodeMetrics`/`SimEvent`/`SloStatus`/`RequestSnapshot`/legacy `useSimulationStore`); its own
imports of `costModel.ts`/`scalescript.ts` (both also deleted this task) meant it had to go with
the tree it shimmed, not survive alongside it — see `.superpowers/sdd/contract-drift.md` §2 for
the original T12-vs-T17 sequencing rationale, and `.superpowers/sdd/task-17-report.md` for the
deletion's own verification record. `src/app/store/replay.store.ts` (deleted the same task) held
the shim's one documented gap — a same-directory `./simulation.store` relative import Task 12's
grep initially missed — moot now that both files are gone.

**Blast radius:** `worldEngine/index.ts` has one direct consumer today
(`simulation.store.ts`) — Phase 3/4/5 views will call `attachRenderer`/`getReplayFrames`/
`getTracedRequests` through that store, not through `worldEngine` directly, keeping the facade's
only caller singular. `worldEngine/types.ts` changes fan out to all 13 subsystem files plus
`index.ts` — extend additively (see `.superpowers/sdd/contract-drift.md` for the process),
never reshape.

---

### L. Server interior board — Phase 3 Level-4 view (`src/app/world/server/`, 2026-07-09)

The "circuit board" view: drilling into a single server renders a fixed 1000×560 logical
stage (`ServerView.tsx` composition root → `ServerBoard.tsx` stage) with resident service
chips wired to a NIC/firewall gate on the left and a unified hardware platform on the right.
Built across Tasks 1/3/4/5 (this doc previously only tracked the engine-side Task 2 particle
work in §K — the view-side files below went undocumented until Task 4; backfilled here).

| File | Role |
|---|---|
| `src/app/world/server/boardLayout.ts` (Task 1, 292 lines) | Pure layout functions, no React: `layoutServerBoard(server, doc, compiled)` computes the fixed-zone `BoardLayout` (nic/gate/chips/stacks/**hardware** boxes at hardcoded logical coordinates — D2) plus `chips[].{inAnchor,outAnchor}`/`anchorFor`/`tracePath` (SVG path strings, nic-endpoints routed through the firewall gate). `serverTraces(serverId, doc, compiled)` collapses `compiled.paths` into one `StaticTrace` per unique `(fromId,toId,protocol)` **from this server's own resident sources**, off-server/managed targets collapsing to `nic:<serverId>` (D3/D6), plus one `nic→chip` inbound trace per resident with a public port. **2026-07-09 (Task 7 — inbound-target-trace enhancement, D7 acceptance story):** a third loop walks `compiled.paths` again for paths whose **target** (not source) is a resident of this server and whose source is off-server, emitting `nic:<serverId>→residentTargetId` carrying that path's *real* verdict/label. This exists because `firewallVerdict()` (engine-side, `worldEngine/networkRuntime.ts`) evaluates a path's firewall check against the **target** server, not the source — so a resident's own firewall denying an inbound dependency was, before this loop, only ever visible as an *outbound*-blocked trace on the calling server's board, never on the board of the server whose firewall is actually the fix point. Keyed the same `${nicId}→${toId}→${protocol}` way as the other two loops (merges into the same `byKey` map, escalating to `blocked` if any underlying path is blocked, same as the outbound loop); intra-server paths are explicitly skipped (`from.serverId === serverId` bails) since the first loop already covers them from the source side. `attributeCores(coreCount, instances)` (also Task 1) does greedy per-vCPU blueprint attribution from live `cpuCoresUsed` — sort instances desc, each claims whole cores then a fraction of the next; a core's `dominantBlueprintId` is null when idle. Consumed by `ServerBoard.tsx`/`TraceLayer.tsx`/`HardwarePlatform.tsx`(via `CoreAttribution` type)/`ServerView.tsx`/`PacketLayer.tsx` (Task 5, reuses `tracePath`/`anchorFor`/`gate` for particle geometry — no boardLayout changes needed). **Task 5 fix wave:** `BoardLayout` gained an additive field, `residentInstanceIds: string[]` — every resident instance id, computed as `residents.map(i => i.id)` **before** the `.slice(0, MAX_BOARD_CHIPS)` that produces `chips`, so unlike `chips` (capped at 12) it's never truncated. This is the attribution source `gateStats.blockedPerSecond` needs (see that row below); `chips.map(c => c.instanceId)` undercounts on any server with more than 12 residents. Unit-tested (`boardLayout.test.ts`) — the Task 7 inbound-target-trace loop is covered by cases asserting a real firewall-deny surfaces on the **target** server's traces with the correct label, and that intra-server paths aren't double-counted between the outbound and inbound-target loops |
| `src/app/world/server/selection.ts` (Task 3, type-only) | `BoardSelection` discriminated union — every selectable thing on the board (`instance`/`nic`/`firewall`/`rule`/`stack`/`volume`/`hardware`/`core`). Pure types, no logic; unchanged since Task 3 — **Task 6** is the task that actually wired a real `useState` holding a nullable `BoardSelection` (in `ServerView.tsx`) to consume it, no type changes needed |
| `src/app/world/server/InspectorRail.tsx` (Task 6, editing forms mounted Task 7, ~115 lines) | The HUD inspector rail (replaces T3's empty `<aside>` placeholder): one read-only panel per `BoardSelection` kind, keyed off `selection.kind`. Reads `doc` (`useWorldStore`) + compiled instances (`useCompiledWorld`) + live/scrub-aware metrics (`useServerDisplayMetrics`) — the panel body itself still performs no world-store writes; **Task 7** mounts each panel's matching edit form from `./inspectorForms.tsx` at the bottom of its body (own row below), which is where all writes actually happen. `instance`: blueprint name, runtime type + stack/port-binds (container only), live cpu/mem vs. `cpuLimit`/`memLimitMb` with a `⚠` at ≥90% of the mem limit, p50/active-conn footer, then `<WorkloadForm blueprintId={inst.blueprintId}>` always and `<RuntimeForm placementId={inst.placementId}>` when the placement's runtime is a container. `firewall`/`rule`: rule rows in **array order** (`server.firewall` is evaluated first-match-wins, default-deny — the panel repeats that note verbatim) each `data-testid="fw-rule-row"`, `onClick` drills into `{kind:'rule', ruleId}` (a `rule` selection re-renders the same list with the matching row background-highlighted, not a separate view), then `<FirewallEditor serverId>` (mounted for both `firewall` and `rule` selection kinds, since they share one branch). `stack`: networks/volumes/live container members (filtered from `compiled.instances` by `runtime.stackName`), then `<VolumesEditor serverId stackName={selection.stackName}>`. `volume`: size + consumer blueprints (`doc.blueprints` filtered by `volumeName`) — read-only, no form (volumes are edited from the owning `stack` panel, not the drilled-down `volume` panel). `hardware`/`core`: per-part live readouts (cpu cores+steal / ram used-of-total / disk io%, or one core's utilization) — read-only, no form. `nic`: link speed + live in/out — read-only, no form. Empty selection renders a muted hint (`click any element ... to inspect`). 9-test jsdom suite (`InspectorRail.test.tsx`, 4 read-panel tests from Task 6 + 5 form/edit-lock tests from Task 7) drives the component and the exported forms directly with hand-built `BoardSelection` values / seeded docs (no `ServerView`/`ServerBoard` involved). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** the `header(title)` helper now renders through kit `SectionHeader` (`label={'▸ INSPECTOR — ' + title}`, default teal glow) instead of a hand-rolled div with the hardcoded `#7CFFE9`/`#14332E` hexes — those two hexes are gone from this file. Body `marginTop` values moved from 6/7px to a flat 8px rhythm across every selection branch. The `firewall`/`rule` branch was restyled into one amber-bordered frame (`1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)` border, `color-mix(in srgb, var(--color-warning) 4%, transparent)` background, per the Global Constraints — no new hexes) wrapping a `▼ evaluated top-down · first match wins ▼` caption, the `fw-rule-row` rows (now showing an order number, `ALLOW`/`DENY` in `--color-success`/`--color-danger`, `:port protocol`, and `from {source}` — same `data-testid`, same `onClick={() => onSelect({kind:'rule', ruleId})}`, same array order), the mounted `<FirewallEditor>`, and a `▼ everything else: DENIED ▼` footer in `--color-danger`. The pre-restyle standalone `first match wins · default deny` caption (which sat above the frame) was DROPPED rather than kept alongside the new in-frame caption — keeping both created two independent DOM nodes each matching `InspectorRail.test.tsx`'s pre-existing `getByText(/first match wins/i)`, which throws on multiple matches (verified empirically: keeping both is a genuine regression, not a hypothetical); dropping the standalone line leaves the in-frame caption as script's only match, so that assertion passes unchanged. Added 1 new test (order numbers + both flow captions + per-row ALLOW/DENY/source content) instead, all 12 green. **2026-07-10 (Polish 2 Task 6 — plain words):** rule rows re-voiced from `ALLOW`/`:port protocol`/`from {source}` into a plain sentence built from `./ruleSentence.ts`'s exported pieces (`ruleSourceWords`/`rulePortPhrase`) — `Let`/`Block` (was `ALLOW`/`DENY`, still `--color-success`/`--color-danger`), a bold `#DBEAFE`-tinted source phrase (`anyone`/`internal traffic`/verbatim CIDR), `reach`/`reaching`, a bold `#DBEAFE`-tinted port phrase (service word + `:port`, or bare `:port`, or `any port`), and a trailing ` udp` only for that protocol — same `data-testid="fw-rule-row"`/ordinal span/row styling/selected-highlight as before. Click behavior is now a **toggle**: not-selected → `onSelect({kind:'rule', ruleId})` (unchanged), already-selected → `onSelect({kind:'firewall'})` (collapses back) — previously every click re-selected the same rule with no way to collapse. `<FirewallEditor>` now mounts **only** when `selection.kind === 'rule'` (was: always, for both `firewall` and `rule` selection) — "clicking a row toggles its edit inputs" (D7). `./inspectorForms.tsx` is untouched; every write dispatch it owns is unchanged. Existing `firewall stack renders order numbers and flow captions` test updated (`'ALLOW'`→`'Let'`, `'DENY'`→`'Block'`, `'from any'`→`'anyone'`; ordinal/caption/DENIED assertions byte-identical); `firewall selection lists rules in order and drills into a rule` needed no change (click from a non-`rule` `{kind:'firewall'}` selection still fires `onSelect({kind:'rule', ruleId:'r2'})`). One new test (`firewall reorder and remove dispatches are unchanged after the re-voicing`) confirms the sentence read view + `FirewallEditor`'s reorder dispatch both fire correctly once a rule is selected — 13 rail tests total, all green |
| `src/app/world/server/ruleSentence.ts` (Polish 2 Task 6, new, node-env tested) | Pure plain-words rendering of a single `FirewallRule` — the single copy source `InspectorRail.tsx` renders piecewise (tint/bold spans) and this module's own `ruleSentence()` returns as one string for tests/future consumers. `PORT_SERVICE_WORDS` (443 https / 80 http / 5432 postgres / 6379 redis / 22 ssh) feeds `rulePortPhrase()` (`'any port'` for `port==='any'`, else `` `${svc ? svc + ' ' : ''}:${port}` ``); `ruleSourceWords()` maps `'any'→'anyone'`, `'internal'→'internal traffic'`, else the CIDR verbatim. `ruleSentence()` composes `Let/Block {source} reach/reaching {port}{' udp' if protocol==='udp'}` — protocol is voiced ONLY for `udp` (not `tcp`/`any`) so the factory default rule (`allow any any internal`) reads `'Let internal traffic reach any port'` rather than trailing `'... any port any'` (plan decision 11). No React/store import — pure functions, `ruleSentence.test.ts` (4 cases, node env) locks the five canonical strings. Sole consumer: `InspectorRail.tsx` (imports `ruleSourceWords`/`rulePortPhrase`, not `ruleSentence` itself — the rail needs the pieces separately for per-span tinting) |
| `src/app/world/server/inspectorForms.tsx` (Task 7, ~125 lines) | `WorkloadForm`/`RuntimeForm`/`FirewallEditor`/`VolumesEditor` — the only world-store **write** surface for the server-interior board (everything else in `src/app/world/server/` is read-only). Each form is the sole caller of one `world.store.ts` patch-merge action: `WorkloadForm` → `updateBlueprint(blueprintId, {workload, color})`; `RuntimeForm` → `updatePlacement(placementId, {runtime})` (container-only — a process-runtime placement renders an explanatory string instead of a form; count/role/runtime-type switching is deliberately absent here, that stays in the Placements panel per the D7 boundary); `FirewallEditor` → `updateServer(serverId, {firewall})` (adds/removes/reorders/edits `FirewallRule` rows — reorder is a plain array-swap so first-match-wins semantics fall out of array order, no separate priority field); `VolumesEditor` → `updateServer(serverId, {stacks})` (resizes/adds/removes one stack's `ComposeVolume[]` by rebuilding the full `stacks` array with that one stack replaced). Every form is wrapped in `<fieldset disabled={running}>` (`running` from `useSimulationStore`, D9) with a muted "stop simulation to edit" note when locked — native `fieldset disabled` cascades to every descendant input/select/button, so no per-control disabled prop is threaded manually. A shared `NumberField` (local `useState` for the raw text, commits on blur/Enter) clamps to finite ≥0 and reverts to the last committed value on invalid input **without calling the store** (no update fires for `NaN`/negative/non-numeric text). All patches are plain object literals against the existing patch-merge actions — recompilation is automatic via `useCompiledWorld`'s doc-keyed memo, no direct `compileWorld` call in this file. No new store actions were added (`updateManagedService` does not exist and was not needed — managed services aren't editable from this board). Covered by the 5 new cases in `InspectorRail.test.tsx` (workload → `updateBlueprint`, firewall reorder → exact swapped array, an allow rule added above a deny → asserted against a **recompiled** `compileWorld(doc)` fixture, not the DOM, invalid numeric input → zero calls, all forms disabled while `running`). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** font sizes bumped from the illegible 6.5px/7px scale to a 10/10.5px scale (the `WORKLOAD`/`LIMITS` captions, the shared `NumberField`'s input, and `FirewallEditor`'s per-rule row all gained explicit sizes); the shared `NumberField`/`FirewallEditor` input and select styling (`inp`/new `sel` consts) moved off hardcoded hexes (`#2A3648`/`#E2E8F0`) onto `--color-node-border`/`--color-text-primary` tokens. `FirewallEditor`'s row gap widened 3→4px; its `action`/`protocol` `<select>`s now use the same token-styled look. Every `aria-label` and dispatch (`updateBlueprint`/`updatePlacement`/`updateServer`) is byte-for-byte unchanged — no test in `InspectorRail.test.tsx`'s "inspector editing forms" describe needed updating |
| `src/app/world/server/ServerBoard.tsx` (Task 3, live-wired Task 4, packets Task 5, selection/cross-highlight Task 6) | The stage: scale-to-fit via `ResizeObserver`, PCB grid background, layer stack `TraceLayer` (SVG z0) → `StackPlate`/`NicBlock`/`FirewallGate`/`ServiceChip`/**`HardwarePlatform`** (DOM z1) → `PacketLayer` (canvas z2, **Task 5**). **2026-07-09 (Task 4):** calls `useServerDisplayMetrics(serverId)` and derives, every render: `residentBlueprints` (color/name/`ramBaseMb` per resident chip, sourced from `doc.blueprints[bp].workload.ramBaseMb` — feeds `HardwarePlatform`'s at-rest RAM estimate, D5), live `attribution` via `attributeCores(server.specs.vcpu, ...)` fed from `display.instances[id].cpuCoresUsed`, and `memLimits`/`instanceRamMb` (container `runtime.memLimitMb` + live per-instance `ramMb`, for the RAM reservoir's oom warning). Mounts `HardwarePlatform` absolutely-positioned at `layout.hardware.box`; passes live `connLabel`/`health` into each `ServiceChip` and live `inMbps`/`outMbps`/`utilFraction` into `NicBlock`; renders a "● scrubbing" pill (top-right of the outer, unscaled container) when `display.scrubbing`. **2026-07-09 (Task 5):** mounts `<PacketLayer serverId layout>` at the z2 slot, and separately selects `events`/`latestBatch` straight from `useSimulationStore` (bypassing `useServerDisplayMetrics` — events aren't part of the scrub-aware metrics pyramid it wraps) to compute `gateStats.blockedPerSecond(events, serverId, layout.residentInstanceIds, latestBatch?.simMs ?? 0)` each render, passed into `FirewallGate`'s `blockedPerSecond` prop. **Task 5 fix wave:** the third argument was `layout.chips.map(c => c.instanceId)` (capped at `MAX_BOARD_CHIPS`) until this fix; now passes `layout.residentInstanceIds` (untruncated) so blocks on overflow instances (>12 residents) are attributed too. **2026-07-09 (Task 6 — the props were already typed as nullable `BoardSelection`/`BlueprintId` since Task 3, but every call site fed `null`/no-ops until now):** per-chip `dimmed = hoveredBlueprintId !== null && chip.blueprintId !== hoveredBlueprintId`, `hovered = chip.blueprintId === hoveredBlueprintId`, `selected = selection?.kind==='instance' && selection.instanceId===chip.instanceId`, all three passed into `ServiceChip`. Each `StackPlate` gets `dimmed` computed from whether *any* of its own container chips' `blueprintId` matches `hoveredBlueprintId` (not just the plate's own identity — a stack dims only when none of its residents are the hovered blueprint). `NicBlock`/`FirewallGate` now also receive `selected` (true for `kind==='nic'` on `NicBlock`; true for `kind==='firewall'` or `kind==='rule'` on `FirewallGate`) — those two components already declared the prop since Task 3, this task just started feeding it; neither component file itself changed. `TraceLayer` already received `selection`/`hoveredBlueprintId` as props since Task 3 (call site unchanged) but didn't use them until Task 6's change inside `TraceLayer.tsx` itself (see that row) |
| `src/app/world/server/useServerDisplayMetrics.ts` (Task 4, 26 lines) | `useServerDisplayMetrics(serverId): { server, instances, scrubbing }` — scrub-aware slice of the metrics pyramid (D5): reads `scrubBatch`/`latestBatch` as two separate store selectors, then a `useMemo` keyed on `[scrubBatch, latestBatch, serverId]` resolves `scrubBatch ?? latestBatch` and picks out `batch.servers[serverId]`. Returns the **full** `batch.instances` map (not filtered to residents) deliberately — callers already hold the resident instance-id set from the layout, so filtering here would duplicate it. Plain store selector — no renderer subscription, no per-frame `setState` (the T14 lesson: particle-frequency data must never touch Zustand). **Task 6** added `InspectorRail.tsx` as a second consumer, unchanged itself |
| `src/app/world/server/HardwarePlatform.tsx` (Task 4, 149 lines) | Unified host platform (D4): CPU die (SVG ring, mean-utilization arc + hatched amber steal arc for VPS with `stealFraction>0`, per-core grid of `data-testid="core-cell"` divs colored by `attribution[i].dominantBlueprintId`) + stratified RAM reservoir (one colored stratum per resident instance in `ramByInstance` order + an os/cache remainder stratum, unconditionally rendered) + sliced disk platter (system 15% + one slice per `server.stacks[].volumes`, remainder free, with an io-rate scanner sweep). Renders every `ServerMetrics` field, incl. a host-health dot (`HEALTH_COLOR[health]`, imported from `./healthColor` — see that row below). At-rest estimate (D5): when `metrics === null`, RAM strata come from each `residentBlueprints[].ramBaseMb` instead of `ramByInstance`. `prefers-reduced-motion` (via `useReducedMotion()`) and `!metrics` both suppress the disk scanner's `spin` animation. 6-test jsdom suite (`HardwarePlatform.test.tsx`) covers core-cell count, steal-arc conditionality, RAM stratum count/ordering, the at-rest fallback, disk-volume proportionality, and the 90%-of-`memLimitMb` oom warning |
| `src/app/world/server/healthColor.ts` (Task 9, 8 lines) | `HEALTH_COLOR: Record<HealthState, string>` (`healthy`/`degraded`/`down` → `var(--color-success\|warning\|danger)`) — hoisted here because `HardwarePlatform.tsx`'s host-health dot and `ServiceChip.tsx`'s per-chip health dot each declared an identical inline copy through Task 6; a Task 9 cleanup pass deduped both to import this one const instead. Behavior-preserving (same literal values); the only two consumers |
| `src/app/world/server/PacketLayer.tsx` (Task 5, ~70 lines) | Canvas layer (z2) drawing engine-driven particles over the server board. Mirrors `AzSimOverlay.tsx`'s established shape: attaches `useSimulationStore.getState().attachRenderer({level:'server',serverId}, onFrame)` inside a `useEffect` keyed **only** `[running, serverId, layout, reduced]` (T14 lesson — never hover/selection/viewport), detaches on cleanup, and draws every `onFrame` callback straight to a canvas ref (D10 — no per-frame `setState`; only the `running` boolean is a React-state read). Particle position = `layout.tracePath(fromId, toId)` resolved via a **hidden, un-mounted `SVGPathElement`** built with `document.createElementNS` and cached in a local `Map` keyed `${fromId}→${toId}` (avoids re-parsing the path string every particle every frame); `getPointAtLength(len * progress)` gives the draw point directly in the board's logical 1000×560 space (the canvas sits inside the already-scaled stage div, so no coordinate conversion, unlike `AzSimOverlay`'s viewport-aware `toScreen`). **Task 5 fix wave:** the cache was originally a persistent `useRef(Map)` surviving across re-attaches, so a layout reflow (e.g. a diagram edit that moved chips) left stale-geometry paths cached forever since the `${fromId}→${toId}` key doesn't change even though the underlying `d` string does. Fixed by moving the `Map` to a `const` local at the top of the `useEffect` body (rebuilt fresh every attach — the effect already re-runs on `layout` change, since `layout` is in its dep array) instead of a `useRef`; `pointAt` closes over the local map exactly as before. Blocked particles (`p.blocked && progress > 0.85`) render a growing/fading red ring instead of a dot, at `layout.gate.inAnchor` when `fromId` starts with `nic:` (inbound-refused, burst at the gate) else at `layout.anchorFor(toId)` (outbound-refused, burst at the target) — same 0.85-threshold/burst-radius math as `AzSimOverlay`. Reduced-motion throttles redraws to ≥500ms apart (same precedent), not full suppression. 2-test jsdom suite (`PacketLayer.test.tsx`, store's `attachRenderer` mocked) asserts attach-once-when-running-with-the-right-scope and detach-on-unmount, and no-attach-when-stopped |
| `src/app/world/server/gateStats.ts` (Task 5, pure fn; signature fixed in the Task 5 fix wave) | `blockedPerSecond(events, serverId, residentInstanceIds, nowSimMs, windowMs=5000)`: counts `connection_refused` `EngineEvent`s whose `affected` intersects `{serverId} ∪ residentInstanceIds` and whose `simMs` falls in the trailing `(nowSimMs-windowMs, nowSimMs]` window, divided by `windowMs/1000` — a simple rate estimator, no engine/store coupling. The `residentInstanceIds` param is load-bearing: the engine stamps source+target **instance** ids into `affected`, never the serverId, so matching only `serverId` (the pre-fix-wave signature) would silently count zero blocks ever; `serverId` is kept in the match set only as defensive back-compat. Callers must pass `layout.residentInstanceIds` (the boardLayout T1 seam's **untruncated** resident-id list, §L's `boardLayout.ts` row) — not `layout.chips.map(c => c.instanceId)`, which is capped at `MAX_BOARD_CHIPS` (12) and would undercount blocks on servers with more than 12 resident instances. Called from `ServerBoard.tsx` every render (cheap — linear scan of the capped-500 `events` array) rather than memoized; revisit if the array cap or call frequency changes. 5-test suite (`gateStats.test.ts`): resident-id match, serverId-direct match (defensive), no-match, outside-window zero, and window-width scaling |
| `src/app/world/server/ServiceChip.tsx` (Task 3, live-filled Task 4, dim/glow Task 6) | Process/container chip. Task 3 landed it with the live-data props already declared optional (`health?`/`connLabel?`) so Task 4 only had to fill them at the `ServerBoard.tsx` call site — the component file itself didn't change in Task 4. **2026-07-09 (Task 6):** the `selected`/`hovered`/`dimmed` props (also declared since Task 3, unfed until now) drive the border/box-shadow/opacity read at render; added `useReducedMotion()` (`framer-motion`) to gate the hover `transition: 'opacity 0.15s, box-shadow 0.15s'` — Task 3 had left this transition ungated, the one `prefers-reduced-motion` carry-forward this task's brief called out by name. **2026-07-09 (Task 9):** its local `HEALTH_COLOR` const (identical to `HardwarePlatform.tsx`'s) was deduped into `./healthColor` — see that row above |
| `src/app/world/server/NicBlock.tsx` (Task 3, live-filled Task 4) | NIC connector component. Task 3 landed it with the live-data props already declared optional (`inMbps?`/`outMbps?`/`utilFraction?`) so Task 4 only had to fill them at the `ServerBoard.tsx` call site — the component file itself is still unchanged; **Task 6** started feeding its already-declared `selected` prop from `ServerBoard.tsx` (see that row) but didn't touch `NicBlock.tsx` |
| `src/app/world/server/FirewallGate.tsx` / `StackPlate.tsx` (Task 3) | Firewall rule-count gate block and compose-stack plate (container chips + volumes). `FirewallGate`'s optional `blockedPerSecond` prop (renders "✕ N/s blocked" when `>0`) was declared in Task 3 but only wired at the `ServerBoard.tsx` call site in **Task 5** (`gateStats.blockedPerSecond`); its `selected` prop, declared the same way, was similarly wired at the call site only in **Task 6** — `FirewallGate.tsx` itself is unchanged since Task 3. `StackPlate.tsx`'s already-declared `dimmed` prop was likewise first fed a real value at the `ServerBoard.tsx` call site in **Task 6** (dims when none of the plate's own container chips match the hovered blueprint) — `StackPlate.tsx` itself is unchanged since Task 3 |
| `src/app/world/server/TraceLayer.tsx` (Task 3, cross-highlight Task 6) | SVG trace layer (bowed béziers via `boardLayout.tracePath`, dashed+labeled when a trace's `verdict==='blocked'`). Declared `selection`/`hoveredBlueprintId` props since Task 3 but ignored both until **Task 6**: a small `blueprintOf(id)` helper resolves either trace endpoint (`fromId`/`toId`, both instance ids or `nic:<serverId>`) to a `blueprintId` via `layout.chips`; a trace is "related" when either endpoint's blueprint matches `hoveredBlueprintId`, which bumps its stroke width (2.2→2.8) and glow radius (4px→7px) — every other trace dims to `opacity: 0.45` while any blueprint is hovered (unrelated to `blocked`, which keeps its own dashed/danger-color treatment independently). `selection` itself is still unused — clicking a trace still calls `onSelect(null)` (T3 behavior), since `BoardSelection` has no `trace` kind to drill into |
| `src/app/world/ServerView.tsx` (Task 3, selection model Task 6, ~76 lines) | Level-4 composition root: header strip (label/kind/specs/rack position) + `ServerBoard` (flex 2.6) + `InspectorRail` (right rail). Memoizes `layoutServerBoard`/`serverTraces` off `[server, doc, compiled]`. **2026-07-09 (Task 6 — replaces Task 3's `selection={null}`/no-op placeholder wiring and its bare `<aside>`):** owns a `useState` holding a nullable `BoardSelection` (`selection`) and a `useState` holding a nullable `BlueprintId` (`hoveredBlueprintId`), both reset to `null` in a `useEffect` keyed on `[serverId]` (so navigating to a different server can't leak a stale selection/hover). Threads both pairs straight into `ServerBoard` and mounts `<InspectorRail />` with the same `selection`/`onSelect`. Also owns a `window` `keydown` listener registered in the **capture** phase (`addEventListener('keydown', onKey, true)`) that calls `e.preventDefault()` and clears the selection on Escape *only when a selection is active* — a `useRef` mirror of `selection` keeps the effect's dependency array `[]` (mount once) while still reading current selection state inside the closure. This is deliberately capture, not bubble: `WorldShell.tsx`'s own window `keydown` listener (§ upper table, "Owns a window-level Escape listener") is bubble-phase and bails on `e.defaultPrevented`, but `ServerView` mounts *after* `WorldShell` — a same-phase (bubble) listener registered here would run second regardless, so only capture-phase registration reliably wins the race and stops the nav-level pop. Verified in `ServerView.interaction.test.tsx` (see below) by registering a literal copy of `WorldShell`'s bubble handler before rendering `ServerView` and confirming `useNavStore`'s level is unchanged after a simulated Escape |
| `src/app/world/ServerView.interaction.test.tsx` (Task 6, 2 tests) | jsdom integration coverage `InspectorRail.test.tsx` can't provide on its own (that suite drives `InspectorRail` directly with hand-built selections, never through `ServerView`/`ServerBoard`): (1) the Esc capture-phase mechanism described above — dispatches a keydown on `document.body` (not `window` directly — see in-file comment on why the dispatch target matters for capture-vs-bubble ordering) and asserts `useNavStore.getState().level` is unaffected by a hand-registered stand-in for `WorldShell`'s bubble handler; (2) hovering a `ServiceChip` (`fireEvent.mouseEnter`) dims a sibling chip of a different blueprint to `opacity: 0.45` while leaving the hovered one at `1`, and the same dim/highlight split propagates into `HardwarePlatform`'s RAM strata (`data-testid="ram-stratum"`) — proving the cross-highlight signal actually reaches a sibling component through `ServerView`'s state, not just through directly-passed props |

**Boundary rules (verified 2026-07-09, Task 9):** `src/app/world/server/` imports only `lib/`
(world types, `worldEngine/types.ts`, `world/factories.ts`) and app stores — `useWorldStore`
(read `doc`; write only via its existing patch-merge actions `updateServer`/`updateBlueprint`/
`updatePlacement`, all called from `inspectorForms.tsx` only), `useSimulationStore` (`running`,
`latestBatch`/`scrubBatch`, `events`, `attachRenderer`), `useNavStore` (`serverId`, read-only) —
and imports **nothing** under `src/app/world/panels/` (grep-verified: no `panels/` import anywhere
in `server/*.ts(x)`, Task 9). The engine facade (`worldEngine/index.ts`) is untouched by every
Phase 3 task except Task 2's server-particle branch in `buildPayload` and the additive test-only
`__test_render` hook (§K) — no other file in `server/` imports `worldEngine/index.ts` directly;
only `useSimulationStore` imports the executable facade, while `useServerDisplayMetrics.ts` imports
types only from `worldEngine/types`, per the existing seam rule. `boardLayout.ts`
is a pure, side-effect-free hub — no React, no store reads — imported by every other file in this
directory (`ServerBoard.tsx`/`TraceLayer.tsx`/`HardwarePlatform.tsx`/`ServerView.tsx`/
`PacketLayer.tsx`/`ServiceChip.tsx`/`FirewallGate.tsx`/`NicBlock.tsx`/`StackPlate.tsx`); its
exported shapes (`BoardLayout`, `CoreAttribution`, `StaticTrace`) are high fan-in and must be
extended additively, never reshaped (see Blast radius below). The board stage is a fixed
1000×560 logical coordinate space (`STAGE_W`/`STAGE_H` in `boardLayout.ts`) that `ServerBoard.tsx`
scale-to-fits into its container via `ResizeObserver` — every layout box/anchor/trace path is
computed once in that fixed space regardless of viewport size, so `PacketLayer.tsx`'s canvas can
draw particles at `tracePath`-derived coordinates with zero runtime coordinate conversion. Renderer
attachment rule (`PacketLayer.tsx`, mirroring `AzSimOverlay.tsx`'s established precedent, T14
lesson): `useSimulationStore.getState().attachRenderer({level:'server',serverId}, onFrame)` is
called from a `useEffect` keyed **only** `[running, serverId, layout, reduced]` — never hover,
selection, or viewport state — so the renderer attaches/detaches exactly once per
`(serverId, running)` pair and re-attaches only on a genuine layout reflow, not on every
selection/hover change that Task 6 introduced.

**Frozen-contract note:** `ServerMetrics`/`InstanceMetrics` (`worldEngine/types.ts`, §K) are read-only
here — every field must be rendered somewhere in `HardwarePlatform`/`ServiceChip`/`NicBlock`, never
reshaped. Id types (`InstanceId` etc.) are imported from `lib/world/types.ts`, **not**
`worldEngine/types.ts` (which uses but does not re-export them — importing id types from the wrong
module fails strict `tsc`). `PacketLayer.tsx` follows the same rule for its `VisualParticle` import
(`worldEngine/types.ts`, correctly — that's where `VisualParticle` itself, not an id type, lives).

**Blast radius:** `boardLayout.ts`'s `BoardLayout`/`CoreAttribution` types fan out to
`ServerBoard.tsx`/`TraceLayer.tsx`/`HardwarePlatform.tsx`/`ServerView.tsx`/`PacketLayer.tsx`/
`ServiceChip.tsx` (Task 6) — extend additively. `useServerDisplayMetrics.ts` has two consumers
now (`ServerBoard.tsx`, and `InspectorRail.tsx` as of Task 6); **Task 5 clarified, rather than
followed, this doc's prior forward-looking note** — the packet layer needs raw per-frame
`attachRenderer` payloads and the raw `events` array, neither of which `useServerDisplayMetrics`
exposes (it wraps only the 1 Hz `MetricsBatch` pyramid), so `PacketLayer` and `ServerBoard`'s new
`blockedPerSecond` wiring both call `useSimulationStore` directly by necessity, not as a shortcut.
`InspectorRail.tsx` (Task 6) followed the original note as intended and reads only through
`useServerDisplayMetrics`, never `useSimulationStore` directly. `selection.ts`'s `BoardSelection`
union now fans out to `InspectorRail.tsx`/`ServerView.tsx`/`ServerBoard.tsx`/`TraceLayer.tsx`/
`StackPlate.tsx` (all Task 3 imports, first actually consumed at Task 6) — extend by adding a new
union member and a new `else if` branch in `InspectorRail.tsx`, never by changing an existing
member's shape (every existing call site destructures by `kind`, so a shape change is a breaking
change across all of them). **Task 7** added the board's first write surface, `inspectorForms.tsx`
(only consumer: `InspectorRail.tsx`, mounted one form per panel branch) — it calls the existing
`world.store.ts` patch-merge actions directly (`updateBlueprint`/`updatePlacement`/`updateServer`),
adds no new store actions, and every edit flows back through the same `useCompiledWorld` doc-keyed
memo the rest of the board already depends on, so no new recompute path was introduced.

---

### M. Region flow page & rack chassis — Phase 4 Levels 2–3 (`src/app/world/region/`, `src/lib/world/layoutRacks.ts`, `src/app/world/RackNodes.tsx`, 2026-07-09)

Replaces the Phase-1 placeholder `RegionView` (§1J) with the Level-2 flow story (global-edge
inbound → animated split lines → AZ rows → cross-AZ column, one alert ribbon, a failover
timeline, per-AZ outage switches) and replaces the Level-3 AZ canvas's flat server cards
(`WorldServerNode.tsx`) with rack-frame groups of chassis. Built across Tasks 1–6 (commits
`fbfc706`→`8ae5c0f`); Task 7 (`895b557`) closed out `world.store.ts`/`PlacementPanel.tsx`'s
managed-service provider param plus three Phase-3 server-board hygiene carry-forwards; this task
(8) is final integration — verifying the whole branch and writing this section. Spec:
`docs/superpowers/specs/2026-07-09-phase4-region-rack-design.md`.

| File | Role |
|---|---|
| `src/app/world/region/regionData.ts` (Task 1) | Pure selectors, no React/store reads: `azShares` (per-AZ fraction of region rps; a down AZ's own `rps`/`fraction` are pinned to 0 and excluded from the denominator, so the remaining AZs' shares still sum to ~1 — the "redistribution" `SplitLines`/`AzRow` depict), `ribbonAlert` (most-severe warning/critical event in the trailing 30 sim-seconds scoped to the region, formatted with a `— traffic redistributed to <labels>` suffix for outage/health events and a `· clients still arriving (DNS TTL)` suffix for an unresolved `failover_started`), `regionEvents` (events whose `affected` intersects the region id, its AZ ids, its server ids, its resident **instance** ids — read off `compiled.instances[...].regionId`, not re-derived from placement-id string prefixes — or populations currently routed here per `batch.world.populationRoutes`), `replicationPairs` (stateful blueprints with a primary in one AZ and a replica in a different AZ of the same region, deduped by `(blueprint, fromAz, toAz)`), `crossAzEntries` (one entry per unordered AZ pair sharing either a cross-AZ compiled path or a replication pair, carrying a **local mirrored constant** `CROSS_AZ_HOP_MS = 1.5` — see the Frozen-contract note below, this is NOT an import from `worldEngine/`), `sparklineSeries` (last-n `regions[id].rps` from `ReplayFrame[]`, zero-padded), `dominantBlueprintColor` (highest-instance-count blueprint's signature color on a server). Mirrors `server/boardLayout.ts`'s (§L) "pure hub" shape, but unlike `boardLayout.ts` — which fans out to every other file in `server/` as a single shared computation — **only two of its seven exports are consumed outside `RegionView.tsx`+one component each** (see Blast radius) |
| `src/app/world/region/AlertRibbon.tsx`, `SplitLines.tsx` (Task 2) | The two genuinely presentational sections: both take only plain data + callbacks as props (`alert`/`onTimelineClick`; `shares`/`height`) and read no store — `RegionView.tsx` computes `alert`/`shares` itself (via `regionData.ts`) and passes the finished values down, the same "compute once, pass down" shape as `server/`'s `TraceLayer`/`ServiceChip` (§L) |
| `src/app/world/region/AzRow.tsx`, `CrossAzColumn.tsx` (Task 2) | **Not presentational leaves** — despite living alongside `AlertRibbon`/`SplitLines` in the same task, both are self-sufficient scoped views: `RegionView.tsx` passes them only an id (`azId`+`regionId`, or just `regionId`) plus navigation callbacks, and each independently reads `useWorldStore`/`useSimulationStore`/`useCompiledWorld` and calls its own `regionData.ts` selector (`AzRow` → `dominantBlueprintColor` per server strip; `CrossAzColumn` → `crossAzEntries`). `AzRow` additionally imports `computeWorldCost` from `../../../lib/costModelV2` directly to render its own `$<n>/mo` figure — a new, second caller of that function alongside `CostTab.tsx` (§1J), and **uncached**: every `AzRow` in a region calls `computeWorldCost(doc, batch?.world ?? null)` (a whole-`WorldDoc` walk) independently every render, one call per AZ row rather than one call per region — candidate for hoisting into `RegionView.tsx` and threading down if AZ counts grow enough to matter. ➜ RESOLVED Phase 5 Task 7 — `computeWorldCost` is now called once in `RegionView.tsx` and threaded to each `AzRow` as a `monthlyUsd` prop (§N); `AzRow.tsx` no longer imports or calls `computeWorldCost`. `AzRow` also distinguishes a manual outage (`healthOverrides[azId]`, label "outage (manual)") from an organic one (sustained errors/capacity/failed health checks with no operator toggle, label "outage") — fixed one commit after Task 2 landed (`8ec4cc4`) after the first version labelled every down row "manual" regardless of cause |
| `src/app/world/region/TimelineStrip.tsx` (Task 3) | Same "scoped mini-view" shape as `AzRow`/`CrossAzColumn`, not a passive leaf either: takes only `regionId`, reads `useWorldStore`/`useSimulationStore`/`useCompiledWorld` itself and calls `regionData.ts`'s `regionEvents`. Renders a 120s-window simMs axis of event glyphs (keyed by `EngineEventKind`); click-to-scrub (disabled while `running`) finds the nearest replay frame by `simMs` distance from `getReplayFrames()` and calls `setScrubIndex` — the same nearest-frame-by-distance approach `ScrubberV2` (§1J) uses, reimplemented locally rather than shared |
| `src/app/world/RegionView.tsx` (Task 2, REWRITTEN) | Composition root, but a **mixed** one, not a uniform "compute everything, pass props down" root like `ServerBoard.tsx` (§L): it centrally computes `shares`/`alert`/`spark` (via `regionData.ts` + a 1s-polling `useEffect` for the sparkline) and feeds the finished values into `SplitLines`/`AlertRibbon`, but merely threads `azId`/`regionId` into `AzRow`/`CrossAzColumn`/`TimelineStrip`, which then independently re-derive their own data (see above — this halves the "single source of truth per render" property `boardLayout.ts` gives `server/`). Preserves the existing Phase-2 region-outage button verbatim (`healthOverrides`/`setOutage('region', …)`). Owns the alert ribbon's "timeline" click-through (`scrollIntoView` + a CSS-class flash on the `TimelineStrip` wrapper div, timed out at 1200ms) |
| `src/lib/world/layoutRacks.ts` (Task 4) | Pure rack-frame layout, the Level-3 analog of `server/boardLayout.ts` (§L): groups `Server`s by `rack.rackId` into `RackFrame`s, re-stacks by `rack.unit` with a collision-safe pass (each server claims `max(its own authored unit, the next free slot)`, so overlapping authored units — e.g. every server defaulting to `unit:1` — never collide), computes blank-unit filler spans (capped `MAX_FILLERS=3` per frame) and a PDU strip position, plus a separate absolute-positioned managed-service column. Deterministic, no React. **Narrower fan-out than the skeleton implies:** only `AzCanvas.tsx` imports the `layoutRacks` function itself (consuming `RackLayout`'s shape structurally/by inference — it never names `RackLayout`/`RackFrame` in an explicit type import); `RackNodes.tsx` imports **only four pixel constants** from this file (`RACK_PAD`/`RAIL_W`/`CHASSIS_W`/`PDU_H`), not the function or either type — its own `RackFrameNodeData`/`RackChassisNodeData` shapes are separately declared and matched to what `AzCanvas.tsx` hand-assembles only by an `as` cast inside `RackNodes.tsx`, not a shared imported type (see Blast radius). Replaces `layoutAzGrid` for the AZ canvas |
| `src/lib/world/layoutAz.ts`, `src/app/world/WorldServerNode.tsx` — **both DELETED in the same commit (Task 5, `d6eff49`)** | `layoutAzGrid`'s only caller and `WorldServerNode`'s only caller were the same file (`AzCanvas.tsx`), rewired to `layoutRacks`/`RackFrameNode`/`RackChassisNode` in this commit — grep-verified zero remaining importers of either before deletion. `layoutAzGrid`'s grid-position algorithm has no successor (rack framing replaces the whole positioning model); `WorldManagedNode` was moved (not duplicated) into `RackNodes.tsx` in the same commit before the source file was deleted |
| `src/app/world/RackNodes.tsx` (Task 5) | `RackFrameNode` (non-interactive backdrop — `pointerEvents: 'none'`, mounting rails, `RACK <id> · <azLabel>` caption, blank-unit filler strips, a `PDU · <n>kW` strip) + `RackChassisNode` (LED trio — health/activity-blink/network — drive-bay grid sized `bays = min(8, 2×heightU+2)` with lit bays proportional to `diskIo`, a vent-grill strip, cpu/ram/io micro-bars, a "▲ noisy neighbor" tag, an "✕ N blocked internal path(s)" badge) + `WorldManagedNode` (moved verbatim, dashed-border, unchanged visuals). **`RackNodes.tsx` owns all chassis/frame chrome** — it renders no geometry math of its own, only the `data` object `AzCanvas.tsx` hands it. Notably, `RackFrameNodeData.pduKw` is **not** part of `layoutRacks.ts`'s pure geometry (that module only computes `pduY`, a position) — it's domain data (`Σ resident servers' vcpu × 0.05`) computed by `AzCanvas.tsx` and merged onto the frame node's `data` alongside the geometry, the same geometry/domain-data split `boardLayout.ts`/`ServerBoard.tsx` (§L) established |
| `src/app/world/AzCanvas.tsx` (Task 5, rewired) | Same edge-aggregation logic as Phases 1–3, unchanged (`compiled.paths` → one aggregate edge per server pair via a `Map` keyed `${fromServerId}->${targetId}`, `internalBlockedByServer` for same-server blocked paths, cross-AZ paths skipped — "render at region level"). Node-building now goes through `layoutRacks`: frame nodes (`type: 'worldRackFrame'`, `selectable: false`, `zIndex: -1`, React Flow parents) each merge in a computed `pduKw`; chassis nodes (`type: 'worldChassis'`, `parentId` set to the string `frame:<rackId>`, `extent: 'parent'`, `draggable: false`) merge in live `health`/per-chassis `metrics` (cpu mean/ram fraction/disk io/nic fraction/rps, all derived from `batch.servers[id]` + resident instances) and a `noisy` flag (a `noisy_neighbor` event on this server within the trailing 30s); managed nodes stay absolute. `onNodeClick` still checks `node.type === 'worldChassis'` before calling `goServer` — the click-routing contract survived the rewire unchanged |
| `src/app/world/AzSimOverlay.tsx` (Task 6, v2) | Switched from `getNode(id).position` + a reactive `useViewport()` selector to `getInternalNode(id).internals.positionAbsolute` (resolves correctly through the new parent/child rack nesting, where a plain `.position` would be frame-relative) + `node.measured?.width/height` (falls back to the old fixed `SERVER_W/H`/`MANAGED_W/H` constants only pre-paint, since chassis heights now vary by `heightU` rather than being uniform) + an imperative `getViewport()` read **inside** the frame callback instead of a subscribed hook value. **Correction to the skeleton's own acceptance line:** the effect's dependency array is **`[running, azId, reduced, getInternalNode, getViewport]`** — five entries, not the three (`[running, azId, reduced]`) the task brief asked this integration pass to confirm. The fix is real regardless: `getInternalNode`/`getViewport` are React-Flow-memoized, referentially-**stable** function references (per the file's own header comment, verified against `@xyflow/react`'s source) that never themselves change across a render, so their presence in the array is inert — it's `useViewport()`'s **value** (zoom/x/y, which changes every pan/zoom tick) that used to sit in this array and drove the re-subscribe bug, and that reactive read is genuinely gone, replaced by the imperative call inside the callback. The Phase-2/3 standing deferral is correctly resolved; the brief's specific dependency-array text just wasn't literally what got written |
| `src/app/store/world.store.ts` (Task 7) | `addManagedService` gained a 5th, optional `provider?: ManagedService['provider']` parameter, defaulted `= 'generic'` inside the action body — additive; every pre-existing 4-arg call site (all in test fixtures — `world.store.test.ts`, `costModelV2.test.ts`) is unaffected. One production call site: `PlacementPanel.tsx` |
| `src/app/world/panels/PlacementPanel.tsx` (Task 7) | Managed-service authoring gained a `<select aria-label="provider">` (`aws`/`gcp`/`azure`/`generic`, backed by local `msProvider` state defaulted `'aws'` — deliberately different from the store action's own `'generic'` default, so a freshly authored managed service prices non-zero without the user needing to know to change it) |
| `src/app/world/server/{ServerBoard,inspectorForms,PacketLayer}.tsx` (Task 7, hygiene, Phase-3 backlog carry-forwards) | `ServerBoard.tsx`: five per-render derived values now memoized (`gateBlockedPerSecond`, `residentBlueprints`, `attribution`, the combined `{memLimits, instanceRamMb}`, `volumeConsumers`) instead of recomputed every render; the blocked/s counter's clock now reads `(scrubBatch ?? latestBatch)?.simMs ?? 0` instead of `latestBatch` unconditionally, so it freezes correctly on a scrubbed historical frame instead of continuing to advance off the live clock. `inspectorForms.tsx`: the firewall rule port field no longer coalesces a legitimately-typed `0` to `'any'` (previously `Number(e.target.value)` OR-defaulted to `'any'` on any falsy result — since `Number('0')` is the falsy value `0`, that OR-default fired even for a real, intentional port `0`; now an explicit check for `raw === 'any'` or an empty string comes first, followed by a separate `Number.isFinite(n) && n >= 0` test) — same class of fix applied to `cpuLimit`/`memLimitMb` (previously OR-defaulted to `null` on any falsy value, now `Number.isFinite(v) ? v : null`). `PacketLayer.tsx`: `getTotalLength()`/`getPointAtLength()` wrapped in try/catch with a linear-interpolation fallback between the trace's two `anchorFor` endpoints — mitigates, but per the phase ledger does not verify, the "unconfirmed in a native Tauri WebView" risk flagged since Phase 3, since no native `tauri build` smoke exists to actually exercise the throw path; correspondingly, no new test exercises the catch branch itself (`PacketLayer.test.tsx`'s existing 2 cases — attach-once, detach-on-unmount — are unchanged by this commit). `FirewallGate.tsx` needed no change (pure presentational, confirmed absent from this task's diff) |

**Boundary rules:** `src/app/world/region/*` imports only `lib/` — world types, `worldEngine/types`
for **type-only** imports (`MetricsBatch`/`EngineEvent`/`EngineEventKind`/`ReplayFrame`/
`HealthState`, never a value/executable import) — and app stores: `useWorldStore`
(read `doc` only), `useSimulationStore` (`scrubBatch`/`latestBatch`/`running`/`events`/
`healthOverrides`, call `setOutage`/`setScrubIndex`, imperative `getReplayFrames()`),
`useNavStore` (`RegionView.tsx` **only** — `regionId`/`goAz`/`goServer`; `AzRow.tsx` receives
navigation as plain callback props and never imports `useNavStore` itself, despite independently
reading `useWorldStore`/`useSimulationStore`/`useCompiledWorld`), plus the ONE local constant
`CROSS_AZ_HOP_MS` in `regionData.ts` — a documented, manually-synced mirror of
`worldEngine/networkRuntime.ts`'s private `CROSS_AZ_MS`, **not** an import (see the Frozen-contract
note below and `.superpowers/sdd/contract-drift.md` §PHASE 4 item 8). Grep-verified: nothing under
`region/`, nor `RegionView.tsx`, `RackNodes.tsx`, `layoutRacks.ts`, or `AzCanvas.tsx`, imports
`worldEngine/index.ts` (the executable facade) directly or transitively (`useCompiledWorld.ts`,
the shared hook all of these read through for `compiled`, only reaches `world.store.ts` + the
pure `compileWorld.ts` — no engine import either) — only `useSimulationStore` does that; the seam
established in §K holds for a third feature module in a row (after `server/`, §L, itself the
second). `RackNodes.tsx` owns all chassis/frame/managed-node chrome; `AzCanvas.tsx` and
`layoutRacks.ts` only compute positions/domain-merge and aggregate edges, never render chassis
internals. `layoutAz.ts` is gone — nothing outside git history depends on `layoutAzGrid` anymore.
Unlike `server/`'s uniform "one shared `boardLayout.ts` computation, fed down as props to inert
leaves" shape (§L), the region page mixes that pattern (`AlertRibbon`/`SplitLines`) with
self-sufficient scoped views that read stores directly (`AzRow`/`CrossAzColumn`/`TimelineStrip`)
— see the file table above; a future contributor extending this page should be deliberate about
which shape a new section follows, since both currently coexist.

**Frozen-contract note:** `regionData.ts`'s `CROSS_AZ_HOP_MS = 1.5` is a **local mirror**, not an
import, of `worldEngine/networkRuntime.ts:10`'s private (non-exported) `CROSS_AZ_MS` (confirmed at
that exact line in the committed source) — the design spec's D5 named `worldEngine/latency.ts` as
the source, but that file exports only `sampleLatencyMs(p50, p99, rng)` — a function, not a
constants module; exporting the real constant would be a code change under `worldEngine/`, which
this phase's Global Constraints forbid. If the engine ever varies cross-AZ latency, this mirror
must be updated by hand (or the engine can additively export the constant, at which point the
mirror becomes a real import — additive, no reshape). Logged in
`.superpowers/sdd/contract-drift.md` §PHASE 4 item 8 as a **RESOLVED, view-side deviation from the
plan text** — no file under `src/lib/worldEngine/` was touched; this doc entry doesn't restate the
reasoning, just cross-references it.

**Blast radius:** `layoutRacks.ts` has a narrower fan-out than its skeleton draft assumed: its
`RackLayout`/`RackFrame` **types** are never imported by name anywhere (`AzCanvas.tsx` consumes
`layoutRacks()`'s return shape structurally, `RackNodes.tsx` doesn't import them at all) — the only
two files that reference this module at all are `AzCanvas.tsx` (the function) and `RackNodes.tsx`
(four pixel constants). This means a reshape of `RackLayout`/`RackFrame` is **not** caught by
`RackNodes.tsx`'s own type-checking — the two files agree on the `data` shape only via
`RackNodes.tsx`'s local `as RackFrameNodeData`/`as RackChassisNodeData` casts, so a change to what
`AzCanvas.tsx` assembles into `node.data` must be manually kept in sync with those two interfaces;
extend both additively and keep them in sync by hand. `regionData.ts`'s selector **functions**
(all seven) fan out across `RegionView.tsx` + `AzRow.tsx` + `CrossAzColumn.tsx` +
`TimelineStrip.tsx` — one more consumer than the "four region/ components" the draft assumed,
since Task 3's `TimelineStrip.tsx` also calls in (`regionEvents`). Of its exported **types**
specifically, only `AzShare` (→ `SplitLines.tsx`) and `RibbonAlert` (→ `AlertRibbon.tsx`) are
imported by name; `ReplicationPair`/`CrossAzEntry` are consumed only structurally, through
`crossAzEntries()`'s inferred return type (`CrossAzColumn.tsx`) — extend all four additively
regardless of which are named today, since a named import could be added later without warning.
`world.store.ts`'s `addManagedService` has exactly one production call site (`PlacementPanel.tsx`)
plus direct calls from two test files (`world.store.test.ts`, `costModelV2.test.ts`) — the new
param is optional/defaulted, so no existing caller needed to change. `costModelV2.ts`'s
`computeWorldCost` (§1D/§1J) gained a **second caller** this phase, `AzRow.tsx` — §1J's existing
"exactly 1 caller (`CostTab.tsx`)" blast-radius note predates this and is now stale; not corrected
there as part of this task (out of this section's scope), flagged here so the next edit to
§1D/§1J reconciles it. `AzRow.tsx`'s own call is uncached (one whole-`WorldDoc` `computeWorldCost`
walk per AZ row per render, not per region) — worth hoisting into `RegionView.tsx` if AZ counts
grow enough for it to show up in a profile, not fixed this task. ➜ RESOLVED Phase 5 Task 7 —
hoisted to RegionView.tsx, see §N.

---

### N. R3F globe + traffic authoring — Phase 5 Level-1 view (`src/app/world/globe/`, `src/app/world/panels/TrafficPanel.tsx`, 2026-07-09)

Replaces the Phase-1 placeholder `GlobeView` card grid (§1J) with a real three.js globe
(react-three-fiber): NASA night-lights earth + atmosphere shader, health-colored region pins,
teal population markers, and engine-driven great-circle traffic arcs (client/inter-region/
drain). Ships the traffic-authoring UI the world.store actions had no reader for since Phase 1
(`addPopulation`/`updatePopulation`/`removePopulation`/`updateRouting`/`updateTraffic`) via a new
`TrafficPanel.tsx` tab plus click-the-globe population placement. Built across Tasks 1–7 (spec:
`docs/superpowers/specs/2026-07-09-phase5-globe-design.md`); this task (7) is final integration —
fps probe, this section, and closing out the Phase-4 backlog (see the four carry-forward rows
below).

| File | Role |
|---|---|
| `src/app/world/globe/geo.ts` (Task 1) | Pure spherical math, no React/store reads: `latLonToVec3(lat,lon,r)`/`vec3ToLatLon(v)` (inverse, used for click-to-place) under the app's fixed convention (lat 90→+Y pole, lon 0→+Z meridian, lon 90E→+X), `greatCirclePoints(from,to,r,n)` (slerped great-circle points with an altitude bump peaking at the midpoint). Everything under `globe/` that needs spherical geometry goes through this module; nothing else in the app does its own trig |
| `src/app/world/globe/webgl.ts` (Task 3) | `webglAvailable()` — one-shot cached WebGL context-creation feature-detect. Sole gate deciding `GlobeView`'s scene-vs-`GlobeCards` branch |
| `src/app/world/globe/GlobeScene.tsx` (Task 3) | `<Canvas>` (dpr [1,2]) + night-earth sphere (T1 texture) + fresnel atmosphere shell + `OrbitControls` (no pan, clamped zoom) + idle rotation (paused on pointer-down and under reduced motion) + place-mode raycast-to-click (`vec3ToLatLon` on the hit point → `onPlace(lat,lon)`). `GlobeSceneProps { placeMode; onPlace; children }` is the seam T4/T5's layers and T6's placement wiring all mount through |
| `src/app/world/globe/RegionPins.tsx`, `PopulationMarkers.tsx` (Task 4) | Health-colored region pins (pulse on a recent failover/outage event, drei `Html` label, click→`goRegion`) and teal population markers (hover label `label · peakRps rps`, no click behavior — editing lives in `TrafficPanel`). Both read stores directly, no props |
| `src/app/world/globe/ArcsLayer.tsx` (Task 5) | `attachRenderer({level:'globe'}, onFrame)` once per `running` (T14-lesson renderer-attach discipline); rebuilds a pooled set of `THREE.Line` great-circle geometries only when the arc set's signature changes (`arcsSignature`, kind+endpoints), advances dash offset in refs every frame (never `setState`). Colors: client teal `#2DD4BF`, inter-region blue `#4A9EFF`, drain red `#EF4444` — local consts, not tokens, matching spec D6/R2's scene-chrome carve-out (arc colors have no `ColorTokens` equivalent) |
| `src/app/world/GlobeCards.tsx` (Task 3) | The pre-Phase-5 card grid, extracted verbatim from the old `GlobeView.tsx` — the WebGL-unavailable fallback AND the permanent a11y/screen-reader path (the canvas is `aria-hidden`, so a visually-hidden region-nav list is duplicated into both branches of `GlobeView.tsx`, not just this one) |
| `src/app/world/GlobeView.tsx` (Task 3, extended Task 6) | Composition root: `webglAvailable() ? <GlobeScene>{RegionPins,PopulationMarkers,ArcsLayer}</GlobeScene> : <GlobeCards/>`, plus the a11y list in both branches. **Task 6** gave it a `GlobeViewProps { placeMode; onExitPlaceMode; onPopulationPlaced }` — it does NOT own `placeMode` itself (see the Boundary rules note below on why) — and a `handlePlace(lat,lon)` that calls `addPopulation` + disarms + reports the new id up, passed as `GlobeScene`'s `onPlace` |
| `src/lib/worldEngine/index.ts` (Task 2, `buildArcs` only) | Extended (additive, no type change) to also emit `kind:'inter-region'` arcs (aggregated cross-region dependency flows, region→region, intensity by rps share) and `kind:'drain'` arcs (population's failover pending, or still routed to a `down` region during the TTL-lag window) — the pre-Phase-5 `kind:'client'` arcs stay byte-identical and first in the returned array; total capped at the existing `MAX_GLOBE_ARCS=200`, order client→inter-region→drain. One new engine-internal `Map<PopulationId, RegionId>` (prev-region-during-drain memory) — logged as the phase's one informational drift item, see the Frozen-contract note |
| `src/app/world/panels/TrafficPanel.tsx` (Task 6) | Three sections (POPULATIONS/TRAFFIC/ROUTING) writing through the pre-existing `world.store.ts` actions only (Phase 5 adds none) — see the Boundary rules note. `placeMode`/`selectedPopulationId` arrive as props, NOT read from a store — the panel is a pure controlled component over state `WorldShell.tsx` owns (see next row). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** presentation-only pass onto the shared kit (`src/app/world/ui/kit.tsx`) and `ttlLagHint` (`src/app/world/ui/derived.ts`) — every dispatch above is byte-for-byte unchanged. Each section caption became a `SectionHeader` (`▸ POPULATIONS`/`▸ TRAFFIC`/`▸ ROUTING`); population rows are now `EdgeRow`s with a small `var(--kit-teal)` signature-dot `<span>` prefixed to the unchanged six controls (label/lat/lon/rps/diurnal/remove), draft row and `+ add`/`+ place on globe` untouched. The routing-policy `<select>` became `<Segmented ariaLabel="routing-policy" options={[⚡ latency, 🌍 geo, ⚖ weighted, priority]}>` (`onChange={v => updateRouting({policy: v})}`, identical patch shape); an `Explainer` below it swaps per active policy (one of four fixed strings — see the component for verbatim text). `dnsTtlSec` became a `DerivedField` (input mode, `min={1}`, `deriveTone="warning"`, `derive={v => ttlLagHint({...doc.routing, dnsTtlSec: v}) ?? ''}`) — the derived hint line only renders while TTL < detection window, mirroring `ttl-outlives-detection`'s inequality (`capacity.ts`); `healthCheckIntervalMs`/`healthCheckFailureThreshold` keep their original `<label><span>+NumberField</span></label>` markup unchanged. Weighted/priority sub-editors are unchanged rows below the explainer. Added 2 tests (`TrafficPanel.test.tsx`: Segmented-click dispatches `policy`+ explainer text, TTL-hint appears/clears across a commit) plus mechanically updated the pre-existing weighted/geo policy-switch test's two `fireEvent.change` interactions to `fireEvent.click(screen.getByText('⚖ weighted'))` / `fireEvent.click(screen.getByText('🌍 geo'))` — every store assertion in that test is untouched, all 12 green |
| `src/app/world/panels/WorldPanel.tsx` (Task 6) | Gained a `'traffic'` tab entry and three new required props (`placeMode`/`onTogglePlaceMode`/`selectedPopulationId`), threaded straight through to `TrafficPanel` inside the existing `<fieldset disabled={running}>` — no new gating logic |
| `src/app/world/WorldShell.tsx` (Task 6) | Owns `placeMode`/`selectedPopulationId` `useState`s and threads them to both `GlobeView` and `WorldPanel` — the ONLY place they can live, since those two are siblings in `WorldShell`'s `flex` row (not parent/child), and `TrafficPanel` (a `WorldPanel` descendant) needs to toggle the same boolean `GlobeView`'s `GlobeScene` reads to arm its raycast handler. No new store — this is Zustand-free, plain lifted `useState`, per the Phase 5 constraint that no store action was added |

**Boundary rules:** `src/app/world/globe/*` imports `three`/`@react-three/fiber`/`@react-three/drei`
(Task 1 deps, no other new dependency anywhere per Global Constraints), `lib/world/types` +
`lib/world/regionGeo` + `lib/worldEngine/types` (type-only, `VisualArc`), and app stores
(`useWorldStore` read-only `doc`, `useSimulationStore` `attachRenderer`/`scrubBatch`/
`latestBatch`/`events`, `useNavStore` `goRegion`) — nothing under `globe/` imports
`worldEngine/index.ts` (the executable engine facade) directly; only `useSimulationStore` does,
continuing the seam §K/§L/§M each independently established. `TrafficPanel.tsx` writes through
`useWorldStore`'s five pre-existing population/traffic/routing actions ONLY — grep-verified no
new action was added to `world.store.ts` this phase. `GlobeView.tsx`/`WorldPanel.tsx`/
`WorldShell.tsx` together are the ONE place in the app where `placeMode` is threaded as plain
props across a sibling boundary rather than through a store — a deliberate, narrow exception
(two `useState`s, no persistence, no other reader) rather than a precedent for avoiding stores
generally elsewhere in `world/`.

**Frozen-contract note:** `VisualArc { fromLatLon; toLatLon; intensity; kind:
'client'|'inter-region'|'drain' }` (`worldEngine/types.ts`) was already frozen with all three
`kind` members before Phase 5 — `buildArcs` v2 only starts POPULATING the two kinds it previously
never emitted; no type under `worldEngine/` changed. The one informational drift item (a new
engine-internal `Map<PopulationId, RegionId>` added to `EngineState` in `worldEngine/index.ts` to
remember each population's previous region during a drain window) is logged in
`.superpowers/sdd/contract-drift.md` `## PHASE 5` as engine-internal state, not a contract change
— mirrors how Phase 4's item 8 (`CROSS_AZ_HOP_MS` local mirror) was logged as a transparency
record rather than a violation.

**Blast radius / Phase-4 backlog closed this task:** the four Phase-4-final-review backlog items
this task fixes (full text in `.superpowers/sdd/progress.md`'s `## PHASE 4 COMPLETE` "OPEN ITEMS
for Phase 5" list) — `CrossAzColumn.tsx`'s replication-list key now includes `fromAzId`/`toAzId`;
`TimelineStrip.tsx` now excludes (not clamps) events older than its 120s window;
`SplitLines.tsx`'s `DOWN_RED` and `RackNodes.tsx`'s `CHASSIS_BORDER.degraded` now route through
`var(--color-danger)`/`color-mix(in srgb, var(--color-warning) 33%, transparent)` instead of raw
hex; and **§M's own Blast-radius paragraph is hereby corrected** — its "AzRow.tsx's own call is
uncached ... not fixed this task" note is now stale, since `computeWorldCost` is hoisted to
`RegionView.tsx` (one call per region render, `monthlyUsd` passed down) as of this task. The
other three backlog categories from that same list (test-coverage gaps, cosmetic geometry nits,
the two PARKED items needing engine work) are out of Phase-5 scope and remain open.

---

### O. Analysis engine + LLM reviewer + Settings — Phase 6 final layer (`src/lib/analysis/`, `src/lib/llmReview.ts`, `src/app/world/SettingsModal.tsx`, `src/app/world/panels/AnalysisTab.tsx`/`AiReviewSection.tsx`, 2026-07-10)

The rebuild's final phase. Layer 1 is a deterministic analysis-rule engine — three families
(`structural`/`network`/`capacity`, 13 rules total across Tasks 1–3) run over `compileWorld`'s
output (+ the latest `MetricsBatch`, optional), replacing the plain `Findings` tab with a
family-grouped `Analysis` tab that merges unsuppressed compile findings and gives every affected
entity id a clickable navigation chip (Task 4). Layer 2 is an on-demand LLM architecture review
against any OpenAI-compatible endpoint, schema-validated and retried once on a malformed reply
(Task 6), transported through a new Rust command since a webview `fetch` to arbitrary hosts dies
on CORS (Task 5), rendered as AI-tagged cards beside the deterministic findings (Task 8). A new
global Settings modal (⚙, Task 7) is the first UI ever to expose the app's already-wired
dark/light theme toggle, plus the LLM endpoint configuration. Spec:
`docs/superpowers/specs/2026-07-10-phase6-analysis-llm-design.md`.

| File | Role |
|---|---|
| `src/lib/analysis/types.ts` (Task 1) | `AnalysisFinding`/`AnalysisRule`/`AnalysisInput`/`AnalysisFamily`/`AnalysisSeverity` — the shape every rule file and `runAnalysis.ts` share. `id` is `` `${ruleId}:${primaryAffectedId}` `` (or `` `${ruleId}:world` `` when `affected` is empty), stable across runs — never derived from array position |
| `src/lib/analysis/runAnalysis.ts` (Task 1, appended Tasks 2–3) | `ANALYSIS_RULES: AnalysisRule[]` — ONE registry; `structural.ts`/`network.ts`/`capacity.ts` each export their rule objects and are spread into this same array, never executed through a separate path (same "one array, no special-casing" convention the deleted §1C structural linter established and this phase inherits). `runAnalysis(doc, compiled, lastBatch)` builds one `AnalysisInput`, concatenates every rule's findings, and sorts by severity (critical→warning→info) then family (structural→network→capacity) then `ruleId` — a stable composite-key sort |
| `src/lib/analysis/rules/structural.ts` (Task 1, 6 rules) | `single-az-region`, `no-failover-region`, `replicas-colocated`, `dependency-cycle`, `deep-sync-chain`, `unused-managed-service` — read `compiled.instances`/`compiled.routing.populationRegionOrder`/`doc.blueprints` only |
| `src/lib/analysis/rules/network.ts` (Task 2, 3 rules) | `blocked-dependency-path` (id embeds the compiled path id so the Analysis tab can suppress the raw compile-side duplicate, D4), `db-port-exposed`, `entry-unreachable` — replicate a source-aware firewall first-match-wins loop rather than importing `src/lib/world/network.ts`'s `evaluateFirewall` (that helper ignores `source` by design, Phase-1 scope; documented in-file, `network.ts` itself is untouched) |
| `src/lib/analysis/rules/capacity.ts` (Task 3, 4 rules) | `ram-oversubscribed`, `burstable-sustained-load` (silent without `lastBatch`), `ocean-crossing-population` (imports `REGION_GEO`/`greatCircleKm` from `src/lib/world/regionGeo.ts` — the SAME distance source `routing.ts` already uses; no second haversine implementation), `ttl-outlives-detection` (`affected: []`, world-scoped id) |
| `src/lib/analysis/__fixtures__/worlds.ts` (Task 1, extended Tasks 2–3) | Shared doc-builder fixtures for rule tests, in the same "small local factory functions, no cross-file test imports" style every `worldEngine/*.test.ts` file already uses (§K) |
| `src/lib/llmReview.ts` (Task 6) | Pure, mock-`chat`-testable: `buildReviewContext(doc, compiled, findings, lastBatch)` (JSON string — world doc + deterministic/compile finding summaries + aggregated region/AZ metrics; NEVER instance-level maps, NEVER any settings value), `validateReviewResponse(raw)` (hand-rolled schema check + clamping, no new deps), `requestReview(settings, context, chat?)` (builds the chat request, retries ONCE on a malformed reply), `pingLlm(settings, chat?)`. `chat` defaults to `src/lib/tauri.ts`'s `llmChat` wrapper, injectable for tests |
| `src/app/world/panels/AnalysisTab.tsx` (Task 4, mounts `AiReviewSection` Task 8) | Replaces the old inline `Findings` tab body. `useMemo(runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])` where `displayBatch = scrubBatch ?? latestBatch`; renders `structural`/`network`/`capacity` sections (non-empty only) then an unsuppressed-compile section. Exports `navigateToEntity(id, doc, compiled, nav)` (regionId→`goRegion`, azId→`goAz`, serverId→`goServer`, instanceId→its server's interior, else no-op) and `unsuppressedCompileFindings(analysis, compile)` (strips the `` `finding-` `` prefix off a compile id and checks it against the analysis id set) — both are the ONE place either kind of suppression/navigation logic lives; `WorldPanel.tsx`'s tab-count label calls the same `unsuppressedCompileFindings`, not a second computation. **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** the three family headers and the Compile header became `SectionHeader`s (`▸ STRUCTURAL`/`▸ NETWORK`/`▸ CAPACITY`/`▸ COMPILE`, replacing the plain `sectionLabel` div text `Structural`/`Network`/`Capacity`/`Compile`) — severity chips, `AffectedChips`, and the mounted `AiReviewSection` are untouched. Mechanically updated `AnalysisTab.test.tsx`'s one header-text assertion (`getByText('Structural')` → `getByText('▸ STRUCTURAL')`); every finding-text/navigation assertion in that file is byte-for-byte unchanged |
| `src/app/world/panels/WorldPanel.tsx` (Task 4 tab rename, Task 8 threads `openSettings`) | `Tab` union's `'findings'` → `'analysis'`; label `` `Analysis (${n})` `` where `n` = analysis findings + unsuppressed compile findings (via the same helper above). Gained an `openSettings: () => void` prop in Task 8, threaded straight to `AnalysisTab` → `AiReviewSection` — a plain prop chain, not a store (see Boundary rules). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** the tab strip's inline `smallBtn`-style buttons became token-styled `type="button"` tabs (`5px 10px` padding, transparent background/border, `2px solid transparent` bottom border; active = `2px solid var(--color-accent)` bottom border + `--color-text-primary` text). The Analysis label split from `` `Analysis (${n})` `` into a plain `Analysis` text node plus a sibling `<ChipValue>{n}</ChipValue>` (kit component, `src/app/world/ui/kit.tsx`) — renders even when `n === 0`, since the chip is gated on `t.id === 'analysis'`, not on the count. Mechanically updated `WorldPanel.test.tsx`'s two `getByText(/Analysis \(\d+\)/)` clicks to `getByText('Analysis')` (works because RTL's default text matcher only reads an element's own direct text-node children, so the sibling `ChipValue` span's digit doesn't merge into the button's matched text) and added a third test asserting the chip-plus-click behavior; `running`/`fieldset`/every other prop untouched. **2026-07-10 (Polish 1 Task 6 — examples vault):** the local `type Tab` union was deleted and replaced by an import of `PanelTab` from `ui.store.ts` (§P) — a view→store type import, the correct direction since the vault's `openExample` (in `HomeScreen.tsx`, §P) needs the same union to call `setPendingPanelTab`. `useState<PanelTab>` now initializes from `useUiStore.getState().pendingPanelTab ?? 'topology'` (read once, in the initializer — not a subscribed value, so a later store update never re-triggers this `useState` call) and a `useEffect(() => {...}, [])` clears the pending value back to `null` right after mount if one was set, so a later remount never re-applies a stale request. Every other prop/dispatch in this file is unchanged |
| `src/app/world/panels/AiReviewSection.tsx` (Task 8) | `unconfigured`/`idle`/`in-flight`/`done`/`error` states. Violet AI chip uses `CATEGORY_COLORS.messaging.accent` (`theme.ts`) — a local hex const for this color is forbidden (Global Constraints; `theme.ts` already carries the exact violet, no new token needed); its text is `var(--color-on-accent)` (T9), not a hardcoded `#fff`. Review click calls `buildReviewContext` + `requestReview`; cards reuse `AnalysisTab`'s `navigateToEntity` for affected chips. Mounted at the top of `AnalysisTab` |
| `src/app/world/SettingsModal.tsx` (Task 7) | Portal overlay (`createPortal`, `position:fixed` backdrop, token-styled). Two sections: **Appearance** (`dark`\|`light` segmented control over `useUiStore(s=>s.themeMode)`/`setThemeMode` — no new plumbing, `App.tsx`'s `useThemeBootstrap` already applies the effect live) and **AI Review** (`baseUrl`/`apiKey type=password`/`model`, `Save`→`saveLlmSettings`, `Test connection`→`pingLlm`). The active segment's text is `var(--color-on-accent)` (T9), not a hardcoded `#fff`. Registers its OWN capture-phase `window` `keydown` listener for Escape (`stopPropagation`+`preventDefault`+`onClose`) so `WorldShell.tsx`'s bubble-phase nav-Escape handler bails — same mechanism Phase 3's inspector (§L) established for exactly this kind of overlay-vs-nav-shell conflict. **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** the two section captions became `SectionHeader`s (`▸ APPEARANCE`/`▸ AI REVIEW`, replacing the local `sectionLabelStyle` div text `Appearance`/`AI Review`); the hand-rolled two-button `aria-pressed` group became kit `Segmented` (`ariaLabel="theme"`, options `dark`/`light`, `onChange={setThemeMode}` — identical dispatch). `Segmented` preserves both `aria-pressed` and the button's own text, so `SettingsModal.test.tsx` needed NO changes at all (`getByText('dark')`/`getByText('light')` + `aria-pressed` assertions still resolve against the new component). Field inputs (`baseUrl`/`apiKey`/`model`) adopted the kit field look (`--color-node-base`/`--color-node-border`, 4px radius, `4px 6px` padding) — same aria-labels/values. D6 invariants untouched: the password input, masked `•••• <last4>` placeholder, and no-key-echo behavior were not touched by this pass |
| `src/app/world/WorldShell.tsx` (Task 7) | Gained a ⚙ ghost button (first child of the header's right-side button cluster) + local `settingsOpen` state + `<SettingsModal open onClose>`; the `openSettings` prop threaded to `WorldPanel` in Task 8 is `() => setSettingsOpen(true)` — the SAME state the gear opens |
| `src/lib/tauri.ts` / `src/lib/tauriMock.ts` (Task 5) | `LlmSettings { baseUrl; apiKey; model }` + `saveLlmSettings`/`loadLlmSettings`/`llmChat` wrappers (explicit snake↔camel field mapping to/from the Rust struct — Tauri v2 camelCases command ARG names but not struct fields, verified against the existing `commands.rs` conventions). The mock mirrors settings to `localStorage` and does a direct `fetch()` for `llm_chat` (fine for local stubs/Ollama/LM Studio, where the user controls CORS). This is the ONE seam §G's own note on these two files already flagged for a future LLM-transport write-up — §O is that write-up; §G's paragraph stays as the Rust-file inventory (`save_llm_settings`/`load_llm_settings`/`llm_chat` in `commands.rs`, next row), this table owns the TS-wrapper boundary, and neither duplicates the other |
| `src-tauri/src/commands.rs` (Task 5) | `save_llm_settings`/`load_llm_settings` (mirrors the existing `recent_files.json` app-data-dir pattern exactly) + `llm_chat` (async, `reqwest` POST, 60s timeout, returns the raw response body text for ANY HTTP status so the frontend can read an OpenAI-style error envelope itself) + `redact(msg, key)` (pure, unit-tested — masks every occurrence of the key, short keys masked entirely) |
| `scripts/llm-stub.mjs` (Task 8) | ~40-line stdlib-`http` OpenAI-compatible stub for the live smoke: CORS-enabled `POST /v1/chat/completions`, first hit returns malformed content (proves the retry live), every later hit returns a canned valid review |

**Boundary rules:** `src/lib/analysis/*` imports ONLY `src/lib/world/types` and
`src/lib/worldEngine/types` (types-only — never the executable `worldEngine/index.ts` facade,
never any `app/` store, never React) — every rule file is plain, node-env-testable logic, exactly
like the deleted §1C linter and the live `worldEngine/` subsystems (§K) before it. `llmReview.ts`
imports only `src/lib/tauri.ts`'s wrappers (`llmChat`, `LlmSettings`) — never calls Tauri's
`invoke` itself, never imports `tauriMock.ts` directly (that split is `tauri.ts`'s own concern, an
existing pattern this phase didn't change). `AnalysisTab.tsx`/`AiReviewSection.tsx` are the ONE
place either the analysis findings or the AI review reach the DOM — both compose `runAnalysis`,
`navigateToEntity`, and (for AI) `buildReviewContext`/`requestReview`, rather than any other file
duplicating that wiring. `SettingsModal.tsx` NEVER imports `world.store.ts` or `serializer.ts` —
by construction, not convention: LLM settings are not world-document state and must never become
reachable from a save/serialize path.

**D6 key-security invariants (restated, non-negotiable — every one of these has a dedicated
test):** the API key is never serialized into `.scalemap` (enforced by `SettingsModal.tsx` never
importing `world.store`/`serializer.ts` at all — there is no code path for it to reach either);
never logged or `console.*`'d on either side; never included in `buildReviewContext`'s payload
(canary-string-tested); redacted (`commands.rs`'s `redact()`) from every error string the Rust
transport can produce; rendered only masked (`•••• <last4>`) in the Settings modal after a key has
been saved, and the masked placeholder is never echoed back into the input's live `value` (typing
a NEW value is the only way to overwrite a saved key — leaving the field empty on Save keeps the
existing one); the API key input is `type="password"`. Any task whose test suite can assert one of
these, does.

**The `openSettings` prop chain** (`WorldShell` → `WorldPanel` → `AnalysisTab` →
`AiReviewSection`) is this phase's one plain-prop thread across what would otherwise be a store
boundary — the same narrow, deliberate exception class §N's `placeMode` thread already
established (two components down a fixed hierarchy needing to share one boolean/callback that a
common ancestor owns), not a precedent for skipping stores generally elsewhere in `world/`.

**Carry-forwards closed this task (closing out Phase 5's backlog, `.superpowers/sdd/progress.md`
`## PHASE 5 COMPLETE`'s "OPEN ITEMS for Phase 6" list — see §N's own note above for the Phase-4
backlog, closed by Phase 5):** `worldEngine/index.ts:43`'s `MAX_GLOBE_ARCS` is now `export const`
(the ONE sanctioned `worldEngine/` edit this phase) and `ArcsLayer.tsx` imports it from the
engine facade instead of hand-duplicating the literal; a new `src/lib/world/populationLabel.ts`
(pure, `nextPopulationLabel(populations)` — scans existing `pop-N` labels for the max suffix) is
shared by `TrafficPanel.tsx`'s "+ add" and `GlobeView.tsx`'s place-on-globe handler, so the two
authoring surfaces can no longer reissue the same default label after a remove+re-add;
`GlobeScene.tsx`'s texture wrap/offset mutation moved from a `useMemo` (a memoized-derivation
hook being used for a side effect) to `useLayoutEffect` (the conventional home for a synchronous
pre-paint side effect), same body, same `texture.needsUpdate=true` flag; `globeArcs.test.ts`
gained a test for `buildDrainArcs`'s `?? [pop.lat,pop.lon]` fallback (a previous-region catalogId
missing from `REGION_GEO`), the one named gap Phase 5's final review left explicitly untested —
reaching it required routing the fixture's population onto the geo-less region via a `'weighted'`
policy pinning the OTHER region's weight to 0 rather than `'priority'`/`'geo'`/`'latency'`, since
`routing.ts`'s `distanceScore` falls back to `Number.MAX_SAFE_INTEGER` for a region missing a
`REGION_GEO` entry and that dominates every scoring formula except `weighted`'s (empirically
confirmed against this repo's current `routing.ts`, not merely assumed). The other three Phase-5
backlog items (`NumberField` no external re-sync on undo/redo, `PopulationMarkers`' aspirational
"matches theme teal" comment, `health_check_failed`'s no-pulse tradeoff) are cosmetic/documented-
tradeoff and remain open — not part of this phase's scope.

**On-accent theme token (folded in from Task 7's review):** `theme.ts`'s `ColorTokens` gained
`onAccent` (`#FFFFFF` in both `DARK_COLORS` and `LIGHT_COLORS` — white always reads on a
saturated accent/danger/warning chip background in either theme), auto-emitted as
`--color-on-accent` by `App.tsx`'s `useThemeBootstrap` the same way every other token is, and
mirrored in `index.css`'s static `:root` fallback block. `SettingsModal.tsx`'s active segment,
`AnalysisTab.tsx`'s `sevChip`, and `AiReviewSection.tsx`'s AI chip — the three places a hardcoded
`color: '#fff'` had drifted from the token system before the theme was live — now read
`var(--color-on-accent)` instead; no other hardcoded hex remained in those three files.

**This is the rebuild's final phase.** With Task 9's docs landing, all six phases (world model +
navigation shell, substrate simulation engine, server interior board, region flow page + rack
chassis, R3F globe + traffic authoring, analysis engine + LLM reviewer + settings) are complete;
see `.superpowers/sdd/progress.md`'s `## PHASE 6 COMPLETE` entry for the closing summary and the
umbrella-spec §9 parked list of intentionally-unscoped future work.

---

### P. Hybrid UI kit, examples vault & session reset (`src/app/world/ui/` Polish 1 Task 1, `src/lib/vault/exampleWorlds.ts` Task 5, `src/app/home/` Task 6, `simulation.store.ts`'s `resetSession` Task 7, 2026-07-10)

Three unrelated-but-same-phase additions share this letter because none earned a standalone
section: a shared presentation kit every panel restyle (Tasks 2-4) sits on top of (Task 1); four
prebuilt example worlds on the home screen (Tasks 5-6); and the doc-swap session-reset fix that
keeps the replay scrubber honest after New/Open (Task 7, full detail lives on `simulation.store.ts`'s
and `ScrubberV2.tsx`'s own rows in §K/§J — this section only points at it).

**The kit (Task 1):** `src/app/world/ui/kit.tsx` + `derived.ts` are the shared instrument-skin
components and derived-consequence math every Polish 1 panel restyle (`TopologyPanel`,
`BlueprintPanel`, `PlacementPanel`, `TrafficPanel`, `WorldPanel`, `AnalysisTab`, `SettingsModal`)
and the server-view rail (`InspectorRail.tsx`) build on. Import rule: panels import the kit; the
kit imports NOTHING from panels — `kit.tsx`'s only import is `react` (`useEffect`/`useState`/
`CSSProperties`/`ReactNode`, grep-verified). The vault's four prebuilt worlds (Task 5) are pure
data, read-only for Task 6's card UI; the home-screen open sequence and the one-shot "land on the
Analysis tab" plumbing are Task 6's.

| File | Role |
|---|---|
| `src/app/world/ui/kit.tsx` (Task 1, new) | Nine components: `SectionHeader`, `EdgeRow`, `ChipValue`, `SpecBar`, `MicroBars`, `DerivedField`, `Segmented`, `PresetCardGrid`, `Explainer`. Houses the app's only sanctioned raw hex literals outside the globe/board scene constants (§K/§L) and the vault card's decorative glyph teal/violet (below) — the brief's "two sanctioned glow hexes" are `KIT_GLOW_TEXT` (`#7CFFE9`, `SectionHeader`'s default label color/text-shadow) and `KIT_GLOW_DIM` (`#2DD4BF44`, the alpha-glow gradient beside it); a third, non-glow solid accent `KIT_TEAL` (`#2DD4BF`, `MicroBars`'/`EdgeRow`'s teal dot/bar) lives alongside them. Each of the three has a light-theme counterpart (`KIT_GLOW_TEXT_LIGHT`/`KIT_GLOW_DIM_LIGHT`/`KIT_TEAL_LIGHT`) — six literals total, injected once via a `document.getElementById('scalemap-kit-styles')`-guarded `<style>` tag as `--kit-accent`/`--kit-accent-dim`/`--kit-teal` custom properties (dark under `:root`, light under `:root[data-theme="light"]` — the same theme-swap shape as `App.tsx`'s `useThemeBootstrap`, but scoped to the kit's own three tokens rather than `theme.ts`'s `ColorTokens`). Every component reads `var(--kit-*)`, never the six constants directly — that's the enforcement mechanism, there's no lint rule. Fan-in (8 files, grep-verified): `TopologyPanel.tsx` (FIVE components — `SectionHeader`/`EdgeRow`/`ChipValue`/`MicroBars`/`PresetCardGrid` — across its Task 2 restyle, not all nine), `BlueprintPanel.tsx`/`PlacementPanel.tsx` (`SectionHeader`/`EdgeRow`/`DerivedField`/`Segmented`), `TrafficPanel.tsx` (`SectionHeader`/`EdgeRow`/`Segmented`/`DerivedField`/`Explainer`), `WorldPanel.tsx` (`ChipValue` only, for the Analysis tab count), `AnalysisTab.tsx`/`SettingsModal.tsx` (`SectionHeader`, `SettingsModal.tsx` also `Segmented`), and `server/InspectorRail.tsx` (`SectionHeader`, **2026-07-10 (final-review fix wave)** also `KIT_GLOW_TEXT` — the one server-view consumer, proof the kit isn't panel-scoped despite the directory living under `src/app/world/ui/` rather than `src/app/world/panels/`). `SpecBar` has ZERO consumers outside `kit.test.tsx` as of this writing — built to the design contract but not yet wired into any panel or view; don't read its presence in the export list as evidence a consumer exists. `kit.test.tsx` covers all nine exports. **2026-07-10 (Task 8):** two previously-untested branches got cases — `EdgeRow`'s `edgeColor` prop (asserted via the rendered row's `style.borderLeft`/`style.background`, both set only when `edgeColor` is passed) and `SectionHeader`'s custom `accent` hex (asserted onto the label span's `style.color`, overriding the `var(--kit-accent)` default). **2026-07-10 (final-review fix wave):** `KIT_GLOW_TEXT` (the dark `#7CFFE9` constant, one-line-commented as the scene-surface accent for always-dark mounts) is now EXPORTED — the sole exception to "consumers use `var(--kit-*)`, never the constants" — because `server/InspectorRail.tsx` keeps a hardcoded dark scene background regardless of app theme and can't ride `SectionHeader`'s theme-swapping `--kit-accent` default, which flips to the light-theme teal under `data-theme="light"` and reads at ~3.4:1 there; no other file may touch the hex. `DerivedField`'s slider mode gained an `interacted` ref set only by the range input's `onChange` and cleared on every successful `commitSlider` and on every external `value`-prop resync — `commitSlider` (fired by `onMouseUp`/`onTouchEnd`/`onKeyUp`/`onBlur`) now returns early unless the flag is set, so tabbing into/through a slider whose stored `value` sits outside `[min,max]` (legally reachable via `inspectorForms`' `WorkloadForm`, which only floor-clamps to ≥0) no longer dispatches an unsolicited clamped commit + undo/redo history entry from pure focus traversal. The injected stylesheet also gained a tokenized `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }` rule (no `:focus-visible` rule existed anywhere in `src` before this — needed because `TopologyPanel.tsx`'s `unstyledButton` (`all: 'unset'`) strips the browser's native ring on the preset-toggle button) and `.kit-pcard:hover` picked up the mockup's glow (`box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 27%, transparent), 0 6px 18px rgba(0,0,0,0.31)`) alongside its pre-existing border-color change |
| `src/app/world/ui/derived.ts` (Task 1, new) | Pure derived-consequence math the kit's `DerivedField` instances render — no store imports, no React (per the file's own header comment). `rpsPerCore`/`hostRpsCapacity` (workload cpu-ms → sustained rps — `BlueprintPanel.tsx`'s cpu slider), `ramAtConnections` (base + per-conn × 2,000 conns — `BlueprintPanel.tsx`'s ram/conn field), `residentRamDemandMb` (thin wrapper, below), `ttlLagHint` (`TrafficPanel.tsx`'s TTL field — `null` once `dnsTtlSec*1000 >= healthCheckIntervalMs*healthCheckFailureThreshold`, mirroring `ttl-outlives-detection`'s inequality in `lib/analysis/rules/capacity.ts`), `diskIoWord` (light/moderate/heavy banding). `residentRamDemandMb` does NOT reimplement the reserved-RAM sum — it calls `reservedRamMb`, exported from `lib/analysis/rules/capacity.ts` (that file's own header comment cross-references this one both ways), so the panel-kit's derived hint and the `ram-oversubscribed` analysis rule can never drift onto two different definitions of "reserved RAM." SIX exports total (`rpsPerCore`/`hostRpsCapacity`/`ramAtConnections`/`residentRamDemandMb`/`ttlLagHint`/`diskIoWord`), all covered by `derived.test.ts` |
| `src/lib/vault/exampleWorlds.ts` (Task 5) | `VaultEntry { id, name, blurb, tags, difficulty, build }` + `VAULT: VaultEntry[]`, four entries: `three-tier`/`multi-region-failover`/`event-driven` (clean — compile to zero compile+analysis findings, enforced by `exampleWorlds.test.ts`) and `broken-teaching` (trips ≥10 analysis findings across all three families on purpose — exposed db, single-AZ SPOF, oversubscribed RAM, a blocked cache dependency, TTL slower than failover detection). Pure data — imports only `world/factories.ts`, `world/instanceCatalog.ts`, and type-only imports (`WorldDoc`/`Server`/`ServiceBlueprint`/`FirewallRule`) from `world/types.ts`, same doc-builder-helper idiom as `src/lib/analysis/__fixtures__/worlds.ts` (§O). Not owned by this task; treat as a frozen data source unless a future task explicitly revisits it |
| `src/app/home/VaultCard.tsx` (Task 6, new) | One card: `<button data-teaching={entry.difficulty === 'teaching' \|\| undefined}>` rendering a decorative glyph, name, blurb, tag pills, and a difficulty pill, `onClick={() => onOpen(entry)}`. `GLYPHS: Record<VaultEntry['id'], ReactElement>` transcribes the mockup's four `<svg class="vg" viewBox="0 0 200 64">` blocks 1:1 (`docs/superpowers/specs/mockups/panels-hybrid-v1.html`'s vault section) — strokes map to tokens (`#4A9EFF`→`--color-accent`, `#EF4444`→`--color-danger`, `#2A2E38`→`--color-node-border`, `#F59E0B`→`--color-warning`) except two decorative-only teal/violet strokes (`#2DD4BF`/`#A78BFA`) kept as local hex constants `GLYPH_TEAL`/`GLYPH_VIOLET` — same stance as the globe/board scene hexes (§K/§L): art that never appears as UI chrome doesn't need a token. Difficulty-pill color is a per-difficulty inline-style map (`beginner`→`--color-success-text` + a `color-mix(...--color-success 27%...)` border override, `intermediate`→`--color-warning` + the same `color-mix` border tint at `--color-warning`, `teaching`→`--color-danger` + the same tint at `--color-danger` — **2026-07-10 (final-review fix wave)** added the intermediate/teaching border tints; beginner's was already present); imports its CSS classes from `HomeScreen.module.css` rather than owning a module of its own (no `VaultCard.module.css`) |
| `src/app/home/HomeScreen.tsx` | Gained a vault section between `.actions` and the recents list: `VAULT.map(e => <VaultCard key={e.id} entry={e} onOpen={openExample} />)`. `openExample(entry)` mirrors `openNew`'s stance exactly but explicitly, since `replaceWorld` (unlike `newWorld`) does NOT reset the file store: `useWorldStore.getState().replaceWorld(entry.build())` → `setFilePath(null)` → `setDirty(false)` → `setCreatedIso(null)` → (teaching card only) `useUiStore.getState().setPendingPanelTab('analysis')` → `useNavStore.getState().goGlobe()` → `setShowHome(false)`. The pending-tab set happens BEFORE `setShowHome(false)` so `WorldShell`/`WorldPanel` never mount with a stale value. Every other card leaves `pendingPanelTab` untouched (stays `null`) |
| `src/app/home/HomeScreen.module.css` | The legacy `.vault`/`.vaultHeader`/`.vaultCount`/`.vaultGrid`/`.templateCard`/`.template*` block (the deleted canvas app's template grid, verified zero consumers) was deleted outright and replaced with the mockup's card recipe under the same section banner: `.vaultSection`, `.vaultHeader` (the existing eyebrow-caps recipe, reused verbatim), `.vaultGrid` (`repeat(auto-fit, minmax(220px, 1fr))`, gap 12), `.vcard` (gradient `--color-node-base`→`--color-canvas`, 1px `--color-node-border`, radius 10, padding 14; hover border a `color-mix(...--color-text-muted 35%...)` tint + `translateY(-2px)` + shadow; `[data-teaching]` gets a `color-mix(...--color-danger 20%...)` border instead), `.vg`/`.vn`/`.vd`/`.vm`/`.vpill` (glyph/name/desc/meta-row/pill sizing straight off the mockup's px values). `@media (prefers-reduced-motion: reduce)` kills `.vcard`'s transition and hover transform, leaving the border/shadow hover cues intact |
| `src/app/store/ui.store.ts` (Task 6) | `pendingPanelTab`/`setPendingPanelTab` — see §2's `ui.store.ts` row for the full note. `PanelTab` now lives here (moved out of `WorldPanel.tsx`'s local `type Tab`) since both a store consumer (`WorldPanel.tsx`) and a store producer (`HomeScreen.tsx`) need the same union |
| `src/app/world/panels/WorldPanel.tsx` (Task 6) | Consumes `pendingPanelTab` once on mount — see §O's `WorldPanel.tsx` row for the full note |
| `src/app/store/simulation.store.ts`'s `resetSession` (Task 7) | See §K's `simulation.store.ts` row for the full note. The ONLY doc-swap reset path — `world.store.ts`'s `newWorld()`/`replaceWorld()` (§J) call it in place of the plain `stop()` they used to call. `stop()` itself is unchanged and remains what `SimControls.tsx`'s user-facing Stop button calls — a manual stop should still leave a scrubbable replay ring behind it; a doc swap discards the world those ids belong to, so the session state has to reset wholesale instead |
| `src/app/world/ScrubberV2.tsx`'s latestBatch gate (Task 7) | See §J's `ScrubberV2.tsx` row for the full note. The render gate's new third leg (`latestBatch === null`) is what makes `resetSession` actually hide the scrubber after New/Open — the engine's replay ring survives a plain `stop()` by design and `resetSession` doesn't proactively clear it either, so `frames.length` alone would stay stale-nonzero for one render after a doc swap; `latestBatch` is reset by both `start()` and `resetSession()`, so it's the reliable "this session hasn't produced a frame since the last reset" signal |

**Why `replaceWorld` needed explicit resets instead of a store-level fix:** `newWorld()` (used by
`openNew`) already resets `dirty`/`createdIso` internally because a "New World" click always means
"fully pristine." `replaceWorld()` (used by both the vault and `fileOps.ts`'s file-open path) does
NOT — `fileOps.ts`'s `openWorldFromPath` deliberately wants `markSaved(path)` afterward (a loaded
file is NOT dirty and DOES have a path), so baking a pristine-reset into `replaceWorld` itself
would break that caller. The vault's `openExample` is the one `replaceWorld` caller that wants the
`newWorld`-like pristine state, so it does the three resets explicitly rather than the store
picking one stance for every `replaceWorld` caller.

---

### Q. Polish 2: command overlays, guided console, motion (`src/app/world/ui/` Tasks 1/3/4/8, `src/app/world/globe/` Task 3, `src/app/world/panels/` Tasks 5/7, `src/app/world/server/ruleSentence.ts` Task 6, `src/app/world/AzCanvas.tsx`/`WorldShell.tsx`/`SimControls.tsx` Task 7, 2026-07-10)

Seven tasks land as one phase: a shared kit motion grammar + a hold-to-enter drill primitive
(Task 1); in-scene "command overlay" cards for region pins and population markers, portaled
outside the globe canvas's `aria-hidden` wrapper for accessibility (Tasks 3-4); a world-summary
strip and a traffic-hero sentence-slider giving the panel dock a "guided console" read (Task 5);
plain-words re-voicing of topology health and firewall rules (Task 6, already folded into §J/§L —
see the `InspectorRail.tsx`/`ruleSentence.ts` rows there, not repeated here); and this task's
app-wide motion APPLICATION pass — tab ink, button-press states, health ripples, AZ-canvas flow
shimmer (Task 7/8). One governing rule ties Tasks 3-5 together and is worth stating once, in one
place, rather than per-file: **every relocated or newly-surfaced control (region role toggle,
outage kill switch, population demand slider, "traffic panel →" jump, remove) reuses an existing
world/nav/simulation-store dispatch byte-for-byte** — `updateRouting`/`setOutage`/
`updatePopulation`/`removePopulation`/`setPendingPanelTab`/`goRegion`, all pre-existing. The
**only** new store surface across the whole phase is `ui.store.ts`'s `sceneOverlay` field (below)
— no new dispatch was invented to make an overlay or a hero slider work.

**Kit motion grammar (Task 1):** `src/app/world/ui/kit.tsx`'s injected stylesheet (§P's kit.tsx
row) gained four classes, all inside the existing `@media (prefers-reduced-motion: reduce)`
block (`kit.test.tsx`'s "kit motion grammar" describe locks both the classes' presence and their
reduced-motion membership): `.kit-press` (border-color/transform/box-shadow transition, a
`--kit-accent` hover glow, `scale(0.96)` on `:active` — the button-press feedback every clickable
surface in Tasks 1-8 uses), `.kit-ripple`/`.kit-ripple::after` (a `currentColor` circle scaling
1→3.2 and fading over 1.6s, `infinite` — the "this is live" cue for health dots; consumers set
`color` alongside the class so `currentColor` resolves per-status, never a hardcoded hex), and
`.kit-ink` (`position: absolute; bottom: 0` by default, `left`/`width` `transition`ing on a
cubic-bezier — the sliding tab underline). `.kit-t`'s existing `transition: all 0.15s ease`
(pre-Polish-2) is reused, not reinvented, wherever a hover-only transition suffices.

**Hold-to-enter (Task 1):** `src/app/world/ui/HoldToEnter.tsx` — `holdProgress(nowMs, startMs,
durationMs=HOLD_DURATION_MS)` (pure 0..1 clamp) and `HoldRing` (a screen-space SVG ring driven by
a `progressRef` mutated per r3f frame — DOM writes only, never `setState` per frame, the
established T14/D5 lesson for particle-frequency data). `HOLD_TAP_MS` (250) and
`isAbortedHold(pressedMs)` classify a released press: shorter than the threshold = a plain tap
(falls through to the click handler); at or past it but before `HOLD_DURATION_MS` (700) completes
= an aborted hold, whose synthetic click must be swallowed (spec D1 — early release means no
navigation, no overlay-close-then-reopen flicker). The ring's SWEEP stays live under
prefers-reduced-motion (it's functional progress feedback, not decoration); only its glow
(`drop-shadow`) is trimmed. Sole consumer today: `src/app/world/globe/RegionPins.tsx`'s
`RegionPin` — `onPointerDown` starts `holdStartRef`, a `useFrame` callback advances
`holdProgressRef` and calls `goRegion(regionId)` (existing nav dispatch) at completion,
`onPointerUp`/`onPointerOut` cancel or mark-aborted via a self-expiring `swallowClickUntilRef`
window so a stale swallow can never eat a later genuine tap. Final-review fix wave (401073c):
because r3f pointer capture keeps the pin in every hit list, `onPointerOut` never fires
mid-hold — D1's "leaving cancels" is enforced by `HOLD_SLOP_PX` (12) / `exceedsHoldSlop`
pointer-movement slop in `onPointerMove` (rotation drift moves the pin, not the pointer, and
correctly does not cancel); the same wave added GlobeView's stale-`sceneOverlay` clear when the
open entity is deleted from the dock, the empty-firewall `FirewallEditor` mount in
InspectorRail (`rules.length === 0`), and `useRollingNumber`'s `durationMs <= 0` snap guard.
Reusable beyond the globe (region →
AZ → server hold-drills are a parked follow-up, not built).

**Scene overlays (Tasks 3-4):** `src/app/world/ui/SceneOverlay.tsx` is the shared card shell
(the mockup's `.ovl`, tokenized) — title/health-or-`dotColor` header dot, children body, footer
action row, `esc` close button (`kit-press`). **Task 7 addition:** an additive `ripple?: boolean`
prop — when true the header dot gains `.kit-ripple` and `color: <the dot's own color>` so the
ripple's `currentColor` resolves correctly; omitted entirely (`undefined`) means no ripple, so
every pre-Task-7 call site is unaffected. `src/app/world/globe/overlayPortal.ts` exports
`OverlayPortalContext`, a `RefObject<HTMLDivElement> | null` context — the globe canvas wrapper is
`aria-hidden` (decorative; `GlobeView.tsx` renders a separate visually-hidden a11y region list as
the REAL keyboard/screen-reader navigation surface), so an overlay's interactive DOM (buttons,
sliders) must portal OUTSIDE that wrapper to stay reachable; `GlobeView.tsx` provides the ref
target (a plain absolutely-positioned div sibling to the canvas), `RegionPins.tsx`/
`PopulationMarkers.tsx` consume it via `<Html portal={overlayPortal ?? undefined}>`. Content
components: `src/app/world/ui/overlays/RegionOverlay.tsx` (chips for AZ/server counts, live rps
via `useRollingNumber`, p50, $/hr; a `Segmented` role toggle that writes `useWorldStore.setState`
directly — copied verbatim from `TopologyPanel.tsx`'s own no-history-push role toggle, same
deliberate bypass; a `kill`/`restore` button wired to the existing `setOutage` dispatch, disabled
while stopped; **Task 7:** passes `ripple={running}` to `SceneOverlay`, `running` already in
scope for the kill button's `disabled` prop) and `src/app/world/ui/overlays/PopulationOverlay.tsx`
(a demand slider transcribing `DerivedField`'s commit-on-release discipline locally since the
overlay needs `step=50`, which `DerivedField` doesn't parameterize; "traffic panel →" calls the
pre-existing `setPendingPanelTab('traffic')`; "remove" calls the pre-existing
`removePopulation`). Both overlays read `populationLanding`/`isEntryBlueprint`-adjacent derived
math from `../derived` (below), never duplicate it. **SpecBar retirement note:** `kit.tsx`'s
`SpecBar` (§P's kit.tsx row: "ZERO consumers outside `kit.test.tsx`" as of Polish 1) gained its
first real consumer here — `RegionOverlay`'s capacity bar — so that "built but unwired" flag no
longer applies; no other `SpecBar` consumer exists yet.

**`ui.store.ts`'s `sceneOverlay` field (Task 3):** `SceneOverlayTarget { kind: 'region' |
'population'; id: string } | null`, plus `setSceneOverlay`. The single open in-scene overlay
card — set on pin/marker click, cleared on `esc`, click-away (`onPointerMissed`), or unmount. This
is the ONE additive store field the whole Polish 2 phase introduces (see the relocated-dispatch
contract statement above); `themeMode`/`pendingPanelTab` are untouched.

**`pendingPanelTab` becomes reactive (Task 4, `WorldPanel.tsx`):** previously consumed once via a
mount-only effect (Polish 1 Task 6). `WorldPanel`'s `useState` initializer still reads
`useUiStore.getState().pendingPanelTab` for the mount-time vault-card path, but the consuming
`useEffect` now depends on the live `pendingPanelTab` selector (not `[]`) — so
`PopulationOverlay`'s "traffic panel →" button, which sets `pendingPanelTab` while `WorldPanel` is
ALREADY mounted, also switches the tab; the effect clears the field via `getState()` (not the
selector value) so the write itself doesn't re-trigger the effect. One-shot semantics are
preserved either way — mount-time or live, the field is read once and nulled.

**Guided console (Task 5, `panels/WorldPanel.tsx`/`panels/TrafficPanel.tsx`):** `WorldPanel.tsx`
gained `WorldSummary` — a read-only strip ABOVE the tab bar, OUTSIDE the `<fieldset
disabled={running}>` (it must stay legible while the sim runs): at rest it counts the authored doc
(`{n} region(s) · {n} server(s) · baseline {n} rps`), and once a batch is live it becomes a
sentence (`Handling {rolling rps} rps from {n} cities across {n} regions`) plus a stats line
(health label, `$/hr` via `computeWorldCost(...).monthlyUsd / HOURS_PER_MONTH`, rps-weighted mean
p50). `TrafficPanel.tsx`'s `TrafficSection`+`RoutingSection`'s old baseline-rps slider role was
dissolved into a new `TrafficHero`: a sentence-slider (`Send {n} requests/sec, routed to the
{routing-policy Segmented} region.`) with a frontline-capacity hint (`≈ {n} rps per frontline
replica — comfortable/tight/✗ will shed load`) computed from `frontlineCapacityRps` (below); the
`autoBaseline` checkbox and an exact-value `NumberField` fold in below, same `updateTraffic`
dispatch as before Task 5. Population rows became click-to-expand sentence rows (`{label} sends
{rps} rps → lands on {region}`) instead of always-open `EdgeRow`s; every tuning field inside stays
the same dispatch it always was.

**`derived.ts` additions (Tasks 4-5):** four new pure exports, same "no store imports, no React"
discipline as the rest of the file (§P's derived.ts row). `healthWord(cpuFraction, ramFraction):
'comfortable'|'tight'|'straining'` — worst-of-the-two-pressures banding (<70%/<90%/else),
consumed by `TopologyPanel.tsx`'s `ServerRow` (Task 6, already in §J) and echoed by the hero's
capacity hint tone. `POP_LATENCY_KM_PER_MS = 100` + `populationLanding(pop, doc, compiled): {
regionCatalogId, latencyMs } | null` — a PURE reimplementation of the engine's client→region
latency convention (`worldEngine/networkRuntime.ts`'s `INTERNET_KM_PER_MS`, "~1ms per 100km
great-circle") and of `resolveRegion`'s policy-order consumption (`compiled.routing.
populationRegionOrder[pop.id]?.[0]`) — never imported from `worldEngine` internals (Global
Constraints); returns `null` when no region resolves or the landing region's `catalogId` has no
`REGION_GEO` entry. Consumed by `TrafficPanel.tsx`'s population rows and
`PopulationOverlay.tsx`'s landing hint — one definition, two surfaces. `isEntryBlueprint(bp):
boolean` — a pure reimplementation of the engine's client-entry predicate (`worldEngine/
index.ts`'s "has a public port" check), same never-import-from-engine-internals stance.
`frontlineCapacityRps(doc, compiled): number` — Σ `hostRpsCapacity(host vcpu, blueprint cpuMs)`
over every placement of an entry blueprint; the compiled world param exists for signature
symmetry with future instance-count refinements, the sum itself is authored-doc math today.
Consumed by `TrafficHero`'s capacity hint.

**`costModelV2.ts`'s `HOURS_PER_MONTH` export (Task 5):** `= 730`, hoisted out of what were two
inline `730` literals (`computeWorldCost`'s `instanceHourly` branch and its per-server rollup) so
`WorldSummary`'s `$/hr` derivation (`monthlyUsd / HOURS_PER_MONTH`) shares the exact constant the
cost model itself uses — no risk of a second, silently-different "hours in a month" creeping in
at a new call site.

**Motion application pass (Task 7 — this task):** the phase's closing pass wires the Task 1
classes onto every clickable/live-status surface app-wide, rather than adding new primitives.
`WorldPanel.tsx`'s tab bar: the per-button `borderBottom` underline is REPLACED (not
supplemented) by a `.kit-ink` span whose `left`/`width`/`top` are measured off the active
button's `offsetLeft`/`offsetWidth`/`offsetTop + offsetHeight - 2` inside a `useLayoutEffect`
keyed on the active tab, re-measured on `onMouseEnter` per tab (hover preview) and reset on the
bar's `onMouseLeave` (`placeInk(tab)`) — `top` is tracked per-tab, not hardcoded to the
container's bottom, because the 7-tab bar in a 360px dock WRAPS to two rows and a
bottom-anchored ink would underline the wrong row for every tab in the first row. Every tab's
click dispatch (`setTab(t.id)`) and the Analysis `ChipValue` are unchanged. `WorldSummary`'s
health line: the `●` glyph moved out of the health string into its own small (6×6) `span`
carrying `.kit-ripple` (gated on batch presence — a scrub replay ripples too, matching every
other `scrubBatch ?? latestBatch` live read in the app) — folding the dot into the sentence
string would have rippled an oval across the whole phrase instead of a dot, since `.kit-ripple`'s
`::after` is `inset: 0` on its own box. `EdgeRow` (kit.tsx) gained an additive `ripple?: boolean`
prop: when true AND `status` is non-null, the status dot gains `.kit-ripple` + `color:
STATUS_COLOR[status]`; `TopologyPanel.tsx`'s `ServerRow` is the one caller (`ripple={running}`,
a new plain `useSimulationStore(s => s.running)` read, no dispatch). `Segmented` and
`PresetCardGrid` (kit.tsx) buttons gained `kit-press` (`PresetCardGrid` appends it to its
existing `"kit-pcard kit-t"`). Every `smallBtn`/`dangerBtn`-styled `<button>` across
`TopologyPanel.tsx`/`TrafficPanel.tsx`/`BlueprintPanel.tsx`/`PlacementPanel.tsx`,
`WorldShell.tsx`'s `hdrBtn` buttons (⚙/New/Open/Save/Save As/dismiss), and `SimControls.tsx`'s
Simulate/Stop button gained `className="kit-press"` — presentation-only, zero dispatch changes.
Two deliberate exclusions: `TopologyPanel.tsx`'s `unstyledButton` ChipValue wrapper (`all:
'unset'`, no border to glow) and any button that already carried `kit-press` from Tasks 3-4
(`TrafficPanel.tsx`'s "exact value" toggle, every overlay footer button). `AzCanvas.tsx` gained a
flow shimmer: a `rpsByServer` `Map` (source-server id → Σ resident-instance live rps, built once
before the edge map — the same per-instance rps sum the chassis-node metrics already compute per
server, just lifted to cover every server rather than the currently-selected one) feeds each
edge's new `animated: e.blocked === 0 && (rpsByServer.get(e.source) ?? 0) > 0` — React Flow 12's
own `animated: true` renders the dashed-flow treatment; a blocked edge NEVER animates regardless
of its source server's rps (decision: a refused path shouldn't look "flowing"). **Decision 12
no-op:** the region-level view (`RegionView.tsx`/`CrossAzColumn.tsx`) was evaluated for the same
shimmer treatment and intentionally skipped — `CrossAzColumn` renders cross-AZ links as plain
text rows (`{labelA} ⇄ {labelB} {latency}`), not an SVG/path element a dashed-flow animation could
attach to; the AZ canvas (an actual React Flow edge graph) is the only surface where the
treatment applies. **Reduced-motion selector, verified not reworded:** T1's stylesheet block
already carried `.react-flow__edge.animated .react-flow__edge-path { animation: none; }` inside
the `@media (prefers-reduced-motion: reduce)` query; checked against the installed
`@xyflow/react@12.11.1` (`node_modules/@xyflow/react/dist/style.css`) — the library's own dashed-
flow rule is `.react-flow__edge.animated path` and the rendered `<path>` element DOES carry the
`react-flow__edge-path` class (confirmed in `dist/esm/index.js`'s `BaseEdge`), so the reduced-
motion override matches AND wins on specificity (three class selectors vs. the base rule's two
classes + one type selector) regardless of stylesheet load order — no selector fix was needed.

---

### R. Polish 3: motion budget, `price` token, rack doc model, `@xyflow/react` removal (`src/lib/theme.ts` Task 1, `src/lib/world/rackModel.ts`/`world.store.ts` Task 2, `src/app/world/region/` Task 3, `src/app/world/az/` Task 4, `src/app/world/server/` Tasks 5-6, `src/app/world/panels/WorldPanel.tsx` Task 7, motion-budget enforcement Task 8, 2026-07-11)

Eight tasks, one phase, one design constitution (spec D1: "no animation unless it carries
information; per view, at most ~8 concurrent infinite animated strokes; everything else encodes
with static fills, glows, and numbers" — `docs/superpowers/specs/2026-07-11-polish3-level-
redesign-design.md`): a dedicated money-value color (Task 1); an optional rack doc model layered
under the free-pool server model (Task 2); a full visual rebuild of Region v4 (Task 3), the AZ
level (Task 4 — the isometric datacenter floor, which removes `@xyflow/react` from the app
entirely), and the server board v5 (Tasks 5-6); Dock v2 signature tab headers (Task 7); and this
task's closing motion-budget audit plus these doc updates. This section documents the six items
the brief scoped to Task 8: the `az/` module map, the rack doc model + serializer compat rule, the
`@xyflow/react` removal, the `price` token, the motion-budget inventory, and the relocated-
dispatch statement. §L (server board) and §M (region/AZ, Phase 4) predate this phase and describe
the PRE-Polish-3 shape of those directories — §L's server/ file table is superseded piece-by-piece
by Tasks 5-6 below (not rewritten there, per this task's append-only scope); §M's `AzCanvas.tsx`/
`AzSimOverlay.tsx`/`RackNodes.tsx`/`src/lib/world/layoutRacks.ts` rows are now HISTORY — all four
files are deleted (Task 4; see the `@xyflow/react` removal below) and §M is left as-is as the
historical record of the Phase-4 design those files implemented.

**`price` token (Task 1, `src/lib/theme.ts`).** A dedicated `price: string` field on both
`DARK_COLORS`/`LIGHT_COLORS` (dark `#6EE7B7`, light `#047857` — 6.4:1 on white, normal-text AA),
picked up automatically as `--color-price` by `App.tsx`'s `useThemeBootstrap` (which already
walks every `COLORS` key generically — no bootstrap change needed). Every money value in the app
now renders `var(--color-price)`: `CostTab.tsx`'s rollups, `TopologyPanel.tsx`'s hourly meta,
`WorldPanel.tsx`'s dock summary `$N/hr`, `region/AzRow.tsx`'s `$N/mo` and `region/
SourcesColumn.tsx`'s `+$N/hr egress` figure, `ui/kit.tsx`'s instance-catalog picker prices, and
`ui/overlays/RegionOverlay.tsx`'s capacity/cost chips. One token, both themes — grep-verified no
other UI surface uses that hue.

**Rack doc model (Task 2, `src/lib/world/rackModel.ts` + `world.store.ts` + `types.ts`).** Racks
are an OPTIONAL authored container layered over the pre-existing free-pool server model —
`WorldDoc.racks: Record<RackId, Rack>` (`Rack { id, azId, label, capacityU }`) and
`Server.rack: RackPosition | null` (`RackPosition { rackId, unit, heightU }`; `null` = unracked,
free pool). `rackModel.ts` is pure (no React/store imports): `serverHeightU` (2U dedicated / 1U
vps, matching the old factory-seeded split), `rackUsedU`, `canAssign` (capacity check excluding
the server's own current usage if it's already in that rack), and `autoArrangePlan` (deterministic
bin-packing — free-pool servers sorted label-then-id into existing racks bottom-up, new racks
`rack-<n>` created on demand once existing targets are full, `<n>` the smallest globally-unused
integer). `world.store.ts` gained five rack actions — `addRack`, `updateRack` (capacity clamped to
`[RACK_CAPACITY_MIN, RACK_CAPACITY_MAX]` and never below current usage), `removeRack` (sends every
resident to the free pool THEN deletes the rack, one `mutate()`/one undo step), `assignServerToRack`
(no-ops if `canAssign` fails), `autoArrangeAz` (applies an entire `autoArrangePlan` — new racks +
every assignment — in one `mutate()`) — all routed through the existing `mutate()` helper, so
undo/dirty-marking come free with zero new plumbing (this file's top-level "Undo/redo" Key
Architecture Decision still holds unchanged). `InspectorV2.tsx`'s selected-server pane gained a
`rack` `<select>` (free pool + every AZ rack, options disabled via `canAssign` when the server
can't fit) dispatching `assignServerToRack` on change. Grep-verified production call sites:
`assignServerToRack` (`InspectorV2.tsx`), `addRack`/`autoArrangeAz` (`az/DatacenterFloor.tsx`'s
toolbar + its "+ rack" ghost-slot click) — `removeRack`/`updateRack` have no UI call site yet
(store-level + `world.store.test.ts` only; a rack-management UI beyond assign/auto-arrange is
parked, not built).

**Serializer additive-compat (Task 2, `src/lib/serializer.ts`).** `racks` and non-null
`server.rack` were both introduced after the v2 format shipped, so `deserializeWorld` normalizes
rather than rejects: `result.world.racks ??= {}` and, for every server, `if (server.rack ===
undefined) server.rack = null`. A pre-Polish-3 `.scalemap` file — no `racks` key at all, no `rack`
key on any server — loads, edits, saves, and reopens unchanged; nothing in the required-
collections validation (`meta` + the 9 top-level `WorldDoc` collections) changed, `racks` is
normalized AFTER that check passes, not added to the required list.

**`src/app/world/az/` — the isometric datacenter floor (Task 4), Level-3's new home.** Replaces
the React Flow AZ canvas outright (see the `@xyflow/react` removal below). Composition root +
pure data/geometry helpers, the same "pure layout, dumb presentational leaves" split `server/`
(§L) and the deleted `layoutRacks.ts`/`RackNodes.tsx` pair (§M) already established:

| File | Role |
|---|---|
| `floorLayout.ts` | Pure grid layout (no React/store/pixel math): assigns every rack, free-pool server, and managed service a GRID CELL — `layoutFloor(racks, rackedByRack, freePool, managedIds): FloorPlan`. Grid grows in rings from a 4×4 base (`BASE_GRID=4`, `GROWTH_STEP=2`) as occupant count exceeds capacity; `rackedByRack` is accepted but unused for the grid math itself (only occupant COUNT matters, not contents) — kept as a parameter because every caller already has it in hand for rendering |
| `floorData.ts` | Pure derivations, no React/store: `aggregateFlows` (a verbatim port of the deleted `AzCanvas.tsx`'s edge-aggregation block — same per-`(fromServer,target)` totals/blocked/first-reason semantics, same same-server-pairs-draw-no-edge rule, now operating on `CompiledWorld` directly since it already carries each instance's `azId`), `ledParams(cpuMean): { lit, color }` (6-LED CPU-threshold language), and `meanUtilization` (T8 addition — shared by `RackCabinet.tsx`/`FreePoolPod.tsx`'s own per-slot cpuMean AND `DatacenterFloor.tsx`'s AZ-wide LED-blink ranking, replacing three independent copies of the same one-liner) |
| `iso.ts` | Isometric tile projection + 3-face box geometry (roof cap + two walls sharing edges with a tile's diamond footprint), generalizing the mockup's fixed 2-rack/2-pod illustration to an arbitrary N×N `layoutFloor` grid at a fixed `VIEW_W`/`VIEW_H` (growing the ring shrinks tiles, not the scene — "the camera refits"). No React/store imports |
| `useHoldTap.ts` | DOM/SVG pointer-event wiring around `ui/HoldToEnter.tsx`'s pure primitives (§Q) — reused, never forked. `RegionPins.tsx` (§Q) is r3f/WebGL and needs a synthetic-click swallow dance around its raycaster; real DOM elements with `setPointerCapture` don't, so tap-vs-hold-vs-abort resolves entirely in `onPointerUp` here. Pointer CAPTURE (not `pointerleave`) still governs "left mid-hold", via `exceedsHoldSlop` distance-from-press-point in `onPointerMove` — the same D1 rule §Q's hold-to-enter established, reapplied rather than reinvented |
| `azFloorStyles.ts` | The injected-stylesheet-once idiom `region/r3Styles.ts` established, self-contained (pulls its one theme-matched token, teal, from `lib/theme.ts` rather than `ui/kit.tsx`), keyframes namespaced `az-*` so they can't collide with `region/`'s unprefixed copies or `server/`'s `hw-`/`gw-` copies. Every infinite-iteration rule (`.az-trace-animated`, `.az-led-blink`) plus the boot cascade (`.az-newslot.go`, one-shot `forwards`, not `infinite`) is neutralized under `@media (prefers-reduced-motion: reduce)` |
| `RackCabinet.tsx` | One rack cabinet: 3-face isometric box, hover lift + halo (CSS `transition`, not `animation` — excluded from the motion budget), one `RackSlot` per resident (tap selects, hold drills in via `useHoldTap`). Height grows with occupancy up to `capacityU`. `RackSlot`'s LED blink is now gated on an `animatedLed` prop (T8, see the motion-budget table below) in addition to `lit > 0`/reduced-motion |
| `FreePoolPod.tsx` | One free-pool (unracked) server: same 3-face box + LED language as a `RackSlot`, one pod = one whole box, no internal slat stack. Same tap/hold interaction, same boot-cascade treatment, same T8 `animatedLed` gating |
| `DatacenterFloor.tsx` | Composition root: reads `doc`/`compiled`/`batch`/`nav`, runs `layoutFloor`/`aggregateFlows`, renders tiles + one `RackCabinet` per rack + one `FreePoolPod` per unracked server + a small appliance box per in-scope managed service, flow traces, and the toolbar (`+ server`/`+ rack`/`auto-arrange` — Task 2's rack actions). Owns `selectedServerId` and a seen-ids ref driving the boot-cascade animation for newly-added servers (skipped entirely under reduced motion — instant-appear, the D1 functional exception). Computes BOTH of T8's ranked animation sets (`animatedKeys` for traces, `animatedLedIds` for LEDs) here, since both need AZ-wide visibility no single leaf component has |

**Boundary rules:** `az/*` imports only `lib/` (world types, `rackModel.ts`, `worldEngine/types`
type-only) and app stores (`useWorldStore`, `useNavStore`, `useSimulationStore`,
`useCompiledWorld`) — the same shape `region/*` (§M) established. `RackCabinet.tsx`/
`FreePoolPod.tsx` are presentational leaves fed AZ-wide-computed props (`animatedLedIds`/
`animatedLed`, `newServerIds`/`isNew`) by `DatacenterFloor.tsx`, never re-deriving cross-server
rankings themselves — the same "compute once at the composition root, thread down" shape
`region/AzRow.tsx`'s `monthlyUsd` prop and `server/ServerBoard.tsx`'s `boardLayout.ts` outputs
both already use. `floorLayout.ts`/`floorData.ts`/`iso.ts` are pure — no React/store/engine
imports; `az/` as a whole never imports `worldEngine/index.ts` (the executable facade), matching
the seam §K/§L/§M established for `server/`/`region/`.

**`@xyflow/react` removal (Task 4).** `AzCanvas.tsx`, `AzSimOverlay.tsx`, `RackNodes.tsx`, and
`src/lib/world/layoutRacks.ts` were all deleted in Task 4 — `az/DatacenterFloor.tsx` (DOM/SVG, no
React Flow) replaces the Level-3 view outright, and grep-verified these were `@xyflow/react`'s
only import sites in the app; `package.json`'s `@xyflow/react` dependency was removed in the same
task (grep-confirmed absent from `package.json` and from every file under `src/` as of this task).
CLAUDE.md's Key Dependencies table and architecture notes still claimed React Flow renders the AZ
level as of the start of this task — corrected below. §M's description of the deleted quartet is
left unedited as the historical record of the Phase-4 design; this section is the forward pointer
to "these files are gone, and here's what replaced them."

**Motion budget (spec D1) — the T8 sweep.** Every `animation:`/`animate` occurrence under
`region/`, `az/`, `server/`, `panels/` was inventoried. `panels/` (the Dock v2 tab bar, Task 7) has
ZERO — Dock v2's signature headers are static glyphs/gradients, no `@keyframes` at all. The other
three views each have one or more top-N-by-magnitude ranked categories (mirroring the established
`SplitLines.MAX_ANIMATED_BEAMS`/`ReplicaRail.MAX_ANIMATED_RAILS` shape) plus, on the server board
only, a set of FIXED-cardinality effects the design spec (D6/D7) mandates outright — 8 NIC pins,
3 intake lanes, a firewall scan/beacon/spark — whose count never scales with world size and so
carries no proliferation risk regardless of how large the world grows (unlike a ranked category,
whose whole point is capping something that otherwise scales with server/AZ/population count).

| View | Ranked (data-scaling) categories, capped | Fixed chrome (spec-mandated, doesn't scale) | Worst-case ranked total |
|---|---|---|---|
| Region | dot-streams top-5 (`SourcesColumn`, rps-ranked) + beam top-1 (`SplitLines`, fraction-ranked — tightened from top-2 this task) + replica-rail top-1 (`ReplicaRail`) + trunk march ×1 (`SourcesColumn`, fixed single element, counted with the ranked total per this file's own established arithmetic) | none | 5+1+1+1 = **8** |
| Floor (AZ) | flow traces top-5 (`DatacenterFloor`, rps-ranked — tightened from top-8 this task) + LED blink top-3 (`RackCabinet`/`FreePoolPod`, cpuMean-ranked — **newly capped this task; previously unbounded**) | boot cascade (`az-rackin`/`az-bootled`) is one-shot `forwards`, not `infinite` — excluded | 5+3 = **8** |
| Board (server) | flow overlays top-8 (`TraceLayer.MAX_ANIMATED_TRACES`, rate-ranked, pre-existing) + core flicker/steal-glitch top-4 (`HardwarePlatform`, utilization-ranked — **newly capped this task; previously unbounded, up to 32 vCPU on a `dedicated-32` box**) | NIC: 8 pins + 3 lanes + 1 ACT LED (`NicBlock`, D6-mandated exact counts) · Firewall: 1 scan + 1 beacon + up to 4 edge-dots (bounded by `shieldSlats`'s `maxSlats=4`) + 1 reject spark (`FirewallGate`, D7) · Disk platter spin ×1, `InspectorRail` scanline ×1 | **8 + 4 = 12** (two independent pools, summed, not "8 or 4") — intentional exception, see note below |

**The board is an intentional, user-approved exception to D1's ≤8 rule — accepted as-built,
2026-07-11.** `TraceLayer`'s traces (top-8, rate-ranked) and `HardwarePlatform`'s cores (top-4,
utilization-ranked) are two INDEPENDENT ranked pools in two separate DOM subtrees (like region's
four categories, not summed against a shared pool) — so their own concurrent maximum is **8 + 4 =
12**, not "8 or 4, not summed" and not ≤8; any doc wording implying otherwise was wrong and is
corrected here. On top of that ranked-pool total, the board additionally carries D6/D7's
FIXED-cardinality hardware chrome — 8 NIC pins + 3 intake lanes + 1 ACT LED (`NicBlock`), a
firewall scan sweep + beacon + up to 4 edge-dots + 1 reject spark (`FirewallGate`), a disk-platter
spin, and `InspectorRail`'s scanline — whose count never scales with world size (unlike a ranked
category, whose whole point is capping something that DOES scale with server/AZ/population
count). D1's ≤8-concurrent rule targets WORLD-SCALING data-viz motion, which is now capped
everywhere it appears (region's dot-streams/beam/rail, the floor's traces + LED blinks, and the
board's own two ranked pools above); the board's hardware chrome is a bounded, cheap, non-scaling
set that the round-5 mockup locks verbatim (the user personally locked the rippling RJ45 pins
during mockup review) and that D6 specifies by exact count ("8 gold pins that ripple"). Given
that, the user directly adjudicated this question: **accept the board as-built** — no product-code
changes follow from this; this doc entry is the record of that decision, not a call to tighten the
board to match region/floor's arithmetic. Region and Floor, by contrast, have no such fixed-chrome
carve-out and no cross-pool summing question, so both were tightened until their own literal sums
land at exactly 8, matching the precedent `SplitLines.tsx`'s and `ReplicaRail.tsx`'s file comments
already set by doing this arithmetic by hand.

**Two genuine bugs found and fixed (previously unbounded, not just re-tuned):** (1) floor LED
blink had no cap at all — `lit > 0 && !reducedMotion` was the only gate, so an AZ with many active
servers blinked every one of them concurrently. Fixed via `DatacenterFloor.tsx`'s new
`animatedLedIds` (top-`MAX_ANIMATED_LEDS` by cpuMean, computed once and threaded to
`RackCabinet`/`FreePoolPod` as `animatedLedIds`/`animatedLed`); a lit LED outside the set still
shows its color, just statically. (2) `HardwarePlatform`'s per-core `hw-coreflicker`/`hw-glitch`
had no cap either — every core cell animated regardless of vCPU count, and `dedicated-32`
(`instanceCatalog.ts`) has 32. Fixed via a new `animatedCoreIndices` set (top-`MAX_ANIMATED_CORES`
by utilization); a core outside the set still shows its exact fill height, just without the
flicker/glitch overlay animating. One pre-existing arithmetic-consistency fix: `ReplicaRail.tsx`'s
`MAX_ANIMATED_RAILS` (added in an earlier review-fix wave) pushed region's own documented running
total from 8 to 9 without anyone re-checking the sum — `SplitLines.MAX_ANIMATED_BEAMS` tightened
2→1 to restore it, and `DatacenterFloor.tsx`'s trace cap was similarly tightened 8→5 to make room
for the new LED cap under the same discipline. All three fixes are ranked-cap additions/
tightenings in the VIEW layer only; zero changes under `src/lib/worldEngine/` (Global Constraint
honored — `git status --short src/lib/worldEngine/` is clean for this task).

**Reduced motion verified zero (code-read; the live phase-gate confirmation is CONTROLLER-run —
see this task's report):** every ranked category above is gated `!reducedMotion &&`/`!reduced &&`
at the point the `animation` inline style or class is applied (`SourcesColumn`/`SplitLines`/
`ReplicaRail` in region; `DatacenterFloor`'s trace `animated` flag AND `RackCabinet`/
`FreePoolPod`'s new `blinking` gate in the floor; `TraceLayer`/`HardwarePlatform`'s new
`flickering` gate, `NicBlock`, `FirewallGate` in the board). Three of the four injected
stylesheets — `azFloorStyles.ts`/`hwStyles.ts`/`gateStyles.ts` — additionally neutralize their own
classes inside `@media (prefers-reduced-motion: reduce)` as belt-and-suspenders; **`region/
r3Styles.ts` does NOT** (verified by reading the file — it has no `@media` block at all). Region's
reduced-motion compliance rests entirely on REACT-LEVEL gating instead — `reduced ? {} : {
animation: ... }` in `SourcesColumn`/`ReplicaRail`, `{animated && <animate/>}` in
`SplitLines.tsx` — which is sufficient on its own (React never emits the animating class, inline
style, or `<animate>` element when reduced), just not doubly-enforced at the CSS layer the way the
other three views are; a prior version of this doc incorrectly claimed `r3Styles.ts` carried the
same CSS-level neutralization, corrected here. The ONE
functional exception is the hold-ring sweep (`useHoldTap.ts`'s rAF-driven `progressRef`, §Q) — not
a CSS `animation` at all, self-terminating on release/completion, never `infinite`-iterating, so
it was never in scope for this budget. The add-server boot animation (`az-rackin`/`az-bootled`)
degrades to instant-appear under reduced motion (`DatacenterFloor.tsx` passes an empty
`newServerIds` set when `reducedMotion` is true, rather than gating the CSS alone) — confirmed by
the pre-existing `DatacenterFloor.test.tsx` reduced-motion tests, unchanged by this task.

**Relocated-dispatch statement (Tasks 4-7, carried forward from D10/§Q's own rule).** Every
control this phase restyled or relocated reuses its EXISTING store dispatch byte-for-byte:
`region/AzRow.tsx`'s `⏎ enter`/`+ server`/`⚡ kill` reuse `onNavigateAz`/`addServer`/`setOutage`
unchanged from pre-Polish-3; `az/DatacenterFloor.tsx`'s `+ server` toolbar button reuses
`addServer`; `server/HardwarePlatform.tsx`/`NicBlock.tsx`/`FirewallGate.tsx`/`ServiceChip.tsx`'s
click handlers all still call the same `onSelect(BoardSelection)` callback `ServerBoard.tsx` has
wired since Phase 3 (§L); `panels/WorldPanel.tsx`'s Dock v2 tab headers still call the same
`setTab`. **The only new store surface across the entire eight-task phase is Task 2's rack CRUD in
`world.store.ts`** (`addRack`/`updateRack`/`removeRack`/`assignServerToRack`/`autoArrangeAz`,
surfaced through `az/DatacenterFloor.tsx`'s toolbar and `InspectorV2.tsx`'s new rack selector) —
`nav`/`simulation`/`file`/`ui` stores gain nothing (matches spec D10 verbatim).

---

## 2. Shared "hub" files (everyone touches these — high conflict risk)

These aren't feature modules; they're registries other code plugs into. The fix
isn't to avoid them, it's to **only ever append/extend, never restructure, in a
routine PR** — restructure them in their own dedicated PR when nobody else has
in-flight changes.

| File | Why it's a hub | Fan-in (CodeGraph-verified) |
|---|---|---|
| `src/lib/nodeConfig.ts` (~380 lines) | `NODE_CONFIG` registry — every node type's icon/category/label | **31 files import it** — the single largest fan-in in the repo (fan-in unaffected by Task 17: `nodeConfig.ts` is a survivor, its historical fan-in included legacy files that are now gone, so the *current* count is lower than 31 — worth re-verifying with `grep -rln "from '.*nodeConfig'" src` next time this file is touched rather than trusting the stale number). `NodeSimConfig` gained two append-only optional fields (`consistencyLevel`, `replicationLagMs`, GitHub #12). **2026-07-05:** added `FORWARD_ONLY_NODE_TYPES` (`loadBalancer`/`dns`/`firewall`/`vpn`) and `canDefineOutboundThroughput(sourceType)`, consumed by the now-deleted `PropertiesPanel.tsx`/`particleEngine.ts` (§A/§B) — these two exports and the header comments referencing `particleEngine.ts` (lines ~31/141/148) are dead code/dangling-but-historical comments post-Task-17, left in place deliberately rather than edited (same "porting provenance" reasoning as `worldEngine/breakers.ts`, §B) since `nodeConfig.ts` wasn't itself on Task 17's deletion or modify list. |
| `src/lib/theme.ts` (120 lines) | `ColorTokens`/`DARK_COLORS`/`LIGHT_COLORS`/`CATEGORY_COLORS`/`FONT_*`/`SPACING`/`MOTION` — small file, but touched by any node/edge visual change. Only the 16 `ColorTokens` keys (`canvas`, `canvasDots`, `nodeBase`, `nodeBorder`, `surface`, `surfaceHover`, `toolbar`, `toolbarBorder`, `textPrimary`, `textSecondary`, `textMuted`, `danger`, `success`, `successText`, `warning`, `accent`) are exposed as `--color-*` CSS custom properties by `App.tsx`'s `useThemeBootstrap` and mirrored in `src/index.css`'s static `:root` fallback. `CATEGORY_COLORS` (messaging/network/storage/etc per-category accents) is **not** exposed to CSS — only consumed directly in `.tsx` via inline styles (`BaseNode.tsx`/`GroupNode.tsx`, both deleted 2026-07-08, §A). **2026-07-02 bug-fix sweep migrated every remaining panel CSS module** (SimConfigPanel, PacketEditor, EventLogPanel, ReportsPanel, PropertiesPanel, MetricGraphOverlay, RequestInspector, DiagnosticsPanel, PlaybackScrubber, MetricsDrawer, CostTracker, HomeScreen, ContextMenu, NodePalette, StatusBar, BaseNode/GroupNode leftover fallbacks, Canvas.module.css, edges.module.css — ~545 hardcoded hex values total) to `var(--color-*)`/`color-mix()` — **historical note: every file in that list except `HomeScreen` was deleted 2026-07-08 (Phase 2 Task 17, §A/§B/§D/§E/§F/§H/§I)**; kept here as a record of the token-migration effort, not as a current file inventory. `theme.ts` itself, `HomeScreen.module.css`, and `src/app/world/`'s CSS are the surfaces that still matter today. | `HomeScreen.tsx`, `src/app/world/**` |
| `src/index.css` | `:root` holds a **static copy of `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION`** (closes a first-paint FOUC gap — every `var(--color-*)` reference would otherwise be undefined until `App.tsx`'s `useThemeBootstrap` `useEffect` runs post-first-paint). This is a values-only fallback, not a second source of truth — if `theme.ts`'s `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION` change, update this block to match (nothing enforces the two staying in sync) | Every CSS module transitively (first paint only — overridden by the bootstrap effect on mount) |
| `src/app/store/ui.store.ts` | **Trimmed 2026-07-08 (Phase 2 Task 17) to `themeMode: 'dark' \| 'light'` + `setThemeMode` only** — every other field (`activeTool`, `leftSidebarOpen`/`rightSidebarOpen`/`rightTab`, `selectedNodeId`/`selectedEdgeId`, `gridEnabled`, `connectSourceId`, `contextMenu`, `simConfigOpen`/`simConfigPanelNodeId`, `dockOpen`/`dockTab`, `packetEditorOpen`, `highlightedNodeIds`) was read only by the legacy canvas/simulation/sidebar/toolbar/dock UI deleted the same task (§A/§B/§D/§E/§F/§H/§I) — grep-verified zero remaining readers before trimming. Drives the runtime CSS custom-property bootstrap in `App.tsx` that every panel's CSS module reads via `var(--color-*)`; persisted to `localStorage` (`scalemap-theme-mode`). `App.tsx` is now the **only** file reading this store (`themeMode`, to bootstrap the CSS vars) — there is currently no UI control to call `setThemeMode` (the old toggle lived in the deleted `Toolbar.tsx`); a future task should add one to `WorldShell.tsx`'s header. If a future phase wants a "focus this node" pulse, a floating-panel-open registry, etc., re-add the specific field then rather than resurrecting the old multi-concern shape. **2026-07-10 (Polish 1 Task 6 — examples vault, §P):** gained a SECOND, unrelated field — `pendingPanelTab: PanelTab \| null` (initial `null`) + `setPendingPanelTab` — additive, `themeMode`'s contract untouched. `PanelTab` (`'topology'\|'blueprints'\|'placements'\|'traffic'\|'analysis'\|'events'\|'cost'`) is exported from here now, not from `WorldPanel.tsx` (view→store type import). One-shot signal: `HomeScreen.tsx`'s `openExample` sets it to `'analysis'` only for the teaching vault card, `WorldPanel.tsx` reads it once in a `useState` initializer and clears it in a mount effect | `App.tsx` (`themeMode`), `HomeScreen.tsx` + `WorldPanel.tsx` (`pendingPanelTab`) |
| `src/app/store/simulation.store.ts` | **The only simulation store since 2026-07-08 (Phase 2 Task 17 deleted its legacy sibling, `simulationLegacy.store.ts`, §K).** Rewritten in Task 12 as the v2 world-engine store — `MetricsBatch`/`EngineEvent`/render-scope shape from `worldEngine/types.ts`. Consumers: `SimControls.tsx`, `EventsTab.tsx`, `WorldShell.tsx`, `GlobeView.tsx`/`RegionView.tsx`, `AzCanvas.tsx`, `ScrubberV2.tsx`, `InspectorV2.tsx`, `CostTab.tsx` (§J) | `src/app/world/**` (see §J's per-file Task 13/15/16 notes) |

**Convention to adopt:** when adding a new node type, only add to `NODE_CONFIG` (one new key) — don't reorder existing keys or reformat the file. Same for `NODE_SIM_DEFAULTS`. Append-only registries plus small, frequent PRs are what actually reduce conflicts here — restructuring these files is the thing to schedule as its own solo PR.

---

## 3. Suggested ownership split for parallel work

If splitting a sprint's work across people to avoid stepping on each other:

1. ~~**Simulation realism** → §1B~~ — the legacy `particleEngine.ts` and its `circuitBreakers.ts`/`backpressure.ts`/`chaos.ts`/`lbRouting.ts`/`compute.ts` sub-modules were deleted 2026-07-08 (Phase 2 Task 17). Simulation-realism work now happens in `src/lib/worldEngine/` (§K) — the subsystem-per-file split (`breakers.ts`/`flows.ts`/`hostScheduler.ts`/`vpsModel.ts`/etc.) is the spiritual successor to the old sub-module split and offers the same "disjoint files, low internal merge conflict" property.
2. ~~**Lint rules** → §1C~~ — deleted 2026-07-08 (structural linter + diagnostics removed outright, replaced by the Phase 6 Analysis system).
3. ~~**Packet editor** → §1E~~ — the editor UI (`PacketEditor.tsx`) and its CRUD store slice (`canvas.store.ts`) were deleted 2026-07-08 (Phase 2 Task 17). The packet *types* survive (`nodeConfig.ts`, still read by `WorldDoc`/`ScalemapFileV2`) but there is no authoring UI for them today — a good greenfield task for whoever picks packet-template editing back up in the world model.
4. ~~**Cost/pricing model work** → §1D~~ — `costModel.ts` was deleted 2026-07-08 (Phase 2 Task 17); cost/pricing work now happens in `src/lib/costModelV2.ts`/`src/app/world/CostTab.tsx` (§J Task 16), isolated unless changing `computeWorldCost`'s signature or `cloudRegistry.ts`'s `MANAGED_TYPE_ALIASES` mapping (§D).
5. ~~**Terraform/Vault/ScaleScript** → §1F~~ — all three deleted 2026-07-08 (Phase 2 Task 17), no Phase-2 replacement. **Rust persistence** (`src-tauri/src/commands.rs`, §G) is unaffected and remains the narrowest-blast-radius area in the repo, good for onboarding or solo side-quests (e.g. wiring up a Phase-2+ reports-export command).
6. ~~**Floating panel/IA work** → §1H~~ — the dock (`UtilityDock`/`ReportsPanel`) was deleted 2026-07-08 (Phase 2 Task 17) along with the panel-open fields it was the last reader of in `ui.store.ts` (now trimmed to `themeMode` only, §2). A future floating-panel system in the world shell starts from scratch — there's no "pick an empty corner" precedent left to follow, only the historical rationale in §H's old spec links if that's useful context.

---

## 4. Why this is a codebase-organization fix, not a microservices one

Scalemap is a single-process Tauri desktop app: world-document state, the world engine
(`src/lib/worldEngine/`), and the Zustand stores all run in one JS runtime because the
simulation loop reads and mutates them synchronously every step. There's no network boundary to split
services along, so introducing microservices would mean standing up inter-process
communication purely to solve a code-ownership problem — real added complexity
(serialization, latency, deployment) without the deployment-independence benefit
that normally justifies it. The module boundaries above get most of the
conflict-reduction benefit without that cost.
