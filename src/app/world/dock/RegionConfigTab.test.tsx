// @vitest-environment jsdom
// Polish 4 T2 (spec D4): region scope's Config tab — this region's AZ rows + a "+ az" button
// reusing TopologyPanel's exact `addAz` dispatch, edit-locked while running.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { RegionConfigTab } from './RegionConfigTab'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null, running: false })
})

describe('RegionConfigTab', () => {
  it('shows an empty state when the region has no AZs yet', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByTestId('region-config-tab')).toHaveTextContent(/no az/i)
  })

  it('lists one row per AZ in this region, with a singular-aware server count', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<RegionConfigTab regionId={regionId} />)
    const rows = screen.getAllByTestId('region-config-az-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('us-east-1a')
    expect(rows[0]).toHaveTextContent('1 server')
  })

  it('pluralizes server count correctly', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByTestId('region-config-az-row')).toHaveTextContent('2 servers')
  })

  it('only lists AZs belonging to THIS region, not sibling regions', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const otherRegionId = useWorldStore.getState().addRegion('eu-west-1')
    useWorldStore.getState().addAz(otherRegionId, 'eu-west-1a')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getAllByTestId('region-config-az-row')).toHaveLength(1)
  })

  it('shows live rps from the metrics batch when present, "—" at rest', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByTestId('region-config-az-row')).toHaveTextContent('—')

    const batch: MetricsBatch = {
      simMs: 1000, instances: {}, servers: {},
      azs: { [azId]: { azId, rps: 42, errorRate: 0, p50Ms: 5, p90Ms: 6, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0 } },
      regions: {},
      world: { totalRps: 42, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    }
    useSimulationStore.setState({ latestBatch: batch })
    render(<RegionConfigTab regionId={regionId} />)
    const rows = screen.getAllByTestId('region-config-az-row')
    expect(rows[rows.length - 1]).toHaveTextContent('42 rps')
  })

  it('clicking an AZ row dispatches goAz(regionId, azId)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(screen.getByTestId('region-config-az-row'))
    expect(useNavStore.getState().level).toBe('az')
    expect(useNavStore.getState().regionId).toBe(regionId)
    expect(useNavStore.getState().azId).toBe(azId)
  })

  it('"+ az" dispatches addAz with the same auto-suffixed label convention as TopologyPanel', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(screen.getByText('+ az'))
    const azs = Object.values(useWorldStore.getState().doc.azs)
    expect(azs).toHaveLength(1)
    expect(azs[0]).toMatchObject({ regionId, label: 'us-east-1a' })
  })

  it('"+ az" is edit-locked while running, with the standard tooltip', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useSimulationStore.setState({ running: true })
    render(<RegionConfigTab regionId={regionId} />)
    const btn = screen.getByText('+ az')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'stop the simulation to edit')
  })

  it('"+ az" is enabled with no tooltip when stopped', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    const btn = screen.getByText('+ az')
    expect(btn).not.toBeDisabled()
    expect(btn).not.toHaveAttribute('title')
  })

  it('"×" on an AZ row dispatches removeAz without triggering the row\'s own goAz navigation', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(screen.getByLabelText('remove us-east-1a'))
    expect(useWorldStore.getState().doc.azs[azId]).toBeUndefined()
    // Proves stopPropagation worked: goAz would have flipped nav to 'az' had the click bubbled.
    expect(useNavStore.getState().level).toBe('globe')
  })

  it('AZ row delete is edit-locked while running, with the standard tooltip', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useSimulationStore.setState({ running: true })
    render(<RegionConfigTab regionId={regionId} />)
    const btn = screen.getByLabelText('remove us-east-1a')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'stop the simulation to edit')
  })

  it('renders a load balancer section reflecting the effective default (cross-zone off)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    render(<RegionConfigTab regionId={regionId} />)
    const group = screen.getByRole('group', { name: 'cross-zone' })
    expect(within(group).getByText('off')).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByText('on')).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggling cross-zone on creates/updates the region load balancer', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'cross-zone' })).getByText('on'))
    const lb = Object.values(useWorldStore.getState().doc.loadBalancers).find(l => l.regionId === regionId)
    expect(lb).toBeDefined()
    expect(lb!.crossZone).toBe(true)
  })

  it('load balancer controls are edit-locked while the simulation runs', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    useSimulationStore.setState({ running: true })
    render(<RegionConfigTab regionId={regionId} />)
    expect(within(screen.getByRole('group', { name: 'cross-zone' })).getByText('on')).toBeDisabled()
  })

  it('defaults to L4 with no listener-rules editor; switching to L7 reveals it and sets mode', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    render(<RegionConfigTab regionId={regionId} />)
    expect(within(screen.getByRole('group', { name: 'lb-mode' })).getByText('NLB · L4')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('▸ LISTENER RULES')).toBeNull()

    fireEvent.click(within(screen.getByRole('group', { name: 'lb-mode' })).getByText('ALB · L7'))
    const lb = Object.values(useWorldStore.getState().doc.loadBalancers).find(l => l.regionId === regionId)
    expect(lb!.mode).toBe('l7')
    expect(screen.getByText('▸ LISTENER RULES')).toBeInTheDocument()
  })

  it('adds a listener rule mapping a path pattern to a blueprint', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    const bpId = useWorldStore.getState().addBlueprint('api')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'lb-mode' })).getByText('ALB · L7'))
    fireEvent.click(screen.getByText('+ rule'))
    const lb = Object.values(useWorldStore.getState().doc.loadBalancers).find(l => l.regionId === regionId)!
    expect(lb.listenerRules).toHaveLength(1)
    expect(lb.listenerRules[0]).toMatchObject({ pathPattern: '/*', targetBlueprintId: bpId })

    fireEvent.change(screen.getByLabelText('rule-pattern-0'), { target: { value: '/api/*' } })
    const after = Object.values(useWorldStore.getState().doc.loadBalancers).find(l => l.regionId === regionId)!
    expect(after.listenerRules[0].pathPattern).toBe('/api/*')
  })

  it('setting the default action patches defaultTargetBlueprintId', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    const bpId = useWorldStore.getState().addBlueprint('api')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'lb-mode' })).getByText('ALB · L7'))
    fireEvent.change(screen.getByLabelText('lb-default-target'), { target: { value: bpId } })
    const lb = Object.values(useWorldStore.getState().doc.loadBalancers).find(l => l.regionId === regionId)!
    expect(lb.defaultTargetBlueprintId).toBe(bpId)
  })

  it('hides the load balancer section entirely with 0 AZs', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.queryByText('▸ LOAD BALANCER')).toBeNull()
    expect(screen.queryByRole('group', { name: 'cross-zone' })).toBeNull()
  })

  it('hides the load balancer section at exactly 1 AZ, showing a hint instead (crossZone is a no-op with <2 AZs)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.queryByText('▸ LOAD BALANCER')).toBeNull()
    expect(screen.queryByRole('group', { name: 'cross-zone' })).toBeNull()
    expect(screen.getByText(/add a second az/i)).toBeInTheDocument()
  })

  it('reveals the load balancer section the moment a second AZ is added', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const { rerender } = render(<RegionConfigTab regionId={regionId} />)
    expect(screen.queryByText('▸ LOAD BALANCER')).toBeNull()

    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    rerender(<RegionConfigTab regionId={regionId} />)
    expect(screen.getByText('▸ LOAD BALANCER')).toBeInTheDocument()
    expect(screen.queryByText(/add a second az/i)).toBeNull()
  })

  it('hides per-AZ weight inputs under round-robin, shows them under weighted', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addAz(regionId, 'us-east-1b')
    render(<RegionConfigTab regionId={regionId} />)
    expect(screen.queryByLabelText(/az-weight-/)).toBeNull()

    fireEvent.click(within(screen.getByRole('group', { name: 'lb-algorithm' })).getByText('weighted'))
    expect(screen.getAllByLabelText(/az-weight-/)).toHaveLength(2)
  })

  it('editing a per-AZ weight input patches azWeights, defaulting unset AZs to 1', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azA = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const azB = useWorldStore.getState().addAz(regionId, 'us-east-1b')
    render(<RegionConfigTab regionId={regionId} />)
    fireEvent.click(within(screen.getByRole('group', { name: 'lb-algorithm' })).getByText('weighted'))

    expect(screen.getByLabelText(`az-weight-${azA}`)).toHaveValue(1)
    expect(screen.getByLabelText(`az-weight-${azB}`)).toHaveValue(1)

    fireEvent.change(screen.getByLabelText(`az-weight-${azA}`), { target: { value: '3' } })
    const lb = Object.values(useWorldStore.getState().doc.loadBalancers).find(l => l.regionId === regionId)!
    expect(lb.azWeights).toEqual({ [azA]: 3 })
    expect(screen.getByLabelText(`az-weight-${azB}`)).toHaveValue(1) // still defaulted, not persisted
  })

  // T2 review fix (motion-law violation): spec D3 gives the dock exactly ONE ambient stroke
  // (the atlas arc, mounted above the tab bar at region scope) — everything else in every dock
  // is hover-reactive only. EdgeRow's `kit-ripple` class runs a non-hover-gated `animation:
  // kit-ripple 1.6s ease-out infinite`, so an AZ row must never carry it, even with a healthy
  // status and the sim running (the two conditions that would have triggered it pre-fix).
  it('AZ row status dots never carry the ripple animation, even with a healthy status while running (D3: one ambient stroke per dock)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<RegionConfigTab regionId={regionId} />)

    const batch: MetricsBatch = {
      simMs: 1000, instances: {}, servers: {},
      azs: { [azId]: { azId, rps: 42, errorRate: 0, p50Ms: 5, p90Ms: 6, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0 } },
      regions: {},
      world: { totalRps: 42, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    }
    act(() => { useSimulationStore.setState({ running: true, latestBatch: batch }) })

    const dot = screen.getByTestId('kit-dot')
    expect(dot.className).not.toMatch(/kit-ripple/)
  })
})
