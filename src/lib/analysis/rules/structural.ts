// Structural analysis rules (Phase 6 D2). Pure; read doc + compiled only.
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { ServiceInstance, WorldDoc } from '../../world/types'

// blueprint→blueprint edges (optionally protocol-filtered) present in the world.
function blueprintEdges(doc: WorldDoc, protocols?: Array<'http' | 'db' | 'event' | 'stream'>): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const bp of Object.values(doc.blueprints)) {
    const targets: string[] = []
    for (const d of bp.dependencies) {
      if (d.target.kind !== 'blueprint') continue
      if (protocols && !protocols.includes(d.protocol)) continue
      if (doc.blueprints[d.target.blueprintId]) targets.push(d.target.blueprintId)
    }
    adj.set(bp.id, targets)
  }
  return adj
}

const singleAzRegion: AnalysisRule = {
  id: 'single-az-region', family: 'structural',
  run: ({ doc, compiled }) => {
    const azsByRegion = new Map<string, Set<string>>()
    for (const inst of Object.values(compiled.instances)) {
      const set = azsByRegion.get(inst.regionId) ?? new Set<string>()
      set.add(inst.azId); azsByRegion.set(inst.regionId, set)
    }
    const out: AnalysisFinding[] = []
    for (const [regionId, azs] of azsByRegion) {
      if (azs.size !== 1) continue
      const azId = [...azs][0]
      const rn = doc.regions[regionId]?.catalogId ?? regionId
      const an = doc.azs[azId]?.label ?? azId
      out.push({
        id: `single-az-region:${regionId}`, ruleId: 'single-az-region', family: 'structural', severity: 'warning',
        title: 'Single-AZ region',
        why: `Every instance in region ${rn} lives in a single AZ (${an}); one AZ outage takes the whole region down.`,
        fix: `Place replicas of these workloads in another AZ of ${rn} (Placements panel).`,
        affected: [regionId, azId],
      })
    }
    return out
  },
}

const noFailoverRegion: AnalysisRule = {
  id: 'no-failover-region', family: 'structural',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const pop of Object.values(doc.populations)) {
      const order = compiled.routing.populationRegionOrder[pop.id] ?? []
      if (order.length !== 1) continue
      const regionId = order[0]
      const rn = doc.regions[regionId]?.catalogId ?? regionId
      // Population-scoped ⇒ critical (skeleton: "warning; critical when the world has populations" —
      // a live population with a single-region order is a real geographic SPOF).
      out.push({
        id: `no-failover-region:${pop.id}`, ruleId: 'no-failover-region', family: 'structural', severity: 'critical',
        title: 'No failover region',
        why: `Population ${pop.label} routes only to ${rn} with no failover region; a regional outage drops its traffic entirely.`,
        fix: `Add a second active region and place entry workloads there so ${pop.label} can fail over (Topology + Placements).`,
        affected: [pop.id, regionId],
      })
    }
    return out
  },
}

const replicasColocated: AnalysisRule = {
  id: 'replicas-colocated', family: 'structural',
  run: ({ doc, compiled }) => {
    const byBp = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const a = byBp.get(inst.blueprintId) ?? []; a.push(inst); byBp.set(inst.blueprintId, a)
    }
    const out: AnalysisFinding[] = []
    for (const [bpId, insts] of byBp) {
      const bp = doc.blueprints[bpId]
      if (!bp?.stateful) continue
      const primaries = insts.filter(i => i.role === 'primary')
      const replicas = insts.filter(i => i.role === 'replica')
      if (primaries.length === 0 || replicas.length === 0) continue
      const primaryAz = primaries[0].azId
      if (!replicas.every(r => r.azId === primaryAz)) continue
      const an = doc.azs[primaryAz]?.label ?? primaryAz
      const instIds = [...primaries.filter(p => p.azId === primaryAz), ...replicas].map(i => i.id)
      out.push({
        id: `replicas-colocated:${bpId}`, ruleId: 'replicas-colocated', family: 'structural', severity: 'warning',
        title: 'Replicas co-located with primary',
        why: `Stateful ${bp.name}'s primary and all ${replicas.length} replica(s) share AZ ${an}; losing that AZ loses every copy.`,
        fix: `Move at least one ${bp.name} replica to a different AZ (Placements panel).`,
        affected: [bpId, primaryAz, ...instIds],
      })
    }
    return out
  },
}

const dependencyCycle: AnalysisRule = {
  id: 'dependency-cycle', family: 'structural',
  run: ({ doc }) => {
    const adj = blueprintEdges(doc)
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    const stack: string[] = []
    const seen = new Set<string>()
    const out: AnalysisFinding[] = []
    const emit = (cycle: string[]) => {
      let min = 0
      for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[min]) min = i
      const rot = [...cycle.slice(min), ...cycle.slice(0, min)]
      const key = rot.join('>')
      if (seen.has(key)) return
      seen.add(key)
      const names = rot.map(id => doc.blueprints[id]?.name ?? id)
      out.push({
        id: `dependency-cycle:${key}`, ruleId: 'dependency-cycle', family: 'structural', severity: 'critical',
        title: 'Dependency cycle',
        why: `Blueprints form a dependency cycle: ${names.join(' → ')} → ${names[0]}. Requests can loop and failures cascade.`,
        fix: `Break the cycle by removing or inverting one dependency (Blueprints panel).`,
        affected: rot,
      })
    }
    const dfs = (u: string) => {
      color.set(u, GRAY); stack.push(u)
      for (const v of adj.get(u) ?? []) {
        if (color.get(v) === GRAY) {
          const idx = stack.indexOf(v)
          if (idx >= 0) emit(stack.slice(idx))
        } else if ((color.get(v) ?? WHITE) === WHITE) {
          dfs(v)
        }
      }
      stack.pop(); color.set(u, BLACK)
    }
    for (const id of adj.keys()) if ((color.get(id) ?? WHITE) === WHITE) dfs(id)
    return out
  },
}

const deepSyncChain: AnalysisRule = {
  id: 'deep-sync-chain', family: 'structural',
  run: ({ doc }) => {
    const adj = blueprintEdges(doc, ['http', 'db'])
    let best: string[] = []
    const dfs = (u: string, path: string[], visited: Set<string>) => {
      if (path.length > best.length) best = [...path]
      for (const v of adj.get(u) ?? []) {
        if (visited.has(v)) continue
        visited.add(v); dfs(v, [...path, v], visited); visited.delete(v)
      }
    }
    for (const id of adj.keys()) dfs(id, [id], new Set([id]))
    if (best.length - 1 < 4) return []
    const names = best.map(id => doc.blueprints[id]?.name ?? id)
    return [{
      id: `deep-sync-chain:${best[0]}`, ruleId: 'deep-sync-chain', family: 'structural', severity: 'warning',
      title: 'Deep synchronous chain',
      why: `A synchronous http/db call chain is ${best.length - 1} hops deep: ${names.join(' → ')}. Latency and failure risk compound with depth.`,
      fix: `Introduce async messaging or caching to shorten the critical path (Blueprints panel).`,
      affected: best,
    }]
  },
}

const unusedManagedService: AnalysisRule = {
  id: 'unused-managed-service', family: 'structural',
  run: ({ doc }) => {
    const targeted = new Set<string>()
    for (const bp of Object.values(doc.blueprints))
      for (const d of bp.dependencies)
        if (d.target.kind === 'managed') targeted.add(d.target.managedServiceId)
    const out: AnalysisFinding[] = []
    for (const ms of Object.values(doc.managedServices)) {
      if (targeted.has(ms.id)) continue
      out.push({
        id: `unused-managed-service:${ms.id}`, ruleId: 'unused-managed-service', family: 'structural', severity: 'info',
        title: 'Unused managed service',
        why: `Managed service ${ms.label} is not the target of any blueprint dependency; it bills but serves no traffic.`,
        fix: `Wire a blueprint dependency to ${ms.label} or remove it (Placements panel).`,
        affected: [ms.id],
      })
    }
    return out
  },
}

export const structuralRules: AnalysisRule[] = [
  singleAzRegion, noFailoverRegion, replicasColocated, dependencyCycle, deepSyncChain, unusedManagedService,
]
