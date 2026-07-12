// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { WorldPanel } from './WorldPanel'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  // Additive reset (Polish 4 T1): WorldPanel now also reads nav + the lifted floor selection to
  // derive scope. Every pre-existing test below implicitly assumes world scope (globe level,
  // no selection) — this keeps that assumption true regardless of test order, without changing
  // a single existing assertion.
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useUiStore.setState({ selectedServerId: null })
})

describe('WorldPanel findings tab', () => {
  it('shows the stateful-without-volume finding for a stateful blueprint with no volume', () => {
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().updateBlueprint(bpId, { stateful: true, volumeName: null })

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Analysis'))

    expect(screen.getByText(/is stateful but has no volume configured/)).toBeInTheDocument()
  })

  it('shows the empty state when there are no findings', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Analysis'))
    expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
  })

  it('active tab renders the count as a chip and stays clickable', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Analysis'))
    expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
  })

  it('consumes a pending panel tab once on mount', () => {
    useUiStore.setState({ pendingPanelTab: 'analysis' })
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
    expect(useUiStore.getState().pendingPanelTab).toBeNull()
  })

  it('switches to a pendingPanelTab set while mounted and clears it', () => {
    useUiStore.setState({ pendingPanelTab: null })
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.queryByLabelText('autoBaseline')).not.toBeInTheDocument()   // starts on Topology
    act(() => useUiStore.getState().setPendingPanelTab('traffic'))
    expect(screen.getByLabelText('autoBaseline')).toBeInTheDocument()         // switched to Traffic
    expect(useUiStore.getState().pendingPanelTab).toBeNull()                  // one-shot consumed
  })

  it('tab ink slides — clicking a tab still switches content with the ink element present', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Traffic'))
    expect(screen.getByLabelText('autoBaseline')).toBeInTheDocument()
    expect(document.querySelector('.kit-ink')).not.toBeNull()
  })
})

// Migrated from the pre-Polish-4-T2 "WorldSummary" describe block (Polish 4 T2, spec D4): the
// atlas headline ABSORBS the old WorldSummary strip — same behavioral intent (same two postures,
// same number derivations), new home (AtlasHeader, mounted above the tab bar via WorldPanel).
// The old `data-testid="world-summary"` element no longer exists anywhere (WorldSummary itself
// was deleted, not just hidden) — asserted explicitly below alongside the migrated assertions.
describe('WorldPanel atlas header (Polish 4 T2)', () => {
  it('the old world-summary testid is gone — WorldSummary was absorbed, not duplicated', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.queryByTestId('world-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('atlas-header')).toBeInTheDocument()
  })

  it('atlas headline at rest counts the authored doc (same copy as the old world summary)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByTestId('atlas-headline')).toHaveTextContent(/1 region · 1 server · baseline 1,000 rps/)
  })

  it('the atlas headline $/hr renders in the price color while running', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch: MetricsBatch = {
      simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
      world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    }
    useSimulationStore.setState({ latestBatch: batch })
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    // Scoped to the atlas headline specifically (not a blind screen.getByText): the default
    // Topology tab's own wtree meta line legitimately shows the SAME rounded $/hr for this
    // single-region/single-server world, so an unscoped query would find two matches.
    const headline = screen.getByTestId('atlas-headline')
    expect(within(headline).getByText('$0.04/hr')).toHaveStyle({ color: 'var(--color-price)' })
    useSimulationStore.setState({ latestBatch: null })
  })

  it('region scope shows a scoped atlas headline above the four tabs', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useNavStore.getState().goRegion(regionId)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByTestId('atlas-header')).toBeInTheDocument()
    expect(screen.getByTestId('atlas-headline')).toHaveTextContent('us-east-1')
  })

  it('az scope renders the floor-plan minimap, not the atlas (own instrument, T3)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useNavStore.getState().goAz(regionId, azId)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.queryByTestId('atlas-header')).not.toBeInTheDocument()
    expect(screen.getByTestId('floor-plan-header')).toBeInTheDocument()
  })

  it('server scope renders no instrument header at all (T4 territory)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useNavStore.getState().goServer(regionId, azId, serverId)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.queryByTestId('atlas-header')).not.toBeInTheDocument()
    expect(screen.queryByTestId('floor-plan-header')).not.toBeInTheDocument()
  })
})

describe('WorldPanel signature headers (Polish 3 T7)', () => {
  it('every tab renders a signature header with its live one-liner', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addPlacement(bpId, serverId)
    useWorldStore.getState().addPopulation('nyc', 40.7, -74)

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)

    // 1-of-each fixture (1 region/AZ/server/blueprint/placement/population) doubles as the
    // singular-aware-grammar exercise (review fix wave, Polish 3 T7) — every count below is
    // exactly 1, so the singular branch of each `${n}${n===1?'':'s'}` must be hit.
    fireEvent.click(screen.getByText('Topology'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 region · 1 AZ · 1 server')

    fireEvent.click(screen.getByText('Blueprints'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 blueprint')

    fireEvent.click(screen.getByText('Placements'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 placement')

    fireEvent.click(screen.getByText('Traffic'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1,000 rps baseline · 1 population')

    fireEvent.click(screen.getByText('Analysis'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent(/\d+ findings? \(\d+ errors?\)/)

    fireEvent.click(screen.getByText('Events'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('—')

    fireEvent.click(screen.getByText('Cost'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent(/\$\d+\.\d{2}\/hr/)
  })

  it('all seven tab-header accents are distinct CSS var tokens (light-mode collision fix)', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)

    const labels = ['Topology', 'Blueprints', 'Placements', 'Traffic', 'Analysis', 'Events', 'Cost']
    const accents = labels.map(label => {
      fireEvent.click(screen.getByText(label))
      const header = screen.getByTestId('signature-header')
      const match = header.style.borderLeft.match(/var\(--[\w-]+\)/)
      expect(match).not.toBeNull()
      return match![0]
    })

    expect(new Set(accents).size).toBe(7)
  })

  it('cost header uses the price color', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Cost'))
    const header = screen.getByTestId('signature-header')
    const summary = within(header).getByText(/^\$\d+\.\d{2}\/hr$/)
    expect(summary).toHaveStyle({ color: 'var(--color-price)' })
  })

  it('header summaries show at rest where metrics-driven (topology counts render without a batch)', () => {
    useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(Object.keys(useWorldStore.getState().doc.regions)[0], 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    expect(useSimulationStore.getState().latestBatch).toBeNull()

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    // Starts on Topology by default — no metrics batch has ever been set.
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 region · 1 AZ · 1 server')
  })

  it('renders the signature header between the tab bar and the fieldset, outside disabled scope', () => {
    render(<WorldPanel running={true} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    const header = screen.getByTestId('signature-header')
    // A header nested inside `<fieldset disabled>` would itself carry the disabled attribute
    // cascade only for form controls — but the header must not be a fieldset descendant at all
    // per the brief ("never grays a header out"). Assert it sits outside any fieldset.
    expect(header.closest('fieldset')).toBeNull()
  })
})

describe('WorldPanel scope (Polish 4 T1)', () => {
  it('always renders the scope rail, even at world scope', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByTestId('scope-rail')).toBeInTheDocument()
    expect(screen.getByTestId('scope-pill-world')).toBeInTheDocument()
  })

  it('world scope keeps all seven existing tabs', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    for (const label of ['Topology', 'Blueprints', 'Placements', 'Traffic', 'Analysis', 'Events', 'Cost']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryByText('Config')).not.toBeInTheDocument()
  })

  it('region scope narrows the tab bar to Config/Analysis/Events/Cost and lands on Config', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useNavStore.getState().goRegion(regionId)

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)

    expect(screen.getByText('Config')).toBeInTheDocument()
    expect(screen.queryByText('Topology')).not.toBeInTheDocument()
    expect(screen.queryByText('Blueprints')).not.toBeInTheDocument()
    expect(screen.queryByText('Placements')).not.toBeInTheDocument()
    expect(screen.queryByText('Traffic')).not.toBeInTheDocument()
    // Tab persistence (D2): the world default ('topology') doesn't exist at region scope, so it
    // falls back to the new scope's first tab, Config — region scope's REAL Config body (T2:
    // RegionConfigTab, not the generic "coming soon" placeholder — that stays az/server-only)
    // should render.
    expect(screen.getByTestId('region-config-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('config-placeholder')).not.toBeInTheDocument()
  })

  it('az scope narrows the tab bar to Config/Analysis/Events/Cost and lands on the floor-plan Config (T3)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useNavStore.getState().goAz(regionId, azId)

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)

    expect(screen.getByText('Config')).toBeInTheDocument()
    expect(screen.queryByText('Topology')).not.toBeInTheDocument()
    expect(screen.queryByText('Blueprints')).not.toBeInTheDocument()
    // AZ scope's REAL Config body (T3: FloorPlanHeader + AzConfigTab, not the generic
    // "coming soon" placeholder — that stays server-only now).
    expect(screen.getByTestId('floor-plan-header')).toBeInTheDocument()
    expect(screen.getByTestId('az-config-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('config-placeholder')).not.toBeInTheDocument()
  })

  it('keeps a tab id shared across scopes (Analysis) instead of resetting to Config on a scope change', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Analysis'))
    expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()

    const regionId = useWorldStore.getState().addRegion('us-east-1')
    act(() => useNavStore.getState().goRegion(regionId))

    // Still on Analysis (valid at region scope too) — must NOT have been bounced to Config.
    expect(screen.queryByTestId('config-placeholder')).not.toBeInTheDocument()
    expect(screen.getByText('No findings in this scope.')).toBeInTheDocument()
  })

  it('the Analysis badge reflects the SCOPED count, not the world total', () => {
    const regionA = useWorldStore.getState().addRegion('us-east-1')
    const azA = useWorldStore.getState().addAz(regionA, 'us-east-1a')
    const serverA = useWorldStore.getState().addServer(azA, getPreset('vps-medium')!)
    const bp = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().updateBlueprint(bp, { stateful: true, volumeName: null })
    useWorldStore.getState().addPlacement(bp, serverA)
    const regionB = useWorldStore.getState().addRegion('eu-west-1')   // clean — no findings

    useNavStore.getState().goRegion(regionB)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)

    fireEvent.click(screen.getByText('Analysis'))
    expect(screen.getByText('No findings in this scope.')).toBeInTheDocument()
  })

  it('az scope: selecting a server (ui.store) narrows further to server scope, four-pill rail', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useWorldStore.getState().updateServer(serverId, { label: 'db-replica' })
    useNavStore.getState().goAz(regionId, azId)

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.queryByTestId('scope-pill-server')).not.toBeInTheDocument()

    act(() => useUiStore.getState().setSelectedServerId(serverId))

    expect(screen.getByTestId('scope-pill-server')).toHaveTextContent('db-replica')
    expect(screen.getByTestId('config-placeholder')).toHaveTextContent('db-replica')
  })

  it('server scope Cost tab shows compute cost plus the documented egress caveat', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useNavStore.getState().goServer(regionId, azId, serverId)

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Cost'))

    expect(screen.getByTestId('scoped-cost')).toBeInTheDocument()
    expect(screen.getByText('egress is attributed at the AZ level')).toBeInTheDocument()
  })
})
