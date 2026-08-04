import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import type { AnalysisFinding } from '../types'
import type { MetricsBatch } from '../../worldEngine/types'

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
  it('silent when the population has two SERVABLE regions to route to', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); const a2 = s.az(r2.id, 'eu-west-1a')
    const web = s.blueprint('web')
    s.placement(web.id, s.server(a1.id).id)
    s.placement(web.id, s.server(a2.id).id)
    s.population('nyc', 40.7, -74)
    expect(ids(run(s), 'no-failover-region')).toHaveLength(0)
  })

  // Audit ISSUE-025: a second EMPTY region is not failover — the check counts regions that
  // actually host entry capacity, not authored regions.
  it('fires when a second region exists but hosts no entry capacity', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    s.region('eu-west-1')   // authored but empty — cannot serve failover
    const web = s.blueprint('web')
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s.server(a1.id).id)
    const pop = s.population('nyc', 40.7, -74)
    const f = ids(run(s), 'no-failover-region')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].affected).toEqual([pop.id, r1.id])
  })

  it('clears once a real entry instance lands in the second region', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); const a2 = s.az(r2.id, 'eu-west-1a')
    const web = s.blueprint('web')
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s.server(a1.id).id)
    s.placement(web.id, s.server(a2.id).id)
    s.population('nyc', 40.7, -74)
    expect(ids(run(s), 'no-failover-region')).toHaveLength(0)
  })

  // An internal-only helper placed in region B does NOT make B servable — only entry capacity does.
  it('still fires when the second region hosts only non-entry workloads', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); const a2 = s.az(r2.id, 'eu-west-1a')
    const web = s.blueprint('web')
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s.server(a1.id).id)
    const worker = s.blueprint('worker')   // internal ports only (factory default)
    s.placement(worker.id, s.server(a2.id).id)
    s.population('nyc', 40.7, -74)
    expect(ids(run(s), 'no-failover-region')).toHaveLength(1)
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

  // Audit ISSUE-026: PARTIAL colocation fires too — 2 of 3 replicas sharing the primary's AZ is
  // still a SPOF for those copies, even though one replica is safely elsewhere.
  it('fires when 2 of 3 replicas share the primary AZ (partial colocation)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)                                   // primary in a1
    const r1 = s.placement(db.id, s.server(a1.id).id); r1.role = 'replica'   // colocated
    const r2 = s.placement(db.id, s.server(a1.id).id); r2.role = 'replica'   // colocated
    const r3 = s.placement(db.id, s.server(a2.id).id); r3.role = 'replica'   // safe
    const f = ids(run(s), 'replicas-colocated')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(db.id)
    expect(f[0].affected[1]).toBe(a1.id)
    expect(f[0].affected.length).toBe(2 + 3)   // bp + az + the 3 colocated copies (not the safe one)
  })

  it('fires per colocated AZ with multiple primaries in different AZs', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)                                   // primary in a1
    s.placement(db.id, s.server(a2.id).id)                                   // primary in a2
    const r1 = s.placement(db.id, s.server(a2.id).id); r1.role = 'replica'   // colocated with p2
    const f = ids(run(s), 'replicas-colocated')
    expect(f).toHaveLength(1)
    expect(f[0].affected[1]).toBe(a2.id)   // the OTHER primary's AZ — not just primaries[0]'s
  })

  it('silent when copies are fully spread across AZs', () => {
    const s = scenario()
    const r = s.region('us-east-1')
    const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b'); const a3 = s.az(r.id, 'us-east-1c')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)
    const r1 = s.placement(db.id, s.server(a2.id).id); r1.role = 'replica'
    const r2 = s.placement(db.id, s.server(a3.id).id); r2.role = 'replica'
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

// Audit ISSUE-010: a dependency whose target blueprint has zero instances gets zero compiled
// paths and produces zero traffic/cost — previously silent (looks like a healthy, idle source).
describe('structural: dangling-dependency-no-targets', () => {
  it('fires when the target blueprint has no placements at all', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a'); const sv = s.server(az.id)
    const api = s.blueprint('api')
    const target = s.blueprint('target')   // authored, but never placed anywhere
    api.dependencies = [dep('d1', target.id, 'http')]
    s.placement(api.id, sv.id)
    const f = ids(run(s), 'dangling-dependency-no-targets')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('warning')
    expect(f[0].affected).toEqual([api.id, 'd1'])
  })

  it('does not fire when the dependency resolves to a real instance', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a'); const sv = s.server(az.id)
    const api = s.blueprint('api')
    const target = s.blueprint('target')
    api.dependencies = [dep('d1', target.id, 'http')]
    s.placement(api.id, sv.id)
    s.placement(target.id, sv.id)   // now the target has a real instance
    expect(ids(run(s), 'dangling-dependency-no-targets')).toHaveLength(0)
  })

  it('does not fire for a managed-service target (compileWorld already gates a missing service)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a'); const sv = s.server(az.id)
    const api = s.blueprint('api')
    api.dependencies = [{ id: 'd1', target: { kind: 'managed', managedServiceId: 'no-such-service' }, port: 6379, protocol: 'db', packetTemplateId: null }]
    s.placement(api.id, sv.id)
    expect(ids(run(s), 'dangling-dependency-no-targets')).toHaveLength(0)
  })

  it('does not fire for a blueprint with no instances of its own', () => {
    const s = scenario()
    const api = s.blueprint('api')   // never placed
    const target = s.blueprint('target')
    api.dependencies = [dep('d1', target.id, 'http')]
    expect(ids(run(s), 'dangling-dependency-no-targets')).toHaveLength(0)
  })
})

describe('structural: split-brain-risk', () => {
  it('fires when two effective primaries exist in one blueprintId|regionId cluster', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    const p1 = s.placement(db.id, s.server(a1.id).id)   // primary by default
    const p2 = s.placement(db.id, s.server(a2.id).id); p2.role = 'primary'   // second primary, same cluster
    const f = ids(run(s), 'split-brain-risk')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].affected).toHaveLength(2)
    expect(f[0].affected.some(id => id.startsWith(p1.id))).toBe(true)
    expect(f[0].affected.some(id => id.startsWith(p2.id))).toBe(true)
  })
  it('does not fire with exactly one primary per cluster', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)   // primary by default
    const rep = s.placement(db.id, s.server(a2.id).id); rep.role = 'replica'
    expect(ids(run(s), 'split-brain-risk')).toHaveLength(0)
  })
  // Audit final-review I2: previously an accepted "known gap" — clustered by
  // `${blueprintId}|${regionId}`, so two primaries in different regions never shared a cluster and
  // FEAT-002's actual cross-region self-promotion (primary in region A untouched + self-promoted
  // replica in region B) went completely undetected. Widened to cluster by blueprintId alone, but
  // (see the rule's own file comment) the cross-region case additionally requires promotion
  // EVIDENCE — some instance's AUTHORED role isn't 'primary' — to avoid false-firing on an
  // intentionally-authored active-active design (the vault's own multi-region-failover example
  // authors a primary per active region, sharing one blueprintId, with no promotion involved).
  // This fixture models the genuine case: region1's db is an authored primary, region2's db is an
  // authored REPLICA that a live batch reports as a self-promoted effective primary.
  it('fires for a genuine cross-region split-brain: an authored primary in region1 + a self-promoted (lastBatch) former replica in region2 (was a known gap — I2 fix)', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); const a2 = s.az(r2.id, 'eu-west-1a')
    const db = s.blueprint('db'); db.stateful = true
    const primary = s.placement(db.id, s.server(a1.id).id)               // authored primary, region 1
    const replica = s.placement(db.id, s.server(a2.id).id); replica.role = 'replica'   // authored replica, region 2
    const compiled = s.compile()
    const primaryInstanceId = Object.values(compiled.instances).find(i => i.placementId === primary.id)!.id
    const replicaInstanceId = Object.values(compiled.instances).find(i => i.placementId === replica.id)!.id
    // Sanity: with no lastBatch (authored roles only), this is a healthy cross-region primary +
    // replica pair — not split-brain.
    expect(runAnalysis(s.doc, compiled, null).some(f => f.ruleId === 'split-brain-risk')).toBe(false)

    const batch = {
      instances: {
        [primaryInstanceId]: { effectiveRole: 'primary' },
        [replicaInstanceId]: { effectiveRole: 'primary' },   // self-promoted in region2 — genuine cross-region split-brain
      },
    } as unknown as MetricsBatch
    const f = ids(runAnalysis(s.doc, compiled, batch), 'split-brain-risk')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual(expect.arrayContaining([primaryInstanceId, replicaInstanceId]))
    expect(f[0].why).toMatch(/across regions/)
  })

  // Audit final-review I2 regression guard: an intentionally-authored active-active topology (two
  // DIFFERENT regions each with their own authored 'primary' for the same blueprint, no promotion
  // anywhere) must NOT trip the widened rule — this is exactly the vault's multi-region-failover
  // example world's shape (a `db` primary+replica pair per active region), and the widened
  // blueprintId-only key would false-positive on it without the promotion-evidence guard.
  it('does NOT fire for an intentionally-authored active-active pair (two authored primaries, different regions, no promotion) — regression guard for I2', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); const a2 = s.az(r2.id, 'eu-west-1a')
    const db = s.blueprint('db'); db.stateful = true
    s.placement(db.id, s.server(a1.id).id)   // authored primary, region 1
    const p2 = s.placement(db.id, s.server(a2.id).id); p2.role = 'primary'   // authored primary, region 2 — active-active by design
    expect(ids(run(s), 'split-brain-risk')).toHaveLength(0)
  })

  // Review fix: the rule must detect a LIVE partition-induced promotion, not just a hand-authored
  // double-primary. A real promotion never touches the doc/compiled role (failover.ts's
  // promoteReplicas only mutates the engine's internal promotedAt map) — it surfaces ONLY through
  // MetricsBatch.instances[id].effectiveRole (metrics.ts's buildBatch, fed by index.ts's memoized
  // roleResolver). This fixture keeps the AUTHORED roles exactly as a healthy primary+replica pair
  // (compiled.instances[replica].role === 'replica') and asserts the rule still fires once the
  // published batch reports the replica as an effective primary — proving the rule reads
  // lastBatch.effectiveRole, not just the static compiled role.
  it('fires when lastBatch reports a live promotion (effectiveRole), even though the authored roles are a normal primary+replica pair', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    const primary = s.placement(db.id, s.server(a1.id).id)              // authored primary
    const replica = s.placement(db.id, s.server(a2.id).id); replica.role = 'replica'   // authored replica
    const compiled = s.compile()
    const primaryInstanceId = Object.values(compiled.instances).find(i => i.placementId === primary.id)!.id
    const replicaInstanceId = Object.values(compiled.instances).find(i => i.placementId === replica.id)!.id
    // Sanity: authored roles are a normal, non-split-brain pair.
    expect(runAnalysis(s.doc, compiled, null).some(f => f.ruleId === 'split-brain-risk')).toBe(false)

    const batch = {
      instances: {
        [primaryInstanceId]: { effectiveRole: 'primary' },
        [replicaInstanceId]: { effectiveRole: 'primary' },   // self-promoted — a live split-brain
      },
    } as unknown as MetricsBatch
    const findings = ids(runAnalysis(s.doc, compiled, batch), 'split-brain-risk')
    expect(findings).toHaveLength(1)
    expect(findings[0].affected).toHaveLength(2)
    expect(findings[0].affected).toEqual(expect.arrayContaining([primaryInstanceId, replicaInstanceId]))
  })

  // Re-review N1: false-positive regression. Same topology as worldEngine/index.test.ts's
  // `sameRegionPlusCrossRegionPrimaryFixture` (C1) and the vault's multi-region-failover example
  // world UNDER a live failover — a same-region primary (P_A) + same-region replica (R_A) in
  // region A, PLUS a SEPARATE, unrelated authored primary (P_B) for the SAME blueprint in region
  // B. P_A goes down and R_A is correctly promoted (ordinary same-region HA failover, NOT a
  // partition or a bug). Before the N1 fix, the coarse guard ("any candidate's authored role !=
  // 'primary' anywhere in the cluster") fired here because R_A's authored role is 'replica' even
  // though R_A has a same-region authored primary sibling (P_A) — this is NOT cross-region
  // split-brain evidence and the rule must stay silent.
  it('does NOT fire for a same-region HA promotion that happens to share a blueprintId with a separate cross-region authored primary (N1 false-positive fix)', () => {
    const s = scenario()
    const r1 = s.region('us-east-1'); const a1 = s.az(r1.id, 'us-east-1a')
    const r2 = s.region('eu-west-1'); const a2 = s.az(r2.id, 'eu-west-1a')
    const db = s.blueprint('db'); db.stateful = true
    const primaryA = s.placement(db.id, s.server(a1.id).id)                // authored primary, region A
    const replicaA = s.placement(db.id, s.server(a1.id).id); replicaA.role = 'replica'   // same-region replica, region A
    const primaryB = s.placement(db.id, s.server(a2.id).id)                // SEPARATE authored primary, region B
    const compiled = s.compile()
    const primaryAIid = Object.values(compiled.instances).find(i => i.placementId === primaryA.id)!.id
    const replicaAIid = Object.values(compiled.instances).find(i => i.placementId === replicaA.id)!.id
    const primaryBIid = Object.values(compiled.instances).find(i => i.placementId === primaryB.id)!.id

    // P_A is down (its server failed) and R_A was correctly promoted — a normal same-region
    // failover. P_B is untouched, still authored+effective primary.
    const batch = {
      instances: {
        [primaryAIid]: { effectiveRole: 'primary' },   // still authored primary, unaffected by this fixture's own health
        [replicaAIid]: { effectiveRole: 'primary' },   // promoted — same-region HA, not split-brain
        [primaryBIid]: { effectiveRole: 'primary' },   // separate, unrelated authored primary
      },
    } as unknown as MetricsBatch
    expect(ids(runAnalysis(s.doc, compiled, batch), 'split-brain-risk')).toHaveLength(0)
  })
})

// FEAT-005 (Task 14): replication-lag-exceeds-rpo — reads lastBatch.clusters (Task 12) against
// the primary blueprint's authored DbConfig.rpoTargetSec (Task 9). clusterId convention is
// `${primaryBlueprintId}|${primaryRegionId}` (index.ts's buildReplicationIndexes).
describe('structural: replication-lag-exceeds-rpo', () => {
  it('fires above the authored target and clears below it', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    db.dbConfig = { engine: 'sql', storageGb: 50, rpoTargetSec: 2 }
    s.placement(db.id, s.server(a1.id).id)   // authored primary
    const rep = s.placement(db.id, s.server(a2.id).id); rep.role = 'replica'
    const compiled = s.compile()
    const clusterId = `${db.id}|${r.id}`

    const overBatch = { clusters: { [clusterId]: { lagSec: 5 } } } as unknown as MetricsBatch
    const over = ids(runAnalysis(s.doc, compiled, overBatch), 'replication-lag-exceeds-rpo')
    expect(over).toHaveLength(1)
    expect(over[0].severity).toBe('warning')
    expect(over[0].affected).toEqual([db.id])

    const underBatch = { clusters: { [clusterId]: { lagSec: 1 } } } as unknown as MetricsBatch
    expect(ids(runAnalysis(s.doc, compiled, underBatch), 'replication-lag-exceeds-rpo')).toHaveLength(0)
  })

  it('is silent when the blueprint has no authored rpoTargetSec', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    db.dbConfig = { engine: 'sql', storageGb: 50 }   // no rpoTargetSec authored
    s.placement(db.id, s.server(a1.id).id)
    const rep = s.placement(db.id, s.server(a2.id).id); rep.role = 'replica'
    const compiled = s.compile()
    const clusterId = `${db.id}|${r.id}`
    const batch = { clusters: { [clusterId]: { lagSec: 999 } } } as unknown as MetricsBatch
    expect(ids(runAnalysis(s.doc, compiled, batch), 'replication-lag-exceeds-rpo')).toHaveLength(0)
  })

  it('is silent with no lastBatch at all', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const a1 = s.az(r.id, 'us-east-1a'); const a2 = s.az(r.id, 'us-east-1b')
    const db = s.blueprint('db'); db.stateful = true
    db.dbConfig = { engine: 'sql', storageGb: 50, rpoTargetSec: 2 }
    s.placement(db.id, s.server(a1.id).id)
    const rep = s.placement(db.id, s.server(a2.id).id); rep.role = 'replica'
    expect(ids(run(s), 'replication-lag-exceeds-rpo')).toHaveLength(0)
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
