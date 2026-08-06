// @vitest-environment jsdom
// Polish 4 T3 (spec D3/D5): the floor-plan instrument's clickable isometric minimap. jsdom
// because the component is plain SVG/DOM (no WebGL).
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FloorPlanHeader } from './FloorPlanHeader'
import { useWorldStore } from '../../store/world.store'
import { useUiStore } from '../../store/ui.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useUiStore.setState({ selectedServerId: null })
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null, running: false })
})

function seedAz() {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
}

describe('FloorPlanHeader', () => {
  it('renders one minimap-cab per rack and one minimap-pod per free-pool server', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    useWorldStore.getState().addRack(azId)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // free pool
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // free pool

    render(<FloorPlanHeader azId={azId} />)
    expect(screen.getAllByTestId('minimap-cab')).toHaveLength(2)
    expect(screen.getAllByTestId('minimap-pod')).toHaveLength(2)
  })

  it('renders no cab/pod shapes for an empty AZ', () => {
    const { azId } = seedAz()
    render(<FloorPlanHeader azId={azId} />)
    expect(screen.queryAllByTestId('minimap-cab')).toHaveLength(0)
    expect(screen.queryAllByTestId('minimap-pod')).toHaveLength(0)
  })

  it('headline shows the AZ label uppercased, live inbound rps, and $/mo', () => {
    const { azId } = seedAz()
    const batch: MetricsBatch = {
      simMs: 1000, instances: {}, servers: {},
      azs: { [azId]: { azId, rps: 425, errorRate: 0, p50Ms: 5, p90Ms: 6, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0 } },
      regions: {},
      world: { totalRps: 425, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    }
    useSimulationStore.setState({ latestBatch: batch })
    render(<FloorPlanHeader azId={azId} />)
    const headline = screen.getByTestId('floor-plan-headline')
    expect(headline).toHaveTextContent('US-EAST-1A')
    expect(headline).toHaveTextContent('425 rps in')
    expect(headline).toHaveTextContent('/mo')
  })

  it('shows 0 rps in and $0/mo at rest (no batch)', () => {
    const { azId } = seedAz()
    render(<FloorPlanHeader azId={azId} />)
    expect(screen.getByTestId('floor-plan-headline')).toHaveTextContent('0 rps in')
  })

  it('clicking a pod selects that server directly', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<FloorPlanHeader azId={azId} />)
    fireEvent.click(screen.getByTestId('minimap-pod'))
    expect(useUiStore.getState().selectedServerId).toBe(serverId)
  })

  it('clicking a cabinet selects its lowest-unit resident server', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    const rack = Object.values(useWorldStore.getState().doc.racks)[0]
    const first = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const second = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().assignServerToRack(first, rack.id)
    useWorldStore.getState().assignServerToRack(second, rack.id)

    render(<FloorPlanHeader azId={azId} />)
    fireEvent.click(screen.getByTestId('minimap-cab'))
    // `first` occupies unit 1 (assigned before `second`) — the lowest-unit resident.
    expect(useUiStore.getState().selectedServerId).toBe(first)
  })

  it('clicking an empty cabinet does not change the selection', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addRack(azId)
    render(<FloorPlanHeader azId={azId} />)
    fireEvent.click(screen.getByTestId('minimap-cab'))
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })

  it('marks the shape containing the current selection with the `sel` class', () => {
    const { azId } = seedAz()
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useUiStore.setState({ selectedServerId: serverId })
    render(<FloorPlanHeader azId={azId} />)
    const pod = screen.getByTestId('minimap-pod')
    expect(pod.getAttribute('class')).toMatch(/\bsel\b/)
  })

  it('does not mark an unselected shape with the `sel` class', () => {
    const { azId } = seedAz()
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<FloorPlanHeader azId={azId} />)
    const pod = screen.getByTestId('minimap-pod')
    expect(pod.getAttribute('class')).not.toMatch(/\bsel\b/)
  })
})
