import { describe, it, expect } from 'vitest'
import {
  emptyPacketRegistry, listRoutes, getRoute, addRoute, updateRoute, removeRoute,
  routeMatchesPattern, routeIdOf,
} from './nodeConfig'
import type { PacketRegistry, EventTemplate } from './nodeConfig'

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
