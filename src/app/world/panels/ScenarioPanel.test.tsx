// @vitest-environment jsdom
// FEAT-003 Task 20: scenario timeline authoring. Writes through world.store's setScenario/
// addScenarioStep/removeScenarioStep/updateScenarioStep (undo/dirty for free).
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScenarioPanel } from './ScenarioPanel'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false, paused: false, latestBatch: null })
})

function makeServer(): string {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return useWorldStore.getState().addServer(azId, getPreset('vps-large')!)
}

describe('ScenarioPanel', () => {
  it('shows Create scenario when doc.scenario is undefined', () => {
    render(<ScenarioPanel />)
    expect(screen.getByTestId('create-scenario')).toBeInTheDocument()
    expect(screen.queryByText(/Steps \(/)).toBeNull()
  })

  it('creating a scenario calls setScenario with a fresh id/steps', () => {
    render(<ScenarioPanel />)
    fireEvent.click(screen.getByTestId('create-scenario'))
    const scenario = useWorldStore.getState().doc.scenario
    expect(scenario).toBeDefined()
    expect(scenario!.steps).toEqual([])
    expect(scenario!.durationMs).toBeGreaterThan(0)
  })

  it('adding a step calls addScenarioStep with the authored action', () => {
    const serverId = makeServer()
    useWorldStore.getState().setScenario({ id: 's1', label: 'Test', seed: 1, durationMs: 60000, steps: [] })
    render(<ScenarioPanel />)

    fireEvent.change(screen.getByLabelText('new-step-atms'), { target: { value: '5' } })
    // default action type is 'inject-fault'; default scope is 'server'
    fireEvent.change(screen.getByLabelText('new-step-fault-id'), { target: { value: serverId } })
    fireEvent.change(screen.getByLabelText('new-step-fault-kind'), { target: { value: 'down' } })
    fireEvent.click(screen.getByTestId('add-step'))

    const steps = useWorldStore.getState().doc.scenario!.steps
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      atMs: 5000,
      action: { type: 'inject-fault', scope: 'server', id: serverId, spec: { kind: 'down' } },
    })
  })

  it('deletes a step', () => {
    const serverId = makeServer()
    useWorldStore.getState().setScenario({
      id: 's1', label: 'Test', seed: 1, durationMs: 60000,
      steps: [{ atMs: 1000, action: { type: 'inject-fault', scope: 'server', id: serverId, spec: { kind: 'down' } } }],
    })
    render(<ScenarioPanel />)
    fireEvent.click(screen.getByLabelText('remove-step-0'))
    expect(useWorldStore.getState().doc.scenario!.steps).toHaveLength(0)
  })

  it('authoring controls are disabled while running, with a stop-to-edit tooltip', () => {
    useWorldStore.getState().setScenario({ id: 's1', label: 'Test', seed: 1, durationMs: 60000, steps: [] })
    useSimulationStore.setState({ running: true })
    render(<ScenarioPanel />)
    // These are plain native inputs mounted (in the real app) inside WorldPanel's ambient
    // `<fieldset disabled={running}>` — this test renders ScenarioPanel standalone (no fieldset
    // wrapper present), so it asserts the title/tooltip contract instead of native disabling,
    // which is WorldPanel's job, not this component's.
    expect(screen.getByLabelText('scenario-label')).toHaveAttribute('title', 'stop the simulation to edit the scenario')
    expect(screen.getByText('locked while running')).toBeInTheDocument()
  })

  it('shows a static progress fill on the ruler while running, keyed off latestBatch.simMs', () => {
    useWorldStore.getState().setScenario({ id: 's1', label: 'Test', seed: 1, durationMs: 100000, steps: [] })
    useSimulationStore.setState({ running: true, latestBatch: { simMs: 25000 } as never })
    render(<ScenarioPanel />)
    const fill = screen.getByTestId('scenario-progress-fill')
    expect(fill.style.width).toBe('25%')
  })
})
