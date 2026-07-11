// src/app/world/az/RackCabinet.tsx
// One rack cabinet on the datacenter floor (mockup `g.rack3`): a 3-face isometric box (front/
// side/top, gradient-filled, hover lift + under-glow halo) whose visible height grows with
// occupancy (`usedU`) up to `capacityU` — "renders exactly its contents" per the mockup's
// caption — with one thin slat per resident server (LED strip from `floorData.ledParams`,
// health-tinted). Each slat is its own `RackSlot`: tap selects, hold drills into the server
// (`useHoldTap`, reusing `ui/HoldToEnter`'s primitives). A newly-added resident (tracked by
// `DatacenterFloor`'s seen-ids ref) mounts with the mockup's `rackin`/`bootled` boot cascade.
import { type ReactElement } from 'react'
import { isoBox, isoSlat, type IsoBox } from './iso'
import { serverHeightU } from '../../../lib/world/rackModel'
import { ledParams } from './floorData'
import { useHoldTap } from './useHoldTap'
import { HoldRing } from '../ui/HoldToEnter'
import type { Rack, Server, ServerId } from '../../../lib/world/types'
import type { MetricsBatch, HealthState } from '../../../lib/worldEngine/types'

export const SLOT_PX = 15
const SLOT_GAP = 3
const CAB_PAD = 9
export const MIN_DISPLAY_U = 1

export function cabinetHeightPx(usedU: number): number {
  return Math.max(MIN_DISPLAY_U, usedU) * (SLOT_PX + SLOT_GAP) + CAB_PAD * 2
}

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

interface RackSlotProps {
  server: Server
  box: IsoBox
  yTop: number
  yBottom: number
  cpuMean: number
  health: HealthState
  selected: boolean
  isNew: boolean
  reducedMotion: boolean
  onSelect: (id: ServerId) => void
  onEnter: (id: ServerId) => void
}

function RackSlot({
  server, box, yTop, yBottom, cpuMean, health, selected, isNew, reducedMotion, onSelect, onEnter,
}: RackSlotProps): ReactElement {
  const { handlers, progressRef } = useHoldTap(() => onSelect(server.id), () => onEnter(server.id))
  const { poly: slatPoly, led } = isoSlat(box, yTop, yBottom)
  const { lit, color } = ledParams(cpuMean)
  const ledColor = health === 'down' ? 'var(--color-danger)' : LED_COLOR[color]

  return (
    <g
      className={isNew ? 'az-newslot go' : undefined}
      data-testid={`rack-slot-${server.id}`}
      data-selected={selected ? 'true' : undefined}
      style={{ cursor: 'pointer' }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerLeave={handlers.onPointerLeave}
    >
      <title>{server.label} · {health} · {Math.round(cpuMean * 100)}% cpu</title>
      <polygon
        points={slatPoly}
        fill={selected ? 'color-mix(in srgb, var(--color-accent) 22%, #0e1116)' : '#0e1116'}
        stroke={selected ? 'var(--color-accent)' : '#232a36'}
        strokeWidth={selected ? 1.5 : 1}
      />
      <circle
        className={lit > 0 && !reducedMotion ? 'az-led az-led-blink' : 'az-led'}
        cx={led.x} cy={led.y} r={2}
        fill={ledColor}
        style={lit > 0 && !reducedMotion ? { animationDuration: `${2.1 + (yTop % 3)}s` } : undefined}
      />
      <g transform={`translate(${led.x - 12},${led.y - 12})`}>
        <HoldRing progressRef={progressRef} size={24} />
      </g>
    </g>
  )
}

export interface RackCabinetProps {
  rack: Rack
  cell: { x: number; y: number }
  cols: number
  residents: Server[]     // already sorted (label/id) by the caller
  usedU: number
  batch: MetricsBatch | null
  selectedServerId: ServerId | null
  newServerIds: ReadonlySet<ServerId>
  reducedMotion: boolean
  onSelect: (id: ServerId) => void
  onEnter: (id: ServerId) => void
}

export function RackCabinet({
  rack, cell, cols, residents, usedU, batch, selectedServerId, newServerIds, reducedMotion, onSelect, onEnter,
}: RackCabinetProps): ReactElement {
  const heightPx = cabinetHeightPx(usedU)
  const box = isoBox(cell.x, cell.y, cols, heightPx)
  const haloCx = (box.roofSW.x + box.roofSE.x) / 2
  const haloCy = box.floorSE.y - 6

  const HEALTH_RANK: Record<HealthState, number> = { healthy: 0, degraded: 1, down: 2 }
  const worstHealth: HealthState = residents.reduce<HealthState>((worst, s) => {
    const h = batch?.servers[s.id]?.health ?? 'healthy'
    return HEALTH_RANK[h] > HEALTH_RANK[worst] ? h : worst
  }, 'healthy')

  let cursorY = CAB_PAD
  const slots = residents.map(server => {
    const heightU = serverHeightU(server)
    const slatH = heightU * SLOT_PX + (heightU - 1) * SLOT_GAP
    const yTop = cursorY
    const yBottom = yTop + slatH
    cursorY = yBottom + SLOT_GAP
    return { server, yTop, yBottom }
  })

  return (
    <g className="az-rack3" data-testid={`rack-cabinet-${rack.id}`}>
      <ellipse className="az-halo" cx={haloCx} cy={haloCy} rx={heightPx * 0.55 + 26} ry={14} fill="#5b9cf61e" />
      <g className="az-lift">
        <polygon points={box.side} fill="url(#az-rackside)" stroke="#232b38" />
        <polygon points={box.front} fill="url(#az-rackfront)" stroke={HEALTH_STROKE[worstHealth]} strokeWidth={worstHealth === 'healthy' ? 1 : 1.6} />
        <polygon points={box.top} fill="url(#az-racktop)" stroke="#333d4d" />
        {slots.map(({ server, yTop, yBottom }) => (
          <RackSlot
            key={server.id}
            server={server} box={box} yTop={yTop} yBottom={yBottom}
            cpuMean={mean(batch?.servers[server.id]?.coreUtilization)}
            health={batch?.servers[server.id]?.health ?? 'healthy'}
            selected={selectedServerId === server.id}
            isNew={newServerIds.has(server.id)}
            reducedMotion={reducedMotion}
            onSelect={onSelect} onEnter={onEnter}
          />
        ))}
      </g>
    </g>
  )
}
