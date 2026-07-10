// src/app/world/globe/RegionPins.tsx
// Health-lit region pins (Phase 5 D5): one small self-lit dot + additive glow halo per doc
// region with a REGION_GEO-known catalogId, colored by RegionMetrics.health, labeled via drei
// <Html>, pulsing while a failover/outage event touching the region is <10s old, click → nav.
// Reads stores directly (no props) — mounted as a GlobeScene child (T3) alongside
// PopulationMarkers/ArcsLayer. R3F component; NOT jsdom-tested (no WebGL there) — this task's
// live smoke is the gate. The two exported pure helpers below (pinColor, isPulsing) ARE
// unit-tested (node env, RegionPins.test.ts) since they carry the only testable logic.
import { useMemo, useRef, useState, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useReducedMotion } from 'framer-motion'
import { AdditiveBlending, type Mesh } from 'three'
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
  const [hovered, setHovered] = useState(false)
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
        onPointerOver={() => { document.body.style.cursor = 'pointer'; setHovered(true) }}
        onPointerOut={() => { document.body.style.cursor = 'default'; setHovered(false) }}
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
