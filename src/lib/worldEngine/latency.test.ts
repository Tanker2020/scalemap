// sampleSizeMultiplier (slice 3: log-normal NIC-burst tails) — a mean-preserving log-normal
// per-step multiplier, mirroring sampleLatencyMs's Box-Muller sampling approach. sigma <= 0 must
// be a true no-op: returns exactly 1 and consumes ZERO rng draws, so an unauthored (sigma-less)
// world's rng stream is completely undisturbed by this feature (the backward-compat invariant).
import { describe, it, expect } from 'vitest'
import { createRng } from './rng'
import { sampleSizeMultiplier } from './latency'

describe('sampleSizeMultiplier (mean-preserving log-normal NIC-burst multiplier)', () => {
  it('sigma = 0 returns exactly 1 and consumes zero rng draws', () => {
    const rng = createRng(1)
    let calls = 0
    const spied = { ...rng, next: () => { calls += 1; return rng.next() } }
    const m = sampleSizeMultiplier(0, spied)
    expect(m).toBe(1)
    expect(calls).toBe(0)
  })

  it('a negative sigma is also treated as a no-op (returns 1, no draw)', () => {
    const rng = createRng(1)
    let calls = 0
    const spied = { ...rng, next: () => { calls += 1; return rng.next() } }
    const m = sampleSizeMultiplier(-0.5, spied)
    expect(m).toBe(1)
    expect(calls).toBe(0)
  })

  it('sigma > 0 draws exactly two rng.next() calls (Box-Muller)', () => {
    const rng = createRng(1)
    let calls = 0
    const spied = { ...rng, next: () => { calls += 1; return rng.next() } }
    sampleSizeMultiplier(0.5, spied)
    expect(calls).toBe(2)
  })

  it('large-N sample mean is approximately 1 (mean-preserving) for sigma > 0', () => {
    const rng = createRng(42)
    const sigma = 0.6
    const N = 20000
    let sum = 0
    for (let i = 0; i < N; i++) sum += sampleSizeMultiplier(sigma, rng)
    const mean = sum / N
    expect(mean).toBeGreaterThan(0.95)
    expect(mean).toBeLessThan(1.05)
  })

  it('is deterministic: same seed + same sigma ⇒ same sequence', () => {
    const sigma = 0.7
    const rngA = createRng(123)
    const rngB = createRng(123)
    const seqA = Array.from({ length: 10 }, () => sampleSizeMultiplier(sigma, rngA))
    const seqB = Array.from({ length: 10 }, () => sampleSizeMultiplier(sigma, rngB))
    expect(seqA).toEqual(seqB)
  })

  it('is a pure function of (sigma, rng-stream) — different seeds diverge', () => {
    const sigma = 0.7
    const rngA = createRng(1)
    const rngB = createRng(2)
    const a = sampleSizeMultiplier(sigma, rngA)
    const b = sampleSizeMultiplier(sigma, rngB)
    expect(a).not.toBe(b)
  })

  it('multiplier is always positive (log-normal support)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 500; i++) {
      expect(sampleSizeMultiplier(1.4, rng)).toBeGreaterThan(0)
    }
  })
})
