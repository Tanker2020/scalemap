import { describe, it, expect } from 'vitest'
import { splitDependencyShares, managedDbRefusedRps } from './flows'
import type { CompiledPath, ServiceBlueprint, ServiceInstance, InstanceId, ManagedService } from '../world/types'

// Minimal fakes: splitDependencyShares only reads role off instances and kind/engine off the
// target blueprint, so a full compile is unnecessary here (solveFlows integration lives in
// flows.test.ts). Each candidate path targets one instance whose role we control.
function inst(id: string, role: 'primary' | 'replica'): ServiceInstance {
  return { id, blueprintId: 'bp', placementId: 'pl', serverId: 's', azId: 'az', regionId: 'r', role, indexInPlacement: 0 }
}

function path(toId: string): CompiledPath {
  return {
    id: `p-${toId}`, dependencyId: 'dep', fromInstanceId: 'caller',
    to: { kind: 'instance', instanceId: toId },
    hopClass: 'same-az', verdict: 'permitted', blockReason: null,
  }
}

function bp(kind: ServiceBlueprint['kind']): ServiceBlueprint {
  return {
    id: 'bp', name: 'db', color: '#fff', kind,
    workload: { cpuMsPerRequest: 5, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
    ports: [], dependencies: [], stateful: kind.startsWith('db'), volumeName: null,
    dbConfig: kind.startsWith('db') ? { engine: kind === 'db-nosql' ? 'nosql' : 'sql', storageGb: 100 } : null,
    ownerServerKind: kind.startsWith('db') ? (kind as 'db-sql' | 'db-nosql') : null,
  }
}

function build(roles: Array<[string, 'primary' | 'replica']>) {
  const instances: Record<InstanceId, ServiceInstance> = {}
  const candidates: CompiledPath[] = []
  for (const [id, role] of roles) {
    instances[id] = inst(id, role)
    candidates.push(path(id))
  }
  return { instances, candidates }
}

// Sum a share array by target id, so assertions read in terms of "how much reached primary/replica".
function byTarget(candidates: CompiledPath[], shares: number[]): Record<string, number> {
  const out: Record<string, number> = {}
  candidates.forEach((c, i) => {
    if (c.to.kind === 'instance') out[c.to.instanceId] = (out[c.to.instanceId] ?? 0) + shares[i]
  })
  return out
}

describe('splitDependencyShares', () => {
  // Non-DB target: the pre-Phase-3 behavior must be exactly preserved — even split across all
  // candidates, writeFraction ignored. This is what keeps the engine's golden tests unchanged.
  it('splits evenly for a non-DB target regardless of writeFraction', () => {
    const { instances, candidates } = build([['a', 'primary'], ['b', 'primary'], ['c', 'primary']])
    const shares = splitDependencyShares(300, candidates, (id) => instances[id]?.role ?? 'primary', bp('api'), 0.5)
    expect(shares).toEqual([100, 100, 100])
  })

  it('conserves total volume (writes + reads = admitted)', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica'], ['r2', 'replica']])
    const shares = splitDependencyShares(1000, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), 0.2)
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1000)
  })

  // SQL: writes concentrate on the single primary (the emergent single-writer ceiling); reads go
  // to the replicas only, so the primary is spared read load and replicas scale reads.
  it('routes SQL writes to the primary and reads to the replicas', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica'], ['r2', 'replica']])
    const shares = splitDependencyShares(1000, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), 0.3)
    const t = byTarget(candidates, shares)
    // 300 writes → primary; 700 reads split across the two replicas.
    expect(t.p).toBeCloseTo(300)
    expect(t.r1).toBeCloseTo(350)
    expect(t.r2).toBeCloseTo(350)
  })

  // A SQL DB with no replicas must not drop its reads: the primary serves both.
  it('sends SQL reads to the primary when there are no replicas', () => {
    const { instances, candidates } = build([['p', 'primary']])
    const shares = splitDependencyShares(1000, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), 0.3)
    expect(byTarget(candidates, shares).p).toBeCloseTo(1000)
  })

  // NoSQL: every node takes both reads and writes, so total load spreads evenly and adding nodes
  // raises write capacity — no single write bottleneck.
  it('spreads NoSQL reads AND writes across every node', () => {
    const { instances, candidates } = build([['a', 'primary'], ['b', 'replica'], ['c', 'replica'], ['d', 'replica']])
    const shares = splitDependencyShares(1000, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-nosql'), 0.4)
    // Each node: 400 writes / 4 + 600 reads / 4 = 250.
    expect(shares).toEqual([250, 250, 250, 250])
  })

  // A pure-read DB client (writeFraction 0) must not touch the primary when replicas exist.
  it('keeps pure reads off the SQL primary', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica']])
    const shares = splitDependencyShares(500, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), 0)
    const t = byTarget(candidates, shares)
    expect(t.p).toBeCloseTo(0)
    expect(t.r1).toBeCloseTo(500)
  })

  // A pure-write client (writeFraction 1) puts nothing on the replicas.
  it('keeps pure writes off the SQL replicas', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica']])
    const shares = splitDependencyShares(500, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), 1)
    const t = byTarget(candidates, shares)
    expect(t.p).toBeCloseTo(500)
    expect(t.r1).toBeCloseTo(0)
  })

  // writeFraction is clamped, so a malformed value never produces negative or >admitted shares.
  it('clamps writeFraction into [0,1]', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica']])
    const over = splitDependencyShares(500, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), 5)
    expect(byTarget(candidates, over).p).toBeCloseTo(500)   // treated as 1
    const under = splitDependencyShares(500, candidates, (id) => instances[id]?.role ?? 'primary', bp('db-sql'), -2)
    expect(byTarget(candidates, under).r1).toBeCloseTo(500)  // treated as 0
  })
})


// The cloud-managed DB write ceiling: a managed DB has no host, so its capacity comes from the
// chosen instance class. Demand over the ceiling is refused (throttled), like a too-small RDS.
describe('managedDbRefusedRps', () => {
  function db(nodeType: string, instanceClassId: string | null, over: Partial<ManagedService> = {}): ManagedService {
    return { id: 'ms', label: 'db', nodeType, scope: { kind: 'region', regionId: 'r' }, provider: 'aws', port: 5432, instanceClassId, ...over }
  }

  it('refuses nothing when the managed service is not a DB', () => {
    expect(managedDbRefusedRps(9999, 1, db('queue', 'sql.small'))).toBe(0)
  })

  it('refuses nothing when no instance class is set (back-compat: uncapped)', () => {
    expect(managedDbRefusedRps(9999, 1, db('dbSql', null))).toBe(0)
  })

  it('admits writes under the class write ceiling', () => {
    // sql.small writeRps = 500. 300 writes < 500 → nothing refused.
    expect(managedDbRefusedRps(300, 1, db('dbSql', 'sql.small'))).toBeCloseTo(0)
  })

  it('refuses SQL writes above the single-writer ceiling', () => {
    // sql.small writeRps = 500. 800 writes → 300 refused. Reads (0 here) irrelevant.
    expect(managedDbRefusedRps(800, 1, db('dbSql', 'sql.small'))).toBeCloseTo(300)
  })

  // SQL replicas add READ capacity, not write capacity — the single-writer ceiling is unmoved.
  it('does not raise the SQL write ceiling with replicas', () => {
    expect(managedDbRefusedRps(800, 1, db('dbSql', 'sql.small', { replicaCount: 3 }))).toBeCloseTo(300)
  })

  // NoSQL scales writes with nodes: 2 replicas → 3 nodes → 3× the per-node ceiling.
  it('raises the NoSQL write ceiling with nodes', () => {
    // nosql.small writeRps = 1000/node. 3 nodes → 3000 ceiling. 2500 writes → 0 refused.
    expect(managedDbRefusedRps(2500, 1, db('dbNoSql', 'nosql.small', { replicaCount: 2 }))).toBeCloseTo(0)
    // 3500 writes → 500 refused.
    expect(managedDbRefusedRps(3500, 1, db('dbNoSql', 'nosql.small', { replicaCount: 2 }))).toBeCloseTo(500)
  })

  it('refuses reads above the read ceiling (replicas raise it)', () => {
    // sql.small readRps = 2500. Pure reads (w=0) of 6000 with 1 replica → ceiling 5000 → 1000 refused.
    expect(managedDbRefusedRps(6000, 0, db('dbSql', 'sql.small', { replicaCount: 1 }))).toBeCloseTo(1000)
  })

  it('sums write and read overflow independently', () => {
    // sql.small: writeRps 500, readRps 2500. 1000 total, w=0.6 → 600 writes / 400 reads.
    // writes 600 > 500 → 100 refused; reads 400 < 2500 → 0. Total 100.
    expect(managedDbRefusedRps(1000, 0.6, db('dbSql', 'sql.small'))).toBeCloseTo(100)
  })
})
