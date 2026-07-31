// sampleSizeMultiplier (slice 3: log-normal NIC-burst tails) — a mean-preserving log-normal
// per-step multiplier, mirroring sampleLatencyMs's Box-Muller sampling approach. sigma <= 0 must
// be a true no-op: returns exactly 1 and consumes ZERO rng draws, so an unauthored (sigma-less)
// world's rng stream is completely undisturbed by this feature (the backward-compat invariant).
import { describe, it, expect } from 'vitest'
import { createRng } from './rng'
import { sampleSizeMultiplier, sampleLatencyMs, timeoutErrorFraction } from './latency'

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

// ─── timeoutErrorFraction (audit ISSUE-006) ───────────────────────────────────
// P(latency > timeoutMs) under the SAME log-normal (p50, p99) sampleLatencyMs draws from —
// analytic, no rng draw, so it can't disturb the seeded stream.
describe('timeoutErrorFraction', () => {
  it('is ~0 when the timeout sits well above p99', () => {
    expect(timeoutErrorFraction(50, 150, 500)).toBeCloseTo(0, 3)
  })

  it('is large when the timeout sits below p50', () => {
    expect(timeoutErrorFraction(50, 150, 30)).toBeGreaterThan(0.5)
  })

  it('is exactly 0.5 when the timeout equals p50 (median of the distribution)', () => {
    expect(timeoutErrorFraction(50, 150, 50)).toBeCloseTo(0.5, 6)
  })

  it('rises monotonically as the timeout tightens', () => {
    const loose = timeoutErrorFraction(50, 150, 200)
    const mid = timeoutErrorFraction(50, 150, 60)
    const tight = timeoutErrorFraction(50, 150, 20)
    expect(loose).toBeLessThan(mid)
    expect(mid).toBeLessThan(tight)
  })

  it('a non-positive or absent timeout means no timeout at all (fraction 0)', () => {
    expect(timeoutErrorFraction(50, 150, 0)).toBe(0)
    expect(timeoutErrorFraction(50, 150, -10)).toBe(0)
  })

  it('handles the degenerate zero-spread case (p99 <= p50) without NaN', () => {
    expect(timeoutErrorFraction(50, 50, 100)).toBe(0)   // timeout above the single point -> never
    expect(timeoutErrorFraction(50, 50, 10)).toBe(1)    // timeout below it -> always
  })

  it('never returns NaN or a value outside [0, 1] across a range of inputs', () => {
    for (const p50 of [1, 10, 100, 1000]) {
      for (const timeoutMs of [0.1, 1, 50, 500, 10000]) {
        const f = timeoutErrorFraction(p50, p50 * 10, timeoutMs)
        expect(Number.isNaN(f)).toBe(false)
        expect(f).toBeGreaterThanOrEqual(0)
        expect(f).toBeLessThanOrEqual(1)
      }
    }
  })

  it('consumes no rng draws — sampleLatencyMs is unaffected by calling it alongside', () => {
    const rng = createRng(5)
    const before = sampleLatencyMs(50, 150, rng)
    const rngAgain = createRng(5)
    timeoutErrorFraction(50, 150, 60)   // no rng argument at all — can't consume a draw
    const after = sampleLatencyMs(50, 150, rngAgain)
    expect(after).toBe(before)
  })
})
