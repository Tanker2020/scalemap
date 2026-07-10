// src/app/world/region/RegionView.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RegionView } from '../RegionView'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { WorldDoc } from '../../../lib/world/types'
import type { MetricsBatch, AzMetrics } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function fakeBatch(simMs: number, azs: Record<string, AzMetrics>): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs, regions: {}, world: emptyWorldMetrics() }
}
function az(over: Partial<AzMetrics>): AzMetrics {
  return { azId: '', rps: 0, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0, ...over }
}

function seedRegion() {
  const doc: WorldDoc = createWorld()
  const region = createRegion('us-east-1')
  const azA = createAz(region.id, 'us-east-1a')
  const azB = createAz(region.id, 'us-east-1b')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB = createServer(azB.id, getPreset('vps-medium')!)
  serverA.label = 'web-01'
  serverB.label = 'web-02'
  doc.regions[region.id] = region
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
  doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB
  const bp = createBlueprint('web', 0)
  doc.blueprints[bp.id] = bp
  doc.placements['p1'] = createPlacement(bp.id, serverA.id)
  doc.placements['p2'] = createPlacement(bp.id, serverB.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useNavStore.setState({ level: 'region', regionId: region.id, azId: null, serverId: null })
  return { doc, region, azA, azB, serverA, serverB }
}

// Captured once, pristine — restored by resetSim() every test so a spy installed by one test
// (e.g. the outage-switch test overriding setOutage) never leaks into the next.
const realSetOutage = useSimulationStore.getState().setOutage

function resetSim() {
  useSimulationStore.setState({
    running: false, timeScale: 1, latestBatch: null, events: [], healthOverrides: {},
    scrubIndex: null, scrubBatch: null, degraded: false, setOutage: realSetOutage,
  })
}

describe('RegionView (Phase 4 flow page)', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    resetSim()
  })

  it('renders one AzRow per az with ring score', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(1000, {
        [azA.id]: az({ azId: azA.id, healthScore: 91, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, healthScore: 87, health: 'healthy' }),
      }),
    })
    render(<RegionView />)
    expect(screen.getByText('us-east-1a')).toBeInTheDocument()
    expect(screen.getByText('us-east-1b')).toBeInTheDocument()
    expect(screen.getByText('91')).toBeInTheDocument()
    expect(screen.getByText('87')).toBeInTheDocument()
  })

  it('down az row shows drain targets instead of strips', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(1000, {
        [azA.id]: az({ azId: azA.id, healthScore: 91, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, healthScore: 9, health: 'down' }),
      }),
    })
    render(<RegionView />)
    expect(screen.getByText(/draining/)).toBeInTheDocument()
    expect(screen.getByTitle('web-01')).toBeInTheDocument()          // healthy row still shows its strip
    expect(screen.queryByTitle('web-02')).not.toBeInTheDocument()    // down row swapped strip for drain line
  })

  it("az outage switch dispatches setOutage('az')", () => {
    const { azA } = seedRegion()
    const setOutageSpy = vi.fn()
    useSimulationStore.setState({ running: true, setOutage: setOutageSpy })
    render(<RegionView />)
    fireEvent.click(screen.getByLabelText('Simulate outage for us-east-1a'))
    expect(setOutageSpy).toHaveBeenCalledWith('az', azA.id, true)
  })

  it('server strip click navigates to server, row click to az', () => {
    const { region, azA, azB, serverA } = seedRegion()
    render(<RegionView />)
    fireEvent.click(screen.getByTitle('web-01'))
    expect(useNavStore.getState()).toMatchObject({ level: 'server', regionId: region.id, azId: azA.id, serverId: serverA.id })

    fireEvent.click(screen.getByText('us-east-1b'))
    expect(useNavStore.getState()).toMatchObject({ level: 'az', regionId: region.id, azId: azB.id, serverId: null })
  })

  it('ribbon renders redistribution message and timeline link', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(10_000, {
        [azA.id]: az({ azId: azA.id, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, health: 'down' }),
      }),
      events: [{
        id: 'e1', simMs: 9000, kind: 'outage_triggered', severity: 'critical',
        message: 'us-east-1b unhealthy', affected: [azB.id],
      }],
    })
    render(<RegionView />)
    expect(screen.getByText(/redistributed to/)).toBeInTheDocument()
    expect(screen.getByText('timeline')).toBeInTheDocument()
  })

  it('renders static skeleton with no batch', () => {
    seedRegion()
    render(<RegionView />)
    expect(screen.getByText('us-east-1a')).toBeInTheDocument()
    expect(screen.getByText('us-east-1b')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })
})
