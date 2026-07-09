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
  lastCheckMs: number | null
}

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
export function runHealthChecks(
  state: RoutingState,
  config: RoutingConfig,
  simMs: number,
  scopes: { id: string; health: HealthState }[],
): { id: string; checkFailed: boolean }[] {
  return scopes.map(({ id, health }) => {
    let counter = state.healthCheckCounters.get(id)
    if (!counter) {
      counter = { consecutiveFailures: 0, lastCheckMs: null }
      state.healthCheckCounters.set(id, counter)
    }
    const due = counter.lastCheckMs === null || simMs - counter.lastCheckMs >= config.healthCheckIntervalMs
    if (due) {
      counter.consecutiveFailures = health === 'healthy' ? 0 : counter.consecutiveFailures + 1
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
