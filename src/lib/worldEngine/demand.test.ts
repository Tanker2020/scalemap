import { describe, it, expect } from 'vitest'
import {
  populationDemandRps, splitDemandByMix, samplePoisson, createDemandState,
  BURST_MULTIPLIER_MIN, diurnalMultiplierFor,
} from './demand'
import type { DemandOverlayEntry } from './rampMath'
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

  // FEAT-003 Task 19: the demand-overlay consumption side — populationDemandRps must scale the
  // diurnal MEAN by the overlay's current ramped multiplier, not replace the Poisson draw with a
  // deterministic value (that would silence every downstream queue/breaker/capacity signal the
  // Poisson variance exists to stress in the first place, per audit ISSUE-017).
  it('demand-multiplier at factor 4, rampSec 600 reaches ~4x mean demand at +10min, Poisson variance still present', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 100, diurnal: 'flat' as const, burstiness: 0 }
    const rng = createRng(11)
    const overlay = new Map<string, DemandOverlayEntry>([
      [pop.id, { multiplier: 1, targetMultiplier: 4, rampStartMs: 0, rampSec: 600 }],
    ])
    // Ramp completes at simMs=600_000 (rampSec=600s); sample well past it, near +10min mark.
    const sampleAt = 600_000
    const N = 3000
    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      samples.push(populationDemandRps(pop, sampleAt + i * 1000, rng, 1000, undefined, overlay))
    }
    const mean = samples.reduce((a, b) => a + b, 0) / N
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N
    expect(mean).toBeGreaterThan(400 * 0.95)
    expect(mean).toBeLessThan(400 * 1.05)
    // Poisson signature preserved at the scaled mean (variance ≈ mean, not ≈ 0 as a deterministic
    // "replace the draw" shortcut bug would produce).
    expect(variance).toBeGreaterThan(mean * 0.8)
    expect(variance).toBeLessThan(mean * 1.25)
  })

  it('a population with no overlay entry is unaffected (multiplier defaults to 1)', () => {
    const pop = { ...createPopulation('clients', 0, 0), peakRps: 100, diurnal: 'flat' as const, burstiness: 0 }
    const rng = createRng(12)
    const overlay = new Map<string, DemandOverlayEntry>([
      ['someone-else', { multiplier: 1, targetMultiplier: 4, rampStartMs: 0, rampSec: 600 }],
    ])
    const N = 2000
    const samples: number[] = []
    for (let i = 0; i < N; i++) samples.push(populationDemandRps(pop, i * 1000, rng, 1000, undefined, overlay))
    const mean = samples.reduce((a, b) => a + b, 0) / N
    expect(mean).toBeGreaterThan(100 * 0.9)
    expect(mean).toBeLessThan(100 * 1.1)
  })
})

describe('diurnalMultiplierFor', () => {
  it('a custom curve interpolates piecewise-linearly between authored points', () => {
    const DAY_MS = 120_000
    const pop = {
      ...createPopulation('clients', 0, 0),
      peakRps: 100,
      diurnal: 'custom' as const,
      curve: [{ atFraction: 0, multiplier: 0.2 }, { atFraction: 0.5, multiplier: 1.0 }, { atFraction: 1, multiplier: 0.2 }],
    }
    expect(diurnalMultiplierFor(pop, 0)).toBeCloseTo(0.2)
    expect(diurnalMultiplierFor(pop, DAY_MS / 2)).toBeCloseTo(1.0)
    expect(diurnalMultiplierFor(pop, DAY_MS / 4)).toBeCloseTo(0.6)   // midpoint of the first segment
  })

  it('a custom curve clamps outside the authored range and handles an absent/empty curve as flat 1x', () => {
    const DAY_MS = 120_000
    const pop = {
      ...createPopulation('clients', 0, 0),
      peakRps: 100,
      diurnal: 'custom' as const,
      curve: [{ atFraction: 0.25, multiplier: 0.5 }, { atFraction: 0.75, multiplier: 2.0 }],
    }
    expect(diurnalMultiplierFor(pop, 0)).toBeCloseTo(0.5)   // before first point ⇒ clamp to first
    expect(diurnalMultiplierFor(pop, DAY_MS)).toBeCloseTo(0.5)   // wraps to fraction 0 ⇒ clamp to first
    expect(diurnalMultiplierFor(pop, DAY_MS * 0.9)).toBeCloseTo(2.0)   // after last point ⇒ clamp to last

    const flatFallback = { ...pop, curve: undefined }
    expect(diurnalMultiplierFor(flatFallback, DAY_MS / 3)).toBe(1)
  })

  it('flat and day-night diurnal patterns are unchanged to the digit', () => {
    const DAY_MS = 120_000
    const flat = { ...createPopulation('clients', 0, 0), peakRps: 100, diurnal: 'flat' as const }
    expect(diurnalMultiplierFor(flat, 0)).toBe(1)
    expect(diurnalMultiplierFor(flat, 12_345)).toBe(1)
    expect(diurnalMultiplierFor(flat, DAY_MS * 7)).toBe(1)

    const dayNight = { ...createPopulation('clients', 0, 0), peakRps: 100, diurnal: 'day-night' as const }
    const expectedAt = (simMs: number) => 0.55 + 0.45 * Math.sin((2 * Math.PI * simMs) / DAY_MS - Math.PI / 2)
    expect(diurnalMultiplierFor(dayNight, 0)).toBeCloseTo(expectedAt(0))
    expect(diurnalMultiplierFor(dayNight, DAY_MS / 4)).toBeCloseTo(expectedAt(DAY_MS / 4))
    expect(diurnalMultiplierFor(dayNight, DAY_MS / 2)).toBeCloseTo(expectedAt(DAY_MS / 2))
    expect(diurnalMultiplierFor(dayNight, DAY_MS * 3 / 4)).toBeCloseTo(expectedAt(DAY_MS * 3 / 4))
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
