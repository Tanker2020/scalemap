// Capacity/geo analysis rules (Phase 6 D2). Pure. Distance via regionGeo.greatCircleKm (lib→lib;
// the single cited distance source per design D2 — NOT a local haversine, NOT app-layer geo.ts).
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { CompiledWorld, ServiceInstance, WorldDoc } from '../../world/types'
import { REGION_GEO, greatCircleKm } from '../../world/regionGeo'

// Reserved RAM on a server: Σ (container memLimitMb ?? blueprint ramBaseMb) over resident
// instances. Shared with the panel kit's derived hints (src/app/world/ui/derived.ts).
export function reservedRamMb(serverId: string, doc: WorldDoc, compiled: CompiledWorld): number {
  let sum = 0
  for (const inst of Object.values(compiled.instances)) {
    if (inst.serverId !== serverId) continue
    const pl = doc.placements[inst.placementId]
    const memLimit = pl?.runtime.type === 'container' ? pl.runtime.memLimitMb : null
    sum += memLimit ?? doc.blueprints[inst.blueprintId]?.workload.ramBaseMb ?? 0
  }
  return sum
}

const ramOversubscribed: AnalysisRule = {
  id: 'ram-oversubscribed', family: 'capacity',
  run: ({ doc, compiled }) => {
    const byServer = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const a = byServer.get(inst.serverId) ?? []; a.push(inst); byServer.set(inst.serverId, a)
    }
    const out: AnalysisFinding[] = []
    for (const [serverId, insts] of byServer) {
      const server = doc.servers[serverId]; if (!server) continue
      const sum = reservedRamMb(serverId, doc, compiled)
      if (sum <= server.specs.ramMb) continue
      out.push({
        id: `ram-oversubscribed:${serverId}`, ruleId: 'ram-oversubscribed', family: 'capacity', severity: 'warning',
        title: 'Host RAM oversubscribed',
        why: `Reserved RAM on ${server.label} totals ${sum} MB but the host only has ${server.specs.ramMb} MB; instances will contend and may OOM.`,
        fix: `Lower container memory limits, move instances off ${server.label}, or use a larger host (Placements / Server view).`,
        affected: [serverId, ...insts.map(i => i.id)],
      })
    }
    return out
  },
}

const burstableSustainedLoad: AnalysisRule = {
  id: 'burstable-sustained-load', family: 'capacity',
  run: ({ doc, lastBatch }) => {
    if (!lastBatch) return []
    const out: AnalysisFinding[] = []
    for (const server of Object.values(doc.servers)) {
      if (!server.burstable) continue
      const util = lastBatch.servers[server.id]?.coreUtilization
      if (!util || util.length === 0) continue
      const mean = util.reduce((a, b) => a + b, 0) / util.length
      if (mean <= 0.4) continue
      out.push({
        id: `burstable-sustained-load:${server.id}`, ruleId: 'burstable-sustained-load', family: 'capacity', severity: 'warning',
        title: 'Sustained load on a burstable VPS',
        why: `Burstable VPS ${server.label} is averaging ${(mean * 100).toFixed(0)}% CPU (> 40%); it will drain its CPU credits and throttle.`,
        fix: `Move this workload to a non-burstable instance or a larger host (Placements panel).`,
        affected: [server.id],
      })
    }
    return out
  },
}

const oceanCrossingPopulation: AnalysisRule = {
  id: 'ocean-crossing-population', family: 'capacity',
  run: ({ doc, compiled }) => {
    const regions = Object.values(doc.regions)
    if (regions.length < 2) return []
    const out: AnalysisFinding[] = []
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      if (order.length === 0) continue
      const firstId = order[0]
      const firstGeo = REGION_GEO[doc.regions[firstId]?.catalogId ?? '']
      if (!firstGeo) continue
      const firstKm = greatCircleKm(pop.lat, pop.lon, firstGeo.lat, firstGeo.lon)
      let nearestId = firstId, nearestKm = firstKm
      for (const region of regions) {
        const geo = REGION_GEO[region.catalogId]; if (!geo) continue
        const km = greatCircleKm(pop.lat, pop.lon, geo.lat, geo.lon)
        if (km < nearestKm) { nearestKm = km; nearestId = region.id }
      }
      if (nearestId === firstId || firstKm <= 1.5 * nearestKm) continue
      const fn = doc.regions[firstId]?.catalogId ?? firstId
      const nn = doc.regions[nearestId]?.catalogId ?? nearestId
      out.push({
        id: `ocean-crossing-population:${pop.id}`, ruleId: 'ocean-crossing-population', family: 'capacity', severity: 'warning',
        title: 'Population routed across an ocean',
        why: `${pop.label} routes first to ${fn} (${Math.round(firstKm)} km) when ${nn} (${Math.round(nearestKm)} km) is far nearer; needless latency.`,
        fix: `Adjust routing policy/weights or add capacity in ${nn} so ${pop.label} lands closer (Traffic panel).`,
        affected: [pop.id, firstId, nearestId],
      })
    }
    return out
  },
}

const ttlOutlivesDetection: AnalysisRule = {
  id: 'ttl-outlives-detection', family: 'capacity',
  run: ({ doc }) => {
    const { dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold } = doc.routing
    const ttlMs = dnsTtlSec * 1000
    const detectMs = healthCheckIntervalMs * healthCheckFailureThreshold
    if (ttlMs >= detectMs) return []
    return [{
      id: 'ttl-outlives-detection:world', ruleId: 'ttl-outlives-detection', family: 'capacity', severity: 'warning',
      title: 'DNS TTL shorter than failure detection',
      why: `DNS TTL is ${ttlMs} ms but failure detection takes ${detectMs} ms (${healthCheckIntervalMs} ms × ${healthCheckFailureThreshold}); clients re-resolve faster than a failed region is detected, so failover lags.`,
      fix: `Raise dnsTtlSec above the detection window, or lower the health-check interval/threshold (Traffic panel → routing).`,
      affected: [],
    }]
  },
}

export const capacityRules: AnalysisRule[] = [
  ramOversubscribed, burstableSustainedLoad, oceanCrossingPopulation, ttlOutlivesDetection,
]
