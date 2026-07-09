import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { createMetricsState, accumulateStep, buildBatch, type RoutingSnapshot, type VpsPublish } from './metrics'
import type { InstanceFlow } from './flows'
import type { HostStepResult } from './hostScheduler'
import type { NicState } from './networkRuntime'
import type { HealthState } from './types'

// 1 region / 1 AZ / 2 servers / 1 blueprint / 2 single-count placements → 2 instances.
function fixture() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const s1 = createServer(az.id, getPreset('vps-medium')!)
  const s2 = createServer(az.id, getPreset('vps-medium')!)
  const bp = createBlueprint('api', 0)
  const p1 = createPlacement(bp.id, s1.id)
  const p2 = createPlacement(bp.id, s2.id)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })
  doc.blueprints[bp.id] = bp
  Object.assign(doc.placements, { [p1.id]: p1, [p2.id]: p2 })
  const pop = { id: 'pop-1', label: 'us', lat: 40, lon: -75, peakRps: 100, diurnal: 'flat' as const }
  doc.populations[pop.id] = pop
  const compiled = compileWorld(doc)
  const i1 = instanceId(p1.id, 0)
  const i2 = instanceId(p2.id, 0)
  return { doc, compiled, region, az, s1, s2, bp, i1, i2 }
}

function flow(id: string, rps: number, over: Partial<InstanceFlow> = {}): InstanceFlow {
  return {
    instanceId: id, offeredRps: rps, admittedRps: rps, errorRps: 0, refusedRps: 0,
    serviceLatencyMs: 10, downstream: [], ...over,
  }
}

function host(vcpu = 4): HostStepResult {
  return {
    cpuPressure: 0.5, coreUtilization: Array.from({ length: vcpu }, (_, i) => (i < 2 ? 0.5 : 0)),
    latencyMultiplier: 1, admittedScale: 1, ramUsedMb: 1024, oomVictim: null,
  }
}

const healthy: (id: string) => HealthState = () => 'healthy'
const nic: NicState = { inBytesThisStep: 125_000, outBytesThisStep: 250_000 }

function accumulate1s(state: ReturnType<typeof createMetricsState>, f: ReturnType<typeof fixture>, rps1: number, rps2: number, health = healthy, errorRps = 0) {
  for (let step = 0; step < 10; step++) {
    accumulateStep(
      state,
      { [f.i1]: flow(f.i1, rps1, { errorRps }), [f.i2]: flow(f.i2, rps2) },
      { [f.s1.id]: host(), [f.s2.id]: host() },
      { [f.s1.id]: { steal: 0.05, effectiveVcpuFactor: 1, creditsFraction: 0.8 } as VpsPublish, [f.s2.id]: { steal: 0, effectiveVcpuFactor: 1, creditsFraction: null } as VpsPublish },
      { [f.s1.id]: nic, [f.s2.id]: nic },
      health,
      step * 100,
    )
  }
}

const snapshot = (f: ReturnType<typeof fixture>, rps: number): RoutingSnapshot => ({
  populationRoutes: [{ populationId: 'pop-1', regionId: f.region.id, rps }],
})
const totals = { crossAzBytes: 1_000_000, crossRegionBytes: 2_000_000, internetBytes: 500_000 }

describe('metrics pyramid', () => {
  it('sums the pyramid: az rps = Σ instance rps, region and world follow', () => {
    const f = fixture()
    const state = createMetricsState()
    accumulate1s(state, f, 60, 40)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    expect(batch.instances[f.i1].rps).toBeCloseTo(60, 1)
    expect(batch.instances[f.i2].rps).toBeCloseTo(40, 1)
    expect(batch.azs[f.az.id].rps).toBeCloseTo(100, 1)
    expect(batch.regions[f.region.id].rps).toBeCloseTo(100, 1)
    expect(batch.world.totalRps).toBeCloseTo(100, 1)
    expect(batch.azs[f.az.id].serverCount).toBe(2)
    expect(batch.azs[f.az.id].instanceCount).toBe(2)
  })

  it('EMA-smooths across batches with α=0.3 (first window seeds directly)', () => {
    const f = fixture()
    const state = createMetricsState()
    accumulate1s(state, f, 100, 0)
    const b1 = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    expect(b1.instances[f.i1].rps).toBeCloseTo(100, 1)      // seeded, not 0.3×100
    accumulate1s(state, f, 0, 0)
    const b2 = buildBatch(state, f.doc, f.compiled, snapshot(f, 0), totals, 2000)
    expect(b2.instances[f.i1].rps).toBeCloseTo(70, 1)       // 0.3·0 + 0.7·100
  })

  it('computes healthScore = 100 × (1 − errorRate) × healthFactor', () => {
    const f = fixture()
    const state = createMetricsState()
    // 20 err of 100 admitted on i1, i2 idle → az errorRate 0.2; az degraded.
    const health: (id: string) => HealthState = (id) => (id === f.az.id ? 'degraded' : 'healthy')
    accumulate1s(state, f, 100, 0, health, 20)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    expect(batch.azs[f.az.id].errorRate).toBeCloseTo(0.2, 2)
    expect(batch.azs[f.az.id].healthScore).toBeCloseTo(100 * 0.8 * 0.6, 1)   // 48
    expect(batch.azs[f.az.id].health).toBe('degraded')
  })

  it('populates every contract field — nothing undefined anywhere in the batch', () => {
    const f = fixture()
    const state = createMetricsState()
    accumulate1s(state, f, 60, 40)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 100), totals, 1000)
    const assertDefined = (obj: unknown, path: string) => {
      expect(obj, path).not.toBeUndefined()
      if (obj !== null && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) assertDefined(v, `${path}.${k}`)
      }
    }
    assertDefined(batch, 'batch')
    // Spot-check the tricky contract fields.
    expect(batch.servers[f.s1.id].coreUtilization).toHaveLength(4)
    expect(batch.servers[f.s1.id].burstCredits).toBeCloseTo(0.8, 2)
    expect(batch.servers[f.s2.id].burstCredits).toBeNull()
    expect(batch.servers[f.s1.id].stealFraction).toBeCloseTo(0.05, 2)
    expect(batch.servers[f.s1.id].nicInMbps).toBeCloseTo((125_000 * 10 * 8) / 1e6, 1)
    expect(batch.regions[f.region.id].inboundByPopulation).toEqual([{ populationId: 'pop-1', rps: 100 }])
    expect(batch.world.populationRoutes).toEqual([{ populationId: 'pop-1', regionId: f.region.id, rps: 100 }])
    expect(batch.world.crossAzBytesPerSec).toBeCloseTo(1_000_000, -3)
    expect(batch.world.crossRegionBytesPerSec).toBeCloseTo(2_000_000, -3)
    expect(batch.world.internetEgressBytesPerSec).toBeCloseTo(500_000, -3)
  })

  it('orders ramByInstance by ramMb descending', () => {
    const f = fixture()
    // Put both instances on s1 by moving p2's placement server: simplest — build flows with
    // differing connection loads on the same server via a second placement fixture.
    const state = createMetricsState()
    // i1 heavy (100 rps → more conns/ram), i2 idle but still resident on its own server.
    accumulate1s(state, f, 100, 1)
    const batch = buildBatch(state, f.doc, f.compiled, snapshot(f, 101), totals, 1000)
    const strata = batch.servers[f.s1.id].ramByInstance
    expect(strata.length).toBeGreaterThan(0)
    for (let i = 1; i < strata.length; i++) expect(strata[i - 1].ramMb).toBeGreaterThanOrEqual(strata[i].ramMb)
    expect(strata[0]).toMatchObject({ instanceId: f.i1, blueprintId: f.bp.id })
  })
})
