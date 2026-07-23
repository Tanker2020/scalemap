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

// ── Per-class base latency + load-dependent queueing (audit ISSUE-037) ──────────────────────
// Every non-DB managed service used to book one flat 3 ms regardless of type or load — a cache
// hit and an object-store GET are an order of magnitude apart, and a saturated queue should
// visibly slow down. Same coarse-but-honest register as the capacity table above. DB nodes are
// NOT served from here: their latency comes from the instance-class failure model
// (managedDbRuntime.ts); a type absent from this table keeps the historical 3 ms.
export const MANAGED_BASE_LATENCY_MS: Record<string, number> = {
  queue: 5,
  eventBus: 6,
  pubsub: 6,
  stream: 8,
  redis: 0.5,
  memcached: 0.4,
  cdn: 8,
  cdnCache: 8,
  apiGateway: 5,
  lambda: 15,
  objectStorage: 15,
  fileStorage: 10,
  dns: 1,
  firewall: 1,
  loadBalancer: 1,
  vpn: 12,
}

// Mirrors worldEngine/flows.ts's MANAGED_SERVICE_LATENCY_MS (3) — repeated here as a literal
// because importing it would invert the layering (flows.ts imports this module).
const DEFAULT_MANAGED_LATENCY_MS = 3

// Documented tail spread for the coarse managed model (a DB's runtime carries its own p99).
export const MANAGED_P99_OVER_P50 = 3

export function managedBaseLatencyMs(nodeType: string): number {
  return MANAGED_BASE_LATENCY_MS[nodeType] ?? DEFAULT_MANAGED_LATENCY_MS
}

// Load-dependent service latency: M/M/1-shaped queueing multiplier `base / (1 − ρ)` on the
// class base, ρ capped at 0.95 so a saturated service reads ~20× base rather than diverging.
export function managedLatencyMs(nodeType: string, utilization: number): number {
  const rho = Math.min(0.95, Math.max(0, utilization))
  return managedBaseLatencyMs(nodeType) / (1 - rho)
}
