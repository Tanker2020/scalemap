// FEAT-010 Task 8: frame-indexed memo over computeWorldCost (Task 7), plus the incident-cost
// delta the Cost tab (Task 9/10) needs to answer "did this outage cost or save money."
//
// computeWorldCost is designed to run once per published MetricsBatch (1 Hz) -- it's not free
// (iterates every server/managed service/LB in the world). Charting a 300-frame replay window
// naively (calling it once per frame PER RENDER) would be exactly the perf regression this module
// exists to avoid: a re-render doesn't need to recompute cost for a frame it already priced.
//
// The cache is caller-owned (not module-level) so the future CostTab.tsx can hold it in a
// useRef that survives re-renders but must be reset by the CALLER whenever `doc` changes identity
// -- this function has no way to detect "the world changed since last time" from a frame index
// alone, so invalidation is NOT this function's responsibility.
//
// Wave 4 final review, Critical #1: the cache used to be keyed by ARRAY INDEX into `frames`. That
// assumed the replay ring (worldEngine/replay.ts's createReplayBuffer, cap 300) is append-only. It
// is NOT -- past 300 frames every push() evicts the oldest frame and shifts every remaining frame's
// array position down by one, so index 0 on tick 301 is a DIFFERENT frame than index 0 on tick 1.
// An index-keyed cache.has(i) check has no way to see that shift: past the 5-minute mark it never
// calls computeWorldCost again, silently freezing the $/hr sparkline and every incidentCost
// integral on the run's first five minutes. Re-keyed below by each frame's OWN `simMs` (stable and
// monotonically increasing within one run) instead of its transient position in the array.
//
// A second failure mode: stop() then start() allocates a brand-new replay buffer, so a NEW run's
// frame 0 (simMs starting back near 0) can collide with an OLD run's cached entry at the same
// simMs, served from a cache the caller (CostTab.tsx) only resets on `doc` identity change, not on
// a same-doc run restart. Detected here via `lastMaxSimMs`: if the incoming frames' last simMs is
// LESS than the highest simMs this cache has ever seen, time went backwards -- a fresh run -- so
// the cache is cleared before repopulating.
import type { WorldDoc } from './world/types'
import type { ReplayFrame } from './worldEngine/types'
import { computeWorldCost, type WorldCostResult } from './costModelV2'

export interface CostSeriesCache {
  bySimMs: Map<number, WorldCostResult>
  lastMaxSimMs: number
}

export function createCostSeriesCache(): CostSeriesCache {
  return { bySimMs: new Map(), lastMaxSimMs: -Infinity }
}

export function costSeriesFor(
  frames: ReplayFrame[],
  doc: WorldDoc,
  cache: CostSeriesCache = createCostSeriesCache(),
): Map<number, WorldCostResult> {
  if (frames.length > 0) {
    const lastSimMs = frames[frames.length - 1].simMs
    if (lastSimMs < cache.lastMaxSimMs) {
      // Time went backwards relative to everything this cache has priced before -- a run
      // restart, not a continuation of the same run. Stale entries from the OLD run would
      // otherwise collide with the new run's simMs values and be served as if they still applied.
      cache.bySimMs.clear()
      cache.lastMaxSimMs = -Infinity
    }
  }
  for (const f of frames) {
    if (cache.bySimMs.has(f.simMs)) continue
    const worldForCost = f.batch.world
      ? { ...f.batch.world, runningByPlacement: f.batch.runningByPlacement }
      : null
    cache.bySimMs.set(f.simMs, computeWorldCost(doc, worldForCost, f.batch.managedServices ?? null))
    if (f.simMs > cache.lastMaxSimMs) cache.lastMaxSimMs = f.simMs
  }
  return cache.bySimMs
}

// actualUsd: the real, metered cost of the [fromIdx, toIdx) window, integrating each frame's
// OWN hourlyUsd over that frame's actual duration (so a variable frame cadence, or a rate that
// changed mid-window from an autoscale event or a fault, is captured exactly).
//
// baselineUsd: what the SAME elapsed duration would have cost had the world stayed at its
// fromIdx-frame rate throughout -- the "nothing happened" counterfactual.
//
// incidentUsd = actualUsd - baselineUsd. This is deliberately signed, not clamped to >= 0: an
// incident that SHEDS load (e.g. a partition that stops traffic reaching an expensive path, or
// an autoscale-in that never would have fired without the fault) can genuinely cost LESS than
// steady state, and the spec requires that to render as a real negative number, not an absolute
// value that erases the direction of the effect.
//
// Duration is deliberately derived by SUMMING each frame's own frameSec (the same quantity
// actualUsd integrates over), not by subtracting frames[fromIdx].simMs from frames[toIdx].simMs.
// The naive subtraction breaks at the caller's most common boundary -- toIdx === frames.length,
// i.e. "the incident runs through the newest frame we have" -- because frames[toIdx] doesn't
// exist past the end of the array; that reads as duration 0 and collapses baselineUsd to 0 while
// actualUsd stays nonzero, producing a wildly wrong incidentUsd. Accumulating the SAME totalHours
// actualUsd already walks guarantees the two numbers integrate over identical elapsed time no
// matter where fromIdx/toIdx sit relative to the array, including at its very end.
//
// `series` is keyed by frame `simMs` (see costSeriesFor above), NOT array index -- fromIdx/toIdx
// remain array positions into `frames` (the caller's natural scrub-index vocabulary); every lookup
// below goes through `frames[i].simMs` to translate.
export function incidentCost(
  series: Map<number, WorldCostResult>,
  frames: ReplayFrame[],
  fromIdx: number,
  toIdx: number,
): { actualUsd: number; baselineUsd: number; incidentUsd: number } {
  if (toIdx <= fromIdx || !frames[fromIdx] || !series.has(frames[fromIdx].simMs)) {
    return { actualUsd: 0, baselineUsd: 0, incidentUsd: 0 }
  }
  let actualUsd = 0
  let totalHours = 0
  for (let i = fromIdx; i < toIdx; i++) {
    const cost = series.get(frames[i].simMs)
    if (!cost) continue
    const frameSec = Math.max(0, (frames[i + 1]?.simMs ?? frames[i].simMs) - frames[i].simMs) / 1000
    const hours = frameSec / 3600
    actualUsd += cost.hourlyUsd * hours
    totalHours += hours
  }
  const baselineUsd = (series.get(frames[fromIdx].simMs)?.hourlyUsd ?? 0) * totalHours
  return { actualUsd, baselineUsd, incidentUsd: actualUsd - baselineUsd }
}
