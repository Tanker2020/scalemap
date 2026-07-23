// src/app/world/region/TimelineV2.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TimelineV2 } from './TimelineV2'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch, EngineEvent, ReplayFrame, AzMetrics } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function az(over: Partial<AzMetrics>): AzMetrics {
  return { azId: '', rps: 0, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0, ...over }
}
function fakeBatch(simMs: number, azs: Record<string, AzMetrics> = {}): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs, regions: {}, world: emptyWorldMetrics() }
}
function frame(simMs: number, azs: Record<string, AzMetrics> = {}): ReplayFrame {
  return { simMs, events: [], batch: fakeBatch(simMs, azs) }
}

function seedTwoAzRegion() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const azA = createAz(region.id, 'us-east-1a')
  const azB = createAz(region.id, 'us-east-1b')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB1 = createServer(azB.id, getPreset('vps-medium')!)
  const serverB2 = createServer(azB.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
  doc.servers[serverA.id] = serverA; doc.servers[serverB1.id] = serverB1; doc.servers[serverB2.id] = serverB2
  useWorldStore.setState({ doc, history: [], future: [] })
  return { doc, region, azA, azB, serverA, serverB1, serverB2 }
}

// Captured once, pristine — restored by resetSim() every test (mirrors TimelineStrip.test.tsx's
// own note, which this file's setup carries forward for the same reason: individual tests
// override getReplayFrames/setScrubIndex).
const realSetScrubIndex = useSimulationStore.getState().setScrubIndex
const realGetReplayFrames = useSimulationStore.getState().getReplayFrames

function resetSim() {
  useSimulationStore.setState({
    running: false, timeScale: 1, latestBatch: null, events: [], healthOverrides: {},
    scrubIndex: null, scrubBatch: null, degraded: false,
    setScrubIndex: realSetScrubIndex, getReplayFrames: realGetReplayFrames,
  })
}

describe('TimelineV2', () => {
  beforeEach(() => {
    useWorldStore.getState().newWorld()
    resetSim()
  })

  it('renders one lane per AZ with singular-aware server-count sub-labels', () => {
    const { region, azA, azB } = seedTwoAzRegion()
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000) })
    render(<TimelineV2 regionId={region.id} />)
    expect(screen.getByText(azA.label)).toBeInTheDocument()
    expect(screen.getByText(azB.label)).toBeInTheDocument()
    expect(screen.getByText('1 srv')).toBeInTheDocument()   // azA has 1 server
    expect(screen.getByText('2 srv')).toBeInTheDocument()   // azB has 2 servers
  })

  it('returns null when the region has no AZs', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    useWorldStore.setState({ doc, history: [], future: [] })
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000) })
    const { container } = render(<TimelineV2 regionId={region.id} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders health bands for a lane from the replay frame sequence', () => {
    const { region, azA } = seedTwoAzRegion()
    const frames: ReplayFrame[] = [
      frame(1000, { [azA.id]: az({ azId: azA.id, health: 'healthy' }) }),
      frame(2000, { [azA.id]: az({ azId: azA.id, health: 'down' }) }),
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(3000), getReplayFrames: () => frames })
    render(<TimelineV2 regionId={region.id} />)
    const bands = screen.getAllByTestId('tl-band')
    const states = bands.map(b => b.getAttribute('data-state'))
    expect(states).toContain('healthy')
    expect(states).toContain('down')
  })

  it('renders a marker for a region-scoped event with the right class and a t=Xs · message tooltip', () => {
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'in-scope', simMs: 9000, kind: 'outage_triggered', severity: 'critical', message: 'az killed', affected: [azA.id] },
      { id: 'out-of-scope', simMs: 9000, kind: 'oom_kill', severity: 'critical', message: 'irrelevant', affected: ['nonexistent-server'] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000), events })
    render(<TimelineV2 regionId={region.id} />)
    const markers = screen.getAllByTestId('tl-marker')
    // in-scope kill marker exists with the 'kill' class glyph
    const killMarker = markers.find(m => m.getAttribute('data-cls') === 'kill')
    expect(killMarker).toBeDefined()
    expect(killMarker).toHaveTextContent('✕')
    expect(killMarker!.querySelector('.tl-tip')).toHaveTextContent('t=9s · az killed')
  })

  it('narration bar shows the assembled chain text and is absent with no events', () => {
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'kill', simMs: 12_000, kind: 'outage_triggered', severity: 'critical', message: 'az us-east-1a manually taken down', affected: [azA.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(20_000), events })
    const { rerender } = render(<TimelineV2 regionId={region.id} />)
    expect(screen.getByText(`What just happened: t=12s you killed ${azA.label}.`)).toBeInTheDocument()

    useSimulationStore.setState({ events: [] })
    rerender(<TimelineV2 regionId={region.id} />)
    expect(screen.queryByText(/What just happened/)).not.toBeInTheDocument()
  })

  it('draws a causality arrow overlay when the narrated chain crosses lanes', () => {
    const { region, azA, azB } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'kill', simMs: 1000, kind: 'outage_triggered', severity: 'critical', message: 'killed a', affected: [azA.id] },
      { id: 'hc', simMs: 2000, kind: 'health_check_failed', severity: 'warning', message: 'hc failed', affected: [azB.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(5000), events })
    render(<TimelineV2 regionId={region.id} />)
    expect(screen.getByTestId('causality-arrows')).toBeInTheDocument()
  })

  it('no causality arrow overlay when there is no narrated chain', () => {
    const { region } = seedTwoAzRegion()
    useSimulationStore.setState({ latestBatch: fakeBatch(5000), events: [] })
    render(<TimelineV2 regionId={region.id} />)
    expect(screen.queryByTestId('causality-arrows')).not.toBeInTheDocument()
  })

  it('staggers markers that land at the same simMs in the same lane instead of stacking dead-on', () => {
    // Verified live: a replica promotion can fire on the SAME tick as the manual kill that
    // triggered it — two markers at identical x would otherwise render as one indistinguishable
    // glyph with the later one eating every click.
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'kill', simMs: 5000, kind: 'outage_triggered', severity: 'critical', message: 'killed', affected: [azA.id] },
      { id: 'promote', simMs: 5000, kind: 'replica_promoted', severity: 'warning', message: 'promoted', affected: [azA.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(10_000), events })
    render(<TimelineV2 regionId={region.id} />)
    const markers = screen.getAllByTestId('tl-marker')
    const killTop = markers.find(m => m.getAttribute('data-cls') === 'kill')!.style.top
    const promoteTop = markers.find(m => m.getAttribute('data-cls') === 'promote')!.style.top
    expect(killTop).not.toBe(promoteTop)
  })

  // ── axis-origin position assertions (fix for the pre-fix bug where the view's pct-scale
  // origin was clamped to the SAME `max(0, endMs - TIMELINE_WINDOW_MS)` as buildLanes' frame-
  // filtering window start — for any run younger than 120s that pinned "now" well short of the
  // right edge instead of at it). These assert real rendered `left` style, not a tautology, and
  // fail against the pre-fix clamped origin. ──────────────────────────────────────────────────

  it('an event at simMs === endMs ("now") renders pinned to the right edge', () => {
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'now-event', simMs: 60_000, kind: 'outage_triggered', severity: 'critical', message: 'killed now', affected: [azA.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(60_000), events })
    render(<TimelineV2 regionId={region.id} />)
    const marker = screen.getByTestId('tl-marker')
    expect(marker.style.left).toBe('100%')
  })

  it('for a run younger than the 120s window, t=0 left-pads to the midpoint and "now" still pins to the right edge', () => {
    // endMs=60_000 is exactly half the 120s window, so with the correct UNCLAMPED origin
    // (endMs - TIMELINE_WINDOW_MS = -60_000) t=0 lands at exactly 50% and t=endMs at 100%.
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'at-zero', simMs: 0, kind: 'outage_triggered', severity: 'critical', message: 'killed at start', affected: [azA.id] },
      { id: 'at-now', simMs: 60_000, kind: 'replica_promoted', severity: 'info', message: 'promoted now', affected: [azA.id] },
    ]
    useSimulationStore.setState({ latestBatch: fakeBatch(60_000), events })
    render(<TimelineV2 regionId={region.id} />)
    const markers = screen.getAllByTestId('tl-marker')
    const zeroMarker = markers.find(m => m.getAttribute('data-cls') === 'kill')!
    const nowMarker = markers.find(m => m.getAttribute('data-cls') === 'promote')!
    expect(zeroMarker.style.left).toBe('50%')
    expect(nowMarker.style.left).toBe('100%')
  })

  it('renders the legend and time axis', () => {
    const { region } = seedTwoAzRegion()
    useSimulationStore.setState({ latestBatch: fakeBatch(5000) })
    render(<TimelineV2 regionId={region.id} />)
    expect(screen.getByText('manual kill')).toBeInTheDocument()
    expect(screen.getByText('health detection')).toBeInTheDocument()
    expect(screen.getByText('traffic shift')).toBeInTheDocument()
    expect(screen.getByText('promotion')).toBeInTheDocument()
    expect(screen.getByText(/band color = the AZ's state/)).toBeInTheDocument()
    expect(screen.getByText('t=0')).toBeInTheDocument()
    expect(screen.getByText('now')).toBeInTheDocument()
  })

  // ── migrated from TimelineStrip.test.tsx (still-applicable behavior, D8 guarantee 3) ──────

  it('click while stopped scrubs to nearest frame (carried from TimelineStrip)', () => {
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'e1', simMs: 5200, kind: 'failover_started', severity: 'warning', message: 'failing over', affected: [azA.id] },
    ]
    const frames: ReplayFrame[] = [1000, 5000, 9000].map(simMs => frame(simMs))
    const setScrubIndexSpy = vi.fn()
    useSimulationStore.setState({
      running: false, latestBatch: fakeBatch(10_000), events,
      getReplayFrames: () => frames, setScrubIndex: setScrubIndexSpy,
    })
    render(<TimelineV2 regionId={region.id} />)
    const marker = screen.getAllByTestId('tl-marker').find(m => m.getAttribute('data-cls') === 'shift')!
    fireEvent.click(marker)
    // Frame simMs=5000 is nearest to event simMs=5200; the frames snapshot rides along so the
    // store resolves the batch from the SAME array the bands were drawn from (audit ISSUE-052/057).
    expect(setScrubIndexSpy).toHaveBeenCalledWith(1, frames)
  })

  it('clicks inert while running, with the running-disabled title (carried from TimelineStrip)', () => {
    const { region, azA } = seedTwoAzRegion()
    const events: EngineEvent[] = [
      { id: 'e1', simMs: 5200, kind: 'failover_started', severity: 'warning', message: 'failing over', affected: [azA.id] },
    ]
    const setScrubIndexSpy = vi.fn()
    useSimulationStore.setState({ running: true, latestBatch: fakeBatch(10_000), events, setScrubIndex: setScrubIndexSpy })
    render(<TimelineV2 regionId={region.id} />)
    const marker = screen.getByTitle('stop the simulation to scrub to this event')
    expect(marker).toBeDisabled()
    fireEvent.click(marker)
    expect(setScrubIndexSpy).not.toHaveBeenCalled()
  })
})
