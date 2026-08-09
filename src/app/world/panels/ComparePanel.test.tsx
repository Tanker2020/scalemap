// @vitest-environment jsdom
// Wave 5 FEAT-011 Task 6: two-column baseline comparison. Validity banner fires whenever the two
// selected RunSummary captures aren't a sound comparison (different scenario/seed); direction-aware
// deltas color lower-is-better metrics (latency, cost) so a "worse" run reads red regardless of
// whether the raw number went up or down.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ComparePanel } from './ComparePanel'
import { useBaselineStore } from '../../store/baseline.store'
import type { RunSummary } from '../../../lib/runSummary'

function runSummaryFixture(partial: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    label: 'Run 1',
    capturedIso: '2026-08-09T00:00:00.000Z',
    scenarioId: 's1',
    seed: 1,
    docFingerprint: 'fp1',
    durationMs: 60000,
    latency: { p50Ms: 10, p90Ms: 18, p99Ms: 40 },
    errorRate: 0.001,
    peakRps: 100,
    cost: { meanHourlyUsd: 5, totalUsd: 5, peakHourlyUsd: 6 },
    slo: { target: {}, breaches: [] },
    eventCounts: {},
    ...partial,
  }
}

beforeEach(() => {
  useBaselineStore.setState({ summaries: [], compareA: null, compareB: null })
})

describe('ComparePanel', () => {
  it('shows a validity warning when scenarioId or seed differ, none when they match', () => {
    useBaselineStore.setState({
      summaries: [
        runSummaryFixture({ id: 'a', scenarioId: 's1', seed: 1, docFingerprint: 'fp1' }),
        runSummaryFixture({ id: 'b', scenarioId: 's2', seed: 1, docFingerprint: 'fp2' }),
      ],
      compareA: 'a', compareB: 'b',
    })
    const { unmount } = render(<ComparePanel />)
    expect(screen.getByText(/differ/i)).toBeInTheDocument()
    unmount()

    useBaselineStore.setState({
      summaries: [
        runSummaryFixture({ id: 'a', scenarioId: 's1', seed: 1, docFingerprint: 'fp1' }),
        runSummaryFixture({ id: 'b', scenarioId: 's1', seed: 1, docFingerprint: 'fp2' }),
      ],
      compareA: 'a', compareB: 'b',
    })
    render(<ComparePanel />)
    expect(screen.queryByText(/differ/i)).not.toBeInTheDocument()
  })

  it('renders direction-aware deltas: lower latency is good, lower cost is good', () => {
    useBaselineStore.setState({
      summaries: [
        runSummaryFixture({ id: 'a', latency: { p50Ms: 10, p90Ms: 20, p99Ms: 100 }, cost: { meanHourlyUsd: 5, totalUsd: 100, peakHourlyUsd: 8 } }),
        runSummaryFixture({ id: 'b', latency: { p50Ms: 10, p90Ms: 20, p99Ms: 62 }, cost: { meanHourlyUsd: 6.1, totalUsd: 120, peakHourlyUsd: 9 } }),
      ],
      compareA: 'a', compareB: 'b',
    })
    render(<ComparePanel />)
    expect(screen.getByText(/p99.*(-38|down 38|−38)/i)).toBeInTheDocument()
    expect(screen.getByText(/cost.*(\+22|up 22)/i)).toBeInTheDocument()
  })
})
