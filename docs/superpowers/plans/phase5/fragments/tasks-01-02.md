# Phase 5 plan fragment — Tasks 1–2 (deps/textures/geo math · engine arcs v2)

> Fragment scope: Task 1 (three/r3f/drei deps, NASA night texture, pure geo math module) and
> Task 2 (`buildArcs` v2 — inter-region + failover-drain globe arcs). Global Constraints / File
> Structure live in the skeleton's assembled header
> (`docs/superpowers/plans/phase5/skeleton.md`) — not repeated here.
>
> **Verification note:** the geo formulas below were independently re-verified in a scratch Node
> harness before being baked into `geo.test.ts`'s assertions (poles/equator exact to float dust,
> 10k-point round-trip max error `1.08e-9°`, antimeridian round-trip, `greatCirclePoints` apex
> length `1.125` at `t=0.5` for a 90° arc, zero-distance degeneracy — all match GROUNDING's
> independently-verified values). The Task 1 texture step was run for real: the NASA Black Marble
> 2016 "0.1 degree" JPEG (the closest official delivery size — NASA's Earth Observatory doesn't
> publish an exact 2048×1024 asset; the canonical `visibleearth.nasa.gov` URL from GROUNDING has
> itself moved, confirming the skeleton's "any equivalent public-domain NASA night-lights earth
> works if the canonical URL moved" clause) was downloaded (3600×1800, 779,638 bytes) and resized
> to exactly 2048×1024 with `sips`, landing at 263,299 bytes (~257KB, well under the 2.5MB
> budget) — the exact commands and byte counts below are real output, not estimates. Task 2's
> fixtures/arc-count arithmetic (the cap-truncation test's `150 client + 150 drain-candidate =
> 300 requested, capped at 200 -> 150 client + 0 inter-region + 50 drain`) is exact arithmetic
> against the real `MAX_GLOBE_ARCS = 200` constant (`src/lib/worldEngine/index.ts:43`), not a
> guess — reasoned from the real `resolveRegion` DNS-cache code (`routingRuntime.ts:47-67`, read
> in full) so the fixtures don't depend on unverified TTL-timing assumptions.

---

## Task 1: Deps, textures, pure geo math `[sonnet]`

**Files:** modify `package.json` (+ lockfile, via `npm i`), `vite.config.ts`; create
`src/assets/globe/black-marble-2k.jpg`, `src/app/world/globe/geo.ts`, `src/app/world/globe/geo.test.ts`.

**Grounding:** `package.json` today has no `three`/`@react-three/*` deps; React is `^19.1.0`
(peer-compatible with the versions below). `vite.config.ts` today is
`export default defineConfig(async () => ({ plugins: [react()], test: {...}, clearScreen: false,
server: {...} }))` — the new `build` key must be MERGED into that same returned object, not
replace it. No file currently imports `three` or does spherical math — `geo.ts` is the first and,
per spec D3, the ONLY module that does (T3–T5 call into it).

- [ ] **Step 1: Install the three/r3f/drei deps**

Run:

```bash
npm i three @react-three/fiber @react-three/drei
npm i -D @types/three
```

Registry-checked resolved versions (confirmed live against the npm registry — record the actual
`package.json` ranges/lockfile versions after running the install for real, they should match):

| package | range to install | resolved (registry-checked) | peer deps (checked) |
|---|---|---|---|
| `three` | `^0.185.1` | `0.185.1` | — |
| `@react-three/fiber` | `^9.6.1` | `9.6.1` | `react >=19 <19.3`, `three >=0.156` — both satisfied |
| `@react-three/drei` | `^10.7.7` | `10.7.7` | `react ^19`, `three >=0.159`, `@react-three/fiber ^9.0.0` — all satisfied |
| `@types/three` | `^0.185.1` | `0.185.1` | — |

`package.json` gains these four lines (dependencies for the first three, devDependencies for
`@types/three`) and `package-lock.json` updates accordingly — no other manual edits.

- [ ] **Step 2: `vite.config.ts` — add the `three` vendor chunk (merge, don't clobber)**

Current file (verbatim, all 39 lines — the merge target):

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vitest: seed Math.random before every test for deterministic, order-independent runs.
  // See vitest.setup.ts for why (process-global RNG bleeding across worker-scheduled test files).
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

New file — one new top-level key (`build`) added to the returned object, right after the
`test` block; every existing key is untouched:

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vitest: seed Math.random before every test for deterministic, order-independent runs.
  // See vitest.setup.ts for why (process-global RNG bleeding across worker-scheduled test files).
  test: {
    setupFiles: ["./vitest.setup.ts"],
  },

  // Phase 5 (D1): the globe view's three.js dependency (~600KB) gets its own chunk so it
  // doesn't inflate the initial bundle for users who never open the globe.
  build: {
    rollupOptions: {
      output: {
        manualChunks: { three: ["three"] },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

- [ ] **Step 3: Texture — download, resize, verify (exact commands + real output)**

NASA's Earth Observatory serves Black Marble 2016 at three fixed resolutions (3600×1800 /
13500×6750 / 86400×43200 tiled) — there is no official 2048×1024 delivery, and the
`visibleearth.nasa.gov` URL GROUNDING named has itself 301-redirected to
`science.nasa.gov/earth/earth-observatory/earth-at-night/maps` (confirmed live). Per the
skeleton's "any equivalent public-domain NASA night-lights earth works if the canonical URL
moved" clause: download the closest official size (3600×1800, the smallest raster NASA
publishes) and resize it to the design's exact 2048×1024 with `sips`. Run from the repo root:

```bash
curl -sL "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_01deg.jpg" \
  -o /tmp/BlackMarble_2016_01deg.jpg --max-time 30

sips -g pixelWidth -g pixelHeight /tmp/BlackMarble_2016_01deg.jpg
# pixelWidth: 3600
# pixelHeight: 1800

mkdir -p src/assets/globe
sips -z 1024 2048 /tmp/BlackMarble_2016_01deg.jpg --out src/assets/globe/black-marble-2k.jpg -s formatOptions 85

sips -g pixelWidth -g pixelHeight src/assets/globe/black-marble-2k.jpg
# pixelWidth: 2048
# pixelHeight: 1024

ls -la src/assets/globe/black-marble-2k.jpg
# -rw-r--r--  1 <user>  staff  263299 <date> src/assets/globe/black-marble-2k.jpg
```

Real output from this exact pipeline (run in the scratchpad during planning, reproducible):
source `779,638` bytes at `3600×1800`; resized output `263,299` bytes (~257KB) at exactly
`2048×1024` — comfortably under the 2.5MB budget. Visual check: the resized JPEG is a standard
equirectangular night-lights map (Americas left-of-center, Europe/Africa/Asia center-right,
Australia bottom-right, Antarctica as a flat band along the bottom) — matches the mockup's look
and gives T3's `GlobeScene` a known, correct orientation to align its UV offset against.

Add a public-domain attribution comment at the one place T3 imports the asset (not this task —
T3 doesn't exist yet); for now the file just needs to exist and pass the size/dimension check.
`npm run build` stays green with the asset committed but imported nowhere (dead weight until
T3 — acceptable for one task, per the skeleton).

- [ ] **Step 4: Write the failing test `geo.test.ts`**

```ts
// src/app/world/globe/geo.test.ts
import { describe, it, expect } from 'vitest'
import { latLonToVec3, vec3ToLatLon, greatCirclePoints } from './geo'

// atan2's range is (-180, 180], so a point exactly on the antimeridian resolves to +180, never
// -180 — raw subtraction fails there. Wrap-aware comparison (GROUNDING-verified convention).
function lonDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

describe('latLonToVec3', () => {
  it('poles and equator land on axes', () => {
    const cases: [number, number, [number, number, number]][] = [
      [90, 0, [0, 1, 0]],
      [-90, 0, [0, -1, 0]],
      [0, 0, [0, 0, 1]],
      [0, 90, [1, 0, 0]],
      [0, -90, [-1, 0, 0]],
      [0, 180, [0, 0, -1]],
    ]
    for (const [lat, lon, [ex, ey, ez]] of cases) {
      const v = latLonToVec3(lat, lon, 1)
      expect(v.x).toBeCloseTo(ex, 5)
      expect(v.y).toBeCloseTo(ey, 5)
      expect(v.z).toBeCloseTo(ez, 5)
    }
  })
})

describe('vec3ToLatLon', () => {
  it('round-trips random points within 1e-6', () => {
    let maxLatErr = 0
    let maxLonErr = 0
    for (let i = 0; i < 10_000; i++) {
      const lat = Math.random() * 180 - 90
      const lon = Math.random() * 360 - 180
      const r = 0.5 + Math.random() * 5
      const back = vec3ToLatLon(latLonToVec3(lat, lon, r))
      maxLatErr = Math.max(maxLatErr, Math.abs(back.lat - lat))
      maxLonErr = Math.max(maxLonErr, Math.abs(lonDiff(back.lon, lon)))
    }
    expect(maxLatErr).toBeLessThan(1e-6)
    expect(maxLonErr).toBeLessThan(1e-6)
  })

  it('antimeridian round-trip', () => {
    const { lat, lon } = vec3ToLatLon(latLonToVec3(10, 180, 2))
    expect(lat).toBeCloseTo(10, 5)
    expect(lonDiff(lon, 180)).toBeCloseTo(0, 5)
  })
})

describe('greatCirclePoints', () => {
  it('returns n+1 points, ends on the surface, apex lifted', () => {
    const points = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, 1, 48)
    expect(points).toHaveLength(49)
    expect(points[0].length()).toBeCloseTo(1, 5)
    expect(points[48].length()).toBeCloseTo(1, 5)
    const expectedApex = 1 + 0.25 * (Math.PI / 2) / Math.PI   // = 1.125
    expect(points[24].length()).toBeCloseTo(expectedApex, 5)
  })

  it('zero-distance pair degenerates safely', () => {
    const points = greatCirclePoints({ lat: 20, lon: 30 }, { lat: 20, lon: 30 }, 2, 48)
    expect(points).toHaveLength(49)
    for (const p of points) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
      expect(p.length()).toBeCloseTo(2, 5)
    }
  })
})
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run src/app/world/globe/geo.test.ts`
Expected: FAIL — `Cannot find module './geo'` (the file doesn't exist yet).

- [ ] **Step 6: Write `geo.ts`**

```ts
// src/app/world/globe/geo.ts
// Pure spherical geometry for the globe view (Phase 5 D3): lat/lon <-> unit-sphere vec3
// conversion and great-circle arc point sampling. Convention: lat 90 -> +Y pole; lon 0 -> +Z
// meridian; lon 90E -> +X (right-handed, texture-aligned — GlobeScene.tsx (T3) aligns the
// night-texture's UV offset to this same convention). Nothing outside this module does
// spherical math (spec D3) — GlobeScene/RegionPins/PopulationMarkers/ArcsLayer (T3-T5) call in.
import { Vector3 } from 'three'

export function latLonToVec3(lat: number, lon: number, r: number): Vector3 {
  const latRad = (lat * Math.PI) / 180
  const lonRad = (lon * Math.PI) / 180
  const y = r * Math.sin(latRad)
  const x = r * Math.cos(latRad) * Math.sin(lonRad)
  const z = r * Math.cos(latRad) * Math.cos(lonRad)
  return new Vector3(x, y, z)
}

// Inverse of latLonToVec3, any radius (normalizes internally via v.length()). lon is
// atan2-derived, so a point exactly on the antimeridian resolves to +180 (never -180) —
// callers comparing lon values across the wrap must compare via
// ((a - b + 540) % 360) - 180, not raw subtraction.
export function vec3ToLatLon(v: Vector3): { lat: number; lon: number } {
  const len = v.length()
  const lat = (Math.asin(v.y / len) * 180) / Math.PI
  const lon = (Math.atan2(v.x, v.z) * 180) / Math.PI
  return { lat, lon }
}

interface LatLon { lat: number; lon: number }

// n+1 points from `from` to `to` along the great circle (slerp between the unit-sphere
// endpoints), lifted by an altitude bump proportional to angular distance:
// r * (1 + 0.25 * (angularDistance / PI) * sin(PI * t)) at parameter t = i/n — 0 at both ends
// (sin(0) = sin(PI) = 0, landing exactly on the surface), peaking at
// r * (1 + 0.25 * angularDistance / PI) at the apex (t = 0.5). Zero-distance pairs
// (angularDistance ~ 0) degenerate safely to n+1 copies of the same surface point — no NaN
// (the slerp denominator is guarded in the helper below).
export function greatCirclePoints(from: LatLon, to: LatLon, r: number, n: number): Vector3[] {
  const a = latLonToVec3(from.lat, from.lon, 1)
  const b = latLonToVec3(to.lat, to.lon, 1)
  const dot = Math.max(-1, Math.min(1, a.dot(b)))
  const angularDistance = Math.acos(dot)
  const points: Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = slerp(a, b, t, angularDistance)
    const bump = 1 + 0.25 * (angularDistance / Math.PI) * Math.sin(Math.PI * t)
    points.push(p.normalize().multiplyScalar(r * bump))
  }
  return points
}

// Spherical linear interpolation between two UNIT vectors. Falls back to a plain copy of `a`
// when the angle is ~0 (identical or numerically antipodal-adjacent points) to avoid a 0/0
// division — the caller always normalizes the result, so this degenerate case is safe.
function slerp(a: Vector3, b: Vector3, t: number, theta: number): Vector3 {
  if (theta < 1e-9) return a.clone()
  const s0 = Math.sin((1 - t) * theta) / Math.sin(theta)
  const s1 = Math.sin(t * theta) / Math.sin(theta)
  return new Vector3(
    a.x * s0 + b.x * s1,
    a.y * s0 + b.y * s1,
    a.z * s0 + b.z * s1,
  )
}
```

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run src/app/world/globe/geo.test.ts` → PASS (5 tests).
Run: `npm run build` → succeeds (`tsc` clean under `strict`/`noUnusedLocals`/`noUnusedParameters`
— the new `three` import resolves now that Step 1 installed it and `@types/three`; `vite build`
completes, emitting the new `three` vendor chunk per Step 2's `manualChunks`).
Run: `npx vitest run` → all suites green (nothing else references `geo.ts` or the texture yet).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vite.config.ts src/assets/globe/black-marble-2k.jpg \
  src/app/world/globe/geo.ts src/app/world/globe/geo.test.ts
git commit -m "feat(globe): add three/r3f deps, NASA night texture, pure geo math"
```

---

## Task 2: Engine arcs v2 — inter-region + drain `[sonnet]`

**Files:** modify `src/lib/worldEngine/index.ts` (the `EngineState` interface, `start()`'s
initializer, the routing block inside `runStep`, and `buildArcs` — this is the ONLY engine
change in Phase 5: no new files under `worldEngine/`, no type edits to the frozen contracts, no
`Math.random`, determinism preserved); create `src/lib/worldEngine/globeArcs.test.ts`; append one
informational entry to `.superpowers/sdd/contract-drift.md`.

**Grounding:** current `buildArcs` (`index.ts:462-477`), `EngineState` (`index.ts:71-111`),
`start()`'s initializer (`index.ts:562-576`), and the routing block inside `runStep`
(`index.ts:226-252`) are quoted verbatim below. `MAX_GLOBE_ARCS = 200` (`index.ts:43`, private —
stays private; the cap test below reasons about it via a comment, not an import).
`REGION_GEO_LOCAL` (aliased import of `REGION_GEO` from `../world/regionGeo`) is already
imported at `index.ts:37`. `s.prevFlows: Record<InstanceId, InstanceFlow>` — each `InstanceFlow`
carries `downstream: DownstreamFlow[]` (`{ dependencyId, toInstanceId?, toManagedServiceId?, rps,
hopClass, blocked }`, `flows.ts:47-54`); `s.compiled.instances[id].regionId` resolves an
instance's region directly (`ServiceInstance`, `world/types.ts:190-199`) — no re-derivation
needed. `s.failover.healthByScope: Map<string, HealthState>` (`failover.ts:28`) — region health
reads as `s.failover.healthByScope.get(regionId) ?? 'healthy'`, exactly the existing
`healthOfScope` closure helper (`index.ts:130`), reused as-is (it's already in scope where
`buildArcs`'s helpers are defined). `compileWorld` resolves EVERY blueprint dependency to EVERY
matching-blueprint instance world-wide (`compileWorld.ts:60-93`, no region scoping) — so even the
existing `e2eFixture` (web/api/db mirrored in both regions) already produces cross-region flows
via this mesh; the test fixtures below account for that (a dedicated single-region fixture is
used wherever a test needs to guarantee zero cross-region flow).

- [ ] **Step 1: Write the failing test `globeArcs.test.ts`**

```ts
// src/lib/worldEngine/globeArcs.test.ts
// Phase 5 T2: buildArcs v2 — inter-region + drain arcs, appended after the unchanged client
// arcs (D4). This file doesn't import fixtures/helpers from index.test.ts or
// serverParticles.test.ts (nothing there is exported) — the fixtures below are local
// copies/variants, the same convention every worldEngine test file already uses.
import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { REGION_GEO } from '../world/regionGeo'
import type { WorldDoc } from '../world/types'
import type { MetricsBatch, EngineEvent, FramePayload, VisualArc } from './types'

// A public-facing entry blueprint: the facade routes client demand only to blueprints that
// expose a 'public' port. Verbatim from index.test.ts.
function publicBlueprint(name: string, colorIndex: number) {
  const bp = createBlueprint(name, colorIndex)
  bp.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  return bp
}

// 2 regions / 3 AZ / 4 servers / 3 blueprints (web[entry] -> api -> db), one US population.
// Verbatim copy of index.test.ts's e2eFixture — every web instance's 'd-api' dependency
// mesh-resolves to ALL api instances everywhere (compileWorld has no region scoping), so this
// fixture inherently produces BOTH client arcs (population -> its resolved region) AND
// inter-region arcs (region-1 web instances calling region-2's api instance, and vice versa) —
// useful for the "client arcs unchanged" and "deterministic" cases below.
function e2eFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'geo'
  doc.routing.dnsTtlSec = 5

  const r1 = createRegion('us-east-1')
  const r2 = createRegion('eu-west-1')
  const az1a = createAz(r1.id, 'us-east-1a')
  const az1b = createAz(r1.id, 'us-east-1b')
  const az2a = createAz(r2.id, 'eu-west-1a')
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
  Object.assign(doc.azs, { [az1a.id]: az1a, [az1b.id]: az1b, [az2a.id]: az2a })

  const s1 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s2 = createServer(az1b.id, getPreset('dedicated-8')!)
  const s3 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s4 = createServer(az2a.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3, [s4.id]: s4 })

  const web = publicBlueprint('web', 0)
  const api = createBlueprint('api', 1)
  const db = createBlueprint('db', 2)
  web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })

  const place = (bpId: string, serverId: string) => {
    const pl = createPlacement(bpId, serverId)
    doc.placements[pl.id] = pl
    return pl
  }
  const web1a = place(web.id, s1.id); place(api.id, s1.id); place(db.id, s3.id)
  const web1b = place(web.id, s2.id); place(api.id, s2.id)
  const web2 = place(web.id, s4.id); place(api.id, s4.id); place(db.id, s4.id)

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 120
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2, az1a, az1b, pop, web1aInst: instanceId(web1a.id, 0), web1bInst: instanceId(web1b.id, 0), web2Inst: instanceId(web2.id, 0) }
}

// web (public, region1) with two dependencies, both resolving only to region2 blueprints — every
// admitted request crosses regions on BOTH dependencies, so aggregation must collapse the 2
// downstream rows into ONE (region1 -> region2) arc.
function crossRegionFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'geo'

  const r1 = createRegion('us-east-1')
  const r2 = createRegion('eu-west-1')
  const az1 = createAz(r1.id, 'us-east-1a')
  const az2 = createAz(r2.id, 'eu-west-1a')
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
  Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2 })

  const s1 = createServer(az1.id, getPreset('dedicated-8')!)
  const s2 = createServer(az2.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = publicBlueprint('web', 0)
  const api1 = createBlueprint('api1', 1)
  const api2 = createBlueprint('api2', 2)
  web.dependencies = [
    { id: 'd-api1', target: { kind: 'blueprint', blueprintId: api1.id }, port: 8080, protocol: 'http', packetTemplateId: null },
    { id: 'd-api2', target: { kind: 'blueprint', blueprintId: api2.id }, port: 8080, protocol: 'http', packetTemplateId: null },
  ]
  Object.assign(doc.blueprints, { [web.id]: web, [api1.id]: api1, [api2.id]: api2 })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  place(web.id, s1.id)
  place(api1.id, s2.id)
  place(api2.id, s2.id)

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 100
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2 }
}

// Everything in ONE region — compileWorld's mesh can only ever produce same-region hops here
// (localhost/same-az/cross-az), never cross-region. popCount lets the cap test crank population
// count without touching the rest of the topology.
function singleRegionFixture(popCount: number) {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'geo'
  doc.routing.dnsTtlSec = 5

  const r1 = createRegion('us-east-1')
  const az1a = createAz(r1.id, 'us-east-1a')
  const az1b = createAz(r1.id, 'us-east-1b')
  Object.assign(doc.regions, { [r1.id]: r1 })
  Object.assign(doc.azs, { [az1a.id]: az1a, [az1b.id]: az1b })

  const s1 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s2 = createServer(az1b.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = publicBlueprint('web', 0)
  const api = createBlueprint('api', 1)
  web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  place(web.id, s1.id); place(api.id, s1.id)
  place(web.id, s2.id); place(api.id, s2.id)

  for (let i = 0; i < popCount; i++) {
    const pop = createPopulation(`pop-${i}`, 40.7 + i * 0.01, -74.0 - i * 0.01)
    pop.peakRps = 10
    doc.populations[pop.id] = pop
  }

  const compiled = compileWorld(doc)
  return { doc, compiled, r1 }
}

function drive(doc: WorldDoc, compiled: ReturnType<typeof compileWorld>) {
  const engine = createWorldEngine(1)
  const batches: MetricsBatch[] = []
  const events: EngineEvent[] = []
  engine.start(doc, compiled, {
    onMetrics: b => batches.push(b),
    onEvent: e => events.push(e),
    onHealthChange: () => {},
  })
  const stepFor = (seconds: number) => engine.__test_step(seconds * 10)   // 100ms steps
  return { engine, batches, events, stepFor, latest: () => batches[batches.length - 1] }
}

// Verbatim re-implementation of the PRE-Phase-5 buildArcs' client-arc logic, fed by the same
// populationRoutes shape the engine publishes on MetricsBatch.world (WorldMetrics.populationRoutes
// — frozen contract, the same data buildArcs' engine-internal lastRoutingSnapshot holds). Used as
// an independent regression oracle instead of diffing against git history.
function computeExpectedClientArcs(doc: WorldDoc, routes: MetricsBatch['world']['populationRoutes']): VisualArc[] {
  const maxRps = Math.max(1, ...routes.map(r => r.rps))
  const arcs: VisualArc[] = []
  for (const r of routes) {
    if (r.populationId.startsWith('baseline:')) continue
    const pop = doc.populations[r.populationId]
    const region = doc.regions[r.regionId]
    const geo = region ? REGION_GEO[region.catalogId] : undefined
    if (!pop || !geo) continue
    arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geo.lat, geo.lon], intensity: Math.min(1, r.rps / maxRps), kind: 'client' })
  }
  return arcs
}

describe('buildArcs v2 (globe scope)', () => {
  it('client arcs unchanged for the baseline fixture', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    const expected = computeExpectedClientArcs(f.doc, sim.latest().world.populationRoutes)
    expect(frame.arcs.filter(a => a.kind === 'client')).toEqual(expected)
    sim.engine.stop()
  })

  it('cross-region dependency produces an inter-region arc with aggregated rps', () => {
    const f = crossRegionFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    const interArcs = frame.arcs.filter(a => a.kind === 'inter-region')
    // Both dependencies (d-api1, d-api2) land on region2 — one aggregated arc, not two.
    expect(interArcs).toHaveLength(1)
    const geoR1 = REGION_GEO['us-east-1']
    const geoR2 = REGION_GEO['eu-west-1']
    expect(interArcs[0]).toMatchObject({ fromLatLon: [geoR1.lat, geoR1.lon], toLatLon: [geoR2.lat, geoR2.lon], intensity: 1 })
    sim.engine.stop()
  })

  it('no inter-region arcs when all flows are intra-region', () => {
    const f = singleRegionFixture(1)
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    expect(frame.arcs.some(a => a.kind === 'inter-region')).toBe(false)
    sim.engine.stop()
  })

  it('population routed at a down region emits a drain arc until TTL expiry', () => {
    const f = singleRegionFixture(1)
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                   // warm the DNS cache -> r1
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(2)                                    // still inside the 5s TTL -> cache lags
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    const pop = Object.values(f.doc.populations)[0]
    const geoR1 = REGION_GEO['us-east-1']
    const drainArcs = frame.arcs.filter(a => a.kind === 'drain')
    expect(drainArcs).toHaveLength(1)
    expect(drainArcs[0]).toMatchObject({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geoR1.lat, geoR1.lon], intensity: 1 })
    sim.engine.stop()
  })

  it('drain arc from old to new region during pending failover, then clears', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                    // warm DNS cache -> us-east-1
    sim.engine.setOutage('region', f.r1.id, true)

    // Step one 100ms tick at a time until failover_started fires (the TTL-expiry re-resolve) —
    // avoids hardcoding the exact ms boundary; 100 steps (10s) is a generous safety margin over
    // the ~2-6s window index.test.ts's "honors DNS TTL" test observes for this same fixture.
    let startedFrame: FramePayload | null = null
    for (let i = 0; i < 100 && !startedFrame; i++) {
      sim.engine.__test_step(1)
      sim.engine.__test_render(1000)
      if (sim.events.some(e => e.kind === 'failover_started')) startedFrame = frames[frames.length - 1]
    }
    expect(startedFrame).not.toBeNull()
    const drainAtFlip = startedFrame!.arcs.filter(a => a.kind === 'drain')
    expect(drainAtFlip).toHaveLength(1)
    const geoR1 = REGION_GEO['us-east-1']
    const geoR2 = REGION_GEO['eu-west-1']
    expect(drainAtFlip[0]).toMatchObject({ fromLatLon: [geoR1.lat, geoR1.lon], toLatLon: [geoR2.lat, geoR2.lon], intensity: 1 })

    // Step until failover_completed fires; the drain arc must be gone by then.
    let completedFrame: FramePayload | null = null
    for (let i = 0; i < 100 && !completedFrame; i++) {
      sim.engine.__test_step(1)
      sim.engine.__test_render(1000)
      if (sim.events.some(e => e.kind === 'failover_completed')) completedFrame = frames[frames.length - 1]
    }
    expect(completedFrame).not.toBeNull()
    expect(completedFrame!.arcs.some(a => a.kind === 'drain')).toBe(false)
    sim.engine.stop()
  })

  it('cap truncates drain last, keeping client arcs first', () => {
    const f = singleRegionFixture(150)
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                    // warm DNS caches -> r1 for all 150 pops
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(1)                                     // still well inside the 5s TTL for every pop
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    // 150 client arcs + 150 drain candidates (case b, all still routed to the now-down r1) = 300
    // requested; MAX_GLOBE_ARCS = 200 (index.ts, private) caps the total, order client -> inter-
    // region -> drain: all 150 client kept, 0 inter-region (single region), 50 of 150 drain kept.
    expect(frame.arcs).toHaveLength(200)
    expect(frame.arcs.slice(0, 150).every(a => a.kind === 'client')).toBe(true)
    expect(frame.arcs.slice(150)).toHaveLength(50)
    expect(frame.arcs.slice(150).every(a => a.kind === 'drain')).toBe(true)
    sim.engine.stop()
  })

  it('deterministic under fixed seed', () => {
    const run = (): VisualArc[] => {
      const f = e2eFixture()
      const sim = drive(f.doc, f.compiled)
      let last: FramePayload | undefined
      sim.engine.attachRenderer({ level: 'globe' }, p => { last = p })
      sim.stepFor(5)
      sim.engine.__test_render(1000)
      sim.engine.stop()
      return last!.arcs
    }
    expect(run()).toEqual(run())
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/worldEngine/globeArcs.test.ts`
Expected: FAIL on 4 of 7 tests against the unmodified engine (assertion mismatches, not a module
error — `globeArcs.test.ts` only imports the existing `createWorldEngine`):
- `cross-region dependency produces an inter-region arc...` — `interArcs` has length 0, not 1.
- `population routed at a down region emits a drain arc...` — `drainArcs` has length 0, not 1.
- `drain arc from old to new region during pending failover...` — `drainAtFlip` has length 0.
- `cap truncates drain last...` — `frame.arcs` has length 150 (only client arcs exist, under the
  200 cap so nothing truncates), not 200.
The other 3 (`client arcs unchanged`, `no inter-region arcs when all flows are intra-region`,
`deterministic under fixed seed`) already pass against the unmodified engine — they're
regression/vacuous-negative/general-robustness guards, not new-behavior assertions.

- [ ] **Step 3: Modify `EngineState` — add `popPrevRegion`**

Old (`index.ts:93-98`):

```ts
  prevFlows: Record<InstanceId, InstanceFlow>
  windowTotals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number }
  lastRoutingSnapshot: RoutingSnapshot
  popRegion: Map<PopulationId, RegionId>
  pendingFailover: Map<PopulationId, RegionId>
  checkFailedPrev: Map<string, boolean>
```

New:

```ts
  prevFlows: Record<InstanceId, InstanceFlow>
  windowTotals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number }
  lastRoutingSnapshot: RoutingSnapshot
  popRegion: Map<PopulationId, RegionId>
  pendingFailover: Map<PopulationId, RegionId>
  // Phase 5 (D4): remembers each population's previous region for the pending-failover window,
  // so buildDrainArcs can render the globe's drain arc FROM the old region instead of falling
  // back to the population's own lat/lon. Engine-internal — not a contract type (see
  // contract-drift.md ## PHASE 5, entry logged in Step 7 below).
  popPrevRegion: Map<PopulationId, RegionId>
  checkFailedPrev: Map<string, boolean>
```

- [ ] **Step 4: Modify `start()` — initialize `popPrevRegion`**

Old (`index.ts:571-572`):

```ts
        lastRoutingSnapshot: { populationRoutes: [] }, popRegion: new Map(), pendingFailover: new Map(),
        checkFailedPrev: new Map(), instanceHealth: new Map(), oomRestartAt: new Map(), refusedRateLimit: new Map(),
```

New:

```ts
        lastRoutingSnapshot: { populationRoutes: [] }, popRegion: new Map(), pendingFailover: new Map(),
        popPrevRegion: new Map(),
        checkFailedPrev: new Map(), instanceHealth: new Map(), oomRestartAt: new Map(), refusedRateLimit: new Map(),
```

- [ ] **Step 5: Modify the routing block inside `runStep` — set/clear `popPrevRegion`**

Old (`index.ts:233-240`):

```ts
      if (prevRegion && prevRegion !== region) {
        emit('ttl_lag_expired', 'info', `${pop.label} DNS re-resolved ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        emit('failover_started', 'warning', `${pop.label} failing over ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        s.pendingFailover.set(pop.id, region)
      } else if (s.pendingFailover.get(pop.id) === region) {
        emit('failover_completed', 'info', `${pop.label} now served by ${region}`, [pop.id, region], simMs)
        s.pendingFailover.delete(pop.id)
      }
```

New:

```ts
      if (prevRegion && prevRegion !== region) {
        emit('ttl_lag_expired', 'info', `${pop.label} DNS re-resolved ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        emit('failover_started', 'warning', `${pop.label} failing over ${prevRegion} → ${region}`, [pop.id, prevRegion, region], simMs)
        s.pendingFailover.set(pop.id, region)
        s.popPrevRegion.set(pop.id, prevRegion)   // Phase 5: from-side for the globe drain arc
      } else if (s.pendingFailover.get(pop.id) === region) {
        emit('failover_completed', 'info', `${pop.label} now served by ${region}`, [pop.id, region], simMs)
        s.pendingFailover.delete(pop.id)
        s.popPrevRegion.delete(pop.id)
      }
```

- [ ] **Step 6: Modify `buildArcs`**

Old (`index.ts:462-477`, verbatim):

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

New — the same client logic (renamed `buildClientArcs`, body byte-identical) plus two new
helpers and a thin dispatcher, in the same place in the file:

```ts
  // Phase 5 (D4): client arcs first, byte-identical to Phase-2's original buildArcs, then
  // inter-region (cross-region dependency flows aggregated by region pair), then drain
  // (pending-failover / stuck-on-a-down-region populations). Total capped at MAX_GLOBE_ARCS,
  // truncating in that order — client arcs are never displaced.
  function buildArcs(): VisualArc[] {
    const arcs = buildClientArcs()
    if (arcs.length < MAX_GLOBE_ARCS) arcs.push(...buildInterRegionArcs(MAX_GLOBE_ARCS - arcs.length))
    if (arcs.length < MAX_GLOBE_ARCS) arcs.push(...buildDrainArcs(MAX_GLOBE_ARCS - arcs.length))
    return arcs
  }

  // Unchanged from Phase 2 (renamed from buildArcs) — body byte-identical.
  function buildClientArcs(): VisualArc[] {
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

  // One arc per (fromRegionId, toRegionId) pair, aggregated over this step's downstream flow
  // rows whose caller and target instances sit in different regions. Managed-service targets
  // (toManagedServiceId) have no instance region and are skipped — they aren't cross-region
  // client-visible flows. intensity = pairRps / maxPairRps, floored at 0.15 so a faint
  // cross-region link stays visible against a dominant one.
  function buildInterRegionArcs(budget: number): VisualArc[] {
    if (budget <= 0) return []
    const s = state!
    const pairs = new Map<string, { fromRegionId: RegionId; toRegionId: RegionId; rps: number }>()
    for (const flow of Object.values(s.prevFlows)) {
      const from = s.compiled.instances[flow.instanceId]
      if (!from) continue
      for (const row of flow.downstream) {
        if (!row.toInstanceId || row.rps <= 0) continue
        const to = s.compiled.instances[row.toInstanceId]
        if (!to || to.regionId === from.regionId) continue
        const key = `${from.regionId}->${to.regionId}`
        const entry = pairs.get(key)
        if (entry) entry.rps += row.rps
        else pairs.set(key, { fromRegionId: from.regionId, toRegionId: to.regionId, rps: row.rps })
      }
    }
    if (pairs.size === 0) return []
    const maxPairRps = Math.max(...[...pairs.values()].map(p => p.rps))
    const arcs: VisualArc[] = []
    for (const { fromRegionId, toRegionId, rps } of pairs.values()) {
      const fromGeo = REGION_GEO_LOCAL[s.doc.regions[fromRegionId]?.catalogId ?? '']
      const toGeo = REGION_GEO_LOCAL[s.doc.regions[toRegionId]?.catalogId ?? '']
      if (!fromGeo || !toGeo) continue
      const intensity = Math.max(0.15, Math.min(1, rps / maxPairRps))
      arcs.push({ fromLatLon: [fromGeo.lat, fromGeo.lon], toLatLon: [toGeo.lat, toGeo.lon], intensity, kind: 'inter-region' })
      if (arcs.length >= budget) break
    }
    return arcs
  }

  // (a) one arc per population in s.pendingFailover: from the PREVIOUS region (captured in
  // s.popPrevRegion when the switch happened — see the routing block in runStep) to the newly
  // resolved one; falls back to the population's own lat/lon when the previous region isn't
  // resolvable (defensive; popPrevRegion is set in the same step pendingFailover is). (b) one
  // arc per population still routed (this step's populationRoutes) to a region whose health is
  // 'down' — the DNS-TTL lag window where clients keep arriving at a dead region. Both kinds
  // render intensity 1 (a drain arc is binary — happening or not).
  function buildDrainArcs(budget: number): VisualArc[] {
    if (budget <= 0) return []
    const s = state!
    const arcs: VisualArc[] = []
    const geoOfRegion = (regionId: RegionId): [number, number] | null => {
      const region = s.doc.regions[regionId]
      const geo = region ? REGION_GEO_LOCAL[region.catalogId] : undefined
      return geo ? [geo.lat, geo.lon] : null
    }

    for (const [popId, newRegionId] of s.pendingFailover) {
      const pop = s.doc.populations[popId]
      const toGeo = geoOfRegion(newRegionId)
      if (!pop || !toGeo) continue
      const prevRegionId = s.popPrevRegion.get(popId)
      const fromGeo: [number, number] = (prevRegionId ? geoOfRegion(prevRegionId) : null) ?? [pop.lat, pop.lon]
      arcs.push({ fromLatLon: fromGeo, toLatLon: toGeo, intensity: 1, kind: 'drain' })
      if (arcs.length >= budget) return arcs
    }

    for (const r of s.lastRoutingSnapshot.populationRoutes) {
      if (r.populationId.startsWith('baseline:')) continue
      if (healthOfScope(r.regionId) !== 'down') continue
      const pop = s.doc.populations[r.populationId]
      const toGeo = geoOfRegion(r.regionId)
      if (!pop || !toGeo) continue
      arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: toGeo, intensity: 1, kind: 'drain' })
      if (arcs.length >= budget) return arcs
    }

    return arcs
  }
```

`healthOfScope` is the existing closure helper (`index.ts:130`), already in scope here — no new
import. `RegionId` is already imported at the top of the file (`index.ts:11`).

- [ ] **Step 7: Log the informational drift item**

Append to `.superpowers/sdd/contract-drift.md` (new `## PHASE 5` section at the end of the file,
continuing the entry numbering from Phase 4's `### 8.`):

```markdown

---

## PHASE 5 — R3F globe + traffic authoring

### 9. `EngineState` gains `popPrevRegion: Map<PopulationId, RegionId>` — informational (engine-internal, NOT a contract type)

**What:** Task 2 (`buildArcs` v2 — inter-region + drain globe arcs, spec D4) adds one field to
the engine-internal `EngineState` interface in `src/lib/worldEngine/index.ts`:
`popPrevRegion: Map<PopulationId, RegionId>`. It remembers each population's previous region for
the duration of a pending DNS-TTL failover, so the globe's red "drain" arc
(`VisualArc.kind: 'drain'`) can render from the OLD region to the NEW one instead of falling back
to the population's own lat/lon. Set in the routing block inside `runStep` (same site that sets
`s.pendingFailover`) when `prevRegion && prevRegion !== region`; cleared alongside
`s.pendingFailover.delete(pop.id)` when `failover_completed` fires.

**Why informational, not APPLIED/RESOLVED:** `EngineState` is not one of the frozen contract
types in `docs/superpowers/specs/2026-07-08-world-engine-contracts.md` — it's an engine-internal
implementation detail (same category as entry #4's `FailoverState`/`NicState` additions from
Phase 2). `VisualArc`, `FramePayload`, and every other frozen type are unchanged; `buildArcs`'s
public behavior only grows two new emitted `VisualArc.kind` values already sanctioned by the
frozen union (`'client' | 'inter-region' | 'drain'`).

**Phase-6 impact:** none — `popPrevRegion` is private to `createWorldEngine`'s closure, never
exposed on `WorldEngineApi`.
```

- [ ] **Step 8: Run tests + build**

Run: `npx vitest run src/lib/worldEngine/globeArcs.test.ts` → PASS (7 tests).
Run: `npx vitest run src/lib/worldEngine/index.test.ts` → PASS (unchanged — proves client-arc
byte-identity and the DNS-TTL/failover mechanics used by `popPrevRegion` weren't disturbed).
Run: `npx vitest run` → all suites green.
Run: `npm run build` → succeeds (`tsc` clean, `vite build` completes).

- [ ] **Step 9: Commit**

```bash
git add src/lib/worldEngine/index.ts src/lib/worldEngine/globeArcs.test.ts \
  .superpowers/sdd/contract-drift.md
git commit -m "feat(engine): globe arcs v2 — inter-region and failover-drain arcs"
```
