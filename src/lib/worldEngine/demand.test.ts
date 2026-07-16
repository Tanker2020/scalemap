import { describe, it, expect } from 'vitest'
import { populationDemandRps, splitDemandByMix } from './demand'
import { createRng } from './rng'
import { createPopulation } from '../world/factories'

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

describe('splitDemandByMix', () => {
  it('no mix ⇒ a single implicit default route carrying 100% (pre-route equivalence)', () => {
    expect(splitDemandByMix(1000)).toEqual([{ routeId: null, rps: 1000 }])
    expect(splitDemandByMix(1000, [])).toEqual([{ routeId: null, rps: 1000 }])
  })

  it('an all-non-positive mix collapses to the default route (no divide-by-zero)', () => {
    expect(splitDemandByMix(500, [{ routeId: 'a', weight: 0 }, { routeId: 'b', weight: -1 }]))
      .toEqual([{ routeId: null, rps: 500 }])
  })

  it('splits by relative weight and preserves routeIds', () => {
    const out = splitDemandByMix(1000, [{ routeId: 'api', weight: 1 }, { routeId: 'static', weight: 3 }])
    expect(out).toEqual([{ routeId: 'api', rps: 250 }, { routeId: 'static', rps: 750 }])
  })

  it('the split conserves total rps', () => {
    const out = splitDemandByMix(777, [{ routeId: 'a', weight: 2 }, { routeId: 'b', weight: 5 }, { routeId: 'c', weight: 1 }])
    const sum = out.reduce((s, r) => s + r.rps, 0)
    expect(sum).toBeCloseTo(777, 6)
  })

  it('drops zero-weight entries but keeps positive ones', () => {
    const out = splitDemandByMix(100, [{ routeId: 'keep', weight: 4 }, { routeId: 'drop', weight: 0 }])
    expect(out).toEqual([{ routeId: 'keep', rps: 100 }])
  })
})
