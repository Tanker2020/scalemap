// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CostTab } from './CostTab'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null })
})

describe('CostTab', () => {
  it('renders exact monthly math for a server-only world', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // 0.036 usd/hr
    render(<CostTab />)
    expect(screen.getByText('$26.28 /mo')).toBeInTheDocument()   // 0.036 * 730
  })

  it('shows a zero-state before any regions exist', () => {
    render(<CostTab />)
    expect(screen.getByText('$0.00 /mo')).toBeInTheDocument()
    expect(screen.getByText('no regions yet')).toBeInTheDocument()
  })

  it('the monthly total renders in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<CostTab />)
    expect(screen.getByText('$26.28 /mo').style.color).toBe('var(--color-price)')
  })

  it('per-region, per-AZ, and egress money figures all render in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<CostTab />)
    const moneyValues = screen.getAllByText('$26.28')   // by-region row + by-AZ row
    expect(moneyValues).toHaveLength(2)
    for (const el of moneyValues) expect(el).toHaveStyle({ color: 'var(--color-price)' })

    expect(screen.getByText('Cross-AZ').nextSibling).toHaveStyle({ color: 'var(--color-price)' })
    expect(screen.getByText('Cross-region').nextSibling).toHaveStyle({ color: 'var(--color-price)' })
    expect(screen.getByText('Internet').nextSibling).toHaveStyle({ color: 'var(--color-price)' })
  })

  // Task 12 (wave 5): "price this world as…" comparison row.
  it('shows a price-this-world-as row for aws/gcp/azure, each in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<CostTab />)
    expect(screen.getByText('Price this world as…')).toBeInTheDocument()
    for (const label of ['AWS', 'GCP', 'Azure']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // A server-only world (no managed services) prices identically under every provider — the
    // "/mo" (no leading space) format distinguishes these rows from the top total's "$X /mo".
    const rowValues = screen.getAllByText('$26.28/mo')
    expect(rowValues).toHaveLength(3)
    for (const el of rowValues) expect(el).toHaveStyle({ color: 'var(--color-price)' })
  })
})
