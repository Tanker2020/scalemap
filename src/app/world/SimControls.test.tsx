// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false, timeScale: 1 })
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

  it('shows Stop and calls stop() when running', () => {
    useSimulationStore.setState({ running: true })
    const stopSpy = vi.spyOn(useSimulationStore.getState(), 'stop').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.click(screen.getByText('Stop'))
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('changes timeScale via the select while running', () => {
    useSimulationStore.setState({ running: true })
    const setTimeScaleSpy = vi.spyOn(useSimulationStore.getState(), 'setTimeScale').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.change(screen.getByLabelText('time-scale'), { target: { value: '4' } })
    expect(setTimeScaleSpy).toHaveBeenCalledWith(4)
  })

  it('disables the timeScale select while stopped', () => {
    render(<SimControls />)
    expect(screen.getByLabelText('time-scale')).toBeDisabled()
  })
})
