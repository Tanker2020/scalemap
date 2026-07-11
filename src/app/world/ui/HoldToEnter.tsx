// Hold-to-enter drill primitive (Polish 2 D5): pure progress math + a screen-space SVG ring.
// Reusable beyond the globe (region → AZ → server mounts are a parked follow-up). The ring is
// FUNCTIONAL progress feedback, so its sweep stays under prefers-reduced-motion — only the
// glow is trimmed (Global Constraints).
import { useEffect, useRef, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'

export const HOLD_DURATION_MS = 700

const RING_R = 15                       // viewBox units — matches the mockup's r=15 @ 34×34
const RING_C = 2 * Math.PI * RING_R     // 94.248 — the mockup's stroke-dasharray

export function holdProgress(nowMs: number, startMs: number | null, durationMs = HOLD_DURATION_MS): number {
  if (startMs === null) return 0
  return Math.min(1, Math.max(0, (nowMs - startMs) / durationMs))
}

// A press shorter than this is a tap; a longer-but-incomplete press is an aborted hold —
// its synthetic click must be swallowed (spec D1: early release = no navigation, no overlay).
export const HOLD_TAP_MS = 250

export function isAbortedHold(pressedMs: number): boolean {
  return pressedMs >= HOLD_TAP_MS
}

export interface HoldRingProps {
  /** Parent-owned progress cell (0..1), mutated per frame — never setState per frame. */
  progressRef: { current: number }
  size?: number
}

export function HoldRing({ progressRef, size = 34 }: HoldRingProps): ReactElement {
  const circleRef = useRef<SVGCircleElement>(null)
  const reduced = useReducedMotion() ?? false

  // rAF loop applies progressRef to stroke-dashoffset/opacity — DOM writes only, no React
  // state. jsdom/SSR-safe: without rAF the ring simply stays hidden (live-smoke gated).
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return
    let raf = 0
    const tick = () => {
      const el = circleRef.current
      if (el) {
        const p = Math.min(1, Math.max(0, progressRef.current))
        el.style.strokeDashoffset = String(RING_C * (1 - p))
        if (el.ownerSVGElement) el.ownerSVGElement.style.opacity = p > 0 ? '1' : '0'
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [progressRef])

  return (
    <svg
      width={size} height={size} viewBox="0 0 34 34" aria-hidden="true"
      style={{ opacity: 0, transform: 'rotate(-90deg)', pointerEvents: 'none', display: 'block' }}
    >
      <circle
        ref={circleRef}
        cx="17" cy="17" r={RING_R} fill="none"
        stroke="var(--kit-accent)" strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={RING_C} strokeDashoffset={RING_C}
        style={reduced ? undefined : { filter: 'drop-shadow(0 0 4px var(--kit-accent-dim))' }}
      />
    </svg>
  )
}
