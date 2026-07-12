// @vitest-environment jsdom
// Regression coverage for the stuck hold-ring (user report 2026-07-12): every release/cancel
// path must ZERO progressRef, not merely stop the rAF loop — HoldRing's own rAF keeps painting
// progressRef after this hook's loop stops, so a stale partial value renders a ring frozen at
// its last sweep forever.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHoldTap } from './useHoldTap'
import { HOLD_TAP_MS } from '../ui/HoldToEnter'
import type { PointerEvent as ReactPointerEvent } from 'react'

function fakeEvent(x = 100, y = 100): ReactPointerEvent {
  return {
    pointerId: 1, clientX: x, clientY: y,
    target: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
  } as unknown as ReactPointerEvent
}

describe('useHoldTap — ring progress resets on every cancel path', () => {
  let now = 0
  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    // Freeze the rAF loop: the hook's loop only advances when frames fire; tests drive
    // progressRef by simulating what one frame would have written.
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('aborted hold (released after HOLD_TAP_MS, before completion) zeroes the ring and never taps', () => {
    const onTap = vi.fn()
    const { result } = renderHook(() => useHoldTap(onTap, () => {}))
    result.current.handlers.onPointerDown(fakeEvent())
    // mid-hold: the rAF loop would have painted partial progress
    result.current.progressRef.current = 0.6
    now += HOLD_TAP_MS + 150   // past tap threshold, before 700ms completion
    result.current.handlers.onPointerUp(fakeEvent())
    expect(result.current.progressRef.current).toBe(0)
    expect(onTap).not.toHaveBeenCalled()
  })

  it('a plain tap zeroes the ring and fires onTap', () => {
    const onTap = vi.fn()
    const { result } = renderHook(() => useHoldTap(onTap, () => {}))
    result.current.handlers.onPointerDown(fakeEvent())
    result.current.progressRef.current = 0.2
    now += 120
    result.current.handlers.onPointerUp(fakeEvent())
    expect(result.current.progressRef.current).toBe(0)
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('slop-cancelled drag-off zeroes the ring immediately', () => {
    const { result } = renderHook(() => useHoldTap(() => {}, () => {}))
    result.current.handlers.onPointerDown(fakeEvent(100, 100))
    result.current.progressRef.current = 0.4
    result.current.handlers.onPointerMove(fakeEvent(160, 100))   // way past HOLD_SLOP_PX
    expect(result.current.progressRef.current).toBe(0)
  })

  it('pointer leave zeroes the ring', () => {
    const { result } = renderHook(() => useHoldTap(() => {}, () => {}))
    result.current.handlers.onPointerDown(fakeEvent())
    result.current.progressRef.current = 0.5
    result.current.handlers.onPointerLeave()
    expect(result.current.progressRef.current).toBe(0)
  })
})
