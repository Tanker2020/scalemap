// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RegionOverlay } from './RegionOverlay'
import { useWorldStore } from '../../../store/world.store'
import { useSimulationStore } from '../../../store/simulation.store'
import { useFileStore } from '../../../store/file.store'
import { useNavStore } from '../../../store/nav.store'
import { createWorld, createRegion, createAz, createServer } from '../../../../lib/world/factories'
import { getPreset } from '../../../../lib/world/instanceCatalog'

function seedRegion() {
  const doc = createWorld()
  const r = createRegion('us-east-1'); doc.regions[r.id] = r
  const az1 = createAz(r.id, 'us-east-1a'); doc.azs[az1.id] = az1
  const az2 = createAz(r.id, 'us-east-1b'); doc.azs[az2.id] = az2
  const s1 = createServer(az1.id, getPreset('vps-medium')!); doc.servers[s1.id] = s1   // $0.036/hr
  const s2 = createServer(az2.id, getPreset('vps-medium')!); doc.servers[s2.id] = s2
  useWorldStore.setState({ doc, history: [], future: [] })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null, healthOverrides: {} })
  return { regionId: r.id, serverIds: [s1.id, s2.id] }
}

afterEach(() => vi.clearAllMocks())

describe('RegionOverlay', () => {
  it('renders authored chips at rest and — for metrics', () => {
    const { regionId } = seedRegion()
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    expect(screen.getByText('2 AZs')).toBeInTheDocument()
    expect(screen.getByText('2 servers')).toBeInTheDocument()
    expect(screen.getByText('$0.07/hr')).toBeInTheDocument()          // 2 × 0.036 → toFixed(2)
    expect(screen.getByText('~— rps in')).toBeInTheDocument()         // metrics chips dashed at rest
    expect(screen.getByText('p50 — ms')).toBeInTheDocument()
  })

  it('the $/hr chip renders in the price color', () => {
    const { regionId } = seedRegion()
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    expect(screen.getByText('$0.07/hr')).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('role segmented dispatches the exact TopologyPanel role patch (no history push)', () => {
    const { regionId } = seedRegion()
    const historyBefore = useWorldStore.getState().history.length
    useFileStore.getState().setDirty(false)
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'passive' }))
    expect(useWorldStore.getState().doc.regions[regionId].role).toBe('passive')
    expect(useWorldStore.getState().history.length).toBe(historyBefore)   // deliberate no-history
    expect(useFileStore.getState().dirty).toBe(true)
  })

  it('kill is disabled while stopped and dispatches setFault("region", id, { kind: "down" }) while running', () => {
    const { regionId } = seedRegion()
    const spy = vi.spyOn(useSimulationStore.getState(), 'setFault')
    const { rerender } = render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    const kill = screen.getByRole('button', { name: /kill/ })
    expect(kill).toBeDisabled()
    expect(kill).toHaveAttribute('title', 'start the simulation to break things')

    useSimulationStore.setState({ running: true })
    rerender(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /kill/ }))
    expect(spy).toHaveBeenCalledWith('region', regionId, { kind: 'down' })
  })

  it('enter ⏎ navigates into the region', () => {
    const { regionId } = seedRegion()
    useNavStore.getState().goGlobe()
    render(<RegionOverlay regionId={regionId} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'enter ⏎' }))
    expect(useNavStore.getState().level).toBe('region')
    expect(useNavStore.getState().regionId).toBe(regionId)
  })
})
