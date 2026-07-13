// @vitest-environment jsdom
// The Events tab's history browser (2026-07-12): runs newest-first from the durable event log,
// expandable to paged events, plus a two-step clear-all that follows the edit-lock convention.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EventHistory } from './EventHistory'
import { useSimulationStore } from '../store/simulation.store'
import { eventLogRuns, eventLogTail, eventLogClear } from '../../lib/tauri'

vi.mock('../../lib/tauri', () => ({
  eventLogBeginRun: vi.fn(async () => 1),
  eventLogAppend: vi.fn(async () => 0),
  eventLogTail: vi.fn(async () => []),
  eventLogRuns: vi.fn(async () => []),
  eventLogClear: vi.fn(async () => {}),
}))

const row = (seq: number) => ({
  seq, id: `e${seq}`, simMs: seq * 100, kind: 'oom_kill', severity: 'critical',
  message: `boom ${seq}`, affected: [],
})

beforeEach(() => {
  vi.mocked(eventLogRuns).mockClear()
  vi.mocked(eventLogTail).mockClear()
  vi.mocked(eventLogClear).mockClear()
  useSimulationStore.setState({ running: false, eventLogTotal: 0 })
  vi.mocked(eventLogRuns).mockResolvedValue([
    { id: 2, startedAt: '2026-07-12T09:00:00Z', worldName: 'multi-region', events: 3 },
    { id: 1, startedAt: '2026-07-12T08:00:00Z', worldName: 'three-tier', events: 1 },
  ])
})

describe('EventHistory', () => {
  it('expanding lists the recorded runs newest-first with counts', async () => {
    render(<EventHistory />)
    fireEvent.click(screen.getByTestId('event-history-toggle'))
    await waitFor(() => expect(screen.getByTestId('event-history-run-2')).toBeInTheDocument())
    expect(screen.getByTestId('event-history-run-2').textContent).toContain('multi-region')
    expect(screen.getByTestId('event-history-run-2').textContent).toContain('3 events')
    expect(screen.getByTestId('event-history-run-1').textContent).toContain('1 event')
  })

  it('opening a run tails its events from the log', async () => {
    vi.mocked(eventLogTail).mockResolvedValue([row(3), row(2), row(1)])
    render(<EventHistory />)
    fireEvent.click(screen.getByTestId('event-history-toggle'))
    await waitFor(() => screen.getByTestId('event-history-run-2'))
    fireEvent.click(screen.getByTestId('event-history-run-2'))
    await waitFor(() => expect(screen.getByText('boom 3')).toBeInTheDocument())
    expect(vi.mocked(eventLogTail)).toHaveBeenCalledWith(2, null, 50)
    // fewer rows than a page means the run is exhausted — no "older events" button
    expect(screen.queryByText(/older events/)).toBeNull()
  })

  it('clear requires a second confirming click, then wipes and resets the live total', async () => {
    useSimulationStore.setState({ eventLogTotal: 42 })
    render(<EventHistory />)
    fireEvent.click(screen.getByTestId('event-history-toggle'))
    await waitFor(() => screen.getByTestId('event-history-clear'))
    fireEvent.click(screen.getByTestId('event-history-clear'))
    expect(vi.mocked(eventLogClear)).not.toHaveBeenCalled()
    expect(screen.getByTestId('event-history-clear').textContent).toContain('click again')
    fireEvent.click(screen.getByTestId('event-history-clear'))
    await waitFor(() => expect(vi.mocked(eventLogClear)).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useSimulationStore.getState().eventLogTotal).toBe(0))
  })

  it('clear is disabled while the simulation runs (edit-lock convention)', async () => {
    useSimulationStore.setState({ running: true })
    render(<EventHistory />)
    fireEvent.click(screen.getByTestId('event-history-toggle'))
    await waitFor(() => screen.getByTestId('event-history-clear'))
    const btn = screen.getByTestId('event-history-clear')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'stop the simulation to edit')
  })
})
