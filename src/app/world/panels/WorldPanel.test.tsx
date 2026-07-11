// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { WorldPanel } from './WorldPanel'
import { useWorldStore } from '../../store/world.store'
import { useUiStore } from '../../store/ui.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

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
})
