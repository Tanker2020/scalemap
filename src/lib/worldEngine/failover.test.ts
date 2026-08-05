import { describe, it, expect } from 'vitest'
import {
  createFailoverState, setOutage, computeHealth, probeInstant, promoteReplicas, drainFactor,
  beginDrain, DEFAULT_HYSTERESIS, effectiveRoleResolver, hasOutage,
  recoverMultiAzManagedDbs, MANAGED_FAILOVER_WINDOW_MS, MANAGED_PROMOTION_TIER_STEP_MS,
  failbackPromotions, applyAzOutageToManaged,
} from './failover'
import type { WorldDoc } from '../world/types'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'

const healthy = { errorRate: 0, cpuPressure: 0.5, checkFailed: false, manualDown: false }
const bad = { errorRate: 0.9, cpuPressure: 3, checkFailed: true, manualDown: false }

describe('setOutage', () => {
  it('forces a scope down, emits outage_triggered once, and is idempotent', () => {
    const state = createFailoverState()
    const events = setOutage(state, 'az', 'az-1', true, 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'outage_triggered', severity: 'critical', affected: ['az-1'], simMs: 1000 })
    expect(hasOutage(state, 'az', 'az-1')).toBe(true)
    expect(state.healthByScope.get('az-1')).toBe('down')
    // idempotent — no second event for an already-down scope
    expect(setOutage(state, 'az', 'az-1', true, 2000)).toEqual([])
    // manualDown forces 'down' through computeHealth regardless of signals
    expect(computeHealth(state, 'az-1', { ...healthy, manualDown: true }, 3000, DEFAULT_HYSTERESIS)).toBe('down')
  })

  it('clears an outage and emits outage_cleared exactly once', () => {
    const state = createFailoverState()
    setOutage(state, 'region', 'r-1', true, 0)
    const cleared = setOutage(state, 'region', 'r-1', false, 5000)
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ kind: 'outage_cleared', affected: ['r-1'], simMs: 5000 })
    expect(hasOutage(state, 'region', 'r-1')).toBe(false)
    expect(setOutage(state, 'region', 'r-1', false, 6000)).toEqual([]) // already cleared
  })

  // Audit ISSUE-044: the outage set is keyed `${scope}:${id}` — an id shared across scopes must
  // never cross-trigger (taking down az X is not taking down managed X).
  it('an id shared across scopes does not cross-trigger (ISSUE-044)', () => {
    const state = createFailoverState()
    setOutage(state, 'az', 'X', true, 0)
    expect(hasOutage(state, 'az', 'X')).toBe(true)
    expect(hasOutage(state, 'managed', 'X')).toBe(false)
    expect(hasOutage(state, 'server', 'X')).toBe(false)
    // Resuming the (never-down) managed X is a no-op and leaves the AZ outage in place.
    expect(setOutage(state, 'managed', 'X', false, 100)).toEqual([])
    expect(hasOutage(state, 'az', 'X')).toBe(true)
  })

  // node-model Phase 5.2: managed services can be taken down. Same set/clear machinery; the flow
  // solver reads state.manualOutages directly to fail traffic to a down managed service.
  it('takes a managed service down and restores it (managed scope)', () => {
    const state = createFailoverState()
    const down = setOutage(state, 'managed', 'ms-queue', true, 1000)
    expect(down[0]).toMatchObject({ kind: 'outage_triggered', affected: ['ms-queue'] })
    expect(hasOutage(state, 'managed', 'ms-queue')).toBe(true)
    const up = setOutage(state, 'managed', 'ms-queue', false, 2000)
    expect(up[0]).toMatchObject({ kind: 'outage_cleared', affected: ['ms-queue'] })
    expect(hasOutage(state, 'managed', 'ms-queue')).toBe(false)
  })
})

describe('computeHealth — hysteresis', () => {
  it('debounces onset: two bad ticks inside onsetMs keep the scope healthy', () => {
    const state = createFailoverState()
    expect(computeHealth(state, 's-1', bad, 0, DEFAULT_HYSTERESIS)).toBe('healthy')       // pending starts
    expect(computeHealth(state, 's-1', bad, 2000, DEFAULT_HYSTERESIS)).toBe('healthy')     // 2s < 3s
    expect(computeHealth(state, 's-1', bad, 3001, DEFAULT_HYSTERESIS)).toBe('down')        // >= onsetMs -> commit
  })

  it('locks recovery: a healed scope stays down until recoveryMs elapses', () => {
    const state = createFailoverState()
    // drive it down first
    computeHealth(state, 's-2', bad, 0, DEFAULT_HYSTERESIS)
    computeHealth(state, 's-2', bad, 3001, DEFAULT_HYSTERESIS)
    expect(state.healthByScope.get('s-2')).toBe('down')
    // now healthy signals — recovery lock holds
    expect(computeHealth(state, 's-2', healthy, 4000, DEFAULT_HYSTERESIS)).toBe('down')    // lock starts
    expect(computeHealth(state, 's-2', healthy, 8000, DEFAULT_HYSTERESIS)).toBe('down')    // 4s < 5s
    expect(computeHealth(state, 's-2', healthy, 9001, DEFAULT_HYSTERESIS)).toBe('healthy') // >= recoveryMs
  })
})

describe('drainFactor', () => {
  it('ramps 1 -> 0 across DRAIN_MS (2000) after the AZ goes down', () => {
    const state = createFailoverState()
    beginDrain(state, 'az-9', 0)
    expect(drainFactor(state, 'az-9', 0)).toBeCloseTo(1, 5)
    expect(drainFactor(state, 'az-9', 1000)).toBeCloseTo(0.5, 5)
    expect(drainFactor(state, 'az-9', 2000)).toBeCloseTo(0, 5)
    expect(drainFactor(state, 'az-9', 2500)).toBe(0)
    expect(drainFactor(state, 'az-other', 0)).toBe(0)   // no drain entry
  })
})

describe('promoteReplicas', () => {
  // 1 region, 2 AZs; a primary in az-a and a replica of the same blueprint in az-b.
  function replicaFixture() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    const bp = createBlueprint('db', 0)
    bp.stateful = true
    const primary = createPlacement(bp.id, sA.id)          // role 'primary' by default
    const replica = createPlacement(bp.id, sB.id)
    replica.role = 'replica'
    doc.regions[region.id] = region
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB })
    Object.assign(doc.servers, { [sA.id]: sA, [sB.id]: sB })
    doc.blueprints[bp.id] = bp
    Object.assign(doc.placements, { [primary.id]: primary, [replica.id]: replica })
    const compiled = compileWorld(doc)
    return { doc, compiled, primaryInst: instanceId(primary.id, 0), replicaInst: instanceId(replica.id, 0) }
  }

  it('promotes the same-blueprint same-region replica and emits replica_promoted once', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'replica_promoted', simMs: 1000 })
    expect(events[0].affected).toContain(f.replicaInst)
    expect(events[0].affected).toContain(f.primaryInst)
    // called again while still promoted -> no duplicate event
    expect(promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 2000)).toEqual([])
  })

  // FEAT-008 (Task 19 consumer audit): since Task 11, `compiled.instances` carries an autoscaled
  // placement's full maxCount ENVELOPE, including parked (not-running) slots. A parked replica is
  // not a real standby — it has no CPU/RAM scheduled (Task 13), receives no traffic (Task 14) and
  // publishes no metrics (Task 16) — so promoting it would hand the cluster's primary role to an
  // instance that cannot serve. `healthOfInstance` deliberately knows nothing about running/parked
  // (index.ts scopes the running check to routing only), so a parked replica reads 'healthy' and,
  // absent an explicit running filter, wins the sort outright on the id tiebreak.
  it('never promotes a parked (scaled-in) replica when a running sibling exists', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    // A SECOND replica placement, created after the fixture's own, so the fixture's replica sorts
    // first on the id tiebreak (both healthy, no lag data) and would be chosen without a running
    // filter. Mark the fixture's replica parked and the newcomer running.
    const bpId = f.doc.placements[Object.keys(f.doc.placements)[0]].blueprintId
    const serverB = Object.values(f.doc.servers).find(s => s.id !== f.doc.placements[Object.keys(f.doc.placements)[0]].serverId)!
    const extra = createPlacement(bpId, serverB.id)
    extra.role = 'replica'
    f.doc.placements[extra.id] = extra
    const compiled = compileWorld(f.doc)
    const runningReplica = instanceId(extra.id, 0)
    const isRunning = (id: string) => id !== f.replicaInst

    const events = promoteReplicas(
      state, compiled, f.doc, [f.primaryInst], 1000, undefined, undefined, undefined, isRunning,
    )
    expect(events).toHaveLength(1)
    expect(events[0].affected).toContain(runningReplica)
    expect(events[0].affected).not.toContain(f.replicaInst)
  })

  it('does not promote at all when every replica in the cluster is parked', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    const events = promoteReplicas(
      state, f.compiled, f.doc, [f.primaryInst], 1000, undefined, undefined, undefined, () => false,
    )
    expect(events).toEqual([])
    expect(state.promotedAt.size).toBe(0)
  })

  it('does nothing when the down instance is not a primary', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    expect(promoteReplicas(state, f.compiled, f.doc, [f.replicaInst], 1000)).toEqual([])
  })

  // 1 primary + 2 replicas in three AZs — selection & re-promotion (audit ISSUE-007).
  function twoReplicaFixture() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const azC = createAz(region.id, 'us-east-1c')
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    const sC = createServer(azC.id, getPreset('dedicated-8')!)
    const bp = createBlueprint('db', 0)
    bp.stateful = true
    const primary = createPlacement(bp.id, sA.id)
    const replicaA = createPlacement(bp.id, sB.id); replicaA.role = 'replica'
    const replicaB = createPlacement(bp.id, sC.id); replicaB.role = 'replica'
    doc.regions[region.id] = region
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB, [azC.id]: azC })
    Object.assign(doc.servers, { [sA.id]: sA, [sB.id]: sB, [sC.id]: sC })
    doc.blueprints[bp.id] = bp
    Object.assign(doc.placements, { [primary.id]: primary, [replicaA.id]: replicaA, [replicaB.id]: replicaB })
    const compiled = compileWorld(doc)
    return {
      doc, compiled, primaryInst: instanceId(primary.id, 0),
      // Sorted lexically: the OLD selector always picked replicaInsts[0].
      replicaInsts: [instanceId(replicaA.id, 0), instanceId(replicaB.id, 0)].sort((a, b) => a.localeCompare(b)),
      placementOf: (iid: string) => compiled.instances[iid].placementId,
    }
  }

  it('prefers a healthier replica over the lexically-first one (audit ISSUE-007)', () => {
    const f = twoReplicaFixture()
    const [first, second] = f.replicaInsts
    const state = createFailoverState()
    const healthOf = (id: string) => (id === first ? 'degraded' as const : 'healthy' as const)
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000, healthOf)
    expect(events).toHaveLength(1)
    expect(state.promotedAt.has(f.placementOf(second))).toBe(true)
    expect(state.promotedAt.has(f.placementOf(first))).toBe(false)
  })

  it('re-promotes a second replica when the promoted one later fails (audit ISSUE-007)', () => {
    const f = twoReplicaFixture()
    const state = createFailoverState()
    promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    const [promoted, survivor] = f.replicaInsts       // all healthy ⇒ deterministic id tiebreak
    expect(state.promotedAt.has(f.placementOf(promoted))).toBe(true)
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst, promoted], 2000)
    expect(events).toHaveLength(1)
    expect(events[0].affected).toContain(survivor)
    expect(state.promotedAt.has(f.placementOf(promoted))).toBe(false)   // stale promotion cleared
    expect(state.promotedAt.has(f.placementOf(survivor))).toBe(true)
  })

  // Failback (audit ISSUE-007): once the authored primary is healthy again the promotion
  // overlay clears and writes route back to it.
  it('fails back — clears the promotion and reverts roles once the authored primary recovers', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    expect(state.promotedAt.size).toBe(1)
    const events = failbackPromotions(state, f.compiled, f.doc, () => 'healthy', 30_000)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('primary_failback')
    expect(state.promotedAt.size).toBe(0)
    const roleOf = effectiveRoleResolver(f.compiled, state.promotedAt)
    expect(roleOf(f.primaryInst)).toBe('primary')
    expect(roleOf(f.replicaInst)).toBe('replica')
  })

  it('holds the promotion while the authored primary is still down', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    const events = failbackPromotions(state, f.compiled, f.doc, id => (id === f.primaryInst ? 'down' : 'healthy'), 30_000)
    expect(events).toEqual([])
    expect(state.promotedAt.size).toBe(1)
  })

  // FEAT-005 (Task 13): among equally-healthy candidates, the least-lagged replica wins — today's
  // health-only sort is indifferent between two healthy replicas and falls back to the id
  // tiebreak, which this test's fixture deliberately defeats (the lexically-LATER replica has the
  // lower lag) to prove the sort key actually changed.
  it('promoteReplicas selects the least-lagged healthy replica, not merely the first healthy one', () => {
    const f = twoReplicaFixture()
    const [first, second] = f.replicaInsts   // id-tiebreak would normally pick `first`
    const state = createFailoverState()
    const lagByInstance = new Map([[first, 3], [second, 0.5]])
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000, undefined, lagByInstance)
    expect(events).toHaveLength(1)
    expect(state.promotedAt.has(f.placementOf(second))).toBe(true)
    expect(state.promotedAt.has(f.placementOf(first))).toBe(false)
  })

  // FEAT-005 (Task 13): the RPO payload — dataLossWindowSec is the CHOSEN replica's lag,
  // estimatedLostWrites = lagSec * writeRps, both only stamped when the caller supplies the maps.
  it('RPO: replica_promoted event carries dataLossWindowSec matching the promoted replica lag, and estimatedLostWrites = lagSec * writeRps', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    const lagByInstance = new Map([[f.replicaInst, 2]])
    const writeRpsByReplica = new Map([[f.replicaInst, 150]])
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000, undefined, lagByInstance, writeRpsByReplica)
    const ev = events.find(e => e.kind === 'replica_promoted')!
    expect(ev.payload?.dataLossWindowSec).toBeCloseTo(2, 5)
    expect(ev.payload?.estimatedLostWrites).toBeCloseTo(300, 5)
  })

  // Omitting the new params entirely (today's existing call shape) must produce no payload at all.
  it('omits the RPO payload when lag data is not supplied (pre-FEAT-005 callers unaffected)', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    const events = promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    const ev = events.find(e => e.kind === 'replica_promoted')!
    expect(ev.payload).toBeUndefined()
  })
})

describe('probeInstant', () => {
  // The health-check probe signal: manual outage + raw error/pressure — NEVER checkFailed,
  // which is the check system's own output (feeding that back deadlocked recovery).
  it('reports down for a manual outage regardless of other signals', () => {
    expect(probeInstant({ errorRate: 0, cpuPressure: 0, manualDown: true })).toBe('down')
  })

  it('mirrors computeHealth instant thresholds without checkFailed', () => {
    expect(probeInstant({ errorRate: 0, cpuPressure: 0, manualDown: false })).toBe('healthy')
    expect(probeInstant({ errorRate: 0.1, cpuPressure: 0, manualDown: false })).toBe('degraded')
    expect(probeInstant({ errorRate: 0, cpuPressure: 1, manualDown: false })).toBe('degraded')
    expect(probeInstant({ errorRate: 0.5, cpuPressure: 0, manualDown: false })).toBe('down')
    expect(probeInstant({ errorRate: 0, cpuPressure: 2, manualDown: false })).toBe('down')
  })
})

describe('effectiveRoleResolver', () => {
  // Reuse promoteReplicas' fixture shape: a primary in az-a, a replica in az-b of one blueprint.
  function fixture() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    const bp = createBlueprint('db', 0); bp.kind = 'db-sql'; bp.dbConfig = { engine: 'sql', storageGb: 100 }
    const primary = createPlacement(bp.id, sA.id)
    const replica = createPlacement(bp.id, sB.id); replica.role = 'replica'
    doc.regions[region.id] = region
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB })
    Object.assign(doc.servers, { [sA.id]: sA, [sB.id]: sB })
    doc.blueprints[bp.id] = bp
    Object.assign(doc.placements, { [primary.id]: primary, [replica.id]: replica })
    return { doc, compiled: compileWorld(doc), primaryInst: instanceId(primary.id, 0), replicaInst: instanceId(replica.id, 0) }
  }

  it('returns compiled roles when nothing has been promoted (fast path)', () => {
    const f = fixture()
    const roleOf = effectiveRoleResolver(f.compiled, new Map())
    expect(roleOf(f.primaryInst)).toBe('primary')
    expect(roleOf(f.replicaInst)).toBe('replica')
  })

  // After promotion the overlay flips roles WITHOUT touching the doc: the promoted replica acts as
  // primary (writes route to it) and the failed original primary is demoted to replica.
  it('promotes the replica and demotes the down primary once promoted', () => {
    const f = fixture()
    const state = createFailoverState()
    promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)

    const roleOf = effectiveRoleResolver(f.compiled, state.promotedAt)
    expect(roleOf(f.replicaInst)).toBe('primary')   // promoted → write target
    expect(roleOf(f.primaryInst)).toBe('replica')   // demoted
  })

  it('leaves other clusters untouched', () => {
    const f = fixture()
    const state = createFailoverState()
    promoteReplicas(state, f.compiled, f.doc, [f.primaryInst], 1000)
    const roleOf = effectiveRoleResolver(f.compiled, state.promotedAt)
    // An unknown id falls through to a safe default rather than throwing.
    expect(roleOf('no-such-instance')).toBe('primary')
  })
})

// ─── Multi-AZ managed-DB auto-recovery (node-model Phase 5.4, audit ISSUE-008) ─
// A multi-AZ managed DB has a standby that promotes on its own — so a SIMULATED infrastructure
// failure (its AZ going down) is a blip, not a permanent kill. A MANUAL operator kill stays down
// until the operator restores it. A single-AZ DB has nothing to promote and stays down either way.
describe('recoverMultiAzManagedDbs', () => {
  function docWith(over: Record<string, unknown>): WorldDoc {
    const doc = createWorld()
    doc.managedServices['ms-db'] = {
      id: 'ms-db', label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'az', azId: 'az-1' }, provider: 'aws', port: 5432,
      instanceClassId: 'sql.small', ...over,
    } as WorldDoc['managedServices'][string]
    return doc
  }
  // A simulated failure: the managed service's AZ goes down (audit ISSUE-008 'simulated' source).
  const simulateAzFailure = (state: ReturnType<typeof createFailoverState>, doc: WorldDoc, simMs: number) =>
    applyAzOutageToManaged(state, doc, 'az-1', true, simMs)

  it('auto-recovers a multi-AZ managed DB after the failover window (simulated AZ failure)', () => {
    const doc = docWith({ multiAz: true })
    const state = createFailoverState()
    simulateAzFailure(state, doc, 0)
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)

    // Still inside the window — the standby has not taken over yet.
    expect(recoverMultiAzManagedDbs(state, doc, 1000)).toEqual([])
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)

    const events = recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS + 1)
    expect(events.map(e => e.kind)).toContain('replica_promoted')
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(false)
  })

  it('never auto-recovers a MANUAL operator outage (audit ISSUE-008)', () => {
    const doc = docWith({ multiAz: true })
    const state = createFailoverState()
    setOutage(state, 'managed', 'ms-db', true, 0)
    expect(recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS * 10)).toEqual([])
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)   // stays down until the operator resumes
    // Explicit operator resume is the only way out.
    setOutage(state, 'managed', 'ms-db', false, MANAGED_FAILOVER_WINDOW_MS * 10 + 1)
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(false)
  })

  it('leaves a single-AZ managed DB down indefinitely', () => {
    const doc = docWith({ multiAz: false })
    const state = createFailoverState()
    simulateAzFailure(state, doc, 0)
    expect(recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS * 10)).toEqual([])
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)
  })

  it('does not touch a non-DB managed service', () => {
    const doc = docWith({ nodeType: 'queue', multiAz: true })
    const state = createFailoverState()
    simulateAzFailure(state, doc, 0)
    expect(recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS * 10)).toEqual([])
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)
  })

  it('promotes only once per outage, and re-arms after a fresh kill', () => {
    const doc = docWith({ multiAz: true })
    const state = createFailoverState()
    simulateAzFailure(state, doc, 0)
    expect(recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS + 1)).toHaveLength(1)
    expect(recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS + 2)).toEqual([])

    simulateAzFailure(state, doc, 100_000)
    expect(recoverMultiAzManagedDbs(state, doc, 100_000 + 1)).toEqual([])   // window restarts
    expect(recoverMultiAzManagedDbs(state, doc, 100_000 + MANAGED_FAILOVER_WINDOW_MS + 1)).toHaveLength(1)
  })

  it('delays recovery for a higher promotion tier', () => {
    const doc = docWith({ multiAz: true, promotionTier: 2 })
    const state = createFailoverState()
    simulateAzFailure(state, doc, 0)
    // Tier 2 is still waiting when a tier-0 standby would already have promoted.
    expect(recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS + 1)).toEqual([])
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)
    // …and promotes once its tier delay has also elapsed.
    const events = recoverMultiAzManagedDbs(state, doc, MANAGED_FAILOVER_WINDOW_MS + 2 * MANAGED_PROMOTION_TIER_STEP_MS + 1)
    expect(events).toHaveLength(1)
  })
})

// ─── AZ-outage propagation into az-scoped managed services (audit ISSUE-008) ──
describe('applyAzOutageToManaged', () => {
  function docWithAzMs(over: Record<string, unknown> = {}): WorldDoc {
    const doc = createWorld()
    doc.managedServices['ms-db'] = {
      id: 'ms-db', label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'az', azId: 'az-1' }, provider: 'aws', port: 5432,
      instanceClassId: 'sql.small', multiAz: true, ...over,
    } as WorldDoc['managedServices'][string]
    return doc
  }

  it('an AZ failure takes down its az-scoped managed services as simulated outages', () => {
    const doc = docWithAzMs()
    const state = createFailoverState()
    const events = applyAzOutageToManaged(state, doc, 'az-1', true, 1000)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'outage_triggered', affected: ['ms-db'] })
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)
    expect(state.healthByScope.get('ms-db')).toBe('down')
    // idempotent — a second application changes nothing
    expect(applyAzOutageToManaged(state, doc, 'az-1', true, 2000)).toEqual([])
  })

  it('ignores managed services scoped to other AZs or to a region', () => {
    const doc = docWithAzMs({ scope: { kind: 'region', regionId: 'r1' } })
    doc.managedServices['ms-other'] = {
      id: 'ms-other', label: 'cache', nodeType: 'redis',
      scope: { kind: 'az', azId: 'az-2' }, provider: 'aws', port: 6379,
    } as WorldDoc['managedServices'][string]
    const state = createFailoverState()
    expect(applyAzOutageToManaged(state, doc, 'az-1', true, 0)).toEqual([])
    expect(state.manualOutages.size).toBe(0)
  })

  it('restoring the AZ clears a simulated managed outage', () => {
    const doc = docWithAzMs()
    const state = createFailoverState()
    applyAzOutageToManaged(state, doc, 'az-1', true, 0)
    const cleared = applyAzOutageToManaged(state, doc, 'az-1', false, 1000)
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toMatchObject({ kind: 'outage_cleared', affected: ['ms-db'] })
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(false)
    expect(state.healthByScope.get('ms-db')).toBe('healthy')
  })

  it('an AZ restore never clears a MANUAL managed outage', () => {
    const doc = docWithAzMs()
    const state = createFailoverState()
    setOutage(state, 'managed', 'ms-db', true, 0)          // operator kill
    expect(applyAzOutageToManaged(state, doc, 'az-1', false, 1000)).toEqual([])
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)
  })

  it('an AZ failure does not overwrite an existing manual outage with a simulated one', () => {
    const doc = docWithAzMs()
    const state = createFailoverState()
    setOutage(state, 'managed', 'ms-db', true, 0)          // operator kill first
    expect(applyAzOutageToManaged(state, doc, 'az-1', true, 1000)).toEqual([])
    // …so the later AZ restore still cannot resurrect it
    applyAzOutageToManaged(state, doc, 'az-1', false, 2000)
    expect(hasOutage(state, 'managed', 'ms-db')).toBe(true)
  })
})
