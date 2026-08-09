// @vitest-environment jsdom
// Wave 5 FEAT-011 Task 6: two-column baseline comparison. Validity banner fires whenever the two
// selected RunSummary captures aren't a sound comparison (different scenario/seed); direction-aware
// deltas color lower-is-better metrics (latency, cost) so a "worse" run reads red regardless of
// whether the raw number went up or down.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ComparePanel } from './ComparePanel'
import { useBaselineStore } from '../../store/baseline.store'
import type { RunSummary } from '../../../lib/runSummary'
import { saveFileDialog, saveDiagram, openFileDialog, loadDiagram } from '../../../lib/tauri'

vi.mock('../../../lib/tauri', () => ({
  saveFileDialog: vi.fn(),
  saveDiagram: vi.fn(),
  openFileDialog: vi.fn(),
  loadDiagram: vi.fn(),
}))

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
  vi.mocked(saveFileDialog).mockReset()
  vi.mocked(saveDiagram).mockReset()
  vi.mocked(openFileDialog).mockReset()
  vi.mocked(loadDiagram).mockReset()
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

  it('colors a non-money row (p99 latency) success/danger by direction, but never recolors cost rows', () => {
    useBaselineStore.setState({
      summaries: [
        // p99 improves (100 -> 62, lower is better -> good/success). cost mean increases
        // (5 -> 6.1) and cost total DECREASES (100 -> 80) — opposite directions, both must
        // still render in var(--color-price), never success/danger.
        runSummaryFixture({ id: 'a', latency: { p50Ms: 10, p90Ms: 20, p99Ms: 100 }, cost: { meanHourlyUsd: 5, totalUsd: 100, peakHourlyUsd: 8 } }),
        runSummaryFixture({ id: 'b', latency: { p50Ms: 10, p90Ms: 20, p99Ms: 62 }, cost: { meanHourlyUsd: 6.1, totalUsd: 80, peakHourlyUsd: 9 } }),
      ],
      compareA: 'a', compareB: 'b',
    })
    render(<ComparePanel />)

    const p99Node = screen.getByText(/p99/i)
    expect(p99Node).toHaveStyle({ color: 'var(--color-success)' })

    const costMeanNode = screen.getByText(/cost mean/i) // increased ($5 -> $6.1)
    expect(costMeanNode).toHaveStyle({ color: 'var(--color-price)' })

    const costTotalNode = screen.getByText(/cost total/i) // decreased ($100 -> $80)
    expect(costTotalNode).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('Export calls saveFileDialog then saveDiagram with the store JSON; Import calls openFileDialog then loadDiagram and merges', async () => {
    vi.mocked(saveFileDialog).mockResolvedValue('/x/runs.json')
    vi.mocked(saveDiagram).mockResolvedValue(undefined)
    vi.mocked(openFileDialog).mockResolvedValue('/x/runs.json')
    vi.mocked(loadDiagram).mockResolvedValue(JSON.stringify({ summaries: [runSummaryFixture({ id: 'imported' })] }))
    useBaselineStore.setState({ summaries: [runSummaryFixture({ id: 'existing' })], compareA: null, compareB: null })
    render(<ComparePanel />)

    fireEvent.click(screen.getByRole('button', { name: /export/i }))
    await waitFor(() => expect(saveDiagram).toHaveBeenCalledWith('/x/runs.json', expect.stringContaining('existing')))

    fireEvent.click(screen.getByRole('button', { name: /import/i }))
    await waitFor(() => expect(useBaselineStore.getState().summaries.map(s => s.id)).toEqual(['existing', 'imported']))
  })

  it('Export no-ops when the save dialog is cancelled', async () => {
    vi.mocked(saveFileDialog).mockResolvedValue(null)
    useBaselineStore.setState({ summaries: [runSummaryFixture({ id: 'existing' })], compareA: null, compareB: null })
    render(<ComparePanel />)

    fireEvent.click(screen.getByRole('button', { name: /export/i }))
    await waitFor(() => expect(saveFileDialog).toHaveBeenCalled())
    expect(saveDiagram).not.toHaveBeenCalled()
  })

  it('Import no-ops when the open dialog is cancelled', async () => {
    vi.mocked(openFileDialog).mockResolvedValue(null)
    useBaselineStore.setState({ summaries: [runSummaryFixture({ id: 'existing' })], compareA: null, compareB: null })
    render(<ComparePanel />)

    fireEvent.click(screen.getByRole('button', { name: /import/i }))
    await waitFor(() => expect(openFileDialog).toHaveBeenCalled())
    expect(loadDiagram).not.toHaveBeenCalled()
    expect(useBaselineStore.getState().summaries.map(s => s.id)).toEqual(['existing'])
  })

  it('shows an error message when import fails to parse', async () => {
    vi.mocked(openFileDialog).mockResolvedValue('/x/bad.json')
    vi.mocked(loadDiagram).mockResolvedValue('not json')
    useBaselineStore.setState({ summaries: [], compareA: null, compareB: null })
    render(<ComparePanel />)

    fireEvent.click(screen.getByRole('button', { name: /import/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/import failed/i))
  })
})
