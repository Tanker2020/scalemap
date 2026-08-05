// src/app/world/az/RackCabinet.tsx
// One rack cabinet on the datacenter floor (mockup `g.rack3`): a 3-face isometric box (front/
// side/top, gradient-filled, hover lift + under-glow halo) whose visible height grows with
// occupancy (`usedU`) up to `capacityU` — "renders exactly its contents" per the mockup's
// caption — with one thin slat per resident server (LED strip from `floorData.ledParams`,
// health-tinted). Each slat is its own `RackSlot`: tap selects, hold drills into the server
// (`useHoldTap`, reusing `ui/HoldToEnter`'s primitives). A newly-added resident (tracked by
// `DatacenterFloor`'s seen-ids ref) mounts with the mockup's `rackin`/`bootled` boot cascade.
// `animatedLedIds` (T8 motion-budget sweep): LED blink used to be gated on nothing but
// `lit > 0`/reduced-motion, so an AZ full of active servers could blink every slat at once —
// unbounded by D1's ≤8-concurrent budget. `DatacenterFloor.tsx` now ranks every AZ server by
// cpuMean and passes down the top `MAX_ANIMATED_LEDS`; a slat outside that set still shows its
// lit color, just statically (see `FreePoolPod.tsx`'s matching free-pool-side comment).
import { type ReactElement } from 'react'
import { isoBox, isoSlat, type IsoBox } from './iso'
import { serverHeightU } from '../../../lib/world/rackModel'
import { ledParams, meanUtilization } from './floorData'
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

const HEALTH_STROKE: Record<HealthState, string> = {
  healthy: '#2b3342', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
const LED_COLOR: Record<'success' | 'warning' | 'danger', string> = {
  success: 'var(--color-success)', warning: 'var(--color-warning)', danger: 'var(--color-danger)',
}

// FEAT-004: the floor's mirror of ServiceChip's live hit-ratio readout — see DatacenterFloor.tsx's
// cacheByServer comment for why "first cache instance on this server" is representative.
export interface CacheHitInfo { ratio: number; warming: boolean }

// FEAT-005 (Task 15): the floor's mirror of ServiceChip's live replication-lag readout — same
// "first resolvable instance on this server" representativeness call as CacheHitInfo above.
export interface ReplicaLagInfo { lagSec: number; overRpo: boolean }

interface RackSlotProps {
  server: Server
  box: IsoBox
  yTop: number
  yBottom: number
  cpuMean: number
  health: HealthState
  accents: readonly string[]   // resident blueprints' signature colors (≤3) — per-slat identity
  cacheHit: CacheHitInfo | null
  replicaLag: ReplicaLagInfo | null
  // FEAT-007 (Task 8): live cold-start ramp (0..1), or null once warm/absent. See
  // DatacenterFloor.tsx's warmthByServer comment for the "first resolvable instance is
  // representative" convention this mirrors from cacheHit/replicaLag.
  warmth: number | null
  selected: boolean
  isNew: boolean
  animatedLed: boolean
  reducedMotion: boolean
  onSelect: (id: ServerId) => void
  onEnter: (id: ServerId) => void
}

function RackSlot({
  server, box, yTop, yBottom, cpuMean, health, accents, cacheHit, replicaLag, warmth, selected, isNew, animatedLed, reducedMotion, onSelect, onEnter,
}: RackSlotProps): ReactElement {
  const { handlers, progressRef } = useHoldTap(() => onSelect(server.id), () => onEnter(server.id))
  const { poly: slatPoly, led } = isoSlat(box, yTop, yBottom)
  const { lit, color } = ledParams(cpuMean)
  // FEAT-007 (Task 8): a warming resident gets a distinct LED — neither the ordinary cpu-driven
  // success/warning/danger read, nor the steady 'down' red — a color-mix ramp from amber toward
  // the normal success color as warmth climbs to 1, matching ServiceChip's fill-bar treatment.
  const ledColor = health === 'down' ? 'var(--color-danger)'
    : warmth != null ? `color-mix(in srgb, var(--color-warning) ${Math.round((1 - warmth) * 100)}%, var(--color-success) ${Math.round(warmth * 100)}%)`
      : LED_COLOR[color]
  const blinking = lit > 0 && animatedLed && !reducedMotion
  const labelY = box.roofSW.y + (yTop + yBottom) / 2 + ((yBottom - yTop) * 0.24) / 2
  const cacheTitle = cacheHit ? ` · ⌬ ${Math.round(cacheHit.ratio * 100)}% hit${cacheHit.warming ? ' (warming)' : ''}` : ''
  const lagTitle = replicaLag ? ` · ⏎ ${replicaLag.lagSec.toFixed(1)}s lag${replicaLag.overRpo ? ' (over RPO)' : ''}` : ''
  const warmthTitle = warmth != null ? ` · ⚡ ${Math.round(warmth * 100)}% warm` : ''
  const readoutOffset = (cacheHit ? 30 : 0) + (replicaLag ? 30 : 0)

  return (
    <g
      className={`az-slat${isNew ? ' az-newslot go' : ''}`}
      data-testid={`rack-slot-${server.id}`}
      data-selected={selected ? 'true' : undefined}
      style={{ cursor: 'pointer' }}
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerLeave={handlers.onPointerLeave}
    >
      <title>{server.label} · {server.kind} · {health} · {Math.round(cpuMean * 100)}% cpu{cacheTitle}{lagTitle}{warmthTitle}</title>
      <polygon
        points={slatPoly}
        fill={selected ? 'color-mix(in srgb, var(--color-accent) 22%, #0e1116)' : '#0e1116'}
        stroke={selected ? 'var(--color-accent)' : '#232a36'}
        strokeWidth={selected ? 1.5 : 1}
      />
      {/* per-server identity on the faceplate: label + resident-blueprint ticks (user request
          2026-07-11 — slats were anonymous identical strips) */}
      <text
        data-testid="slat-label"
        x={box.roofSW.x + 7} y={labelY} fontSize={6.5}
        fill="var(--color-text-secondary)" style={{ font: '6.5px var(--font-mono)', pointerEvents: 'none' }}
      >
        {server.label.length > 10 ? `${server.label.slice(0, 9)}…` : server.label}
      </text>
      {accents.slice(0, 3).map((c, i) => (
        <rect
          key={i} data-testid="slat-accent-tick"
          x={box.roofSW.x + 7 + i * 8} y={labelY + 3} width={5} height={2.5} rx={1}
          fill={c} opacity={0.9}
        />
      ))}
      {cacheHit && (
        // Same row as the accent ticks (not a new line — a 1-2U slat has no vertical room to
        // spare), offset past the ticks' max 3×8px span so the two never overlap.
        <text
          data-testid="rack-cache-hit" x={box.roofSW.x + 34} y={labelY + 5} fontSize={6}
          fill={cacheHit.warming ? 'var(--color-warning)' : 'var(--color-success)'}
          opacity={cacheHit.warming ? 0.8 : 1}
          style={{ font: '6px var(--font-mono)', pointerEvents: 'none' }}
        >
          ⌬ {Math.round(cacheHit.ratio * 100)}%
        </text>
      )}
      {replicaLag && (
        // Offset past the cache readout's span (rare same-server overlap of a cache instance AND
        // a db replica) so the two never draw on top of each other; when cache is absent this
        // just reoccupies the same slot cache would have used.
        <text
          data-testid="rack-replica-lag" x={box.roofSW.x + 34 + (cacheHit ? 30 : 0)} y={labelY + 5} fontSize={6}
          fill={replicaLag.overRpo ? 'var(--color-danger)' : 'var(--color-text-secondary)'}
          style={{ font: '6px var(--font-mono)', pointerEvents: 'none' }}
        >
          ⏎ {replicaLag.lagSec.toFixed(1)}s
        </text>
      )}
      {warmth != null && (
        // Offset past any cache/lag readouts already occupying this row — same tiebreak those
        // two use against each other.
        <text
          data-testid="rack-warmth" x={box.roofSW.x + 34 + readoutOffset} y={labelY + 5} fontSize={6}
          fill="var(--color-warning)"
          style={{ font: '6px var(--font-mono)', pointerEvents: 'none' }}
        >
          ⚡ {Math.round(warmth * 100)}%
        </text>
      )}
      <circle
        className={blinking ? 'az-led az-led-blink' : 'az-led'}
        cx={led.x} cy={led.y} r={2}
        fill={ledColor}
        style={blinking ? { animationDuration: `${2.1 + (yTop % 3)}s` } : undefined}
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
  accentsByServer: ReadonlyMap<ServerId, readonly string[]>   // resident-blueprint colors per server
  cacheByServer: ReadonlyMap<ServerId, CacheHitInfo>   // FEAT-004 live hit-ratio readout per server
  lagByServer: ReadonlyMap<ServerId, ReplicaLagInfo>   // FEAT-005 live replication-lag readout per server
  warmthByServer: ReadonlyMap<ServerId, number>   // FEAT-007 live cold-start ramp per server
  selectedServerId: ServerId | null
  newServerIds: ReadonlySet<ServerId>
  animatedLedIds: ReadonlySet<ServerId>
  reducedMotion: boolean
  onSelect: (id: ServerId) => void
  onEnter: (id: ServerId) => void
}

export function RackCabinet({
  rack, cell, cols, residents, usedU, batch, accentsByServer, cacheByServer, lagByServer, warmthByServer, selectedServerId, newServerIds, animatedLedIds, reducedMotion, onSelect, onEnter,
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
            cpuMean={meanUtilization(batch?.servers[server.id]?.coreUtilization)}
            health={batch?.servers[server.id]?.health ?? 'healthy'}
            accents={accentsByServer.get(server.id) ?? []}
            cacheHit={cacheByServer.get(server.id) ?? null}
            replicaLag={lagByServer.get(server.id) ?? null}
            warmth={warmthByServer.get(server.id) ?? null}
            selected={selectedServerId === server.id}
            isNew={newServerIds.has(server.id)}
            animatedLed={animatedLedIds.has(server.id)}
            reducedMotion={reducedMotion}
            onSelect={onSelect} onEnter={onEnter}
          />
        ))}
      </g>
    </g>
  )
}
