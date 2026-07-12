# Polish 4 — Contextual Dock, Drawer Config, Timeline v2, Globe Traffic Mode (Design)

**Date:** 2026-07-11
**Status:** LOCKED — all four designs user-ratified (rounds 1–2, 2026-07-11)
**Binding mockups (visual truth, committed):**
- `docs/superpowers/specs/mockups/polish4-dock-v2.html` — §1 three dock instruments, §2 drawer
  config surface (interactive), §3 timeline (carried), §4 globe-traffic pointer. **Binding for
  the docks and drawers.**
- `docs/superpowers/specs/mockups/polish4-round1-locked.html` — §3 timeline (WITH the causality
  arrows the v2 re-render dropped) and §4 globe traffic mode (full mock). **Binding for the
  timeline and globe traffic.** Its §1–§2 (dock/config) are SUPERSEDED by v2 — ignore those two
  sections visually; their *laws* (scope rail grammar, tab scoping, one-state-two-surfaces,
  authoring↔watching) still bind and are restated below.

Predecessor context: Polish 1–3 are merged to main (`34742c2`); this spec builds on the Polish 3
level redesign (isometric floor, dock v2 signature headers) and the two post-merge fix waves
(idle-static motion law, floor camera, sim edit-lock, outage-reset-on-stop, per-server floor
identity, globe red-out, app-wide emoji purge, price token).

---

## 0 · What Polish 4 is

Four user-locked designs, one theme: **the dock watches where you are.**

1. **Contextual dock, three instruments** — the right-hand dock scopes itself to nav + selection
   and *wears the skin of the level it watches*: an **atlas** at world/region scope, a **floor
   plan** at AZ scope, a hardware **faceplate** at server scope. Only the scope rail is shared.
2. **Drawer config surface** — the server's config is a spine of four drawers
   (HARDWARE / FIREWALL / SERVICES / PLACEMENT) with always-visible one-line readouts, one open
   at a time, that **re-voice into live gauges while the simulation runs**.
3. **Failover timeline v2** — the region's cryptic glyph strip becomes swimlanes + state bands +
   a narration sentence ("a git chart for your infra"), with five seamless-integration
   guarantees (§D8).
4. **Globe traffic placement mode** — "+ traffic" arms a mode where the cursor snaps to real
   cities, a preview card answers "what will this do" before the click, and a ghost arc shows
   the route immediately.

Everything is view-side. The engine (`src/lib/worldEngine/`) and the compiled-world contract are
**frozen** for this phase (§D10).

---

## D1 · Scope model — derived, not stored

**The law (round 1, verbatim): scope = where you are + what you selected.** Navigating sets the
scope; selecting narrows it; any scope-rail pill widens back; `world` is always one click.
There is no "global vs local mode" — the dock simply follows.

- **One new store field, additive:** `ui.store.ts` gains
  `selectedServerId: ServerId | null` + `setSelectedServerId(id)`. This LIFTS the floor's
  existing local `selectedServerId` (`DatacenterFloor.tsx:66`) into shared state — "floor
  selection and dock scope are the SAME state; select there, configure here." No other new
  store, no new store file. `nav.store.ts` is untouched (it stays dependency-free).
- **Scope is derived, never stored** (no sync code to get wrong): a pure
  `deriveScope(nav, selectedServerId, doc): DockScope` in a new `src/app/world/dock/scope.ts`:
  - `nav.level === 'server'` → server scope (nav.serverId)
  - `nav.level === 'az'` + a selected server that still exists in `doc.servers` and belongs to
    this AZ → server scope (selection)
  - `nav.level === 'az'` → az scope
  - `nav.level === 'region'` → region scope
  - else → world scope
  Stale/foreign selections (deleted server, server from another AZ) are ignored, not crashed on.
- **Selection lifecycle:** WorldShell clears `selectedServerId` whenever `nav.level` or
  `nav.azId` changes (one effect). Removing the selected server clears it too (guard in the
  faceplate's remove action).
- **Scope rail** (shared chrome, identical at every scope): breadcrumb pills
  `world ▸ us-east-1 ▸ us-east-1b ▸ db-replica`, the current scope pill lit (`here` state —
  hud color, `#7cffe910` fill, hud-dim border). Pill clicks: `world` → `goGlobe()`;
  region pill → `goRegion(id)`; az pill → if nav is already at this AZ just
  `setSelectedServerId(null)` (widen without re-navigating), else `goAz(...)`. Pills reuse
  existing nav dispatches byte-for-byte — the rail is a restyled Breadcrumb, not a second
  navigation system (the header Breadcrumb stays; they read the same store).

## D2 · Tab law under scope

- **World scope = exactly today's dock.** All seven tabs (Topology, Blueprints, Placements,
  Traffic, Analysis, Events, Cost), all existing panel components, all existing dispatches.
  Nothing is lost — the global view is the widest pill, not a separate mode.
- **Region / AZ / server scope = four tabs: Config, Analysis, Events, Cost.**
  - **Config** — the focused entity's own surface (D4/D5/D6). Replaces Topology below world
    scope: the world tree IS world-scope config.
  - **Analysis** — findings whose `affected` ids intersect the scope's entity closure (the
    entity + its descendants: region → its AZs/servers/instances; server → itself + its
    instances). The tab badge count follows the scoped count.
  - **Events** — engine events filtered to the scope's closure (generalize `regionEvents`'s
    id-closure approach; region scope uses `regionEvents` itself, unchanged).
  - **Cost** — the scope's own rollup in the price color: region/AZ from
    `computeWorldCost().byRegion/byAz`; server = `hourlyUsd` (×730 for monthly). **Server-scope
    egress: not shown** — the cost model attributes egress at AZ/region/world level only; the
    server Cost tab renders compute cost plus one muted line "egress is attributed at the AZ
    level" (documented deviation from the round-1 mock's per-server egress row, which the model
    cannot honestly produce).
- **Blueprints / Traffic / Placements are world-only** (inherently global); at narrower scopes
  they fold into the world pill rather than showing global data in a local frame.
- **Tab persistence across scope changes:** if the active tab id exists at the new scope
  (analysis/events/cost do everywhere), keep it; otherwise land on the new scope's first tab
  (Topology at world, Config elsewhere).
- Edit-lock law carries: every Config surface's authoring controls sit inside the existing
  `<fieldset disabled={running}>` pattern or per-control `disabled={running}` with title
  `stop the simulation to edit`; run-only controls (kill) invert with
  `start the simulation to break things`.

## D3 · Three instruments, one rail

**The rule (locked): the dock wears the skin of the level it's watching** — layout, texture, and
motion all change; the change itself tells you where you are.

| Scope | Instrument | Signature header | Body | The ONE ambient stroke |
|---|---|---|---|---|
| world | **ATLAS** | constellation SVG: graticule, region nodes, population dots, traffic arcs, live headline | today's seven tabs | 1 marching arc (top route, running only) |
| region | **ATLAS, scoped** (§D4) | same constellation, this region's node ringed/lit | Config/Analysis/Events/Cost | same single arc rule |
| az | **FLOOR PLAN** | clickable isometric minimap of the actual floor | Config/Analysis/Events/Cost | 1 blinking LED (busiest server, running only) |
| server | **FACEPLATE** | screwed-on name plate | vitals rail + drawer spine | 1 breathing pulse (ratified idle exception) |

**What stays identical everywhere:** the scope rail, the tab names, the price color, the
edit-lock law. Skins differ; grammar doesn't.

**Region scope rides the atlas** — this is the one scope the mockups did not draw (they mock
world/az/server); it is deliberately the atlas instrument scoped down: the constellation
highlights this region's node (hud ring), the headline reads
`us-east-1 · 980 rps · $1.61/hr`, and the Config tab lists this region's AZs. No fourth skin.

**Motion budget per dock: ONE ambient stroke**, and the idle-static law
(post-Polish-3 fix wave) still governs it:
- **Atlas arc** marches (`dashflow`, 1.2s linear) only while the sim is running AND that route
  carries rps > 0 AND not reduced-motion. At rest, arcs render static at low opacity (they are
  compile-derived route previews, not motion). At most 1 marching + 2 static arcs.
- **Floor-plan LED** blinks only for the single busiest server by live CPU (the floor's
  `MAX_ANIMATED_LEDS` ranking logic with a budget of 1) — running only.
- **Faceplate pulse** breathes at 3.6s idle / 2.2s under load. The idle breathe is a
  **user-ratified bounded exception** to the static-at-0-rps law (the "it's alive" heartbeat —
  its RATE is the signal), same standing as the board's hardware chrome exception: one element,
  a 6px dot, disabled under reduced motion. Document it in the motion inventory.
- Everything else in every dock is hover-reactive only (slat shunt, row hover, pill hover).

**Instrument header chrome & themes:** the three instrument headers (constellation, minimap,
plate) are *scenes*, and follow the board InspectorRail precedent — they keep their
dark-scene palette in both themes (the mock's `#0d1420`-family navy for the atlas,
`#11150f`-family for the floor plan, `#242c38` plate metal), applied via scoped constants with
a comment citing this decision. Everything BELOW the header (tab bar, body rows, drawers,
buttons) uses `var(--color-*)` tokens exclusively and must look right in both themes. Dock
border/background tints per instrument (`#21344a` / `#2c3a2e` / `#333d4d` borders) count as
scene chrome. No emojis anywhere (app law); glyphs like `▸ ✕ ⇄ ⬆ ♺ ¤ ⌬` are fine.

## D4 · The atlas (world + region)

Per the v2 mock's `.dock.w`:

- **Constellation header** (`372×92`-proportioned SVG, width 100%): 6 static graticule paths
  (`#16283d`, 0.6px); one dot per region at its `REGION_GEO` metro projected equirectangular
  (helpers in the atlas component; lat range clamp ~[-60, 75]); dot fill = live health color
  (batch region health; success/warning/danger; drop-shadow glow, red glow for down — matches
  the globe's red-out law), authored-but-not-running worlds show success dots. 2px hud
  population dots. 8px region labels (`#8fb3e0`).
- **Arcs**: population→landing-region quadratic curves. Landing comes from
  `populationLanding` (rest) or `batch.world.populationRoutes` (running). Top route by rps gets
  `.live` (marching, per D3); the next two render static at 0.35 opacity; cap 3 total.
- **Headline** (bottom-left, text-shadowed): world scope mirrors the two postures of today's
  WorldSummary — at rest `N regions · M servers · baseline X rps`; running
  `Handling <b>N rps</b> from M cities · <price>$X/hr</price>` (+ p50 if it fits). Region scope:
  `<catalogId> · N rps · <price>$X/hr</price>`. The old WorldSummary strip is ABSORBED by the
  atlas headline (it does not render twice).
- **World body**: the existing seven panels unchanged. TopologyPanel gets the mock's `wtree`
  left-border region-row reskin (2px `#21344a` left border, hud on hover, rps right-aligned in
  hud, meta line with price) — **styling only, every dispatch preserved** (relocated-dispatch
  contract).
- **Region Config tab** (new, small): this region's AZ rows (health dot, label, server count,
  live rps; click → `goAz`) + `+ az` button (TopologyPanel's exact `addAz` dispatch,
  edit-locked while running).

## D5 · The floor plan (AZ scope)

Per the v2 mock's `.dock.az`:

- **Minimap header** (~96px): a real, clickable miniature of the SAME floor — cabinets and
  free-pool pods from the SAME `floorLayout` plan the DatacenterFloor renders, drawn as small
  isometric polygons. **The minimap is the selection surface, not decoration:** tapping a pod
  selects that server (shared `ui.store.selectedServerId` — it selects "out there" on the floor
  too, and flips the dock to the faceplate); tapping a cabinet selects its lowest-unit resident
  server (a useful landing; refine via the slat rows). The cabinet/pod containing the current
  selection renders `sel` (hud stroke + glow). Hover brightens. Headline top-left:
  `US-EAST-1B · 425 rps in · <price>$352/mo</price>`.
- **Body — Config tab**:
  - `RACKS — capacity wells` section (hatched `azsec` divider rails: the
    `repeating-linear-gradient` industrial stripe). One 34px well per rack: teal fill height =
    `rackUsedU/capacityU`, U-notch overlay (the `::after` rung stripes), `rack-1 · 2/8U` caption.
    A dashed ghost well = `+ rack` (existing `addRack` dispatch; hidden while running, same as
    the floor's ghost rack).
  - `SERVERS — tap = select on floor` section: one slat row per server (racked first, then free
    pool): health LED (live health color; the ONE blink per D3), name, blueprint accent ticks
    (the floor's exact `accentsByServer` derivation), meta `kind · healthWord` (derived.ts's
    `healthWord` from live cpu/ram fractions; plain kind at rest). Hover: `translateX(4px)` +
    teal border (hover-reactive, allowed). Click → select.
  - `THIS AZ'S COST` row: `computeWorldCost().byAz` entry, price-colored, `$/hr · $/mo`.
  - Action row: `+ server` (the floor toolbar's exact addServer dispatch/preset),
    `auto-arrange` (`autoArrangeAz`), `kill AZ` (danger; `setOutage('az', azId, …)`,
    kill/restore pair, run-only). Edit-locks per D2.

## D6 · The faceplate + drawer spine (server scope)

Per the v2 mock's `.dock.sv` and §2 (both postures):

- **Plate header**: brushed-metal gradient bar with four corner screws (5px inset-shadow dots),
  server name (13px), `KIND` chip (bordered, blue family), price right-aligned in
  `var(--color-price)`; sub-line `8c / 32G · rack-1 slot 3 · <health>` (rack text from
  `Server.rack`, `free pool` when null; health = live health color word while running,
  omitted/`—` at rest). Posture line while running: `running — watching · stop to edit`
  (warning color); at rest `stopped — authoring · everything editable` (muted).
- **Body layout**: PCB texture (`radial-gradient(#ffffff06 1px, transparent 1px)` 22px grid) —
  scene chrome, D3. Left: **vitals rail** — pulse dot (D3 exception) + three 44px vertical
  gauges cpu (blue) / ram (amber) / io (teal), fill heights from live `ServerMetrics`:
  `mean(coreUtilization)`, `ramUsedMb/ramTotalMb`, `diskIoFraction` (reuse
  `useServerDisplayMetrics` — it already handles scrub/latest); caption `vitals`/`idle`/`live`.
  Right: the **drawer spine**.
- **Four drawers** — HARDWARE (blue left-accent) / FIREWALL (amber) / SERVICES (violet) /
  PLACEMENT (teal). Each is `border-left-width: 2px` accent, rounded, with:
  - a full-width header button: `▸` tri (rotates 90° when open, 0.18s), letter-spaced title,
    and the **`pv` readout** — the drawer's one-line summary, right-aligned, tabular-nums,
    **always visible when closed** ("closed ≠ hidden": the spine is a complete summary at a
    glance).
  - a body that slides open: `max-height` 0→340px + opacity, `0.26s cubic-bezier(0.3,0.8,0.3,1)`
    (the mock's exact easing). **One open at a time** — opening one closes the others; clicking
    the open one closes it. Default open: HARDWARE. Reduced motion: instant open/close.
- **HARDWARE** (authoring): pv `8c · 32G` (+ ` · <kind>` in the wide variant). Body: two
  spec knobs (vCPU, RAM) — track + fill + round hud thumb. **Knobs snap across the instance
  preset ladder of the server's kind** (INSTANCE_CATALOG filtered by `kind`, sorted by vcpu
  then ramMb): moving a knob commits the target preset's FULL set —
  `updateServer(id, { catalogId, specs, hourlyUsd, oversubscriptionRatio, burstable })` — so
  the price stays honest (specs and price never drift apart; the plate's price updates live).
  Both knobs drive the same ladder (one by vcpu, one by ram); after a snap both re-render the
  chosen preset. Each knob carries a **consequence hint** (the guided-console grammar):
  vCPU → `→ sustains ~N rps of <blueprint> at X ms/query` via derived.ts `hostRpsCapacity`
  against the server's first resident blueprint (`→ no services mounted yet` when none);
  RAM → `→ headroom for ~N connections at X MB each` from
  `(ramMb − Σ resident ramBaseMb) / ramPerConnMb`.
- **FIREWALL** (authoring): pv `N allow · M deny` (or `N rules`). Body: numbered rule
  sentences — `1 · Let internal traffic reach postgres :5432` / `2 · Block everyone else,
  everywhere` — built with the board's EXISTING sentence helpers
  (`server/ruleSentence.ts`'s `ruleSourceWords`/`rulePortPhrase`; **reuse, do not re-derive
  the grammar**), `Let`/`Block` in success/danger. `+ rule` appends the factory default rule
  (allow · any · internal — `createServer`'s default shape) via `updateServer`; deep editing
  stays on the board (muted hint `edit rules on the board`).
- **SERVICES** (authoring): pv `db ×1 · replica` (first placement summary; `n services` when
  several; `—` when none). Body: one chip line per placement on this server — blueprint color
  swatch, name, `:port · role`, count stepper `− +` (`updatePlacement(id, { count })`, clamped
  ≥1) — plus a ghosted `+ mount a blueprint…` line that expands to a blueprint `<select>` and
  dispatches `addPlacement(blueprintId, serverId)` (PlacementPanel's exact dispatch).
- **PLACEMENT** (authoring): pv `rack-1 · slot 3` (`free pool` when unracked). Body: the
  rack `<select>` **relocated byte-for-byte from InspectorV2** (free pool + per-rack options,
  `canAssign` disabling, `assignServerToRack` dispatch).
- **Action row**: `enter board ⏎` (AZ scope only — at server scope you're already on the
  board; `goServer` dispatch), `kill`/`↺ restore` (danger; InspectorV2's exact `setOutage`
  pattern — disabled while stopped with the standard title), `remove…` (danger; two-step
  confirm, `removeServer` + clear selection; edit-locked while running).
- **InspectorV2 retires its selected-server pane** (returns to traced-requests-only; props back
  to `{ azId }`): with selection scoping the dock, the floor card would be a duplicate surface.
  Its dispatches all move into the faceplate (relocated-dispatch contract). The board's
  `InspectorRail` (per-BoardSelection deep editor) is a different surface and is untouched.

## D7 · Watching mode — the same spine, two postures

While `running` (per §2's right card): **the shape never changes — only its temperature.**

- Amber **watchband** at the top of the spine: `SIMULATION RUNNING — drawers are gauges now.`
- Drawers stay openable; their voices change:
  - **HARDWARE** pv → `31% cpu · 42% ram` in success color (live ServerMetrics). Body: live
    rows — `rps` (Σ `InstanceMetrics.rps` over this server's instances), `ram` etc.; the knobs
    freeze (opacity ~0.55, thumb hidden, title `locked while running`) with the LIVE
    utilization as the track fill behind the frozen value.
  - **FIREWALL** pv → `≈N req/s allowed` (N = the server's summed instance rps). **Documented
    deviation from the mock's `418 allowed/s · 0 blocked`:** the frozen metrics contract
    carries no per-rule or blocked-connection counters, and the engine is frozen — re-voice
    from what is real. Body sentences unchanged.
  - **SERVICES** pv → `<name> · p50 X ms`. Body rows: per-instance `health · rps` live
    (InstanceMetrics), success/danger colored.
  - **PLACEMENT** unchanged (rack select disabled per the existing edit-lock).
- Vitals: gauges live, caption `live`, pulse quickens to 2.2s.
- `kill` lights up (run-only inverse), `remove…` and `+`-controls lock.
- Scrubbing (stopped, scrub batch active) renders the same watching posture from `scrubBatch` —
  the existing `scrubBatch ?? latestBatch` read everywhere.

## D8 · Failover timeline v2 (LOCKED round 1 — "a git chart for your infra")

Replaces `TimelineStrip.tsx`'s glyph strip in RegionView (same mount point, same
AlertRibbon-scroll integration). Visual truth: round-1 mock §3 (including the dotted causality
arrows) — the v2 re-render §3 matches but omitted the arrows; **the arrows are in.**

**Five seamless-integration guarantees (verbatim, binding):**
1. **Markers are REAL engine events** — rendered from the `events` array the store already
   publishes; nothing synthesized or reconstructed.
2. **Bands derive from the same health data the views read** — per-AZ state bands are computed
   from `getReplayFrames()`'s `batch.azs[azId].health` sequence (healthy→ok green,
   degraded→strain amber, down→dead red), the identical field every other view colors by.
3. **Clicking a marker scrubs the replay to that instant** — the existing nearest-frame
   `setScrubIndex` logic (TimelineStrip's `onEventClick`, carried), disabled while running with
   the existing title.
4. **The narration line regenerates from the actual event chain** — a template over the real
   scoped events (kill → detection → shift → promotion), e.g. `What just happened: t=12s you
   killed us-east-1a → health checks failed 3× (t=15s) → traffic shifted to 1b (t=18s) →
   db-replica promoted (t=19s).` Segments appear only when their event exists; manual
   `outage_triggered` voices as "you killed", engine-detected `health_check_failed` as "health
   checks failed"; no events → no narration bar.
5. **The strip is a static render — zero animation cost.** No ambient motion; marker hover
   scale is the only (hover-reactive) transition.

Layout: one **lane per AZ** in the region (label + `N srv` sub-label, right-aligned, 92px
gutter), state **bands** along a 120s window (last 120s of sim time; shorter runs left-pad from
t=0), **event markers** — 16px circled glyphs on the lane at their simMs: manual kill `✕`
(danger), health detection `♺` (warning), traffic shift `⇄` (teal: failover_started/completed,
ttl_lag_expired), promotion `⬆` (violet), everything else a small muted dot `●` — each with a
hover tooltip `t=Xs · <message>`. **Dotted causality arrows** (muted, 1px, dash 3 4, arrowhead)
connect consecutive steps of the narrated chain when they sit in different lanes (kill in lane
A → shift in lane B). Time axis `t=0 … now` under the lanes; legend row below (glyph = meaning,
`band color = the AZ's state · click a marker = scrub there`). Events scoped via the existing
`regionEvents` helper, unchanged.

## D9 · Globe traffic placement mode (LOCKED round 1, verbatim)

Visual truth: round-1 mock §4. **"+ traffic" enters placement mode: the cursor becomes a
crosshair ghost that snaps to the nearest known city; a card previews who would send, how much,
where it lands and at what latency — before you commit. Click places the population and opens
its overlay with the rps slider; a ghost arc previews the route immediately, even with the sim
stopped. Esc leaves the mode.**

- **HUD button**: `+ traffic` next to the existing `rotation:` button on the globe
  (`GlobeView`); armed label `+ traffic — click a city` + hud mode styling; click toggles the
  SAME `placeMode` state WorldShell already owns (TrafficPanel's existing place toggle keeps
  working — two arms, one state; relocated-dispatch). `disabled={running}` with
  `stop the simulation to edit` (placement is authoring). A small `esc = cancel` hint renders
  beside it while armed.
- **City snap**: new pure catalog `src/lib/world/cityCatalog.ts` — `WORLD_CITIES` (~48 major
  cities across all continents, `{ name, lat, lon }`) + `nearestCity(lat, lon)` via the
  existing `greatCircleKm`. The ghost marker renders at the SNAPPED city's coordinates, not the
  raw pointer.
- **Ghost + preview card** (new r3f layer mounted as a GlobeScene child, active only in
  placeMode): pointer-move raycast over the globe → `vec3ToLatLon` (exists in `globe/geo.ts`)
  → snap → dashed crosshair ring at the city (blinks at 2s steps — an authoring-mode
  affordance, ratified bounded exception like a text caret; static under reduced motion) + an
  Html card: `<b>São Paulo</b> · would send 500 rps → lands on <b>us-east-1</b> · 142 ms ·
  <price>+$0.09/hr egress</price>`. 500 rps is `createPopulation`'s real default — the card
  states what the click will actually do; the rps slider comes right after, in the overlay.
  No regions in the world → card says `no regions yet — traffic has nowhere to land`.
- **Exact landing, not an estimate**: refactor `src/lib/world/routing.ts` to extract the
  per-population region-ordering into an exported pure
  `regionOrderFor(pop: Pick<ClientPopulation,'lat'|'lon'>, doc: WorldDoc): RegionId[]`;
  `computeRouting` calls it per population — a **behavior-identical refactor** (routing golden
  tests must pass unmodified). The ghost card and arc use `regionOrderFor(city, doc)[0]`, i.e.
  the compiler's own policy math (latency/geo/weighted/priority all correct). Latency =
  `greatCircleKm / 100` (the existing `POP_LATENCY_KM_PER_MS` convention in derived.ts).
- **Egress price**: new derived.ts helper `placementEgressUsdPerHr(rps: number): number` =
  `egressMonthlyCost('aws', rps × 2048 × 2 × 2_630_000 / 1024³) / 730` — 2048 is a pure,
  commented reimplementation of the engine's `BYTES_PER_REQUEST_EACH_WAY` (flows.ts), same
  never-import-engine-internals rule as `POP_LATENCY_KM_PER_MS`; the month constant and tiered
  rate come from costModelV2/cloudRegistry's existing exports. Rendered in the price color.
- **Ghost arc**: one static dashed great-circle line (hud tint, `stroke-dasharray`-style sparse
  dashes, NO marching) from the snapped city to the landing region while hovering. Removed on
  commit/cancel.
- **Commit**: the EXISTING Earth click → `GlobeView.onPlace(lat, lon)` path, now snapping:
  `const city = nearestCity(lat, lon)` → `addPopulation(city.name, city.lat, city.lon)` (label
  = the city name — no more `pop-N` for globe-placed populations; `nextPopulationLabel` remains
  for TrafficPanel's `+ add`) → exit place mode → `onPopulationPlaced(id)` (TrafficPanel row
  focus, existing) → `setSceneOverlay({ kind: 'population', id })` so the PopulationOverlay
  (rps slider) opens immediately.
- **Mode behavior**: globe rotation pauses while armed (`autoRotate` gains `&& !placeMode`);
  Esc disarms (WorldShell's keydown handles placeMode BEFORE `nav.up()`); navigating away
  disarms (already exists).

## D10 · Frozen contracts (non-negotiable)

- **Zero changes under `src/lib/worldEngine/`** — no new metrics, no new events, no facade
  changes. Every live number in this phase is derived from the published `MetricsBatch`,
  `events`, and `getReplayFrames()` — all already exposed.
- `simulation.store.ts` remains the ONLY caller of the engine facade.
- `compileWorld` output types untouched. The one compiler-adjacent change is D9's
  `regionOrderFor` extraction — pure refactor, byte-identical ordering, golden tests unmodified.
- `world.store.ts` gains NO new actions (everything dispatches existing CRUD);
  `ui.store.ts` gains exactly the selection field; `nav.store.ts` untouched.
- `.scalemap` format untouched (selection/scope are ephemeral view state).

## D11 · App laws carried (all binding)

- **No emojis anywhere.** Glyph characters (`▸ ✕ ⇄ ⬆ ♺ ● ◷ ¤ ⌬ ⏎ ↺ −`) are fine.
- **Every money value renders `var(--color-price)`.**
- **Edit-lock:** nothing added/deleted/moved while running; kill/restore is run-only;
  manual outages reset on stop (already in the store).
- **Motion:** static at 0 rps; one ambient stroke per dock (D3's table); timeline zero;
  ratified exceptions: faceplate pulse idle-breathe, place-mode ghost blink. ALL animation
  respects `prefers-reduced-motion`.
- **Singular-aware copy** (`1 region`, not `1 regions`) — the Polish 3 T7 pattern.
- **Relocated-dispatch contract:** every restyled/moved control reuses its existing store
  dispatch byte-for-byte; new UI never invents a parallel mutation path.
- **Both themes:** token-driven below the instrument headers; headers are documented
  dark-scene chrome (D3).

## D12 · Testing posture

Same as Polish 3: jsdom component tests for every new dock/drawer/timeline component
(scope derivation, rail clicks, tab law, drawer accordion + pv readouts, watching re-voicing,
preset-ladder knob commits, timeline lanes/bands/narration/scrub, city snap + card math);
node-env pure tests for `scope.ts`, `cityCatalog.ts`, `regionOrderFor` (golden parity),
`placementEgressUsdPerHr`, timeline model helpers. R3f layers (atlas SVG is DOM — testable;
the globe ghost layer is WebGL — live smoke gate, like ArcsLayer). Baseline: the existing 615
tests stay green, unmodified except where a surface intentionally moved (InspectorV2 pane
tests migrate to the faceplate's).

## Out of scope (unchanged from the roadmap's parked list)

Watch-mode AI review, packet editor, drag-to-rack on the floor, Option B 3D datacenter (#23),
per-provider egress attribution, per-rule firewall counters (would need engine work), region
dock beyond the scoped atlas.
