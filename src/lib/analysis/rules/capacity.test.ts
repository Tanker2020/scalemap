import { describe, it, expect } from 'vitest'
import { scenario } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import { greatCircleKm } from '../../world/regionGeo'
import type { AnalysisFinding } from '../types'
import type { MetricsBatch } from '../../worldEngine/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)

// Minimal batch stub — the capacity rules read only servers[id].coreUtilization.
function batchWith(serverId: string, util: number[]): MetricsBatch {
  return { servers: { [serverId]: { coreUtilization: util } } } as unknown as MetricsBatch
}

describe('capacity: ram-oversubscribed', () => {
  it('fires when reserved RAM exceeds the host and names both numbers', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id) // dedicated-8 → 32768 MB
    const bp = s.blueprint('web')
    const pl = s.placement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 40000 }
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ram-oversubscribed')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(srv.id)
    expect(f[0].why).toMatch(/40000/); expect(f[0].why).toMatch(/32768/)
  })
  it('silent when reserved RAM fits', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id); const bp = s.blueprint('web')
    const pl = s.placement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 1000 }
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ram-oversubscribed')).toHaveLength(0)
  })
})

describe('capacity: burstable-sustained-load', () => {
  it('fires when a burstable VPS averages > 40% CPU', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small') // burstable
    s.placement(s.blueprint('web').id, srv.id)
    const f = ids(runAnalysis(s.doc, s.compile(), batchWith(srv.id, [0.5, 0.5])), 'burstable-sustained-load')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([srv.id])
  })
  it('silent below the 40% threshold', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small')
    s.placement(s.blueprint('web').id, srv.id)
    expect(ids(runAnalysis(s.doc, s.compile(), batchWith(srv.id, [0.2, 0.2])), 'burstable-sustained-load')).toHaveLength(0)
  })
  it('silent with a null batch', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const srv = s.server(az.id, 'vps-small')
    s.placement(s.blueprint('web').id, srv.id)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'burstable-sustained-load')).toHaveLength(0)
  })
})

describe('capacity: ocean-crossing-population', () => {
  it('fires when the first region is > 1.5× the nearest', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.doc.routing.policy = 'priority'
    s.doc.routing.priorityOrder = [r1.id, r2.id] // forces us-east-1 first for a London pop
    const pop = s.population('london', 51.5, -0.1)
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ocean-crossing-population')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([pop.id, r1.id, r2.id])
  })
  it('silent when the nearest region is first', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); s.az(r2.id, 'eu-west-1a')
    s.doc.routing.policy = 'priority'
    s.doc.routing.priorityOrder = [r2.id, r1.id]
    s.population('london', 51.5, -0.1)
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ocean-crossing-population')).toHaveLength(0)
  })
  it('haversine sanity: NYC→London ≈ 5570 km (±2%)', () => {
    const km = greatCircleKm(40.7, -74, 51.5, -0.1)
    expect(km).toBeGreaterThan(5570 * 0.98)
    expect(km).toBeLessThan(5570 * 1.02)
  })
})

// audit ISSUE-010: the rule was inverted. Total failover time ≈ detection window + up to one
// TTL, so a SHORT TTL is healthy; the anti-pattern is a TTL that OUTLIVES detection (clients
// keep serving a stale cached record long after the failure is known).
describe('capacity: ttl-outlives-detection', () => {
  it('fires when the DNS TTL outlives the failure-detection window', () => {
    const s = scenario()
    s.doc.routing.dnsTtlSec = 300 // 300000ms > 10000×3 = 30000ms — stale cache dominates failover
    const f = ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([])
    expect(f[0].id).toBe('ttl-outlives-detection:world')
    expect(f[0].why).toMatch(/300000/); expect(f[0].why).toMatch(/30000/)
    expect(f[0].fix).toMatch(/lower/i)
  })
  it('silent when the TTL is below the detection window (short TTL is healthy)', () => {
    const s = scenario()
    s.doc.routing.dnsTtlSec = 5 // 5000ms < 30000ms — clients re-resolve promptly after detection
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(0)
  })
  it('silent at the default TTL/detection balance', () => {
    const s = scenario() // dnsTtlSec 30 → 30000ms == 30000ms detection, not >
    expect(ids(runAnalysis(s.doc, s.compile(), null), 'ttl-outlives-detection')).toHaveLength(0)
  })
})
