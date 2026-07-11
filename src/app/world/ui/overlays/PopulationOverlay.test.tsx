// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PopulationOverlay } from './PopulationOverlay'
import { useWorldStore } from '../../../store/world.store'
import { useUiStore } from '../../../store/ui.store'
import { createWorld, createRegion, createPopulation } from '../../../../lib/world/factories'

function seedPop() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); doc.regions[r.id] = r
  const pop = createPopulation('São Paulo', -23.55, -46.63); doc.populations[pop.id] = pop
  useWorldStore.setState({ doc, history: [], future: [] })
  return { popId: pop.id }
}

afterEach(() => vi.clearAllMocks())

describe('PopulationOverlay', () => {
  it('slider commit dispatches updatePopulation with peakRps on release only', () => {
    const { popId } = seedPop()
    const spy = vi.spyOn(useWorldStore.getState(), 'updatePopulation')
    render(<PopulationOverlay populationId={popId} onClose={() => {}} />)
    const slider = screen.getByLabelText('demand')
    fireEvent.change(slider, { target: { value: '1600' } })
    expect(spy).not.toHaveBeenCalled()                                  // drag = draft only
    fireEvent.mouseUp(slider)
    expect(spy).toHaveBeenCalledWith(popId, { peakRps: 1600 })          // exact TrafficPanel patch
  })

  it('renders the landing hint from the compiled routing table', () => {
    const { popId } = seedPop()
    render(<PopulationOverlay populationId={popId} onClose={() => {}} />)
    expect(screen.getByText('→ lands on us-east-1 · 77 ms away')).toBeInTheDocument()
  })

  it('falls back to the policy wording when no route resolves', () => {
    const doc = createWorld()
    const pop = createPopulation('nowhere', 0, 0); doc.populations[pop.id] = pop
    useWorldStore.setState({ doc, history: [], future: [] })
    render(<PopulationOverlay populationId={pop.id} onClose={() => {}} />)
    expect(screen.getByText('routed by latency')).toBeInTheDocument()
  })

  it('remove dispatches removePopulation and closes', () => {
    const { popId } = seedPop()
    const onClose = vi.fn()
    render(<PopulationOverlay populationId={popId} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'remove' }))
    expect(useWorldStore.getState().doc.populations[popId]).toBeUndefined()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traffic panel → queues the tab and closes', () => {
    const { popId } = seedPop()
    useUiStore.setState({ pendingPanelTab: null })
    const onClose = vi.fn()
    render(<PopulationOverlay populationId={popId} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'traffic panel →' }))
    expect(useUiStore.getState().pendingPanelTab).toBe('traffic')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
