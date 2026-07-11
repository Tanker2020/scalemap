// Regression: the engine's start() always begins at 1x, so the store must re-apply its
// timeScale selection after every start — without this, picking 2x, stopping, and simulating
// again left the select claiming 2x while the engine ran realtime (user report 2026-07-10).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSimulationStore } from './simulation.store'
import { worldEngine } from '../../lib/worldEngine'
import { createWorld } from '../../lib/world/factories'
import { compileWorld } from '../../lib/world/compileWorld'

describe('simulation.store timeScale', () => {
  beforeEach(() => {
    vi.spyOn(worldEngine, 'start').mockImplementation(() => {})
    vi.spyOn(worldEngine, 'stop').mockImplementation(() => {})
  })
  afterEach(() => {
    useSimulationStore.getState().resetSession()
    useSimulationStore.setState({ timeScale: 1 })
    vi.restoreAllMocks()
  })

  it('re-applies the stored timeScale to the engine on start', () => {
    const scaleSpy = vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
    useSimulationStore.setState({ timeScale: 2 })
    const doc = createWorld()
    useSimulationStore.getState().start(doc, compileWorld(doc))
    expect(scaleSpy).toHaveBeenCalledWith(2)
  })

  it('setTimeScale updates both the engine and the store while stopped', () => {
    const scaleSpy = vi.spyOn(worldEngine, 'setTimeScale').mockImplementation(() => {})
    useSimulationStore.getState().setTimeScale(4)
    expect(scaleSpy).toHaveBeenCalledWith(4)
    expect(useSimulationStore.getState().timeScale).toBe(4)
  })
})
