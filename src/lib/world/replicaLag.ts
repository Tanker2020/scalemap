// src/lib/world/replicaLag.ts
// FEAT-005 (Task 15): the ONE place a UI component resolves "what cluster is this replica
// instance in, and what is that cluster's live replication lag" — read by ServerBoard.tsx's
// ServiceChip readout and DatacenterFloor.tsx's RackCabinet/FreePoolPod readout (the same two
// call sites Task 7 wired for the cache hit-ratio readout), so the two views can't drift on how
// a replica's cluster is identified.
//
// clusterId convention and primary-selection tiebreak (same-region primary preferred, else the
// first primary sorted by id) are copied verbatim from worldEngine/index.ts's
// `buildReplicationIndexes` — this file does NOT own that convention, it mirrors it for a
// read-only UI lookup. If that convention ever changes, this must change with it.
import type { CompiledWorld, ServiceInstance } from './types'
import type { MetricsBatch } from '../worldEngine/types'

/**
 * The live replication lag (seconds) of the cluster `inst` belongs to, or null when `inst`
 * isn't a replica, has no resolvable primary, or the batch has no lag data for its cluster yet.
 */
export function replicaClusterLagSec(
  inst: ServiceInstance, compiled: CompiledWorld, batch: MetricsBatch | null,
): number | null {
  if (inst.role !== 'replica' || !batch?.clusters) return null
  const primaries = Object.values(compiled.instances)
    .filter(i => i.role === 'primary' && i.blueprintId === inst.blueprintId)
  if (primaries.length === 0) return null
  const primary = primaries.find(p => p.regionId === inst.regionId)
    ?? [...primaries].sort((a, b) => a.id.localeCompare(b.id))[0]
  const clusterId = `${primary.blueprintId}|${primary.regionId}`
  return batch.clusters[clusterId]?.lagSec ?? null
}
