// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScopeRail } from './ScopeRail'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useUiStore } from '../../store/ui.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import type { DockScope } from './scope'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useUiStore.setState({ selectedServerId: null })
})

function seed() {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  useWorldStore.getState().updateServer(serverId, { label: 'db-replica' })
  return { regionId, azId, serverId }
}

describe('ScopeRail', () => {
  it('renders data-testid="scope-rail"', () => {
    render(<ScopeRail scope={{ kind: 'world' }} />)
    expect(screen.getByTestId('scope-rail')).toBeTruthy()
  })

  it('world scope renders exactly one lit "world" pill', () => {
    render(<ScopeRail scope={{ kind: 'world' }} />)
    expect(screen.getByTestId('scope-pill-world')).toHaveTextContent('world')
    expect(screen.queryByTestId('scope-pill-region')).not.toBeInTheDocument()
  })

  it('server scope renders the full four-pill trail with doc-sourced labels', () => {
    const { regionId, azId, serverId } = seed()
    useNavStore.getState().goServer(regionId, azId, serverId)
    const scope: DockScope = { kind: 'server', regionId, azId, serverId }
    render(<ScopeRail scope={scope} />)
    expect(screen.getByTestId('scope-pill-world')).toHaveTextContent('world')
    expect(screen.getByTestId('scope-pill-region')).toHaveTextContent('us-east-1')
    expect(screen.getByTestId('scope-pill-az')).toHaveTextContent('us-east-1a')
    expect(screen.getByTestId('scope-pill-server')).toHaveTextContent('db-replica')
  })

  it('the "here" pill (current scope) is not a clickable control', () => {
    const { regionId } = seed()
    useNavStore.getState().goRegion(regionId)
    render(<ScopeRail scope={{ kind: 'region', regionId }} />)
    const herePill = screen.getByTestId('scope-pill-region')
    expect(herePill.tagName).not.toBe('BUTTON')
  })

  it('clicking the world pill (not "here") dispatches goGlobe', () => {
    const { regionId } = seed()
    useNavStore.getState().goRegion(regionId)
    render(<ScopeRail scope={{ kind: 'region', regionId }} />)
    fireEvent.click(screen.getByTestId('scope-pill-world'))
    expect(useNavStore.getState().level).toBe('globe')
  })

  it('clicking the region pill (not "here") dispatches goRegion(id)', () => {
    const { regionId, azId } = seed()
    useNavStore.getState().goAz(regionId, azId)
    render(<ScopeRail scope={{ kind: 'az', regionId, azId }} />)
    fireEvent.click(screen.getByTestId('scope-pill-region'))
    expect(useNavStore.getState().level).toBe('region')
    expect(useNavStore.getState().regionId).toBe(regionId)
  })

  it('clicking the az pill while nav is already at "az" level just clears selection (widen, no re-nav)', () => {
    const { regionId, azId, serverId } = seed()
    useNavStore.getState().goAz(regionId, azId)
    useUiStore.setState({ selectedServerId: serverId })
    const goAzSpy = vi.spyOn(useNavStore.getState(), 'goAz')

    const scope: DockScope = { kind: 'server', regionId, azId, serverId }
    render(<ScopeRail scope={scope} />)
    fireEvent.click(screen.getByTestId('scope-pill-az'))

    expect(useUiStore.getState().selectedServerId).toBeNull()
    expect(goAzSpy).not.toHaveBeenCalled()
    goAzSpy.mockRestore()
  })

  it('clicking the az pill while nav is at "server" level (board-drilled) navigates up via goAz', () => {
    const { regionId, azId, serverId } = seed()
    useNavStore.getState().goServer(regionId, azId, serverId)

    const scope: DockScope = { kind: 'server', regionId, azId, serverId }
    render(<ScopeRail scope={scope} />)
    fireEvent.click(screen.getByTestId('scope-pill-az'))

    expect(useNavStore.getState().level).toBe('az')
    expect(useNavStore.getState().serverId).toBeNull()
    expect(useNavStore.getState().azId).toBe(azId)
  })
})
