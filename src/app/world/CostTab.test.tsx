// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CostTab } from './CostTab'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { getPreset } from '../../lib/world/instanceCatalog'
import * as costModel from '../../lib/costModelV2'
import * as costSeriesModule from '../../lib/costSeries'
import type { MetricsBatch, ReplayFrame } from '../../lib/worldEngine/types'

function emptyWorldMetrics(over: Partial<MetricsBatch['world']> = {}): MetricsBatch['world'] {
  return {
    totalRps: 0, errorRate: 0, populationRoutes: [],
    crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0,
    ...over,
  }
}

function fakeBatch(simMs: number): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs: {}, regions: {}, world: emptyWorldMetrics() }
}

function fakeFrames(count: number): ReplayFrame[] {
  return Array.from({ length: count }, (_, i) => ({ simMs: i * 1000, events: [], batch: fakeBatch(i * 1000) }))
}

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null, scrubIndex: null })
  // Pre-existing store/engine quirk (not introduced by this task, see task-9-report.md):
  // worldEngine.getReplayFrames() returns a FRESH `[]` literal on every call while no run is
  // active (`state?.replay.getFrames() ?? []`), which is referentially unstable across
  // re-renders and trips React's useSyncExternalStore consistency check into an infinite
  // render loop under jsdom. SignalsPanel.test.tsx (Task 4/5) never renders that hook unmocked
  // for exactly this reason -- every one of its tests mocks getReplayFrames first. Follow the
  // same established convention here: a stable default of no frames, overridden per-test where a
  // fixture needs real frames.
  vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue([])
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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
    // by-region row + by-AZ row + the residual row (Wave 4 final review fix #2: no blueprint is
    // placed on this server, so its entire cost is unattributed and shows as the residual line).
    const moneyValues = screen.getAllByText('$26.28')
    expect(moneyValues).toHaveLength(3)
    for (const el of moneyValues) expect(el).toHaveStyle({ color: 'var(--color-price)' })

    expect(screen.getByText('Cross-AZ').nextSibling).toHaveStyle({ color: 'var(--color-price)' })
    expect(screen.getByText('Cross-region').nextSibling).toHaveStyle({ color: 'var(--color-price)' })
    expect(screen.getByText('Internet').nextSibling).toHaveStyle({ color: 'var(--color-price)' })
  })

  // --- FEAT-010 Task 9 additions ---

  it('renders the $/hr headline in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<CostTab />)
    const headline = screen.getByText(/\/hr/)
    expect(headline).toHaveStyle({ color: 'var(--color-price)' })
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

  it('renders a By service section ranked by cost (more expensive service first)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const cheapServerId = useWorldStore.getState().addServer(azId, getPreset('vps-small')!)   // 0.018/hr
    const pricyServerId = useWorldStore.getState().addServer(azId, getPreset('vps-large')!)   // 0.071/hr
    const cheapBpId = useWorldStore.getState().addBlueprint('cheap-svc')
    const pricyBpId = useWorldStore.getState().addBlueprint('pricy-svc')
    useWorldStore.getState().addPlacement(cheapBpId, cheapServerId)
    useWorldStore.getState().addPlacement(pricyBpId, pricyServerId)

    render(<CostTab />)
    expect(screen.getByText(/by service/i)).toBeInTheDocument()
    const cheapLabel = screen.getByText('cheap-svc')
    const pricyLabel = screen.getByText('pricy-svc')
    // DOCUMENT_POSITION_FOLLOWING means `cheapLabel` comes AFTER `pricyLabel` in the DOM --
    // i.e. pricy-svc (the more expensive row) is ranked first.
    // eslint-disable-next-line no-bitwise
    expect(cheapLabel.compareDocumentPosition(pricyLabel) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('shows a negative incident-cost delta with a minus glyph, still in the price color (never success/danger)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const frames = fakeFrames(4)
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
    vi.spyOn(costSeriesModule, 'incidentCost').mockReturnValue({ actualUsd: 1, baselineUsd: 5, incidentUsd: -4 })
    useSimulationStore.setState({ scrubIndex: 3 })

    render(<CostTab />)
    const el = screen.getByTestId('incident-cost')
    expect(el.textContent).toMatch(/^−/)
    expect(el).toHaveStyle({ color: 'var(--color-price)' })
    // The forbidden temptation this test guards against: rendering a negative delta as "good
    // news" in the success color (or as a warning in the danger color). Price law is absolute --
    // every money value, including a negative one, is var(--color-price).
    expect(el.style.color).not.toBe('var(--color-success)')
    expect(el.style.color).not.toBe('var(--color-danger)')
  })

  it('shows a positive incident-cost delta with no minus glyph, still in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const frames = fakeFrames(4)
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
    vi.spyOn(costSeriesModule, 'incidentCost').mockReturnValue({ actualUsd: 9, baselineUsd: 5, incidentUsd: 4 })
    useSimulationStore.setState({ scrubIndex: 3 })

    render(<CostTab />)
    const el = screen.getByTestId('incident-cost')
    expect(el.textContent).not.toMatch(/^−/)
    expect(el).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('the LB-hours note renders its dollar amount in the price color, not the muted note color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().addLoadBalancer(regionId)
    render(<CostTab />)
    // The dollar amount lives in its OWN span, priced -- distinct from the surrounding
    // descriptive note text, which stays muted. Queried by testid, not by text pattern: the
    // "price this world as..." comparison row (wave 5) renders the identical "$X.XX/mo" text
    // shape, so a plain text-pattern query would ambiguously match both once a world has an LB.
    const amountEl = screen.getByTestId('lb-hours-amount')
    expect(amountEl).toHaveStyle({ color: 'var(--color-price)' })
    expect(screen.getByText(/includes 1 load balancer/i)).toHaveStyle({ color: 'var(--color-text-muted)' })
  })

  it('does not render the incident-cost readout when not scrubbing', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<CostTab />)
    expect(screen.queryByTestId('incident-cost')).not.toBeInTheDocument()
  })

  // --- Wave 4 final review, Important #2: unattributed-residual row ---

  it('shows an "unattributed" residual row when By-service rows do not sum to the monthly total (e.g. an LB)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const bpId = useWorldStore.getState().addBlueprint('svc')
    useWorldStore.getState().addPlacement(bpId, serverId)
    // An authored LB adds LB-hours to computeWorldCost's monthlyUsd, but attributeByBlueprint
    // documents that it deliberately does NOT attribute LB/cross-zone cost to any blueprint --
    // so the By-service rows (just `svc`'s server cost) undershoot the monthly total by exactly
    // the LB-hours amount, and that gap should render as an explicit residual line.
    useWorldStore.getState().addLoadBalancer(regionId)

    render(<CostTab />)
    const residual = screen.getByTestId('cost-residual')
    expect(residual).toBeInTheDocument()
    expect(residual.textContent).toMatch(/unattributed/i)
    const amountEl = residual.querySelector('span:last-child')!
    expect(amountEl).toHaveStyle({ color: 'var(--color-price)' })
    expect(amountEl.textContent).toMatch(/^\$\d+\.\d{2}$/)
  })

  it('does not show a residual row when By-service rows already sum to the monthly total', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const bpId = useWorldStore.getState().addBlueprint('svc')
    useWorldStore.getState().addPlacement(bpId, serverId)
    // No LB, no traffic -> nothing unattributed.
    render(<CostTab />)
    expect(screen.queryByTestId('cost-residual')).not.toBeInTheDocument()
  })

  it('resets the cost-series cache when doc identity changes (no stale cost carried across worlds)', () => {
    const frames = fakeFrames(2)
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
    const spy = vi.spyOn(costModel, 'computeWorldCost')

    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)

    const { rerender } = render(<CostTab />)
    const callsAfterFirst = spy.mock.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // Change doc identity (a brand-new world -- different WorldDoc reference) while `frames`
    // stays the SAME array/reference. If the per-doc cache were not reset, costSeriesFor would
    // reuse the old doc's cached WorldCostResult for frame indices 0/1 and computeWorldCost would
    // NOT be called again for the series -- only the always-uncached headline call would fire.
    useWorldStore.getState().newWorld()
    const region2 = useWorldStore.getState().addRegion('us-west-2')
    const az2 = useWorldStore.getState().addAz(region2, 'us-west-2a')
    useWorldStore.getState().addServer(az2, getPreset('vps-large')!)

    rerender(<CostTab />)
    const callsAfterSecond = spy.mock.calls.length - callsAfterFirst
    // 1 headline call + 2 series calls (one per frame, cache freshly empty for the new doc) = 3.
    expect(callsAfterSecond).toBeGreaterThanOrEqual(3)
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
