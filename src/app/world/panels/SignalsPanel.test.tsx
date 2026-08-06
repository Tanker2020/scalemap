// src/app/world/panels/SignalsPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SignalsPanel } from './SignalsPanel'
import { useSimulationStore } from '../../store/simulation.store'
import * as signalsSeries from './signalsSeries'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../../../lib/worldEngine/types'

function emptyWorldMetrics(over: Partial<MetricsBatch['world']> = {}): MetricsBatch['world'] {
  return {
    totalRps: 0, errorRate: 0, populationRoutes: [],
    crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
    ...over,
  }
}

function fakeBatch(simMs: number, world: Partial<MetricsBatch['world']> = {}): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs: {}, regions: {}, world: emptyWorldMetrics(world) }
}

function fakeEvent(simMs: number, id: string): EngineEvent {
  return { id, simMs, kind: 'failover_started', severity: 'info', message: 'test event', affected: [] }
}

function frame(simMs: number, rps: number, events: EngineEvent[] = []): ReplayFrame {
  return { simMs, events, batch: fakeBatch(simMs, { totalRps: rps, errorRate: 0.01 }) }
}

function twoFrameFixture(): ReplayFrame[] {
  return [frame(1000, 10, [fakeEvent(1000, 'e1')]), frame(2000, 20)]
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SignalsPanel', () => {
  it('renders an empty-state message (not 8 empty charts) with no frames', () => {
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue([])
    render(<SignalsPanel scope={{ kind: 'world' }} />)
    expect(screen.getByText(/no history yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/^rps$/i)).not.toBeInTheDocument()
  })

  it('renders all 8 signal rows when frames exist', () => {
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(twoFrameFixture())
    render(<SignalsPanel scope={{ kind: 'world' }} />)
    for (const label of ['rps', 'error rate', 'p50 ms', 'p90 ms', 'p99 ms', 'connections', 'cpu', 'ram mb']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('does not recompute series on a re-render with unchanged frames/scope', () => {
    const frames = twoFrameFixture()
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
    const extractSpy = vi.spyOn(signalsSeries, 'extractSeries')
    const { rerender } = render(<SignalsPanel scope={{ kind: 'world' }} />)
    const callsAfterMount = extractSpy.mock.calls.length
    expect(callsAfterMount).toBeGreaterThan(0)
    rerender(<SignalsPanel scope={{ kind: 'world' }} />)
    expect(extractSpy.mock.calls.length).toBe(callsAfterMount)
  })

  it('recomputes series when frames grow (a genuinely new frame arrives)', () => {
    const frames = twoFrameFixture()
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
    const extractSpy = vi.spyOn(signalsSeries, 'extractSeries')
    const { rerender } = render(<SignalsPanel scope={{ kind: 'world' }} />)
    const callsAfterMount = extractSpy.mock.calls.length
    const grown = [...frames, frame(3000, 30)]
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(grown)
    rerender(<SignalsPanel scope={{ kind: 'world' }} />)
    expect(extractSpy.mock.calls.length).toBeGreaterThan(callsAfterMount)
  })

  it('does not throw "Maximum update depth exceeded" when getReplayFrames returns a FRESH array reference on every call', () => {
    // Regression test for the production-crashing bug found via CostTab/Task 9: mockReturnValue
    // (used by every other test in this file) happens to return the SAME array reference every
    // call, which masks a reactive `useSimulationStore(s => s.getReplayFrames())` subscription
    // bug entirely. The real engine's getReplayFrames() always allocates a fresh array
    // (`[...frames]`/a bare `[]`), so the mock here must do the same to actually exercise the
    // hazard the component guards against (a non-reactive `getState()` read).
    const frames = twoFrameFixture()
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockImplementation(() => [...frames])
    expect(() => render(<SignalsPanel scope={{ kind: 'world' }} />)).not.toThrow()
    expect(screen.getByText('rps')).toBeInTheDocument()
  })

  it('does not throw against the REAL (unmocked) store, with no run active', () => {
    // The exact empirical probe that surfaced the bug: render against worldEngine's real
    // getReplayFrames() (no spy/mock at all). Before the fix, this threw "Maximum update depth
    // exceeded" immediately on mount because the reactive selector subscribed directly to a
    // call that reallocates its return value every single time, even the bare `[]` returned
    // before any simulation run has started.
    expect(() => render(<SignalsPanel scope={{ kind: 'world' }} />)).not.toThrow()
    expect(screen.getByText(/no history yet/i)).toBeInTheDocument()
  })

  it('clicking a chart calls setScrubIndex with the frame index nearest the click', () => {
    const frames = twoFrameFixture()
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
    const setScrubIndex = vi.fn()
    vi.spyOn(useSimulationStore.getState(), 'setScrubIndex').mockImplementation(setScrubIndex)
    render(<SignalsPanel scope={{ kind: 'world' }} />)
    const charts = screen.getAllByRole('img', { name: /signal chart/i })
    expect(charts.length).toBeGreaterThan(0)
    const chart = charts[0]
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 300, width: 300, top: 0, bottom: 36, height: 36, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    // Click near the right edge -- nearest to the second (later) frame, index 1.
    fireEvent.click(chart, { clientX: 299 })
    expect(setScrubIndex).toHaveBeenCalledTimes(1)
    expect(setScrubIndex).toHaveBeenCalledWith(1, frames)
  })
})
