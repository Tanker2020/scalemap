// src/app/world/az/useHoldTap.ts
// DOM/SVG pointer-event wiring around `ui/HoldToEnter.tsx`'s pure primitives (reused, never
// forked — see that file's header). `RegionPins.tsx` (globe/) is the existing hold-to-enter
// consumer, but it's r3f/WebGL: raycast-driven onPointerOver/Out and a needed onClick-swallow
// dance around the synthetic click event r3f's mesh raycaster fires after pointerup. Real DOM
// elements with `setPointerCapture` don't have that problem — pointerup is the ONE place tap-vs-
// hold-vs-abort gets decided, so there's no separate click to swallow. What carries over
// unchanged from RegionPins: pointer CAPTURE (not pointerleave) is what governs "left mid-hold"
// (D1), because a captured pointer never fires pointerout — leaving is detected purely by
// distance from the press point (`exceedsHoldSlop`).
import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { holdProgress, isAbortedHold, exceedsHoldSlop } from '../ui/HoldToEnter'

export interface HoldTapHandlers {
  onPointerDown: (e: ReactPointerEvent) => void
  onPointerMove: (e: ReactPointerEvent) => void
  onPointerUp: (e: ReactPointerEvent) => void
  onPointerLeave: () => void
}

export interface UseHoldTap {
  handlers: HoldTapHandlers
  /** Mutated per animation frame while a hold is in progress — feed straight to `HoldRing`. */
  progressRef: { current: number }
}

export function useHoldTap(onTap: () => void, onHoldComplete: () => void): UseHoldTap {
  const progressRef = useRef(0)
  const startRef = useRef<number | null>(null)
  const startPosRef = useRef<{ x: number; y: number } | null>(null)
  const slopCancelledRef = useRef(false)
  const rafRef = useRef(0)

  const stopLoop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
  }

  const loop = useCallback(() => {
    const p = holdProgress(performance.now(), startRef.current)
    progressRef.current = p
    if (startRef.current !== null && p >= 1) {
      startRef.current = null
      progressRef.current = 0
      stopLoop()
      onHoldComplete()
      return
    }
    if (startRef.current !== null && typeof requestAnimationFrame === 'function') {
      rafRef.current = requestAnimationFrame(loop)
    }
  }, [onHoldComplete])

  const handlers: HoldTapHandlers = {
    onPointerDown: (e) => {
      ;(e.target as Element)?.setPointerCapture?.(e.pointerId)
      startRef.current = performance.now()
      startPosRef.current = { x: e.clientX, y: e.clientY }
      slopCancelledRef.current = false
      stopLoop()
      if (typeof requestAnimationFrame === 'function') rafRef.current = requestAnimationFrame(loop)
    },
    onPointerMove: (e) => {
      const start = startPosRef.current
      if (startRef.current !== null && start && exceedsHoldSlop(e.clientX - start.x, e.clientY - start.y)) {
        startRef.current = null   // deliberate drag-off — cancel the hold (D1)
        slopCancelledRef.current = true
        progressRef.current = 0   // HoldRing keeps painting progressRef after the loop stops —
        stopLoop()                // an un-zeroed cancel leaves the ring frozen mid-sweep
      }
    },
    onPointerUp: (e) => {
      ;(e.target as Element)?.releasePointerCapture?.(e.pointerId)
      const start = startRef.current
      startRef.current = null
      // Every release path must zero the ring, not just stop the loop: HoldRing's own rAF
      // keeps applying progressRef to the stroke, so a stale partial value = a ring stuck at
      // its last sweep forever (user report 2026-07-12: "pops up and stays").
      progressRef.current = 0
      stopLoop()
      // Hold already completed via the rAF loop above (which nulls startRef itself) — nothing
      // left to do. Otherwise: a slop-cancelled drag-off never taps; a short press taps; a long
      // but incomplete press is an aborted hold (D1: early release = no navigation, no select).
      if (slopCancelledRef.current) { slopCancelledRef.current = false; return }
      if (start === null) return
      const pressedMs = performance.now() - start
      if (isAbortedHold(pressedMs)) return
      onTap()
    },
    onPointerLeave: () => {
      // Defensive fallback only — under real pointer capture this won't fire mid-hold, but it's
      // free insurance for pointerdown sequences that never actually captured (e.g. jsdom).
      startRef.current = null
      progressRef.current = 0
      stopLoop()
    },
  }

  return { handlers, progressRef }
}
