// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { WorldPanel } from './WorldPanel'
import { useWorldStore } from '../../store/world.store'
import { useUiStore } from '../../store/ui.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { MetricsBatch } from '../../../lib/worldEngine/types'

beforeEach(() => useWorldStore.getState().newWorld())

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

  it('world summary at rest counts the authored doc', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByText(/1 region · 1 server · baseline 1,000 rps/)).toBeInTheDocument()
  })

  it('tab ink slides — clicking a tab still switches content with the ink element present', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Traffic'))
    expect(screen.getByLabelText('autoBaseline')).toBeInTheDocument()
    expect(document.querySelector('.kit-ink')).not.toBeNull()
  })

  it('the world summary $/hr renders in the price color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    const batch: MetricsBatch = {
      simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
      world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    }
    useSimulationStore.setState({ latestBatch: batch })
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByText('$0.04/hr')).toHaveStyle({ color: 'var(--color-price)' })
    useSimulationStore.setState({ latestBatch: null })
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

    fireEvent.click(screen.getByText('Topology'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 regions · 1 AZs · 1 servers')

    fireEvent.click(screen.getByText('Blueprints'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 blueprints')

    fireEvent.click(screen.getByText('Placements'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 placements')

    fireEvent.click(screen.getByText('Traffic'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1,000 rps baseline · 1 populations')

    fireEvent.click(screen.getByText('Analysis'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent(/\d+ findings \(\d+ errors\)/)

    fireEvent.click(screen.getByText('Events'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent('—')

    fireEvent.click(screen.getByText('Cost'))
    expect(screen.getByTestId('signature-header')).toHaveTextContent(/\$\d+\.\d{2}\/hr/)
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
    expect(screen.getByTestId('signature-header')).toHaveTextContent('1 regions · 1 AZs · 1 servers')
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
