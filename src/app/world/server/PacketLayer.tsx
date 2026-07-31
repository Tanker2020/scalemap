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
import { useUiStore } from '../../store/ui.store'
import { CATEGORY_COLORS } from '../../../lib/theme'
import type { BoardLayout } from './boardLayout'
import type { VisualParticle } from '../../../lib/worldEngine/types'

// Audit ISSUE-016: this is a <canvas> 2D context, so `ctx.fillStyle` needs a resolved literal
// color, not a `var(--color-*)` reference — a canvas can't read CSS custom properties. The
// codebase's existing idiom for exactly this situation (JS/canvas code needing a resolved,
// theme-aware color) is CATEGORY_COLORS from theme.ts, branched on ui.store's themeMode — the same
// pattern azFloorStyles.ts/ServerFaceplate.tsx already use. Four hardcoded dark-tuned hexes here
// violated the design-system law and rendered the wrong hue in light mode. Mapped by the same
// category grouping the design system already uses (http -> compute, db -> storage, event ->
// messaging, stream -> network).
const PROTOCOL_CATEGORY: Record<VisualParticle['protocol'], keyof typeof CATEGORY_COLORS> = {
  http: 'compute', db: 'storage', event: 'messaging', stream: 'network',
}
function protocolColor(protocol: VisualParticle['protocol'], themeMode: 'dark' | 'light'): string {
  const cat = CATEGORY_COLORS[PROTOCOL_CATEGORY[protocol]]
  return themeMode === 'light' ? cat.foreground.light : cat.accent
}

export interface PacketLayerProps { serverId: string; layout: BoardLayout }

export function PacketLayer({ serverId, layout }: PacketLayerProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const running = useSimulationStore(s => s.running)
  const themeMode = useUiStore(s => s.themeMode)
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
    // Caches BOTH the path element and its total length (audit ISSUE-016): `layout.tracePath`'s
    // geometry is immutable for the lifetime of this effect (only `layout` itself changing
    // re-attaches it), so `getTotalLength()` is exactly as loop-invariant as the path element — but
    // only the element was cached before, so every particle on every frame re-computed the same
    // length via an SVG geometry call, not a cheap property read.
    const pathCache = new Map<string, { path: SVGPathElement; len: number }>()
    const svgNS = 'http://www.w3.org/2000/svg'
    // D10e (Phase-3 carry-forward): getPointAtLength (and, defensively, getTotalLength) can throw
    // in some native WebView SVG implementations — never verified against an actual native Tauri
    // build (documented Phase-3 open item). A thrown geometry call must never crash the frame
    // loop; fall back to a straight-line lerp between the trace's two cached anchors — visually
    // close enough for a single degraded frame, and cheap (anchorFor is a plain lookup).
    const pointAt = (fromId: string, toId: string, progress: number): { x: number; y: number } | null => {
      const key = `${fromId}→${toId}`
      try {
        let cached = pathCache.get(key)
        if (!cached) {
          const d = layout.tracePath(fromId, toId)
          if (!d) return null
          const path = document.createElementNS(svgNS, 'path')
          path.setAttribute('d', d)
          // getTotalLength is as loop-invariant as the path element itself (same immutable
          // geometry) — computed once here, at cache-population time, not per particle per frame.
          const len = path.getTotalLength?.() ?? 0
          cached = { path, len }
          pathCache.set(key, cached)
        }
        if (!cached.len) return null
        return cached.path.getPointAtLength(cached.len * progress)
      } catch {
        // Defensively covers BOTH getTotalLength and getPointAtLength throwing (D10e) — never
        // verified against an actual native Tauri WebView SVG implementation.
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
        ctx.fillStyle = p.colorHint ?? protocolColor(p.protocol, themeMode); ctx.fill()
      }
    })
    return detach
  }, [running, serverId, layout, reduced, themeMode])

  return <canvas ref={canvasRef} width={layout.stageW} height={layout.stageH}
    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
}
