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

// ─── Edge packet binding (packet-library phase) ──────────────────────────────────────────────
describe('ConnectionsView — EdgeInspector packet binding', () => {
  const st = () => useWorldStore.getState()
  const addDbPacket = (name: string, over: Record<string, unknown> = {}) => st().addPacket({
    name, protocol: 'db', sizeKb: 2, queryType: 'read', isWAL: false, resultSizeKb: 64, ...over,
  } as never)

  // The write-fraction control only exists when the edge points AT a db blueprint, so the
  // seed makes the target a real SQL appliance rather than the default 'api' kind.
  function seedEdge() {
    const { apiId, dbId } = seedApiDb()
    st().updateBlueprint(dbId, { kind: 'db-sql', dbConfig: { engine: 'sql', storageGb: 100 } })
    const depId = st().connectServices(apiId, { kind: 'blueprint', blueprintId: dbId },
      { port: 5432, protocol: 'db', autoProvision: true })
    return { apiId, dbId, depId }
  }

  it('binds a packet mix to the selected edge', () => {
    const { apiId, depId } = seedEdge()
    const packetId = addDbPacket('query')
    render(<ConnectionsView open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId(`conn-edge-${depId}`))

    const weight = screen.getByLabelText(`edge-mix-${depId}-${packetId}`)
    fireEvent.change(weight, { target: { value: '1' } })
    fireEvent.blur(weight)

    expect(st().doc.blueprints[apiId].dependencies[0].packetMix).toEqual([{ packetId, weight: 1 }])
  })

  it('the inline req/resp KB fields write tier-2 sizes when no mix is bound', () => {
    const { apiId, depId } = seedEdge()
    render(<ConnectionsView open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId(`conn-edge-${depId}`))

    const req = screen.getByLabelText(`edge-req-kb-${depId}`)
    fireEvent.change(req, { target: { value: '512' } })
    fireEvent.blur(req)
    expect(st().doc.blueprints[apiId].dependencies[0].reqKb).toBe(512)
    // and the readout reflects the resolver, not the raw field
    expect(screen.getByText(/512 KB up/)).toBeTruthy()
  })

  it('a bound db mix REPLACES the manual write-fraction slider with its derived value', () => {
    const { apiId, depId } = seedEdge()
    const writePacket = addDbPacket('insert', { queryType: 'write' })
    render(<ConnectionsView open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId(`conn-edge-${depId}`))
    // manual slider present while unbound
    expect(screen.getByLabelText('write fraction')).toBeTruthy()

    const weight = screen.getByLabelText(`edge-mix-${depId}-${writePacket}`)
    fireEvent.change(weight, { target: { value: '1' } })
    fireEvent.blur(weight)

    expect(screen.queryByLabelText('write fraction')).toBeNull()
    expect(screen.getByText(/derived from the bound db packets/)).toBeTruthy()
    expect(screen.getByText('writes 100%')).toBeTruthy()
    void apiId
  })

  it('the synthetic Internet ingress edge offers no packet binding (its sizes come from routes)', () => {
    const { apiId } = seedApiDb()
    st().setInternetFacing(apiId, 8080, true)
    render(<ConnectionsView open onClose={() => {}} />)
    fireEvent.click(screen.getByTestId(`conn-edge-ingress:${apiId}`))
    expect(screen.queryByText('▸ OUTGOING PACKETS')).toBeNull()
  })
})
