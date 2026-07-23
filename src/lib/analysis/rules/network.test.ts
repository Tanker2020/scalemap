import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import { createLoadBalancer } from '../../world/factories'
import { addRoute, routeIdOf } from '../../nodeConfig'
import type { AnalysisFinding } from '../types'
import type { FirewallRule } from '../../world/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)
const run = (s: ReturnType<typeof scenario>) => runAnalysis(s.doc, s.compile(), null)
const allowAny = (port: number): FirewallRule => ({ id: `fw-open-${port}`, action: 'allow', port, protocol: 'tcp', source: 'any' })
const allowFrom = (port: number, source: string): FirewallRule => ({ id: `fw-open-${port}`, action: 'allow', port, protocol: 'tcp', source })

describe('network: blocked-dependency-path', () => {
  it('fires for a firewall-denied cross-server path and names the rule in the fix', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    // web (process) → db (process on s2) over port 5432, but s2's firewall denies 5432.
    s2.firewall = [{ id: 'deny-5432', action: 'deny', port: 5432, protocol: 'tcp', source: 'internal' }, ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'blocked-dependency-path')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].id.startsWith('blocked-dependency-path:')).toBe(true)
    expect(f[0].fix).toMatch(/firewall/i)
  })
  it('silent when the path is permitted', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const api = s.blueprint('api', 1)
    api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-api', api.id, 'http', 8080)]
    s.placement(web.id, s1.id); s.placement(api.id, s1.id) // localhost → permitted
    expect(ids(run(s), 'blocked-dependency-path')).toHaveLength(0)
  })
})

describe('network: db-port-exposed', () => {
  it('fires when a db target server allows the port from any source', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowAny(5432), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(s2.id)
  })
  // Audit ISSUE-068: sub-rule (b) is placement-gated — an UNPLACED blueprint with a public db
  // port is a design sketch, not a live "critical" exposure; placing it makes it one.
  it('stays silent for an unplaced public-port db blueprint until it is placed (ISSUE-068)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id)   // db NOT placed anywhere
    expect(ids(run(s), 'db-port-exposed').some(x => x.affected[0] === db.id)).toBe(false)
    s.placement(db.id, s1.id)    // now it's live
    expect(ids(run(s), 'db-port-exposed').some(x => x.affected[0] === db.id)).toBe(true)
  })
  it('fires via public visibility even without a firewall hole', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }] // public db port
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s1.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.some(x => x.affected[0] === db.id)).toBe(true)
  })
  // audit ISSUE-011: '0.0.0.0/0' (and '::/0') IS the entire internet — a valid CIDR
  // FirewallSource that must be treated exactly like the literal 'any'.
  it('fires when a db target server allows the port from 0.0.0.0/0', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowFrom(5432, '0.0.0.0/0'), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(s2.id)
  })
  it('fires for the IPv6 ::/0 form as well', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowFrom(5432, '::/0'), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    expect(ids(run(s), 'db-port-exposed').length).toBeGreaterThanOrEqual(1)
  })
  it('silent for a db target behind the default internal firewall', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s1.id)
    expect(ids(run(s), 'db-port-exposed')).toHaveLength(0)
  })
})

describe('network: entry-unreachable', () => {
  it('fires for a public port with no hosting server allowing it from any', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id) // default firewall: source 'internal', not 'any'
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const f = ids(run(s), 'entry-unreachable')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(web.id)
  })
  it('silent once a hosting server allows the port from any', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); s1.firewall = [allowAny(443), ...s1.firewall]
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    expect(ids(run(s), 'entry-unreachable')).toHaveLength(0)
  })
  // audit ISSUE-011: a public port reachable via 0.0.0.0/0 is reachable — no false positive.
  it('silent when a hosting server allows the port from 0.0.0.0/0', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); s1.firewall = [allowFrom(443, '0.0.0.0/0'), ...s1.firewall]
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    expect(ids(run(s), 'entry-unreachable')).toHaveLength(0)
  })
})

describe('network: lb-listener-target-absent', () => {
  it('fires when an L7 listener rule points at a service with no instance in the region', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const api = s.blueprint('api', 0); api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    const ghost = s.blueprint('ghost', 1); ghost.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(api.id, s1.id)   // ghost intentionally NOT placed
    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'rg', pathPattern: '/ghost/*', targetBlueprintId: ghost.id }]
    s.doc.loadBalancers[lb.id] = lb
    const f = ids(run(s), 'lb-listener-target-absent')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toContain(ghost.id)
    expect(f[0].why).toMatch(/ghost/i)
  })

  it('silent when the rule target is present, or the LB is L4', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const api = s.blueprint('api', 0); api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(api.id, s1.id)
    const lb = createLoadBalancer(r.id)   // L4 with an authored rule → no L7 semantics, no finding
    lb.listenerRules = [{ id: 'ra', pathPattern: '/api/*', targetBlueprintId: api.id }]
    s.doc.loadBalancers[lb.id] = lb
    expect(ids(run(s), 'lb-listener-target-absent')).toHaveLength(0)
  })
})

describe('network: lb-route-dropped', () => {
  it('fires for a request-mix route matching no listener rule with no default action', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const added = addRoute(s.doc.packets, { name: 'health', method: 'GET', path: '/health/live' })
    s.doc.packets = added.registry
    const pop = s.population('nyc', 40.7, -74.0)
    pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'ra', pathPattern: '/api/*', targetBlueprintId: web.id }]
    lb.defaultTargetBlueprintId = 'bp-absent'   // default resolves to no in-region instance ⇒ empty
    s.doc.loadBalancers[lb.id] = lb
    const f = ids(run(s), 'lb-route-dropped')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toContain(pop.id)
    expect(f[0].why).toMatch(/health/i)
  })

  it('silent when a default action exists to catch the unmatched route', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const added = addRoute(s.doc.packets, { name: 'health', method: 'GET', path: '/health/live' })
    s.doc.packets = added.registry
    const pop = s.population('nyc', 40.7, -74.0)
    pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'ra', pathPattern: '/api/*', targetBlueprintId: web.id }]
    // defaultTargetBlueprintId null ⇒ default = present entry blueprints (web) ⇒ non-empty
    s.doc.loadBalancers[lb.id] = lb
    expect(ids(run(s), 'lb-route-dropped')).toHaveLength(0)
  })
})
