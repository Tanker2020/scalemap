// src/app/world/az/useFloorCamera.ts
// Floor camera (post-Polish-3 fix wave, user report 2026-07-11: the floor rendered at a fixed
// 900×430 box with no fit/zoom/pan — dead space everywhere on large windows and no way to
// navigate a grown floor). Pure math (clampScale/fitCamera/zoomAt — node-env tested in
// useFloorCamera.test.ts) plus a hook owning {scale, tx, ty} that wires: fit on mount and on
// plan-footprint change, wheel zoom anchored at the cursor (native non-passive listener —
// React's synthetic onWheel can't preventDefault page scroll), and background drag-pan with
// pointer capture. Anything matching INTERACTIVE_SEL never starts a pan, so pod/slat
// hold-to-enter gestures (useHoldTap) and the toolbar/inspector keep their own pointer flow.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

export interface CameraState { scale: number; tx: number; ty: number }

export const CAMERA_MIN_SCALE = 0.45
export const CAMERA_MAX_SCALE = 2.5
export const FIT_MARGIN = 0.94

// Default = the datacenter floor's interactive set. ServerBoard (the level-4 circuit board,
// which reuses this hook since 2026-07-12) passes its own selector — pointerdown on anything
// matching never starts a pan; pointer capture would otherwise retarget the release (and the
// synthetic click) to the viewport and swallow the element's own tap/hold/click gesture.
const INTERACTIVE_SEL =
  'g[data-testid^="rack-slot"], g[data-testid^="free-pod"], .az-ghost, button, select, a, input, [data-no-pan]'

export function clampScale(s: number): number {
  return Math.min(CAMERA_MAX_SCALE, Math.max(CAMERA_MIN_SCALE, s))
}

/** Scale-to-fit-and-center. FIT_MARGIN leaves a breathing edge; a zero-sized container
 *  (jsdom, pre-layout mount) yields the identity camera rather than NaN. */
export function fitCamera(containerW: number, containerH: number, contentW: number, contentH: number): CameraState {
  if (containerW <= 0 || containerH <= 0 || contentW <= 0 || contentH <= 0) return { scale: 1, tx: 0, ty: 0 }
  const scale = clampScale(Math.min(containerW / contentW, containerH / contentH) * FIT_MARGIN)
  return { scale, tx: (containerW - contentW * scale) / 2, ty: (containerH - contentH * scale) / 2 }
}

/** Zoom by `factor`, keeping the content point under the cursor (mx,my — container px)
 *  stationary on screen. */
export function zoomAt(cam: CameraState, mx: number, my: number, factor: number): CameraState {
  const scale = clampScale(cam.scale * factor)
  const k = scale / cam.scale
  return { scale, tx: mx - (mx - cam.tx) * k, ty: my - (my - cam.ty) * k }
}

export interface FloorCamera {
  containerRef: RefObject<HTMLDivElement | null>
  cameraStyle: CSSProperties
  panning: boolean
  fit: () => void
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
}

export function useFloorCamera(contentW: number, contentH: number, refitKey: string, interactiveSel: string = INTERACTIVE_SEL): FloorCamera {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [cam, setCam] = useState<CameraState>({ scale: 1, tx: 0, ty: 0 })
  const [panning, setPanning] = useState(false)
  // Once the user has zoomed/panned, window resizes stop silently re-fitting under them;
  // the explicit fit button (and a plan-footprint change) always re-fits.
  const touchedRef = useRef(false)
  const panRef = useRef<{ id: number; x: number; y: number } | null>(null)

  const fit = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    touchedRef.current = false
    setCam(fitCamera(r.width, r.height, contentW, contentH))
  }, [contentW, contentH])

  useEffect(() => { fit() }, [fit, refitKey])

  useEffect(() => {
    const onResize = () => { if (!touchedRef.current) fit() }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fit])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      touchedRef.current = true
      setCam(c => zoomAt(c, e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    if ((e.target as Element).closest?.(interactiveSel)) return
    panRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setPanning(true)
    touchedRef.current = true
  }, [interactiveSel])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current
    if (!p || p.id !== e.pointerId) return
    const dx = e.clientX - p.x
    const dy = e.clientY - p.y
    panRef.current = { id: p.id, x: e.clientX, y: e.clientY }
    setCam(c => ({ ...c, tx: c.tx + dx, ty: c.ty + dy }))
  }, [])

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.id !== e.pointerId) return
    panRef.current = null
    setPanning(false)
  }, [])

  return {
    containerRef,
    cameraStyle: {
      position: 'absolute', left: 0, top: 0, width: contentW, height: contentH,
      transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.scale})`,
      transformOrigin: '0 0', willChange: 'transform',
    },
    panning,
    fit,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
