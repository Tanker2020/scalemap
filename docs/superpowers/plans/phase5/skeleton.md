# Phase 5 Plan Skeleton — R3F Globe + Traffic Authoring

Authored by the Phase-5 planning session (Fable). The executor expands each task into a
full plan section per the handoff runbook's Step 0. Signatures and semantics are exact —
expand, don't redesign. D1–D10 cite the phase spec
(`docs/superpowers/specs/2026-07-09-phase5-globe-design.md`).

## Global Constraints (every task inherits these)

- Branch: `phase5-globe`, cut from `main` (Phase 4 merged; main ≥ `9784434`).
- Contract types FROZEN; the ONLY engine change is Task 2's `buildArcs` extension inside
  `src/lib/worldEngine/index.ts` (no new files under `worldEngine/`, no type edits, no
  `Math.random`, determinism preserved). Forced drift →
  `.superpowers/sdd/contract-drift.md` `## PHASE 5`.
- strict tsc; `npm run build` green per commit (this now includes the three vendor chunk).
- Full `border` shorthand rule; jsdom pragma + jest-dom for component tests; pure tests in
  node env.
- Views read `useSimulationStore` (`scrubBatch ?? latestBatch` where metrics render);
  world mutations via existing `useWorldStore` actions ONLY (Phase 5 adds none).
- R3F discipline: renderer attach once per `running`; frame callbacks (`useFrame`,
  attachRenderer onFrame) write to refs/material props — NEVER setState; no per-frame
  allocations in loops (preallocate Vector3s/arrays); dispose geometries/materials on
  unmount.
- `prefers-reduced-motion`: no idle rotation, no pin pulse, no arc dash flow (D2/D5/D6).
- New deps allowed in Task 1 ONLY: `three`, `@react-three/fiber`, `@react-three/drei`
  (+ `@types/three` if needed). Verify React-19-compatible majors on the registry before
  pinning. No other new dependencies anywhere.
- Texture assets committed in Task 1 under `src/assets/globe/`, total ≤2.5MB, with a
  NASA public-domain attribution comment where imported.
- Colors: theme tokens for semantics; arc/pin hexes are the spec D6 values as local
  constants in `globe/` files.
- Live smokes controller-run on strict port 1420, ZERO app console errors, screenshots,
  server stopped after. R3F internals are gated by live smokes, not jsdom (spec Testing).
- Ledger: `.superpowers/sdd/progress.md` `## PHASE 5`. Boundaries doc gains §N (T7).

## File Structure

```
src/assets/globe/black-marble-2k.jpg   # T1 (public-domain NASA night lights, 2048×1024)
src/app/world/globe/                   # NEW
  geo.ts (+ geo.test.ts)               # T1: latLonToVec3 / vec3ToLatLon / greatCirclePoints
  GlobeScene.tsx                       # T3: Canvas, earth, atmosphere, controls, rotation
  RegionPins.tsx                       # T4: pins + labels + pulse + click-nav
  PopulationMarkers.tsx                # T4: teal markers + hover labels + place-mode target
  ArcsLayer.tsx                        # T5: engine-payload great-circle arcs
  webgl.ts                             # T3: one-shot WebGL feature detect
src/app/world/GlobeView.tsx            # T3: REWRITTEN — scene | GlobeCards fallback + a11y list
src/app/world/GlobeCards.tsx           # T3: today's card grid extracted verbatim
src/app/world/panels/TrafficPanel.tsx  # T6 (+ TrafficPanel.test.tsx): populations/traffic/routing
src/app/world/panels/WorldPanel.tsx    # T6: + 'traffic' tab
src/lib/worldEngine/index.ts           # T2: buildArcs v2 (inter-region + drain)
src/lib/worldEngine/globeArcs.test.ts  # T2
vite.config.ts                         # T1: manualChunks three vendor chunk
docs/module-boundaries.md              # T7: §N
```

Dependency order: T1 → {T2, T3} → T4 → T5; T6 after T3 (place-mode hooks into the
scene); T7 last. Serial T1…T7.

---

## Task 1: Deps, textures, pure geo math `[sonnet]`

**Files:** modify `package.json` (via `npm i three @react-three/fiber @react-three/drei`
— record exact resolved versions in the plan), `vite.config.ts` (rollup
`manualChunks: { three: ['three'] }` — read the current config first and merge, don't
clobber); create `src/assets/globe/black-marble-2k.jpg`, `src/app/world/globe/geo.ts`,
`geo.test.ts`.

**Texture step (exact):** download NASA's Black Marble 2016 night-lights JPEG at
2048×1024 (visibleearth.nasa.gov / eoimages.gsfc.nasa.gov; any equivalent public-domain
NASA night-lights earth works if the canonical URL moved), verify dimensions and size
(`sips -g pixelWidth -g pixelHeight`, ≤2.5MB), commit. Note: `npm run build` must stay
green with the asset imported nowhere yet (it is dead weight until T3 — acceptable for
one task).

**Produces (exact):**

```ts
import { Vector3 } from 'three'

// lat/lon degrees, r = sphere radius. Standard mapping: lat 90 → +Y pole; lon 0 →
// +Z meridian, lon 90E → +X (right-handed, texture-aligned; document the convention
// and keep the texture offset consistent with it in T3).
export function latLonToVec3(lat: number, lon: number, r: number): Vector3
export function vec3ToLatLon(v: Vector3): { lat: number; lon: number }   // inverse, any radius
// n+1 points from `from` to `to` along the great circle, slerped, with altitude bump:
// r × (1 + 0.25 × (angularDistance / π)) at the apex, easing to r at the ends.
export function greatCirclePoints(from: { lat: number; lon: number }, to: { lat: number; lon: number }, r: number, n: number): Vector3[]
```

**Named test cases:** `latLonToVec3 poles and equator land on axes`; `vec3ToLatLon
round-trips random points within 1e-6`; `antimeridian round-trip`; `greatCirclePoints
returns n+1 points, ends on the surface, apex lifted`; `zero-distance pair degenerates
safely`. Verify expected values with a scratch Node harness before baking them in.

**Commit:** `feat(globe): add three/r3f deps, NASA night texture, pure geo math`

---

## Task 2: Engine arcs v2 — inter-region + drain `[sonnet]`

**Files:** modify `src/lib/worldEngine/index.ts` (`buildArcs` only — quote the current
function verbatim in a Modify step, old→new); create `src/lib/worldEngine/globeArcs.test.ts`.

**Semantics (D4):** keep existing client arcs byte-identical first (order preserved).
Then append:
- **inter-region:** walk `s.prevFlows` downstream rows; for rows whose caller instance
  and target instance sit in different regions, aggregate rps by
  `(fromRegionId, toRegionId)`; one arc per pair, `fromLatLon`/`toLatLon` from
  `REGION_GEO_LOCAL[catalogId]`, `intensity = pairRps / maxPairRps` (min 0.15 so faint
  links stay visible), `kind: 'inter-region'`.
- **drain:** for each population in `s.pendingFailover` (target region resolved, TTL
  drama in flight) emit `kind: 'drain'` from the PREVIOUS region (`s.popRegion` holds the
  current=new one — you need the from-side: read the failover pair the way the events at
  index.ts:232-238 do, i.e. capture prev→next when the switch happens; if the previous
  region is no longer resolvable, fall back to the population's own lat/lon as the from
  point) to the new region, intensity 1. Additionally, a population still routed to a
  region whose health is `down` (TTL not yet expired) emits a drain arc population→that
  down region (the "clients still arriving" picture).
- Cap: total ≤ `MAX_GLOBE_ARCS`, client arcs first, then inter-region, then drain
  (truncate in that order).
The implementation may add a small `Map` to `EngineState` to remember each population's
previous region for the drain window — engine-internal state, not a contract change; log
it as an informational drift item.

**Named test cases (fixture with 2 regions, cross-region dependency, NYC population,
TTL 5s — reuse/extend the existing failover fixture patterns in `index.test.ts`):**
`client arcs unchanged for the baseline fixture` (deep-equal snapshot vs pre-change
capture); `cross-region dependency produces an inter-region arc with aggregated rps`;
`no inter-region arcs when all flows are intra-region`; `population routed at a down
region emits a drain arc until TTL expiry`; `drain arc from old to new region during
pending failover, then clears`; `cap truncates drain last... (order: client kept first)`;
`deterministic under fixed seed`.

**Commit:** `feat(engine): globe arcs v2 — inter-region and failover-drain arcs`

---

## Task 3: Globe scene, fallback, GlobeView rewrite `[sonnet]`

**Files:** create `GlobeScene.tsx`, `webgl.ts`, `src/app/world/GlobeCards.tsx` (extract
today's `GlobeView` card grid VERBATIM — it still reads doc/compiled/batch and navigates);
REWRITE `src/app/world/GlobeView.tsx`; jsdom test `GlobeView.test.tsx` (fallback branch
only — mock `webgl.ts`).

**Produces (exact):**

```ts
// webgl.ts — evaluated once, cached
export function webglAvailable(): boolean
```

```tsx
export interface GlobeSceneProps {
  placeMode: boolean                                   // T6 arms this; T3 wires prop through inert
  onPlace: (lat: number, lon: number) => void
  children?: ReactNode                                 // T4/T5 layers mount inside the Canvas
}
export function GlobeScene(props: GlobeSceneProps): ReactElement
```

Scene per D2: `<Canvas>` (dpr [1,2], camera z≈2.8) → earth mesh (sphereGeometry 64×64,
`meshBasicMaterial` with the T1 texture via drei `useTexture`; align texture offset to
T1's lon convention and PROVE it in the live smoke: the us-east-1 pin must sit on the US
east coast); atmosphere = sphere r×1.03, backside, additive fresnel shader (write the
~20-line GLSL inline); `OrbitControls` (enablePan false, minDistance 1.6, maxDistance 5,
enableDamping); idle rotation: a group ref advanced in `useFrame` by `0.02 × delta`,
skipped while `controls` is being interacted with (pointerdown/up listeners) or reduced
motion. Place-mode: when armed, a click raycasts the earth mesh (`onClick` on the mesh —
r3f gives the intersection point), `vec3ToLatLon(point)` → `onPlace`, and the cursor
swaps to crosshair. `GlobeView` = `webglAvailable() ? <GlobeScene…>{layers}</GlobeScene>
: <GlobeCards/>`, plus the visually-hidden a11y region list (buttons → `goRegion`) in
both branches; canvas container `aria-hidden`.

**Named jsdom tests:** `renders GlobeCards when webgl unavailable`; `hidden a11y region
list navigates` (fallback branch, mocked store).

**Live smoke:** globe renders night earth + atmosphere; drag rotates, wheel zooms within
clamps; idle rotation visible, absent under emulated reduced motion; pin-position
calibration check deferred to T4 smoke BUT texture-orientation eyeball (Americas/
Africa/Asia recognizable, not mirrored) happens HERE with a screenshot.

**Commit:** `feat(globe): r3f night-earth scene with atmosphere, controls, and card fallback`

---

## Task 4: Region pins + population markers `[sonnet]`

**Files:** create `RegionPins.tsx`, `PopulationMarkers.tsx`; mount as `GlobeScene`
children in `GlobeView`.

**Produces (exact):**

```tsx
export function RegionPins(): ReactElement
// One pin group per doc region at REGION_GEO[catalogId] (skip unknown catalogIds):
// sphere r=0.018 + additive glow sprite/halo, color = health of
// (scrubBatch ?? latestBatch)?.regions[id]?.health ?? 'healthy' via the shared
// HEALTH hex map; label = drei <Html occlude distanceFactor≈8> `catalogId` (+ ` ▼ down`
// suffix in danger color when down). Pulse: scale 1→1.35→1 @≈1s while a failover/outage
// event whose affected includes the regionId is <10s old (display simMs) — skipped under
// reduced motion. onClick → goRegion(id); onPointerOver/Out → document.body cursor +
// emissive brighten.
export function PopulationMarkers(): ReactElement
// Teal dot r=0.012 per population at its lat/lon; drei <Html> label `label · <peakRps>
// rps` shown on hover only. No click behavior (editing lives in the Traffic tab).
```

Both read stores directly (no props). Events/metrics polling: subscribe to the store
values; per-frame work stays in refs.

**Named jsdom tests:** none (R3F) — state that explicitly; logic worth testing lives in
tiny exported helpers `pinColor(health)` and `isPulsing(events, regionId, nowSimMs)`
which DO get node-env unit tests (`pin pulses within 10s of a region outage event`,
`stops after`, `pinColor maps health states`).

**Live smoke:** us-east-1 pin sits on the US east coast and eu-west-1 on Ireland
(calibration proof, screenshot); population marker at NYC; hover shows label; region
outage via debug hook turns the pin red with `▼ down` and it pulses; click pin →
region flow page.

**Commit:** `feat(globe): health-lit region pins and population markers`

---

## Task 5: Live arcs layer `[sonnet]`

**Files:** create `ArcsLayer.tsx`; mount in `GlobeView`'s scene children.

**Produces (exact):**

```tsx
export function ArcsLayer(): ReactElement
// attachRenderer({ level: 'globe' }, onFrame) once per `running` (store action, detach on
// unmount/stop). onFrame: compute signature = arcs.map(a => `${a.kind}:${a.fromLatLon}:
// ${a.toLatLon}`).join('|'); if changed, rebuild line geometries (greatCirclePoints, 48
// segments, r 1.001) into a pooled set of THREE.Line objects with LineDashedMaterial
// (computeLineDistances; dashSize 0.045 gapSize 0.03); always update per-arc material
// opacity = 0.25 + 0.75×intensity and advance dashOffset -= delta×0.15 (skip offset
// under reduced motion). Colors per kind: client #2DD4BF, inter-region #4A9EFF, drain
// #EF4444. Pool max = MAX_GLOBE_ARCS lines created lazily, hidden when unused; dispose
// on unmount. No allocations in the steady-state frame path.
```

**Named tests:** exported pure helper `arcsSignature(arcs)` gets a node test
(`signature changes on endpoints or kind, not on intensity`). Rendering is live-smoke
gated (state explicitly).

**Live smoke:** under load, teal client arc NYC→us-east-1 flows; add a cross-region
dependency → blue inter-region arc; kill the target region → red drain arc during the
TTL window, then the client arc re-points to the surviving region; reduced-motion pass
shows static dashes. Screenshots.

**Commit:** `feat(globe): engine-driven great-circle traffic arcs`

---

## Task 6: Traffic authoring tab + place-on-globe `[sonnet]`

**Files:** create `src/app/world/panels/TrafficPanel.tsx`, `TrafficPanel.test.tsx`;
modify `WorldPanel.tsx` (add `{ id: 'traffic', label: 'Traffic' }` tab + render);
modify `GlobeView.tsx` (own `placeMode` state; pass to `GlobeScene`; `onPlace` →
`addPopulation` + disarm + notify the panel via a `useState`-lifted selected-population
id — keep it local to GlobeView/WorldShell props, no new store).

**Produces (exact):**

```tsx
export interface TrafficPanelProps {
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
}
export function TrafficPanel(props: TrafficPanelProps): ReactElement
```

Sections (D8), each writing through existing actions with exact patches:
1. POPULATIONS — row per population: label text input (`updatePopulation(id, { label })`
   on commit), lat/lon numeric (clamped [-90,90]/[-180,180]), peakRps numeric ≥0,
   diurnal `<select>` flat|day-night, ✕ remove; `+ add` (form defaults 40.7/-74/100/flat)
   and `+ place on globe` toggle (armed style while `placeMode`); the
   `selectedPopulationId` row auto-focuses its label input.
2. TRAFFIC — `autoBaseline` checkbox, `baselineTotalRps` numeric ≥0 →
   `updateTraffic(patch)`.
3. ROUTING — `policy` select (latency|geo|weighted|priority); when `weighted`: one
   numeric weight per region (`weights` record patch); when `priority`: ordered region
   list with ↑↓ buttons (aria-labels) editing `priorityOrder`; `dnsTtlSec`,
   `healthCheckIntervalMs`, `healthCheckFailureThreshold` numerics ≥1 →
   `updateRouting(patch)`.
Numeric handling per the Phase-4 T7 convention (`Number.isFinite`, clamp, keep last
valid). The WorldPanel fieldset already running-gates everything — do not duplicate.

**Named jsdom tests:** `add and edit population dispatches store actions with exact
patches`; `lat clamps to [-90,90]`; `weights editor only for weighted policy`;
`priority order buttons reorder priorityOrder`; `traffic toggles dispatch updateTraffic`;
`place toggle fires onTogglePlaceMode`.

**Live smoke:** place-mode click on the globe drops a population where clicked (marker
appears at the click point), the tab shows it selected; edit peakRps → simulate → arc
intensity reflects it.

**Commit:** `feat(traffic): population, baseline-traffic, and routing authoring with globe placement`

---

## Task 7: Integration, fps probe, §N, carry-forwards `[sonnet]`

**Files:** `docs/module-boundaries.md` §N (globe module: imports lib + stores + three;
GlobeCards is the no-WebGL/a11y path; the D10 carry-forward edits);
`src/app/world/region/CrossAzColumn.tsx` (repl key `${bp}:${from}:${to}`),
`src/app/world/region/TimelineStrip.tsx` (out-of-window events return null),
`src/app/world/region/SplitLines.tsx` + `src/app/world/RackNodes.tsx` (status hexes →
theme tokens), `src/app/world/RegionView.tsx` + `region/AzRow.tsx` (hoist
`computeWorldCost` to RegionView, pass `monthlyUsd` down — adjust AzRow props + tests).

**Done bar (this task's checklist):** full suite + build green; fps probe (rAF count
over 3s, twice, on a 6-region/6-population world with arcs) ≥30fps logged in the report;
the spec's phase-gate live story end-to-end with screenshots; reduced-motion and
WebGL-fallback passes; ledger `## PHASE 5` summary (per-task lines + open items + drift
state — expected: one informational engine-internal item from T2).

**Commit:** `docs: update module boundaries for the globe (§N); region/rack carry-forwards`
