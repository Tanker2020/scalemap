// src/app/world/AzSimOverlay.tsx
// Canvas overlay for the focused AZ: draws live particles from the engine's per-frame
// attachRenderer payload along the same server-pair positions AzCanvas lays its nodes out at.
// Read-only, pointer-events: none — all real interaction stays on the ReactFlow pane underneath.
import { useEffect, useRef } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { VisualParticle } from '../../lib/worldEngine/types'

// Approximate on-screen footprint of WorldServerNode/WorldManagedNode. React Flow only reports
// *measured* dimensions once a node has actually painted; this overlay must be able to draw on
// frame 1, so a fixed approximation is used instead of waiting on measurement. Good enough for a
// Phase-2 "minimal, contracts-shaped" overlay — Phase 4/5 can read real measured dimensions.
const SERVER_W = 220, SERVER_H = 96
const MANAGED_W = 170, MANAGED_H = 60

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

interface Props { azId: string }

export function AzSimOverlay({ azId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { getNode } = useReactFlow()
  const viewport = useViewport()
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

      const toScreen = (id: string, fallback: { x: number; y: number }) => {
        if (id.startsWith('edge:')) return { x: -40 * viewport.zoom + viewport.x, y: fallback.y }
        const node = getNode(id)
        if (!node) return fallback
        const w = node.type === 'worldManaged' ? MANAGED_W : SERVER_W
        const h = node.type === 'worldManaged' ? MANAGED_H : SERVER_H
        return {
          x: (node.position.x + w / 2) * viewport.zoom + viewport.x,
          y: (node.position.y + h / 2) * viewport.zoom + viewport.y,
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
  }, [running, azId, getNode, viewport, reduced])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
