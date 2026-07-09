import { describe, it, expect } from 'vitest'
import { hopLatencyMs, applyNicCap, createNicState, refusedAttemptRate } from './networkRuntime'
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
    expect(applyNicCap(state, server(), CAP * 0.4, CAP * 0.4, 100))
      .toEqual({ deliveredFraction: 1, queuedLatencyMs: 0 })
  })

  it('between cap and 2x cap: full delivery with proportional queued latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server(), CAP * 1.5, 0, 100)
    expect(r.deliveredFraction).toBe(1)
    expect(r.queuedLatencyMs).toBeCloseTo(50, 5) // (1.5 - 1) * 100ms
  })

  it('beyond 2x cap: sheds to 2x cap with saturated queue latency', () => {
    const state = createNicState()
    const r = applyNicCap(state, server(), 0, CAP * 4, 100)
    expect(r.deliveredFraction).toBeCloseTo(0.5, 5) // 2 / 4
    expect(r.queuedLatencyMs).toBe(100)
  })

  it('accumulates within a step: two adds that jointly cross the cap start queueing', () => {
    const state = createNicState()
    expect(applyNicCap(state, server(), CAP * 0.7, 0, 100).queuedLatencyMs).toBe(0)
    const second = applyNicCap(state, server(), CAP * 0.7, 0, 100)
    expect(second.deliveredFraction).toBe(1)
    expect(second.queuedLatencyMs).toBeCloseTo(40, 5) // cumulative 1.4x cap -> (0.4)*100ms
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
