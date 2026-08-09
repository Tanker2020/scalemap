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
    // naive mean-of-frames would be (290*40 + 10*2000)/300 ~= 105.7ms; because only ~1% of any
    // given frame's requests actually see its p99Ms value, the spike's true share of the run's
    // total REQUEST volume is far below 1%, so the run-level p99 should stay close to the calm
    // value (40) rather than being dragged toward the naive frame-count average.
    expect(summary.latency.p99Ms).toBeLessThan(70)
    expect(summary.latency.p99Ms).toBeGreaterThan(38)
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
