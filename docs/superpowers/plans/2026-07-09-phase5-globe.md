# Phase 5: R3F Globe + Traffic Authoring Implementation Plan

> Assembled by the Phase-5 executor from `docs/superpowers/plans/phase5/skeleton.md` +
> `fragments/{tasks-01-02, tasks-03-05, tasks-06-07}.md` per the execution handoff runbook
> (`docs/superpowers/plans/2026-07-09-phase5-execution-handoff.md`) Step 0. Grounding facts
> resolved before writing live in `docs/superpowers/plans/phase5/GROUNDING.md`.

## Execution model (agentic-workers)

Execute via superpowers **subagent-driven-development**: a fresh implementer subagent per task
(model tag `[sonnet]` on each task heading), a task-reviewer after each, fix subagents for any
Critical/Important findings, re-review, then one whole-branch review on the most capable model.
Every implementer follows **test-driven-development** (write the failing test, watch it fail,
implement, watch it pass). Tasks are serial T1 → T2 → T3 → T4 → T5 → T6 → T7; each commits before
the next begins. Progress + drift are tracked in `.superpowers/sdd/progress.md` `## PHASE 5` and
`.superpowers/sdd/contract-drift.md` `## PHASE 5`.

## Goal

Replace the Level-1 card grid with a real three.js globe (react-three-fiber): NASA night-lights
earth + atmosphere shader, health-colored region pins (pulsing on failover), teal client-population
markers, and live great-circle traffic arcs from the engine's globe payload (client + inter-region +
red failover-drain). Ship the missing traffic-layer authoring — populations (incl. click-the-globe
placement), auto-baseline traffic, routing policy — through the EXISTING `world.store` actions.

## Architecture

`src/app/world/globe/` is a NEW self-contained render module: pure geo math (`geo.ts`) feeds an
`<Canvas>` scene (`GlobeScene.tsx`) whose children are the pin/marker/arc layers; `GlobeView.tsx`
branches WebGL-scene vs. the extracted `GlobeCards.tsx` fallback (also the a11y path). The globe
reads `useSimulationStore` (`scrubBatch ?? latestBatch`, `attachRenderer({level:'globe'})`) and
`useWorldStore`/`useNavStore`; world mutations go only through existing `useWorldStore` actions. The
sole engine change is Task 2's additive `buildArcs` v2 in `src/lib/worldEngine/index.ts`.

## Tech Stack

`three@^0.185.1`, `@react-three/fiber@^9.6.1`, `@react-three/drei@^10.7.7`, `@types/three@^0.185.1`
(React-19-compatible majors, registry-verified). Existing: React 19, Zustand, framer-motion
(`useReducedMotion`), `@xyflow/react` (unaffected). A `three` vendor chunk is added to vite's
`manualChunks`. Texture: NASA Black Marble night lights, 2048×1024 JPEG, `src/assets/globe/`, ≤2.5MB.


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

---

# Phase 5 plan fragment — Tasks 3–5 (r3f globe scene · region pins/population markers · live arcs layer)

> Fragment scope: Task 3 (WebGL feature-detect, `GlobeScene`, `GlobeCards` extraction,
> `GlobeView` rewrite), Task 4 (`RegionPins`, `PopulationMarkers`), Task 5 (`ArcsLayer`). Global
> Constraints / File Structure live in the skeleton's assembled header
> (`docs/superpowers/plans/phase5/skeleton.md`) — not repeated here. This fragment assumes
> Task 1 (`three`/`@react-three/fiber`/`@react-three/drei` deps, `src/app/world/globe/geo.ts`
> exporting `latLonToVec3`/`vec3ToLatLon`/`greatCirclePoints`, and
> `src/assets/globe/black-marble-2k.jpg`) and Task 2 (`buildArcs` v2 emitting `client` /
> `inter-region` / `drain` `VisualArc`s, capped at `MAX_GLOBE_ARCS = 200`) have already landed
> on `phase5-globe`. It does not re-derive their surfaces — see `GROUNDING.md` for the verified
> T1/T2 facts this fragment imports verbatim.
>
> **Judgment calls (J1–J5), flagged inline where they bite and summarized here:**
> **J1 — texture longitude offset.** Three.js's default `SphereGeometry` UV places its own
> `u=0.25` seam at `lon=0` (derived below in `GlobeScene.tsx`'s comment from the geometry's own
> vertex formula vs. T1's `latLonToVec3` convention). A standard NASA Black Marble equirectangular
> mosaic centers the prime meridian at `u_texture=0.5`. Aligning the two requires
> `texture.offset.x = 0.25`. This is derived algebraically (not guessed) but is EXACTLY the
> "highest-risk bug" the skeleton calls out — Task 3's live smoke eyeballs continent shape and
> Task 4's live smoke proves it by pin placement; `TEXTURE_LON_OFFSET` is a single named constant
> to retune if either smoke disagrees. **J2 — pulse-eligible event kinds.** The skeleton says "a
> failover/outage event" without enumerating `EngineEventKind` members; this fragment defines
> `PULSE_EVENT_KINDS = {failover_started, failover_completed, ttl_lag_expired, outage_triggered,
> outage_cleared}` as the failover/outage-shaped subset (excludes `health_check_failed`, which
> precedes an actual failover/outage and would double-pulse the window). **J3 — node-env import
> safety.** `RegionPins.tsx` and `ArcsLayer.tsx` are `.tsx` files that import `@react-three/fiber`
> and `@react-three/drei`; their pure helpers (`pinColor`/`isPulsing`/`arcsSignature`) are tested
> by importing the SAME file under plain Node (no jsdom pragma), per the skeleton's exact
> phrasing. Both libraries are written to be import-safe outside a browser (they only touch
> `window`/`document` when a `<Canvas>` actually mounts) — if a task executor hits an import-time
> crash under Node, the fallback is to hoist the two/three helpers into a colocated pure module
> (e.g. `globe/pins.ts`, `globe/arcs.ts`) and re-export from the `.tsx` file; the test files'
> import paths do not need to change either way. **J4 — "pointerdown/up listeners".** The
> skeleton's idle-rotation pause is implemented via drei's `OrbitControls` `onStart`/`onEnd` props
> (documented pass-throughs to the underlying three.js controls' own `'start'`/`'end'` events,
> which fire on pointerdown/pointerup) rather than raw DOM listeners — same semantic, idiomatic
> drei API. **J5 — glow halo raycasting.** The additive glow sphere behind each pin/marker has no
> `onClick`; clicks resolve against the smaller opaque dot in front, so no raycast-disabling prop
> is needed on the glow mesh.

Dependency order within this fragment: T3 → T4 → T5, serial (T4 mounts inside T3's `GlobeScene`
children slot; T5 mounts inside the same slot after T4's layers).

---

## Task 3: Globe scene, fallback, GlobeView rewrite `[sonnet]`

**Files:** create `src/app/world/globe/webgl.ts`, `src/app/world/globe/GlobeScene.tsx`,
`src/app/world/GlobeCards.tsx`, `src/app/world/GlobeView.test.tsx`; REWRITE
`src/app/world/GlobeView.tsx`.

**Grounding:** `src/app/world/GlobeView.tsx` today (Phase-1 placeholder, read verbatim above) is
the exact card grid to extract into `GlobeCards.tsx` — same imports, same JSX, only the export
name changes (`GlobeView` → `GlobeCards`). `src/app/world/globe/` files import lib via
`../../../lib/...` and stores via `../../store/...` (three `../` to reach `src/`, same depth as
`src/app/world/region/*.ts` in the Phase-4 precedent); `GlobeView.tsx` itself sits one level
shallower (directly in `src/app/world/`) so its own imports are `../store/...`, `../../lib/...`,
`./useCompiledWorld`, `./globe/GlobeScene`, `./GlobeCards`. `useNavStore` exposes
`goRegion(regionId: string)` — nav's `RegionId`, not `catalogId`. `useWorldStore.getState().doc`
holds `regions: Record<RegionId, Region>` where `Region.catalogId` is the `WORLD_REGIONS` id.
`WorldShell.tsx` mounts `<GlobeView/>` unconditionally at `nav.level === 'globe'` (line 69) — no
change needed there. Texture import path from `src/app/world/globe/GlobeScene.tsx` to
`src/assets/globe/black-marble-2k.jpg` is `../../../assets/globe/black-marble-2k.jpg` (three
`../` from `globe/` to `src/`, then into `assets/globe/`).

- [ ] **Step 1: Write the failing test `GlobeView.test.tsx`**

```tsx
// src/app/world/GlobeView.test.tsx
// @vitest-environment jsdom
// R3F scene internals (GlobeScene + the T4/T5 layers it hosts) are NOT jsdom-tested — jsdom has
// no WebGL context, so @react-three/fiber's <Canvas> cannot mount there. This file exercises
// ONLY the WebGL-unavailable fallback branch (webgl.ts mocked); GlobeScene's live behavior is
// gated by this task's live smoke, stated explicitly.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('./globe/webgl', () => ({ webglAvailable: () => false }))

import { GlobeView } from './GlobeView'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { createWorld, createRegion } from '../../lib/world/factories'

function resetSim() {
  useSimulationStore.setState({
    running: false, timeScale: 1, latestBatch: null, events: [], healthOverrides: {},
    scrubIndex: null, scrubBatch: null, degraded: false,
  })
}

function seedOneRegion() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  doc.regions[region.id] = region
  useWorldStore.setState({ doc, history: [], future: [] })
  return { doc, region }
}

describe('GlobeView (fallback branch — WebGL unavailable)', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
    resetSim()
  })

  it('renders GlobeCards when webgl unavailable', () => {
    seedOneRegion()
    render(<GlobeView />)
    // GlobeCards' card grid renders the region's catalogId as a clickable card heading.
    expect(screen.getAllByText('us-east-1').length).toBeGreaterThan(0)
  })

  it('hidden a11y region list navigates', () => {
    const { region } = seedOneRegion()
    render(<GlobeView />)
    const nav = screen.getByRole('navigation', { name: 'Regions' })
    fireEvent.click(within(nav).getByRole('button', { name: 'us-east-1' }))
    expect(useNavStore.getState()).toMatchObject({ level: 'region', regionId: region.id })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/GlobeView.test.tsx`
Expected: FAIL — `Cannot find module './globe/webgl'` (the mocked module doesn't exist yet), then
after Step 3 lands, `Cannot find module './GlobeCards'`, etc. — each intermediate failure is a
missing-module error, not an assertion failure, since none of these files exist yet.

- [ ] **Step 3: Write `webgl.ts`**

```ts
// src/app/world/globe/webgl.ts
// One-shot cached WebGL feature-detect (Phase 5 D7). GlobeView calls this to decide between the
// real r3f scene and the GlobeCards fallback. Cached after the first call — probing WebGL forces
// the browser to spin up (and immediately discard) a GL context, which is wasteful to repeat on
// every GlobeView render/remount.
let cached: boolean | null = null

export function webglAvailable(): boolean {
  if (cached !== null) return cached
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    cached = !!gl
  } catch {
    cached = false
  }
  return cached
}
```

- [ ] **Step 4: Write `GlobeCards.tsx`** — today's `GlobeView.tsx` body, extracted verbatim

```tsx
// src/app/world/GlobeCards.tsx
// The pre-Phase-5 Level-1 card grid, extracted verbatim from the old GlobeView.tsx (only the
// export name changed). Survives as the WebGL-unavailable fallback AND as the visual reference
// screen readers effectively see (the canvas itself is aria-hidden — see GlobeView.tsx's hidden
// a11y region list, which is the REAL navigation surface in both branches; this component is
// just the sighted-fallback visual).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'

const card: CSSProperties = {
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)',
}

const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const

export function GlobeCards() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const goRegion = useNavStore(s => s.goRegion)
  const latestBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const regions = Object.values(doc.regions)

  return (
    <div style={{ padding: 24 }}>
      <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 4 }}>
        World — {regions.length} region{regions.length === 1 ? '' : 's'} · {Object.keys(compiled.instances).length} service instances
      </div>
      <div style={{ font: '11px var(--font-mono)', color: 'var(--color-text-muted)', marginBottom: 16 }}>
        {compiled.findings.length > 0
          ? `${compiled.findings.length} finding(s) — see the World panel`
          : 'no findings'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        {regions.map(r => {
          const azs = Object.values(doc.azs).filter(a => a.regionId === r.id)
          const serverCount = Object.values(doc.servers).filter(s => azs.some(a => a.id === s.azId)).length
          const label = WORLD_REGIONS.find(w => w.id === r.catalogId)?.label ?? r.catalogId
          return (
            <button key={r.id} style={card} onClick={() => goRegion(r.id)}>
              <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
              <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
                {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
              </div>
              {latestBatch?.regions[r.id] && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <span style={{ color: HEALTH_COLOR[latestBatch.regions[r.id].health] }}>● {latestBatch.regions[r.id].health}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.regions[r.id].rps.toFixed(0)} rps</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.regions[r.id].errorRate * 100).toFixed(1)}% err</span>
                </div>
              )}
            </button>
          )
        })}
        {regions.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', font: '12px var(--font-mono)' }}>
            No regions yet — add one in the World panel →
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Write `GlobeScene.tsx`**

```tsx
// src/app/world/globe/GlobeScene.tsx
// R3F night-earth scene (Phase 5 D2): self-lit sphere with the T1 NASA Black Marble texture, a
// backside additive-fresnel atmosphere shell, clamped OrbitControls, idle rotation (paused on
// interaction / disabled under reduced motion), and place-mode click-to-latlon. T4/T5 layers
// (RegionPins, PopulationMarkers, ArcsLayer) mount as `children` INSIDE the rotating group so
// they track the globe's orientation for free — no extra wiring needed here or in those files.
import { Suspense, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, useTexture } from '@react-three/drei'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { vec3ToLatLon } from './geo'
import earthTextureUrl from '../../../assets/globe/black-marble-2k.jpg'

const EARTH_RADIUS = 1
const ATMOSPHERE_SCALE = 1.03
const IDLE_ROTATION_RAD_PER_S = 0.02

// J1 (fragment header): three.js's default SphereGeometry (phiStart=0, phiLength=2π) places
// vertices at the equator as x=-r·cos(phi), z=r·sin(phi) where phi=u_geom·2π (u_geom = the
// geometry's own u coordinate, 0..1). T1's latLonToVec3 places the equator at x=r·sin(lon),
// z=r·cos(lon). Solving x/z equal at lon=0 (x=0,z=r) against the geometry's formula (x=0,z=r
// happens at phi=π/2, i.e. u_geom=0.25) shows the geometry's own u=0.25 seam sits at lon=0. A
// standard NASA Black Marble equirectangular mosaic centers the prime meridian at the image's
// horizontal middle (u_texture=0.5, since it spans lon -180..180 left-to-right). Sampling the
// texture at (u_geom + 0.25) aligns the two — hence texture.offset.x = 0.25. THIS IS THE
// PHASE'S HIGHEST-RISK CALIBRATION: if the live smoke shows continents mirrored/rotated, or
// (Task 4) us-east-1's pin lands in the Atlantic instead of Virginia, retune this ONE constant
// first (try 0.75, or negate lon in latLonToVec3's caller — but that would also move every pin,
// so prefer retuning this offset).
const TEXTURE_LON_OFFSET = 0.25

// ~20-line backside additive fresnel glow (Phase 5 D2/D6): rim brightens where the surface
// normal is near-perpendicular to the view direction, faint head-on. No external light needed —
// intensity is purely a function of view angle.
const ATMOSPHERE_VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`
const ATMOSPHERE_FRAGMENT_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform vec3 glowColor;
  void main() {
    float rim = 1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);
    float intensity = pow(rim, 2.2);
    gl_FragColor = vec4(glowColor, intensity * 0.9);
  }
`

interface EarthProps { placeMode: boolean; onPlace: (lat: number, lon: number) => void }

function Earth({ placeMode, onPlace }: EarthProps): ReactElement {
  const texture = useTexture(earthTextureUrl)
  useMemo(() => {
    texture.wrapS = THREE.RepeatWrapping
    texture.offset.x = TEXTURE_LON_OFFSET
    texture.colorSpace = THREE.SRGBColorSpace
  }, [texture])

  // Raycasts the earth mesh only (r3f's onClick gives the world-space intersection point,
  // already correct even though this mesh lives inside the rotating group — r3f resolves hits
  // in world space, not group-local space).
  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    if (!placeMode) return
    e.stopPropagation()
    const { lat, lon } = vec3ToLatLon(e.point)
    onPlace(lat, lon)
  }, [placeMode, onPlace])

  return (
    <mesh onClick={handleClick}>
      <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
      <meshBasicMaterial map={texture} />
    </mesh>
  )
}

function Atmosphere(): ReactElement {
  // useMemo so the THREE.Color instance (and its allocation) isn't recreated every render.
  const uniforms = useMemo(() => ({ glowColor: { value: new THREE.Color('#4A9EFF') } }), [])
  return (
    <mesh scale={ATMOSPHERE_SCALE}>
      <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
      <shaderMaterial
        vertexShader={ATMOSPHERE_VERTEX_SHADER}
        fragmentShader={ATMOSPHERE_FRAGMENT_SHADER}
        uniforms={uniforms}
        side={THREE.BackSide}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

interface RotatingGroupProps { reduced: boolean; interactingRef: { current: boolean }; children?: ReactNode }

function RotatingGroup({ reduced, interactingRef, children }: RotatingGroupProps): ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, delta) => {
    if (reduced || interactingRef.current) return
    if (groupRef.current) groupRef.current.rotation.y += IDLE_ROTATION_RAD_PER_S * delta
  })
  return <group ref={groupRef}>{children}</group>
}

export interface GlobeSceneProps {
  placeMode: boolean                                   // T6 arms this; T3 wires the prop through inert
  onPlace: (lat: number, lon: number) => void
  children?: ReactNode                                 // T4/T5 layers mount inside the Canvas
}

export function GlobeScene({ placeMode, onPlace, children }: GlobeSceneProps): ReactElement {
  const reduced = useReducedMotion() ?? false
  // J4 (fragment header): OrbitControls' onStart/onEnd are documented pass-throughs to the
  // underlying three.js controls' 'start'/'end' events, which fire on pointerdown/pointerup —
  // this IS the "pointerdown/up listeners" pause the skeleton describes, via the idiomatic drei
  // API rather than raw DOM listeners.
  const interactingRef = useRef(false)

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 2.8], fov: 45 }}
      style={{ cursor: placeMode ? 'crosshair' : 'default' }}
    >
      <Suspense fallback={null}>
        <RotatingGroup reduced={reduced} interactingRef={interactingRef}>
          <Earth placeMode={placeMode} onPlace={onPlace} />
          <Atmosphere />
          {children}
        </RotatingGroup>
      </Suspense>
      <OrbitControls
        enablePan={false}
        minDistance={1.6}
        maxDistance={5}
        enableDamping
        onStart={() => { interactingRef.current = true }}
        onEnd={() => { interactingRef.current = false }}
      />
    </Canvas>
  )
}
```

- [ ] **Step 6: Rewrite `GlobeView.tsx`**

```tsx
// src/app/world/GlobeView.tsx
// Level-1 globe (Phase 5 D2/D7): the real r3f night-earth scene when WebGL is available,
// GlobeCards (the pre-Phase-5 card grid) otherwise. A visually-hidden a11y region list with the
// same goRegion navigation renders in BOTH branches — the canvas container is aria-hidden
// (decorative to a screen reader; the hidden list is the real navigation surface there, and it
// also covers any environment that passes the WebGL probe but still renders nothing).
import { useState, type CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { webglAvailable } from './globe/webgl'

const visuallyHidden: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
}

function RegionA11yList() {
  const doc = useWorldStore(s => s.doc)
  const goRegion = useNavStore(s => s.goRegion)
  const regions = Object.values(doc.regions)
  return (
    <nav aria-label="Regions" style={visuallyHidden}>
      <ul>
        {regions.map(r => (
          <li key={r.id}>
            <button onClick={() => goRegion(r.id)}>{r.catalogId}</button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function GlobeView() {
  // Place-mode is T6's concern; T3 wires the prop through inert (always false, no-op onPlace) so
  // GlobeScene's click-to-place raycast exists but nothing arms it until T6 lifts real state in.
  const [placeMode] = useState(false)
  const onPlace = () => {}

  if (!webglAvailable()) {
    return (
      <>
        <GlobeCards />
        <RegionA11yList />
      </>
    )
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
        <GlobeScene placeMode={placeMode} onPlace={onPlace}>
          {/* RegionPins + PopulationMarkers mount here (T4); ArcsLayer mounts here (T5) */}
        </GlobeScene>
      </div>
      <RegionA11yList />
    </div>
  )
}
```

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run src/app/world/GlobeView.test.tsx` → PASS (2 tests).
Run: `npm run build` → succeeds (tsc clean under `strict`/`noUnusedLocals`/`noUnusedParameters`;
the `three` vendor chunk from T1's `vite.config.ts` edit absorbs the new r3f/drei/three code —
confirm the build log shows a separate `three` chunk, not the main bundle ballooning).
Run: `npx vitest run` → all suites green (T1's `geo.test.ts` unaffected; this file's 2 new
tests pass; nothing else touches these files).

- [ ] **Step 8: Live Playwright smoke (controller-run, strict port 1420)**

1. `npm run dev` (background); wait for `Local:   http://localhost:1420/`.
2. `browser_navigate` → `http://localhost:1420`; click "New World" (HomeScreen) to land at the
   globe level (default `nav.level: 'globe'`).
3. `browser_snapshot` / `browser_take_screenshot` → confirm: a rotating night-lit sphere with a
   soft blue atmosphere rim on a near-black background (`#04050A`-ish canvas), no console errors
   yet. Save as `task3-globe-scene.png`.
4. **Texture-orientation eyeball (the calibration proof this task owns):** watch a few seconds of
   idle rotation (or `browser_drag` from canvas-center to a point ~80px right to spin it
   manually) and confirm recognizable, non-mirrored continent shapes pass by — North/South
   America, then the Atlantic, then Africa/Europe, then Asia, in that left-to-right order as the
   globe rotates. If continents appear as mirror images or the order runs backwards, retune
   `TEXTURE_LON_OFFSET` in `GlobeScene.tsx` per J1's comment before proceeding (pin-position proof
   lands in Task 4's smoke, but a mirrored texture is visible here first).
5. `browser_drag` on the canvas (~100px horizontal) → `browser_snapshot` → globe visibly rotated
   from the drag, confirming `OrbitControls` responds to pointer drag.
6. `browser_evaluate` a synthetic wheel event on the canvas element (`canvas.dispatchEvent(new
   WheelEvent('wheel', { deltaY: -300, bubbles: true }))`) twice, then once with `deltaY: 900`
   several times → `browser_snapshot` after each → globe visibly zooms in then out, but never
   closer than the `minDistance=1.6`/`maxDistance=5` clamp (camera stops moving past those
   points — verify via `browser_evaluate` reading the camera's `position.length()` if the visual
   change alone is ambiguous).
7. Confirm idle rotation resumes a beat after releasing the drag (interaction flag clears via
   `onEnd`) — two screenshots ~1.5s apart post-drag should show a small further rotation delta.
8. Reduced-motion pass: emulate `prefers-reduced-motion: reduce` for the page (e.g. via
   `browser_run_code_unsafe` calling the underlying Playwright context's
   `page.emulateMedia({ reducedMotion: 'reduce' })`), reload, and confirm across two screenshots
   ~2s apart that the globe does NOT rotate on its own (still draggable, just no idle spin).
9. `browser_console_messages` → assert ZERO error-level entries throughout.
10. Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add src/app/world/globe/webgl.ts src/app/world/globe/GlobeScene.tsx \
        src/app/world/GlobeCards.tsx src/app/world/GlobeView.tsx src/app/world/GlobeView.test.tsx
git commit -m "feat(globe): r3f night-earth scene with atmosphere, controls, and card fallback"
```

---

## Task 4: Region pins + population markers `[sonnet]`

**Files:** create `src/app/world/globe/RegionPins.tsx`, `src/app/world/globe/RegionPins.test.ts`,
`src/app/world/globe/PopulationMarkers.tsx`; edit `src/app/world/GlobeView.tsx` (mount both as
`GlobeScene` children).

**Grounding:** `REGION_GEO: Record<string, {lat,lon}>` (`src/lib/world/regionGeo.ts`, import from
`globe/` as `../../../lib/world/regionGeo`) is keyed by `catalogId`; skip any `doc.regions` entry
whose `catalogId` isn't a key. `RegionMetrics.health` reads via
`(scrubBatch ?? latestBatch)?.regions[id]?.health ?? 'healthy'` (D1 convention, same as every
other Phase-3/4 metric read). `EngineEvent.affected: string[]` carries region/az/server/instance/
population ids depending on kind (frozen contracts); pulse-eligibility only checks region-id
membership directly (no az/server expansion — unlike Phase 4's `regionEvents`, a globe pin only
cares about events stamped with the region itself, since `failover_started`/`outage_triggered`
etc. are emitted with the region id in `affected`, per the T2 grounding's failover-loop citation).
`useNavStore(s => s.goRegion)` takes the doc `RegionId`, not `catalogId`. `doc.populations:
Record<PopulationId, ClientPopulation>` (`{id, label, lat, lon, peakRps, diurnal}`,
`src/lib/world/types.ts:31-38`).

- [ ] **Step 1: Write the failing test `RegionPins.test.ts`**

```ts
// src/app/world/globe/RegionPins.test.ts
// Pure-logic coverage for RegionPins.tsx's two exported helpers (pinColor, isPulsing) — the
// component itself is R3F and NOT jsdom-tested (no WebGL there); this task's live smoke is its
// gate. Node env (no @vitest-environment pragma): importing RegionPins.tsx pulls in
// @react-three/fiber/drei, which are import-safe outside a browser (see fragment header J3).
import { describe, it, expect } from 'vitest'
import { pinColor, isPulsing } from './RegionPins'
import type { EngineEvent } from '../../../lib/worldEngine/types'

function evt(over: Partial<EngineEvent>): EngineEvent {
  return { id: 'e', simMs: 0, kind: 'outage_triggered', severity: 'critical', message: '', affected: [], ...over }
}

describe('pinColor', () => {
  it('maps health states', () => {
    expect(pinColor('healthy')).toBe('#22C55E')
    expect(pinColor('degraded')).toBe('#F59E0B')
    expect(pinColor('down')).toBe('#EF4444')
  })
})

describe('isPulsing', () => {
  it('pulses within 10s of a region outage event', () => {
    const events = [evt({ kind: 'outage_triggered', affected: ['r1'], simMs: 5000 })]
    expect(isPulsing(events, 'r1', 12_000)).toBe(true)   // 7s old
  })

  it('stops after 10s', () => {
    const events = [evt({ kind: 'outage_triggered', affected: ['r1'], simMs: 5000 })]
    expect(isPulsing(events, 'r1', 15_001)).toBe(false)  // 10.001s old
  })

  it('ignores events for other regions and non-failover/outage kinds', () => {
    const events = [
      evt({ kind: 'outage_triggered', affected: ['other-region'], simMs: 9000 }),
      evt({ kind: 'oom_kill', affected: ['r1'], simMs: 9500 }),
    ]
    expect(isPulsing(events, 'r1', 10_000)).toBe(false)
  })

  it('a failover_started event also triggers the pulse', () => {
    const events = [evt({ kind: 'failover_started', affected: ['r1'], simMs: 8000 })]
    expect(isPulsing(events, 'r1', 8500)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/globe/RegionPins.test.ts`
Expected: FAIL — `Cannot find module './RegionPins'`.

- [ ] **Step 3: Write `RegionPins.tsx`**

```tsx
// src/app/world/globe/RegionPins.tsx
// Health-lit region pins (Phase 5 D5): one small self-lit dot + additive glow halo per doc
// region with a REGION_GEO-known catalogId, colored by RegionMetrics.health, labeled via drei
// <Html>, pulsing while a failover/outage event touching the region is <10s old, click → nav.
// Reads stores directly (no props) — mounted as a GlobeScene child (T3) alongside
// PopulationMarkers/ArcsLayer. R3F component; NOT jsdom-tested (no WebGL there) — this task's
// live smoke is the gate. The two exported pure helpers below (pinColor, isPulsing) ARE
// unit-tested (node env, RegionPins.test.ts) since they carry the only testable logic.
import { useMemo, useRef, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useReducedMotion } from 'framer-motion'
import type { Mesh } from 'three'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { REGION_GEO } from '../../../lib/world/regionGeo'
import { latLonToVec3 } from './geo'
import type { HealthState, EngineEvent, EngineEventKind } from '../../../lib/worldEngine/types'
import type { RegionId } from '../../../lib/world/types'

const EARTH_RADIUS = 1
const PIN_ALTITUDE = EARTH_RADIUS * 1.002   // lifted slightly off the surface to avoid z-fighting
const PIN_RADIUS = 0.018
const GLOW_RADIUS = PIN_RADIUS * 2.4
const PULSE_WINDOW_MS = 10_000
const PULSE_PERIOD_S = 1

// Local hex map (Theme/constants: material colors inside a WebGL scene aren't a plain CSS
// var() substitution — same carve-out the arc colors use). Values match theme.ts's DARK_COLORS.
const HEALTH: Record<HealthState, string> = { healthy: '#22C55E', degraded: '#F59E0B', down: '#EF4444' }
const DOWN_LABEL_COLOR = '#FF8A8A'   // matches the mockup's down-pin label tint
const HEALTHY_LABEL_COLOR = '#BFD6FF'

// J2 (fragment header): the failover/outage-shaped subset of EngineEventKind — excludes
// health_check_failed (precedes an actual failover/outage; including it would double-pulse the
// window once the real failover/outage event lands moments later).
const PULSE_EVENT_KINDS = new Set<EngineEventKind>([
  'failover_started', 'failover_completed', 'ttl_lag_expired', 'outage_triggered', 'outage_cleared',
])

export function pinColor(health: HealthState): string {
  return HEALTH[health]
}

export function isPulsing(events: EngineEvent[], regionId: RegionId, nowSimMs: number): boolean {
  return events.some(e =>
    PULSE_EVENT_KINDS.has(e.kind) && e.affected.includes(regionId) &&
    e.simMs <= nowSimMs && nowSimMs - e.simMs < PULSE_WINDOW_MS)
}

interface PinProps { regionId: RegionId; catalogId: string; lat: number; lon: number }

function RegionPin({ regionId, catalogId, lat, lon }: PinProps): ReactElement {
  const goRegion = useNavStore(s => s.goRegion)
  const health = useSimulationStore(s => (s.scrubBatch ?? s.latestBatch)?.regions[regionId]?.health ?? 'healthy')
  const events = useSimulationStore(s => s.events)
  const simMs = useSimulationStore(s => (s.scrubBatch ?? s.latestBatch)?.simMs ?? 0)
  const reduced = useReducedMotion() ?? false
  const pulsing = !reduced && isPulsing(events, regionId, simMs)

  const pinRef = useRef<Mesh>(null)
  const position = useMemo(() => latLonToVec3(lat, lon, PIN_ALTITUDE), [lat, lon])
  const color = pinColor(health)
  const down = health === 'down'

  // Frame callback: reads `pulsing` from the latest render's closure (r3f updates useFrame's
  // callback ref every render — no stale-closure risk) and writes ONLY to the mesh's scale ref.
  // Never calls setState here.
  useFrame((state) => {
    if (!pinRef.current) return
    if (!pulsing) { pinRef.current.scale.setScalar(1); return }
    const t = (state.clock.elapsedTime % PULSE_PERIOD_S) / PULSE_PERIOD_S   // 0..1 sawtooth
    pinRef.current.scale.setScalar(1 + 0.35 * Math.sin(t * Math.PI))        // 1 -> 1.35 -> 1
  })

  return (
    <group position={position}>
      <mesh
        ref={pinRef}
        onClick={e => { e.stopPropagation(); goRegion(regionId) }}
        onPointerOver={() => { document.body.style.cursor = 'pointer' }}
        onPointerOut={() => { document.body.style.cursor = 'default' }}
      >
        <sphereGeometry args={[PIN_RADIUS, 16, 16]} />
        {/* Self-lit (emissive-only, color=black zeroes the unlit diffuse contribution) — the
            scene has no lights (D2: no sun simulation), so a plain meshStandardMaterial color
            would render black without this. emissiveIntensity bumps on hover for "brighten". */}
        <meshStandardMaterial color="black" emissive={color} emissiveIntensity={1.1} />
      </mesh>
      <mesh>
        <sphereGeometry args={[GLOW_RADIUS, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      <Html occlude distanceFactor={8} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
        <span style={{ font: '9px var(--font-mono)', color: down ? DOWN_LABEL_COLOR : HEALTHY_LABEL_COLOR }}>
          {catalogId}{down && <span style={{ color: DOWN_LABEL_COLOR }}> ▼ down</span>}
        </span>
      </Html>
    </group>
  )
}

export function RegionPins(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const regions = Object.values(doc.regions).filter(r => REGION_GEO[r.catalogId] != null)
  return (
    <>
      {regions.map(r => {
        const geo = REGION_GEO[r.catalogId]
        return <RegionPin key={r.id} regionId={r.id} catalogId={r.catalogId} lat={geo.lat} lon={geo.lon} />
      })}
    </>
  )
}
```

- [ ] **Step 4: Write `PopulationMarkers.tsx`**

```tsx
// src/app/world/globe/PopulationMarkers.tsx
// Teal client-population markers (Phase 5 D5): one small dot per ClientPopulation at its
// lat/lon, hover-only label `label · <peakRps> rps`, no click (editing lives in the T6 Traffic
// tab). Reads the world store directly — mounted as a GlobeScene child (T3). R3F component; NOT
// jsdom-tested (no WebGL there) — this task's live smoke is the gate.
import { useMemo, useState, type ReactElement } from 'react'
import { Html } from '@react-three/drei'
import { useWorldStore } from '../../store/world.store'
import { latLonToVec3 } from './geo'

const EARTH_RADIUS = 1
const MARKER_ALTITUDE = EARTH_RADIUS * 1.002
const MARKER_RADIUS = 0.012
const TEAL = '#2DD4BF'          // matches the arc/theme teal (D6) — population markers are the
                                 // arc's origin point, same color family
const LABEL_COLOR = '#7DEFDD'

interface MarkerProps { label: string; lat: number; lon: number; peakRps: number }

function PopulationMarker({ label, lat, lon, peakRps }: MarkerProps): ReactElement {
  const [hovered, setHovered] = useState(false)
  const position = useMemo(() => latLonToVec3(lat, lon, MARKER_ALTITUDE), [lat, lon])

  return (
    <group position={position}>
      <mesh onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
        <sphereGeometry args={[MARKER_RADIUS, 12, 12]} />
        <meshStandardMaterial color="black" emissive={TEAL} emissiveIntensity={hovered ? 1.6 : 1} />
      </mesh>
      {hovered && (
        <Html occlude distanceFactor={8} style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <span style={{ font: '9px var(--font-mono)', color: LABEL_COLOR }}>
            {label} · {peakRps.toFixed(0)} rps
          </span>
        </Html>
      )}
    </group>
  )
}

export function PopulationMarkers(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const populations = Object.values(doc.populations)
  return (
    <>
      {populations.map(p => (
        <PopulationMarker key={p.id} label={p.label} lat={p.lat} lon={p.lon} peakRps={p.peakRps} />
      ))}
    </>
  )
}
```

- [ ] **Step 5: Edit `GlobeView.tsx`** — mount `RegionPins` + `PopulationMarkers`

Change 1 — add imports (after the `GlobeCards` import):

```tsx
// OLD
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { webglAvailable } from './globe/webgl'
// NEW
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { webglAvailable } from './globe/webgl'
```

Change 2 — replace the placeholder comment with the real mounts:

```tsx
// OLD
        <GlobeScene placeMode={placeMode} onPlace={onPlace}>
          {/* RegionPins + PopulationMarkers mount here (T4); ArcsLayer mounts here (T5) */}
        </GlobeScene>
// NEW
        <GlobeScene placeMode={placeMode} onPlace={onPlace}>
          <RegionPins />
          <PopulationMarkers />
          {/* ArcsLayer mounts here (T5) */}
        </GlobeScene>
```

- [ ] **Step 6: Run tests + build**

Run: `npx vitest run src/app/world/globe/RegionPins.test.ts` → PASS (5 tests).
Run: `npx vitest run src/app/world/GlobeView.test.tsx` → still PASS (2 tests — the Step 5 edit
only changes the WebGL-available branch, which this file's tests never exercise since
`webglAvailable` stays mocked `false`).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green.

- [ ] **Step 7: Live Playwright smoke (controller-run, port 1420)**

1. `npm run dev` (background); wait for ready.
2. `browser_navigate` → `http://localhost:1420`; click "New World".
3. Author a minimal 2-region world via the dev debug hook (`window.__scalemapDebug`, DEV-only —
   no population-authoring UI exists before T6): `browser_evaluate` —
   ```js
   const { useWorldStore } = window.__scalemapDebug
   const s = useWorldStore.getState()
   const east = s.addRegion('us-east-1')
   const west = s.addRegion('eu-west-1')
   s.addPopulation('NYC', 40.7, -74.0)
   ```
4. `browser_snapshot` / `browser_take_screenshot` → **CALIBRATION PROOF**: confirm the
   `us-east-1` pin sits on/near the US EAST COAST (not in the ocean, not mirrored to the Pacific
   or Asia) and `eu-west-1` sits on/near IRELAND. This is the phase's highest-risk visual bug — if
   either pin is clearly wrong, stop and retune `TEXTURE_LON_OFFSET` (J1, `GlobeScene.tsx`) before
   continuing; re-run this step after any retune. Save as `task4-pin-calibration.png`.
5. `browser_snapshot` → confirm the teal NYC population marker sits near the US East Coast (close
   to but distinct from the `us-east-1` pin).
6. Hover the NYC marker (`browser_hover` or equivalent pointer move over its screen coordinates)
   → `browser_snapshot` → confirm a label `NYC · 0 rps` (peakRps defaults from `addPopulation`;
   note the exact default and adjust the expected string if it differs) appears only while
   hovered.
7. Trigger a region outage via the debug hook (fallback per GROUNDING's stated dev-hook purpose):
   `browser_evaluate` → `window.__scalemapDebug.useSimulationStore.getState().setOutage('region',
   east, true)` (using the `east` id captured in step 3 — re-read it via
   `useWorldStore.getState().doc.regions` if the id wasn't retained across evaluate calls).
   Requires the sim to be `running` first — click "Simulate" (header `SimControls`) before this
   step if `setOutage` is a no-op while stopped.
8. `browser_snapshot` → the `us-east-1` pin now renders red with a `▼ down` label suffix and is
   visibly larger/smaller across two screenshots ~0.5s apart (pulse animation).
9. Click the `us-east-1` pin (`browser_click` at its screen coordinates) → `browser_snapshot` →
   confirm navigation to the region flow page (breadcrumb / page content shows `us-east-1`).
10. `browser_console_messages` → assert ZERO error-level entries.
11. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add src/app/world/globe/RegionPins.tsx src/app/world/globe/RegionPins.test.ts \
        src/app/world/globe/PopulationMarkers.tsx src/app/world/GlobeView.tsx
git commit -m "feat(globe): health-lit region pins and population markers"
```

---

## Task 5: Live arcs layer `[sonnet]`

**Files:** create `src/app/world/globe/ArcsLayer.tsx`, `src/app/world/globe/ArcsLayer.test.ts`;
edit `src/app/world/GlobeView.tsx` (mount `ArcsLayer` in the remaining placeholder slot).

**Grounding:** `attachRenderer({level:'globe'}, onFrame): DetachFn`
(`useSimulationStore.getState().attachRenderer`, frozen contracts) delivers `FramePayload {
simMs, particles, arcs }` every animation frame; globe scope's `particles` is always `[]`, only
`arcs: VisualArc[]` matters. `VisualArc { fromLatLon: [number,number]; toLatLon:
[number,number]; intensity: number; kind: 'client'|'inter-region'|'drain' }`. `MAX_GLOBE_ARCS =
200` is a `worldEngine`-internal constant (not exported) — this file defines its own local
`MAX_GLOBE_ARCS = 200` mirroring it (pool size only ever needs to match the engine's own cap, per
D6). `greatCirclePoints(from, to, r, n)` (T1, `./geo`) returns `n+1` points. Renderer-attach
discipline mirrors `AzSimOverlay.tsx` exactly: attach inside a `useEffect` gated on `[running]`,
call `useSimulationStore.getState().attachRenderer(...)` imperatively (not the reactive hook
form) to avoid re-subscribing on unrelated re-renders, return the detach fn as the effect
cleanup, and write frame data only into a ref inside `onFrame` — never `setState`.

- [ ] **Step 1: Write the failing test `ArcsLayer.test.ts`**

```ts
// src/app/world/globe/ArcsLayer.test.ts
// Pure-logic coverage for ArcsLayer.tsx's exported arcsSignature helper — the component itself
// is R3F and NOT jsdom-tested (no WebGL there); this task's live smoke is its gate. Node env (no
// @vitest-environment pragma) — see fragment header J3 on importing a .tsx that pulls in
// @react-three/fiber/three.
import { describe, it, expect } from 'vitest'
import { arcsSignature } from './ArcsLayer'
import type { VisualArc } from '../../../lib/worldEngine/types'

function arc(over: Partial<VisualArc>): VisualArc {
  return { fromLatLon: [0, 0], toLatLon: [10, 10], intensity: 0.5, kind: 'client', ...over }
}

describe('arcsSignature', () => {
  it('changes when an endpoint moves', () => {
    const a = [arc({})]
    const b = [arc({ toLatLon: [11, 10] })]
    expect(arcsSignature(a)).not.toBe(arcsSignature(b))
  })

  it('changes when kind changes', () => {
    const a = [arc({ kind: 'client' })]
    const b = [arc({ kind: 'inter-region' })]
    expect(arcsSignature(a)).not.toBe(arcsSignature(b))
  })

  it('does not change when only intensity changes', () => {
    const a = [arc({ intensity: 0.1 })]
    const b = [arc({ intensity: 0.9 })]
    expect(arcsSignature(a)).toBe(arcsSignature(b))
  })

  it('changes on arc count (append/remove), and empty arrays match', () => {
    expect(arcsSignature([arc({})])).not.toBe(arcsSignature([arc({}), arc({ toLatLon: [20, 20] })]))
    expect(arcsSignature([])).toBe(arcsSignature([]))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/globe/ArcsLayer.test.ts`
Expected: FAIL — `Cannot find module './ArcsLayer'`.

- [ ] **Step 3: Write `ArcsLayer.tsx`**

```tsx
// src/app/world/globe/ArcsLayer.tsx
// Live great-circle traffic arcs (Phase 5 D6): attaches the globe-scope renderer once per
// `running`, writes each frame's VisualArc[] into a ref, and drives a fixed-size pool of
// THREE.Line objects (LineDashedMaterial) — geometry rebuilt only when the arc SET's signature
// changes (endpoints/kind), opacity and dash-flow updated every frame regardless. Mounted as a
// GlobeScene child (T3), alongside RegionPins/PopulationMarkers (T4) — lives in the same
// rotating group so arcs track the globe's orientation. R3F component; NOT jsdom-tested (no
// WebGL there) — this task's live smoke is the gate. arcsSignature is the one exported pure
// helper, unit-tested in ArcsLayer.test.ts.
import { useEffect, useRef, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { useSimulationStore } from '../../store/simulation.store'
import { greatCirclePoints } from './geo'
import type { VisualArc, FramePayload } from '../../../lib/worldEngine/types'

// Mirrors worldEngine's own (unexported) MAX_GLOBE_ARCS — the pool only ever needs to match the
// engine's own render cap (D6); not importable, so kept in sync manually here.
const MAX_GLOBE_ARCS = 200
const ARC_SEGMENTS = 48
const ARC_RADIUS = 1.001
const DASH_SIZE = 0.045
const GAP_SIZE = 0.03
const DASH_SPEED = 0.15   // dashOffset units/sec

const ARC_COLOR: Record<VisualArc['kind'], string> = {
  client: '#2DD4BF', 'inter-region': '#4A9EFF', drain: '#EF4444',
}

// Order-sensitive by design: a reorder of the SAME arcs (which would misalign the pool's
// index-to-arc mapping between frames) also changes this string, forcing a rebuild — see the
// per-frame update loop below for why that alignment matters.
export function arcsSignature(arcs: VisualArc[]): string {
  return arcs.map(a => `${a.kind}:${a.fromLatLon}:${a.toLatLon}`).join('|')
}

interface PoolEntry { line: THREE.Line; material: THREE.LineDashedMaterial; geometry: THREE.BufferGeometry }

export function ArcsLayer(): ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  const poolRef = useRef<PoolEntry[]>([])
  const latestArcsRef = useRef<VisualArc[]>([])
  const lastSignatureRef = useRef<string>('')
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion() ?? false

  // Build the fixed-size pool once (mount only) — lines start hidden until real arcs fill them.
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const pool: PoolEntry[] = []
    for (let i = 0; i < MAX_GLOBE_ARCS; i++) {
      const geometry = new THREE.BufferGeometry()
      const material = new THREE.LineDashedMaterial({
        color: ARC_COLOR.client, dashSize: DASH_SIZE, gapSize: GAP_SIZE, transparent: true, opacity: 0,
      })
      const line = new THREE.Line(geometry, material)
      line.visible = false
      line.frustumCulled = false
      group.add(line)
      pool.push({ line, material, geometry })
    }
    poolRef.current = pool
    return () => {
      for (const entry of pool) {
        group.remove(entry.line)
        entry.geometry.dispose()
        entry.material.dispose()
      }
      poolRef.current = []
    }
  }, [])

  // Attach the globe renderer once per `running` (AzSimOverlay precedent): imperative
  // getState().attachRenderer call, ref-only writes inside onFrame, detach on stop/unmount.
  useEffect(() => {
    if (!running) {
      latestArcsRef.current = []
      return
    }
    const detach = useSimulationStore.getState().attachRenderer({ level: 'globe' }, (payload: FramePayload) => {
      latestArcsRef.current = payload.arcs
    })
    return detach
  }, [running])

  useFrame((_, delta) => {
    const pool = poolRef.current
    if (pool.length === 0) return
    const arcs = latestArcsRef.current
    // The one per-frame allocation this file makes — mandated by the skeleton's exact
    // signature algorithm, bounded by MAX_GLOBE_ARCS (≤200 short strings), cheap relative to
    // the WebGL frame budget. Every other per-frame write below touches only refs/material
    // props, no allocations.
    const signature = arcsSignature(arcs)

    if (signature !== lastSignatureRef.current) {
      lastSignatureRef.current = signature
      for (let i = 0; i < pool.length; i++) {
        const entry = pool[i]
        const arc = arcs[i]
        if (!arc) { entry.line.visible = false; continue }
        const points = greatCirclePoints(
          { lat: arc.fromLatLon[0], lon: arc.fromLatLon[1] },
          { lat: arc.toLatLon[0], lon: arc.toLatLon[1] },
          ARC_RADIUS, ARC_SEGMENTS)
        entry.geometry.setFromPoints(points)
        entry.line.computeLineDistances()
        entry.material.color.set(ARC_COLOR[arc.kind])
        entry.line.visible = true
      }
    }

    // Per-frame updates independent of signature: opacity tracks intensity, dash pattern flows
    // (skipped under reduced motion — dashes render static).
    for (let i = 0; i < arcs.length && i < pool.length; i++) {
      const entry = pool[i]
      const arc = arcs[i]
      entry.material.opacity = 0.25 + 0.75 * arc.intensity
      if (!reduced) entry.material.dashOffset -= delta * DASH_SPEED
    }
  })

  return <group ref={groupRef} />
}
```

- [ ] **Step 4: Edit `GlobeView.tsx`** — mount `ArcsLayer`

Change 1 — add the import:

```tsx
// OLD
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { webglAvailable } from './globe/webgl'
// NEW
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { ArcsLayer } from './globe/ArcsLayer'
import { webglAvailable } from './globe/webgl'
```

Change 2 — replace the remaining placeholder comment with the real mount:

```tsx
// OLD
          <RegionPins />
          <PopulationMarkers />
          {/* ArcsLayer mounts here (T5) */}
// NEW
          <RegionPins />
          <PopulationMarkers />
          <ArcsLayer />
```

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run src/app/world/globe/ArcsLayer.test.ts` → PASS (4 tests).
Run: `npx vitest run src/app/world/GlobeView.test.tsx` → still PASS (2 tests — unaffected, same
reasoning as Task 4 Step 6).
Run: `npm run build` → succeeds.
Run: `npx vitest run` → all suites green — this closes out the fragment's three tasks' test
files (`GlobeView.test.tsx`, `RegionPins.test.ts`, `ArcsLayer.test.ts`) plus every pre-existing
suite untouched.

- [ ] **Step 6: Live Playwright smoke (controller-run, port 1420)**

1. `npm run dev` (background); wait for ready.
2. `browser_navigate` → `http://localhost:1420`; click "New World".
3. Author a cross-region-eligible fixture via the debug hook (mirrors the T2 engine fixture
   pattern — 2 regions, cross-region dependency, one population, running sim):
   ```js
   const { useWorldStore, useSimulationStore } = window.__scalemapDebug
   const s = useWorldStore.getState()
   const east = s.addRegion('us-east-1')
   const west = s.addRegion('eu-west-1')
   const azE = s.addAz(east, 'us-east-1a')
   const azW = s.addAz(west, 'eu-west-1a')
   const srvE = s.addServer(azE, /* a getPreset('vps-medium')-shaped preset, or the World
     panel's default preset object — read one off an existing addServer call in the running app
     if the raw preset shape isn't already in scope */)
   const srvW = s.addServer(azW, /* same preset */)
   const web = s.addBlueprint('web')
   const api = s.addBlueprint('api')
   s.updateBlueprint(web, { dependencies: [{ id: 'dep-api', target: { kind: 'blueprint', blueprintId: api }, port: 8080, protocol: 'http', packetTemplateId: null }] })
   s.addPlacement(web, srvE)
   s.addPlacement(api, srvW)
   s.addPopulation('NYC', 40.7, -74.0)
   s.updateRouting({ dnsTtlSec: 5 })
   useSimulationStore.getState().start(useWorldStore.getState().doc, /* compiled — read via
     useCompiledWorld()'s underlying compileWorld(doc) call, or simply click "Simulate" in the
     header instead of scripting start() directly */)
   ```
   (If scripting `compileWorld` inline is awkward from `browser_evaluate`, simplest path: run
   the `addRegion`/`addAz`/`addServer`/`addBlueprint`/`addPlacement`/`addPopulation`/
   `updateRouting` calls via the debug hook, THEN click "Simulate" in the header UI rather than
   calling `start()` directly.)
4. `browser_wait_for` ~2s → `browser_snapshot` / screenshot → confirm a teal client arc animates
   from the NYC population marker to the `us-east-1` pin (dashes visibly flowing across two
   screenshots ~0.5s apart). Save as `task5-client-arc.png`.
5. With the cross-region `web→api` dependency already authored in step 3, confirm a blue
   inter-region arc animates between the `us-east-1` and `eu-west-1` pins.
6. Trigger a region outage on `us-east-1` (`setOutage('region', east, true)` via the debug hook,
   same call form as Task 4's smoke) → `browser_wait_for` ~1s → `browser_snapshot` → confirm a
   red drain arc appears (from `us-east-1` toward `eu-west-1`, or from the population toward the
   down region, per the T2 drain semantics) during the TTL window (`dnsTtlSec=5` → within ~5s).
7. `browser_wait_for` past the TTL window (~6s) → `browser_snapshot` → confirm the client arc has
   re-pointed from NYC to `eu-west-1` (the surviving region) and the drain arc has cleared.
8. Reduced-motion pass: emulate `prefers-reduced-motion: reduce` (same technique as Task 3 Step
   8), reload, re-run steps 3–4 → confirm arcs render with STATIC dashes (no flow) across two
   screenshots ~1s apart, while intensity/opacity and rebuild-on-signature-change still work.
9. `browser_console_messages` → assert ZERO error-level entries throughout.
10. `browser_take_screenshot` → scratchpad `task5-arcs-full.png`.
11. Click "Stop"; stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/globe/ArcsLayer.tsx src/app/world/globe/ArcsLayer.test.ts \
        src/app/world/GlobeView.tsx
git commit -m "feat(globe): engine-driven great-circle traffic arcs"
```

---

# Phase 5 plan fragment — Tasks 6–7 (traffic authoring tab + place-on-globe · integration,
# fps probe, §N, region/rack carry-forwards)

> Fragment scope: Task 6 (`TrafficPanel.tsx` — populations/traffic/routing authoring, wired to
> globe place-mode) and Task 7 (final integration: fps probe, `docs/module-boundaries.md` §N,
> the five D10 carry-forward fixes). Global Constraints / File Structure live in the skeleton's
> assembled header (`docs/superpowers/plans/phase5/skeleton.md`) — not repeated here. Both tasks
> are grounded against real current source (`phase5-globe`, cut from `main @ 9784434`) as it
> exists *before* Tasks 1–5 run — Tasks 1–5 have not executed yet at fragment-writing time, so
> `GlobeView.tsx`'s Task-6 diff is written against a **reconstruction** of Task 3's output (its
> exact contract — `GlobeSceneProps`, `webglAvailable()`, the `GlobeScene`/`GlobeCards` split —
> is already pinned verbatim in `skeleton.md` and `GROUNDING.md`, so the reconstruction is
> contract-accurate even though the literal file doesn't exist yet). This is flagged explicitly
> at that step; every other edit in this fragment (`WorldPanel.tsx`, `WorldShell.tsx`,
> `WorldPanel.test.tsx`, `CrossAzColumn.tsx`, `TimelineStrip.tsx`, `SplitLines.tsx`,
> `RackNodes.tsx`, `AzRow.tsx`, `RegionView.tsx`) is grounded in real, currently-committed source
> quoted verbatim below.

**Judgment call flagged up front (governs Task 6's whole shape):** the skeleton's Task 6 file
list says GlobeView.tsx should "own `placeMode` state." Reading `WorldShell.tsx` (real source,
quoted in Task 6 Step 6) shows `GlobeView`/`RegionView`/`AzCanvas`/`ServerView` (the `view` local)
and `WorldPanel` are **siblings** in one `flex` row — `WorldPanel` is not a child of `GlobeView`
and vice versa. Since `TrafficPanel` (mounted inside `WorldPanel`) must toggle the same
`placeMode` boolean that `GlobeView` reads to arm `GlobeScene`'s raycast-click handler, the state
physically cannot live inside `GlobeView.tsx` while `WorldPanel.tsx` also needs to flip it — only
their common ancestor, `WorldShell.tsx`, can own it. This fragment lifts `placeMode` and
`selectedPopulationId` to two `useState`s in `WorldShell.tsx` and threads them down as props to
both `GlobeView` (`placeMode`, `onExitPlaceMode`, `onPopulationPlaced`) and `WorldPanel`
(`placeMode`, `onTogglePlaceMode`, `selectedPopulationId`, which `WorldPanel` passes straight
through to `TrafficPanel`) — no new store, per the skeleton's own constraint. This satisfies the
skeleton's *intent* (GlobeView still does the actual `addPopulation` call and owns the
raycast→lat/lon→placement wiring; it just doesn't own the armed/disarmed boolean itself).

---

## Task 6: Traffic authoring tab + place-on-globe `[sonnet]`

**Files:** create `src/app/world/panels/TrafficPanel.tsx`, `TrafficPanel.test.tsx`; modify
`src/app/world/panels/WorldPanel.tsx`, `src/app/world/panels/WorldPanel.test.tsx`,
`src/app/world/GlobeView.tsx` (Task 3's output — reconstructed, see the fragment header),
`src/app/world/GlobeView.test.tsx` (same caveat), `src/app/world/WorldShell.tsx`.

**Grounding — store actions (verified verbatim, `src/app/store/world.store.ts`):**
```ts
addPopulation: (label, lat, lon) => string
updatePopulation: (id, patch: Partial<ClientPopulation>) => void
removePopulation: (id) => void
updateRouting: (patch: Partial<RoutingConfig>) => void
updateTraffic: (patch: Partial<TrafficConfig>) => void
```
`createPopulation(label, lat, lon)` (`src/lib/world/factories.ts:95-97`) hardcodes
`peakRps: 500, diurnal: 'flat'` — `addPopulation` has **no** peakRps/diurnal parameter, so the
"+ add" form's rps/diurnal drafts must be applied via a follow-up `updatePopulation(id, {
peakRps, diurnal })` call right after `addPopulation` returns the new id (verified: this is not
optional plumbing, it's the only way those two fields reach a value other than the factory's
500/flat default).

**Grounding — types** (`src/lib/world/types.ts`): `ClientPopulation { id; label; lat; lon;
peakRps; diurnal: 'flat'|'day-night' }`; `RoutingConfig { policy: 'latency'|'geo'|'weighted'|
'priority'; weights: Record<RegionId,number>; priorityOrder: RegionId[];
healthCheckIntervalMs; healthCheckFailureThreshold; dnsTtlSec }`; `TrafficConfig { autoBaseline;
baselineTotalRps }`.

**Grounding — numeric-field convention** (`src/app/world/server/inspectorForms.tsx:15-26`,
quoted verbatim):
```ts
function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span>{label}</span>
      <input aria-label={label} style={inp} value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => { const n = Number(text); if (Number.isFinite(n) && n >= 0) onCommit(n); else setText(String(value)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}
```
Local text buffer, commits on blur/Enter, reverts to the last committed value on non-numeric
text. This file's version only ever floor-clamps to `>=0` (no upper bound, no lower bound below
0) — `TrafficPanel.tsx` needs a **symmetric range** clamp for lat (`[-90,90]`) and lon
(`[-180,180]`), so Task 6 declares its own generalized `NumberField` with explicit `min`/`max`
rather than importing the `inspectorForms.tsx` one (which isn't exported). Same "Number.isFinite,
clamp, keep last valid" convention, extended to clamp in-range finite values instead of only
floor-clamping.

**Grounding — panel styles** (`src/app/world/panels/panelStyles.ts`, unchanged, reused
verbatim): `panel`, `sectionLabel`, `field`, `smallBtn`, `dangerBtn`, `row`.

- [ ] **Step 1: Write the failing test `TrafficPanel.test.tsx`**

```tsx
// src/app/world/panels/TrafficPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TrafficPanel } from './TrafficPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

const noop = () => {}

describe('TrafficPanel — populations', () => {
  it('add and edit population dispatches store actions with exact patches', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)

    fireEvent.click(screen.getByText('+ add'))
    const pops = Object.values(useWorldStore.getState().doc.populations)
    expect(pops).toHaveLength(1)
    expect(pops[0]).toMatchObject({ label: 'pop-1', lat: 40.7, lon: -74, peakRps: 100, diurnal: 'flat' })

    const id = pops[0].id
    fireEvent.change(screen.getByLabelText(`label-${id}`), { target: { value: 'nyc' } })
    expect(useWorldStore.getState().doc.populations[id].label).toBe('nyc')

    const latInput = screen.getByLabelText(`lat-${id}`)
    fireEvent.change(latInput, { target: { value: '51.5' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(51.5)

    const rpsInput = screen.getByLabelText(`rps-${id}`)
    fireEvent.change(rpsInput, { target: { value: '250' } })
    fireEvent.blur(rpsInput)
    expect(useWorldStore.getState().doc.populations[id].peakRps).toBe(250)

    fireEvent.change(screen.getByLabelText(`diurnal-${id}`), { target: { value: 'day-night' } })
    expect(useWorldStore.getState().doc.populations[id].diurnal).toBe('day-night')
  })

  it('remove population dispatches removePopulation', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByLabelText(`remove-${id}`))
    expect(useWorldStore.getState().doc.populations[id]).toBeUndefined()
  })

  it('lat clamps to [-90,90]', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const latInput = screen.getByLabelText(`lat-${id}`)

    fireEvent.change(latInput, { target: { value: '999' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(90)

    fireEvent.change(latInput, { target: { value: '-999' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(-90)
  })

  it('selectedPopulationId row auto-focuses its label input', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={id} />)
    expect(screen.getByLabelText(`label-${id}`)).toHaveFocus()
  })
})

describe('TrafficPanel — place mode', () => {
  it('place toggle fires onTogglePlaceMode', () => {
    const onToggle = vi.fn()
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={onToggle} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText('+ place on globe'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reflects armed state via aria-pressed while placeMode is true', () => {
    render(<TrafficPanel placeMode={true} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.getByText('+ place on globe')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('TrafficPanel — traffic', () => {
  it('traffic toggles dispatch updateTraffic', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByLabelText('autoBaseline'))
    expect(useWorldStore.getState().doc.traffic.autoBaseline).toBe(true)

    const rps = screen.getByLabelText('baselineTotalRps')
    fireEvent.change(rps, { target: { value: '250' } })
    fireEvent.blur(rps)
    expect(useWorldStore.getState().doc.traffic.baselineTotalRps).toBe(250)
  })
})

describe('TrafficPanel — routing', () => {
  it('weights editor only for weighted policy', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByLabelText(`weight-${regionId}`)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('routing-policy'), { target: { value: 'weighted' } })
    const w = screen.getByLabelText(`weight-${regionId}`)
    expect(w).toBeInTheDocument()
    fireEvent.change(w, { target: { value: '3' } })
    fireEvent.blur(w)
    expect(useWorldStore.getState().doc.routing.weights[regionId]).toBe(3)

    fireEvent.change(screen.getByLabelText('routing-policy'), { target: { value: 'geo' } })
    expect(screen.queryByLabelText(`weight-${regionId}`)).not.toBeInTheDocument()
  })

  it('priority order buttons reorder priorityOrder', () => {
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    const r2 = useWorldStore.getState().addRegion('eu-west-1')
    useWorldStore.getState().updateRouting({ policy: 'priority', priorityOrder: [r1, r2] })
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)

    fireEvent.click(screen.getByLabelText('move eu-west-1 up'))
    expect(useWorldStore.getState().doc.routing.priorityOrder).toEqual([r2, r1])

    fireEvent.click(screen.getByLabelText('move eu-west-1 down'))
    expect(useWorldStore.getState().doc.routing.priorityOrder).toEqual([r1, r2])
  })

  it('health/ttl numerics dispatch updateRouting with a floor of 1', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const ttl = screen.getByLabelText('dnsTtlSec')
    fireEvent.change(ttl, { target: { value: '0' } })
    fireEvent.blur(ttl)
    expect(useWorldStore.getState().doc.routing.dnsTtlSec).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/panels/TrafficPanel.test.tsx`
Expected: FAIL — `Cannot find module './TrafficPanel'`.

- [ ] **Step 3: Write `TrafficPanel.tsx`**

```tsx
// src/app/world/panels/TrafficPanel.tsx
// Traffic-authoring tab (Phase 5 D8): populations (incl. globe placement), auto-baseline
// traffic, and routing policy — all three sections write through EXISTING world.store actions
// only (addPopulation/updatePopulation/removePopulation/updateRouting/updateTraffic — Phase 5
// adds no new store actions). Mounted inside WorldPanel's `<fieldset disabled={running}>`
// (WorldPanel.tsx) — this component does NOT duplicate that running-gate itself.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

export interface TrafficPanelProps {
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

// Same "Number.isFinite, clamp, keep last valid" convention as
// src/app/world/server/inspectorForms.tsx's NumberField (local text buffer, commits on
// blur/Enter, reverts on non-numeric input) — generalized with explicit min/max bounds, since
// that file's version only ever floor-clamps to `>=0` and lat/lon here need a symmetric range.
// On a successful commit the buffer is also reset to the CLAMPED value, so an out-of-range
// entry (e.g. lat 999) visibly snaps to the clamped figure (90) rather than leaving "999"
// displayed while the store silently holds 90.
function NumberField({ label, value, min, max, onCommit }: {
  label: string; value: number; min: number; max: number; onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  return (
    <input
      aria-label={label} style={{ ...field, width: 56, marginBottom: 0 }} value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text)
        if (Number.isFinite(n)) { const c = clamp(n, min, max); onCommit(c); setText(String(c)) }
        else setText(String(value))
      }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

const armedBtn = { border: '1px solid var(--color-accent)', color: 'var(--color-accent)' } as const

export function TrafficPanel({ placeMode, onTogglePlaceMode, selectedPopulationId }: TrafficPanelProps): ReactElement {
  return (
    <div>
      <PopulationsSection selectedPopulationId={selectedPopulationId} placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} />
      <TrafficSection />
      <RoutingSection />
    </div>
  )
}

function PopulationsSection({ selectedPopulationId, placeMode, onTogglePlaceMode }: {
  selectedPopulationId: string | null; placeMode: boolean; onTogglePlaceMode: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  const addPopulation = useWorldStore(s => s.addPopulation)
  const updatePopulation = useWorldStore(s => s.updatePopulation)
  const removePopulation = useWorldStore(s => s.removePopulation)
  const populations = Object.values(doc.populations)
  const labelRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const [draftLabel, setDraftLabel] = useState('')
  const [draftLat, setDraftLat] = useState(40.7)
  const [draftLon, setDraftLon] = useState(-74)
  const [draftRps, setDraftRps] = useState(100)
  const [draftDiurnal, setDraftDiurnal] = useState<DiurnalPattern>('flat')

  // Auto-focus the row for a population just placed via the globe (GlobeView's onPlace selects
  // it) or otherwise externally selected — re-runs whenever the selection changes.
  useEffect(() => {
    if (selectedPopulationId) labelRefs.current[selectedPopulationId]?.focus()
  }, [selectedPopulationId])

  const addDraft = () => {
    const label = draftLabel.trim() || `pop-${populations.length + 1}`
    // addPopulation's factory hardcodes peakRps:500/diurnal:'flat' (src/lib/world/factories.ts)
    // — it has no param for either, so the draft rps/diurnal only reach the store via this
    // follow-up patch.
    const id = addPopulation(label, draftLat, draftLon)
    updatePopulation(id, { peakRps: draftRps, diurnal: draftDiurnal })
    setDraftLabel('')
  }

  return (
    <div>
      <div style={sectionLabel}>Populations</div>
      {populations.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no populations yet</div>}
      {populations.map(pop => (
        <div key={pop.id} style={row}>
          <input
            ref={el => { labelRefs.current[pop.id] = el }}
            style={{ ...field, width: 64, marginBottom: 0 }} aria-label={`label-${pop.id}`}
            value={pop.label} onChange={e => updatePopulation(pop.id, { label: e.target.value })}
          />
          <NumberField label={`lat-${pop.id}`} value={pop.lat} min={-90} max={90}
            onCommit={n => updatePopulation(pop.id, { lat: n })} />
          <NumberField label={`lon-${pop.id}`} value={pop.lon} min={-180} max={180}
            onCommit={n => updatePopulation(pop.id, { lon: n })} />
          <NumberField label={`rps-${pop.id}`} value={pop.peakRps} min={0} max={Infinity}
            onCommit={n => updatePopulation(pop.id, { peakRps: n })} />
          <select aria-label={`diurnal-${pop.id}`} style={{ ...field, width: 68, marginBottom: 0 }}
            value={pop.diurnal} onChange={e => updatePopulation(pop.id, { diurnal: e.target.value as DiurnalPattern })}>
            <option value="flat">flat</option>
            <option value="day-night">day-night</option>
          </select>
          <button style={dangerBtn} aria-label={`remove-${pop.id}`} onClick={() => removePopulation(pop.id)}>✕</button>
        </div>
      ))}

      <div style={row}>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} placeholder="label" aria-label="new-population-label"
          value={draftLabel} onChange={e => setDraftLabel(e.target.value)} />
        <NumberField label="new-lat" value={draftLat} min={-90} max={90} onCommit={setDraftLat} />
        <NumberField label="new-lon" value={draftLon} min={-180} max={180} onCommit={setDraftLon} />
        <NumberField label="new-rps" value={draftRps} min={0} max={Infinity} onCommit={setDraftRps} />
        <select aria-label="new-diurnal" style={{ ...field, width: 68, marginBottom: 0 }} value={draftDiurnal}
          onChange={e => setDraftDiurnal(e.target.value as DiurnalPattern)}>
          <option value="flat">flat</option>
          <option value="day-night">day-night</option>
        </select>
      </div>
      <div style={row}>
        <button style={smallBtn} onClick={addDraft}>+ add</button>
        <button
          style={{ ...smallBtn, ...(placeMode ? armedBtn : {}) }}
          aria-pressed={placeMode}
          onClick={onTogglePlaceMode}
        >
          + place on globe
        </button>
      </div>
    </div>
  )
}

function TrafficSection() {
  const doc = useWorldStore(s => s.doc)
  const updateTraffic = useWorldStore(s => s.updateTraffic)
  return (
    <div>
      <div style={sectionLabel}>Traffic</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <input type="checkbox" aria-label="autoBaseline" checked={doc.traffic.autoBaseline}
          onChange={e => updateTraffic({ autoBaseline: e.target.checked })} />
        <span>auto-baseline traffic</span>
      </label>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>baselineTotalRps</span>
        <NumberField label="baselineTotalRps" value={doc.traffic.baselineTotalRps} min={0} max={Infinity}
          onCommit={n => updateTraffic({ baselineTotalRps: n })} />
      </label>
    </div>
  )
}

function RoutingSection() {
  const doc = useWorldStore(s => s.doc)
  const updateRouting = useWorldStore(s => s.updateRouting)
  const regions = Object.values(doc.regions)
  const { policy, weights, priorityOrder, dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold } = doc.routing

  const move = (regionId: RegionId, dir: -1 | 1) => {
    const i = priorityOrder.indexOf(regionId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= priorityOrder.length) return
    const next = [...priorityOrder]
    ;[next[i], next[j]] = [next[j], next[i]]
    updateRouting({ priorityOrder: next })
  }

  return (
    <div>
      <div style={sectionLabel}>Routing</div>
      <select aria-label="routing-policy" style={{ ...field, marginBottom: 6 }} value={policy}
        onChange={e => updateRouting({ policy: e.target.value as RoutingPolicyKind })}>
        <option value="latency">latency</option>
        <option value="geo">geo</option>
        <option value="weighted">weighted</option>
        <option value="priority">priority</option>
      </select>

      {policy === 'weighted' && regions.map(region => (
        <div key={region.id} style={row}>
          <span style={{ flex: 1 }}>{region.catalogId}</span>
          <NumberField label={`weight-${region.id}`} value={weights[region.id] ?? 0} min={0} max={Infinity}
            onCommit={n => updateRouting({ weights: { ...weights, [region.id]: n } })} />
        </div>
      ))}

      {policy === 'priority' && priorityOrder.map((regionId, i) => {
        const label = doc.regions[regionId]?.catalogId ?? regionId
        return (
          <div key={regionId} style={row}>
            <span style={{ flex: 1 }}>{i + 1}. {label}</span>
            <button style={smallBtn} aria-label={`move ${label} up`} disabled={i === 0} onClick={() => move(regionId, -1)}>↑</button>
            <button style={smallBtn} aria-label={`move ${label} down`} disabled={i === priorityOrder.length - 1} onClick={() => move(regionId, 1)}>↓</button>
          </div>
        )
      })}

      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 6 }}>
        <span>dnsTtlSec</span>
        <NumberField label="dnsTtlSec" value={dnsTtlSec} min={1} max={Infinity}
          onCommit={n => updateRouting({ dnsTtlSec: n })} />
      </label>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>healthCheckIntervalMs</span>
        <NumberField label="healthCheckIntervalMs" value={healthCheckIntervalMs} min={1} max={Infinity}
          onCommit={n => updateRouting({ healthCheckIntervalMs: n })} />
      </label>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>healthCheckFailureThreshold</span>
        <NumberField label="healthCheckFailureThreshold" value={healthCheckFailureThreshold} min={1} max={Infinity}
          onCommit={n => updateRouting({ healthCheckFailureThreshold: n })} />
      </label>
    </div>
  )
}
```

**Judgment call — routing regions not yet in `priorityOrder`:** `world.store.ts`'s `withoutRegion`
already prunes a deleted region out of `priorityOrder`/`weights`, but nothing auto-appends a
newly-added region INTO `priorityOrder`. This panel renders `priorityOrder` strictly as-is (a
freshly added region simply doesn't appear in the priority list until something puts it there) —
no auto-append UI was in the skeleton's spec, so none was invented here. Flagged as a known gap,
not fixed this task.

- [ ] **Step 4: Modify `WorldPanel.tsx`**

Current file (verbatim, 67 lines) — the tab union, `tabs` array, and `<fieldset>` body all need
one addition each; everything else (topology/blueprints/placements/findings/events/cost) is
unchanged.

```diff
 import { useState } from 'react'
 import { TopologyPanel } from './TopologyPanel'
 import { BlueprintPanel } from './BlueprintPanel'
 import { PlacementPanel } from './PlacementPanel'
+import { TrafficPanel } from './TrafficPanel'
 import { useCompiledWorld } from '../useCompiledWorld'
 import { EventsTab } from '../EventsTab'
 import { CostTab } from '../CostTab'
 import { panel, smallBtn, sectionLabel } from './panelStyles'

-type Tab = 'topology' | 'blueprints' | 'placements' | 'findings' | 'events' | 'cost'
+type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'findings' | 'events' | 'cost'

-export function WorldPanel({ running }: { running: boolean }) {
+export interface WorldPanelProps {
+  running: boolean
+  placeMode: boolean
+  onTogglePlaceMode: () => void
+  selectedPopulationId: string | null
+}
+
+export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
   const [tab, setTab] = useState<Tab>('topology')
   const { findings } = useCompiledWorld()
   const tabs: { id: Tab; label: string }[] = [
     { id: 'topology', label: 'Topology' },
     { id: 'blueprints', label: 'Blueprints' },
     { id: 'placements', label: 'Placements' },
+    { id: 'traffic', label: 'Traffic' },
     { id: 'findings', label: `Findings (${findings.length})` },
     { id: 'events', label: 'Events' },
     { id: 'cost', label: 'Cost' },
   ]
   return (
     <aside style={panel}>
       ...(tab strip unchanged)...
       <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
         {tab === 'topology' && <TopologyPanel />}
         {tab === 'blueprints' && <BlueprintPanel />}
         {tab === 'placements' && <PlacementPanel />}
+        {tab === 'traffic' && (
+          <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} />
+        )}
         {tab === 'findings' && ( ...unchanged... )}
         {tab === 'events' && <EventsTab />}
         {tab === 'cost' && <CostTab />}
       </fieldset>
     </aside>
   )
 }
```

`TrafficPanel` is mounted **inside** the existing `<fieldset disabled={running}>` — same
running-gate every other tab already gets, no duplicate gating added.

- [ ] **Step 4b: Modify `WorldPanel.test.tsx`** (existing prop signature is now insufficient)

Both existing `render(<WorldPanel running={false} />)` / `render(<WorldPanel running={false} />)`
call sites (`src/app/world/panels/WorldPanel.test.tsx`, real source quoted earlier) need the three
new required props stubbed — behavior of both existing findings-tab cases is unaffected.

```diff
-    render(<WorldPanel running={false} />)
+    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} />)
     fireEvent.click(screen.getByText(/Findings \(\d+\)/))
```
(applied to both `it` blocks in that file).

- [ ] **Step 5: Modify `GlobeView.tsx`** — reconstruction of Task 3's output, see fragment header

Task 3 rewrites `GlobeView.tsx` into a WebGL-scene/card-fallback split per its exact `Produces`
block (`GlobeSceneProps { placeMode; onPlace; children }`, `webglAvailable()`,
`GlobeCards` extracted verbatim, an always-present visually-hidden a11y region list, the canvas
container `aria-hidden`). Since Tasks 1–5 haven't run yet, this step's "before" is a
contract-accurate reconstruction of that output, not a literal read — the executor running this
task AFTER Task 3 has actually landed must apply this diff's **intent** (prop signature,
`handlePlace` wiring, `GlobeScene`/layer passthrough) against the real file rather than pasting
the reconstruction verbatim if the real Task-3 file's internal structure differs in ways that
don't affect the pinned contract.

Reconstructed Task-3 output (contract-accurate):
```tsx
// src/app/world/GlobeView.tsx (Task 3 output, reconstructed)
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { webglAvailable } from './globe/webgl'
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { ArcsLayer } from './globe/ArcsLayer'

export function GlobeView() {
  const doc = useWorldStore(s => s.doc)
  const goRegion = useNavStore(s => s.goRegion)
  const regions = Object.values(doc.regions)

  const a11yList = (
    <div className="visually-hidden" role="navigation" aria-label="regions">
      {regions.map(r => <button key={r.id} onClick={() => goRegion(r.id)}>{r.catalogId}</button>)}
    </div>
  )

  if (!webglAvailable()) {
    return <>{a11yList}<GlobeCards /></>
  }

  return (
    <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
      {a11yList}
      <GlobeScene placeMode={false} onPlace={() => {}}>
        <RegionPins />
        <PopulationMarkers />
        <ArcsLayer />
      </GlobeScene>
    </div>
  )
}
```

Task 6 diff on top of that:
```diff
+export interface GlobeViewProps {
+  placeMode: boolean
+  onExitPlaceMode: () => void
+  onPopulationPlaced: (id: string) => void
+}
+
-export function GlobeView() {
+export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
   const doc = useWorldStore(s => s.doc)
+  const addPopulation = useWorldStore(s => s.addPopulation)
   const goRegion = useNavStore(s => s.goRegion)
   const regions = Object.values(doc.regions)

+  const handlePlace = (lat: number, lon: number) => {
+    const label = `pop-${Object.keys(doc.populations).length + 1}`
+    const id = addPopulation(label, lat, lon)
+    onExitPlaceMode()
+    onPopulationPlaced(id)
+  }
+
   const a11yList = ( ...unchanged... )

   if (!webglAvailable()) {
     return <>{a11yList}<GlobeCards /></>
   }

   return (
     <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
       {a11yList}
-      <GlobeScene placeMode={false} onPlace={() => {}}>
+      <GlobeScene placeMode={placeMode} onPlace={handlePlace}>
         <RegionPins />
         <PopulationMarkers />
         <ArcsLayer />
       </GlobeScene>
     </div>
   )
 }
```

- [ ] **Step 5b: Modify `GlobeView.test.tsx`** — same reconstruction caveat

Task 3's two named jsdom cases (`renders GlobeCards when webgl unavailable`,
`hidden a11y region list navigates` — both exercise only the fallback branch, mocking
`webgl.ts`) need their `render(<GlobeView />)` call updated to the new required props:

```diff
-      render(<GlobeView />)
+      render(<GlobeView placeMode={false} onExitPlaceMode={() => {}} onPopulationPlaced={() => {}} />)
```
applied at both call sites. Neither case's assertions change — the fallback branch never reads
`placeMode`/the two callbacks.

- [ ] **Step 6: Modify `WorldShell.tsx`** — the state lift (see fragment header's judgment call)

Current file (verbatim, quoted in full earlier in this session's grounding — relevant excerpts):
```tsx
import { useEffect, useState, type CSSProperties } from 'react'
...
export function WorldShell() {
  const nav = useNavStore()
  ...
  const view =
    nav.level === 'globe' ? <GlobeView /> :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzCanvas /> :
    <ServerView />
  ...
        <WorldPanel running={running} />
```

Diff:
```diff
 export function WorldShell() {
   const nav = useNavStore()
   const reduced = useReducedMotion()
   const dirty = useFileStore(s => s.dirty)
   const [fileError, setFileError] = useState<string | null>(null)
   const running = useSimulationStore(s => s.running)
+  // Lifted here (not into GlobeView) because GlobeView and WorldPanel are SIBLINGS in the flex
+  // row below, not parent/child — TrafficPanel (mounted inside WorldPanel) needs to flip the
+  // same placeMode boolean GlobeView's GlobeScene reads, so only their common ancestor can own
+  // it. No new store — per the skeleton's own constraint, this stays local component state.
+  const [placeMode, setPlaceMode] = useState(false)
+  const [selectedPopulationId, setSelectedPopulationId] = useState<string | null>(null)
+
+  // Defensive UX, not a named requirement: disarm place-mode if the user navigates away from
+  // the globe level while it's armed, so it can't silently stay "armed" somewhere it has no
+  // effect (GlobeScene's raycast-click handler only exists at nav.level === 'globe').
+  useEffect(() => {
+    if (nav.level !== 'globe' && placeMode) setPlaceMode(false)
+  }, [nav.level, placeMode])

   ...(useEffect blocks unchanged)...

   const view =
-    nav.level === 'globe' ? <GlobeView /> :
+    nav.level === 'globe' ? (
+      <GlobeView
+        placeMode={placeMode}
+        onExitPlaceMode={() => setPlaceMode(false)}
+        onPopulationPlaced={setSelectedPopulationId}
+      />
+    ) :
     nav.level === 'region' ? <RegionView /> :
     nav.level === 'az' ? <AzCanvas /> :
     <ServerView />
```
and further down:
```diff
-        <WorldPanel running={running} />
+        <WorldPanel
+          running={running}
+          placeMode={placeMode}
+          onTogglePlaceMode={() => setPlaceMode(p => !p)}
+          selectedPopulationId={selectedPopulationId}
+        />
```
(`useEffect`/`useState` are already both imported on `WorldShell.tsx`'s existing React import
line — no import change needed.)

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run src/app/world/panels/TrafficPanel.test.tsx` → PASS (10 tests: 4 populations +
2 place-mode + 1 traffic + 3 routing).
Run: `npx vitest run src/app/world/panels/WorldPanel.test.tsx` → PASS (2 tests, unaffected
assertions, updated call sites).
Run: `npx vitest run src/app/world/GlobeView.test.tsx` → PASS (2 tests, updated call sites) — only
runnable once Task 3's real file exists; if this task executes immediately after Task 3 (per the
skeleton's serial dependency order T3→T4→T5→T6), the real file/test already exist and this is a
normal diff-and-rerun, not a reconstruction exercise.
Run: `npm run build` → succeeds (strict tsc, vite build green, three vendor chunk unaffected).
Run: `npx vitest run` → full suite green.

- [ ] **Step 8: Live smoke**

Strict port 1420, zero app console errors, screenshots, stop server after (per Global
Constraints). Story: open the Traffic tab → `+ place on globe` (button turns accent-armed,
`aria-pressed="true"`) → click a point on the globe → a teal population marker appears at the
clicked lat/lon, place-mode disarms, the tab's population list shows the new row with its label
input focused → rename it, edit `peakRps` → Simulate → the corresponding client arc's opacity
visibly reflects the new intensity (`0.25 + 0.75×intensity` per T5's `ArcsLayer`) as the value
changes. Also verify: switching `routing.policy` to `weighted` reveals one weight input per
region and switching to `priority` reveals the ordered list with working ↑/↓; toggling
`autoBaseline` and editing `baselineTotalRps` takes effect on the next Simulate (baseline
populations' synthetic per-region demand, per `buildArcs`'s existing `startsWith('baseline:')`
skip — client arcs remain population-driven only, unaffected by the auto-baseline toggle itself,
which only affects total demand shape, not arc rendering).

- [ ] **Step 9: Commit**

```bash
git add src/app/world/panels/TrafficPanel.tsx src/app/world/panels/TrafficPanel.test.tsx \
  src/app/world/panels/WorldPanel.tsx src/app/world/panels/WorldPanel.test.tsx \
  src/app/world/GlobeView.tsx src/app/world/GlobeView.test.tsx src/app/world/WorldShell.tsx
git commit -m "feat(traffic): population, baseline-traffic, and routing authoring with globe placement"
```

---

## Task 7: Integration, fps probe, §N, carry-forwards `[sonnet]`

**Files:** `docs/module-boundaries.md` (§N + a one-line §M amendment); modify
`src/app/world/region/CrossAzColumn.tsx`, `src/app/world/region/TimelineStrip.tsx`,
`src/app/world/region/SplitLines.tsx`, `src/app/world/RackNodes.tsx`,
`src/app/world/RegionView.tsx`, `src/app/world/region/AzRow.tsx`; append to
`.superpowers/sdd/progress.md` `## PHASE 5` and (if the T2 engine-internal `Map` note wasn't
already logged in Task 2) `.superpowers/sdd/contract-drift.md` `## PHASE 5`.

**Grounding — where these five carry-forwards actually came from:** all five are the exact
"OPEN ITEMS for Phase 5 / backlog" the Phase-4 final review logged at the bottom of
`.superpowers/sdd/progress.md`'s `## PHASE 4 COMPLETE` section (quoted verbatim below per item) —
this task is closing that backlog, not inventing new scope.

### (a) `CrossAzColumn.tsx` — replication-list dup-key

Backlog text: *"CrossAzColumn repl-list dup-key → key by `${bp}:${from}:${to}` [exotic
bidirectional multi-primary same-pair topology only]."*

Current line (`src/app/world/region/CrossAzColumn.tsx:42`, verbatim):
```tsx
            {entry.replication.map(r => <div key={r.blueprintId}>{r.blueprintName} repl</div>)}
```
Diff:
```diff
-            {entry.replication.map(r => <div key={r.blueprintId}>{r.blueprintName} repl</div>)}
+            {entry.replication.map(r => (
+              <div key={`${r.blueprintId}:${r.fromAzId}:${r.toAzId}`}>{r.blueprintName} repl</div>
+            ))}
```
`ReplicationPair` (`src/app/world/region/regionData.ts`) already carries `fromAzId`/`toAzId` — no
new data needed, purely a key-uniqueness fix for the (currently impossible in this fixture set,
but not type-impossible) case of two replication pairs of the same blueprint sharing one AZ pair.

### (b) `TimelineStrip.tsx` — out-of-window events pile at the left edge

Backlog text: *"TimelineStrip clamps out-of-120s-window events to the left edge → should
`return null if simMs < startMs` [glyph pile-up on >120s sims]."*

Current code (`src/app/world/region/TimelineStrip.tsx:68-86`, verbatim):
```tsx
        {scoped.map(e => {
          const clamped = Math.min(endMs, Math.max(startMs, e.simMs))
          const pct = ((clamped - startMs) / WINDOW_MS) * 100
          return (
            <button
              key={e.id}
              title={running ? 'stop the simulation to scrub to this event' : `${e.message} · t+${(e.simMs / 1000).toFixed(1)}s`}
              onClick={() => onEventClick(e)}
              disabled={running}
              style={{
                position: 'absolute', left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)',
                background: 'none', border: 'none', padding: 2, cursor: running ? 'default' : 'pointer',
                color: SEVERITY_COLOR[e.severity], fontSize: 11, lineHeight: 1,
              }}
            >
              {GLYPH[e.kind]}
            </button>
          )
        })}
```
Diff:
```diff
         {scoped.map(e => {
-          const clamped = Math.min(endMs, Math.max(startMs, e.simMs))
-          const pct = ((clamped - startMs) / WINDOW_MS) * 100
+          if (e.simMs < startMs) return null
+          const pct = ((e.simMs - startMs) / WINDOW_MS) * 100
           return (
             <button
```
`scoped` (from `regionEvents`) is still the full un-windowed set — this per-event guard is what
actually enforces the 120s window on the timeline strip; `regionEvents` itself is untouched (it's
shared with `AlertRibbon`'s 30s window via a different caller, so windowing stays local to this
component rather than moving into the shared selector).

### (c) `SplitLines.tsx` + `RackNodes.tsx` — R2 token bypass

Backlog text: *"R2 token bypass (latent, no live theme toggle wired): SplitLines
DOWN_RED='#EF4444' + RackNodes CHASSIS_BORDER.degraded='#F59E0B55' vs sibling
var(--color-danger)/var(--color-warning)."* Both literals are **exact** hex matches for
`DARK_COLORS.danger`/`.warning` (`src/index.css`: `--color-danger: #EF4444`,
`--color-warning: #F59E0B`) — real R2 bypasses, not decorative chrome (R2's own carve-out is for
scene chrome and alpha-tinted variants that AREEN'T a plain `var()` substitution; `DOWN_RED` isn't
alpha-tinted at all, and `CHASSIS_BORDER.degraded`'s alpha component can be reproduced with
`color-mix()`, so neither needs the carve-out).

`SplitLines.tsx` current (verbatim):
```tsx
const TEAL = '#2DD4BF'
const DOWN_RED = '#EF4444'
const LABEL_COLOR = '#94A3B8'
```
used at:
```tsx
        const stroke = s.down ? DOWN_RED : TEAL
...
            <text x={midX} y={y - 6} fill={s.down ? DOWN_RED : LABEL_COLOR} fontSize={9}>
```
Diff:
```diff
 const TEAL = '#2DD4BF'
-const DOWN_RED = '#EF4444'
 const LABEL_COLOR = '#94A3B8'
```
```diff
-        const stroke = s.down ? DOWN_RED : TEAL
+        const stroke = s.down ? 'var(--color-danger)' : TEAL
```
```diff
-            <text x={midX} y={y - 6} fill={s.down ? DOWN_RED : LABEL_COLOR} fontSize={9}>
+            <text x={midX} y={y - 6} fill={s.down ? 'var(--color-danger)' : LABEL_COLOR} fontSize={9}>
```
`TEAL` and `LABEL_COLOR` are untouched — neither matches a `ColorTokens` value (`TEAL` isn't
`--color-accent`'s `#4A9EFF`; `LABEL_COLOR` happens to equal `--color-text-secondary` but the
backlog item names only the two danger/warning bypasses, and this is scene-chrome/label text, not
a health/severity signal — left local per R2, consistent with the narrower reading the backlog
item itself uses).

`RackNodes.tsx` current (verbatim, line 86):
```tsx
const CHASSIS_BORDER: Record<HealthState, string> = {
  healthy: '1px solid #2A303C', degraded: '1px solid #F59E0B55', down: '1px solid var(--color-danger)',
}
```
Diff (alpha ≈ `0x55/0xFF` = 33.3%, reproduced with `color-mix()` — the same idiom
`docs/module-boundaries.md`'s historical note already cites for this exact
"hex → `var()`/`color-mix()`" migration class):
```diff
 const CHASSIS_BORDER: Record<HealthState, string> = {
-  healthy: '1px solid #2A303C', degraded: '1px solid #F59E0B55', down: '1px solid var(--color-danger)',
+  healthy: '1px solid #2A303C',
+  degraded: '1px solid color-mix(in srgb, var(--color-warning) 33%, transparent)',
+  down: '1px solid var(--color-danger)',
 }
```
`healthy`'s `#2A303C` is a neutral chrome border (not a status hex — doesn't match any
`ColorTokens` value) and is untouched; `down` already used `var(--color-danger)`.

### (d) `AzRow.tsx` / `RegionView.tsx` — uncached per-row `computeWorldCost`

Backlog text: *"AzRow calls computeWorldCost per-row unmemoized (O(AZs×world) redundant at 1Hz) —
hoist to RegionView, pass monthlyUsd."* `docs/module-boundaries.md` §M's own Blast-radius section
already names this exact gap (*"AzRow.tsx's own call is uncached (one whole-WorldDoc
computeWorldCost walk per AZ row per render, not per region) — worth hoisting into
RegionView.tsx if AZ counts grow enough for it to show up in a profile, not fixed this task"*) —
this task fixes it and the §N edit below closes that stale note out.

`AzRow.tsx` current (verbatim):
```tsx
import { computeWorldCost } from '../../../lib/costModelV2'
...
export interface AzRowProps {
  azId: AzId
  regionId: RegionId
  onNavigateAz: () => void
  onNavigateServer: (serverId: ServerId) => void
}

export function AzRow({ azId, regionId, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  ...
  const usd = computeWorldCost(doc, batch?.world ?? null).byAz.find(e => e.azId === azId)?.monthlyUsd ?? 0
```
Diff:
```diff
-import { computeWorldCost } from '../../../lib/costModelV2'
 ...
 export interface AzRowProps {
   azId: AzId
   regionId: RegionId
+  monthlyUsd: number
   onNavigateAz: () => void
   onNavigateServer: (serverId: ServerId) => void
 }

-export function AzRow({ azId, regionId, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
+export function AzRow({ azId, regionId, monthlyUsd, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
   const doc = useWorldStore(s => s.doc)
   const compiled = useCompiledWorld()
   const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
   ...
-  const usd = computeWorldCost(doc, batch?.world ?? null).byAz.find(e => e.azId === azId)?.monthlyUsd ?? 0
+  const usd = monthlyUsd
```
(the render body's `${Math.round(usd)}/mo` usage is unchanged — only the source of `usd` moves.)

`RegionView.tsx` current (verbatim, relevant excerpts):
```tsx
import { azShares, ribbonAlert, sparklineSeries } from './region/regionData'
...
  const shares = azShares(regionId, doc, batch)
  const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
...
            {azs.map(az => (
              <AzRow
                key={az.id} azId={az.id} regionId={regionId}
                onNavigateAz={() => goAz(regionId, az.id)}
                onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
              />
            ))}
```
Diff:
```diff
+import { computeWorldCost } from '../../lib/costModelV2'
 import { azShares, ribbonAlert, sparklineSeries } from './region/regionData'
 ...
   const shares = azShares(regionId, doc, batch)
   const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
+  const costs = computeWorldCost(doc, batch?.world ?? null)
 ...
             {azs.map(az => (
               <AzRow
-                key={az.id} azId={az.id} regionId={regionId}
+                key={az.id} azId={az.id} regionId={regionId}
+                monthlyUsd={costs.byAz.find(e => e.azId === az.id)?.monthlyUsd ?? 0}
                 onNavigateAz={() => goAz(regionId, az.id)}
                 onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
               />
             ))}
```
One `computeWorldCost` call per region render instead of one per AZ row — same result set
(`costs.byAz`), just computed once and sliced per row. `RegionView.test.tsx` has no cost
assertions (verified — `grep -n "usd\|monthlyUsd\|computeWorldCost" RegionView.test.tsx` returns
nothing), so none of its 6 existing cases need updating; `AzRow.tsx` has no dedicated test file of
its own (confirmed — none exists in `src/app/world/region/`), so this prop addition is exercised
only through `RegionView.test.tsx`'s existing render-through coverage.

- [ ] **Step 1: Apply the four code diffs above** (a–d), then run:

Run: `npx vitest run src/app/world/region/RegionView.test.tsx` → PASS (6/6, unaffected — no cost
assertions to break).
Run: `npx vitest run` → full suite green.
Run: `npm run build` → strict tsc + vite build green.

- [ ] **Step 2: `docs/module-boundaries.md` — §N**

Append after §M's closing `---` (before "## 2. Shared 'hub' files"), modeled on §M's own
structure (intro paragraph → file table → Boundary rules → Frozen-contract note → Blast radius):

```markdown
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
| `src/app/world/panels/TrafficPanel.tsx` (Task 6) | Three sections (POPULATIONS/TRAFFIC/ROUTING) writing through the pre-existing `world.store.ts` actions only (Phase 5 adds none) — see the Boundary rules note. `placeMode`/`selectedPopulationId` arrive as props, NOT read from a store — the panel is a pure controlled component over state `WorldShell.tsx` owns (see next row) |
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
```

Also append this one-line correction directly onto §M's existing Blast-radius paragraph (find the
sentence `AzRow.tsx's own call is uncached (one whole-WorldDoc computeWorldCost walk per AZ row
per render, not per region) — worth hoisting into RegionView.tsx if AZ counts grow enough for it
to show up in a profile, not fixed this task.` and append, in the same sentence's spirit as this
doc's other lazy-reconciliation notes, e.g. `➜ RESOLVED Phase 5 Task 7 — hoisted to RegionView.tsx, see §N.`).

- [ ] **Step 3: fps probe**

Author a 6-region/6-population world with a full arc payload (via the Traffic tab + Topology
tab, or the `window.__scalemapDebug` hook for scripted reproducibility) — 6 regions each with
≥1 AZ/server/cross-region-eligible blueprint dependency (to populate inter-region arcs), 6
populations spread globally (to populate client arcs), then simulate under enough load that
`buildArcs` approaches its `MAX_GLOBE_ARCS=200` cap. With the globe rendering live, run this
twice in the devtools console (or via a Playwright `browser_evaluate` call) and log both results
in the task report:
```js
let n = 0
const t0 = performance.now()
function tick(t) { n++; if (t - t0 < 3000) requestAnimationFrame(tick); else console.log('fps ~', (n / 3).toFixed(1)) }
requestAnimationFrame(tick)
```
Both runs must report **≥30fps**. Per spec D9, if either run fails, the first fallback is
reducing `ArcsLayer`'s great-circle segment count from 48 to 32 before any other optimization —
not required if the probe passes on the first attempt.

- [ ] **Step 4: Phase-gate live story, reduced-motion, WebGL-fallback**

Strict port 1420, zero app console errors throughout, screenshots at each major beat, server
stopped after. Story (per the design spec's "Testing & verification" section): author 2 regions +
an NYC population via the Traffic tab → globe shows night earth, pins, teal marker, client arc
under load → kill the target region (existing `setOutage`/region-outage control) → pin turns red
and pulses, a red drain arc appears, TTL expiry moves the client arc to the surviving region →
click a pin → region flow page opens → run the fps probe (Step 3) → toggle
`prefers-reduced-motion` and confirm no idle rotation / pin pulse / arc dash flow → force
`webglAvailable()` false (or use a browser context without WebGL) and confirm `GlobeCards` +
working a11y region-nav list render with zero errors.

- [ ] **Step 5: Ledger entry**

Append to `.superpowers/sdd/progress.md`, modeled on the `## PHASE 4` section's exact shape
(Plan/Branch/Contract-drift-log header lines, one paragraph per task, a `COMPLETE` line, a DONE
BAR, an OPEN ITEMS list, a DRIFT STATE line):

```markdown
## PHASE 5 — R3F globe + traffic authoring
Plan: docs/superpowers/plans/phase5/skeleton.md (+ fragments/tasks-06-07.md and this fragment's siblings)
Branch: phase5-globe (cut from main @ 9784434)
Contract drift log: .superpowers/sdd/contract-drift.md §PHASE 5 (one informational item: buildArcs v2's new engine-internal prev-region Map — RESOLVED, no contract/type change; no other drift expected)

Task 1: complete (<commit range>, <n>/<n> tests, build green). three/r3f/drei deps + NASA night texture + geo.ts.
Task 2: complete (<commit range>, <n>/<n> tests). buildArcs v2 — inter-region + drain arcs, client arcs byte-identical.
Task 3: complete (<commit range>, <n>/<n> tests). GlobeScene/webgl.ts/GlobeCards + GlobeView rewrite.
Task 4: complete (<commit range>). RegionPins/PopulationMarkers.
Task 5: complete (<commit range>, <n>/<n> tests). ArcsLayer.
Task 6: complete (<commit range>, TrafficPanel <n>/<n>, WorldPanel/GlobeView/WorldShell updated call sites). Traffic tab + place-on-globe; placeMode/selectedPopulationId lifted to WorldShell (GlobeView/WorldPanel are siblings, not parent/child — see §N).
Task 7: complete (<commit range>). fps probe <run1>fps/<run2>fps (≥30 both); §N written; 4 Phase-4 backlog items closed (CrossAzColumn key, TimelineStrip window, SplitLines/RackNodes token bypass, AzRow cost hoist); phase-gate live story + reduced-motion + WebGL-fallback passed.

=== ALL 7 TASKS COMPLETE. Suite <n>/<n> green, build green. HEAD <hash>. ===

## PHASE 5 COMPLETE — R3F globe + traffic authoring (branch phase5-globe, HEAD <hash>)

DONE BAR:
1. Full suite green; npm run build green.
2. fps probe ≥30fps, both runs, logged above.
3. Phase-gate live story passed end-to-end, zero console errors, screenshots in .superpowers/sdd/screenshots/phase5/.
4. Reduced-motion pass (no rotation/pulse/dash flow) and WebGL-fallback pass (GlobeCards + a11y list) both verified live.
5. docs/module-boundaries.md §N written; §M's stale AzRow blast-radius note corrected.
6. contract-drift.md §PHASE 5: exactly one informational item (buildArcs v2's prev-region Map).

OPEN ITEMS for Phase 6 / backlog: none blocking — Phase 6 (analysis engine + LLM reviewer) is the next and last phase per the umbrella spec.

DRIFT STATE: exactly ONE entry (contract-drift.md §PHASE 5 — buildArcs v2 prev-region Map) — informational, engine-internal, no contract/type change.
```

- [ ] **Step 6: Commit**

```bash
git add docs/module-boundaries.md \
  src/app/world/region/CrossAzColumn.tsx src/app/world/region/TimelineStrip.tsx \
  src/app/world/region/SplitLines.tsx src/app/world/RackNodes.tsx \
  src/app/world/RegionView.tsx src/app/world/region/AzRow.tsx
git commit -m "docs: update module boundaries for the globe (§N); region/rack carry-forwards"
```
(`.superpowers/sdd/progress.md`/`contract-drift.md` are gitignored per Phase 4's Task 8 note — not
part of this commit's `git add`.)
