// Failover machinery: manual outage switches, ported health onset/recovery hysteresis,
// AZ drain ramp, and stateful replica promotion. Spec decision 7 (and decision 2 for the
// hysteresis port), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// Emits contract EngineEvents; the facade (Task 12) owns id re-sequencing and observation.
import type { AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc } from '../world/types'
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
}

export function createFailoverState(): FailoverState {
  return {
    manualOutages: new Set(),
    healthByScope: new Map(),
    drainUntil: new Map(),
    promotedAt: new Map(),
    onsetPendingSince: new Map(),
    recoveryUntil: new Map(),
  }
}

const SEVERITY: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

function outageEvent(
  kind: 'outage_triggered' | 'outage_cleared',
  scope: 'server' | 'az' | 'region',
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
  scope: 'server' | 'az' | 'region',
  id: string,
  down: boolean,
  simMs = 0,
): EngineEvent[] {
  const already = state.manualOutages.has(id)
  if (down && !already) {
    state.manualOutages.add(id)
    state.healthByScope.set(id, 'down')
    if (scope === 'az') beginDrain(state, id, simMs)
    return [outageEvent('outage_triggered', scope, id, simMs)]
  }
  if (!down && already) {
    state.manualOutages.delete(id)
    if (scope === 'az') clearDrain(state, id)
    return [outageEvent('outage_cleared', scope, id, simMs)]
  }
  return []
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

// Primary down -> promote the oldest same-blueprint, same-region replica (spec decision 7).
// Visual/event semantics only in Phase 2: no data ownership is modeled. Emits once per
// (blueprint, region) via the promotedAt guard.
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
