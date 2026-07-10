// Pure derived-consequence math for the hybrid panel kit (Polish 1 D2). Panels never inline
// this arithmetic — they call these. No store imports, no React.
import type { WorldDoc, CompiledWorld, RoutingConfig } from '../../../lib/world/types'
import { reservedRamMb } from '../../../lib/analysis/rules/capacity'

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
