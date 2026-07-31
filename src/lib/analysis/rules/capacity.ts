// Capacity/geo analysis rules (Phase 6 D2). Pure. Distance via regionGeo.greatCircleKm (lib→lib;
// the single cited distance source per design D2 — NOT a local haversine, NOT app-layer geo.ts).
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { CompiledWorld, ServiceInstance, WorldDoc } from '../../world/types'
import { DEFAULT_HEALTH_CHECK_TIMEOUT_MS } from '../../world/types'
import { REGION_GEO, greatCircleKm } from '../../world/regionGeo'
import { getPreset } from '../../world/instanceCatalog'

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
  run: ({ doc, compiled, lastBatch }) => {
    const byServer = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const a = byServer.get(inst.serverId) ?? []; a.push(inst); byServer.set(inst.serverId, a)
    }
    const out: AnalysisFinding[] = []
    for (const [serverId, insts] of byServer) {
      const server = doc.servers[serverId]; if (!server) continue
      const reserved = reservedRamMb(serverId, doc, compiled)
      // Live per-connection RAM growth (audit ISSUE-066): ramPerConnMb × activeConnections from
      // the latest batch, for UNCAPPED instances only — a container's memLimit already bounds
      // (and OOM-kills) its own growth, so its limit IS its worst case and is counted above.
      let liveConnRam = 0
      if (lastBatch) {
        for (const inst of insts) {
          const pl = doc.placements[inst.placementId]
          if (pl?.runtime.type === 'container' && pl.runtime.memLimitMb != null) continue
          const perConn = doc.blueprints[inst.blueprintId]?.workload.ramPerConnMb ?? 0
          liveConnRam += perConn * (lastBatch.instances?.[inst.id]?.activeConnections ?? 0)
        }
      }
      const sum = reserved + liveConnRam
      if (sum <= server.specs.ramMb) continue
      const liveNote = liveConnRam > 0 ? ` (${Math.round(liveConnRam)} MB of it live per-connection growth)` : ''
      out.push({
        id: `ram-oversubscribed:${serverId}`, ruleId: 'ram-oversubscribed', family: 'capacity', severity: 'warning',
        title: 'Host RAM oversubscribed',
        why: `RAM demand on ${server.label} totals ${Math.round(sum)} MB${liveNote} but the host only has ${server.specs.ramMb} MB; instances will contend and may OOM.`,
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
      // Per-instance credit baseline (audit ISSUE-067): a t3.micro-class box drains credits far
      // below the old hardcoded 40% while a bigger burstable is fine well above it — read the
      // preset's baselineUtilization; 0.4 stays the fallback for custom/unknown specs.
      const baseline = (server.catalogId ? getPreset(server.catalogId)?.baselineUtilization : undefined) ?? 0.4
      if (mean <= baseline) continue
      out.push({
        id: `burstable-sustained-load:${server.id}`, ruleId: 'burstable-sustained-load', family: 'capacity', severity: 'warning',
        title: 'Sustained load on a burstable VPS',
        why: `Burstable VPS ${server.label} is averaging ${(mean * 100).toFixed(0)}% CPU (> its ${(baseline * 100).toFixed(0)}% credit baseline); it will drain its CPU credits and throttle.`,
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
    // Policy guard (audit ISSUE-062): the km-based check only judges DISTANCE-driven policies.
    // Under `weighted`/`priority` the operator deliberately chose the ordering (a 70/30 split or
    // an explicit priority chain can legitimately put a far region first) — flagging that is a
    // false positive on intent, not a design smell.
    if (doc.routing.policy === 'weighted' || doc.routing.policy === 'priority') return []
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

// audit ISSUE-010: total failover time ≈ detection window + up to one TTL, so a SHORT TTL is
// healthy (clients re-resolve promptly once the failure is detected). The anti-pattern is a TTL
// that OUTLIVES detection: clients keep serving the stale cached region long after the failure
// is known. (The original rule had this inverted — it flagged the healthy config and its fix
// text recommended raising the TTL, which worsens real failover.)
const ttlOutlivesDetection: AnalysisRule = {
  id: 'ttl-outlives-detection', family: 'capacity',
  run: ({ doc }) => {
    const { dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold } = doc.routing
    const ttlMs = dnsTtlSec * 1000
    // Real detection includes one probe TIMEOUT on top of interval × threshold (audit
    // ISSUE-061): the last failing probe must itself time out before the threshold trips.
    const timeoutMs = doc.routing.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS
    const detectMs = healthCheckIntervalMs * healthCheckFailureThreshold + timeoutMs
    if (ttlMs <= detectMs) return []
    return [{
      id: 'ttl-outlives-detection:world', ruleId: 'ttl-outlives-detection', family: 'capacity', severity: 'warning',
      title: 'DNS TTL outlives failure detection',
      why: `DNS TTL is ${ttlMs} ms but failure detection takes only ${detectMs} ms (${healthCheckIntervalMs} ms × ${healthCheckFailureThreshold} + ${timeoutMs} ms probe timeout); clients keep resolving to a failed region for up to a full TTL after the failure is detected, so failover lags behind detection.`,
      fix: `Lower dnsTtlSec below the detection window so clients re-resolve promptly after failover (Traffic panel → routing).`,
      affected: [],
    }]
  },
}

// Audit ISSUE-002: the event broker's async decoupling means a struggling consumer no longer
// trips the producer's breaker — but that also means a consumer falling behind is otherwise
// invisible unless something surfaces it. `lagSec` (worldEngine/broker.ts, published on
// `MetricsBatch.topics`) is exactly that signal: a consumer draining slower than its topic fills.
const CONSUMER_LAG_THRESHOLD_SEC = 5

const consumerLagBehindProducer: AnalysisRule = {
  id: 'consumer-lag-behind-producer', family: 'capacity',
  run: ({ doc, lastBatch }) => {
    if (!lastBatch?.topics) return []
    const out: AnalysisFinding[] = []
    for (const [depId, topic] of Object.entries(lastBatch.topics)) {
      if (!Number.isFinite(topic.lagSec) || topic.lagSec <= CONSUMER_LAG_THRESHOLD_SEC) continue
      const bp = Object.values(doc.blueprints).find(b => b.dependencies.some(d => d.id === depId))
      const dep = bp?.dependencies.find(d => d.id === depId)
      const targetBp = dep?.target.kind === 'blueprint' ? doc.blueprints[dep.target.blueprintId] : undefined
      out.push({
        id: `consumer-lag-behind-producer:${depId}`, ruleId: 'consumer-lag-behind-producer', family: 'capacity', severity: 'warning',
        title: 'Consumer falling behind producer',
        why: `${bp?.name ?? 'A service'}'s event topic${targetBp ? ` to ${targetBp.name}` : ''} is ${topic.lagSec.toFixed(1)}s behind — the backlog (${Math.round(topic.backlogCount)} messages) is growing faster than the consumer drains it (${topic.drainRps.toFixed(1)} rps vs ${topic.totalArrivalRps.toFixed(1)} rps arriving).`,
        fix: `Scale the consumer, or raise its capacity/reduce its cpuMsPerRequest (Blueprints panel).`,
        affected: [bp?.id, depId].filter((x): x is string => !!x),
      })
    }
    return out
  },
}

export const capacityRules: AnalysisRule[] = [
  ramOversubscribed, burstableSustainedLoad, oceanCrossingPopulation, ttlOutlivesDetection,
  consumerLagBehindProducer,
]
