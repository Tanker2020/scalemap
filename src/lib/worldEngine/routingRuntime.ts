// DNS/TTL population->region resolution, health-check consecutive-failure debounce, and
// AZ/instance targeting (region LB -> AZ split -> round-robin instance pick).
// Spec decision 5 (traffic & routing) + decision 7 (failover: TTL lag is the observable
// delay), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { RegionId, AzId, PopulationId, BlueprintId, InstanceId, RoutingConfig, PlacementRole } from '../world/types'
import type { HealthState } from './types'
import type { Rng } from './rng'

interface PopulationCacheEntry {
  regionId: RegionId
  expiresAtMs: number
}

interface HealthCheckCounter {
  consecutiveFailures: number
  consecutiveSuccesses: number
  lastCheckMs: number | null
}

// Rise threshold (audit ISSUE-020): consecutive healthy probes required before the failure
// counter clears — ALB/NLB "healthy threshold" semantics. Read from
// config.healthCheckHealthyThreshold when authored; this is the default.
export const DEFAULT_HEALTHY_THRESHOLD = 2

export interface RoutingState {
  popCache: Map<PopulationId, PopulationCacheEntry>
  healthCheckCounters: Map<string, HealthCheckCounter>
  instanceCursors: Map<string, number> // keyed `${azId}:${blueprintId}`
}

export function createRoutingState(): RoutingState {
  return { popCache: new Map(), healthCheckCounters: new Map(), instanceCursors: new Map() }
}

function pickWeighted(candidates: RegionId[], weights: Record<RegionId, number>, rng: Rng): RegionId {
  const weighted = candidates.map(id => ({ id, w: Math.max(0, weights[id] ?? 1) }))
  const total = weighted.reduce((sum, x) => sum + x.w, 0)
  if (total <= 0) return rng.pick(candidates)
  let r = rng.range(0, total)
  for (const x of weighted) {
    r -= x.w
    if (r <= 0) return x.id
  }
  return weighted[weighted.length - 1].id
}

// Honors the TTL cache: a cached region is returned until `expiresAtMs`, even if it has
// since gone down — that lag IS the observable failover delay (decision 7). Re-resolution
// picks the first not-down region in `orderedRegions` (priority/latency/geo — the order
// already encodes the policy and sorts passive regions last, per compileWorld), or a
// weighted not-down draw. Emits nothing itself; the facade (Task 12) diffs cache changes to
// emit `ttl_lag_expired`.
export function resolveRegion(
  state: RoutingState,
  popId: PopulationId,
  orderedRegions: RegionId[],
  healthOf: (id: RegionId) => HealthState,
  policy: RoutingConfig,
  simMs: number,
  rng: Rng,
): RegionId | null {
  const cached = state.popCache.get(popId)
  if (cached && simMs < cached.expiresAtMs) return cached.regionId

  // "healthy" candidate == not down (see SKELETON CONCERNS #2): degraded regions still serve.
  const candidates = orderedRegions.filter(id => healthOf(id) !== 'down')
  if (candidates.length === 0) return null

  const chosen = policy.policy === 'weighted' ? pickWeighted(candidates, policy.weights, rng) : candidates[0]

  state.popCache.set(popId, { regionId: chosen, expiresAtMs: simMs + policy.dnsTtlSec * 1000 })
  return chosen
}

// Per-scope consecutive-failure debounce, gated by `healthCheckIntervalMs` — a scope not yet
// due for a check reports its last-known `checkFailed` state unchanged.
//
// Audit ISSUE-020: symmetric thresholds. Falling needs `healthCheckFailureThreshold` consecutive
// failures (as before); RISING needs `healthCheckHealthyThreshold` (default 2) consecutive
// successes before the failure counter clears. A single healthy probe no longer wipes the
// count, so a scope flapping pass/fail RATCHETS toward failed instead of never tripping.
//
// FEAT-002 Task 12 (directional health / split-brain): this function needed NO changes to
// support per-direction health. `scopes[].id` is just a debounce key — index.ts now also feeds
// it composite ids of the shape `region-pair:${observerRegionId}->${targetRegionId}` (one entry
// per ordered region pair, alongside the existing plain-id region/AZ entries), each carrying a
// health value that's already been forced to 'down' by the caller when `impairmentFor` reports
// the target unreachable FROM that observer. Because debounce state is keyed by `id`, each
// (observer, target) direction gets its own independent consecutive-failure counter for free —
// no signature or logic change here.
export function runHealthChecks(
  state: RoutingState,
  config: RoutingConfig,
  simMs: number,
  scopes: { id: string; health: HealthState }[],
): { id: string; checkFailed: boolean }[] {
  const healthyThreshold = config.healthCheckHealthyThreshold ?? DEFAULT_HEALTHY_THRESHOLD
  return scopes.map(({ id, health }) => {
    let counter = state.healthCheckCounters.get(id)
    if (!counter) {
      counter = { consecutiveFailures: 0, consecutiveSuccesses: 0, lastCheckMs: null }
      state.healthCheckCounters.set(id, counter)
    }
    const due = counter.lastCheckMs === null || simMs - counter.lastCheckMs >= config.healthCheckIntervalMs
    if (due) {
      if (health === 'healthy') {
        counter.consecutiveSuccesses += 1
        if (counter.consecutiveSuccesses >= healthyThreshold) counter.consecutiveFailures = 0
      } else {
        counter.consecutiveFailures += 1
        counter.consecutiveSuccesses = 0
      }
      counter.lastCheckMs = simMs
    }
    return { id, checkFailed: counter.consecutiveFailures >= config.healthCheckFailureThreshold }
  })
}

// Region LB -> healthy AZ spread. "Healthy" here means not-down: a degraded AZ still takes a
// share (only a down AZ is excluded) — consistent with resolveRegion's filter above.
export function azSplit(azIds: AzId[], healthOf: (id: AzId) => HealthState): AzId[] {
  return azIds.filter(id => healthOf(id) !== 'down')
}

export interface DistributeInput {
  targetBlueprintIds: BlueprintId[]                                  // the target group (implicit: all instances of these bps)
  rps: number
  crossZone: boolean
  regionAzSpread: AzId[]                                             // compiled.routing.regionAzSpread[regionId]
  azBlueprintTargets: Record<AzId, Record<BlueprintId, InstanceId[]>>
  healthOfScope: (id: string) => HealthState
  healthOfInstance: (id: InstanceId) => HealthState
  cursors: RoutingState
  into: Record<InstanceId, number>                                   // accumulator (mutated)
  // Weighted-algorithm inputs (both optional; absent/false ⇒ byte-identical to the pre-weighted
  // equal split below — round-robin LBs never touch this). When `weighted` is true, each AZ's
  // share of `rps` is proportional to `azWeights[azId]` (default 1) instead of an equal split;
  // an all-zero/absent weight set among the candidate AZs falls back to equal, same as
  // resolveRegion's pickWeighted does for an all-zero region-weight policy.
  weighted?: boolean
  azWeights?: Record<AzId, number>
  // Undeliverable rps, keyed by the AZ that could not serve it. Traffic drops here only when the
  // WHOLE group can't be served (empty target group, or every target down region-wide) — a
  // cross-zone-off AZ that merely lacks a healthy target for this group is instead pulled from
  // rotation and its share redistributed to the serving AZs (see the crossZone-false path), not
  // failed. Optional accumulator (mutated), mirroring `into`; absent ⇒ drops go uncounted.
  droppedByAz?: Record<AzId, number>
  // Canary routing (Task 13, both optional; absent ⇒ byte-identical to pre-canary behavior — the
  // regression floor). When both are supplied and a target list contains at least one instance
  // `roleOf` classifies as 'canary' whose placement carries a `canaryWeightOf` value, that
  // fraction of the list's share routes to the canary subset instead of being split evenly across
  // canary and primary/replica instances alike. `roleOf` MUST be the engine's
  // `effectiveRoleResolver` output (failover.ts) — never a second, independent role check — so
  // canary classification and promotion state can never disagree.
  roleOf?: (id: InstanceId) => PlacementRole
  canaryWeightOf?: (id: InstanceId) => number | undefined
}

// Distributes `rps` across a target group per the regional LB's cross-zone setting. This is the
// region→AZ→instance tier (the LB "between the AZs"); the caller has already resolved which
// target blueprints answer this traffic (default action in L4, a matched listener rule in L7).
//   crossZone false (NLB default) — each AZ node serves ONLY its own AZ's targets (entry-node ==
//     serving-AZ). The equal per-AZ share (perAz = rps / servingAzCount) is spread over just the
//     AZs that hold a HEALTHY target for this group: an AZ with none is pulled from rotation (as
//     AWS drops a zone with no healthy targets out of DNS), so its share REDISTRIBUTES to the
//     serving AZs instead of failing. Only when NO AZ can serve does the group's traffic drop.
//   crossZone true (ALB default) — every healthy target instance region-wide gets an equal split
//     (entry-node decoupled from serving-AZ), so unequal per-AZ instance counts skew the per-AZ
//     totals toward the AZ with more instances.
function azWeightOf(azWeights: Record<AzId, number> | undefined, azId: AzId): number {
  return Math.max(0, azWeights?.[azId] ?? 1)
}

// Splits `total` across `azIds` proportional to weight when `weighted` is true and at least one
// candidate carries positive weight; falls back to an equal split otherwise (unweighted mode, or
// a degenerate all-zero weight set).
function azShares(azIds: AzId[], total: number, weighted: boolean | undefined, azWeights: Record<AzId, number> | undefined): Map<AzId, number> {
  const shares = new Map<AzId, number>()
  if (weighted) {
    const totalWeight = azIds.reduce((sum, id) => sum + azWeightOf(azWeights, id), 0)
    if (totalWeight > 0) {
      for (const id of azIds) shares.set(id, total * azWeightOf(azWeights, id) / totalWeight)
      return shares
    }
  }
  const per = total / azIds.length
  for (const id of azIds) shares.set(id, per)
  return shares
}

// Canary partition (Task 13): splits a target-instance list into its 'canary'-role subset and
// everything else (primary/replica), reading a single shared weight off the first canary
// instance found (canary placements in one blueprint|region cluster are expected to share one
// authored weight). Returns `canaryWeight: null` — meaning "do not split, keep the list as one
// group" — whenever `roleOf`/`canaryWeightOf` are absent, no instance in the list is canary, or
// the canary instance's placement has no `canaryWeight` authored: all three collapse to the
// EXACT pre-Task-13 behavior (the list flows through unmodified to whichever equal-split/
// round-robin logic already existed).
function splitIntoCanaryGroups(
  targets: InstanceId[],
  roleOf: ((id: InstanceId) => PlacementRole) | undefined,
  canaryWeightOf: ((id: InstanceId) => number | undefined) | undefined,
): { main: InstanceId[]; canary: InstanceId[]; canaryWeight: number | null } {
  if (!roleOf || !canaryWeightOf) return { main: targets, canary: [], canaryWeight: null }
  const canary: InstanceId[] = []
  const main: InstanceId[] = []
  for (const id of targets) {
    if (roleOf(id) === 'canary') canary.push(id)
    else main.push(id)
  }
  if (canary.length === 0) return { main: targets, canary: [], canaryWeight: null }
  const w = canaryWeightOf(canary[0])
  // `undefined`/`null` means "nothing authored" -> pre-Task-13 behavior (fall through, undifferentiated
  // pool). An explicit `0` IS a meaningful authored value (Placement.canaryWeight is a 0..1 fraction) —
  // it must still route through the split below so the canary group's share collapses to zero rather
  // than falling back into the undifferentiated pool and getting an accidental ~1/N share.
  if (w === undefined || w === null || Number.isNaN(w) || w < 0) return { main: targets, canary: [], canaryWeight: null }
  return { main, canary, canaryWeight: Math.min(1, w) }
}

// Normalizes an authored `canaryWeight` (always a fraction of the blueprint's REGIONAL rps, per its
// doc comment on DistributeInput) into the LOCAL weight to hand to `canaryShares` when the split is
// being applied to only a sub-portion (`localShare`) of the full regional total (`totalRps`) — e.g.
// one AZ's share in the weighted cross-zone-on branch, or one AZ+blueprint's share in the
// cross-zone-off branch. Without this, `canaryWeight: 0.05` would silently mean "5% of THIS AZ's
// share" instead of "5% of the region" whenever the canary's AZ carries less than the full regional
// total (the common multi-AZ case) — a canary weight authored as 5% would actually receive roughly
// 5% * azShareOfRegion. Clamped to [0, 1]. When `localShare` already IS the full regional total (the
// crossZone-on unweighted branch, which splits the region-wide target list directly), this reduces
// to the identity function.
function regionalCanaryWeight(canaryWeight: number, localShare: number, totalRps: number): number {
  if (localShare <= 0 || totalRps <= 0) return canaryWeight
  const localFraction = localShare / totalRps
  if (localFraction <= 0) return canaryWeight
  return Math.min(1, canaryWeight / localFraction)
}

// Splits `total` between the canary and main (primary+replica) subsets of a target list,
// proportional to `canaryWeight` — the SAME weighted-share formula as `azShares` above (invoked
// directly, not re-derived), just applied to a two-member 'main'/'canary' group instead of a set
// of AZ ids.
function canaryShares(total: number, canaryWeight: number): { main: number; canary: number } {
  const shares = azShares(['main', 'canary'], total, true, { main: 1 - canaryWeight, canary: canaryWeight })
  return { main: shares.get('main') ?? 0, canary: shares.get('canary') ?? 0 }
}

export function distributeToTargets(input: DistributeInput): void {
  const { targetBlueprintIds, rps, crossZone, regionAzSpread, azBlueprintTargets,
    healthOfScope, healthOfInstance, cursors, into, droppedByAz, weighted, azWeights, roleOf, canaryWeightOf } = input
  if (rps <= 0) return
  // Credit undeliverable `amount` to `azId` (or spread across the region's AZs when the drop isn't
  // attributable to one AZ — e.g. an empty target group or an all-down region).
  const drop = (azId: AzId | null, amount: number): void => {
    if (!droppedByAz || amount <= 0) return
    if (azId) { droppedByAz[azId] = (droppedByAz[azId] ?? 0) + amount; return }
    const spread = regionAzSpread.length > 0 ? regionAzSpread : []
    if (spread.length === 0) return
    const per = amount / spread.length
    for (const id of spread) droppedByAz[id] = (droppedByAz[id] ?? 0) + per
  }

  if (targetBlueprintIds.length === 0) { drop(null, rps); return }
  const healthyAzs = azSplit(regionAzSpread, healthOfScope)
  if (healthyAzs.length === 0) { drop(null, rps); return }

  if (crossZone) {
    if (!weighted) {
      const targets: InstanceId[] = []
      for (const azId of healthyAzs) {
        const byBp = azBlueprintTargets[azId] ?? {}
        for (const bpId of targetBlueprintIds) {
          for (const iid of byBp[bpId] ?? []) {
            if (healthOfInstance(iid) !== 'down') targets.push(iid)
          }
        }
      }
      if (targets.length === 0) { drop(null, rps); return }
      const { main, canary, canaryWeight } = splitIntoCanaryGroups(targets, roleOf, canaryWeightOf)
      if (canaryWeight !== null) {
        // localShare === rps here (this split IS already region-wide) -> regionalCanaryWeight is
        // the identity function; kept for consistency with the other two branches below.
        const { main: mainShare, canary: canaryShare } = canaryShares(rps, regionalCanaryWeight(canaryWeight, rps, rps))
        // main/canary are already health-filtered (targets was built from healthy instances only
        // above), so an empty group here means "genuinely nothing healthy in that group" —
        // redirect its whole share to the other group when it's non-empty, rather than dropping
        // traffic the other group could serve (Important #1's crossZone-on mirror case: a down
        // primary with a healthy canary in the same region must not drop the primary's share).
        let mainAlloc = mainShare
        let canaryAlloc = canaryShare
        if (mainAlloc > 0 && main.length === 0 && canary.length > 0) { canaryAlloc += mainAlloc; mainAlloc = 0 }
        else if (canaryAlloc > 0 && canary.length === 0 && main.length > 0) { mainAlloc += canaryAlloc; canaryAlloc = 0 }
        if (main.length > 0) {
          const perMain = mainAlloc / main.length
          for (const iid of main) into[iid] = (into[iid] ?? 0) + perMain
        } else if (mainAlloc > 0) drop(null, mainAlloc)
        if (canary.length > 0) {
          const perCanary = canaryAlloc / canary.length
          for (const iid of canary) into[iid] = (into[iid] ?? 0) + perCanary
        } else if (canaryAlloc > 0) drop(null, canaryAlloc)
        return
      }
      const per = rps / targets.length
      for (const iid of targets) into[iid] = (into[iid] ?? 0) + per
      return
    }
    // Weighted: each AZ's total share is proportional to its weight, then split evenly across
    // that AZ's own healthy targets for the group (unlike the unweighted flat split above, an
    // AZ's instance COUNT no longer skews its share — only its authored weight does).
    const byAz: { azId: AzId; targets: InstanceId[] }[] = []
    for (const azId of healthyAzs) {
      const byBp = azBlueprintTargets[azId] ?? {}
      const targets: InstanceId[] = []
      for (const bpId of targetBlueprintIds) {
        for (const iid of byBp[bpId] ?? []) {
          if (healthOfInstance(iid) !== 'down') targets.push(iid)
        }
      }
      if (targets.length > 0) byAz.push({ azId, targets })
    }
    if (byAz.length === 0) { drop(null, rps); return }
    const shares = azShares(byAz.map(x => x.azId), rps, weighted, azWeights)
    // Pre-pass (Important #3): a canary group can be replicated across several AZs (a normal HA
    // canary deployment) — the authored canaryWeight is a fraction of the REGIONAL rps, so its
    // conservation has to be enforced across ALL canary-hosting AZ slices at once, not
    // independently per AZ (which would deliver canaryWeight × rps to EACH hosting AZ and sum to
    // N× the authored fraction). Aggregate the local share of every AZ that hosts this group's
    // canary subset first, then every hosting AZ's local weight derives off that aggregate.
    const azSplits = byAz.map(({ azId, targets }) => ({
      azId,
      targets,
      azShare: shares.get(azId) ?? 0,
      split: splitIntoCanaryGroups(targets, roleOf, canaryWeightOf),
    }))
    const aggregateCanaryShare = azSplits.reduce(
      (sum, x) => sum + (x.split.canaryWeight !== null ? x.azShare : 0), 0)
    for (const { azId, targets, azShare, split: { main, canary, canaryWeight } } of azSplits) {
      if (canaryWeight !== null) {
        const { main: mainShare, canary: canaryShare } = canaryShares(
          azShare, regionalCanaryWeight(canaryWeight, aggregateCanaryShare, rps))
        // main/canary are already health-filtered (targets was built from healthy instances only
        // above), so an empty group here means "genuinely nothing healthy in that group" —
        // redirect its whole share to the other group when it's non-empty (Important #1's
        // crossZone-on mirror case: a down primary with a healthy canary in the same AZ must not
        // drop the primary's share).
        let mainAlloc = mainShare
        let canaryAlloc = canaryShare
        if (mainAlloc > 0 && main.length === 0 && canary.length > 0) { canaryAlloc += mainAlloc; mainAlloc = 0 }
        else if (canaryAlloc > 0 && canary.length === 0 && main.length > 0) { mainAlloc += canaryAlloc; canaryAlloc = 0 }
        if (main.length > 0) {
          const perMain = mainAlloc / main.length
          for (const iid of main) into[iid] = (into[iid] ?? 0) + perMain
        } else if (mainAlloc > 0) drop(azId, mainAlloc)
        if (canary.length > 0) {
          const perCanary = canaryAlloc / canary.length
          for (const iid of canary) into[iid] = (into[iid] ?? 0) + perCanary
        } else if (canaryAlloc > 0) drop(azId, canaryAlloc)
        continue
      }
      const per = azShare / targets.length
      for (const iid of targets) into[iid] = (into[iid] ?? 0) + per
    }
    return
  }

  // Each AZ node serves ONLY its own targets, but an AZ with no HEALTHY target for this group is
  // pulled from the LB's rotation — mirroring how AWS removes a zone with no healthy targets from
  // DNS once health checks confirm it — so its share REDISTRIBUTES to the AZs that can serve
  // rather than failing. `targetsHere` therefore filters on instance health (not mere placement),
  // and only AZs with a non-empty set stay in the split.
  const serving: { azId: AzId; byBp: Record<BlueprintId, InstanceId[]>; targetsHere: BlueprintId[] }[] = []
  for (const azId of healthyAzs) {
    const byBp = azBlueprintTargets[azId] ?? {}
    const targetsHere = targetBlueprintIds.filter(bpId => (byBp[bpId] ?? []).some(iid => healthOfInstance(iid) !== 'down'))
    if (targetsHere.length > 0) serving.push({ azId, byBp, targetsHere })
  }
  // No AZ in the region can serve this group (every target down, or none placed in a healthy AZ):
  // now the whole share genuinely fails, spread across the region's AZs since it isn't attributable
  // to one. (A single empty AZ no longer drops — it just left the split above.)
  if (serving.length === 0) { drop(null, rps); return }
  const shares = azShares(serving.map(x => x.azId), rps, weighted, azWeights)
  // Pre-pass (Important #3): same multi-AZ conservation fix as the crossZone-on weighted branch
  // above, scoped per blueprint (each blueprint's canary group is normalized independently) —
  // aggregate the local (az, blueprint) share carried by every serving-AZ slice that hosts THAT
  // blueprint's canary subset, across however many AZs replicate it, before deriving any one
  // slice's local canary weight. Cache the (raw, health-unfiltered) split per (az, bpId) so the
  // pre-pass and the main loop below agree and neither recomputes it twice.
  const splitCache = new Map<string, ReturnType<typeof splitIntoCanaryGroups>>()
  const splitFor = (azId: AzId, bpId: BlueprintId): ReturnType<typeof splitIntoCanaryGroups> => {
    const key = `${azId}:${bpId}`
    let cached = splitCache.get(key)
    if (!cached) {
      cached = splitIntoCanaryGroups(azBlueprintTargets[azId]?.[bpId] ?? [], roleOf, canaryWeightOf)
      splitCache.set(key, cached)
    }
    return cached
  }
  const aggregateCanaryShareByBp = new Map<BlueprintId, number>()
  for (const { azId, targetsHere } of serving) {
    const perBp = (shares.get(azId) ?? 0) / targetsHere.length
    for (const bpId of targetsHere) {
      if (splitFor(azId, bpId).canaryWeight !== null) {
        aggregateCanaryShareByBp.set(bpId, (aggregateCanaryShareByBp.get(bpId) ?? 0) + perBp)
      }
    }
  }
  for (const { azId, byBp, targetsHere } of serving) {
    const perBp = (shares.get(azId) ?? 0) / targetsHere.length
    for (const bpId of targetsHere) {
      const { main, canary, canaryWeight } = splitFor(azId, bpId)
      if (canaryWeight !== null) {
        // perBp is only this AZ+blueprint's slice of the region's rps -> normalize against the
        // AGGREGATE share of every serving AZ that hosts this blueprint's canary subset (not just
        // this one slice), so the authored canaryWeight is conserved at the regional total even
        // when the canary group is replicated across multiple AZs (Important #3). Note
        // `byBp[bpId]` (fed into splitFor above) is the RAW, health-unfiltered placement list —
        // unlike targetsHere's health-filtered check a few lines up — so `main`/`canary` here may
        // each contain zero healthy instances; the fallback below (Important #1) is what keeps a
        // down canary (or down primaries) from silently dropping traffic that the OTHER group
        // could still serve, matching the "redistribute rather than fail" philosophy documented
        // atop this function's crossZone-false branch.
        const aggregateShare = aggregateCanaryShareByBp.get(bpId) ?? perBp
        const { main: mainShare, canary: canaryShare } = canaryShares(perBp, regionalCanaryWeight(canaryWeight, aggregateShare, rps))
        const mainHealthy = main.some(iid => healthOfInstance(iid) !== 'down')
        const canaryHealthy = canary.some(iid => healthOfInstance(iid) !== 'down')
        let mainAlloc = mainShare
        let canaryAlloc = canaryShare
        if (mainAlloc > 0 && !mainHealthy && canaryHealthy) { canaryAlloc += mainAlloc; mainAlloc = 0 }
        else if (canaryAlloc > 0 && !canaryHealthy && mainHealthy) { mainAlloc += canaryAlloc; canaryAlloc = 0 }
        if (mainAlloc > 0) {
          const inst = pickInstance(cursors, azId, bpId, main, healthOfInstance)
          if (inst) into[inst] = (into[inst] ?? 0) + mainAlloc
          else drop(azId, mainAlloc)
        }
        if (canaryAlloc > 0) {
          // Own cursor key (`${bpId}:canary`) so canary rotation never shares state with the
          // main group's — pickInstance keys purely off (azId, blueprintId).
          const inst = pickInstance(cursors, azId, `${bpId}:canary`, canary, healthOfInstance)
          if (inst) into[inst] = (into[inst] ?? 0) + canaryAlloc
          else drop(azId, canaryAlloc)
        }
        continue
      }
      const inst = pickInstance(cursors, azId, bpId, byBp[bpId], healthOfInstance)
      // targetsHere guarantees ≥1 healthy instance of bpId here, so pickInstance won't return null;
      // the drop is defensive belt-and-braces that keeps the accounting closed.
      if (inst) into[inst] = (into[inst] ?? 0) + perBp
      else drop(azId, perBp)
    }
  }
}

// AZ LB -> round-robin instance pick, one cursor per (az, blueprint) pair so different
// blueprints in the same AZ don't share rotation state.
export function pickInstance(
  state: RoutingState,
  azId: AzId,
  blueprintId: BlueprintId,
  targets: InstanceId[],
  healthyOf: (id: InstanceId) => HealthState,
): InstanceId | null {
  const healthy = targets.filter(id => healthyOf(id) !== 'down')
  if (healthy.length === 0) return null
  const key = `${azId}:${blueprintId}`
  const cursor = state.instanceCursors.get(key) ?? 0
  const chosen = healthy[cursor % healthy.length]
  state.instanceCursors.set(key, cursor + 1)
  return chosen
}
