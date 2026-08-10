import { describe, it, expect } from 'vitest'
import {
  hopLatencyMs, applyNicCap, createNicState, addNicBytes, settleNic, refusedAttemptRate,
  createNatGatewayState, applyNatGatewayCap, settleNatGateway,
} from './networkRuntime'
import { createRng } from './rng'
import { createServer } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { interRegionLatencyMs } from '../regionConfig'
import { REGION_GEO, greatCircleKm } from '../world/regionGeo'
import type { CompiledPath, BlueprintDependency } from '../world/types'

const GEO = REGION_GEO

describe('hopLatencyMs', () => {
  it('localhost ~0.1ms within +-10% jitter', () => {
    const rng = createRng(1)
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('localhost', null, null, null, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(0.09 - 1e-9)
      expect(v).toBeLessThanOrEqual(0.11 + 1e-9)
    }
  })

  it('same-az ~0.5ms and cross-az ~1.5ms within +-10% jitter', () => {
    const rng = createRng(2)
    for (let i = 0; i < 300; i++) {
      const az = hopLatencyMs('same-az', null, null, null, GEO, rng)
      expect(az).toBeGreaterThanOrEqual(0.45 - 1e-9)
      expect(az).toBeLessThanOrEqual(0.55 + 1e-9)
      const xaz = hopLatencyMs('cross-az', null, null, null, GEO, rng)
      expect(xaz).toBeGreaterThanOrEqual(1.35 - 1e-9)
      expect(xaz).toBeLessThanOrEqual(1.65 + 1e-9)
    }
  })

  it('cross-region uses the pure inter-region base +-10% (deterministic port)', () => {
    const rng = createRng(3)
    const base = interRegionLatencyMs('us-east-1', 'eu-west-1')
    expect(base).toBeGreaterThan(0)
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('cross-region', 'us-east-1', 'eu-west-1', null, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(base * 0.9 - 1e-9)
      expect(v).toBeLessThanOrEqual(base * 1.1 + 1e-9)
    }
  })

  it('internet = great-circle km / 100 ms +-10% from the population to the region', () => {
    const rng = createRng(4)
    const nyc: [number, number] = [40.7, -74.0]
    const geo = GEO['us-east-1']
    const expected = greatCircleKm(nyc[0], nyc[1], geo.lat, geo.lon) / 100
    for (let i = 0; i < 300; i++) {
      const v = hopLatencyMs('internet', null, 'us-east-1', nyc, GEO, rng)
      expect(v).toBeGreaterThanOrEqual(expected * 0.9 - 1e-9)
      expect(v).toBeLessThanOrEqual(expected * 1.1 + 1e-9)
    }
  })

  it('is deterministic under the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    expect(hopLatencyMs('cross-region', 'us-east-1', 'ap-southeast-2', null, GEO, a))
      .toBe(hopLatencyMs('cross-region', 'us-east-1', 'ap-southeast-2', null, GEO, b))
  })

  it('falls back to documented constants when geo inputs are missing', () => {
    const rng = createRng(5)
    for (let i = 0; i < 100; i++) {
      const xr = hopLatencyMs('cross-region', null, 'eu-west-1', null, GEO, rng)
      expect(xr).toBeGreaterThanOrEqual(72 - 1e-9)   // 80 +-10%
      expect(xr).toBeLessThanOrEqual(88 + 1e-9)
      const inet = hopLatencyMs('internet', null, 'us-east-1', null, GEO, rng)
      expect(inet).toBeGreaterThanOrEqual(36 - 1e-9) // 40 +-10%
      expect(inet).toBeLessThanOrEqual(44 + 1e-9)
    }
  })
})

describe('applyNicCap', () => {
  // vps-medium: nicMbps 1000 -> per-100ms-step budget = 1000e6/8 * 0.1 = 12_500_000 bytes
  const server = () => createServer('az-1', getPreset('vps-medium')!)
  const CAP = 12_500_000

  it('under cap: full delivery, no queued latency', () => {
    const state = createNicState()
    expect(applyNicCap(state, server().specs.nicMbps, CAP * 0.4, CAP * 0.4, 100))
      .toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
  })

  it('between cap and 2x cap: full delivery with proportional queued latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server().specs.nicMbps, CAP * 1.5, 0, 100)
    expect(r.deliveredFraction).toBe(1)
    expect(r.queuedLatencyMs).toBeCloseTo(50, 5) // (1.5 - 1) * 100ms
  })

  it('beyond 2x cap: sheds to 2x cap with saturated queue latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server().specs.nicMbps, 0, CAP * 4, 100)
    expect(r.deliveredFraction).toBeCloseTo(0.5, 5) // 2 / 4
    expect(r.queuedLatencyMs).toBe(100)
  })

  it('accumulates within a step: two adds that jointly cross the cap start queueing', () => {
    const state = createNicState()
    expect(applyNicCap(state, server().specs.nicMbps, CAP * 0.7, 0, 100).queuedLatencyMs).toBe(0)
    const second = applyNicCap(state, server().specs.nicMbps, CAP * 0.7, 0, 100)
    expect(second.deliveredFraction).toBe(1)
    expect(second.queuedLatencyMs).toBeCloseTo(40, 5) // cumulative 1.4x cap -> (0.4)*100ms
  })
})

// Audit ISSUE-002: the NIC gained a persistent send buffer. settleNic evaluates the step's
// cumulative bytes PLUS last step's backlog, carries the un-transmitted remainder (bounded at
// one step's cap — beyond 2x cap is shed, not queued) into the next step, and resets the
// per-step counters. A saturated NIC now drains over several ticks instead of resetting.
describe('settleNic — persistent send buffer (audit ISSUE-002)', () => {
  const server = () => createServer('az-1', getPreset('vps-medium')!)
  const CAP = 12_500_000   // vps-medium 1000 Mbps → bytes per 100ms step

  it('under cap: full delivery, no backlog carried, counters reset', () => {
    const state = createNicState()
    addNicBytes(state, CAP * 0.4, CAP * 0.4)
    expect(settleNic(state, server().specs.nicMbps, 100)).toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
    expect(state.backlogBytes).toBe(0)
    expect(state.inBytesThisStep).toBe(0)
    expect(state.outBytesThisStep).toBe(0)
  })

  it('a saturated step carries backlog that drains on the next (idle) step', () => {
    const state = createNicState()
    addNicBytes(state, 0, CAP * 1.5)
    const r1 = settleNic(state, server().specs.nicMbps, 100)
    expect(r1.deliveredFraction).toBe(1)
    expect(r1.queuedLatencyMs).toBeCloseTo(50, 5)          // (1.5 − 1) × 100ms
    expect(state.backlogBytes).toBeCloseTo(CAP * 0.5, 0)   // the queued excess

    const r2 = settleNic(state, server().specs.nicMbps, 100)             // idle step: only the backlog
    expect(r2).toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
    expect(state.backlogBytes).toBe(0)                     // drained, not reset
  })

  it('backlog is bounded at one step-cap (excess beyond 2x cap is shed) and adds to next step load', () => {
    const state = createNicState()
    addNicBytes(state, 0, CAP * 4)
    const r1 = settleNic(state, server().specs.nicMbps, 100)
    expect(r1.deliveredFraction).toBeCloseTo(0.5, 5)       // 2 / 4
    expect(state.backlogBytes).toBeCloseTo(CAP, 0)         // capped at one step's budget

    addNicBytes(state, 0, CAP * 0.6)                       // 0.6 new + 1.0 backlog = 1.6× cap
    const r2 = settleNic(state, server().specs.nicMbps, 100)
    expect(r2.deliveredFraction).toBe(1)
    expect(r2.queuedLatencyMs).toBeCloseTo(60, 5)          // still congested from the carryover
    expect(state.backlogBytes).toBeCloseTo(CAP * 0.6, 0)
  })
})

describe('generalized NIC cap (nicMbps parameter) and NatGatewayState', () => {
  it('applyNicCap/settleNic still work when called with nicMbps (regression floor)', () => {
    const server = createServer('az-1', getPreset('vps-medium')!)
    const CAP = 12_500_000
    const state = createNicState()
    expect(applyNicCap(state, server.specs.nicMbps, CAP * 0.4, CAP * 0.4, 100))
      .toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
    expect(settleNic(state, server.specs.nicMbps, 100)).toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
  })

  it('a NatGatewayState shares its cap across two flows the way a single NIC would', () => {
    const state = createNatGatewayState()
    const stepMs = 1000
    const nicMbps = 100 // 12.5 MB/s cap
    const capBytes = (nicMbps * 1e6 / 8) * (stepMs / 1000)
    applyNatGatewayCap(state, nicMbps, capBytes * 0.6, 0, stepMs)
    const r2 = applyNatGatewayCap(state, nicMbps, capBytes * 0.6, 0, stepMs)
    // combined load (1.2x cap) exceeds capacity — both flows see queued latency, not full delivery
    expect(r2.queuedLatencyMs).toBeGreaterThan(0)
    settleNatGateway(state, nicMbps, stepMs)
  })
})

describe('refusedAttemptRate', () => {
  const mkPath = (dependencyId: string, verdict: 'permitted' | 'blocked', n: number): CompiledPath => ({
    id: `p-${dependencyId}-${n}`,
    dependencyId,
    fromInstanceId: 'i-1',
    to: { kind: 'instance', instanceId: `t-${n}` },
    hopClass: 'same-az',
    verdict,
    blockReason: verdict === 'blocked' ? { kind: 'firewall-deny', detail: 'test', firewallRuleId: null } : null,
  })
  const dep: BlueprintDependency = {
    id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-t' },
    port: 8080, protocol: 'http', packetTemplateId: null,
  }

  it('refuses the full demand when every target path is blocked', () => {
    const paths = [mkPath('dep-1', 'blocked', 0), mkPath('dep-1', 'blocked', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(200)
  })

  it('refuses the blocked share when only some targets are blocked', () => {
    const paths = [mkPath('dep-1', 'blocked', 0), mkPath('dep-1', 'permitted', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(100)
  })

  it('returns 0 with no blocked paths, and ignores other dependencies\' paths', () => {
    const paths = [mkPath('dep-1', 'permitted', 0), mkPath('dep-other', 'blocked', 1)]
    expect(refusedAttemptRate(dep, paths, 200)).toBe(0)
    expect(refusedAttemptRate(dep, [], 200)).toBe(0)
  })
})
