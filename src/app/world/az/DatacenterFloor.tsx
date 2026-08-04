// src/app/world/az/DatacenterFloor.tsx
// The Level-3 AZ view (Polish 3 T4, spec D5, mockup `.iso3`): a DOM/SVG isometric datacenter
// floor replacing the React Flow AZ canvas. Composition root — reads doc/compiled/batch/nav,
// runs `layoutFloor`/`aggregateFlows` (both pure, `floorLayout.ts`/`floorData.ts`), and renders
// tiles + one `RackCabinet` per rack + one `FreePoolPod` per unracked server + a small appliance
// box per in-scope managed service, flow traces between them, and the toolbar (`+ server`/
// `+ rack`/`auto-arrange`, T2's rack actions). `selectedServerId` (tap-to-select) is Polish 4
// T1-lifted into `ui.store` (spec D1) — "floor selection and dock scope are the SAME state";
// this component reads/writes the shared field instead of owning local state, so WorldPanel's
// scope derivation sees the same selection live. Also owns a seen-ids ref driving the
// boot-cascade animation for newly-added servers.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore, selectLive } from '../../store/simulation.store'
import { useUiStore } from '../../store/ui.store'
import { useCompiledWorld, instancesByServerFor } from '../useCompiledWorld'
import { layoutFloor } from './floorLayout'
import { aggregateFlows, internetIngress, meanUtilization, serverAccents } from './floorData'
import { placeLabels, estimateLabelSize, type LabelSpec, type Rect } from './labelLayout'
import { rackUsedU } from '../../../lib/world/rackModel'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { RackCabinet, cabinetHeightPx } from './RackCabinet'
import { FreePoolPod, POD_HEIGHT_PX } from './FreePoolPod'
import { InspectorV2 } from '../InspectorV2'
import { ChaosControl, isNonFatalFault, NON_FATAL_FAULT_ACCENT } from '../dock/ChaosControl'
import { useFloorCamera, INTERACTIVE_SEL } from './useFloorCamera'
import { VIEW_W, VIEW_H, floorOutline, tileOutline, tileCenter, isoBox, type IsoBox } from './iso'
// FEAT-002 Task 14: impairmentFor is a pure predicate (no engine-runtime deps), safe to import
// directly rather than reimplementing its forward/backward matching by hand.
import { impairmentFor } from '../../../lib/worldEngine/faults'
import type { AzId, RackId, RegionId, Server, ServerId, WorldDoc } from '../../../lib/world/types'
import type { PartitionFault } from '../../../lib/worldEngine/types'
import './azFloorStyles'

// Motion budget (D1, T8 sweep): the floor has TWO independent top-N-by-magnitude animated
// categories — flow traces and LED blink — so, mirroring region's own 5-primary/N-secondary
// split (`SourcesColumn`'s dot-streams + `SplitLines`'/`ReplicaRail`'s beam/rail), their caps
// are sized so the two SUM to the app-wide ≤8 concurrent-infinite-stroke budget (D1) rather than
// each independently claiming 8. Tightened from 8 in the T8 sweep, which also found LED blink
// (`RackCabinet`/`FreePoolPod`'s `az-led-blink`) had NO cap at all — every server with any cpu
// utilization got its own infinite blink, unbounded by AZ server count. Both are now ranked
// (traces by source-server rps, LEDs by cpuMean) and the loser of each ranking renders the same
// visual — a static etched trace, a steadily-lit LED — without the animation. See
// module-boundaries.md §R's motion-budget table.
const TOP_ANIMATED = 5
const MAX_ANIMATED_LEDS = 3
const NEW_ANIMATION_MS = 2400
const APPLIANCE_HEIGHT_PX = 30
const EMPTY_SERVER_ID_SET: ReadonlySet<ServerId> = new Set()

function byLabelThenId(a: { label: string; id: string }, b: { label: string; id: string }): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

// FEAT-002 (Task 14): resolve a flow's source/target into the SAME EndpointIds shape the
// engine's own buildImpairmentMemo (worldEngine/index.ts) builds for a CompiledPath, so the
// floor's flow traces agree with what the engine actually impairs — a `target` is either another
// server in this AZ or a managed service (whose scope contributes region/az ids but no serverId,
// exactly like the engine's own managed-service branch). Pure + exported for unit coverage
// without mounting the DOM/SVG component.
export function flowImpairment(
  doc: WorldDoc, azId: AzId, regionId: RegionId | null, source: ServerId, target: string,
  partitions: PartitionFault[],
): { blocked: boolean; lossFraction: number; delayMs: number } {
  if (partitions.length === 0) return { blocked: false, lossFraction: 0, delayMs: 0 }
  const fromIds = { serverId: source, azId, regionId: regionId ?? undefined }
  let toIds: { regionId?: string; azId?: string; serverId?: string }
  if (doc.servers[target]) {
    toIds = { serverId: target, azId, regionId: regionId ?? undefined }
  } else {
    const ms = doc.managedServices[target]
    toIds = ms?.scope.kind === 'region' ? { regionId: ms.scope.regionId }
      : ms?.scope.kind === 'az' ? { azId: ms.scope.azId, regionId: doc.azs[ms.scope.azId]?.regionId }
        : {}
  }
  return impairmentFor(fromIds, toIds, partitions)
}

const btnStyle: CSSProperties = {
  font: '10px var(--font-mono)', background: '#10141bee', border: '1px solid var(--az-hud-dim)',
  color: 'var(--az-hud)', borderRadius: 5, padding: '4px 12px', cursor: 'pointer',
}
const lockedBtnStyle: CSSProperties = { ...btnStyle, opacity: 0.35, cursor: 'default' }
const lblStyle: CSSProperties = {
  position: 'absolute', font: '9px var(--font-mono)', color: 'var(--color-text-secondary)',
  background: '#0d1014e0', border: '1px solid #232a36', borderRadius: 4, padding: '1px 7px',
  pointerEvents: 'none', whiteSpace: 'nowrap',
}

export function DatacenterFloor() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const healthOverrides = useSimulationStore(s => s.healthOverrides)
  const activeFaults = useSimulationStore(s => s.activeFaults)
  const partitions = useSimulationStore(s => s.partitions)
  // Flow traces + LED blink march only while the sim is actively ticking; a paused/ended/scrubbed
  // run freezes them (the batch stays non-zero, so a rate-only gate would keep marching).
  const live = useSimulationStore(selectLive)
  const { regionId, azId, goServer } = useNavStore()
  const reducedMotion = useReducedMotion() ?? false

  // Lifted to ui.store (Polish 4 T1, spec D1) — WorldShell.tsx now owns clearing this on any
  // nav.level/nav.azId change (one shared effect covering every nav path in and out of the
  // floor, superseding this component's old azId-keyed local reset).
  const selectedServerId = useUiStore(s => s.selectedServerId)
  const setSelectedServerId = useUiStore(s => s.setSelectedServerId)

  const [newIds, setNewIds] = useState<ReadonlySet<ServerId>>(new Set())
  const seenIdsRef = useRef<Set<ServerId> | null>(null)
  // A press that started on empty floor (candidate for click-to-deselect; null when the press
  // began on anything interactive). Cleared on release/cancel.
  const bgPressRef = useRef<{ x: number; y: number } | null>(null)

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

  // FEAT-002 (Task 14): per-flow partition impairment, keyed identically to the flow's own
  // `${source}->${target}` testid/key — presentation-only, computed off the store's authored
  // `partitions` list (never per animation frame).
  const flowImpairmentByKey = useMemo(() => {
    const m = new Map<string, { blocked: boolean; lossFraction: number; delayMs: number }>()
    if (!azId || partitions.length === 0) return m
    for (const f of flows) {
      m.set(`${f.source}->${f.target}`, flowImpairment(doc, azId, regionId, f.source, f.target, partitions))
    }
    return m
  }, [doc, azId, regionId, flows, partitions])

  // Internet ingress (user request 2026-07-12: "which server is receiving traffic from
  // outside?"): one edge per server hosting a public-port blueprint, drawn from the ISP box
  // (below) — allowed = teal line, firewalled-shut = the same red blocked treatment dep flows use.
  const ingress = useMemo(
    () => (azId ? internetIngress(doc, compiled, azId) : []),
    [doc, compiled, azId],
  )

  // Motion budget (spec D1, tightened 8→5 in the T8 sweep — see TOP_ANIMATED's comment above):
  // only the top-N permitted flows BY SOURCE-SERVER RPS animate; blocked flows are always static
  // (red dash + reason label), regardless of rank.
  const rpsByServer = useMemo(() => {
    // Audit ISSUE-029: index into the per-compiled instancesByServer map instead of re-scanning
    // the whole instance record per server per batch (O(servers × instances) every second).
    const byServer = instancesByServerFor(compiled)
    const m = new Map<ServerId, number>()
    for (const s of azServers) {
      const rps = (byServer.get(s.id) ?? [])
        .reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0)
      m.set(s.id, rps)
    }
    return m
  }, [azServers, compiled, batch])

  const animatedKeys = useMemo(() => {
    if (!live) return new Map<string, number>()   // frozen run → no marching traces
    const ranked = [
      ...flows
        .filter(f => f.blocked === 0)
        .map(f => ({ key: `${f.source}->${f.target}`, rate: rpsByServer.get(f.source) ?? 0 })),
      // Ingress lines compete for the SAME TOP_ANIMATED budget as dep flows — one ranking,
      // one cap (D1); an entry server carrying traffic is usually exactly what should march.
      ...ingress
        .filter(e => e.allowed)
        .map(e => ({ key: `inet->${e.serverId}`, rate: rpsByServer.get(e.serverId) ?? 0 })),
    ]
      // rate > 0: a 0-rps flow must never occupy an animated slot — pre-simulation the whole
      // floor sits static (dash speed = rate, D1; user report 2026-07-11 caught idle marching).
      .filter(f => f.rate > 0)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, TOP_ANIMATED)
    return new Map(ranked.map(r => [r.key, r.rate]))
  }, [flows, ingress, rpsByServer, live])
  const maxAnimatedRate = Math.max(1, ...animatedKeys.values())

  // Motion budget (D1, T8 sweep): rank every AZ server (racked or free-pool) by live cpuMean and
  // let only the top MAX_ANIMATED_LEDS blink — same "top-N by magnitude" shape as `animatedKeys`
  // above, just a separate, smaller budget line (see the MAX_ANIMATED_LEDS comment).
  const animatedLedIds = useMemo(() => {
    if (!live) return new Set<string>()   // frozen run → LEDs stop blinking
    const ranked = azServers
      .map(s => ({ id: s.id, cpuMean: meanUtilization(batch?.servers[s.id]?.coreUtilization) }))
      .filter(s => s.cpuMean > 0)
      .sort((a, b) => b.cpuMean - a.cpuMean)
      .slice(0, MAX_ANIMATED_LEDS)
    return new Set(ranked.map(r => r.id))
  }, [azServers, batch, live])

  // Per-server identity (user request 2026-07-11): each server's resident blueprints' signature
  // colors, rendered as faceplate ticks by RackSlot/FreePoolPod so no two servers hosting
  // different services look alike. Extracted to `serverAccents` (Polish 4 T3, floorData.ts) — a
  // behavior-identical pure-function move, now also consumed by the dock's FloorPlanHeader/
  // AzConfigTab (spec D5) so the floor and the dock never disagree on a server's color ticks.
  const accentsByServer = useMemo(() => serverAccents(doc, compiled), [compiled.instances, doc.blueprints])

  // FEAT-004: the floor's per-server mirror of ServiceChip's live hit-ratio readout — a server can
  // host at most one cache instance in every fixture this app authors today, so the first cache
  // instance found is representative; a future multi-cache server would just show the first one.
  // `warming` mirrors ServerBoard.tsx's own derivation (effective < the blueprint's steady-state
  // target), reading the SAME InstanceMetrics.cacheHitRatio the chip reads — never re-derived.
  const cacheByServer = useMemo(() => {
    const byServer = instancesByServerFor(compiled)
    const m = new Map<ServerId, { ratio: number; warming: boolean }>()
    for (const s of azServers) {
      for (const inst of byServer.get(s.id) ?? []) {
        const ratio = batch?.instances[inst.id]?.cacheHitRatio
        if (ratio == null) continue
        const target = doc.blueprints[inst.blueprintId]?.cacheConfig?.hitRatio
        m.set(s.id, { ratio, warming: target != null && ratio < target - 0.001 })
        break
      }
    }
    return m
  }, [azServers, compiled, batch, doc.blueprints])

  // Camera: fit-to-view on mount/plan growth, wheel zoom at the cursor, background drag-pan
  // (post-Polish-3 fix wave — the floor previously rendered fixed-size with no navigation).
  const camera = useFloorCamera(VIEW_W, VIEW_H, `${plan.cols}x${plan.rows}`)

  if (!azId || !regionId) return null

  const az = doc.azs[azId]
  const azLabel = az?.label ?? azId
  const ingressRps = Math.round(batch?.azs[azId]?.rps ?? 0)

  // Anchor points for flow traces + labels — a stable "front-center" point on each box,
  // independent of internal slat count, so an edge never has to know which server occupies
  // which visible slat.
  const anchorFor = (target: string): { x: number; y: number } | null => {
    // Flow/ingress endpoints are SERVER ids, but a racked server has no tile of its own —
    // plan.cabinets is keyed by RACK id and plan.pods only holds the free pool. Resolve a
    // racked server to its cabinet first, or every line into it silently vanished the moment
    // auto-arrange/assign moved it off the free pool (user report 2026-07-12).
    const rackId = doc.servers[target]?.rack?.rackId
    if (rackId && plan.cabinets[rackId]) target = rackId
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

  // ISP uplink cabinet (user requests 2026-07-12: "which server receives traffic from
  // outside" + "make the isp a custom object that looks pretty darn realistic"): a hand-rolled
  // mini isometric box — same 2:1 dimetric ratio as the tiles — fixed at the floor's empty
  // bottom-left corner, OUTSIDE the diamond, so outside traffic visibly enters the room from
  // off the floor. Front face carries a PWR/LINK/ACT status-LED row and an RJ45-ish uplink
  // port; a whip antenna tops the roof; a dashed street-feed line enters from screen-left.
  // Content coordinates (inside the camera transform), so it pans/zooms with the scene.
  const ISP = (() => {
    const bw = 30, bh = 15, hp = 36
    const fl = { x: 96, y: VIEW_H - 52 }   // front-left floor corner
    const roofSW = { x: fl.x, y: fl.y - hp }
    const roofSE = { x: roofSW.x + bw, y: roofSW.y + bh }
    const roofNE = { x: roofSE.x + bw, y: roofSE.y - bh }
    const roofNW = { x: roofSW.x + bw, y: roofSW.y - bh }
    const floorSE = { x: roofSE.x, y: roofSE.y + hp }
    const floorNE = { x: roofNE.x, y: roofNE.y + hp }
    const pts = (arr: { x: number; y: number }[]) => arr.map(pt => `${pt.x},${pt.y}`).join(' ')
    return {
      roofSW, roofSE, roofNE, roofNW, floorSE, floorNE, fl,
      front: pts([roofSW, roofSE, floorSE, fl]),
      side: pts([roofSE, roofNE, floorNE, floorSE]),
      top: pts([roofSW, roofSE, roofNE, roofNW]),
      anchor: { x: roofNE.x - 2, y: (roofNE.y + floorNE.y) / 2 },
      bounds: { x: fl.x - 6, y: roofNW.y - 32, w: bw * 2 + 12, h: hp + bh + 32 + 18 },
    }
  })()
  const inetAnchor = ISP.anchor
  const showInet = azServers.length > 0

  // ── Floating labels (user report 2026-07-12: names/badges overlapped boxes and each other):
  // every floating label anchors ABOVE its box's roofline, then labelLayout.ts pushes it
  // further up until it clears every box and every earlier label. Spec order = priority
  // (racks, pods, managed, section badge, dep/ingress chips — later entries yield). ──
  const boxRect = (box: IsoBox): Rect => ({
    x: box.roofSW.x, y: box.roofNW.y, w: box.roofNE.x - box.roofSW.x, h: box.floorSE.y - box.roofNW.y,
  })
  const obstacles: Rect[] = []
  const labelSpecs: LabelSpec[] = []
  for (const rack of racks) {
    const cell = plan.cabinets[rack.id]
    if (!cell) continue
    const box = isoBox(cell.x, cell.y, plan.cols, cabinetHeightPx(rackUsedU(doc, rack.id)))
    obstacles.push(boxRect(box))
    const { w, h } = estimateLabelSize(`${rack.label} · ${rackUsedU(doc, rack.id)}/${rack.capacityU}U`)
    labelSpecs.push({ id: `rack:${rack.id}`, x: tileCenter(cell.x, cell.y, plan.cols).x - w / 2, y: box.roofNW.y - h - 6, w, h })
  }
  for (const server of freePool) {
    const cell = plan.pods[server.id]
    if (!cell) continue
    const box = isoBox(cell.x, cell.y, plan.cols, POD_HEIGHT_PX, 0.52)
    obstacles.push(boxRect(box))
    const { w, h } = estimateLabelSize(server.label, 'text')
    labelSpecs.push({ id: `pod:${server.id}`, x: tileCenter(cell.x, cell.y, plan.cols).x - w / 2, y: box.roofNW.y - h - 5, w, h })
  }
  for (const m of managed) {
    const cell = plan.appliances[m.id]
    if (!cell) continue
    const box = isoBox(cell.x, cell.y, plan.cols, APPLIANCE_HEIGHT_PX, 0.5)
    obstacles.push(boxRect(box))
    const { w, h } = estimateLabelSize(`${m.label} · ${m.nodeType}`)
    labelSpecs.push({ id: `managed:${m.id}`, x: tileCenter(cell.x, cell.y, plan.cols).x - w / 2, y: box.roofNW.y - h - 6, w, h })
  }
  if (freePool.length > 0) {
    // Section badge anchors above the topmost pod; deconfliction stacks it over that pod's
    // own name label instead of letting it lie across a neighbor's face.
    const topPod = freePool.reduce((best, s) => {
      const c = plan.pods[s.id]
      const b = plan.pods[best.id]
      if (!c || !b) return best
      return isoBox(c.x, c.y, plan.cols, POD_HEIGHT_PX, 0.52).roofNW.y <
        isoBox(b.x, b.y, plan.cols, POD_HEIGHT_PX, 0.52).roofNW.y ? s : best
    }, freePool[0])
    const cell = plan.pods[topPod.id]
    if (cell) {
      const box = isoBox(cell.x, cell.y, plan.cols, POD_HEIGHT_PX, 0.52)
      const { w, h } = estimateLabelSize('FREE POOL · unracked')
      labelSpecs.push({ id: 'section:free-pool', x: tileCenter(cell.x, cell.y, plan.cols).x - w / 2, y: box.roofNW.y - h - 6, w, h })
    }
  }
  for (const f of flows) {
    const from = anchorFor(f.source)
    const to = anchorFor(f.target)
    if (!from || !to) continue
    if (from.x === to.x && from.y === to.y) continue   // same-cabinet pair — no line, no chip
    const partitioned = flowImpairmentByKey.get(`${f.source}->${f.target}`)?.blocked ?? false
    const text = f.blocked > 0 ? `✕ ${f.reason}` : partitioned ? '✕ partitioned' : `${f.total} dep${f.total > 1 ? 's' : ''}`
    const { w, h } = estimateLabelSize(text)
    labelSpecs.push({ id: `dep:${f.source}->${f.target}`, x: (from.x + to.x) / 2 - w / 2, y: (from.y + to.y) / 2 - h / 2, w, h })
  }
  for (const e of ingress) {
    if (e.allowed) continue   // allowed ingress: the line + ISP box ARE the label; only blocked warns
    const to = anchorFor(e.serverId)
    if (!to) continue
    const { w, h } = estimateLabelSize('✕ firewall')
    labelSpecs.push({ id: `inetlbl:${e.serverId}`, x: (inetAnchor.x + to.x) / 2 - w / 2, y: (inetAnchor.y + to.y) / 2 - h / 2, w, h })
  }
  if (showInet) obstacles.push(ISP.bounds)
  const placedLabels = placeLabels(labelSpecs, obstacles)

  return (
    <div
      ref={camera.containerRef}
      data-testid="floor-viewport"
      // Background press = potential pan AND potential deselect: if the pointer goes down on
      // empty floor (nothing INTERACTIVE_SEL matches) and comes up within the slop radius —
      // i.e. it never became a drag — clear the floor selection so the dock widens back to AZ
      // scope (user report 2026-07-12: "once I click a server I can't view the rack level
      // config again" — the scope-rail AZ pill already did this, but click-empty-floor is the
      // gesture everyone actually tries first).
      onPointerDown={(e) => {
        bgPressRef.current = e.button !== 0 || (e.target as Element).closest?.(INTERACTIVE_SEL)
          ? null : { x: e.clientX, y: e.clientY }
        camera.onPointerDown(e)
      }}
      onPointerMove={camera.onPointerMove}
      onPointerUp={(e) => {
        const press = bgPressRef.current
        bgPressRef.current = null
        if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5 && selectedServerId) {
          setSelectedServerId(null)
        }
        camera.onPointerUp(e)
      }}
      onPointerCancel={(e) => { bgPressRef.current = null; camera.onPointerUp(e) }}
      style={{
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative',
        background: 'radial-gradient(ellipse 70% 55% at 50% 66%, #121722 0%, #0b0d11 78%)',
        cursor: camera.panning ? 'grabbing' : 'grab', touchAction: 'none',
      }}
    >
      {/* Screen-space chrome (header, toolbar, inspector) sits OUTSIDE the camera transform. */}
      <div style={{ position: 'absolute', left: 16, top: 12, font: '10px var(--font-mono)', letterSpacing: '0.15em', color: 'var(--az-hud)', textShadow: '0 0 9px var(--az-hud-dim)', zIndex: 5, pointerEvents: 'none' }}>
        ▸ {azLabel.toUpperCase()} · FLOOR
      </div>
      <div style={{ position: 'absolute', left: 16, top: 30, font: '8.5px var(--font-mono)', color: 'var(--color-text-muted)', zIndex: 5, pointerEvents: 'none' }}>
        {racks.length} rack{racks.length === 1 ? '' : 's'} · {azServers.length} server{azServers.length === 1 ? '' : 's'} · {ingressRps} rps entering · scroll = zoom · drag = pan
      </div>

      <div style={camera.cameraStyle}>
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

            {ghostCell && !running && (
              <g
                className="az-ghost" data-testid="floor-ghost-slot"
                onClick={() => azId && useWorldStore.getState().addRack(azId)}
              >
                <polygon points={isoBox(ghostCell.x, ghostCell.y, plan.cols, 40).front} fill="none" stroke="#2a3140" strokeDasharray="5 5" />
                <polygon points={isoBox(ghostCell.x, ghostCell.y, plan.cols, 40).top} fill="none" stroke="#2a3140" strokeDasharray="5 5" />
              </g>
            )}

            {/* Flow traces — top 5 by source rps animate (dash speed ∝ rate); blocked flows are
                always static red dash + reason (never shimmer a refused path). FEAT-002 (Task
                14): a `drop` partition on this source->target link renders the SAME static
                red-dash treatment as a firewall block (both mean "can't get through") but is
                marked `data-partitioned` so it's distinguishable in tests/inspection; a `loss`
                partition stipples a still-open link with a tighter dash, no color change. */}
            {flows.map(f => {
              const key = `${f.source}->${f.target}`
              const from = anchorFor(f.source)
              const to = anchorFor(f.target)
              if (!from || !to) return null
              // Both endpoints racked in the same cabinet resolve to one anchor — no line to draw.
              if (from.x === to.x && from.y === to.y) return null
              const impairment = flowImpairmentByKey.get(key)
              const partitioned = impairment?.blocked ?? false
              const lossy = !partitioned && (impairment?.lossFraction ?? 0) > 0
              const blocked = f.blocked > 0 || partitioned
              const rate = animatedKeys.get(key)
              const animated = !blocked && rate !== undefined
              const dur = animated ? (0.5 + (1 - (rate as number) / maxAnimatedRate) * 1.1).toFixed(2) : undefined
              const d = `M${from.x},${from.y} L${to.x},${to.y}`
              return (
                <path
                  key={key}
                  data-testid={`flow-${key}`}
                  data-animated={animated ? 'true' : 'false'}
                  data-partitioned={partitioned ? 'true' : 'false'}
                  d={d}
                  fill="none"
                  stroke={blocked ? 'var(--color-danger)' : 'var(--color-accent)'}
                  strokeWidth={blocked ? 2 : 1.8}
                  strokeDasharray={blocked ? '5 4' : lossy ? '3 6' : '7 8'}
                  className={animated ? 'az-trace-animated' : undefined}
                  style={animated ? { animationDuration: `${dur}s` } : undefined}
                  opacity={blocked ? 0.85 : lossy ? 0.5 : 0.75}
                />
              )
            })}

            {/* Internet ingress: ISP cabinet → every public-entry server (allowed = teal,
                marching under the same TOP_ANIMATED budget when carrying rps; firewalled-shut =
                the blocked red treatment). Drawn with the flows so lines pass UNDER the boxes. */}
            {showInet && (
              <g data-testid="inet-box">
                {/* street feed entering from off-floor (screen-left) */}
                <path
                  d={`M-40,${ISP.fl.y - 10} L${ISP.fl.x - 14},${ISP.fl.y - 10} L${ISP.fl.x + 2},${ISP.fl.y - 18}`}
                  fill="none" stroke="var(--color-text-muted)" strokeDasharray="3 5" opacity={0.5}
                />
                {/* cabinet faces (the floor's own gradients — it is a real appliance in the room's light) */}
                <polygon points={ISP.front} fill="url(#az-rackfront)" stroke="#3a4556" />
                <polygon points={ISP.side} fill="url(#az-rackside)" stroke="#2c3644" />
                <polygon points={ISP.top} fill="url(#az-racktop)" stroke="#3a4556" />
                {/* roofline accent — hud teal marks it as the network's mouth */}
                <line x1={ISP.roofSW.x} y1={ISP.roofSW.y} x2={ISP.roofSE.x} y2={ISP.roofSE.y} stroke="var(--az-hud)" strokeWidth={1.6} opacity={0.85} />
                {/* whip antenna */}
                <line x1={ISP.roofNW.x} y1={ISP.roofNW.y} x2={ISP.roofNW.x} y2={ISP.roofNW.y - 16} stroke="#4a5668" strokeWidth={1.2} />
                <circle cx={ISP.roofNW.x} cy={ISP.roofNW.y - 18} r={2} fill="var(--az-hud)" opacity={0.9} />
                {/* status LEDs: PWR always · LINK when any entry is open · ACT when rps flows */}
                <circle cx={ISP.fl.x + 7} cy={ISP.fl.y - 26} r={1.7} fill="var(--color-success)" />
                <circle cx={ISP.fl.x + 14} cy={ISP.fl.y - 22.5} r={1.7}
                  fill={ingress.some(e => e.allowed) ? 'var(--az-hud)' : '#2a3442'} />
                <circle cx={ISP.fl.x + 21} cy={ISP.fl.y - 19} r={1.7}
                  fill={ingressRps > 0 ? 'var(--color-warning)' : '#2a3442'} />
                {/* RJ45-ish uplink port with a gold pin line */}
                <rect x={ISP.fl.x + 8} y={ISP.fl.y - 14} width={12} height={9} rx={1} fill="#0b0e13" stroke="#3a4556" strokeWidth={0.8} />
                <line x1={ISP.fl.x + 10} y1={ISP.fl.y - 11.5} x2={ISP.fl.x + 18} y2={ISP.fl.y - 11.5} stroke="#c9a227" strokeWidth={1.4} opacity={0.9} />
                <text x={ISP.roofSW.x - 2} y={ISP.roofNW.y - 24} fill="var(--az-hud)" style={{ font: '10px var(--font-mono)', letterSpacing: '0.14em', pointerEvents: 'none' }}>
                  INTERNET
                </text>
                <text x={ISP.roofSW.x - 2} y={ISP.floorSE.y + 14} fill="var(--color-text-muted)" style={{ font: '8px var(--font-mono)', pointerEvents: 'none' }}>
                  {ingress.length > 0 ? `isp uplink · ${ingressRps.toLocaleString('en-US')} rps in` : 'isp uplink · no public entry'}
                </text>
              </g>
            )}
            {showInet && ingress.map(e => {
              const to = anchorFor(e.serverId)
              if (!to) return null
              const key = `inet->${e.serverId}`
              const rate = animatedKeys.get(key)
              const animated = e.allowed && rate !== undefined
              const dur = animated ? (0.5 + (1 - (rate as number) / maxAnimatedRate) * 1.1).toFixed(2) : undefined
              // One elbow: run along the floor from the box, then up to the server's anchor.
              const d = `M${inetAnchor.x},${inetAnchor.y} L${(inetAnchor.x + to.x) / 2},${inetAnchor.y} L${to.x},${to.y}`
              return (
                <path
                  key={key}
                  data-testid={`ingress-${e.serverId}`}
                  data-animated={animated ? 'true' : 'false'}
                  d={d}
                  fill="none"
                  stroke={e.allowed ? 'var(--az-hud)' : 'var(--color-danger)'}
                  strokeWidth={e.allowed ? 1.8 : 2}
                  strokeDasharray={e.allowed ? '7 8' : '5 4'}
                  className={animated ? 'az-trace-animated' : undefined}
                  style={animated ? { animationDuration: `${dur}s` } : undefined}
                  opacity={e.allowed ? 0.7 : 0.85}
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
                  accentsByServer={accentsByServer}
                  cacheByServer={cacheByServer}
                  selectedServerId={selectedServerId}
                  newServerIds={reducedMotion ? EMPTY_SERVER_ID_SET : newIds}
                  animatedLedIds={animatedLedIds}
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
                  accents={accentsByServer.get(server.id) ?? []}
                  cacheHit={cacheByServer.get(server.id) ?? null}
                  selectedServerId={selectedServerId}
                  isNew={newIds.has(server.id) && !reducedMotion}
                  animatedLed={animatedLedIds.has(server.id)}
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
              // Live traffic reaching this managed service (node-model Phase 5.1): the box was a
              // static shell — it now tints warning/danger when the DB is at/over its instance-class
              // ceiling, and reads solid (vs. dashed-idle) while it's actively serving. teal stays
              // the healthy resting colour, matching the server-LED green-until-trouble language.
              const mm = live ? batch?.managedServices?.[m.id] : undefined
              const activeRps = mm ? mm.rps : 0
              // Manually taken down (node-model Phase 5.2) reads red at rest, independent of traffic.
              const manuallyDown = healthOverrides[m.id] ?? false
              // Non-fatal operator fault (FEAT-001, plan design section) — a distinct amber outline
              // from organic `degraded`/idle dashing, so "operator injected latency/CPU/memory/error
              // fault" never reads as either "dead" (manuallyDown/red) or merely "busy" (teal).
              const nonFatalFault = isNonFatalFault(activeFaults[m.id] ?? null)
              const accent = manuallyDown || mm?.health === 'down' ? 'var(--color-danger)'
                : nonFatalFault ? 'var(--color-warning)'
                  : mm?.health === 'degraded' ? 'var(--color-warning)'
                    : 'var(--az-teal)'
              return (
                <g
                  key={m.id} data-testid={`appliance-${m.id}`} data-managed-rps={Math.round(activeRps)}
                  data-managed-down={manuallyDown ? 'true' : 'false'} data-nonfatal-fault={nonFatalFault ? 'true' : 'false'}
                >
                  <polygon points={box.side} fill="url(#az-rackside)" stroke="#232b38" />
                  <polygon
                    points={box.front} fill="url(#az-rackfront)" stroke={accent}
                    strokeWidth={activeRps > 0.5 || manuallyDown || nonFatalFault ? 1.5 : 1}
                    strokeDasharray={nonFatalFault ? '3 2' : activeRps > 0.5 && !manuallyDown ? undefined : '2 3'}
                  />
                  <polygon points={box.top} fill="url(#az-racktop)" stroke="#333d4d" />
                </g>
              )
            })}
          </svg>

          {/* Label layer — plain positioned divs as SVG siblings (mockup's own `.iso3 .lbl`
              shape); raw px matches the SVG's own unscaled viewBox 1:1. Positions come from
              `placedLabels` (labelLayout.ts) — anchored above each roof, pushed up until clear
              of every box and every earlier label (user report 2026-07-12). */}
          {racks.map(rack => {
            const r = placedLabels.get(`rack:${rack.id}`)
            if (!r) return null
            const used = rackUsedU(doc, rack.id)
            return (
              <div key={rack.id} style={{ ...lblStyle, left: r.x, top: r.y }}>
                {rack.label} <small style={{ color: 'var(--color-text-muted)' }}>· {used}/{rack.capacityU}U</small>
              </div>
            )
          })}
          {freePool.map(server => {
            const r = placedLabels.get(`pod:${server.id}`)
            if (!r) return null
            return (
              <div
                key={server.id} data-testid="pod-label"
                style={{
                  position: 'absolute', left: r.x, top: r.y, width: r.w, textAlign: 'center',
                  font: '8px var(--font-mono)', color: 'var(--color-text-secondary)',
                  pointerEvents: 'none', whiteSpace: 'nowrap',
                }}
              >
                {server.label}
              </div>
            )
          })}
          {managed.map(m => {
            const r = placedLabels.get(`managed:${m.id}`)
            if (!r) return null
            // Show the LIVE received rps (node-model Phase 5.1) so a managed DB that IS taking
            // traffic no longer looks dead; a ⚠ flags when it's throttling over its ceiling; a
            // kill/restore control (node-model Phase 5.2) takes the whole service down mid-run.
            const mm = live ? batch?.managedServices?.[m.id] : undefined
            const showRps = mm && mm.rps > 0.5
            const throttling = mm && mm.refusedRps > 0.5
            const manuallyDown = healthOverrides[m.id] ?? false
            const color = manuallyDown ? 'var(--color-danger)' : throttling ? 'var(--color-warning)' : 'var(--az-teal)'
            return (
              <div
                key={m.id}
                style={{
                  ...lblStyle, left: r.x, top: r.y, color, borderColor: '#3fc7b83a',
                  pointerEvents: running ? 'auto' : 'none', display: 'flex', alignItems: 'center', gap: 5,
                  ...(isNonFatalFault(activeFaults[m.id] ?? null) ? NON_FATAL_FAULT_ACCENT : {}),
                }}
              >
                <span>{m.label} <small>· {m.nodeType}{manuallyDown ? ' · down' : showRps ? ` · ${Math.round(mm!.rps).toLocaleString('en-US')} rps` : ''}{throttling && !manuallyDown ? ' ⚠' : ''}</small></span>
                <ChaosControl scope="managed" id={m.id} running={running} label={m.label} />
              </div>
            )
          })}
          {(() => {
            const r = placedLabels.get('section:free-pool')
            if (!r) return null
            return (
              <div style={{ ...lblStyle, left: r.x, top: r.y, color: 'var(--az-teal)', borderColor: '#3fc7b83a' }}>
                FREE POOL <small>· unracked</small>
              </div>
            )
          })()}
          {ghostCell && !running && (
            <div
              data-no-pan
              style={{ ...lblStyle, left: tileCenter(ghostCell.x, ghostCell.y, plan.cols).x - 20, top: tileCenter(ghostCell.x, ghostCell.y, plan.cols).y + 8, cursor: 'pointer', pointerEvents: 'auto' }}
              onClick={() => azId && useWorldStore.getState().addRack(azId)}
            >
              + rack
            </div>
          )}
          {flows.map(f => {
            const key = `${f.source}->${f.target}`
            const r = placedLabels.get(`dep:${key}`)
            if (!r) return null
            const partitioned = flowImpairmentByKey.get(key)?.blocked ?? false
            const blocked = f.blocked > 0 || partitioned
            return (
              <div
                key={`lbl-${key}`}
                style={{
                  ...lblStyle, left: r.x, top: r.y,
                  color: blocked ? 'var(--color-danger)' : 'var(--az-hud)',
                  borderColor: blocked ? undefined : '#2dd4bf3a',
                }}
              >
                {f.blocked > 0 ? `✕ ${f.reason}` : partitioned ? '✕ partitioned' : `${f.total} dep${f.total > 1 ? 's' : ''}`}
              </div>
            )
          })}
          {ingress.filter(e => !e.allowed).map(e => {
            const r = placedLabels.get(`inetlbl:${e.serverId}`)
            if (!r) return null
            return (
              <div key={`inetlbl-${e.serverId}`} style={{ ...lblStyle, left: r.x, top: r.y, color: 'var(--color-danger)' }}>
                ✕ firewall
              </div>
            )
          })}
      </div>

      {/* Authoring is edit-locked while the simulation runs (user request 2026-07-11: nothing
          added/deleted/moved mid-run) — same rule the dock's topology fieldset already follows.
          Observation controls (fit) stay live. */}
      <div data-no-pan style={{ position: 'absolute', right: 16, bottom: 16, display: 'flex', gap: 8, zIndex: 6 }}>
        {/* Quick-add of the default compute host. The FULL typed palette (compute presets + DB
            appliances) lives in the dock's AzConfigTab, which is the AZ's config instrument —
            this row is four buttons wide and is not the place for it. Labelled "+ compute" rather
            than "+ server" precisely because it can no longer reach every node kind. */}
        <button style={running ? lockedBtnStyle : btnStyle} disabled={running} title={running ? 'stop the simulation to edit' : 'add a default compute host — the dock has the full node palette'} onClick={() => azId && useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)}>+ compute</button>
        <button style={running ? lockedBtnStyle : btnStyle} disabled={running} title={running ? 'stop the simulation to edit' : undefined} onClick={() => azId && useWorldStore.getState().addRack(azId)}>+ rack</button>
        <button style={running ? lockedBtnStyle : btnStyle} disabled={running} title={running ? 'stop the simulation to edit' : undefined} onClick={() => azId && useWorldStore.getState().autoArrangeAz(azId)}>auto-arrange</button>
        <button style={btnStyle} aria-label="fit floor to view" onClick={camera.fit}>fit</button>
      </div>

      {/* Polish 4 T4 (spec D6): InspectorV2 retired its selected-server pane — the dock's
          faceplate (dock/ServerFaceplate.tsx) now renders that same `selectedServerId`
          selection instead, so this stays traces-only. Floor selection still drives the
          highlight below AND the dock (ui.store.selectedServerId, read directly by both). */}
      <InspectorV2 azId={azId} />
    </div>
  )
}
