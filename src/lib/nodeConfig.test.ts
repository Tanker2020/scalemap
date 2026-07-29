import { describe, it, expect } from 'vitest'
import {
  emptyPacketRegistry, listRoutes, getRoute, addRoute, updateRoute, removeRoute,
  routeMatchesPattern, routeIdOf,
  listPackets, getPacket, addPacket, updatePacket, removePacket, duplicatePacket,
} from './nodeConfig'
import type { PacketRegistry, EventTemplate, DbTemplate } from './nodeConfig'

describe('route helpers over PacketRegistry', () => {
  it('emptyPacketRegistry is a generic, empty registry', () => {
    expect(emptyPacketRegistry()).toEqual({ mode: 'generic', templates: {}, nextId: 1 })
  })

  it('addRoute assigns nextId, stores an http template, and advances nextId', () => {
    const reg0 = emptyPacketRegistry()
    const { registry: reg1, route } = addRoute(reg0, { name: 'api', method: 'GET', path: '/api/*' })
    expect(route.id).toBe(1)
    expect(route.protocol).toBe('http')
    expect(route.path).toBe('/api/*')
    expect(reg1.nextId).toBe(2)
    expect(reg0.templates).toEqual({})   // original untouched (immutable)
    expect(routeIdOf(route)).toBe('1')
  })

  it('listRoutes returns only http templates, id-sorted', () => {
    let reg = emptyPacketRegistry()
    reg = addRoute(reg, { name: 'b', method: 'POST', path: '/b' }).registry
    reg = addRoute(reg, { name: 'a', method: 'GET', path: '/a' }).registry
    // a stray non-http template must be ignored by the route view
    const evt: EventTemplate = { id: 99, name: 'e', protocol: 'event', sizeKb: 1, topic: 't', eventType: 'x', deliveryMode: 'at-most-once' }
    reg = { ...reg, templates: { ...reg.templates, 99: evt } }
    const routes = listRoutes(reg)
    expect(routes.map(r => r.name)).toEqual(['b', 'a'])   // id order 1,2 — insertion order
  })

  it('getRoute resolves by stringified id and ignores non-http', () => {
    let reg = emptyPacketRegistry()
    const { registry, route } = addRoute(reg, { name: 'api', method: 'GET', path: '/api' })
    reg = registry
    expect(getRoute(reg, routeIdOf(route))?.name).toBe('api')
    expect(getRoute(reg, '404')).toBeUndefined()
  })

  it('updateRoute patches an existing http template only', () => {
    const { registry, route } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    const reg2 = updateRoute(registry, routeIdOf(route), { path: '/v2/*', method: 'POST' })
    expect(getRoute(reg2, routeIdOf(route))).toMatchObject({ path: '/v2/*', method: 'POST', name: 'api' })
  })

  it('removeRoute deletes the template', () => {
    const { registry, route } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    const reg2 = removeRoute(registry, routeIdOf(route))
    expect(getRoute(reg2, routeIdOf(route))).toBeUndefined()
    expect(listRoutes(reg2)).toEqual([])
  })

  it('addRoute gives a new route sensible byte/connection defaults', () => {
    const { route } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    expect(route.sizeKb).toBe(1)
    expect(route.responseSizeKb).toBe(4)
    expect(route.connectionType).toBe('keep-alive')
  })

  it('addRoute honors explicit sizes and connection type from fields', () => {
    const { route } = addRoute(emptyPacketRegistry(), {
      name: 'img', method: 'GET', path: '/img', sizeKb: 2, responseSizeKb: 512, connectionType: 'streaming',
    })
    expect(route.sizeKb).toBe(2)
    expect(route.responseSizeKb).toBe(512)
    expect(route.connectionType).toBe('streaming')
  })

  it('updateRoute patches responseSizeKb and connectionType', () => {
    const { registry, route } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    const reg2 = updateRoute(registry, routeIdOf(route), { responseSizeKb: 64, connectionType: 'short-lived' })
    expect(getRoute(reg2, routeIdOf(route))).toMatchObject({ responseSizeKb: 64, connectionType: 'short-lived' })
  })

  // Slice 3: sizeVariance (sigma) — the log-normal NIC-burst coefficient. Defaults to 0 (no
  // jitter) so an unauthored route stays byte-identical to pre-slice-3 behavior.
  it('addRoute defaults sizeVariance to 0', () => {
    const { route } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    expect(route.sizeVariance).toBe(0)
  })

  it('addRoute honors an explicit sizeVariance', () => {
    const { route } = addRoute(emptyPacketRegistry(), { name: 'img', method: 'GET', path: '/img', sizeVariance: 0.8 })
    expect(route.sizeVariance).toBe(0.8)
  })

  it('updateRoute patches sizeVariance and round-trips through getRoute', () => {
    const { registry, route } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    const reg2 = updateRoute(registry, routeIdOf(route), { sizeVariance: 1.2 })
    expect(getRoute(reg2, routeIdOf(route))).toMatchObject({ sizeVariance: 1.2 })
  })
})

// ─── Packet library: the registry's second view (pathless templates, any protocol) ───────────
const dbFields = (over: Partial<DbTemplate> = {}) => ({
  name: 'query', protocol: 'db' as const, sizeKb: 1, queryType: 'read' as const, isWAL: false,
  resultSizeKb: 64, ...over,
})

describe('packet library helpers over the same PacketRegistry', () => {
  it('addPacket assigns from the SAME monotonic id space as addRoute', () => {
    const { registry: reg1 } = addRoute(emptyPacketRegistry(), { name: 'api', method: 'GET', path: '/api' })
    const { registry: reg2, packet } = addPacket(reg1, dbFields())
    expect(packet.id).toBe(2)
    expect(reg2.nextId).toBe(3)
  })

  it('listPackets returns pathless templates of every protocol, id-sorted', () => {
    let reg = emptyPacketRegistry()
    reg = addRoute(reg, { name: 'route', method: 'GET', path: '/api' }).registry
    reg = addPacket(reg, dbFields({ name: 'db-read' })).registry
    reg = addPacket(reg, { name: 'evt', protocol: 'event', sizeKb: 2, topic: 't', eventType: 'x', deliveryMode: 'at-least-once' }).registry
    reg = addPacket(reg, { name: 'blob', protocol: 'http', sizeKb: 5000, method: 'PUT', statusCode: 200 }).registry
    expect(listPackets(reg).map(p => p.name)).toEqual(['db-read', 'evt', 'blob'])
  })

  it('the two views are disjoint — a route never shows up as a packet and vice versa', () => {
    let reg = emptyPacketRegistry()
    reg = addRoute(reg, { name: 'route', method: 'GET', path: '/api' }).registry
    const { registry, packet } = addPacket(reg, dbFields())
    expect(listRoutes(registry).map(r => r.name)).toEqual(['route'])
    expect(listPackets(registry).map(p => p.name)).toEqual(['query'])
    expect(getRoute(registry, String(packet.id))).toBeUndefined()
    expect(getPacket(registry, 1)).toBeUndefined()
  })

  it('updatePacket replaces the shape wholesale so a protocol switch strands no fields', () => {
    const { registry, packet } = addPacket(emptyPacketRegistry(), dbFields())
    const reg2 = updatePacket(registry, packet.id, {
      name: 'now-a-stream', protocol: 'stream', sizeKb: 9, streamId: 's1', compressionType: 'gzip',
    })
    const updated = getPacket(reg2, packet.id)
    expect(updated).toEqual({ id: packet.id, name: 'now-a-stream', protocol: 'stream', sizeKb: 9, streamId: 's1', compressionType: 'gzip' })
    expect(updated).not.toHaveProperty('queryType')
  })

  it('removePacket deletes it; duplicatePacket deep-copies under a fresh id', () => {
    const { registry, packet } = addPacket(emptyPacketRegistry(), dbFields({ colorOverride: '#ff0000' }))
    const dup = duplicatePacket(registry, packet.id, 'query (copy)')
    expect(dup).not.toBeNull()
    expect(dup!.packet.id).toBe(packet.id + 1)
    expect(dup!.packet).toMatchObject({ name: 'query (copy)', colorOverride: '#ff0000', protocol: 'db' })
    expect(getPacket(removePacket(dup!.registry, packet.id), packet.id)).toBeUndefined()
    expect(duplicatePacket(registry, 999, 'nope')).toBeNull()
  })
})

describe('routeMatchesPattern (glob prefix, first-match is the caller job)', () => {
  it('wildcard-all patterns match anything', () => {
    expect(routeMatchesPattern('/anything', '*')).toBe(true)
    expect(routeMatchesPattern('/anything', '/*')).toBe(true)
  })

  it('/prefix/* matches the prefix and its children but not a sibling with a shared stem', () => {
    expect(routeMatchesPattern('/api', '/api/*')).toBe(true)
    expect(routeMatchesPattern('/api/users', '/api/*')).toBe(true)
    expect(routeMatchesPattern('/apix', '/api/*')).toBe(false)
    expect(routeMatchesPattern('/static/a.js', '/api/*')).toBe(false)
  })

  it('bare-star suffix is a plain prefix match', () => {
    expect(routeMatchesPattern('/assets/x', '/assets*')).toBe(true)
  })

  it('exact patterns require equality', () => {
    expect(routeMatchesPattern('/health', '/health')).toBe(true)
    expect(routeMatchesPattern('/health/live', '/health')).toBe(false)
  })
})

// Type guard sanity: PacketRegistry stays structurally what nodeConfig declares.
const _typecheck: PacketRegistry = emptyPacketRegistry()
void _typecheck
