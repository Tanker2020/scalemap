// Pure FEAT-008 autoscale machinery: per-placement HPA-style desired-count state, a running-set
// resolver that parks compiled instances past the current desired count (mirrors failover.ts's
// effectiveRoleResolver closure pattern), and the asymmetric-cooldown scale-up/scale-down control
// loop. No engine imports, no side effects -- consumed by Task 13 (engine wiring), Task 14
// (routing exclusion), Task 16 (metrics publishing).
import type { AutoscalePolicy, PlacementId, InstanceId, WorldDoc, Placement, CompiledWorld } from '../world/types'

export interface AutoscaleState {
  desiredCount: Map<PlacementId, number>
  lastScaleUpAt: Map<PlacementId, number>
  lastScaleDownAt: Map<PlacementId, number>
}

export function createAutoscaleState(doc: WorldDoc): AutoscaleState {
  const desiredCount = new Map<PlacementId, number>()
  for (const pl of Object.values(doc.placements)) {
    desiredCount.set(pl.id, pl.autoscale ? pl.autoscale.minCount : pl.count)
  }
  return { desiredCount, lastScaleUpAt: new Map(), lastScaleDownAt: new Map() }
}

/**
 * (instanceId) -> is this instance currently in the running set (vs. parked past desiredCount).
 * Mirrors failover.ts's effectiveRoleResolver: a closure built once per desiredCount change,
 * with a fast path when there is nothing tracked to overlay against the compiled envelope.
 */
export function runningSetResolver(
  compiled: CompiledWorld,
  desiredCount: Map<PlacementId, number>,
): (instanceId: InstanceId) => boolean {
  if (desiredCount.size === 0) return () => true
  return (instanceId: InstanceId) => {
    const inst = compiled.instances[instanceId]
    if (!inst) return false
    const desired = desiredCount.get(inst.placementId)
    if (desired === undefined) return true // not an autoscaled/tracked placement -> always running
    return inst.indexInPlacement < desired
  }
}

export function evaluatePolicy(
  placement: Placement,
  observedCpuPercent: number,
  state: AutoscaleState,
  simMs: number,
): { next: number; scaled: 'out' | 'in' | null } {
  const policy = placement.autoscale as AutoscalePolicy
  const current = state.desiredCount.get(placement.id) ?? policy.minCount
  const ratio = observedCpuPercent / policy.targetCpuPercent
  const proposedRaw = Math.ceil(current * ratio)
  const clamp = (n: number) => Math.max(policy.minCount, Math.min(policy.maxCount, n))

  if (proposedRaw > current) {
    const lastUp = state.lastScaleUpAt.get(placement.id) ?? -Infinity
    if (simMs - lastUp < policy.scaleUpCooldownSec * 1000) return { next: current, scaled: null }
    const stepped = policy.scaleStep ? Math.min(proposedRaw, current + policy.scaleStep) : proposedRaw
    const next = clamp(stepped)
    if (next === current) return { next, scaled: null }
    state.desiredCount.set(placement.id, next)
    state.lastScaleUpAt.set(placement.id, simMs)
    return { next, scaled: 'out' }
  }

  if (proposedRaw < current) {
    const lastDown = state.lastScaleDownAt.get(placement.id) ?? -Infinity
    if (simMs - lastDown < policy.scaleDownCooldownSec * 1000) return { next: current, scaled: null }
    const stepped = policy.scaleStep ? Math.max(proposedRaw, current - policy.scaleStep) : proposedRaw
    const next = clamp(stepped)
    if (next === current) return { next, scaled: null }
    state.desiredCount.set(placement.id, next)
    state.lastScaleDownAt.set(placement.id, simMs)
    return { next, scaled: 'in' }
  }

  return { next: current, scaled: null }
}
