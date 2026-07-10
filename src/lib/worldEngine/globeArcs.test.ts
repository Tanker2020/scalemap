// Phase 5 T2: buildArcs v2 — inter-region + drain arcs, appended after the unchanged client
// arcs (D4). This file doesn't import fixtures/helpers from index.test.ts or
// serverParticles.test.ts (nothing there is exported) — the fixtures below are local
// copies/variants, the same convention every worldEngine test file already uses.
import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { REGION_GEO } from '../world/regionGeo'
import type { WorldDoc } from '../world/types'
import type { MetricsBatch, EngineEvent, FramePayload, VisualArc } from './types'

// A public-facing entry blueprint: the facade routes client demand only to blueprints that
// expose a 'public' port. Verbatim from index.test.ts.
function publicBlueprint(name: string, colorIndex: number) {
  const bp = createBlueprint(name, colorIndex)
  bp.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  return bp
}

// 2 regions / 3 AZ / 4 servers / 3 blueprints (web[entry] -> api -> db), one US population.
// Verbatim copy of index.test.ts's e2eFixture — every web instance's 'd-api' dependency
// mesh-resolves to ALL api instances everywhere (compileWorld has no region scoping), so this
// fixture inherently produces BOTH client arcs (population -> its resolved region) AND
// inter-region arcs (region-1 web instances calling region-2's api instance, and vice versa) —
// useful for the "client arcs unchanged" and "deterministic" cases below.
function e2eFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'geo'
  doc.routing.dnsTtlSec = 5

  const r1 = createRegion('us-east-1')
  const r2 = createRegion('eu-west-1')
  const az1a = createAz(r1.id, 'us-east-1a')
  const az1b = createAz(r1.id, 'us-east-1b')
  const az2a = createAz(r2.id, 'eu-west-1a')
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
  Object.assign(doc.azs, { [az1a.id]: az1a, [az1b.id]: az1b, [az2a.id]: az2a })

  const s1 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s2 = createServer(az1b.id, getPreset('dedicated-8')!)
  const s3 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s4 = createServer(az2a.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3, [s4.id]: s4 })

  const web = publicBlueprint('web', 0)
  const api = createBlueprint('api', 1)
  const db = createBlueprint('db', 2)
  web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })

  const place = (bpId: string, serverId: string) => {
    const pl = createPlacement(bpId, serverId)
    doc.placements[pl.id] = pl
    return pl
  }
  const web1a = place(web.id, s1.id); place(api.id, s1.id); place(db.id, s3.id)
  const web1b = place(web.id, s2.id); place(api.id, s2.id)
  const web2 = place(web.id, s4.id); place(api.id, s4.id); place(db.id, s4.id)

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 120
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2, az1a, az1b, pop, web1aInst: instanceId(web1a.id, 0), web1bInst: instanceId(web1b.id, 0), web2Inst: instanceId(web2.id, 0) }
}

// web (public, region1) with two dependencies, both resolving only to region2 blueprints — every
// admitted request crosses regions on BOTH dependencies, so aggregation must collapse the 2
// downstream rows into ONE (region1 -> region2) arc.
function crossRegionFixture() {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'geo'

  const r1 = createRegion('us-east-1')
  const r2 = createRegion('eu-west-1')
  const az1 = createAz(r1.id, 'us-east-1a')
  const az2 = createAz(r2.id, 'eu-west-1a')
  Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
  Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2 })

  const s1 = createServer(az1.id, getPreset('dedicated-8')!)
  const s2 = createServer(az2.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = publicBlueprint('web', 0)
  const api1 = createBlueprint('api1', 1)
  const api2 = createBlueprint('api2', 2)
  web.dependencies = [
    { id: 'd-api1', target: { kind: 'blueprint', blueprintId: api1.id }, port: 8080, protocol: 'http', packetTemplateId: null },
    { id: 'd-api2', target: { kind: 'blueprint', blueprintId: api2.id }, port: 8080, protocol: 'http', packetTemplateId: null },
  ]
  Object.assign(doc.blueprints, { [web.id]: web, [api1.id]: api1, [api2.id]: api2 })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  place(web.id, s1.id)
  place(api1.id, s2.id)
  place(api2.id, s2.id)

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 100
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2 }
}

// Everything in ONE region — compileWorld's mesh can only ever produce same-region hops here
// (localhost/same-az/cross-az), never cross-region. popCount lets the cap test crank population
// count without touching the rest of the topology.
function singleRegionFixture(popCount: number) {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  doc.routing.policy = 'geo'
  doc.routing.dnsTtlSec = 5

  const r1 = createRegion('us-east-1')
  const az1a = createAz(r1.id, 'us-east-1a')
  const az1b = createAz(r1.id, 'us-east-1b')
  Object.assign(doc.regions, { [r1.id]: r1 })
  Object.assign(doc.azs, { [az1a.id]: az1a, [az1b.id]: az1b })

  const s1 = createServer(az1a.id, getPreset('dedicated-8')!)
  const s2 = createServer(az1b.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = publicBlueprint('web', 0)
  const api = createBlueprint('api', 1)
  web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  place(web.id, s1.id); place(api.id, s1.id)
  place(web.id, s2.id); place(api.id, s2.id)

  for (let i = 0; i < popCount; i++) {
    const pop = createPopulation(`pop-${i}`, 40.7 + i * 0.01, -74.0 - i * 0.01)
    pop.peakRps = 10
    doc.populations[pop.id] = pop
  }

  const compiled = compileWorld(doc)
  return { doc, compiled, r1 }
}

function drive(doc: WorldDoc, compiled: ReturnType<typeof compileWorld>) {
  const engine = createWorldEngine(1)
  const batches: MetricsBatch[] = []
  const events: EngineEvent[] = []
  engine.start(doc, compiled, {
    onMetrics: b => batches.push(b),
    onEvent: e => events.push(e),
    onHealthChange: () => {},
  })
  const stepFor = (seconds: number) => engine.__test_step(seconds * 10)   // 100ms steps
  return { engine, batches, events, stepFor, latest: () => batches[batches.length - 1] }
}

// Verbatim re-implementation of the PRE-Phase-5 buildArcs' client-arc logic, fed by the same
// populationRoutes shape the engine publishes on MetricsBatch.world (WorldMetrics.populationRoutes
// — frozen contract, the same data buildArcs' engine-internal lastRoutingSnapshot holds). Used as
// an independent regression oracle instead of diffing against git history.
function computeExpectedClientArcs(doc: WorldDoc, routes: MetricsBatch['world']['populationRoutes']): VisualArc[] {
  const maxRps = Math.max(1, ...routes.map(r => r.rps))
  const arcs: VisualArc[] = []
  for (const r of routes) {
    if (r.populationId.startsWith('baseline:')) continue
    const pop = doc.populations[r.populationId]
    const region = doc.regions[r.regionId]
    const geo = region ? REGION_GEO[region.catalogId] : undefined
    if (!pop || !geo) continue
    arcs.push({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geo.lat, geo.lon], intensity: Math.min(1, r.rps / maxRps), kind: 'client' })
  }
  return arcs
}

describe('buildArcs v2 (globe scope)', () => {
  it('client arcs unchanged for the baseline fixture', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    const expected = computeExpectedClientArcs(f.doc, sim.latest().world.populationRoutes)
    expect(frame.arcs.filter(a => a.kind === 'client')).toEqual(expected)
    sim.engine.stop()
  })

  it('cross-region dependency produces an inter-region arc with aggregated rps', () => {
    const f = crossRegionFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    const interArcs = frame.arcs.filter(a => a.kind === 'inter-region')
    // Both dependencies (d-api1, d-api2) land on region2 — one aggregated arc, not two.
    expect(interArcs).toHaveLength(1)
    const geoR1 = REGION_GEO['us-east-1']
    const geoR2 = REGION_GEO['eu-west-1']
    expect(interArcs[0]).toMatchObject({ fromLatLon: [geoR1.lat, geoR1.lon], toLatLon: [geoR2.lat, geoR2.lon], intensity: 1 })
    sim.engine.stop()
  })

  it('no inter-region arcs when all flows are intra-region', () => {
    const f = singleRegionFixture(1)
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    expect(frame.arcs.some(a => a.kind === 'inter-region')).toBe(false)
    sim.engine.stop()
  })

  it('population routed at a down region emits a drain arc until TTL expiry', () => {
    const f = singleRegionFixture(1)
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                   // warm the DNS cache -> r1
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(2)                                    // still inside the 5s TTL -> cache lags
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    const pop = Object.values(f.doc.populations)[0]
    const geoR1 = REGION_GEO['us-east-1']
    const drainArcs = frame.arcs.filter(a => a.kind === 'drain')
    expect(drainArcs).toHaveLength(1)
    expect(drainArcs[0]).toMatchObject({ fromLatLon: [pop.lat, pop.lon], toLatLon: [geoR1.lat, geoR1.lon], intensity: 1 })
    sim.engine.stop()
  })

  it('drain arc from old to new region during pending failover, then clears', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                    // warm DNS cache -> us-east-1
    sim.engine.setOutage('region', f.r1.id, true)

    // Step one 100ms tick at a time until failover_started fires (the TTL-expiry re-resolve) —
    // avoids hardcoding the exact ms boundary; 100 steps (10s) is a generous safety margin over
    // the ~2-6s window index.test.ts's "honors DNS TTL" test observes for this same fixture.
    let startedFrame: FramePayload | null = null
    for (let i = 0; i < 100 && !startedFrame; i++) {
      sim.engine.__test_step(1)
      sim.engine.__test_render(1000)
      if (sim.events.some(e => e.kind === 'failover_started')) startedFrame = frames[frames.length - 1]
    }
    expect(startedFrame).not.toBeNull()
    const drainAtFlip = startedFrame!.arcs.filter(a => a.kind === 'drain')
    expect(drainAtFlip).toHaveLength(1)
    const geoR1 = REGION_GEO['us-east-1']
    const geoR2 = REGION_GEO['eu-west-1']
    expect(drainAtFlip[0]).toMatchObject({ fromLatLon: [geoR1.lat, geoR1.lon], toLatLon: [geoR2.lat, geoR2.lon], intensity: 1 })

    // Step until failover_completed fires; the drain arc must be gone by then.
    let completedFrame: FramePayload | null = null
    for (let i = 0; i < 100 && !completedFrame; i++) {
      sim.engine.__test_step(1)
      sim.engine.__test_render(1000)
      if (sim.events.some(e => e.kind === 'failover_completed')) completedFrame = frames[frames.length - 1]
    }
    expect(completedFrame).not.toBeNull()
    expect(completedFrame!.arcs.some(a => a.kind === 'drain')).toBe(false)
    sim.engine.stop()
  })

  it('cap truncates drain last, keeping client arcs first', () => {
    const f = singleRegionFixture(150)
    const sim = drive(f.doc, f.compiled)
    const frames: FramePayload[] = []
    sim.engine.attachRenderer({ level: 'globe' }, p => frames.push(p))
    sim.stepFor(3)                                    // warm DNS caches -> r1 for all 150 pops
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(1)                                     // still well inside the 5s TTL for every pop
    sim.engine.__test_render(1000)
    const frame = frames[frames.length - 1]
    // 150 client arcs + 150 drain candidates (case b, all still routed to the now-down r1) = 300
    // requested; MAX_GLOBE_ARCS = 200 (index.ts, private) caps the total, order client -> inter-
    // region -> drain: all 150 client kept, 0 inter-region (single region), 50 of 150 drain kept.
    expect(frame.arcs).toHaveLength(200)
    expect(frame.arcs.slice(0, 150).every(a => a.kind === 'client')).toBe(true)
    expect(frame.arcs.slice(150)).toHaveLength(50)
    expect(frame.arcs.slice(150).every(a => a.kind === 'drain')).toBe(true)
    sim.engine.stop()
  })

  it('deterministic under fixed seed', () => {
    const run = (): VisualArc[] => {
      const f = e2eFixture()
      const sim = drive(f.doc, f.compiled)
      let last: FramePayload | undefined
      sim.engine.attachRenderer({ level: 'globe' }, p => { last = p })
      sim.stepFor(5)
      sim.engine.__test_render(1000)
      sim.engine.stop()
      return last!.arcs
    }
    expect(run()).toEqual(run())
  })
})
