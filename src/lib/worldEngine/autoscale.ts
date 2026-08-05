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
 *
 * Task 15: an instance below `desired` (i.e. genuinely past the current envelope) is still
 * "running" — for CPU/RAM/publishing purposes — while it is draining. `drainUntilByInstance` is
 * passed through LIVE (the same mutated-in-place Map the engine owns), so this resolver does NOT
 * need to be rebuilt when a drain begins or completes — only the indexInPlacement/desired
 * relationship changes require a rebuild. This resolver answers ONLY "is this instance running"
 * (CPU/RAM/metrics), never "is this instance eligible for new work" — that is a SEPARATE
 * question, answered by two SEPARATE wrappers built in index.ts from this same resolver plus
 * `drainUntilByInstance`, one per tier: `routingHealthOfInstance` (Task 14) for the entry/LB
 * tier, and the `isEligibleForNewWork` predicate threaded into `FlowInput` (Wave 3 final review,
 * Important #1) for internal service-to-service fan-out and event-topic consumer seeding — both
 * exclude a draining instance from NEW work of any kind while it keeps finishing work already in
 * flight.
 */
export function runningSetResolver(
  compiled: CompiledWorld,
  desiredCount: Map<PlacementId, number>,
  drainUntilByInstance?: Map<InstanceId, number>,
): (instanceId: InstanceId) => boolean {
  if (desiredCount.size === 0) return () => true
  return (instanceId: InstanceId) => {
    const inst = compiled.instances[instanceId]
    if (!inst) return false
    const desired = desiredCount.get(inst.placementId)
    if (desired === undefined) return true // not an autoscaled/tracked placement -> always running
    return inst.indexInPlacement < desired || (drainUntilByInstance?.has(instanceId) ?? false)
  }
}

// ── Task 15: scale-in drain — instance-keyed clone of failover.ts's drainUntil/beginDrain/
// clearDrain/drainFactor pattern. Kept here (rather than a second copy in index.ts or a shared
// generalization of failover.ts's AZ-keyed version) so FEAT-008's pure mechanics stay in ONE file,
// per this task's brief. Same formula, same shape, different key (instance id, not AZ id) and a
// separate constant since an instance drain and an AZ drain are conceptually independent knobs
// even though they currently share the same 2000ms value.
export const INSTANCE_DRAIN_MS = 2000 // mirrors failover.ts's DRAIN_MS

export function beginInstanceDrain(
  drainUntilByInstance: Map<InstanceId, number>,
  instanceId: InstanceId,
  simMs: number,
): void {
  if (!drainUntilByInstance.has(instanceId)) drainUntilByInstance.set(instanceId, simMs + INSTANCE_DRAIN_MS)
}

export function clearInstanceDrain(drainUntilByInstance: Map<InstanceId, number>, instanceId: InstanceId): void {
  drainUntilByInstance.delete(instanceId)
}

export function instanceDrainFactor(
  drainUntilByInstance: Map<InstanceId, number>,
  instanceId: InstanceId,
  simMs: number,
): number {
  const until = drainUntilByInstance.get(instanceId)
  if (until === undefined) return 0
  return Math.max(0, Math.min(1, (until - simMs) / INSTANCE_DRAIN_MS))
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
