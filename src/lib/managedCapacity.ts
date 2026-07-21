// src/lib/managedCapacity.ts
// Per-node-type throughput ceilings for cloud-managed services (node-model Phase 5.2).
//
// DB nodes carry their ceiling in the instance class (dbInstanceClasses.ts, via
// worldEngine/flows.ts's managedDbCeilings); every OTHER managed type used to be an infinite sink.
// This gives each a sensible default rps ceiling — overridable per service via
// `ManagedService.capacityRps` — so a queue/cache/object store can actually saturate and refuse.
// Pure: the only import is the type + the DB-engine discriminator.
import { managedDbEngine, type ManagedService } from './world/types'

// Representative sustained-throughput ceilings (requests/sec). Deliberately coarse — this is an
// educational simulation, not a capacity planner. A type absent here is treated as uncapped.
export const MANAGED_DEFAULT_CAPACITY_RPS: Record<string, number> = {
  queue: 5_000,
  eventBus: 10_000,
  pubsub: 10_000,
  stream: 8_000,
  redis: 100_000,
  memcached: 150_000,
  cdn: 1_000_000,
  cdnCache: 1_000_000,
  apiGateway: 10_000,
  lambda: 10_000,
  objectStorage: 5_500,
  fileStorage: 3_000,
  dns: 1_000_000,
  firewall: 50_000,
  loadBalancer: 100_000,
  vpn: 2_000,
}

// The effective flat throughput ceiling (rps) for a NON-DB managed service: the user override if
// set (> 0), else the per-type default, else Infinity (a type we don't cap). DB nodes return
// `null` — their ceiling is the instance-class write/read split (managedDbCeilings), not one flat
// number — so callers know to use the DB path instead.
export function managedCapacityRps(ms: ManagedService): number | null {
  if (managedDbEngine(ms.nodeType)) return null
  if (ms.capacityRps != null && ms.capacityRps > 0) return ms.capacityRps
  return MANAGED_DEFAULT_CAPACITY_RPS[ms.nodeType] ?? Number.POSITIVE_INFINITY
}
