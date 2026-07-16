import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
  createLoadBalancer,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { addRoute, routeIdOf } from '../nodeConfig'
import type { WorldDoc } from '../world/types'
import type { MetricsBatch, EngineEvent } from './types'

// A public-facing entry blueprint: the facade routes client demand only to blueprints that
// expose a 'public' port (documented entry rule).
function publicBlueprint(name: string, colorIndex: number) {
  const bp = createBlueprint(name, colorIndex)
  bp.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  return bp
}

// 2 regions / 3 AZ / 4 servers / 3 blueprints (web[entry] -> api -> db). One US population.
function e2eFixture() {
  const doc = createWorld()
  doc.routing.policy = 'geo'
  doc.routing.dnsTtlSec = 5                  // short TTL so the failover lag is observable within 30s

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

  // web + api + db present in both region-1 AZs and in region-2 (so failover has somewhere to land).
  const place = (bpId: string, serverId: string) => {
    const pl = createPlacement(bpId, serverId)
    doc.placements[pl.id] = pl
    return pl
  }
  const web1a = place(web.id, s1.id); place(api.id, s1.id); place(db.id, s3.id)
  const web1b = place(web.id, s2.id); place(api.id, s2.id)
  const web2 = place(web.id, s4.id); place(api.id, s4.id); place(db.id, s4.id)

  const pop = createPopulation('nyc', 40.7, -74.0)   // near us-east-1
  pop.peakRps = 120
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return { doc, compiled, r1, r2, az1a, az1b, pop, web1aInst: instanceId(web1a.id, 0), web1bInst: instanceId(web1b.id, 0), web2Inst: instanceId(web2.id, 0) }
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
  const stepFor = (seconds: number) => engine.__test_step(seconds * 10)  // 100ms steps
  return { engine, batches, events, stepFor, latest: () => batches[batches.length - 1] }
}

// Minimal 2-AZ region with a single public entry blueprint and NO downstream dependencies, so
// world.totalRps is exactly the ingress that LANDED (no internal fan-out to inflate it). The
// default synthesized LB is L4 / cross-zone OFF.
function twoAzIngress(entryInBothAzs: boolean) {
  const doc = createWorld()
  doc.routing.policy = 'geo'
  const r = createRegion('us-east-1')
  const az1 = createAz(r.id, 'us-east-1a')
  const az2 = createAz(r.id, 'us-east-1b')
  doc.regions[r.id] = r; doc.azs[az1.id] = az1; doc.azs[az2.id] = az2
  const s1 = createServer(az1.id, getPreset('dedicated-8')!)
  const s2 = createServer(az2.id, getPreset('dedicated-8')!)
  doc.servers[s1.id] = s1; doc.servers[s2.id] = s2
  const web = publicBlueprint('web', 0); doc.blueprints[web.id] = web
  const p1 = createPlacement(web.id, s1.id); doc.placements[p1.id] = p1
  const p2 = entryInBothAzs ? createPlacement(web.id, s2.id) : null
  if (p2) doc.placements[p2.id] = p2
  const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 500; doc.populations[pop.id] = pop
  return { doc, compiled: compileWorld(doc), az1: az1.id, az2: az2.id, web1: instanceId(p1.id, 0), web2: p2 ? instanceId(p2.id, 0) : null }
}

describe('cross-zone-off ingress distribution', () => {
  it('splits ingress ~50/50 when the entry service is in BOTH AZs (no traffic lost)', () => {
    const f = twoAzIngress(true)
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)   // let the metrics EMA settle toward the flat 500 rps demand
    const b = sim.latest()
    expect(b.instances[f.web1!].rps).toBeGreaterThan(200)
    expect(b.instances[f.web1!].rps).toBeLessThan(300)
    expect(b.instances[f.web2!].rps).toBeGreaterThan(200)
    expect(b.instances[f.web2!].rps).toBeLessThan(300)
    expect(b.world.totalRps).toBeGreaterThan(450)   // ~all 500 landed
    sim.engine.stop()
  })

  it('forfeits the AZ share with no entry target — HALF the ingress is dropped (cross-zone off)', () => {
    const f = twoAzIngress(false)   // entry only in az1
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)
    const b = sim.latest()
    // az1's node gets perAz = 250 → web1 ≈ 250; az2's node has no target → its 250 is dropped.
    expect(b.instances[f.web1!].rps).toBeGreaterThan(200)
    expect(b.instances[f.web1!].rps).toBeLessThan(300)
    expect(b.world.totalRps).toBeGreaterThan(200)
    expect(b.world.totalRps).toBeLessThan(300)       // only ~250 of the 500 landed
    expect(b.azs[f.az2].rps).toBe(0)                 // az2 processed nothing
    sim.engine.stop()
  })
})

describe('world engine integration', () => {
  it('flows client rps end-to-end through the compiled world', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    const b = sim.latest()
    expect(b).toBeDefined()
    expect(b.world.totalRps).toBeGreaterThan(0)
    expect(b.regions[f.r1.id].rps).toBeGreaterThan(0)            // US population lands in us-east-1
    expect(b.world.populationRoutes.find(r => r.populationId === f.pop.id)?.regionId).toBe(f.r1.id)
    sim.engine.stop()
  })

  it('redistributes within 3s when an AZ is killed (region keeps serving)', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(4)
    const before = sim.latest().regions[f.r1.id].rps
    expect(before).toBeGreaterThan(0)
    sim.engine.setOutage('az', f.az1a.id, true)
    sim.stepFor(3)
    const after = sim.latest().regions[f.r1.id].rps
    // az1b still carries region-1 traffic — region rps is not wiped out
    expect(after).toBeGreaterThan(before * 0.3)
    expect(sim.latest().azs[f.az1a.id].health).toBe('down')
    sim.engine.stop()
  })

  it('honors DNS TTL: killing a region shifts populationRoutes only after dnsTtlSec', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)                                    // warm the DNS cache -> us-east-1
    const routeOf = () => sim.latest().world.populationRoutes.find(r => r.populationId === f.pop.id)?.regionId
    expect(routeOf()).toBe(f.r1.id)
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(2)                                    // still inside the 5s TTL -> cache lags
    expect(routeOf()).toBe(f.r1.id)                   // the OBSERVABLE failover lag (spec D8)
    sim.stepFor(6)                                    // past TTL -> re-resolves to eu-west-1
    expect(routeOf()).toBe(f.r2.id)
    expect(sim.events.some(e => e.kind === 'ttl_lag_expired')).toBe(true)
    expect(sim.events.some(e => e.kind === 'failover_started')).toBe(true)
    sim.engine.stop()
  })

  it('recovers a killed region after the outage is cleared, even once health checks have latched', () => {
    // Regression (surfaced by the Polish 2 phase gate): runHealthChecks was fed the COMPUTED
    // health, whose checkFailed input is the check system's own output — once 3 checks failed
    // (interval 10s x threshold 3), clearing the outage could never reset the counter and the
    // region stayed down forever. The probe now reads the raw signal (manual outage +
    // error/pressure), so recovery drains the counter and hysteresis brings the region back.
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(32)                                   // past 3 check intervals -> checkFailed latches
    expect(sim.latest().regions[f.r1.id].health).toBe('down')
    sim.engine.setOutage('region', f.r1.id, false)
    sim.stepFor(20)                                   // next due check resets + 5s recovery hysteresis
    expect(sim.latest().regions[f.r1.id].health).toBe('healthy')
    // and the geo-routed population comes home once its TTL re-expires
    const route = sim.latest().world.populationRoutes.find(r => r.populationId === f.pop.id)?.regionId
    expect(route).toBe(f.r1.id)
    sim.engine.stop()
  })

  // An L7 world: one AZ, two entry services (api on its own server, cdn on its own server), a
  // route catalog with /api/data + /static/logo.png, and an L7 LB whose listener rules send each
  // path to its service. `apiWeight`/`cdnWeight` set the population's request mix; extraRoute lets
  // a test add a class that matches no listener rule. Returns the two instance ids for per-service
  // rps asserts.
  function l7Fixture(opts: { apiWeight: number; cdnWeight: number; extra?: { path: string; weight: number }; defaultTarget?: 'api' | 'none' }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sApi = createServer(az.id, getPreset('dedicated-8')!)
    const sCdn = createServer(az.id, getPreset('dedicated-8')!)
    Object.assign(doc.servers, { [sApi.id]: sApi, [sCdn.id]: sCdn })
    const api = publicBlueprint('api', 0)
    const cdn = publicBlueprint('cdn', 1)
    Object.assign(doc.blueprints, { [api.id]: api, [cdn.id]: cdn })
    const plApi = createPlacement(api.id, sApi.id); doc.placements[plApi.id] = plApi
    const plCdn = createPlacement(cdn.id, sCdn.id); doc.placements[plCdn.id] = plCdn

    const rApi = addRoute(doc.packets, { name: 'api', method: 'GET', path: '/api/data' }); doc.packets = rApi.registry
    const rCdn = addRoute(doc.packets, { name: 'static', method: 'GET', path: '/static/logo.png' }); doc.packets = rCdn.registry
    const mix = [
      { routeId: routeIdOf(rApi.route), weight: opts.apiWeight },
      { routeId: routeIdOf(rCdn.route), weight: opts.cdnWeight },
    ]
    if (opts.extra) {
      const rX = addRoute(doc.packets, { name: 'extra', method: 'GET', path: opts.extra.path }); doc.packets = rX.registry
      mix.push({ routeId: routeIdOf(rX.route), weight: opts.extra.weight })
    }
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 120
    pop.requestMix = mix.filter(m => m.weight > 0)
    doc.populations[pop.id] = pop

    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [
      { id: 'r-api', pathPattern: '/api/*', targetBlueprintId: api.id },
      { id: 'r-static', pathPattern: '/static/*', targetBlueprintId: cdn.id },
    ]
    // default action: api (present) unless the test wants an empty default to observe a drop
    lb.defaultTargetBlueprintId = opts.defaultTarget === 'none' ? 'bp-does-not-exist' : api.id
    doc.loadBalancers[lb.id] = lb

    return { doc, compiled: compileWorld(doc), apiInst: instanceId(plApi.id, 0), cdnInst: instanceId(plCdn.id, 0) }
  }

  it('L7: routes each request-mix class to its listener-rule target group', () => {
    const f = l7Fixture({ apiWeight: 1, cdnWeight: 3 })   // 25% /api, 75% /static
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    const b = sim.latest()
    const apiRps = b.instances[f.apiInst].rps
    const cdnRps = b.instances[f.cdnInst].rps
    expect(apiRps).toBeGreaterThan(0)
    expect(cdnRps).toBeGreaterThan(0)
    expect(cdnRps / apiRps).toBeGreaterThan(2)   // ~3:1
    expect(cdnRps / apiRps).toBeLessThan(4)
    sim.engine.stop()
  })

  it('L7: an unmatched request-mix route falls through to the default action', () => {
    // 100% of traffic on /health/* — matches neither /api/* nor /static/* — so it lands on the
    // default action (api). The cdn service, which owns no matching rule for this class, gets none.
    const f = l7Fixture({ apiWeight: 0, cdnWeight: 0, extra: { path: '/health/live', weight: 1 } })
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    const b = sim.latest()
    expect(b.instances[f.apiInst].rps).toBeGreaterThan(0)   // landed on the default target
    expect(b.instances[f.cdnInst].rps).toBe(0)
    sim.engine.stop()
  })

  it('L7: a route matching no rule and an empty default target group is dropped', () => {
    const f = l7Fixture({ apiWeight: 0, cdnWeight: 0, extra: { path: '/health/live', weight: 1 }, defaultTarget: 'none' })
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    const b = sim.latest()
    expect(b.instances[f.apiInst].rps).toBe(0)
    expect(b.instances[f.cdnInst].rps).toBe(0)
    expect(b.regions[f.compiled.instances[f.apiInst].regionId].rps).toBe(0)   // nothing served
    sim.engine.stop()
  })

  it('OOM-kills the largest consumer under a RAM-starved fixture and restarts it', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    // Tiny-RAM server + a RAM-hungry entry blueprint under heavy client load -> host OOM.
    const server = createServer(az.id, getPreset('vps-small')!)
    server.specs.ramMb = 256
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    // Base alone (220) fits in 256, but even a fraction of a connection pushes it over — a
    // deterministic host-OOM regardless of the sampled service latency.
    web.workload = { cpuMsPerRequest: 2, ramBaseMb: 220, ramPerConnMb: 150, diskIoPerRequest: 0 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 400
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    sim.stepFor(2)
    expect(sim.events.some(e => e.kind === 'oom_kill')).toBe(true)
    sim.stepFor(6)                                    // > 5s restart delay
    expect(sim.events.some(e => e.kind === 'instance_restarted')).toBe(true)
    sim.engine.stop()
  })
})
