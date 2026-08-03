// Failover machinery: manual outage switches, ported health onset/recovery hysteresis,
// AZ drain ramp, and stateful replica promotion. Spec decision 7 (and decision 2 for the
// hysteresis port), docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
// Emits contract EngineEvents; the facade (Task 12) owns id re-sequencing and observation.
import type { AzId, PlacementId, InstanceId, CompiledWorld, WorldDoc, PlacementRole, ServiceInstance } from '../world/types'
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

// Why a managed service is down (audit ISSUE-008): a MANUAL operator kill stays down until the
// operator explicitly resumes it; a SIMULATED infrastructure failure (its AZ going down) may
// auto-recover — a multi-AZ DB promotes its standby after the failover window.
export type OutageSource = 'manual' | 'simulated'
export interface ManagedOutage { sinceMs: number; source: OutageSource }

export type OutageScope = 'server' | 'az' | 'region' | 'managed'

// Outage-set key (audit ISSUE-044): keyed `${scope}:${id}`, never the bare id — a bare-id set
// silently ignored the scope argument, so any id collision across scopes (e.g. an AZ and a
// managed service sharing an id) cross-triggered each other's outage.
export function outageKey(scope: OutageScope, id: string): string {
  return `${scope}:${id}`
}

export function hasOutage(state: FailoverState, scope: OutageScope, id: string): boolean {
  return state.manualOutages.has(outageKey(scope, id))
}

export interface FailoverState {
  // Every currently-down scope regardless of source — the single set flows.ts/index.ts read,
  // keyed by outageKey(scope, id) (audit ISSUE-044).
  // (The name predates the manual/simulated split; the source tag lives in managedDownSince.)
  manualOutages: Set<string>
  healthByScope: Map<string, HealthState>
  drainUntil: Map<AzId, number>
  promotedAt: Map<PlacementId, number>
  // Ownership bookkeeping for FEAT-002's cross-region self-promotion path (index.ts, Task 12),
  // kept SEPARATE from promotedAt (audit final-review C1). promotedAt is written by BOTH
  // promoteReplicas (same-region HA, below) and the cross-region isolation path — both write the
  // SAME overlay so effectiveRoleResolver sees one unified promoted set for routing purposes. But
  // failback for each mechanism must ask "did I, specifically, promote this?", never "is this
  // promoted at all?" — the earlier bug was the cross-region block reading `alreadyPromoted` off
  // promotedAt and deleting an entry promoteReplicas itself had written, causing perpetual
  // promote/failback flapping. isolationPromotedAt is this block's OWN record of exactly the
  // placements IT promoted, so its failback only ever reverses its own action. Combined with the
  // orphan-replica eligibility guard in index.ts's start() (a replica with a same-region authored
  // primary is NEVER a candidate here), the two mechanisms' promotedAt writes are additionally
  // guaranteed to land in disjoint blueprint|region clusters, so promoteReplicas/failbackPromotions
  // (same-region cluster keyed) can never observe or touch an isolation-promoted placement either.
  isolationPromotedAt: Map<PlacementId, number>
  onsetPendingSince: Map<string, number>
  recoveryUntil: Map<string, number>
  // When and WHY each currently-down managed service went down (node-model Phase 5.4 + audit
  // ISSUE-008), so a multi-AZ DB can auto-recover a SIMULATED failure once its failover window
  // elapses — while a manual operator outage is never auto-cancelled. Cleared on recovery/restore.
  managedDownSince: Map<string, ManagedOutage>
}

export function createFailoverState(): FailoverState {
  return {
    manualOutages: new Set(),
    healthByScope: new Map(),
    drainUntil: new Map(),
    promotedAt: new Map(),
    isolationPromotedAt: new Map(),
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
  scope: OutageScope,
  id: string,
  down: boolean,
  simMs = 0,
): EngineEvent[] {
  const key = outageKey(scope, id)
  const already = state.manualOutages.has(key)
  if (down && !already) {
    state.manualOutages.add(key)
    state.healthByScope.set(id, 'down')
    if (scope === 'az') beginDrain(state, id, simMs)
    // Phase 5.4 + audit ISSUE-008: record the outage as MANUAL — the operator owns it, so the
    // multi-AZ auto-recovery below must never cancel it.
    if (scope === 'managed') state.managedDownSince.set(id, { sinceMs: simMs, source: 'manual' })
    return [outageEvent('outage_triggered', scope, id, simMs)]
  }
  if (!down && already) {
    state.manualOutages.delete(key)
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

// Multi-AZ managed DBs recover from SIMULATED infrastructure failures on their own: the standby
// promotes after the failover window, so an AZ failure is a blip rather than a permanent outage.
// A SINGLE-AZ DB has nothing to promote and stays down until its AZ recovers — which is precisely
// what makes multiAz worth paying for. A MANUAL operator outage is never auto-cancelled (audit
// ISSUE-008): it stays down until the operator resumes it. Only managed DBs participate; other
// managed types have no standby model.
export function recoverMultiAzManagedDbs(
  state: FailoverState,
  doc: WorldDoc,
  simMs: number,
): EngineEvent[] {
  const events: EngineEvent[] = []
  for (const [id, outage] of [...state.managedDownSince]) {
    if (outage.source === 'manual') continue   // the operator said down — honor it (ISSUE-008)
    const ms = doc.managedServices[id]
    if (!ms || !managedDbEngine(ms.nodeType) || !ms.multiAz) continue
    const window = MANAGED_FAILOVER_WINDOW_MS
      + Math.max(0, ms.promotionTier ?? 0) * MANAGED_PROMOTION_TIER_STEP_MS
    if (simMs - outage.sinceMs < window) continue
    state.manualOutages.delete(outageKey('managed', id))
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

// AZ-outage propagation (audit ISSUE-008): when an AZ fails, every managed service scoped to it
// goes down as a SIMULATED outage — the source that recoverMultiAzManagedDbs may auto-recover.
// When the AZ recovers, simulated outages clear; MANUAL operator outages are never touched in
// either direction (an AZ failing can't overwrite operator intent, and an AZ recovering can't
// resurrect a service the operator explicitly killed).
export function applyAzOutageToManaged(
  state: FailoverState,
  doc: WorldDoc,
  azId: AzId,
  down: boolean,
  simMs: number,
): EngineEvent[] {
  const events: EngineEvent[] = []
  for (const ms of Object.values(doc.managedServices)) {
    if (ms.scope.kind !== 'az' || ms.scope.azId !== azId) continue
    if (down) {
      if (hasOutage(state, 'managed', ms.id)) continue   // already down (manual wins; idempotent)
      state.manualOutages.add(outageKey('managed', ms.id))
      state.managedDownSince.set(ms.id, { sinceMs: simMs, source: 'simulated' })
      state.healthByScope.set(ms.id, 'down')
      events.push({
        id: `azfail-${ms.id}-down-${simMs}`,
        simMs,
        kind: 'outage_triggered',
        severity: 'critical',
        message: `${ms.label} unavailable — its AZ is down`,
        affected: [ms.id],
      })
    } else {
      if (state.managedDownSince.get(ms.id)?.source !== 'simulated') continue
      state.manualOutages.delete(outageKey('managed', ms.id))
      state.managedDownSince.delete(ms.id)
      state.healthByScope.set(ms.id, 'healthy')
      events.push({
        id: `azfail-${ms.id}-up-${simMs}`,
        simMs,
        kind: 'outage_cleared',
        severity: 'info',
        message: `${ms.label} restored — its AZ recovered`,
        affected: [ms.id],
      })
    }
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

const HEALTH_RANK: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }

// Primary down -> promote the healthiest same-blueprint, same-region replica (spec decision 7,
// audit ISSUE-007 — health stands in for replication lag in the lightweight model; the id compare
// is only a determinism tiebreak). The promotion is REAL: effectiveRoleResolver above flips
// routing to the promoted replica. Effective roles also gate re-entry: a still-down ORIGINAL
// primary resolves 'replica' after failover (no duplicate emit), while a failed PROMOTED primary
// resolves 'primary' — so a second failure in the cluster re-promotes a surviving replica,
// clearing the stale promotion.
export function promoteReplicas(
  state: FailoverState,
  compiled: CompiledWorld,
  doc: WorldDoc,
  downInstanceIds: InstanceId[],
  simMs: number,
  healthOf?: (id: InstanceId) => HealthState,
): EngineEvent[] {
  const events: EngineEvent[] = []
  const downSet = new Set(downInstanceIds)
  const roleOf = effectiveRoleResolver(compiled, state.promotedAt)
  const handledClusters = new Set<string>()

  for (const downId of downInstanceIds) {
    const primary = compiled.instances[downId]
    if (!primary || roleOf(downId) !== 'primary') continue
    const clusterKey = `${primary.blueprintId}|${primary.regionId}`
    if (handledClusters.has(clusterKey)) continue
    handledClusters.add(clusterKey)

    const siblingReplicas = Object.values(compiled.instances).filter(
      i => roleOf(i.id) === 'replica' && i.blueprintId === primary.blueprintId && i.regionId === primary.regionId,
    )

    const health = (i: ServiceInstance): HealthState => healthOf?.(i.id) ?? 'healthy'
    const chosen = siblingReplicas
      .filter(i => !downSet.has(i.id) && health(i) !== 'down')
      .sort((a, b) => (HEALTH_RANK[health(a)] - HEALTH_RANK[health(b)]) || a.id.localeCompare(b.id))[0]
    if (!chosen) continue

    // Re-promotion: the down effective primary may itself be a promoted replica — drop its stale
    // promotion so exactly one placement per cluster carries the overlay.
    state.promotedAt.delete(primary.placementId)
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

// Failback (audit ISSUE-007): once every AUTHORED primary of a promoted cluster is healthy again
// (the health hysteresis' recovery lock has already debounced this), clear the promotion overlay
// so writes route back to the original primary. Without this, promotedAt was never cleared — the
// recovered original stayed demoted forever.
export function failbackPromotions(
  state: FailoverState,
  compiled: CompiledWorld,
  doc: WorldDoc,
  healthOf: (id: InstanceId) => HealthState,
  simMs: number,
): EngineEvent[] {
  if (state.promotedAt.size === 0) return []
  const events: EngineEvent[] = []
  const instances = Object.values(compiled.instances)

  for (const placementId of [...state.promotedAt.keys()]) {
    const promotedInst = instances.find(i => i.placementId === placementId)
    if (!promotedInst) { state.promotedAt.delete(placementId); continue }   // placement gone from the doc
    const authoredPrimaries = instances.filter(
      i => i.role === 'primary' && i.blueprintId === promotedInst.blueprintId && i.regionId === promotedInst.regionId,
    )
    if (authoredPrimaries.length === 0) continue
    if (!authoredPrimaries.every(i => healthOf(i.id) === 'healthy')) continue

    state.promotedAt.delete(placementId)
    const bpName = doc.blueprints[promotedInst.blueprintId]?.name ?? promotedInst.blueprintId
    events.push({
      id: `failback-${promotedInst.id}-${simMs}`,
      simMs,
      kind: 'primary_failback',
      severity: 'info',
      message: `${bpName} primary recovered — writes failed back from promoted replica ${promotedInst.id}`,
      affected: [...authoredPrimaries.map(i => i.id), promotedInst.id],
    })
  }
  return events
}
