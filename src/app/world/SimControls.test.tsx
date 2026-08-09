// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'
import { useBaselineStore } from '../store/baseline.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false, paused: false, timeScale: 1, latestBatch: null })
  useBaselineStore.setState({ summaries: [], compareA: null, compareB: null })
})

describe('SimControls', () => {
  it('calls start with the current doc + compiled world when clicking Simulate', () => {
    const startSpy = vi.spyOn(useSimulationStore.getState(), 'start').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.click(screen.getByText('Simulate'))
    expect(startSpy).toHaveBeenCalledTimes(1)
    const [doc, compiled] = startSpy.mock.calls[0]
    expect(doc).toBe(useWorldStore.getState().doc)
    expect(compiled.instances).toEqual({})   // fresh world → compileWorld returns no instances
  })

  it('while live, shows Pause + End; Pause calls pause(), End calls stop()', () => {
    useSimulationStore.setState({ running: true, paused: false })
    const pauseSpy = vi.spyOn(useSimulationStore.getState(), 'pause').mockImplementation(() => {})
    const stopSpy = vi.spyOn(useSimulationStore.getState(), 'stop').mockImplementation(() => {})
    render(<SimControls />)
    expect(screen.queryByText('Simulate')).toBeNull()
    fireEvent.click(screen.getByText('Pause'))
    expect(pauseSpy).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('End'))
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('while paused, shows Resume + End; Resume calls resume()', () => {
    useSimulationStore.setState({ running: true, paused: true })
    const resumeSpy = vi.spyOn(useSimulationStore.getState(), 'resume').mockImplementation(() => {})
    render(<SimControls />)
    expect(screen.queryByText('Pause')).toBeNull()
    fireEvent.click(screen.getByText('Resume'))
    expect(resumeSpy).toHaveBeenCalledTimes(1)
    expect(screen.getByText('End')).toBeInTheDocument()
  })

  it('changes timeScale via the select while running', () => {
    useSimulationStore.setState({ running: true })
    const setTimeScaleSpy = vi.spyOn(useSimulationStore.getState(), 'setTimeScale').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.change(screen.getByLabelText('time-scale'), { target: { value: '4' } })
    expect(setTimeScaleSpy).toHaveBeenCalledWith(4)
  })

  it('keeps the timeScale select usable while stopped (start() re-applies the selection)', () => {
    const setTimeScaleSpy = vi.spyOn(useSimulationStore.getState(), 'setTimeScale').mockImplementation(() => {})
    render(<SimControls />)
    const select = screen.getByLabelText('time-scale')
    expect(select).not.toBeDisabled()
    fireEvent.change(select, { target: { value: '2' } })
    expect(setTimeScaleSpy).toHaveBeenCalledWith(2)
  })

  it('shows the degraded chip when the store flag is set', () => {
    useSimulationStore.setState({ running: true, degraded: true })
    render(<SimControls />)
    expect(screen.getByText('degraded tick')).toBeInTheDocument()
  })

  it('shows the warm-up chip while warmupBatchesRemaining is positive, then hides it (audit ISSUE-019)', () => {
    useSimulationStore.setState({ running: true, warmupBatchesRemaining: 5 })
    const { rerender } = render(<SimControls />)
    expect(screen.getByText('warming up (5s)')).toBeInTheDocument()
    useSimulationStore.setState({ warmupBatchesRemaining: 0 })
    rerender(<SimControls />)
    expect(screen.queryByText(/warming up/)).toBeNull()
  })

  it('does not show the warm-up chip while stopped, even with a stale nonzero count', () => {
    useSimulationStore.setState({ running: false, warmupBatchesRemaining: 5 })
    render(<SimControls />)
    expect(screen.queryByText(/warming up/)).toBeNull()
  })

  describe('Capture baseline', () => {
    it('is disabled with no replay frames yet', () => {
      render(<SimControls />)
      const btn = screen.getByRole('button', { name: /capture baseline/i })
      expect(btn).toBeDisabled()
    })

    it('becomes enabled once a batch has landed (frames available), and captures a RunSummary from the current replay buffer on click', () => {
      const fakeFrames = [{ simMs: 1000, batch: {}, events: [] }] as never
      const framesSpy = vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(fakeFrames)
      const captureSpy = vi.spyOn(useBaselineStore.getState(), 'capture').mockImplementation(() => {})

      const { rerender } = render(<SimControls />)
      let btn = screen.getByRole('button', { name: /capture baseline/i })
      expect(btn).toBeDisabled()

      // A landed metrics batch is the reactive signal the button uses to know frames exist.
      useSimulationStore.setState({ latestBatch: { simMs: 1000 } as never })
      rerender(<SimControls />)
      btn = screen.getByRole('button', { name: /capture baseline/i })
      expect(btn).not.toBeDisabled()

      fireEvent.click(btn)
      expect(captureSpy).toHaveBeenCalledTimes(1)
      const [frames, doc, compiled, label] = captureSpy.mock.calls[0]
      expect(frames).toBe(fakeFrames)
      expect(doc).toBe(useWorldStore.getState().doc)
      expect(compiled.instances).toEqual({})
      expect(label).toMatch(/^Run /)
      expect(framesSpy).toHaveBeenCalled()
    })
  })

  // FEAT-003 Task 20: "running a scenario" IS running the engine — start() already applies
  // doc.scenario's steps once the engine sees it, so there is no separate run-scenario action to
  // test here, only the label/progress readout that tells the user what Simulate will do.
  describe('Scenario integration', () => {
    it('shows a run-scenario control (relabeled Simulate button) only when doc.scenario exists', () => {
      const { rerender } = render(<SimControls />)
      expect(screen.getByText('Simulate')).toBeInTheDocument()
      expect(screen.queryByText('Run scenario')).toBeNull()

      useWorldStore.getState().setScenario({ id: 's1', label: 'Test scenario', seed: 1, durationMs: 60000, steps: [] })
      rerender(<SimControls />)
      expect(screen.queryByText('Simulate')).toBeNull()
      expect(screen.getByText('Run scenario')).toBeInTheDocument()
    })

    it('shows the scenario progress chip only while running with a scenario present', () => {
      useWorldStore.getState().setScenario({ id: 's1', label: 'Test scenario', seed: 1, durationMs: 60000, steps: [] })
      const { rerender } = render(<SimControls />)
      expect(screen.queryByTestId('scenario-progress-chip')).toBeNull()

      useSimulationStore.setState({ running: true, latestBatch: { simMs: 30000 } as never })
      rerender(<SimControls />)
      expect(screen.getByTestId('scenario-progress-chip')).toHaveTextContent('50%')
    })
  })
})
