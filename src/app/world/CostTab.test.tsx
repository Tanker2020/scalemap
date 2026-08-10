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

  // I3 fix (final wave-5 review): `doc.cloudProfile` used to be authored/persisted/read-back by
  // the TopologyPanel dropdown that writes it, but nothing downstream ever consumed it — setting
  // a world's cloud profile produced zero visible change anywhere. The headline "$X /mo" total
  // (NOT the "price this world as…" comparison row, which explicitly overrides per-provider
  // regardless) must now change when `cloudProfile` is set, for a world with an unpinned managed
  // service (a pinned service's price is untouched by design — see costModelV2.test.ts's own
  // providerOverride suite).
  it('setting doc.cloudProfile changes the headline monthly total for a world with an unpinned managed service (but not a pinned one)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addManagedService('objectStorage', 'Object store', { kind: 'region', regionId }, 443, undefined, {
      storageGb: 500, storageTierId: 'standard',
    })

    const { unmount } = render(<CostTab />)
    const genericTotal = screen.getByText(/\$\d+\.\d\d \/mo/).textContent
    unmount()

    useWorldStore.getState().setCloudProfile('aws')
    render(<CostTab />)
    const awsTotal = screen.getByText(/\$\d+\.\d\d \/mo/).textContent

    expect(awsTotal).not.toBe(genericTotal)
  })

  // Fix round 1: the degenerate all-identical test above proves the row renders, but a world with
  // an unpinned ('generic') managed service is actually eligible for repricing, so its three
  // totals must genuinely diverge — this is what would catch a regression where providerOverride
  // stops being threaded through to computeWorldCost.
  it('a world with an unpinned managed service reprices differently under aws/gcp/azure', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    // provider omitted -> defaults to 'generic', i.e. unpinned and eligible for providerOverride.
    useWorldStore.getState().addManagedService('objectStorage', 'Object store', { kind: 'region', regionId }, 443, undefined, {
      storageGb: 500, storageTierId: 'standard',
    })
    render(<CostTab />)
    const rowValues = screen.getAllByText(/^\$\d+\.\d{2}\/mo$/)
    expect(rowValues).toHaveLength(3)
    const totals = rowValues.map(el => el.textContent)
    expect(new Set(totals).size).toBeGreaterThan(1)
  })
})
