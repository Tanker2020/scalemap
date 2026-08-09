import { describe, it, expect } from 'vitest'
import { docFingerprint, buildRunSummary } from './runSummary'
import { compileWorld } from './world/compileWorld'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from './world/factories'
import { getPreset } from './world/instanceCatalog'
import { createWorldEngine } from './worldEngine/index'
import type { WorldDoc } from './world/types'
import type { ReplayFrame, MetricsBatch } from './worldEngine/types'

// Mirrors compileWorld.test.ts's tinyWorld()/e2eFixture() conventions: build a doc from the real
// factories, not hand-rolled object literals, so this test tracks the real WorldDoc shape.
function buildTwoTierWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const webServer = createServer(az.id, getPreset('vps-medium')!)
  const dbServer = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[webServer.id] = webServer
  doc.servers[dbServer.id] = dbServer

  const web = createBlueprint('web', 0)
  web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  const db = createBlueprint('db', 1)
  doc.blueprints[web.id] = web
  doc.blueprints[db.id] = db

  const webPl = createPlacement(web.id, webServer.id)
  const dbPl = createPlacement(db.id, dbServer.id)
  doc.placements[webPl.id] = webPl
  doc.placements[dbPl.id] = dbPl

  return { doc, region, az, webServer, dbServer, web, db, webPl, dbPl }
}

function addAnotherReplica(doc: WorldDoc): WorldDoc {
  const cloned: WorldDoc = JSON.parse(JSON.stringify(doc))
  const webPl = Object.values(cloned.placements)[0]
  webPl.count = (webPl.count ?? 1) + 1
  return cloned
}

describe('docFingerprint', () => {
  it('is stable across a cosmetic rename and changes when structure changes', () => {
    const { doc } = buildTwoTierWorld()
    const compiled = compileWorld(doc)
    const fp1 = docFingerprint(compiled)

    // Cosmetic rename: AZ label is display-only, never read by docFingerprint.
    const azId = Object.keys(doc.azs)[0]
    const renamed: WorldDoc = {
      ...doc,
      azs: { ...doc.azs, [azId]: { ...doc.azs[azId], label: 'renamed-az' } },
    }
    const fp2 = docFingerprint(compileWorld(renamed))
    expect(fp2).toBe(fp1)

    // Structural change: another replica of the web placement adds a new instance.
    const scaled = addAnotherReplica(doc)
    const fp3 = docFingerprint(compileWorld(scaled))
    expect(fp3).not.toBe(fp1)
  })
})

// ─── buildRunSummary: time-weighted latency ────────────────────────────────────

function buildFrames({ count, p50Ms, p99Ms, startMs = 0 }: {
  count: number; p50Ms: number; p99Ms: number; startMs?: number
}): ReplayFrame[] {
  const frames: ReplayFrame[] = []
  for (let i = 0; i < count; i++) {
    const simMs = startMs + i * 1000
    const batch: MetricsBatch = {
      simMs,
      instances: {
        'inst-1': {
          instanceId: 'inst-1',
          rps: 100,
          errorRate: 0,
          p50Ms,
          p99Ms,
          activeConnections: 10,
          cpuCoresUsed: 1,
          ramMb: 256,
          health: 'healthy',
        },
      },
      servers: {},
      azs: {},
      regions: {},
      world: {
        totalRps: 100,
        errorRate: 0,
        populationRoutes: [],
        crossAzBytesPerSec: 0,
        crossRegionBytesPerSec: 0,
        internetEgressBytesPerSec: 0,
      },
    }
    frames.push({ simMs, batch, events: [] })
  }
  return frames
}

describe('buildRunSummary — time-weighted latency', () => {
  it('time-weights latency: a 10s spike in a 300s run stays close to the calm value', () => {
    const { doc } = buildTwoTierWorld()
    const compiled = compileWorld(doc)
    const calmFrames = buildFrames({ count: 290, p50Ms: 20, p99Ms: 40 })
    const spikeFrames = buildFrames({ count: 10, p50Ms: 20, p99Ms: 2000, startMs: 290_000 })
    const frames = [...calmFrames, ...spikeFrames]

    const summary = buildRunSummary(frames, doc, compiled, 'test')
    // naive mean-of-frames would be (290*40 + 10*2000)/300 ~= 105.7ms. The run-level p99 is a
    // request-weighted quantile over all frames (weight = rps * dt per frame), not a mean or a
    // frame-count average: with every frame carrying equal weight here (same constant rps), the
    // spike frames are only 10/300 ~= 3.3% of the total request mass, so the weighted-quantile
    // cutoff falls well inside the calm frames and the run-level p99 stays close to the calm
    // value (40) rather than being dragged toward the spike value.
    expect(summary.latency.p99Ms).toBeLessThan(70)
    expect(summary.latency.p99Ms).toBeGreaterThan(38)
  })

  it('a run with more spike-seconds reports a materially worse p99 than one with fewer', () => {
    const { doc } = buildTwoTierWorld()
    const compiled = compileWorld(doc)

    const fewSpikeFrames = [
      ...buildFrames({ count: 290, p50Ms: 20, p99Ms: 40 }),
      ...buildFrames({ count: 10, p50Ms: 20, p99Ms: 2000, startMs: 290_000 }),
    ]
    const manySpikeFrames = [
      ...buildFrames({ count: 100, p50Ms: 20, p99Ms: 40 }),
      ...buildFrames({ count: 200, p50Ms: 20, p99Ms: 2000, startMs: 100_000 }),
    ]

    const fewSpikeSummary = buildRunSummary(fewSpikeFrames, doc, compiled, 'few-spikes')
    const manySpikeSummary = buildRunSummary(manySpikeFrames, doc, compiled, 'many-spikes')

    // The whole point of a request-weighted rollup: a run that spent two-thirds of its seconds
    // spiking must summarize materially worse than one that spent 3.3% of its seconds spiking,
    // given the same spike magnitude. (The prior bulk/tail-split implementation reported 40ms for
    // BOTH.) The split here (200/300 spike frames, well clear of the 50/50 mass boundary) is
    // deliberately NOT exactly balanced: weightedQuantile's cum > threshold comparison decides
    // ties at exact 50/50 mass splits by floating-point exactness of the accumulated weights, so
    // a fixture sitting on that boundary would pass or fail by luck rather than by the rollup
    // actually weighting spike-frame requests correctly. With spike frames holding a clear
    // request-mass majority, the p99 must land on the spike side regardless of any FP rounding.
    expect(manySpikeSummary.latency.p99Ms).toBeGreaterThan(fewSpikeSummary.latency.p99Ms + 500)
  })
})

// ─── buildRunSummary: SLO breach evaluation ────────────────────────────────────

describe('buildRunSummary — SLO breach evaluation', () => {
  it('flags a p99Ms breach only for the seconds that actually exceed the target', () => {
    const { doc } = buildTwoTierWorld()
    doc.slo = { p99Ms: 100 }
    const compiled = compileWorld(doc)
    const calmFrames = buildFrames({ count: 20, p50Ms: 20, p99Ms: 40 })
    const breachFrames = buildFrames({ count: 5, p50Ms: 20, p99Ms: 500, startMs: 20_000 })
    const summary = buildRunSummary([...calmFrames, ...breachFrames], doc, compiled, 'test')

    expect(summary.slo.breaches).toHaveLength(1)
    const breach = summary.slo.breaches[0]
    expect(breach.key).toBe('p99Ms')
    expect(breach.worst).toBe(500)
    expect(breach.breachedSec).toBeCloseTo(5, 0)
  })

  it('reports no breaches when no SLO targets are set', () => {
    const { doc } = buildTwoTierWorld()
    const compiled = compileWorld(doc)
    const frames = buildFrames({ count: 5, p50Ms: 20, p99Ms: 40 })
    const summary = buildRunSummary(frames, doc, compiled, 'test')
    expect(summary.slo.breaches).toEqual([])
    expect(summary.slo.target).toEqual({})
  })
})

// ─── buildRunSummary: active-environment cost overlay ──────────────────────────

describe('buildRunSummary — active-environment cost overlay', () => {
  it('reports higher cost when the active environment swaps a server to a pricier instance class', () => {
    // costModelV2's computeWorldCost bills a server's hourlyUsd flat per box (not per placement
    // count, unless autoscaled) -- so instanceClassOverrides (which rewrites hourlyUsd via
    // getPreset, see environments.ts) is the reliable lever to prove the overlay is applied,
    // where serverCountFactor alone would not move recorded cost for a non-autoscaled placement.
    const { doc, webServer } = buildTwoTierWorld()
    const compiled = compileWorld(doc)
    const frames = buildFrames({ count: 5, p50Ms: 20, p99Ms: 40 })
    const baseline = buildRunSummary(frames, doc, compiled, 'baseline')

    // vps-medium (webServer's preset) is 0.036/hr; dedicated-32 is 1.32/hr -- a large, unmissable
    // delta if the overlay is applied, and a zero delta (test failure) if it silently isn't.
    const scaledDoc: WorldDoc = {
      ...doc,
      environments: {
        env1: { id: 'env1', label: 'Upsized', instanceClassOverrides: { [webServer.id]: 'dedicated-32' } },
      },
      activeEnvironmentId: 'env1',
    }
    const scaledCompiled = compileWorld(scaledDoc)
    const scaled = buildRunSummary(frames, scaledDoc, scaledCompiled, 'scaled')

    // Sanity: the raw doc's server was left untouched by constructing scaledDoc (applyEnvironment
    // returns a NEW doc/servers map, never mutates the input) -- otherwise this test could pass
    // for the wrong reason (mutating shared fixture state) instead of the overlay actually working.
    expect(webServer.catalogId).not.toBe('dedicated-32')

    expect(scaled.cost.meanHourlyUsd).toBeGreaterThan(baseline.cost.meanHourlyUsd)
    expect(scaled.cost.peakHourlyUsd).toBeGreaterThan(baseline.cost.peakHourlyUsd)
  })
})

// ─── buildRunSummary: determinism (the feature's core precondition) ───────────

describe('buildRunSummary — determinism', () => {
  // Mirrors index.test.ts's FEAT-003 scenario fixture/helper conventions (scenarioFixture /
  // runFullScenario) for a minimal-but-real scenario+seed run.
  function publicBlueprint(name: string, colorIndex: number) {
    const bp = createBlueprint(name, colorIndex)
    bp.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    return bp
  }

  function scenarioFixture() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    web.workload = { ...web.workload, cpuMsPerRequest: 40 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 100
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    doc.scenario = { id: 's1', label: 'T', seed: 777, durationMs: 30_000, steps: [] }
    const compiled = compileWorld(doc)
    return { doc, compiled }
  }

  function runScenarioToFrames(doc: WorldDoc, compiled: ReturnType<typeof compileWorld>): ReplayFrame[] {
    const engine = createWorldEngine(0)
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })
    ;(engine as unknown as { __test_step: (n: number) => void }).__test_step(300) // 300 x 100ms = 30,000ms
    const frames = engine.getReplayFrames()
    engine.stop()
    return frames
  }

  it('two captures of the same scenario+seed+doc produce equal RunSummary metric fields', () => {
    const { doc, compiled } = scenarioFixture()
    const frames1 = runScenarioToFrames(doc, compiled)
    const frames2 = runScenarioToFrames(doc, compiled)
    expect(frames1.length).toBeGreaterThan(0)

    const s1 = buildRunSummary(frames1, doc, compiled, 'a')
    const s2 = buildRunSummary(frames2, doc, compiled, 'b')
    expect(s1.docFingerprint).toBe(s2.docFingerprint)
    expect(s1.latency).toEqual(s2.latency)
    expect(s1.errorRate).toBe(s2.errorRate)
    expect(s1.cost).toEqual(s2.cost)
    expect(s1.eventCounts).toEqual(s2.eventCounts)
  })
})
