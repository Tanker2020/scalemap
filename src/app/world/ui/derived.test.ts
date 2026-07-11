import { describe, it, expect } from 'vitest'
import {
  rpsPerCore, hostRpsCapacity, ramAtConnections, residentRamDemandMb, ttlLagHint, diskIoWord,
  healthWord,
} from './derived'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
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
