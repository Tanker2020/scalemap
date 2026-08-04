import { interRegionLatencyMs } from '../regionConfig'

export type ReplicaLocality = 'same-az' | 'cross-az' | 'cross-region'

const SAME_AZ_FLOOR_SEC = 0.005
const CROSS_AZ_FLOOR_SEC = 0.02
const WRITE_APPLY_EFFICIENCY = 0.7
const EPSILON = 1e-6

export function localityFloorSec(
  locality: ReplicaLocality,
  fromRegionId?: string,
  toRegionId?: string,
): number {
  if (locality === 'same-az') return SAME_AZ_FLOOR_SEC
  if (locality === 'cross-az') return CROSS_AZ_FLOOR_SEC
  if (!fromRegionId || !toRegionId) return CROSS_AZ_FLOOR_SEC
  return interRegionLatencyMs(fromRegionId, toRegionId) / 1000
}

export interface ReplicaRef {
  id: string
  locality: ReplicaLocality
  applyCapacity: number   // writes/sec this replica can apply
  fromRegionId?: string
  toRegionId?: string
}

export interface ReplicationState {
  backlogWritesByInstance: Map<string, number>
  lagSecByInstance: Map<string, number>
}

export function createReplicationState(): ReplicationState {
  return { backlogWritesByInstance: new Map(), lagSecByInstance: new Map() }
}

export function stepReplication(
  state: ReplicationState,
  replicasByCluster: Record<string, ReplicaRef[]>,
  writeRpsByCluster: Record<string, number>,
  stepSec: number,
): void {
  for (const [clusterId, replicas] of Object.entries(replicasByCluster)) {
    const writeRps = writeRpsByCluster[clusterId] ?? 0
    for (const replica of replicas) {
      const prevBacklog = state.backlogWritesByInstance.get(replica.id) ?? 0
      const delta = (writeRps - replica.applyCapacity) * stepSec
      const nextBacklog = Math.max(0, prevBacklog + delta)
      state.backlogWritesByInstance.set(replica.id, nextBacklog)
      const floor = localityFloorSec(replica.locality, replica.fromRegionId, replica.toRegionId)
      const lagSec = nextBacklog / Math.max(replica.applyCapacity, EPSILON) + floor
      state.lagSecByInstance.set(replica.id, lagSec)
    }
  }
}

export function staleReadFraction(writeRps: number, lagSec: number, hotKeyCount: number): number {
  if (lagSec <= 0 || writeRps <= 0) return 0
  return 1 - Math.exp(-(writeRps * lagSec) / Math.max(hotKeyCount, 1))
}

export const WRITE_APPLY_EFFICIENCY_CONST = WRITE_APPLY_EFFICIENCY
