// src/app/world/panels/PacketsPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PacketsPanel } from './PacketsPanel'
import { BlueprintsPanel } from './BlueprintsPanel'
import { RoutesPanel } from './RoutesPanel'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { listPackets, listRoutes } from '../../../lib/nodeConfig'
import { getPreset } from '../../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
})

const st = () => useWorldStore.getState()
const addDbPacket = (name = 'query') => st().addPacket({
  name, protocol: 'db', sizeKb: 2, queryType: 'read', isWAL: false, resultSizeKb: 64,
})

describe('PacketsPanel', () => {
  it('lists packets with their id and size summary, and NOT routes', () => {
    st().addRoute({ name: 'checkout', method: 'POST', path: '/checkout' })
    const id = addDbPacket('thumbnail')
    render(<PacketsPanel />)
    expect(screen.getByText('thumbnail')).toBeTruthy()
    expect(screen.getByText(`#${id}`)).toBeTruthy()
    expect(screen.queryByText('checkout')).toBeNull()
  })

  it('shows the empty state before anything is authored', () => {
    render(<PacketsPanel />)
    expect(screen.getByText('no packets yet')).toBeTruthy()
  })

  it('counts bindings across both edges and routes', () => {
    const packetId = addDbPacket()
    const routeId = st().addRoute({ name: 'r', method: 'GET', path: '/a' })
    const web = st().addBlueprint('web')
    const db = st().addBlueprint('db')
    const depId = st().connectServices(web, { kind: 'blueprint', blueprintId: db }, { port: 5432, protocol: 'db', autoProvision: false })
    st().setDependencyPacketMix(web, depId, [{ packetId, weight: 1 }])
    st().setRoutePacketMix(routeId, [{ packetId, weight: 1 }])

    render(<PacketsPanel />)
    expect(screen.getByText('1 edge · 1 route')).toBeTruthy()
  })

  it('an unbound packet reads "unused"', () => {
    addDbPacket()
    render(<PacketsPanel />)
    expect(screen.getByText('unused')).toBeTruthy()
  })

  it('dup and × dispatch through the store', () => {
    const id = addDbPacket()
    render(<PacketsPanel />)
    fireEvent.click(screen.getByLabelText(`duplicate-packet-${id}`))
    expect(listPackets(st().doc.packets).map(p => p.name)).toEqual(['query', 'query (copy)'])
    fireEvent.click(screen.getByLabelText(`remove-packet-${id}`))
    expect(listPackets(st().doc.packets).map(p => p.name)).toEqual(['query (copy)'])
  })

  it('the default-packet row starts at the 2 KB convention and resets back to absent', () => {
    render(<PacketsPanel />)
    const req = screen.getByLabelText('default-req-size') as HTMLInputElement
    expect(req.value).toBe('2')
    // no override authored yet ⇒ no reset affordance
    expect(screen.queryByLabelText('reset-default-packet')).toBeNull()

    fireEvent.change(req, { target: { value: '8' } })
    expect(st().doc.packets.defaultPacket).toEqual({ reqKb: 8, respKb: 2 })

    fireEvent.click(screen.getByLabelText('reset-default-packet'))
    expect(st().doc.packets.defaultPacket).toBeUndefined()
  })

  it('the add button opens the modal (which renders outside this container, via a portal)', () => {
    render(<PacketsPanel />)
    expect(screen.queryByText('Add packet')).toBeNull()
    fireEvent.click(screen.getByLabelText('add-packet'))
    expect(screen.getByText('Add packet')).toBeTruthy()
  })
})

describe('BlueprintsPanel', () => {
  it('lists every definition, placed or not', () => {
    const region = st().addRegion('us-east-1')
    const az = st().addAz(region, 'us-east-1a')
    const server = st().addServer(az, getPreset('vps-medium')!)
    const placed = st().addBlueprint('orders')
    st().addPlacement(placed, server)
    st().addBlueprint('lonely-worker')

    render(<BlueprintsPanel openConnections={() => {}} />)
    expect(screen.getByText('orders')).toBeTruthy()
    expect(screen.getByText('lonely-worker')).toBeTruthy()
    expect(screen.getByText(/1 host · 1 AZ/)).toBeTruthy()
    expect(screen.getByText(/not placed/)).toBeTruthy()
  })

  it('duplicate creates a second, unplaced definition', () => {
    const region = st().addRegion('us-east-1')
    const az = st().addAz(region, 'us-east-1a')
    const server = st().addServer(az, getPreset('vps-medium')!)
    const id = st().addBlueprint('orders')
    st().addPlacement(id, server)

    render(<BlueprintsPanel openConnections={() => {}} />)
    fireEvent.click(screen.getByLabelText(`duplicate-blueprint-${id}`))
    const names = Object.values(st().doc.blueprints).map(b => b.name).sort()
    expect(names).toEqual(['orders', 'orders (copy)'])
    expect(Object.values(st().doc.placements)).toHaveLength(1)
  })

  it('routes and packets are untouched by blueprint work (the two libraries are independent)', () => {
    st().addRoute({ name: 'r', method: 'GET', path: '/a' })
    render(<BlueprintsPanel openConnections={() => {}} />)
    expect(listRoutes(st().doc.packets)).toHaveLength(1)
  })

  it('the empty state points at the VPS door rather than offering a create button', () => {
    render(<BlueprintsPanel openConnections={() => {}} />)
    expect(screen.getByText(/no services yet/)).toBeTruthy()
  })

  it('opens the connections graph from the panel footer', () => {
    let opened = false
    render(<BlueprintsPanel openConnections={() => { opened = true }} />)
    fireEvent.click(screen.getByLabelText('open connections graph'))
    expect(opened).toBe(true)
  })
})

// ─── Shared PacketMixEditor + its two carriers (slice 5) ─────────────────────────────────────
describe('PacketMixEditor (via RoutesPanel\'s advanced disclosure)', () => {
  it('binds a weighted mix to a route and greys out the inline sizes', async () => {
    const packetId = addDbPacket('thumb')
    const routeId = st().addRoute({ name: 'upload', method: 'POST', path: '/upload' })
    render(<RoutesPanel />)

    fireEvent.click(screen.getByLabelText(`route-advanced-${routeId}`))
    const weight = screen.getByLabelText(`route-mix-${routeId}-${packetId}`)
    fireEvent.change(weight, { target: { value: '3' } })
    fireEvent.blur(weight)

    expect(st().doc.packets.templates[Number(routeId)]).toMatchObject({
      packetMix: [{ packetId, weight: 3 }],
    })
    expect(screen.getByText('packet mix bound')).toBeTruthy()
  })

  it('setting a weight back to 0 unbinds the mix entirely', () => {
    const packetId = addDbPacket()
    const routeId = st().addRoute({ name: 'r', method: 'GET', path: '/a' })
    st().setRoutePacketMix(routeId, [{ packetId, weight: 2 }])
    render(<RoutesPanel />)

    const weight = screen.getByLabelText(`route-mix-${routeId}-${packetId}`)
    fireEvent.change(weight, { target: { value: '0' } })
    fireEvent.blur(weight)
    expect(st().doc.packets.templates[Number(routeId)]).toMatchObject({ packetMix: undefined })
  })

  it('an empty packet library explains where to author one instead of rendering rows', () => {
    const routeId = st().addRoute({ name: 'r', method: 'GET', path: '/a' })
    render(<RoutesPanel />)
    fireEvent.click(screen.getByLabelText(`route-advanced-${routeId}`))
    expect(screen.getByText(/No packets defined yet/)).toBeTruthy()
  })

  it('shows the live percentage split across a multi-packet mix', () => {
    const a = addDbPacket('a')
    const b = addDbPacket('b')
    const routeId = st().addRoute({ name: 'r', method: 'GET', path: '/a' })
    st().setRoutePacketMix(routeId, [{ packetId: a, weight: 3 }, { packetId: b, weight: 1 }])
    render(<RoutesPanel />)
    // an already-bound route opens the disclosure itself — a binding must never be hidden
    expect(screen.getByLabelText(`route-advanced-${routeId}`).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('75%')).toBeTruthy()
    expect(screen.getByText('25%')).toBeTruthy()
  })
})
