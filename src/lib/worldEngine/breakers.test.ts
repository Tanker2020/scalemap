import { describe, it, expect } from 'vitest'
import {
  getBreaker, recordResult, recordWeighted, transition, admitRequest, clearBreakers, pathKey,
  DEFAULT_BREAKER_CONFIG,
} from './breakers'
import type { Breaker } from './breakers'

function freshBreaker(): { map: Map<string, Breaker>; b: Breaker } {
  const map = new Map<string, Breaker>()
  const b = getBreaker(map, pathKey('i-1', 'dep-1'))
  return { map, b }
}

// Close a half-open breaker: k consecutive successful probe batches (audit ISSUE-015).
function probeToClose(b: Breaker, fromMs: number): void {
  for (let i = 0; i < DEFAULT_BREAKER_CONFIG.halfOpenProbes; i++) {
    admitRequest(b)
    recordWeighted(b, 0, 100, fromMs + i * 100)
  }
}

describe('breakers — state cycle (audit ISSUE-015 semantics)', () => {
  it('runs the full cycle: closed -> open -> half-open -> closed after k probe successes', () => {
    const { b } = freshBreaker()
    expect(b.state).toBe('closed')
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(1000)

    expect(transition(b, 5_000)).toBe('open')          // resetMs (10s) not yet elapsed
    expect(transition(b, 11_001)).toBe('half-open')    // > openedAt + resetMs

    // ONE clean probe is no longer enough — k consecutive successes are required.
    admitRequest(b)
    recordWeighted(b, 0, 100, 11_100)
    expect(b.state).toBe('half-open')
    admitRequest(b)
    recordWeighted(b, 0, 100, 11_200)
    expect(b.state).toBe('half-open')
    admitRequest(b)
    recordWeighted(b, 0, 100, 11_300)                  // 3rd consecutive success
    expect(b.state).toBe('closed')
    expect(b.buckets).toEqual([])                      // window cleared on close
  })

  it('reopens with a fresh openedAt when a half-open probe fails', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    transition(b, 11_001)
    expect(b.state).toBe('half-open')
    admitRequest(b)
    recordResult(b, true, 11_200)                      // trial fails
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(11_200)
    expect(transition(b, 21_000)).toBe('open')         // new resetMs window from 11_200
    expect(transition(b, 21_201)).toBe('half-open')
  })

  it('a probe failure between successes resets the consecutive count', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    transition(b, 10_001)
    admitRequest(b); recordWeighted(b, 0, 100, 10_100)   // success 1
    admitRequest(b); recordWeighted(b, 0, 100, 10_200)   // success 2
    admitRequest(b); recordWeighted(b, 100, 100, 10_300) // failure — reopen, count wiped
    expect(b.state).toBe('open')
    expect(b.halfOpenSuccesses).toBe(0)
    transition(b, 20_301)
    probeToClose(b, 20_400)                              // needs the full k again
    expect(b.state).toBe('closed')
  })

  it('half-open admits exactly one trial until it resolves', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    transition(b, 10_001)
    expect(admitRequest(b)).toBe(true)    // claims the trial
    expect(admitRequest(b)).toBe(false)   // second caller refused
    expect(admitRequest(b)).toBe(false)
    recordResult(b, false, 10_100)        // trial resolves (success 1 of k) — still half-open
    expect(b.state).toBe('half-open')
    expect(admitRequest(b)).toBe(true)    // next probe may claim a fresh trial
  })

  it('closed always admits; open never admits', () => {
    const { b } = freshBreaker()
    expect(admitRequest(b)).toBe(true)
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    expect(b.state).toBe('open')
    expect(admitRequest(b)).toBe(false)
    expect(admitRequest(b)).toBe(false)
  })
})

describe('breakers — weighted time-bucketed window (audit ISSUE-015)', () => {
  it('never opens below the weighted volume floor even at 100% errors', () => {
    const { b } = freshBreaker()
    recordWeighted(b, 9, 9, 0)            // 9 failed requests < minTotalToOpen 10
    expect(b.state).toBe('closed')
    recordWeighted(b, 1, 1, 100)          // 10th failed request crosses the floor
    expect(b.state).toBe('open')
  })

  it('weighs by request volume: a huge healthy flow drowns a tiny failing one', () => {
    const { b } = freshBreaker()
    recordWeighted(b, 0, 10_000, 0)       // 10 000 clean requests
    for (let i = 0; i < 20; i++) recordWeighted(b, 1, 1, i * 100)   // 20 failed 1-req batches
    // Unweighted per-batch samples would read 20/21 ≈ 95% and open; weighted is 20/10020.
    expect(b.state).toBe('closed')
  })

  it('failures age out of the rolling time window', () => {
    const { b } = freshBreaker()
    recordWeighted(b, 40, 100, 0)          // 40% errors at t=0 — under threshold
    expect(b.state).toBe('closed')
    // 15s later (past the 10×1s window) the old bucket is gone; fresh clean traffic dominates.
    recordWeighted(b, 0, 100, 15_000)
    expect(b.buckets).toHaveLength(1)
    expect(b.buckets[0].failures).toBe(0)
  })

  it('opens at a sustained ≥50% weighted rate once the volume floor is met', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 5; i++) recordWeighted(b, 6, 10, i * 100)   // 60% × 50 requests
    expect(b.state).toBe('open')

    const { b: c } = freshBreaker()
    for (let i = 0; i < 20; i++) recordWeighted(c, 4, 10, i * 100)  // 40% — stays closed
    expect(c.state).toBe('closed')
  })

  it('getBreaker creates once and reuses; clearBreakers empties the map', () => {
    const map = new Map<string, Breaker>()
    const a = getBreaker(map, 'k1')
    expect(getBreaker(map, 'k1')).toBe(a)
    expect(a.config).toEqual(DEFAULT_BREAKER_CONFIG)
    getBreaker(map, 'k2', { ...DEFAULT_BREAKER_CONFIG, errorThreshold: 0.2 })
    expect(map.size).toBe(2)
    expect(getBreaker(map, 'k2').config.errorThreshold).toBe(0.2)
    clearBreakers(map)
    expect(map.size).toBe(0)
  })

  it('pathKey formats `${fromInstanceId}->${dependencyId}`', () => {
    expect(pathKey('pl-1#0', 'dep-9')).toBe('pl-1#0->dep-9')
  })
})

// Audit ISSUE-015 hysteresis: OPEN at ≥50% but a probe only counts as SUCCESS below 20% — the
// band between the two is "still broken". A dependency hovering at ~50% (or even 30%) errors
// can never flap closed again until it genuinely recovers.
describe('breakers — hysteresis band (audit ISSUE-015)', () => {
  it('a steady 50% dependency opens and STAYS open (probe at 50% reopens)', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordWeighted(b, 5, 10, i * 100)
    expect(b.state).toBe('open')
    transition(b, 11_000)
    admitRequest(b)
    recordWeighted(b, 50, 100, 11_100)     // probe still sees 50%
    expect(b.state).toBe('open')           // old semantics closed here (0.5 < threshold? no — but 0.45 did)
  })

  it('a probe in the band (30%: under open, over close) still reopens', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordWeighted(b, 10, 10, i * 100)
    transition(b, 11_000)
    admitRequest(b)
    recordWeighted(b, 30, 100, 11_100)     // 30% ≥ closeThreshold 0.2 — not recovered
    expect(b.state).toBe('open')
  })

  it('closes only after k probes below the close threshold', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordWeighted(b, 10, 10, i * 100)
    transition(b, 11_000)
    admitRequest(b); recordWeighted(b, 10, 100, 11_100)   // 10% < 0.2 — success 1
    admitRequest(b); recordWeighted(b, 15, 100, 11_200)   // 15% — success 2
    expect(b.state).toBe('half-open')
    admitRequest(b); recordWeighted(b, 0, 100, 11_300)    // success 3 — closed
    expect(b.state).toBe('closed')
  })
})

describe('breakers — weighted error recording (audit ISSUE-001)', () => {
  it('a fully-failing downstream opens once the window holds enough volume', () => {
    const { b } = freshBreaker()
    recordWeighted(b, 5, 5, 500)
    expect(b.state).toBe('closed')
    recordWeighted(b, 5, 5, 1000)
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(1000)
  })

  it('ignores an empty sample (total 0) instead of polluting the window', () => {
    const { b } = freshBreaker()
    recordWeighted(b, 0, 0, 0)
    expect(b.buckets).toEqual([])
  })

  it('recordResult remains the boolean special case of recordWeighted', () => {
    const { b } = freshBreaker()
    const { b: c } = freshBreaker()
    for (let i = 0; i < 10; i++) {
      recordResult(b, i % 2 === 0, 0)
      recordWeighted(c, i % 2 === 0 ? 1 : 0, 1, 0)
    }
    expect(b.buckets).toEqual(c.buckets)
    expect(b.state).toBe(c.state)
  })
})
