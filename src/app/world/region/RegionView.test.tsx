// src/app/world/region/RegionView.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
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
    const { container } = render(<RegionView />)
    // TimelineV2 (Polish 4 T6) also renders each AZ's label as its lane label, so a bare
    // getByText('us-east-1a') is now ambiguous — scope to the AzRow card via its `data-az-row`
    // marker to assert specifically on the AzRow instance this test is about.
    expect(within(container.querySelector(`[data-az-row="${azA.id}"]`)!).getByText(azA.label)).toBeInTheDocument()
    expect(within(container.querySelector(`[data-az-row="${azB.id}"]`)!).getByText(azB.label)).toBeInTheDocument()
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
    // organic engine-reported health, no manual override — must NOT read as operator-triggered
    expect(screen.getByText('outage')).toBeInTheDocument()
    expect(screen.queryByText('outage (manual)')).not.toBeInTheDocument()
  })

  it('manually downed az row labels the outage as manual', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(1000, {
        [azA.id]: az({ azId: azA.id, healthScore: 91, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, healthScore: 9, health: 'down' }),
      }),
      healthOverrides: { [azB.id]: true },
    })
    render(<RegionView />)
    expect(screen.getByText('outage (manual)')).toBeInTheDocument()
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
    const { container } = render(<RegionView />)
    fireEvent.click(screen.getByTitle('web-01'))
    expect(useNavStore.getState()).toMatchObject({ level: 'server', regionId: region.id, azId: azA.id, serverId: serverA.id })

    // Scoped to the AzRow card (see the note above) — TimelineV2 renders the same 'us-east-1b'
    // text as a lane label, which isn't clickable, but would make a bare getByText ambiguous.
    const azBCard = within(container.querySelector(`[data-az-row="${azB.id}"]`)!)
    fireEvent.click(azBCard.getByText(azB.label))
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
    const { azA, azB } = seedRegion()
    const { container } = render(<RegionView />)
    // Scoped to the AzRow cards — see the ambiguity note on the first test in this file.
    expect(within(container.querySelector(`[data-az-row="${azA.id}"]`)!).getByText(azA.label)).toBeInTheDocument()
    expect(within(container.querySelector(`[data-az-row="${azB.id}"]`)!).getByText(azB.label)).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('AZ row $/mo renders in the price color', () => {
    const { azA, azB } = seedRegion()
    useSimulationStore.setState({
      latestBatch: fakeBatch(1000, {
        [azA.id]: az({ azId: azA.id, healthScore: 91, health: 'healthy' }),
        [azB.id]: az({ azId: azB.id, healthScore: 87, health: 'healthy' }),
      }),
    })
    render(<RegionView />)
    // vps-medium: 0.036 usd/hr * 730 = 26.28/mo, Math.round -> 26, one server per AZ
    expect(screen.getAllByText('$26/mo')).toHaveLength(2)
    for (const el of screen.getAllByText('$26/mo')) expect(el).toHaveStyle({ color: 'var(--color-price)' })
  })

  it("az card kill is disabled while stopped and dispatches setOutage('az', id, true) while running", () => {
    const { azA } = seedRegion()
    const { rerender } = render(<RegionView />)
    const stoppedBtn = screen.getByLabelText('Simulate outage for us-east-1a') as HTMLButtonElement
    expect(stoppedBtn.disabled).toBe(true)

    const setOutageSpy = vi.fn()
    useSimulationStore.setState({ running: true, setOutage: setOutageSpy })
    rerender(<RegionView />)
    const runningBtn = screen.getByLabelText('Simulate outage for us-east-1a') as HTMLButtonElement
    expect(runningBtn.disabled).toBe(false)
    fireEvent.click(runningBtn)
    expect(setOutageSpy).toHaveBeenCalledWith('az', azA.id, true)
  })

  it('sources column renders one row per population, top-5 animated', () => {
    const { doc, region } = seedRegion()
    const popRps: [string, number][] = [['p1', 600], ['p2', 500], ['p3', 400], ['p4', 300], ['p5', 200], ['p6', 100]]
    for (const [id, peakRps] of popRps) {
      doc.populations[id] = { id, label: `pop-${id}`, lat: 40, lon: -74, peakRps, diurnal: 'flat' }
    }
    useWorldStore.setState({ doc })
    const populationRoutes = popRps.map(([id, rps]) => ({ populationId: id, regionId: region.id, rps }))
    useSimulationStore.setState({
      latestBatch: {
        simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
        world: { ...emptyWorldMetrics(), populationRoutes, totalRps: 2100 },
      },
    })
    render(<RegionView />)
    for (const [id] of popRps.slice(0, 5)) {
      expect(screen.getByTestId(`src-row-${id}`).getAttribute('data-dot-count')).not.toBe('0')
    }
    expect(screen.getByTestId('src-row-p6').getAttribute('data-dot-count')).toBe('0')
  })

  it('the who\'s-sending trunk sums the ingress rows, NOT the region total-throughput metric', () => {
    // Regression for the "region summation is always incorrect" report: the trunk used to read
    // region.rps (ingress + internal service→service traffic), which exceeds the visible sources.
    const { doc, region } = seedRegion()
    doc.populations['a'] = { id: 'a', label: 'Chicago', lat: 41.9, lon: -87.6, peakRps: 1383, diurnal: 'flat' }
    doc.populations['b'] = { id: 'b', label: 'Seattle', lat: 47.6, lon: -122.3, peakRps: 511, diurnal: 'flat' }
    useWorldStore.setState({ doc })
    useSimulationStore.setState({
      latestBatch: {
        simMs: 1000, instances: {}, servers: {}, azs: {},
        // region.rps deliberately far exceeds the ingress sum (as internal fan-out makes it) so a
        // trunk reading region.rps would show 9,999 instead of the ingress 1,894.
        regions: { [region.id]: { regionId: region.id, rps: 9999, errorRate: 0, p50Ms: 5, healthScore: 100, health: 'healthy', inboundByPopulation: [] } },
        world: {
          ...emptyWorldMetrics(), totalRps: 9999,
          populationRoutes: [
            { populationId: 'a', regionId: region.id, rps: 1383 },
            { populationId: 'b', regionId: region.id, rps: 511 },
          ],
        },
      },
    })
    render(<RegionView />)
    expect(screen.getByText('1,894')).toBeInTheDocument()   // 1383 + 511, the ingress sum
    expect(screen.queryByText('9,999')).not.toBeInTheDocument()
  })

  it('replica rail caps concurrent dashflow animation at MAX_ANIMATED_RAILS regardless of pair count', () => {
    const { doc, azA, azB } = seedRegion()
    // Two independent cross-AZ primary/replica blueprint pairs — the rail must draw both curves
    // but animate only the first (review fix: unbounded animation was a motion-budget bug).
    const db1 = createBlueprint('db1', 1)
    db1.stateful = true
    doc.blueprints[db1.id] = db1
    const primary1 = createPlacement(db1.id, doc.servers[Object.keys(doc.servers).find(id => doc.servers[id].azId === azB.id)!].id)
    const replica1 = createPlacement(db1.id, doc.servers[Object.keys(doc.servers).find(id => doc.servers[id].azId === azA.id)!].id)
    replica1.role = 'replica'
    doc.placements[primary1.id] = primary1
    doc.placements[replica1.id] = replica1

    const serverC = createServer(azA.id, getPreset('vps-medium')!)
    const serverD = createServer(azB.id, getPreset('vps-medium')!)
    doc.servers[serverC.id] = serverC
    doc.servers[serverD.id] = serverD
    const db2 = createBlueprint('db2', 2)
    db2.stateful = true
    doc.blueprints[db2.id] = db2
    const primary2 = createPlacement(db2.id, serverD.id)
    const replica2 = createPlacement(db2.id, serverC.id)
    replica2.role = 'replica'
    doc.placements[primary2.id] = primary2
    doc.placements[replica2.id] = replica2

    useWorldStore.setState({ doc })
    const { container, rerender } = render(<RegionView />)

    // Idle world (no batch → region rps 0): both curves drawn, NOTHING animated — the rail's
    // march is gated on live traffic (dash speed = rate, post-Polish-3 fix wave 2026-07-11).
    const railPaths = container.querySelectorAll('path[stroke="var(--r3-amber)"]')
    expect(railPaths.length).toBe(2)   // both cross-AZ pairs are drawn
    expect(container.querySelectorAll('path[stroke="var(--r3-amber)"][data-animated]').length).toBe(0)

    // With live region traffic: at most MAX_ANIMATED_RAILS (1) carries dashflow.
    const region = Object.values(doc.regions)[0]
    const batch = fakeBatch(1000, { [azA.id]: az({ azId: azA.id, rps: 250 }), [azB.id]: az({ azId: azB.id, rps: 250 }) })
    batch.regions[region.id] = { regionId: region.id, rps: 500, errorRate: 0, p50Ms: 5, healthScore: 100, health: 'healthy', inboundByPopulation: [] }
    useSimulationStore.setState({ latestBatch: batch })
    rerender(<RegionView />)
    const animatedPaths = container.querySelectorAll('path[stroke="var(--r3-amber)"][data-animated]')
    expect(animatedPaths.length).toBe(1)
  })

  it('egress figure renders in the price color', () => {
    const { doc, region } = seedRegion()
    doc.populations.p1 = { id: 'p1', label: 'NYC', lat: 40, lon: -74, peakRps: 500, diurnal: 'flat' }
    useWorldStore.setState({ doc })
    useSimulationStore.setState({
      latestBatch: {
        simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
        world: { ...emptyWorldMetrics(), populationRoutes: [{ populationId: 'p1', regionId: region.id, rps: 500 }], totalRps: 500, internetEgressBytesPerSec: 1000 },
      },
    })
    render(<RegionView />)
    const egressEl = screen.getByText(/\/hr egress/)
    expect(egressEl).toHaveStyle({ color: 'var(--color-price)' })
  })
})
