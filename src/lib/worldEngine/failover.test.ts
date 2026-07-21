import { describe, it, expect } from 'vitest'
import {
  createFailoverState, setOutage, computeHealth, probeInstant, promoteReplicas, drainFactor,
  beginDrain, DEFAULT_HYSTERESIS, effectiveRoleResolver,
} from './failover'
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
    expect(state.manualOutages.has('az-1')).toBe(true)
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
    expect(state.manualOutages.has('r-1')).toBe(false)
    expect(setOutage(state, 'region', 'r-1', false, 6000)).toEqual([]) // already cleared
  })

  // node-model Phase 5.2: managed services can be taken down. Same set/clear machinery; the flow
  // solver reads state.manualOutages directly to fail traffic to a down managed service.
  it('takes a managed service down and restores it (managed scope)', () => {
    const state = createFailoverState()
    const down = setOutage(state, 'managed', 'ms-queue', true, 1000)
    expect(down[0]).toMatchObject({ kind: 'outage_triggered', affected: ['ms-queue'] })
    expect(state.manualOutages.has('ms-queue')).toBe(true)
    const up = setOutage(state, 'managed', 'ms-queue', false, 2000)
    expect(up[0]).toMatchObject({ kind: 'outage_cleared', affected: ['ms-queue'] })
    expect(state.manualOutages.has('ms-queue')).toBe(false)
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

  it('does nothing when the down instance is not a primary', () => {
    const f = replicaFixture()
    const state = createFailoverState()
    expect(promoteReplicas(state, f.compiled, f.doc, [f.replicaInst], 1000)).toEqual([])
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
