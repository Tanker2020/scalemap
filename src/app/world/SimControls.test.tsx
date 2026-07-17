// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false, paused: false, timeScale: 1 })
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
})
