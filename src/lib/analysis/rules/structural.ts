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
    // Audit ISSUE-025: base the check on SERVABLE regions — regions actually hosting an
    // entry-blueprint instance — not on populationRegionOrder, which regionOrderFor fills with
    // EVERY authored region regardless of capacity (so a second empty region silenced the rule
    // while providing zero failover). A world with no public-port blueprint at all falls back to
    // any-instance regions: without port data, any instance-bearing region is potentially
    // servable, and the geographic-SPOF signal should still fire.
    const entryBpIds = new Set(
      Object.values(doc.blueprints)
        .filter(bp => bp.ports.some(p => p.visibility === 'public'))
        .map(bp => bp.id))
    const servable = new Set<string>()
    for (const inst of Object.values(compiled.instances)) {
      if (entryBpIds.size === 0 || entryBpIds.has(inst.blueprintId)) servable.add(inst.regionId)
    }
    if (servable.size !== 1) return []   // 0 ⇒ nothing serves at all (other rules); ≥2 ⇒ real failover
    const regionId = [...servable][0]
    const rn = doc.regions[regionId]?.catalogId ?? regionId
    const out: AnalysisFinding[] = []
    for (const pop of Object.values(doc.populations)) {
      // Population-scoped ⇒ critical (skeleton: "warning; critical when the world has populations" —
      // a live population whose entry capacity all sits in one region is a real geographic SPOF).
      out.push({
        id: `no-failover-region:${pop.id}`, ruleId: 'no-failover-region', family: 'structural', severity: 'critical',
        title: 'No failover region',
        why: `Population ${pop.label} can only be served from ${rn} — no other region hosts entry capacity, so a regional outage drops its traffic entirely.`,
        fix: `Place entry workloads in a second active region so ${pop.label} can fail over (Topology + Placements).`,
        affected: [pop.id, regionId],
      })
    }
    return out
  },
}

const replicasColocated: AnalysisRule = {
  id: 'replicas-colocated', family: 'structural',
  run: ({ doc, compiled }) => {
    // Audit ISSUE-026: flag EVERY AZ holding ≥2 copies of a stateful blueprint — any subset of
    // colocated copies is a redundancy SPOF. The old check compared all replicas against
    // primaries[0]'s AZ only, so partial colocation (2 of 3 replicas sharing an AZ) and clusters
    // with multiple primaries in different AZs slipped through. Copies count regardless of role:
    // primary+replica, replica+replica, or primary+primary in one AZ all lose together.
    const byBp = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const a = byBp.get(inst.blueprintId) ?? []; a.push(inst); byBp.set(inst.blueprintId, a)
    }
    const out: AnalysisFinding[] = []
    for (const [bpId, insts] of byBp) {
      const bp = doc.blueprints[bpId]
      if (!bp?.stateful || insts.length < 2) continue
      const byAz = new Map<string, ServiceInstance[]>()
      for (const inst of insts) {
        const a = byAz.get(inst.azId) ?? []; a.push(inst); byAz.set(inst.azId, a)
      }
      for (const [azId, colocated] of byAz) {
        if (colocated.length < 2) continue
        const an = doc.azs[azId]?.label ?? azId
        const roles = colocated.map(i => i.role)
        const desc = roles.includes('primary')
          ? `its primary and ${colocated.length - roles.filter(r => r === 'primary').length} replica(s)`
          : `${colocated.length} of its replicas`
        out.push({
          id: `replicas-colocated:${bpId}:${azId}`, ruleId: 'replicas-colocated', family: 'structural', severity: 'warning',
          title: 'Replica copies co-located',
          why: `Stateful ${bp.name} has ${desc} sharing AZ ${an}; losing that AZ loses ${colocated.length} cop${colocated.length === 1 ? 'y' : 'ies'} at once.`,
          fix: `Spread ${bp.name}'s copies so no AZ holds more than one (Placements panel).`,
          affected: [bpId, azId, ...colocated.map(i => i.id)],
        })
      }
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

// Audit ISSUE-010: a dependency whose target blueprint resolves to zero instances gets zero
// compiled paths for it (`compileWorld.ts`'s `instancesByBlueprint.get(targetBpId) ?? []` loop
// runs zero times) — the solver's `flows.ts:566` comment calls this "dangling dep: compile emitted
// nothing" and simply `continue`s, silently. This is distinct from a BLOCKED path, which at least
// produces a `blocked: true` downstream row visible in the UI/analysis — a dangling dependency
// produces nothing at all, so an author sees a healthy, zero-traffic source instance and no
// indication anything is wrong. A static/structural property of the compiled world (does this
// dependency's target blueprint have ANY instance), so it's checked once per unique dependency
// here, not per compiled path or per source instance of the same blueprint.
const danglingDependencyNoTargets: AnalysisRule = {
  id: 'dangling-dependency-no-targets', family: 'structural',
  run: ({ doc, compiled }) => {
    const instanceCountByBlueprint = new Map<string, number>()
    for (const inst of Object.values(compiled.instances)) {
      instanceCountByBlueprint.set(inst.blueprintId, (instanceCountByBlueprint.get(inst.blueprintId) ?? 0) + 1)
    }
    const out: AnalysisFinding[] = []
    for (const bp of Object.values(doc.blueprints)) {
      if (!instanceCountByBlueprint.has(bp.id)) continue   // no instances of the SOURCE blueprint — nothing to flag
      for (const dep of bp.dependencies) {
        if (dep.target.kind !== 'blueprint') continue   // managed targets: compileWorld already skips a missing service
        if ((instanceCountByBlueprint.get(dep.target.blueprintId) ?? 0) > 0) continue
        const targetBp = doc.blueprints[dep.target.blueprintId]
        out.push({
          id: `dangling-dependency-no-targets:${dep.id}`, ruleId: 'dangling-dependency-no-targets', family: 'structural', severity: 'warning',
          title: 'Dependency has no reachable targets',
          why: `${bp.name}'s dependency on ${targetBp?.name ?? dep.target.blueprintId} resolves to zero instances — every call down this edge silently vanishes (no traffic, no cost, no findings past this point).`,
          fix: `Place at least one instance of ${targetBp?.name ?? 'the target blueprint'}, or remove this dependency (Placements panel).`,
          affected: [bp.id, dep.id],
        })
      }
    }
    return out
  },
}

// FEAT-002 (network partitions): a stateful cluster with more than one instance carrying the
// 'primary' role at once is a split-brain risk — usually the result of an asymmetric partition
// that let a replica self-promote (failover.ts's promoteReplicas) while the original primary is
// still up and serving on the other side of the partition. NOTE: `InstanceMetrics` (the
// MetricsBatch per-instance shape in worldEngine/types.ts) carries no `role`/effective-role field
// at all — the promoted-role overlay (`promotedAt`) lives only inside the engine's internal
// FailoverState and is never published to the metrics batch. The only `role` available to a pure
// analysis rule is the AUTHORED `PlacementRole` on the compiled `ServiceInstance`
// (`compiled.instances[id].role`), so this rule can only catch two AUTHORED primaries in one
// cluster, not a live promotion-driven split brain — see the cluster-key caveat below.
//
// Gated on `bp.stateful`, mirroring replicasColocated's own convention: `role` defaults to
// 'primary' for EVERY placement regardless of blueprint (a plain horizontally-scaled stateless
// tier like `web` with two placements is not a "split brain" just because both default to
// 'primary' — that field is meaningless without primary/replica replication semantics). Confirmed
// against the vault example worlds (`exampleWorlds.test.ts`'s zero-findings assertions), which
// caught the ungated version false-firing on exactly this.
//
// clusterKey mirrors promoteReplicas's own inline `${blueprintId}|${regionId}` derivation
// (failover.ts:351) — there's no exported helper for it (failover.ts derives it inline at both of
// its own call sites too), so this rule derives it the same way rather than inventing a different
// convention. Known gap (accepted, out of scope here): this key groups by region, so a GENUINE
// cross-region split-brain (primary in region A, self-promoted replica in region B) never lands
// in the same cluster and is not detected by this rule.
const splitBrainRisk: AnalysisRule = {
  id: 'split-brain-risk', family: 'structural',
  run: ({ doc, compiled }) => {
    const primariesByCluster = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      if (inst.role !== 'primary') continue
      if (!doc.blueprints[inst.blueprintId]?.stateful) continue
      const clusterKey = `${inst.blueprintId}|${inst.regionId}`
      const list = primariesByCluster.get(clusterKey) ?? []
      list.push(inst)
      primariesByCluster.set(clusterKey, list)
    }
    const out: AnalysisFinding[] = []
    for (const [clusterKey, instances] of primariesByCluster) {
      if (instances.length <= 1) continue
      const regionIds = [...new Set(instances.map(i => i.regionId))]
      const regionNames = regionIds.map(rid => rid).join(', ')
      out.push({
        id: `split-brain-risk:${clusterKey}`, ruleId: 'split-brain-risk', family: 'structural', severity: 'critical',
        title: 'Split-brain: multiple effective primaries',
        why: `${instances.length} instances in cluster ${clusterKey} (region${regionIds.length > 1 ? 's' : ''} ${regionNames}) are all acting as primary simultaneously — likely an asymmetric network partition.`,
        fix: 'Heal the partition, or demote all but one primary once connectivity is restored.',
        affected: instances.map(i => i.id),
      })
    }
    return out
  },
}

export const structuralRules: AnalysisRule[] = [
  singleAzRegion, noFailoverRegion, replicasColocated, dependencyCycle, deepSyncChain, unusedManagedService,
  danglingDependencyNoTargets, splitBrainRisk,
]
