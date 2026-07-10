# Phase 5: R3F Globe + Traffic Authoring — Design

**Date:** 2026-07-09 · **Status:** Approved direction (umbrella spec §5 Level 1 / §9 row
5; the mockup's Level-1 globe panel is binding: night-lights earth, atmosphere glow,
health-colored pins, teal population markers, animated great-circle arcs, red drain arcs).
**Binding companions:** umbrella `2026-07-08-world-model-multiscale-simulation-design.md`,
FROZEN `2026-07-08-world-engine-contracts.md` (no type changes — `VisualArc` already
carries `kind: 'client' | 'inter-region' | 'drain'`), mockup
`docs/superpowers/specs/mockups/views-overview-v2.html` (Level-1 panel only).

## Goal

Replace the Level-1 card grid with a real three.js globe (react-three-fiber): NASA
night-lights earth with an atmosphere shader, region pins glowing by health (pulsing on
failover), client populations as teal markers, live traffic as animated great-circle arcs
from the engine's globe payload — including inter-region and red drain arcs the engine
doesn't emit yet. Ship the missing traffic-layer authoring: populations (including
click-the-globe placement), auto-baseline traffic config, and routing policy controls —
none of which currently have UI (the world.store actions exist unused).

## Engineering decisions (within the umbrella's envelope)

1. **Stack + assets.** `three` + `@react-three/fiber@^9` + `@react-three/drei@^10`
   (React-19-compatible majors; verify exact versions against the registry at install
   time). Textures: NASA Black Marble (night lights, the mockup's look) as the globe
   surface, 2048×1024 JPG, bundled under `src/assets/globe/` with a public-domain/NASA
   attribution comment; Blue Marble optional and only if a day-side blend proves trivial —
   night-only is the approved look. Budget ≤2.5MB of committed texture. A `three` vendor
   chunk is added to vite's `manualChunks` so the main bundle doesn't absorb ~600KB.
2. **Scene.** One `<Canvas>` filling the view: sphere (radius 1, 64×64) with the night
   texture on a self-lit material (matches the app's dark theme; no sun simulation);
   atmosphere = slightly larger back-side sphere with a ~20-line fresnel-glow shader
   (blue rim, additive); faint starfield optional via drei `Stars` (drop it if it costs
   frames). drei `OrbitControls`: rotate + zoom clamped (min/max distance), no pan. Idle
   rotation ~0.02 rad/s, paused while the pointer is down and disabled entirely under
   `prefers-reduced-motion`.
3. **Geo math is pure and tested.** `src/app/world/globe/geo.ts`: `latLonToVec3(lat,
   lon, r)`, `vec3ToLatLon(v)` (inverse, for click-to-place), and
   `greatCirclePoints(from, to, r, n)` — slerp between surface points with altitude
   lifted by a bump proportional to angular distance (arc apex). All globe placement and
   arc geometry flows through this module; nothing else does spherical math.
4. **Engine: arcs v2 (the only engine change, additive, no contract edit).** `buildArcs`
   today emits only `kind: 'client'` arcs and skips baseline populations. Extend it:
   (a) **inter-region** arcs — aggregate cross-region dependency flows (downstream rows
   whose hop crosses regions) into region→region pairs, intensity by rps share, blue;
   (b) **drain** arcs — while a population's failover is pending or it remains routed to
   a `down` region (the TTL-lag window), emit a red drain arc from the down/previous
   region to the new one (or from the down region along the population's route when no
   target is resolved yet). Baseline populations stay arc-less (they're synthetic
   per-region demand with no origin point). The shared `MAX_GLOBE_ARCS = 200` cap holds
   across all kinds, client arcs first.
5. **Pins and markers.** Region pins at `REGION_GEO` catalog coordinates: small sphere +
   glow, colored by `RegionMetrics.health` (fallback healthy), label via drei `Html`
   (mono font, occlusion-hidden on the far side); a pin pulses (scale oscillation ~1s)
   while a failover/outage event touching that region is <10s old — static under reduced
   motion, and a down pin renders the mockup's `▼ down` label suffix. Click pin →
   `goRegion`; hover sets cursor and brightens. Populations: teal dot markers with
   name + peak rps in a hover label.
6. **Arc rendering.** One line per `VisualArc` from `attachRenderer({level:'globe'})`:
   geometry from `greatCirclePoints` (48 segments) rebuilt ONLY when the arc set's
   signature changes (kind+endpoints, compared per frame, cheap at ≤200); per-frame
   updates touch material dash offset (flow animation; static dashes under reduced
   motion) and opacity (= intensity). Colors: client teal `#2DD4BF`, inter-region blue
   `#4A9EFF`, drain red `#EF4444`. The renderer attaches once per `running` (Phase-3/4
   discipline); frame callbacks write to refs, never setState.
7. **WebGL fallback.** The current card grid survives as `GlobeCards`; `GlobeView`
   renders it when WebGL context creation fails (feature-detect once) — and it remains
   the a11y/screen-reader path (the canvas is `aria-hidden`; a visually-hidden region
   list with the same navigation stays in the DOM).
8. **Traffic authoring (new "Traffic" tab in WorldPanel + globe placement mode).**
   The tab (running-gated by WorldPanel's existing fieldset) edits, via the EXISTING
   store actions only: populations (list: label, lat, lon, peakRps, diurnal flat/
   day-night, remove; add via form OR the globe's place-mode), traffic
   (`autoBaseline` toggle + `baselineTotalRps`), routing (`policy` select with
   weights editor shown for `weighted` and an ordered priority list for `priority`,
   `dnsTtlSec`, `healthCheckIntervalMs`, `healthCheckFailureThreshold`). Place-mode: a
   `+ place on globe` toggle arms one click — raycast the sphere, `vec3ToLatLon`,
   `addPopulation('pop-<n>', lat, lon)`, disarm, select it in the tab for renaming.
9. **Perf budget.** The globe must hold ≥30 fps with 6 regions, 6 populations, and a
   full 200-arc payload on the reference machine (live-smoke fps probe: count rAF ticks
   over 3s, twice). Geometry pooling per D6; no per-frame allocations in the arc loop;
   pin/marker meshes are stable (no re-mount on batch updates). If the probe fails,
   reduce arc segments to 32 before anything else.
10. **Phase-4 carry-forwards absorbed:** CrossAzColumn replication-list key
    `${bp}:${from}:${to}`; TimelineStrip returns null for events older than its window;
    SplitLines/RackNodes hardcoded status hexes swap to theme tokens; AzRow's per-row
    `computeWorldCost` hoisted to RegionView (compute once, pass down).

## Testing & verification

Unit: `geo.ts` (round-trip lat/lon↔vec3 at poles/antimeridian, great-circle midpoint
altitude, segment count), `buildArcs` v2 (inter-region aggregation, drain arc during TTL
lag — extend the engine fixture that already proves TTL lag; cap ordering; client arcs
unchanged — snapshot guard). Component (jsdom): Traffic tab (each field dispatches the
right store action with the right patch; weights editor appears only for `weighted`),
GlobeView fallback (renders GlobeCards when WebGL unavailable — mock the detector).
R3F scene internals are NOT jsdom-tested (no WebGL there) — the live smoke is their gate,
stated explicitly in the plan. Live phase-gate story: author 2 regions + NYC population
via the new tab → globe shows night earth, pins, teal marker, client arc under load →
kill the target region → pin turns red + pulses, drain arc appears, TTL expiry moves the
client arc to the surviving region → click a pin → region flow page opens → fps probe
≥30 → reduced-motion pass (no rotation/pulse/dash flow) → WebGL-fallback pass. Zero
console errors.

## Out of scope (unchanged from umbrella)

Analysis engine + LLM reviewer (Phase 6), day/night terminator or sun simulation, globe
camera persistence in `.scalemap`, region-scope particles, replication-lag/recovery
modeling, k8s/ECS.
