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
