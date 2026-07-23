import { describe, it, expect } from 'vitest'
import { stepHost } from './hostScheduler'
import type { InstanceLoad } from './hostScheduler'
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
  it('under capacity: multiplier 1, cores partially filled in order', () => {
    const server = testServer(4, 2048)
    const rng = createRng(5)
    const result = stepHost(server, [load({ instanceId: 'i1', cpuMsPerRequest: 10, admittedRps: 150 })], 4, rng)
    // demand = 150 * 10 / 1000 = 1.5 cores
    expect(result.cpuPressure).toBeCloseTo(0.375)
    expect(result.latencyMultiplier).toBe(1)
    expect(result.admittedScale).toBe(1)
    expect(result.coreUtilization).toEqual([1, 0.5, 0, 0])
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
