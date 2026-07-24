// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ScrubberV2 } from './ScrubberV2'
import { useSimulationStore } from '../store/simulation.store'
import type { ReplayFrame, MetricsBatch } from '../../lib/worldEngine/types'

const batch = (simMs: number): MetricsBatch => ({
  simMs, instances: {}, servers: {}, azs: {}, regions: {},
  world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
})
const frames: ReplayFrame[] = [{ simMs: 1000, batch: batch(1000), events: [] }]

beforeEach(() => useSimulationStore.setState({ running: false, paused: false, latestBatch: null, scrubIndex: null, scrubBatch: null }))

describe('ScrubberV2 session gate', () => {
  it('hidden after End / doc swap — a cleared latestBatch hides it even while the engine holds frames', () => {
    // End (stop) and New/Open (resetSession) both clear latestBatch (erase-on-end); scrubbing a
    // finished run is gone — it is now pause-only (see the PAUSED case below).
    useSimulationStore.setState({ running: false, paused: false, latestBatch: null, getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.queryByLabelText('replay-scrubber')).not.toBeInTheDocument()
  })
  it('hidden while live (running, not paused)', () => {
    useSimulationStore.setState({ running: true, paused: false, latestBatch: batch(1000), getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.queryByLabelText('replay-scrubber')).not.toBeInTheDocument()
  })
  it('shown while PAUSED — scrub-back is enabled without ending the run', () => {
    useSimulationStore.setState({ running: true, paused: true, latestBatch: batch(1000), getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.getByLabelText('replay-scrubber')).toBeInTheDocument()
  })
})
