import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as costModel from './costModelV2'
import { costSeriesFor, incidentCost } from './costSeries'
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

function fixtureFrames(count: number): ReplayFrame[] {
  return Array.from({ length: count }, (_, i) => ({ simMs: i * 1000, events: [], batch: fixtureBatch(i) }))
}

describe('costSeriesFor', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls computeWorldCost at most once per frame, cached across repeated calls with the same cache', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const frames = fixtureFrames(10)
    const doc = fixtureDoc()

    const cache = costSeriesFor(frames, doc)
    expect(spy).toHaveBeenCalledTimes(10)

    // Second call reuses the SAME cache instance -- every index is already cached, so this
    // must add ZERO further calls. This is the assertion that actually distinguishes "memoized"
    // from "recomputed every call": if costSeriesFor ignored the cache argument, this would push
    // the count to 20.
    costSeriesFor(frames, doc, cache)
    expect(spy).toHaveBeenCalledTimes(10)

    // A THIRD call with a fresh subset of new frames appended, same cache: only the NEW indices
    // should trigger new computeWorldCost calls (2 more, not 12).
    const extended = [...frames, ...fixtureFrames(2).map((f, j) => ({ ...f, simMs: (10 + j) * 1000 }))]
    costSeriesFor(extended, doc, cache)
    expect(spy).toHaveBeenCalledTimes(12)
  })

  it('returns a WorldCostResult per frame index, keyed 0..frames.length-1', () => {
    const frames = fixtureFrames(3)
    const doc = fixtureDoc()
    const series = costSeriesFor(frames, doc)
    expect([...series.keys()].sort()).toEqual([0, 1, 2])
    for (const result of series.values()) {
      expect(result.hourlyUsd).toBeGreaterThan(0)   // one server authored, no autoscale -> billed in full
    }
  })

  it('a fresh (default) cache means a second, unrelated costSeriesFor call recomputes from scratch', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const frames = fixtureFrames(5)
    const doc = fixtureDoc()
    costSeriesFor(frames, doc)               // no cache passed -> fresh Map each time
    costSeriesFor(frames, doc)               // no cache passed again -> fresh Map, recomputes
    expect(spy).toHaveBeenCalledTimes(10)
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
    const cheap = series.get(0)!
    const expensive = { ...cheap, hourlyUsd: cheap.hourlyUsd * 3 }
    series.set(2, expensive)
    series.set(3, expensive)

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
    const baseline = series.get(0)!
    const cheaper = { ...baseline, hourlyUsd: baseline.hourlyUsd * 0.2 }
    series.set(1, cheaper)
    series.set(2, cheaper)
    series.set(3, cheaper)

    const { actualUsd, baselineUsd, incidentUsd } = incidentCost(series, frames, 0, 4)
    expect(baselineUsd).toBeGreaterThan(actualUsd)
    expect(incidentUsd).toBeLessThan(0)
    // Sanity: the delta is exactly actual - baseline, not an absolute value.
    expect(incidentUsd).toBeCloseTo(actualUsd - baselineUsd, 10)
  })
})
