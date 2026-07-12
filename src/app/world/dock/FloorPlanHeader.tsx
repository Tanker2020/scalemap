// src/app/world/dock/FloorPlanHeader.tsx
// Polish 4 T3 (spec D3/D5): the floor-plan instrument's signature header for AZ scope — a
// miniature, CLICKABLE isometric minimap of the SAME datacenter floor DatacenterFloor.tsx
// renders full-size. Reuses `layoutFloor` (`az/floorLayout.ts`) for the grid-cell PLAN — the one
// piece of layout math D5 says must not be re-derived (which rack/pod sits in which grid cell) —
// but projects that grid into its OWN small (~372×96) isometric pixel space rather than
// `az/iso.ts`'s fixed 900×430 one: `iso.ts`'s `tileToScreen`/`isoBox` are calibrated to the big
// floor's viewBox via module-level constants (not parametrized by width/height), so reusing them
// here would mean rendering at 900×430 and scale-transforming the whole SVG down — more
// indirection than writing the small equivalent directly. `floorLayout.ts`'s own header comment
// draws exactly this line: "the isometric projection ... is a separate, purely presentational
// concern" from the grid PLAN — the plan is shared, the pixel projection is this file's own.
//
// The minimap IS the selection surface (D5, ambiguity resolutions): a pod click selects that
// server directly; a cabinet click selects its lowest-`unit` resident. Both write the SAME
// shared `ui.store.selectedServerId` the floor itself reads/writes — selecting here also selects
// "out there" on the big floor, and (per `dock/scope.ts`'s `deriveScope`) flips the dock itself
// to the faceplate. Presentational only, per the T3 brief's ambiguity resolution — it does not
// try to keep itself mounted after a selection.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore } from '../../store/ui.store'
import { layoutFloor } from '../az/floorLayout'
import { scopedCost } from './scopeData'
import type { Rack, RackId, Server } from '../../../lib/world/types'
import './floorPlanStyles'

export interface FloorPlanHeaderProps { azId: string }

// ─── Dark-scene chrome (spec D3, InspectorRail precedent — the same carve-out AtlasHeader.tsx
// documents for the constellation header): the minimap keeps the mock's `#11150f`-family
// palette in BOTH themes, fixed local hex, never `var(--color-*)` — this is one of the app's
// three permanently-dark "instrument header" scenes, not a themed card. ──────────────────────
const MINIMAP_BG = 'radial-gradient(ellipse 70% 90% at 50% 110%, #14241a2b, transparent 70%), linear-gradient(180deg, #11150f 0%, #101318 90%)'
const MINIMAP_BORDER = '#2c3a2e'
const TILE_STROKE = '#1b2620'
const CAB_FILL = '#16202a'
const CAB_STROKE = '#2c3a44'
const POD_FILL = '#131c22'
const POD_STROKE = '#3fc7b866'
const LABEL_COLOR = '#64748B'    // DARK_COLORS.textMuted — the mock's --t3
const HEADLINE_COLOR = '#3FC7B8' // CATEGORY_COLORS.network.accent — the mock's --teal

const W = 372
const H = 96
const ORIGIN_X = W / 2
// ORIGIN_Y leaves clearance under the headline (absolute, top:8, ~14px tall) — the topmost grid
// diamond's peak sits at roughly ORIGIN_Y minus half a tile's height, so this needs real margin,
// not just the headline's own box.
const ORIGIN_Y = 40
const FLOOR_W = 300
const FLOOR_H = 46

function byLabelThenId(a: { label: string; id: string }, b: { label: string; id: string }): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

// A small dimetric grid->screen projection, structurally the same idea as `iso.ts`'s
// `tileToScreen` (recalibrated to this header's own 372×96 space, not the big floor's 900×430
// one — see the file header comment).
function tileCenter(cellX: number, cellY: number, cols: number): { x: number; y: number } {
  const halfW = FLOOR_W / cols / 2
  const halfH = FLOOR_H / cols / 2
  const gx = cellX + 0.5
  const gy = cellY + 0.5
  return { x: ORIGIN_X + (gx - gy) * halfW, y: ORIGIN_Y + (gx + gy) * halfH }
}

// One grid cell rendered as a single diamond (a standard isometric-tile silhouette) — the
// minimap draws ONE polygon per occupant (mirroring the locked mock's own `<polygon class="cab">
// .../<polygon class="pod">` DOM, which is flatter than the big floor's 3-face roof/front/side
// boxes; at 372×96 there isn't room for that much detail to read).
function cellPoly(cellX: number, cellY: number, cols: number, scale: number): string {
  const halfW = FLOOR_W / cols / 2
  const halfH = FLOOR_H / cols / 2
  const c = tileCenter(cellX, cellY, cols)
  const bw = halfW * scale
  const bh = halfH * scale
  return `${c.x},${c.y - bh} ${c.x + bw},${c.y} ${c.x},${c.y + bh} ${c.x - bw},${c.y}`
}

const headlineStyle: CSSProperties = {
  position: 'absolute', left: 12, top: 8, fontSize: 10, letterSpacing: '0.12em',
  color: HEADLINE_COLOR, textShadow: '0 1px 6px #000', fontVariantNumeric: 'tabular-nums',
}
const mlabelStyle: CSSProperties = { font: '8px var(--font-mono)', fill: LABEL_COLOR, pointerEvents: 'none' }

export function FloorPlanHeader({ azId }: FloorPlanHeaderProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const selectedServerId = useUiStore(s => s.selectedServerId)
  const setSelectedServerId = useUiStore(s => s.setSelectedServerId)

  const az = doc.azs[azId]
  const azLabel = az?.label ?? azId

  const azServers = Object.values(doc.servers).filter(s => s.azId === azId)
  const racks = Object.values(doc.racks).filter(r => r.azId === azId).sort(byLabelThenId)
  const rackedByRack: Record<RackId, Server[]> = {}
  for (const rack of racks) rackedByRack[rack.id] = []
  for (const s of azServers) {
    if (s.rack && rackedByRack[s.rack.rackId]) rackedByRack[s.rack.rackId].push(s)
  }
  for (const rackId of Object.keys(rackedByRack)) {
    rackedByRack[rackId].sort((a, b) => (a.rack!.unit - b.rack!.unit) || a.label.localeCompare(b.label))
  }
  const freePool = azServers.filter(s => s.rack === null).sort(byLabelThenId)
  const managedIds = Object.values(doc.managedServices)
    .filter(m => m.scope.kind === 'az' && m.scope.azId === azId)
    .map(m => m.id)

  const plan = layoutFloor(racks, rackedByRack, freePool, managedIds)

  // Cost/rps headline (D5): `scopedCost`'s az branch never reads `regionId`, so a possibly-empty
  // fallback here is harmless — kept only to satisfy DockScope's shape.
  const cost = scopedCost({ kind: 'az', regionId: az?.regionId ?? '', azId }, doc, batch?.world ?? null)
  const rps = Math.round(batch?.azs[azId]?.rps ?? 0)

  const selectCabinet = (rack: Rack) => {
    const lowest = rackedByRack[rack.id]?.[0]
    if (lowest) setSelectedServerId(lowest.id)
  }
  const selectPod = (server: Server) => setSelectedServerId(server.id)

  const firstPod = freePool[0]

  return (
    <div
      data-testid="floor-plan-header"
      style={{
        position: 'relative', height: H, borderRadius: 7, marginBottom: 8, overflow: 'hidden',
        background: MINIMAP_BG, border: `1px solid ${MINIMAP_BORDER}`,
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <g>
          {plan.tiles.map((t, i) => (
            <polygon key={i} points={cellPoly(t.x, t.y, plan.cols, 0.94)} fill="none" stroke={TILE_STROKE} opacity={0.6} />
          ))}
        </g>
        {racks.map(rack => {
          const cell = plan.cabinets[rack.id]
          if (!cell) return null
          const selected = (rackedByRack[rack.id] ?? []).some(s => s.id === selectedServerId)
          return (
            <polygon
              key={rack.id}
              data-testid="minimap-cab"
              className={`dockfp-cab${selected ? ' sel' : ''}`}
              points={cellPoly(cell.x, cell.y, plan.cols, 0.82)}
              fill={CAB_FILL} stroke={CAB_STROKE} strokeWidth={selected ? 1.5 : 1}
              onClick={() => selectCabinet(rack)}
            >
              <title>{rack.label}</title>
            </polygon>
          )
        })}
        {freePool.map(server => {
          const cell = plan.pods[server.id]
          if (!cell) return null
          const selected = server.id === selectedServerId
          return (
            <polygon
              key={server.id}
              data-testid="minimap-pod"
              className={`dockfp-pod${selected ? ' sel' : ''}`}
              points={cellPoly(cell.x, cell.y, plan.cols, 0.46)}
              fill={POD_FILL} stroke={POD_STROKE} strokeWidth={selected ? 1.5 : 1}
              onClick={() => selectPod(server)}
            >
              <title>{server.label}</title>
            </polygon>
          )
        })}
        {racks[0] && plan.cabinets[racks[0].id] && (() => {
          const c = tileCenter(plan.cabinets[racks[0].id].x, plan.cabinets[racks[0].id].y, plan.cols)
          return <text style={mlabelStyle} x={c.x - 16} y={c.y - 14}>{racks[0].label}</text>
        })()}
        {firstPod && plan.pods[firstPod.id] && (
          <text style={mlabelStyle}
            x={tileCenter(plan.pods[firstPod.id].x, plan.pods[firstPod.id].y, plan.cols).x - 16}
            y={tileCenter(plan.pods[firstPod.id].x, plan.pods[firstPod.id].y, plan.cols).y - 10}>
            free pool
          </text>
        )}
      </svg>
      <div data-testid="floor-plan-headline" style={headlineStyle}>
        {azLabel.toUpperCase()} · {rps} rps in · <span style={{ color: 'var(--color-price)' }}>${cost.monthlyUsd.toFixed(0)}/mo</span>
      </div>
    </div>
  )
}
