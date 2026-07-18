// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConnectionsView } from './ConnectionsView'
import { useWorldStore } from '../../store/world.store'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => useWorldStore.getState().newWorld())

// api + db each on their own server; db's server firewall tightened to default-deny so an edge
// to it compiles blocked until provisioned.
function seedApiDb() {
  const s = useWorldStore.getState()
  const regionId = s.addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  const apiSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const dbSrv = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
  const apiId = useWorldStore.getState().addBlueprint('api')
  const dbId = useWorldStore.getState().addBlueprint('db')
  useWorldStore.getState().addPlacement(apiId, apiSrv)
  useWorldStore.getState().addPlacement(dbId, dbSrv)
  useWorldStore.getState().updateServer(dbSrv, { firewall: [] })
  return { apiId, dbId, dbSrv }
}

describe('ConnectionsView', () => {
  it('drag-connect from a service handle onto another opens a draft that dispatches connectServices', () => {
    const { apiId, dbId } = seedApiDb()
    render(<ConnectionsView open onClose={() => {}} />)

    fireEvent.mouseDown(screen.getByTestId(`conn-handle-${apiId}`))
    fireEvent.mouseUp(screen.getByTestId(`conn-node-${dbId}`))
    // Draft bar appears; commit it.
    fireEvent.click(screen.getByTestId('conn-draft-connect'))

    const api = useWorldStore.getState().doc.blueprints[apiId]
    expect(api.dependencies).toHaveLength(1)
    expect(api.dependencies[0].target).toEqual({ kind: 'blueprint', blueprintId: dbId })
  })

  it('a blocked edge exposes a fix that opens the firewall on the target host', () => {
    const { apiId, dbId, dbSrv } = seedApiDb()
    // Author a dependency on a port db already binds (8080) → firewall-deny, i.e. blocked.
    const depId = useWorldStore.getState().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId }, { port: 8080, protocol: 'http', autoProvision: false })
    render(<ConnectionsView open onClose={() => {}} />)

    fireEvent.click(screen.getByTestId(`conn-edge-${depId}`))   // select the edge → inspector
    fireEvent.click(screen.getByTestId('conn-fix'))             // one-click provision

    const fw = useWorldStore.getState().doc.servers[dbSrv].firewall
    expect(fw.some(r => r.action === 'allow' && r.port === 8080)).toBe(true)
  })

  it('the per-service 🌐 toggle flips its primary port to public (ingress)', () => {
    const { apiId } = seedApiDb()
    render(<ConnectionsView open onClose={() => {}} />)

    fireEvent.click(screen.getByTestId(`conn-expose-${apiId}`))
    const api = useWorldStore.getState().doc.blueprints[apiId]
    expect(api.ports[0].visibility).toBe('public')
  })

  it('dragging a node persists its position to doc.connectionLayout', () => {
    const { apiId } = seedApiDb()
    render(<ConnectionsView open onClose={() => {}} />)
    fireEvent.mouseDown(screen.getByTestId(`conn-node-${apiId}`), { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(screen.getByTestId('conn-canvas'), { clientX: 320, clientY: 200 })
    fireEvent.mouseUp(screen.getByTestId('conn-canvas'))
    expect(useWorldStore.getState().doc.connectionLayout[apiId]).toBeDefined()
  })

  it('auto-arrange clears manual node positions back to the auto layout', () => {
    const { apiId } = seedApiDb()
    useWorldStore.getState().setNodePosition(apiId, { x: 400, y: 300 })
    render(<ConnectionsView open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId('conn-autoarrange'))
    expect(useWorldStore.getState().doc.connectionLayout).toEqual({})
  })

  it('renders nothing when closed', () => {
    seedApiDb()
    const { container } = render(<ConnectionsView open={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
