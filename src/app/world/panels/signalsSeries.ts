// FEAT-009 Task 2: pure series extraction over the engine's replay ring. No React, no store
// access -- this file turns `ReplayFrame[]` + a `DockScope` into chartable point series and
// downsamples them for a fixed-width chart. `SignalChart.tsx`/`SignalsPanel.tsx` (later tasks)
// are the only intended consumers.
import type { InstanceMetrics, MetricsBatch, ReplayFrame } from '../../../lib/worldEngine/types'
import type { DockScope } from '../dock/scope'

// FEAT-010 Task 8 widens this with 'costUsdPerHour' -- keep the resolver below an if/else chain
// per scope kind (not an exhaustive switch) so that widening doesn't require touching every
// branch; cost isn't a MetricsBatch field, so its series is built by a separate module entirely.
export type SignalKey =
  | 'rps' | 'errorRate' | 'p50Ms' | 'p90Ms' | 'p99Ms'
  | 'activeConnections' | 'cpu' | 'queueDepth' | 'ramMb'
  // costUsdPerHour is charted through the SAME downsample()/SignalChart path as every other
  // signal (FEAT-010), but its SeriesPoint[] comes from costSeries.ts's costSeriesFor map, not
  // from extractSeries below -- cost isn't a field on MetricsBatch, it's derived per-frame by
  // computeWorldCost. Deliberately NO branch for it exists in valueForScope/extractSeries; the
  // future CostTab.tsx (Task 10) builds its own SeriesPoint[] straight from costSeriesFor and
  // bypasses extractSeries entirely for this one key. If you're looking for a costUsdPerHour
  // case below and not finding one, that's this -- not a bug.
  | 'costUsdPerHour'

export interface SeriesPoint { simMs: number; value: number }
export interface DownsampledPoint { simMs: number; min: number; max: number; value: number }

// Per-instance field a SignalKey reads. 'cpu' displays cpuCoresUsed under a shorter label.
// 'queueDepth' has NO published gauge: the engine's flow solver carries a `queueDepth` map
// internally (worldEngine/flows.ts) but never publishes it onto InstanceMetrics/MetricsBatch --
// grepped for it before writing this, found no such field. Left unmapped on purpose so
// extractSeries resolves it to an empty series everywhere rather than inventing a fake reading;
// wire it here if a per-instance queue-depth gauge is ever added to the contract.
const INSTANCE_FIELD: Partial<Record<SignalKey, keyof InstanceMetrics>> = {
  rps: 'rps',
  errorRate: 'errorRate',
  p50Ms: 'p50Ms',
  p90Ms: 'p90Ms',
  p99Ms: 'p99Ms',
  activeConnections: 'activeConnections',
  cpu: 'cpuCoresUsed',
  ramMb: 'ramMb',
}

// Additive per-instance fields that are summed (not rps-weighted-averaged) across a server's
// resident instances -- absolute quantities, unlike a rate/latency percentile.
const SUM_KEYS: ReadonlySet<SignalKey> = new Set(['rps', 'activeConnections', 'cpu', 'ramMb'])

// ServerMetrics.ramByInstance is the ONLY serverId -> instanceId mapping published on the batch
// itself -- InstanceMetrics carries no serverId field (that link lives only on the COMPILED
// world's ServiceInstance, which this pure module deliberately does not depend on). A server with
// no entry in batch.servers, or no resident instances, resolves to [].
function instanceIdsForServer(serverId: string, batch: MetricsBatch): string[] {
  const server = batch.servers[serverId]
  if (!server) return []
  return server.ramByInstance.map(r => r.instanceId)
}

// rps-weighted mean across a set of instance ids for a given metrics field. Falls back to a
// plain mean when every instance in the set has zero rps (avoids a silent divide-by-zero
// collapsing to 0 when e.g. every resident instance is idle but still reporting a latency floor).
function weightedMean(ids: string[], field: keyof InstanceMetrics, batch: MetricsBatch): number {
  const rows = ids.map(id => batch.instances[id]).filter((m): m is InstanceMetrics => m != null)
  const totalRps = rows.reduce((s, m) => s + m.rps, 0)
  if (totalRps <= 0) {
    return rows.reduce((s, m) => s + (m[field] as number), 0) / Math.max(1, rows.length)
  }
  return rows.reduce((s, m) => s + (m[field] as number) * m.rps, 0) / totalRps
}

function valueForServerScope(serverId: string, key: SignalKey, batch: MetricsBatch): number | null {
  const ids = instanceIdsForServer(serverId, batch)
  if (ids.length === 0) return null
  const field = INSTANCE_FIELD[key]
  if (!field) return null // queueDepth: no source field, see comment above
  const rows = ids.map(id => batch.instances[id]).filter((m): m is InstanceMetrics => m != null)
  if (rows.length === 0) return null
  if (SUM_KEYS.has(key)) {
    return rows.reduce((s, m) => s + (m[field] as number), 0)
  }
  return weightedMean(ids, field, batch)
}

function valueForScope(scope: DockScope, key: SignalKey, batch: MetricsBatch): number | null {
  if (scope.kind === 'world') {
    if (key === 'rps') return batch.world.totalRps
    if (key === 'errorRate') return batch.world.errorRate
    // WorldMetrics has no latency/connection/cpu/ram rollup today.
    return null
  }
  if (scope.kind === 'region') {
    const r = batch.regions[scope.regionId]
    if (!r) return null
    if (key === 'rps') return r.rps
    if (key === 'errorRate') return r.errorRate
    if (key === 'p50Ms') return r.p50Ms
    if (key === 'p90Ms') return r.p90Ms
    // RegionMetrics has no p99Ms/activeConnections/cpu/ramMb/queueDepth rollup today.
    return null
  }
  if (scope.kind === 'az') {
    const a = batch.azs[scope.azId]
    if (!a) return null
    if (key === 'rps') return a.rps
    if (key === 'errorRate') return a.errorRate
    if (key === 'p50Ms') return a.p50Ms
    if (key === 'p90Ms') return a.p90Ms
    // AzMetrics has no p99Ms/activeConnections/cpu/ramMb/queueDepth rollup today.
    return null
  }
  // server scope: rps-weighted mean/sum across the resident instances -- for today's typical
  // single-instance-per-server placement this is exactly that instance's own reading.
  return valueForServerScope(scope.serverId, key, batch)
}

export function extractSeries(frames: ReplayFrame[], scope: DockScope, key: SignalKey): SeriesPoint[] {
  const points: SeriesPoint[] = []
  for (const f of frames) {
    const value = valueForScope(scope, key, f.batch)
    if (value !== null) points.push({ simMs: f.simMs, value })
  }
  return points
}

// Extrema-preserving downsample: each output bucket carries the min/max/mean of the source
// points folded into it, so a single-frame spike survives as a visible `max` even after the
// chart width shrinks the point count by 6x+ -- an average-only downsample would smear it away.
export function downsample(points: SeriesPoint[], targetWidth: number): DownsampledPoint[] {
  if (points.length === 0) return []
  if (points.length <= targetWidth) {
    return points.map(p => ({ simMs: p.simMs, min: p.value, max: p.value, value: p.value }))
  }
  const bucketSize = points.length / targetWidth
  const buckets: DownsampledPoint[] = []
  for (let b = 0; b < targetWidth; b++) {
    const start = Math.floor(b * bucketSize)
    const end = Math.min(points.length, Math.floor((b + 1) * bucketSize))
    const slice = points.slice(start, Math.max(start + 1, end))
    if (slice.length === 0) continue
    const values = slice.map(p => p.value)
    buckets.push({
      simMs: slice[Math.floor(slice.length / 2)].simMs,
      min: Math.min(...values),
      max: Math.max(...values),
      value: values.reduce((s, v) => s + v, 0) / values.length,
    })
  }
  return buckets
}
