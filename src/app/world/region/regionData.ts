// src/app/world/region/regionData.ts
// Pure region-page selectors (Phase 4 D3): everything the Level-2 flow page renders is derived
// here from doc/compiled/batch/events — no store access, no JSX, no randomness. Mirrors the
// server board's boardLayout.ts precedent (Phase 3 §L): one pure data module per composed view.
import type { WorldDoc, CompiledWorld, RegionId, AzId, ServerId, BlueprintId } from '../../../lib/world/types'
import type { MetricsBatch, EngineEvent, ReplayFrame } from '../../../lib/worldEngine/types'

export interface AzShare { azId: AzId; fraction: number; rps: number; down: boolean }

// Ordered by doc iteration order. fraction of the region's total az rps (0 when total 0);
// down = batch az health === 'down' (or healthOverride-style absence tolerated: null batch
// → fraction 0, down false). A down AZ's `rps`/`fraction` are BOTH pinned to 0 regardless of
// what the batch reports for it (mockup line 244 shows "0 rps" on a down row, not a stale
// number) — the denominator used for the other AZs' fractions excludes the down AZ's rps too,
// so the remaining shares still sum to 1 (the "redistribution" the ribbon/split-lines depict).
export function azShares(regionId: RegionId, doc: WorldDoc, batch: MetricsBatch | null): AzShare[] {
  const azIds = Object.values(doc.azs).filter(a => a.regionId === regionId).map(a => a.id)
  const raw = azIds.map(azId => {
    const m = batch?.azs[azId] ?? null
    return { azId, rawRps: m?.rps ?? 0, down: m?.health === 'down' }
  })
  const total = raw.reduce((sum, a) => sum + (a.down ? 0 : a.rawRps), 0)
  return raw.map(a => ({
    azId: a.azId,
    down: a.down,
    rps: a.down ? 0 : a.rawRps,
    fraction: a.down || total <= 0 ? 0 : a.rawRps / total,
  }))
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

// Signature color of the blueprint with the highest instance count on this server (ties →
// first by compiled iteration order); fallback 'var(--color-text-muted)'.
export function dominantBlueprintColor(serverId: ServerId, doc: WorldDoc, compiled: CompiledWorld): string {
  const counts = new Map<BlueprintId, number>()
  for (const inst of Object.values(compiled.instances)) {
    if (inst.serverId !== serverId) continue
    counts.set(inst.blueprintId, (counts.get(inst.blueprintId) ?? 0) + 1)
  }
  let bestId: BlueprintId | null = null
  let bestCount = 0
  for (const [id, count] of counts) {
    if (count > bestCount) { bestCount = count; bestId = id }
  }
  return (bestId && doc.blueprints[bestId]?.color) || 'var(--color-text-muted)'
}
