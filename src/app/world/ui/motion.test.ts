// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRollingNumber } from './motion'

let rafQueue: FrameRequestCallback[] = []
let now = 0

beforeEach(() => {
  rafQueue = []
  now = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})
afterEach(() => vi.unstubAllGlobals())

// Runs every queued frame callback once, advancing the mocked clock by dtMs per flush.
function flushFrame(dtMs: number) {
  now += dtMs
  const queue = rafQueue
  rafQueue = []
  act(() => { for (const cb of queue) cb(now) })
}

describe('useRollingNumber', () => {
  it('eases toward the target and lands exactly on it', () => {
    const { result, rerender } = renderHook(({ target }) => useRollingNumber(target, 150), {
      initialProps: { target: 1000 },
    })
    expect(result.current).toBe(1000)          // first render seeds at target — no roll-in
    rerender({ target: 2000 })
    flushFrame(50)
    expect(result.current).toBeGreaterThan(1000)
    expect(result.current).toBeLessThan(2000)  // mid-flight: strictly between
    for (let i = 0; i < 20 && result.current !== 2000; i++) flushFrame(50)
    expect(result.current).toBe(2000)          // lands EXACTLY, not asymptotically close
  })

  it('snaps immediately under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'), addEventListener: () => {}, removeEventListener: () => {},
    }))
    const { result, rerender } = renderHook(({ target }) => useRollingNumber(target), {
      initialProps: { target: 100 },
    })
    rerender({ target: 900 })
    // effect runs synchronously post-render; no frames flushed — already at target
    expect(result.current).toBe(900)
  })

  it('snaps immediately with durationMs 0 (no divide-by-zero ease)', () => {
    const { result, rerender } = renderHook(({ target }) => useRollingNumber(target, 0), {
      initialProps: { target: 100 },
    })
    rerender({ target: 900 })
    // guard branch: no frames flushed — already at target
    expect(result.current).toBe(900)
  })
})
