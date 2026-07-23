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

describe('breakers — state cycle', () => {
  it('runs the full cycle: closed -> open -> half-open -> closed on trial success', () => {
    const { b } = freshBreaker()
    expect(b.state).toBe('closed')
    for (let i = 0; i < 10; i++) recordResult(b, true, 1000)
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(1000)

    expect(transition(b, 5_000)).toBe('open')          // resetMs (10s) not yet elapsed
    expect(transition(b, 11_001)).toBe('half-open')    // > openedAt + resetMs

    expect(admitRequest(b)).toBe(true)                 // the single trial
    recordResult(b, false, 11_100)                     // trial succeeds
    expect(b.state).toBe('closed')
    expect(b.errorWindow).toEqual([])                  // window cleared on close
  })

  it('reopens with a fresh openedAt when the half-open trial fails', () => {
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

  it('half-open admits exactly one trial until it resolves', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordResult(b, true, 0)
    transition(b, 10_001)
    expect(admitRequest(b)).toBe(true)    // claims the trial
    expect(admitRequest(b)).toBe(false)   // second caller refused
    expect(admitRequest(b)).toBe(false)
    recordResult(b, false, 10_100)        // trial resolves -> closed
    expect(admitRequest(b)).toBe(true)    // closed admits freely again
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

describe('breakers — window behavior', () => {
  it('never opens below the 10-sample minimum even at 100% errors', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 9; i++) recordResult(b, true, 0)
    expect(b.state).toBe('closed')
    recordResult(b, true, 0)              // 10th sample crosses the minimum
    expect(b.state).toBe('open')
  })

  it('stays closed under the error threshold and caps the window at 20 samples', () => {
    const { b } = freshBreaker()
    // 20 successes, then 9 failures: window holds the last 20 -> 9/20 = 0.45 < 0.5
    for (let i = 0; i < 20; i++) recordResult(b, false, 0)
    for (let i = 0; i < 9; i++) recordResult(b, true, 0)
    expect(b.errorWindow.length).toBe(20)
    expect(b.state).toBe('closed')
    recordResult(b, true, 0)              // 10/20 = 0.5 >= threshold
    expect(b.state).toBe('open')
  })

  it('getBreaker creates once and reuses; clearBreakers empties the map', () => {
    const map = new Map<string, Breaker>()
    const a = getBreaker(map, 'k1')
    expect(getBreaker(map, 'k1')).toBe(a)
    expect(a.config).toEqual(DEFAULT_BREAKER_CONFIG)
    getBreaker(map, 'k2', { errorThreshold: 0.2, windowSize: 20, resetMs: 5_000 })
    expect(map.size).toBe(2)
    expect(getBreaker(map, 'k2').config.errorThreshold).toBe(0.2)
    clearBreakers(map)
    expect(map.size).toBe(0)
  })

  it('pathKey formats `${fromInstanceId}->${dependencyId}`', () => {
    expect(pathKey('pl-1#0', 'dep-9')).toBe('pl-1#0->dep-9')
  })
})

// Audit ISSUE-001: the engine's step 8 feeds the breaker the target's observed ERROR FRACTION
// (errorRps / offeredRps), not a blocked boolean — a down/erroring/CPU-shedding downstream now
// registers as failures even though its caller row isn't `blocked`. The window holds one
// fraction (0..1) per recorded call batch; recordResult stays the boolean special case.
describe('breakers — weighted error recording (audit ISSUE-001)', () => {
  it('a fully-failing downstream (fraction 1 on every sample) opens after the 10-sample minimum', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 9; i++) recordWeighted(b, 100, 100, 500)
    expect(b.state).toBe('closed')
    recordWeighted(b, 100, 100, 1000)
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(1000)
  })

  it('partial error fractions accumulate: mean 0.6 opens, mean 0.4 stays closed', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordWeighted(b, 60, 100, 0)   // fraction 0.6 each
    expect(b.state).toBe('open')

    const { b: c } = freshBreaker()
    for (let i = 0; i < 20; i++) recordWeighted(c, 40, 100, 0)   // fraction 0.4 each
    expect(c.state).toBe('closed')
  })

  it('ignores an empty sample (total 0) instead of polluting the window', () => {
    const { b } = freshBreaker()
    recordWeighted(b, 0, 0, 0)
    expect(b.errorWindow).toEqual([])
  })

  it('half-open: a low-fraction trial closes, a high-fraction trial reopens', () => {
    const { b } = freshBreaker()
    for (let i = 0; i < 10; i++) recordWeighted(b, 100, 100, 1000)
    transition(b, 11_001)
    expect(b.state).toBe('half-open')
    admitRequest(b)
    recordWeighted(b, 90, 100, 11_100)     // 90% of the trial batch failed — still broken
    expect(b.state).toBe('open')
    expect(b.openedAt).toBe(11_100)

    transition(b, 21_101)
    admitRequest(b)
    recordWeighted(b, 5, 100, 21_200)      // 5% errors — recovered
    expect(b.state).toBe('closed')
    expect(b.errorWindow).toEqual([])
  })

  it('recordResult remains the boolean special case of recordWeighted', () => {
    const { b } = freshBreaker()
    const { b: c } = freshBreaker()
    for (let i = 0; i < 10; i++) {
      recordResult(b, i % 2 === 0, 0)
      recordWeighted(c, i % 2 === 0 ? 1 : 0, 1, 0)
    }
    expect(b.errorWindow).toEqual(c.errorWindow)
    expect(b.state).toBe(c.state)
  })
})
