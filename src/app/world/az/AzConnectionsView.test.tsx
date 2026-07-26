// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AzConnectionsView } from './AzConnectionsView'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

// api and db each on their own server, wired with a dependency. `sameAz: false` places them in
// separate AZs of the same region for the cross-AZ assertions.
function seedApiDb(sameAz = true) {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azA = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const azB = sameAz ? azA : useWorldStore.getState().addAz(regionId, 'us-east-1b')
  const apiSrv = useWorldStore.getState().addServer(azA, getPreset('vps-medium')!)
  const dbSrv = useWorldStore.getState().addServer(azB, getPreset('vps-medium')!)
  const apiId = useWorldStore.getState().addBlueprint('api')
  const dbId = useWorldStore.getState().addBlueprint('db')
  useWorldStore.getState().addPlacement(apiId, apiSrv)
  useWorldStore.getState().addPlacement(dbId, dbSrv)
  useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId }, { port: 5432, protocol: 'db', autoProvision: true })
  return { azA, azB, apiId, dbId, dbSrv }
}

describe('AzConnectionsView', () => {
  it('renders nothing when closed', () => {
    const { azA } = seedApiDb()
    render(<AzConnectionsView azId={azA} open={false} onClose={() => {}} />)
    expect(screen.queryByTestId('az-conn-canvas')).toBeNull()
  })

  it('renders both endpoint nodes and one edge for a same-AZ dependency', () => {
    const { azA, apiId, dbId } = seedApiDb()
    render(<AzConnectionsView azId={azA} open onClose={() => {}} />)
    expect(screen.getByTestId(`az-conn-node-${apiId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`az-conn-node-${dbId}`)).toBeInTheDocument()
    expect(screen.getAllByTestId(/^az-conn-edge-/)).toHaveLength(1)
  })

  it('shows the empty state for an AZ with no touching connections', () => {
    const s = useWorldStore.getState()
    const regionId = s.addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    render(<AzConnectionsView azId={azId} open onClose={() => {}} />)
    expect(screen.getByText(/no connections touch this az/i)).toBeInTheDocument()
  })

  it('is read-only: no connect handle, no move-drag affordance, no fix/remove controls', () => {
    const { azA, apiId } = seedApiDb()
    render(<AzConnectionsView azId={azA} open onClose={() => {}} />)
    expect(screen.queryByTestId(`conn-handle-${apiId}`)).toBeNull()
    fireEvent.click(screen.getAllByTestId(/^az-conn-edge-/)[0])
    expect(screen.queryByTestId('conn-fix')).toBeNull()
    expect(screen.queryByTestId('conn-remove')).toBeNull()
  })

  it('clicking an edge opens a read-only inspector with port/protocol/verdict', () => {
    const { azA } = seedApiDb()
    render(<AzConnectionsView azId={azA} open onClose={() => {}} />)
    fireEvent.click(screen.getAllByTestId(/^az-conn-edge-/)[0])
    expect(screen.getByText(/port 5432/)).toBeInTheDocument()
    expect(screen.getByText(/●\s*permitted/)).toBeInTheDocument()
  })

  it('a cross-AZ dependency renders in both AZs\' views', () => {
    const { azA, azB, apiId, dbId } = seedApiDb(false)
    const { unmount } = render(<AzConnectionsView azId={azA} open onClose={() => {}} />)
    expect(screen.getByTestId(`az-conn-node-${apiId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`az-conn-node-${dbId}`)).toBeInTheDocument()
    unmount()

    render(<AzConnectionsView azId={azB} open onClose={() => {}} />)
    expect(screen.getByTestId(`az-conn-node-${apiId}`)).toBeInTheDocument()
    expect(screen.getByTestId(`az-conn-node-${dbId}`)).toBeInTheDocument()
  })

  it('the close button calls onClose', () => {
    const { azA } = seedApiDb()
    let closed = 0
    render(<AzConnectionsView azId={azA} open onClose={() => { closed++ }} />)
    fireEvent.click(screen.getByText('close'))
    expect(closed).toBe(1)
  })

  it('Escape calls onClose', () => {
    const { azA } = seedApiDb()
    let closed = 0
    render(<AzConnectionsView azId={azA} open onClose={() => { closed++ }} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(closed).toBe(1)
  })
})
