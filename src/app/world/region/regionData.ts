// src/app/world/region/regionData.ts
// Pure region-page selectors (Phase 4 D3): everything the Level-2 flow page renders is derived
// here from doc/compiled/batch/events — no store access, no JSX, no randomness. Mirrors the
// server board's boardLayout.ts precedent (Phase 3 §L): one pure data module per composed view.
import type { WorldDoc, CompiledWorld, RegionId, AzId, ServerId, BlueprintId, ManagedServiceId } from '../../../lib/world/types'
import type { MetricsBatch, EngineEvent, ReplayFrame, HealthState } from '../../../lib/worldEngine/types'
import { managedCapacityRps } from '../../../lib/managedCapacity'

export interface AzShare { azId: AzId; fraction: number; rps: number; dropped: number; down: boolean }

// The region → AZ INGRESS split. Region ingress (Σ populationRoutes into this region) divides into
// what was DELIVERED to servers (`ingress − dropped`) and what the LB routed to an AZ that couldn't
// serve it (`dropped` — cross-zone-off forfeiture etc., published per AZ). The delivered portion is
// attributed by each healthy AZ's share of region throughput (throughput double-counts internal
// service→service hops, so only its FRACTION is used, not its absolute — this fixed the earlier
// "both AZs receive the entirety, doubling" report); `dropped` is added on top per AZ. `rps` is the
// AZ's total ROUTED inbound (delivered share + dropped), so the shares still sum to the region
// ingress. A down AZ's delivered share is pinned to 0, but it still shows any traffic dropped at it.
export function azShares(regionId: RegionId, doc: WorldDoc, batch: MetricsBatch | null): AzShare[] {
  const azIds = Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id)
  const raw = azIds.map(azId => {
    const m = batch?.azs[azId] ?? null
    return { azId, throughput: m?.rps ?? 0, dropped: m?.droppedRps ?? 0, down: m?.health === 'down' }
  })
  const totalThroughput = raw.reduce((sum, a) => sum + (a.down ? 0 : a.throughput), 0)
  const regionIngress = (batch?.world.populationRoutes ?? [])
    .filter(r => r.regionId === regionId)
    .reduce((sum, r) => sum + r.rps, 0)
  const totalDropped = raw.reduce((sum, a) => sum + a.dropped, 0)
  const deliveredIngress = Math.max(0, regionIngress - totalDropped)
  return raw.map(a => {
    const servedFraction = a.down || totalThroughput <= 0 ? 0 : a.throughput / totalThroughput
    const rps = servedFraction * deliveredIngress + a.dropped
    const fraction = regionIngress > 0 ? rps / regionIngress : 0
    return { azId: a.azId, down: a.down, fraction, rps, dropped: a.dropped }
  })
}

export interface RibbonAlert { severity: 'warning' | 'critical'; message: string; simMs: number }

const RIBBON_WINDOW_MS = 30_000
const SEVERITY_RANK: Record<EngineEvent['severity'], number> = { info: 0, warning: 1, critical: 2 }

// ribbonAlert's own scope test — NOT the exported regionEvents() (that function additionally
// needs `compiled`/`batch` for instance- and population-routing membership, which this
// function's fixed signature doesn't receive). Region/az/server ids cover every event kind the
// ribbon actually surfaces (outage/health/failover all stamp az or region ids into `affected`
// per the frozen contracts) — see the fragment's judgment-call note.
function inRegionScope(regionId: RegionId, doc: WorldDoc, affected: string[]): boolean {
  if (affected.includes(regionId)) return true
  for (const az of Object.values(doc.azs)) {
    if (az.regionId === regionId && affected.includes(az.id)) return true
  }
  for (const server of Object.values(doc.servers)) {
    if (doc.azs[server.azId]?.regionId === regionId && affected.includes(server.id)) return true
  }
  return false
}

// Most severe (critical > warning), then most recent, event affecting this region within the
// last 30 sim-seconds. Message formatting: an az-scoped outage/health event gets
// "— traffic redistributed to <healthy AZ labels>" appended (full AZ labels — this is a pure
// data function, not a display layer, so it doesn't invent the mockup's "1a/1b" abbreviation);
// an unresolved failover (a region-scoped failover_started with no later matching
// failover_completed, anywhere in `events`, not just the 30s window) gets
// "· clients still arriving (DNS TTL)" appended. Info events never ribbon.
export function ribbonAlert(regionId: RegionId, doc: WorldDoc, events: EngineEvent[], nowSimMs: number): RibbonAlert | null {
  const azEntries = Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => [a.id, a.label] as const)
  const azLabelById = new Map(azEntries)

  const candidates = events.filter(e =>
    (e.severity === 'warning' || e.severity === 'critical') &&
    e.simMs > nowSimMs - RIBBON_WINDOW_MS && e.simMs <= nowSimMs &&
    inRegionScope(regionId, doc, e.affected))
  if (candidates.length === 0) return null

  candidates.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    return bySeverity !== 0 ? bySeverity : b.simMs - a.simMs
  })
  const top = candidates[0]
  const severity: 'warning' | 'critical' = top.severity === 'critical' ? 'critical' : 'warning'
  let message = top.message

  if (top.kind === 'outage_triggered' || top.kind === 'health_check_failed') {
    const downAzIds = top.affected.filter(id => azLabelById.has(id))
    if (downAzIds.length > 0) {
      const healthyLabels = azEntries.filter(([id]) => !downAzIds.includes(id)).map(([, label]) => label)
      if (healthyLabels.length > 0) message += ` — traffic redistributed to ${healthyLabels.join('/')}`
    }
  }

  const pendingTtl = events.some(e =>
    e.kind === 'failover_started' && inRegionScope(regionId, doc, e.affected) &&
    !events.some(c => c.kind === 'failover_completed' && c.simMs > e.simMs && inRegionScope(regionId, doc, c.affected)))
  if (pendingTtl) message += ' · clients still arriving (DNS TTL)'

  return { severity, message, simMs: top.simMs }
}

// Events whose affected ids intersect: the regionId, its AZ ids, its server ids, its resident
// instance ids, or population ids currently routed to this region per batch.world.populationRoutes.
// Instance membership is read straight off `compiled.instances[...].regionId` (already resolved
// by compileWorld) rather than re-deriving it by string-prefixing an instance id against
// placement ids — same information the skeleton's "prefix match `<placementId>#`" phrasing
// describes, sourced from the compiled graph instead of re-parsing id strings.
export function regionEvents(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, events: EngineEvent[], batch: MetricsBatch | null,
): EngineEvent[] {
  const azIds = new Set(Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id))
  const serverIds = new Set(Object.values(doc.servers).filter(s => azIds.has(s.azId)).map(s => s.id))
  const instanceIds = new Set(Object.values(compiled.instances).filter(i => i.regionId === regionId).map(i => i.id))
  const routedPopulationIds = new Set(
    (batch?.world.populationRoutes ?? []).filter(r => r.regionId === regionId).map(r => r.populationId))

  const isRelevant = (id: string): boolean =>
    id === regionId || azIds.has(id) || serverIds.has(id) || instanceIds.has(id) || routedPopulationIds.has(id)

  return events.filter(e => e.affected.some(isRelevant))
}

export interface ReplicationPair { blueprintId: BlueprintId; blueprintName: string; fromAzId: AzId; toAzId: AzId; linkDown: boolean }

// Stateful blueprints with a primary-role instance in one of this region's AZs and a
// replica-role instance in a DIFFERENT AZ of the same region. linkDown = either AZ down.
// Deduped by (blueprint, fromAz, toAz) — count>1 placements would otherwise repeat a pair.
export function replicationPairs(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, batch: MetricsBatch | null,
): ReplicationPair[] {
  const regionInstances = Object.values(compiled.instances).filter(i => i.regionId === regionId)
  const pairs: ReplicationPair[] = []
  const seen = new Set<string>()

  for (const bp of Object.values(doc.blueprints)) {
    if (!bp.stateful) continue
    const primaries = regionInstances.filter(i => i.blueprintId === bp.id && i.role === 'primary')
    const replicas = regionInstances.filter(i => i.blueprintId === bp.id && i.role === 'replica')
    for (const p of primaries) {
      for (const r of replicas) {
        if (r.azId === p.azId) continue
        const key = `${bp.id}:${p.azId}:${r.azId}`
        if (seen.has(key)) continue
        seen.add(key)
        const linkDown = batch?.azs[p.azId]?.health === 'down' || batch?.azs[r.azId]?.health === 'down'
        pairs.push({ blueprintId: bp.id, blueprintName: bp.name, fromAzId: p.azId, toAzId: r.azId, linkDown })
      }
    }
  }
  return pairs
}

export interface CrossAzEntry { a: AzId; b: AzId; latencyMs: number; linkDown: boolean; replication: ReplicationPair[] }

// R1 — mirrors CROSS_AZ_MS (private) in src/lib/worldEngine/networkRuntime.ts. D2 forbids
// editing worldEngine/ to export it, and latency.ts (D5's named source) has no such constant.
// Value is a stable engine design constant; kept in sync manually. See contract-drift.md §PHASE 4.
const CROSS_AZ_HOP_MS = 1.5

// One entry per unordered AZ pair (a < b by label) connected by ≥1 cross-az compiled path
// between this region's instances OR ≥1 replication pair. Verdict is NOT filtered on
// 'permitted' — a blocked cross-az dependency still represents the topology WANTING to talk
// cross-AZ, which is the pairing this column depicts.
export function crossAzEntries(
  regionId: RegionId, doc: WorldDoc, compiled: CompiledWorld, batch: MetricsBatch | null,
): CrossAzEntry[] {
  const regionAzIds = new Set(Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id))
  const pairs = new Map<string, { a: AzId; b: AzId }>()

  const addPair = (x: AzId, y: AzId) => {
    if (x === y || !regionAzIds.has(x) || !regionAzIds.has(y)) return
    const [a, b] = doc.azs[x].label <= doc.azs[y].label ? [x, y] : [y, x]
    pairs.set(`${a}::${b}`, { a, b })
  }

  for (const path of compiled.paths) {
    if (path.hopClass !== 'cross-az') continue
    const from = compiled.instances[path.fromInstanceId]
    if (!from || from.regionId !== regionId) continue
    if (path.to.kind === 'instance') {
      const to = compiled.instances[path.to.instanceId]
      if (to) addPair(from.azId, to.azId)
    } else {
      const ms = doc.managedServices[path.to.managedServiceId]
      if (ms?.scope.kind === 'az') addPair(from.azId, ms.scope.azId)
    }
  }

  const replication = replicationPairs(regionId, doc, compiled, batch)
  for (const r of replication) addPair(r.fromAzId, r.toAzId)

  return [...pairs.values()]
    .sort((x, y) => (doc.azs[x.a].label + doc.azs[x.b].label).localeCompare(doc.azs[y.a].label + doc.azs[y.b].label))
    .map(({ a, b }) => ({
      a, b,
      latencyMs: CROSS_AZ_HOP_MS,
      linkDown: batch?.azs[a]?.health === 'down' || batch?.azs[b]?.health === 'down',
      replication: replication.filter(r => (r.fromAzId === a && r.toAzId === b) || (r.fromAzId === b && r.toAzId === a)),
    }))
}

// Last n frames' regions[regionId].rps (missing frames/regions → 0), oldest first. `frames` is
// assumed already chronological (getReplayFrames()'s ring-buffer read order, same assumption
// ScrubberV2 makes). Always returns exactly `n` entries, zero-padded at the front when fewer
// than n frames exist yet.
export function sparklineSeries(frames: ReplayFrame[], regionId: RegionId, n = 60): number[] {
  const tail = frames.slice(Math.max(0, frames.length - n)).map(f => f.batch.regions[regionId]?.rps ?? 0)
  return tail.length >= n ? tail : [...new Array(n - tail.length).fill(0), ...tail]
}

// Region v4 (Polish 3 T3, mockup `.r3` `.srcrow .stream`): how many dots animate a source row's
// hairline and how fast, both driven purely by that row's share of the loudest row (`maxRps`) —
// ratio 0 → the calmest single dot at the slowest period, ratio 1 → three dots at the fastest.
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export function dotStreamParams(rps: number, maxRps: number): { dots: 1 | 2 | 3; periodSec: number } {
  const ratio = maxRps > 0 ? rps / maxRps : 0
  const dots: 1 | 2 | 3 = ratio < 0.25 ? 1 : ratio < 0.60 ? 2 : 3
  const periodSec = clamp(3.0 - 1.8 * ratio, 1.2, 3.0)
  return { dots, periodSec }
}

export interface ReplicaRailPair { primaryServerId: ServerId; replicaServerId: ServerId; blueprintId: BlueprintId }

// Region v4 (Polish 3 T3, mockup `.replrail`): every cross-AZ primary/replica instance pair in
// this region, keyed by the SERVERS they sit on (the rail draws server-to-server, not
// instance-to-instance) — deliberately NOT `replicationPairs`' `bp.stateful` gate above; per the
// T3 brief this only cares about role pairing + different AZs, not the blueprint's stateful flag.
// `_doc` is unused (everything needed is already resolved onto `compiled.instances`) — kept in
// the signature to match the brief's exact `(doc, compiled, regionId)` shape.
export function replicaRailPairs(_doc: WorldDoc, compiled: CompiledWorld, regionId: RegionId): ReplicaRailPair[] {
  const regionInstances = Object.values(compiled.instances).filter(i => i.regionId === regionId)
  const byBlueprint = new Map<BlueprintId, { primaries: typeof regionInstances; replicas: typeof regionInstances }>()
  for (const inst of regionInstances) {
    if (inst.role !== 'primary' && inst.role !== 'replica') continue
    const entry = byBlueprint.get(inst.blueprintId) ?? { primaries: [], replicas: [] }
    if (inst.role === 'primary') entry.primaries.push(inst)
    else entry.replicas.push(inst)
    byBlueprint.set(inst.blueprintId, entry)
  }

  const pairs: ReplicaRailPair[] = []
  for (const [blueprintId, { primaries, replicas }] of byBlueprint) {
    for (const p of primaries) {
      for (const r of replicas) {
        if (p.azId === r.azId) continue
        pairs.push({ primaryServerId: p.serverId, replicaServerId: r.serverId, blueprintId })
      }
    }
  }
  return pairs
}

// Signature color of the blueprint with the highest instance count on this server (ties →
// first by compiled iteration order); fallback 'var(--color-text-muted)'.
//
// Audit ISSUE-029: the dominant blueprint per server is derived ONCE per compiled identity (one
// O(instances) pass, WeakMap-cached like useCompiledWorld's compile cache) instead of re-scanning
// the whole instance map per server per call — AzRow called this for every server on every 1 Hz
// batch, making the region page O(servers × instances)/s. Pure memoization, no store access.
const dominantBpCache = new WeakMap<CompiledWorld, Map<ServerId, BlueprintId>>()

function dominantBlueprintByServer(compiled: CompiledWorld): Map<ServerId, BlueprintId> {
  let best = dominantBpCache.get(compiled)
  if (!best) {
    const counts = new Map<ServerId, Map<BlueprintId, number>>()
    for (const inst of Object.values(compiled.instances)) {
      let perBp = counts.get(inst.serverId)
      if (!perBp) { perBp = new Map(); counts.set(inst.serverId, perBp) }
      perBp.set(inst.blueprintId, (perBp.get(inst.blueprintId) ?? 0) + 1)
    }
    best = new Map()
    for (const [serverId, perBp] of counts) {
      let bestId: BlueprintId | null = null
      let bestCount = 0
      for (const [id, count] of perBp) {
        if (count > bestCount) { bestCount = count; bestId = id }
      }
      if (bestId) best.set(serverId, bestId)
    }
    dominantBpCache.set(compiled, best)
  }
  return best
}

export function dominantBlueprintColor(serverId: ServerId, doc: WorldDoc, compiled: CompiledWorld): string {
  const bestId = dominantBlueprintByServer(compiled).get(serverId)
  return (bestId && doc.blueprints[bestId]?.color) || 'var(--color-text-muted)'
}

// node-model Phase 5.1: every cloud-managed service ANCHORED in this region — region-scoped ones,
// plus az-scoped ones whose AZ lives here — with the live traffic reaching it (batch.managedServices).
// Managed services have no hardware, so they never appear among the region's servers; the region
// page's Managed strip is how they surface here at all. `rps`/`refusedRps`/`utilization`/`health`
// default to the at-rest 0/healthy when there's no batch (so the strip still LISTS them pre-run).
export interface RegionManagedEntry {
  id: ManagedServiceId
  label: string
  nodeType: string
  scope: 'region' | 'az'
  azLabel: string | null      // the AZ it lives in, for an az-scoped service
  rps: number
  refusedRps: number
  utilization: number
  health: HealthState
}

// The managed services anchored in ONE availability zone (az-scoped only) with their live load +
// ceiling (node-model Phase 5.2), for the region page's AZ cards. Region-scoped services aren't
// tied to an AZ — they stay in the region-level strip (regionManagedServices). capacityRps is the
// flat non-DB ceiling (null for a DB, whose ceiling is its instance class); the usage bar uses the
// metric utilization regardless, so it works for both.
export interface RegionAzManagedEntry {
  id: ManagedServiceId
  label: string
  nodeType: string
  rps: number
  refusedRps: number
  utilization: number
  health: HealthState
  capacityRps: number | null
  // Which scope the service is authored at (node-model Phase 5.4). Region-scoped services appear in
  // EVERY AZ card of their region — they serve the whole region, and omitting them made the card
  // disagree with the AZ floor, which has always drawn them. The card marks them so the user can
  // tell "in this AZ" from "region-wide, shown here too".
  scope: 'az' | 'region'
  // Phase 5.4 managed-DB failure-model gauges; 0 for non-DB services and when no metrics exist yet.
  saturation: number
  p50Ms: number
  connections: number
  errorRps: number
}

export function regionAzManaged(azId: AzId, doc: WorldDoc, batch: MetricsBatch | null): RegionAzManagedEntry[] {
  const entries: RegionAzManagedEntry[] = []
  const regionId = doc.azs[azId]?.regionId
  for (const ms of Object.values(doc.managedServices)) {
    const inAz = ms.scope.kind === 'az' && ms.scope.azId === azId
    const inRegion = ms.scope.kind === 'region' && regionId != null && ms.scope.regionId === regionId
    if (!inAz && !inRegion) continue
    const mm = batch?.managedServices?.[ms.id]
    const cap = managedCapacityRps(ms)
    entries.push({
      id: ms.id, label: ms.label, nodeType: ms.nodeType,
      rps: mm?.rps ?? 0, refusedRps: mm?.refusedRps ?? 0,
      utilization: mm?.utilization ?? 0, health: mm?.health ?? 'healthy',
      capacityRps: cap != null && Number.isFinite(cap) ? cap : null,
      scope: inAz ? 'az' : 'region',
      saturation: mm?.saturation ?? 0,
      p50Ms: mm?.p50Ms ?? 0,
      connections: mm?.connections ?? 0,
      errorRps: mm?.errorRps ?? 0,
    })
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label))
}

export function regionManagedServices(regionId: RegionId, doc: WorldDoc, batch: MetricsBatch | null): RegionManagedEntry[] {
  const entries: RegionManagedEntry[] = []
  for (const ms of Object.values(doc.managedServices)) {
    let inRegion: boolean
    let azLabel: string | null = null
    if (ms.scope.kind === 'region') {
      inRegion = ms.scope.regionId === regionId
    } else {
      const az = doc.azs[ms.scope.azId]
      inRegion = az?.regionId === regionId
      azLabel = az?.label ?? null
    }
    if (!inRegion) continue
    const mm = batch?.managedServices?.[ms.id]
    entries.push({
      id: ms.id, label: ms.label, nodeType: ms.nodeType, scope: ms.scope.kind, azLabel,
      rps: mm?.rps ?? 0, refusedRps: mm?.refusedRps ?? 0,
      utilization: mm?.utilization ?? 0, health: mm?.health ?? 'healthy',
    })
  }
  return entries.sort((a, b) => a.label.localeCompare(b.label))
}
