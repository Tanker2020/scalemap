# Phase 4: Region Flow Page + Rack Chassis — Design

**Date:** 2026-07-09 · **Status:** Approved direction (umbrella spec §5 Levels 2–3 / §9
row 4; user approved the mockup "This looks incredible I love it" — it is binding).
**Binding companions:** umbrella `2026-07-08-world-model-multiscale-simulation-design.md`,
FROZEN `2026-07-08-world-engine-contracts.md` (NO amendment this phase — see D2), approved
mockup `docs/superpowers/specs/mockups/views-overview-v2.html` (Level-2 region page and
Level-3 rack chassis panels; the Level-1 globe panel is Phase 5's, ignore it here),
Phase-3 open items (carry-forwards absorbed in D10).

## Goal

Replace the Phase-1 placeholder `RegionView` with the Level-2 flow story — global-edge
inbound → animated split lines with per-AZ shares → AZ rows (health ring, clickable server
strips, rps/p50/err/$) → cross-AZ column — with one alert ribbon, a failover timeline, and
per-AZ outage switches. On the Level-3 AZ canvas, servers become realistic rack chassis
stacked inside per-rack frame groups (rails, drive-bay LEDs, vent grills, status LEDs,
live cpu/ram/io micro-bars, blank-U fillers, PDU strip). Zero engine changes.

## Engineering decisions (within the umbrella's envelope)

1. **Region page architecture: flex flow, no canvas.** A horizontal flex composition
   (mockup layout): fixed inbound column (~120px) → fixed SVG split-lines column (~90px,
   height driven by the AZ stack) → AZ rows (flex 1) → fixed cross-AZ column (~130px).
   Alert ribbon full-width above the flow; failover timeline full-width below it. All data
   from `scrubBatch ?? latestBatch` + `events` + `doc`/`compiled` — the page is fully
   scrub-aware and renders a meaningful static state when nothing has run (counts, strips
   from doc, rings at "—").
2. **No engine changes; region render payload stays empty.** The mockup's split lines are
   animated dashed SVG strokes whose *widths/percentages* come from the 1 Hz metrics batch
   (per-AZ rps shares) — per-particle rendering adds nothing at this zoom. The engine's
   `attachRenderer({level:'region'})` continues returning empty-but-valid payloads
   (comment updated to say Phase 5+ may claim it for arc-adjacent effects). The frozen
   contracts need NO amendment this phase.
3. **Pure region-data module.** `src/app/world/region/regionData.ts` (unit-tested) derives
   everything the page renders: `azShares` (per-AZ fraction of region rps, down AZs
   pinned to 0 with a `down` flag), `ribbonAlert` (most-severe warning/critical event
   affecting the region scope within the last 30 sim-seconds, formatted mockup-style with
   redistribution target labels and the DNS-TTL note when a `ttl_lag_expired` is pending),
   `regionEvents` (events whose `affected` intersects the region, its AZs, its servers, or
   populations currently routed to it), `replicationPairs` (stateful blueprints with a
   primary instance in one AZ and replicas in another → `{blueprintName, fromAzId, toAzId,
   linkDown}`), and `sparklineSeries` (last 60 replay frames' region rps via
   `getReplayFrames()`, polled at 1 Hz while running — same polling pattern as
   InspectorV2).
4. **AZ rows (mockup center).** Health ring = SVG arc of `AzMetrics.healthScore` colored
   by health state, score numeral centered; label + `<n> srv · <m> svc`; server strips =
   one thin bar per server in the AZ (height = mean `coreUtilization`, top border =
   dominant blueprint signature color on that server, tooltip = server label) — strip
   click navigates `goServer(regionId, azId, serverId)`, row click (anywhere else)
   navigates `goAz`; right column = `rps · p50` and `err% · $<n>/mo` (per-AZ dollars from
   `costModelV2`'s existing per-AZ breakdown). Down AZ rows dim, red left border, and
   swap the strips for the drain line: `draining → <healthy AZ labels>` plus `replicas
   promoting` when a `replica_promoted` event hit this AZ's servers in the last 30s.
   Each row carries its own outage switch (⚡, running-gated like the existing region
   one) calling `setOutage('az', azId, !down)`. The mockup's `recovery in 41s` is NOT
   built — recovery timing isn't exposed by the engine (parked, needs an engine surface).
5. **Cross-AZ column.** One entry per AZ pair that shares at least one cross-AZ compiled
   path or replication pair: `1a ⇄ 1b` + the engine's cross-AZ hop latency constant
   (imported from `src/lib/worldEngine/latency.ts` — a pure constants module, permitted
   lib import) + replication lines (`<blueprint> repl`); a pair with either AZ down
   renders `✕ link down`. Numeric replication *lag* is NOT rendered — it isn't modeled;
   inventing a number would be fake telemetry (parked with D4's recovery timer).
6. **Failover timeline.** `TimelineStrip` under the flow: region-scoped events (D3's
   `regionEvents`) on a horizontal simMs axis covering the last 120 sim-seconds
   (auto-scrolling while running), glyph + color per kind/severity, hover tooltip with
   message + relative time. When STOPPED with replay frames available, clicking an event
   calls `setScrubIndex` with the frame nearest its simMs — the whole app (region page
   included) then shows that moment; an `Exit scrub` affordance already exists in
   ScrubberV2. The ribbon's `timeline` link scrolls/flashes the strip.
7. **Rack frames on the AZ canvas.** Servers group by `server.rack.rackId` into rack
   frame nodes (React Flow parent nodes; chassis are child nodes with `parentId` +
   `extent: 'parent'`, `draggable: false`). A pure `layoutRacks(servers, managedIds)`
   module (unit-tested) replaces `layoutAzGrid` for the AZ canvas: frames side by side,
   chassis stacked inside by `rack.unit` (chassis height = `rack.heightU × U_PX`,
   `U_PX = 44`), blank-U filler strips between occupied units, PDU strip at the frame
   bottom, managed services in a separate column right of the frames. Frame chrome per
   mockup: side rails with mounting-hole dot pattern, `RACK <id> · <az label>` caption.
8. **Chassis visuals (replaces WorldServerNode).** Header `label · <heightU>U · kind ·
   <vcpu>vCPU/<GB>G` + status LEDs (pwr = health color; act = blinks with rps activity on
   the server's instances, static under reduced motion; net = lit when NIC utilization
   > 5%); body row = drive bays (count = `2 × heightU + 2`, capped 8, activity LEDs lit
   in proportion to `diskIoFraction`), vent grill, cpu/ram/io micro-bars from
   `ServerMetrics` (blue/amber/teal). A degraded/noisy server shows the mockup's amber
   `▲ noisy neighbor` tag when a `noisy_neighbor` event hit it within 30s. Blocked-path
   badge and click→`goServer` behavior carry over from today's node. Managed nodes keep
   their dashed style unchanged.
9. **AzSimOverlay v2 (forced by racks).** Child-node positions are parent-relative in
   React Flow, so the overlay's `getNode().position` math breaks inside frames: switch to
   `getInternalNode(id).internals.positionAbsolute` and use measured node dimensions
   (fallback to constants pre-paint). Also fixes two carried Minors: read the viewport
   imperatively inside the draw callback (`getViewport()`) instead of keying the effect
   on `useViewport` — kills the re-subscribe churn on pan/zoom — and drop the fixed
   `SERVER_H` for variable chassis heights.
10. **Phase-3 carry-forwards absorbed here:** (a) managed-service provider:
    `world.store.addManagedService` gains a `provider` parameter, the authoring UI gets a
    provider select defaulting to `'aws'` (so new managed services actually price;
    `'generic'` stays available), costModelV2 test covers the authored path; (b) memoize
    `ServerBoard`'s derived values; (c) falsy-zero coalescing in inspector numeric fields
    (port/cpuLimit/memLimit `0` handled by explicit null/NaN checks, not `||`);
    (d) gate blocked/s counter reads the *display* batch's simMs so it's scrub-correct;
    (e) `PacketLayer` gets a linear-interpolation fallback if `getPointAtLength` throws
    (WebKit/Tauri insurance).
11. **Perf + motion.** The region page re-renders at most at 1 Hz (batch) + event pushes;
    split-line dash animation is pure CSS/SVG (`prefers-reduced-motion` → static dashes);
    timeline capped at the event ring (500); rack chassis are plain DOM nodes — no new
    per-frame work. The AZ overlay keeps its existing caps.

## Testing & verification

Unit: `regionData` (shares/ribbon/replication/event scoping — fixture doc + synthetic
batch/events), `layoutRacks` (grouping, unit stacking, heights, filler/PDU boxes, managed
column, determinism). Component (jsdom): RegionView (rows render per AZ, down-row drain
line, outage switch dispatch, strip navigation), TimelineStrip (event glyphs, scrub click
→ setScrubIndex), RackChassisNode (LEDs/micro-bars from metrics, noisy tag). Live
Playwright smokes per UI task, and a phase-gate story: 2-AZ region under load → region
page shows split shares and $ figures → kill 1b via its row switch → ribbon appears,
splits re-share to 1a, down row shows drain line, timeline logs
outage/health/failover events → stop → click a timeline event → app scrubs to that moment
→ AZ canvas shows rack frame with chassis LEDs/micro-bars live → click chassis → server
interior opens. Zero console errors.

## Out of scope (unchanged from umbrella)

r3f globe (Phase 5), analysis + LLM reviewer (Phase 6), replication-lag and
recovery-countdown modeling (parked — engine surfaces don't exist), region-scope engine
particles (D2), k8s/ECS.
