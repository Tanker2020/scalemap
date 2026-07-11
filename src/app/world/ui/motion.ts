// Motion hooks for the hybrid kit (Polish 2 D8). No store imports.
import { useEffect, useRef, useState } from 'react'

/** Eases the displayed number toward `target` on rAF (~durationMs to land), landing exactly
 *  on the target. Under prefers-reduced-motion — or with no rAF (SSR) — it snaps. */
export function useRollingNumber(target: number, durationMs = 150): number {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)

  useEffect(() => {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof requestAnimationFrame !== 'function') {
      displayRef.current = target
      setDisplay(target)
      return
    }
    if (displayRef.current === target) return
    let raf = 0
    let last = performance.now()
    const tick = (nowMs: number) => {
      const dt = Math.max(0, nowMs - last)
      last = nowMs
      const cur = displayRef.current
      // Exponential approach (time constant durationMs/3, the standard 3τ≈95% rule) so the
      // value covers ~95% of the gap within durationMs, independent of frame rate.
      let next = cur + (target - cur) * (1 - Math.exp((-3 * dt) / durationMs))
      if (Math.abs(target - next) < Math.max(0.5, Math.abs(target) * 1e-4)) next = target
      displayRef.current = next
      setDisplay(next)
      if (next !== target) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, durationMs])

  return display
}
