// Failover machinery: manual outage switches, ported health onset/recovery hysteresis,
// AZ drain ramp, and stateful replica promotion. Spec decision 7 (and decision 2 for the
// hysteresis port), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// Emits contract EngineEvents; the facade (Task 12) owns id re-sequencing and observation.
import type { AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc, PlacementRole } from '../world/types'
import { managedDbEngine } from '../world/types'
import type { EngineEvent, HealthState } from './types'

const DRAIN_MS = 2000               // existing traffic on a downed AZ ramps out over 2s (spec decision 7)

// Instantaneous-severity thresholds (ported approximations of the legacy health signals).
// Only the hysteresis timing is behaviourally load-bearing; these bands classify a single tick.
const DOWN_ERROR_RATE = 0.5
const DOWN_CPU_PRESSURE = 2
const DEGRADED_ERROR_RATE = 0.1
const DEGRADED_CPU_PRESSURE = 1

export interface HealthHysteresis {
  onsetMs: number     // a worsening must persist this long before it commits
  recoveryMs: number  // an improvement must hold this long before it commits
}

// Legacy onset debounce 3000ms / recovery lock 5000ms (skeleton T9; legacy used an 8s
// recovery lock — SKELETON CONCERNS #7 keeps the skeleton's 5s since it's a parameter).
export const DEFAULT_HYSTERESIS: HealthHysteresis = { onsetMs: 3000, recoveryMs: 5000 }

export interface FailoverState {
  manualOutages: Set<string>
  healthByScope: Map<string, HealthState>
  drainUntil: Map<AzId, number>
  promotedAt: Map<PlacementId, number>
  onsetPendingSince: Map<string, number>
  recoveryUntil: Map<string, number>
  // When each currently-down managed service went down (node-model Phase 5.4), so a multi-AZ DB
  // can auto-recover once its failover window elapses. Cleared on recovery or manual restore.
  managedDownSince: Map<string, number>
}

export function createFailoverState(): FailoverState {
  return {
    manualOutages: new Set(),
    healthByScope: new Map(),
    drainUntil: new Map(),
    promotedAt: new Map(),
    onsetPendingSince: new Map(),
    recoveryUntil: new Map(),
    managedDownSince: new Map(),
  }
}

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

function outageEvent(
  kind: 'outage_triggered' | 'outage_cleared',
  scope: 'server' | 'az' | 'region' | 'managed',
  id: string,
  simMs: number,
): EngineEvent {
  const down = kind === 'outage_triggered'
  return {
    id: `outage-${scope}-${id}-${down ? 'down' : 'up'}-${simMs}`,
    simMs,
    kind,
    severity: down ? 'critical' : 'info',
    message: `${scope} ${id} manually ${down ? 'taken down' : 'restored'}`,
    affected: [id],
  }
}

export function beginDrain(state: FailoverState, azId: AzId, simMs: number): void {
  if (!state.drainUntil.has(azId)) state.drainUntil.set(azId, simMs + DRAIN_MS)
}

export function clearDrain(state: FailoverState, azId: AzId): void {
  state.drainUntil.delete(azId)
}

export function drainFactor(state: FailoverState, azId: AzId, simMs: number): number {
  const until = state.drainUntil.get(azId)
  if (until === undefined) return 0
  return Math.max(0, Math.min(1, (until - simMs) / DRAIN_MS))
}

// Idempotent manual switch: an event is returned ONLY when the outage set actually changes.
export function setOutage(
  state: FailoverState,
  scope: 'server' | 'az' | 'region' | 'managed',
  id: string,
  down: boolean,
  simMs = 0,
): EngineEvent[] {
  const already = state.manualOutages.has(id)
  if (down && !already) {
    state.manualOutages.add(id)
    state.healthByScope.set(id, 'down')
    if (scope === 'az') beginDrain(state, id, simMs)
    // Phase 5.4: start the failover clock so a multi-AZ managed DB can promote its standby.
    if (scope === 'managed') state.managedDownSince.set(id, simMs)
    return [outageEvent('outage_triggered', scope, id, simMs)]
  }
  if (!down && already) {
    state.manualOutages.delete(id)
    if (scope === 'az') clearDrain(state, id)
    if (scope === 'managed') state.managedDownSince.delete(id)
    return [outageEvent('outage_cleared', scope, id, simMs)]
  }
  return []
}

// How long a multi-AZ managed DB takes to promote its standby and come back (node-model Phase 5.4).
// Real RDS/Cloud SQL multi-AZ failovers land in the tens of seconds; this is the sim's equivalent.
export const MANAGED_FAILOVER_WINDOW_MS = 15_000
// Each promotion tier above 0 waits this much longer — the ordering knob made observable, since a
// managed DB's replicas are anonymous (the lightweight locality model has no per-replica entities).
export const MANAGED_PROMOTION_TIER_STEP_MS = 5_000

// Multi-AZ managed DBs recover on their own: the standby promotes after the failover window, so
// killing one is a blip rather than a permanent outage. A SINGLE-AZ DB has nothing to promote and
// stays down until manually restored — which is precisely what makes multiAz worth paying for.
// Only managed DBs participate; other managed types have no standby model.
export function recoverMultiAzManagedDbs(
  state: FailoverState,
  doc: WorldDoc,
  simMs: number,
): EngineEvent[] {
  const events: EngineEvent[] = []
  for (const [id, since] of [...state.managedDownSince]) {
    const ms = doc.managedServices[id]
    if (!ms || !managedDbEngine(ms.nodeType) || !ms.multiAz) continue
    const window = MANAGED_FAILOVER_WINDOW_MS
      + Math.max(0, ms.promotionTier ?? 0) * MANAGED_PROMOTION_TIER_STEP_MS
    if (simMs - since < window) continue
    state.manualOutages.delete(id)
    state.managedDownSince.delete(id)
    state.healthByScope.set(id, 'healthy')
    events.push({
      id: `managed-promote-${id}-${simMs}`,
      simMs,
      kind: 'replica_promoted',
      severity: 'warning',
      message: `${ms.label} promoted its multi-AZ standby after failover`,
      affected: [id],
    })
  }
  return events
}

/** The raw signal a health-check probe observes for a scope: manual outage or the scope's own
 *  error/pressure levels — never `checkFailed`, which is the check system's own OUTPUT.
 *  runHealthChecks must be fed this, not computeHealth's result: feeding the computed health
 *  back in deadlocked recovery (down → probe "fails" → checkFailed → instant down → still
 *  down next step, forever — a restored region never came back). */
export function probeInstant(inputs: { errorRate: number; cpuPressure: number; manualDown: boolean }): HealthState {
  if (inputs.manualDown) return 'down'
  return inputs.errorRate >= DOWN_ERROR_RATE || inputs.cpuPressure >= DOWN_CPU_PRESSURE
    ? 'down'
    : inputs.errorRate >= DEGRADED_ERROR_RATE || inputs.cpuPressure >= DEGRADED_CPU_PRESSURE
      ? 'degraded'
      : 'healthy'
}

export function computeHealth(
  state: FailoverState,
  scopeId: string,
  inputs: { errorRate: number; cpuPressure: number; checkFailed: boolean; manualDown: boolean },
  simMs: number,
  hysteresis: HealthHysteresis,
): HealthState {
  if (inputs.manualDown) {
    state.healthByScope.set(scopeId, 'down')
    state.onsetPendingSince.delete(scopeId)
    state.recoveryUntil.delete(scopeId)
    return 'down'
  }

  const instant: HealthState =
    inputs.checkFailed || inputs.errorRate >= DOWN_ERROR_RATE || inputs.cpuPressure >= DOWN_CPU_PRESSURE
      ? 'down'
      : inputs.errorRate >= DEGRADED_ERROR_RATE || inputs.cpuPressure >= DEGRADED_CPU_PRESSURE
        ? 'degraded'
        : 'healthy'

  const prev = state.healthByScope.get(scopeId) ?? 'healthy'
  let next = prev

  if (SEVERITY[instant] > SEVERITY[prev]) {
    // worsening — debounce onset
    state.recoveryUntil.delete(scopeId)
    const since = state.onsetPendingSince.get(scopeId)
    if (since === undefined) {
      state.onsetPendingSince.set(scopeId, simMs)
    } else if (simMs - since >= hysteresis.onsetMs) {
      next = instant
      state.onsetPendingSince.delete(scopeId)
    }
  } else if (SEVERITY[instant] < SEVERITY[prev]) {
    // improving — hold the recovery lock
    state.onsetPendingSince.delete(scopeId)
    const until = state.recoveryUntil.get(scopeId)
    if (until === undefined) {
      state.recoveryUntil.set(scopeId, simMs + hysteresis.recoveryMs)
    } else if (simMs >= until) {
      next = instant
      state.recoveryUntil.delete(scopeId)
    }
  } else {
    // stable at the current severity — cancel any pending transition
    state.onsetPendingSince.delete(scopeId)
    state.recoveryUntil.delete(scopeId)
  }

  state.healthByScope.set(scopeId, next)
  return next
}

// The promoted-role OVERLAY (node-model Phase 4). Promotion must be REAL — writes have to fail
// over to the promoted replica — but it must NOT mutate the WorldDoc: `compiled` is derived from
// the doc, and world.store's mutate() pushes undo history and marks the file dirty, so a running
// simulation writing the document would corrupt both. Instead the engine holds the promotion in
// `promotedAt` (set by promoteReplicas) and the flow solver consults THIS resolver for the
// EFFECTIVE role, leaving the compiled role — and the doc — untouched.
//
//   promoted replica  → 'primary'  (writes route to it)
//   failed original   → 'replica'  (demoted; it's down, so it serves nothing until it recovers)
//   everything else   → its compiled role
//
// Fast path: with no promotions (the overwhelming common case) this is just a compiled-role
// lookup, so a healthy sim pays nothing for the overlay.
export function effectiveRoleResolver(
  compiled: CompiledWorld,
  promotedAt: Map<PlacementId, number>,
): (instanceId: InstanceId) => PlacementRole {
  if (promotedAt.size === 0) {
    return (id) => compiled.instances[id]?.role ?? 'primary'
  }

  // Clusters ('blueprintId|regionId') that have a promotion, and the placements that were promoted.
  const promotedClusters = new Set<string>()
  for (const inst of Object.values(compiled.instances)) {
    if (promotedAt.has(inst.placementId)) promotedClusters.add(`${inst.blueprintId}|${inst.regionId}`)
  }

  return (id) => {
    const inst = compiled.instances[id]
    if (!inst) return 'primary'
    if (promotedAt.has(inst.placementId)) return 'primary'
    if (inst.role === 'primary' && promotedClusters.has(`${inst.blueprintId}|${inst.regionId}`)) return 'replica'
    return inst.role
  }
}

// Primary down -> promote the oldest same-blueprint, same-region replica (spec decision 7).
// The promotion is now REAL: effectiveRoleResolver above flips routing to the promoted replica.
// Emits once per (blueprint, region) via the promotedAt guard.
export function promoteReplicas(
  state: FailoverState,
  compiled: CompiledWorld,
  doc: WorldDoc,
  downInstanceIds: InstanceId[],
  simMs: number,
): EngineEvent[] {
  const events: EngineEvent[] = []
  const downSet = new Set(downInstanceIds)

  for (const downId of downInstanceIds) {
    const primary = compiled.instances[downId]
    if (!primary || primary.role !== 'primary') continue

    const siblingReplicas = Object.values(compiled.instances).filter(
      i => i.role === 'replica' && i.blueprintId === primary.blueprintId && i.regionId === primary.regionId,
    )
    // already promoted a replica for this (blueprint, region)? emit-once guard.
    if (siblingReplicas.some(i => state.promotedAt.has(i.placementId))) continue

    const chosen = siblingReplicas
      .filter(i => !downSet.has(i.id))
      .sort((a, b) => a.id.localeCompare(b.id))[0]
    if (!chosen) continue

    state.promotedAt.set(chosen.placementId, simMs)
    const bpName = doc.blueprints[primary.blueprintId]?.name ?? primary.blueprintId
    events.push({
      id: `promote-${chosen.id}-${simMs}`,
      simMs,
      kind: 'replica_promoted',
      severity: 'warning',
      message: `${bpName} replica ${chosen.id} promoted to primary after ${downId} failed`,
      affected: [chosen.id, downId],
    })
  }

  return events
}
