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

beforeEach(() => useSimulationStore.setState({ running: false, latestBatch: null, scrubIndex: null, scrubBatch: null }))

describe('ScrubberV2 session gate', () => {
  it('shown after a normal stop (frames + latestBatch)', () => {
    useSimulationStore.setState({ latestBatch: batch(1000), getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.getByLabelText('replay-scrubber')).toBeInTheDocument()
  })
  it('hidden after a doc swap even when the engine still holds frames', () => {
    useSimulationStore.setState({ latestBatch: null, getReplayFrames: () => frames })
    render(<ScrubberV2 />)
    expect(screen.queryByLabelText('replay-scrubber')).not.toBeInTheDocument()
  })
})
