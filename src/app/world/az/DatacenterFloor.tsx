// src/app/world/az/DatacenterFloor.tsx
// The Level-3 AZ view (Polish 3 T4, spec D5, mockup `.iso3`): a DOM/SVG isometric datacenter
// floor replacing the React Flow AZ canvas. Composition root — reads doc/compiled/batch/nav,
// runs `layoutFloor`/`aggregateFlows` (both pure, `floorLayout.ts`/`floorData.ts`), and renders
// tiles + one `RackCabinet` per rack + one `FreePoolPod` per unracked server + a small appliance
// box per in-scope managed service, flow traces between them, and the toolbar (`+ server`/
// `+ rack`/`auto-arrange`, T2's rack actions). Owns `selectedServerId` (tap-to-select) and a
// seen-ids ref driving the boot-cascade animation for newly-added servers.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { layoutFloor } from './floorLayout'
import { aggregateFlows } from './floorData'
import { rackUsedU } from '../../../lib/world/rackModel'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { RackCabinet, cabinetHeightPx } from './RackCabinet'
import { FreePoolPod, POD_HEIGHT_PX } from './FreePoolPod'
import { InspectorV2 } from '../InspectorV2'
import { VIEW_W, VIEW_H, floorOutline, tileOutline, tileCenter, isoBox } from './iso'
import type { RackId, Server, ServerId } from '../../../lib/world/types'
import './azFloorStyles'

const TOP_ANIMATED = 8
const NEW_ANIMATION_MS = 2400
const APPLIANCE_HEIGHT_PX = 30
const EMPTY_SERVER_ID_SET: ReadonlySet<ServerId> = new Set()

function byLabelThenId(a: { label: string; id: string }, b: { label: string; id: string }): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

const btnStyle: CSSProperties = {
  font: '10px var(--font-mono)', background: '#10141bee', border: '1px solid var(--az-hud-dim)',
  color: 'var(--az-hud)', borderRadius: 5, padding: '4px 12px', cursor: 'pointer',
}
const lblStyle: CSSProperties = {
  position: 'absolute', font: '9px var(--font-mono)', color: 'var(--color-text-secondary)',
  background: '#0d1014e0', border: '1px solid #232a36', borderRadius: 4, padding: '1px 7px',
  pointerEvents: 'none', whiteSpace: 'nowrap',
}

export function DatacenterFloor() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const { regionId, azId, goServer } = useNavStore()
  const reducedMotion = useReducedMotion() ?? false

  const [selectedServerId, setSelectedServerId] = useState<ServerId | null>(null)
  useEffect(() => { setSelectedServerId(null) }, [azId])

  const [newIds, setNewIds] = useState<ReadonlySet<ServerId>>(new Set())
  const seenIdsRef = useRef<Set<ServerId> | null>(null)

  const azServers = useMemo(
    () => Object.values(doc.servers).filter(s => s.azId === azId),
    [doc.servers, azId],
  )
  const racks = useMemo(
    () => Object.values(doc.racks).filter(r => r.azId === azId).sort(byLabelThenId),
    [doc.racks, azId],
  )
  const rackedByRack = useMemo(() => {
    const m: Record<RackId, Server[]> = {}
    for (const rack of racks) m[rack.id] = []
    for (const s of azServers) {
      if (s.rack && m[s.rack.rackId]) m[s.rack.rackId].push(s)
    }
    for (const rackId of Object.keys(m)) {
      m[rackId].sort((a, b) => (a.rack!.unit - b.rack!.unit) || a.label.localeCompare(b.label))
    }
    return m
  }, [racks, azServers])
  const freePool = useMemo(
    () => azServers.filter(s => s.rack === null).sort(byLabelThenId),
    [azServers],
  )
  const managed = useMemo(() => Object.values(doc.managedServices).filter(m =>
    (m.scope.kind === 'az' && m.scope.azId === azId) ||
    (m.scope.kind === 'region' && m.scope.regionId === regionId)), [doc.managedServices, azId, regionId])
  const managedIds = useMemo(() => managed.map(m => m.id), [managed])
  const managedHere = useMemo(() => new Set(managedIds), [managedIds])

  const plan = useMemo(
    () => layoutFloor(racks, rackedByRack, freePool, managedIds),
    [racks, rackedByRack, freePool, managedIds],
  )

  // Boot-cascade detection: a server id present now but absent from the previously-seen set
  // mounts its slat/pod with the rackin/bootled animation (functional exception: skipped
  // entirely under reduced motion, per D1 — it just appears, instantly settled).
  const currentIds = useMemo(() => new Set(azServers.map(s => s.id)), [azServers])
  const currentIdsKey = useMemo(() => [...currentIds].sort().join(','), [currentIds])
  useEffect(() => {
    const seen = seenIdsRef.current
    if (seen === null) { seenIdsRef.current = currentIds; return }
    const added = [...currentIds].filter(id => !seen.has(id))
    seenIdsRef.current = currentIds
    if (added.length === 0) return
    setNewIds(prev => new Set([...prev, ...added]))
    const t = setTimeout(() => {
      setNewIds(prev => { const next = new Set(prev); for (const id of added) next.delete(id); return next })
    }, NEW_ANIMATION_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdsKey])

  const flows = useMemo(
    () => (azId ? aggregateFlows(compiled, azId, managedHere) : []),
    [compiled, azId, managedHere],
  )

  // Motion budget (spec D1): only the top 8 permitted flows BY SOURCE-SERVER RPS animate;
  // blocked flows are always static (red dash + reason label), regardless of rank.
  const rpsByServer = useMemo(() => {
    const m = new Map<ServerId, number>()
    for (const s of azServers) {
      const rps = Object.values(compiled.instances)
        .filter(i => i.serverId === s.id)
        .reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0)
      m.set(s.id, rps)
    }
    return m
  }, [azServers, compiled.instances, batch])

  const animatedKeys = useMemo(() => {
    const ranked = flows
      .filter(f => f.blocked === 0)
      .map(f => ({ key: `${f.source}->${f.target}`, rate: rpsByServer.get(f.source) ?? 0 }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, TOP_ANIMATED)
    return new Map(ranked.map(r => [r.key, r.rate]))
  }, [flows, rpsByServer])
  const maxAnimatedRate = Math.max(1, ...animatedKeys.values())

  if (!azId || !regionId) return null

  const az = doc.azs[azId]
  const azLabel = az?.label ?? azId
  const ingressRps = Math.round(batch?.azs[azId]?.rps ?? 0)

  // Anchor points for flow traces + labels — a stable "front-center" point on each box,
  // independent of internal slat count, so an edge never has to know which server occupies
  // which visible slat.
  const anchorFor = (target: string): { x: number; y: number } | null => {
    if (plan.cabinets[target]) {
      const c = plan.cabinets[target]
      const h = cabinetHeightPx(rackUsedU(doc, target))
      const box = isoBox(c.x, c.y, plan.cols, h)
      return { x: (box.roofSW.x + box.roofSE.x) / 2, y: (box.roofSW.y + box.roofSE.y) / 2 + h / 2 }
    }
    if (plan.pods[target]) {
      const c = plan.pods[target]
      const box = isoBox(c.x, c.y, plan.cols, POD_HEIGHT_PX, 0.52)
      return { x: (box.roofSW.x + box.roofSE.x) / 2, y: (box.roofSW.y + box.roofSE.y) / 2 + POD_HEIGHT_PX / 2 }
    }
    if (plan.appliances[target]) {
      const c = plan.appliances[target]
      const box = isoBox(c.x, c.y, plan.cols, APPLIANCE_HEIGHT_PX, 0.5)
      return { x: (box.roofSW.x + box.roofSE.x) / 2, y: (box.roofSW.y + box.roofSE.y) / 2 + APPLIANCE_HEIGHT_PX / 2 }
    }
    return null
  }

  const ghostCell = racks.length + freePool.length < plan.tiles.length
    ? plan.tiles[racks.length + freePool.length]
    : null

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', position: 'relative', background: 'var(--color-canvas)' }}>
      <div style={{ position: 'relative', minWidth: VIEW_W, height: VIEW_H + 56, padding: '0 0 56px' }}>
        <div style={{
          position: 'relative', minWidth: VIEW_W, height: VIEW_H, borderRadius: 10, overflow: 'hidden',
          background: 'radial-gradient(ellipse 70% 55% at 50% 66%, #121722 0%, #0b0d11 78%)',
        }}>
          <div style={{ position: 'absolute', left: 16, top: 12, font: '10px var(--font-mono)', letterSpacing: '0.15em', color: 'var(--az-hud)', textShadow: '0 0 9px var(--az-hud-dim)', zIndex: 5 }}>
            ▸ {azLabel.toUpperCase()} · FLOOR
          </div>
          <div style={{ position: 'absolute', left: 16, top: 30, font: '8.5px var(--font-mono)', color: 'var(--color-text-muted)', zIndex: 5 }}>
            {racks.length} rack{racks.length === 1 ? '' : 's'} · {azServers.length} server{azServers.length === 1 ? '' : 's'} · {ingressRps} rps entering
          </div>

          <svg width={VIEW_W} height={VIEW_H} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} style={{ position: 'absolute', inset: 0 }}>
            <defs>
              <radialGradient id="az-floorglow" cx="50%" cy="50%"><stop offset="0%" stopColor="#7cffe908" /><stop offset="100%" stopColor="transparent" /></radialGradient>
              <linearGradient id="az-rackfront" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#20262f" /><stop offset="100%" stopColor="#14181f" /></linearGradient>
              <linearGradient id="az-rackside" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#12161d" /><stop offset="100%" stopColor="#0d1015" /></linearGradient>
              <linearGradient id="az-racktop" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#2c3542" /><stop offset="100%" stopColor="#222a36" /></linearGradient>
            </defs>

            <g opacity={0.6}>
              <polygon points={floorOutline(plan.cols, plan.rows)} fill="#0f131b" stroke="#1a2130" />
              <g stroke="#161c28" strokeWidth={1}>
                {plan.tiles.map((t, i) => <polygon key={i} points={tileOutline(t.x, t.y, plan.cols)} fill="none" opacity={0.35} />)}
              </g>
              <ellipse cx={VIEW_W / 2} cy={VIEW_H * 0.63} rx={300} ry={120} fill="url(#az-floorglow)" />
            </g>

            {ghostCell && (
              <g
                className="az-ghost" data-testid="floor-ghost-slot"
                onClick={() => azId && useWorldStore.getState().addRack(azId)}
              >
                <polygon points={isoBox(ghostCell.x, ghostCell.y, plan.cols, 40).front} fill="none" stroke="#2a3140" strokeDasharray="5 5" />
                <polygon points={isoBox(ghostCell.x, ghostCell.y, plan.cols, 40).top} fill="none" stroke="#2a3140" strokeDasharray="5 5" />
              </g>
            )}

            {/* Flow traces — top 8 by source rps animate (dash speed ∝ rate); blocked flows are
                always static red dash + reason (never shimmer a refused path). */}
            {flows.map(f => {
              const key = `${f.source}->${f.target}`
              const from = anchorFor(f.source)
              const to = anchorFor(f.target)
              if (!from || !to) return null
              const blocked = f.blocked > 0
              const rate = animatedKeys.get(key)
              const animated = !blocked && rate !== undefined
              const dur = animated ? (0.5 + (1 - (rate as number) / maxAnimatedRate) * 1.1).toFixed(2) : undefined
              const d = `M${from.x},${from.y} L${to.x},${to.y}`
              return (
                <path
                  key={key}
                  data-testid={`flow-${key}`}
                  data-animated={animated ? 'true' : 'false'}
                  d={d}
                  fill="none"
                  stroke={blocked ? 'var(--color-danger)' : 'var(--color-accent)'}
                  strokeWidth={blocked ? 2 : 1.8}
                  strokeDasharray={blocked ? '5 4' : '7 8'}
                  className={animated ? 'az-trace-animated' : undefined}
                  style={animated ? { animationDuration: `${dur}s` } : undefined}
                  opacity={blocked ? 0.85 : 0.75}
                />
              )
            })}

            {racks.map(rack => {
              const cell = plan.cabinets[rack.id]
              if (!cell) return null
              return (
                <RackCabinet
                  key={rack.id} rack={rack} cell={cell} cols={plan.cols}
                  residents={rackedByRack[rack.id] ?? []}
                  usedU={rackUsedU(doc, rack.id)}
                  batch={batch}
                  selectedServerId={selectedServerId}
                  newServerIds={reducedMotion ? EMPTY_SERVER_ID_SET : newIds}
                  reducedMotion={reducedMotion}
                  onSelect={setSelectedServerId}
                  onEnter={id => regionId && azId && goServer(regionId, azId, id)}
                />
              )
            })}

            {freePool.map(server => {
              const cell = plan.pods[server.id]
              if (!cell) return null
              return (
                <FreePoolPod
                  key={server.id} server={server} cell={cell} cols={plan.cols}
                  batch={batch}
                  selectedServerId={selectedServerId}
                  isNew={newIds.has(server.id) && !reducedMotion}
                  reducedMotion={reducedMotion}
                  onSelect={setSelectedServerId}
                  onEnter={id => regionId && azId && goServer(regionId, azId, id)}
                />
              )
            })}

            {managed.map(m => {
              const cell = plan.appliances[m.id]
              if (!cell) return null
              const box = isoBox(cell.x, cell.y, plan.cols, APPLIANCE_HEIGHT_PX, 0.5)
              return (
                <g key={m.id} data-testid={`appliance-${m.id}`}>
                  <polygon points={box.side} fill="url(#az-rackside)" stroke="#232b38" />
                  <polygon points={box.front} fill="url(#az-rackfront)" stroke="var(--az-teal)" strokeDasharray="2 3" />
                  <polygon points={box.top} fill="url(#az-racktop)" stroke="#333d4d" />
                </g>
              )
            })}
          </svg>

          {/* Label layer — plain positioned divs as SVG siblings (mockup's own `.iso3 .lbl`
              shape); raw px matches the SVG's own unscaled viewBox 1:1. */}
          {racks.map(rack => {
            const cell = plan.cabinets[rack.id]
            if (!cell) return null
            const used = rackUsedU(doc, rack.id)
            const h = cabinetHeightPx(used)
            const box = isoBox(cell.x, cell.y, plan.cols, h)
            return (
              <div key={rack.id} style={{ ...lblStyle, left: box.roofSW.x - 18, top: box.roofSW.y - 20 }}>
                {rack.label} <small style={{ color: 'var(--color-text-muted)' }}>· {used}/{rack.capacityU}U</small>
              </div>
            )
          })}
          {managed.map(m => {
            const cell = plan.appliances[m.id]
            if (!cell) return null
            const c = tileCenter(cell.x, cell.y, plan.cols)
            return (
              <div key={m.id} style={{ ...lblStyle, left: c.x - 20, top: c.y + 16, color: 'var(--az-teal)', borderColor: '#3fc7b83a' }}>
                {m.label} <small>· {m.nodeType}</small>
              </div>
            )
          })}
          {freePool.length > 0 && (() => {
            const c = tileCenter(plan.pods[freePool[0].id].x, plan.pods[freePool[0].id].y, plan.cols)
            return (
              <div style={{ ...lblStyle, left: c.x - 10, top: c.y + 30, color: 'var(--az-teal)', borderColor: '#3fc7b83a' }}>
                FREE POOL <small>· unracked</small>
              </div>
            )
          })()}
          {ghostCell && (
            <div
              style={{ ...lblStyle, left: tileCenter(ghostCell.x, ghostCell.y, plan.cols).x - 20, top: tileCenter(ghostCell.x, ghostCell.y, plan.cols).y + 8, cursor: 'pointer' }}
              onClick={() => azId && useWorldStore.getState().addRack(azId)}
            >
              + rack
            </div>
          )}
          {flows.map(f => {
            const key = `${f.source}->${f.target}`
            const from = anchorFor(f.source)
            const to = anchorFor(f.target)
            if (!from || !to) return null
            const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
            const blocked = f.blocked > 0
            return (
              <div
                key={`lbl-${key}`}
                style={{
                  ...lblStyle, left: mid.x - 14, top: mid.y - 10,
                  color: blocked ? 'var(--color-danger)' : 'var(--az-hud)',
                  borderColor: blocked ? undefined : '#2dd4bf3a',
                }}
              >
                {blocked ? `✕ ${f.reason}` : `${f.total} dep${f.total > 1 ? 's' : ''}`}
              </div>
            )
          })}
        </div>

        <div style={{ position: 'absolute', right: 16, bottom: 16, display: 'flex', gap: 8, zIndex: 6 }}>
          <button style={btnStyle} onClick={() => azId && useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)}>+ server</button>
          <button style={btnStyle} onClick={() => azId && useWorldStore.getState().addRack(azId)}>+ rack</button>
          <button style={btnStyle} onClick={() => azId && useWorldStore.getState().autoArrangeAz(azId)}>auto-arrange</button>
        </div>

        <InspectorV2
          azId={azId}
          selectedServerId={selectedServerId}
          onClearSelection={() => setSelectedServerId(null)}
        />
      </div>
    </div>
  )
}
