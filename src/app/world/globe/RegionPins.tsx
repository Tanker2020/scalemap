// src/app/world/globe/RegionPins.tsx
// Health-lit region pins (Phase 5 D5): one small self-lit dot + additive glow halo per doc
// region with a REGION_GEO-known catalogId, colored by RegionMetrics.health, labeled via drei
// <Html>, pulsing while a failover/outage event touching the region is <10s old, click → nav.
// Reads stores directly (no props) — mounted as a GlobeScene child (T3) alongside
// PopulationMarkers/ArcsLayer. R3F component; NOT jsdom-tested (no WebGL there) — this task's
// live smoke is the gate. The two exported pure helpers below (pinColor, isPulsing) ARE
// unit-tested (node env, RegionPins.test.ts) since they carry the only testable logic.
import { useContext, useMemo, useRef, useState, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useReducedMotion } from 'framer-motion'
import { AdditiveBlending, Vector3, type Group, type Mesh } from 'three'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore } from '../../store/ui.store'
import { REGION_GEO } from '../../../lib/world/regionGeo'
import { latLonToVec3 } from './geo'
import { HoldRing, holdProgress, isAbortedHold } from '../ui/HoldToEnter'
import { SceneOverlay } from '../ui/SceneOverlay'
import { OverlayPortalContext } from './overlayPortal'
import type { HealthState, EngineEvent, EngineEventKind } from '../../../lib/worldEngine/types'
import type { RegionId } from '../../../lib/world/types'

const EARTH_RADIUS = 1
const PIN_ALTITUDE = EARTH_RADIUS * 1.002   // lifted slightly off the surface to avoid z-fighting
const PIN_RADIUS = 0.018
const GLOW_RADIUS = PIN_RADIUS * 2.4
const PULSE_WINDOW_MS = 10_000
const PULSE_PERIOD_S = 1
// Generous window for the synthetic click; self-expires so a stale swallow can never eat a
// later tap.
const SWALLOW_WINDOW_MS = 400

// Scratch vectors for the per-frame horizon test (module-level: no per-frame allocation).
const TMP_PIN = new Vector3()
const TMP_CAM = new Vector3()
// Margin past the exact horizon: a label right on the limb is unreadable anyway, and hiding a
// touch early avoids one-frame flicker at the boundary.
const HORIZON_MARGIN = 0.05

/** True when a point on the unit sphere (pin world position) is on the camera-facing cap.
 *  For a camera at distance d from the globe's center, the horizon sits where the angle α
 *  between the point's normal and the camera direction satisfies cos α = 1/d. */
export function isFrontFacing(pinDotCam: number, cameraDistance: number): boolean {
  return pinDotCam > EARTH_RADIUS / cameraDistance + HORIZON_MARGIN
}

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
  const sceneOverlay = useUiStore(s => s.sceneOverlay)
  const setSceneOverlay = useUiStore(s => s.setSceneOverlay)
  const overlayOpen = sceneOverlay?.kind === 'region' && sceneOverlay.id === regionId
  // Overlay Html portals OUTSIDE the aria-hidden canvas wrapper (T3 fix) — the shell's esc
  // button (and T4's controls) must stay in the accessibility tree. The ring + label Htmls
  // stay in the default (decorative) container.
  const overlayPortal = useContext(OverlayPortalContext)

  const pinRef = useRef<Mesh>(null)
  const groupRef = useRef<Group>(null)
  const [hovered, setHovered] = useState(false)
  const [labelVisible, setLabelVisible] = useState(true)
  const labelVisibleRef = useRef(true)
  const holdStartRef = useRef<number | null>(null)
  // Deadline (performance.now() ms) until which the next click is swallowed — set by hold
  // completion AND by an aborted hold (released ≥ HOLD_TAP_MS but before completion, spec D1:
  // early release = no navigation). A timestamp, not a boolean: it self-expires, so a swallow
  // whose synthetic click the browser never delivers can't eat the NEXT genuine tap.
  const swallowClickUntilRef = useRef(0)
  const holdProgressRef = useRef(0)
  const position = useMemo(() => latLonToVec3(lat, lon, PIN_ALTITUDE), [lat, lon])
  const color = pinColor(health)
  const down = health === 'down'

  // Frame callback: reads `pulsing` from the latest render's closure (r3f updates useFrame's
  // callback ref every render — no stale-closure risk) and writes to the mesh's scale ref.
  // The one setState here (label visibility) fires only on a horizon crossing, not per frame —
  // drei <Html> is a DOM element, so hiding it has to go through React, and its raycast-based
  // `occlude` prop demonstrably left far-side labels floating over the globe.
  useFrame((state) => {
    if (groupRef.current) {
      const pin = groupRef.current.getWorldPosition(TMP_PIN).normalize()
      const cameraDistance = state.camera.position.length()
      const facing = isFrontFacing(pin.dot(TMP_CAM.copy(state.camera.position).normalize()), cameraDistance)
      if (facing !== labelVisibleRef.current) {
        labelVisibleRef.current = facing
        setLabelVisible(facing)
      }
    }
    // Hold-to-enter (Polish 2 D5): drive the ring from performance.now() (pointer handlers
    // can't read the r3f clock — one coherent timebase, see plan header decision 1). Placed
    // ABOVE the pulse block: its `!pulsing` early return would otherwise make this dead code
    // on any non-pulsing (i.e. normal) pin.
    const p = holdProgress(performance.now(), holdStartRef.current)
    holdProgressRef.current = p
    if (p >= 1 && holdStartRef.current !== null) {
      holdStartRef.current = null
      holdProgressRef.current = 0
      // Swallow the synthetic click that follows pointerup — generous window, self-expiring.
      swallowClickUntilRef.current = performance.now() + SWALLOW_WINDOW_MS
      goRegion(regionId)
    }

    if (!pinRef.current) return
    if (!pulsing) { pinRef.current.scale.setScalar(1); return }
    const t = (state.clock.elapsedTime % PULSE_PERIOD_S) / PULSE_PERIOD_S   // 0..1 sawtooth
    pinRef.current.scale.setScalar(1 + 0.35 * Math.sin(t * Math.PI))        // 1 -> 1.35 -> 1
  })

  return (
    <group ref={groupRef} position={position}>
      <mesh
        ref={pinRef}
        onClick={e => {
          e.stopPropagation()
          // Completed or aborted hold — swallow its synthetic click; a plain tap falls through.
          if (performance.now() < swallowClickUntilRef.current) { swallowClickUntilRef.current = 0; return }
          setSceneOverlay({ kind: 'region', id: regionId })
        }}
        onPointerMissed={() => {
          const cur = useUiStore.getState().sceneOverlay
          if (cur?.kind === 'region' && cur.id === regionId) useUiStore.getState().setSceneOverlay(null)
        }}
        onPointerDown={e => {
          e.stopPropagation()
          ;(e.target as Element | undefined)?.setPointerCapture?.(e.pointerId)
          holdStartRef.current = performance.now()
        }}
        onPointerUp={e => {
          const start = holdStartRef.current   // capture BEFORE nulling (completion already cleared it)
          ;(e.target as Element | undefined)?.releasePointerCapture?.(e.pointerId)
          holdStartRef.current = null      // released early → cancel (completion already cleared it)
          // Released after the tap threshold but before completion = an aborted hold (spec D1):
          // no navigation — swallow the synthetic click that's about to fire. Self-expiring window.
          if (start !== null && isAbortedHold(performance.now() - start)) swallowClickUntilRef.current = performance.now() + SWALLOW_WINDOW_MS
        }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; setHovered(true) }}
        onPointerOut={() => {
          document.body.style.cursor = 'default'; setHovered(false)
          holdStartRef.current = null      // left the pin mid-hold → cancel (mockup pointerleave)
        }}
      >
        <sphereGeometry args={[PIN_RADIUS, 16, 16]} />
        {/* Self-lit (emissive-only, color=black zeroes the unlit diffuse contribution) — the
            scene has no lights (D2: no sun simulation), so a plain meshStandardMaterial color
            would render black without this. emissiveIntensity bumps on hover for "brighten"
            (discrete pointer events, not per-frame — plain useState is fine here, unlike the
            pulse scale above which is driven every frame via a ref). */}
        <meshStandardMaterial color="black" emissive={color} emissiveIntensity={hovered ? 1.6 : 1.1} />
      </mesh>
      <mesh>
        <sphereGeometry args={[GLOW_RADIUS, 12, 12]} />
        <meshBasicMaterial color={color} transparent opacity={0.28} depthWrite={false} blending={AdditiveBlending} />
      </mesh>
      <Html center zIndexRange={[50, 40]} style={{ pointerEvents: 'none' }}>
        <HoldRing progressRef={holdProgressRef} />
      </Html>
      {/* No distanceFactor: it CSS-scaled the 9px label up ~3x at the default camera distance —
          blurry and globe-covering. A fixed screen-size 10px label reads the same at every zoom.
          Visibility comes from the useFrame horizon test above, not drei's `occlude`. */}
      {labelVisible && (
        <Html style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <span style={{ font: '10px var(--font-mono)', color: down ? DOWN_LABEL_COLOR : HEALTHY_LABEL_COLOR, marginLeft: 8 }}>
            {catalogId}{down && <span style={{ color: DOWN_LABEL_COLOR }}> ▼ down</span>}
          </span>
        </Html>
      )}
      {overlayOpen && (
        <Html portal={overlayPortal ?? undefined} zIndexRange={[100, 90]} style={{ pointerEvents: 'auto' }}>
          <div style={{ transform: 'translate(14px, -8px)' }}>
            <SceneOverlay title={catalogId} health={health} onClose={() => setSceneOverlay(null)}>
              <div style={{ padding: '10px 13px 2px', color: 'var(--color-text-muted)' }}>
                region controls arrive in T4
              </div>
            </SceneOverlay>
          </div>
        </Html>
      )}
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
