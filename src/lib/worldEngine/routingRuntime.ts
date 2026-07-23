// DNS/TTL population->region resolution, health-check consecutive-failure debounce, and
// AZ/instance targeting (region LB -> AZ split -> round-robin instance pick).
// Spec decision 5 (traffic & routing) + decision 7 (failover: TTL lag is the observable
// delay), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { RegionId, AzId, PopulationId, BlueprintId, InstanceId, RoutingConfig } from '../world/types'
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
  // Undeliverable rps, keyed by the AZ that could not serve it (audit follow-up: cross-zone-off
  // forfeiture used to vanish silently). A real cross-zone-off NLB FAILS the connections routed to
  // an AZ with no healthy target, so that share is a failure, not a no-op — every drop point below
  // credits it here. Optional accumulator (mutated), mirroring `into`; absent ⇒ drops go uncounted
  // (existing callers/tests unchanged).
  droppedByAz?: Record<AzId, number>
}

// Distributes `rps` across a target group per the regional LB's cross-zone setting. This is the
// region→AZ→instance tier (the LB "between the AZs"); the caller has already resolved which
// target blueprints answer this traffic (default action in L4, a matched listener rule in L7).
//   crossZone false (NLB default) — each healthy AZ node takes an equal share and serves ONLY
//     its own AZ's targets (entry-node == serving-AZ). Byte-equivalent to the pre-LB equal-per-AZ
//     distribution: perAz = rps / healthyAzCount, then one round-robin instance per target
//     blueprint present in the AZ. An AZ with no target instances forfeits its share.
//   crossZone true (ALB default) — every healthy target instance region-wide gets an equal split
//     (entry-node decoupled from serving-AZ), so unequal per-AZ instance counts skew the per-AZ
//     totals toward the AZ with more instances.
export function distributeToTargets(input: DistributeInput): void {
  const { targetBlueprintIds, rps, crossZone, regionAzSpread, azBlueprintTargets,
    healthOfScope, healthOfInstance, cursors, into, droppedByAz } = input
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
    const per = rps / targets.length
    for (const iid of targets) into[iid] = (into[iid] ?? 0) + per
    return
  }

  const perAz = rps / healthyAzs.length
  for (const azId of healthyAzs) {
    const byBp = azBlueprintTargets[azId] ?? {}
    const targetsHere = targetBlueprintIds.filter(bpId => (byBp[bpId]?.length ?? 0) > 0)
    // This AZ's node has no healthy target for the traffic routed to it: cross-zone-off can't
    // spill to another AZ, so the whole per-AZ share fails here (real NLB connection failures).
    if (targetsHere.length === 0) { drop(azId, perAz); continue }
    const perBp = perAz / targetsHere.length
    for (const bpId of targetsHere) {
      const inst = pickInstance(cursors, azId, bpId, byBp[bpId], healthOfInstance)
      // pickInstance returns null only when every instance of the blueprint here is down.
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
