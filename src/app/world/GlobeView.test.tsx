// src/app/world/GlobeView.test.tsx
// @vitest-environment jsdom
// R3F scene internals (GlobeScene + the T4/T5/T7 layers it hosts) are NOT jsdom-tested — jsdom
// has no WebGL context, so @react-three/fiber's <Canvas> cannot mount there. The fallback-branch
// describe block below exercises the webglAvailable()===false path end to end (unchanged from
// before this task). The "traffic placement mode" describe block exercises the
// webglAvailable()===true branch's plain-DOM surface (HUD buttons, onPlace snap logic) by
// mocking GlobeScene itself to a dumb stub that never renders its children — real children
// (RegionPins/ArcsLayer/TrafficPlacementLayer/etc.) call r3f hooks like useFrame that require an
// actual Canvas/fiber root, which jsdom can't provide; GlobeScene's own live behavior (and
// TrafficPlacementLayer's) stays gated by this task's live smoke, as stated in the brief.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

vi.mock('./globe/webgl', () => ({ webglAvailable: vi.fn(() => false) }))
vi.mock('./globe/GlobeScene', () => ({
  GlobeScene: ({ onPlace }: { onPlace: (lat: number, lon: number) => void }) => (
    // Fires onPlace at coordinates NEAR (not exactly on) São Paulo — proves the snap, not a
    // pass-through identity that would look the same either way.
    <button aria-label="mock-earth-click" onClick={() => onPlace(-23.0, -46.0)} />
  ),
}))

import { GlobeView } from './GlobeView'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useSimulationStore } from '../store/simulation.store'
import { useUiStore } from '../store/ui.store'
import { createWorld, createRegion } from '../../lib/world/factories'
import { webglAvailable } from './globe/webgl'

const noop = () => {}

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
    vi.mocked(webglAvailable).mockReturnValue(false)
    useWorldStore.getState().newWorld()
    useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
    resetSim()
  })

  it('renders GlobeCards when webgl unavailable', () => {
    seedOneRegion()
    render(<GlobeView placeMode={false} onExitPlaceMode={noop} onPopulationPlaced={noop} onTogglePlaceMode={noop} />)
    // GlobeCards' card grid renders the region's catalogId as a clickable card heading.
    expect(screen.getAllByText('us-east-1').length).toBeGreaterThan(0)
  })

  it('hidden a11y region list navigates', () => {
    const { region } = seedOneRegion()
    render(<GlobeView placeMode={false} onExitPlaceMode={noop} onPopulationPlaced={noop} onTogglePlaceMode={noop} />)
    const nav = screen.getByRole('navigation', { name: 'Regions' })
    fireEvent.click(within(nav).getByRole('button', { name: 'us-east-1' }))
    expect(useNavStore.getState()).toMatchObject({ level: 'region', regionId: region.id })
  })
})

describe('GlobeView — traffic placement mode (WebGL available, GlobeScene mocked)', () => {
  beforeEach(() => {
    vi.mocked(webglAvailable).mockReturnValue(true)
    useWorldStore.getState().newWorld()
    useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
    resetSim()
    useUiStore.setState({ sceneOverlay: null })
  })

  it('rest state: "+ traffic", enabled, no esc hint', () => {
    render(<GlobeView placeMode={false} onExitPlaceMode={noop} onPopulationPlaced={noop} onTogglePlaceMode={noop} />)
    const btn = screen.getByRole('button', { name: 'Place traffic' })
    expect(btn).toHaveTextContent('+ traffic')
    expect(btn).not.toHaveTextContent('click a city')
    expect(btn).not.toBeDisabled()
    expect(screen.queryByText('esc = cancel')).not.toBeInTheDocument()
  })

  it('armed state: label changes to "+ traffic — click a city" and the esc hint appears', () => {
    render(<GlobeView placeMode={true} onExitPlaceMode={noop} onPopulationPlaced={noop} onTogglePlaceMode={noop} />)
    const btn = screen.getByRole('button', { name: 'Exit traffic placement mode' })
    expect(btn).toHaveTextContent('+ traffic — click a city')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('esc = cancel')).toBeInTheDocument()
  })

  it('running: disabled with the edit-lock title, regardless of armed state', () => {
    useSimulationStore.setState({ running: true })
    render(<GlobeView placeMode={false} onExitPlaceMode={noop} onPopulationPlaced={noop} onTogglePlaceMode={noop} />)
    const btn = screen.getByRole('button', { name: 'Place traffic' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'stop the simulation to edit')
  })

  it('click toggles via onTogglePlaceMode (same state TrafficPanel\'s toggle uses)', () => {
    const onToggle = vi.fn()
    render(<GlobeView placeMode={false} onExitPlaceMode={noop} onPopulationPlaced={noop} onTogglePlaceMode={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Place traffic' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('onPlace snaps the raw lat/lon to the nearest city, labels the population after it, exits place mode, and opens its overlay', () => {
    const onExitPlaceMode = vi.fn()
    const onPopulationPlaced = vi.fn()
    render(
      <GlobeView
        placeMode={true}
        onExitPlaceMode={onExitPlaceMode}
        onPopulationPlaced={onPopulationPlaced}
        onTogglePlaceMode={noop}
      />,
    )
    fireEvent.click(screen.getByLabelText('mock-earth-click'))

    const pops = Object.values(useWorldStore.getState().doc.populations)
    expect(pops).toHaveLength(1)
    // Snapped, not pass-through: the click was at (-23.0, -46.0), NOT São Paulo's exact coords.
    expect(pops[0].label).toBe('São Paulo')
    expect(pops[0].lat).toBeCloseTo(-23.5505, 3)
    expect(pops[0].lon).toBeCloseTo(-46.6333, 3)

    expect(onExitPlaceMode).toHaveBeenCalledTimes(1)
    expect(onPopulationPlaced).toHaveBeenCalledWith(pops[0].id)
    expect(useUiStore.getState().sceneOverlay).toEqual({ kind: 'population', id: pops[0].id })
  })
})
