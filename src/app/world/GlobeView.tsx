// src/app/world/GlobeView.tsx
// Level-1 globe (Phase 5 D2/D7): the real r3f night-earth scene when WebGL is available,
// GlobeCards (the pre-Phase-5 card grid) otherwise. A visually-hidden a11y region list with the
// same goRegion navigation renders in BOTH branches — the canvas container is aria-hidden
// (decorative to a screen reader; the hidden list is the real navigation surface there, and it
// also covers any environment that passes the WebGL probe but still renders nothing).
import type { CSSProperties } from 'react'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
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
  const populations = useWorldStore(s => s.doc.populations)

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
      <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
        <GlobeScene placeMode={placeMode} onPlace={onPlace}>
          <RegionPins />
          <PopulationMarkers />
          <ArcsLayer />
        </GlobeScene>
      </div>
      <RegionA11yList />
    </div>
  )
}
