// src/app/world/AzSimOverlay.tsx
// Canvas overlay for the focused AZ: draws live particles from the engine's per-frame
// attachRenderer payload along the same chassis/managed-node positions AzCanvas lays out.
// Read-only, pointer-events: none — all real interaction stays on the ReactFlow pane underneath.
//
// v2 (Phase 4 D9): chassis are React Flow CHILD nodes (parentId + extent:'parent'), so a
// plain node.position is parent-relative, not absolute — getInternalNode(id)
// .internals.positionAbsolute resolves the real canvas position for both parented and
// top-level nodes. Node footprint comes from React Flow's own measured DOM size
// (node.measured) once painted; the old fixed constants are kept ONLY as a pre-paint
// fallback (chassis heights vary 1U/2U, unlike the old flat cards — this fallback is a
// coarse, brief-window guess, not a second source of truth). getViewport() is read
// imperatively inside the frame callback instead of subscribing to useViewport(), so
// panning/zooming the canvas no longer re-runs this effect (no re-attach churn) —
// getInternalNode/getViewport are both referentially stable across re-renders (verified
// against @xyflow/react's source: each is produced inside a `useMemo(..., [])`-style
// memo), so including them in the deps array below is correct and never itself
// retriggers the effect.
import { useEffect, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { VisualParticle } from '../../lib/worldEngine/types'

// Pre-paint fallback footprint only — real dimensions come from node.measured once React
// Flow has laid the DOM out. Deliberately NOT U-height-aware (see file header).
const SERVER_W = 220, SERVER_H = 96
const MANAGED_W = 170, MANAGED_H = 60

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

interface Props { azId: string }

export function AzSimOverlay({ azId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { getInternalNode, getViewport } = useReactFlow()
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)

  // Keep the canvas's pixel buffer matched to its container — avoids CSS-stretch distortion,
  // which would otherwise throw off the screen-space math below.
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const resize = () => { canvas.width = parent.clientWidth; canvas.height = parent.clientHeight }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }

    const detach = useSimulationStore.getState().attachRenderer({ level: 'az', azId }, (payload) => {
      // Reduced-motion: throttle redraws to ~2/sec (still shows real, current state, just not
      // smooth motion) rather than fully suppressing the visualization — this canvas IS the
      // simulation's primary information channel here, not decorative chrome.
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Read the viewport imperatively, once per frame — NOT via the useViewport() hook,
      // which would re-run this whole effect (and re-attach the renderer) on every
      // pan/zoom tick (D9).
      const viewport = getViewport()

      const toScreen = (id: string, fallback: { x: number; y: number }) => {
        if (id.startsWith('edge:')) return { x: -40 * viewport.zoom + viewport.x, y: fallback.y }
        const node = getInternalNode(id)
        if (!node) return fallback
        const w = node.measured?.width ?? (node.type === 'worldManaged' ? MANAGED_W : SERVER_W)
        const hgt = node.measured?.height ?? (node.type === 'worldManaged' ? MANAGED_H : SERVER_H)
        const abs = node.internals.positionAbsolute
        return {
          x: (abs.x + w / 2) * viewport.zoom + viewport.x,
          y: (abs.y + hgt / 2) * viewport.zoom + viewport.y,
        }
      }

      for (const p of payload.particles) {
        const to = toScreen(p.toId, { x: canvas.width / 2, y: canvas.height / 2 })
        const from = toScreen(p.fromId, to)
        const x = from.x + (to.x - from.x) * p.progress
        const y = from.y + (to.y - from.y) * p.progress

        if (p.blocked && p.progress > 0.85) {
          const burst = (p.progress - 0.85) / 0.15
          ctx.beginPath()
          ctx.arc(to.x, to.y, 4 + burst * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239, 68, 68, ${1 - burst})`   // var(--color-danger) #EF4444
          ctx.lineWidth = 2
          ctx.stroke()
          continue
        }

        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]
        ctx.fill()
      }
    })

    return detach
  }, [running, azId, reduced, getInternalNode, getViewport])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
