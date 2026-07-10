import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import type { AnalysisFinding } from '../types'
import type { FirewallRule } from '../../world/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)
const run = (s: ReturnType<typeof scenario>) => runAnalysis(s.doc, s.compile(), null)
const allowAny = (port: number): FirewallRule => ({ id: `fw-open-${port}`, action: 'allow', port, protocol: 'tcp', source: 'any' })

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
})
