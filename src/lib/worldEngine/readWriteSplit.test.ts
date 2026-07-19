import { describe, it, expect } from 'vitest'
import { splitDependencyShares } from './flows'
import type { CompiledPath, ServiceBlueprint, ServiceInstance, InstanceId } from '../world/types'

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
    const shares = splitDependencyShares(300, candidates, instances, bp('api'), 0.5)
    expect(shares).toEqual([100, 100, 100])
  })

  it('conserves total volume (writes + reads = admitted)', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica'], ['r2', 'replica']])
    const shares = splitDependencyShares(1000, candidates, instances, bp('db-sql'), 0.2)
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1000)
  })

  // SQL: writes concentrate on the single primary (the emergent single-writer ceiling); reads go
  // to the replicas only, so the primary is spared read load and replicas scale reads.
  it('routes SQL writes to the primary and reads to the replicas', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica'], ['r2', 'replica']])
    const shares = splitDependencyShares(1000, candidates, instances, bp('db-sql'), 0.3)
    const t = byTarget(candidates, shares)
    // 300 writes → primary; 700 reads split across the two replicas.
    expect(t.p).toBeCloseTo(300)
    expect(t.r1).toBeCloseTo(350)
    expect(t.r2).toBeCloseTo(350)
  })

  // A SQL DB with no replicas must not drop its reads: the primary serves both.
  it('sends SQL reads to the primary when there are no replicas', () => {
    const { instances, candidates } = build([['p', 'primary']])
    const shares = splitDependencyShares(1000, candidates, instances, bp('db-sql'), 0.3)
    expect(byTarget(candidates, shares).p).toBeCloseTo(1000)
  })

  // NoSQL: every node takes both reads and writes, so total load spreads evenly and adding nodes
  // raises write capacity — no single write bottleneck.
  it('spreads NoSQL reads AND writes across every node', () => {
    const { instances, candidates } = build([['a', 'primary'], ['b', 'replica'], ['c', 'replica'], ['d', 'replica']])
    const shares = splitDependencyShares(1000, candidates, instances, bp('db-nosql'), 0.4)
    // Each node: 400 writes / 4 + 600 reads / 4 = 250.
    expect(shares).toEqual([250, 250, 250, 250])
  })

  // A pure-read DB client (writeFraction 0) must not touch the primary when replicas exist.
  it('keeps pure reads off the SQL primary', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica']])
    const shares = splitDependencyShares(500, candidates, instances, bp('db-sql'), 0)
    const t = byTarget(candidates, shares)
    expect(t.p).toBeCloseTo(0)
    expect(t.r1).toBeCloseTo(500)
  })

  // A pure-write client (writeFraction 1) puts nothing on the replicas.
  it('keeps pure writes off the SQL replicas', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica']])
    const shares = splitDependencyShares(500, candidates, instances, bp('db-sql'), 1)
    const t = byTarget(candidates, shares)
    expect(t.p).toBeCloseTo(500)
    expect(t.r1).toBeCloseTo(0)
  })

  // writeFraction is clamped, so a malformed value never produces negative or >admitted shares.
  it('clamps writeFraction into [0,1]', () => {
    const { instances, candidates } = build([['p', 'primary'], ['r1', 'replica']])
    const over = splitDependencyShares(500, candidates, instances, bp('db-sql'), 5)
    expect(byTarget(candidates, over).p).toBeCloseTo(500)   // treated as 1
    const under = splitDependencyShares(500, candidates, instances, bp('db-sql'), -2)
    expect(byTarget(candidates, under).r1).toBeCloseTo(500)  // treated as 0
  })
})
