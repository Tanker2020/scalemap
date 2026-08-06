import { describe, it, expect } from 'vitest'
import { extractSeries, downsample } from './signalsSeries'
import type { ReplayFrame, MetricsBatch, InstanceMetrics, ServerMetrics } from '../../../lib/worldEngine/types'
import type { DockScope } from '../dock/scope'

// Builds a minimal-but-real MetricsBatch. Every collection required by MetricsBatch is present
// (even if empty) so the fixture matches the real shape extractSeries reads, not an `as any` stub.
function instanceMetrics(overrides: Partial<InstanceMetrics> & { instanceId: string }): InstanceMetrics {
  return {
    rps: 0, errorRate: 0, p50Ms: 0, p99Ms: 0, p90Ms: 0,
    activeConnections: 0, cpuCoresUsed: 0, ramMb: 0, health: 'healthy',
    ...overrides,
  }
}

function serverMetrics(overrides: Partial<ServerMetrics> & { serverId: string }): ServerMetrics {
  return {
    coreUtilization: [], stealFraction: 0, burstCredits: null,
    ramByInstance: [], ramUsedMb: 0, ramTotalMb: 0,
    nicInMbps: 0, nicOutMbps: 0, diskIoFraction: 0, health: 'healthy',
    ...overrides,
  }
}

function frame(simMs: number, batch: Partial<MetricsBatch>): ReplayFrame {
  return {
    simMs,
    events: [],
    batch: {
      simMs,
      instances: {},
      servers: {},
      azs: {},
      regions: {},
      world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
      ...batch,
    },
  }
}

describe('extractSeries', () => {
  it('returns one point per frame for world scope (rps read off batch.world.totalRps)', () => {
    const frames = [
      frame(1000, { world: { totalRps: 10, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 } }),
      frame(2000, { world: { totalRps: 20, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 } }),
    ]
    const scope: DockScope = { kind: 'world' }
    expect(extractSeries(frames, scope, 'rps')).toEqual([
      { simMs: 1000, value: 10 },
      { simMs: 2000, value: 20 },
    ])
  })

  it('resolves server scope via batch.servers[serverId].ramByInstance -> batch.instances (no compiled world needed)', () => {
    // srv-1 hosts instance i-1 -- ServerMetrics.ramByInstance is the ONLY serverId->instanceId
    // mapping published on the batch itself; InstanceMetrics carries no serverId field.
    const frames = [
      frame(1000, {
        servers: { 'srv-1': serverMetrics({ serverId: 'srv-1', ramByInstance: [{ instanceId: 'i-1', blueprintId: 'bp-1', ramMb: 100 }] }) },
        instances: { 'i-1': instanceMetrics({ instanceId: 'i-1', rps: 10, p50Ms: 50 }) },
      }),
      frame(2000, {
        servers: { 'srv-1': serverMetrics({ serverId: 'srv-1', ramByInstance: [{ instanceId: 'i-1', blueprintId: 'bp-1', ramMb: 100 }] }) },
        instances: { 'i-1': instanceMetrics({ instanceId: 'i-1', rps: 20, p50Ms: 60 }) },
      }),
    ]
    const scope: DockScope = { kind: 'server', regionId: 'r1', azId: 'az1', serverId: 'srv-1' }
    expect(extractSeries(frames, scope, 'rps')).toEqual([
      { simMs: 1000, value: 10 },
      { simMs: 2000, value: 20 },
    ])
    expect(extractSeries(frames, scope, 'p50Ms')).toEqual([
      { simMs: 1000, value: 50 },
      { simMs: 2000, value: 60 },
    ])
  })

  it('returns an empty array for a server scope with no matching data (no crash)', () => {
    const frames = [
      frame(1000, {
        servers: { 'srv-1': serverMetrics({ serverId: 'srv-1', ramByInstance: [{ instanceId: 'i-1', blueprintId: 'bp-1', ramMb: 100 }] }) },
        instances: { 'i-1': instanceMetrics({ instanceId: 'i-1', rps: 10, p50Ms: 50 }) },
      }),
    ]
    const scope: DockScope = { kind: 'server', regionId: 'r1', azId: 'az1', serverId: 'does-not-exist' }
    expect(extractSeries(frames, scope, 'rps')).toEqual([])
  })

  it('returns an empty array for a signal with no source at world scope (e.g. p50Ms)', () => {
    const frames = [frame(1000, {})]
    const scope: DockScope = { kind: 'world' }
    expect(extractSeries(frames, scope, 'p50Ms')).toEqual([])
  })

  it('returns an empty array for queueDepth at every scope (no published gauge exists yet)', () => {
    const frames = [
      frame(1000, {
        servers: { 'srv-1': serverMetrics({ serverId: 'srv-1', ramByInstance: [{ instanceId: 'i-1', blueprintId: 'bp-1', ramMb: 100 }] }) },
        instances: { 'i-1': instanceMetrics({ instanceId: 'i-1', rps: 10 }) },
      }),
    ]
    const scope: DockScope = { kind: 'server', regionId: 'r1', azId: 'az1', serverId: 'srv-1' }
    expect(extractSeries(frames, scope, 'queueDepth')).toEqual([])
  })

  it('rps-weights the mean of p50Ms across multiple instances resident on one server', () => {
    const frames = [
      frame(1000, {
        servers: { 'srv-1': serverMetrics({ serverId: 'srv-1', ramByInstance: [
          { instanceId: 'i-1', blueprintId: 'bp-1', ramMb: 100 },
          { instanceId: 'i-2', blueprintId: 'bp-1', ramMb: 100 },
        ] }) },
        instances: {
          'i-1': instanceMetrics({ instanceId: 'i-1', rps: 30, p50Ms: 100 }),
          'i-2': instanceMetrics({ instanceId: 'i-2', rps: 10, p50Ms: 20 }),
        },
      }),
    ]
    const scope: DockScope = { kind: 'server', regionId: 'r1', azId: 'az1', serverId: 'srv-1' }
    // weighted mean = (30*100 + 10*20) / 40 = 80
    expect(extractSeries(frames, scope, 'p50Ms')).toEqual([{ simMs: 1000, value: 80 }])
    // rps is summed, not weighted-averaged
    expect(extractSeries(frames, scope, 'rps')).toEqual([{ simMs: 1000, value: 40 }])
  })

  it('resolves region scope directly off batch.regions', () => {
    const frames = [
      frame(1000, {
        regions: { r1: { regionId: 'r1', rps: 42, errorRate: 0.1, p50Ms: 55, p90Ms: 90, healthScore: 100, health: 'healthy', inboundByPopulation: [] } },
      }),
    ]
    const scope: DockScope = { kind: 'region', regionId: 'r1' }
    expect(extractSeries(frames, scope, 'rps')).toEqual([{ simMs: 1000, value: 42 }])
    expect(extractSeries(frames, scope, 'p90Ms')).toEqual([{ simMs: 1000, value: 90 }])
    // RegionMetrics has no p99Ms rollup -- must not crash, must not fabricate a value
    expect(extractSeries(frames, scope, 'p99Ms')).toEqual([])
  })

  it('resolves az scope directly off batch.azs', () => {
    const frames = [
      frame(1000, {
        azs: { az1: { azId: 'az1', rps: 7, errorRate: 0, p50Ms: 12, p90Ms: 20, healthScore: 100, health: 'healthy', serverCount: 1, instanceCount: 1 } },
      }),
    ]
    const scope: DockScope = { kind: 'az', regionId: 'r1', azId: 'az1' }
    expect(extractSeries(frames, scope, 'p50Ms')).toEqual([{ simMs: 1000, value: 12 }])
  })
})

describe('downsample', () => {
  it('preserves a single-frame spike after downsampling to fewer buckets', () => {
    const points = Array.from({ length: 300 }, (_, i) => ({ simMs: i * 1000, value: i === 150 ? 500 : 10 }))
    const buckets = downsample(points, 50)
    expect(buckets.length).toBe(50)
    const spikeBucket = buckets.find(b => b.max >= 500)
    expect(spikeBucket).toBeDefined()
    expect(spikeBucket!.max).toBe(500)
    // every non-spike bucket's min should still read the flat baseline
    expect(buckets.filter(b => b.max < 500).every(b => b.min === 10)).toBe(true)
  })

  it('is a pass-through when targetWidth >= point count', () => {
    const points = [{ simMs: 0, value: 1 }, { simMs: 1000, value: 2 }]
    const buckets = downsample(points, 300)
    expect(buckets).toEqual([
      { simMs: 0, min: 1, max: 1, value: 1 },
      { simMs: 1000, min: 2, max: 2, value: 2 },
    ])
  })

  it('returns an empty array for an empty input', () => {
    expect(downsample([], 50)).toEqual([])
  })
})
