# Polish 4 — Contextual Dock Skeleton (T1–T8)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.
> Spec: `docs/superpowers/specs/2026-07-11-polish4-contextual-dock-design.md` (decisions D1–D12).
> Visual truth: `docs/superpowers/specs/mockups/polish4-dock-v2.html` (docks §1, drawers §2) and
> `docs/superpowers/specs/mockups/polish4-round1-locked.html` (timeline §3 WITH causality
> arrows, globe traffic §4). Round-1 §1–§2 are superseded visuals — laws only.

**Goal:** the dock scopes itself to nav + selection and wears three instrument skins
(atlas / floor plan / faceplate); server config becomes a four-drawer breathing spine with a
watching posture; the region timeline becomes swimlanes + narration; the globe gains a
city-snapping "+ traffic" placement mode.

**Architecture:** all view-side. One additive ui.store field (`selectedServerId`); scope is
derived, never stored. Engine (`src/lib/worldEngine/`) frozen — zero changes. One
behavior-identical compiler-adjacent refactor (`regionOrderFor` extraction in routing.ts).

## Global Constraints (every task; copy into every dispatch)

- **Engine frozen:** no file under `src/lib/worldEngine/` changes. `simulation.store.ts` stays
  the only facade caller. All live numbers come from `latestBatch`/`scrubBatch`, `events`,
  `getReplayFrames()` — already published.
- **`nav.store.ts` untouched. `world.store.ts` gains no actions.** `ui.store.ts` gains exactly
  `selectedServerId` + setter. `.scalemap` format untouched.
- **Relocated-dispatch contract:** restyled/moved controls reuse existing store dispatches
  byte-for-byte (`goRegion/goAz/goServer`, `addAz/addServer/addRack/autoArrangeAz`,
  `assignServerToRack`, `updateServer/updatePlacement/addPlacement/removeServer`,
  `setOutage`, `addPopulation/updatePopulation`).
- **Price values render `var(--color-price)`. No emojis** (glyphs `▸ ✕ ⇄ ⬆ ♺ ● ◷ ¤ ⏎ ↺ −` ok).
- **Edit-lock law:** authoring controls `disabled={running}` title `stop the simulation to
  edit`; kill/restore run-only, title `start the simulation to break things`.
- **Motion:** static at 0 rps; ONE ambient stroke per dock (atlas arc / floor-plan LED /
  faceplate pulse); timeline zero-animation; ratified exceptions: faceplate idle breathe
  (3.6s), place-mode ghost blink (2s). Everything respects `useReducedMotion()`.
- **Themes:** `var(--color-*)` tokens everywhere except the three instrument HEADERS
  (constellation/minimap/plate = dark-scene chrome, InspectorRail precedent, commented).
- **Singular-aware copy** (`1 server`, `2 servers`).
- Tests: jsdom for components, node env for pure logic. The pre-existing suite (615) stays
  green; only intentionally-moved surfaces may migrate their tests (named per task).

---

## T1 · Scope model, selection lift, scope rail, dock shell

**Files:**
- Modify: `src/app/store/ui.store.ts` — add `selectedServerId: ServerId | null` (initial null)
  + `setSelectedServerId: (id: ServerId | null) => void`.
- Create: `src/app/world/dock/scope.ts` + `scope.test.ts` (node env):
  ```ts
  export type DockScope =
    | { kind: 'world' }
    | { kind: 'region'; regionId: string }
    | { kind: 'az'; regionId: string; azId: string }
    | { kind: 'server'; regionId: string; azId: string; serverId: string }
  export interface NavSnapshot { level: WorldLevel; regionId: string | null; azId: string | null; serverId: string | null }
  export function deriveScope(nav: NavSnapshot, selectedServerId: string | null, doc: WorldDoc): DockScope
  // server scope from selection ONLY when doc.servers[selectedServerId]?.azId === nav.azId (stale/foreign guard)
  export function scopeTabs(scope: DockScope): PanelTab[]   // world → 7 existing ids; else ['config','analysis','events','cost']
  ```
- Create: `src/app/world/dock/ScopeRail.tsx` + test — pills per D1; `here` pill styling from
  the mock's `.scopeseg.here`; pill clicks dispatch `goGlobe/goRegion/goAz` +
  `setSelectedServerId(null)` per D1 (az pill while at az level = clear selection only).
  `data-testid="scope-rail"`.
- Modify: `src/app/world/panels/WorldPanel.tsx` — derive scope; render ScopeRail above the tab
  bar; extend `PanelTab` with `'config'`; tab persistence rule (keep shared tab id, else first);
  at non-world scopes render the four-tab set with placeholder Config bodies (T2–T4 fill them);
  scoped Analysis/Events/Cost per T1's helpers below. Analysis badge = scoped count.
- Create: `src/app/world/dock/scopeData.ts` + test (node env) — the scoping helpers:
  ```ts
  export function scopeEntityIds(scope: DockScope, doc: WorldDoc, compiled: CompiledWorld): Set<string>
  // closure: entity + descendants (+ instance ids via compiled); world → null-sentinel "everything"
  export function scopedEvents(scope: DockScope, doc: WorldDoc, compiled: CompiledWorld, events: EngineEvent[], batch: MetricsBatch | null): EngineEvent[]
  // region scope MUST delegate to the existing regionEvents (regionData.ts) — do not fork its logic
  export function scopedFindings(scope, findings: AnalysisFinding[], compileFindings: CompileFinding[], doc, compiled): { analysis: AnalysisFinding[]; compile: CompileFinding[] }
  export function scopedCost(scope, doc, world: WorldMetrics | null): { hourlyUsd: number; monthlyUsd: number; egressNote: string | null }
  // server scope: hourlyUsd = server.hourlyUsd, egressNote = 'egress is attributed at the AZ level'
  ```
- Modify: `src/app/world/WorldShell.tsx` — effect clearing `selectedServerId` on
  `nav.level`/`nav.azId` change.
- Modify: `src/app/world/az/DatacenterFloor.tsx` — replace the local `selectedServerId`
  useState with the ui.store field (lift; all existing prop threading to
  RackCabinet/FreePoolPod/InspectorV2 unchanged this task).

**Produces for later tasks:** `DockScope`, `deriveScope`, `scopeTabs`, `scopedEvents/Findings/
Cost`, the ScopeRail, ui.store selection.

## T2 · The atlas instrument (world + region scopes)

**Files:**
- Create: `src/app/world/dock/AtlasHeader.tsx` + test (jsdom — it is plain SVG/DOM):
  ```ts
  export interface AtlasHeaderProps { regionId: string | null }   // null = world scope
  export function AtlasHeader(props: AtlasHeaderProps): ReactElement
  export function projectLatLon(lat: number, lon: number, w: number, h: number): { x: number; y: number }  // exported for tests
  ```
  Equirectangular projection (lon −180…180 → 0…w; lat 75…−60 → 0…h, clamped). Graticule (6
  paths, `#16283d`), region dots (live health colors + glow; `data-testid="atlas-region-dot"`),
  population dots, 8px labels, arcs per D4: quadratic `path` population→landing; top-rps route
  gets class `live` with CSS `dashflow 1.2s linear infinite` ONLY when `running && rps>0 &&
  !reduced` (`data-animated` attribute for tests); ≤3 arcs total. Headline per D4 (two
  postures; price token). Region scope: this region's dot ringed (hud stroke), scoped headline.
  Dark-scene chrome constants + comment (D3).
- Modify: `WorldPanel.tsx` — world scope: AtlasHeader replaces the `WorldSummary` strip
  (delete the WorldSummary function + its testid usage; migrate its two-posture copy into the
  headline); region scope: AtlasHeader + four tabs.
- Create: `src/app/world/dock/RegionConfigTab.tsx` + test — AZ rows (health dot, label,
  `N servers`, live rps; click → `goAz`) + `+ az` (TopologyPanel's `addAz` dispatch,
  edit-locked). 
- Modify: `src/app/world/panels/TopologyPanel.tsx` — `wtree` reskin per D4 (left-border region
  rows, hud hover, rps/meta lines). **Styling only — zero dispatch changes**; existing tests
  must pass untouched.
- Update: `WorldPanel.test.tsx` — WorldSummary assertions migrate to atlas-headline assertions.

## T3 · The floor-plan instrument (AZ scope)

**Files:**
- Create: `src/app/world/dock/FloorPlanHeader.tsx` + test:
  ```ts
  export interface FloorPlanHeaderProps { azId: string }
  ```
  Miniature isometric SVG from the SAME `floorLayout` plan the floor renders (import its
  existing plan builder — read `az/floorLayout.ts` for the exact export; scale to ~372×96).
  Cabinet/pod polygons (`data-testid="minimap-cab"` / `"minimap-pod"`): pod click →
  `setSelectedServerId(podServerId)`; cabinet click → select its lowest-`unit` resident server;
  `sel` class (hud stroke + glow) on the shape containing the current selection; hover
  brighten. Headline `<AZ label> · N rps in · <price>$/mo</price>`. Dark-scene chrome.
- Create: `src/app/world/dock/AzConfigTab.tsx` + test — per D5:
  hatched `azsec` section rails; rack capacity wells (fill = `rackUsedU/capacityU`, U-notch
  overlay, caption `label · used/capU`, `data-testid="rack-well"`); dashed `+ rack` ghost well
  (addRack; hidden while running); slat rows (`data-testid="dock-slat"`): health LED (ONE
  blink budget — busiest by live mean CPU, running only; reuse the floor's ranking shape),
  name, blueprint accent ticks (the floor's `accentsByServer` derivation — extract it into a
  shared pure helper `serverAccents(doc, compiled): Map<ServerId, string[]>` in
  `src/app/world/az/floorData.ts` or alongside, and make DatacenterFloor consume the same
  helper), meta `kind · healthWord(...)` (derived.ts) at runtime / `kind` at rest, hover
  shunt `translateX(4px)`, click → select; AZ cost row (byAz, price token); action row
  `+ server` (floor toolbar's exact preset dispatch) / `auto-arrange` / `kill AZ`
  (setOutage az kill/restore pair, run-only). Edit-locks per Global Constraints.
- Modify: `WorldPanel.tsx` — az scope renders FloorPlanHeader + AzConfigTab under Config.

## T4 · The faceplate + drawer spine (authoring posture)

**Files:**
- Create: `src/app/world/dock/Drawer.tsx` + test — the generic accordion drawer:
  ```ts
  export interface DrawerProps {
    accent: string                    // left-border color
    title: string                     // 'HARDWARE' | ...
    readout: ReactNode                // the pv — always visible
    open: boolean
    onToggle: () => void
    children: ReactNode
  }
  ```
  Tri rotate 0.18s; body `max-height 0→340px` + opacity + padding,
  `0.26s cubic-bezier(0.3, 0.8, 0.3, 1)`; reduced motion → no transition.
  `data-testid="drawer"` + `data-open`.
- Create: `src/app/world/dock/ServerFaceplate.tsx` + test — plate (screws, name, KIND chip,
  price token, sub-line rack·slot·health, posture line), vitals rail (pulse + cpu/ram/io
  gauges via `useServerDisplayMetrics`; captions idle/live), drawer spine state
  (`openDrawer: 'hw' | 'fw' | 'svc' | 'pl' | null`, default `'hw'`, one-open), action row
  (`enter board ⏎` only when scope came from AZ selection — prop `showEnter: boolean`;
  kill/restore = InspectorV2's exact pattern; `remove…` two-step confirm → `removeServer` +
  `setSelectedServerId(null)`, edit-locked). PCB-dot body background (scene chrome).
- Create: `src/app/world/dock/drawers/HardwareDrawer.tsx`, `FirewallDrawer.tsx`,
  `ServicesDrawer.tsx`, `PlacementDrawer.tsx` + tests — bodies + pv builders per spec D6:
  - Hardware: preset-ladder knobs. Add to `src/lib/world/instanceCatalog.ts`:
    ```ts
    export function presetLadder(kind: ServerKind): InstancePreset[]   // filtered by kind, sorted vcpu then ramMb
    ```
    Knob commit = `updateServer(id, { catalogId, specs: { ...p.specs }, hourlyUsd,
    oversubscriptionRatio, burstable })`. Consequence hints via derived.ts
    (`hostRpsCapacity`; RAM headroom = `(ramMb − Σ resident ramBaseMb) / ramPerConnMb`,
    guard ÷0 → `—`). pv: `${vcpu}c · ${ramGb}G`.
  - Firewall: sentences via `server/ruleSentence.ts` helpers (import, don't re-derive);
    `Let`/`Block` colored; `+ rule` appends createServer's default rule shape via
    `updateServer(id, { firewall: [...] })`; muted `edit rules on the board` hint.
    pv: `N allow · M deny`.
  - Services: chip lines per placement on this server (blueprint color swatch, name,
    `:port · role`, `− +` steppers `updatePlacement(id, { count })` clamp ≥1);
    `+ mount a blueprint…` → blueprint select → `addPlacement`. pv: first placement
    `name ×count · role`, else `n services` / `—`.
  - Placement: InspectorV2's rack `<select>` relocated byte-for-byte
    (FREE_POOL_VALUE, canAssign disabling, assignServerToRack). pv: `rack · slot N` /
    `free pool`.
- Modify: `WorldPanel.tsx` — server scope Config = ServerFaceplate (+ drawers).
- Modify: `src/app/world/InspectorV2.tsx` — retire the selected-server pane: props back to
  `{ azId: AzId }`, traces-only render. Modify `DatacenterFloor.tsx` to stop passing
  selection props to it (floor selection still drives highlight + the dock).
- Update: `InspectorV2.test.tsx` — rack-selector/price/enter/kill tests MIGRATE to the
  faceplate/PlacementDrawer test files (same assertions, new mount); InspectorV2 keeps its
  traces + render-nothing tests.

## T5 · Watching mode (the spine re-voices)

**Files:**
- Modify: T4's faceplate + four drawers — `running` posture per D7: watchband, pv re-voicing
  (`31% cpu · 42% ram` success-colored; `≈N req/s allowed`; `name · p50 X ms`), HW body live
  rows + frozen knobs (opacity 0.55, hidden thumb, live-fill track, title
  `locked while running`), SVC live rows (per-instance health · rps), pulse 2.2s
  (`data-testid="vitals-pulse"` + `data-live`), kill lights up, remove/+ lock.
  Live numbers: server cpu = mean(coreUtilization), ram = ramUsedMb/ramTotalMb, io =
  diskIoFraction, server rps = Σ InstanceMetrics.rps of `compiled.instances` on this server.
  Scrub posture: `scrubBatch ?? latestBatch` (the app-wide read).
- Tests: seed `useSimulationStore.setState({ running: true, latestBatch })` (wrap in `act`) and
  assert pv re-voicing, frozen knob, watchband, kill enablement; scrub-batch variant.

## T6 · Timeline v2 (swimlanes + narration; replaces the glyph strip)

**Files:**
- Create: `src/app/world/region/timelineModel.ts` + `timelineModel.test.ts` (node env) — pure:
  ```ts
  export interface TimelineBand { startMs: number; endMs: number; state: HealthState }
  export interface TimelineMarker { event: EngineEvent; cls: 'kill' | 'hc' | 'shift' | 'promote' | 'other' }
  export interface TimelineLane { azId: string; label: string; serverCount: number; bands: TimelineBand[]; markers: TimelineMarker[] }
  export const TIMELINE_WINDOW_MS = 120_000
  export function markerClass(kind: EngineEventKind): TimelineMarker['cls']
  // outage_triggered→kill · health_check_failed→hc · failover_started/failover_completed/ttl_lag_expired→shift · replica_promoted→promote · else other
  export function buildLanes(regionId: string, doc: WorldDoc, compiled: CompiledWorld,
    events: EngineEvent[], frames: ReplayFrame[], endMs: number): TimelineLane[]
  // bands: merge consecutive frames with equal batch.azs[azId].health (healthy|degraded|down); markers via regionEvents-scoped events assigned to the lane whose closure contains an affected id (fallback: first lane)
  export function narration(regionId: string, doc: WorldDoc, compiled: CompiledWorld,
    events: EngineEvent[]): { text: string; chain: EngineEvent[] } | null
  // last kill/detection cluster → subsequent shift → promotion, per spec D8 guarantee 4; null when no chain
  export function causalLinks(lanes: TimelineLane[], chain: EngineEvent[]): { fromId: string; toId: string }[]
  // consecutive chain steps in DIFFERENT lanes
  ```
- Create: `src/app/world/region/TimelineV2.tsx` + test (jsdom) — lanes/bands/markers/tooltips/
  axis/legend/narration bar per the round-1 mock §3 (incl. dotted causality arrows as an
  absolutely-positioned SVG overlay); click-to-scrub = TimelineStrip's exact nearest-frame
  logic (disabled while running, same titles); band colors `#22c55e22/#f59e0b22/#ef444426`
  families via tokens where they exist. ZERO ambient animation.
- Modify: `src/app/world/RegionView.tsx` — mount TimelineV2 where TimelineStrip was (keep the
  AlertRibbon scroll/flash wiring).
- Delete: `src/app/world/region/TimelineStrip.tsx` + `TimelineStrip.test.tsx` (assertions that
  still apply — scrub click, running-disabled — migrate into TimelineV2's test).

## T7 · Globe traffic placement mode

**Files:**
- Create: `src/lib/world/cityCatalog.ts` + test (node env):
  ```ts
  export interface WorldCity { name: string; lat: number; lon: number }
  export const WORLD_CITIES: readonly WorldCity[]   // ~48, all continents, real coords
  export function nearestCity(lat: number, lon: number): WorldCity   // greatCircleKm argmin
  ```
- Modify: `src/lib/world/routing.ts` — extract `regionOrderFor` per spec D9 (exported;
  computeRouting delegates). **`routing.test.ts` passes unmodified** + add a parity test
  (regionOrderFor(pop) === computeRouting's order for that pop).
- Modify: `src/app/world/ui/derived.ts` + test — add:
  ```ts
  export const PLACEMENT_BYTES_EACH_WAY = 2048   // pure reimplementation of the engine's BYTES_PER_REQUEST_EACH_WAY (flows.ts) — never imported
  export function placementEgressUsdPerHr(rps: number): number
  ```
- Create: `src/app/world/globe/TrafficPlacementLayer.tsx` — r3f GlobeScene child, active only
  when `placeMode`: transparent raycast sphere (radius ~1.0005) with onPointerMove →
  `vec3ToLatLon` → `nearestCity` snap → ghost state; renders dashed crosshair ring at the city
  (2s blink; static under reduced motion), Html preview card (`<city> · would send 500 rps →
  lands on <region catalogId> · N ms · <price>+$X.XX/hr egress</price>`; landing via
  `regionOrderFor`; no-regions copy per D9), one static dashed ghost arc
  (`greatCirclePoints` + LineDashedMaterial, NO per-frame updates). It does NOT handle click —
  the Earth's existing placeMode click commits (no double-path). NOT jsdom-tested (WebGL);
  live smoke is the gate; the card MATH is tested via the pure helpers above.
- Modify: `src/app/world/GlobeView.tsx` — HUD `+ traffic` button next to `rotation:` (armed
  label `+ traffic — click a city`, hud mode styling, `disabled={running}` +
  `stop the simulation to edit`, `esc = cancel` hint while armed; new props
  `onTogglePlaceMode: () => void` threaded from WorldShell); `onPlace` snaps:
  `const city = nearestCity(lat, lon)` → `addPopulation(city.name, city.lat, city.lon)` →
  exit mode → `onPopulationPlaced(id)` → `setSceneOverlay({ kind: 'population', id })`;
  GlobeScene `autoRotate` gains `&& !placeMode`; mount TrafficPlacementLayer.
- Modify: `src/app/world/WorldShell.tsx` — keydown: `Escape` disarms placeMode (before
  `nav.up()`); pass `onTogglePlaceMode` to GlobeView.
- Update: `GlobeView.test.tsx` — button states (rest/armed/running-disabled), snap-on-place
  behavior (mock onPlace path), esc disarm.

## T8 · Sweep + gate

- Motion audit: at rest with the sim stopped, `getAnimations()` across dock/timeline/globe HUD
  shows ONLY the ratified exceptions (faceplate pulse; ghost blink if armed). Per-dock: exactly
  one ambient stroke under load. Reduced-motion: zero.
- Emoji scan (`grep -rnP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' src/` modulo the sanctioned
  glyph list), price-token audit (every `$` render), singular/plural audit on new copy.
- Both themes: light-mode pass over every new surface (instrument headers exempt per D3/D11).
- `docs/module-boundaries.md`: new `dock/` module section (files, boundaries, who may import
  scope.ts), InspectorV2 pane retirement, TimelineStrip → TimelineV2, routing.ts refactor note,
  motion-inventory additions (atlas arc, dock LED, faceplate pulse + exception, ghost blink +
  exception, timeline zero).
- Full suite + `npm run build` green. Ledger closed with `## POLISH 4 COMPLETE`.

---

## Task order & parallelism

T1 → (T2, T3, T6, T7 in any order; T4 → T5) → T8. T2/T3/T4 all touch `WorldPanel.tsx` — run
them sequentially or rebase carefully (WorldPanel is the hub file this phase; see
module-boundaries).
