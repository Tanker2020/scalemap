import { describe, it, expect } from 'vitest'
import { populationDemandRps, baselineDemands } from './demand'
import { createRng } from './rng'
import { createPopulation, createRegion } from '../world/factories'
import type { TrafficConfig } from '../world/types'

describe('populationDemandRps', () => {
  it('flat pattern stays at peakRps within the +-3% jitter band, independent of simMs', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 1000, diurnal: 'flat' as const }
    const rng = createRng(1)
    for (const simMs of [0, 10_000, 60_000, 500_000]) {
      const v = populationDemandRps(pop, simMs, rng)
      expect(v).toBeGreaterThanOrEqual(1000 * 0.97)
      expect(v).toBeLessThanOrEqual(1000 * 1.03)
    }
  })

  it('day-night pattern envelopes between ~10% and ~100% of peakRps over one compressed day', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 1000, diurnal: 'day-night' as const }
    const rng = createRng(2)
    const DAY_MS = 120_000
    let min = Infinity
    let max = -Infinity
    for (let simMs = 0; simMs <= DAY_MS; simMs += 500) {
      const v = populationDemandRps(pop, simMs, rng)
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    // envelope factors are 0.55 +- 0.45 => [0.1, 1.0] of peakRps, +-3% jitter on top
    expect(min).toBeGreaterThanOrEqual(1000 * 0.1 * 0.9)
    expect(min).toBeLessThanOrEqual(1000 * 0.1 * 1.1)
    expect(max).toBeGreaterThanOrEqual(1000 * 1.0 * 0.95)
    expect(max).toBeLessThanOrEqual(1000 * 1.0 * 1.05)
  })

  it('jitter never pushes demand outside the documented +-3% band', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 200, diurnal: 'flat' as const }
    const rng = createRng(3)
    for (let i = 0; i < 500; i++) {
      const v = populationDemandRps(pop, i * 1000, rng)
      expect(v).toBeGreaterThanOrEqual(200 * 0.97)
      expect(v).toBeLessThanOrEqual(200 * 1.03)
    }
  })
})

describe('baselineDemands', () => {
  const traffic = (autoBaseline: boolean, baselineTotalRps = 900): TrafficConfig => ({ autoBaseline, baselineTotalRps })

  it('splits baselineTotalRps evenly across regions with baseline:<regionId> keys', () => {
    const r1 = createRegion('us-east-1')
    const r2 = createRegion('eu-west-1')
    const r3 = createRegion('ap-southeast-1')
    const regions = { [r1.id]: r1, [r2.id]: r2, [r3.id]: r3 }
    const result = baselineDemands(traffic(true, 900), {}, regions)
    expect(Object.keys(result).sort()).toEqual([`baseline:${r1.id}`, `baseline:${r2.id}`, `baseline:${r3.id}`].sort())
    for (const regionId of [r1.id, r2.id, r3.id]) {
      expect(result[`baseline:${regionId}`]).toBe(300)
    }
  })

  it('returns {} when autoBaseline is off', () => {
    const r1 = createRegion('us-east-1')
    expect(baselineDemands(traffic(false), {}, { [r1.id]: r1 })).toEqual({})
  })

  it('returns {} for an empty region set (no divide-by-zero)', () => {
    expect(baselineDemands(traffic(true), {}, {})).toEqual({})
  })

  it('does not clobber an authored population that already owns a baseline:<regionId> id', () => {
    const r1 = createRegion('us-east-1')
    const clashId = `baseline:${r1.id}`
    const authored = { [clashId]: { ...createPopulation('manual', 1, 1), id: clashId } }
    const result = baselineDemands(traffic(true, 500), authored, { [r1.id]: r1 })
    expect(result[clashId]).toBeUndefined()
  })
})
