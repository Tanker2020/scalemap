// Pure derived-consequence math for the hybrid panel kit (Polish 1 D2). Panels never inline
// this arithmetic — they call these. No store imports, no React.
import type { WorldDoc, CompiledWorld, RoutingConfig, ClientPopulation } from '../../../lib/world/types'
import { reservedRamMb } from '../../../lib/analysis/rules/capacity'
import { REGION_GEO, greatCircleKm } from '../../../lib/world/regionGeo'

export function rpsPerCore(cpuMsPerRequest: number): number {
  if (!Number.isFinite(cpuMsPerRequest) || cpuMsPerRequest <= 0) return 0
  return 1000 / cpuMsPerRequest
}

export function hostRpsCapacity(vcpu: number, cpuMsPerRequest: number): number {
  if (!Number.isFinite(vcpu) || vcpu <= 0) return 0
  return vcpu * rpsPerCore(cpuMsPerRequest)
}

export function ramAtConnections(baseMb: number, perConnMb: number, conns = 2000): number {
  return baseMb + perConnMb * conns
}

// Σ resident (memLimitMb ?? workload.ramBaseMb) — the SAME quantity the ram-oversubscribed
// analysis rule sums; shared via reservedRamMb rather than duplicated (skeleton T1).
export function residentRamDemandMb(serverId: string, doc: WorldDoc, compiled: CompiledWorld): number {
  return reservedRamMb(serverId, doc, compiled)
}

// Mirrors ttl-outlives-detection's inequality (capacity.ts:93-108), phrased as a hint before
// it becomes a finding: null when TTL ≥ detection window.
export function ttlLagHint(routing: RoutingConfig): string | null {
  const ttlMs = routing.dnsTtlSec * 1000
  const detectMs = routing.healthCheckIntervalMs * routing.healthCheckFailureThreshold
  if (ttlMs >= detectMs) return null
  return `⚠ ttl ${routing.dnsTtlSec}s < detection ${detectMs / 1000}s — clients re-resolve before the failure is even detected`
}

export function diskIoWord(diskIoPerRequest: number): 'light' | 'moderate' | 'heavy' {
  if (diskIoPerRequest < 0.5) return 'light'
  if (diskIoPerRequest < 2) return 'moderate'
  return 'heavy'
}

// Plain-words health for a server row (spec D7a): worst of the two pressure fractions.
export function healthWord(cpuFraction: number, ramFraction: number): 'comfortable' | 'tight' | 'straining' {
  const worst = Math.max(cpuFraction, ramFraction)
  if (worst < 0.70) return 'comfortable'
  if (worst < 0.90) return 'tight'
  return 'straining'
}

// Pure reimplementation of the engine's client→region latency convention
// (worldEngine/networkRuntime.ts INTERNET_KM_PER_MS = 100, "~1ms per 100km great-circle") —
// never imported from worldEngine (Global Constraints).
export const POP_LATENCY_KM_PER_MS = 100

// Where a population's traffic lands: the first region in the compiled policy order (the
// same order resolveRegion consumes), with a great-circle latency estimate. Null when no
// route resolves (no regions, or a region whose catalogId has no geo entry).
export function populationLanding(
  pop: ClientPopulation, doc: WorldDoc, compiled: CompiledWorld,
): { regionCatalogId: string; latencyMs: number } | null {
  const first = compiled.routing.populationRegionOrder[pop.id]?.[0]
  const region = first ? doc.regions[first] : undefined
  const geo = region ? REGION_GEO[region.catalogId] : undefined
  if (!region || !geo) return null
  return {
    regionCatalogId: region.catalogId,
    latencyMs: Math.round(greatCircleKm(pop.lat, pop.lon, geo.lat, geo.lon) / POP_LATENCY_KM_PER_MS),
  }
}
