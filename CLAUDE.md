# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for authoring and simulating
multi-region infrastructure "worlds." Users build a world at four zoom levels — globe → region →
availability zone → server — out of regions, AZs, servers, service blueprints, placements, and
managed services; `compileWorld()` resolves that document into concrete service instances and
permitted/blocked network paths; a from-scratch client-side simulation engine
(`src/lib/worldEngine/`) ticks the compiled world at a fixed step rate and publishes live
per-instance/server/AZ/region metrics, engine events, and replay frames that drive every view. A
deterministic analysis-rule engine and an on-demand LLM architecture reviewer surface design
issues (structural SPOFs, exposed databases, capacity/geo problems, plus free-form AI-found
issues) alongside a cost model and traffic-authoring tools.

This is the app's SECOND full architecture: the original React-Flow "canvas" prototype —
hand-wired nodes/edges, a particle-based `requestAnimationFrame` simulation, a 9-rule structural
linter, a ScaleScript DSL, one-way Terraform export, and vault templates — was deleted wholesale
in Phase 2 of a ground-up rebuild (2026-07-08) and replaced by everything described below. None
of the legacy systems exist in the codebase today; do not assume any of them do (see
`docs/module-boundaries.md`'s §1A–§1I for exactly what was removed and why, if that history is
ever needed).

Core systems that exist today:

- **World document model** (`src/lib/world/`) — a normalized `WorldDoc` (regions, AZs, servers,
  service blueprints, placements, managed services, client populations, routing config)
  plus `compileWorld(doc)`, the pure gate every other system reads through: it resolves
  placements into concrete `ServiceInstance`s, evaluates firewall/port/network-isolation rules
  into permitted/blocked `CompiledPath`s, builds routing tables, and emits structural
  `CompileFinding`s. Nothing downstream — views, the engine, analysis rules — reads the raw
  `WorldDoc` for anything derived; always `compiled`.
- **World engine** (`src/lib/worldEngine/`) — a from-scratch, deliberately-ported (not reused)
  discrete fixed-step simulation: demand generation, DNS-TTL-cached region routing with health
  checks and failover, per-host CPU/RAM scheduling, VPS burstable-credit/noisy-neighbor modeling,
  NIC byte-rate caps, per-dependency circuit breakers, a BFS flow solver, replica promotion, a 1
  Hz metrics pyramid (instance→server→AZ→region→world), an event ring, and a replay buffer.
  Exposed as one facade — `createWorldEngine()` / the shared `worldEngine` singleton — driven
  ONLY by `simulation.store.ts`; every view reads that store, never the engine directly.
- **Four-level navigation shell** (`src/app/world/`, `nav.store.ts`'s `WorldLevel`) — a
  react-three-fiber globe (night-earth, health-colored region pins, population markers,
  engine-driven great-circle traffic arcs) → a region flow page (cross-AZ traffic columns, rack
  chassis) → a DOM/SVG isometric datacenter floor (racks, free-pool pods, flow traces) → a
  per-server "circuit board" view (NIC/firewall gate, service chips, a unified hardware
  platform). All four are live-metrics-aware and replay-scrubbable.
- **Traffic authoring** — client populations (placed by hand or by clicking the globe, each with
  an optional per-population L7 route mix) and routing policy (latency/geo/weighted/priority) with
  DNS TTL + health-check tuning. (Auto-baseline synthetic per-region demand was removed
  2026-07-15 — all traffic now originates from authored populations.)
- **Analysis engine** (`src/lib/analysis/`) — three rule families (structural/network-security/
  capacity, 15 rules) run over the compiled world plus the latest metrics batch, rendered in an
  `Analysis` tab merged with compile findings, with clickable affected-entity chips that jump to
  the region/AZ/server in question.
- **LLM architecture reviewer** (`src/lib/llmReview.ts`) — on-demand, schema-validated review
  against any OpenAI-compatible endpoint, rendered as AI-tagged cards beside the deterministic
  findings. The actual HTTP call is Rust-side (`llm_chat` Tauri command — a webview `fetch` to
  arbitrary hosts dies on CORS); settings persist to the app data dir and are never serialized
  into `.scalemap`, logged, or echoed unmasked (see Key Architecture Decisions).
- **AI chat assistant** (`src/lib/aiChat/`, `src/app/world/ai/`) — a read-only, multi-turn chat
  overlay (toggled from a header button beside ⚙ Settings) that answers questions about the
  live/compiled world using the same `llmClient.ts` transport seam as the one-shot reviewer above,
  grounded in an always-on context digest plus opt-in scoped attachments (entity detail, recent
  events, causal episodes) — it never mutates the world or the simulation.
- **Cost model** (`src/lib/costModelV2.ts`) — per-server hourly cost + managed-service pricing
  (`cloudRegistry.ts`) rolled up by region/AZ, plus tiered cross-AZ/cross-region/internet egress
  costed off live simulated byte rates.
- **Global Settings** (⚙ button, `SettingsModal.tsx`) — the app's dark/light theme toggle (now
  actually reachable from the UI) and the LLM endpoint configuration above.
- **`.scalemap` v3 file persistence** via Tauri commands, with a `localStorage`-backed mock for
  browser-only dev, plus a 30-second dirty-triggered autosave snapshot. (v3 is node-model Phase 5's
  clean-break bump; v1 and v2 files are rejected on load.)
- **Durable simulation event log** — every engine event of every run is appended to SQLite
  (WAL) at `<app_data_dir>/events.db` in 1 Hz batches (`event_log_*` commands; in-memory map
  under `tauriMock` in browser dev). The store's in-memory `events` list is a 500-entry
  presentation window for the live Events tab, NOT a history cap — `eventLogTotal` carries the
  true persisted count. Event history is never serialized into `.scalemap`.

There is no `prd.txt` in the repo; this file is the source of truth for scope and architecture.
**Read `docs/agent-onboarding.md` before writing code** — it holds the hard laws (theme/price/
emoji/motion/edit-lock rules), design philosophy, verification bar, and the accumulated gotchas.
`docs/module-boundaries.md` is the detailed, file-by-file companion — more current than the prose
above for any specific file's history.

---

## Commands

```bash
# Full Tauri dev (Rust + React hot-reload) — use this for all feature work
npm run tauri dev

# Vite-only dev server (no Tauri APIs available — falls back to tauriMock.ts)
npm run dev

# Type-check + build frontend
npm run build

# Build native app (release)
npm run tauri build

# Run frontend tests (extensive vitest coverage — jsdom for components, node env for pure
# rule/engine logic)
npx vitest

# Rust-only (from src-tauri/)
cargo build
cargo test
```

Vite dev server runs on port 1420 (strict — fails if occupied).

---

## Architecture

```
src/
  App.tsx                        # useThemeBootstrap + ⌘N/⌘Z/⇧⌘Z global handlers + 30s
                                  # dirty-triggered autosave + HomeScreen/WorldShell gate
  main.tsx
  app/
    store/                       # Zustand, one store per domain — no monolithic store
      nav.store.ts                # WorldLevel ('globe'|'region'|'az'|'server') + regionId/azId/
                                   # serverId focus; deliberately has no dependency on world.store
      world.store.ts              # WorldDoc CRUD + undo/redo (history/future snapshots) +
                                   # dirty-marking on every mutation
      simulation.store.ts         # running/timeScale/latestBatch/events/healthOverrides/
                                   # scrubIndex/scrubBatch/degraded — the ONLY caller of
                                   # worldEngine directly; every view reads this store instead
      file.store.ts               # File path, dirty flag, recent files
      ui.store.ts                 # themeMode ('dark'|'light') + setThemeMode — persisted,
                                   # now user-facing via the Settings modal
    world/
      WorldShell.tsx               # Header (breadcrumb, SimControls, ⚙ Settings gear, file
                                    # actions) + active-level view + WorldPanel dock +
                                    # ScrubberV2 bottom bar
      GlobeView.tsx, globe/         # Level 1: react-three-fiber night-earth globe (GlobeScene,
                                    # RegionPins, PopulationMarkers, ArcsLayer engine-driven
                                    # traffic arcs) or GlobeCards fallback when WebGL is
                                    # unavailable
      RegionView.tsx, region/       # Level 2: cross-AZ traffic columns, failover timeline v2
                                    # (swimlanes/bands/causality arrows — TimelineV2.tsx +
                                    # timelineModel.ts, Polish 4 T6; replaced the old single-lane
                                    # TimelineStrip.tsx, deleted), rack chassis (SplitLines,
                                    # AzRow, CrossAzColumn)
      az/                           # Level 3: DOM/SVG isometric datacenter floor (DatacenterFloor
                                    # — WorldShell.tsx renders it directly, no separate top-level
                                    # AzView.tsx — RackCabinet, FreePoolPod, floorLayout, floorData)
                                    # — replaced the React Flow AZ canvas outright (Polish 3 T4);
                                    # @xyflow/react has no remaining consumer anywhere in the app
      ServerView.tsx, server/       # Level 4: the "circuit board" — NIC/firewall gate, service
                                    # chips, HardwarePlatform, PacketLayer, InspectorRail
      SettingsModal.tsx             # ⚙ modal — Appearance (theme toggle) + AI Review (LLM
                                    # endpoint config)
      dock/                        # The contextual dock (Polish 4, right-hand WorldPanel body):
                                    # scope.ts/scopeData.ts derive a world|region|az|server
                                    # DockScope from nav + a lifted ui.store.selectedServerId
                                    # (pure, no React/store imports — read only by WorldPanel.tsx
                                    # and the instrument components below); ScopeRail (the "here"
                                    # pill rail, identical at every scope); one signature
                                    # instrument per scope — AtlasHeader (world+region
                                    # constellation), FloorPlanHeader (az minimap,
                                    # AzConfigTab), ServerFaceplate (+ drawers/: Hardware/
                                    # Firewall/Services/Placement, one open at a time)
      panels/                       # WorldPanel dock tabs — world scope only: Topology,
                                    # Blueprints, Packets, Managed, Connections, Traffic, Routes,
                                    # Analysis (+ AiReviewSection), Events, Cost. Blueprints and
                                    # Packets are the two global LIBRARIES (reusable definitions,
                                    # independent of where they run) — Blueprints returned
                                    # 2026-07-28 as a CATALOG only: services are still authored
                                    # via the VPS door (dock/drawers/AddServiceForm) + Connections,
                                    # and the Placements tab stays gone. ManagedPanel holds the
                                    # cloud-managed appliances. PacketMixEditor/NumberField are
                                    # shared controls (the mix editor is also used by
                                    # connections/ConnectionsView's EdgeInspector).
                                    # Region/AZ/server scope
                                    # show a narrower Config/Analysis/Events/Cost set instead,
                                    # with Config rendered by dock/'s instrument components above
                                    # (see docs/module-boundaries.md §S-§V)
      fileOps.ts, Breadcrumb.tsx, SimControls.tsx, EventsTab.tsx, useCompiledWorld.ts
  lib/
    world/                        # Pure document model + compiler — the schema of .scalemap v3
      types.ts                     # WorldDoc entities + CompiledWorld output types
      factories.ts, instanceCatalog.ts, regionGeo.ts, populationLabel.ts
      packetDraft.ts               # Pure draft logic for PacketModal (mirrors managedDraft.ts) —
                                    # defaultPacketDraft/draftFromPacket/draftToTemplate/
                                    # applyProtocolChange. Never emits a `path`, which is what
                                    # keeps a library packet out of the route view
      rackModel.ts                 # Pure rack capacity/placement model (Polish 3): Rack/
                                    # RackPosition types live in types.ts; this file has
                                    # serverHeightU/rackUsedU/canAssign/autoArrangePlan — no
                                    # engine/compile/analysis/cost semantics, consumed by
                                    # world.store.ts's rack actions + app/world/az/
      compileWorld.ts (+ network.ts, routing.ts)  # doc -> instances, permitted/blocked paths,
                                    # routing tables, compile findings — the gate every
                                    # consumer reads through instead of the raw doc
    worldEngine/                  # The simulation engine — a from-scratch port (not a reuse)
                                   # of the deleted canvas app's particleEngine mechanisms
      index.ts                     # createWorldEngine() facade — sequences every subsystem
                                    # below into one fixed-step run; exports MAX_GLOBE_ARCS
      rng.ts, engineClock.ts, demand.ts, routingRuntime.ts, hostScheduler.ts, vpsModel.ts,
      networkRuntime.ts, breakers.ts, flows.ts, failover.ts, metrics.ts, events.ts, replay.ts
      types.ts                     # Frozen WorldEngineApi/MetricsBatch/EngineEvent/render-
                                    # payload contract — additive-only, see contract-drift.md
    analysis/                     # Deterministic rule engine over the compiled world
      types.ts, runAnalysis.ts, rules/{structural,network,capacity}.ts
    llmReview.ts                  # LLM review context builder + schema-validated, retrying
                                   # request client
    costModelV2.ts, cloudRegistry.ts, regionConfig.ts
    serializer.ts                 # .scalemap v3 (de)serialization (v1/v2 rejected on load)
    nodeConfig.ts                 # Packet-template types + BOTH registry views. The canvas-era
                                   # NODE_CONFIG icon registry / node-edge sim-config types were
                                   # removed 2026-07-12; the surviving PacketRegistry was REVIVED
                                   # in the Phase 2 route system and widened 2026-07-28 into one id
                                   # space with two views — listRoutes (http WITH a path = the L7
                                   # route catalog, authored via RoutesPanel) and listPackets
                                   # (pathless, any protocol = the packet library, authored via
                                   # PacketsPanel). Both live in WorldDoc.packets
    connectionModel.ts            # The ONE connection-semantics point (companion to
                                   # packetResolve): connectionClassOf's protocol-wins rule,
                                   # profileFor/resolveConnectionProfile, and activeConnections —
                                   # the SINGLE Little's-law formula both engine call sites use
    packetResolve.ts              # The ONE mix→wire-bytes resolution point: resolveWireSize's
                                   # four-tier fallback (bound mix → inline KB → registry default
                                   # → 2 KB), db write-fraction/WAL derivation, routeIngressBytes,
                                   # and pickPacketByIndex (rng-FREE particle packet choice —
                                   # drawing rng at render time would break replay determinism)
    theme.ts                      # DARK_COLORS/LIGHT_COLORS/CATEGORY_COLORS/FONT — the
                                   # --color-* token source for both themes
    tauri.ts / tauriMock.ts       # Tauri command wrappers + browser-dev localStorage/fetch
                                   # fallback (file I/O + LLM settings/chat)

src-tauri/src/
  main.rs, lib.rs
  commands.rs                    # All Tauri commands: save/load diagram, file dialogs, recent
                                  # files, save/load_llm_settings, llm_chat, event_log_*
                                  # (SQLite WAL event history at <app_data_dir>/events.db)
```

---

## Key Architecture Decisions

**Four-level nav + compiled-world gate:** the app has exactly one document model, `WorldDoc`
(`src/lib/world/types.ts`), navigated at four zoom levels — globe → region → AZ → server
(`nav.store.ts`'s `WorldLevel`). Every view, the engine, and the analysis rules read
`compileWorld(doc)`'s output (`CompiledWorld`: instances, permitted/blocked paths, routing
tables, compile findings) for anything derived — never the raw doc. Extend `CompiledWorld`
additively; never reshape it (it fans out to every view, the engine's `start()`, and every
analysis rule).

**Engine facade + store seam:** `src/lib/worldEngine/index.ts`'s `createWorldEngine()` is the
ONLY simulation engine; `simulation.store.ts` is the ONLY file in the app allowed to call it
directly (`start`/`stop`/`attachRenderer`/`getReplayFrames`/`getTracedRequests`/`setOutage`).
Every view reads the store, never the engine facade. `worldEngine/types.ts` is a frozen contract
— additive-only changes, logged in `.superpowers/sdd/contract-drift.md` when they happen.

**AZ level:** the Level-3 AZ view is `src/app/world/az/DatacenterFloor.tsx` — a DOM/SVG isometric
datacenter floor (racks as 3-face isometric boxes with per-server LED slats, free-pool servers as
standalone pods, flow traces between them), read-only, rendered directly by `WorldShell.tsx` for
`nav.level === 'az'`. **`@xyflow/react` (React Flow) is no longer in the app** (Polish 3 Task 4)
— it previously rendered this same AZ-level canvas (`AzCanvas.tsx`/`AzSimOverlay.tsx`/
`RackNodes.tsx`, plus `src/lib/world/layoutRacks.ts`), all four deleted in the same commit that
replaced them with `az/`; don't assume React Flow appears anywhere in the app.

**State management:** Zustand, one store per domain (`nav`, `world`, `simulation`, `file`, `ui` —
no monolithic store). `nav.store.ts` deliberately has no dependency on `world.store.ts`:
navigating never pushes undo/redo history.

**Undo/redo:** immutable history stack in `world.store.ts` (`history`/`future` snapshot arrays of
`{ doc }`), routed through one internal `mutate()` helper that also marks the file dirty — new
CRUD actions get both for free by going through it.

**Analysis rules:** one registry, `ANALYSIS_RULES` (`src/lib/analysis/runAnalysis.ts`) —
`structural`/`network`/`capacity` rule files each export their rule objects, spread into the same
array. Add new rules there; don't special-case execution elsewhere. Rules never duplicate
`compiled.findings` — the Analysis tab merges both lists and suppresses the compile-side
duplicate of any rule that re-surfaces a compile finding (e.g. `blocked-dependency-path`).

**Packet system — ONE registry, TWO views (route catalog + packet library):** the Flyweight
packet-template types (`PacketTemplate`/`PacketMode`/`PacketRegistry`, `src/lib/nodeConfig.ts`)
survive from the deleted canvas app. `WorldDoc.packets` is a single monotonic id space
(mutate()-managed, serialized inside `world`; the old vestigial top-level `.scalemap` `packets`
slot is migrated in on load), and what a template IS depends on whether it carries a path:

- **`listRoutes`** — http templates WITH a path = the Phase 2 L7 **route catalog**, authored in
  `panels/RoutesPanel.tsx` (world-scope `routes` tab). `ClientPopulation.requestMix` maps
  routes→weights; a region's L7 LB `listenerRules` map route paths→services.
- **`listPackets`** — every template WITHOUT a path = the global **packet library** (all four
  protocols, each with request/response size, burst variance, and a colour), authored in
  `panels/PacketsPanel.tsx` + `PacketModal.tsx`. A `PacketMixEntry[]` binds packets to a
  service→service edge (`BlueprintDependency.packetMix`, via the Connections graph's
  `EdgeInspector`) or, "advanced", to a route.

`src/lib/packetResolve.ts` is the ONE place a mix becomes wire bytes — a four-tier fallback
(bound mix → the carrier's inline req/resp KB → `PacketRegistry.defaultPacket` → 2 KB each way).
Payload size now drives **cost, NIC saturation, and per-KB CPU on every hop**, not just ingress:
the flow solver's `depBytesById` sizes cross-AZ/cross-region egress, NIC is booked per downstream
row on BOTH endpoints, and inbound internal KB feeds `cpuMsPerKb` (one-step lagged off
`prevFlows`). db packets additionally derive an edge's `writeFraction` from their `queryType` and
apply WAL write amplification. Every new field is optional, so a pre-existing `.scalemap` loads
and simulates byte-identically. Internal service-to-service per-route routing is still parked
(ingress-only L7), as is persistent `stream` DELIVERY semantics (authored and connection-modelled
today, but not yet simulated as its own framing/heartbeat protocol — see the multi-protocol audit's
Wave 6). `event` delivery, by contrast, IS now simulated as asynchronous (2026-07-31, audit
ISSUE-002) — see `src/lib/worldEngine/broker.ts` below.

**Connection semantics — the other half of a packet (2026-07-29):** `ConnectionType`
(`keep-alive`/`short-lived`/`streaming`) was authored-and-inert schema from Phase 2 until this
phase; it is now LIVE. Where payload size says how much data a call moves, connection type says
how long the connection is held and what establishing it costs — the difference between a
CPU-bound and a RAM-bound failure. `src/lib/connectionModel.ts` is the ONE place that lives:
`connections = rps × (latencyShare × latency/1000 + extraHold + fixedHold)`, where `keep-alive` is
the exact historical identity (the regression floor), `short-lived` adds a 15 ms handshake + 100 ms
linger hold tail and 2 ms/req of handshake CPU, and `streaming` decouples from latency entirely for
an authored `holdSeconds` (default 30 s). `protocol` WINS over `connectionType` for the non-http
kinds: `stream` → streaming, `db`/`event` → keep-alive. Both tiers are covered — routes (entry) and
packets bound to edges (internal), blended per instance by rps share.

⚠ **The two-call-site invariant.** Little's law is computed in exactly TWO places — the host
scheduler's `InstanceLoad.activeConnections` (which drives RAM growth and OOM victim selection) and
`metrics.ts`'s published `InstanceMetrics.activeConnections` (which drives every view and the
`ram-oversubscribed` analysis rule). **Both MUST call `connectionModel`'s `activeConnections()`.**
If only one is ever made aware of a change, the RAM the scheduler enforces silently diverges from
the RAM the user is shown. `index.test.ts`'s `DIVERGENCE GUARD` test exists solely to catch that.
There is deliberately NO connection ceiling/refusal path — RAM is the constraint, so
`hostScheduler`'s existing OOM path and `capacity.ts`'s `ram-oversubscribed` fire with zero new
code. Caveat: a saved world that already picked `short-lived`/`streaming` WILL change behavior on
load — that is the point of the phase, but it is a real change to existing documents.

**Global blueprint library:** `panels/BlueprintsPanel.tsx` + `BlueprintModal.tsx` (world-scope
`blueprints` tab) give `ServiceBlueprint` — always a global, reusable definition — the catalog
surface it lost in node-model Phase 5. It does NOT resurrect the retired generic-blueprint
authoring model: creating a service is still the VPS door (`dock/drawers/AddServiceForm`), and
dependencies are still authored in the Connections graph. `duplicateBlueprint` deep-copies a
definition with fresh dependency ids and no placements.

**LLM reviewer + key security (non-negotiable):** `src/lib/llmReview.ts` builds a review context
from the compiled world + deterministic findings + aggregated metrics (never raw instance maps),
sends it to any OpenAI-compatible endpoint via the Rust-side `llm_chat` Tauri command (a webview
`fetch` to arbitrary hosts dies on CORS), and validates/retries against a hand-rolled JSON schema
check. Settings (`baseUrl`/`apiKey`/`model`) persist to `llm_settings.json` in the app data dir.
The API key is NEVER serialized into `.scalemap` (settings never touch `world.store`/
`serializer`), NEVER logged or `console.*`'d, NEVER included in the review-context payload,
REDACTED from every error string on both the Rust and TS sides, and rendered only masked
(`•••• <last4>`) after save — the Settings modal's password input never echoes a saved key back
into its value. The same canary now also covers the AI chat assistant: `src/lib/aiChat/context.ts`'s
digest/attachment builders (`buildChatDigest`/`buildContextBlock`) never receive an `LlmSettings`
parameter at all — a structural guarantee, not just a convention — so there is no code path by
which the API key could reach the context payload sent to the model.

**Theme:** `--color-*` CSS custom properties (`theme.ts`'s `DARK_COLORS`/`LIGHT_COLORS`,
bootstrapped by `App.tsx`'s `useThemeBootstrap`) are the only sanctioned color source for new UI
— no hardcoded hexes. The dark/light toggle is live and user-facing via the ⚙ Settings modal
(`ui.store.ts`'s `themeMode`); design new UI to look correct in both.

**Cross-platform:** all Tauri API calls (file dialogs, path resolution, the LLM HTTP transport)
must use Tauri's cross-platform abstractions — no OS-specific system calls. Rust code is
currently a single `commands.rs`; keep new commands there unless the file grows large enough to
warrant splitting (not yet planned/required).

---

## Design System

```
Canvas bg:         #0D0F12   /  canvas dots: #1A1D22
Node base:         #161920   /  border: #2A2E38
Surface:           #0F1117   /  surface hover: #13161E
Toolbar:           #111318   /  toolbar border: #1E2128

Compute/Orchestration: #5B9CF6 (blue)
Storage/Caching:       #E0A552 (amber)
Network:               #3FC7B8 (teal)
Messaging:              #9C8CE0 (violet)
Grouping:               #8391A5 (slate-blue accent, transparent bg)

Text primary: #F1F5F9 / secondary: #94A3B8 / muted: #64748B
Status: danger #EF4444 / success #22C55E / warning #F59E0B
```

Source of truth: `src/lib/theme.ts` (`DARK_COLORS`, `CATEGORY_COLORS`). Font: `JetBrains Mono`
throughout. All animations must respect `prefers-reduced-motion`.

**Light mode:** `theme.ts` also exports a full `LIGHT_COLORS` sibling (WCAG-AA-checked
replacements — e.g. `danger` #DC2626, `success` #16A34A/`successText` #11823B, `warning` #B45309,
`accent` #3F6DAC) and every `CATEGORY_COLORS` entry carries a `foreground.light` variant for
icon/text use on a light card. The dark/light toggle (`ui.store.ts`'s `themeMode`, live via the
⚙ Settings modal) swaps the whole set at runtime through `App.tsx`'s `useThemeBootstrap`, which
writes every token as a `--color-*` CSS custom property — new UI must use `var(--color-*)`
exclusively, never a hardcoded hex, since both modes are now genuinely reachable in the running
app.

---

## Diagram File Format

`.scalemap` files are JSON, version `"3"` (`src/lib/serializer.ts`). Two older formats are
explicitly rejected on load, each with its own dedicated error message: the v1 canvas-era format
(removed with the legacy app in Phase 2) and — as of **node-model Phase 5's clean breaking
change** — the v2 pre-typed-node format (node-based services/DBs have no faithful auto-migration
from a generic-blueprint world, so v2 files are refused at the version gate, mirroring the v1
rejection). The `world` shape below is otherwise unchanged from v2 — only the version string
bumped:

```json
{
  "version": "3",
  "meta": { "name": "", "created": "", "modified": "" },
  "world": {
    "routing": { "policy": "latency", "weights": {}, "priorityOrder": [], "healthCheckIntervalMs": 10000, "healthCheckFailureThreshold": 3, "dnsTtlSec": 30 },
    "populations": {},
    "regions": {},
    "azs": {},
    "servers": {},
    "blueprints": {},
    "placements": {},
    "managedServices": {},
    "loadBalancers": {},
    "racks": {},
    "packets": { "mode": "generic", "templates": {}, "nextId": 1 }
  },
  "viewState": { "level": "globe" }
}
```

`world` is the full `WorldDoc` (`src/lib/world/types.ts`) — every entity collection
(`regions`/`azs`/`servers`/`blueprints`/`placements`/`managedServices`/`populations`/
`loadBalancers`/`racks`) plus `routing` config and the `packets` route catalog, keyed by id.
(The `traffic`/auto-baseline config was removed 2026-07-15 — traffic comes only from authored
populations.) `deserializeWorld` first gates on `version` — v1 and v2 are rejected with their own
messages (see above), only `"3"` proceeds — then validates that `meta` and the 8 required
top-level collections
(`routing`/`populations`/`regions`/`azs`/`servers`/`blueprints`/`placements`/`managedServices`)
are present and non-null before accepting a file, throwing a single "missing or malformed world
document" error otherwise; `loadBalancers`/`racks`/`packets`/`connectionLayout` are
additive-normalized (defaulted when absent — defensive insurance for a hand-authored v3 file,
since the serializer itself always writes the full `WorldDoc`). `packets` now lives inside `world` (Phase 2 route system); a legacy TOP-LEVEL
`packets` slot in an older file is migrated into `world.packets` on load (see Key Architecture
Decisions for the packet system's current, reduced
role). `viewState` is optional — `{ level, regionId?, azId?, serverId? }`, the nav focus at save
time, restored on reopen so a saved file reopens where you left it. There is no analysis-finding
or LLM-review persistence in this format — both are derived/ephemeral (see Key Architecture
Decisions).

---

## Key Dependencies

| Package | Purpose |
|---|---|
| `@react-three/fiber` | React renderer for three.js — the globe scene (`Canvas`, `useFrame`, hooks) |
| `@react-three/drei` | `OrbitControls`, `useTexture`, and other r3f scene helpers used by the globe |
| `three` | The WebGL scene graph underlying the globe (night-earth sphere, atmosphere shader, arc geometry) |
| `zustand` | State management — one store per domain (`nav`/`world`/`simulation`/`file`/`ui`) |
| `framer-motion` | Panel/globe/board animations; every animated component also checks `useReducedMotion()` |
| `lucide-react` | Icons — today's only live consumer is `HomeScreen.tsx` |
| `vitest` / `@testing-library/react` | Test harness — extensively used (see Known Issues / Roadmap) |

Rust (`src-tauri/Cargo.toml`): `tauri`, `tauri-plugin-opener`, `tauri-plugin-dialog`,
`serde`/`serde_json`, `chrono`, `reqwest` (`default-features = false`, features `["json",
"rustls-tls"]` — added in Phase 6 for the `llm_chat` command; no OpenSSL dependency), `rusqlite`
(`features = ["bundled"]` — the durable simulation event log, WAL mode, added 2026-07-12).

---

## Known Issues / Roadmap

Test coverage is now extensive (`lib/analysis`'s rule files, `lib/worldEngine`'s subsystems,
`lib/world`, and most of `app/world`'s panels/board/rack/globe components all have
`*.test.ts(x)` coverage — jsdom for anything rendering React, plain node env for pure logic).
`src-tauri/src/commands.rs` remains a single flat file — still fine at its current size (file
I/O commands + the LLM settings/chat commands); revisit modularization only if it becomes hard
to navigate.

This file, `docs/agent-onboarding.md`, `docs/module-boundaries.md`, and the phase-completion
summaries in `.superpowers/sdd/progress.md` are the current architectural record. The rebuild's scope is
complete as of Phase 6; the following is intentionally parked, not partially built or in
progress — do not assume any of it exists:

- k8s/ECS schedulers (blueprint/placement scheduling semantics beyond the current explicit
  server-by-server placement model)
- ScaleScript v2 (a declarative scenario/override DSL — the original ScaleScript was deleted
  with the legacy canvas app and never ported)
- Terraform v2 (diagram/world → HCL export, or any HCL import/parsing — the original
  export-only Terraform support was deleted with the legacy canvas app and never ported; there
  has never been an import path in any version of this app)
- AI watch-mode (continuous/background LLM review, vs. today's on-demand `Review architecture`
  button)
- Spot-instance cost/interruption modeling
- Managed-service pseudo-internals (today's `ManagedService` is a black-box cost/routing
  target, not a simulated internal engine)
- LLM review persistence/history (both AI surfaces — the one-shot architecture review's cards
  AND the multi-turn chat assistant's transcript — are ephemeral, in-memory only, never persisted
  and never serialized into `.scalemap`; closing the assistant or reloading the world discards
  the conversation)
- Streaming LLM responses / request cancellation (today's review request is a single blocking
  round trip with one retry; no cancel button, no token streaming. The chat assistant adds a
  generation-counter **abandon** mechanism — `chat.store.ts`'s `requestGen`/`inFlightTurnId` lets
  a stale turn's late resolve be discarded on close/retry — but this is not true request
  cancellation: `llm_chat` itself is un-abortable once dispatched, with a fixed 60s Rust-side
  timeout)
- Connection POOL modeling (pool size, checkout wait, pool-exhaustion queueing) and a connection
  CEILING / refusal path — connection semantics are live, but RAM is deliberately the only
  constraint (see the two-call-site invariant above); a `WorkloadProfile.maxConnections` mirroring
  `managedDbRuntimeFor`'s `connectionRefusedRps` is the natural follow-up
- Wire-protocol sub-enum (HTTP/2 multiplexing, gRPC streams, WebSocket) beneath `ConnectionType`


When making changes to the codebase refer to the [module boundaries](docs/module-boundaries.md) document to understand which files are low-risk to modify in parallel and which are high-conflict "hub" files that require careful coordination, and try to utilize codegraph mcp server if possible to understand the fan-in and fan-out of the files you are modifying. And after every new feature/change update the docs/module-boundaries.md file to reflect the new architecture and module boundaries.