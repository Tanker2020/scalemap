import { describe, it, expect } from 'vitest'
import {
  populationDemandRps, splitDemandByMix, samplePoisson, createDemandState,
  BURST_MULTIPLIER_MIN,
} from './demand'
import { createRng } from './rng'
import { createPopulation } from '../world/factories'

// Audit ISSUE-017: demand is Poisson around the diurnal mean (variance ≈ mean), with a seeded
// on-off burst process — the old ±3% uniform jitter never stressed queues or breakers.
describe('populationDemandRps (Poisson arrivals)', () => {
  it('flat pattern: mean over many 1s samples ≈ peakRps, variance ≈ mean (Poisson)', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 100, diurnal: 'flat' as const }
    const rng = createRng(1)
    const N = 3000
    const samples: number[] = []
    for (let i = 0; i < N; i++) samples.push(populationDemandRps(pop, i * 1000, rng))   // 1s windows ⇒ arrivals
    const mean = samples.reduce((a, b) => a + b, 0) / N
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N
    expect(mean).toBeGreaterThan(100 * 0.95)
    expect(mean).toBeLessThan(100 * 1.05)
    // Poisson signature: variance ≈ mean (uniform ±3% jitter would give variance ≈ 3, not ~100).
    expect(variance).toBeGreaterThan(mean * 0.8)
    expect(variance).toBeLessThan(mean * 1.25)
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
    // envelope factors are 0.55 ± 0.45 ⇒ [0.1, 1.0] of peakRps, Poisson noise (σ≈√λ) on top
    expect(min).toBeGreaterThanOrEqual(1000 * 0.1 * 0.6)
    expect(min).toBeLessThanOrEqual(1000 * 0.1 * 1.4)
    expect(max).toBeGreaterThanOrEqual(1000 * 0.9)
    expect(max).toBeLessThanOrEqual(1000 * 1.2)
  })

  it('same seed ⇒ identical demand sequence (determinism)', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 50, diurnal: 'day-night' as const }
    const runA: number[] = []
    const runB: number[] = []
    for (const out of [runA, runB]) {
      const rng = createRng(42)
      const burst = createDemandState()
      for (let i = 0; i < 500; i++) out.push(populationDemandRps(pop, i * 100, rng, 100, burst))
    }
    expect(runA).toEqual(runB)
  })

  it('burst process occasionally pushes demand well above the diurnal mean', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 200, diurnal: 'flat' as const }
    const rng = createRng(7)
    const burst = createDemandState()
    let max = 0
    for (let i = 0; i < 6000; i++) {   // 10 min at 100ms steps — expect ~3 bursts
      max = Math.max(max, populationDemandRps(pop, i * 100, rng, 100, burst))
    }
    // A burst multiplies the mean by ≥1.5; Poisson noise alone at λ=20 stays far below 1.5×200.
    expect(max).toBeGreaterThan(200 * BURST_MULTIPLIER_MIN * 0.9)
  })

  it('burstiness 0 disables bursts entirely', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 200, diurnal: 'flat' as const, burstiness: 0 }
    const rng = createRng(7)
    const burst = createDemandState()
    for (let i = 0; i < 6000; i++) populationDemandRps(pop, i * 100, rng, 100, burst)
    expect(burst.burstUntilMs).toBe(-1)   // the burst state never engaged
  })
})

describe('samplePoisson', () => {
  it('λ=0 ⇒ 0; small λ matches mean over many draws', () => {
    const rng = createRng(5)
    expect(samplePoisson(0, rng)).toBe(0)
    const N = 5000
    let sum = 0
    for (let i = 0; i < N; i++) sum += samplePoisson(4, rng)
    expect(sum / N).toBeGreaterThan(4 * 0.9)
    expect(sum / N).toBeLessThan(4 * 1.1)
  })

  it('large λ (normal approximation) matches mean and never goes negative', () => {
    const rng = createRng(6)
    const N = 3000
    let sum = 0
    for (let i = 0; i < N; i++) {
      const v = samplePoisson(500, rng)
      expect(v).toBeGreaterThanOrEqual(0)
      sum += v
    }
    expect(sum / N).toBeGreaterThan(500 * 0.98)
    expect(sum / N).toBeLessThan(500 * 1.02)
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
