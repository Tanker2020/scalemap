import { describe, it, expect } from 'vitest'
import {
  rpsPerCore, hostRpsCapacity, ramAtConnections, residentRamDemandMb, ttlLagHint, diskIoWord,
  healthWord, populationLanding, frontlineCapacityRps, placementEgressUsdPerHr,
  PLACEMENT_BYTES_EACH_WAY,
} from './derived'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createPopulation,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'

describe('rpsPerCore', () => {
  it('computes 1000/ms', () => {
    expect(rpsPerCore(8)).toBe(125)
    expect(rpsPerCore(1)).toBe(1000)
  })
  it('is 0-safe and NaN-safe', () => {
    expect(rpsPerCore(0)).toBe(0)
    expect(rpsPerCore(-3)).toBe(0)
    expect(rpsPerCore(Number.NaN)).toBe(0)
  })
})

describe('hostRpsCapacity', () => {
  it('scales rpsPerCore by vcpu', () => {
    expect(hostRpsCapacity(4, 8)).toBe(500)
    expect(hostRpsCapacity(16, 5)).toBe(3200)
  })
  it('guards zero/NaN inputs', () => {
    expect(hostRpsCapacity(0, 8)).toBe(0)
    expect(hostRpsCapacity(4, 0)).toBe(0)
    expect(hostRpsCapacity(Number.NaN, 8)).toBe(0)
  })
})

describe('ramAtConnections', () => {
  it('defaults to 2000 connections', () => {
    expect(ramAtConnections(220, 0.5)).toBe(1220)
  })
  it('honors an explicit connection count', () => {
    expect(ramAtConnections(128, 0.5, 100)).toBe(178)
  })
})

describe('residentRamDemandMb', () => {
  it('sums memLimitMb ?? ramBaseMb per resident instance — same quantity as the ram-oversubscribed rule', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1'); doc.regions[r.id] = r
    const az = createAz(r.id, 'us-east-1a'); doc.azs[az.id] = az
    const s = createServer(az.id, getPreset('vps-small')!); doc.servers[s.id] = s
    const bp = createBlueprint('api', 0); bp.workload.ramBaseMb = 300; doc.blueprints[bp.id] = bp
    const plA = createPlacement(bp.id, s.id); plA.count = 2; doc.placements[plA.id] = plA   // 2 × 300
    const plB = createPlacement(bp.id, s.id); doc.placements[plB.id] = plB
    plB.runtime = { type: 'container', stackName: 'app', networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: 512 }
    const compiled = compileWorld(doc)
    expect(residentRamDemandMb(s.id, doc, compiled)).toBe(300 + 300 + 512)
  })
  it('returns 0 for a server with no instances', () => {
    const doc = createWorld()
    expect(residentRamDemandMb('missing', doc, compileWorld(doc))).toBe(0)
  })
})

describe('ttlLagHint', () => {
  const routing = (dnsTtlSec: number, healthCheckIntervalMs: number, healthCheckFailureThreshold: number) => ({
    policy: 'latency' as const, weights: {}, priorityOrder: [],
    dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold,
  })
  it('is null when TTL covers the detection window (factory defaults: 30s vs 10s×3)', () => {
    expect(ttlLagHint(routing(30, 10_000, 3))).toBeNull()
  })
  it('phrases the lag with both numbers when TTL is shorter than detection', () => {
    expect(ttlLagHint(routing(5, 12_000, 3))).toBe(
      '⚠ ttl 5s < detection 36s — clients re-resolve before the failure is even detected',
    )
  })
})

describe('diskIoWord', () => {
  it('buckets <0.5 / <2 / ≥2', () => {
    expect(diskIoWord(0.2)).toBe('light')
    expect(diskIoWord(0.5)).toBe('moderate')
    expect(diskIoWord(1.9)).toBe('moderate')
    expect(diskIoWord(2)).toBe('heavy')
  })
})

describe('healthWord', () => {
  it('thresholds at 0.70 and 0.90 on the max of the two fractions', () => {
    expect(healthWord(0.69, 0)).toBe('comfortable')
    expect(healthWord(0, 0.71)).toBe('tight')
    expect(healthWord(0.9, 0.1)).toBe('straining')
  })
  it('boundary values: exactly 0.70 is tight, exactly 0.90 is straining', () => {
    expect(healthWord(0.7, 0)).toBe('tight')
    expect(healthWord(0.9, 0)).toBe('straining')
  })
})

describe('populationLanding', () => {
  it('lands on the first policy-ordered region with its km-derived latency', () => {
    const doc = createWorld()
    const r1 = createRegion('us-east-1'); doc.regions[r1.id] = r1
    const r2 = createRegion('eu-west-1'); doc.regions[r2.id] = r2
    const pop = createPopulation('São Paulo', -23.55, -46.63); doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)
    const landing = populationLanding(pop, doc, compiled)
    expect(landing).toEqual({ regionCatalogId: 'us-east-1', latencyMs: 77 })
  })
  it('returns null with no regions', () => {
    const doc = createWorld()
    const pop = createPopulation('nyc', 40.7, -74); doc.populations[pop.id] = pop
    expect(populationLanding(pop, doc, compileWorld(doc))).toBeNull()
  })
})

describe('frontlineCapacityRps', () => {
  it('sums vcpu·1000/cpuMs over entry placements only', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1'); doc.regions[r.id] = r
    const az = createAz(r.id, 'us-east-1a'); doc.azs[az.id] = az
    const s1 = createServer(az.id, getPreset('vps-medium')!); doc.servers[s1.id] = s1      // 4 vcpu
    const s2 = createServer(az.id, getPreset('dedicated-8')!); doc.servers[s2.id] = s2     // 8 vcpu
    const web = createBlueprint('web', 0)
    web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    web.workload.cpuMsPerRequest = 8
    doc.blueprints[web.id] = web
    const api = createBlueprint('api', 1)          // default port is internal → not an entry
    doc.blueprints[api.id] = api
    const p1 = createPlacement(web.id, s1.id); doc.placements[p1.id] = p1
    const p2 = createPlacement(web.id, s2.id); doc.placements[p2.id] = p2
    const p3 = createPlacement(api.id, s1.id); doc.placements[p3.id] = p3
    expect(frontlineCapacityRps(doc, compileWorld(doc))).toBe(1500)   // 4·125 + 8·125, api excluded
  })
  it('is 0 with no entry placements', () => {
    expect(frontlineCapacityRps(createWorld(), compileWorld(createWorld()))).toBe(0)
  })
})

describe('placementEgressUsdPerHr', () => {
  it('constant matches the engine\'s documented BYTES_PER_REQUEST_EACH_WAY value', () => {
    expect(PLACEMENT_BYTES_EACH_WAY).toBe(2048)
  })

  it('is 0 at 0 rps', () => {
    expect(placementEgressUsdPerHr(0)).toBe(0)
  })

  it('stays 0 while under AWS\'s 100 GB/month free egress allowance', () => {
    // 5 rps * 2048 * 2 each-way * 2_630_000 s/month / 1024^3 ≈ 50.16 GB/month < 100 GB free.
    expect(placementEgressUsdPerHr(5)).toBe(0)
  })

  it('matches the hand-derived D9 formula at 500 rps (createPopulation\'s default)', () => {
    // bytesPerSec = 500 * 2048 * 2 = 2,048,000
    // gbMonth = 2,048,000 * 2,630,000 / 1024^3 = 20,546,875/4096 ≈ 5016.3269 GB/month
    // billable = 5016.3269 - 100 (aws free tier) ≈ 4916.3269 GB @ $0.09/GB ≈ $442.4694/month
    // hourly = 442.4694 / 730 ≈ $0.6061/hr
    expect(placementEgressUsdPerHr(500)).toBeCloseTo(0.6061, 3)
  })

  it('scales linearly once past the free allowance (no free tier double-counted)', () => {
    const at1000 = placementEgressUsdPerHr(1000)
    const at2000 = placementEgressUsdPerHr(2000)
    // Both comfortably clear the free tier, so doubling rps should ~double the billed egress
    // (same $/GB tier for both — well under AWS's 10,240 GB tier ceiling at these rps values).
    expect(at2000 / at1000).toBeCloseTo(2, 1)
  })
})
