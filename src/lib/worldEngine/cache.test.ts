import { describe, it, expect } from 'vitest'
import { effectiveHitRatio, effectiveMissFraction } from './cache'
import type { CacheConfig } from '../world/types'

const cfg: CacheConfig = { hitRatio: 0.95, warmupSec: 60, ttlSec: 300 }

describe('effectiveHitRatio', () => {
  it('is 0 at simMs === warmSinceMs (just restarted)', () => {
    expect(effectiveHitRatio(cfg, 10_000, 10_000)).toBe(0)
  })

  it('ramps linearly to the configured hitRatio over warmupSec', () => {
    // warmSinceMs = 0, warmupSec = 60 -> full warmth at simMs = 60_000
    expect(effectiveHitRatio(cfg, 0, 30_000)).toBeCloseTo(0.475, 5) // half warm * 0.95
    expect(effectiveHitRatio(cfg, 0, 60_000)).toBeCloseTo(0.95, 5)
  })

  it('clamps at the configured hitRatio past warmupSec (never overshoots)', () => {
    expect(effectiveHitRatio(cfg, 0, 120_000)).toBeCloseTo(0.95, 5)
  })

  it('is exactly hitRatio when warmSinceMs is undefined (warm at start(), the regression floor)', () => {
    expect(effectiveHitRatio(cfg, undefined, 0)).toBeCloseTo(0.95, 5)
  })
})

describe('effectiveMissFraction', () => {
  it('equals 1 - effectiveHitRatio away from the TTL floor', () => {
    // hitRatio 0.5, well above the TTL floor (stepSec/ttlSec is tiny)
    const c: CacheConfig = { hitRatio: 0.5, warmupSec: 0, ttlSec: 300 }
    expect(effectiveMissFraction(c, undefined, 0, 0.1)).toBeCloseTo(0.5, 5)
  })

  it('the TTL floor holds: an aggressive hitRatio never reaches a physically-impossible zero miss', () => {
    const c: CacheConfig = { hitRatio: 0.999, warmupSec: 0, ttlSec: 10 }
    const stepSec = 0.1
    const floor = stepSec / c.ttlSec // 0.01
    expect(effectiveMissFraction(c, undefined, 0, stepSec)).toBeGreaterThanOrEqual(floor)
    expect(effectiveMissFraction(c, undefined, 0, stepSec)).toBeCloseTo(floor, 5) // floor dominates 1-0.999=0.001
  })

  it('is 1 (100% miss) at the instant of restart', () => {
    expect(effectiveMissFraction(cfg, 10_000, 10_000, 0.1)).toBeCloseTo(1, 5)
  })

  it('decays toward the steady-state miss fraction as warmth ramps', () => {
    const early = effectiveMissFraction(cfg, 0, 5_000, 0.1)
    const later = effectiveMissFraction(cfg, 0, 60_000, 0.1)
    expect(early).toBeGreaterThan(later)
    expect(later).toBeCloseTo(1 - 0.95, 2)
  })
})
