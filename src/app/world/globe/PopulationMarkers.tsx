// src/app/world/globe/PopulationMarkers.tsx
// Teal client-population markers (Phase 5 D5): one small dot per ClientPopulation at its
// lat/lon, hover-only label `label · <peakRps> rps`. Tap opens a SceneOverlay (Polish 2 T3;
// editing content itself lands in T4 — this task is a placeholder mount). Reads the world
// store directly — mounted as a GlobeScene child (T3). R3F component; NOT jsdom-tested (no
// WebGL there) — this task's live smoke is the gate.
import { useContext, useMemo, useState, type ReactElement } from 'react'
import { Html } from '@react-three/drei'
import { useWorldStore } from '../../store/world.store'
import { useUiStore } from '../../store/ui.store'
import { SceneOverlay } from '../ui/SceneOverlay'
import { OverlayPortalContext } from './overlayPortal'
import { latLonToVec3 } from './geo'

const EARTH_RADIUS = 1
const MARKER_ALTITUDE = EARTH_RADIUS * 1.002
const MARKER_RADIUS = 0.012
const TEAL = '#2DD4BF'          // matches the arc/theme teal (D6) — population markers are the
                                 // arc's origin point, same color family
const LABEL_COLOR = '#7DEFDD'

interface MarkerProps { id: string; label: string; lat: number; lon: number; peakRps: number }

function PopulationMarker({ id, label, lat, lon, peakRps }: MarkerProps): ReactElement {
  const [hovered, setHovered] = useState(false)
  const position = useMemo(() => latLonToVec3(lat, lon, MARKER_ALTITUDE), [lat, lon])
  const overlayOpen = useUiStore(s => s.sceneOverlay?.kind === 'population' && s.sceneOverlay.id === id)
  // Overlay Html portals OUTSIDE the aria-hidden canvas wrapper (T3 fix) — same reasoning as
  // RegionPins.tsx. The hover-label Html stays in the default (decorative) container.
  const overlayPortal = useContext(OverlayPortalContext)

  return (
    <group position={position}>
      <mesh
        onClick={e => { e.stopPropagation(); useUiStore.getState().setSceneOverlay({ kind: 'population', id }) }}
        onPointerMissed={() => {
          const cur = useUiStore.getState().sceneOverlay
          if (cur?.kind === 'population' && cur.id === id) useUiStore.getState().setSceneOverlay(null)
        }}
        onPointerOver={() => { document.body.style.cursor = 'pointer'; setHovered(true) }}
        onPointerOut={() => { document.body.style.cursor = 'default'; setHovered(false) }}
      >
        <sphereGeometry args={[MARKER_RADIUS, 12, 12]} />
        <meshStandardMaterial color="black" emissive={TEAL} emissiveIntensity={hovered ? 1.6 : 1} />
      </mesh>
      {hovered && (
        // Fixed screen-size label (no distanceFactor) — same reasoning as RegionPins.tsx.
        <Html occlude style={{ pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <span style={{ font: '10px var(--font-mono)', color: LABEL_COLOR, marginLeft: 8 }}>
            {label} · {peakRps.toFixed(0)} rps
          </span>
        </Html>
      )}
      {overlayOpen && (
        <Html portal={overlayPortal ?? undefined} zIndexRange={[100, 90]} style={{ pointerEvents: 'auto' }}>
          <div style={{ transform: 'translate(14px, -8px)' }}>
            <SceneOverlay
              title={label} subtitle="client population" dotColor="var(--kit-teal)"
              onClose={() => useUiStore.getState().setSceneOverlay(null)}
            >
              <div style={{ padding: '10px 13px 2px', color: 'var(--color-text-muted)' }}>
                demand controls arrive in T4
              </div>
            </SceneOverlay>
          </div>
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
        <PopulationMarker key={p.id} id={p.id} label={p.label} lat={p.lat} lon={p.lon} peakRps={p.peakRps} />
      ))}
    </>
  )
}
