// @vitest-environment jsdom
// FEAT-001 Task 8: component smoke test for the shared ChaosControl split button. Covers the
// three behaviors the brief calls out — disabled+tooltip while stopped, primary click applies a
// `down` fault, and the `▾` menu's numeric-parameter rows apply the typed FaultSpec.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChaosControl } from './ChaosControl'
import { useSimulationStore } from '../../store/simulation.store'

beforeEach(() => {
  useSimulationStore.getState().resetSession()
})

describe('ChaosControl', () => {
  it('disables both buttons when not running, with the standardized tooltip', () => {
    render(<ChaosControl scope="server" id="s1" running={false} />)
    const kill = screen.getByRole('button', { name: /kill/i })
    expect(kill).toBeDisabled()
    expect(kill).toHaveAttribute('title', 'start the simulation to break things')
    const menuToggle = screen.getByRole('button', { name: /more fault options/i })
    expect(menuToggle).toBeDisabled()
    expect(menuToggle).toHaveAttribute('title', 'start the simulation to break things')
  })

  it('primary click applies a down fault when running', () => {
    render(<ChaosControl scope="server" id="s1" running />)
    fireEvent.click(screen.getByRole('button', { name: /kill/i }))
    expect(useSimulationStore.getState().activeFaults.s1).toEqual({ kind: 'down' })
    expect(useSimulationStore.getState().healthOverrides.s1).toBe(true)
  })

  it('primary click clears an active fault (down or otherwise)', () => {
    render(<ChaosControl scope="server" id="s1" running />)
    fireEvent.click(screen.getByRole('button', { name: /kill/i }))
    expect(useSimulationStore.getState().activeFaults.s1).toEqual({ kind: 'down' })
    fireEvent.click(screen.getByRole('button', { name: '↺ restore' }))
    expect(useSimulationStore.getState().activeFaults.s1 ?? null).toBeNull()
  })

  it('menu apply sends the typed FaultSpec (cpu-brownout)', () => {
    render(<ChaosControl scope="server" id="s1" running />)
    fireEvent.click(screen.getByRole('button', { name: /more fault options/i }))
    const row = screen.getByTestId('chaos-menu-row-cpu-brownout')
    const input = row.querySelector('input')!
    fireEvent.change(input, { target: { value: '0.3' } })
    fireEvent.blur(input)
    fireEvent.click(row.querySelector('button')!)
    expect(useSimulationStore.getState().activeFaults.s1).toEqual({ kind: 'cpu-brownout', capacityFraction: 0.3 })
  })

  it('menu is not rendered while stopped even if toggled', () => {
    render(<ChaosControl scope="server" id="s1" running={false} />)
    fireEvent.click(screen.getByRole('button', { name: /more fault options/i }))
    expect(screen.queryByTestId('chaos-menu')).toBeNull()
  })

  it('an active non-down fault renders the amber-tone "clear" primary label', () => {
    useSimulationStore.getState().setFault('server', 's1', { kind: 'latency-add', ms: 500 })
    render(<ChaosControl scope="server" id="s1" running />)
    expect(screen.getByRole('button', { name: '✕ clear' })).toBeInTheDocument()
  })

  it('sets a friendly aria-label only when a `label` prop is supplied', () => {
    const { rerender } = render(<ChaosControl scope="az" id="az1" running={false} />)
    expect(screen.getByRole('button', { name: /kill/i })).not.toHaveAttribute('aria-label')

    rerender(<ChaosControl scope="az" id="az1" running={false} label="us-east-1a" />)
    expect(screen.getByLabelText('Simulate outage for us-east-1a')).toBeInTheDocument()
  })
})
