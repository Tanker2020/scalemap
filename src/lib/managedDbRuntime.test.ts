import { describe, it, expect } from 'vitest'
import { managedDbRuntimeFor, SERVERLESS_BURST_MULTIPLIER } from './managedDbRuntime'
import type { ManagedService } from './world/types'

// A managed SQL DB on the smallest class: writeRps 500 / readRps 2500 (dbInstanceClasses.ts).
function sqlDb(over: Partial<ManagedService> = {}): ManagedService {
  return {
    id: 'ms-db', label: 'orders-db', nodeType: 'dbSql', scope: 'region',
    provider: 'generic', regionId: 'r1', azId: null,
    instanceClassId: 'sql.small', replicaCount: 0, multiAz: false, storageGb: 100,
    ...over,
  } as ManagedService
}

describe('managedDbRuntimeFor — queueing latency', () => {
  it('serves at the engine base latency when the DB is nearly idle', () => {
    // 10 rps of pure reads against a 2500 read ceiling ⇒ saturation ~0, no queueing.
    const rt = managedDbRuntimeFor(sqlDb(), 10, 0)!
    expect(rt.saturation).toBeCloseTo(10 / 2500, 5)
    expect(rt.p50Ms).toBeGreaterThan(0)
    expect(rt.p50Ms).toBeLessThan(3.1)   // SQL read base is 3ms; near-idle adds almost nothing
  })

  it('latency climbs as saturation rises (queueing)', () => {
    const idle = managedDbRuntimeFor(sqlDb(), 250, 0)!    // 10% of read ceiling
    const busy = managedDbRuntimeFor(sqlDb(), 2250, 0)!   // 90% of read ceiling
    expect(busy.saturation).toBeGreaterThan(idle.saturation)
    expect(busy.p50Ms).toBeGreaterThan(idle.p50Ms * 5)    // 1/(1-0.9) vs 1/(1-0.1)
  })

  it('p99 is above p50', () => {
    const rt = managedDbRuntimeFor(sqlDb(), 1000, 0)!
    expect(rt.p99Ms).toBeGreaterThan(rt.p50Ms)
  })
})

describe('managedDbRuntimeFor — query timeout (the soft failure)', () => {
  it('no timeout errors while effective latency is under the timeout', () => {
    const rt = managedDbRuntimeFor(sqlDb({ queryTimeoutMs: 1000 }), 250, 0)!
    expect(rt.p50Ms).toBeLessThan(1000)
    expect(rt.timeoutErrorFraction).toBe(0)
  })

  it('errors a growing fraction once latency passes the timeout', () => {
    // A tight 10ms timeout: SQL read base 3ms, so this bites well before the rps ceiling.
    const db = sqlDb({ queryTimeoutMs: 10 })
    const mild = managedDbRuntimeFor(db, 1875, 0)!   // 75% sat ⇒ 3/0.25 = 12ms
    const hard = managedDbRuntimeFor(db, 2375, 0)!   // 95% sat ⇒ 3/0.05 = 60ms
    expect(mild.p50Ms).toBeGreaterThan(10)
    expect(mild.timeoutErrorFraction).toBeGreaterThan(0)
    expect(hard.timeoutErrorFraction).toBeGreaterThan(mild.timeoutErrorFraction)
  })

  it('fails below the raw rps ceiling when the timeout is tight', () => {
    // The whole point: 1900 rps is only 76% of the 2500 read ceiling — nothing is refused for
    // throughput, yet a 10ms timeout still makes the DB error.
    const rt = managedDbRuntimeFor(sqlDb({ queryTimeoutMs: 10 }), 1900, 0)!
    expect(rt.ceilingRefusedRps).toBe(0)
    expect(rt.timeoutErrorFraction).toBeGreaterThan(0)
  })
})

describe('managedDbRuntimeFor — ceilings', () => {
  it('refuses writes over the single-writer ceiling', () => {
    const rt = managedDbRuntimeFor(sqlDb(), 800, 1)!   // all writes, ceiling 500
    expect(rt.ceilingRefusedRps).toBeCloseTo(300, 5)
    expect(rt.refusalFraction).toBeCloseTo(300 / 800, 5)
  })

  it('refuses connections over maxConnections (Little\'s law)', () => {
    // 2000 rps at ~high latency ⇒ live connections well past a deliberately tiny cap.
    const rt = managedDbRuntimeFor(sqlDb({ maxConnections: 2 }), 2000, 0)!
    expect(rt.connections).toBeGreaterThan(0)
    expect(rt.connectionRefusedRps).toBeGreaterThan(0)
  })

  it('does not refuse connections when the cap is generous', () => {
    const rt = managedDbRuntimeFor(sqlDb({ maxConnections: 100000 }), 2000, 0)!
    expect(rt.connectionRefusedRps).toBe(0)
  })
})

describe('managedDbRuntimeFor — capacity mode', () => {
  it('serverless bursts the ceiling so provisioned-throttled load is admitted', () => {
    const provisioned = managedDbRuntimeFor(sqlDb({ capacityMode: 'provisioned' }), 800, 1)!
    const serverless = managedDbRuntimeFor(sqlDb({ capacityMode: 'serverless' }), 800, 1)!
    expect(provisioned.ceilingRefusedRps).toBeGreaterThan(0)
    // 500 x burst multiplier comfortably clears 800 rps of writes.
    expect(SERVERLESS_BURST_MULTIPLIER).toBeGreaterThan(1)
    expect(serverless.ceilingRefusedRps).toBe(0)
    expect(serverless.saturation).toBeLessThan(provisioned.saturation)
  })
})

describe('managedDbRuntimeFor — replica locality', () => {
  it('cross-region replicas add read latency; same-az does not', () => {
    const sameAz = managedDbRuntimeFor(sqlDb({ replicaCount: 1, replicaLocality: 'sameAz' }), 100, 0)!
    const crossRegion = managedDbRuntimeFor(sqlDb({ replicaCount: 1, replicaLocality: 'crossRegion' }), 100, 0)!
    expect(crossRegion.p50Ms).toBeGreaterThan(sameAz.p50Ms + 20)
  })

  it('locality does not penalise a pure-write workload', () => {
    const sameAz = managedDbRuntimeFor(sqlDb({ replicaCount: 1, replicaLocality: 'sameAz' }), 100, 1)!
    const crossRegion = managedDbRuntimeFor(sqlDb({ replicaCount: 1, replicaLocality: 'crossRegion' }), 100, 1)!
    expect(crossRegion.p50Ms).toBeCloseTo(sameAz.p50Ms, 5)
  })
})

describe('managedDbRuntimeFor — opt-out', () => {
  it('returns null for a non-DB managed service', () => {
    expect(managedDbRuntimeFor(sqlDb({ nodeType: 'queue' }), 100, 0)).toBeNull()
  })

  it('returns null for a DB with no instance class chosen (uncapped, pre-Phase-3)', () => {
    expect(managedDbRuntimeFor(sqlDb({ instanceClassId: null }), 100, 0)).toBeNull()
  })

  it('is inert at zero load', () => {
    const rt = managedDbRuntimeFor(sqlDb(), 0, 0)!
    expect(rt.refusalFraction).toBe(0)
    expect(rt.connections).toBe(0)
    expect(rt.timeoutErrorFraction).toBe(0)
  })
})
