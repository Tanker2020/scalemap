import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as costModel from './costModelV2'
import { costSeriesFor, incidentCost, createCostSeriesCache } from './costSeries'
import { createWorld, createRegion, createAz, createServer } from './world/factories'
import { getPreset } from './world/instanceCatalog'
import type { WorldDoc } from './world/types'
import type { MetricsBatch, ReplayFrame } from './worldEngine/types'

function fixtureDoc(): WorldDoc {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  const server = createServer(az.id, getPreset('vps-medium')!)
  doc.servers[server.id] = server
  return doc
}

function fixtureBatch(i: number): MetricsBatch {
  return {
    simMs: i * 1000,
    instances: {},
    servers: {},
    azs: {},
    regions: {},
    world: {
      totalRps: 0,
      errorRate: 0,
      populationRoutes: [],
      crossAzBytesPerSec: 0,
      crossRegionBytesPerSec: 0,
      internetEgressBytesPerSec: 0,
    },
  }
}

function fixtureFrames(count: number, startAt = 0): ReplayFrame[] {
  return Array.from({ length: count }, (_, i) => {
    const idx = startAt + i
    return { simMs: idx * 1000, events: [], batch: fixtureBatch(idx) }
  })
}

describe('costSeriesFor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls computeWorldCost at most once per frame, cached across repeated calls with the same cache', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const frames = fixtureFrames(10)
    const doc = fixtureDoc()

    const cache = createCostSeriesCache()
    costSeriesFor(frames, doc, cache)
    expect(spy).toHaveBeenCalledTimes(10)

    // Second call reuses the SAME cache instance -- every simMs is already cached, so this
    // must add ZERO further calls. This is the assertion that actually distinguishes "memoized"
    // from "recomputed every call": if costSeriesFor ignored the cache argument, this would push
    // the count to 20.
    costSeriesFor(frames, doc, cache)
    expect(spy).toHaveBeenCalledTimes(10)

    // A THIRD call with a fresh subset of new frames appended (higher simMs, same cache): only
    // the NEW simMs values should trigger new computeWorldCost calls (2 more, not 12).
    const extended = [...frames, ...fixtureFrames(2, 10)]
    costSeriesFor(extended, doc, cache)
    expect(spy).toHaveBeenCalledTimes(12)
  })

  it('returns a WorldCostResult per frame, keyed by simMs (not array index)', () => {
    const frames = fixtureFrames(3)
    const doc = fixtureDoc()
    const cache = createCostSeriesCache()
    const series = costSeriesFor(frames, doc, cache)
    expect([...series.keys()].sort((a, b) => a - b)).toEqual([0, 1000, 2000])
    for (const result of series.values()) {
      expect(result.hourlyUsd).toBeGreaterThan(0)   // one server authored, no autoscale -> billed in full
    }
  })

  it('a fresh (default) cache means a second, unrelated costSeriesFor call recomputes from scratch', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const frames = fixtureFrames(5)
    const doc = fixtureDoc()
    costSeriesFor(frames, doc)               // no cache passed -> fresh cache each time
    costSeriesFor(frames, doc)               // no cache passed again -> fresh cache, recomputes
    expect(spy).toHaveBeenCalledTimes(10)
  })

  // Wave 4 final review, Critical #1 regression test. The replay ring (worldEngine/replay.ts) is
  // a ROLLING 300-frame window: every push past the cap evicts the oldest frame and shifts every
  // remaining frame's ARRAY POSITION down by one. This reproduces exactly that shift at small
  // scale: frame at old index 0 is gone, everything else shifts down one slot, and one genuinely
  // NEW frame is appended at the end. The OLD (array-index-keyed) implementation would see
  // `cache.has(4)` already true (populated by the first call's index-4 frame) and skip recomputing
  // for what is actually a brand new frame with a higher simMs -- silently freezing the series.
  it('rolling-window shift: a genuinely new frame at the old-cache-tail position is still priced', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const doc = fixtureDoc()
    const cache = createCostSeriesCache()

    const window1 = fixtureFrames(5, 0)          // simMs 0,1000,2000,3000,4000
    costSeriesFor(window1, doc, cache)
    expect(spy).toHaveBeenCalledTimes(5)

    // Simulate the ring's push() eviction+shift: drop the oldest frame, keep the rest, append one
    // genuinely new frame. Array positions 0..4 now hold simMs 1000..5000 -- position 4 used to
    // mean simMs=4000 (already cached) but now means simMs=5000 (never seen).
    const window2 = [...window1.slice(1), ...fixtureFrames(1, 5)]   // simMs 1000,2000,3000,4000,5000
    costSeriesFor(window2, doc, cache)

    // Only the genuinely new simMs=5000 frame should trigger a new computeWorldCost call.
    expect(spy).toHaveBeenCalledTimes(6)
    expect(cache.bySimMs.get(5000)).toBeDefined()
  })

  // Wave 4 final review, Critical #1 second regression: a run restart (stop() then start())
  // allocates a brand-new replay buffer, so a new run's frames start again near simMs=0 -- which
  // would otherwise collide with a PREVIOUS run's cached entries at those same simMs values if the
  // cache is not cleared. Detected via lastMaxSimMs going backwards.
  it('run restart (simMs resets to a lower value) clears stale cache entries instead of colliding', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const doc = fixtureDoc()
    const cache = createCostSeriesCache()

    const run1 = fixtureFrames(5, 0)   // simMs 0..4000
    costSeriesFor(run1, doc, cache)
    expect(spy).toHaveBeenCalledTimes(5)

    // A NEW run: simMs 0,1000,2000 again -- lower than run1's max (4000), so this is unambiguously
    // "time went backwards", i.e. a fresh run, not a continuation.
    const run2 = fixtureFrames(3, 0)
    costSeriesFor(run2, doc, cache)

    // If the cache were NOT cleared, simMs 0/1000/2000 would already be "cached" from run1 and
    // this call would add ZERO new computeWorldCost calls. Clearing means all 3 are recomputed.
    expect(spy).toHaveBeenCalledTimes(8)
  })
})

describe('incidentCost', () => {
  it('degenerate range (toIdx <= fromIdx) returns all zeros without crashing', () => {
    const frames = fixtureFrames(5)
    const doc = fixtureDoc()
    const series = costSeriesFor(frames, doc)
    expect(incidentCost(series, frames, 3, 3)).toEqual({ actualUsd: 0, baselineUsd: 0, incidentUsd: 0 })
    expect(incidentCost(series, frames, 3, 1)).toEqual({ actualUsd: 0, baselineUsd: 0, incidentUsd: 0 })
  })

  it('unknown fromIdx (not in series) returns all zeros without crashing', () => {
    const frames = fixtureFrames(5)
    const series = new Map<number, ReturnType<typeof costModel.computeWorldCost>>()
    expect(incidentCost(series, frames, 0, 3)).toEqual({ actualUsd: 0, baselineUsd: 0, incidentUsd: 0 })
  })

  it('flat-rate window: actual matches baseline exactly (incidentUsd === 0)', () => {
    const frames = fixtureFrames(5)   // 1s apart, uniform world -> uniform hourlyUsd every frame
    const doc = fixtureDoc()
    const series = costSeriesFor(frames, doc)
    const { actualUsd, baselineUsd, incidentUsd } = incidentCost(series, frames, 0, 4)
    expect(actualUsd).toBeCloseTo(baselineUsd, 10)
    expect(incidentUsd).toBeCloseTo(0, 10)
  })

  it('a rate increase mid-window makes incidentUsd positive (an incident that cost more)', () => {
    const frames = fixtureFrames(4)
    const doc = fixtureDoc()
    const series = costSeriesFor(frames, doc)
    // Simulate a scale-out event: from frame 2 onward the world got more expensive.
    const cheap = series.get(frames[0].simMs)!
    const expensive = { ...cheap, hourlyUsd: cheap.hourlyUsd * 3 }
    series.set(frames[2].simMs, expensive)
    series.set(frames[3].simMs, expensive)

    const { incidentUsd } = incidentCost(series, frames, 0, 4)
    expect(incidentUsd).toBeGreaterThan(0)
  })

  it('load-shed incident: a cheaper mid-window rate makes incidentUsd genuinely negative', () => {
    const frames = fixtureFrames(4)
    const doc = fixtureDoc()
    const series = costSeriesFor(frames, doc)
    // Simulate an outage that sheds load without any compensating scale-out: frames 1-3 get
    // CHEAPER than the fromIdx baseline (e.g. an autoscaled fleet scaled itself down because
    // a partition cut off the traffic that used to justify the extra capacity).
    const baseline = series.get(frames[0].simMs)!
    const cheaper = { ...baseline, hourlyUsd: baseline.hourlyUsd * 0.2 }
    series.set(frames[1].simMs, cheaper)
    series.set(frames[2].simMs, cheaper)
    series.set(frames[3].simMs, cheaper)

    const { actualUsd, baselineUsd, incidentUsd } = incidentCost(series, frames, 0, 4)
    expect(baselineUsd).toBeGreaterThan(actualUsd)
    expect(incidentUsd).toBeLessThan(0)
    // Sanity: the delta is exactly actual - baseline, not an absolute value.
    expect(incidentUsd).toBeCloseTo(actualUsd - baselineUsd, 10)
  })
})
