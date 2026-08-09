// Structural analysis rules (Phase 6 D2). Pure; read doc + compiled only.
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { ServiceInstance, WorldDoc, PlacementRole } from '../../world/types'

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
// still up and serving on the other side of the partition. Reads
// `lastBatch?.instances[id]?.effectiveRole ?? compiled.instances[id].role` — `effectiveRole` is
// the LIVE promotion-aware role (`failover.ts`'s `effectiveRoleResolver`, published by
// `metrics.ts`'s `buildBatch` as of the Task 13 review fix below), falling back to the STATIC
// authored `PlacementRole` on `ServiceInstance` when no batch has run yet (e.g. a freshly-opened,
// never-simulated world) — `InstanceMetrics` had no such field until this fix, so a partition-
// induced promotion (which only ever mutates `state.failover.promotedAt`, never the doc) was
// completely invisible to this rule; it could only ever fire on a hand-authored double-primary.
//
// Gated on `bp.stateful`, mirroring replicasColocated's own convention: `role` defaults to
// 'primary' for EVERY placement regardless of blueprint (a plain horizontally-scaled stateless
// tier like `web` with two placements is not a "split brain" just because both default to
// 'primary' — that field is meaningless without primary/replica replication semantics). Confirmed
// against the vault example worlds (`exampleWorlds.test.ts`'s zero-findings assertions), which
// caught the ungated version false-firing on exactly this.
//
// Audit final-review I2 (was: clusterKey = `${blueprintId}|${regionId}`, mirroring
// promoteReplicas's SAME-region cluster grouping in failover.ts). That key could only ever catch
// two primaries within ONE region — never the genuine cross-region split-brain (primary in
// region A untouched, self-promoted replica in region B) that FEAT-002's Task 12 cross-region
// isolation-promotion mechanism (index.ts) specifically exists to produce, even though this
// rule's own `why` string claimed "likely an asymmetric network partition" coverage it didn't
// have. Widened to group by blueprintId ALONE, BUT with an extra guard on the cross-region case
// specifically: a cross-region cluster only fires when at least one member's AUTHORED role isn't
// 'primary' (i.e. compiled.instances[id].role — a promotion overlay never touches this field, so
// a mismatch against the effective role proves a LIVE promotion happened). Without that guard,
// widening the key naively broke the vault's own `multi-region-failover` example world
// (exampleWorlds.test.ts's zero-analysis-findings assertion): it intentionally authors a `db`
// primary+replica pair PER active region (active-active by design, not partition-induced) — two
// authored primaries sharing a blueprintId across regions is a supported, deliberate topology
// here, not a bug, and runAnalysis(doc, compiled, null) sees no lastBatch to distinguish "self-
// promoted" from "authored primary" without this extra check. The SAME-region case keeps its
// original behavior unchanged (still fires on a purely authored double-primary, no promotion
// needed) — only the newly-added cross-region path requires promotion evidence, since same-region
// dual-authoring was already flagged pre-fix and multi-region-failover never authors that shape.
//
// Re-review N1 fix: the I2 guard above ("any candidate's authored role isn't 'primary'") was too
// coarse — it fires on ANY promotion anywhere in the cluster, including an ordinary SAME-region HA
// promotion that happens to also share a blueprintId with an unrelated separate authored primary in
// another region (the `sameRegionPlusCrossRegionPrimaryFixture` shape in worldEngine/index.test.ts,
// and the vault's own multi-region-failover example world UNDER a live failover — neither is a bug).
// Narrowed to require a genuine CROSS-REGION ORPHAN promotion specifically, mirroring
// worldEngine/index.ts's `buildCrossRegionOrphanReplicaIds`: a promoted candidate only counts as
// split-brain evidence when its OWN region has ZERO authored primary for this blueprint (checked
// against ALL of compiled.instances, not just this cluster's candidates). A same-region authored
// primary sibling means the promotion is normal same-region failover, not cross-region split-brain,
// regardless of what else shares the blueprintId elsewhere.
const splitBrainRisk: AnalysisRule = {
  id: 'split-brain-risk', family: 'structural',
  run: ({ doc, compiled, lastBatch }) => {
    interface Candidate { inst: ServiceInstance; authoredRole: PlacementRole }
    // FEAT-008 (Task 19 consumer audit): "acting as primary" is a LIVE claim, so this rule's
    // candidate set must be the RUNNING set, not the compiled ENVELOPE. Since Task 11,
    // `compiled.instances` expands an autoscaled placement to its full maxCount envelope, and a
    // parked slot is omitted from `lastBatch.instances` (Task 16) — which made the
    // `?? inst.role` fallback below resolve every parked slot to its AUTHORED role ('primary' by
    // default for every placement), reporting a whole idle envelope as a critical split-brain.
    // Membership in `lastBatch.instances` is the sanctioned running signal for a non-engine
    // consumer, and metrics.ts omits ONLY parked (non-draining) instances — a killed/down/
    // degraded instance still publishes an entry — so absence here means parked, nothing else.
    // Gated on a NON-EMPTY published instance map so the never-simulated case (no batch, or a
    // batch that predates any instance publishing) keeps the pure authored-role behavior.
    const published = lastBatch?.instances
    const hasRunningSignal = published != null && Object.keys(published).length > 0
    const primariesByBlueprint = new Map<string, Candidate[]>()
    for (const inst of Object.values(compiled.instances)) {
      if (hasRunningSignal && !published[inst.id]) continue   // parked envelope slot — not running, not acting
      const effectiveRole = lastBatch?.instances?.[inst.id]?.effectiveRole ?? inst.role
      if (effectiveRole !== 'primary') continue
      if (!doc.blueprints[inst.blueprintId]?.stateful) continue
      const list = primariesByBlueprint.get(inst.blueprintId) ?? []
      list.push({ inst, authoredRole: inst.role })
      primariesByBlueprint.set(inst.blueprintId, list)
    }
    const out: AnalysisFinding[] = []
    for (const [blueprintId, candidates] of primariesByBlueprint) {
      if (candidates.length <= 1) continue
      const regionIds = [...new Set(candidates.map(c => c.inst.regionId))]
      const spansRegions = regionIds.length > 1
      // Cross-region: require evidence of a genuine CROSS-REGION ORPHAN self-promotion, mirroring
      // worldEngine/index.ts's buildCrossRegionOrphanReplicaIds eligibility (only a replica with
      // ZERO same-region authored primary sibling can ever be a real cross-region split-brain
      // promotion). A candidate whose authored role isn't 'primary' only counts as evidence when
      // its OWN region has no authored primary for this blueprint at all — if a same-region
      // authored primary sibling exists, the promotion is an ordinary same-region HA failover
      // (promoteReplicas in failover.ts), not evidence of anything cross-region, even though this
      // candidate is now ALSO part of a cross-region cluster because of an unrelated separate
      // authored primary elsewhere (the sameRegionPlusCrossRegionPrimaryFixture / vault
      // multi-region-failover-under-failover shape). Without this narrowing, the coarse "any
      // authored role != primary anywhere in the cluster" guard false-fires on that exact normal
      // topology.
      if (spansRegions) {
        const hasCrossRegionOrphanEvidence = candidates.some(c => {
          if (c.authoredRole === 'primary') return false   // not a promotion at all
          // Mirrors buildCrossRegionOrphanReplicaIds: only an orphan (its OWN region has NO
          // authored primary for this blueprint, among ALL compiled instances — not just this
          // cluster's candidates, since a same-region authored primary sibling may not currently
          // be an effective primary itself) counts as cross-region split-brain evidence.
          return !Object.values(compiled.instances).some(
            other => other.id !== c.inst.id && other.blueprintId === blueprintId &&
              other.regionId === c.inst.regionId && other.role === 'primary')
        })
        if (!hasCrossRegionOrphanEvidence) continue
      }
      const instances = candidates.map(c => c.inst)
      out.push({
        id: `split-brain-risk:${blueprintId}`, ruleId: 'split-brain-risk', family: 'structural', severity: 'critical',
        title: 'Split-brain: multiple effective primaries',
        why: spansRegions
          ? `${instances.length} instances of blueprint ${blueprintId} are all acting as primary simultaneously, across regions ${regionIds.join(', ')} — likely a cross-region partition that let an isolated replica self-promote while the original primary kept serving.`
          : `${instances.length} instances of blueprint ${blueprintId} (region ${regionIds[0]}) are all acting as primary simultaneously — likely an asymmetric network partition.`,
        fix: 'Heal the partition, or demote all but one primary once connectivity is restored.',
        affected: instances.map(i => i.id),
      })
    }
    return out
  },
}

// FEAT-005 (Task 14): mirrors splitBrainRisk's shape — a cluster-scoped structural finding read
// off lastBatch.clusters (Task 12's published per-cluster replication lag) against the primary
// blueprint's authored DbConfig.rpoTargetSec (Task 9). clusterId is `${primaryBlueprintId}|
// ${primaryRegionId}` (index.ts's buildReplicationIndexes convention); no lastBatch, or no
// authored target for the cluster's blueprint, means silent (no finding).
const replicationLagExceedsRpo: AnalysisRule = {
  id: 'replication-lag-exceeds-rpo', family: 'structural',
  run: ({ doc, lastBatch }) => {
    if (!lastBatch?.clusters) return []
    const out: AnalysisFinding[] = []
    for (const [clusterId, cluster] of Object.entries(lastBatch.clusters)) {
      const [blueprintId] = clusterId.split('|')
      const bp = doc.blueprints[blueprintId]
      const target = bp?.dbConfig?.rpoTargetSec
      if (target == null || cluster.lagSec <= target) continue
      out.push({
        id: `replication-lag-exceeds-rpo:${clusterId}`, ruleId: 'replication-lag-exceeds-rpo', family: 'structural', severity: 'warning',
        title: 'Replication lag exceeds RPO target',
        why: `${bp?.name ?? blueprintId} replication lag (${cluster.lagSec.toFixed(1)}s) exceeds its authored RPO target (${target}s) — a promotion right now could lose more data than the target permits.`,
        fix: `Raise applyRatePerReplica or lower the write load on ${bp?.name ?? blueprintId}, or relax its RPO target (Connections panel).`,
        affected: [blueprintId],
      })
    }
    return out
  },
}

// Wave 5 (Task 14): a `canaryWeight` canary placement is only useful if its error behavior is
// actually watched against its primary sibling. Compares a canary ServiceInstance's PUBLISHED
// errorRate (lastBatch.instances[id].errorRate) against its primary sibling's — same blueprintId
// + regionId, mirroring splitBrainRisk/replicationLagExceedsRpo's own cluster-key convention
// above. "Sustained over a window" needs no new state here: like every other lastBatch-reading
// rule in this file, it trusts the value it's given — and InstanceMetrics.errorRate is already
// EMA'd (α=0.3) by metrics.ts's buildBatch, not a raw per-step sample, so a one-step blip barely
// moves the published number while a genuinely sustained spike converges the EMA toward the true
// rate over several steps. A plain delta threshold on that already-smoothed value is therefore
// enough to tell "sustained" from "blip" — the same shape capacity.ts's burstable-sustained-load
// uses (a plain mean-vs-baseline threshold, no rolling window of its own). Uses the STATIC
// authored role (inst.role), not effectiveRole: canary is an authoring-time A/B designation, not
// a live promotion state like splitBrainRisk's primary/replica.
const CANARY_ERROR_DELTA = 0.15   // absolute errorRate points the canary must exceed its primary by

const canaryFailing: AnalysisRule = {
  id: 'canary-failing', family: 'structural',
  run: ({ doc, compiled, lastBatch }) => {
    const published = lastBatch?.instances
    if (!published) return []
    const byClusterCanaries = new Map<string, ServiceInstance[]>()
    const byClusterPrimaries = new Map<string, ServiceInstance[]>()
    for (const inst of Object.values(compiled.instances)) {
      const key = `${inst.blueprintId}|${inst.regionId}`
      if (inst.role === 'canary') {
        const l = byClusterCanaries.get(key) ?? []; l.push(inst); byClusterCanaries.set(key, l)
      } else if (inst.role === 'primary') {
        const l = byClusterPrimaries.get(key) ?? []; l.push(inst); byClusterPrimaries.set(key, l)
      }
    }
    const out: AnalysisFinding[] = []
    for (const [key, canaries] of byClusterCanaries) {
      const primaries = byClusterPrimaries.get(key) ?? []
      if (primaries.length === 0) continue
      const primaryRates = primaries
        .map(p => published[p.id]?.errorRate)
        .filter((r): r is number => r != null)
      if (primaryRates.length === 0) continue
      const primaryErrorRate = primaryRates.reduce((a, b) => a + b, 0) / primaryRates.length
      for (const canary of canaries) {
        const canaryErrorRate = published[canary.id]?.errorRate
        if (canaryErrorRate == null) continue
        if (canaryErrorRate - primaryErrorRate <= CANARY_ERROR_DELTA) continue
        const bp = doc.blueprints[canary.blueprintId]
        out.push({
          id: `canary-failing:${canary.id}`, ruleId: 'canary-failing', family: 'structural', severity: 'warning',
          title: 'Canary error rate elevated',
          why: `Canary instance of ${bp?.name ?? canary.blueprintId} in region ${canary.regionId} is erroring at ${(canaryErrorRate * 100).toFixed(0)}% vs its primary's ${(primaryErrorRate * 100).toFixed(0)}%, sustained — this canary looks unhealthy.`,
          fix: `Roll back this canary placement (set canaryWeight to 0 or remove it) until the error rate is fixed (Placement drawer).`,
          affected: [canary.id, ...primaries.map(p => p.id)],
        })
      }
    }
    return out
  },
}

export const structuralRules: AnalysisRule[] = [
  singleAzRegion, noFailoverRegion, replicasColocated, dependencyCycle, deepSyncChain, unusedManagedService,
  danglingDependencyNoTargets, splitBrainRisk, replicationLagExceedsRpo, canaryFailing,
]
