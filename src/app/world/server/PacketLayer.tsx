// src/app/world/server/PacketLayer.tsx
// Canvas over the (unscaled) 1000x560 stage — lives INSIDE the scaled stage div so logical coords
// need no conversion. Attaches the server renderer once per (serverId, running, layout); draws via
// refs. Particle position = point at `progress` along layout.tracePath, resolved with a cached
// hidden SVG path per unique pair — the cache is a local Map rebuilt on every effect attach (not a
// persistent ref), so a layout reflow (chip positions change) can't leave stale-geometry paths
// behind. Blocked bursts render at the gate (nic origin) or target anchor (D6).
import { useEffect, useRef, type ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../../store/simulation.store'
import type { BoardLayout } from './boardLayout'
import type { VisualParticle } from '../../../lib/worldEngine/types'

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

export interface PacketLayerProps { serverId: string; layout: BoardLayout }

export function PacketLayer({ serverId, layout }: PacketLayerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }
    // Recreated on every effect attach (i.e. whenever `layout` changes, since it's a dep below) —
    // a persistent cache across layout changes would keep drawing at stale (pre-reflow) geometry.
    const pathCache = new Map<string, SVGPathElement>()
    const svgNS = 'http://www.w3.org/2000/svg'
    // D10e (Phase-3 carry-forward): getPointAtLength (and, defensively, getTotalLength) can throw
    // in some native WebView SVG implementations — never verified against an actual native Tauri
    // build (documented Phase-3 open item). A thrown geometry call must never crash the frame
    // loop; fall back to a straight-line lerp between the trace's two cached anchors — visually
    // close enough for a single degraded frame, and cheap (anchorFor is a plain lookup).
    const pointAt = (fromId: string, toId: string, progress: number): { x: number; y: number } | null => {
      const key = `${fromId}→${toId}`
      let path = pathCache.get(key)
      if (!path) {
        const d = layout.tracePath(fromId, toId)
        if (!d) return null
        path = document.createElementNS(svgNS, 'path')
        path.setAttribute('d', d)
        pathCache.set(key, path)
      }
      try {
        const len = path.getTotalLength?.() ?? 0
        if (!len) return null
        return path.getPointAtLength(len * progress)
      } catch {
        const a = layout.anchorFor(fromId)
        const b = layout.anchorFor(toId)
        if (!a || !b) return null
        return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress }
      }
    }
    const detach = useSimulationStore.getState().attachRenderer({ level: 'server', serverId }, payload => {
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const p of payload.particles) {
        if (p.blocked && p.progress > 0.85) {
          const burstAt = p.fromId.startsWith('nic:') ? layout.gate.inAnchor : layout.anchorFor(p.toId)
          if (!burstAt) continue
          const t = (p.progress - 0.85) / 0.15
          ctx.beginPath(); ctx.arc(burstAt.x, burstAt.y, 4 + t * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239,68,68,${1 - t})`; ctx.lineWidth = 2; ctx.stroke()
          continue
        }
        const pt = pointAt(p.fromId, p.toId, p.progress)
        if (!pt) continue
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.6, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]; ctx.fill()
      }
    })
    return detach
  }, [running, serverId, layout, reduced])

  return <canvas ref={canvasRef} width={layout.stageW} height={layout.stageH}
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}
