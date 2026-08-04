import { describe, it, expect } from 'vitest'
import { stepHost, poolCheckoutFor, diskIoDemandFor, diskWaitFor, warmthOf } from './hostScheduler'
import type { InstanceLoad } from './hostScheduler'
import type { WorldDoc } from '../world/types'
import { sampleLatencyMs } from './latency'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

function testServer(vcpu: number, ramMb: number) {
  const server = createServer('az-1', getPreset('vps-medium')!)
  server.specs.vcpu = vcpu
  server.specs.ramMb = ramMb
  return server
}

const load = (over: Partial<InstanceLoad> & { instanceId: string }): InstanceLoad => ({
  cpuMsPerRequest: 10,
  admittedRps: 0,
  activeConnections: 0,
  ramBaseMb: 100,
  ramPerConnMb: 0.5,
  memLimitMb: null,
  ...over,
})

describe('stepHost', () => {
  it('under capacity: multiplier 1, utilization spread evenly across cores (audit ISSUE-035)', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 150 })], 4, rng)
    // demand = 150 * 10 / 1000 = 1.5 cores over 4 → every core at 0.375, not [1, 0.5, 0, 0]
    expect(result.cpuPressure).toBeCloseTo(0.375)
    expect(result.latencyMultiplier).toBe(1)
    expect(result.admittedScale).toBe(1)
    expect(result.coreUtilization).toEqual([0.375, 0.375, 0.375, 0.375])
  })

  it('a credit-throttled host reads saturated on the effective basis (audit ISSUE-035)', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    // effectiveVcpu 1.6 (0.4× throttle on 4 vCPU); demand 2 cores saturates the effective
    // capacity — the die must read full, not 2/4 of the raw core count.
    const result = stepHost(server, [load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 200 })], 1.6, rng)
    expect(result.coreUtilization).toEqual([1, 1, 1, 1])
  })

  it('2x overload: multiplier 2, admittedScale 0.5, every core saturated', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 800 })], 4, rng)
    // demand = 800 * 10 / 1000 = 8 cores against 4 effective vCPU
    expect(result.cpuPressure).toBe(2)
    expect(result.latencyMultiplier).toBe(2)
    expect(result.admittedScale).toBe(0.5)
    expect(result.coreUtilization).toEqual([1, 1, 1, 1])
  })

  it('RAM grows with active connections (base + per-conn)', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', ramBaseMb: 100, ramPerConnMb: 2, activeConnections: 50 })], 4, rng)
    expect(result.ramUsedMb).toBe(200) // 100 + 2*50
    expect(result.oomVictim).toBeNull()
  })

  it('a container memLimit kills that instance individually, capped at the limit', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(
      server,
      [load({ instanceId: 'i1', ramBaseMb: 100, ramPerConnMb: 2, activeConnections: 500, memLimitMb: 300 })],
      4,
      rng,
    )
    // raw would be 100 + 2*500 = 1100, capped at its own 300MB limit
    expect(result.ramUsedMb).toBe(300)
    expect(result.oomVictim).toBe('i1')
  })

  it('host OOM picks the largest over-base consumer when total RAM exceeds the host', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(
      server,
      [
        load({ instanceId: 'small', ramBaseMb: 100, ramPerConnMb: 1, activeConnections: 10 }),
        load({ instanceId: 'big', ramBaseMb: 100, ramPerConnMb: 200, activeConnections: 10 }),
      ],
      4,
      rng,
    )
    // small: 110MB (overBase 10) ; big: 2100MB (overBase 2000) ; total 2210 > 2048 host RAM
    expect(result.ramUsedMb).toBe(2210)
    expect(result.oomVictim).toBe('big')
  })
})

describe('sampleLatencyMs', () => {
  it('median over 2000 seeded samples lands within +-10% of p50', () => {
    const rng = createRng(11)
    const samples: number[] = []
    for (let i = 0; i < 2000; i++) samples.push(sampleLatencyMs(50, 200, rng))
    samples.sort((a, b) => a - b)
    const median = samples[1000]
    expect(median).toBeGreaterThanOrEqual(50 * 0.9)
    expect(median).toBeLessThanOrEqual(50 * 1.1)
  })
})

// Audit ISSUE-018: per-instance weighted fair-share service rates.
describe('stepHost — serviceRateByInstance (ISSUE-018)', () => {
  it('splits a saturated host by cpuShares: the high-share instance keeps more capacity', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    // Both demand far beyond the 4 effective cores (10 ms/req ⇒ 400 rps host-wide ceiling).
    const result = stepHost(server, [
      load({ instanceId: 'hi', cpuMsPerRequest: 10, admittedRps: 1000, cpuShares: 3 }),
      load({ instanceId: 'lo', cpuMsPerRequest: 10, admittedRps: 1000, cpuShares: 1 }),
    ], 4, rng)
    const hi = result.serviceRateByInstance['hi']
    const lo = result.serviceRateByInstance['lo']
    expect(hi).toBeCloseTo(300, 3)   // 3/4 of 4 cores ⇒ 3 cores ⇒ 300 rps at 10 ms/req
    expect(lo).toBeCloseTo(100, 3)
  })

  it('is work-conserving: an idle sibling\'s unused share flows to the busy instance', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    const result = stepHost(server, [
      load({ instanceId: 'busy', cpuMsPerRequest: 10, admittedRps: 1000 }),
      load({ instanceId: 'idle', cpuMsPerRequest: 10, admittedRps: 0 }),
    ], 4, rng)
    // busy's demand-capped water-fill takes the whole 4 cores (idle wants nothing).
    expect(result.serviceRateByInstance['busy']).toBeCloseTo(400, 3)
    // idle keeps its fair-share FLOOR (2 of 4 cores ⇒ 200 rps) so it can serve from cold.
    expect(result.serviceRateByInstance['idle']).toBeCloseTo(200, 3)
  })

  it('grants a backlogged instance capacity beyond its instantaneous demand', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    const result = stepHost(server, [
      load({ instanceId: 'draining', cpuMsPerRequest: 10, admittedRps: 100, backlogRps: 150 }),
      load({ instanceId: 'other', cpuMsPerRequest: 10, admittedRps: 100 }),
    ], 4, rng)
    // draining wants 100+150=250 rps (2.5 cores), other wants 100 (1 core); both fit in 4.
    expect(result.serviceRateByInstance['draining']).toBeCloseTo(250, 3)
    expect(result.serviceRateByInstance['other']).toBeCloseTo(200, 3)   // floor (2 cores) > demand
  })
})

// FEAT-007 (Task 4): a warming instance's water-fill share is capped at warmth × its normal fair
// share, with the released surplus flowing to uncapped siblings through the SAME work-conserving
// water-fill surplus loop ISSUE-018's tests above exercise -- no separate redistribution path.
describe('stepHost — cold-start capacity throttle (FEAT-007 Task 4)', () => {
  it('warmth=1 (or no entry) reproduces the exact pre-FEAT-007 numbers -- the regression floor', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    const noWarmth = stepHost(server, [
      load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 1000 }),
    ], 4, rng)
    const rng2 = createRng(5)
    const explicitlyWarm = stepHost(server, [
      load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 1000 }),
    ], 4, rng2, undefined, undefined, { i1: 1 })
    expect(explicitlyWarm.serviceRateByInstance['i1']).toBe(noWarmth.serviceRateByInstance['i1'])
    expect(noWarmth.serviceRateByInstance['i1']).toBeCloseTo(400, 3)   // 4 cores @ 10ms/req = 400 rps
  })

  it('a lone saturated instance is throttled to warmth × its fair share (a lone claimant otherwise always reads 100%)', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    // 4 effective vCPU @ 10ms/req = 400 rps ceiling if fully warm; demand (1000 rps) saturates it.
    const at30pct = stepHost(server, [
      load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 1000 }),
    ], 4, rng, undefined, undefined, { i1: 0.3 })
    expect(at30pct.serviceRateByInstance['i1']).toBeCloseTo(120, 3)   // 400 * 0.3

    const rng2 = createRng(5)
    const at65pct = stepHost(server, [
      load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 1000 }),
    ], 4, rng2, undefined, undefined, { i1: 0.65 })
    expect(at65pct.serviceRateByInstance['i1']).toBeCloseTo(260, 3)   // 400 * 0.65
  })

  it('REDISTRIBUTION: capacity withheld from a warming instance flows to its saturated warm sibling, work-conserving', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    // Both instances demand far beyond their 2-core-each fair share -- fully saturated.
    const result = stepHost(server, [
      load({ instanceId: 'cold', cpuMsPerRequest: 10, admittedRps: 1000 }),
      load({ instanceId: 'warm', cpuMsPerRequest: 10, admittedRps: 1000 }),
    ], 4, rng, undefined, undefined, { cold: 0.3 })   // 'warm' absent from the map -> warmth 1
    const cold = result.serviceRateByInstance['cold']
    const warm = result.serviceRateByInstance['warm']
    // cold's fair share is 2 of 4 cores (200 rps); throttled to 0.3 of THAT -> 60 rps.
    expect(cold).toBeCloseTo(60, 3)
    // The 1.4 cores cold left on the table flow to warm via the water-fill surplus loop -- warm
    // absorbs its own 2-core fair share PLUS all of cold's unclaimed remainder.
    expect(warm).toBeCloseTo(340, 3)
    // Work-conserving: the host's total granted capacity is unchanged by the throttle -- only the
    // SPLIT shifts, exactly like the pre-existing "idle sibling's unused share flows to the busy
    // instance" case above.
    expect(cold + warm).toBeCloseTo(400, 3)
  })

  it('a warming instance still keeps its throttled floor even when its own demand is lower', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    // cold's raw demand (0.5 cores = 50 rps) is under its throttled floor (0.3 * 2-core fair share
    // = 0.6 cores = 60 rps) -- the SAME "floor guarantees a recovering instance can serve from
    // cold" guarantee ISSUE-018's "idle sibling" test exercises above, just scaled down by warmth
    // rather than removed by it, so a low-demand warming instance is never pinned below its own
    // (throttled) fair share.
    const result = stepHost(server, [
      load({ instanceId: 'cold', cpuMsPerRequest: 10, admittedRps: 50 }),
      load({ instanceId: 'warm', cpuMsPerRequest: 10, admittedRps: 1000 }),
    ], 4, rng, undefined, undefined, { cold: 0.3 })
    expect(result.serviceRateByInstance['cold']).toBeCloseTo(60, 3)
  })
})

// ─── Self-hosted connection pool (audit ISSUE-005) ───────────────────────────
describe('poolCheckoutFor', () => {
  it('returns null when maxConnections is absent (not capacity-modelled, the pre-issue behavior)', () => {
    expect(poolCheckoutFor(500, undefined, undefined)).toBeNull()
    expect(poolCheckoutFor(500, 0, undefined)).toBeNull()
  })

  it('no wait while unsaturated (rho <= 1)', () => {
    expect(poolCheckoutFor(80, 100, undefined)).toEqual({ checkoutWaitMs: 0, checkoutTimeoutErrorFraction: 0 })
    expect(poolCheckoutFor(100, 100, undefined)).toEqual({ checkoutWaitMs: 0, checkoutTimeoutErrorFraction: 0 })
  })

  it('checkout wait grows past saturation, with no timeout authored ⇒ zero error fraction', () => {
    const r = poolCheckoutFor(200, 100, undefined)
    expect(r!.checkoutWaitMs).toBeGreaterThan(0)
    expect(r!.checkoutTimeoutErrorFraction).toBe(0)
  })

  it('a tight checkoutTimeoutMs against a saturated pool produces a positive error fraction', () => {
    const r = poolCheckoutFor(500, 100, 1)   // deeply saturated (rho=5), 1ms timeout
    expect(r!.checkoutWaitMs).toBeGreaterThan(1)
    expect(r!.checkoutTimeoutErrorFraction).toBeGreaterThan(0)
    expect(r!.checkoutTimeoutErrorFraction).toBeLessThanOrEqual(1)
  })

  it('checkout wait stays finite even at extreme saturation (clamped overshoot)', () => {
    const r = poolCheckoutFor(1_000_000, 100, undefined)
    expect(Number.isFinite(r!.checkoutWaitMs)).toBe(true)
  })
})

describe('stepHost — pool checkout (audit ISSUE-005)', () => {
  it('an instance with no maxConnections is unaffected: bit-identical RAM to before this issue', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    const result = stepHost(server, [
      load({ instanceId: 'i1', activeConnections: 1000, ramBaseMb: 100, ramPerConnMb: 0.5 }),
    ], 4, rng)
    expect(result.ramUsedMb).toBe(100 + 0.5 * 1000)
    expect(result.checkoutByInstance?.['i1']).toBeUndefined()
  })

  it('a saturated pool with a tight timeout sheds the timed-out connections from RAM', () => {
    const server = testServer(4, 8192)
    const rng = createRng(5)
    const result = stepHost(server, [
      load({
        instanceId: 'i1', activeConnections: 1000, ramBaseMb: 100, ramPerConnMb: 0.5,
        maxConnections: 100, checkoutTimeoutMs: 1,
      }),
    ], 4, rng)
    const checkout = result.checkoutByInstance?.['i1']
    expect(checkout).toBeDefined()
    expect(checkout!.checkoutTimeoutErrorFraction).toBeGreaterThan(0)
    // RAM must be LESS than the naive (unshed) 100 + 0.5*1000 = 600 — some connections timed out
    // and never actually landed, so they must not inflate RAM as if they held one.
    expect(result.ramUsedMb).toBeLessThan(100 + 0.5 * 1000)
  })
})

// ─── Disk I/O capacity (FEAT-006) ───────────────────────────
describe('diskWaitFor', () => {
  it('returns null when neither diskIops nor diskType is resolvable (unbounded, the regression floor)', () => {
    expect(diskWaitFor(500, undefined, undefined)).toBeNull()
  })

  it('returns 0 when demand is at or below the ceiling', () => {
    expect(diskWaitFor(100, 200, 'ssd')).toBe(0)
    expect(diskWaitFor(200, 200, 'ssd')).toBe(0)
  })

  it('matches BASE_DISK_MS / (1 - overshoot) above saturation, to the digit, sharing poolCheckoutFor\'s curve shape', () => {
    // ssd BASE_DISK_MS = 0.5; demand 300 vs ceiling 200 -> rho = 1.5, overshoot = 0.5
    const wait = diskWaitFor(300, 200, 'ssd')
    expect(wait).toBeCloseTo(0.5 / (1 - 0.5), 10) // = 1.0
  })

  it('derives BASE_DISK_MS from diskType when diskIops is absent but diskType is present', () => {
    // e.g. diskType 'hdd' alone implies a 150 IOPS default ceiling per the spec's table
    expect(diskWaitFor(300, undefined, 'hdd')).not.toBeNull()
  })
})

describe('diskIoDemandFor', () => {
  it('sums rps * diskIoPerRequest across resident instances, matching the existing metrics.ts shape', () => {
    const loads = [{ instanceId: 'i1', admittedRps: 10 } as InstanceLoad, { instanceId: 'i2', admittedRps: 5 } as InstanceLoad]
    const blueprintByInstance = new Map([['i1', 'bp-db'], ['i2', 'bp-api']])
    const doc = { blueprints: { 'bp-db': { workload: { diskIoPerRequest: 4 } }, 'bp-api': { workload: { diskIoPerRequest: 0 } } } } as any as WorldDoc
    expect(diskIoDemandFor(loads, blueprintByInstance, doc)).toBe(40) // 10*4 + 5*0
  })
})

describe('warmthOf', () => {
  it('is 1 (fully warm) when the instance has no warming entry (the regression floor)', () => {
    expect(warmthOf('inst-a', new Map(), 10_000)).toBe(1)
  })

  it('is 0 at the instant warming starts', () => {
    const m = new Map([['inst-a', { startedMs: 5_000, coldStartMs: 30_000 }]])
    expect(warmthOf('inst-a', m, 5_000)).toBe(0)
  })

  it('ramps linearly to 1 over coldStartMs', () => {
    const m = new Map([['inst-a', { startedMs: 0, coldStartMs: 30_000 }]])
    expect(warmthOf('inst-a', m, 15_000)).toBeCloseTo(0.5, 5)
    expect(warmthOf('inst-a', m, 30_000)).toBeCloseTo(1, 5)
  })

  it('clamps at 1 past coldStartMs (never overshoots)', () => {
    const m = new Map([['inst-a', { startedMs: 0, coldStartMs: 30_000 }]])
    expect(warmthOf('inst-a', m, 60_000)).toBe(1)
  })

  it('treats coldStartMs <= 0 as instantly warm', () => {
    const m = new Map([['inst-a', { startedMs: 0, coldStartMs: 0 }]])
    expect(warmthOf('inst-a', m, 0)).toBe(1)
  })
})
