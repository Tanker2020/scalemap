// src/app/world/az/FreePoolPod.tsx
// A single free-pool (unracked) server on the datacenter floor (mockup `g.pod3` — "standalone
// pods on the same floor, the natural home for the vps/cloud mental model", per the mockup's own
// caption). Same 3-face isometric box + LED language as `RackCabinet`'s slats, just one pod =
// one whole box (no internal slat stack) and a smaller footprint. Same tap-select/hold-drill
// interaction (`useHoldTap`), same boot-cascade treatment when newly born via the toolbar.
import { type ReactElement } from 'react'
import { isoBox, isoSlat } from './iso'
import { ledParams } from './floorData'
import { useHoldTap } from './useHoldTap'
import { HoldRing } from '../ui/HoldToEnter'
import type { Server, ServerId } from '../../../lib/world/types'
import type { MetricsBatch, HealthState } from '../../../lib/worldEngine/types'

export const POD_HEIGHT_PX = 40
const POD_SCALE = 0.52

function mean(values?: number[]): number {
  if (!values || values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

const HEALTH_STROKE: Record<HealthState, string> = {
  healthy: '#2b3342', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
const LED_COLOR: Record<'success' | 'warning' | 'danger', string> = {
  success: 'var(--color-success)', warning: 'var(--color-warning)', danger: 'var(--color-danger)',
}

export interface FreePoolPodProps {
  server: Server
  cell: { x: number; y: number }
  cols: number
  batch: MetricsBatch | null
  selectedServerId: ServerId | null
  isNew: boolean
  reducedMotion: boolean
  onSelect: (id: ServerId) => void
  onEnter: (id: ServerId) => void
}

export function FreePoolPod({
  server, cell, cols, batch, selectedServerId, isNew, reducedMotion, onSelect, onEnter,
}: FreePoolPodProps): ReactElement {
  const { handlers, progressRef } = useHoldTap(() => onSelect(server.id), () => onEnter(server.id))
  const box = isoBox(cell.x, cell.y, cols, POD_HEIGHT_PX, POD_SCALE)
  const { led } = isoSlat(box, POD_HEIGHT_PX * 0.35, POD_HEIGHT_PX * 0.65)
  const cpuMean = mean(batch?.servers[server.id]?.coreUtilization)
  const { lit, color } = ledParams(cpuMean)
  const health = batch?.servers[server.id]?.health ?? 'healthy'
  const ledColor = health === 'down' ? 'var(--color-danger)' : LED_COLOR[color]
  const selected = selectedServerId === server.id

  return (
    <g
      className={`az-pod3${isNew ? ' az-newslot go' : ''}`}
      data-testid={`free-pod-${server.id}`}
      data-selected={selected ? 'true' : undefined}
      style={{ cursor: 'pointer' }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerLeave={handlers.onPointerLeave}
    >
      <title>{server.label} · free pool · {health} · {Math.round(cpuMean * 100)}% cpu</title>
      <polygon points={box.side} fill="url(#az-rackside)" stroke="#232b38" />
      <polygon
        className="az-podbody"
        points={box.front}
        fill="url(#az-rackfront)"
        stroke={selected ? 'var(--color-accent)' : HEALTH_STROKE[health]}
        strokeWidth={selected || health !== 'healthy' ? 1.6 : 1}
      />
      <polygon points={box.top} fill="url(#az-racktop)" stroke="#333d4d" />
      <circle
        className={lit > 0 && !reducedMotion ? 'az-led az-led-blink' : 'az-led'}
        cx={led.x} cy={led.y} r={2}
        fill={ledColor}
        style={lit > 0 && !reducedMotion ? { animationDuration: '2.9s' } : undefined}
      />
      <g transform={`translate(${led.x - 12},${led.y - 12})`}>
        <HoldRing progressRef={progressRef} size={24} />
      </g>
    </g>
  )
}
