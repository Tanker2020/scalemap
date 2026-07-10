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
