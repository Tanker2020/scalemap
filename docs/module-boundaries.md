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

> **2026-07-12 repo slim-down:** executed phase/polish specs, plans, and most mockups under
> `docs/superpowers/` were pruned (kept: the umbrella spec, the world-engine contracts, the
> phase2 engine spec, and the two mockups source comments still cite). Historical doc paths
> referenced in the per-task sections below may therefore no longer exist on disk — they all
> remain in git history. In the same sweep, `nodeConfig.ts` was cut down to just the
> packet-template types, `cloudRegistry.ts` lost its canvas-era `simDefaults`/label-rewrite
> surface, and `WorldPanel.tsx`'s unreachable `ScopedConfigBody` placeholder was removed —
> mentions of those in the historical sections describe the pre-sweep state. Current-state
> onboarding lives in `docs/agent-onboarding.md`.

> **2026-07-12 durable event log:** engine events are no longer capped-and-dropped — the store's
> in-memory list became a 500-entry presentation window and EVERY event now spills in 1 Hz
> batches to SQLite (WAL) at `<app_data_dir>/events.db`. Touched files: `src-tauri/src/commands.rs`
> (+`rusqlite` bundled — `LoggedEvent`/`LoggedEventRow`, `open_event_db` WAL+schema,
> `begin_run_in`/`append_events_in`/`tail_in` pure helpers with cargo tests, `event_log_begin_run`/
> `event_log_append`/`event_log_tail` commands, one `OnceLock<Mutex<Connection>>`),
> `src-tauri/src/lib.rs` (handler registration), `src/lib/tauri.ts` (camelCase wrappers +
> `LoggedEngineEvent`/`LoggedEventRow`), `src/lib/tauriMock.ts` (in-memory map, same command
> surface), `src/app/store/simulation.store.ts` (module-local pending buffer + 1 Hz flusher +
> final drain on stop/resetSession; additive state `eventLogRunId`/`eventLogTotal`; engine
> contract untouched), `src/app/world/EventsTab.tsx` (shows `latest N of TOTAL` + on-disk note).
> No history-browsing UI yet — `event_log_tail` is the ready-made pagination surface for it.

> **2026-07-12 fix wave:** `AtlasHeader.tsx` projects geography into `MAP_H = H - 20` (the band
> above the headline caption — São Paulo's dot used to hide under the caption text, making its
> arc read as broken) and population dots are r=2.5/opacity-0.9 with
> `data-testid="atlas-population-dot"`. `DatacenterFloor.tsx` clears `selectedServerId` on an
> empty-floor left-click that never becomes a drag (<5px slop), widening the dock back to AZ
> scope; `useFloorCamera.ts` now exports `INTERACTIVE_SEL` so floor deselect and camera pan
> agree on what "background" means.

> **2026-07-12 fix wave 2 — atlas depth + event history browser:** (1) `AtlasHeader.tsx` gained
> `warpToSphere` (exported, unit-tested): projected content bends onto the same 10px center
> bulge the graticule always drew ("looked like a flat plane" — dots/arcs and grid were two
> geometries on one card), plus limb-darkening + zenith radials, a teal atmosphere rim at the
> top, and harder-bowed outer meridians; all lighting sits UNDER the content so health colors
> never dim. (2) Event history: `commands.rs` gained `RunSummary` + `runs_in`/`clear_in` +
> `event_log_runs`/`event_log_clear` (11 cargo tests); `tauri.ts`/`tauriMock.ts` mirror them;
> NEW `src/app/world/EventHistory.tsx` (rendered at the bottom of the world-scope `EventsTab`)
> lists runs newest-first, expands one run at a time via `event_log_tail` paging (50/page,
> "older events ▸"), and clears all history behind a two-step confirm that is
> `disabled={running}`. (3) `WorldPanel.tsx`'s edit-lock fieldset is now
> `disabled={running && tab !== 'events'}` — the events tab is a read surface whose only
> destructive control self-locks; this follows the same escape-hatch precedent as the
> `<div role="button">` kill controls (`ServerFaceplate.tsx`/`AzConfigTab.tsx`).

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
| `src/lib/world/cityCatalog.ts` (2026-07-12, Polish 4 Task 7, §X) | `WORLD_CITIES` (48 real cities, all continents) + `nearestCity(lat,lon)` (argmin over `regionGeo.ts`'s `greatCircleKm`) — the globe placement-mode's snap-to-city catalog. No relationship to `regionGeo.ts`'s `REGION_GEO` (that's datacenter metros; this is population/client cities) — deliberately separate tables, not a shared/merged one, since a city here need not sit anywhere near a region |
| `src/lib/world/compileWorld.ts` (+ `network.ts`, `routing.ts`) | Pure resolver: blueprints × placements → instances, permitted/blocked paths (firewall/ports/docker networks), routing tables, findings. Golden-tested; every consumer (views now, engine in Phase 2, analysis in Phase 6) reads its output, never the raw doc, for derived facts. **2026-07-12 (Polish 4 Task 7 — globe traffic placement, §X):** `routing.ts`'s per-population region-ordering loop was extracted into an exported `regionOrderFor(pop: Pick<ClientPopulation,'lat'\|'lon'>, doc)`; `computeRouting` now just calls it per population. Behavior-identical refactor — `routing.test.ts` passes byte-for-byte unmodified (verified via `git diff`, zero changes); a new `regionOrderFor.test.ts` asserts parity against `computeRouting`'s output across all four policies rather than editing the golden file. `regionOrderFor` is now a second, pre-compile consumer alongside `compileWorld` itself: the globe's placement-mode preview (§X) calls it directly on a not-yet-placed `WorldCity` (which structurally satisfies the `Pick<...,'lat'\|'lon'>` param) to get the EXACT landing region before any population exists in the doc |
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
| `src/app/world/InspectorV2.tsx` (Phase 2 Task 15; **mount site moved to `DatacenterFloor.tsx` in Polish 3 Task 4** — `AzCanvas.tsx` no longer exists; **selected-server pane added Polish 3 Task 4, retired Polish 4 Task 4, §V**) | AZ-scoped overlay mounted inside `DatacenterFloor.tsx`, absolutely positioned bottom-left, props back down to `{ azId: AzId }` only (Polish 4 T4). Polls `useSimulationStore.getState().getTracedRequests({level:'az', azId})` on a 1s `setInterval` (same "plain method, not reactive state" reasoning as `ScrubberV2` — the contracts note the engine samples ≤1 traced request/sec/scope, so a 1Hz poll can't miss anything the engine itself wouldn't have missed) into local `useState`; re-polls (new effect) whenever `azId` changes. Renders `null` when there are zero traces for the scope — no persistent empty-state chrome. Each traced request is a clickable row (outcome + total latency, outcome-colored) that toggles a hop-table expansion showing `fromId → toId (hopClass)` and `outcome · latencyMs` per hop, both colored by the same `OUTCOME_COLOR` map (`ok`→success, `refused`/`error`→danger, `timeout`→warning). Its Polish-3-T4-era selected-server rack-selector/enter/kill card is GONE — see §V for where those three dispatches now live (`dock/PlacementDrawer.tsx`/`dock/ServerFaceplate.tsx`) |
| `src/app/world/panels/WorldPanel.tsx` | Authoring dock — a 300px right-side `<aside>` with a `Topology \| Blueprints \| Placements` tab strip (local `useState<Tab>`, not `nav.store` — tab selection is presentation-only and never needs to survive a level change). All three tabs render real content as of Task 12. **2026-07-08 (final review fix batch):** added a fourth `Findings` tab (`` `Findings (${count})` ``, `count = useCompiledWorld().findings.length` — same live compiler output `GlobeView`/`RegionView`/`ServerView` already read, not a separate computation) listing each finding as a severity chip (`error`/`warning` → `var(--color-danger)`/`var(--color-warning)`) + `kind` + message, with an explicit "clean" empty state. This is the first `WorldPanel` tab that reads `useCompiledWorld()` itself rather than only doc-level CRUD state. **2026-07-08 (Phase 2 Task 13):** gained a fifth `Events` tab (`EventsTab.tsx`) and a new required `running: boolean` prop (from `WorldShell`, sourced from `useSimulationStore`) — the tab strip and all four content tabs now sit inside a single `<fieldset disabled={running}>` wrapper, which cascades into every native `<button>`/`<input>`/`<select>` in `TopologyPanel`/`BlueprintPanel`/`PlacementPanel` with zero changes to those three files (same editing-lock intent as the legacy `canvas.store`'s `running` gate, §1A, implemented as one choke point instead of per-action checks). Findings/Events have no form controls, so wrapping them in the same `fieldset` is a harmless no-op, kept for uniformity. **Breaking-ish change:** `WorldPanel` now requires a `running` prop — `WorldPanel.test.tsx`'s two existing `render(<WorldPanel />)` calls were updated to `render(<WorldPanel running={false} />)` alongside this task, since neither the brief's file list nor its commit list called that test file out but `tsc` (whole-repo, `npm run build`) type-checks it via `tsconfig.json`'s `include: ["src", ...]` and fails on a missing required prop otherwise. **2026-07-08 (Phase 2 Task 16):** gained a sixth `Cost` tab (`CostTab.tsx`) inside the same `<fieldset disabled={running}>` wrapper as the other five — `Tab` widened to include `'cost'`, `tabs` array gained `{ id: 'cost', label: 'Cost' }`. Like Findings/Events, Cost has no form controls, so the fieldset wrap is a no-op for it too |
| `src/app/world/panels/TopologyPanel.tsx` (Task 11) | Region → AZ → server authoring. Add-region `<select>` is filtered to `WORLD_REGIONS` entries not yet used by any `doc.region`; `+ AZ` auto-suffixes the label (`${catalogId}${a,b,c…}`, recomputed from `doc.azs` every render, not stored); `+ Server` reads a per-AZ preset choice (local `Record<azId, presetId>` state) via `getPreset()` and calls `store.addServer`. Per-server `ServerRow` expands into label/firewall/compose-stack editors, edited as whole-array replacements (`store.updateServer({ firewall: [...] })`/`{ stacks: [...] }`). **Intentional exception to "always go through a store action":** the region-role `<select>` writes via `useWorldStore.setState(...)` directly (a deliberate two-value toggle with no undo/redo push, documented inline — **2026-07-08:** now additionally calls `useFileStore.getState().setDirty(true)` right after, since the history bypass was never meant to also skip dirty-marking). **2026-07-08 (final review fix batch):** each firewall rule row gained `↑`/`↓` reorder buttons (disabled at index 0 / the last index respectively), swapping the rule with its immediate neighbor via an immutably-rebuilt array passed to `upd({ firewall: swapped })` — necessary because firewall evaluation is first-match-wins and `+ Rule` always appends after the default allow-all, so a `deny` rule added later is otherwise permanently unreachable. Clicking a server's `→` calls `useNavStore.getState().goServer(...)`. **2026-07-10 (Polish 1 Task 2 — hybrid instrument restyle):** presentation-only pass onto the Task-1 shared kit (`src/app/world/ui/kit.tsx`) — every dispatch above is byte-for-byte unchanged. Each region block now renders as a `SectionHeader` (`label` = `` `▸ ${catalogId.toUpperCase()} · ${METRO}` ``, the metro parsed from the matching `WORLD_REGIONS` label's parenthesized city, uppercased; `trailing` carries a live health dot text — `● healthy`/`degraded`/`down` from `displayBatch?.regions[id]?.health`, muted `● —` at rest — then the unchanged role `<select>` and `×` button). Each AZ's `+ Server` row gained a `ChipValue`-styled toggle (`aria-label="choose server preset"`, wrapped in an `all: unset` `<button>` so the chip keeps its look while the button carries the aria-label/onClick) that expands a `PresetCardGrid` fed from `INSTANCE_CATALOG`; the grid's `onChange` only writes the existing local `presetByAz` state (no store dispatch) — `+ Server` itself is unchanged and still always visible. `ServerRow` now renders as an `EdgeRow` (`status`/dot = batch health or `null`; `edgeColor` = `var(--color-accent)`, or `var(--color-warning)`/`var(--color-danger)` when degraded/down) whose content is the unchanged expand-toggle button (`▸/▾ label (kind)`, still the `getByText(/server-N/)` test hook) plus a new muted meta line (`kind · vcpu c/ram G · azSuffix`, azSuffix = the AZ label's last char) and, only when `displayBatch` has that server, a 4px `data-testid="topo-util-fill"` utilization bar (width = mean `coreUtilization` rounded to %, amber past 75%); `trailing` carries `MicroBars` (batch-only), a muted `$hourlyUsd/hr` chip, then the unchanged `→`/`×` buttons. Firewall/compose-stack section captions became `SectionHeader`s (default teal, no `accent` override — the amber firewall treatment is Task 4's, in the server view); their inputs/aria-labels (`fw-port-*`/`stack-*`/`server-label`) are untouched. Added 3 tests (`TopologyPanel.test.tsx`'s `'TopologyPanel — instrument restyle'` block: batch-driven micro-bars/util-fill, at-rest absence of both, preset-grid selection feeding `addServer`) alongside the 4 pre-existing dispatch tests, all 7 green. **2026-07-10 (Polish 2 Task 6 — plain words):** `ServerRow`'s trailing cluster gained a `healthWord(cpuMean, ramFrac)` chip (`src/app/world/ui/derived.ts`, T1) right after the batch-only `MicroBars`, same `metrics &&` guard so it's absent at rest — `comfortable`/`tight`/`straining` colored `var(--color-success\|warning\|danger)`. Two new tests in the instrument-restyle describe (`healthWord chip appears only with metrics and uses the status color`, `no health word at rest`) alongside the 7 pre-existing; every firewall/compose-stack dispatch in this file is untouched by this task |
| `src/app/world/panels/BlueprintPanel.tsx` (Task 12) | **DELETED 2026-07-19 (node-model Phase 5)** — see that section; its blueprint editing moved to `dock/drawers/EditServiceForm.tsx` (workload/ports/stateful) + the Connections tab (dependencies). The rest of this row is historical. Service-blueprint CRUD — name/runtime/port config plus a dependency editor (`BlueprintDependency` targets either another blueprint or a managed service). **2026-07-10 (Polish 1 Task 3 — hybrid instrument restyle):** presentation-only pass onto the shared kit (`src/app/world/ui/kit.tsx`) and derived-hint math (`src/app/world/ui/derived.ts`) — every dispatch is byte-for-byte unchanged. Each card is now a `.b-card`-token shell (`--color-node-base`/`--color-node-border`, 8px radius) whose head row gained an editable `<input type="color" aria-label="signature color">` swatch (`upd({ color })`, new — the pre-restyle card had no color editor) and a `ChipValue title="placed instances"` (`×N` from `useCompiledWorld()`'s `instances` filtered by `blueprintId`), plus a muted meta line (`:port :port · N deps`) under the head. Ports/deps editors are unchanged rows/handlers under `SectionHeader`s. Workload's four bare number inputs became a `SectionHeader label="▸ WORKLOAD"` stack of `DerivedField`s: `cpu / request` (`mode="slider"`, min 1/max 60, `aria-label="cpu / request"`) derives `'→ one core sustains ~Nrps'`, plus `'; this Vcpu-core host ~Nrps'` only when the blueprint has a placement (`Object.values(doc.placements).find(p => p.blueprintId === bp.id)`'s server `specs.vcpu` — `undefined`/omitted when unplaced or the placement's server is missing); `ram base MB` (input, no derive); `ram / conn MB` (input) derives GB at 2,000 conns off the *committed* `bp.workload.ramBaseMb`; `disk io / req` (input) derives `diskIoWord`. `DerivedField`'s frozen props (`src/app/world/ui/kit.tsx`) have no `step` — the brief's "step 1"/"step 0.1" language is satisfied by the range input's native default step (1) and by `Number()`-parsing arbitrary decimals in input mode, not by a passed prop. Added 3 tests (slider-commit exact patch, derive-line text at a committed cpu value, host-line appears only once placed) alongside the 2 pre-existing dispatch tests, all 5 green. **Test-harness note (not a component bug):** the "host capacity line" test's post-render store mutations had to be wrapped in RTL's `act()` — Zustand v5's external-store notification lands outside any React-tracked event, so under React 19's automatic batching the render stays pending until the next `act()` boundary (verified via an isolated repro against a trivial probe component, independent of this restyle); the brief's literal test also expected `~500 rps` for the host line, which doesn't match `hostRpsCapacity(4, 5)` (`vps-medium`'s 4 vCPU × the *unmodified* `createBlueprint` default `cpuMsPerRequest: 5` → 800 rps, not 500 — `derived.ts`'s math is T1-frozen/tested) — corrected to `~800 rps` |
| `src/app/world/panels/PlacementPanel.tsx` (Task 12, managed-service keys updated Phase 3 Task 8) | **DELETED 2026-07-19 (node-model Phase 5)** — see that section; managed-service authoring moved verbatim to `panels/ManagedPanel.tsx`, placement CRUD is covered by `dock/drawers/ServicesDrawer.tsx` + `SpreadControl`. The rest of this row is historical. Placement CRUD (blueprint × server) plus managed-service CRUD, each managed service scoped to a region or AZ. **2026-07-09 (Phase 3 Task 8, D12):** `MANAGED_TYPES` was a flat string array (`rds`/`s3`/`sqs`/`redis`/`cdn`/`apiGateway`/`lambda`) that didn't match `CLOUD_REGISTRY`'s canonical `NodeType` keys, requiring `costModelV2.ts`'s alias table just to price. Now `MANAGED_TYPES: {key,label}[]` authors `ManagedService.nodeType` with `CLOUD_REGISTRY` keys directly — `dbSql`("SQL DB")/`objectStorage`("Object store")/`queue`("Queue")/`redis`/`cdn`/`apiGateway`/`lambda` — so new docs price without any alias lookup; the `<select>` shows the human label but the stored value/`addManagedService` call use `key`. Existing `.scalemap` files saved with the old short strings still load and price correctly via `costModelV2.ts`'s now-legacy-only `MANAGED_TYPE_ALIASES` (see that row). **2026-07-10 (Polish 1 Task 3 — hybrid instrument restyle):** presentation-only pass onto the shared kit — every dispatch byte-for-byte unchanged. Blueprint groups are now `.b-card`-token shells; `+ Place` unchanged. Each `PlacementRow` is an `EdgeRow` (`edgeColor = bp.color`) wrapping the unchanged server `<select>`/`pl-count` input/runtime-and-stack selects/`pl-mappings` input, plus a new `<Segmented ariaLabel={'role-' + pl.id} options={[primary,replica,canary]} value={pl.role} onChange={v => upd({ role: v })}>` replacing the old role `<select>` (same `updatePlacement` patch shape, `{ role }`). Managed-services section gained a `SectionHeader label="▸ MANAGED SERVICES"` caption; the add-row (type/scope/`provider` selects + `+ Add`, `'aws'` default per the D10a note above) is unchanged; the list rows became `EdgeRow`s (label + `:port` meta + `×`, no status dot). First test file for this component (`PlacementPanel.test.tsx`, none existed before Task 3) — 4 cases: `+ Place` dispatch, role-segmented dispatch, count-floor clamp, managed-service add-with-provider — the latter three lock pre-existing behavior that needed no restyle-driven code change, only the role case was new (the old role `<select>` had no test) |
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

**Wave-1 additions (fault injection + scenario timeline, 2026-08-01 onward):**

| File | Role |
|---|---|
| `src/lib/worldEngine/faults.ts` | Pure fault-type definitions and impairment math (FEAT-001/002: down/cpu-brownout/memory-leak faults + latency-add, error-inject helpers; FEAT-009/010: `LinkEndpoint`/`PartitionFault` types + `impairmentFor` directional health checks) — do not import any store or worldEngine subsystem, only types |
| `src/lib/world/types.ts` | Wave-1 additions: `FaultSpec`/`FaultScope` union types on root, `ScenarioFrame` + `Scenario` types; hub file, sequence with other Wave-1 mutators |
| `src/lib/worldEngine/types.ts` | Wave-1 additions: `FaultInjection` field on `EngineState`/`WorldEngineApi`, `impairmentMemo` on per-step state; Task 12 added a MINIMAL `WorldEngineApi.setPartition`/`healPartition` pair (thin wrappers over `faults.ts`'s `addPartition`/`removePartition`) ahead of Task 13, which owns the full partition-authoring surface — Task 13 should extend this, not duplicate it; frozen contract, additive-only, see `.superpowers/sdd/contract-drift.md` |
| `src/app/store/simulation.store.ts` | Wave-1 additions: `setFault`/`setPartition` actions, `impairmentMemo` selector; hub file, sequence with other Wave-1 mutators |
| `src/app/world/panels/WorldPanel.tsx` | Wave-1 additions: `ScenarioPanel` integration + Chaos split-control (5 call sites); hub file, sequence with other Wave-1 mutators |
| `src/lib/worldEngine/routingRuntime.ts` | Task 12 (split-brain enabler): `runHealthChecks` needed NO functional change — its debounce is already keyed generically by `scopes[].id`, so index.ts feeding it composite `region-pair:${observer}->${target}` ids (one per ordered region pair, alongside the existing plain-id entries) gives each DIRECTION its own independent consecutive-failure counter for free. Comment-only change here; see index.ts for the actual mechanism |
| `src/lib/worldEngine/index.ts` | Task 12: the step function now computes a per-(observer region, target region) directional health view (`regionSeesRegionDown`) via `impairmentFor(fromIds=target, toIds=observer, partitions)` — an observer sees a target as down iff the TARGET→OBSERVER leg is impaired (the response-leg direction) — batched through ONE `runHealthChecks` call alongside the existing global region/AZ scopes. Falls back to the target's own non-directional `checkFailed` when no partition is active (byte-identical to pre-Task-12 behavior). A SEPARATE, narrower promotion path (right after the existing `promoteReplicas` call) handles the case `promoteReplicas`' same-region-only sibling rule can never reach: a replica placed in a DIFFERENT region than every authored primary of its blueprint self-promotes when its own region cannot directionally reach any of those primaries' regions, and fails back (clears `s.failover.promotedAt`) once reachability returns — this is DELIBERATELY independent of, and does not modify, `promoteReplicas`'/`failover.ts`'s same-region sibling-selection semantics |

---

### L. Server interior board — Phase 3 Level-4 view (`src/app/world/server/`, 2026-07-09)

The "circuit board" view: drilling into a single server renders a fixed 1000×560 logical
stage (`ServerView.tsx` composition root → `ServerBoard.tsx` stage) with resident service
chips wired to a NIC/firewall gate on the left and a unified hardware platform on the right.
Built across Tasks 1/3/4/5 (this doc previously only tracked the engine-side Task 2 particle
work in §K — the view-side files below went undocumented until Task 4; backfilled here).

| File | Role |
|---|---|
| `src/app/world/server/boardLayout.ts` (Task 1, 292 lines) | Pure layout functions, no React: `layoutServerBoard(server, doc, compiled)` computes the fixed-zone `BoardLayout` (nic/gate/chips/stacks/**hardware** boxes at hardcoded logical coordinates — D2) plus `chips[].{inAnchor,outAnchor}`/`anchorFor`/`tracePath` (SVG path strings, nic-endpoints routed through the firewall gate). `serverTraces(serverId, doc, compiled)` collapses `compiled.paths` into one `StaticTrace` per unique `(fromId,toId,protocol)` **from this server's own resident sources**, off-server/managed targets collapsing to `nic:<serverId>` (D3/D6), plus one `nic→chip` inbound trace per resident with a public port. **2026-07-09 (Task 7 — inbound-target-trace enhancement, D7 acceptance story):** a third loop walks `compiled.paths` again for paths whose **target** (not source) is a resident of this server and whose source is off-server, emitting `nic:<serverId>→residentTargetId` carrying that path's *real* verdict/label. This exists because `firewallVerdict()` (engine-side, `worldEngine/networkRuntime.ts`) evaluates a path's firewall check against the **target** server, not the source — so a resident's own firewall denying an inbound dependency was, before this loop, only ever visible as an *outbound*-blocked trace on the calling server's board, never on the board of the server whose firewall is actually the fix point. Keyed the same `${nicId}→${toId}→${protocol}` way as the other two loops (merges into the same `byKey` map, escalating to `blocked` if any underlying path is blocked, same as the outbound loop); intra-server paths are explicitly skipped (`from.serverId === serverId` bails) since the first loop already covers them from the source side. `attributeCores(coreCount, instances)` (also Task 1) does greedy per-vCPU blueprint attribution from live `cpuCoresUsed` — sort instances desc, each claims whole cores then a fraction of the next; a core's `dominantBlueprintId` is null when idle. Consumed by `ServerBoard.tsx`/`TraceLayer.tsx`/`HardwarePlatform.tsx`(via `CoreAttribution` type)/`ServerView.tsx`/`PacketLayer.tsx` (Task 5, reuses `tracePath`/`anchorFor`/`gate` for particle geometry — no boardLayout changes needed). **Task 5 fix wave:** `BoardLayout` gained an additive field, `residentInstanceIds: string[]` — every resident instance id, computed as `residents.map(i => i.id)` **before** the `.slice(0, MAX_BOARD_CHIPS)` that produces `chips`, so unlike `chips` (capped at 12) it's never truncated. This is the attribution source `gateStats.blockedPerSecond` needs (see that row below); `chips.map(c => c.instanceId)` undercounts on any server with more than 12 residents. **2026-07-12 fix wave:** gained a second additive field, `ghostChip: Box` — the next process-column slot (itself centered when the column is empty, clamped on-stage) where `ServerBoard.tsx` renders the "+ service" authoring affordance. Unit-tested (`boardLayout.test.ts`) — the Task 7 inbound-target-trace loop is covered by cases asserting a real firewall-deny surfaces on the **target** server's traces with the correct label, and that intra-server paths aren't double-counted between the outbound and inbound-target loops |
| `src/app/world/server/selection.ts` (Task 3, type-only) | `BoardSelection` discriminated union — every selectable thing on the board (`instance`/`nic`/`firewall`/`rule`/`stack`/`volume`/`hardware`/`core`). Pure types, no logic; unchanged since Task 3 — **Task 6** is the task that actually wired a real `useState` holding a nullable `BoardSelection` (in `ServerView.tsx`) to consume it, no type changes needed |
| `src/app/world/server/InspectorRail.tsx` (Task 6, editing forms mounted Task 7, ~115 lines) | The HUD inspector rail (replaces T3's empty `<aside>` placeholder): one read-only panel per `BoardSelection` kind, keyed off `selection.kind`. Reads `doc` (`useWorldStore`) + compiled instances (`useCompiledWorld`) + live/scrub-aware metrics (`useServerDisplayMetrics`) — the panel body itself still performs no world-store writes; **Task 7** mounts each panel's matching edit form from `./inspectorForms.tsx` at the bottom of its body (own row below), which is where all writes actually happen. `instance`: blueprint name, runtime type + stack/port-binds (container only), live cpu/mem vs. `cpuLimit`/`memLimitMb` with a `⚠` at ≥90% of the mem limit, p50/active-conn footer, then `<WorkloadForm blueprintId={inst.blueprintId}>` always and `<RuntimeForm placementId={inst.placementId}>` when the placement's runtime is a container. `firewall`/`rule`: rule rows in **array order** (`server.firewall` is evaluated first-match-wins, default-deny — the panel repeats that note verbatim) each `data-testid="fw-rule-row"`, `onClick` drills into `{kind:'rule', ruleId}` (a `rule` selection re-renders the same list with the matching row background-highlighted, not a separate view), then `<FirewallEditor serverId>` (mounted for both `firewall` and `rule` selection kinds, since they share one branch). `stack`: networks/volumes/live container members (filtered from `compiled.instances` by `runtime.stackName`), then `<VolumesEditor serverId stackName={selection.stackName}>`. `volume`: size + consumer blueprints (`doc.blueprints` filtered by `volumeName`) — read-only, no form (volumes are edited from the owning `stack` panel, not the drilled-down `volume` panel). `hardware`/`core`: per-part live readouts (cpu cores+steal / ram used-of-total / disk io%, or one core's utilization) — read-only, no form. `nic`: link speed + live in/out — read-only, no form. Empty selection renders a muted hint (`click any element ... to inspect`). 9-test jsdom suite (`InspectorRail.test.tsx`, 4 read-panel tests from Task 6 + 5 form/edit-lock tests from Task 7) drives the component and the exported forms directly with hand-built `BoardSelection` values / seeded docs (no `ServerView`/`ServerBoard` involved). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** the `header(title)` helper now renders through kit `SectionHeader` (`label={'▸ INSPECTOR — ' + title}`, default teal glow) instead of a hand-rolled div with the hardcoded `#7CFFE9`/`#14332E` hexes — those two hexes are gone from this file. Body `marginTop` values moved from 6/7px to a flat 8px rhythm across every selection branch. The `firewall`/`rule` branch was restyled into one amber-bordered frame (`1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)` border, `color-mix(in srgb, var(--color-warning) 4%, transparent)` background, per the Global Constraints — no new hexes) wrapping a `▼ evaluated top-down · first match wins ▼` caption, the `fw-rule-row` rows (now showing an order number, `ALLOW`/`DENY` in `--color-success`/`--color-danger`, `:port protocol`, and `from {source}` — same `data-testid`, same `onClick={() => onSelect({kind:'rule', ruleId})}`, same array order), the mounted `<FirewallEditor>`, and a `▼ everything else: DENIED ▼` footer in `--color-danger`. The pre-restyle standalone `first match wins · default deny` caption (which sat above the frame) was DROPPED rather than kept alongside the new in-frame caption — keeping both created two independent DOM nodes each matching `InspectorRail.test.tsx`'s pre-existing `getByText(/first match wins/i)`, which throws on multiple matches (verified empirically: keeping both is a genuine regression, not a hypothetical); dropping the standalone line leaves the in-frame caption as script's only match, so that assertion passes unchanged. Added 1 new test (order numbers + both flow captions + per-row ALLOW/DENY/source content) instead, all 12 green. **2026-07-10 (Polish 2 Task 6 — plain words):** rule rows re-voiced from `ALLOW`/`:port protocol`/`from {source}` into a plain sentence built from `./ruleSentence.ts`'s exported pieces (`ruleSourceWords`/`rulePortPhrase`) — `Let`/`Block` (was `ALLOW`/`DENY`, still `--color-success`/`--color-danger`), a bold `#DBEAFE`-tinted source phrase (`anyone`/`internal traffic`/verbatim CIDR), `reach`/`reaching`, a bold `#DBEAFE`-tinted port phrase (service word + `:port`, or bare `:port`, or `any port`), and a trailing ` udp` only for that protocol — same `data-testid="fw-rule-row"`/ordinal span/row styling/selected-highlight as before. Click behavior is now a **toggle**: not-selected → `onSelect({kind:'rule', ruleId})` (unchanged), already-selected → `onSelect({kind:'firewall'})` (collapses back) — previously every click re-selected the same rule with no way to collapse. `<FirewallEditor>` now mounts **only** when `selection.kind === 'rule'` (was: always, for both `firewall` and `rule` selection) — "clicking a row toggles its edit inputs" (D7). `./inspectorForms.tsx` is untouched; every write dispatch it owns is unchanged. Existing `firewall stack renders order numbers and flow captions` test updated (`'ALLOW'`→`'Let'`, `'DENY'`→`'Block'`, `'from any'`→`'anyone'`; ordinal/caption/DENIED assertions byte-identical); `firewall selection lists rules in order and drills into a rule` needed no change (click from a non-`rule` `{kind:'firewall'}` selection still fires `onSelect({kind:'rule', ruleId:'r2'})`). One new test (`firewall reorder and remove dispatches are unchanged after the re-voicing`) confirms the sentence read view + `FirewallEditor`'s reorder dispatch both fire correctly once a rule is selected — 13 rail tests total, all green |
| `src/app/world/server/ruleSentence.ts` (Polish 2 Task 6, new, node-env tested) | Pure plain-words rendering of a single `FirewallRule` — the single copy source `InspectorRail.tsx` renders piecewise (tint/bold spans) and this module's own `ruleSentence()` returns as one string for tests/future consumers. `PORT_SERVICE_WORDS` (443 https / 80 http / 5432 postgres / 6379 redis / 22 ssh) feeds `rulePortPhrase()` (`'any port'` for `port==='any'`, else `` `${svc ? svc + ' ' : ''}:${port}` ``); `ruleSourceWords()` maps `'any'→'anyone'`, `'internal'→'internal traffic'`, else the CIDR verbatim. `ruleSentence()` composes `Let/Block {source} reach/reaching {port}{' udp' if protocol==='udp'}` — protocol is voiced ONLY for `udp` (not `tcp`/`any`) so the factory default rule (`allow any any internal`) reads `'Let internal traffic reach any port'` rather than trailing `'... any port any'` (plan decision 11). No React/store import — pure functions, `ruleSentence.test.ts` (4 cases, node env) locks the five canonical strings. Sole consumer: `InspectorRail.tsx` (imports `ruleSourceWords`/`rulePortPhrase`, not `ruleSentence` itself — the rail needs the pieces separately for per-span tinting) |
| `src/app/world/server/inspectorForms.tsx` (Task 7, ~125 lines) | `WorkloadForm`/`RuntimeForm`/`FirewallEditor`/`VolumesEditor` — the only world-store **write** surface for the server-interior board (everything else in `src/app/world/server/` is read-only). Each form is the sole caller of one `world.store.ts` patch-merge action: `WorkloadForm` → `updateBlueprint(blueprintId, {workload, color})`; `RuntimeForm` → `updatePlacement(placementId, {runtime})` (container-only — a process-runtime placement renders an explanatory string instead of a form; count/role/runtime-type switching is deliberately absent here, that stays in the Placements panel per the D7 boundary); `FirewallEditor` → `updateServer(serverId, {firewall})` (adds/removes/reorders/edits `FirewallRule` rows — reorder is a plain array-swap so first-match-wins semantics fall out of array order, no separate priority field); `VolumesEditor` → `updateServer(serverId, {stacks})` (resizes/adds/removes one stack's `ComposeVolume[]` by rebuilding the full `stacks` array with that one stack replaced). Every form is wrapped in `<fieldset disabled={running}>` (`running` from `useSimulationStore`, D9) with a muted "stop simulation to edit" note when locked — native `fieldset disabled` cascades to every descendant input/select/button, so no per-control disabled prop is threaded manually. A shared `NumberField` (local `useState` for the raw text, commits on blur/Enter) clamps to finite ≥0 and reverts to the last committed value on invalid input **without calling the store** (no update fires for `NaN`/negative/non-numeric text). All patches are plain object literals against the existing patch-merge actions — recompilation is automatic via `useCompiledWorld`'s doc-keyed memo, no direct `compileWorld` call in this file. No new store actions were added (`updateManagedService` does not exist and was not needed — managed services aren't editable from this board). Covered by the 5 new cases in `InspectorRail.test.tsx` (workload → `updateBlueprint`, firewall reorder → exact swapped array, an allow rule added above a deny → asserted against a **recompiled** `compileWorld(doc)` fixture, not the DOM, invalid numeric input → zero calls, all forms disabled while `running`). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** font sizes bumped from the illegible 6.5px/7px scale to a 10/10.5px scale (the `WORKLOAD`/`LIMITS` captions, the shared `NumberField`'s input, and `FirewallEditor`'s per-rule row all gained explicit sizes); the shared `NumberField`/`FirewallEditor` input and select styling (`inp`/new `sel` consts) moved off hardcoded hexes (`#2A3648`/`#E2E8F0`) onto `--color-node-border`/`--color-text-primary` tokens. `FirewallEditor`'s row gap widened 3→4px; its `action`/`protocol` `<select>`s now use the same token-styled look. Every `aria-label` and dispatch (`updateBlueprint`/`updatePlacement`/`updateServer`) is byte-for-byte unchanged — no test in `InspectorRail.test.tsx`'s "inspector editing forms" describe needed updating |
| `src/app/world/server/ServerBoard.tsx` (Task 3, live-wired Task 4, packets Task 5, selection/cross-highlight Task 6) | The stage: scale-to-fit via `ResizeObserver`, PCB grid background, layer stack `TraceLayer` (SVG z0) → `StackPlate`/`NicBlock`/`FirewallGate`/`ServiceChip`/**`HardwarePlatform`** (DOM z1) → `PacketLayer` (canvas z2, **Task 5**). **2026-07-09 (Task 4):** calls `useServerDisplayMetrics(serverId)` and derives, every render: `residentBlueprints` (color/name/`ramBaseMb` per resident chip, sourced from `doc.blueprints[bp].workload.ramBaseMb` — feeds `HardwarePlatform`'s at-rest RAM estimate, D5), live `attribution` via `attributeCores(server.specs.vcpu, ...)` fed from `display.instances[id].cpuCoresUsed`, and `memLimits`/`instanceRamMb` (container `runtime.memLimitMb` + live per-instance `ramMb`, for the RAM reservoir's oom warning). Mounts `HardwarePlatform` absolutely-positioned at `layout.hardware.box`; passes live `connLabel`/`health` into each `ServiceChip` and live `inMbps`/`outMbps`/`utilFraction` into `NicBlock`; renders a "● scrubbing" pill (top-right of the outer, unscaled container) when `display.scrubbing`. **2026-07-09 (Task 5):** mounts `<PacketLayer serverId layout>` at the z2 slot, and separately selects `events`/`latestBatch` straight from `useSimulationStore` (bypassing `useServerDisplayMetrics` — events aren't part of the scrub-aware metrics pyramid it wraps) to compute `gateStats.blockedPerSecond(events, serverId, layout.residentInstanceIds, latestBatch?.simMs ?? 0)` each render, passed into `FirewallGate`'s `blockedPerSecond` prop. **Task 5 fix wave:** the third argument was `layout.chips.map(c => c.instanceId)` (capped at `MAX_BOARD_CHIPS`) until this fix; now passes `layout.residentInstanceIds` (untruncated) so blocks on overflow instances (>12 residents) are attributed too. **2026-07-09 (Task 6 — the props were already typed as nullable `BoardSelection`/`BlueprintId` since Task 3, but every call site fed `null`/no-ops until now):** per-chip `dimmed = hoveredBlueprintId !== null && chip.blueprintId !== hoveredBlueprintId`, `hovered = chip.blueprintId === hoveredBlueprintId`, `selected = selection?.kind==='instance' && selection.instanceId===chip.instanceId`, all three passed into `ServiceChip`. Each `StackPlate` gets `dimmed` computed from whether *any* of its own container chips' `blueprintId` matches `hoveredBlueprintId` (not just the plate's own identity — a stack dims only when none of its residents are the hovered blueprint). `NicBlock`/`FirewallGate` now also receive `selected` (true for `kind==='nic'` on `NicBlock`; true for `kind==='firewall'` or `kind==='rule'` on `FirewallGate`) — those two components already declared the prop since Task 3, this task just started feeding it; neither component file itself changed. `TraceLayer` already received `selection`/`hoveredBlueprintId` as props since Task 3 (call site unchanged) but didn't use them until Task 6's change inside `TraceLayer.tsx` itself (see that row). **2026-07-12 fix wave:** the `ResizeObserver` scale-to-fit is REPLACED by `az/useFloorCamera` (fit + wheel zoom-at-cursor + drag-pan, board-specific `BOARD_INTERACTIVE_SEL` exclusion so chip/nic/gate/stack/trace clicks never start a pan; screen-space `fit` button + `scroll = zoom · drag = pan` hint), and the board gained the authoring-only "+ service" ghost chip at `layout.ghostChip` — an inline blueprint `<select>` dispatching `addPlacement(blueprintId, serverId)` (the SAME dispatch as the dock's ServicesDrawer mount line), hidden while running, disabled with a create-a-blueprint-first title when no blueprints exist |
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
| `src/app/world/region/TimelineStrip.tsx` (Task 3) — **DELETED, replaced by `TimelineV2.tsx`/`timelineModel.ts` (Polish 4 Task 6, §X)** | Historical: same "scoped mini-view" shape as `AzRow`/`CrossAzColumn`, not a passive leaf either: took only `regionId`, read `useWorldStore`/`useSimulationStore`/`useCompiledWorld` itself and called `regionData.ts`'s `regionEvents` inline. Rendered a 120s-window simMs axis of event glyphs (keyed by `EngineEventKind`); click-to-scrub (disabled while `running`) found the nearest replay frame by `simMs` distance from `getReplayFrames()` and called `setScrubIndex` — the same nearest-frame-by-distance approach `ScrubberV2` (§1J) uses. That scrub-click logic was carried verbatim into `TimelineV2.tsx`; see §X for the swimlane replacement |
| `src/app/world/RegionView.tsx` (Task 2, REWRITTEN; mount swapped Polish 4 Task 6, §X) | Composition root, but a **mixed** one, not a uniform "compute everything, pass props down" root like `ServerBoard.tsx` (§L): it centrally computes `shares`/`alert`/`spark` (via `regionData.ts` + a 1s-polling `useEffect` for the sparkline) and feeds the finished values into `SplitLines`/`AlertRibbon`, but merely threads `azId`/`regionId` into `AzRow`/`CrossAzColumn`/`TimelineV2` (§X, formerly `TimelineStrip`), which then independently re-derive their own data (see above — this halves the "single source of truth per render" property `boardLayout.ts` gives `server/`). Preserves the existing Phase-2 region-outage button verbatim (`healthOverrides`/`setOutage('region', …)`). Owns the alert ribbon's "timeline" click-through (`scrollIntoView` + a CSS-class flash on the timeline wrapper div, timed out at 1200ms — same wrapper, now around `TimelineV2`) |
| `src/lib/world/layoutRacks.ts` (Task 4) | Pure rack-frame layout, the Level-3 analog of `server/boardLayout.ts` (§L): groups `Server`s by `rack.rackId` into `RackFrame`s, re-stacks by `rack.unit` with a collision-safe pass (each server claims `max(its own authored unit, the next free slot)`, so overlapping authored units — e.g. every server defaulting to `unit:1` — never collide), computes blank-unit filler spans (capped `MAX_FILLERS=3` per frame) and a PDU strip position, plus a separate absolute-positioned managed-service column. Deterministic, no React. **Narrower fan-out than the skeleton implies:** only `AzCanvas.tsx` imports the `layoutRacks` function itself (consuming `RackLayout`'s shape structurally/by inference — it never names `RackLayout`/`RackFrame` in an explicit type import); `RackNodes.tsx` imports **only four pixel constants** from this file (`RACK_PAD`/`RAIL_W`/`CHASSIS_W`/`PDU_H`), not the function or either type — its own `RackFrameNodeData`/`RackChassisNodeData` shapes are separately declared and matched to what `AzCanvas.tsx` hand-assembles only by an `as` cast inside `RackNodes.tsx`, not a shared imported type (see Blast radius). Replaces `layoutAzGrid` for the AZ canvas |
| `src/lib/world/layoutAz.ts`, `src/app/world/WorldServerNode.tsx` — **both DELETED in the same commit (Task 5, `d6eff49`)** | `layoutAzGrid`'s only caller and `WorldServerNode`'s only caller were the same file (`AzCanvas.tsx`), rewired to `layoutRacks`/`RackFrameNode`/`RackChassisNode` in this commit — grep-verified zero remaining importers of either before deletion. `layoutAzGrid`'s grid-position algorithm has no successor (rack framing replaces the whole positioning model); `WorldManagedNode` was moved (not duplicated) into `RackNodes.tsx` in the same commit before the source file was deleted |
| `src/app/world/RackNodes.tsx` (Task 5) | `RackFrameNode` (non-interactive backdrop — `pointerEvents: 'none'`, mounting rails, `RACK <id> · <azLabel>` caption, blank-unit filler strips, a `PDU · <n>kW` strip) + `RackChassisNode` (LED trio — health/activity-blink/network — drive-bay grid sized `bays = min(8, 2×heightU+2)` with lit bays proportional to `diskIo`, a vent-grill strip, cpu/ram/io micro-bars, a "▲ noisy neighbor" tag, an "✕ N blocked internal path(s)" badge) + `WorldManagedNode` (moved verbatim, dashed-border, unchanged visuals). **`RackNodes.tsx` owns all chassis/frame chrome** — it renders no geometry math of its own, only the `data` object `AzCanvas.tsx` hands it. Notably, `RackFrameNodeData.pduKw` is **not** part of `layoutRacks.ts`'s pure geometry (that module only computes `pduY`, a position) — it's domain data (`Σ resident servers' vcpu × 0.05`) computed by `AzCanvas.tsx` and merged onto the frame node's `data` alongside the geometry, the same geometry/domain-data split `boardLayout.ts`/`ServerBoard.tsx` (§L) established |
| `src/app/world/AzCanvas.tsx` (Task 5, rewired) | Same edge-aggregation logic as Phases 1–3, unchanged (`compiled.paths` → one aggregate edge per server pair via a `Map` keyed `${fromServerId}->${targetId}`, `internalBlockedByServer` for same-server blocked paths, cross-AZ paths skipped — "render at region level"). Node-building now goes through `layoutRacks`: frame nodes (`type: 'worldRackFrame'`, `selectable: false`, `zIndex: -1`, React Flow parents) each merge in a computed `pduKw`; chassis nodes (`type: 'worldChassis'`, `parentId` set to the string `frame:<rackId>`, `extent: 'parent'`, `draggable: false`) merge in live `health`/per-chassis `metrics` (cpu mean/ram fraction/disk io/nic fraction/rps, all derived from `batch.servers[id]` + resident instances) and a `noisy` flag (a `noisy_neighbor` event on this server within the trailing 30s); managed nodes stay absolute. `onNodeClick` still checks `node.type === 'worldChassis'` before calling `goServer` — the click-routing contract survived the rewire unchanged |
| `src/app/world/AzSimOverlay.tsx` (Task 6, v2) | Switched from `getNode(id).position` + a reactive `useViewport()` selector to `getInternalNode(id).internals.positionAbsolute` (resolves correctly through the new parent/child rack nesting, where a plain `.position` would be frame-relative) + `node.measured?.width/height` (falls back to the old fixed `SERVER_W/H`/`MANAGED_W/H` constants only pre-paint, since chassis heights now vary by `heightU` rather than being uniform) + an imperative `getViewport()` read **inside** the frame callback instead of a subscribed hook value. **Correction to the skeleton's own acceptance line:** the effect's dependency array is **`[running, azId, reduced, getInternalNode, getViewport]`** — five entries, not the three (`[running, azId, reduced]`) the task brief asked this integration pass to confirm. The fix is real regardless: `getInternalNode`/`getViewport` are React-Flow-memoized, referentially-**stable** function references (per the file's own header comment, verified against `@xyflow/react`'s source) that never themselves change across a render, so their presence in the array is inert — it's `useViewport()`'s **value** (zoom/x/y, which changes every pan/zoom tick) that used to sit in this array and drove the re-subscribe bug, and that reactive read is genuinely gone, replaced by the imperative call inside the callback. The Phase-2/3 standing deferral is correctly resolved; the brief's specific dependency-array text just wasn't literally what got written |
| `src/app/store/world.store.ts` (Task 7) | `addManagedService` gained a 5th, optional `provider?: ManagedService['provider']` parameter, defaulted `= 'generic'` inside the action body — additive; every pre-existing 4-arg call site (all in test fixtures — `world.store.test.ts`, `costModelV2.test.ts`) is unaffected. One production call site: `PlacementPanel.tsx` |
| `src/app/store/world.store.ts` (managed-service-modal plan, Task 2) | `addManagedService` gained a 6th, optional `config?: Partial<ManagedService>` parameter — same additive trailing-param pattern as the Task 7 `provider` addition directly above, still ONE `mutate()` call (one undo/history entry). `config` is merged over the engine-derived DB defaults (`instanceClassId`/`replicaCount`/`multiAz`/`storageGb`), with explicitly-`undefined` keys stripped first (on this CREATE path, `undefined` in `config` means "nothing to set," not "clear" — that clear-semantics distinction is `updateManagedService`'s alone, untouched by this task) and `id` re-assigned after every spread so `config` can never override the entity's identity even if a future caller mistakenly included one. Grep-confirmed 23 existing `addManagedService(` call sites (22 test fixtures + 1 production — `PlacementPanel.tsx` from Task 7's note above no longer exists, superseded by `ManagedPanel.tsx`; as of this plan's Task 4, the actual dispatch call site moved again, into `ManagedServiceModal.tsx`, which `ManagedPanel.tsx` now mounts — see the Phase 5 entries below) all still compile unchanged (`tsc` clean) since the new param is optional and trailing. Precedent for a future modal (plan Task 3) to pass a `draftToConfig(draft)` result (`src/lib/world/managedDraft.ts`, plan Task 1) as this argument on the Create path |
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
self-sufficient scoped views that read stores directly (`AzRow`/`CrossAzColumn`/`TimelineV2`)
— see the file table above; a future contributor extending this page should be deliberate about
which shape a new section follows, since both currently coexist. **`TimelineV2` (§X) diverges
further still**: it's the one `region/` view that reads its data through a dedicated pure model
file (`timelineModel.ts`) rather than computing inline or calling straight into `regionData.ts`
— `AzRow`/`CrossAzColumn` remain "self-sufficient scoped view calls `regionData.ts` inline."

**Frozen-contract note:** `regionData.ts`'s `CROSS_AZ_HOP_MS = 1.5` is a **local mirror**, not an
import, of `worldEngine/networkRuntime.ts:10`'s private (non-exported) `CROSS_AZ_MS` (confirmed at
that exact line in the committed source) — the design spec's D5 named `worldEngine/latency.ts` as
the source, but that file exports only sampling functions (`sampleLatencyMs(p50, p99, rng)`, plus
`sampleSizeMultiplier(sigma, rng)` as of the slice-3 NIC-burst-tail work) — not a constants
module; exporting the real constant would be a code change under `worldEngine/`, which
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
`timelineModel.ts` — one more consumer than the "four region/ components" the draft assumed,
since Task 3's `TimelineStrip.tsx` (→ Polish 4 Task 6's `timelineModel.ts`, §X) also calls in
(`regionEvents`; `TimelineV2.tsx` itself does not call `regionData.ts` directly, only through
`timelineModel.ts`). Of its exported **types**
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
| `src/app/world/globe/TrafficPlacementLayer.tsx` (2026-07-12, Polish 4 Task 7, §X) | Mounted as a `GlobeScene` child (same rotating-group-for-free trick as the row above), active only while `placeMode`. A transparent raycast sphere (`r≈1.0005`) tracks `onPointerMove` → `vec3ToLatLon` → `nearestCity` snap → local `city` state; renders a dashed crosshair ring at the snapped city (2s visibility-toggle blink — a RATIFIED bounded motion exception, static under `useReducedMotion()`), a drei `Html` preview card (who/how much/where/latency/egress, `regionOrderFor(city, doc)[0]` for the EXACT landing region — not an estimate), and ONE static dashed `THREE.Line` ghost arc to the landing region, built imperatively in a `useEffect` (same primitive-object pattern as `ArcsLayer.tsx`'s pool, minus the pool and the per-frame dash-flow — rebuilt only when the snapped city/landing pair changes, never per frame). Does NOT handle click — `GlobeScene.tsx`'s `Earth` component's existing placeMode click still commits (no second commit path). Not jsdom-tested (WebGL); its math (`nearestCity`/`regionOrderFor`/`placementEgressUsdPerHr`) is covered by the three pure-helper test files those functions live in |
| `src/app/world/GlobeCards.tsx` (Task 3) | The pre-Phase-5 card grid, extracted verbatim from the old `GlobeView.tsx` — the WebGL-unavailable fallback AND the permanent a11y/screen-reader path (the canvas is `aria-hidden`, so a visually-hidden region-nav list is duplicated into both branches of `GlobeView.tsx`, not just this one) |
| `src/app/world/GlobeView.tsx` (Task 3, extended Task 6) | Composition root: `webglAvailable() ? <GlobeScene>{RegionPins,PopulationMarkers,ArcsLayer}</GlobeScene> : <GlobeCards/>`, plus the a11y list in both branches. **Task 6** gave it a `GlobeViewProps { placeMode; onExitPlaceMode; onPopulationPlaced }` — it does NOT own `placeMode` itself (see the Boundary rules note below on why) — and a `handlePlace(lat,lon)` that calls `addPopulation` + disarms + reports the new id up, passed as `GlobeScene`'s `onPlace`. **2026-07-12 (Polish 4 Task 7 — globe traffic placement, §X):** mounts `TrafficPlacementLayer` (new `globe/` sibling, above) inside `GlobeScene`'s children; gained a 4th prop, `onTogglePlaceMode: () => void` (threaded from `WorldShell.tsx`, the SAME callback `WorldPanel`'s `TrafficPanel` toggle already used — two arms, one state); a new HUD `+ traffic` button next to the pre-existing `rotation:` button (armed label `+ traffic — click a city`, `disabled={running}` + `title="stop the simulation to edit"`, an `esc = cancel` hint beside it while armed). `onPlace(lat,lon)` now SNAPS via `nearestCity` before calling `addPopulation` — the placed population's `label` is the city's name (not a `pop-N` counter; `nextPopulationLabel` remains TrafficPanel's own "+ add" label source, untouched) — then additionally opens the new population's overlay (`setSceneOverlay({kind:'population', id})`) so its rps slider is visible immediately, on top of the pre-existing exit/report-id calls. `GlobeScene`'s `autoRotate` prop gained `&& !placeMode` (rotation now also pauses while armed, not just while an overlay is open) |
| `src/lib/worldEngine/index.ts` (Task 2, `buildArcs` only) | Extended (additive, no type change) to also emit `kind:'inter-region'` arcs (aggregated cross-region dependency flows, region→region, intensity by rps share) and `kind:'drain'` arcs (population's failover pending, or still routed to a `down` region during the TTL-lag window) — the pre-Phase-5 `kind:'client'` arcs stay byte-identical and first in the returned array; total capped at the existing `MAX_GLOBE_ARCS=200`, order client→inter-region→drain. One new engine-internal `Map<PopulationId, RegionId>` (prev-region-during-drain memory) — logged as the phase's one informational drift item, see the Frozen-contract note |
| `src/app/world/panels/TrafficPanel.tsx` (Task 6) | Three sections (POPULATIONS/TRAFFIC/ROUTING) writing through the pre-existing `world.store.ts` actions only (Phase 5 adds none) — see the Boundary rules note. `placeMode`/`selectedPopulationId` arrive as props, NOT read from a store — the panel is a pure controlled component over state `WorldShell.tsx` owns (see next row). **2026-07-10 (Polish 1 Task 4 — hybrid instrument restyle):** presentation-only pass onto the shared kit (`src/app/world/ui/kit.tsx`) and `ttlLagHint` (`src/app/world/ui/derived.ts`) — every dispatch above is byte-for-byte unchanged. Each section caption became a `SectionHeader` (`▸ POPULATIONS`/`▸ TRAFFIC`/`▸ ROUTING`); population rows are now `EdgeRow`s with a small `var(--kit-teal)` signature-dot `<span>` prefixed to the unchanged six controls (label/lat/lon/rps/diurnal/remove), draft row and `+ add`/`+ place on globe` untouched. The routing-policy `<select>` became `<Segmented ariaLabel="routing-policy" options={[⚡ latency, 🌍 geo, ⚖ weighted, priority]}>` (`onChange={v => updateRouting({policy: v})}`, identical patch shape); an `Explainer` below it swaps per active policy (one of four fixed strings — see the component for verbatim text). `dnsTtlSec` became a `DerivedField` (input mode, `min={1}`, `deriveTone="warning"`, `derive={v => ttlLagHint({...doc.routing, dnsTtlSec: v}) ?? ''}`) — the derived hint line only renders while TTL < detection window, mirroring `ttl-outlives-detection`'s inequality (`capacity.ts`); `healthCheckIntervalMs`/`healthCheckFailureThreshold` keep their original `<label><span>+NumberField</span></label>` markup unchanged. Weighted/priority sub-editors are unchanged rows below the explainer. Added 2 tests (`TrafficPanel.test.tsx`: Segmented-click dispatches `policy`+ explainer text, TTL-hint appears/clears across a commit) plus mechanically updated the pre-existing weighted/geo policy-switch test's two `fireEvent.change` interactions to `fireEvent.click(screen.getByText('⚖ weighted'))` / `fireEvent.click(screen.getByText('🌍 geo'))` — every store assertion in that test is untouched, all 12 green |
| `src/app/world/panels/WorldPanel.tsx` (Task 6) | Gained a `'traffic'` tab entry and three new required props (`placeMode`/`onTogglePlaceMode`/`selectedPopulationId`), threaded straight through to `TrafficPanel` inside the existing `<fieldset disabled={running}>` — no new gating logic |
| `src/app/world/WorldShell.tsx` (Task 6) | Owns `placeMode`/`selectedPopulationId` `useState`s and threads them to both `GlobeView` and `WorldPanel` — the ONLY place they can live, since those two are siblings in `WorldShell`'s `flex` row (not parent/child), and `TrafficPanel` (a `WorldPanel` descendant) needs to toggle the same boolean `GlobeView`'s `GlobeScene` reads to arm its raycast handler. No new store — this is Zustand-free, plain lifted `useState`, per the Phase 5 constraint that no store action was added. **2026-07-12 (Polish 4 Task 7 — globe traffic placement, §X):** the header keydown handler's `Escape` case now checks `placeMode` FIRST — an armed placeMode disarms (`setPlaceMode(false)`) and returns before `nav.up()` runs (previously Escape always went straight to `nav.up()`, a no-op at globe level, which made an armed placement mode look un-cancelable via Escape). The effect's dependency array grew from `[]` to `[placeMode]` accordingly (closure correctness, not a behavior change to the undo/redo/other-key branches). A single `onTogglePlaceMode = () => setPlaceMode(p => !p)` is now defined once and passed to BOTH `GlobeView` and `WorldPanel` (previously `WorldPanel` had its own identical inline arrow) — same two-arms-one-state contract, just no longer two independently-defined closures doing the same thing |

**Boundary rules:** `src/app/world/globe/*` imports `three`/`@react-three/fiber`/`@react-three/drei`
(Task 1 deps, no other new dependency anywhere per Global Constraints), `lib/world/types` +
`lib/world/regionGeo` + `lib/worldEngine/types` (type-only, `VisualArc`), and app stores
(`useWorldStore` read-only `doc`, `useSimulationStore` `attachRenderer`/`scrubBatch`/
`latestBatch`/`events`, `useNavStore` `goRegion`) — nothing under `globe/` imports
`worldEngine/index.ts` (the executable engine facade) directly; only `useSimulationStore` does,
continuing the seam §K/§L/§M each independently established. **2026-07-12 (Task 7, §X) extends
this list, additively:** `TrafficPlacementLayer.tsx` additionally imports `lib/world/cityCatalog`
(new, `nearestCity`), `lib/world/routing` (`regionOrderFor` — a value import, not type-only; the
one place under `globe/` that reads compiler-adjacent logic directly rather than through
`compileWorld`'s output, justified because there IS no compiled output yet for a population that
doesn't exist), and `app/world/ui/derived` (`POP_LATENCY_KM_PER_MS`/`placementEgressUsdPerHr` —
a view→view import, `ui/` to `globe/`, both under `app/world/`, not a `lib/` boundary crossing).
Still zero imports of `worldEngine/index.ts` or any other engine-internal file. `TrafficPanel.tsx` writes through
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
(`structural`/`network`/`capacity`, 15 rules total across Tasks 1–3) run over `compileWorld`'s
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
| `src/app/world/ui/derived.ts` (Task 1, new) | Pure derived-consequence math the kit's `DerivedField` instances render — no store imports, no React (per the file's own header comment). `rpsPerCore`/`hostRpsCapacity` (workload cpu-ms → sustained rps — `BlueprintPanel.tsx`'s cpu slider), `ramAtConnections` (base + per-conn × 2,000 conns — `BlueprintPanel.tsx`'s ram/conn field), `residentRamDemandMb` (thin wrapper, below), `ttlLagHint` (`TrafficPanel.tsx`'s TTL field — `null` once `dnsTtlSec*1000 >= healthCheckIntervalMs*healthCheckFailureThreshold`, mirroring `ttl-outlives-detection`'s inequality in `lib/analysis/rules/capacity.ts`), `diskIoWord` (light/moderate/heavy banding). `residentRamDemandMb` does NOT reimplement the reserved-RAM sum — it calls `reservedRamMb`, exported from `lib/analysis/rules/capacity.ts` (that file's own header comment cross-references this one both ways), so the panel-kit's derived hint and the `ram-oversubscribed` analysis rule can never drift onto two different definitions of "reserved RAM." SIX exports total (`rpsPerCore`/`hostRpsCapacity`/`ramAtConnections`/`residentRamDemandMb`/`ttlLagHint`/`diskIoWord`), all covered by `derived.test.ts`. **2026-07-12 (Polish 4 Task 7 — globe traffic placement, §X):** gained `PLACEMENT_BYTES_EACH_WAY = 2048` (a commented pure reimplementation of `worldEngine/flows.ts`'s `BYTES_PER_REQUEST_EACH_WAY` — never imported, same never-reach-into-`worldEngine`-internals treatment `POP_LATENCY_KM_PER_MS` already established two rows up) and `placementEgressUsdPerHr(rps)` (the globe placement-mode preview card's egress-price math: `rps × PLACEMENT_BYTES_EACH_WAY × 2 each-way × 2_630_000 s/month ÷ 1024³ → GB/month`, fed through the EXISTING `egressMonthlyCost('aws', gbMonth)`/`HOURS_PER_MONTH` — `costModelV2.ts`'s own `SECONDS_PER_MONTH`/`BYTES_PER_GB` are module-private there, so those two constants are mirrored as local literals rather than imported, same treatment as `PLACEMENT_BYTES_EACH_WAY`). Hand-derived and test-verified at 500 rps (`createPopulation`'s default): ≈$0.606/hr — notably higher than the locked mockup's illustrative "+$0.09/hr" (which coincidentally equals AWS's flat $/GB rate, not a computed figure); the mockup number was never meant as a golden value, and the formula above is what the brief/spec gave verbatim, so it's what shipped |
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
| `floorData.ts` | Pure derivations, no React/store: `aggregateFlows` (a verbatim port of the deleted `AzCanvas.tsx`'s edge-aggregation block — same per-`(fromServer,target)` totals/blocked/first-reason semantics, same same-server-pairs-draw-no-edge rule, now operating on `CompiledWorld` directly since it already carries each instance's `azId`), `ledParams(cpuMean): { lit, color }` (6-LED CPU-threshold language), `meanUtilization` (T8 addition — shared by `RackCabinet.tsx`/`FreePoolPod.tsx`'s own per-slot cpuMean AND `DatacenterFloor.tsx`'s AZ-wide LED-blink ranking, replacing three independent copies of the same one-liner), and `serverAccents(doc, compiled): Map<ServerId, string[]>` (Polish 4 T3, §U — a behavior-identical extraction of `DatacenterFloor.tsx`'s pre-T3 inline `accentsByServer` derivation, now shared by `DatacenterFloor.tsx` AND `dock/AzConfigTab.tsx`'s slat ticks), and `internetIngress(doc, compiled, azId): IngressEdge[]` (**2026-07-12 fix wave** — one edge per AZ server hosting a public-port blueprint, `allowed` replicating the analysis rules' `openToAny` first-match-allow-source-any convention, NOT `network.ts`'s source-blind `evaluateFirewall`; feeds the floor's ISP-cabinet ingress lines) |
| `iso.ts` | Isometric tile projection + 3-face box geometry (roof cap + two walls sharing edges with a tile's diamond footprint), generalizing the mockup's fixed 2-rack/2-pod illustration to an arbitrary N×N `layoutFloor` grid at a fixed `VIEW_W`/`VIEW_H` (growing the ring shrinks tiles, not the scene — "the camera refits"). No React/store imports |
| `labelLayout.ts` | **2026-07-12 fix wave** (user report: pod names, the FREE POOL badge, and dep chips overlapped boxes and each other): pure floating-label placement — `estimateLabelSize(text, 'chip'\|'text')` and `placeLabels(labels, obstacles)` (greedy: each label starts at its desired rect — anchored above its box's roofline by `DatacenterFloor.tsx` — and is pushed straight UP until it clears every box bounding-rect and every earlier label; spec order = priority). No React/store imports; node-env tested (`labelLayout.test.ts`) |
| `useFloorCamera.ts` | The fit/zoom-at-cursor/drag-pan camera (post-Polish-3 fix wave): pure `clampScale`/`fitCamera`/`zoomAt` + a hook owning `{scale, tx, ty}` — native non-passive wheel listener, pointer-capture background pan, interactive-element exclusion. **2026-07-12 fix wave:** gained an optional `interactiveSel` 4th param (default = the floor's selector) so `server/ServerBoard.tsx` reuses the SAME hook for the board's camera with a board-specific exclusion list (`[data-chip]/[data-nic]/[data-firewall]/[data-stack]/path/...`) — pointer capture would otherwise retarget releases to the viewport and swallow block clicks |
| `useHoldTap.ts` | DOM/SVG pointer-event wiring around `ui/HoldToEnter.tsx`'s pure primitives (§Q) — reused, never forked. `RegionPins.tsx` (§Q) is r3f/WebGL and needs a synthetic-click swallow dance around its raycaster; real DOM elements with `setPointerCapture` don't, so tap-vs-hold-vs-abort resolves entirely in `onPointerUp` here. Pointer CAPTURE (not `pointerleave`) still governs "left mid-hold", via `exceedsHoldSlop` distance-from-press-point in `onPointerMove` — the same D1 rule §Q's hold-to-enter established, reapplied rather than reinvented. **2026-07-12 fix wave:** every release/cancel path now ZEROES `progressRef` in addition to stopping the rAF loop — `HoldRing`'s own rAF keeps painting the ref after this loop stops, so an un-zeroed abort left the ring frozen at its partial sweep forever (user report "the circle bar pops up and stays"; regression-tested in `useHoldTap.test.ts`; `RegionPins.tsx`'s r3f copy was already immune — its `useFrame` recomputes from the nulled start ref every frame) |
| `azFloorStyles.ts` | The injected-stylesheet-once idiom `region/r3Styles.ts` established, self-contained (pulls its one theme-matched token, teal, from `lib/theme.ts` rather than `ui/kit.tsx`), keyframes namespaced `az-*` so they can't collide with `region/`'s unprefixed copies or `server/`'s `hw-`/`gw-` copies. Every infinite-iteration rule (`.az-trace-animated`, `.az-led-blink`) plus the boot cascade (`.az-newslot.go`, one-shot `forwards`, not `infinite`) is neutralized under `@media (prefers-reduced-motion: reduce)` |
| `RackCabinet.tsx` | One rack cabinet: 3-face isometric box, hover lift + halo (CSS `transition`, not `animation` — excluded from the motion budget), one `RackSlot` per resident (tap selects, hold drills in via `useHoldTap`). Height grows with occupancy up to `capacityU`. `RackSlot`'s LED blink is now gated on an `animatedLed` prop (T8, see the motion-budget table below) in addition to `lit > 0`/reduced-motion |
| `FreePoolPod.tsx` | One free-pool (unracked) server: same 3-face box + LED language as a `RackSlot`, one pod = one whole box, no internal slat stack. Same tap/hold interaction, same boot-cascade treatment, same T8 `animatedLed` gating |
| `DatacenterFloor.tsx` | Composition root: reads `doc`/`compiled`/`batch`/`nav`, runs `layoutFloor`/`aggregateFlows`, renders tiles + one `RackCabinet` per rack + one `FreePoolPod` per unracked server + a small appliance box per in-scope managed service, flow traces, and the toolbar (`+ server`/`+ rack`/`auto-arrange` — Task 2's rack actions). Reads `selectedServerId` from `ui.store` (Polish 4 T1, §S — lifted out of local state) and a seen-ids ref driving the boot-cascade animation for newly-added servers (skipped entirely under reduced motion — instant-appear, the D1 functional exception). Computes BOTH of T8's ranked animation sets (`animatedKeys` for traces, `animatedLedIds` for LEDs) here, since both need AZ-wide visibility no single leaf component has. Its `accentsByServer` is now `serverAccents(doc, compiled)` (Polish 4 T3, §U), not an inline `useMemo` body. **2026-07-12 fix wave:** (a) every floating label (rack titles, pod names — moved here out of `FreePoolPod.tsx`'s SVG — managed labels, the FREE POOL badge, dep chips) now routes through `labelLayout.ts`'s `placeLabels` with the boxes' bounding rects as obstacles: anchored above each roof, pushed up until clear, never overlapping a box or another label; (b) renders the hand-rolled isometric **ISP uplink cabinet** at the floor's empty bottom-left corner (outside the diamond — outside traffic enters from off the floor: PWR/LINK/ACT status LEDs, RJ45-ish port, whip antenna, dashed street-feed from screen-left) with one `internetIngress` line per public-entry server — allowed = teal, competing for the SAME `TOP_ANIMATED` budget as dep flows; firewalled-shut = the blocked red treatment + a `✕ firewall` chip. Its `anchorFor` resolves a RACKED server to its cabinet first (`doc.servers[id].rack?.rackId` → `plan.cabinets`) — flow/ingress endpoints are server ids but racked servers have no tile of their own, so every line into one silently vanished after auto-arrange until the 2026-07-12 follow-up; same-cabinet dep pairs (both endpoints resolve to one anchor) draw no line and no chip |

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
`nav`/`simulation`/`file`/`ui` stores gain nothing within Polish 3 (matches spec D10 verbatim) —
Polish 4 Task 1 later added `ui.store`'s `selectedServerId`, the one exception in any later phase
(see §S).

---

### S. Polish 4 Task 1 — contextual dock foundation (`src/app/world/dock/`, 2026-07-11)

The first task of Polish 4 (spec `docs/superpowers/specs/2026-07-11-polish4-contextual-dock-design.md`,
§D1/D2): the right-hand dock now scopes itself to nav + a lifted floor selection instead of
always showing the full world tree. This task built the **foundation** only — the derived scope
model, the selection lift, the shared scope rail, and the dock shell's tab-set switch — not the
three per-scope instrument bodies (atlas/floor-plan/faceplate), which are Tasks 2-4.

**New module: `src/app/world/dock/`** — mirrors `region/`'s and `az/`'s existing "one folder per
level-specific concern" pattern, but this one is cross-level (it's read by `WorldPanel.tsx`
regardless of which level the user is on). Everyone building a Polish-4 dock surface (T2's
`AtlasHeader`/`RegionConfigTab`, T3's `FloorPlanHeader`/`AzConfigTab`, T4's `ServerFaceplate`/
drawers) lands their new files here too — this is now the module boundary for "dock scope"
work, separate from `region/`/`az/`/`server/`'s existing "per-level view" boundaries.

- `scope.ts` — **pure, no React, no store imports** (only type-only imports of `WorldLevel`
  from `nav.store.ts` and `PanelTab` from `ui.store.ts`, both erased at build time — the file's
  RUNTIME footprint stays zero-dependency, which is what keeps it node-env testable). Exports
  `DockScope` (the `'world' | 'region' | 'az' | 'server'` discriminated union, verbatim from the
  brief), `NavSnapshot`, `deriveScope(nav, selectedServerId, doc)` (D1's ladder: server nav level
  wins outright; az level + a selection that still exists AND belongs to this az narrows to
  server; az level alone; region level; else world — stale/foreign selections are silently
  ignored, never crashed on), and `scopeTabs(scope)` (world → the 7 existing tab ids; anything
  narrower → `['config','analysis','events','cost']`, a fresh array each call).
- `scopeData.ts` — also pure, same import discipline. `scopeEntityIds(scope, doc, compiled)`
  returns the scope's entity closure as a `Set<string>`, or **`null` at world scope as an
  explicit "no filter, everything" sentinel** — a deliberate, documented deviation from the
  brief's literal `Set<string>` signature (its own comment described the null-sentinel
  behavior the type didn't allow; the brief's ambiguity-resolution notes explicitly sanctioned
  picking a representation and documenting it). The closure is literally D2's wording — region →
  its AZs/servers/instances; az → itself + its servers + their instances; server → itself + its
  instances — plus, since the T1 fix wave (2026-07-11, review finding), a blueprint id counts as
  in-scope when it has a `compiled.instances` entry whose server/az/region falls within the
  current scope, and a managed-service id resolves via its own `ManagedScope` field (az-scoped
  services roll up into their parent region, mirroring how az/server/instance ids already roll up
  above; region-scoped services do not roll back down into one specific AZ). This closes the
  original gap where a finding whose only affected id was e.g. a managed-service id
  (`unused-managed-service`) or a bare blueprint id (`db-port-exposed`'s public-port variant,
  `stateful-without-volume`) never surfaced at any narrower scope even when physically placed
  there — spec D2 requires findings "physically located in the scope" to surface. Population ids
  remain unwalked (no `DockScope` variant models a population).
  `scopedEvents` delegates region scope to the EXISTING `region/regionData.ts`'s `regionEvents`
  byte-for-byte (per the brief's explicit "do not fork its logic" instruction) and generalizes
  the same "affected intersects the closure" shape for az/server via `scopeEntityIds`.
  `scopedFindings`/`scopedCost` follow the same world-is-a-pass-through, narrower-is-a-real-filter
  shape; `scopedCost`'s server branch is the one hardcoded case (`hourlyUsd = server.hourlyUsd`,
  `egressNote = 'egress is attributed at the AZ level'`) per the brief's ambiguity resolution —
  region/AZ read `computeWorldCost().byRegion`/`byAz` (`egressNote: null`, since that function has
  no per-region/per-az egress breakdown to begin with, only a world total).
- `ScopeRail.tsx` — the one component (not pure — reads `world`/`nav`/`ui` stores directly and
  dispatches their EXISTING actions, same relocated-dispatch discipline as every other Polish-3/4
  restyle) shared identically by all three future instruments. `data-testid="scope-rail"`,
  `aria-label="dock scope"`; pills carry `data-testid="scope-pill-<world|region|az|server>"`. The
  lit "here" pill (the mock's `.scopeseg.here`) rides `--kit-accent`/`--kit-accent-dim`
  (`ui/kit.tsx`'s already-injected, already-theme-aware token pair — dark value `#7CFFE9`/
  `#2DD4BF44` is a byte-for-byte match for the mock's locked `--hud`/`--hud-dim`, with a
  WCAG-checked light-mode swap already defined) rather than a new hardcoded hex — this is why
  `WorldPanel.tsx` (which already imports `ui/kit.tsx` for `ChipValue`) doesn't need a new style
  injection for the rail to render correctly in both themes. Az-pill click implements D1's exact
  conditional: `nav.level === 'az'` → `setSelectedServerId(null)` (widen without navigating,
  covers the case where scope narrowed to 'server' purely via a floor selection); otherwise →
  `goAz(regionId, azId)` (a real climb-up, covers the case where nav is literally on the server
  board). Live-verified via the running app (Playwright against `npm run dev`): selecting a floor
  pod narrows the rail to 4 pills WITHOUT touching the header `Breadcrumb` or `nav.level`, and the
  same `ui.store.selectedServerId` drives both the rail AND the pre-existing `InspectorV2`
  "selected server" card simultaneously — the "select there, configure here" unification works
  end-to-end, not just in jsdom.

**`src/app/store/ui.store.ts`** gained exactly what D1/the brief specified — `selectedServerId:
ServerId | null` (initial `null`) + `setSelectedServerId` — and `PanelTab` gained `'config'`. See
the updated hub-file entry below (§2) for the full field list.

**`src/app/world/az/DatacenterFloor.tsx`**: the local `selectedServerId` `useState` (previously
reset on its own `azId`-keyed `useEffect`) is now `useUiStore(s => s.selectedServerId)` +
`useUiStore(s => s.setSelectedServerId)` — no other prop threading to `RackCabinet`/
`FreePoolPod`/`InspectorV2` changed. The old local clearing effect was DELETED, not kept
alongside the new one: it was already a same-mount no-op even before this task (this component
remounts on any `azId` change anyway, via `WorldShell.tsx`'s `viewKey`-keyed `AnimatePresence`,
so a fresh `useState(null)` already covered it) and now that the state is a shared store field
that survives remounts, the responsibility for clearing it correctly moved to...

**`src/app/world/WorldShell.tsx`**: gained one `useEffect(() => { useUiStore.getState()
.setSelectedServerId(null) }, [nav.level, nav.azId])`, alongside the existing place-mode-disarm
effect. This is the ONLY place a selection gets cleared now — covering every nav transition in
or out of an AZ (entering a different AZ, drilling into a server board, climbing back out,
jumping to a different region), not just the AZ-local case the old effect covered. Without it, a
stale selection from a previously-visited AZ could silently revive itself (and narrow the dock's
scope) on a later return visit to that same AZ, since store state — unlike component state —
doesn't reset on remount.

**`src/app/world/panels/WorldPanel.tsx`** (already a de-facto hub — every authoring panel/tab
component is a descendant): derives `scope` via `deriveScope` (selective `useNavStore(s => s.X)`
primitive subscriptions + `useUiStore(s => s.selectedServerId)`, memoized), renders `<ScopeRail
scope={scope} />` as the dock's first child (above the existing `WorldSummary` strip — left
UNCONDITIONALLY rendered at every scope for this task; Task 2's brief explicitly owns replacing
it with `AtlasHeader`, so a narrow-scope dock temporarily still shows world-wide "handling N rps"
copy above the scope-correct tab body — a known, intentionally-deferred rough edge, not an
oversight — **superseded by §T below: `WorldSummary` no longer exists, `AtlasHeader` now renders
at both world AND region scope**), and switches the tab-bar's id set via `scopeTabs(scope)`. Tab persistence (D2): a
`useLayoutEffect` keyed on `scope` alone (mirrors this file's own `placeInk` `useLayoutEffect`
precedent, and `DatacenterFloor.tsx`'s `currentIdsKey`-only-dependency precedent) resets `tab` to
the new scope's first id only when the current one doesn't exist there. World scope's rendering
path (all 7 tabs, `TopologyPanel`/`BlueprintPanel`/`PlacementPanel`/`TrafficPanel`/`AnalysisTab`/
`EventsTab`/`CostTab`, the per-tab `SignatureHeader` switch) is **byte-identical in behavior** to
pre-Task-1 — `scopedFindings`/`scopedEvents`/`scopedCost` are provable pass-throughs at world
scope (same references, same computed values), so the Analysis tab-bar badge and every world-tab
`SignatureHeader` summary read the same numbers they always did. Non-world scope renders four new
file-local (not exported, not in their own files — small enough to keep beside their one caller,
same judgment call `WorldSummary` itself already made) components: `ScopedConfigBody` (the
brief's placeholder — T2/T3/T4 replace this per scope — **T2 (§T) landed first: `WorldPanel.tsx`
calls `RegionConfigTab` instead of `ScopedConfigBody` for region scope specifically, leaving
`ScopedConfigBody`'s `scope.kind === 'region'` branch unreachable dead code, kept deliberately so
the component's shared signature/type stays untouched for AZ/server, which T3/T4 still called
as-is at the time. **T8 status (final): T3 (§U) and T4 (§V) have SINCE landed their own AZ/server
Config instruments (`AzConfigTab`/`ServerFaceplate`), so ALL THREE of `ScopedConfigBody`'s
`region`/`az`/`server` branches are now unreachable — `WorldPanel.tsx`'s ternary chain
(`scope.kind === 'region' ? … : scope.kind === 'az' ? … : scope.kind === 'server' ? … :
<ScopedConfigBody>`) exhausts `DockScope`'s 3-member non-world union before ever falling through
to it. T8's sweep audited this deliberately (spec brief's own "narrow it only if trivially safe,
else document why it stays" instruction) and chose to LEAVE it as a defensive fallback rather
than delete the function or narrow its prop type: it costs nothing at runtime (never called),
keeps a "coming soon" render path alive for free if a future `DockScope` variant is ever added
without an instrument yet built for it, and deleting it would be a pure risk/no-reward edit this
late in the phase.**), `ScopedAnalysisBody`/`ScopedEventsBody`/
`ScopedCostBody` (real, wired to the scopeData helpers above — nothing later replaces these
three, they're final for this phase, not placeholders).

### T. Polish 4 Task 2 — the atlas instrument (`src/app/world/dock/`, 2026-07-11)

Builds ON §S's foundation (spec §D3/D4): the dock's signature header at world + region scope — a
live constellation SVG (graticule, region dots, population dots, ≤3 traffic arcs) plus a
two-posture headline — replacing T1's temporary "WorldSummary stays unconditionally rendered"
rough edge and T1's generic region-scope Config placeholder. Does NOT touch az/server scope
(the floor-plan/faceplate headers are T3/T4 territory) or the engine/`nav.store.ts`/
`world.store.ts`/`ui.store.ts`.

- **`src/app/world/dock/AtlasHeader.tsx`** (new) — `AtlasHeaderProps { regionId: string | null }`
  (`null` = world scope); pure presentational (reads props + `world`/`simulation` stores +
  `useCompiledWorld()` directly, no new store fields). Exports `projectLatLon(lat, lon, w, h)`
  standalone (equirectangular, lon −180..180→0..w, **lat 75..−60→0..h** — the datacenter-metro
  band, not the full globe — both clamped) so its math is TDD'd independent of rendering.
  **Dark-scene chrome** (D3's InspectorRail precedent, third instance after ScopeRail's rail
  background and InspectorRail itself): `ATLAS_BG`/`ATLAS_BORDER`/`GRATICULE_STROKE`/
  `LABEL_COLOR`/`HEADLINE_MUTED`/`HEADLINE_STRONG` are fixed local hex (DARK_COLORS' own values/
  the locked mock's literals — e.g. `HEADLINE_MUTED = '#94A3B8'` IS `DARK_COLORS.textSecondary`,
  not a new invented color), never `var(--color-*)`, with the same InspectorRail-precedent
  reasoning: `var(--color-text-secondary)` would degrade to a mid-gray calibrated for a WHITE
  card in light theme, illegible against this permanently-dark backdrop. **One documented
  exception**: the region-scope ring and the traffic arcs both use `HUD = 'var(--kit-accent)'`
  (theme-aware, NOT fixed) per the T2 brief's explicit ambiguity resolution ("reuse the
  ScopeRail/theme hud color token") — they denote "hud/live," the same semantic ScopeRail's "here"
  pill and the tab-bar ink already carry, so they deliberately ride that already-WCAG-checked
  pair instead of a 7th hardcoded hex.
  - **Region dot health**: reuses `pinColor(health)` — exported from `globe/RegionPins.tsx`, NOT
    re-derived — for the fixed-hex fill (so the atlas's health colors are byte-identical to the
    globe's pin colors in both scenes). The "region whose every AZ is manually killed reads as
    down" aggregation (`RegionPins.tsx`'s `RegionPin`-local view-side rule, the globe's "red-out
    law") is DUPLICATED as a small local `regionHealth()` helper rather than imported — RegionPins
    only exports `pinColor`/`isPulsing` as standalone functions, that aggregation is inlined in a
    component-local selector there, and duplicating ~4 lines with a citing comment follows
    `ui/derived.ts`'s own established "cite, don't cross-import engine/view-adjacent math"
    precedent rather than adding a new cross-module (`dock/` → `globe/`, beyond the already-taken
    `pinColor` import) coupling for logic that isn't exported anyway. `displayBatch` null (never
    run) → every region dot renders `pinColor('healthy')` (success/green) per the brief's explicit
    "authored-but-not-running worlds show success dots" rule.
  - **Arcs**: population→landing-region quadratic paths, capped at 3, ranked by rps descending.
    Landing/ranking source is `displayBatch` presence (`scrubBatch ?? latestBatch` — the SAME
    discriminator every other dock/panel surface already uses for "rest vs has-data," e.g. the
    deleted WorldSummary's own `!displayBatch` branch) — NOT the literal `running` flag, since a
    stopped-but-scrubbed replay still has real route data to show. At rest (`populationLanding`
    branch), routes rank by `pop.peakRps` (no live rps exists yet); baseline synthetic
    `populationRoutes` entries (id `baseline:<regionId>`, no `doc.populations` entry — see
    `worldEngine/index.ts`'s baseline-demand loop) are skipped, matching the fact that they have
    no population marker anywhere in the app (including the globe) to draw an arc FROM. The
    MOTION gate is separate and literal-`running`-based (idle-static law): `data-arc-live`
    (`"true"`/`"false"` string, always present) marks the top-ranked arc for its opacity tier
    (0.7 vs the other two's 0.35) REGARDLESS of running state; `data-animated` (`"true"`/`"false"`
    string, always present, exposed specifically so tests never have to read computed CSS) is
    `true` only on the top arc AND only when `running && topRps > 0 && !useReducedMotion()` —
    verified test-side that a scrubbed-but-stopped batch still ranks a top arc but never animates
    it.
  - **Headline**: world scope's copy is REUSED verbatim from the deleted `WorldSummary`'s two
    postures for region/server/city COUNTS and the `$/hr`/rolling-rps MATH (`useRollingNumber`,
    `scopedCost({kind:'world'}, doc, world)` — literally T1's `scopeData.ts` helper, not
    `computeWorldCost` re-called inline, so the world Cost tab and the atlas headline can never
    silently diverge) — **but the RUNNING posture's exact SENTENCE changed** per D4/the mock:
    dropped `across N regions` and the old secondary line's health-label/p50 (health now
    communicated visually via the constellation's dot colors, not text); p50 is never appended
    (the brief's "append p50 only if it fits" judgment call — the mock's own example line is
    already close to the dock's ~336px width with rps+cities+price alone, so this implementation
    always omits it rather than building a fragile text-measurement heuristic). Region scope is
    ONE formula (not two postures) — `<catalogId> · N rps · $X/hr` — that degrades gracefully at
    rest for free: rps naturally reads `0` (no batch), and `$/hr` still resolves via
    `scopedCost({kind:'region', regionId}, doc, world ?? null)` because `computeWorldCost` sums
    server `hourlyUsd` unconditionally — only its egress term needs a live `world` metrics object.
    A single `useRollingNumber` call handles BOTH scope's rps figure (fed whichever raw value is
    scope-relevant via a ternary computed BEFORE the hook call) — calling the hook itself from
    inside an `if (regionId === null)` branch would violate React's rules-of-hooks the instant a
    mounted instance's `regionId` prop flips between renders (WorldPanel never remounts
    `AtlasHeader` on a world↔region scope change — same component type, same JSX slot).
  - `data-testid="atlas-header"` (root), `atlas-region-dot` (per dot, per the brief verbatim),
    `atlas-headline`.
- **`src/app/world/dock/RegionConfigTab.tsx`** (new) — region scope's REAL Config tab body
  (`RegionConfigTabProps { regionId: string }`), replacing T1's generic `ScopedConfigBody`
  placeholder for region scope ONLY (az/server still get the placeholder — T3/T4 territory,
  untouched **at the time this task landed; superseded by §U below: az now gets its own real
  Config body too, `AzConfigTab`, leaving only server on the placeholder**). One `EdgeRow` per AZ
  in this region (health dot from `displayBatch.azs[az.id]`,
  label, doc-derived server count — always available, unlike the batch-gated rps — singular-aware,
  live rps or `'—'` at rest, right-aligned via `marginLeft: 'auto'` inside EdgeRow's own
  `children` slot rather than its separate `trailing` prop, so the whole row's text is one
  testable block and a click anywhere in it still bubbles to EdgeRow's onClick); row click →
  `goAz(regionId, az.id)` (nav-only, never edit-locked — edit-locking is for MUTATIONS, and EdgeRow
  renders a plain `<div>`, which a `<fieldset disabled>` doesn't touch anyway, unlike a `<button>`).
  `+ az` button reuses `world.store.ts`'s `addAz` AND `TopologyPanel.tsx`'s exact auto-suffix
  label convention (`${catalogId}${String.fromCharCode(97 + azs.length)}`) byte-for-byte —
  duplicated as a one-line expression (not imported — `nextAzLabel` is a `TopologyPanel`-local
  closure, not exported) rather than refactored into a shared helper, matching the relocated-
  dispatch contract's "reuse the dispatch, not necessarily the call site" reading. Explicitly
  `disabled={running}` + `title="stop the simulation to edit"` on the button itself (not relying
  solely on `WorldPanel.tsx`'s ambient `<fieldset disabled={running}>`, which this component sits
  inside in production but NOT in its own standalone test) — same self-sufficient-correctness
  precedent as `AzRow.tsx`'s/`DatacenterFloor.tsx`'s own `+ server`/`+ rack` buttons.
  `data-testid="region-config-tab"` (root), `region-config-az-row` (per row).
- **`src/app/world/panels/WorldPanel.tsx`**: `WorldSummary` (the Polish-2-era read strip, §Q/§R)
  is DELETED outright — not hidden, not kept as dead code — its `data-testid="world-summary"` no
  longer exists anywhere. `<AtlasHeader regionId={scope.kind === 'region' ? scope.regionId :
  null} />` renders in its exact old slot (above the tab bar, OUTSIDE the `<fieldset
  disabled={running}>` — a read surface, must stay legible while running) at BOTH world and
  region scope (a single conditional, `scope.kind === 'world' || scope.kind === 'region'`) — az/
  server scope render no atlas at all. The Config-tab branch now checks `scope.kind === 'region'`
  first (→ `RegionConfigTab`) before falling through to `ScopedConfigBody` (az/server, unchanged).
  `useRollingNumber`/`computeWorldCost`/`HOURS_PER_MONTH` imports were removed (their only
  consumer, `WorldSummary`, is gone) — `AtlasHeader.tsx` now owns that math instead.
- **`src/app/world/panels/TopologyPanel.tsx`** — the `wtree` reskin (D4/mock): each region row's
  full 1px box border became a 2px LEFT border (`WTREE_BORDER = 'var(--color-node-border)'` at
  rest — a THEME-AWARE token, deliberately, since TopologyPanel is dock BODY content, below the
  atlas header, where the dark-scene-chrome carve-out does NOT apply — brightening to
  `var(--kit-accent)` on hover). Hover state is a plain local `useState<string|null>` +
  `onMouseEnter`/`onMouseLeave` (same idiom this file already uses for
  `presetGridOpenAz`/`expandedServer`) rather than a new injected stylesheet class, since inline
  `style` objects can't express `:hover` and this task's brief didn't list `ui/kit.tsx` as a file
  to touch — zero other files touched for this reskin. Added a live rps figure (hud-colored,
  batch-gated — omitted entirely at rest, matching `ServerRow`'s existing "no fake numbers at
  rest" convention below it in the same file) to the region `SectionHeader`'s `trailing`, and a
  new meta line (`N AZ(s) · M server(s) · $X.XX/hr`, doc-derived so it's always shown, price via
  `computeWorldCost(doc, world).byRegion` — the SAME primitive every other cost readout uses, no
  new math) below it. **STYLING ONLY**: `regionAzs`/`regionAzIds` are computed once per region row
  and the pre-existing AZ `.map()` now reuses `regionAzs` instead of re-filtering
  `doc.azs`/`doc.servers` a second time (a pure simplification, not a behavior change) — every
  other dispatch (`addRegion`/`removeRegion`/`addAz`/`removeAz`/`addServer`/role-`select`/
  firewall/stack editors) is byte-for-byte untouched, confirmed by all 11 pre-existing
  `TopologyPanel.test.tsx` cases passing with zero edits. **Test-collision note**: the new
  region-row `$X.XX/hr` meta line uses `.toFixed(2)` specifically (not raw `hourlyUsd`) so a
  single-server region's rollup (e.g. `$0.036` → `"$0.04/hr"`) can never collide with
  `ServerRow`'s own unrounded `${server.hourlyUsd}/hr` (`"$0.036/hr"`, 3 decimals) — but it CAN,
  by design, collide with `AtlasHeader`'s own `.toFixed(2)`-rounded world `$/hr` for a
  trivially-small world (both legitimately render `"$0.04/hr"` simultaneously, since
  `WorldPanel.tsx` mounts `AtlasHeader` unconditionally alongside whichever tab is active); the
  migrated `WorldPanel.test.tsx` price assertion (below) scopes its query to
  `within(screen.getByTestId('atlas-headline'))` rather than a blind `screen.getByText` for
  exactly this reason.
- **`src/app/world/panels/WorldPanel.test.tsx`**: the two `WorldSummary`-describe-block tests
  migrated into a new `'WorldPanel atlas header (Polish 4 T2)'` describe block, same behavioral
  intent (same two-posture number derivations) against `atlas-headline`/`atlas-header` instead of
  `world-summary`, plus a new explicit assertion that `world-summary` no longer exists anywhere
  (WorldSummary was absorbed, not duplicated) and two new scope-boundary assertions (region scope
  DOES render `atlas-header`; az scope does NOT). The pre-existing T1 `'region scope narrows the
  tab bar...'` test's Config-tab assertion was updated from `config-placeholder` (region text/
  catalogId) to `region-config-tab` (RegionConfigTab now owns region scope's Config body) — a
  required update, not an optional migration, since T2 deliberately changes what renders there.

### U. Polish 4 Task 3 — the floor-plan instrument (`src/app/world/dock/`, 2026-07-11)

Builds ON §S/§T's foundation (spec §D3/D5): the dock's signature header + Config body at AZ
scope — a clickable isometric minimap (a genuine miniature of the same floor, doubling as the
selection surface) plus rack capacity wells / server slat rows / AZ cost / actions — replacing
T1's generic AZ-scope `ScopedConfigBody` placeholder. Does NOT touch world/region scope (§T's
atlas is untouched) or server scope (§T4/faceplate territory) or the engine/`nav.store.ts`/
`world.store.ts`/`ui.store.ts` (no new store surface this task — the dock keeps reading/writing
the SAME `ui.store.selectedServerId` §S lifted).

- **`src/app/world/az/floorData.ts`**: gained `serverAccents(doc, compiled): Map<ServerId,
  string[]>` — a byte-for-byte extraction of `DatacenterFloor.tsx`'s pre-T3 inline
  `accentsByServer` `useMemo` body (every resident instance's blueprint color, deduped in
  first-seen order). `DatacenterFloor.tsx` now calls `serverAccents(doc, compiled)` instead of
  computing it locally — same dependency array (`[compiled.instances, doc.blueprints]`, not
  `[doc, compiled]`, to keep the memo exactly as fine-grained as before) — so its own faceplate
  ticks are unchanged (all 7 `DatacenterFloor.test.tsx` cases pass with zero edits, confirming the
  refactor is behavior-identical). `floorData.test.ts` gained a `serverAccents` describe block
  (dedup-by-color-index, first-seen order, no-entry-for-a-server-with-no-residents, and a
  `matches the prior inline derivation` test that runs a copy of the OLD inline logic
  (`inlineAccentsByServer`) side-by-side against the new export and asserts `toEqual` — the TDD
  evidence that the move changed nothing observable). The new helper is now shared by THREE
  consumers: `DatacenterFloor.tsx` (faceplate ticks), `dock/AzConfigTab.tsx` (slat accent ticks) —
  the two surfaces can no longer independently drift on "what color is this server."
  `FloorPlanHeader.tsx` does NOT use it (the minimap has no room for per-server ticks at 372×96;
  it uses `layoutFloor`'s plan only, see below).
- **`src/app/world/dock/FloorPlanHeader.tsx`** (new) — `FloorPlanHeaderProps { azId: string }`;
  pure presentational (reads props + `world`/`simulation`/`ui` stores directly, no new store
  fields). Reuses `az/floorLayout.ts`'s `layoutFloor(racks, rackedByRack, freePool, managedIds)`
  for the grid-cell PLAN (which rack/pod occupies which cell) — the one piece of layout math the
  brief said must not be re-derived — but projects that grid into its OWN small dimetric pixel
  space (`ORIGIN_X/Y`, `FLOOR_W/H` local consts, a `tileCenter`/`cellPoly` pair) rather than
  reusing `az/iso.ts`'s `tileToScreen`/`isoBox`: `iso.ts`'s functions are calibrated to the big
  floor's fixed 900×430 viewBox via module-level constants (not parametrized by width/height), so
  reusing them here would mean rendering at 900×430 and scale-transforming the whole SVG down —
  more indirection than writing the small 372×96 equivalent directly. This mirrors
  `floorLayout.ts`'s own header comment, which already draws the PLAN/PROJECTION line as two
  separate concerns. Each occupant renders as ONE polygon (a diamond, not `iso.ts`'s 3-face
  roof/front/side box) — matching the locked mock's own flatter `<polygon class="cab">`/
  `<polygon class="pod">` DOM, which has no room for 3-face detail at this scale.
  **The minimap IS the selection surface** (D5): a pod click → `setSelectedServerId(podServerId)`
  directly; a cabinet click → the rack's lowest-`unit` resident (`rackedByRack[rack.id][0]`,
  already unit-sorted the same way `DatacenterFloor.tsx` sorts it; a no-op on an empty rack, never
  a crash). The shape containing `ui.store.selectedServerId` gets a `sel` class (hud stroke +
  glow, `dock/floorPlanStyles.ts`); hover brightens (CSS `:hover`, same file). Headline (top-left,
  `data-testid="floor-plan-headline"`): `<AZ label uppercased> · N rps in · <price>$/mo</price>` —
  rps from `batch?.azs[azId]?.rps`, price from `scopeData.ts`'s `scopedCost({kind:'az', ...},
  doc, batch?.world ?? null)` (the SAME helper `AzConfigTab`'s cost row and `WorldPanel`'s scoped
  Cost tab read, so the minimap headline can never silently diverge from either). **Dark-scene
  chrome** (D3's InspectorRail precedent, the SAME carve-out `AtlasHeader.tsx` documents): fixed
  local hex (`MINIMAP_BG`/`MINIMAP_BORDER`/`TILE_STROKE`/`CAB_FILL`/`CAB_STROKE`/`POD_FILL`/
  `POD_STROKE`/`LABEL_COLOR`/`HEADLINE_COLOR`), never `var(--color-*)` — the mock's `#11150f`-
  family palette, permanently dark in both themes.
- **`src/app/world/dock/AzConfigTab.tsx`** (new) — `AzConfigTabProps { azId: string }`; AZ scope's
  REAL Config tab body, replacing T1's `ScopedConfigBody` placeholder for AZ scope specifically
  (server scope still gets the placeholder — T4 territory, untouched). Below the header, every
  color is `var(--color-*)`/`var(--kit-*)` (the below-header law) — no fixed hex in this file.
  - **RACKS — capacity wells**: one 34px-wide well per rack (`data-testid="rack-well"`), teal
    fill height = `rackUsedU(doc, rack.id) / rack.capacityU` (both from `lib/world/rackModel.ts`,
    not re-derived), a `repeating-linear-gradient` U-notch rung overlay (an inline decorative
    `<div>`, not a CSS `::after` — inline React styles can't express pseudo-elements, and this is
    a one-off per-well overlay, not a reusable rule worth a stylesheet class), caption
    `<label>` / `<used>/<capacity>U`. A dashed ghost well (`data-testid="rack-well-ghost"`,
    `.dockfp-rackwell-ghost` for its hover-only opacity lift) dispatches `addRack(azId)` — the
    SAME call `DatacenterFloor.tsx`'s own ghost-rack click makes — and is HIDDEN while running,
    the same precedent as the floor's own ghost rack. The hatched `azsec` section rail (mock's
    `.azsec::after` `repeating-linear-gradient` industrial stripe) is a small file-local
    `SectionRail` component, tokenized (`var(--color-node-border)`), not `ui/kit.tsx`'s
    `SectionHeader` (which renders a plain fading gradient line, a visually different pattern —
    kept file-local rather than added to the shared kit since D5 requires this specific hatched
    texture, not the kit's default one, and no other dock surface needs it yet).
  - **SERVERS — tap = select on floor**: one slat row per server (`data-testid="dock-slat"`,
    `.dockfp-slat` for the hover `translateX(4px)` + teal-border shunt), racked first (rack order,
    then unit within rack — the SAME `rackedByRack` grouping/sort `DatacenterFloor.tsx` and
    `FloorPlanHeader.tsx` both build locally) then free pool. Health LED color from
    `batch?.servers[id]?.health` (success/warning/danger, the same `HEALTH_COLOR` mapping
    `region/AzRow.tsx` already uses). Accent ticks from `serverAccents` (above). Meta text:
    `<kind> · <healthWord(cpuMean, ramFraction)>` (`ui/derived.ts`'s existing `healthWord`) while
    a batch is live, plain `<kind>` at rest. Click → `setSelectedServerId(server.id)` — no
    navigation; per the brief's ambiguity resolution, selecting a server here immediately narrows
    `deriveScope` to server scope, which flips `WorldPanel` away from `AzConfigTab` to the server
    placeholder (T4 territory) — `AzConfigTab` does not try to stay mounted after a selection.
    **Rendered as a `<div role="button" tabIndex={0}>`, NOT a `<button>`** — a bug found live
    (Playwright against a running `npm run dev`, not caught by any jsdom test, since every
    `AzConfigTab.test.tsx` case renders the component standalone): `WorldPanel.tsx` wraps its
    entire non-world tab body in `<fieldset disabled={running}>`, which the HTML spec cascades
    onto EVERY descendant form control regardless of that control's own `disabled` prop — a real
    `<button>` slat would go silently unclickable for the entire duration of any simulation run,
    breaking "tap = select on floor" exactly when the floor is most interesting to watch. Fixed by
    following `RegionConfigTab.tsx`'s own documented precedent (its `EdgeRow`-as-plain-`<div>`
    choice, for the identical reason) rather than inventing a new pattern. Two regression tests
    (`AzConfigTab.test.tsx`) render `<AzConfigTab>` inside a REAL `<fieldset disabled>` (not
    standalone) specifically to catch a future regression back to `<button>`.
  - **Motion budget (D3, the dock's own — INDEPENDENT of the floor's own `MAX_ANIMATED_LEDS=3`
    budget documented in §R)**: exactly ONE slat's LED may blink — the single busiest server by
    live mean `coreUtilization` (`meanUtilization`, `floorData.ts`), running only, never
    reduced-motion. Computed as a plain linear scan (`busiestServerId`, not a reuse of the floor's
    own ranking helper, since that one returns a whole ranked SET sized by `MAX_ANIMATED_LEDS`
    and this dock needs a single winner) capped at budget 1 by construction — every slat carries
    `data-blinking="true"|"false"` specifically so a test can assert the budget without reading
    computed CSS/animation state. The blink keyframe itself (`dockfp-blink`, `.dockfp-led-blink`)
    lives in the new shared `dock/floorPlanStyles.ts` (see below), reduced-motion-neutralized
    there too as a second guard.
  - **THIS AZ'S COST**: one row, `scopeData.ts`'s `scopedCost({kind:'az', regionId: az?.regionId
    ?? '', azId}, doc, batch?.world ?? null)` — price-colored (`var(--color-price)`),
    `$X.XX/hr · $Y/mo`. **T8 fix**: this originally re-derived `computeWorldCost(doc,
    batch?.world ?? null).byAz` inline instead of calling `scopedCost` — the same helper
    `FloorPlanHeader`'s minimap headline already reads (this doc previously claimed AzConfigTab
    "reads the SAME helper," which was false until this fix) — now both dedupe through one call
    site.
  - **Action row**: `+ server` — `DatacenterFloor.tsx`'s toolbar's EXACT dispatch/preset
    (`addServer(azId, getPreset('vps-medium')!)`); `auto-arrange` — the SAME `autoArrangeAz(azId)`
    call — both real `<button disabled={running}>`s, correctly ALSO redundantly disabled by
    WorldPanel's ambient fieldset (harmless: they're authoring controls that are SUPPOSED to be
    locked while running, same polarity as the fieldset). `kill AZ` — `region/AzRow.tsx`'s EXACT
    kill/restore pair (`setOutage('az', azId, !isManuallyDown)`, `isManuallyDown` from
    `simulation.store`'s `healthOverrides[azId]`), labeled `kill AZ` / `↺ restore` (the `↺` glyph
    from the Global Constraints' approved list, swapped in for `AzRow.tsx`'s own `✓ restore` since
    `✓` isn't on that list). **`kill AZ` hit the SAME fieldset bug as the slat rows above, but with
    the OPPOSITE, more severe consequence**: it's a run-ONLY control (must be clickable exactly
    while `running`, disabled while stopped) — the precise inverse of `<fieldset
    disabled={running}>`'s own polarity, so nesting it as a real `<button disabled={!running}>`
    made it permanently unclickable at the one moment it's supposed to work, confirmed live before
    the fix. Fixed the same way as the slats: a `<div role="button" tabIndex={running?0:-1}
    aria-disabled={!running}>` whose click/keydown handlers self-guard on `running` (nothing here
    can rely on the browser's native disabled-click suppression, since there's no native
    `disabled` attribute to suppress with). Two regression tests mirror the slat rows' pattern —
    one asserts `aria-disabled`/click-is-a-no-op while stopped (standalone), one renders inside a
    REAL `<fieldset disabled>` while running and asserts the click still dispatches `setOutage`.
    Edit-locks per D2 read `aria-disabled`/title, not the native `disabled` attribute, for this one
    control — `stop the simulation to edit` (the two real buttons) / `start the simulation to
    break things` (`kill AZ`) — all three relocated-dispatch, byte-identical to their origin call
    sites, no new/parallel mutation path. **Lesson for T4 (the faceplate, which also has a run-only
    `kill`/`↺ restore` action per D6, similarly nested inside this same fieldset): give it the
    identical `<div role="button">` treatment from the start, not a `<button>` first.**
- **`src/app/world/dock/floorPlanStyles.ts`** (new) — the injected-stylesheet-once idiom
  `ui/kit.tsx`/`az/azFloorStyles.ts` already established (inline React styles can't express
  `:hover`/keyframes), shared by BOTH new components above (`dockfp-cab`/`dockfp-pod` hover +
  `sel` ring for the minimap, `dockfp-slat` hover shunt + `dockfp-led-blink` keyframe +
  `dockfp-rackwell-ghost` hover for the Config tab) — namespaced `dockfp-*` so it can't collide
  with `ui/kit.tsx`'s `kit-*` or `az/azFloorStyles.ts`'s `az-*` copies. Every rule is neutralized
  under `@media (prefers-reduced-motion: reduce)`.
- **`src/app/world/panels/WorldPanel.tsx`**: `{scope.kind === 'az' && <FloorPlanHeader
  azId={scope.azId} />}` renders in the same header slot as `AtlasHeader` (mutually exclusive —
  world/region get the atlas, az gets the floor plan, server gets nothing yet). The Config-tab
  branch now checks `scope.kind === 'region'` (→ `RegionConfigTab`) then `scope.kind === 'az'`
  (→ `AzConfigTab`) before falling through to `ScopedConfigBody` (server only, now the sole
  placeholder consumer — its `scope.kind === 'region'`/`'az'` branches are unreachable dead code,
  kept deliberately so the component's shared signature/type stays untouched for server scope,
  which T4 still calls as-is).
- **`src/app/world/panels/WorldPanel.test.tsx`**: the T1 `'az/server scope render no atlas header
  at all'` test split into two (az scope now DOES render an instrument header — `floor-plan-
  header`, just not `atlas-header`; server scope still renders neither, T4 territory), plus a new
  `'az scope narrows the tab bar...lands on the floor-plan Config'` test mirroring T2's region-
  scope equivalent (asserts `floor-plan-header` + `az-config-tab` render and `config-placeholder`
  does not) — both required updates, not optional migrations, since T3 deliberately changes what
  renders at az scope.

### V. Polish 4 Task 4 — the faceplate + drawer spine (`src/app/world/dock/`, 2026-07-11)

Builds ON §S/T/U (spec §D3/D6): server scope's signature body — a screwed-on name plate + a
live vitals rail + a spine of four accordion drawers (HARDWARE/FIREWALL/SERVICES/PLACEMENT, one
open at a time, always-visible `pv` one-line readouts) — replacing T1's `ScopedConfigBody`
placeholder for server scope, the LAST scope still on that placeholder. Authoring posture only
(no watchband, no live pv re-voice, no frozen knobs — that's Polish 4 T5, which extends these
same components); every new file threads `running`/live-metrics data through as props so T5 can
branch on them without restructuring. No engine/`nav.store.ts`/`world.store.ts`/`ui.store.ts`
changes — every dispatch below is an EXISTING store action, called byte-for-byte from its prior
call site.

- **`src/lib/world/instanceCatalog.ts`**: gained `presetLadder(kind: ServerKind):
  InstancePreset[]` — `INSTANCE_CATALOG` filtered to one kind, sorted ascending
  vcpu-then-ramMb, fresh array per call. TDD'd first (`instanceCatalog.test.ts` gained a
  `presetLadder` describe block — filter/sort/membership/empty-kind assertions — written and
  confirmed red (`presetLadder is not a function`) before the ~5-line implementation landed).
  The HARDWARE drawer's two knobs both index into this SAME ladder (see below).
- **`src/app/world/dock/Drawer.tsx`** (new) — the generic accordion leaf every drawer body
  mounts inside: `DrawerProps { accent, title, readout, open, onToggle, children }`. Header is a
  `<div role="button" tabIndex={0}>` (T3's `AzConfigTab`/`InspectorV2`-pane lesson, §U, applied
  pre-emptively rather than discovered live again): the faceplate renders inside
  `WorldPanel.tsx`'s `<fieldset disabled={running}>`, and T5 (next task) needs these headers to
  stay clickable WHILE running (watching mode reads drawers as gauges) — a native `<button>`
  would go silently fieldset-disabled for the run's entire duration. Toggling is never
  edit-locked (it's attention, not authoring). Body: `max-height` 0→340px + opacity + padding,
  `0.26s cubic-bezier(0.3,0.8,0.3,1)`, tri rotates 90° in 0.18s; `useReducedMotion()` strips
  every transition to instant (no separate CSS media query — same explicit-JS-gate convention
  §U's `dockfp-led-blink` established, chosen for direct testability over a pure-CSS-only gate).
  `data-testid="drawer"` + `data-open` + `data-drawer="<title>"` (the last one lets
  `ServerFaceplate.test.tsx` assert drawer ORDER without depending on visible text).
- **`src/app/world/dock/drawers/HardwareDrawer.tsx`** (new) — `hardwarePv(server)` → `"<vcpu>c ·
  <ramGb>G"`. Body: two `<input type="range">` knobs (vCPU, RAM — native range styled
  `accentColor: var(--kit-accent)`, the same "styled native control" precedent
  `ui/kit.tsx`'s `DerivedField` slider mode already sets, not a bespoke pointer-driven SVG
  slider) sharing ONE index into `presetLadder(server.kind)` — moving EITHER knob commits
  `updateServer(id, { catalogId, specs: {...preset.specs}, hourlyUsd, oversubscriptionRatio,
  burstable })`, so vCPU/RAM/price can never drift apart (real cloud tiers don't scale the two
  axes independently either). `currentLadderIndex(server, ladder)` (exported, unit-tested)
  matches by `catalogId` when on-ladder, else falls back to nearest-by-weighted-distance for an
  off-ladder custom spec. Consequence hints read the server's FIRST resident blueprint (by
  `compiled.instances`): vCPU → `hostRpsCapacity(vcpu, blueprint.workload.cpuMsPerRequest)`
  (`ui/derived.ts`, unchanged) or `"no services mounted yet"` with none; RAM → `(ramMb −
  residentRamDemandMb(...)) / blueprint.workload.ramPerConnMb`, guarded to `"—"` when
  `ramPerConnMb` is 0/undefined (covers the same "nothing placed" case as the vCPU branch,
  without a second explicit empty-state string).
- **`src/app/world/dock/drawers/FirewallDrawer.tsx`** (new) — `firewallPv(server)` → `"<allow>
  allow · <deny> deny"` (always this form — the brief's own text; the locked mock's TWO cards
  show this string two different ways across its two demo sections, an internal mock
  inconsistency, not a spec branch — the brief's literal `pv: N allow · M deny` is what's
  implemented, no `"N rules"` fallback). Sentences import `ruleSourceWords`/`rulePortPhrase`
  from `server/ruleSentence.ts` (not `ruleSentence()` itself, since `Let`/`Block` need
  independent success/danger coloring) — the SAME grammar/rendering `InspectorRail.tsx` already
  uses for its rule rows, byte-identical spans (`#DBEAFE` bold source/port). `+ rule` appends
  `createServer`'s default rule shape (factories.ts: `allow · any port · any protocol ·
  internal`) via `updateServer(id, { firewall: [...server.firewall, rule] })`, id generated by
  the SAME exported `nextWorldId('fw')` factories.ts itself uses — not a `createServer()` call
  (that would construct a whole throwaway server just to read its first rule).
- **`src/app/world/dock/drawers/ServicesDrawer.tsx`** (new) — `servicesPv(serverId, doc)` →
  `"—"` (none) / `"<name> ×<count> · <role>"` (exactly one) / `"<n> services"` (several). Body:
  one chip line per placement (blueprint color swatch, name, `:<firstPort> · <role>`, a `− +`
  count stepper → `updatePlacement(id, { count: Math.max(1, count ± 1) })`, PlacementPanel's own
  clamp) plus a ghosted `+ mount a blueprint…` line that expands (local `useState`) to a
  blueprint `<select>` dispatching `addPlacement(blueprintId, serverId)` — PlacementPanel's
  exact call shape.
- **`src/app/world/dock/drawers/PlacementDrawer.tsx`** (new) — `placementPv(server, doc)` →
  `"free pool"` / `"<rack label> · slot <unit>"`. Body: InspectorV2's rack `<select>` relocated
  BYTE-FOR-BYTE (`FREE_POOL_VALUE`, per-rack `<option>` `canAssign`-disabling, the exact
  `assignServerToRack` dispatch) — the retirement target below.
- **`src/app/world/dock/ServerFaceplate.tsx`** (new) — `ServerFaceplateProps { serverId,
  showEnter }`. Plate header is dark-scene chrome (D3, the InspectorRail/AtlasHeader/
  FloorPlanHeader carve-out): fixed local hex for the metal gradient/border/screws/name/muted
  text/KIND-chip ("blue family," `CATEGORY_COLORS.compute.accent` regardless of the server's
  ACTUAL kind — matches the locked mock, which colors this chip identically for both
  `DEDICATED` and `VPS`), but `var(--color-price)` for the price and `var(--color-success/
  warning/danger)` for the live health word / running-posture line — the SAME "status semantics
  stay theme-aware even inside fixed chrome" carve-out `AtlasHeader.tsx`'s HUD ring and
  `InspectorRail.tsx`'s rule coloring already establish (documented inline, citing both). Health
  word is the engine's own `HealthState` ('healthy'/'degraded'/'down', matching the mock's
  literal text) — NOT `ui/derived.ts`'s `healthWord` (a different, cpu/ram-fraction vocabulary,
  'comfortable'/'tight'/'straining' — the local variable is deliberately named `healthState` to
  avoid the collision). Shown live while `running`, omitted at rest. Below the plate: PCB-dot
  texture (`radial-gradient(#ffffff06 1px, transparent 1px)` 22px grid, the ONE scene-chrome
  exception permitted below the header per global-constraints.md) over a `var(--color-surface)`
  base holding the vitals rail (left) and the drawer spine (right) — everything in both is
  `var(--color-*)`/`var(--kit-cat-*)` tokens. Vitals: `useServerDisplayMetrics(serverId)`
  (unmodified — already scrub/latest-aware) feeds `meanUtilization(coreUtilization)` (blue,
  `az/floorData.ts`, not re-derived), `ramUsedMb/ramTotalMb` (amber), `diskIoFraction` (teal)
  into three 44px `GaugeColumn`s, plus the pulse dot (`data-testid="vitals-pulse"`, class
  `dockfp-vitals-pulse` from the new `dock/faceplateStyles.ts` sibling — 3.6s opacity breathe,
  the dock's ONE ambient stroke at server scope per D3, JS-gated off under `useReducedMotion()`
  the same way §U's LED blink is, `@media` block as a second guard) and an `idle`/`live` caption
  keyed on whether `display.server` exists (NOT on `running` alone — a stopped-but-scrubbed
  replay still has real numbers; this is T4's own scope per the brief's literal "captions
  idle/live" line, not deferred to T5 — T5's territory is the drawer PV/BODY re-voicing and the
  2.2s "under load" pulse-rate quickening, both absent here by design). Drawer spine:
  `openDrawer: 'hw'|'fw'|'svc'|'pl'|null` (component state, default `'hw'`, reset on `serverId`
  change so a fresh selection never inherits a stale confirm/open state), one open at a time —
  opening a drawer closes the rest, clicking the open one closes it. Action row: `enter board ⏎`
  — a `<div role="button">` (navigation, never edit-locked, must also survive the ambient
  fieldset if T5 ever needs it live) rendered ONLY when `showEnter` — `goServer(nav.regionId,
  nav.azId, serverId)`, InspectorV2's exact dispatch; `kill`/`↺ restore` — a `<div role="button"
  tabIndex={running?0:-1} aria-disabled={!running}>` (run-only, §U's now-twice-applied lesson),
  InspectorV2's exact `setOutage('server', id, !isManuallyDown)` pattern; `remove…` — a real
  `<button disabled={running}>` (authoring, correctly locks), two-step confirm (`'remove…'` →
  click → `'confirm remove?'` → click → `removeServer(id)` + `setSelectedServerId(null)`).
- **`src/app/world/dock/faceplateStyles.ts`** (new) — the same injected-stylesheet-once idiom as
  `ui/kit.tsx`/`dock/floorPlanStyles.ts`, namespaced `dockfp-vitals-*` so it can't collide with
  either; holds only the `dockfp-vitals-breathe` keyframe + its reduced-motion neutralization.
- **`src/app/world/panels/WorldPanel.tsx`**: the Config-tab branch gained a THIRD real arm —
  `scope.kind === 'server' ? <ServerFaceplate serverId={scope.serverId} showEnter={navLevel ===
  'az'} /> : <ScopedConfigBody .../>` — `ScopedConfigBody` is now 100% dead code at every scope
  (kept deliberately, same reasoning §U already documented for its region/az branches: a
  defensive fallback that keeps the shared signature stable rather than narrowing the type).
  `showEnter` is exactly `nav.level === 'az'` — `deriveScope`'s (`dock/scope.ts`) ONLY two paths
  into server scope are a real board navigation (`nav.level === 'server'`, already "entered,"
  `showEnter` false) or an AZ-level floor/minimap/slat selection narrowing scope WITHOUT
  navigating (`nav.level === 'az'` + `ui.store.selectedServerId`, `showEnter` true) — no other
  case exists, so this single equality check is exhaustive, not a heuristic.
- **`src/app/world/InspectorV2.tsx` retires its selected-server pane** (D6: "with selection
  scoping the dock, the floor card would be a duplicate surface"). Props shrink back to `{ azId:
  AzId }` (the `selectedServerId`/`onClearSelection` props Polish 3 T4 added are gone); the
  component is traces-only again, its pre-Polish-3-T4 shape. `assignServerToRack` moved to
  `PlacementDrawer.tsx`, `goServer`/`setOutage` moved to `ServerFaceplate.tsx` — both
  byte-for-byte, no parallel dispatch path. The per-file table entry above (§1, Phase 2 Task 15
  row) still says "mounted inside `AzCanvas.tsx`" — stale since Polish 3 Task 4 moved the mount
  to `DatacenterFloor.tsx` (`AzCanvas.tsx` no longer exists); left as historical-context prose
  rather than rewritten, per this doc's own convention of layering deltas forward instead of
  editing every earlier paragraph — this §V entry is the current description.
- **`src/app/world/az/DatacenterFloor.tsx`**: its `<InspectorV2>` mount drops the
  `selectedServerId`/`onClearSelection` props (now just `<InspectorV2 azId={azId} />`) — the
  component's OWN `selectedServerId`/`setSelectedServerId` reads/writes (driving the floor's
  slat/pod highlight, `RackSlot`/`FreePoolPod`'s `onSelect`) are UNCHANGED, since those still
  drive the shared `ui.store` field the dock's `deriveScope` reads independently of InspectorV2.
- **Test migration** (InspectorV2.test.tsx → faceplate/PlacementDrawer, brief-mandated, not
  deletion): the rack-selector describe block's disabling/dispatch test moved to
  `dock/drawers/PlacementDrawer.test.tsx` verbatim; the price/enter/kill describe block moved to
  `dock/ServerFaceplate.test.tsx` verbatim (each test's body unchanged, only the mount target).
  The `"clear-selection button calls onClearSelection"` test was DROPPED, not migrated — that
  affordance has no replacement in the faceplate by design: `dock/ScopeRail.tsx` (§S) already
  provides "the way out" (clicking the `az` pill clears `selectedServerId` when `nav.level ===
  'az'`, D3's "scope rail = the way out" law), so a second dedicated clear-selection control
  would be a duplicate escape hatch. `InspectorV2.test.tsx` keeps exactly one test post-T4:
  renders nothing with no traced requests (its "no selection" framing dropped along with the
  props).

### W. Polish 4 Task 5 — watching mode, the spine re-voices (`src/app/world/dock/`, 2026-07-11)

Builds ON §V (spec D7): "the shape never changes — only its temperature." §V's faceplate +
four drawers stay ONE component tree with a `running`-branch, never a fork — this task adds the
branch T4 left seams for. No engine/`nav.store.ts`/`world.store.ts`/`ui.store.ts` changes; every
live number is `useServerDisplayMetrics`'s existing scrub-or-latest `display` plus
`compiled.instances` filtered by `serverId` — nothing new published by `simulation.store.ts`.

- **`ServerFaceplate.tsx`**: gained one derived boolean, `watching = running ||
  display.scrubbing` — the D7 "watching posture" gate for the drawer pv/body re-voicing AND the
  vitals pulse's 2.2s quickening + new `data-live` attribute. Deliberately NOT `display.server !==
  null` (which would also read true after a plain Stop, since `simulation.store.ts`'s `stop()`
  leaves `latestBatch` populated with the run's last frame until the next `start()`/
  `resetSession()` — that would strand the drawers in watching mode after the user has already
  stopped and gone back to authoring). The amber **watchband** (`data-testid="watchband"`, "SIMULATION
  RUNNING — drawers are gauges now.") and `kill`'s enablement stay gated on `running` ALONE, not
  `watching` — the text is literally a claim about the sim being live, and `kill` calls
  `setOutage` against a live engine; both would be misleading/inert during a stopped scrub replay.
  Also computes `serverRps` (Σ `InstanceMetrics.rps` over `compiled.instances` filtered by this
  `serverId`) ONCE and shares it between HARDWARE's live rps row and FIREWALL's pv — no duplicate
  derivation. `svcLive` (first compiled instance's blueprint name + p50Ms, or `null` at rest/no
  instances) feeds `servicesPv`'s new optional third arg. `hardwarePv`/`firewallPv`'s watching-mode
  return values get wrapped in a `var(--color-success)` `<span>` HERE (not inside the drawer
  files) — the pv builders stay plain string functions, color is a call-site decision.
- **`drawers/HardwareDrawer.tsx`**: `hardwarePv` grew an optional second arg
  (`{cpuPct, ramPct} | null`) → `"<cpu>% cpu · <ram>% ram"` when supplied, unchanged `"<vcpu>c ·
  <ramGb>G"` otherwise (existing 1-arg call sites/tests untouched). `HardwareDrawerProps` gained
  `live?: HardwareLive | null` (`cpuFraction`/`ramFraction`/`rps`/`ramUsedMb`/`ramTotalMb` — all
  straight off `ServerMetrics`, no invented field). When `live` is set, the body branches to TWO
  live rows (`rps`, `ram` as `"<used> / <total> GB"`) above two FROZEN knob replacements
  (`data-testid="hw-frozen-vcpu"`/`"hw-frozen-ram"`, `opacity: 0.55`, `title="locked while
  running"`, a static track+fill div at the LIVE cpu/ram percentage) — **no `<input type="range">`
  renders at all** in this branch, not just a CSS-hidden thumb: the edit-lock law's
  `disabled={running}` alone would NOT have covered a stopped-but-scrubbing read (running is
  false there), so the interactive control has to be absent, not merely disabled, to stay
  non-editable during scrub. The ladder/hint/commit code above the branch point is unchanged and
  simply unused when `live` is set.
- **`drawers/FirewallDrawer.tsx`**: `firewallPv` grew an optional second arg (`liveAllowedRps:
  number | null`) → `"≈<N> req/s allowed"` (N = the shared `serverRps`, `!= null`-checked so 0
  rps still re-voices instead of falling through to the authoring string). **The component body
  is UNTOUCHED** — D7 explicitly keeps the rule sentences unchanged while watching; this is a
  **RATIFIED documented deviation** from the locked mock's `418 allowed/s · 0 blocked` +
  `— carrying all traffic` sentence suffix (`task-5-brief.md`): the frozen `MetricsBatch`
  contract carries no per-rule or blocked-connection counter, and the engine is frozen (§K), so
  there is nothing real to re-voice the body with. **T8-documented accepted asymmetry**: `+ rule`
  is `disabled={running}` (T4's original edit-lock), not `disabled={watching}` — so during a
  STOPPED scrub replay (`running` false, `watching` true via `display.scrubbing`), `+ rule` stays
  CLICKABLE while HARDWARE's knobs and SERVICES' mount control are gone/hidden for the same
  posture. This is defensible, not a bug: the edit-lock law's intent is "authoring is safe
  whenever the engine isn't live," and a stopped scrub replay is exactly that — no engine is
  running to contradict a rule you add. HARDWARE/SERVICES hide their controls for a DIFFERENT
  reason (D7 replaces their body with a live-metrics READ that has no editable control to show at
  all while watching, scrub or run alike), not because scrub-authoring itself is unsafe. No test
  asserts either polarity; left as-is per the brief's carry-forward note.
- **`drawers/ServicesDrawer.tsx`**: `servicesPv` grew an optional third arg (`{name, p50Ms} |
  null`) → `"<name> · p50 <X> ms"`. `ServicesDrawerProps` gained `compiled: CompiledWorld`
  (new, required — HardwareDrawer's own existing pattern) + `liveInstances?:
  Record<InstanceId, InstanceMetrics> | null`. When `liveInstances` is set, the body branches
  from per-PLACEMENT chip lines to one row per compiled INSTANCE (`data-testid=
  "service-live-row"`) — a placement with `count > 1` fans out to several instances, each with
  its own `InstanceMetrics`, so this is a different cardinality than the authoring chip list, not
  just a recolor — `"<blueprint name> :<port>"` + `"<health> · <rps> rps"` colored by the
  existing shared `server/healthColor.ts`'s `HEALTH_COLOR` map (success/warning/danger — a
  superset of D7's literal "success/danger," not a new color scheme). Zero instances renders the
  same `"No services mounted here yet."` string the authoring branch already used.
- **`drawers/PlacementDrawer.tsx`**: **untouched** — D7 explicitly keeps this pv/body unchanged;
  the rack `<select>` was already `disabled={running}`-locked by T4's edit-lock, which already
  covers the running case D7 cares about here (no scrub-specific gap the way HARDWARE's knobs
  had, since PLACEMENT never renders a "live" visual to begin with).
- **Vitals pulse** (`ServerFaceplate.tsx`): same `dockfp-vitals-pulse` CSS class from
  `faceplateStyles.ts` (§V) — T5 does NOT add a second animation or class. `watching` just adds
  an inline `animationDuration: '2.2s'` override (falls back to the class's 3.6s idle rate when
  `undefined`) plus `data-live="true"/"false"`, keeping D3's "same ambient stroke, rate is the
  signal" rule literally true (one keyframe, two durations, browser recalculates in place on
  the same DOM node rather than remounting — no restart-jump at the loop wrap).
- **Test migration/additions**: `HardwareDrawer.test.tsx`/`FirewallDrawer.test.tsx`/
  `ServicesDrawer.test.tsx` each gained a `pv`-re-voice case plus (Hardware/Services only, since
  Firewall's body is unchanged) a watching-posture body case; `ServicesDrawer.test.tsx`'s
  pre-existing calls all gained the new required `compiled` prop (`compileWorld(doc)`, same
  pattern `HardwareDrawer.test.tsx` already used). `ServerFaceplate.test.tsx` gained a "watching
  mode (T5, spec D7)" describe block: watchband running-only, HW/FW/SVC pv re-voice + drawer body
  integration, `data-live`/2.2s pulse, kill-lit-while-running with remove/+ still locked, and a
  scrub-posture case (`running:false`, `latestBatch:null`, `scrubBatch` set) asserting the SAME
  watching output with NO watchband — the literal D7 acceptance case.

### X. Polish 4 Task 6 — failover timeline v2 (`src/app/world/region/`, 2026-07-11)

Independent of §S–§W (the contextual-dock tasks) — spec D8 ("a git chart for your infra"),
`.superpowers/sdd/task-6-brief.md`. Replaces `TimelineStrip.tsx`'s single-lane glyph strip
(§M) with per-AZ swimlanes: colored health bands, real-event markers with hover tooltips,
static dotted causality arrows between a narrated chain's cross-lane steps, a time axis, a
legend, and (only when a chain exists) a one-sentence narration bar. Same `RegionView.tsx`
mount point and `AlertRibbon` scroll/flash wiring as before (§M's file-table row for
`RegionView.tsx` is updated in place, not duplicated here).

- **`src/app/world/region/timelineModel.ts` (new, PURE — no React/store reads)**: the region
  page's second pure-model file alongside `regionData.ts`, but unlike `regionData.ts` — which
  every `region/` view calls directly — `TimelineV2.tsx` is `timelineModel.ts`'s ONLY consumer,
  and `timelineModel.ts` itself calls INTO `regionData.ts`'s `regionEvents` (unchanged) for
  event scoping rather than duplicating that logic, the same "reuse, don't fork" instruction the
  task brief gave. Exports `TimelineBand`/`TimelineMarker`/`TimelineLane`/`TIMELINE_WINDOW_MS`
  (120_000) plus four functions: `markerClass(kind)` (the fixed `EngineEventKind → cls` map —
  `outage_triggered→kill`, `health_check_failed→hc`, `failover_started`/`failover_completed`/
  `ttl_lag_expired→shift`, `replica_promoted→promote`, else `other`); `buildLanes(regionId, doc,
  compiled, events, frames, endMs)` (one lane per AZ in doc iteration order — mirrors
  `RegionView.tsx`/`AzRow.tsx`'s own unsorted convention; bands merge consecutive in-window
  frames with equal `batch.azs[azId].health`, closing each band at the next band's start so they
  render edge-to-edge, with the final band stretched to `endMs`; markers are `regionEvents`-
  scoped events filtered to the trailing `TIMELINE_WINDOW_MS` and assigned to the lane whose
  closure — the AZ itself, a server living in it, or a compiled instance resident on it —
  contains an affected id, falling back to the first lane for region/population-scoped events
  no AZ closure claims); `narration(regionId, doc, compiled, events)` (assembles a "last kill/
  detection cluster → subsequent shift → promotion" chain in strict temporal order, returning
  `null` when there's no kill AND no detection to anchor on — verified against a REAL run, see
  the concern below); `causalLinks(lanes, chain)` (consecutive chain steps that resolve to
  different lane `azId`s, by exact event-id lookup — unambiguous since `buildLanes` assigns
  each scoped event to exactly one lane).
- **`src/app/world/region/TimelineV2.tsx` (new)**: render-only, reading `useWorldStore` (`doc`
  only), `useCompiledWorld`, `useSimulationStore` (`scrubBatch ?? latestBatch`/`running`/
  `events`/`setScrubIndex`, plus an imperative `getReplayFrames()` call **at render time**, not
  just inside the click handler — bands/markers need the frame history to draw, not only to
  scrub to it; the component has no second subscription for this, it just re-reads the getter
  fresh on every render `latestBatch`/`events` already trigger). Click-to-scrub is
  `TimelineStrip.tsx`'s exact nearest-frame-by-`simMs`-distance logic, carried verbatim
  (disabled while `running`, same title string). Renders `null` when the region has zero AZs
  (`buildLanes` returns `[]`) — note this is a NARROWER null-gate than `TimelineStrip.tsx` had
  (that returned `null` on zero SCOPED EVENTS; this timeline is a health-band "git chart" that's
  meaningful even with no events at all, so it now only goes away when there's truly nothing to
  show a lane for). **Overlapping-marker stagger** (found via live verification, not spec'd):
  two markers can legitimately land at the identical `simMs` in the same lane — verified live,
  a replica promotion can fire on the SAME engine tick as the manual kill that triggered it,
  well before the AZ's aggregate health check confirms down — so markers within
  `CLUSTER_EPSILON_PCT` (1.5% of the window) of an earlier marker in the same lane stagger
  vertically (alternating above/below center, `STACK_STEP_PX = 9`) instead of rendering
  dead-on-top with the later one eating every click.
- **`src/app/world/region/timelineStyles.ts` (new)**: the same injected-stylesheet-once idiom
  `r3Styles.ts`/`hwStyles.ts`/`azFloorStyles.ts` established, self-contained rather than
  extending `r3Styles.ts` (a different, older mockup's stylesheet — `r3Styles.ts`'s own header
  comment ties it to `level-redesign-v5.html`'s `.r3` section, not this task's mock). Exposes
  theme-aware `--tl-teal`/`--tl-violet` (from `CATEGORY_COLORS.network`/`.messaging`, the same
  swap-on-light-theme idiom `r3Styles.ts` uses for its own `--r3-teal`) for the shift/promote
  marker classes, plus the ONE CSS transition D8 guarantee 5 permits: marker hover-scale. No
  `@keyframes`, no infinite animation — relies on the app's existing blanket
  `prefers-reduced-motion` override (`src/index.css`, the same precedent its own
  `.region-timeline-flash` comment documents) rather than a component-level `useReducedMotion()`
  call, since this is a plain CSS `:hover` transition with no JS-driven animation loop.
- **Band/marker color tokens**: band tints are `color-mix(in srgb, var(--color-success/warning/
  danger) N%, transparent)` (13/13/15%, borders 24/27/30%) — this codebase's established way to
  alpha-blend a `var(--color-*)` token in both themes (`ui/kit.tsx`, `dock/*Styles.ts`,
  `server/InspectorRail.tsx` all do the same), NOT the mock's literal `#22c55e22` family, which
  is dark-mode-only. Marker chip fills mix each class's accent into `var(--color-node-base)`
  (not `transparent`) for an opaque circle that stays legible on a light card — a theme-aware
  stand-in for the mock's near-black per-class literals, which would look wrong outside a dark
  scene (D8: this strip is normal region-view chrome, not an instrument-header dark scene).
- **`src/app/world/RegionView.tsx`**: `<TimelineStrip regionId={regionId} />` → `<TimelineV2
  regionId={regionId} />` at the identical mount point, inside the same `<div ref={timelineRef}>`
  the `AlertRibbon` scroll/flash wiring already targets — that wiring is untouched.
- **`src/index.css`**: `.region-timeline-flash`'s comment updated in place (was "RegionView /
  TimelineStrip, Phase 4 T3") to note the Task 6 swap — the CSS rule itself is unchanged, still
  targets the same wrapper div.
- **Test migration**: `TimelineStrip.test.tsx` is deleted; its scrub-click-nearest-frame and
  running-disabled-with-title cases are carried into `TimelineV2.test.tsx` (same behavioral
  intent, new component, new assertions since markers are no longer bare glyph buttons but
  `data-testid="tl-marker"`/`data-cls` elements). Its other two cases (region-scoping,
  null-with-no-events) were NOT carried — scoping is now covered at the `timelineModel.test.ts`
  level (`buildLanes`'s marker-assignment tests), and the null gate changed shape (see above).
  `RegionView.test.tsx` needed three incidental fixes: `TimelineV2` now renders every AZ's label
  a second time (as its lane label), so a bare `getByText('us-east-1a')` became ambiguous —
  those three assertions now scope into the `AzRow` card via its pre-existing `data-az-row`
  marker (`within(container.querySelector('[data-az-row="..."]'))`) rather than querying the
  whole document.
- **Concern (verified live, not a spec gap)**: `narration()`'s fixed `kill → detection → shift →
  promotion` template only includes a step when it falls AT OR AFTER the previous step's
  `simMs` — driving the actual app against the "Classic three-tier" example world, a kill +
  replica-promotion fired on the identical tick (both before the AZ's health-check debounce
  ever resolved), so the promotion was correctly OMITTED from that run's narration rather than
  being attributed to a detection that chronologically followed it. This is intentional (never
  claim a causal order the data doesn't support), but means a real "full four-segment chain" is
  rarer in practice than the locked mock's illustrative copy suggests. Separately,
  `failover_started`/`failover_completed`/`ttl_lag_expired` carry population/region ids, never
  AZ ids (confirmed against `worldEngine/index.ts`), so a "shift" marker almost always lands on
  `buildLanes`' first-lane fallback rather than the AZ actually receiving the traffic — a
  documented, data-shape-driven limitation of AZ-level attribution for region/population-scoped
  events, not a bug in the assignment logic itself.

### Y. Polish 4 Task 8 — sweep + gate (`docs/superpowers/specs/2026-07-11-polish4-contextual-dock-design.md` D3/D10/D11/D12, 2026-07-12)

The phase's closing task: cross-cutting audits over everything §S-§X (+TA) built, a handful of
carry-forward Minor fixes, and this reconciliation pass. No engine/store changes (Global
Constraints honored — `git status --short src/lib/worldEngine/` clean, zero new store actions).

**The `dock/` module, consolidated.** `src/app/world/dock/` is now the home for every scope-aware
dock surface built across T1-T5: `scope.ts` + `scopeData.ts` (pure — see §S for the full API),
`ScopeRail.tsx` (§S), `AtlasHeader.tsx` + `RegionConfigTab.tsx` (§T, world/region),
`FloorPlanHeader.tsx` + `AzConfigTab.tsx` (§U, az), `ServerFaceplate.tsx` + `drawers/{Hardware,
Firewall,Services,Placement}Drawer.tsx` (§V/§W, server) — plus three colocated stylesheet
modules (`faceplateStyles.ts`/`floorPlanStyles.ts`, the injected-once idiom `ui/kit.tsx`
established) and no others. **Import boundary rule (explicit, was previously only implicit
across §S's per-file prose): `scope.ts`/`scopeData.ts` may be imported by `WorldPanel.tsx` (the
scope-deriving hub) and by the dock instrument components listed above — nothing under
`region/`/`az/`/`server/`/`globe/`/`panels/` reaches into them.** Both files stay React/store-free
by construction (type-only imports of `WorldLevel`/`PanelTab` excepted) specifically so they stay
importable from anywhere in the dock without dragging a store dependency into a pure derivation —
new dock work should extend `scopeData.ts`'s existing helpers (`scopeEntityIds`/`scopedEvents`/
`scopedFindings`/`scopedCost`) rather than re-deriving a scope filter inline (see the
`AzConfigTab` fix below for what re-deriving instead of reusing costs).

**InspectorV2 selected-server-pane retirement (§V, Task 4) — confirmed final at T8.**
`InspectorV2.tsx` is AZ-scoped only now: its props shrank to `{ azId: AzId }`, it renders ONLY
the traced-request list (poll + hop-table expansion), and its Polish-3-T4-era selected-server
rack-selector/enter/kill card is gone — those three dispatches (`assignServerToRack`/`goServer`/
`setOutage('server', …)`) now live on `dock/PlacementDrawer.tsx`/`dock/ServerFaceplate.tsx`
respectively, reached via the SAME `ui.store.selectedServerId` the floor's minimap/slats write
(§S/§U). No further InspectorV2 changes landed after §V; T8's audit re-confirmed zero remaining
selected-server references in the file.

**TimelineStrip → TimelineV2 (§X, Task 6) — confirmed final at T8.** `TimelineStrip.tsx` is
deleted; `region/TimelineV2.tsx` + the new pure `region/timelineModel.ts` are the permanent
replacement (per-AZ swimlanes, health bands, real-event markers, causality arrows, narration bar,
ZERO ambient animation — ratified motion budget, see below). Mount point and `AlertRibbon`
scroll/flash wiring unchanged from `TimelineStrip`'s. See §X for the full file-by-file account;
nothing further changed here at T8 beyond the motion-inventory entry below.

**`routing.ts`'s `regionOrderFor` extraction (§X, Task 7) — confirmed final at T8.** A
byte-identical refactor (`routing.test.ts` unmodified, `regionOrderFor.test.ts` proves parity
across all four policies) that gave the compiler a second, pre-compile consumer:
`globe/TrafficPlacementLayer.tsx`'s placement-mode preview card calls `regionOrderFor` directly
on a not-yet-placed `WorldCity` to compute the exact landing region before any population exists
in the doc. T8 cleaned up the one cosmetic leftover in its test file — see the Minors table below.

#### Motion-inventory additions (the T8 sweep, dock/timeline/globe)

Mirrors the Polish-3 T8 sweep's own inventory table (above, "Motion budget (spec D1)") — same
method: every `animation:`/`animate`/`<animate>` occurrence under `dock/`, `region/TimelineV2.tsx`
+ `timelineModel.ts`, and `globe/TrafficPlacementLayer.tsx` was inventoried and checked against
D3's "exactly ONE ambient stroke per dock, at rest only the ratified exceptions" rule.

| Element | Gate | Budget | Reduced motion |
|---|---|---|---|
| Atlas top arc (`AtlasHeader.tsx`, `dashflow 1.2s`) | `running && topRps > 0 && !reduced` | 1 (top-ranked route only; ≤2 more render static) | class/style omitted entirely when `reduced` |
| Floor-plan LED (`AzConfigTab.tsx`, `dockfp-blink 2.4s`, class in `floorPlanStyles.ts`) | `running && !reducedMotion`, single busiest server by mean CPU | 1 (hard cap, not a ranked-N-of-M set like the floor's own `MAX_ANIMATED_LEDS=3`, §U/§R — this is the DOCK's independent, smaller budget) | component-level gate (`busiestServerId` returns `null`) AND a `@media (prefers-reduced-motion: reduce)` CSS neutralizer — belt-and-suspenders, same pattern `azFloorStyles.ts`/`hwStyles.ts`/`gateStyles.ts` use |
| Faceplate pulse (`ServerFaceplate.tsx`, `dockfp-vitals-breathe`, class in `faceplateStyles.ts`) | always mounted; rate only changes | **RATIFIED bounded exception to the static-at-rest law** — 3.6s idle / 2.2s watching (`animationDuration` inline override) | class omitted (`reducedMotion ? undefined : 'dockfp-vitals-pulse'`) + CSS `@media` neutralizer, both verified by a T8-added test (`reduced motion disables the pulse animation even while running/watching`) |
| Place-mode ghost ring blink (`globe/TrafficPlacementLayer.tsx`, `GhostRing`, visibility-toggle `blink 2s steps(1)`) | `placeMode` only (component returns `null` otherwise) | **RATIFIED bounded exception** — an authoring-mode affordance, "like a text caret" per the file's own comment | `useReducedMotion()` → mesh stays permanently visible (no toggle) instead of blinking |
| Timeline v2 (`region/TimelineV2.tsx` + `timelineModel.ts` + `timelineStyles.ts`) | n/a | **ZERO animation** — `timelineStyles.ts`'s own header comment: "No keyframes, no infinite animation" | the ONE permitted motion (marker hover-`scale(1.35)`) is a plain CSS transition, collapsed to 0.01ms by the app's existing blanket `prefers-reduced-motion` rule in `src/index.css` |
| Ghost great-circle arc (`globe/TrafficPlacementLayer.tsx`, `GhostArc`) | n/a | static dashed line, rebuilt only on city/landing change — explicitly NOT per-frame dash-flow (unlike `ArcsLayer.tsx`'s live traffic arcs) | n/a (never animates) |

**`jsdom` has no `getAnimations()` implementation** (verified: `Element.prototype.getAnimations`
is `undefined` under this repo's jsdom 29.1.1 — a real API gap, not a config issue), so — matching
every prior motion-law test in this codebase (T2's/TA's regression tests, T5's pulse test) — the
above is locked by class-name/`data-*`-attribute assertions instead (e.g. `dot.className).not
.toMatch(/kit-ripple/)`, `vitals-pulse`'s `data-live`/`style.animationDuration`), not a live
Web-Animations-API read; the table above is the accompanying static/code-read audit.

**TopologyPanel `ripple={running}` — adjudicated (world-scope AZ-list rows) — FIXED to static.**
`panels/TopologyPanel.tsx`'s `ServerRow` (world scope's Topology tab, ~line 213) passed
`ripple={running}` into every server row's `EdgeRow`, the exact same always-on
`kit-ripple 1.6s ease-out infinite` pattern T2 already removed from `dock/RegionConfigTab.tsx`'s
AZ rows (§T, commit `485ea33`) for violating D3's one-ambient-stroke-per-dock law — a running sim
with N healthy servers showed N simultaneous ripples alongside the atlas's own marching top arc.
This predates Polish 4 (TopologyPanel's `wtree` reskin is §T-adjacent styling-only work, but the
`ripple` prop itself is older, Phase-2-era), so T2's own carry-forward note explicitly deferred
its adjudication to this task rather than silently leaving it. **Verdict: made static**, for
consistency with the RegionConfigTab precedent and because TopologyPanel IS the world-scope
dock's Config-adjacent body (D3's "today's seven tabs" row) — same one-ambient-stroke law
applies. `ripple={running}` (and the now-unused `running` local it depended on) was deleted; no
pre-existing test asserted the ripple (verified via grep before the fix), so nothing needed
migrating, and one regression test was added mirroring T2's own (`server row status dots never
carry the ripple animation, even with a healthy status while running`).

#### Other T8 audit results

- **Emoji scan** (`grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' src/`): every Polish-4 hit
  is a sanctioned glyph (`region/TimelineV2.tsx`'s `GLYPH` map — `✕ ♺ ⇄ ⬆ ●` — is drawn EXACTLY
  from D11's approved list, by design, §X). One pre-existing, out-of-phase hit survives:
  `app/world/ui/kit.tsx`'s `Segmented` component test (`kit.test.tsx`, Polish 3 Task 1, commit
  `fb060fb3` — before this branch existed) passes literal `'⚡ latency'`/`'🌍 geo'` as ARBITRARY
  fixture label text proving the generic component doesn't special-case string content; it never
  renders in the real app (`TrafficPanel.tsx`'s actual routing-policy labels are plain
  `'latency'`/`'geo'`/`'weighted'`/`'priority'`, no glyphs). Left as out-of-scope (Polish 3, test
  fixture only, not a Polish-4 surface) rather than edited.
- **Price-token audit** (every `$`/`toFixed`/`/hr`/`/mo` in `dock/`, `region/TimelineV2.tsx`,
  `globe/TrafficPlacementLayer.tsx`): PASS, all price-colored — `AtlasHeader.tsx` (world/region
  headline), `FloorPlanHeader.tsx` (az headline), `AzConfigTab.tsx` (cost row), `ServerFaceplate
  .tsx` (plate price), `TrafficPlacementLayer.tsx` (egress line). No misses found.
- **Singular/plural audit**: PASS — every new count-driven string already ternary-guards its
  plural (`RegionConfigTab.tsx`'s `N server{N===1?'':'s'}`, `AtlasHeader.tsx`'s city/cities,
  `HardwareDrawer.tsx`'s connection/connections, `ServicesDrawer.tsx`'s single-placement branch
  that never falls through to its bare-plural `"N services"` string at N=1). `TimelineV2.tsx`'s
  `{lane.serverCount} srv` is intentionally unpluralized (an abbreviation, not a natural-English
  plural noun) — matches the brief's own listed-correct example.
- **Light-theme audit** (every NEW below-header surface, headers exempt per D3): found and fixed
  TWO real hardcoded-hex misses (neither previously caught because neither had a light-theme-
  specific test): (1) `dock/drawers/FirewallDrawer.tsx`'s rule-sentence id spans copied
  InspectorRail's exact `#DBEAFE` verbatim, calibrated for InspectorRail's OWN always-dark scene
  background — but this drawer body sits on the theme-flipping `var(--color-canvas)`, so in light
  theme the pastel-blue text read at ~1.1:1 contrast (functionally invisible) against the
  near-white light canvas. Swapped to `var(--kit-accent)` (the SAME theme-aware id/hud token
  every other dock surface already uses), with a regression test locking the token. (2)
  `globe/TrafficPlacementLayer.tsx`'s Html preview card `<span>{PREVIEW_RPS} rps</span>` used the
  same raw `HUD_TEAL` hex its WebGL ring/arc materials legitimately need (three.js `Color` can't
  parse a CSS custom property — that WebGL usage is correctly unchanged, matching the globe's
  established `RegionPins.tsx`/`ArcsLayer.tsx` fixed-hex-for-scene-geometry precedent), even
  though the card ITSELF already used `var(--color-*)` tokens for every other span — an
  inconsistency, not a deliberate scene-chrome choice. Swapped that one DOM span to
  `var(--kit-teal)` (same dark-theme value, WCAG-checked light swap already defined in `ui/kit
  .tsx`). This file has no jsdom test (WebGL, live-smoke-gated per its own header comment), so no
  test to add. Everything else audited (dock/'s remaining hardcoded hex — `AtlasHeader.tsx`'s
  `ATLAS_*`/`FloorPlanHeader.tsx`'s `MINIMAP_*`/`ServerFaceplate.tsx`'s `PLATE_*`/`KIND_CHIP_*` —
  is confined to the three documented instrument-header scenes, D3's carve-out, verified by
  reading each component's returned JSX for containment) was already token-correct.

#### Carry-forward Minors resolved

| Minor (source task) | Resolution |
|---|---|
| `dock/AzConfigTab.tsx` recomputes `computeWorldCost().byAz` inline instead of `scopedCost` (T3); doc claimed otherwise (T3) | **Fixed**: now calls `scopeData.ts`'s `scopedCost({kind:'az',…})`, the SAME helper `FloorPlanHeader.tsx` already used — dedupes the two call sites. The doc's pre-existing "reads the SAME helper" claims (§U, ~1362 and ~1418) are now both true; the ~1418 entry's wording corrected in place |
| `dock/drawers/HardwareDrawer.tsx` computes `firstInstance`/RAM-hint BEFORE the `if(live) return` early return (T5) | **Fixed**: `if (live)` is now the FIRST statement in the component; `ladder`/`index`/`commit`/`firstInstance`/`firstBlueprint`/`vcpuHintText`/`residentMb`/`ramHintText`/`disabled` all moved below it (authoring-only, never read by the live branch) |
| No test for `reducedMotion===true && watching===true` on the vitals pulse (T5) | **Fixed**: `ServerFaceplate.test.tsx` gained `reduced motion disables the pulse animation even while running/watching` |
| `lib/world/regionOrderFor.test.ts`'s `void euwest` lint-silencer (T7) | **Fixed**: the test's destructure no longer pulls `euwest` at all (it was never read besides the silencer) |
| No `WorldShell.test.tsx` — T1's selection-clear effect and T7's Escape-disarm priority both untested at that level (T1+T7) | **Fixed**: new `src/app/world/WorldShell.test.tsx`, 4 tests — two for the selection-clear effect (AZ change; level change), two for Escape priority (armed → disarms, `nav.up()` NOT called, verified via a spy; unarmed → falls through to `nav.up()` as before). Arms place-mode via `TrafficPanel`'s own "+ place on globe" toggle (`GlobeView`'s HUD button doesn't render in jsdom — no WebGL, `GlobeCards` fallback) |
| Dead `ScopedConfigBody` region branch (T2) | **Left as-is, documented** — see the updated §T passage above (now covers the T8-final state: all three non-world branches are dead, not just region, and why it stays) |
| Top-arc opacity 0.7 vs mock 0.65 (T2) | **Left as-is** — cosmetic, no functional/legibility impact, not touched |
| FW `+ rule` stays enabled during scrub-only watching (T5) | **Left as-is, documented** — see the updated §W passage above |

#### Gate

Full suite green (868/868 — 861 baseline + 7 new: `TopologyPanel.test.tsx` +1, `FirewallDrawer
.test.tsx` +1, `ServerFaceplate.test.tsx` +1, `WorldShell.test.tsx` +4), `npx tsc --noEmit` clean,
`npm run build` green. Zero diffs under `src/lib/worldEngine/`; zero new store actions.

---

## 2. Shared "hub" files (everyone touches these — high conflict risk)

These aren't feature modules; they're registries other code plugs into. The fix
isn't to avoid them, it's to **only ever append/extend, never restructure, in a
routine PR** — restructure them in their own dedicated PR when nobody else has
in-flight changes.

| File | Why it's a hub | Fan-in (CodeGraph-verified) |
|---|---|---|
| `src/lib/nodeConfig.ts` (~70 lines) | Packet-template types only (`PacketTemplate`/`PacketMode`/`PacketRegistry`) — consumed by `serializer.ts` (`.scalemap` v2 `packets` key) and referenced by `BlueprintDependency.packetTemplateId`. The canvas-era `NODE_CONFIG` icon registry, `NodeSimConfig`, edge configs, and workload helpers were removed 2026-07-12 with zero live consumers (see git history). No longer a hub — fan-in is 1 real importer. |
| `src/lib/theme.ts` (120 lines) | `ColorTokens`/`DARK_COLORS`/`LIGHT_COLORS`/`CATEGORY_COLORS`/`FONT_*`/`SPACING`/`MOTION` — small file, but touched by any node/edge visual change. Only the 16 `ColorTokens` keys (`canvas`, `canvasDots`, `nodeBase`, `nodeBorder`, `surface`, `surfaceHover`, `toolbar`, `toolbarBorder`, `textPrimary`, `textSecondary`, `textMuted`, `danger`, `success`, `successText`, `warning`, `accent`) are exposed as `--color-*` CSS custom properties by `App.tsx`'s `useThemeBootstrap` and mirrored in `src/index.css`'s static `:root` fallback. `CATEGORY_COLORS` (messaging/network/storage/etc per-category accents) is **not** exposed to CSS — only consumed directly in `.tsx` via inline styles (`BaseNode.tsx`/`GroupNode.tsx`, both deleted 2026-07-08, §A). **2026-07-02 bug-fix sweep migrated every remaining panel CSS module** (SimConfigPanel, PacketEditor, EventLogPanel, ReportsPanel, PropertiesPanel, MetricGraphOverlay, RequestInspector, DiagnosticsPanel, PlaybackScrubber, MetricsDrawer, CostTracker, HomeScreen, ContextMenu, NodePalette, StatusBar, BaseNode/GroupNode leftover fallbacks, Canvas.module.css, edges.module.css — ~545 hardcoded hex values total) to `var(--color-*)`/`color-mix()` — **historical note: every file in that list except `HomeScreen` was deleted 2026-07-08 (Phase 2 Task 17, §A/§B/§D/§E/§F/§H/§I)**; kept here as a record of the token-migration effort, not as a current file inventory. `theme.ts` itself, `HomeScreen.module.css`, and `src/app/world/`'s CSS are the surfaces that still matter today. | `HomeScreen.tsx`, `src/app/world/**` |
| `src/index.css` | `:root` holds a **static copy of `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION`** (closes a first-paint FOUC gap — every `var(--color-*)` reference would otherwise be undefined until `App.tsx`'s `useThemeBootstrap` `useEffect` runs post-first-paint). This is a values-only fallback, not a second source of truth — if `theme.ts`'s `DARK_COLORS`/`FONT_*`/`SPACING`/`MOTION` change, update this block to match (nothing enforces the two staying in sync) | Every CSS module transitively (first paint only — overridden by the bootstrap effect on mount) |
| `src/app/store/ui.store.ts` | **Trimmed 2026-07-08 (Phase 2 Task 17) to `themeMode: 'dark' \| 'light'` + `setThemeMode` only** — every other field (`activeTool`, `leftSidebarOpen`/`rightSidebarOpen`/`rightTab`, `selectedNodeId`/`selectedEdgeId`, `gridEnabled`, `connectSourceId`, `contextMenu`, `simConfigOpen`/`simConfigPanelNodeId`, `dockOpen`/`dockTab`, `packetEditorOpen`, `highlightedNodeIds`) was read only by the legacy canvas/simulation/sidebar/toolbar/dock UI deleted the same task (§A/§B/§D/§E/§F/§H/§I) — grep-verified zero remaining readers before trimming. Drives the runtime CSS custom-property bootstrap in `App.tsx` that every panel's CSS module reads via `var(--color-*)`; persisted to `localStorage` (`scalemap-theme-mode`). `App.tsx` is now the **only** file reading this store (`themeMode`, to bootstrap the CSS vars) — there is currently no UI control to call `setThemeMode` (the old toggle lived in the deleted `Toolbar.tsx`); a future task should add one to `WorldShell.tsx`'s header. If a future phase wants a "focus this node" pulse, a floating-panel-open registry, etc., re-add the specific field then rather than resurrecting the old multi-concern shape. **2026-07-10 (Polish 1 Task 6 — examples vault, §P):** gained a SECOND, unrelated field — `pendingPanelTab: PanelTab \| null` (initial `null`) + `setPendingPanelTab` — additive, `themeMode`'s contract untouched. `PanelTab` (`'topology'\|'blueprints'\|'placements'\|'traffic'\|'analysis'\|'events'\|'cost'`) is exported from here now, not from `WorldPanel.tsx` (view→store type import). One-shot signal: `HomeScreen.tsx`'s `openExample` sets it to `'analysis'` only for the teaching vault card, `WorldPanel.tsx` reads it once in a `useState` initializer and clears it in a mount effect. **2026-07-11 (Polish 4 Task 1 — contextual dock, §S):** gained a THIRD, unrelated field — `selectedServerId: ServerId \| null` (initial `null`) + `setSelectedServerId` — the AZ floor's (`az/DatacenterFloor.tsx`) selection, lifted out of local `useState` so the dock's derived scope (`app/world/dock/scope.ts`) and the floor's own highlight read the SAME value; cleared by one shared `WorldShell.tsx` effect on any `nav.level`/`nav.azId` change, not by the floor itself anymore. `PanelTab` gained an 8th member, `'config'` (the non-world scopes' shared entity-config tab id). **2026-07-11 (Polish 4 Task 3 — the floor-plan instrument, §U):** two more `selectedServerId` readers/writers — `dock/FloorPlanHeader.tsx` (the minimap IS the selection surface: a cab/pod click writes it, the `sel`-class shape reads it) and `dock/AzConfigTab.tsx` (a slat click writes it, a matching row gets a selected border) — no field/shape change, purely additive fan-in. **2026-07-11 (Polish 4 Task 4 — the faceplate + drawer spine, §V):** one more `selectedServerId` WRITER (`dock/ServerFaceplate.tsx`'s `remove…` action clears it after `removeServer`) — still no field/shape change; `InspectorV2.tsx` drops OUT of this field's fan-in the same task (its own selected-server pane retired, §V) | `App.tsx` (`themeMode`), `HomeScreen.tsx` + `WorldPanel.tsx` (`pendingPanelTab`), `DatacenterFloor.tsx` + `WorldShell.tsx` + `WorldPanel.tsx` + `dock/ScopeRail.tsx` + `dock/FloorPlanHeader.tsx` + `dock/AzConfigTab.tsx` + `dock/ServerFaceplate.tsx` (`selectedServerId`) |
| `src/app/store/simulation.store.ts` | **The only simulation store since 2026-07-08 (Phase 2 Task 17 deleted its legacy sibling, `simulationLegacy.store.ts`, §K).** Rewritten in Task 12 as the v2 world-engine store — `MetricsBatch`/`EngineEvent`/render-scope shape from `worldEngine/types.ts`. Consumers: `SimControls.tsx`, `EventsTab.tsx`, `WorldShell.tsx`, `GlobeView.tsx`/`RegionView.tsx`, `AzCanvas.tsx`, `ScrubberV2.tsx`, `InspectorV2.tsx`, `CostTab.tsx` (§J) — the `AzCanvas.tsx` entry is stale (deleted Polish 3 Task 4, superseded by `az/DatacenterFloor.tsx`). **2026-07-11 (Polish 4 Task 4, §V):** `dock/ServerFaceplate.tsx` gained `running`/`healthOverrides`/`setOutage` reads (the SAME `setOutage('server', ...)` call `InspectorV2.tsx`'s now-retired pane used to make) and every drawer body reads `running` via a plain prop (not a fresh store subscription — `ServerFaceplate.tsx` is the only new subscriber, drawers stay dumb). **2026-07-11 (Polish 4 Task 5, §W):** no new store reads — `ServerFaceplate.tsx` derives `watching` (running OR scrubbing) from fields it already subscribed to in §V (`running` from this store, `display.scrubbing` from `useServerDisplayMetrics`'s existing `scrubBatch`/`latestBatch` reads); `HardwareDrawer`/`ServicesDrawer` gained live-metrics PROPS (`live`/`liveInstances`), not store subscriptions of their own — still dumb | `src/app/world/**` (see §J's per-file Task 13/15/16 notes) |

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

---

## Regional Load Balancer — Phase 1 (accurate ALB/NLB, cross-zone AZ distribution)

The region-internal load balancer — the tier "between the AZs" that was previously a hardcoded
equal split inside `worldEngine/index.ts` — is now a real, authorable device. Phase 1 ships the
L4/NLB device with a configurable **cross-zone** setting; L7 listener rules + the route/packet
system are Phase 2 (parked, not built).

**New model (`src/lib/world/types.ts`)** — a `LoadBalancer` entity (id-keyed, region-scoped like
`ManagedService`): `mode: 'l4'|'l7'`, `crossZone`, `algorithm: 'round-robin'|'weighted'`,
`listenerRules: ListenerRule[]` ([] in L4), `defaultTargetBlueprintId` (null = all entry
blueprints). Added to `WorldDoc.loadBalancers`. A target group is modeled implicitly as all
healthy instances of a target blueprint in the region (explicit target groups: future). The LB is
abstract managed infra (no rackable server, no SPOF/capacity — matches AWS, and the app's prior
abstraction).

**Compiled gate (additive) (`src/lib/world/routing.ts`, `types.ts`)** — `CompiledRouting.lbRouting:
Record<RegionId, CompiledLbRouting>` (`{ mode, crossZone, algorithm, rules, defaultTargetBlueprintIds }`).
`computeLbRouting` synthesizes a default LB per region when none is authored: **NLB (L4,
cross-zone OFF)** whose default targets are the region's entry blueprints (public port) that have
≥1 instance there. This default is byte-equivalent to the pre-LB equal-per-AZ distribution, so
every engine golden test passes unchanged. `CompiledRouting` is extended additively (never
reshaped) — it fans out to every view + the engine.

**Engine (`worldEngine/index.ts` hub, `routingRuntime.ts`)** — the old inline `distributeToEntries`
now delegates to a new pure, reusable helper `distributeToTargets` (`routingRuntime.ts`):
- **cross-zone OFF (NLB default)** — `perAz = rps / servingAzCount`, then one round-robin
  instance per healthy target blueprint in the AZ (entry-node == serving-AZ). An AZ with **no
  healthy target for this group is pulled from rotation** (mirroring AWS removing a zone with no
  healthy targets from DNS) and its share **redistributes** to the AZs that can serve — it is
  **not** forfeited. Only when *no* AZ in the region can serve does the group's traffic drop.
  (Superseded the earlier "empty AZ forfeits its per-AZ share" model — 2026-07-24, see the dated
  entry below.)
- **cross-zone ON (ALB)** — every healthy target instance region-wide gets an equal split
  (entry-node decoupled from serving-AZ), so unequal per-AZ instance counts skew per-AZ totals.
`distributeToTargets` takes an input object (target blueprint ids + rps + cross-zone + the compiled
AZ tables + health fns + cursors + accumulator) so Phase 2 can call it once per matched route.
Reuses `azSplit` (healthy-AZ filter) + `pickInstance` (round-robin cursors). `index.ts` dropped its
`azSplit`/`pickInstance` imports (both now live inside the helper); `entryBlueprintIds` stays —
still read by the particle builders.

**Store (`app/store/world.store.ts`)** — `addLoadBalancer(regionId)` / `updateLoadBalancer(id,
patch)` via the existing `mutate()` (undo/dirty for free). `withoutRegion` cascades LB deletion
(mirrors its `managedServices` cascade).

**Config UI (`app/world/dock/RegionConfigTab.tsx`)** — a `LOAD BALANCER` section below the AZ
list: cross-zone + algorithm `Segmented`s, edit-locked while running via a `<fieldset disabled>`.
Reads the authored LB or shows the synthesized default (cross-zone off); the first edit lazily
creates the LB. Mode is L4-only this phase (L7 toggle arrives with listener rules in Phase 2).

**Persistence (`serializer.ts`)** — `loadBalancers` serializes with the whole `world`; deserialize
defaults it to `{}` for pre-LB files (same additive-normalization pattern as `racks`), and
`compileWorld` synthesizes the default LB from there — old `.scalemap` files load and behave
identically.

**Gate** — new TDD tests: `routing.test.ts` (+3, lbRouting synthesis), `routingRuntime.test.ts`
(+3, distributeToTargets cross-zone on/off/down-AZ), `world.store.test.ts` (+3, LB actions +
region cascade), `serializer.test.ts` (+1, back-compat default), `RegionConfigTab.test.tsx` (+3, LB
section render/toggle/edit-lock). All engine golden tests green (byte-equivalence proven);
`npm run build` clean. Phase 2 (routes + L7) is scoped but not built.

---

## Regional Load Balancer — weighted algorithm made real (2026-07-24)

`LoadBalancer.algorithm: 'weighted'` existed since Phase 1 (selectable in the UI, compiled into
`CompiledLbRouting.algorithm`) but was **never actually consumed** — `distributeToTargets` always
split traffic equally regardless of the selected algorithm, and there was no UI to author weights
in the first place. This closes both gaps with a per-AZ weight, the natural fit given
`distributeToTargets` already operates at the region→AZ tier.

**Model (`world/types.ts`)** — `LoadBalancer.azWeights?: Record<AzId, number>` (optional; missing
AZ ⇒ default weight 1, so authoring nothing under 'weighted' behaves like an equal split).
`CompiledLbRouting.azWeights: Record<AzId, number>` (non-optional; `routing.ts`'s
`computeLbRouting` defaults it to `lb?.azWeights ?? {}`).

**Engine (`worldEngine/routingRuntime.ts`)** — `DistributeInput` gained `weighted?: boolean` +
`azWeights?: Record<AzId, number>`; `index.ts`'s `distributeViaLb` passes
`lb.algorithm === 'weighted'` and `lb.azWeights` through on every call. A new `azShares` helper
splits a total across a set of AZ ids proportional to weight (default 1, floor 0) when `weighted`
is true and at least one candidate has positive weight; otherwise (unweighted, or an all-zero
weight set — mirroring `resolveRegion`'s `pickWeighted` fallback for an all-zero region-weight
policy) it falls back to the pre-existing equal split. Both branches use it:
- **cross-zone off** — `perAz` (previously always `rps / servingAzCount`) now comes from
  `azShares`, i.e. an AZ's authored weight, not just its "is it serving" status.
- **cross-zone on** — previously one flat split across every healthy target instance region-wide
  (so an AZ's instance *count* skewed its share). Weighted mode now groups targets by AZ first,
  takes `azShares` for the AZ-level total, then splits *that* evenly across the AZ's own
  instances — instance count no longer skews the ratio, only the authored weight does.
`weighted` unset/false takes neither of the new code paths, so round-robin LBs (the default) are
byte-identical to before this change — no golden-test impact.

**Config UI (`app/world/dock/RegionConfigTab.tsx`)** — `LoadBalancerSection` now takes the
region's `azs` list (from `RegionConfigTab`, which already computed it for the AZ rows above).
Selecting `algorithm: 'weighted'` reveals one `type="number"` input per AZ
(`aria-label="az-weight-${azId}"`, defaulting to `1` when unset), patching
`azWeights: { ...azWeights, [azId]: value }` on change (min 0; blank/NaN clamps to 0, which
`azShares`' fallback then treats as "equal split" if every AZ ends up at 0). Switching back to
`round-robin` hides the inputs again without clearing `azWeights` — flipping back to `weighted`
later restores the authored values.

**Gate** — `routingRuntime.test.ts` (+3: weighted cross-zone-off proportional split, weighted
cross-zone-on per-AZ-then-even split, all-zero-weight fallback), `routing.test.ts` (updated for
the additive `azWeights: {}` field), `RegionConfigTab.test.tsx` (+2: inputs hidden/shown by
algorithm, editing an input patches `azWeights` while leaving unset AZs defaulted not persisted).
Full suite green (1344 tests); `tsc --noEmit` clean.

---

## Regional Load Balancer — Phase 2 (route/packet system + L7 listener rules)

Phase 2 gives the LB's L7 mode real meaning by **reviving the dormant packet system** as a route
catalog and making the engine's ingress distribution route-aware. Everything is additive on top of
Phase 1; back-compat is preserved by construction (a world with no routes/mix and an L4 LB ticks
byte-identically to Phase 1).

**Route catalog — packets fold into `WorldDoc` (`world/types.ts`, `nodeConfig.ts`,
`factories.ts`)** — `WorldDoc.packets: PacketRegistry` is now a first-class collection (previously
the registry existed only as a serializer type the running app never populated). Its
**HTTP-protocol templates ARE the routes**: a route = an `HttpTemplate` (method + path, plus
size/workload for later realism). `nodeConfig.ts` gained pure, immutable route helpers —
`emptyPacketRegistry`, `listRoutes`, `getRoute`, `addRoute`, `updateRoute`, `removeRoute`,
`routeIdOf` (routeId = the template id, stringified), and `routeMatchesPattern` (glob-prefix
first-match, shared by compile + engine + analysis). Living inside `WorldDoc` means every route
edit rides `mutate()` (undo/dirty) and serializes with the world.

**Population request mix (`world/types.ts`, `worldEngine/demand.ts`)** —
`ClientPopulation.requestMix?: { routeId; weight }[]` (absent ⇒ one implicit default route at
100%). `demand.ts` `splitDemandByMix(totalRps, requestMix?)` splits the (already-jittered) scalar
into per-route rps — a pure proportional split, **no `rng`**, so determinism and golden tests
hold. Returns `RouteDemand[]` where `routeId: null` is the default class.

**Compile L7 (`world/routing.ts`)** — `computeLbRouting` now populates `CompiledLbRouting.rules`
(already typed in Phase 1, empty until now) from an L7 LB's `listenerRules`, verbatim and
**in authored order** — even a rule whose target has no in-region instance is kept, so first-match
is accurate and the empty target group drops the route (AWS "503 on empty target group"); the
absent-target case is surfaced by analysis, not by silently reordering. L4 LBs still compile no
rules. No new `CompiledRouting` shape — purely fills an existing field.

**Engine route-aware distribution (`worldEngine/index.ts` hub)** — Phase 1's `distributeToEntries`
became `distributeViaLb(regionId, routeDemands, into)`: per route, `matchRouteTargets(path, lb)`
first-matches a listener rule (or falls to the default action) to pick the target group, then hands
it to the **unchanged** `distributeToTargets` (the region→AZ→instance + cross-zone tier). Route
paths are resolved once at `start()` into `state.routePathById` (built from `doc.packets`). The
demand loop now calls `distributeViaLb(region, splitDemandByMix(total, pop.requestMix), …)`;
`populationRoutes` keeps the scalar total (per-population, not per-route). Back-compat: no mix ⇒
one `{routeId:null}` route ⇒ default targets; L4 ⇒ no rules ⇒ default targets — identical to
Phase 1 (proven: 40 golden engine tests unchanged).

**Store (`app/store/world.store.ts`)** — `addRoute`/`updateRoute`/`removeRoute` via `mutate()` on
`doc.packets`. Reference hygiene: `removeRoute` scrubs the deleted routeId from every population's
`requestMix`; `removeBlueprint` now also runs `scrubBlueprintFromLbs` (drops listener rules
targeting the removed blueprint, nulls a default action that pointed at it).

**Persistence (`serializer.ts`)** — `packets` now serializes **inside `world`** (the top-level
`packets` slot was vestigial — write-never/read-never in the app). `deserializeWorld` defaults
`world.packets` to an empty registry and **migrates any legacy top-level `packets` slot** into it,
so pre-Phase-2 files (with or without the old slot) load unchanged.

**UI** — new **`panels/RoutesPanel.tsx`** (world scope, 8th world tab `routes`, wired through
`ui.store` `PanelTab` + `dock/scope.ts` `WORLD_TABS` + `WorldPanel.tsx` label/render/header) is the
route catalog editor (modeled on `BlueprintPanel`). `TrafficPanel.tsx` gained a `RequestMixEditor`
in the expanded population row (relative-weight fields over the route catalog; empty ⇒ default
class). `RegionConfigTab.tsx`'s LB section gained the **L4/L7 `type` toggle** and, in L7, a
`ListenerRulesEditor` (ordered pathPattern → target-service rows + a default-action select).

**Analysis (`analysis/rules/network.ts`)** — two new rules registered in `networkRules`:
`lb-listener-target-absent` (an L7 listener rule points at a service with no instance in the
region → dropped) and `lb-route-dropped` (a population's request-mix class reaches an L7 region
that has no matching rule and no default action → dropped).

**Gate** — new TDD tests across `nodeConfig.test.ts` (route helpers + glob matcher),
`serializer.test.ts` (packets round-trip + legacy-slot migration), `demand.test.ts`
(`splitDemandByMix`), `routing.test.ts` (L7 rule compilation), `index.test.ts` (+3 L7 integration:
split, unmatched→default, dropped), `world.store.test.ts` (route CRUD + scrubbing),
`network.test.ts` (+4 analysis), `RoutesPanel.test.tsx`, `TrafficPanel.test.tsx` (mix editor),
`RegionConfigTab.test.tsx` (L7 rules). Full suite green (the wall-clock engine perf bench is
load-sensitive and passes in isolation); `npm run build` clean.

**Scope boundary (unchanged from the plan)** — L7 routing is at **ingress** (client → entry
service). Internal service-to-service per-route routing keeps `solveFlows`' fan-out unchanged (a
deliberate future extension). Explicit multi-blueprint target groups, and per-route byte/workload
realism from the packet templates, are likewise parked. **(The ingress byte half of this is now
built — see the packet-driven egress section below.)**

---

## Packet-driven egress — slice 1: route byte sizes drive internet-egress cost (2026-07-25)

**Why** — cost was traffic-*volume*-sensitive but not payload-*size*-sensitive: the engine turned
every request into bytes with flat constants (`BYTES_PER_REQUEST_EACH_WAY = 2048` in `flows.ts`;
`NIC_REQUEST_BYTES = 512` / `NIC_RESPONSE_BYTES = 2048` in `networkRuntime.ts`), so a health check
and an image download cost the same egress. First slice of a phased overhaul: make the
client-facing **internet-egress** byte rate (and thus its cost line) driven by the route mix's
actual payload sizes. Scope is deliberately the **entry/internet tier only**.

**Schema (`nodeConfig.ts`, low-risk additive)** — `HttpTemplate` gained optional `responseSizeKb`
(HTTP had no response-size field; only `DbTemplate.resultSizeKb` existed) and `connectionType`
(`'keep-alive' | 'short-lived' | 'streaming'` — **authored/stored only, no simulation behavior
yet**, a later phase). Both optional so old `.scalemap` files and the serializer's literal
templates need zero migration. New pure helper **`routeIngressBytes(route)`** → `{ reqBytes,
respBytes }` (KB×1024, each falling back to `DEFAULT_PACKET_BYTES_EACH_WAY = 2048` when the route
or field is absent) — the single fallback point that keeps a no-authored-sizes world byte-identical
to the old constant. `RouteFields`/`addRoute`/`updateRoute` extended (new-route defaults: 1 KB req,
4 KB resp, keep-alive).

**Engine (`worldEngine/index.ts` hub, `flows.ts`)** — at `start()`, `buildRouteBytesById(doc)`
resolves each route's wire bytes into `state.routeBytesById` with **two fallback conventions**:
cost/internet keeps the symmetric 2 KB (via `routeIngressBytes`), NIC keeps its asymmetric
512/2048 — so entry-NIC throughput is also byte-identical until a size is authored. `distributeViaLb`
gained an optional `weightAccum` param: it routes each route's demand into a per-route scratch map,
then folds both rps (into `entryDemand`) and byte-weighted sums (Σ rps×bytes, into `entryByteAccum`)
— **`distributeToTargets` (routingRuntime.ts) is untouched**. After the routing loop those sums ÷
entry rps give per-entry-instance weighted-average request/response sizes: `entryBytesByInstance`
(cost) seeds `solveFlows`' internet-byte total (new additive-optional `FlowInput.entryBytesByInstance`
— absent ⇒ the flat 2 KB path, so direct-`solveFlows` unit tests are unchanged), and
`entryNicBytesByInstance` sizes the **entry-demand share** of each instance's NIC booking (step 7),
with any internal-serving rps keeping the flat split.

**Cost model** — **no change**: `internetEgressBytesPerSec` already flows into `egressMonthlyCost`
(`costModelV2.ts`), so the internet-egress cost line becomes payload-size-driven with zero signature
change.

**UI (`RoutesPanel.tsx`)** — the new-route form and each `RouteCard` gained request-size (KB),
response-size (KB), and connection-type controls, wired through the existing store `addRoute`/
`updateRoute` actions.

**Gate** — TDD across `nodeConfig.test.ts` (defaults + `routeIngressBytes` fallback),
`index.test.ts` (response size drives internet bytes/cost proportionally; no-route world stays at
the 4096 B/req convention — golden guard), `RoutesPanel.test.tsx` (new inputs). Full suite green
(1374); `npm run build` clean.

**Still parked (roadmap)** — ~~packet-driven CPU cost~~ **shipped, see slice 2 below**;
~~log-normal per-packet size variance → tail effects (p99/NIC-burst)~~ **shipped, see slice 3
below**; **internal-hop** sizing via `BlueprintDependency.packetTemplateId` (cross-AZ/cross-region
egress + downstream NIC); per-provider egress attribution; connection-type *behavior*.

---

## Packet-driven CPU — slice 2: request size drives entry-tier CPU/latency (2026-07-27)

**Why** — slice 1 made client-facing egress bytes size-sensitive; a request's CPU/processing cost
was still a single per-service constant (`WorkloadProfile.cpuMsPerRequest`) — a 2 MB upload and a
200-byte ping cost the same CPU on the same service. This slice adds a **blend model**: `cpuMs =
cpuMsPerRequest + cpuMsPerKb × sizeKb`. Scope is deliberately **entry-tier only** — route/packet
size is known where demand enters but is discarded before internal hops (`entryDemand` is a bare
`Record<InstanceId, number>`; the flow-solver BFS carries only scalar rps), so internal
service/DB CPU keeps the flat base.

**Schema (`world/types.ts`, low-risk additive)** — `WorkloadProfile` gained optional
`cpuMsPerKb?: number`, absent ⇒ 0 (flat, pre-slice-2 behavior). No catalog/factory migration
needed (`createBlueprint`'s literal `workload` object, `serviceDraft.ts`'s `draftWorkload`) —
the field is optional and simply absent until authored.

**Engine (`worldEngine/index.ts` hub, `flows.ts`)** — reuses slice 1's `EntryByteAccum`
machinery exactly, no new routing plumbing: `RouteWireBytes` gained a `sizeKb` field (the route's
request size in KB, carried alongside — not reconstituted from — the existing byte fields;
`DEFAULT_ROUTE_WIRE_BYTES.sizeKb` mirrors the same 2 KB fallback convention as `costReq`).
`EntryByteAccum` gained `cpuKb`, folded in `distributeViaLb`'s existing per-instance loop
(`acc.cpuKb += r * wb.sizeKb`) alongside `costReq`/`costResp`/`nicReq`/`nicResp`. After the
routing loop, `entryPacketKbByInstance[iid] = acc.cpuKb / entryDemand[iid]` — the same
divide-by-entry-rps fold as `entryBytesByInstance`. A new closure, **`effectiveCpuMs(iid, bp)`**,
collapses the blend into ONE effective ms/request per instance per step: `(bp.workload.
cpuMsPerRequest ?? 1) + (bp.workload.cpuMsPerKb ?? 0) × (entryPacketKbByInstance[iid] ?? 0)` —
non-entry instances read 0 KB ⇒ unchanged flat cost. This single value is threaded into every
`cpuMsPerRequest` read site that previously read the blueprint field directly, so the host
scheduler's cores AND the flow-solver's latency track size **coherently** (one nonlinear
rps↔cores conversion never sees two different costs for the same instance): the `InstanceLoad`
build's `cpuMsPerRequest` field and its `serviceLatencyMs` fallback (both in `index.ts`'s per-step
host-scheduling loop), the offered-cores health-pressure estimate (`overloadPressureByServer`,
same file), and `flows.ts`'s `getFlow` p50 seed via a new additive-optional `FlowInput.
effectiveCpuMsByInstance?: Record<InstanceId, number>` (absent ⇒ the flat `bp.workload.
cpuMsPerRequest` fallback, so direct-`solveFlows` unit tests are unchanged) — built in `index.ts`
for entry instances only and passed into the `solveFlows` call alongside `entryBytesByInstance`.

**Cost model — no change** (explicit constraint, not an oversight): `costModelV2.ts` stays
provisioned-capacity flat, correct for on-demand. This slice changes CPU
*utilization/latency/capacity* — a large-packet service saturates sooner — not the dollar figure.

**Known display gap (not fixed, out of this slice's scope)** — `metrics.ts`'s per-instance
`cpuCoresUsed` (published in `InstanceMetrics`, used only for display) computes `rps ×
workload.cpuMsPerRequest / 1000` directly off the blueprint field, independent of
`effectiveCpuMsByInstance` — it is not wired to the blended value. An entry instance under a
large-payload route will show correct `rps` (lower, admission-capped) and `p50Ms` (higher) but an
understated `cpuCoresUsed` relative to its true scheduled cost. Threading the effective value into
`metrics.ts` would need a new plumbing path (`accumulateStep`/`buildBatch` don't currently see
per-instance effective ms) that the task's brief scoped out — flagged here for a future slice, not
fixed silently.

**UI (`dock/drawers/EditServiceForm.tsx` + `AddServiceForm.tsx`)** — both gained a `cpu / KB`
numeric field next to `cpu / request`, wired through the existing `tuneWorkload`/`tune` helpers
(same `numberField` pattern as every other workload field); `AddServiceForm`'s lives in the same
"advanced" disclosure as its own `cpuMsPerRequest` input.

**Gate** — TDD across `serializer.test.ts` (`cpuMsPerKb` round-trips when authored, stays
`undefined` when not), `EditServiceForm.test.tsx` (field renders + dispatches `tuneWorkload`),
`flows.test.ts` (`effectiveCpuMsByInstance` raises the sampled p50; absent/empty ⇒ unchanged
output — verified against a same-seed baseline), `index.test.ts` (a large-request route with
`cpuMsPerKb > 0` shows higher server `coreUtilization`, lower admitted `rps`, and higher `p50Ms`
than an identical world with a small-request route; a **golden** pair of tests proves the
backward-compat invariant directly — `cpuMsPerKb` unset yields byte-for-byte-identical CPU/latency
metrics across differing route sizes, and `cpuMsPerKb = 0` is identical to leaving it unset
entirely). Full suite green (1382); `npm run build` clean.

---

## Log-normal NIC-burst tails — slice 3: mean-preserving size jitter drives p99 (2026-07-27)

**Why** — every request was exactly its mean size (slice 1's weighted average), so a NIC never saw
a momentary payload spike and instance `p99Ms` never reflected bursty large-object traffic. This
slice adds a **mean-preserving log-normal per-step multiplier** on the NIC byte volume — a fresh
draw each step, `E[multiplier] = 1` exactly — so realistic p99/NIC-burst tail spikes appear
**without moving the mean egress-cost line**. Independent of slice 2 (no CPU-blend interaction);
reuses slice 1/2's `EntryByteAccum` accumulator pattern a third time.

**Schema (`nodeConfig.ts`, low-risk additive)** — `HttpTemplate` gained optional
`sizeVariance?: number` (the coefficient σ, roughly `0..~1.5`), `RouteFields` + `addRoute`'s
default (`0`) match. `routeMatchesPattern`/`routeIngressBytes` untouched — σ is NIC-only, never
part of the cost-byte convention.

**Sampler (`worldEngine/latency.ts`)** — `sampleLatencyMs`'s inline Box-Muller was extracted into
a shared `boxMullerZ(rng)` helper (two `rng.next()` draws, same formula, so `sampleLatencyMs`'s
own output/draw-order is unchanged — verified by the full pre-existing suite staying green
untouched) and reused by the new `sampleSizeMultiplier(sigma, rng)`: `sigma <= 0 ⇒ 1, zero draws`;
`sigma > 0 ⇒ exp(sigma·boxMullerZ(rng) - sigma²/2)`, exactly two draws.

**Engine (`worldEngine/index.ts` hub)** — `RouteWireBytes` gained `sigma` (`route.sizeVariance ??
0`, mirroring slice 2's `sizeKb` carry); `DEFAULT_ROUTE_WIRE_BYTES.sigma = 0`. `EntryByteAccum`
gained `varW`, folded in `distributeViaLb`'s existing per-instance loop (`acc.varW += r *
wb.sigma`) alongside `cpuKb`/`costReq`/`costResp`/`nicReq`/`nicResp` — no new accumulation path.
After the routing loop, `entrySizeVarianceByInstance[iid] = acc.varW / entryDemand[iid]`, the same
divide-by-entry-rps fold as `entryPacketKbByInstance`. Applied at step 7 (the NIC byte-accounting
loop over `flows`, where `addNicBytes` is called per flow): for each flow, `sigma =
entrySizeVarianceByInstance[f.instanceId] ?? 0`; `sigma > 0` draws `m =
sampleSizeMultiplier(sigma, s.rng)` and multiplies ONLY the entry `eb.reqBytes`/`eb.respBytes`
terms by `m` before booking — the internal-serving (non-entry) rps split and, critically, the
**separate** `entryBytesByInstance` map (slice 1's cost/egress seed, read by `solveFlows` in step
6, BEFORE step 7 runs) are never touched. This is what keeps mean internet-egress cost
untouched — the multiplier physically cannot reach the cost accumulator, not just "shouldn't."

**RNG-order discipline** — the draw is gated on `sigma > 0`, so an unauthored (σ-less) world takes
the identical branch (`sizeMultiplier = 1`, no `rng.next()` call) it did before this slice — the
seeded stream, and therefore every existing golden engine test, is completely undisturbed.

**Cost model — no change** (same discipline as slice 2): `flows.ts`'s `internetBytes` seeding and
`costModelV2.ts` are both untouched by this slice; verified by an explicit tolerance-based
mean-preserving test, not assumed.

**Visibility — instance `p99Ms` only** (already published un-smoothed, spec decision). AZ/region/
world p99 aggregation does not exist and is explicitly out of scope; no new metrics plumbing was
added — the inflated per-step bytes reach `p99Ms` through the existing chain
(`networkRuntime.ts`'s `evaluateNic`/`settleNic` → `s.nicQueuedLatencyMs` → next step's
`extraLatencyMsByServer` → `solveFlows`'s `serviceLatencyMs` → the metrics reservoir).

**UI (`RoutesPanel.tsx`)** — a `σ` numeric input sits beside the existing req/resp KB fields (new-
route row and each `RouteCard`), reusing the existing `sizeField`/`parseKb` pattern exactly.

**Gate** — TDD across `latency.test.ts` (new file: `sampleSizeMultiplier` σ=0 returns exactly 1
and spies zero `rng.next()` calls; σ>0 draws exactly two; large-N mean ≈ 1; deterministic under a
fixed seed), `nodeConfig.test.ts` (`sizeVariance` round-trips, defaults to 0),
`RoutesPanel.test.tsx` (the new input renders + dispatches), `index.test.ts` (a NIC-tight server —
`nicMbps` overridden post-preset, load sized to sit under cap at σ=0 but spike past it at σ=1 —
shows a strictly higher `p99Ms` at σ>0; an explicit tolerance-based test holds mean
`internetEgressBytesPerSec` and `computeWorldCost`'s internet-egress line within 5% between σ=0
and σ>0 runs at ample NIC headroom; a golden-guard test proves `sizeVariance: 0` is
metric-identical to leaving the field unauthored entirely). Full suite green (1398); `npm run
build` clean.

---

## Auto-baseline removal + region "who's sending" summation fix (2026-07-15)

Two user-reported traffic issues, fixed together.

**Auto-baseline traffic removed.** The synthetic per-region ambient demand (a phantom
`baselineTotalRps` defaulting to 1000, injected as `baseline:<regionId>` pseudo-populations) is
gone — all traffic now originates from authored `ClientPopulation`s. Removed: `TrafficConfig` +
`WorldDoc.traffic` (`world/types.ts`), the `traffic` default (`factories.ts`), `baselineDemands`
(`worldEngine/demand.ts`) and the engine's baseline demand loop + the three `baseline:`
population-id guards (`worldEngine/index.ts`), `updateTraffic` (`world.store.ts`), the
`TrafficHero` baseline controls (`panels/TrafficPanel.tsx` — the routing-policy `Segmented` it
hosted moved into `RoutingSection`; the auto-baseline checkbox/slider/exact-value are deleted),
and the baseline mentions in the world/traffic headers (`WorldPanel.tsx`, `dock/AtlasHeader.tsx`,
`region/SourcesColumn.tsx`). `serializer.ts` dropped `traffic` from its required-collections list;
old `.scalemap` files with a leftover `world.traffic` object still load (the extra field is
ignored). **Vault consequence:** the single-region clean worlds (`three-tier`, `event-driven` in
`vault/exampleWorlds.ts`) are deliberately population-less to stay finding-clean (a population
would trip `no-failover-region`), so they now render **trafficless** until a population is added —
`exampleWorlds.test.ts`'s engine-smoke asserts non-zero rps only for worlds that author
populations.

**Region "who's sending" trunk now sums the ingress rows** (`region/SourcesColumn.tsx`). It
previously read `batch.regions[regionId].rps`, which is the region's *total instance throughput*
(ingress **plus** internal service→service hops via `metrics.ts`' AZ→region reduction) and so
exceeded the sum of the visible source rows — the "summation is always incorrect" report. The
trunk is now `rows.reduce((s,r)=>s+r.rps, 0)` (the ingress the sources actually send). The region
headline elsewhere still legitimately shows total throughput; only the ingress box was wrong.
Regression-locked by `RegionView.test.tsx` (trunk shows the ingress sum, not `region.rps`).

**Region → AZ split now distributes the ingress, not AZ throughput** (`region/regionData.ts`
`azShares`, consumed by `SplitLines.tsx` pills + `AzRow.tsx`'s inbound header). Same throughput ≠
ingress bug one level down: `azShares.rps` used `batch.azs[az].rps` (per-AZ total throughput), so
the two AZ pills summed to ~2× the region ingress (the "both AZs receive the entirety, doubling"
report). `fraction` still ranks AZs by throughput share, but `rps` is now `fraction × regionIngress`
(regionIngress = Σ `populationRoutes` into the region = the SourcesColumn trunk), so the pills sum
to the ingress. `AzRow` gained an `inboundRps` prop (threaded from `azShares` by `RegionView.tsx`)
and its `◂ N rps` header shows that instead of `batch.azs[az].rps`; per-server rows still show
actual per-instance throughput (where the internal amplification remains visible). Note: this is a
*proportional* attribution. As of the 2026-07-24 fix (dated entry below), cross-zone-OFF no longer
**drops** an AZ's share when that AZ holds no healthy target — the empty AZ leaves the LB rotation
and its share redistributes to the serving AZ(s) (verified by `index.test.ts` "cross-zone-off
ingress distribution": entry in both AZs → clean 50/50; entry in one AZ → the serving AZ absorbs
the whole ingress, `world.totalRps` ≈ full, nothing dropped). A single-AZ entry tier is still a
SPOF/bottleneck — it just shows up as *concentrated load on the serving AZ*, not phantom LB drops.

---

## Regional Load Balancer — Phase 3 (cost + region visualization)

Final phase of the regional-LB feature: pricing and an at-a-glance region-page instrument.

**Cost (`costModelV2.ts`, `cloudRegistry.ts`)** — each AUTHORED regional LB (`doc.loadBalancers`)
now prices at the existing `CLOUD_REGISTRY.loadBalancer` LB-hours (aws default,
`instanceHourly` 0.0225/hr × 730 ≈ $16.43/mo), **bumped into `byRegionMap`** so it flows into the
region total AND every region-scoped cost reader (`dock/scopeData.ts` `scopedCost` → region Cost
tab + `AtlasHeader`) for free. `WorldCostResult` gained `loadBalancerUsd` + `loadBalancerCount`
(additive) — a *subset* of `computeTotal`, exposed only for the Cost tab's "includes N load
balancer(s)" itemization line (`CostTab.tsx`), NOT a second addend to `monthlyUsd`. Cross-zone LB
traffic is deliberately **not** billed here — it rides the cross-AZ egress bytes the engine already
meters/costs (the `egress` pricing component of the LB spec is skipped). Synthesized default LBs
(regions with no authored LB) cost $0 — you pay once you configure one. Tests: `costModelV2.test.ts`
(+2, LB priced into region / deleted-region guard).

**Region visualization (`region/RegionLbCard.tsx`, new)** — a compact, read-only card in the
Level-2 region flow row, inserted by `RegionView.tsx` between `SourcesColumn` (the DNS-outcome
"who's sending" view, deliberately unchanged — it is *not* the LB) and `SplitLines` (the region→AZ
beams), i.e. exactly where the regional LB sits in the flow. Reads `compiled.routing.lbRouting`
(so it reflects the synthesized default too, never the raw doc): shows NLB·L4 / ALB·L7, the
cross-zone on/off badge + fan-out note, and — in L7 — each listener rule as `pattern → service`
plus the default action. Token-only styling (theme-correct). Full authoring still lives in the
dock's `RegionConfigTab`; this is the read-only flow-page mirror. Tests: `RegionLbCard.test.tsx`
(synthesized L4 default + authored L7 rules).

**Contract drift** — no `worldEngine/types.ts` or `CompiledWorld`/`CompiledRouting` change in
Phase 3 (cost model + a display component only). The additive `WorldCostResult` fields are logged
in `.superpowers/sdd/contract-drift.md`.

---

## Simulation pause / resume / end + flow-animation freeze (2026-07-16)

**Pause/Resume/End controls.** `simulation.store.ts` gained a `paused` flag and `pause()`/
`resume()` actions alongside `stop()` (now semantically "End"). `pause()` calls the engine's
`stop()` (which preserves state) and keeps the whole session (latestBatch, events, manual outages,
event-log run + flusher — no events tick in while frozen); `running` stays true so the world stays
edit-locked. `resume()` calls the new engine facade `resume()` (additive to the frozen
`WorldEngineApi` — restarts ticking on preserved state; see contract-drift). `SimControls.tsx`:
idle → `Simulate`; live → `[Pause] [End]`; paused → `[Resume] [End]` (green pulse when live, static
amber when paused).

**`selectLive` — the "actively ticking" gate.** `simulation.store.ts` exports
`selectLive = s => s.running && !s.paused && s.scrubIndex === null`. Engine-driven animations
(globe arcs, server-board particles via `attachRenderer`) already stop when ticking halts — but the
region/AZ views use **CSS/SMIL** animations keyed off the (frozen) batch's `rps`, which kept
marching on pause/end/scrub. Those now gate on `selectLive`: `SourcesColumn` (trunk march + source
dots), `SplitLines` (new `live` prop, ingress beams), `ReplicaRail` (`flowing` = `live && rps>0`
from `RegionView`), and `DatacenterFloor` (its `animatedKeys` flow-trace + `animatedLedIds` LED
memos short-circuit to empty when not live). Tests assert both the animated (live) and frozen
(not-live) states; `RegionView.test`/`DatacenterFloor.test` set `running: true` where they assert
motion.

**Scrub while paused.** `ScrubberV2.tsx` previously showed only when `!running`; since a paused run
keeps `running` true, it now gates on `halted = !running || paused` (stopped OR paused) — you can
scrub replay history without ending the run. `resume()` snaps back to the live head (clears
`scrubIndex`/`scrubBatch`) so a scrub position set while paused doesn't strand the views on a past
frame once ticking continues.

**End ERASES the run; Pause preserves it (2026-07-23).** `stop()` originally cleared only
`{running, paused, healthOverrides}`, leaving `latestBatch`/`events`/`scrub*`/`degraded`/event-log
fields intact — so a server/region that went down mid-run kept rendering as down after End
(views read `scrubBatch ?? latestBatch`) and its routing edge stayed X'ed (user report
2026-07-23). `stop()` now clears the full run-state set `resetSession()` does (batch, events,
scrub, degraded, healthOverrides, event-log fields) and orphans the event buffer (`eventGen++`)
so a late microtask can't repopulate the cleared window — `pause()` is unchanged and still
preserves everything (`running` stays true). Consequences: the batch-driven views (region/AZ
health, ingress edges) return to the at-rest authoring state on End; the imperative renderers
follow suit — `PacketLayer`/`ArcsLayer` already clear on `!running`, `InspectorV2` (AZ traces)
now gates its poll on `running` (clears on End, persists on pause), and `ScrubberV2` is
effectively **pause-only** (its `latestBatch === null` gate hides it after End). The engine
already rebuilds all run state on the next `start()`, so this only closes the End→idle window.

---

## Regional LB UI gated on AZ count ≥2 (2026-07-17)

A region's LB config (cross-zone, algorithm, listener rules) is a verified no-op below 2 AZs —
`distributeToTargets` (`routingRuntime.ts`) computes `perAz = rps / healthyAzs.length`, which
degenerates to `rps / 1` regardless of `crossZone` when there's only one healthy AZ. `compileWorld`
still always synthesizes an LB config per region (a back-compat mechanism for when a region *does*
reach 2+ AZs with no authored LB — unchanged), but that's an engine-internal concern, not a UI
signal. Both LB render sites now gate on the region's own `azs.length >= 2`:
- `dock/RegionConfigTab.tsx` — the "LOAD BALANCER" section renders only at 2+ AZs; at exactly 1 AZ
  it shows a one-line hint ("Add a second AZ to configure this region's load balancer.") instead of
  silently disappearing; at 0 AZs neither renders (the existing "No AZs yet" empty state covers it).
- `RegionView.tsx` — `region/RegionLbCard.tsx` (the flow-page LB card) renders only at 2+ AZs; below
  that it just doesn't take up space in the flow row (no hint — schematic diagram, not a config
  panel). `RegionLbCard.tsx` itself is unchanged and stays agnostic to AZ count; the gate lives
  entirely in its two callers.

A previously-authored `doc.loadBalancers` entry is never deleted when a region drops back below 2
AZs — only the UI toggles; the config resurfaces unchanged if a second AZ is re-added.

---

## AZ delete button in Region Config tab (2026-07-17)

Fixed a user-reported dead end: `RegionConfigTab.tsx`'s AZ rows had no way to remove an AZ, and
the only `×`-styled control near an AZ in the app (the region flow page's `AzRow.tsx` "kill"
button) is actually an outage-SIMULATION toggle (`disabled={!running}` — it only makes sense
during a live run), not a delete — easy to mistake for one. `RegionConfigTab.tsx`'s AZ rows now
carry a real delete `×` in `EdgeRow`'s `trailing` slot, dispatching `store.removeAz(az.id)` — the
exact same store action `TopologyPanel.tsx`'s AZ-row `×` already used (relocated-dispatch
contract, matching this file's existing "+ az" convention; no parallel mutation path, no
confirmation dialog, consistent with every other `remove*` action in the app). The button's
`onClick` calls `stopPropagation()` since it sits inside the row's own `goAz`-navigating
`onClick` — needed only for this new control (the rps figure stays in `children`, not
`trailing`, precisely because it does NOT need click isolation). Edit-locked
(`disabled={running}` + the standard tooltip) matching every other authoring control in this
file.

---

## Visual service-connections layer (`src/lib/world/connections.ts`, `src/app/world/connections/`, 2026-07-17)

Made the app's existing (but invisible + two-surface) service-to-service connection concept
directly authorable as a visual edge-drawing overlay. **Source of truth is unchanged**:
`ServiceBlueprint.dependencies` (`BlueprintDependency`) stays the only persistent record of intent,
and ingress stays derived from `port.visibility:'public'`. There is **no serializer change and no
`compileWorld.ts`/`network.ts` change** — the compiled `paths` (with `verdict`/`blockReason`)
already carry everything the view reads. The two riskiest hub files stayed untouched.

**New pure module — `src/lib/world/connections.ts`** (no store/React imports, same purity contract
as `rackModel.ts`; owned independently):
- `planReachability(doc, target, port, source?)` → the minimal patch set that makes an edge
  permitted: a `ServicePort` to bind on the target blueprint if missing, plus an `allow` rule to
  **prepend** (first-match-wins over any later deny) to every server hosting the target that doesn't
  already allow the port. Agrees with `network.ts`'s `evaluateFirewall` rather than forking it;
  idempotent (a server already allowing the port is skipped). Only auto-fixes `no-port-binding` +
  `firewall-deny`; container `network-isolation` (shared docker network / host port mapping) stays
  manual and will still surface blocked. `applyReachabilityPlan(doc, plan)` folds it into the doc
  immutably.
- `edgesForView(doc, compiled)` → folds authored dependencies (so an unplaced intent still renders)
  with `compiled.paths` grouped by `dependencyId` into blueprint-level `ConnEdge`s with a
  four-state `status` (`permitted`/`partial`/`blocked`/`unplaced`) + worst `blockReason`, plus
  synthetic `INTERNET_NODE → entry-blueprint` ingress edges (entry = `isEntryBlueprint`, re-derived
  here from public ports to avoid a `routing.ts` edit).
- `connNodes(doc)` + `layoutNodes(nodes, edges)` → deterministic layered left→right layout (Internet
  col 0, entries col ≥1, callee col = max caller col + 1 to a cycle-safe fixpoint). No graph-layout
  dependency added — React Flow is gone; DOM/SVG precedent is `az/DatacenterFloor.tsx`.

**New store actions — `src/app/store/world.store.ts`** (all through the existing `mutate()`, one
undo/dirty step each): `connectServices(fromBpId, target, { port, protocol, autoProvision })` →
appends a dependency and (when `autoProvision`) applies `planReachability` in the same mutation;
`disconnectServices(fromBpId, depId)` → drops intent only, leaving provisioned firewall/ports;
`fixReachability(fromBpId, depId)` → re-provisions a blocked edge (the inspector's one-click fix);
`setInternetFacing(bpId, port, exposed)` → flips a port's visibility public/internal and, when
exposing, opens `allow … any` on hosting servers (LB entry targeting is already automatic via
`isEntryBlueprint`). Reuses the existing `stripDependencies`/`scrubBlueprintFromLbs` cascade
cleanup on blueprint/managed deletion — no change there.

**New view — `src/app/world/connections/ConnectionsView.tsx`** (full-stage overlay, `createPortal`
+ capture-phase Esc, same modal idiom as `SettingsModal.tsx`; presentation + dispatch only, all
geometry/verdict logic imported from the pure module). SVG bezier edges coloured by `status` over
absolutely-positioned DOM node boxes; drag a service's `●` handle onto another node → a draft bar
(port/protocol + auto-provision checkbox) → `connectServices`; drag from the Internet node or click
a service's `🌐` toggle → `setInternetFacing`; click an edge → an inspector with `blockReason`
detail + "Open firewall (fix)" (`fixReachability`) + remove/make-private. Theme via `var(--color-*)`
only; nothing animates (reduced-motion satisfied by construction). Launched from a new
`🔗 connections` button in `WorldShell.tsx`'s header (single entry point — the always-visible
header is more discoverable than a scope-gated dock link, and it keeps the high-conflict
`WorldPanel.tsx` untouched; a dock entry point was considered and deliberately dropped).

Tests: `connections.test.ts` (planReachability idempotence + end-to-end permit, edge folding,
ingress derivation, layout), `world.store.test.ts` (the four actions + single-undo atomicity),
`ConnectionsView.test.tsx` (drag-connect, blocked-edge fix, ingress toggle).

### Usability refactor — draggable tree layout + persistence + prominent entry (2026-07-17)

Reworked the editor from a fixed linear grid (edges overlapped, nothing could be untangled, the
entry was a muted header link) into a re-arrangeable tree:

- **Crossing-reduced tree layout.** `layoutNodes` (`connections.ts`) went from stable-insertion
  rows to a Sugiyama-style layered layout: after the same depth-based column assignment, it runs
  repeated barycenter sweeps (down then up) that order each layer by the mean position of a node's
  neighbours in the adjacent layer, then vertically centers shorter layers against the tallest.
  Pure + deterministic; `COL_GAP`/`ROW_GAP` are now exported constants.
- **Draggable nodes + persistence.** A new **additive `WorldDoc.connectionLayout`** field
  (`Record<nodeId, {x,y}>`, `types.ts`'s `NodeLayout`) holds ONLY user-dragged overrides — a node
  absent from it falls back to the auto tree position. Normalized-on-load in `serializer.ts`
  (`?? = {}`, same pattern as `racks`/`loadBalancers`/`packets`) and defaulted in
  `factories.ts`'s `createWorld`. Two new `world.store` actions ride `mutate()`:
  `setNodePosition(nodeId, {x,y})` (committed once on drag-END so one drag = one undo step — the
  live drag is component state) and `clearConnectionLayout()` (the "⟲ auto-arrange" button, back
  to pure auto-layout). `ConnectionsView.tsx` now distinguishes a **move drag** (grab the node
  body) from a **connect drag** (grab the `●` handle, which `stopPropagation`s the body's
  mousedown); edges gained direction arrowheads.
- **Front-and-center entry.** The header button is now accent-filled (`connBtn` in
  `WorldShell.tsx`) reading as a primary action rather than one more muted file button. Still the
  single entry point (dock link deliberately dropped, as above).

Added tests: node-drag persistence + auto-arrange reset (`ConnectionsView.test.tsx`),
`setNodePosition`/`clearConnectionLayout` undo semantics (`world.store.test.ts`). `serializer.ts`
+ `factories.ts` round-trips covered by their existing suites (additive field, defaulted).

**Scope decision — logical (blueprint), not per-AZ/per-server (2026-07-17).** Fielded the question
"shouldn't connections be per-AZ with servers as nodes?". They are deliberately NOT: intent lives
on the blueprint template and applies wherever a service is placed, and the engine's traffic unit
is the service call, not the server link (a server→server edge is meaningless without naming the
services). The per-server *physical* resolution already exists as derived `CompiledPath`s and is
visualized by the AZ-level `DatacenterFloor` flow traces (Level 3) — the connections editor is the
*authoring* surface for the *logical* layer. Rather than change the model, the editor header now
carries a `logical service graph` badge + a scope note ("edges apply in every AZ/region where a
service runs; per-server view: open an AZ floor") so the altitude reads unambiguously. If a
per-AZ physical edge view is ever wanted, the right shape is a complementary AZ-scoped mode that
renders derived instance→instance `CompiledPath`s (not a second authoring surface).

---

## AZ-scoped read-only Connections graph (2026-07-25, revised same day)

Fielded the instinct again: "why isn't Connections configured per-AZ, since users already open
each AZ for other config anyway?" Same answer as the 2026-07-17 scope decision above — a
`BlueprintDependency` is authored once on the blueprint/template and a blueprint's `Placement`s
routinely span several AZs at once, so there is no single AZ an authored edge could belong to
without either duplicating the rule per AZ or silently mis-scoping it. Ships the "complementary
AZ-scoped mode" the 2026-07-17 entry called for.

First cut of this (same day) rendered the AZ's touching paths as a row list in `AzConfigTab.tsx`
directly. User feedback: match the world-scope Connections tab's own pattern instead — a compact
summary + button that opens a separate, full node/edge GRAPH overlay (`ConnectionsView.tsx`'s
visual language), not inline boxes. Revised to that shape; the row-list code below no longer
exists (`AzConnectionRow`/`azConnectionRows` were removed, not deprecated).

**New pure helper (`lib/world/connections.ts`)** — `azConnectionGraph(doc, compiled, azId): {
nodes: ConnNode[]; edges: ConnEdge[] }`, appended after `connectionRows`. Re-runs
`edgesForView`'s exact per-dependency aggregation (status/blockReason/counts via the same
`statusOf` helper) but only over `compiled.paths` with an endpoint in `azId` — so a dependency
with NO leg touching this AZ is simply absent, while one that does gets the SAME `ConnEdge` shape
the world graph uses (just re-aggregated over a filtered path set, not re-invented). Unlike
`floorData.ts`'s `aggregateFlows` (which drops cross-AZ paths — those render at region level on
the floor scene instead), a cross-AZ/cross-region dependency shows up in BOTH endpoint AZs'
graphs, since each genuinely has a leg there. Ingress edges use an AZ-local "placed HERE" check
(`instances.some(i => i.blueprintId === bp.id && i.azId === azId)`), not `edgesForView`'s
"placed anywhere in the world" check. Reuses `connNodes`/`layoutNodes`/`INTERNET_NODE`/`NODE_W`/
`NODE_H` from the same file — no new node/edge shapes for the AZ view to diverge on.

**New read-only viewer (`app/world/az/AzConnectionsView.tsx`)** — a from-scratch component, not a
`ConnectionsView.tsx` prop-flag fork: same backdrop/surface/SVG-edge/node-box visual structure and
`STATUS_COLOR` palette, but every mutation path is gone — no move-drag (`startMove`/`onCanvasMove`
position math), no connect-handle/draft-bar (`startConnect`/`dropConnect`/`commitDraft`), no
ingress toggle on the node box, and the edge inspector drops `EdgeInspector`'s fix/remove buttons
and write-fraction slider down to pure detail (endpoints, port/protocol, verdict, block reason).
Layout is `layoutNodes`'s auto tree only — no `doc.connectionLayout` read/write, since persisting
manual positions for a read-only per-AZ-filtered subgraph isn't worth a new doc field. Testids are
`az-conn-*` (not `conn-*`), so nothing about this view can be mistaken for the editable one in a
test or dev-tools inspection.

**Dock entry point (`dock/AzConfigTab.tsx`)** — the `CONNECTIONS — through this AZ` section (still
between "this AZ's cost" and "add a node") is now a one-line summary
(`"N connection(s) touch this AZ"` / the empty-state sentence) plus an `open graph ↗` button
(disabled when the count is 0, mirroring `ConnectionsPanel.tsx`'s own "open graph" button at world
scope), which mounts `<AzConnectionsView azId={azId} open={...} onClose={...} />` in local
component state (`useState`, not a store field — this is transient UI state, same precedent as
`ConnectionsView`'s own `open` prop being owned by `WorldShell.tsx`). The world-scope Connections
tab/graph remains the only authoring surface; nothing in either new file dispatches a store
action.

**Gate** — `connections.test.ts`'s `azConnectionGraph` describe block (6 cases: same-AZ edge +
node set, cross-AZ edge present in both AZs' graphs, managed-target caller-only, AZ-local ingress
gating, blocked verdict+reason passthrough, empty graph for a non-touching AZ), new
`AzConnectionsView.test.tsx` (8 cases: closed-renders-nothing, node/edge rendering, empty state,
read-only assertions — no connect handle/fix/remove — inspector detail, cross-AZ presence in both
views, Escape/close), `AzConfigTab.test.tsx`'s revised describe block (6 cases: empty state +
disabled button, count + enabled button, open-graph renders nodes read-only, close hides the
overlay, cross-AZ dependency in both AZs' embedded graphs, blocked-edge inspector). No changes to
`world/types.ts`, `compileWorld.ts`, `network.ts`, `ConnectionsView.tsx`, `ConnectionsPanel.tsx`,
or `world.store.ts` — still a purely additive read path. Full suite green (1364 tests);
`tsc --noEmit` and `npm run build` clean.

---

## Delete-rack control in the AZ Config tab (2026-07-17)

The AZ-scope dock config (`dock/AzConfigTab.tsx`) could ADD racks (the "+ rack" ghost well) but
had no way to remove one — the `world.store` `removeRack` action existed with no caller. Each rack
well now carries a small danger `×` (`data-testid="rack-delete"`) that dispatches
`removeRack(rack.id)` — the store action already frees any resident servers to the pool and then
deletes, one undo step, so no orphaned placements. Gated on `!running` (hidden while a sim runs),
the exact same edit-lock convention as the sibling "+ rack" ghost (`ghostVisible = !running`) —
consistent with `+ server`/`auto-arrange` being `disabled={running}` in the same tab. The floor
scene (`az/DatacenterFloor.tsx`) still only ADDS racks via its toolbar (it has no per-rack
selection to hang a delete on); the per-rack delete lives solely where each rack is individually
rendered, mirroring where "+ rack" lives. Tests: `AzConfigTab.test.tsx` (delete frees residents +
removes the rack; the `×` is hidden while running).

## Typed node palette + DB appliance nodes — node-model Phase 1 (`src/lib/world/`, `src/app/world/az/`, 2026-07-18)

First phase of the authoring redesign (plan: `~/.claude/plans/sunny-growing-shore.md`). Replaces
"every server is a generic host you attach a generic blueprint to" with a TYPED palette, so a
database is a recognizable thing you drop into an AZ rather than three abstractions you assemble.

**Model.** `ServerKind` widened `'dedicated' | 'vps'` → `+ 'db-sql' | 'db-nosql'`, with
`isDbServerKind()` and `DB_SERVER_KINDS` beside it (`lib/world/types.ts`). `ServiceBlueprint`
gained three additive fields: `kind: BlueprintKind` (`api`/`worker`/`db-sql`/`db-nosql`/`cache`),
`dbConfig: DbConfig | null` (`engine: 'sql' | 'nosql'` + `storageGb`), and
`ownerServerKind: ServerKind | null` (non-null ⇒ appliance-owned; the box refuses other services
and the blueprint refuses general-purpose hosts). No new top-level collection — **a self-hosted DB
is a `Server`**, so `hostScheduler`, `rackModel`, firewall compile, and `costModelV2` needed no
DB-specific cases at all.

**"The blueprint IS the cluster."** There is deliberately NO cluster entity. Every instance of a DB
blueprint is that cluster; `Placement.role` says primary vs replica. Since `BlueprintDependency`
already targets a blueprint id, adding replicas later (node-model Phase 3's read/write routing)
needs no new `DependencyTarget` shape — only a role-filtered target list in `routing.ts`.

**Factories/store.** `createDbServer(azId, preset, name)` (`lib/world/factories.ts`) returns
`{ server, blueprint, placement }` as one unit — stateful, volume-bearing, port 5432 internal,
heavier workload profile than an API. `world.store.addDbServer` inserts all three in ONE
`mutate()`: a half-applied appliance (a db box whose blueprint hasn't landed) is not a state undo
should be able to reach.

**Palette UI.** `az/paletteEntries.ts` is PURE (no React/store — node-env testable, like
`floorLayout.ts`/`floorData.ts` beside it): derives entries from `INSTANCE_CATALOG` so a new preset
can never drift out of sync with what `getPreset()` resolves, partitions them `compute` → `data`,
and shortens catalog labels (which embed their own specs) against the row's separate detail column.
`az/NodePalette.tsx` renders it and owns dispatch (`addDbServer` for db kinds, `addServer`
otherwise). It is consumed by `dock/AzConfigTab.tsx`, which REPLACED that tab's hardcoded
`+ server` button (always a `vps-medium`). `az/DatacenterFloor.tsx`'s toolbar keeps a quick-add,
relabelled **`+ compute`** because it no longer reaches every node kind — the full palette lives in
the dock, the AZ's config instrument. Note the filename: the pure module is `paletteEntries.ts`,
NOT `nodePalette.ts`, because `nodePalette.ts`/`NodePalette.tsx` collide on Windows'
case-insensitive filesystem (the component import silently resolves to the pure module and React
renders `undefined` — passes on Linux, fails on Windows).

**Two latent bugs fixed by auditing `ServerKind` branches BEFORE widening the union** — both were
written as NEGATIVE tests, which sweep every future kind into the wrong side:
- `worldEngine/vpsModel.ts` `createVpsState`: `=== 'dedicated' → null` became `!== 'vps' → null`.
  Left alone, a DB appliance would have inherited noisy-neighbor steal and burstable CPU credits.
- `world/rackModel.ts` `serverHeightU`: `=== 'dedicated' ? 2 : 1` became `=== 'vps' ? 1 : 2`, so a
  db chassis claims 2U rather than a VPS-sized 1U slice.
- The same anti-pattern lived in `instanceCatalog.test.ts`, whose `if (dedicated) … else expect(
  ratio > 1)` actively DEMANDED that any new kind be oversubscribed. Inverted to a positive test.

**Convention this establishes:** branches on `ServerKind` must be positive (`=== 'vps'`), and
exhaustive `Record<ServerKind, …>` maps (e.g. `az/FreePoolPod.tsx`'s `KIND_STRIPE`) are load-bearing
— that Record is what turned a would-be silent rendering gap into a build error.

Tests: `paletteEntries.test.ts` (grouping/ordering, preset resolvability, label shortening +
uniqueness, appliance naming per engine), `NodePalette.test.tsx` (compute adds a bare host, data
adds box+blueprint+placement, edit-lock while running), `factories.test.ts` (createDbServer),
`world.store.test.ts` (single-undo appliance, dirty-marking), plus updated `AzConfigTab.test.tsx`,
`vpsModel.test.ts`, `rackModel.test.ts`.

## AZ spread + Connections as a first-class tab — node-model Phase 2 (partial) (2026-07-18)

Second phase of the authoring redesign. Two of Phase 2's four pieces landed; the service-authoring
form and the spread UI are still outstanding (see "Not yet" below).

**Spread (`src/lib/world/spread.ts`, new).** `planSpread(doc, blueprintId, targetAzIds)` answers
"replicate this service into these AZs" — the design brief's fifth pain point, where replicating
meant hand-placing N placements onto N servers that happened to live in different AZs. Rules:
reuse the least-loaded host in the target AZ that fits, else create one cloned from the SOURCE
host's preset (not from whatever happens to sit in the target AZ, so spreading a big service never
silently shrinks it); skip AZs already hosting the blueprint, so spreading twice is idempotent;
return `[]` for an unplaced blueprint, since there is nothing to replicate from and no preset to
clone. Admission is on **RAM**, not CPU — an over-committed host OOM-kills a victim outright while
CPU contention only degrades latency, which the engine already models gracefully. Appliance rules
are enforced both directions: a general service never lands on a db box, and a db blueprint only
lands on a box of its own kind. PURE — plans only, allocates no ids, mutates nothing (same
contract as `rackModel.ts` beside it).

`world.store.spreadBlueprint` applies a whole plan in ONE `mutate()` (a half-applied spread — a
new host with no placement on it — is not a state undo should reach) and returns BEFORE `mutate()`
when the plan is empty, so a no-op spread never burns an undo slot. Spread copies are created with
`role: 'replica'`; the source placement stays primary. That is what makes a spread DB a real
cluster (one writer, N read replicas) rather than N primaries — and it is the input Phase 3's
write routing reads.

**Connections is now a world tab** (`panels/ConnectionsPanel.tsx`, new). It was reachable ONLY
from an accent-filled `🔗 Connections` header button that opened a full-screen overlay —
discoverable by accident, absent from the tab set that otherwise describes the world, and looking
like a mode switch. `PanelTab` gained `'connections'`; `dock/scope.ts`'s `WORLD_TABS` places it
directly after Blueprints/Placements, because those three answer what a service IS, WHERE it runs,
and HOW it talks. The header button is deleted; `WorldShell` now passes `openConnections` down to
`WorldPanel`, which hands it to the panel as `onOpenGraph`.

Division of labour, decided against putting the canvas in the dock (the dock is a ~340px column
and the canvas is a pan/zoom graph editor): **the dock lists, the canvas edits.** The tab renders
one scannable row per connection (source → target, port, status dot) and an `open graph ↗` button.
Both surfaces read the same `edgesForView` projection through the new
`connections.connectionRows()`, so the list and the graph can never disagree about what exists or
its status. Rows sort by source-then-target LABEL — the list is the tab's entire content, and rows
reshuffling under the user on unrelated edits is worse than any cleverer ranking. An edge whose
endpoint was deleted still renders as `(deleted)` rather than vanishing: a dangling dependency is
exactly what this surface exists to make visible.

**Gotcha worth keeping:** the tab header's count MUST match the row count the panel renders, which
means authored dependencies PLUS one synthetic Internet ingress edge per publicly-exposed
blueprint. Counting only dependencies shipped a header reading "3 connections" above four rows
(caught by driving the app, not by tests). `ConnectionsPanel.test.tsx` now pins the row
composition so the `WorldPanel` formula has something concrete to agree with.

**Not yet (remaining Phase 2):** the kind-driven service-authoring form inside a host (the "VPS
door", with Light/Medium/Heavy request-cost presets over `WorkloadProfile` and an Advanced
disclosure), and the spread UI that calls `spreadBlueprint` (an AZ picker in the AZ/server views).
`BlueprintPanel`/`PlacementPanel` are still the live authoring surfaces and are not retired until
Phase 5.

Tests: `spread.test.ts` (9 — reuse/create/idempotence/least-loaded/RAM headroom/appliance rules
both directions/multi-AZ ordering), `world.store.test.ts` spread block (single-undo, no-op does
not push history, dirty-marking), `connections.test.ts` `connectionRows` block (labels, ingress,
stable order, deleted-endpoint fallback), `ConnectionsPanel.test.tsx` (rows, ingress, open-graph
handoff, empty state, blocked status, row composition), updated `scope.test.ts` and
`WorldPanel.test.tsx`.

### Spread UI — `dock/drawers/SpreadControl.tsx` (2026-07-18)

The caller for `world.store.spreadBlueprint`. Lives on each service row inside the server
faceplate's SERVICES drawer, deliberately beside the count stepper: the stepper scales a service
ON THIS BOX, spread scales it ACROSS AZs — two axes of the same question, so they belong together
rather than in separate surfaces.

Tick AZs, press "spread into N AZs". Candidates are the AZs of THIS SERVER'S REGION that do not
already run the service; an AZ already hosting it is not offered at all, because `planSpread`
skips it and listing it would invite a click that silently does nothing. When every AZ is covered
the panel says so instead of showing an empty list. The action is disabled at zero checked, and
the panel collapses after applying (the candidate list has just changed underneath, and stale
ticked boxes invite a second click that does nothing).

**Scope is same-region on purpose.** "Spread" here means multi-AZ high availability, which is what
the brief asked for ("replicating a service across AZs"). Standing a service up in another REGION
is a different concern with its own machinery — region role active/passive, DNS failover, the
routing policy — and deliberately does not hide behind this button.

**Gotcha:** spread-created hosts are named from the AZ's LABEL suffix (`web-1c`), never from the
AZ id. The first cut sliced the id and produced `web-36su`, since ids look like `az-3-mf8k36su`.
Tests asserted placement and count but never the name — caught only by looking at the running app,
and now pinned by a `world.store.test.ts` case.

Tests: `SpreadControl.test.tsx` (candidate derivation, same-region scoping, already-hosted
exclusion, full-coverage message, disabled-at-zero, edit-lock while running, collapse-after-apply).

### Service authoring form — the "VPS door" (`dock/drawers/AddServiceForm.tsx`, `lib/world/serviceDraft.ts`, 2026-07-18)

Completes node-model Phase 2. Standing up a service used to take three surfaces — create an
abstract blueprint in the world-scope Blueprints tab, fill in four raw physics numbers
(cpu-ms/request, ram base, ram/conn, disk-io/request), then attach it to a host from Placements.
No path began at "I want a service on this box", and an API and a database were asked identical
questions (the brief's complaint #4). The form is that path: one dialog on a host that creates the
global service record AND places it there.

**The host is a DOOR, not an owner.** `addServiceToServer` writes a normal global
`ServiceBlueprint` with `ownerServerKind: null`, so the service can afterwards be spread across
AZs, mounted on other hosts, or edited from any surface. Only appliance boxes stamp
`ownerServerKind` — that is what locks a database to its own box. One `mutate()`: create-and-place
is one action to the user, so undo must not strand a blueprint nothing runs.

**`lib/world/serviceDraft.ts` (pure)** is the translation layer. `HOSTABLE_KINDS` is
`api`/`worker`/`cache` — deliberately NOT the db kinds, since a database arrives as an appliance
from the AZ palette and `spread.canHost()` would refuse its blueprint on a plain VPS; offering it
here would let the form create a service nothing can host. `COST_MS` (light 2 / medium 8 / heavy
25) and `MEMORY_MB` (512 MB / 2 GB / 8 GB, each with a per-connection figure) map the form's
vocabulary onto `WorkloadProfile`. The presets ARE the WorkloadProfile — no parallel model, nothing
new for the engine to learn. Per-kind defaults differ because the kind changes what the form asks:
a worker gets `port: null` (it pulls work; a phantom listener would enter compileWorld's
port/firewall reasoning), a cache starts memory-heavy and light per request.

**Preset-vs-Advanced precedence:** `ServiceDraft.workload?` is an explicit override rather than a
"was edited" flag. Editing an Advanced field sets it; picking any preset CLEARS it. Whichever the
user touched last wins — without the reset, choosing a preset after hand-tuning would silently do
nothing and the preset radios would look broken.

Mounted in `ServicesDrawer` alongside — not replacing — `+ mount a blueprint…`. The two are
distinct: *add* authors a new service, *mount* attaches an existing one to a second host (how you
hand-place a replica without spread). Both are hidden on an appliance box, which owns exactly one
service. `BlueprintPanel`/`PlacementPanel` remain live until Phase 5, so this ships additively.

**Drawer clipping fix (`dock/Drawer.tsx`) — a latent bug this form surfaced.** The drawer body had
`overflow: hidden` with a hardcoded `OPEN_MAX_HEIGHT = 340`, so ANY content taller than 340px was
silently clipped and physically unreachable. The add-service form's submit button landed 9px past
the cap: present in the DOM, found by tests, unclickable in the browser — jsdom has no layout
engine, so all nine of the form's tests passed against a form that could not be submitted. The body
now scrolls vertically when open (`overflowY: open ? 'auto' : 'hidden'`; horizontal stays hidden so
rows never push the dock sideways). This affected every drawer, not just this one — a FIREWALL
drawer with enough rules had the same silent cliff.

Tests: `serviceDraft.test.ts` (10 — hostable kinds exclude db, preset→workload mapping, per-kind
defaults, port emission), `AddServiceForm.test.tsx` (9 — create+place, name required, preset
written through, worker hides ports, no db kind offered, Advanced override wins, preset overrides
a hand-tuned value, closes after adding, edit-lock), `world.store.test.ts` `addServiceToServer`
block (6), `Drawer.test.tsx` scroll-not-clip case.

## DB read/write routing + SQL/NoSQL fork — node-model Phase 3 core (2026-07-19)

The behavioral heart of the redesign: a DB dependency now carries reads and writes to different
destinations, and SQL vs NoSQL is the one meaningful fork.

**Data model.** `BlueprintDependency` gained `writeFraction?: number` (0..1, absent ⇒ 0). Optional
+ rides inside `blueprints`, so it round-trips through the serializer with no dedicated handling
(pinned by a serializer test) and keeps Phase 3 non-breaking until Phase 5's cutover.

**The seam — `worldEngine/flows.ts`.** The even fan-out at the old `share = admitted / candidates.length`
line is replaced by a pure, exported helper `splitDependencyShares(admitted, candidates, instances,
targetBp, writeFraction)` returning a per-candidate share array:
- Non-DB target (or `dbConfig` absent): even split, **byte-identical to pre-Phase-3** — this is
  what keeps the engine's golden tests unchanged (verified: the whole worldEngine suite passed
  untouched after the change).
- SQL: writes → the primary(s); reads → the replicas, or the primary when there are none (reads
  are never dropped). Writes concentrating on one primary IS the single-writer ceiling — the
  primary's host CPU (`hostScheduler.admittedScale`) caps them and the SPOF falls out for free;
  no new capacity subsystem.
- NoSQL: writes AND reads spread across every node — adding nodes raises write capacity, no SPOF.

The helper is gated so the hot path pays nothing for the common non-DB case (early return before
any role inspection), which matters because this is inside the per-step BFS the perf bench guards.
`routing.ts` was deliberately NOT given an `azBlueprintWriteTargets` table (the plan floated one):
the helper partitions from the candidate paths + live instance roles it already has, so a parallel
routing table would be redundant surface area.

**Cluster identity, reused from Phase 1.** "The blueprint IS the cluster" — a DB's primary and
replicas are placements of one blueprint distinguished by `Placement.role`. `spreadBlueprint`
(Phase 2) already creates replicas with `role: 'replica'`, so spreading a DB across AZs is exactly
what builds a read-scaling cluster. Phase 3 consumes that role with no new grouping concept.

**Authoring.** `world.store.setDependencyWriteFraction` (clamped, undoable) + a read/write slider
in `connections/ConnectionsView.tsx`'s `EdgeInspector`, shown ONLY when the edge targets a db-*
blueprint. The caption names where writes land ("writes go to the primary (single-writer ceiling)"
for SQL, "spread across every node (scales out)" for NoSQL) so the slider's consequence is legible.
Verified end to end in the app: dragged web→sql-1, set writes to 30%, confirmed the split.

**Not yet (Phase 3 remainder):** the cloud-managed DB path — a per-provider DB instance-class
catalog in `cloudRegistry.ts` (class → vCPU/RAM/writeRps/$/hr) and an explicit write-rps ceiling
applied at the managed terminal in `flows.ts` (managed targets have no capacity model today,
`flows.ts` `if (path.to.kind === 'managed') continue`). The self-hosted path above is the primary
story and is complete; the cloud ceiling is separable and deferred.

Tests: `readWriteSplit.test.ts` (8 — the pure share math: even non-DB split, SQL primary/replica
routing, no-replica and no-primary fallbacks, NoSQL spread, clamping, volume conservation),
`flows.test.ts` DB block (4 — through real compile+solveFlows), `world.store.test.ts`
`setDependencyWriteFraction` (3), `serializer.test.ts` writeFraction round-trip.

## Cloud-managed DB instance classes + write ceiling — node-model Phase 3 remainder (2026-07-19)

Completes Phase 3. A self-hosted DB gets its write ceiling for free from the host CPU model; a
cloud-managed DB (a ManagedService) has no host, so `flows.ts`'s managed terminal had NO capacity
model and always admitted. This gives it one, sourced from a chosen instance class.

**`lib/dbInstanceClasses.ts` (new, pure).** `DB_INSTANCE_CLASSES` — a per-engine ladder (sql.small
… sql.xlarge, nosql.small … nosql.large) where each class fixes both a write/read ceiling AND an
hourly price, so a bigger box costs more and lifts the write bottleneck in one decision. Provider-
agnostic (modelling AWS/GCP/Azure DB naming three times over teaches nothing the ladder doesn't).
`getDbInstanceClass` / `defaultDbClassId` accessors.

**Model.** `ManagedService` gained optional `instanceClassId` / `replicaCount` / `multiAz` /
`storageGb` (additive; absent ⇒ pre-Phase-3 black-box behavior). `types.ts` also exports
`MANAGED_DB_NODE_TYPES` and `managedDbEngine(nodeType)` (dbSql→sql, dbNoSql→nosql) so every consumer
agrees on what a managed DB is.

**Engine — `worldEngine/flows.ts`.** New pure export `managedDbRefusedRps(share, writeFraction, ms)`
returns how much of the demand a managed DB throttles: SQL `writeRps` is a single-writer ceiling
(replicas add reads only); NoSQL `writeRps` is per-node so nodes multiply it; replicas raise the
read ceiling for both; multiAz is failover cost, not capacity. Writes and reads overflow
independently and the refused amounts sum. Wired at the managed terminal: the admitted remainder
carries bytes as before, the over-ceiling excess becomes caller `refusedRps` + a blocked row — so a
non-DB managed target (or an unclassed DB) refuses nothing and is byte-identical to before
(the whole worldEngine suite passed untouched).

**Cost — `costModelV2.ts`.** `managedServiceMonthlyUsd` now takes the whole `ManagedService`: a DB
with a class prices as `class.hourlyUsd × (1 + replicaCount + (multiAz?1:0)) × 730 + storageGb ×
$0.115/GB-mo`, winning over the registry's flat rate. Verified in-app: upgrading a DB sql.small →
sql.large moved world cost by exactly (0.48−0.10)×730 = $277.40/mo.

**Store + UI.** `addManagedService` births a DB on the smallest class of its engine (so cost +
ceiling are live immediately); new `updateManagedService` patches class/replicas/etc.
`PlacementPanel`'s managed rows became `ManagedServiceRow`, which shows an instance-class picker +
replica count for DB types only (other managed services keep the plain label+delete). PlacementPanel
retires in Phase 5, so this authoring surface is deliberately minimal.

Tests: `dbInstanceClasses.test.ts` (7 — ladder monotonicity, resolvers, defaults),
`readWriteSplit.test.ts` managedDbRefusedRps block (8 — non-DB/unclassed no-op, SQL single-writer,
NoSQL node scaling, read ceiling, independent overflow), `flows.test.ts` managed-ceiling block
(3 — through solveFlows: admit under ceiling, throttle over, uncapped when unclassed),
`costModelV2.test.ts` class-pricing + replica scaling.

## Real replica promotion — node-model Phase 4 (2026-07-19)

Promotion was event-only: `failover.ts`'s `promoteReplicas` recorded `promotedAt` and emitted
`replica_promoted`, but nothing read it, so writes kept routing to the DOWN primary. Phase 4 makes
it REAL — writes fail over to the promoted replica — under a hard constraint: it must NOT mutate the
WorldDoc. `compiled` is derived from the doc, and world.store's mutate() pushes undo history + marks
the file dirty, so a running sim writing the document would corrupt both.

**The overlay — `failover.ts` `effectiveRoleResolver(compiled, promotedAt)`.** A pure resolver that
returns the EFFECTIVE role per instance from engine state alone: a promoted replica reads back as
'primary' (writes route to it), the failed original primary as 'replica' (demoted), everything else
its compiled role. Fast path: with no promotions it's a plain compiled-role lookup, so a healthy sim
pays nothing. The doc is never touched — the promotion lives entirely in the engine's `promotedAt`
map, exactly where the sim is allowed to hold mutable state.

**Threading — `flows.ts`.** `splitDependencyShares` now takes a `roleOf` function instead of the
`instances` map (it reads the effective role, not the compiled one). `FlowInput` gained an optional
`roleOf`; `solveFlows` defaults it to the compiled role, so every existing caller/test is unchanged.
`index.ts` builds the resolver from `s.failover.promotedAt` each step and passes it in. Step order
makes this work: `solveFlows` runs BEFORE `promoteReplicas`, so a promotion committed at the end of
one step is seen by the next step's routing.

**The write-outage window falls out for free.** Health hysteresis (~3s onset) means a failing
primary is 'degraded' then 'down' before `promoteReplicas` (which only fires on a 'down' instance)
runs. During that gap writes route to the failing primary and error; once down + promoted, writes
route to the healthy new primary. Reads keep flowing off the replicas throughout — nothing in the
read path depends on the primary.

Verified end to end HEADLESSLY through the real engine: `index.test.ts` builds an api→SQL cluster
(primary in az-a, replica in az-b), runs the engine, `setOutage`s az-a (the same API the dock's
"kill AZ" button calls), steps past hysteresis, and asserts the `replica_promoted` event fired AND
the promoted replica is healthy carrying the DB traffic while the downed primary is erroring. The
app was also confirmed to run cleanly with the overlay wiring.

Tests: `failover.test.ts` `effectiveRoleResolver` block (3 — fast path, promote+demote, safe
fallback), `flows.test.ts` promotion-overlay block (2 — writes follow the effective primary),
`index.test.ts` real-write-failover (the full cycle), plus the `splitDependencyShares` refactor to
`roleOf` (all prior read/write tests still green).

## Breaking-change cutover + cleanup — node-model Phase 5 (2026-07-19)

Final phase of the authoring redesign. Three deliverables: bump the file format and reject the old
model, retire the dead authoring panels, and give the surfaces they hosted a proper home. This is
where the redesign stops being additive-on-top-of-v2 and becomes the new baseline.

**Serializer cutover — `serializer.ts` (`.scalemap` v2 → v3).** `serializeWorld` now writes
`version: '3'`; `deserializeWorld` accepts only `'3'`, and rejects `'2'` at the version gate (BEFORE
the world-shape check) with a dedicated message naming the typed-node redesign — mirroring the
existing v1 rejection exactly. **Decision: clean breaking change, no auto-migration** — a
generic-blueprint (v2) world has no faithful translation into typed palette nodes / DB appliances /
cloud-DB instance classes, so it is refused rather than half-converted. The `ScalemapFileV2`
interface was renamed `ScalemapFileV3` (only its version string changed; the `world` shape is
identical — the redesign's fields, e.g. `blueprint.kind`/`dbConfig`, were all added additively to v2
in Phases 1–3). The additive-normalization block (`racks`/`loadBalancers`/`packets`/
`connectionLayout` defaulting) SURVIVES as defensive insurance for a hand-authored v3 file — the
serializer itself always writes the full `WorldDoc`, so a file it produced can never miss them.
`costModelV2.ts`'s `MANAGED_TYPE_ALIASES` table is now effectively unreachable-via-load (its only job
was pricing legacy short-string nodeTypes, which live only in v2 files) — left in place as a harmless
identity mapping; its removal is a separate cleanup, not part of the cutover. `fileOps.ts`'s
open flows already surface `deserializeWorld`'s thrown message to the UI (HomeScreen `setOpenError` /
WorldShell `setFileError`), so the v2 rejection reaches the user verbatim. Tests: `serializer.test.ts`
rewritten to the v3 contract (round-trips at `'3'`, v1 AND v2 both rejected with format-naming
messages, `'4'` is an unknown-version error, `'3'`-with-no-world is a shape error, defensive
normalization re-pinned at v3).

**Managed-service authoring relocated — `panels/ManagedPanel.tsx` (new), a world tab.** The retired
`PlacementPanel` was the ONLY surface that could author managed services (`addManagedService` +
Phase 3's cloud-DB `instanceClassId`/`replicaCount` pickers) — deleting it blind would have stranded
that entire capability, including Phase 3's headline cloud-DB config. **Why a dock panel and not a
floor node (the choice the earlier phases dictate):** Phase 1's `paletteEntries.ts` made a
deliberate, commented decision that managed services are "typed cost/routing terminals, not hosts",
so they are NOT droppable AZ-floor nodes; Phase 3 then EXTENDED the managed-service authoring inside a
dock panel rather than moving it to the floor. So across three phases managed authoring was
consistently a panel surface — Phase 5 keeps it one, just lifts it OUT of the dying PlacementPanel
into its own slim `ManagedPanel` (add row: type/scope/provider + `ManagedServiceRow` with the cloud-DB
instance-class/replica pickers). Every dispatch is byte-for-byte PlacementPanel's old managed section;
`world.store.ts`'s `addManagedService` still has exactly one production caller, now `ManagedPanel.tsx`
(update the row in §J's `world.store.ts` note if that count is ever re-audited). It also FIXES an
omission: the old picker offered only cloud SQL (`dbSql`); `ManagedPanel` adds `dbNoSql` ("NoSQL DB",
a real `CLOUD_REGISTRY` key that `managedDbEngine` already recognized), so cloud NoSQL is now
authorable too. Tests: `ManagedPanel.test.tsx` (add-with-provider, remove, cloud-DB class+replica
pickers drive the write ceiling, non-DB shows no class picker).

**Panels retired + tab set — `BlueprintPanel.tsx`/`PlacementPanel.tsx` DELETED (+ their tests).**
`ui.store.ts`'s `PanelTab` dropped `'blueprints'`/`'placements'` and gained `'managed'`; `dock/scope.ts`'s
`WORLD_TABS` is now `['topology','managed','connections','traffic','routes','analysis','events','cost']`;
`WorldPanel.tsx` dropped the two imports/renders + their `SignatureHeader` cases and added a `managed`
case (glyph 🗄, accent `--kit-cat-storage`). The generic blueprint/placement CRUD they held is fully
covered elsewhere: creating+placing a service is the VPS door (`AddServiceForm`), scaling/replicating
is `ServicesDrawer`'s stepper + `SpreadControl`, dependency wiring (incl. read/write ratio) is the
`Connections` tab. Comment-only reference updates: `RoutesPanel.tsx` (was "Modeled on
BlueprintPanel"), `cloudRegistry.ts` + `costModelV2.ts` (were "…and PlacementPanel.tsx"). Note:
`WorldDoc`'s `blueprints`/`placements` COLLECTIONS are untouched — they remain the internal
representation (`serializer.ts`'s required-collections list still names them, `doc.blueprints` is still
read for connection counts, etc.); only the two authoring TABS were removed. Tests: `scope.test.ts` +
`WorldPanel.test.tsx` updated to the new tab set (the "distinct accents" test drops from 7 to 6
distinct headers now that Placements' `--kit-cat-messaging` hue is gone).

**Post-creation service editor — `dock/drawers/EditServiceForm.tsx` (new), wired into `ServicesDrawer`.**
`AddServiceForm` sets a service's name/workload/ports/stateful once, at creation; the retired
BlueprintPanel was the only place to change them afterwards. A `✎` on each service chip in
`ServicesDrawer` now toggles this compact inline editor (live `updateBlueprint` dispatch, edit-locked
while running), restoring that capability. Dependencies are deliberately NOT here — those stay in the
Connections tab, which owns the edge shape end-to-end. Tests: `EditServiceForm.test.tsx` (rename,
port+visibility, workload field, stateful+volume default, edit-lock) + two `ServicesDrawer.test.tsx`
cases (✎ toggles the editor open/shut; ✎ locked while running).

Verified: full suite green (`npx vitest` — 1095 tests), `npm run build` clean.

## Managed services: outages, ceilings, per-AZ usage, storage + egress — node-model Phase 5.2 (2026-07-20)

Extends the managed-traffic-visibility work so managed services are killable, capacity-bounded, and
storage/egress-aware. Four parts (each independently buildable):

**A — Non-DB capacity ceilings.** `lib/managedCapacity.ts` (new, pure): `MANAGED_DEFAULT_CAPACITY_RPS`
per-type table + `managedCapacityRps(ms)` (override via new additive `ManagedService.capacityRps`, else
type default, else Infinity; `null` for a DB — its ceiling is the instance class). `flows.ts` gained
`managedRefusedRps` (generalizes `managedDbRefusedRps`: DB → write/read split, non-DB → `max(0,
share−capacity)`); `metrics.ts` utilization now bands off a real ceiling for every type. Authored in
`ManagedPanel.tsx` (a "rps capacity" field for non-DB rows). NOTE: like the DB ceiling, refusal is
applied per-caller-share in the flow solver, so the aggregate a service handles can exceed the single
number when fanned across many callers — a pre-existing solver trait, not new here.

**B — Managed outages.** `setOutage` scope widened `'server'|'az'|'region'|'managed'` (`worldEngine/
types.ts`, `simulation.store.ts`, `failover.ts`'s `outageEvent`). `failoverSetOutage` was already
scope-agnostic; `flows.ts` reads `state.failover.manualOutages` directly (via a new optional
`FlowInput.managedDown`) and refuses ALL traffic to a down service → the existing blocked-row path
emits `connection_refused` automatically. `simulation.store.setOutage` already sets `healthOverrides[id]`
(scope-agnostic), so views show "down (manual)" at rest. Kill/restore controls: the AZ-floor managed
box label (`DatacenterFloor.tsx`) + region AzRow/strip.

**C — Per-AZ managed usage.** `region/regionData.ts` `regionAzManaged(azId, doc, batch)` (pure) — the
az-scoped managed services in one AZ with rps/refused/utilization/health + `capacityRps`. `AzRow.tsx`
renders them as usage rows (utilization bar tinted by health, `⚠` on refusal, kill). The region-level
strip (`RegionView.tsx`) now filters to REGION-scoped services (az-scoped live in their AZ card) and
gained down-state + kill.

**D — Storage + per-service egress.** Authored `storageGb` + new `storageTierId` in `ManagedPanel.tsx`
for storage-capable types. `costModelV2.ts` now prices `storageGbMonth` for object/file storage (was
skipped) and computes per-service egress: a storage/CDN managed hop attributes its served bytes
(`cloudRegistry.MANAGED_RESPONSE_KB`) to `FlowTotals.managedEgressBytes` INSTEAD of the world
cross-zone bucket (no double count); `index.ts` windows it; `metrics.ts` surfaces
`ManagedServiceMetrics.egressBytesPerSec`; `computeWorldCost(doc, world, managed?)` (optional 3rd arg;
~6 call sites + `scopedCost` threaded) prices each storage service's egress at its OWN provider schedule
with a free allowance = base free tier + `PROVIDER_EGRESS.freeEgressPerStoredGb × storageGb` (the
Backblaze mechanism; 0 for aws/gcp/azure today). New `WorldCostResult.managedEgressUsd`.

Verified: 1115 tests green, build clean; driven end-to-end (queue throttles at a lowered capacity → ⚠;
kill → down + callers refuse; restore → recovers). Contract-drift.md logged (Phase 5.2 entry).

## Managed services in the topology tree, AZ list, and region metric bar — node-model Phase 5.3 (2026-07-20)

A cloud-managed service (e.g. a region-scoped SQL DB) was authored + costed + rendered on the AZ
floor + shown in the region strip, but was INVISIBLE in the world Topology tree, the AZ dock's SERVERS
list, and had no metric bar in the region strip. Users couldn't see it was part of the system from
those surfaces. This surfaces it everywhere, reading the existing `batch.managedServices` metric:

- **`TopologyPanel.tsx`** — a new `ManagedRow` in the REGIONS tree: region-scoped services listed once
  under the region (`· region-wide` tag), az-scoped under their AZ. Shows 🗄 label · nodeType · live
  rps + health + delete.
- **`dock/AzConfigTab.tsx`** — the SERVERS slat list now appends the managed services present in the AZ
  (az-scoped here + region-scoped in the region — matching what the floor renders), non-selectable,
  with health LED + rps.
- **`RegionView.tsx`** — the region-managed strip chips gained a utilization **metric bar** (live load ÷
  ceiling, health-tinted) — the "metric bar" the region view was missing.
- **`ManagedPanel.tsx`** — added the `multi-AZ` standby toggle for DB services (`ManagedService.multiAz`
  was in the model + priced by `costModelV2` but never authored) — the "more config" ask.

No engine/contract changes — pure view additions over the Phase-5.1 metric. Tests: TopologyPanel /
AzConfigTab / RegionView / ManagedPanel render + dispatch cases. Verified: 1118 tests, build clean,
driven end-to-end (region-scoped SQL DB now shows in topology tree, AZ dock list, and region strip
with a live metric bar).

---

## Managed-DB stress-test model: queueing, timeouts, connections — node-model Phase 5.4 (2026-07-21)

A cloud-managed DB failed along exactly ONE axis — rps vs its instance-class write/read ceiling — at
a fixed 3 ms latency, reporting only `rps`/`refusedRps`/`utilization`. You could not stress it to a
concrete failure throughput, and you could not see WHY it was struggling. This phase gives it a real
failure model, fixes a long-standing aggregation bug, and surfaces the result. (The 2026-07-20
section above is labelled Phase 5.3 — that was the visibility pass; this is the separate model pass.)

**A — The model. `src/lib/managedDbRuntime.ts` (NEW, pure — no engine imports).**
`managedDbRuntimeFor(ms, totalRps, writeFraction)` returns `{ totalRps, saturation, p50Ms, p99Ms,
connections, timeoutErrorFraction, connectionRefusedRps, ceilingRefusedRps, refusalFraction }`, or
`null` for a non-DB service / a DB with no instance class (the uncapped pre-Phase-3 behavior). Three
mechanisms, each chosen because the sim can SHOW its effect:
- **Queueing latency** — `p50 = base / (1 − min(saturation, 0.98))`, per-engine bases in
  `DB_BASE_LATENCY_MS` (SQL r3/w6 ms, NoSQL r1.5/w4 ms). `saturation` is the BINDING axis
  (`max(writeUtil, readUtil)`), not a blend: a write-pinned DB queues even with idle read capacity.
- **Query timeout** (`queryTimeoutMs`) — past the timeout a growing fraction of admitted calls ERROR.
  This is the SOFT failure that bites BELOW the rps ceiling, and it is the direct answer to "at what
  throughput does this DB fall over."
- **Connection ceiling** (`maxConnections`, new REQUIRED field on `DbInstanceClass`) — live
  connections ≈ admitted rps × latency (Little's law). A second saturation axis that COMPOUNDS with
  the first, since latency feeds it.
Plus `capacityMode` ('serverless' bursts both ceilings ×`SERVERLESS_BURST_MULTIPLIER` = 4) and
`replicaLocality` (a read-latency tier: same-AZ 0 / multi-AZ +1.5 ms / cross-region +30 ms, applied
to the READ share only — writes always hit the primary). `aggregateManagedDbLoad()` +
`managedDbRuntime(prevFlows, doc, compiled)` compose it per step.

**B — The §2.1 decision: per-caller → AGGREGATE refusal (a real bug fix).** `flows.ts` enforced the
managed ceiling inside its per-dependency loop, where `share` is ONE caller's slice — so two callers
each sending 60 % of the ceiling were both admitted and the DB silently absorbed 120 %. Every
mechanism above is a function of AGGREGATE rps, so the direction is now inverted: the runtime
computes ONE `refusalFraction` per DB from the PREVIOUS step's flows (same one-step lag as
`admittedScale`) and the solver applies it to each caller's share proportionally. Resolution of the
two pre-existing ceiling paths (documented in `managedDbRuntime.ts`'s header):
- `managedDbCeilings()` **survives** as the single source of capacity truth — the runtime CALLS it
  rather than recomputing, so the solver and the metrics gauge can never disagree.
- `managedDbRefusedRps()` / `managedRefusedRps()` remain the path for non-DB services, unclassed DBs,
  and any caller supplying no runtime; a DB WITH a runtime entry no longer reaches them.
- `managedCapacityRps()` (flat non-DB ceiling, `lib/managedCapacity.ts`) is untouched.

**C — Engine wiring.** `FlowInput.managedDbRuntime?` + `DownstreamFlow.failure?: 'throttled' |
'timeout'` (both additive-optional; the tag lets metrics split "too much load" from "too slow").
`ManagedServiceMetrics` gained `saturation?`/`p50Ms?`/`p99Ms?`/`connections?`/`errorRps?`.
`index.ts` computes the runtime once per step from `s.prevFlows` and feeds the solver, the metrics
window, AND the tracer. **`replay.ts` caught a latency inconsistency the plan flagged:** a managed hop
booked the flat `MANAGED_SERVICE_LATENCY_MS` (3 ms), so a traced request through a saturated DB
disagreed with the metrics pyramid by orders of magnitude — `Tracer.sample` now takes the runtime and
books its `p50Ms` for DB hops (non-DB managed hops keep the flat constant).

**D — Failover.** `failover.ts` gained `MANAGED_FAILOVER_WINDOW_MS` (15 s),
`MANAGED_PROMOTION_TIER_STEP_MS` (5 s), `FailoverState.managedDownSince`, and
`recoverMultiAzManagedDbs()`: a **multi-AZ** managed DB promotes its standby and clears its OWN
outage after the window (emitting `replica_promoted`); a **single-AZ** one stays down until manually
restored — which is what makes `multiAz` worth paying for. `promotionTier` delays the window.
**`simulation.store.ts` reconciles the UI copy:** `healthOverrides` is the store's kill-switch mirror,
so without clearing it on `replica_promoted` the DB served traffic again while the dock still rendered
it "down" with a restore button. (Found during runtime verification, not by a test.)

**E — Cost.** `costModelV2.ts`: `RESERVED_DISCOUNT` (onDemand 0 / 1yr 40 % / 3yr 60 %) on the
provisioned hourly; `capacityMode === 'serverless'` drops instance-hours entirely and prices per
request off live rps (`SERVERLESS_USD_PER_MILLION_REQUESTS`) — so a commitment discount cannot apply
to serverless (there is no provisioned capacity to commit to), which the panel enforces by disabling
the control.

**F — Authoring + visibility.** `ManagedPanel.tsx` DB rows gained capacity-mode / pricing /
`maxConnections` / `queryTimeoutMs` / replica-locality / promotion-tier controls (placeholders show
the class default). `regionData.ts`'s `regionAzManaged` now ALSO returns region-scoped services
(tagged `scope`) so an AZ card matches what the floor draws, plus the new gauges; `AzRow.tsx` renders
`sat% · p50 · conns` with a ⚠ on timeout errors, and `dock/AzConfigTab.tsx` gained the saturation bar
it never had. Two pre-existing `🗄` emoji were removed from the rows being rewritten (hard-law 5).

**Model/format.** `ManagedService` gained `maxConnections?`/`queryTimeoutMs?`/`capacityMode?`/
`pricing?`/`replicaLocality?`/`promotionTier?` + the `ManagedCapacityMode`/`ManagedPricingCommitment`/
`ReplicaLocality` unions. All optional ⇒ **`.scalemap` stays v3**; pre-5.4 v3 files load unchanged.

**Verification.** 120 test files / 1156 tests green, `npx tsc --noEmit` clean (baseline 119/1118).
Contract-drift.md logged (Phase 5.4 entry). Driven end-to-end in the running app: a `sql.small` DB at
1900 rps of reads sat at **66 % of its read ceiling with ZERO throughput refusals yet 228 rps
erroring**, because queueing pushed p50 to 9.8 ms against a 10 ms timeout — the soft failure landing
before the hard ceiling, exactly as designed. At 3200 rps, provisioned read sat 0.91 / p50 78 ms /
104 connections / 931 rps refused, and flipping to serverless dropped it to sat 0.32 / p50 4.4 ms /
0 refused. Reserved-3yr cut the DB's monthly compute by the expected 60 %. A killed multi-AZ DB
auto-recovered (`replica_promoted`, traffic back to 1201 rps, kill-flag cleared); a single-AZ one
stayed down.

---

## Managed-service edit modal — node-model modal plan (2026-07-21)

Closes out the plan that replaced `ManagedPanel.tsx`'s inline managed-service config fields
(type/scope/provider only — no way to touch DB or storage/capacity settings without editing raw
state) with a proper add/edit modal. Four tasks; three are new module boundaries worth recording
here (Task 4's `ManagedPanel.tsx` row-summary swap is mechanical, not a new boundary).

**1 — `addManagedService`'s 6th param.** `world.store.ts`'s `addManagedService` gained a 6th,
optional `config?: Partial<ManagedService>` parameter (`c735dc0`) — the same additive
trailing-param pattern as the existing `provider?` addition documented at §M, line 439 (Phase 4
Task 7): both widen the same action, both stay backward-compatible for every pre-existing call
site because the new param is optional and last. `config` merges over the engine-derived DB
defaults, with explicitly-`undefined` keys stripped first (CREATE-path semantics only —
`updateManagedService`'s own clear-vs-nothing distinction is untouched), and `id` is re-pinned
after the spread so `config` can never override the entity's identity.

**2 — `src/lib/world/managedDraft.ts` (new).** Pure, no React/store imports, node-testable —
sibling to `serviceDraft.ts` (the VPS-door service-authoring draft module, §"Service authoring
form" 2026-07-18) in the same directory, same shape: a draft type plus pure conversion functions
between it and the concrete document record. Exports the `ManagedDraft` type, `MANAGED_TYPES`,
`PROVIDERS`, `STORAGE_CAPABLE`, `scopeToKey`/`scopeFromKey`, `defaultManagedDraft`,
`draftFromService`, `draftToConfig` — plus two invalidation helpers beyond the plan's original
export list: `applyNodeTypeChange` (re-bases type-derived fields when the node type changes, the
same idiom as `AddServiceForm.tsx`'s `pickKind`) and `applyProviderChange` (clears
`storageTierId` on a provider change, since tier ids are provider-specific and `generic` has
none).

**3 — Portal-vs-fieldset edit-lock (a general law for future modals).** `WorldPanel.tsx` locks
its whole dock body with one dock-wide `<fieldset disabled={running}>` (line 294) that every
existing dock tab relies on for free. A `createPortal(..., document.body)` modal renders OUTSIDE
that React tree entirely — its DOM lands as a sibling of the app root, not a descendant — so the
dock's fieldset never reaches it, and `running` has no effect on its controls unless the modal
declares its own. `ManagedServiceModal.tsx` is the first real instance of this pattern in the
codebase: it wraps only its editable field sections in their own `<fieldset disabled={running}>`,
deliberately leaving Close/Cancel/Submit outside that wrapper so there is always an escape hatch
even mid-run. Any future portal-rendered modal that must respect the simulation running-lock
needs this same self-contained fieldset — inheriting the dock's lock is not an option once a
component is rendered through a portal.

---

## Firewall rules modal — wired into both entry points, inline editor retired (2026-07-22)

Follow-on to the "portal-vs-fieldset edit-lock" law just above: `src/app/world/server/
FirewallRulesModal.tsx` (built standalone, unmounted) is now the ONE firewall-rule editor in the
app, reachable from two independent trigger trees that both bottom out at a single
`WorldShell.tsx`-owned mount. The old cramped inline editor (`inspectorForms.tsx`'s
`FirewallEditor`, 280px-rail-sized) is deleted outright — there is no longer any per-field
firewall editing UI anywhere except the modal.

**Lifted-state opener, mirroring `settingsOpen`/`openSettings` exactly.** `WorldShell.tsx` gained
`firewallRulesServerId: string | null` + `openFirewallRules(serverId)` (same shape as the
existing `settingsOpen` pair, just parameterized by which server) and mounts
`<FirewallRulesModal open={firewallRulesServerId !== null} serverId={firewallRulesServerId}
onClose={() => setFirewallRulesServerId(null)} />` alongside `SettingsModal`/`ConnectionsView`.
Both trigger trees thread the SAME `openFirewallRules` callback down to their leaf, each binding
it to their own local server id as a zero-arg closure at the last hop (`FirewallDrawer`'s
`onOpenRules`, `InspectorRail`'s `onOpenFirewallRules`) so the leaf components themselves never
carry a server id parameter in their opener prop:

- **Dock tree:** `WorldShell` → `WorldPanel` (`openFirewallRules` added to `WorldPanelProps`) →
  `ServerFaceplate` (`openFirewallRules` added to `ServerFaceplateProps`, bound to
  `onOpenRules={() => openFirewallRules(server.id)}` on its `<FirewallDrawer>` mount) →
  `dock/drawers/FirewallDrawer.tsx` (`FirewallDrawerProps` gained `onOpenRules: () => void`; its
  `+ rule` button's `onClick` now calls `onOpenRules` instead of blind-appending a default rule
  via `updateServer` — the `addRule` function and its now-unused `useWorldStore`/`nextWorldId`
  imports are deleted; the drawer no longer writes to the store at all, it's pure read + one
  opener). Footer hint copy changed from the now-stale "edit rules on the board" to "open rules
  editor".
- **Board tree:** `WorldShell` → `ServerView` (gained `ServerViewProps { onOpenFirewallRules:
  (serverId: string) => void }` — previously had NO props) → `server/InspectorRail.tsx`
  (`InspectorRailProps` gained `onOpenFirewallRules: () => void`, bound at the `ServerView` mount
  site as `() => onOpenFirewallRules(serverId)`). Inside InspectorRail's `kind==='firewall' ||
  'rule'` branch: the inline `<FirewallEditor key={serverId} serverId={serverId} />` mount
  (previously conditional on `selection.kind === 'rule' || rules.length === 0`) is replaced by an
  UNCONDITIONAL `data-testid="firewall-open-rules-modal"` "edit rules…" button — unconditional
  because the modal needs no empty-list special case (no rows to click into to reach `kind:
  'rule'` matters when there's a permanent, always-rendered opener). Rule-row clicks keep their
  existing behavior unchanged (toggle `{kind:'firewall'}`/`{kind:'rule', ruleId}` for highlight
  only) — the new button is a second, independent way in, not an overload of row-click.
  `ServerBoard.tsx`'s `FirewallGate` `onSelect` wiring needed NO changes (confirmed by reading,
  not assumed) — it already only dispatches `{kind:'firewall'}` with no `ruleId` and no
  interactive-editing hook, so the click-to-highlight path both trees still share was never
  coupled to `FirewallEditor` in the first place.

**`inspectorForms.tsx` shrinks.** `FirewallEditor` deleted entirely, along with the `FirewallRule`
type import and the `sel`/`nextWorldId` locals that turned out (confirmed by grep, not assumed —
the brief's own "verify, don't assume" instruction here was correct to include) to have had NO
other consumer in the file; `noUnusedLocals` would otherwise fail the build. `WorkloadForm`/
`RuntimeForm`/`VolumesEditor` and the shared `inp`/`fs`/`lockNote`/`NumberField` are untouched —
those forms' own edit surfaces (instance/stack panels) are out of scope for this change.

**Test-file fallout beyond the two files with the interesting rewrites
(`InspectorRail.test.tsx`/`FirewallDrawer.test.tsx`).** Any component that gained a new required
prop needed every one of its `render()` call sites updated, including two files never mentioned in
this task's own brief but discovered by grepping the actual call sites rather than trusting the
brief's file list: `ServerFaceplate.test.tsx` (34 render calls) and `WorldPanel.test.tsx` (26
render calls) both needed a no-op `openFirewallRules={() => {}}`/`openFirewallRules` addition;
`ServerBoard.test.tsx` had one more `<ServerView />` zero-prop mount beyond the two already known
in `ServerView.interaction.test.tsx`. General lesson for future prop-threading tasks in this
codebase: grep for every `<Component` call site directly rather than relying on a brief's
enumerated list, even a carefully-researched one — test files accumulate mount sites faster than
any single planning pass can track.

`InspectorRail.test.tsx` also had two MORE tests than the brief's line-range citation
(`~109-149`) that directly rendered the now-deleted `FirewallEditor` component
(`'firewall reorder swaps array order'` and `'all forms disabled while running'`, both in the
`'inspector editing forms'` describe block, not the `'InspectorRail (read panels)'` block the
brief's line numbers pointed at) — both deleted with a comment pointing at their new home
(`FirewallRulesModal.test.tsx`, already covering the same scenarios per Task 1's test suite).

**Second confirmed instance of the portal-vs-fieldset edit-lock pattern.** Where
`ManagedServiceModal.tsx` is the first real instance of this pattern in the codebase (line 3031
above), `FirewallRulesModal.tsx` is the second: same `createPortal(..., document.body)` escape
from `WorldPanel.tsx`'s dock-wide fieldset, same self-contained `<fieldset disabled={running}>`
wrapped only around its editable field sections, same Close left outside that wrapper as an
always-available escape hatch. One deliberate deviation from the first instance, though:
`FirewallRulesModal` has no draft/Save/Cancel staging — every field commits live to the store on
change, matching the pre-existing `FirewallEditor`/`WorkloadForm`/`RuntimeForm`/`VolumesEditor`
family in `inspectorForms.tsx` rather than `ManagedServiceModal`'s staged-draft approach. This is
an intentional per-data-shape choice, not a gap to reconcile toward `ManagedServiceModal`'s
pattern: firewall rules are an ordered list of independently-valid rows, where no combination of
field values is ever invalid mid-edit, unlike `ManagedServiceModal`'s single multi-field entity,
where a half-edited combination frequently IS invalid mid-edit (e.g. changing `nodeType` needing
to re-derive `instanceClassId`).

## Audit critical fixes — ISSUE-001 through ISSUE-006 (`audit-spec.md`, 2026-07-22)

Six critical findings from the system audit (`audit-spec.md`, repo root), executed in dependency
order 004 → 005 → 003 → 006 → 001 → 002 (006 before 001 because 001's breaker feed relies on
006's "attempts still land when every target is down" error signal; both touch `flows.ts`). One
commit per issue on `fix/audit-critical-001-006`. No `worldEngine/types.ts` contract shapes
changed — every engine-side extension is an internal or optional-additive seam, so no
contract-drift entry was needed.

- **ISSUE-004 (`WorldShell.tsx`):** the global Ctrl+Z / Ctrl+Shift+Z handler now early-returns
  when `useSimulationStore.getState().running` — the hotkey path finally mirrors the authoring
  edit-lock (undo mid-run swapped the doc under a running engine, desyncing every view from
  `batch.instances` keyed by the old ids). The undo/redo branches were merged into one
  `meta+z` block with the gate checked once.
- **ISSUE-005 (`simulation.store.ts`):** `markSpillBroken()` is the single place `spillBroken`
  flips (both the `eventLogAppend` and `eventLogBeginRun` failure paths) and it also empties
  `pendingEvents`; `onEvent` guards its push on `!spillBroken`. New read-only diagnostic export
  `pendingEventCount()` — an observability seam for bounded-ness tests, not part of the store's
  state (module-local buffering deliberately never re-renders views).
- **ISSUE-003 (`costModelV2.ts`):** the registry pricing loop now bills `requestsPerMillion`
  from live rps (`rps × SECONDS_PER_MONTH / 1e6 × usdPerMillion` — the same projection the
  serverless-DB path already used; `computeWorldCost` already threaded `managed[id].rps` in,
  it just was never consumed on the registry path) and `computeResource` at a documented default
  sizing (`MANAGED_COMPUTE_DEFAULT_VCPU`/`_RAM_GIB` = 2 vCPU / 4 GiB, x86 rates) because
  `ManagedService` carries no provisioned-size fields — that constant pair is the seam a future
  sizing knob replaces. Lambda/SQS/EventBridge/SNS/API Gateway/CDN-requests/DNS-queries/WAF and
  managed ec2 no longer bill $0. The `usd === 0` early-drop stays (now a genuine no-op skip,
  documented inline).
- **ISSUE-006 (`flows.ts`):** `splitDependencyShares` gained an optional trailing
  `healthWeightOf(instanceId) => number` param (default weight-1 — every existing caller/test
  unchanged); `solveFlows` passes down ⇒ 0 / degraded ⇒ `DEGRADED_ADMIT_FACTOR` / healthy ⇒ 1,
  renormalized per pool. Internal fan-out now mirrors the entry tier's down-exclusion. Two
  deliberate asymmetries: (a) a pool whose EVERY member is down falls back to the even split so
  attempts still land and fail live at the dead targets (the error signal ISSUE-001 needs);
  (b) SQL reads SPILL to the primaries when every replica is down (a primary can always serve
  reads) but writes never spill to replicas (they can't take writes until promotion flips
  roles) — (b) was surfaced by the replica-promotion e2e, where the demoted-down original pinned
  the whole read share as errors and tripped the caller's now-working breaker against a healthy
  promoted primary.
- **ISSUE-001 (`breakers.ts`, `index.ts` step 8):** `recordWeighted(b, errored, total, simMs)`
  generalizes the window to per-batch error FRACTIONS (0..1); `recordResult` remains as the
  boolean special case (`failed?1:0, 1`), so window math, `MIN_SAMPLES_TO_OPEN`, and the
  half-open state machine are unchanged for boolean callers — half-open now resolves against
  `errorThreshold` (fraction 1/0 behaves exactly as the old true/false). Step 8 feeds each
  downstream row the TARGET's observed error fraction (`errorRps / offeredRps` from this step's
  completed flows — aggregated across all callers by the time the solver returns); hard-blocked
  rows stay fraction 1; the `row.rps <= 0` skip is preserved. A down / erroring / CPU-shedding
  downstream instance finally opens its callers' breakers. Known deferred refinements:
  rps-weighted time-bucketed windows + close-threshold hysteresis are ISSUE-015 (Major), and the
  errorRps shed/degraded/hard-down conflation feeding this fraction is ISSUE-042 (Minor).
- **ISSUE-002 (`networkRuntime.ts`, `flows.ts`, `index.ts`):** the NIC cap result is no longer
  discarded. `NicState` gained `backlogBytes` (send-buffer carryover, bounded at one step-cap —
  the beyond-2×-cap slice is shed, not queued); new `addNicBytes` (accumulate-only) and
  `settleNic` (end-of-step evaluate + carry + counter reset) share one evaluator with the kept
  `applyNicCap` single-shot API. `index.ts` persists `nics` per server from `start()`, books
  asymmetric bytes (`NIC_REQUEST_BYTES` 512 in / `NIC_RESPONSE_BYTES` 2048 out — the symmetric
  `BYTES_PER_REQUEST_EACH_WAY` remains the cost-model convention in `flows.ts`), settles AFTER
  step 10's `accumulateStep` (which reads the per-step counters settleNic resets), and feeds the
  settlement into the NEXT step: `deliveredFraction` multiplies into `admittedScaleByServer`,
  `queuedLatencyMs` rides `FlowInput`'s new optional `extraLatencyMsByServer` (added on top of
  the multiplied sampled service latency in `getFlow`). One-step lag, exactly like
  `admittedScale`/`vpsFactor`. Note for anyone reading `ServerMetrics.nicInMbps`: ingress now
  books 512 B/request instead of 2048, so absolute in-Mbps readings dropped 4× (shape unchanged).

Boundary notes: `breakers.ts`'s `recordResult` callers outside the engine facade are unaffected
(the signature is unchanged); `splitDependencyShares` and `solveFlows` extensions are
optional-additive; `simulation.store.ts`'s new export is read-only.

## Audit critical fixes — ISSUE-007 through ISSUE-012 (`audit-spec.md`, 2026-07-22)

The remaining six criticals, executed one commit per issue (007+008 share `failover.ts` and land
together). One `worldEngine/types.ts` contract change — the additive `'primary_failback'`
`EngineEventKind` — logged in `.superpowers/sdd/contract-drift.md` alongside the internal
`managedDownSince` shape change.

- **ISSUE-007 (`failover.ts`, `index.ts`):** replica promotion is health-aware, re-armable, and
  reversible. `promoteReplicas` gained an optional trailing `healthOf(instanceId) => HealthState`
  (engine passes `healthOfInstance`): candidates are ranked healthy > degraded (down excluded),
  id compare only as the determinism tiebreak. The lexical-pick and the emit-once guard are both
  gone — the loop now resolves roles through `effectiveRoleResolver`, so a still-down ORIGINAL
  primary reads 'replica' after failover (no duplicate emit — same observable behavior as the
  old guard) while a failed PROMOTED primary reads 'primary' and triggers re-promotion, clearing
  its stale `promotedAt` entry so exactly one placement per cluster carries the overlay. New
  `failbackPromotions(state, compiled, doc, healthOf, simMs)` — called in the step just BEFORE
  promotion — clears a cluster's promotion and emits `'primary_failback'` (new additive
  `EngineEventKind`) once every authored primary is healthy again; the health hysteresis' 5s
  recovery lock is the failback debounce.
- **ISSUE-008 (`failover.ts`, `index.ts`):** manual operator outages and simulated infrastructure
  failures are no longer conflated. `managedDownSince` entries became
  `{ sinceMs, source: 'manual' | 'simulated' }`; `setOutage('managed', …)` tags 'manual', and
  `recoverMultiAzManagedDbs` skips manual entries — an operator-killed multi-AZ DB now stays
  down until explicitly resumed instead of spontaneously restoring ~15s later. The 'simulated'
  producer is the new `applyAzOutageToManaged(state, doc, azId, down, simMs)`, called by the
  facade's `setOutage` for AZ scope: an AZ kill takes its az-scoped managed services down as
  simulated outages (multi-AZ DBs then auto-promote their standby after the failover window —
  the multiAz value story now rides the AZ kill switch, not the per-service one), and an AZ
  restore clears simulated outages only — it can neither resurrect a manual kill nor can an AZ
  failure overwrite one. `manualOutages` (the name predates the split) remains the single
  all-sources outage set `flows.ts`/`index.ts` read — zero changes to the flow solver.
- **ISSUE-009 (`world/routing.ts`):** the `latency` policy no longer adds `baseLatencyMs × 10` —
  a "distance from a US-East reference client" constant that biased every population on Earth
  toward regions near Virginia (a mid-US population ranked Virginia above a ~400 km-closer
  N. California). Score is now `km × PROPAGATION_MS_PER_KM (0.01) + REGION_PROCESSING_MS (2)` —
  population→region great-circle propagation (~0.01 ms RTT/km in fiber) plus a
  location-independent constant, so ordering is true-distance. `WORLD_REGIONS` is no longer
  imported by routing.ts; `regionConfig.ts`'s `baseLatencyMs` keeps its other consumers.
- **ISSUE-010 (`analysis/rules/capacity.ts`):** `ttl-outlives-detection` was inverted — it fired
  on `ttl < detection` (the HEALTHY config, since total failover ≈ detection + up to one TTL)
  and its fix text recommended raising the TTL, which worsens real failover. Now fires on
  `ttl > detection` (stale cached records outlive detection) and recommends lowering
  `dnsTtlSec`. Vault example worlds were re-authored to the corrected semantics:
  `multi-region-failover` (clean) dropped `dnsTtlSec` 20 → 5 (below its 6s detection window);
  `broken-teaching` raised 5 → 120 (outliving its 36s window) so it still trips the rule.
- **ISSUE-011 (`world/network.ts`, `analysis/rules/network.ts`):** new shared helper
  `isInternetSource(source)` in `world/network.ts` — true for `'any'` and every 0-length CIDR
  prefix (`'0.0.0.0/0'`, `'::/0'`, any `/0`). The analysis rules' `openToAny` uses it instead of
  the literal `m.source === 'any'`, fixing both directions at once: `db-port-exposed` no longer
  false-negatives on a DB port opened to `0.0.0.0/0`, and `entry-unreachable` no longer
  false-positives on a front door reachable only via it. `evaluateFirewall` itself is untouched
  (Phase-1 all-internal source semantics).
- **ISSUE-012 (`serializer.ts`, `world/routing.ts`):** the v3 gate now validates values, not just
  shape. Present-but-invalid fields REJECT with the established `Invalid .scalemap file: …`
  message style (`server <id> hourlyUsd`/`specs.*` must be finite numbers; `routing.policy` must
  be a known policy; routing timing fields must be finite); MISSING fields keep the defensive
  leniency (routing timing defaults to 30 / 10 000 / 3 — the `createWorld()` values — and the
  hand-authored bare-server test still loads). Defense in depth: `regionOrderFor`'s policy
  `switch` gained a `default: score = km` (geo fallback) so an unknown policy that ever slips a
  boundary can't leave scores `undefined` and poison the sort.

Boundary notes: `promoteReplicas`' new param and `'primary_failback'` are additive (both event
consumers verified tolerant — `timelineModel.markerClass` has a `default:` arm,
`simulation.store` pattern-matches specific kinds); `managedDownSince`'s entry shape is
engine-internal (only failover.ts + tests touch it); `isInternetSource` is a new pure export with
no existing-caller impact.

## Audit major fixes — ISSUE-013 through ISSUE-032 (`audit-spec.md`, 2026-07-23)

All 20 Major-tier issues, one commit per issue (013/016/018 land together — the spec marks them
compounding). The Minor tier (ISSUE-033 onward) landed as its own pass — see the next section.

**Engine fidelity (`src/lib/worldEngine/`):**

- **ISSUE-013 + -016 + -018 (`flows.ts`, `hostScheduler.ts`, `index.ts`):** the flow solver
  gained a persistent QUEUE MODEL. `stepHost` now returns `serviceRateByInstance` — a weighted
  fair share of `effectiveVcpu` per instance (`WorkloadProfile.cpuShares?`, default 1;
  demand-capped water-fill for work conservation, PLUS a fair-share floor so a cold/recovered
  instance never has zero capacity; `InstanceLoad.backlogRps?` lets a draining instance claim
  capacity beyond its instantaneous demand). `solveFlows` accepts optional
  `serviceRateByInstance` + `queueDepth` (engine-owned `Map`, mutated in place, carried across
  ticks) + `stepSec`; when all three are present the queueing path runs:
  `served = min(capacity, backlog-first + arrivals)`, excess fills a bounded queue
  (`capacity × MAX_QUEUE_SEC`, 2s), ONLY past-the-bound overflow/timeout becomes `errorRps`, and
  Little's-law wait (`Q/capacity`) adds to `serviceLatencyMs`. Capacity =
  fair-share CPU rate × NIC line-rate ceiling (an absolute rps derived from `specs.nicMbps` —
  a fraction multiplied onto an ample CPU rate never bites) × health factor (down ⇒ 0 ⇒ zero
  queue ⇒ instant errors, subtree still zeroed). Backlogged instances with no arrivals are
  BFS-seeded at zero offered so they drain and their served work still fans out. The per-server
  `admittedScale` CPU shed — the ISSUE-016 one-step-lag oscillator — is GONE from the engine
  path (`admittedScaleByServer` now carries only the NIC deliveredFraction); absent the queue
  inputs `solveFlows` runs the legacy proportional path, so existing solver call sites/tests are
  a frozen back-compat contract.
- **ISSUE-014 (`index.ts`, `metrics.ts`):** starved-vs-idle. `buildDownstreamAdj(compiled)`
  (permitted instance→instance edges, built at `start()`) feeds a per-batch BFS from the down
  set; a reached non-down instance with no offered traffic is STARVED and `buildBatch`'s new
  optional `starved?: Set<InstanceId>` publishes it 'degraded' instead of healthy-at-0
  (override lifts 'healthy' only — real degraded/down win; presentation-only, never fed back
  into failover inputs). `activeConnections` drain rides the existing rps EMA (~70%/s).
- **ISSUE-015 (`breakers.ts`, `index.ts` step 8):** Hystrix-shaped windows. The flat 20-sample
  fraction array became time-bucketed (`bucketMs` 1s × `bucketCount` 10) REQUEST-WEIGHTED
  `{failures, total}` buckets — step 8 records `rps × stepSec` request counts, so
  `minTotalToOpen` (10) has real units and a 10 000-rps dependency outweighs a 1-rps one.
  Hysteresis: open at `errorThreshold` 0.5, a half-open probe batch is a SUCCESS only below
  `closeThreshold` 0.2, and closing needs `halfOpenProbes` (3) consecutive successes — a ~50%
  dependency opens and stays open. `BreakerConfig` reshaped (windowSize → bucket fields);
  `recordResult` stays the boolean special case.
- **ISSUE-017 (`demand.ts`, `index.ts`):** Poisson arrivals + flash crowds. The diurnal curve
  sets the MEAN; per-step arrivals are a seeded Poisson draw (`samplePoisson` — Knuth < 64,
  normal approx above), replacing the ±3% uniform jitter that never stressed queues/breakers.
  New per-population `PopulationDemandState` (engine-owned map) runs an on-off burst process
  (~1 per 200s, ×1.5–3 for 2–10s), scaled by additive-optional `ClientPopulation.burstiness?`
  (0 disables). Deterministic: all draws through the engine rng in fixed population order.
- **ISSUE-019 (`vpsModel.ts`):** burstable credits accrue CONTINUOUSLY at the baseline rate and
  drain proportionally to utilization above baseline (net −3/s pegged, +2/s idle) — the old
  accrual gate (`util < 0.4`) was held shut by the throttle's own effect, a permanent 0.4×
  lockout. `VpsState.throttled` with a real hysteresis band: engage ≤ 10, release ≥ 25.
- **ISSUE-020 (`routingRuntime.ts`):** health checks gained a rise threshold
  (`consecutiveSuccesses` + additive-optional `RoutingConfig.healthCheckHealthyThreshold`,
  default 2): a single healthy probe no longer wipes the failure count, so a flapping scope
  RATCHETS to failed; recovery needs N consecutive passes (ALB/NLB semantics).
- **ISSUE-021 (`world/types.ts`, `world/routing.ts`, `index.ts`):** weighted policy splits
  traffic PROPORTIONALLY. Additive `CompiledRouting.regionProportions?` (normalized over
  positive weights; absent for other policies / all-zero weights) — the engine's step 3 splits
  each population's demand by it across not-down regions (renormalizing over survivors), one
  `populationRoutes` row per served region, `popRegion`/failover events keyed to the
  highest-share region. All-zero weights still fall back to the order-based path. Logged in
  `contract-drift.md` (`WorldMetrics.populationRoutes` may now carry >1 row per population).
- **ISSUE-032 (`index.ts`):** per-step health propagation reads `serversByAz`/`azsByRegion`
  maps built once at `start()` (new `groupBy` helper) instead of re-filtering
  `doc.servers`/`doc.azs` per AZ/region every step.

**Cost model (`src/lib/costModelV2.ts`, `src/lib/cloudRegistry.ts`):**

- **ISSUE-022:** managed-DB provisioned storage bills the provider's own registry
  `storageGbMonth` tier via new `dbStorageRate(ms)` (GCP 0.17 vs AWS/Azure 0.115); the old
  constant survives only as `DB_STORAGE_FALLBACK_USD_PER_GB_MONTH` for unresolvable providers.
- **ISSUE-023:** new `PROVIDER_INTERZONE` table in `cloudRegistry.ts` ($/GB against the
  engine's two-way metered wire bytes; AWS's per-direction cross-AZ billing folds to 0.02 —
  2× the old flat rate — GCP 0.01, Azure 0; cross-region aws/azure 0.02, gcp 0.05). The world
  line bills at the documented aws default (servers carry no provider field — same
  simplification as internet egress); the table is the per-provider seam.
- **ISSUE-024:** `computeWorldCost` accumulates the compute total ALONGSIDE every bump instead
  of summing `byRegionMap` — a server/service pointing at a deleted AZ (normal mid-edit
  transient) now still reaches `monthlyUsd`, so the total is provably complete.

**Analysis rules (`src/lib/analysis/rules/structural.ts`):**

- **ISSUE-025:** `no-failover-region` fires on SERVABLE regions (those hosting an
  entry-blueprint instance; fallback to any-instance regions when the world has no public port
  at all) — a second authored-but-empty region no longer silences it.
- **ISSUE-026:** `replicas-colocated` flags EVERY AZ holding ≥2 copies of a stateful blueprint
  (any roles — partial colocation and multi-primary clusters included); finding ids are now
  `replicas-colocated:<bpId>:<azId>` (one per colocated AZ).

**Perf (`src/lib/world/compileWorld.ts`, `src/app/`):**

- **ISSUE-027:** `compileWorld` indexes `instancesByBlueprint` once — dependency resolution is
  O(I × D × matches), not O(I² × D); path order byte-identical.
- **ISSUE-028 (`useCompiledWorld.ts`):** compilation cached per doc IDENTITY in a module
  WeakMap (`compiledFor(doc)` exported for non-hook use) — one compile per doc change however
  many components call the hook; undo/redo (now reference-sharing, ISSUE-031) is a cache hit.
- **ISSUE-029 (`useCompiledWorld.ts`, `region/regionData.ts`, `region/AzRow.tsx`,
  `az/DatacenterFloor.tsx`):** shared per-compiled WeakMap indexes `instancesByServerFor`/
  `instancesByAzFor`; `dominantBlueprintColor` memoizes its per-server winner map per compiled;
  AzRow gained `useMemo` throughout (servers, resident set, promoting, per-server rps map).
- **ISSUE-030 (`RegionView.tsx`):** every derived value (azShares, ribbonAlert,
  `computeWorldCost`, managed entries, rail pairs/entries/endpoints) is `useMemo`d with precise
  deps, hoisted above the null early-return; hover-state re-renders no longer recompute the
  world cost.
- **ISSUE-031 (`world.store.ts`):** `pushHistory`/`undo`/`redo` share doc REFERENCES —
  `deepCopy` (JSON round-trip per keystroke, ~100× full-world history memory) is deleted;
  mutations were already immutable-by-contract via `mutate()`.

Boundary notes: `solveFlows`' queue inputs, `buildBatch`'s `starved`, `WorkloadProfile.cpuShares?`,
`ClientPopulation.burstiness?`, `RoutingConfig.healthCheckHealthyThreshold?`, and
`CompiledRouting.regionProportions?` are all additive-optional.
`HostStepResult.serviceRateByInstance` is a REQUIRED new field (engine-internal type; the one
external fixture in metrics.test.ts updated). `BreakerConfig`'s reshape is breaking for direct
constructors of breaker configs — all in-repo callers spread `DEFAULT_BREAKER_CONFIG`.

## Audit minor fixes — ISSUE-033 through ISSUE-079 (`audit-spec.md`, 2026-07-23)

All 47 Minor-tier issues, committed in subsystem batches. Six were verified RESOLVED BY earlier
tiers rather than re-fixed (each with a regression test or documented reasoning): **043**
(cold-start over-admit — queue mode bounds step-1 admits by same-step host capacity), **042**
(shed/degraded/failed conflation — in queue mode a degraded instance under light load serves
everything, so no phantom error signal remains; pinned by a flows test), **047** (failover-map
reconciliation — the ISSUE-004 running-gate makes the edit lock strict, engine state is rebuilt
per run, and `failbackPromotions` already prunes dead placements), **049** (healthOverrides
pruning — overrides only exist mid-run under the frozen doc and are cleared on stop/reset),
**071** (cost model vs compiled gate — ISSUE-024's alongside-every-bump accumulator already
reconciles totals; provisioned cost staying doc-based is the documented design decision), **072**
(blocked-path dedup — `AnalysisTab.test.tsx` already pins the suppressor; ISSUE-063's shared
matcher closes the evaluator-drift half).

**Engine (`src/lib/worldEngine/`):**

- **ISSUE-033 (`breakers.ts`):** a claimed half-open trial whose chain produced no downstream
  row wedged the breaker half-open FOREVER (`transition` only re-fires from `open`). New
  `trialStartedMs` + `trialTimeoutMs` (2s): `transition` expires an unresolved trial — no
  evidence, so it neither reopens nor counts as a probe success; `admitRequest(b, simMs)` gained
  the clock param.
- **ISSUE-034 (`index.ts`):** `stepVps` receives UNCLAMPED `cpuPressure` — the drain term scales
  with over-baseline utilization, so a 5×-hammered burstable now burns credits faster than one
  at exactly-full load (safe: post-019 accrual is constant and the steal walk never reads it).
- **ISSUE-035 (`hostScheduler.ts`):** `coreUtilization` spreads evenly on the EFFECTIVE-vCPU
  basis (`min(1, cpuPressure)` per core) — no more two-pegged-two-idle at 50%, and a
  credit-throttled host reads saturated at saturation.
- **ISSUE-037 (`managedCapacity.ts`, `metrics.ts`, `replay.ts`):** per-class managed base
  latency (`MANAGED_BASE_LATENCY_MS` — cache 0.5 ms … objectStorage 15 ms; unknown types keep
  3 ms) with an M/M/1 `base/(1−ρ)` saturation term (`managedLatencyMs`), published as non-DB
  `p50Ms`/`p99Ms` (×`MANAGED_P99_OVER_P50`) and used for trace hop attribution; instance `p99Ms`
  publishes UN-smoothed (the EMA attenuated a 1 s spike to ~30%) — p50 keeps the EMA.
- **ISSUE-038 (`rng.ts`):** `rng.pick([])` throws loudly instead of reading `arr[-1]` =
  `undefined` (all callers pre-check; the throw keeps the `T` return type honest).
- **ISSUE-039/-040 (`replay.ts`, `index.ts`):** trace sampling is rps-WEIGHTED (`pickWeighted`
  roulette wheel over entries by `offeredRps`, hops by `row.rps`), and `Tracer.sample`'s
  population callback became `populationsOf` — every population feeding the entry's region with
  live rps, drawn ∝ rps from the tracer's own rng (never the sim stream).
- **ISSUE-041 (`metrics.ts`):** interpolated percentiles over a rolling 3-batch latency
  reservoir (`latencyHistory`) — p99 is no longer just max-of-10-samples.
- **ISSUE-044 (`failover.ts`):** the outage set keys `outageKey(scope, id)` — an id shared
  across scopes can't cross-trigger; new `hasOutage(state, scope, id)` is the read seam
  (index.ts's five read sites updated).
- **ISSUE-045 (`index.ts`):** ONE event-id allocator — `emitEvent` re-stamps every event
  `evt-${idSeq++}`, so failover's descriptive hand-built ids no longer break cross-subsystem
  monotonicity (context lives in kind/message/affected).
- **ISSUE-046 (`metrics.ts`):** `managedWindow.steps` increments only on row-carrying steps —
  a runtime-only (idle) step no longer averages a DB's windowed rps toward zero.
- **ISSUE-048 (`simulation.store.ts`, `index.ts`):** double-start guard — `store.start`
  early-returns while running AND engine `start()` cancels a live `rafId` before the state swap
  (two rAF chains advanced one state at double speed).
- **ISSUE-076/-078/-079 (`index.ts`):** `instancesByServer` built once at `start()`;
  `entryBlueprintIds` became a `Set` (membership-tested per flow per ~60 Hz frame);
  `effectiveRoleResolver` memoized on `promotedAt` contents; `managedDbRuntime` skipped outright
  for worlds with no managed DB (`hasManagedDbs`).
- **ISSUE-073/-074/-075/-077 (`flows.ts`):** downstream rows aggregate through a keyed `Map`
  (was `find` over a growing array — quadratic for fan-heavy instances); the BFS cycle guard is
  a parent-pointer chain walk (≤ MAX_DEPTH hops, zero allocation — was a cloned `Set` per
  edge); the path index memoizes per compiled identity (`pathIndexFor` WeakMap);
  `splitDependencyShares` computes single-pass into one shares array (role classification
  deliberately NOT hoisted to `start()` as the audit sketched — `roleOf` carries the promotion
  overlay, so roles change mid-run).

**Stores/views (`src/app/`):**

- **ISSUE-052 (`ScrubberV2.tsx`, `simulation.store.ts`, `TimelineV2.tsx`):** `setScrubIndex`
  accepts the caller's OWN captured frames array so index/batch/label all resolve against one
  snapshot; the scrubber label reads `scrubBatch.simMs`, never `frames[scrubIndex]`.
- **ISSUE-053 (`simulation.store.ts`):** the events presentation window micro-batches — a
  synchronous burst applies in ONE `setState` on the next microtask (generation counter orphans
  buffers across start/resetSession); replaces the per-event ≤500-entry copy.
- **ISSUE-055 (`InspectorV2.tsx`):** the 1 Hz trace poll short-circuits to the previous state
  when trace ids are unchanged.
- **ISSUE-050 (`worldEngine/types.ts`, `ArcsLayer.tsx`):** `MAX_GLOBE_ARCS` lives in types.ts
  (re-exported from index.ts for API stability) — the globe view no longer pulls the engine
  singleton module for one render-cap constant.
- **ISSUE-051 (`RegionPins.tsx`):** the pin's health split into its own two subscriptions — the
  region's AZ-id set from a world-store selector (joined-string primitive; AZ add/remove now
  updates without a sim tick) + a sim-store all-down check over just that region's AZs.
- **ISSUE-054/-056 (`ArcsLayer.tsx`):** arc-set change detection is `arcsEqual` (zero-alloc
  element comparison, same order-sensitive/intensity-blind identity as `arcsSignature`, pinned
  equivalent by test); the `lineDistance` attribute is captured once per rebuild as a
  RUNTIME-checked typed handle (`PoolEntry.distAttr`) the flow loop writes through. The audit's
  optional shader-uniform dash offset was deliberately NOT taken (no automated visual gate).
- **ISSUE-057 (`TimelineV2.tsx`):** `getReplayFrames` memoized on the batch tick; `buildLanes`/
  `narration` memoized on real inputs; `onMarkerClick` reuses the memoized frames.
- **ISSUE-058 (`RegionPins.tsx`, `AzRow.tsx`):** the multiplied-per-row components subscribe to
  DERIVED primitives (pulsing/promoting booleans computed inside the selector) instead of the
  whole events array; content-rendering components (EventsTab/TimelineV2/RegionView) keep the
  array — ISSUE-053's batching already collapsed their per-event storms.

**Cost model (`src/lib/costModelV2.ts`, `world/types.ts`):**

- **ISSUE-059:** additive `ManagedService.provisionedIops?` bills gp3-shaped above-baseline
  IOPS (`DB_IOPS_FREE` 3000 free, $0.005/IOPS-month; billed once per cluster like storage).
- **ISSUE-060:** LB pricing = base hours + an LCU-shaped traffic term by MODE (`l7` $0.008 vs
  `l4` $0.006 per unit-hour, 1 unit ≈ 25 rps) off the region's live inbound rps (split evenly
  across a region's LBs); idle/null-metrics keeps the old base-hours figure.

**Analysis/network (`src/lib/analysis/`, `src/lib/world/`):**

- **ISSUE-061:** additive `RoutingConfig.healthCheckTimeoutMs?` (+`DEFAULT_HEALTH_CHECK_TIMEOUT_MS`
  5 s, authored by `createWorld()`, validated by the serializer); `ttl-outlives-detection`'s
  window is now `interval × threshold + timeout`.
- **ISSUE-062:** `ocean-crossing-population` skips `weighted`/`priority` (deliberate operator
  intent); under distance policies it remains as a regression guard for the ISSUE-009 class of
  scoring bug.
- **ISSUE-063 (`world/network.ts`):** ONE `firewallFirstMatch` — `evaluateFirewall` wraps it and
  the analysis rules import it (their private copy of the matching loop is deleted); the rules
  stay the source-AWARE consumers.
- **ISSUE-064 (`world/network.ts` header):** the firewall model is now explicitly documented as
  ordered first-match/default-deny (iptables/NACL), NOT an SG union-allow; an SG-mode evaluator
  is deliberately deferred until authoring demand exists.
- **ISSUE-065 (`world/types.ts`, `world/network.ts`):** additive container
  `overlayNetworkNames?` — Swarm/CNI overlay networks span SERVERS, so co-networked containers
  on different hosts get a permitted path without host publishing (the hop keeps its real
  network class); plain `networkNames` bridges stay per-host.
- **ISSUE-066:** `ram-oversubscribed` adds live `ramPerConnMb × activeConnections` from the
  latest batch for UNCAPPED instances (a container's memLimit is already its counted worst
  case).
- **ISSUE-067 (`instanceCatalog.ts`):** burstable presets carry `baselineUtilization?`
  (vps-small/t3-medium 0.2, vps-medium 0.3); `burstable-sustained-load` compares against the
  preset's baseline via `server.catalogId` (0.4 stays the custom-specs fallback).
- **ISSUE-068:** `db-port-exposed` sub-rule (b) is placement-gated — an unplaced public-port db
  blueprint is a sketch, not a critical finding.

**Serializer (`src/lib/serializer.ts`):**

- **ISSUE-069:** normalization builds a NEW file object (routing/servers/collections spread onto
  a copy) — the parsed input is never written to, and the vestigial legacy top-level `packets`
  slot is folded into `world.packets` without being retained.
- **ISSUE-070:** the version gate compares `String(data.version)` — a numeric `"version": 3`
  loads; numeric 1/2 land on their dedicated rejection messages.

Boundary notes: every doc-model addition (`provisionedIops?`, `healthCheckTimeoutMs?`,
`overlayNetworkNames?`, `InstancePreset.baselineUtilization?`) is additive-optional;
`Tracer.sample`'s `populationsOf` reshape and `admitRequest`'s `simMs` param are engine-internal;
`setScrubIndex`'s `frames?` param is additive. `MAX_GLOBE_ARCS` moved to `worldEngine/types.ts`
(index.ts re-exports). `firewallFirstMatch`, `hasOutage`/`outageKey`, `arcsEqual`,
`managedBaseLatencyMs`/`managedLatencyMs`/`MANAGED_P99_OVER_P50`, and `DB_IOPS_FREE` are new pure
exports. With this pass the audit's full issue list (Critical + Major + Minor, ISSUE-001 through
ISSUE-079) is closed.

## Cross-zone-off dropped traffic + overload health + honest AZ card (2026-07-23)

A user-reported "500 rps into the region, server handles 150 and never crashes" traced to three
compounding issues around a cross-zone-off L7 LB whose target service was placed in only one of
the region's AZs. Fixed together (branch `fix/crosszone-dropped-traffic`):

- **Silent forfeiture → surfaced (`worldEngine/routingRuntime.ts`, `index.ts`, `metrics.ts`,
  `types.ts`).** `distributeToTargets` with cross-zone OFF split `rps / regionAzSpread.length`
  (ALL region AZs) and skipped any AZ with no target instance — dropping `(N−1)/N` of the ingress
  silently. It now takes an optional `droppedByAz` accumulator crediting every undeliverable
  share (empty target group / all-AZs-down → whole rps spread across the region's AZs; per-AZ
  `targetsHere.length === 0` → that `perAz`; `pickInstance → null`, i.e. placed-but-all-down →
  that `perBp`; cross-zone-true `targets.length === 0` → whole rps). The engine threads a per-step
  `droppedByAz` map through `distributeViaLb`, and `accumulateStep`/`buildBatch` publish it as the
  additive `AzMetrics.droppedRps` (EMA'd per AZ, `droppedWindow`/`droppedSteps` in `MetricsState`)
  + a region roll-up `RegionMetrics.droppedRps`.
- **Display-only region impairment, NO cascade (`metrics.ts` buildBatch).** The region's DISPLAYED
  `errorRate`/`health`/`healthScore` fold in dropped (errorRate = true failing inbound fraction;
  health downgrades from — never above — the failover verdict). This is deliberately kept OUT of
  the failover state machine (`index.ts` step 9) and routing: folding it there cascaded onto
  healthy instances via `healthOfInstance = worst-scope`, wrongly failing/throttling backends
  (caught by the starved-vs-idle + forfeit engine tests). Failover health remains the routing/
  cascade source of truth; only the published batch reflects the drop.
- **Overload health from OFFERED load (`index.ts` step 9, Fix D).** Per-server `cpuPressure` for
  the HEALTH input is now computed inline from the current step's `flows[i].offeredRps ×
  cpuMsPerRequest / effectiveVcpu` (`overloadPressureByServer`), not `hostResults.cpuPressure`
  (admitted-based, capped at capacity ⇒ always ≈ 1.0, so an overwhelmed server never tripped the
  CPU band). `latencyMultiplier`, `admittedScale`, and VPS credit-drain keep the admitted-based
  pressure — only server/AZ/region health inputs use the offered-based one, so a moderately
  overloaded server degrades via pressure before its bounded queue saturates into errors.
- **Honest AZ card / split pills (`region/regionData.ts` `azShares`, `AzRow.tsx`,
  `SplitLines.tsx`, `RegionView.tsx`).** `azShares` now splits region ingress into DELIVERED
  (fraction-of-throughput × `ingress − dropped`) + per-AZ `dropped`, so a fully-forfeited AZ shows
  its dropped share instead of the whole ingress being attributed to the one serving AZ. `AzShare`
  gained `dropped`; the AZ card appends `· N dropped` (danger) and a majority-dropped `SplitLines`
  beam renders red/static (`✕N` pill) instead of a healthy teal flow.

Boundary notes: `AzMetrics.droppedRps?`/`RegionMetrics.droppedRps?` are additive-optional (frozen
contract, logged in `contract-drift.md`); `distributeToTargets`' `droppedByAz`, `accumulateStep`'s
`droppedByAz`, and `distributeViaLb`'s 4th arg are additive-optional; `AzShare.dropped` and
`AzRow`'s `droppedRps` prop are new required fields on app-layer (non-contract) types, all
in-repo callers updated. No `.scalemap`/persistence impact (metrics are ephemeral).

## Cross-zone-off empty-AZ: forfeit → AWS-accurate redistribute (2026-07-24)

Follow-up correcting the *model* the "silent forfeiture → surfaced" work above made visible. The
earlier model treated a cross-zone-OFF AZ with no target for a group as a **connection failure**:
its `perAz = rps / regionAzSpread.length` share was dropped (credited to `droppedByAz[azId]`). In
the "classic three-tier" preset — entry blueprint `lb` placed only in `us-east-1a` — this dropped
half the region ingress at `us-east-1b`, and because `azShares` adds each AZ's `dropped` on top of
its delivered-fraction, the region view read `us-east-1b 73% (…dropped)` vs `us-east-1a 27%`,
which *looked* like round-robin sending 70% to one AZ. It wasn't: the LB split was an even 840/840;
1b simply failed its half. (User-reported confusion, 2026-07-23.)

Real AWS NLB/ALB (cross-zone off) does **not** fail a zone that has no healthy targets — it
**removes that zone's node from DNS** once health checks confirm it, so clients only resolve to
zones that can serve and the traffic redistributes. The fix aligns the engine with that:

- **`worldEngine/routingRuntime.ts` `distributeToTargets` (cross-zone-false branch).** Now builds a
  `serving` list = healthy AZs that hold **≥1 healthy target instance** for the group, splits
  `perAz = rps / serving.length` over *only* those AZs, and drops (`drop(null, rps)`, spread across
  the region) **only when `serving` is empty** (no AZ can serve — empty group or every target down
  region-wide). `targetsHere` now filters on instance health, not mere placement, so an
  all-down blueprint in an otherwise-serving AZ is excluded too. Preserves the genuine cross-zone
  lesson (unequal *target counts* per AZ still skew per-target load); only the **zero-healthy-target
  AZ** changed — redistributed, not forfeited.
- **Behavioral result.** Three-tier preset now shows `us-east-1a`/`us-east-1b` ≈ 50/50 delivered
  with **0 dropped**; `lb-01` (sole entry) absorbs the full ingress (a single-AZ entry SPOF now
  reads as *concentrated load*, capacity-testable, not a phantom LB drop). The `droppedByAz`
  plumbing, `AzShare.dropped`, and the AZ card's `· N dropped`/red-beam rendering from the prior
  section are unchanged — they still fire for the *genuine* all-down/empty-group drops, just no
  longer for a merely-empty AZ.
- **Tests.** `routingRuntime.test.ts` — the "reports the empty-AZ per-AZ share as dropped" case
  became "redistributes the empty-AZ share to the serving AZ, dropping nothing" (`into['i-a0']` =
  full 500, `droppedByAz` empty); the down-AZ, empty-group, and all-instances-down cases are
  unchanged (they still drop). `index.test.ts` "cross-zone-off ingress distribution" — the
  forfeit/surfaced pair became redistribute/no-drop (`web1` ≈ full 500, region stays healthy). No
  contract or `.scalemap` change (pure engine-distribution semantics + metrics, both ephemeral).

---

## Packet Library + Global Blueprints (2026-07-28)

Two authoring gaps with one root cause — reusable definitions had no library surface, and packet
payloads stopped at the front door.

### The registry now has two views (`src/lib/nodeConfig.ts`)

`WorldDoc.packets` stays ONE `PacketRegistry` with ONE monotonic id space; what a template *is*
depends on whether it carries a path:

- `listRoutes(reg)` — http templates **with** a non-empty path → the L7 route catalog (Phase 2
  semantics unchanged: population `requestMix`, LB `listenerRules`, the entry byte/CPU tier).
  Returns the narrowed `RouteTemplate = HttpTemplate & { path: string }`, which is what let
  `HttpTemplate.path` become optional without a single `!` at the ~12 consumer sites.
- `listPackets(reg)` — every template **without** a path, all four protocols → the packet library
  bound to service→service edges.

Sizing fields (`responseSizeKb`, `sizeVariance`) moved from `HttpTemplate` onto
`BasePacketTemplate`; `colorOverride` became live (particle tint). The three dormant kinds
(`db`/`event`/`stream`) gained real authoring. **Deleted:** `WorkloadDemand`/`WorkloadTier`/
`BasePacketTemplate.workload` — zero readers, and the name collided confusingly with the LIVE
`WorkloadProfile` in `world/types.ts` that the engine actually reads. New: `PacketMixEntry`,
`PacketRegistry.defaultPacket`, and packet CRUD (`addPacket`/`updatePacket`/`removePacket`/
`duplicatePacket`, `PacketFields` — note the **distributive** omit, since a plain
`Omit<PacketTemplate,'id'>` collapses the union to its common keys).

### `src/lib/packetResolve.ts` (NEW) — the one resolution point

Pure, node-testable, dependency-free (registry types only). `resolveWireSize(reg, mix, inlineReq,
inlineResp)` is the single place the four-tier fallback lives:

> bound mix (weighted mean) → carrier's inline req/resp KB → `reg.defaultPacket` → 2 KB each way

Tier 4 (`DEFAULT_PACKET_BYTES_EACH_WAY`) is why an existing `.scalemap` simulates byte-identically,
and `sigma === 0` there means **zero rng draws**, so the seeded stream is untouched. Also owns
`routeIngressBytes` (**moved here from `nodeConfig.ts`** — the resolver needs the constant as a
*value*, so keeping it in `nodeConfig` would have been an import cycle) and `pickPacketByIndex`
(rng-free, radical-inverse weighted pick for particles). db semantics live here too: `resultSizeKb`
supplies the response leg, `queryType` derives `writeFraction`, `isWAL` sets `amplification`.

### Model + persistence

`BlueprintDependency` gained `packetMix?` / `reqKb?` / `respKb?` (all optional, so existing files
load and simulate unchanged); `packetTemplateId` is now documented DEPRECATED and a non-null value
is migrated to a 1-entry mix in `deserializeWorld`. `HttpTemplate` gained `packetMix?` (a route's
"advanced" binding). **No version bump** — `serializer.ts`'s additive normalization absorbed it.
`defaultPacket` is deliberately NOT seeded on load: its absence IS the 2 KB convention.

### Store (`world.store.ts`, hub file)

New actions, all through `mutate()` (undo/dirty free): `addPacket`/`updatePacket`/`removePacket`/
`duplicatePacket`, `setDefaultPacket`, `setDependencyPacketMix`, `setDependencyWireSize`,
`setRoutePacketMix`, `duplicateBlueprint`. Two cascades matter: `removePacket` scrubs the id from
every dependency mix **and** every route mix (mirroring `removeRoute`'s `requestMix` scrub), and
`duplicateBlueprint` deep-copies with **fresh dependency ids and no placements**. Copy naming
reuses a generalized `nextCopyName` in `world/populationLabel.ts` (non-nesting: `api (copy)` then
`api (copy 2)`).

### UI

Two new world-scope tabs — the dock order is now
`Topology | Blueprints | Packets | Managed | Connections | Traffic | Routes | Analysis | Events | Cost`
(four wiring points, as ever: `ui.store.ts`'s `PanelTab` then `dock/scope.ts`'s `WORLD_TABS` then
`WorldPanel.tsx`'s `TAB_LABELS` + its header/body switches).

| File | Role |
|---|---|
| `panels/PacketsPanel.tsx` (new) | Default-packet row + the packet list (colour swatch, `#id`, protocol chip, sizes, `N edges / M routes` usage, edit/dup/x) |
| `panels/PacketModal.tsx` (new) | All packet config. `ManagedServiceModal`'s shell verbatim: portal, backdrop close, **capture-phase Escape** (so `WorldShell`'s nav-level Escape doesn't also fire), one-time store snapshot per open (so one save is one undo entry), and its **own** `<fieldset disabled={running}>` because `createPortal` escapes `WorldPanel`'s |
| `lib/world/packetDraft.ts` (new) | Pure draft logic, mirroring `managedDraft.ts` — `defaultPacketDraft`/`draftFromPacket`/`draftToTemplate`/`applyProtocolChange`. Never emits a `path`, which is exactly what keeps a library packet out of the route view |
| `panels/BlueprintsPanel.tsx` (new) | The service-definition catalog: workload summary, `N hosts / M AZs` (or `not placed`), dep count, edit/dup/x. Does **not** resurrect the retired generic-blueprint authoring model — creating a service is still the VPS door (`dock/drawers/AddServiceForm`) |
| `panels/BlueprintModal.tsx` (new) | Identity / workload / ports / state / dbConfig, plus a **read-only** `CONNECTIONS (n)` section with a jump to the graph — relationships are authored there, not in a second weaker editor |
| `panels/PacketMixEditor.tsx` (new) | The one weighted-mix control, shared by `EdgeInspector` and `RouteCard`. Lifted from `TrafficPanel`'s `RequestMixEditor` rather than written a third time; TrafficPanel keeps its own because it binds ROUTES by string id, not packets by numeric id |
| `panels/NumberField.tsx` (new) | Lifted verbatim out of `TrafficPanel.tsx` when `PacketMixEditor` needed the same control. `kit.tsx`'s `DerivedField` is the richer sibling; this is the bare one that fits a dense mix row |
| `connections/ConnectionsView.tsx` | `EdgeInspector` gained an OUTGOING PACKETS section (mix + inline req/resp KB, greyed while a mix is bound). When a **db** mix is bound the manual write-fraction slider is replaced by a read-only derived readout — one source of truth |
| `panels/RoutesPanel.tsx` | `RouteCard` gained an `advanced` disclosure holding the same editor; it opens itself when a mix is already bound, so a binding is never hidden |

### Engine (`worldEngine/index.ts`, `flows.ts` — hub files)

- **Cost.** `buildDepWireBytes(doc)` (a direct sibling of `buildRouteBytesById`) resolves every
  dependency once at `start()` into `EngineState.depBytesById`, handed to the solver as the new
  optional `FlowInput.depBytesById`. `bucketBytes(hopClass, rps, depId?)` sizes the request and
  response legs independently; **WAL amplification applies only to the write share of the request
  leg**. Omitting the field reproduces `rps x 2048 x 2` exactly. A bound db mix's derived write
  fraction also supersedes `dep.writeFraction` at `managedRefusedRps`. **No `costModelV2.ts`
  change** — those bytes already flow through `totals.crossAzBytes`/`crossRegionBytes` into the
  metrics EMAs and on to the cost model.
- **NIC (the one genuine restructure).** The aggregate `internalRps x 512/2048` term on the
  *serving* side is **replaced** (not supplemented — that would double-count the callee) by a
  per-downstream-row booking on **both endpoints**: caller sends the request / receives the
  response, callee the mirror. One `sampleSizeMultiplier` draw per row, shared by both endpoints,
  gated on `sigma > 0` so an unauthored world draws nothing. **This is a deliberate behavior
  change**: caller-side NIC was previously unmodelled, so a world with fat internal hops now sees
  uplink pressure on the *producing* server that it did not before.
- **CPU.** `effectiveCpuMs` gained an internal inbound-KB signal derived from `s.prevFlows`
  (**one-step lag**, the same pattern `admittedScale` and `managedDbRuntime` already use, since CPU
  is computed before `solveFlows`). The entry and internal size signals combine as a **max**, not a
  sum — they are alternative descriptions of "the average request this instance serves".
- **Particles.** `VisualParticle.packetId?: number | null` (additive; logged in
  `.superpowers/sdd/contract-drift.md`) and `colorHint` resolving to the packet's `colorOverride`.
  The pick is index-keyed, never rng — see the drift log for why that is load-bearing for replay.

### Tests

`packetResolve.test.ts` (four-tier fallback, weighted mixes, db write fraction, WAL amplification,
interleaving), `nodeConfig.test.ts` (the two views are disjoint), `serializer.test.ts` (migration +
the untouched-round-trip regression floor), `world.store.test.ts` (CRUD + both cascades +
duplication), `PacketModal`/`BlueprintModal`/`PacketsPanel` (jsdom), `ConnectionsView.test.tsx`
(edge binding + the derived write fraction), `flows.test.ts` (byte scaling + the omitted-field
floor), `index.test.ts` (fat packet driving egress/NIC/CPU, plus determinism and the
unauthored-world floor), `serverParticles.test.ts` (packet identity + purity).

---

## Connection Semantics (2026-07-29)

`ConnectionType` had existed since the Phase 2 route system as **authored, persisted, and
completely inert** schema — every reference was a `<select>`, a type declaration, or draft
plumbing. Picking `streaming` over `short-lived` moved not one number. This phase makes all three
drive live behavior.

Where the packet library gave payload SIZE teeth on every hop (bytes → egress cost, NIC saturation,
per-KB CPU), connection type is its missing half: size says how much data a call moves, connection
type says **how long the connection is held and what establishing it costs**. That is what
separates a CPU-bound failure from a RAM-bound one.

### `src/lib/connectionModel.ts` (NEW) — the one connection-semantics point

Pure, node-testable, dependency-free (registry types only) — deliberately the same shape as
`packetResolve.ts` beside it, reusing its weighted-mean and dangling-entry conventions.

| Export | Role |
|---|---|
| `HANDSHAKE_MS` 15 / `HANDSHAKE_CPU_MS` 2 / `LINGER_MS` 100 / `DEFAULT_HOLD_SEC` 30 | Engine constants — handshake/linger vary far less than hold time, which is why only hold time is authored |
| `ConnectionProfile` | `{ latencyShare, fixedHoldSec, extraHoldSec, handshakeCpuMs }` |
| `KEEP_ALIVE_PROFILE` | The frozen identity — `latencyShare 1`, everything else 0 |
| `connectionClassOf(tpl)` | The **protocol-wins** rule (below) |
| `profileFor(cls, holdSeconds?)` | One pure class → its profile |
| `resolveConnectionProfile(reg, mix, fallback?)` | Weighted blend across a bound mix |
| `activeConnections(rps, latencyMs, p)` | **THE formula** — see the two-call-site invariant below |

One formula, three parameterizations:

| Class | hold | handshake CPU | Failure mode it creates |
|---|---|---|---|
| `keep-alive` | `latencyMs / 1000` | 0 | **Exactly the pre-phase behavior** — the regression floor |
| `short-lived` | `(latencyMs + 15 + 100) / 1000` | 2 ms/req | CPU-bound earlier; churn also inflates RAM |
| `streaming` | `holdSeconds` (authored, default 30 s) | ~0 (amortized) | Connections decouple from latency → RAM-bound at low rps |

**Protocol wins for the non-http kinds.** `ConnectionType` only exists on `HttpTemplate`, but
`protocol` describes the same axis and is the stronger statement: `stream` → `streaming` (a stream
IS a persistent connection), `db` → `keep-alive` (real clients pool), `event` → `keep-alive`
(broker connections are long-lived and shared), `http` → its authored `connectionType`.

**`latencyShare: number`, not `latencyCoupled: boolean`** — a boolean cannot survive blending: a
50/50 keep-alive + streaming mix is *half* latency-coupled and a boolean would have to round it to
one class. Carrying the coupled SHARE makes the struct closed under the weighted mean, so every
field blends linearly and each pure class is a corner of that space.

### ⚠ THE TWO-CALL-SITE INVARIANT (the load-bearing constraint of this phase)

Little's law was **duplicated** in the engine before this phase:

| Site | Feeds |
|---|---|
| `worldEngine/index.ts` — `InstanceLoad.activeConnections` | `hostScheduler`'s RAM growth + **OOM victim selection** |
| `worldEngine/metrics.ts` — `InstanceMetrics.activeConnections` | The published metric → every view + `capacity.ts`'s `ram-oversubscribed` |

If only one had been made connection-aware, the RAM the scheduler *enforces* would silently diverge
from the RAM the user is *shown* — by ~1000x on a streaming world. **Both now call
`connectionModel`'s `activeConnections()`.** Any future change to connection math goes in that one
function; `index.test.ts`'s `DIVERGENCE GUARD` test exists solely to catch a re-duplication.

### Schema (no version bump, no serializer migration)

`HttpTemplate.holdSeconds?` and `StreamTemplate.holdSeconds?` (+ `RouteFields.holdSeconds`), both
optional ⇒ an existing `.scalemap` v3 loads and simulates byte-identically; `serializer.ts` already
round-trips the registry wholesale. `draftToTemplate` emits `holdSeconds` **only** for
streaming-http and stream — persisting it on a keep-alive route would recreate exactly the
authored-but-inert schema this phase set out to eliminate.

### Engine (`worldEngine/index.ts`, `metrics.ts` — hub files)

- **Two start-time maps**, direct siblings of the byte maps: `buildRouteConnProfiles(doc)` →
  `EngineState.routeConnById` (a bound mix wins, else the route's own `connectionType`/
  `holdSeconds`) and `buildDepConnProfiles(doc)` → `depConnById` (an unbound edge → keep-alive,
  since a service→service hop has always been modelled as pooled).
- **Two demand-weighted folds**, extending the ones the packet work already built rather than
  adding new passes: `EntryByteAccum` gained `connLatW`/`connFixedW`/`connExtraW`/`connHsW`
  (accumulated in `distributeViaLb`), and the `s.prevFlows` fold producing
  `internalPacketKbByInstance` gained the same four keyed by `row.toInstanceId` — same **one-step
  lag**, same rationale as the CPU signal it sits inside.
- **Blended by rps share** into one `connProfileByInstance`, so an instance serving both clients
  and internal callers reads a true weighted profile instead of letting one tier arbitrarily win.
  Weights count only tiers that actually contributed, so a missing tier dilutes nothing.
- **Handshake CPU** extends the existing blend to
  `cpuMsPerRequest + cpuMsPerKb × sizeKb + handshakeCpuMs`. Because `effectiveCpuMs` already
  collapses to the ONE value read by host-scheduler cores, the latency fallback, and the solver's
  p50 seed, the adder inherits all three — a short-lived route both costs more CPU and takes longer,
  coherently. `effectiveCpuMsByInstance` widened to cover instances with a profile but no size
  signal; a no-op for keep-alive because `flows.ts:375`'s fallback is the identical expression.
- **`buildBatch` gained an optional trailing `connProfiles` param** defaulting to the keep-alive
  identity — the same additive-by-omission discipline `starved`/`entryBytesByInstance`/`depBytesById`
  already use, so every existing direct-`buildBatch` test stays green by omission.

### Deliberately NOT changed

`hostScheduler.ts` needs no edit — it consumes `activeConnections` and already does the right thing
(`:128` RAM growth, `:138` OOM victim selection). Nor does `analysis/rules/capacity.ts`, which
already reads `lastBatch.instances[].activeConnections` and even labels the live per-connection
portion: **streaming RAM blow-ups surface in Analysis with zero new rule code.** No connection
ceiling / refusal path — RAM is the constraint (locked decision); `maxConnections` on
`WorkloadProfile`, mirroring `managedDbRuntimeFor`'s `connectionRefusedRps`, is the natural
follow-up if a sharper failure axis is wanted.

### UI

| File | Change |
|---|---|
| `panels/PacketModal.tsx` | `hold sec` input in the HTTP section (streaming only) and in the STREAM section (always); `CONNECTION_HINT` explainers naming the **failure mode** each class creates, replacing the "no simulation behavior yet" line |
| `panels/RoutesPanel.tsx` | `hold s` input on `RouteCard`, shown only when the route is streaming |
| `panels/PacketsPanel.tsx` | A `conn` chip (`short-lived` / `streaming · 30s`) shown only when the resolved class differs from keep-alive — chipping the default on every row would be noise. Reads the RESOLVED class, so a stream packet chips correctly despite carrying no `connectionType` |
| `lib/world/packetDraft.ts` | `holdSeconds?: string` on `PacketDraft` (blank-means-fallback, same idiom as the size fields) |

### Tests

`connectionModel.test.ts` (23: the keep-alive identity asserted with `toBe`, the three profiles,
protocol-wins, weighted blends, dangling/zero-weight fallthrough); `index.test.ts`'s
`connection semantics` block (short-lived costs >2x CPU at identical rps; streaming shows >100x
connections with CPU unchanged and `connections === rps × holdSec`; the 30 s default; streaming
OOMs where keep-alive does not; the **divergence guard**; seeded determinism with streaming bound);
`capacity.test.ts` (a streaming service trips `ram-oversubscribed` at an rps its keep-alive twin
handles — asserted on the **peak-connection** batch, because a service that oversubscribed is
OOM-killed within the first steps, which is itself the two paths agreeing).

### Behavior-change caveat

Routes have always *defaulted* to `keep-alive` (`addRoute`), so existing worlds are safe. But a
world where someone already picked `short-lived` or `streaming` — inert until now — **will change
behavior on load**. That is the intent of the feature, but it is a real behavior change to saved
documents.

---

### Z. AI chat assistant — read-only multi-turn overlay (`src/lib/aiChat/`, `src/app/world/ai/`, ai-chat-assistant plan, 2026-07-30)

A 13-task addition sitting entirely on top of the compiled world + engine's existing read surface
— no new engine hooks, no new store fields on `world.store`/`simulation.store` beyond a brand-new
sibling `chat.store.ts`, and no mutation path of any kind (this is an advisor, not an editor).

**`src/lib/llmClient.ts` (Task 1) — the shared transport seam.** `chatComplete(settings, messages,
options?, chat?)` wraps the Rust-side `llm_chat` Tauri command (`tauri.ts`'s `llmChat`, §O) behind
one typed `ChatMessage[]`/`ChatOptions` surface, parsing the OpenAI-compatible envelope and
throwing on a non-JSON body, an `error` field, a missing/empty `choices`, or a non-string
completion. `src/lib/llmReview.ts`'s one-shot architecture review was rewired to call this same
function instead of hand-rolling its own request — the two AI surfaces (review, chat) now share
exactly one HTTP-shaped seam, so a transport fix (retry, timeout, envelope-parsing) lands once.

**`src/lib/world/dependents.ts` (Task 2) — the reverse-dependency index.** `dependencyIndexFor(doc,
compiled)` builds (and `WeakMap`-caches, keyed by the `CompiledWorld` reference so a recompile
invalidates it for free) four maps from `doc.blueprints[*].dependencies` (design-time) and
`compiled.paths` filtered to `verdict === 'permitted'` only (runtime-resolved) — blueprint↔blueprint
and instance↔instance, both directions. `blastRadius(rootId, doc, compiled, opts?)` BFS-walks
`dependentInstances` outward from whatever `rootId` resolves to (an instance id directly, or every
instance hosted by a server/AZ/region id) up to `maxDepth` (default 8), returning `direct`/
`transitive`/`depthOf`. This is a new, general-purpose primitive — not chat-specific — consumed by
`eventCausality.ts` below to answer "what did this event actually affect" without hand-walking
`compiled.paths` again.

**`src/lib/aiChat/eventCausality.ts` (Task 4).** `decodeAffected(kind, affected)` is the one place
that knows each `EngineEventKind`'s positional `affected` array layout (e.g. `oom_kill`'s
`[instanceId, serverId?]` vs `primary_failback`'s "promoted id is last, first-failed id is first if
present") and turns it into a uniform `{ primaryId, secondaryId }`. `buildCausalEpisodes(frames, doc,
compiled)` scans `ReplayFrame[]` for seed events (`critical` severity or one of five seed kinds —
`breaker_open`/`failover_started`/`health_check_failed`/`replica_promoted`/`connection_refused`),
collapses repeats of the same `kind|primaryId|secondaryId` within a 30s window, and for each episode
computes a before/after error-rate snapshot, a `blastRadius`-derived `consequences` list (dependents
whose errorRate spiked inside a 15s window), any `unexplainedSpikes` (spiked instances the blast
radius does NOT explain — the model is told this gap exists rather than silently omitting it), and
`followOnEvents` (other events in the window naming a dependent). Returns the 8 most recent
episodes. Pure — no store/React import, `node`-env testable.

**`src/lib/aiChat/context.ts` (Task 5) — the digest/attachment builder.** The one place the compiled
world + live state become text an LLM sees. `buildChatDigest(input: ChatContextInput)` is
always-on, small, and rollup-only (world/routing summary, per-blueprint dependency summary, a
liveState top-8-by-utilization/top-8-by-errorRate truncation — never a full instance/server map,
per the security canary tests in `context.test.ts` — a findings-by-rule index, an event-kind
histogram, and a fixed `LIMITATIONS` list telling the model what this app does NOT model, e.g. no
queue-depth signal, no connection-pool ceiling, so it can't hallucinate features that don't exist).
`buildContextBlock(attachments, input)` renders the user's OPT-IN attachments at full detail —
`events` (causal episodes), `replay` (last 60 frames' world-level rollup), `findings` (the raw
finding list), `topology` (the full `WorldDoc`, opt-in only since it can be large), or a single
`entity` by id. **Structural key-security guarantee, not just convention:** neither function's
signature accepts an `LlmSettings` parameter at all — there is no code path by which the API key
could reach the context payload, independent of any reviewer discipline.

**`src/lib/aiChat/prompt.ts` (Task 6) — `ASSISTANT_SYSTEM_PROMPT`,** the fixed system message
describing the assistant's read-only role and citation convention (backtick-wrapped entity ids).
**`src/lib/aiChat/index.ts` — `requestAssistantTurn`/`HISTORY_TURN_CAP` (12 turns, 24 messages),**
the per-turn orchestrator: system prompt → one system message carrying `digest` + opt-in
`attachmentBlock` → capped history → the user's question, at `temperature: 0.2`.

**`src/lib/aiChat/formatResponse.ts` (Task 7) — a hand-rolled markdown-subset parser,** no new
dependency added. `formatResponse(raw, resolveEntity)` splits fenced code blocks (` ``` `) from
prose, then within prose splits paragraphs/headings (`##`/`###`)/bullet lists, and within a
paragraph's inline text distinguishes `**bold**`, `` `code` ``, and `` `code` `` tokens that
`resolveEntity` recognizes as a live entity id (rendered as a clickable citation instead of a code
span) — see `citations.ts` next. Returns a typed `Block[]`/`Span[]` tree for the UI to render, never
raw HTML — there is no `dangerouslySetInnerHTML` anywhere in `src/app/world/ai/` (verified by the
Task 13 verification grep).

**`src/lib/aiChat/citations.ts` (Task 9) — `buildCitationIndex(doc, compiled)`,** a simple
`WeakMap`-cached `Set`-backed lookup of every known entity id (regions/AZs/servers/blueprints/
managed services/populations/placements/compiled instances). Deliberately NOT a regex scanner over
the model's raw text — `formatResponse.ts` above already isolates the backtick-delimited tokens;
this module only answers "is this token a real id" for each one.

**`src/lib/world/scopeFilters.ts` (Task 3) — moved out of `src/app/world/dock/scopeData.ts`.**
`scopeEntityIds`/`scopedEvents`/`scopedFindings` (Polish 4 T1, §S) are mechanical, behavior-
identical moves — `scopeData.ts` now just re-exports them, so every existing call site
(`WorldPanel.tsx`'s dock tabs) is unaffected. The move was originally planned so `lib/aiChat/
context.ts` could reuse the same per-scope filtering without `lib/` importing from `app/` (a
boundary this repo otherwise holds firm) — **that reuse never actually happened.** `context.ts`'s
final digest/attachment design (see below) only offers whole-world toggles (`events`/`replay`/
`findings`/`topology`) plus a single `entity`-by-id attachment, not a scoped ("just this region/AZ")
view, so there was nothing in `context.ts` for `scopeEntityIds`/`scopedEvents`/`scopedFindings` to
do — `context.ts` imports only `dependencyIndexFor` and `buildCausalEpisodes`. The three functions
remain exactly as useful where they landed (a legitimate `lib/`-level home, still the right call
independent of the aiChat tie-in) and are still consumed solely by `scopeData.ts`/`WorldPanel.tsx`,
their original call site. One wrinkle survives from the original move: `scopedEvents`'s
region-scope branch used to call `app/world/region/regionData.ts`'s `regionEvents` directly (it
additionally folds in population-routed-client ids that the generic entity-closure walk doesn't
model) — that's a value import from `app/`, not legal in the new location. Fixed by turning it into
an **injected parameter**: `scopedEvents` now takes an optional `regionEventsFn` matching
`regionEvents`'s exact signature; every in-repo caller (`scopeData.ts`'s re-export path) passes the
real `regionEvents` and gets byte-identical behavior, while a caller with no injected fn (there are
none yet) falls back to the generic `scopeEntityIds`-based filter, which is a strict behavioral
subset (misses population-routed events) rather than a crash. The only remaining `app/`-rooted
import in the file is a type-only `import type { DockScope }` — erased at compile time, judged
acceptable rather than worth a further `DockScope` relocation.

**`src/app/world/entityNav.ts` (Task 8) — extracted from `AnalysisTab.tsx`.** `navigateToEntity`/
`entityLabel`/the `NavApi` interface used to live in `AnalysisTab.tsx`, with `AiReviewSection.tsx`
importing `navigateToEntity` back out of it while `AnalysisTab.tsx` imported the `AiReviewSection`
component — a genuine ESM import cycle (harmless in practice given React's lazy module evaluation,
but real, and now avoidable). Both helpers (plus the newly-exported `entityLabel`, previously
private) moved to this new file; `AnalysisTab.tsx` re-exports `navigateToEntity`/`entityLabel` only
(not `NavApi`, which has no external consumer) so no other call site needed to change its import
path. `entityNav.ts` is now also the chat assistant's citation-click handler's dependency — clicking
an `EntityChip` in a rendered response calls the same `navigateToEntity` the Analysis tab's
affected-entity chips already used.

**`src/app/store/chat.store.ts` (Task 10) — `useChatStore`, Zustand, no middleware.** Holds the
transcript (`turns: ChatTurn[]`), the composer draft, the selected attachment set, and a
generation-counter pair — `requestGen`/`inFlightTurnId` — mirroring `simulation.store.ts`'s
`eventGen` idiom (§K: bumped on `stop()`/`start()`/`resetSession()` to orphan a stale event-buffer
flush). `beginTurn()` captures the current `requestGen` and hands it back to the caller; `resolveTurn`/
`failTurn` no-op if the gen they're called with no longer matches the store's current `requestGen`;
`abandonInFlight()` (called on overlay close or when the user fires a new turn while one is still
pending) bumps `requestGen`, silently orphaning any in-flight resolve/reject. The store itself stays
fully synchronous — no store in this app has async actions — so the actual `await`ed LLM round trip
lives in `src/app/world/ai/sendChatTurn.ts` instead, which reads `useChatStore.getState()` directly
(store-outside-async-fn, the same shape `SimControls.tsx`'s `start(doc, compiled)` call uses at the
simulation-store seam, §1J).

**`src/app/world/ai/` — the overlay UI (Task 11), wired into `WorldShell.tsx` (Task 12).**
`AssistantView.tsx`/`ChatComposer.tsx`/`ChatTranscript.tsx`/`AttachmentBar.tsx`/
`ResponseBlocks.tsx`/`EntityChip.tsx` originally followed `src/app/world/connections/ConnectionsView.tsx`'s
overlay recipe verbatim (portal + full-stage backdrop + capture-phase `Escape`), but a later 3-task
UI revamp (2026-07-30) turned it into a **floating, draggable, resizable, non-modal window** instead:
the backdrop is gone (clicks reach the globe/region/AZ/server views behind it while the assistant
stays open), the header is a hand-rolled pointer-event drag surface, and the bottom-right corner is
a resize handle — no new dependency for either. Position/size persist for the session in
`chat.store.ts`'s new `windowRect: WindowRect | null` field (in-memory only, dies on app restart);
`AssistantView.tsx`'s `clampRect()` keeps the rect on-screen on every render (not just mid-drag),
recovering a stored rect that's gone out-of-bounds after the app window itself was resized. Because
the window is now non-modal, its capture-phase `Escape` handler only closes it (and stops
propagation) when `document.activeElement` is actually inside the assistant surface — otherwise the
event passes through untouched to `WorldShell.tsx`'s own bubble-phase `Escape` handler (`nav.up()`,
disarming `placeMode`), which would previously never have fired while the assistant was open.
`WorldShell.tsx` mounts `<AssistantView/>` unconditionally beside `<ConnectionsView/>`, gated by a
local `chatOpen` boolean toggled from a header button placed next to the existing ⚙ Settings button.
**Deliberate divergence from every other portal surface in the app: `AssistantView.tsx` does NOT
wrap its body in `<fieldset disabled={running}>`.** Every other dock/overlay surface disables its
controls while the simulation is running (the editing-lock convention traced back to §1A's legacy
`canvas.store` gate, formalized as one `WorldPanel.tsx` choke point in §1J Task 13) — but the
assistant has nothing to protect: it never mutates `world`/`simulation` state, so there is no risk
of a stale/racing edit. More than that, being usable WHILE the simulation runs is the point —
mid-run diagnosis ("why did `web-2` just OOM") is the assistant's primary use case, exactly
mirroring `WorldPanel.tsx`'s pre-existing Events-tab exemption (`disabled={running && tab !==
'events'}`, §1J). LLM settings are loaded fresh via `loadLlmSettings()` (`src/lib/tauri.ts`) on every
send rather than cached in the store or read once at mount, so a mid-session endpoint/key change in
the Settings modal takes effect on the assistant's very next turn without requiring a reload.

**Net new dependency count: zero.** `formatResponse.ts`'s markdown-subset parser and
`citations.ts`'s id lookup are both hand-rolled specifically to avoid pulling in a markdown/HTML
sanitization library for a surface that never touches `innerHTML`.

---

## Multi-Protocol Connection Audit — Wave 1: divergence and type bugs (`audit-spec.md`, 2026-07-31)

Four small, independent fixes sharing one root cause: **a derived quantity computed twice — once
for enforcement, once for display — which then drift, so the user is shown a number the simulator
is not using.** The repo already defended this failure mode exactly once (the `DIVERGENCE GUARD`
test in `worldEngine/index.test.ts`, pinning the two `activeConnections()` call sites). Wave 1
closes three more instances of it and adds a guard to each. **A fix that corrects the number
without adding the guard does not close the issue** — that is the wave's operating rule.

No file in this wave touches `worldEngine/types.ts`'s frozen render contract. Every new parameter
is optional and defaults to the pre-existing behaviour, so an existing `.scalemap` loads and
simulates byte-identically and no pre-existing numeric assertion in the suite changed value.

### ISSUE-001 — DB write-fraction (`flows.ts`, `managedDbRuntime.ts`, `worldEngine/index.ts`)

A bound db packet mix DERIVES `writeFraction` from its query types, and `ConnectionsView.tsx`'s
`EdgeInspector` hides the hand-authored slider once a mix is bound (`:369-370`) — so the raw
`BlueprintDependency.writeFraction` stays at its default while the user is shown the derived value.
Two consumers still read the raw field:

- `flows.ts:557`'s `splitDependencyShares` — which admitted rps goes to a SQL primary (writes) vs
  its replicas (reads). A 100%-write mix routed entirely to the replicas, so **the single-writer
  ceiling the primary/replica split exists to model silently never bound.**
- `managedDbRuntime.ts:169`'s `aggregateManagedDbLoad` — splits `totalRps` into
  `offeredWrite`/`offeredRead` before measuring each against `writeCeiling`/`readCeiling`. A
  100%-write mix measured against `readCeiling` (5x larger on `sql.small`), so a DB that should
  have been visibly refusing read as comfortably under capacity.

Both now read the already-resolved value from `buildDepWireBytes` (`index.ts:184-193`), where the
fallback chain (bound mix → dependency field → 0) already lived. **No third derivation was
introduced**; `managedDbRuntime.ts` stays free of a `packetResolve` import and takes the resolved
map as an optional, structurally-typed parameter. Note `flows.ts:601`'s managed-service branch
already used the correct chain — the file was internally inconsistent 44 lines apart.

⚠ `WireSize.writeFraction === undefined` means **"no db packet in the mix"**, NOT "0% writes" — the
edge's own field must survive. Both consumers use the three-step `?? ... ?? 0` chain, not `?? 0`.

### ISSUE-011 / ISSUE-012 — published CPU and RAM (`metrics.ts`)

Adjacent lines in the same `InstanceMetrics` literal, both read-side only; no enforcement formula
changed.

- **`cpuCoresUsed`** was `rps × workload.cpuMsPerRequest` (the RAW authored value) while the host
  scheduler budgets cores off `effectiveCpuMs` = `cpuMsPerRequest + cpuMsPerKb × kb +
  handshakeCpuMs` (`index.ts:696-701`, fed to `InstanceLoad.cpuMsPerRequest` at `:736`). On a
  `short-lived` route that omits a flat 2 ms/req handshake term — a measured **2.37x gap** — and
  the understated figure sat beside a correctly-sourced `coreUtilization` on the same server card.
  `buildBatch` now takes the same `effectiveCpuMsByInstance` map the scheduler was given.
- **`ramMb`** was published unclamped while `hostScheduler.ts:127-133` clamps the identical
  quantity to the container's `memLimitMb` before OOM accounting. A 512 MB-limited container
  displayed 900 MB — an impossible reading, on the exact panel a user opens right after an
  `oom_kill` event — and it let the per-server sum of `ramByInstance` exceed the clamped
  `ramUsedMb` beside it. `buildBatch` now reads `memLimitMb` **the same way `index.ts:746` does**,
  so the two cannot disagree about the limit for one instance.

⚠ ISSUE-012's engine-level guard is an exact **bound**, not an exact equality: an over-limit
container is OOM-killed and restarts on a 5 s timer, so the two sides are sampled at different
points of that cycle. The exact-equality assertion lives in `metrics.test.ts`, where `buildBatch`
is called directly and the phase is controlled.

### ISSUE-018 — `sizeKb` optionality and discriminated-union construction (`nodeConfig.ts`)

`BasePacketTemplate.sizeKb` was declared `number` but is genuinely `undefined` at runtime (a
blanked `RoutesPanel` "req" input, or a route serialized before the field existed, with no
per-route normalization on load). The type is now `sizeKb?: number`, matching reality. **Auditing
every reader found all of them already guarded** (`packetResolve.ts:46,98`; `index.ts:129,136`;
`PacketsPanel`/`RoutesPanel`/`packetDraft`'s `asString`) — so this is a pure soundness change with
no latent NaN path left open, and `tsc` surfaced zero new errors. Resolve `sizeKb` through
`packetResolve`'s fallback chain rather than reading it raw.

`addPacket`/`updatePacket` built their result with a blanket `{ ...fields, id } as PacketTemplate`,
which compiles even when the fields carry another protocol's keys — precisely the cross-
contamination discriminated-union narrowing exists to catch. Construction now goes through one
`withPacketId()` helper that branches per protocol with a `never` default, so **a fifth
`PacketProtocol` becomes a compile error there instead of a silent fallthrough**. `updateRoute`'s
`as HttpTemplate` is gone too (the `protocol !== 'http'` guard above it already narrows). The
`(t as HttpTemplate).path` reads in `listPackets`/`getPacket` remain: they are read-only narrowing
inside a `protocol !== 'http' ||` short-circuit, not construction, and carry no soundness risk.

### Tests

Every bug-catching assertion in this wave was verified to FAIL with its fix reverted (via
`git stash push <file>`), and every regression-floor assertion passes both before and after.

- `flows.test.ts` — derived value governs primary/replica routing; absent `writeFraction` still
  falls back to the edge's field; **DIVERGENCE GUARD** pinning the fraction `EdgeInspector`
  displays to the fraction routing splits on, for a non-degenerate 70/30 mix, through the one
  shared `resolveWireSize` both call.
- `managedDbRuntime.test.ts` — first coverage of `aggregateManagedDbLoad`; asserts the resolved
  split is what decides whether the single-writer ceiling binds.
- `metrics.test.ts` — effective-value CPU, clamped RAM, `ramByInstance` strata bound, plus two
  regression floors (omitted map, process placement).
- `index.test.ts` — CPU and RAM **DIVERGENCE GUARD**s beside the existing connection-RAM one.
- `packetResolve.test.ts` / `nodeConfig.test.ts` — absent `sizeKb` never yields NaN (including
  blended with a sized packet); all four protocols round-trip through the exhaustive constructor
  with their kind-specific fields intact.

## Multi-Protocol Connection Audit — Wave 2: composed end-to-end latency (`audit-spec.md`, 2026-07-31)

**Lands alone, per the spec** — this is the wave that deliberately changes engine-computed
numbers, not a divergence/type fix. `InstanceFlow.serviceLatencyMs` (`flows.ts`) was SELF time
only — an instance's own CPU/queue/NIC cost, sampled once per instance in BFS creation order. Two
things about this were wrong: (1) the published `p50Ms`/`p99Ms`/`activeConnections` never grew
when a downstream dependency slowed down, so the canonical "slow dependency → connection pileup →
OOM" cascade was structurally unreachable; (2) `replay.ts`'s tracer already composed hop-by-hop
latency correctly for its own sampled path (`totalMs`), so the Trace panel and the metrics p50 chip
for the same instance could show two different "latency" numbers with no explanation.

### ISSUE-003 — `InstanceFlow.totalLatencyMs` (`flows.ts`, `metrics.ts`, `index.ts`)

`solveFlows` now runs a memoized post-BFS composition pass (after every flow's `downstream` array
is settled — flows are created in first-touch, not topological, order, so an instance's own
downstream rows aren't final until the whole BFS finishes) filling a new `InstanceFlow.
totalLatencyMs`: `serviceLatencyMs + rps-weighted mean over non-blocked downstream rows of
(hop time + that row's totalLatencyMs)`. A managed target's contribution is
`managedDbRuntime[id]?.p50Ms ?? managedBaseLatencyMs(nodeType)` — the same fallback chain
`replay.ts` already uses. `totalLatencyMs` is optional on `InstanceFlow` (not part of the frozen
`worldEngine/types.ts` contract) so hand-built flow fixtures in `metrics.test.ts`/`replay.test.ts`
that predate this field compile unchanged; every consumer falls back to `serviceLatencyMs`.

⚠ **Deliberate departure from the spec's literal instruction to reuse `hopLatencyMs`.** That
function draws from the engine's seeded rng (`jitter`). The composition pass touches every
downstream row every step (not once per trace sample like the tracer) — drawing rng there would
shift the stream for the REST of the step (particle picks, VPS steal, breaker jitter, every
subsequent `sampleLatencyMs` call), invalidating hundreds of unrelated exact-value assertions for a
number that only needs to be a reasonable composition estimate, not a sampled realization.
`networkRuntime.ts` now exports `baseHopLatencyMs` — the identical per-hop-class value
`hopLatencyMs` already computed internally before applying `jitter()`, factored out as a pure,
rng-free function. `hopLatencyMs` itself is unchanged (same jitter, same rng draws, same only
caller — the tracer). This is why the full suite needed **zero** golden-value re-baselining despite
Global Constraint 4 anticipating some: no existing test exercises a multi-hop chain while also
asserting the composed-latency-sensitive fields (`p50Ms`/`p99Ms`/`activeConnections`/`ramMb`) for a
non-leaf instance, and the rng stream is untouched everywhere else.

A genuine topology cycle (A depends on B depends on A) is NOT fully prevented by the BFS's
`chainHas` guard — that guard only stops re-*queueing*; the row back into the cycle is still
recorded in `downstream`. The composition pass's `computing` set breaks an in-progress cycle by
treating the back-edge as the callee's self time only, rather than recursing forever.

**The two-call-site invariant, extended.** Both Little's-law sites now read composed latency
consistently: `index.ts`'s host-scheduler `InstanceLoad` (`const latency = pf?.totalLatencyMs ??
pf?.serviceLatencyMs ?? effectiveCpuMs(...)`, one-step-lagged like `admittedScale`) and
`metrics.ts`'s published `activeConnections` (fed by `p50Ms`, itself now sourced from a percentile
reservoir of `totalLatencyMs` samples instead of `serviceLatencyMs`). A caller blocked on a slow
dependency now holds more connections — and more RAM — on BOTH sides, or the RAM the scheduler
enforces/OOM-kills on would silently diverge from what `metrics.ts` publishes.

**New field, additive-optional on the frozen contract:** `InstanceMetrics.serviceP50Ms` (`types.ts`,
logged in `.superpowers/sdd/contract-drift.md`) preserves the PRE-ISSUE-003 self-only semantics —
`p50Ms`/`p99Ms` deliberately mean something different (composed) after this change, so anything
that wants "how long did this instance's own work take" reads `serviceP50Ms` instead. `metrics.ts`'s
`InstanceWindow` gained a parallel `selfLatencySum` accumulator, EMA'd the same way `rps`/
`errorRate` are (a plain windowed mean — `serviceP50Ms` is a regression-floor readout, not a new
tail statistic, so it does not need the multi-second percentile reservoir `p50Ms`/`p99Ms` get).

`replay.ts`'s tracer is untouched — its hop-by-hop `totalMs` is a genuinely different statistic
(one rng-sampled realization of a single path) from the composition pass's rps-weighted mean over
every path, and the spec explicitly keeps them independent as a cross-check rather than unifying
them.

### Tests

- `flows.test.ts` — a leaf instance's `totalLatencyMs` exactly equals `serviceLatencyMs`; a 3-hop
  chain composes recursively (hand-verified against `baseHopLatencyMs`'s exact constants, `toBe`/
  `toBeCloseTo`); multi-dependency fan-out weights by each row's rps share; a genuine A→B→A cycle
  terminates with a finite value; a blocked row contributes nothing.
- `metrics.test.ts` — `p50Ms` sources from `totalLatencyMs`, `serviceP50Ms` from
  `serviceLatencyMs`, from one fixture where the two deliberately disagree; a fixture that omits
  `totalLatencyMs` entirely still publishes the exact pre-existing `p50Ms` value (regression floor).
- `index.test.ts` — an engine-level `web → api → db` fixture (each service on its OWN server, so
  db's cost can't spill onto api's CPU scheduling) where only `db`'s `cpuMsPerRequest` differs
  between two runs: api's composed `p50Ms` grows, its `serviceP50Ms` does not, and its
  `activeConnections` more than doubles — proving Little's law actually reacts to a slow
  dependency. A **DIVERGENCE GUARD** in the same style as Wave 1's, confirming scheduler-enforced
  and published RAM stay within the same bounded ratio once a downstream dependency is slow.
- Every bug-catching assertion above was verified to FAIL with the composition pass reverted (via
  `git stash`, not amending); the full pre-existing suite (1631 tests) passed unchanged both before
  and after — this wave's blast radius is exactly the fields the spec intended to change, nothing
  else.

## Multi-Protocol Connection Audit — Wave 3, part 1: render hot path (`audit-spec.md`, 2026-07-31)

ISSUE-013/014/015, landed together since all three touch the same two functions
(`buildAzParticles`/`buildServerParticles`, `index.ts`). Every fix here is loop-invariant work
hoisted to `start()` or an early exit — none change WHICH particles are emitted or their order, so
every fix is byte-identical-output by construction, verified by the pre-existing "respects
MAX_SERVER_PARTICLES cap" / "is deterministic for a fixed seed" tests in `serverParticles.test.ts`,
which needed no changes to keep passing.

**Prerequisite: `bench/renderPerf.bench.test.ts` (new).** `bench/enginePerf.bench.test.ts` only
measures `runStep` (the ~10 Hz sim loop) — nothing gated the 60 Hz render loop before this file.
Same isolation/median-of-100 idiom as the engine bench (own file, excluded from `npx vitest run`,
run via `npm run bench`); budget is this file's own (1ms/frame at the 400-particle AZ cap, 2x
CI-fail-only line), since there's no render-loop analog to `DEGRADE_THRESHOLD_MS`. Measured on this
machine at a FAN=30/3-packet-mix fixture: **~0.074ms/frame before → ~0.053ms/frame after** — real,
but modest at this scale (the audit's ~24,000 allocs/sec figure is aggregate GC pressure over
sustained runtime, not fully visible in a 100-frame median). This number is what ISSUE-017 gates.

### ISSUE-013 — precomputed packet pick tables (`packetResolve.ts`, `index.ts`)

`pickPacketByIndex` used to `.filter()` + `.reduce()` a dependency's bound packet mix on EVERY
call — once per particle per frame, up to `MAX_AZ_PARTICLES=400`/`MAX_SERVER_PARTICLES=50` times.
`mix` comes from the frozen `doc` (topology is edit-locked while running), so every call after the
first for a given dependency was re-deriving an answer that never changes for the run's duration.

Split into `buildPickTable(mix)` (the old filter+reduce, run ONCE) returning a new `PickTable`
type, and a rewritten `pickPacketByIndex(table, k)` that just walks the precomputed `entries`/
`total`. `index.ts` builds `depPickTableById: Record<string, PickTable | null>` once at `start()`
(alongside the existing `depBytesById`/`depConnById` maps) and the particle builders look it up by
`dependencyId` instead of passing `dep?.packetMix` straight through. Bit-identical output verified
against a hand-inlined replica of the pre-refactor `pickPacketByIndex` body
(`packetResolve.test.ts`'s new `buildPickTable` describe block).

### ISSUE-014 — `depById` start()-time index (`index.ts`, `managedDbRuntime.ts`)

The fifth recurrence of the unindexed-lookup class already fixed as ISSUE-032/073/075/076: both
particle builders did `bp?.dependencies.find(d => d.id === row.dependencyId)` once per downstream
row per FRAME (60 Hz), and `managedDbRuntime.ts`'s `aggregateManagedDbLoad` did the same once per
row per STEP (10 Hz). `dep.id → BlueprintDependency` never changes once `doc` is frozen, so this
was loop-invariant work identical in shape to the maps already built at `start()`.

New `buildDepIndexes(doc)` builds `depById`/`depPickTableById` together in one pass (same
enumeration `buildDepWireBytes`/`buildDepConnProfiles` already use — flat `Record` keyed by
`dep.id` alone, since those two maps already assume dependency ids are globally unique and that
assumption is already load-bearing in production). `aggregateManagedDbLoad`/`managedDbRuntime`
gained an optional `depById` parameter, checked BETWEEN `depBytesById` (which already resolves the
write fraction for virtually every dependency in practice) and the old linear-scan fallback — so
existing callers/tests that omit it are unaffected, and the scan only ever runs when both maps
are deliberately omitted.

### ISSUE-015 — particle cap early-exit (`index.ts`)

`buildAzParticles`/`buildServerParticles` only checked the cap in the INNERMOST loop
(`particles.length < MAX_AZ_PARTICLES`); once the cap was hit early in iteration order, every
subsequent flow and downstream row still ran its lookups/lookups before discovering there was
nothing left to add. Added the same `if (particles.length >= CAP) break` at the top of both the
outer `for (const f of ...)` loop and the per-flow `for (const row of f.downstream)` loop, in both
functions — stops iterating the moment no more particles will be emitted, without touching which
particles are chosen (iteration order is unchanged, so the first CAP particles in the existing
order are exactly what's kept — this is why the fix needed no new "which particles" test).

### Tests

- `packetResolve.test.ts` — `buildPickTable` produces bit-identical picks to a hand-inlined replica
  of the pre-refactor body, across a range of indices including negative ones; the four pre-existing
  `pickPacketByIndex` describe blocks updated to build a table first (same assertions, same values).
- `managedDbRuntime.test.ts` — `depById` resolves the write fraction when `depBytesById` has no
  entry; `depBytesById` still wins when both disagree; omitting both falls back to the linear scan
  (regression floor).
- `serverParticles.test.ts`'s pre-existing cap/determinism tests continue to pass unchanged — the
  strongest possible evidence these three fixes altered no observable behavior.
- `bench/renderPerf.bench.test.ts` (new) — the Wave 3 prerequisite; passes at both the 1ms budget
  and the measured before/after numbers above.

## Multi-Protocol Connection Audit — Wave 3, part 2 (`audit-spec.md`, 2026-07-31)

### ISSUE-007 — protocol-mismatch compile finding (`world/types.ts`, `world/compileWorld.ts`)

`BlueprintDependency.protocol` drives ONLY the particle render tint (`index.ts`'s particle
builders); every simulated consequence — wire bytes, connection hold, WAL amplification — comes
from the bound packet mix's own resolved protocol via `packetResolve`/`connectionModel`. Nothing
reconciled the two, so an author could set `dep.protocol = 'event'` on a dependency whose mix is
entirely `http` packets and the board would render violet "event" particles for what the engine
actually costs/holds as a keep-alive HTTP call.

Added a new `CompileFinding` kind, `'protocol-mismatch'` (additive to the union), and a
`protocolMismatchFindings(doc)` pass in `compileWorld.ts` — computed ONCE per unique dependency
(iterating `doc.blueprints` directly, not per compiled path/instance, which would multiply the
same finding by however many instances the source blueprint has). `majorityMixProtocol` resolves
the mix's majority-weight protocol (same defensive dangling-packet/non-positive-weight filter every
other mix reader applies) and compares it against `dep.protocol`; a mismatch is surfaced as a
`warning`-severity finding, never auto-corrected — an explicit author choice on `dep.protocol`
is left alone, matching how every other compile finding works. `AnalysisTab.tsx`/`WorldPanel.tsx`
render findings generically off `{severity, message, affected}` with no per-kind switch, so the new
kind needed no UI changes.

### ISSUE-016 — `PacketLayer.tsx` path-length cache + theme-aware protocol color

Two independent defects in the same file. (1) `pathCache` memoized the `SVGPathElement` per
`fromId→toId` pair but NOT its `getTotalLength()` — an SVG geometry computation, not a cheap
property read — so every particle on every frame re-computed the same length for an already-cached,
geometrically-immutable path. Now caches `{ path, len }` together, computing `len` once at
cache-population time; the existing D10e try/catch (native WebView SVG throwing) still wraps both
the creation+length computation and the per-particle `getPointAtLength`, so a throw still falls
back to the straight-line lerp exactly as before. (2) `PROTOCOL_COLOR` hardcoded four dark-tuned
hexes directly in TSX — a `<canvas>` 2D context needs a resolved literal (`var(--color-*)` can't be
read from `ctx.fillStyle`), so the fix is a new `protocolColor(protocol, themeMode)` sourced from
`theme.ts`'s `CATEGORY_COLORS` (the codebase's existing idiom for this exact situation, matching
`azFloorStyles.ts`/`ServerFaceplate.tsx`), mapped `http→compute, db→storage, event→messaging,
stream→network` and branched dark(`.accent`)/light(`.foreground.light`) off `ui.store`'s
`themeMode`, added to the draw effect's dependency array so a live theme toggle repaints correctly.

### Tests

- `compileWorld.test.ts` — a mismatched dependency (event-authored, http-bound mix) produces
  exactly one `protocol-mismatch` finding; a matching dependency and a mix-less dependency produce
  none (no false positives).
- `PacketLayer.test.tsx` — `getTotalLength` (stubbed onto the created element's prototype, since
  jsdom doesn't expose `SVGPathElement` globally in this setup) is called exactly once across two
  frames of the same `fromId→toId` pair; `fillStyle` matches `CATEGORY_COLORS`' exact accent/
  foreground values per protocol in dark/light mode; an authored `colorHint` still wins over the
  protocol color in either theme.
- Every new assertion verified to FAIL with its fix reverted (`git stash`), full suite (1645→1652
  tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 3, part 3: ISSUE-017 decision (`audit-spec.md`, 2026-07-31)

**Particle-object pooling: closed as not-needed.** ISSUE-017's mandate was explicit: re-benchmark
after 013+015 land, and only implement pooling — which changes an ownership guarantee (the
renderer would receive a borrowed, reused array instead of one it can freely retain) — if the
budget isn't already met. `bench/renderPerf.bench.test.ts` measured ~0.053ms/frame after 013+014+
015 at the 400-particle AZ cap, against a 1ms budget (2ms CI-fail line) — ~19x headroom. Pooling's
added complexity (auditing every `attachRenderer` consumer for retained references, the correctness
risk of a consumer treating a borrowed array as owned) isn't justified by a number this far under
budget. Not implemented.

**The one piece of ISSUE-017 that WAS implemented unconditionally** (per its own execution steps —
independent of the pooling decision): `buildPayload` allocated a fresh throwaway `[]` for every
non-matching scope's `particles`/`arcs` field every frame (a globe renderer's empty `particles`, an
az/server renderer's empty `arcs`). Replaced with two shared, `Object.freeze`d module-level
constants (`EMPTY_PARTICLES`/`EMPTY_ARCS`) — safe with no ownership caveat (an empty array carries
no state to alias-corrupt), and frozen so a consumer mutating it in place fails loudly instead of
corrupting every other renderer sharing the same instance. Verified with a two-scope test (`arcs`
is the identical instance across an az- and a server-scope renderer) and a frozen-object test.

### Tests

- `index.test.ts` — two renderer scopes' empty `arcs`/`particles` fields are `toBe` the same
  instance; `Object.isFrozen` on the shared instance is `true`. Both verified to FAIL with the fix
  reverted.

## Multi-Protocol Connection Audit — Wave 4: capacity truth (`audit-spec.md`, 2026-07-31)

### ISSUE-009 — NIC service-rate ceiling sized off resolved wire bytes (`index.ts`)

The per-server NIC ceiling (`serviceRateByInstance`, step 4/5) divided the NIC's line-rate bytes/
sec by the flat module constant `Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)` (2048) REGARDLESS
of what an instance's traffic was actually sized as — even though NIC byte BOOKING (step 7) was
already fully packet-aware. A 5 MB edge on a 1 Gbps NIC modeled a ~61,035 rps ceiling instead of the
true ~24 rps — the NIC never became the bottleneck for large-payload edges (bulk export, big DB
result sets, `stream` framing), exactly where NIC modeling matters most.

Fixed by splitting the ceiling into two steps — split the server's bandwidth (bytes/sec) across
resident instances by cpu-share weight FIRST (the physically shared resource), THEN convert each
instance's own bandwidth share into an rps ceiling using THAT instance's own resolved wire size —
reusing signals already built this same step for the packet-driven CPU blend: `entryNicBytesByInstance`
(entry-tier req/resp bytes) and a WIDENED internal-tier fold (`internalPacketKbByInstance`'s sibling,
new `internalRespBytesByInstance` — one extra accumulator field on the SAME loop that already reads
`wire.respBytes`, not a new resolution point). The worst byte direction still governs (mirrors
`evaluateNic`); an instance with no resolvable traffic yet this step falls back to the exact
pre-fix flat constant — which is also what an UNAUTHORED (default 2 KB) edge algebraically reduces
to, so every existing world with no authored packet sizes keeps byte-identical NIC-ceiling behavior.

⚠ Unlike Waves 1/3, this is NOT purely additive: any EXISTING world with an authored large payload
now throttles far more aggressively (correctly). One pre-existing test (`'a fat internal packet
saturates the CALLEE NIC and sheds throughput'`) asserted a >100x nicInMbps gap between a 2 KB and
a 5 MB scenario — reachable only because the OLD ceiling let the ENTIRE 100 rps of 5 MB calls
through uncapped, booking ~4 Gbps on a 100 Mbps NIC (physically impossible — the exact bug this
issue fixes). Hand-verified the corrected numbers (measured ~9x gap, 1.69→15.33 Mbps) and
re-baselined that one assertion with a comment explaining why, following the ISSUE-003 re-baseline
discipline (Global Constraint 4's sanctioned exception): every changed literal individually
verified as physically correct, not merely different.

### Tests

- `index.test.ts` — a 5 MB edge on a 100 Mbps NIC now admits well under 10 rps (was ~100,
  effectively uncapped, pre-fix); an unauthored default-2KB edge at a tight NIC keeps the exact
  pre-fix shed-throughput behavior (regression floor, matching the pre-existing NIC-backpressure
  describe block's own assertion shape). Verified to FAIL with the fix reverted (measured 81 rps
  admitted pre-fix vs the <10 rps bound).

### ISSUE-010 — silently-dropped fan-out, surfaced (`flows.ts`, `index.ts`, `types.ts`, `analysis/rules/structural.ts`)

Three BFS truncation points in `solveFlows` left no trace anywhere: an instance past `MAX_DEPTH`
(8 hops) reads as a healthy, zero-traffic leaf for whatever it would have called next; a dangling
dependency (target blueprint resolves to zero compiled paths) silently `continue`s with no row,
no event, no finding; a genuine topology cycle's cut edge looks like a normal downstream row with
no marker that re-entry was blocked instead of followed. For a tool whose whole purpose is
surfacing architecture problems, "no findings past this depth" reading as "verified fine" is worse
than not modeling it at all.

`solveFlows`'s return type gained `depthExceededInstanceIds: Set<InstanceId>` and `cycleCutEdges:
{ fromId, toId }[]` (additive to `SolveFlowsResult`, NOT the frozen `worldEngine/types.ts`
contract — this is `flows.ts`'s own internal return shape) — collected inline at the two existing
`continue` sites rather than adding a new pass, so `solveFlows` stays a pure function of its input.
`index.ts` turns these into two new `EngineEventKind`s (`chain_depth_exceeded`/`chain_cycle_cut`,
additive to the frozen contract, logged in `.superpowers/sdd/contract-drift.md`), deduped to ONCE
PER RUN per instance/edge via two new `Set`s in `EngineState` (`depthExceededReported`/
`cycleCutReported`) — a state TRANSITION, not a steady-state condition, mirroring how other
steady-state events (`breaker_open`) avoid re-firing every step while the condition holds.

The dangling-dependency case is different in kind — it's a STATIC/structural property of the
compiled world (does this dependency's target blueprint have any instance at all), not a per-step
runtime event, so it doesn't need a simulation run to detect. New analysis rule
`dangling-dependency-no-targets` (`analysis/rules/structural.ts`, registered in `ANALYSIS_RULES`
per the standing "one registry" rule) fires once per unique dependency whose target blueprint has
zero compiled instances — checked once per blueprint's dependency list, not per compiled path or
per source instance of the same blueprint (which would multiply the same finding by however many
instances the source has).

`eventCausality.ts`'s `decodeAffected` needed the two new `EngineEventKind` cases added to stay
exhaustive (a `tsc` compile error, not a runtime bug) — both map `affected[0]`/`affected[1]` to
`primaryId`/`secondaryId` the same way the other instance-pair event kinds do.

### Tests

- `flows.test.ts` — a 10-service chain (one hop past `MAX_DEPTH`) reports the depth-8 instance in
  `depthExceededInstanceIds` and confirms the 10th service's flow is genuinely never reached (not
  just "no event" — the actual silent drop); a shallower chain reports nothing. A genuine A→B→A
  cycle's `cycleCutEdges` contains exactly the cut edge (deterministic, `toEqual` exact); an acyclic
  world reports none.
- `structural.test.ts` — `dangling-dependency-no-targets` fires for a dependency whose target has
  zero placements; stays silent once the target has a real instance, for a managed-service target
  (compileWorld already gates a missing service), and for a source blueprint with no instances of
  its own.
- `index.test.ts` — an engine-level 9-hop-deep world emits `chain_depth_exceeded` exactly ONCE
  across 10 steps (not one per step); an engine-level A↔B cycle world emits `chain_cycle_cut`
  exactly once. Every new assertion verified to FAIL with the fix reverted; full suite
  (1656→1666 tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 5: async event delivery, the broker (`audit-spec.md`, 2026-07-31)

⚠ **Deliberate scope decision, per audit-spec.md's Global Constraint 4 exception (the same one
Wave 2's ISSUE-003 used):** unlike every other issue in this audit, this ONE changes DEFAULT
behavior for every EXISTING `event` packet, not just newly-authored ones — `event` is now
simulated as asynchronous by default. `event` is removed from CLAUDE.md's parked list in the same
change (the "Packet system" Key Architecture Decision paragraph).

### ISSUE-002 — `src/lib/worldEngine/broker.ts` (new), `flows.ts`, `index.ts`, `metrics.ts`, `analysis/rules/capacity.ts`

Before this issue, `event` was a synchronous blocking RPC wearing a different label:
`connectionClassOf` collapsed it to keep-alive, `packetResolve` turned it into plain
request/response bytes, and — critically — the flow solver pushed the consumer onto the SAME
BFS step as the producer, so a struggling CONSUMER's downstream errors opened the PRODUCER's
breaker (`index.ts`'s step-8 breaker-record loop reads `targetErrorFraction(row.toInstanceId)` for
any non-blocked row with a target instance — event rows included). That is the exact opposite of
what a message broker exists to do.

**New `broker.ts`**, modelled directly on `managedDbRuntime.ts`'s three-function shape
(`aggregateTopicLoad` → `topicRuntimeFor` → `topicRuntime`), pure/no engine imports. A "topic" in
this schema is identified by its dependency id (there is no separate Topic entity). Aggregate,
like managedDbRuntime: backlog/lag/drop/DLQ are properties of TOTAL arrival vs TOTAL consumer
capacity, computed once from the PREVIOUS step's flows (one-step lag, same shape as
`admittedScale`/`managedDbRuntime`), with `flows.ts` applying the result to each producer's own
share. `consumerCapacityRps` REUSES the flow solver's own `serviceRateByInstance` (already resolved
for the queue model) rather than re-deriving a second notion of consumer capacity. Worked in
message COUNTS internally (arrival/capacity × stepSec, backlog persisted as a count) — clearer
arithmetic than converting rates back and forth.

**`flows.ts`'s dependency loop**: an event-protocol dependency (resolved via the new shared
`resolveMixProtocol`, below) NEVER pushes its target onto this step's BFS queue — the producer's
share is instead split by the topic's resolved `dropFraction`/`dlqFraction` into an accepted row
(bytes still book — publishing succeeded), a `dropped` row, and a `dlq` row (both new
`DownstreamFlow.failure` values, additive to the existing `'throttled' | 'timeout'` union).
**Separately**, the topic's resolved `drainRps` seeds the CONSUMER instance(s) as an independent
BFS root (own depth 0, no parent) — without this the consumer would never appear in metrics or fan
out its own dependencies for event-only traffic, even though the topic is actively draining; this
was caught by an engine-level test asserting the consumer's published `rps > 0`, which failed
before this seeding was added.

**The breaker fix (the actual bug).** `index.ts`'s step-8 loop now looks up the row's dependency
(`s.depById`, ISSUE-014's index) and forces `fraction = 0` for a non-blocked event-protocol row,
never consulting `targetErrorFraction` — only the topic's OWN drop/DLQ overflow (already recorded
as separate `blocked: true` rows) can open an event dependency's breaker. This was caught by an
engine-level test that failed on the FIRST attempt at this issue: a fixture with a genuinely
struggling consumer (its own dependency 100% firewall-blocked) opened the producer's breaker even
after the flows.ts decoupling landed, because the generic breaker loop doesn't know about
protocols — the decoupling alone was not sufficient; the breaker-recording site itself had to be
taught to ignore the consumer's health for this protocol.

**`resolveMixProtocol`** (`packetResolve.ts`, new export): extracted from ISSUE-007's
`compileWorld.ts`-local `majorityMixProtocol` into a shared resolver — "what protocol does this
dependency actually speak" is now the ONE place both the compile-time protocol-mismatch finding
and the engine's broker-gating logic read from, so they can never disagree.

**Metrics**: `MetricsBatch.topics?: Record<string, TopicMetrics>` (additive, contract-drift
logged) — `state.lastTopicRuntime` follows the exact `lastHost`/`lastVps` side-channel pattern
(published as-is, not window-averaged, since it's already a one-step-lagged aggregate). New
analysis rule `consumer-lag-behind-producer` (`capacity.ts`) fires when a topic's `lagSec` exceeds
a 5 s threshold.

**Authoring**: `EventTemplate` gains `retentionCapCount?`/`maxRedeliveries?` (additive, absent ⇒
unbounded retention / one redelivery before DLQ); `packetDraft.ts` and `PacketModal.tsx` gained the
matching form fields, and the modal's stale "asynchronous delivery semantics are a later phase"
copy is gone (still true for `stream`, which stays parked — see Wave 6).

**Simplifications, documented in `broker.ts`'s own comments**: redelivery is modelled as "every
failure gets one more attempt fed back into the backlog" rather than true per-message
attempt-counting (this is an aggregate rps model, not a per-message one) — `maxRedeliveries === 0`
sends failures straight to the DLQ; any positive value keeps retrying indefinitely under sustained
consumer errors, the reasonable aggregate analogue of "the DLQ only catches messages that are
ACTUALLY exhausted."

### Tests

- `broker.test.ts` (new) — `aggregateTopicLoad` sums arrival/capacity/error-fraction correctly and
  ignores non-event dependencies entirely; `topicRuntime` drains fully under spare capacity, grows
  and PERSISTS a backlog across calls when arrival exceeds capacity, sheds overflow past
  `retentionCapCount` as `dropRps`, and routes failures to `dlqRps` (maxRedeliveries=0) or
  `redeliverRps` (the default).
- `index.test.ts` — the core thesis test: a producer -> event -> consumer world where the consumer
  is genuinely struggling (its own dependency 100% firewall-blocked) still shows real consumer
  throughput AND never opens the producer's breaker (filtered specifically on the producer's own
  `pathKey`, since the consumer's OWN breaker for its dead dependency legitimately opens — that's
  real, unrelated failure, not the bug); `MetricsBatch.topics` publishes non-zero arrival/lag.
- Every bug-catching assertion verified to FAIL with the fix reverted (`git stash`); full suite
  (1666→1677 tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 6, part 1: stream semantics (`audit-spec.md`, 2026-07-31)

### ISSUE-004 — separating stream connection rate, frame rate, and compute rate

One authored `rps` was asked to answer three physically distinct questions for a stream: how many
NEW connections open per second (what `activeConnections()` needs), how many FRAMES a connection
pushes per second (what NIC/CPU-per-KB accounting needs), and steady-state compute. There was no
way to author both a correct connection count AND a correct frame/byte rate at once.

**Landed**: `ConnectionProfile` gains `frameMultiplier` (additive field — 1 for keep-alive/short-
lived and for an unauthored stream, the exact pre-issue 1:1 rps:frame reading). `StreamTemplate`
gains `framesPerSecond?: number`; `profileFor('streaming', holdSeconds, framesPerSecond)` resolves
it, `resolveConnectionProfile` blends it across a mix the same weighted way as every other field.
New `resolvedFrameRps(rps, profile) = rps × frameMultiplier` is what a caller should feed into NIC/
byte/`cpuMsPerKb` accounting instead of raw `rps`; `activeConnections()` itself is UNTOUCHED — it
keeps meaning "connection rate", never "frame rate". `index.ts`'s engine-level `ProfileAccum`/
`addProfile`/`meanProfile` helper (blends a service's entry + internal connection-profile tiers
into one) widened to carry `frameMultiplier` through the same fold, so it's available per-instance
wherever the engine already resolves a connection profile.

Also landed: `packetResolve.ts`'s `resolveWireSize` gained a stream-specific compression ratio
(`none`/`gzip`/`snappy` → `1`/`0.3`/`0.5`) applied to a stream packet's resolved req/resp bytes —
an uncompressed and a `snappy`-compressed stream used to book identical NIC bytes and cost.

**⚠ Scoped down, documented explicitly rather than silently skipped**: the spec's step 4 calls for
threading `resolvedFrameRps` into every engine call site that currently feeds raw `rps` into NIC/
`cpuMsPerKb` accounting for a stream-protocol hop. That was NOT done in this pass — the entry/
internal KB-fold accumulators (`entryPacketKbByInstance`/`internalPacketKbByInstance`) currently
carry exactly ONE rps signal each, and retrofitting a second (frame) rps through them touches the
same hot per-step byte/CPU accounting paths ISSUE-009 just corrected, with a real risk of
introducing a subtle regression under limited time to re-verify the full NIC/cost suite. The
PRIMITIVES (`frameMultiplier`, `resolvedFrameRps`, the blend, the compression ratio) are fully
implemented, tested, and ready — an authored `framesPerSecond` on a stream packet has NO effect on
simulated bytes/CPU yet, only on what `resolvedFrameRps` WOULD compute if a caller used it. Wiring
this into the entry/internal folds is the natural, well-scoped follow-up.

### Tests

- `connectionModel.test.ts` — `frameMultiplier` defaults to 1 for every non-streaming class and for
  an unauthored stream; an authored `framesPerSecond` becomes the multiplier, decoupled from
  `activeConnections()`'s own math; non-finite/non-positive values are ignored;
  `resolvedFrameRps` is the identity for keep-alive and multiplies correctly for a resolved
  streaming profile; `resolveConnectionProfile` blends `frameMultiplier` across a mix the same
  weighted way as every other field. Two pre-existing `toEqual` literals updated to include the new
  field (value unchanged: 1 in both cases).
- `packetResolve.test.ts` — gzip/snappy measurably shrink a stream packet's resolved bytes (gzip <
  snappy < none); a non-stream protocol is completely unaffected.
- Every new assertion verified to FAIL with the fix reverted (`git stash`); full suite
  (1677→1685 tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 6, part 2: client-side timeouts (`audit-spec.md`, 2026-07-31)

### ISSUE-006 — `latency.ts`, `nodeConfig.ts`, `flows.ts`

The only authored timeout anywhere in the engine was `ManagedService.queryTimeoutMs`, scoped to
managed DBs. A regular service→service `http` dependency had NO client-side timeout concept at
all — no matter how slow a downstream instance got, the caller kept counting the call as admitted
unless it hit an unrelated capacity wall. The canonical distributed-systems failure ("dependency
got slow, caller's requests timed out, breaker tripped from timeouts, not 5xx or capacity") was
structurally unreachable.

`latency.ts` factors `sampleLatencyMs`'s mu/sigma derivation into a shared `muSigma` helper and
adds `timeoutErrorFraction(p50, p99, timeoutMs)` — the ANALYTIC `P(latency > timeout)` under that
same log-normal (via a small Abramowitz-Stegun erf/normalCdf approximation), not a Monte Carlo
estimate: no rng draw, so it can't perturb the seeded stream, and it shares its distribution
parameters with what's actually sampled by construction.

`HttpTemplate` gains `clientTimeoutMs?: number` (mirrors `ManagedService.queryTimeoutMs`'s "absent
⇒ no timeout" convention). `flows.ts`'s dependency loop resolves it from the bound mix's first http
packet that authors one (new `resolveClientTimeoutMs`, mirroring how other per-edge scalars resolve
from "the packet that speaks for this axis") and, for a non-blocked instance-target row, computes
`timeoutErrorFraction` off the TARGET's own self-time (`getFlow(toId).serviceLatencyMs` — forces
its first-touch sample if not already taken, exactly as if this were the first row to reach it).
The timed-out share is added to the caller's `errorRps` and recorded as a `timeout`-tagged blocked
row (reusing the SAME `DownstreamFlow.failure` value the managed-DB query-timeout path already
uses — both mean "too slow"); the reduced admitted share is what continues downstream, so bytes/
CPU aren't double-booked for calls that never completed.

**No breaker-side code changes were needed** — `breakers.ts`'s `recordWeighted`/`errorThreshold`
machinery already reads whatever `errorRps`/total ratio a dependency reports, so a timeout-sourced
error and a capacity-sourced error are indistinguishable to it by design. Once `flows.ts` feeds a
latency-caused error into the SAME `flow.errorRps` a capacity error already used, the breaker is
latency-sensitive for free.

**Scoped down, documented explicitly**: the spec's companion ask — wiring `statusCode`'s
documented 4xx (error-but-completes)/5xx (drop) semantics, currently hardcoded to `200` with zero
readers — was NOT done in this pass. It's a materially smaller, independent defect (decorative
schema, not a structural fidelity gap) than the timeout mechanism, and this issue was already at a
reasonable stopping point. Natural follow-up.

### Tests

- `latency.test.ts` — `timeoutErrorFraction` is ~0 well above p99, >0.5 below p50, exactly 0.5 at
  p50 (the log-normal's median), monotonically rises as the timeout tightens, is exactly 0 for a
  non-positive/absent timeout, handles the degenerate zero-spread case without NaN, stays in [0,1]
  across a wide input range, and consumes zero rng draws (verified by confirming `sampleLatencyMs`
  produces the SAME value whether or not `timeoutErrorFraction` was called first on a
  fresh-same-seed rng).
- `flows.test.ts` — a tight timeout against a slow target both errors the caller's `flow.errorRps`
  AND reduces what continues downstream; a loose timeout errors ~nothing; an absent
  `clientTimeoutMs` reproduces the exact pre-issue output (regression floor); a timed-out row is
  tagged `blocked: true, failure: 'timeout'`.
- `index.test.ts` — the test that was structurally impossible before this issue: an engine-level
  world where a dependency's `clientTimeoutMs` sits below its target's simulated latency, with the
  target's own capacity nowhere near saturated (low rps, ample vCPU), opens the CALLER's breaker
  with ZERO capacity overflow anywhere in the chain; a loose timeout on the same shape of world
  never opens it.
- Every new assertion verified to FAIL with the fix reverted (`git stash`); full suite
  (1685→1699 tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 6, part 3: self-hosted connection pool (`audit-spec.md`, 2026-07-31)

⚠ **Deliberate scope decision** — this issue was explicitly parked in CLAUDE.md's Known Issues /
Roadmap ("a `WorkloadProfile.maxConnections` mirroring `managedDbRuntimeFor`'s
`connectionRefusedRps` is the natural follow-up"). Removed from the parked list in the same change.

### ISSUE-005 — `hostScheduler.ts`'s `poolCheckoutFor`, `world/types.ts`, `metrics.ts`

A cloud-managed DB gets the full failure model (`managedDbRuntime.ts`): rps ceiling, queueing
latency, AND a connection ceiling with `connectionRefusedRps`. A self-hosted DB blueprint (or any
workload) got none of that — its `WorkloadProfile` carried `ramPerConnMb` (so RAM at least grows
with connections) but no `maxConnections`, so the ONLY way it could ever fail under connection
pressure was exhausting host RAM and getting OOM-killed — a materially LATER, less common failure
than real pool exhaustion (a real Postgres install with the common `max_connections: 100` default
would already be queueing/refusing checkouts at a fraction of the connection count needed to
exhaust RAM).

`WorkloadProfile` gains `maxConnections?`/`checkoutTimeoutMs?` (additive; absent ⇒ unbounded, the
exact pre-issue behavior). New `hostScheduler.ts`'s `poolCheckoutFor(activeConnections,
maxConnections, checkoutTimeoutMs)` models the checkout step as a bounded queue ahead of compute:
below saturation (ρ = activeConnections/maxConnections ≤ 1) checkout is immediate; past it, wait
grows with the SAME `base / (1 - saturation)` queueing shape `managedDbRuntimeFor` already uses for
DB service latency (clamped so a badly-oversubscribed pool stays finite), and past
`checkoutTimeoutMs` a growing fraction of waiters time out (`checkoutTimeoutErrorFraction`, same
linear-overshoot shape as `managedDbRuntimeFor`'s own timeout fraction). Returns `null` when no
`maxConnections` is authored — "not capacity-modelled", the same convention
`managedDbRuntimeFor` uses for an unclassed DB.

**The two-call-site invariant, extended.** A connection that times out waiting for a checkout
never actually occupied one — the caller gave up — so it must not inflate RAM as if it held one,
on EITHER of the two Little's-law sites: `hostScheduler.ts`'s own RAM/OOM accounting now sheds
`activeConnections × (1 - checkoutTimeoutErrorFraction)` before computing `ramBaseMb +
ramPerConnMb × effectiveConnections`, and `metrics.ts`'s published `ramMb` reads the IDENTICAL
`checkoutByInstance` result (via the same `HostStepResult.checkoutByInstance`, additive-optional)
to shed the same fraction — never re-derived. This divergence was caught DURING implementation,
not anticipated up front: the first version only wired the shedding into `hostScheduler.ts`, and
the new DIVERGENCE GUARD test failed immediately (published RAM ~60x the scheduler-enforced value)
until `metrics.ts` was taught to read the same `checkoutTimeoutErrorFraction`.

New `InstanceMetrics.checkoutWaitMs?: number` (additive, contract-drift logged) surfaces the wait
itself, populated only for an instance with an authored `maxConnections`.

### Tests

- `hostScheduler.test.ts` — `poolCheckoutFor` returns `null` with no `maxConnections`; no wait while
  unsaturated; wait grows past saturation with zero error fraction when no timeout is authored; a
  tight timeout against a saturated pool produces a positive error fraction; wait stays finite even
  at extreme saturation (clamped overshoot). `stepHost` is bit-identical for an instance with no
  `maxConnections`; a saturated pool with a tight timeout measurably sheds RAM below the naive
  (unshed) figure.
- `index.test.ts` — an unauthored pool publishes no `checkoutWaitMs` at all (regression floor); a
  **DIVERGENCE GUARD** confirming scheduler-enforced and published RAM stay within the same bounded
  ratio once a pool saturates (the guard that caught the real bug above, mid-implementation).
- Every new assertion verified to FAIL with the fix reverted (`git stash`); full suite
  (1699→1708 tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 7: demand backpressure (`audit-spec.md`, 2026-07-31)

### ISSUE-008 — measuring Mechanism A, then building Mechanism B (`index.ts`, `flows.ts`)

Every prior wave fixed a way the engine UNDER-reacted to overload (latency composition, NIC
ceilings, connection pools, ...). ISSUE-008 asks the opposite question: once an instance genuinely
IS overloaded, does demand ever get throttled at the edge, or does the world just keep hammering a
dying instance forever? `demand.ts`'s `populationDemandRps` takes `(pop, simMs, rng)` and nothing
else — no system-state input at all, confirmed by a dedicated unit test — so the ENTRY point of
demand is structurally incapable of reacting to what's happening downstream. The only existing
feedback loop is `hostScheduler.ts`'s per-container `memLimitMb` OOM-kill.

**Mechanism A, measured first, per the spec's own instruction ("must be measured before Mechanism
B is attempted, since B may prove unnecessary")**: a fixture chains a fast, RAM-thin `web` entry
instance to a deliberately slow `backend` (2000ms p50, vs. web's own 1ms) — audit ISSUE-003's
latency composition inflates web's own composed latency, which inflates web's held connections
(Little's law), which inflates web's own RAM at `ramPerConnMb=5` until `memLimitMb` kills it. A
30-second run shows `oomCount > 1` (a genuine REPEATING cycle, not a one-time death) AND the
instance recovering to `healthy` between kills. Verdict: Mechanism A DOES eventually bound
throughput, but via a **repeating OOM-kill oscillation**, never a graceful reduction — exactly the
disqualifying shape the spec names. Mechanism B is therefore built.

**Mechanism B** — explicit, hysteresis-gated admission control at the region's front door, applied
to a population's offered demand immediately before `distributeViaLb` (`index.ts`, right before
`// ── 1. demand ──`, so the shed fraction affects THIS step's own distribution, not a lagged one).
Per region, aggregated ONLY over ENTRY (public-port) instances — an internal tier's own healthy
error rate would otherwise dilute the signal from a struggling entry tier; this mechanism answers
"is the region's front door overloaded", not "is anything anywhere unhappy". Engage at a sustained
(20 consecutive 100ms steps = 2s) region-aggregate error rate ≥ 50%; recover at a sustained ≤ 10%
— both hysteresis-gated so a single noisy step can't flap the shed fraction on and off, mirroring
the breaker's own volume-floor/streak conventions.

Three bugs surfaced during implementation, none anticipated up front — all caught by tests, not
inspection:

1. **The 100%-shed feedback loop.** Setting `shedFraction = 1` at engage time cuts a region's
   admitted demand to exactly zero, which makes the very error signal recovery depends on go dark
   (`offered <= 0` reads as `errorRate = 0`, i.e. "healthy"), so the "still shedding, track current
   severity" branch immediately zeroed the shed fraction right back out — a one-step
   self-defeating loop, never a real 20-step recovery. Fixed by capping shed at
   `MAX_SHED_FRACTION = 0.9`: a trickle of real traffic always reaches the origin, so `errorRate`
   keeps measuring the ACTUAL backend condition instead of measuring nothing.
2. **Structural refusals counted as overload.** `f.refusedRps` (the existing `InstanceFlow` field)
   conflates a capacity-driven refusal (breaker-open, managed throttle/timeout, event drop/DLQ)
   with a STRUCTURAL one (a firewall-blocked path, or a manually-downed managed service) — neither
   of which shedding entry demand can fix. A fixture with a permanently firewall-blocked dependency
   spuriously tripped the shed gate on a world that was merely misconfigured, not saturated. Fixed
   by adding `InstanceFlow.structuralRefusedRps?: number` (additive, `flows.ts`), incremented ONLY
   at the two structural sites (`path.verdict === 'blocked'`, `managedDown`); Mechanism B now reads
   `f.errorRps + (f.refusedRps - (f.structuralRefusedRps ?? 0))`. A row-based reconstruction was
   tried FIRST and was wrong: `flows.ts`'s breaker-open short-circuit (`breakerOpen(pathKey(...))`)
   refuses the ENTIRE dependency's call volume with **no downstream row at all** — exactly the
   capacity signal Mechanism B most needs — so scanning `f.downstream` for blocked rows silently
   discarded the dominant real-world trigger (a breaker tripping from backend saturation) while
   still passing the fixture that motivated the change. Tracking the distinction at the SOURCE
   (where each refusal is decided) rather than reconstructing it after the fact is what actually
   works.
3. **A zero-offered step read as recovery.** Even after the 0.9 cap, Mechanism A's OWN OOM-kill
   cycle can independently zero a region's offered demand for a step (the entry instance is
   transiently down), which again reads as `errorRate = 0` and, via the same "still shedding"
   branch, instantly disengaged shedding — the same self-defeating loop as bug 1, just triggered by
   an unrelated mechanism instead of by shedding itself. Fixed by skipping the ENTIRE
   engage/recover/shed update for a region when its aggregate offered demand is `<= 0` that step: no
   traffic means no signal, not "healthy".

`MAX_SHED_FRACTION`, the structural/capacity split, and the zero-offered skip together are what
make the region-level hysteresis loop actually hold for a full 20-step streak in practice — each
one individually looked like a plausible one-line fix and each one individually still let the loop
collapse to a single step under the fixture's real dynamics.

Two PRE-EXISTING tests changed behavior as a genuine, expected side effect of Mechanism B now
existing (re-baselined, not silently loosened, following the ISSUE-003/ISSUE-009 precedent):
`index.test.ts`'s fat-internal-packet NIC test measured a real further reduction (~9x → ~4.4x
against the flat baseline) once Mechanism B started shedding the fat scenario's sustained
api→store breaker-open capacity errors; `serverParticles.test.ts`'s packet-pick-purity test hit a
below-cap particle count once its permanently-blocked dependency plus a real internal breaker trip
combined to cross the 20-step streak within its default 3-second render window (fixed by rendering
at 1s instead of 3s — the test is about pick purity, not backpressure, so it has no reason to run
long enough to engage Mechanism B at all). `bench/renderPerf.bench.test.ts`'s 400-particle-cap
fixture (20,000 rps against a single 8-vCPU host, a deliberate saturation for the render budget,
not a backpressure scenario) needed its 30-step warm-up trimmed to 15 for the same reason.

### Tests

- `index.test.ts` — Mechanism A measured (`oomCount > 1`, recovers to `healthy` between kills);
  `populationDemandRps` takes no system-state input (open-loop confirmation); Mechanism B sheds a
  SUSTAINED run (≥5 consecutive seconds, not a single lucky/unlucky sample — Mechanism A's own
  OOM-kill cycle can independently produce a one-off low-rps second) of demand measurably below the
  raw generated rate; Mechanism B is a no-op for a healthy, non-saturated world (averaged over a
  20-sample window, since a single-step snapshot at low peakRps is Poisson-noisy enough to flake on
  its own).
- Every new assertion verified to FAIL with the fix reverted (`git stash`); full suite (1708→1712
  tests) and both benches green throughout.

## Multi-Protocol Connection Audit — Wave 7, part 2: warm-up indicator (`audit-spec.md`, 2026-07-31)

### ISSUE-019 — surface engine warm-up state after a stop→edit→start cycle (`simulation.store.ts`, `SimControls.tsx`)

Not an engine defect — CLAUDE.md's topology-mutability model (edit-locked while running,
`doc`/`compiled` frozen at `start()`) means a stop→edit→start cycle correctly rebuilds every
slow-converging piece of engine state from cold: VPS burst credits, breakers, queue depth, NICs,
failover hysteresis, and the metrics EMA/latency reservoir are all genuinely reset in
`index.ts`'s `start()`, because the topology they were computed against no longer exists. The gap
was entirely in the UI: nothing distinguished a freshly-started run from a settled one, so a user
who tweaks one server's spec and restarts reads the first few seconds' different-looking metrics
as caused by their edit, when it's an artifact of the engine being cold.

Pure UI affordance, no engine change (per the spec). `simulation.store.ts` adds
`warmupBatchesRemaining: number`, initialized to `WARMUP_SECONDS` on `start()` and decremented by
one on every published metrics batch (floored at 0) — counted in BATCHES, not wall-clock
`setTimeout`/`Date.now()`, so it tracks sim time correctly under `timeScale` 2x/4x rather than
firing early or late relative to what's actually converged. `WARMUP_SECONDS` is derived from
`failover.ts`'s own `DEFAULT_HYSTERESIS` (`onsetMs + recoveryMs`, currently 8s) rather than a bare
hardcoded number — the health signal itself needs that long to settle, so nothing else in the
reset state converges meaningfully faster; if `DEFAULT_HYSTERESIS` ever changes, the warm-up
window moves with it instead of silently drifting out of sync. `stop()`/`resetSession()` reset the
counter to 0 (a stopped world has no "warming up" to show); `pause()`/`resume()` leave it alone,
since paused state is explicitly PRESERVED, not reset.

`selectWarmingUp` (mirroring the existing `selectLive` convention) is `running &&
warmupBatchesRemaining > 0`. `SimControls.tsx` renders a `warmupChip` beside the existing
`degradedChip`, pulsing (respecting `useReducedMotion()`, matching the existing live-run status
dot's convention) via `var(--color-*)` tokens only. Purely advisory: it gates nothing in
metrics/analysis, only its own visibility.

### Tests

- `simulation.store.test.ts` — `start()` sets `warmupBatchesRemaining` to `WARMUP_SECONDS` and it
  counts down one per published batch; never goes negative once every batch is counted past it;
  `stop()`/`resetSession()` clear it back to 0.
- `SimControls.test.tsx` — the warm-up chip shows while the counter is positive and disappears once
  it reaches 0; does not show while stopped even with a stale nonzero counter (a stopped world has
  nothing running to warm up).
- Every new assertion verified to FAIL with the fix reverted (`git stash`); full suite
  (1712→1717 tests), both benches, and `npm run build` (typecheck) green throughout.

This closes out every issue in `audit-spec.md`'s 7 waves (19/19: 5 Critical, 9 Major, 5 Minor) —
ISSUE-004's full engine wiring of `resolvedFrameRps` and ISSUE-006's `statusCode` 4xx/5xx semantics
remain explicitly deferred follow-ups (primitives implemented and tested; wiring/semantics scoped
down and documented at the time, not silently dropped).

## Fault Injection Wave 1, Task 3 — wiring `down`/`cpu-brownout`/`memory-leak` into `index.ts` (2026-08-01)

### `src/lib/worldEngine/index.ts` (hub file) — real `setFault`/`setOutage` facade methods

Tasks 0-2 (merged earlier) added `FaultKind`/`FaultSpec`/`FaultScope` to `types.ts` and the pure
`src/lib/worldEngine/faults.ts` module (`createFaultState`/`setFault`/`faultsForServer`/
`stepLeaks`), plus declared `setFault`/`setOutage` on `WorldEngineApi` — but left both
unimplemented on the engine object `createWorldEngine()` returns (the one `npx tsc --noEmit` error
Task 1 left standing on purpose). This task wires them in:

- `EngineState` gained `faults: FaultState` (constructed via `createFaultState()` in `start()`,
  right alongside `failover: createFailoverState()` — identical lifecycle/ownership pattern) and
  two reverse-lookup indexes built once at `start()`, next to the existing `serversByAz`/
  `azsByRegion` forward indexes: `azOfServer: Map<ServerId, AzId>` and
  `regionOfAz: Map<AzId, RegionId>` — `faultsForServer` needs a server's az/region to resolve
  az-/region-scoped faults per server per step, and no reverse map already existed.
- **`setFault(scope, id, spec)`** calls the pure `setFaultPure` on `state.faults` for
  bookkeeping/event emission, THEN — only when `spec === null` or `spec.kind === 'down'` — routes
  through the EXISTING `failoverSetOutage`/`applyAzOutageToManaged` path unchanged, so a `down`
  fault (or clearing one) is byte-identical to the pre-FEAT-001 `setOutage` behavior: same events,
  same state, same AZ→managed-service cascade. `faults.ts`'s own `active` map is bookkeeping/event
  only for the `down` kind — `failover.ts`'s `manualOutages`/`healthByScope` remain the SOLE source
  of truth for actual down-state behavior.
- **`setOutage(scope, id, down)`** is now a true thin alias: `api.setFault(scope, id, down ? {
  kind: 'down' } : null)` — referencing the `api` closure variable from inside its own method body
  is safe (called only after `api` is fully constructed, never during construction).
- A new module-level helper, `instanceIdsForFaultScope(state, scope, id)`, resolves a fault
  scope/id down to the concrete `InstanceId[]` it covers (via `instancesByServer`/`serversByAz`/
  `azsByRegion`; `'managed'` scope always `[]` — managed services have no compiled
  `ServiceInstance`s) — passed as `setFault`'s `affectedInstanceIds` so clearing a fault also clears
  those instances' `leakAccumMb` entries immediately, not just on their next OOM.
- **cpu-brownout**: in the per-server host-scheduling loop, `faultsForServer(server.id, azId,
  regionId, s.faults)` is resolved once per server per step (also feeds the memory-leak wiring
  below); `effectiveVcpu` becomes `server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1) *
  (brownout?.capacityFraction ?? 1)` — multiplicative composition with the existing VPS steal
  factor, `1` (no-op) when no brownout is active, so the zero-fault path is untouched.
- **memory-leak**: before building each server's `InstanceLoad[]`, `stepLeaks(s.faults,
  resident.map(i => ({ instanceId: i.id, mbPerMinute: leak.mbPerMinute })), stepSec)` accumulates
  into `s.faults.leakAccumMb` for that server's resident instances (called per-server rather than
  once globally — functionally identical to a single global call, since `stepLeaks` just iterates
  whatever list it's handed). Each `InstanceLoad.ramBaseMb` folds in
  `s.faults.leakAccumMb.get(instanceId) ?? 0` (0 when no leak — no-op on the zero-fault path). The
  existing OOM-restart handler (`host.oomVictim && !s.oomRestartAt.has(...)`) now also calls
  `s.faults.leakAccumMb.delete(host.oomVictim)` — a restarted process gets a fresh heap.
- Task 4 (latency-add) and Task 5 (error-inject) both read `state.faults`/`faultsForServer` this
  task established; neither is wired into the engine yet.

### Tests

Added a `describe('FEAT-001 faults', ...)` block to `index.test.ts` (4 tests), reusing the file's
existing `drive(doc, compiled)` harness and fixture-builder patterns (`e2eFixture`,
`overloadedServer`-style inline docs, the existing OOM RAM-starved fixture shape) rather than new
harness code:

- Byte-identical output across two independent runs of the same fixture with zero faults active
  (the regression floor) — `expect(batchA).toEqual(batchB)`.
- `setOutage('region', id, true)` and `setFault('region', id, { kind: 'down' })` produce the exact
  same event-kind sequence.
- cpu-brownout at `capacityFraction: 0.5` roughly doubles mean `ServerMetrics.coreUtilization` at
  the same offered load (a lightly-loaded 8-vCPU/40ms-per-request/100rps fixture: baseline ~0.5
  mean core fill vs. throttled ~1.0, capped).
- memory-leak at a steep `mbPerMinute` rate OOM-kills a near-idle instance within a bounded step
  window, then fires `instance_restarted` after `OOM_RESTART_MS`.

Verified RED first (`setFault is not a function` on all 3 fault-specific tests, zero-fault test
already passing since it exercises no new code path) before implementing, then GREEN. Full suite
(144 files / 1724 tests) and `npx tsc --noEmit` both clean after the change — the type error Task 1
left standing is now resolved by implementation, not silenced.
