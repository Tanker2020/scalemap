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
