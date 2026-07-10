import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import type { AnalysisFinding } from '../types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)
const run = (s: ReturnType<typeof scenario>) => runAnalysis(s.doc, s.compile(), null)

describe('structural: single-az-region', () => {
  it('fires when every instance of a region is in one AZ', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id); const bp = s.blueprint('web'); s.placement(bp.id, srv.id)
    const f = ids(run(s), 'single-az-region')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warning')
    expect(f[0].affected).toEqual([r.id, az.id])
  })
  it('silent when the region spans two AZs', () => {
    const s = scenario()
    const r = s.region('us-east-1')
    const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const bp = s.blueprint('web')
    s.placement(bp.id, s.server(a1.id).id); s.placement(bp.id, s.server(a2.id).id)
    expect(ids(run(s), 'single-az-region')).toHaveLength(0)
  })
})

describe('structural: no-failover-region', () => {
  it('fires (critical) for a population with a single-region order', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    s.placement(s.blueprint('web').id, s.server(az.id).id)
    const pop = s.population('nyc', 40.7, -74)
    const f = ids(run(s), 'no-failover-region')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].affected).toEqual([pop.id, r.id])
  })
  it('silent when the population has two regions to route to', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.population('nyc', 40.7, -74)
    expect(ids(run(s), 'no-failover-region')).toHaveLength(0)
  })
})

describe('structural: replicas-colocated', () => {
  it('fires when a stateful primary and all replicas share an AZ', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s1.id) // primary by default
    const rep = s.placement(db.id, s2.id); rep.role = 'replica'
    const f = ids(run(s), 'replicas-colocated')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(db.id)
    expect(f[0].affected[1]).toBe(az.id)
  })
  it('silent when a replica lives in another AZ', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)
    const rep = s.placement(db.id, s.server(a2.id).id); rep.role = 'replica'
    expect(ids(run(s), 'replicas-colocated')).toHaveLength(0)
  })
})

describe('structural: dependency-cycle', () => {
  it('fires on a two-blueprint cycle', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b')
    a.dependencies = [dep('d1', b.id, 'http')]
    b.dependencies = [dep('d2', a.id, 'http')]
    const f = ids(run(s), 'dependency-cycle')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(new Set(f[0].affected)).toEqual(new Set([a.id, b.id]))
  })
  it('silent on an acyclic chain', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b')
    a.dependencies = [dep('d1', b.id, 'http')]
    expect(ids(run(s), 'dependency-cycle')).toHaveLength(0)
  })
  it('gives disjoint cycles sharing a node distinct ids', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b'); const c = s.blueprint('c')
    a.dependencies = [dep('d1', b.id, 'http'), dep('d2', c.id, 'http')]
    b.dependencies = [dep('d3', a.id, 'http')]  // cycle a↔b
    c.dependencies = [dep('d4', a.id, 'http')]  // cycle a↔c
    const f = ids(run(s), 'dependency-cycle')
    expect(f).toHaveLength(2)
    expect(new Set(f.map(x => x.id)).size).toBe(2) // distinct ids, no collision
  })
})

describe('structural: deep-sync-chain', () => {
  it('fires on a 4-hop http/db chain', () => {
    const s = scenario()
    const bps = ['a', 'b', 'c', 'd', 'e'].map(n => s.blueprint(n))
    for (let i = 0; i < bps.length - 1; i++) bps[i].dependencies = [dep(`d${i}`, bps[i + 1].id, 'http')]
    const f = ids(run(s), 'deep-sync-chain')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toHaveLength(5)
  })
  it('silent on a 2-hop chain', () => {
    const s = scenario()
    const a = s.blueprint('a'); const b = s.blueprint('b'); const c = s.blueprint('c')
    a.dependencies = [dep('d1', b.id, 'http')]; b.dependencies = [dep('d2', c.id, 'db')]
    expect(ids(run(s), 'deep-sync-chain')).toHaveLength(0)
  })
})

describe('structural: unused-managed-service', () => {
  it('fires (info) for a managed service no dependency targets', () => {
    const s = scenario()
    s.doc.managedServices['ms1'] = { id: 'ms1', label: 'cache', nodeType: 'redis', scope: { kind: 'region', regionId: 'r' }, provider: 'aws', port: 6379 }
    const f = ids(run(s), 'unused-managed-service')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('info')
    expect(f[0].affected).toEqual(['ms1'])
  })
  it('silent when a blueprint depends on it', () => {
    const s = scenario()
    s.doc.managedServices['ms1'] = { id: 'ms1', label: 'cache', nodeType: 'redis', scope: { kind: 'region', regionId: 'r' }, provider: 'aws', port: 6379 }
    const a = s.blueprint('a')
    a.dependencies = [{ id: 'd1', target: { kind: 'managed', managedServiceId: 'ms1' }, port: 6379, protocol: 'db', packetTemplateId: null }]
    expect(ids(run(s), 'unused-managed-service')).toHaveLength(0)
  })
})

describe('runAnalysis ordering + id stability', () => {
  it('orders by severity then family', () => {
    const s = scenario()
    // critical (dependency-cycle) + warning (single-az-region) + info (unused-managed-service)
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    s.placement(s.blueprint('web').id, s.server(az.id).id)   // single-az-region (warning)
    const a = s.blueprint('a'); const b = s.blueprint('b')
    a.dependencies = [dep('d1', b.id, 'http')]; b.dependencies = [dep('d2', a.id, 'http')] // cycle (critical)
    s.doc.managedServices['ms1'] = { id: 'ms1', label: 'cache', nodeType: 'redis', scope: { kind: 'region', regionId: r.id }, provider: 'aws', port: 6379 } // unused (info)
    const sevs = run(s).map(f => f.severity)
    const firstCrit = sevs.indexOf('critical'); const firstWarn = sevs.indexOf('warning'); const firstInfo = sevs.indexOf('info')
    expect(firstCrit).toBeLessThan(firstWarn)
    expect(firstWarn).toBeLessThan(firstInfo)
  })
  it('produces stable finding ids across two runs', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    s.placement(s.blueprint('web').id, s.server(az.id).id)
    const compiled = s.compile()
    const a1 = runAnalysis(s.doc, compiled, null).map(f => f.id)
    const a2 = runAnalysis(s.doc, compiled, null).map(f => f.id)
    expect(a1).toEqual(a2)
  })
})
