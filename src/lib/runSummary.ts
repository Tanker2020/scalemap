// Pure derive-once module (Wave 5, comparison-environments-ergonomics): turns an array of engine
// replay frames into a RunSummary — a time-weighted metrics rollup captured on-demand by a user
// action ("capture baseline" / "capture comparison"). Zero store/engine imports: this file only
// consumes the data shapes those modules already publish (ReplayFrame/MetricsBatch/WorldDoc/
// CompiledWorld/SloTargets), never the engine facade or a Zustand store, so it can be called from
// a store action, a test, or anywhere else without pulling in worldEngine/index.ts.
import type { WorldDoc, CompiledWorld, CompiledPath, SloTargets } from './world/types'
import type { ReplayFrame, MetricsBatch } from './worldEngine/types'
import { computeWorldCost, HOURS_PER_MONTH } from './costModelV2'

export interface RunSummary {
  id: string
  label: string
  capturedIso: string
  scenarioId: string | null
  seed: number
  docFingerprint: string
  durationMs: number
  latency: { p50Ms: number; p90Ms: number; p99Ms: number }
  errorRate: number
  peakRps: number
  cost: { meanHourlyUsd: number; totalUsd: number; peakHourlyUsd: number }
  slo: { target: SloTargets; breaches: { key: keyof SloTargets; worst: number; breachedSec: number }[] }
  eventCounts: Record<string, number>
}

// ─── Structural fingerprint ───────────────────────────────────────────────────
// Deliberately structural, not a hash of the whole doc: instance count per blueprint/server/role
// and permitted/blocked dependency-edge shape — so renaming a region/AZ or moving a node in the
// connections layout does not invalidate a comparison, but adding a replica, moving a placement to
// a different server, or changing a firewall rule that flips a path's verdict does.
export function docFingerprint(compiled: CompiledWorld): string {
  const instanceShape = Object.values(compiled.instances)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(i => `${i.blueprintId}:${i.serverId}:${i.role}`)
    .join('|')
  const pathShape = [...compiled.paths]
    .sort((a, b) => (a.fromInstanceId + pathTargetId(a)).localeCompare(b.fromInstanceId + pathTargetId(b)))
    .map(p => `${p.fromInstanceId}>${pathTargetId(p)}:${p.verdict === 'permitted' ? 1 : 0}`)
    .join('|')
  return fnv1a(`${instanceShape}##${pathShape}`)
}

function pathTargetId(p: CompiledPath): string {
  return p.to.kind === 'instance' ? p.to.instanceId : p.to.managedServiceId
}

function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

// ─── Time-weighted rollup ──────────────────────────────────────────────────────

// The fraction of a frame's admitted requests its published p99Ms is meant to represent (by
// definition: 99% of requests land at/below p50-ish territory, the top 1% land up near p99Ms).
// No per-request latency histogram exists anywhere in the engine — MetricsBatch publishes only
// EMA-smoothed p50Ms/p99Ms per instance, one pair per 1Hz frame. Naively time-averaging those
// per-frame p99Ms readings across the whole run lets a brief spike (rare in TIME) dominate the
// reported run-level p99, even though it represents a much smaller share of actual REQUESTS (a
// 10-of-300-second spike is 3.3% of time, but its own p99 tail is only the top 1% of THAT window's
// requests — under 0.04% of the run's total request volume). To avoid that distortion, each
// frame's reading is modeled as two weighted request-count samples — the bulk of its requests at
// p50Ms, and its top-1% tail at p99Ms — merged across every frame and every instance (weighted by
// rps × frame-duration), then the run's p50/p90/p99 are read off that merged weighted distribution
// via weightedQuantile. This keeps a rare tail rare in the rollup instead of letting frame-count
// alone decide its weight.
const P99_TAIL_FRACTION = 0.01

function frameInstanceLatency(batch: MetricsBatch): { p50Ms: number; p99Ms: number; rps: number } {
  const instances = Object.values(batch.instances)
  const totalRps = instances.reduce((sum, i) => sum + i.rps, 0)
  if (totalRps <= 0 || instances.length === 0) return { p50Ms: 0, p99Ms: 0, rps: 0 }
  const p50Ms = instances.reduce((sum, i) => sum + i.p50Ms * i.rps, 0) / totalRps
  const p99Ms = instances.reduce((sum, i) => sum + i.p99Ms * i.rps, 0) / totalRps
  return { p50Ms, p99Ms, rps: totalRps }
}

function weightedQuantile(samples: { value: number; weight: number }[], q: number): number {
  const withWeight = samples.filter(s => s.weight > 0)
  if (withWeight.length === 0) return 0
  const sorted = [...withWeight].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, s) => sum + s.weight, 0)
  const threshold = q * total
  let cum = 0
  for (const s of sorted) {
    cum += s.weight
    if (cum > threshold) return s.value
  }
  return sorted[sorted.length - 1].value
}

export function buildRunSummary(
  frames: ReplayFrame[],
  doc: WorldDoc,
  compiled: CompiledWorld,
  label: string,
): RunSummary {
  if (frames.length === 0) throw new Error('buildRunSummary: no frames to summarize')
  const sorted = [...frames].sort((a, b) => a.simMs - b.simMs)
  const durationMs = sorted[sorted.length - 1].simMs - sorted[0].simMs

  // Per-frame dt in ms, defaulting the first frame's weight to the gap to frame 2 (or 1000ms if
  // there's only one frame) so no frame is silently weighted zero.
  const weights = sorted.map((f, i) => {
    if (i === sorted.length - 1) return i === 0 ? 1000 : sorted[i].simMs - sorted[i - 1].simMs
    return sorted[i + 1].simMs - f.simMs
  })
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  const wMean = (pick: (i: number) => number) =>
    totalWeight > 0 ? sorted.reduce((sum, _f, i) => sum + pick(i) * weights[i], 0) / totalWeight : 0

  const frameLatencies = sorted.map(f => frameInstanceLatency(f.batch))

  const latencySamples: { value: number; weight: number }[] = []
  sorted.forEach((_f, i) => {
    const { p50Ms, p99Ms, rps } = frameLatencies[i]
    const requestWeight = rps * weights[i]
    if (requestWeight <= 0) return
    latencySamples.push({ value: p50Ms, weight: requestWeight * (1 - P99_TAIL_FRACTION) })
    latencySamples.push({ value: p99Ms, weight: requestWeight * P99_TAIL_FRACTION })
  })
  const latency = {
    p50Ms: weightedQuantile(latencySamples, 0.5),
    p90Ms: weightedQuantile(latencySamples, 0.9),
    p99Ms: weightedQuantile(latencySamples, 0.99),
  }

  const errorRate = wMean(i => sorted[i].batch.world.errorRate)
  const peakRps = Math.max(0, ...sorted.map(f => f.batch.world.totalRps))

  // MetricsBatch carries no direct cost field (cost is a display-time derivation, per
  // costModelV2.ts's computeWorldCost(doc, world, managed) signature) -- compute it once per
  // frame from that frame's own world/managedServices metrics slice. WorldCostResult exposes
  // monthlyUsd, not an hourly figure, so hourlyUsd is derived via HOURS_PER_MONTH (the same basis
  // computeWorldCost itself bills against) rather than inventing a parallel cost field.
  const frameHourlyUsds = sorted.map(f =>
    computeWorldCost(doc, f.batch.world, f.batch.managedServices ?? null).monthlyUsd / HOURS_PER_MONTH,
  )
  const meanHourlyUsd = wMean(i => frameHourlyUsds[i])
  const peakHourlyUsd = Math.max(0, ...frameHourlyUsds)
  const totalUsd = meanHourlyUsd * (durationMs / 3_600_000)

  const eventCounts: Record<string, number> = {}
  for (const f of sorted) for (const e of f.events) eventCounts[e.kind] = (eventCounts[e.kind] ?? 0) + 1

  const target: SloTargets = doc.slo ?? {}
  const breaches = evaluateSloBreaches(sorted, weights, frameLatencies, frameHourlyUsds, target)

  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    capturedIso: new Date().toISOString(),
    scenarioId: doc.scenario?.id ?? null,
    seed: doc.scenario?.seed ?? 0,
    docFingerprint: docFingerprint(compiled),
    durationMs,
    latency,
    errorRate,
    peakRps,
    cost: { meanHourlyUsd, totalUsd, peakHourlyUsd },
    slo: { target, breaches },
    eventCounts,
  }
}

function evaluateSloBreaches(
  frames: ReplayFrame[],
  weights: number[],
  frameLatencies: { p50Ms: number; p99Ms: number; rps: number }[],
  frameHourlyUsds: number[],
  target: SloTargets,
): { key: keyof SloTargets; worst: number; breachedSec: number }[] {
  const out: { key: keyof SloTargets; worst: number; breachedSec: number }[] = []

  if (target.p99Ms != null) {
    let worst = 0
    let breachedMs = 0
    frames.forEach((_f, i) => {
      const v = frameLatencies[i].p99Ms
      worst = Math.max(worst, v)
      if (v > target.p99Ms!) breachedMs += weights[i]
    })
    if (breachedMs > 0) out.push({ key: 'p99Ms', worst, breachedSec: breachedMs / 1000 })
  }

  if (target.errorRate != null) {
    let worst = 0
    let breachedMs = 0
    frames.forEach((f, i) => {
      const v = f.batch.world.errorRate
      worst = Math.max(worst, v)
      if (v > target.errorRate!) breachedMs += weights[i]
    })
    if (breachedMs > 0) out.push({ key: 'errorRate', worst, breachedSec: breachedMs / 1000 })
  }

  // No direct availability signal is published anywhere in the engine -- derive it from
  // (1 - errorRate) * 100, the working definition called out for this fallback case.
  if (target.availabilityPercent != null) {
    let worst = 100
    let breachedMs = 0
    frames.forEach((f, i) => {
      const availability = (1 - f.batch.world.errorRate) * 100
      worst = Math.min(worst, availability)
      if (availability < target.availabilityPercent!) breachedMs += weights[i]
    })
    if (breachedMs > 0) out.push({ key: 'availabilityPercent', worst, breachedSec: breachedMs / 1000 })
  }

  // No per-frame "cost to date" signal exists either -- project each frame's instantaneous hourly
  // rate to a full month (costModelV2's HOURS_PER_MONTH, the same basis computeWorldCost bills
  // against), the working definition called out for this fallback case.
  if (target.monthlyUsdBudget != null) {
    let worst = 0
    let breachedMs = 0
    frameHourlyUsds.forEach((hourlyUsd, i) => {
      const projectedMonthly = hourlyUsd * HOURS_PER_MONTH
      worst = Math.max(worst, projectedMonthly)
      if (projectedMonthly > target.monthlyUsdBudget!) breachedMs += weights[i]
    })
    if (breachedMs > 0) out.push({ key: 'monthlyUsdBudget', worst, breachedSec: breachedMs / 1000 })
  }

  return out
}
