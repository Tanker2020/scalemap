// src/lib/world/replicaLag.test.ts
// FEAT-005 (Task 15): replicaClusterLagSec is the ONE place a UI component resolves a replica
// instance's cluster and reads its live lag — mirrors worldEngine/index.ts's
// buildReplicationIndexes clusterId convention (primary blueprintId|primary regionId, same-region
// primary preferred, else lowest id) for a read-only lookup. Instances/CompiledWorld/MetricsBatch
// are hand-built minimal shapes — only the fields this function reads.
import { describe, it, expect } from 'vitest'
import { replicaClusterLagSec } from './replicaLag'
import type { CompiledWorld, ServiceInstance } from './types'
import type { MetricsBatch } from '../worldEngine/types'

function inst(over: Partial<ServiceInstance> & Pick<ServiceInstance, 'id' | 'blueprintId' | 'regionId' | 'role'>): ServiceInstance {
  return {
    placementId: `${over.id}-pl`, serverId: `${over.id}-srv`, azId: `${over.id}-az`, indexInPlacement: 0,
    ...over,
  }
}

function compiledOf(instances: ServiceInstance[]): CompiledWorld {
  const byId: CompiledWorld['instances'] = {}
  for (const i of instances) byId[i.id] = i
  return { instances: byId, paths: [], routing: { permittedByBlueprint: {}, blockedByBlueprint: {}, dnsResolutions: {} } as never, findings: [] }
}

function batchWithClusters(clusters: Record<string, { lagSec: number }>): MetricsBatch {
  return {
    simMs: 0, instances: {}, servers: {}, azs: {}, regions: {},
    world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    clusters,
  }
}

describe('replicaClusterLagSec', () => {
  it('returns null for a non-replica instance', () => {
    const primary = inst({ id: 'p1', blueprintId: 'bp', regionId: 'r1', role: 'primary' })
    const compiled = compiledOf([primary])
    const batch = batchWithClusters({ 'bp|r1': { lagSec: 3 } })
    expect(replicaClusterLagSec(primary, compiled, batch)).toBeNull()
  })

  it('returns null when there is no batch, or the batch has no clusters', () => {
    const replica = inst({ id: 'rep1', blueprintId: 'bp', regionId: 'r1', role: 'replica' })
    const primary = inst({ id: 'p1', blueprintId: 'bp', regionId: 'r1', role: 'primary' })
    const compiled = compiledOf([primary, replica])
    expect(replicaClusterLagSec(replica, compiled, null)).toBeNull()
    const noClusters: MetricsBatch = { ...batchWithClusters({}), clusters: undefined }
    expect(replicaClusterLagSec(replica, compiled, noClusters)).toBeNull()
  })

  it('returns null when no primary of the same blueprint exists', () => {
    const replica = inst({ id: 'rep1', blueprintId: 'bp', regionId: 'r1', role: 'replica' })
    const compiled = compiledOf([replica])
    const batch = batchWithClusters({ 'bp|r1': { lagSec: 3 } })
    expect(replicaClusterLagSec(replica, compiled, batch)).toBeNull()
  })

  it('resolves the same-region primary\'s cluster lag for a same-region replica', () => {
    const primary = inst({ id: 'p1', blueprintId: 'bp', regionId: 'r1', role: 'primary' })
    const replica = inst({ id: 'rep1', blueprintId: 'bp', regionId: 'r1', role: 'replica' })
    const compiled = compiledOf([primary, replica])
    const batch = batchWithClusters({ 'bp|r1': { lagSec: 2.5 } })
    expect(replicaClusterLagSec(replica, compiled, batch)).toBe(2.5)
  })

  it('falls back to the lowest-id primary by id when the replica is cross-region from every primary', () => {
    const primaryB = inst({ id: 'p-b', blueprintId: 'bp', regionId: 'r1', role: 'primary' })
    const primaryA = inst({ id: 'p-a', blueprintId: 'bp', regionId: 'r2', role: 'primary' })
    const replica = inst({ id: 'rep1', blueprintId: 'bp', regionId: 'r3', role: 'replica' })
    const compiled = compiledOf([primaryB, primaryA, replica])
    // Cluster keyed off the LOWEST-id primary (p-a, region r2) per the tiebreak.
    const batch = batchWithClusters({ 'bp|r2': { lagSec: 7 }, 'bp|r1': { lagSec: 99 } })
    expect(replicaClusterLagSec(replica, compiled, batch)).toBe(7)
  })

  it('returns null when the resolved cluster has no lag entry in the batch yet', () => {
    const primary = inst({ id: 'p1', blueprintId: 'bp', regionId: 'r1', role: 'primary' })
    const replica = inst({ id: 'rep1', blueprintId: 'bp', regionId: 'r1', role: 'replica' })
    const compiled = compiledOf([primary, replica])
    const batch = batchWithClusters({ 'other|r9': { lagSec: 1 } })
    expect(replicaClusterLagSec(replica, compiled, batch)).toBeNull()
  })
})
