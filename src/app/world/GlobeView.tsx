// src/app/world/GlobeView.tsx
// Level-1 globe (Phase 5 D2/D7): the real r3f night-earth scene when WebGL is available,
// GlobeCards (the pre-Phase-5 card grid) otherwise. A visually-hidden a11y region list with the
// same goRegion navigation renders in BOTH branches — the canvas container is aria-hidden
// (decorative to a screen reader; the hidden list is the real navigation surface there, and it
// also covers any environment that passes the WebGL probe but still renders nothing).
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useUiStore } from '../store/ui.store'
import { OverlayPortalContext } from './globe/overlayPortal'
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { ArcsLayer } from './globe/ArcsLayer'
import { webglAvailable } from './globe/webgl'
import { nextPopulationLabel } from '../../lib/world/populationLabel'

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

export interface GlobeViewProps {
  placeMode: boolean
  onExitPlaceMode: () => void
  onPopulationPlaced: (id: string) => void
}

export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
  const addPopulation = useWorldStore(s => s.addPopulation)
  const doc = useWorldStore(s => s.doc)
  const populations = doc.populations
  const [rotationLocked, setRotationLocked] = useState(false)
  const sceneOverlay = useUiStore(s => s.sceneOverlay)
  // null! selects React 19's RefObject<HTMLDivElement> overload (matching the context's and
  // drei portal's non-nullable RefObject type); runtime-safe — the portal div mounts in the
  // same commit as the canvas, long before any overlay can open, and drei falls back to its
  // default container if current were ever still null.
  const overlayPortalRef = useRef<HTMLDivElement>(null!)

  // Escape closes an open overlay; WorldShell's own Escape → nav.up() is a no-op at globe
  // level (nav.store.ts:28-33), so the two listeners cannot fight. Overlay state also clears
  // on unmount (level change) so a stale overlay never survives navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useUiStore.getState().sceneOverlay) useUiStore.getState().setSceneOverlay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      useUiStore.getState().setSceneOverlay(null)
    }
  }, [])

  // A dock-side delete of the open overlay's entity must close the overlay: its pin/marker
  // (and the click-away handler that lived on that mesh) unmounts with the entity, which would
  // otherwise strand a stale card and keep the globe's rotation paused with no way to resume.
  useEffect(() => {
    if (!sceneOverlay) return
    const exists = sceneOverlay.kind === 'region' ? doc.regions[sceneOverlay.id] : doc.populations[sceneOverlay.id]
    if (!exists) useUiStore.getState().setSceneOverlay(null)
  }, [sceneOverlay, doc])

  // Place-mode is armed/disarmed by WorldShell (the common ancestor of this component and
  // TrafficPanel) via the placeMode prop; a click on the globe here places a population, then
  // hands control back up so WorldShell can disarm and TrafficPanel can select+focus the new row.
  const onPlace = (lat: number, lon: number) => {
    // Phase 6 T9 carry-forward: same shared max-suffix helper TrafficPanel.tsx's "+ add" uses —
    // this file's previous `pop-${populationCount + 1}` and TrafficPanel's independent
    // `pop-${populations.length + 1}` counter could reissue the same label after a
    // remove+re-add from either surface (Phase-5 backlog item).
    const label = nextPopulationLabel(populations)
    const id = addPopulation(label, lat, lon)
    onExitPlaceMode()
    onPopulationPlaced(id)
  }

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
      <OverlayPortalContext.Provider value={overlayPortalRef}>
      <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
        <GlobeScene placeMode={placeMode} onPlace={onPlace} autoRotate={!rotationLocked && sceneOverlay == null}>
          <RegionPins />
          <PopulationMarkers />
          <ArcsLayer />
        </GlobeScene>
      </div>
      {/* Overlay portal target — outside the aria-hidden canvas wrapper so overlay controls
          stay in the accessibility tree. pointerEvents none: only the overlay cards
          themselves (which re-enable pointer events) are interactive. */}
      <div ref={overlayPortalRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 10 }} />
      <button
        aria-label={rotationLocked ? 'Resume globe rotation' : 'Lock globe rotation'}
        title={rotationLocked ? 'Resume the globe’s idle spin' : 'Stop the globe’s idle spin'}
        onClick={() => setRotationLocked(l => !l)}
        style={{
          position: 'absolute', top: 12, left: 12,
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--color-toolbar)', border: '1px solid var(--color-toolbar-border)',
          borderRadius: 5, padding: '4px 9px', cursor: 'pointer',
          font: '10px var(--font-mono)', color: 'var(--color-text-secondary)',
        }}
      >
        {rotationLocked ? '🔒 rotation locked' : '🌐 rotating'}
      </button>
      <RegionA11yList />
      </OverlayPortalContext.Provider>
    </div>
  )
}
