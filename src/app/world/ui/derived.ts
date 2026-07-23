// Pure derived-consequence math for the hybrid panel kit (Polish 1 D2). Panels never inline
// this arithmetic — they call these. No store imports, no React.
import type {
  WorldDoc, CompiledWorld, RoutingConfig, ClientPopulation, ServiceBlueprint,
} from '../../../lib/world/types'
import { reservedRamMb } from '../../../lib/analysis/rules/capacity'
import { REGION_GEO, greatCircleKm } from '../../../lib/world/regionGeo'
import { egressMonthlyCost } from '../../../lib/cloudRegistry'
import { HOURS_PER_MONTH } from '../../../lib/costModelV2'

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

// The engine's client-entry predicate (worldEngine/index.ts:122-123), reimplemented purely —
// never imported from engine internals (Global Constraints).
export function isEntryBlueprint(bp: ServiceBlueprint): boolean {
  return bp.ports.some(p => p.visibility === 'public')
}

// Total rps the frontline (entry-blueprint placements) can absorb at 100% cpu: Σ
// hostRpsCapacity(host vcpu, blueprint cpuMs) over every placement of an entry blueprint.
// The compiled world is accepted for signature symmetry with its consumers (and future
// instance-count refinements) — the sum itself is authored-doc math.
export function frontlineCapacityRps(doc: WorldDoc, _compiled: CompiledWorld): number {
  let sum = 0
  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server || !isEntryBlueprint(bp)) continue
    sum += hostRpsCapacity(server.specs.vcpu, bp.workload.cpuMsPerRequest)
  }
  return sum
}

// Pure reimplementation of the engine's BYTES_PER_REQUEST_EACH_WAY (worldEngine/flows.ts) —
// never imported from worldEngine (Global Constraints' never-import-engine-internals rule; same
// treatment as POP_LATENCY_KM_PER_MS above).
export const PLACEMENT_BYTES_EACH_WAY = 2048

// costModelV2.ts's SECONDS_PER_MONTH (used to turn a live bytes/sec rate into a monthly GB
// figure) and BYTES_PER_GB are module-private there — mirrored here rather than imported, same
// never-reach-into-a-private-constant treatment as PLACEMENT_BYTES_EACH_WAY. HOURS_PER_MONTH and
// egressMonthlyCost ARE exported, and used directly. Derived as HOURS_PER_MONTH × 3600 to stay
// in lockstep with the cost model's single month basis (audit ISSUE-036).
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600
const BYTES_PER_GB = 1024 ** 3

// What a population placed at `rps` would cost per hour in internet egress — the globe
// placement-mode preview card's math (D9), computed BEFORE the population exists in the doc (so
// it can't route through computeWorldCost's live WorldMetrics). ×2 accounts for each-way traffic
// (PLACEMENT_BYTES_EACH_WAY is already "each way"); the AWS tiered schedule + free allowance
// come from the existing egressMonthlyCost, not duplicated here.
export function placementEgressUsdPerHr(rps: number): number {
  const bytesPerSec = rps * PLACEMENT_BYTES_EACH_WAY * 2
  const gbMonth = (bytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB
  return egressMonthlyCost('aws', gbMonth) / HOURS_PER_MONTH
}
