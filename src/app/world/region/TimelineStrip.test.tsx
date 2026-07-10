// src/app/world/region/TimelineStrip.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TimelineStrip } from './TimelineStrip'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function fakeBatch(simMs: number): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs: {}, regions: {}, world: emptyWorldMetrics() }
}

function seedTwoRegions() {
  const doc = createWorld()
  const regionA = createRegion('us-east-1')
  const regionB = createRegion('eu-west-1')
  const azA = createAz(regionA.id, 'us-east-1a')
  const azX = createAz(regionB.id, 'eu-west-1a')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverX = createServer(azX.id, getPreset('vps-medium')!)
  doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
  doc.azs[azA.id] = azA; doc.azs[azX.id] = azX
  doc.servers[serverA.id] = serverA; doc.servers[serverX.id] = serverX
  useWorldStore.setState({ doc, history: [], future: [] })
  return { doc, regionA, regionB, azA, azX }
}

// Captured once, pristine — restored by resetSim() every test (see the same note in
// RegionView.test.tsx; this file overrides getReplayFrames/setScrubIndex per-test).
const realSetScrubIndex = useSimulationStore.getState().setScrubIndex
const realGetReplayFrames = useSimulationStore.getState().getReplayFrames

function resetSim() {
  useSimulationStore.setState({
    running: false, timeScale: 1, latestBatch: null, events: [], healthOverrides: {},
    scrubIndex: null, scrubBatch: null, degraded: false,
    setScrubIndex: realSetScrubIndex, getReplayFrames: realGetReplayFrames,
  })
}

describe('TimelineStrip', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    resetSim()
  })

  it('renders glyphs for region-scoped events only', () => {
    const { regionA, azA, azX } = seedTwoRegions()
    const events: EngineEvent[] = [
      { id: 'in-scope', simMs: 9000, kind: 'outage_triggered', severity: 'critical', message: 'a', affected: [azA.id] },
      { id: 'out-of-scope', simMs: 9000, kind: 'oom_kill', severity: 'critical', message: 'b', affected: [azX.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000), events })
    render(<TimelineStrip regionId={regionA.id} />)
    expect(screen.getByTitle('a · t+9.0s')).toBeInTheDocument()
    expect(screen.queryByTitle('b · t+9.0s')).not.toBeInTheDocument()
  })

  it('click while stopped scrubs to nearest frame', () => {
    const { regionA, azA } = seedTwoRegions()
    const events: EngineEvent[] = [
      { id: 'e1', simMs: 5200, kind: 'failover_started', severity: 'warning', message: 'failing over', affected: [azA.id] },
    ]
    const frames: ReplayFrame[] = [1000, 5000, 9000].map(simMs => ({ simMs, batch: fakeBatch(simMs), events: [] }))
    const setScrubIndexSpy = vi.fn()
    useSimulationStore.setState({
      running: false, latestBatch: fakeBatch(10_000), events,
      getReplayFrames: () => frames, setScrubIndex: setScrubIndexSpy,
    })
    render(<TimelineStrip regionId={regionA.id} />)
    fireEvent.click(screen.getByTitle(/failing over/))
    expect(setScrubIndexSpy).toHaveBeenCalledWith(1)   // frame simMs=5000 is nearest to event simMs=5200
  })

  it('clicks inert while running', () => {
    const { regionA, azA } = seedTwoRegions()
    const events: EngineEvent[] = [
      { id: 'e1', simMs: 5200, kind: 'failover_started', severity: 'warning', message: 'failing over', affected: [azA.id] },
    ]
    const setScrubIndexSpy = vi.fn()
    useSimulationStore.setState({ running: true, latestBatch: fakeBatch(10_000), events, setScrubIndex: setScrubIndexSpy })
    render(<TimelineStrip regionId={regionA.id} />)
    fireEvent.click(screen.getByTitle('stop the simulation to scrub to this event'))
    expect(setScrubIndexSpy).not.toHaveBeenCalled()
  })

  it('null with no events', () => {
    const { regionA } = seedTwoRegions()
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000), events: [] })
    const { container } = render(<TimelineStrip regionId={regionA.id} />)
    expect(container).toBeEmptyDOMElement()
  })
})
