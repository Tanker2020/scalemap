# Phase 5 Fragment-Writer Grounding (resolved by the controller — do not re-derive)

Everything below is verified against real source at branch `phase5-globe` (cut from main @ `9784434`).
Use these facts verbatim; ground any NEW claim in real source before writing it.

## Resolved dependency versions (T1) — registry-checked, React-19 host (react 19.1.0)
- `three@^0.185.1` (latest 0.185.1)
- `@react-three/fiber@^9.6.1` (latest 9.6.1; peer `react >=19 <19.3` — satisfied by 19.1.0; the R19-compatible major per spec D1)
- `@react-three/drei@^10.7.7` (latest 10.7.7; peer `react ^19`, `three >=0.159`, `@react-three/fiber ^9.0.0` — all satisfied)
- `@types/three@^0.185.1` (matches three)
Install command (T1): `npm i three @react-three/fiber @react-three/drei && npm i -D @types/three`. Record resolved versions from package.json after install.

## Geo math (T1) — convention + VERIFIED expected values (scratch Node harness, 10k round-trips)
Convention (spec D3 / skeleton): `lat 90 → +Y` pole; `lon 0 → +Z` meridian; `lon 90E → +X` (right-handed, texture-aligned).
Formulas: `y=r·sin(latRad)`, `x=r·cos(latRad)·sin(lonRad)`, `z=r·cos(latRad)·cos(lonRad)`. Inverse: `lat=asin(y/|v|)`, `lon=atan2(x,z)`.
`greatCirclePoints`: slerp unit endpoints; per point normalize then multiply by `r·(1 + 0.25·(ang/π)·sin(π·t))` where `ang`=angular distance, `t=i/n`. This gives exactly `r` at both ends (sin 0 = 0) and apex `r·(1+0.25·ang/π)` at `t=0.5`.
Verified numeric expectations to bake into `geo.test.ts` (use `toBeCloseTo`, precision ≥5 — pole components carry ~6e-17 float dust, never exact 0):
- `latLonToVec3(90,0,1) ≈ (0,1,0)`; `(-90,0,1) ≈ (0,-1,0)`; `(0,0,1) ≈ (0,0,1)`; `(0,90,1) ≈ (1,0,0)`; `(0,-90,1) ≈ (-1,0,0)`; `(0,180,1) ≈ (0,0,-1)`.
- Round-trip `vec3ToLatLon(latLonToVec3(lat,lon,r))` max error over 10k random points+radii: `2.6e-11°` — assert within `1e-6`. **Lon comparison must wrap ±180**: `lon=-180` returns `+180` (atan2), so compare via `((a-b+540)%360)-180`.
- Antimeridian: `vec3ToLatLon(latLonToVec3(10,180,2)) ≈ {lat:10, lon:180}`.
- `greatCirclePoints({0,0},{0,90},1,48)` → **49** points; ends length `1.0`; apex (index 24) length `1.125` (= `1+0.25·(π/2)/π`).
- Zero-distance `greatCirclePoints({20,30},{20,30},2,48)` → 49 finite points, each length `2` (= r), no NaN.
Scratch harness lives at the controller's scratchpad `geo.mjs` (reproduces all the above) — re-run if a formula detail is questioned.

## Engine (T2) — current `buildArcs` (src/lib/worldEngine/index.ts:462-477), VERBATIM, quote in the Modify step:
```ts
  function buildArcs(): VisualArc[] {
    const s = state!
    const routes = s.lastRoutingSnapshot.populationRoutes
    const maxRps = Math.max(1, ...routes.map(r => r.rps))
    const arcs: VisualArc[] = []
    for (const r of routes) {
      if (r.populationId.startsWith('baseline:')) continue
      const pop = s.doc.populations[r.populationId]
      const region = s.doc.regions[r.regionId]
      const geo = region ? REGION_GEO_LOCAL[region.catalogId] : undefined
      if (!pop || !geo) continue
      arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geo.lat, geo.lon], intensity: Math.min(1, r.rps / maxRps), kind: 'client' })
      if (arcs.length >= MAX_GLOBE_ARCS) break
    }
    return arcs
  }
```
- `MAX_GLOBE_ARCS = 200` (index.ts:43). `import { REGION_GEO as REGION_GEO_LOCAL } from '../world/regionGeo'` already present (index.ts:37). `VisualArc.kind: 'client' | 'inter-region' | 'drain'` already in frozen contracts — NO type edit.
- `EngineState` fields available (index.ts:84-97): `failover: FailoverState`, `prevFlows: Record<InstanceId, InstanceFlow>`, `popRegion: Map<PopulationId, RegionId>`, `pendingFailover: Map<PopulationId, RegionId>`, `clock` (`s.clock.simMs`), `doc`, `compiled`, `lastRoutingSnapshot`.
- `FailoverState.healthByScope: Map<string, HealthState>` (failover.ts:28) — region health = `s.failover.healthByScope.get(regionId) ?? 'healthy'`. `drainUntil: Map<AzId, number>` is AZ-only (not for regions).
- `InstanceFlow` (flows.ts:56-63): `{ instanceId, offeredRps, admittedRps, serviceLatencyMs, downstream: DownstreamFlow[] }`. `DownstreamFlow` (flows.ts:47-54): `{ dependencyId, toInstanceId?, toManagedServiceId?, rps, blocked }`.
- `CompiledInstance` (from compileWorld, see regionData grounding) exposes `.regionId`, `.azId`, `.serverId`, `.blueprintId` — use `s.compiled.instances[id].regionId` to classify a flow's caller/target region. Managed-service targets (`toManagedServiceId`) have no instance region — skip them for inter-region aggregation (or resolve via `doc.managedServices[id].scope` only if scope.kind gives a region; simplest: skip, they aren't cross-region client flows).
- **Failover loop** (index.ts:228-244) for drain prev-region capture: `prevRegion = s.popRegion.get(pop.id)`; on re-resolve it emits `ttl_lag_expired` + `failover_started` with `affected:[pop.id, prevRegion, region]` and `s.pendingFailover.set(pop.id, region)`; then `s.popRegion.set(pop.id, region)` (popRegion becomes the NEW region same step). So to get the from-side for a drain arc you need a NEW engine-internal `Map<PopulationId, RegionId>` capturing prev→for-drain (the skeleton sanctions "a small Map to EngineState to remember each population's previous region"). Set it when `prevRegion && prevRegion !== region`; clear it on `failover_completed`. Log this Map as the ONE informational engine-internal drift item in `.superpowers/sdd/contract-drift.md` `## PHASE 5`.
- Drain semantics (spec D4 / skeleton): (a) for each pop in `s.pendingFailover` emit `kind:'drain'` from PREV region (via the new Map; fallback to pop's own lat/lon if unresolvable) → new region, `intensity:1`; (b) a pop still routed (in `lastRoutingSnapshot.populationRoutes`) to a region whose `healthByScope` is `down` emits drain from pop lat/lon → that down region (clients-still-arriving). Cap: total ≤ `MAX_GLOBE_ARCS`, order client → inter-region → drain (truncate in that order; client arcs byte-identical & first).
- **Test file** `src/lib/worldEngine/globeArcs.test.ts`: reuse `e2eFixture()` patterns from `index.test.ts` (2 regions us-east-1/eu-west-1, cross-region web→api→db, NYC pop peakRps 120, `doc.routing.dnsTtlSec=5`, `doc.traffic.autoBaseline=false`, `routing.policy='geo'`). Engine exposes `__test_step(steps)` and `__test_render(wallMs?)`. To read arcs: `engine.attachRenderer({level:'globe'}, p => captured=p.arcs)` AFTER `start()`, then `__test_step` + `__test_render`. Named cases per skeleton T2. "client arcs unchanged" = deep-equal vs a snapshot captured before the change (or vs recomputing the client-only subset). Determinism: `createWorldEngine(1)` fixed seed.

## Views / stores (T3-T6) — verified surfaces
- **GlobeView.tsx** today: the card grid to extract VERBATIM into `GlobeCards.tsx` (reads `useWorldStore.doc`, `useCompiledWorld()`, `useNavStore.goRegion`, `useSimulationStore(s => s.scrubBatch ?? s.latestBatch)`, `WORLD_REGIONS` from `../../lib/regionConfig`, local `HEALTH_COLOR` map). Mounted in `WorldShell.tsx:69` as `nav.level === 'globe' ? <GlobeView /> : …`.
- **nav.store** (`../store/nav.store`): `{ level, regionId, azId, serverId, goGlobe(), goRegion(regionId), goAz(regionId,azId), goServer(regionId,azId,serverId), up() }`.
- **simulation.store** (`../store/simulation.store`): `{ running, latestBatch, scrubBatch, events, healthOverrides, setOutage(scope,id,down), attachRenderer(scope,onFrame)→DetachFn, getReplayFrames(), getTracedRequests(scope) }`. `attachRenderer` is a store action delegating to the engine facade. Pattern for layers: `useSimulationStore.getState().attachRenderer({level:'globe'}, onFrame)` inside a `useEffect` gated on `running`, return the detach; write frame data to refs, never setState. Precedent: `AzSimOverlay.tsx` (attach once per `[running, azId, reduced]`, detach on cleanup, `useReducedMotion()` from framer-motion).
- **world.store** (`../store/world.store`) actions (Phase 5 ADDS NONE — use these only): `addPopulation(label,lat,lon)→id`, `updatePopulation(id, Partial<ClientPopulation>)`, `removePopulation(id)`, `updateRouting(Partial<RoutingConfig>)`, `updateTraffic(Partial<TrafficConfig>)`.
- **Types** (`../../lib/world/types` / `../../../lib/world/types`):
  - `ClientPopulation { id; label; lat; lon; peakRps; diurnal: 'flat'|'day-night' }`
  - `TrafficConfig { autoBaseline: boolean; baselineTotalRps: number }`
  - `RoutingConfig { policy: 'latency'|'geo'|'weighted'|'priority'; weights: Record<RegionId,number>; priorityOrder: RegionId[]; healthCheckIntervalMs; healthCheckFailureThreshold; dnsTtlSec }`
  - `RegionMetrics.health: HealthState` from `(scrubBatch ?? latestBatch)?.regions[id]?.health ?? 'healthy'`.
- **REGION_GEO** (`../../lib/world/regionGeo` / adjust depth): `Record<catalogId, {lat,lon}>` — e.g. `'us-east-1':{lat:38.9,lon:-77.5}`, `'eu-west-1':{lat:53.3,lon:-6.3}`, `'ap-southeast-1':{lat:1.35,lon:103.8}`. Pins read `REGION_GEO[region.catalogId]` and skip unknown catalogIds.
- **WorldPanel.tsx**: tabs are `type Tab` union + `tabs: {id,label}[]`; add `{ id:'traffic', label:'Traffic' }` and `{tab==='traffic' && <TrafficPanel .../>}`. Everything is inside `<fieldset disabled={running}>` — do NOT duplicate the running-gate. WorldPanel receives `{ running }` prop today; TrafficPanel's placeMode/selectedPopulation state must be lifted (skeleton: keep local to GlobeView/WorldShell props, no new store) — thread props down from wherever WorldPanel is rendered (check WorldShell for how WorldPanel + GlobeView co-mount; the place-mode toggle in TrafficPanel and the onPlace in GlobeView share one lifted `useState`).

## Theme / constants
- Arc/pin hexes are spec D6 LOCAL constants in `globe/` files (NOT global tokens): client `#2DD4BF`, inter-region `#4A9EFF`, drain `#EF4444`. Health pin colors via a shared `HEALTH` hex map (healthy `#22C55E`/success, degraded `#F59E0B`/warning, down `#EF4444`/danger — match theme.ts). Semantic health/severity elsewhere → `var(--color-success|--color-warning|--color-danger)`. Font `var(--font-mono)` (JetBrains Mono).

## Format precedent
`docs/superpowers/plans/phase4/fragments/tasks-01-03.md` — the fidelity bar: each task = failing-test-first, complete code, exact commands + expected output, live-smoke checklist where named, commit step. Each fragment opens with a scope note; Global Constraints/File Structure live only in the assembled header (skeleton), not repeated in fragments.

## Live-smoke facts
- DEV `window.__scalemapDebug` hook authors populations/traffic/routing until T6 ships the real UI (populations/traffic/routing have NO authoring UI pre-T6).
- Strict port 1420. Zero app console errors. Screenshots. Stop server after. R3F internals gated by live smokes, not jsdom (no WebGL in jsdom).
