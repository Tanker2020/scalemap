import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
  createLoadBalancer,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { addRoute, routeIdOf } from '../nodeConfig'
import { computeWorldCost } from '../costModelV2'
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

  it('redistributes to the serving AZ when the entry target sits in only one AZ (nothing dropped)', () => {
    const f = twoAzIngress(false)   // entry only in az1
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)
    const b = sim.latest()
    // az2 has no entry target, so it is pulled from the regional LB's rotation (AWS drops a zone
    // with no healthy targets out of DNS) — az1's node absorbs the WHOLE ~500 rather than az2
    // forfeiting its half. Round-robin isn't broken; the empty AZ simply isn't in the split.
    expect(b.instances[f.web1!].rps).toBeGreaterThan(450)
    expect(b.world.totalRps).toBeGreaterThan(450)    // ~all 500 landed
    expect(b.azs[f.az2].rps ?? 0).toBe(0)            // az2 still processes nothing itself
    sim.engine.stop()
  })

  it('drops NOTHING at the LB when an AZ lacks the entry target — the empty AZ just leaves rotation', () => {
    const f = twoAzIngress(false)   // entry only in az1
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)
    const b = sim.latest()
    // No forfeiture: the ingress routed to az2 is redistributed to az1, not failed.
    expect(b.azs[f.az2].droppedRps ?? 0).toBeLessThan(1)
    expect(b.azs[f.az1].droppedRps ?? 0).toBeLessThan(1)
    // The region roll-up therefore stays healthy — no phantom ~50% error rate from LB drops.
    const region = b.regions[Object.keys(b.regions)[0]]
    expect(region.droppedRps ?? 0).toBeLessThan(1)
    expect(region.errorRate).toBeLessThan(0.05)
    expect(region.health).toBe('healthy')
    // The surviving web instance carries the redistributed load at full health.
    expect(b.instances[f.web1!].health).toBe('healthy')
    expect(b.instances[f.web1!].rps).toBeGreaterThan(450)
    sim.engine.stop()
  })
})

// Overload health from OFFERED load (not admitted, which is capped at capacity so pre-fix an
// overwhelmed server read cpuPressure ≈ 1.0 and stayed 'healthy'). A moderate sustained overload
// degrades the server via pressure BEFORE its bounded queue saturates into errors.
describe('overload health from offered load', () => {
  function overloadedServer(cpuMsPerRequest: number, peakRps: number) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)   // 8 vCPU, dedicated (no VPS noise)
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    web.workload = { ...web.workload, cpuMsPerRequest }             // capacity ≈ 8000 / cpuMs rps
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = peakRps; pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), webInst: instanceId(pl.id, 0) }
  }

  it('a moderate overload degrades the server via pressure while errors are still ~0', () => {
    // cpuMs 40 ⇒ capacity ≈ 200 rps; offered ≈ 280 (1.4×). Queue bound = 200 × 2 s = 400 req,
    // filling at ~80 req/s ⇒ ~5 s to saturate. At 4 s the queue is still absorbing (errorRate low)
    // but offered-based cpuPressure ≈ 1.4 ⇒ the instance reads 'degraded'.
    const f = overloadedServer(40, 280)
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(4)
    const inst = sim.latest().instances[f.webInst]
    expect(inst.health).toBe('degraded')       // from cpuPressure, not errors…
    expect(inst.errorRate).toBeLessThan(0.15)  // …queue not yet saturated
    expect(inst.p50Ms).toBeGreaterThan(50)     // standing queue raises latency
    sim.engine.stop()
  })

  it('a severe sustained overload drives the server down', () => {
    // cpuMs 40 ⇒ capacity ≈ 200; offered ≈ 600 (3×) ⇒ cpuPressure ≈ 3 (past DOWN_CPU_PRESSURE 2),
    // and the queue saturates into heavy errors — both paths converge on 'down'.
    const f = overloadedServer(40, 600)
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(6)
    expect(sim.latest().instances[f.webInst].health).toBe('down')
    sim.engine.stop()
  })
})

describe('pause/resume (stop preserves state; resume continues)', () => {
  it('stop halts without resetting the clock, and resume continues the same run', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    const atStop = sim.latest().simMs
    sim.engine.stop()
    expect(sim.engine.isRunning()).toBe(false)
    // stop() must PRESERVE state — the clock does not rewind (resume needs the frozen position).
    sim.engine.resume()
    expect(sim.engine.isRunning()).toBe(true)
    sim.stepFor(2)
    expect(sim.latest().simMs).toBeGreaterThan(atStop)   // continued forward, not restarted at 0
    sim.engine.stop()
  })

  it('resume is a no-op when never started or already running', () => {
    const engine = createWorldEngine(1)
    expect(() => engine.resume()).not.toThrow()   // never started
    const f = e2eFixture()
    engine.start(f.doc, f.compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })
    expect(engine.isRunning()).toBe(true)
    engine.resume()                                // already running
    expect(engine.isRunning()).toBe(true)
    engine.stop()
  })
})

// Audit ISSUE-001: a down downstream produced NON-blocked caller rows (the target's subtree is
// zeroed instead), so recordResult logged successes and the caller's breaker never opened. Step 8
// now feeds the breaker the target's observed error fraction.
describe('breaker trips on a down dependency (audit ISSUE-001)', () => {
  // 1 region / 1 AZ / 2 servers: web+api on s1, the SINGLE db candidate on s2 — killing s2
  // leaves the d-db dependency with nothing healthy to route to.
  function soleDbFixture() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r
    doc.azs[az.id] = az
    const s1 = createServer(az.id, getPreset('dedicated-8')!)
    const s2 = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[s1.id] = s1
    doc.servers[s2.id] = s2
    const web = publicBlueprint('web', 0)
    const api = createBlueprint('api', 1)
    const db = createBlueprint('db', 2)
    web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })
    const webPl = createPlacement(web.id, s1.id); doc.placements[webPl.id] = webPl
    const apiPl = createPlacement(api.id, s1.id); doc.placements[apiPl.id] = apiPl
    const dbPl = createPlacement(db.id, s2.id); doc.placements[dbPl.id] = dbPl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 120
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), dbServer: s2, dbInst: instanceId(dbPl.id, 0) }
  }

  it('opens the caller breaker within the window, emits breaker_open, and traffic to the dead dependency decays to ~0', () => {
    const f = soleDbFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)                                     // steady healthy load
    expect(sim.latest().instances[f.dbInst]?.rps ?? 0).toBeGreaterThan(0)
    expect(sim.events.some(e => e.kind === 'breaker_open')).toBe(false)

    sim.engine.setOutage('server', f.dbServer.id, true)
    sim.stepFor(3)                                     // windowSize=20 ticks = 2s; opens ~1s in
    expect(sim.events.some(e => e.kind === 'breaker_open')).toBe(true)

    sim.stepFor(10)                                    // EMA decays once nothing is admitted
    expect(sim.latest().instances[f.dbInst]?.rps ?? 0).toBeLessThan(5)
    sim.engine.stop()
  })
})

// Audit ISSUE-002: step 7 computed applyNicCap and threw the result away — NIC saturation never
// shed throughput or added latency. The settlement now feeds the NEXT step's admits
// (deliveredFraction, like admittedScale) and latency (queuedLatencyMs, additive).
describe('NIC backpressure (audit ISSUE-002)', () => {
  function nicWorld(nicMbps: number) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs = { ...server.specs, nicMbps }
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 300
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), webInst: instanceId(pl.id, 0) }
  }

  it('a saturated NIC caps throughput and raises latency; an uncapped one does not', () => {
    // Baseline: 10 Gbps NIC — 300 rps × 2KB responses is nowhere near saturation.
    const base = nicWorld(10_000)
    const baseSim = drive(base.doc, base.compiled)
    baseSim.stepFor(6)
    const baseInst = baseSim.latest().instances[base.webInst]!
    expect(baseInst.rps).toBeGreaterThan(250)
    baseSim.engine.stop()

    // 1 Mbps NIC: ~12.5KB/step budget vs ~61KB/step of response bytes — deep saturation.
    const capped = nicWorld(1)
    const capSim = drive(capped.doc, capped.compiled)
    capSim.stepFor(6)
    const capInst = capSim.latest().instances[capped.webInst]!
    expect(capInst.rps).toBeLessThan(baseInst.rps * 0.7)          // throughput shed at the NIC
    expect(capInst.p50Ms).toBeGreaterThan(baseInst.p50Ms + 30)    // queued latency raises p50
    capSim.engine.stop()
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
    // Audit ISSUE-020: recovery now needs healthCheckHealthyThreshold (2) consecutive healthy
    // checks — one extra check interval vs the old single-probe reset — plus the 5s hysteresis.
    sim.stepFor(30)
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

// ─── Real replica promotion (node-model Phase 4) ─────────────────────────────
// The acceptance story: kill a SQL primary, and writes fail over to the promoted replica while
// reads keep flowing. Promotion is a real routing change (an engine-state overlay), not just an
// event — and it never touches the WorldDoc.
describe('replica promotion — real write failover', () => {
  function apiToDbCluster() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')   // primary DB lives here
    const azB = createAz(region.id, 'us-east-1b')   // replica + api live here (survive azA outage)
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB

    const api = createBlueprint('api', 0)
    api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    const db = createBlueprint('db', 1); db.kind = 'db-sql'; db.dbConfig = { engine: 'sql', storageGb: 100 }
    doc.blueprints[api.id] = api; doc.blueprints[db.id] = db
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null, writeFraction: 0.5 }]

    const apiPl = createPlacement(api.id, sB.id)
    const primaryPl = createPlacement(db.id, sA.id)                 // primary in azA
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'   // replica in azB
    doc.placements[apiPl.id] = apiPl
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl

    const pop = createPopulation('clients', 38.9, -77.5); pop.peakRps = 200
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), azA, primaryIid: instanceId(primaryPl.id, 0), replicaIid: instanceId(replicaPl.id, 0) }
  }

  it('promotes the replica and routes writes to it after the primary AZ fails', () => {
    const f = apiToDbCluster()
    const sim = drive(f.doc, f.compiled)

    sim.stepFor(2)                       // warm up: steady state, writes on the primary
    sim.engine.setOutage('az', f.azA.id, true)   // kill the primary's AZ
    sim.stepFor(6)                       // past onset hysteresis (3s) so the primary reads 'down'

    // The promotion event fired…
    expect(sim.events.some(e => e.kind === 'replica_promoted')).toBe(true)

    // …and it is REAL: a later step's writes reach the promoted replica. Probe the live flows via
    // one more traced step through the overlay by reading the replica's admitted rps from metrics.
    const batch = sim.latest()
    // …and it is REAL: the promoted replica is healthy and now carries the DB traffic (writes
    // failed over to it), while the downed original primary is erroring and drained. Before the
    // outage the primary carried the 50% writes; now the replica does.
    const replica = batch.instances[f.replicaIid]
    const primary = batch.instances[f.primaryIid]
    expect(replica?.health).toBe('healthy')
    expect(primary?.health).toBe('down')
    expect(replica!.rps).toBeGreaterThan(primary!.rps)
  })
})

// Audit ISSUE-021: the weighted policy splits a population's traffic PROPORTIONALLY across
// regions (Route 53 weighted-record semantics) instead of sending 100% to the highest weight.
describe('weighted routing proportional split (audit ISSUE-021)', () => {
  function weightedFixture() {
    const f = e2eFixture()
    f.doc.routing.policy = 'weighted'
    f.doc.routing.weights = { [f.r1.id]: 70, [f.r2.id]: 30 }
    f.pop.diurnal = 'flat'   // steady demand — the split fractions are what's under test
    return { ...f, compiled: compileWorld(f.doc) }
  }

  it('routes ~70/30 of a population to the two regions, not 100% to the top weight', () => {
    const f = weightedFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)
    const routes = sim.latest().world.populationRoutes.filter(r => r.populationId === f.pop.id)
    expect(routes).toHaveLength(2)
    const total = routes.reduce((s, r) => s + r.rps, 0)
    const r1Share = (routes.find(r => r.regionId === f.r1.id)?.rps ?? 0) / total
    expect(r1Share).toBeCloseTo(0.7, 5)   // exact proportional split of the tick's demand
    // and the landed traffic follows: both regions carry real load
    expect(sim.latest().regions[f.r1.id].rps).toBeGreaterThan(0)
    expect(sim.latest().regions[f.r2.id].rps).toBeGreaterThan(0)
    sim.engine.stop()
  })

  it('renormalizes onto the survivors when a weighted region goes down', () => {
    const f = weightedFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(5)
    sim.engine.setOutage('region', f.r1.id, true)
    sim.stepFor(10)
    const routes = sim.latest().world.populationRoutes.filter(r => r.populationId === f.pop.id)
    expect(routes).toHaveLength(1)
    expect(routes[0].regionId).toBe(f.r2.id)   // 100% renormalized onto the healthy region
    sim.engine.stop()
  })

  it('all-zero weights fall back to the order-based path (single-region rows)', () => {
    const f = e2eFixture()
    f.doc.routing.policy = 'weighted'
    f.doc.routing.weights = {}
    f.pop.diurnal = 'flat'
    const compiled = compileWorld(f.doc)
    expect(compiled.routing.regionProportions).toBeUndefined()
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const routes = sim.latest().world.populationRoutes.filter(r => r.populationId === f.pop.id)
    expect(routes).toHaveLength(1)
    sim.engine.stop()
  })
})

// Audit ISSUE-014: an instance silenced by a DOWN upstream publishes 'degraded' (starved), not
// a healthy zero; a genuinely idle instance stays healthy.
describe('starved-vs-idle metrics (audit ISSUE-014)', () => {
  function tiersFixture() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const s1 = createServer(az.id, getPreset('dedicated-8')!)   // front tier
    const s2 = createServer(az.id, getPreset('dedicated-8')!)   // backend
    const s3 = createServer(az.id, getPreset('dedicated-8')!)   // unrelated idle service
    Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3 })
    const web = publicBlueprint('web', 0)
    const db = createBlueprint('db', 1)
    const lonely = createBlueprint('lonely', 2)   // internal-only, no callers, no demand
    web.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [web.id]: web, [db.id]: db, [lonely.id]: lonely })
    const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
    place(web.id, s1.id)
    const dbPl = place(db.id, s2.id)
    const lonelyPl = place(lonely.id, s3.id)
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 200; pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    return {
      doc, compiled: compileWorld(doc), frontServer: s1,
      dbInst: instanceId(dbPl.id, 0), lonelyInst: instanceId(lonelyPl.id, 0),
    }
  }

  it('a backend starved by a down front tier reports degraded while its rps decays', () => {
    const f = tiersFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(5)
    expect(sim.latest().instances[f.dbInst].health).toBe('healthy')   // serving normally
    const servingRps = sim.latest().instances[f.dbInst].rps
    expect(servingRps).toBeGreaterThan(50)

    sim.engine.setOutage('server', f.frontServer.id, true)
    sim.stepFor(6)
    const starvedDb = sim.latest().instances[f.dbInst]
    expect(starvedDb.health).toBe('degraded')                 // starved, NOT healthy-idle
    expect(starvedDb.rps).toBeLessThan(servingRps)            // connections/throughput draining
    // The unrelated idle service has no down upstream — it stays healthy at 0 rps.
    expect(sim.latest().instances[f.lonelyInst].health).toBe('healthy')
    sim.engine.stop()
  })

  it('recovery clears the starved override', () => {
    const f = tiersFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(3)
    sim.engine.setOutage('server', f.frontServer.id, true)
    sim.stepFor(5)
    expect(sim.latest().instances[f.dbInst].health).toBe('degraded')
    sim.engine.setOutage('server', f.frontServer.id, false)
    sim.stepFor(30)   // recovery hysteresis + traffic resumes
    expect(sim.latest().instances[f.dbInst].health).toBe('healthy')
    sim.engine.stop()
  })
})

// Packet-driven egress (slice 1): a route's responseSizeKb drives the client→entry internet byte
// rate, so the internet-egress cost line varies with the traffic's actual payload size instead of
// the old flat 2 KB-each-way constant.
describe('route-driven internet egress bytes', () => {
  // One region / AZ / server, a single public entry service, one population whose whole mix is a
  // single route — so internet bytes are exactly (offered rps × the route's request+response size).
  function singleEntryWorld(responseSizeKb: number | null) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0); doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 40   // light: no NIC shedding
    if (responseSizeKb != null) {
      const route = addRoute(doc.packets, { name: 'api', method: 'GET', path: '/api', sizeKb: 1, responseSizeKb })
      doc.packets = route.registry
      pop.requestMix = [{ routeId: routeIdOf(route.route), weight: 1 }]
    }
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc) }
  }

  const settle = (f: { doc: WorldDoc; compiled: ReturnType<typeof compileWorld> }) => {
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(6)
    const b = sim.latest()
    sim.engine.stop()
    return b
  }

  it('a larger response size yields a proportionally larger internet byte rate and cost', () => {
    const small = settle(singleEntryWorld(4))     // 1 KB req + 4 KB resp
    const big = settle(singleEntryWorld(256))     // 1 KB req + 256 KB resp
    expect(big.world.internetEgressBytesPerSec).toBeGreaterThan(small.world.internetEgressBytesPerSec)
    // Same seed ⇒ same offered-rps trajectory, so the ratio reflects only the size difference:
    // (1+256)/(1+4) ≈ 51×.
    const ratio = big.world.internetEgressBytesPerSec / small.world.internetEgressBytesPerSec
    expect(ratio).toBeGreaterThan(30)
    // Cost follows the byte rate.
    const costSmall = computeWorldCost(singleEntryWorld(4).doc, small.world).egress.internetUsd
    const costBig = computeWorldCost(singleEntryWorld(256).doc, big.world).egress.internetUsd
    expect(costBig).toBeGreaterThan(costSmall)
  })

  it('a world with no authored routes keeps the 2 KB-each-way convention (byte-identical)', () => {
    const b = settle(singleEntryWorld(null))   // implicit default route → fallback sizes
    // internet bytes are seeded from offered entry rps × 4096 (2 KB req + 2 KB resp); at this light
    // load offered ≈ admitted, so the ratio to totalRps sits right at 4096.
    const perReq = b.world.internetEgressBytesPerSec / b.world.totalRps
    expect(perReq).toBeGreaterThan(3900)
    expect(perReq).toBeLessThan(4300)
  })
})

// Packet-driven CPU (slice 2): a route's request size, blended into cpuMsPerRequest via
// cpuMsPerKb, drives more CPU pressure / less admitted capacity / higher latency on the entry
// service that handles it — the same entry-tier accumulator slice 1 built for egress bytes, now
// also feeding the host scheduler and the flow-solver's latency p50.
describe('packet-driven CPU (blend model, entry tier — slice 2)', () => {
  // One region/AZ/dedicated-8 server, a single public entry service on a single route, one
  // population whose whole mix is that route — so the entry instance's avgReqSizeKb is exactly
  // the route's authored sizeKb.
  function cpuBlendWorld(cpuMsPerKb: number | undefined, sizeKb: number, peakRps: number) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0)
    if (cpuMsPerKb != null) web.workload = { ...web.workload, cpuMsPerKb }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = peakRps
    const route = addRoute(doc.packets, { name: 'api', method: 'GET', path: '/api', sizeKb, responseSizeKb: 2 })
    doc.packets = route.registry
    pop.requestMix = [{ routeId: routeIdOf(route.route), weight: 1 }]
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), serverId: sv.id, webIid: instanceId(pl.id, 0) }
  }

  const settle = (f: ReturnType<typeof cpuBlendWorld>) => {
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(15)
    const b = sim.latest()
    sim.engine.stop()
    return b
  }
  const avgUtil = (u: number[]) => u.reduce((a, c) => a + c, 0) / u.length

  it('a larger request payload raises CPU pressure, lowers admitted capacity, and raises p50 latency', () => {
    // dedicated-8 = 8 vCPU ⇒ ~8000 cores-ms/s budget. Small: 5 + 0.05×1 ≈ 5.05ms/req ⇒ ~1584 rps
    // capacity. Big: 5 + 0.05×300 = 20ms/req ⇒ 400 rps capacity — well under the 600 rps offered.
    const smallWorld = cpuBlendWorld(0.05, 1, 600)
    const bigWorld = cpuBlendWorld(0.05, 300, 600)
    const small = settle(smallWorld)
    const big = settle(bigWorld)

    expect(avgUtil(big.servers[bigWorld.serverId].coreUtilization))
      .toBeGreaterThan(avgUtil(small.servers[smallWorld.serverId].coreUtilization))
    expect(big.instances[bigWorld.webIid].rps).toBeLessThan(small.instances[smallWorld.webIid].rps)
    expect(big.instances[bigWorld.webIid].p50Ms).toBeGreaterThan(small.instances[smallWorld.webIid].p50Ms)
  })

  // Backward-compat invariant (non-negotiable, per the task spec): cpuMsPerKb unset/0 must
  // reproduce today's behavior EXACTLY, regardless of the route's authored size — the coefficient,
  // not the size signal, gates the effect.
  it('cpuMsPerKb unset makes CPU/latency/capacity metrics identical across different route sizes (golden)', () => {
    const tinyRoute = cpuBlendWorld(undefined, 1, 600)
    const hugeRoute = cpuBlendWorld(undefined, 300, 600)
    const bTiny = settle(tinyRoute)
    const bHuge = settle(hugeRoute)
    expect(bHuge.instances[hugeRoute.webIid].rps).toBe(bTiny.instances[tinyRoute.webIid].rps)
    expect(bHuge.instances[hugeRoute.webIid].p50Ms).toBe(bTiny.instances[tinyRoute.webIid].p50Ms)
    expect(bHuge.instances[hugeRoute.webIid].cpuCoresUsed).toBe(bTiny.instances[tinyRoute.webIid].cpuCoresUsed)
    expect(bHuge.servers[hugeRoute.serverId].coreUtilization).toEqual(bTiny.servers[tinyRoute.serverId].coreUtilization)
  })

  it('cpuMsPerKb = 0 is byte/metric-identical to cpuMsPerKb left unset entirely', () => {
    const explicitZero = cpuBlendWorld(0, 300, 600)
    const unset = cpuBlendWorld(undefined, 300, 600)
    const bZero = settle(explicitZero)
    const bUnset = settle(unset)
    expect(bZero.instances[explicitZero.webIid].rps).toBe(bUnset.instances[unset.webIid].rps)
    expect(bZero.instances[explicitZero.webIid].p50Ms).toBe(bUnset.instances[unset.webIid].p50Ms)
    expect(bZero.instances[explicitZero.webIid].cpuCoresUsed).toBe(bUnset.instances[unset.webIid].cpuCoresUsed)
    expect(bZero.servers[explicitZero.serverId].coreUtilization).toEqual(bUnset.servers[unset.serverId].coreUtilization)
  })
})

// Log-normal NIC-burst tails (mean-preserving, slice 3): a route's sizeVariance (sigma) draws a
// fresh mean-1 log-normal multiplier each step on the ENTRY NIC byte booking only (never the
// internet-egress cost accumulator, which flows.ts seeds separately from entryBytesByInstance).
// Surfaces as instance p99Ms tail spikes on a NIC-tight server, with mean egress bytes/cost
// staying ~unchanged over a long run.
describe('log-normal NIC-burst tails (mean-preserving, entry tier — slice 3)', () => {
  // One region/AZ/dedicated-8 server, a single public entry service on a single route, one
  // population whose whole mix is that route. nicMbps is overridden post-preset so tests can
  // dial the NIC cap independently of vCPU/RAM.
  function nicBurstWorld(sizeVariance: number, opts: { nicMbps?: number; responseSizeKb?: number; peakRps?: number } = {}) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    if (opts.nicMbps != null) sv.specs.nicMbps = opts.nicMbps
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0); doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = opts.peakRps ?? 30
    const route = addRoute(doc.packets, {
      name: 'api', method: 'GET', path: '/api', sizeKb: 1, responseSizeKb: opts.responseSizeKb ?? 50, sizeVariance,
    })
    doc.packets = route.registry
    pop.requestMix = [{ routeId: routeIdOf(route.route), weight: 1 }]
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), serverId: sv.id, webIid: instanceId(pl.id, 0) }
  }

  it('a NIC-tight server shows a higher p99Ms with sigma > 0 than the identical world at sigma = 0', () => {
    // nicMbps 20 + 35 rps x (1+50) KB keeps the sigma=0 world safely under the NIC cap (no
    // chronic queuing — p99 reflects only the baseline latency model) while sigma=1's occasional
    // spikes (median multiplier < 1, tail multiplier several x) push well past 2x cap on the
    // worst steps, shedding and growing queuedLatencyMs into next step's latency.
    const base = nicBurstWorld(0, { nicMbps: 20, responseSizeKb: 50, peakRps: 35 })
    const burst = nicBurstWorld(1.0, { nicMbps: 20, responseSizeKb: 50, peakRps: 35 })
    const simBase = drive(base.doc, base.compiled)
    simBase.stepFor(30)
    const bBase = simBase.latest()
    simBase.engine.stop()
    const simBurst = drive(burst.doc, burst.compiled)
    simBurst.stepFor(30)
    const bBurst = simBurst.latest()
    simBurst.engine.stop()
    expect(bBurst.instances[burst.webIid].p99Ms).toBeGreaterThan(bBase.instances[base.webIid].p99Ms)
  })

  it('mean internetEgressBytesPerSec / internet-egress cost stays ~unchanged between sigma=0 and sigma>0', () => {
    // Ample NIC headroom (default dedicated-8 nicMbps, unmodified) — the multiplier only ever
    // touches NIC booking (never entryBytesByInstance, the separate cost/egress seed), so with
    // the NIC nowhere near its cap the two runs' egress trajectories should track closely; any
    // residual gap is pure demand-RNG-stream divergence from the extra per-step draws.
    const base = nicBurstWorld(0, { peakRps: 150 })
    const burst = nicBurstWorld(0.9, { peakRps: 150 })
    const simBase = drive(base.doc, base.compiled)
    simBase.stepFor(60)
    const meanEgressBase = simBase.batches.reduce((sum, b) => sum + b.world.internetEgressBytesPerSec, 0) / simBase.batches.length
    const costBase = computeWorldCost(base.doc, simBase.latest().world).egress.internetUsd
    simBase.engine.stop()
    const simBurst = drive(burst.doc, burst.compiled)
    simBurst.stepFor(60)
    const meanEgressBurst = simBurst.batches.reduce((sum, b) => sum + b.world.internetEgressBytesPerSec, 0) / simBurst.batches.length
    const costBurst = computeWorldCost(burst.doc, simBurst.latest().world).egress.internetUsd
    simBurst.engine.stop()

    const relDiff = Math.abs(meanEgressBurst - meanEgressBase) / meanEgressBase
    expect(relDiff).toBeLessThan(0.05)
    const costRelDiff = Math.abs(costBurst - costBase) / costBase
    expect(costRelDiff).toBeLessThan(0.05)
  })

  // Backward-compat invariant (non-negotiable, per the task spec): sizeVariance unset must
  // reproduce today's behavior EXACTLY — the coefficient, not its absence, gates the effect, and
  // an explicit 0 must be indistinguishable from an unauthored route (golden guard).
  it('sizeVariance = 0 is metric-identical to sizeVariance left unset entirely (golden guard)', () => {
    const explicitZero = nicBurstWorld(0, { nicMbps: 20, responseSizeKb: 50, peakRps: 35 })
    // Build an equivalent world with NO sizeVariance field authored at all (default route form).
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    sv.specs.nicMbps = 20
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0); doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 35
    const route = addRoute(doc.packets, { name: 'api', method: 'GET', path: '/api', sizeKb: 1, responseSizeKb: 50 })
    doc.packets = route.registry
    pop.requestMix = [{ routeId: routeIdOf(route.route), weight: 1 }]
    doc.populations[pop.id] = pop
    const unauthored = { doc, compiled: compileWorld(doc), serverId: sv.id, webIid: instanceId(pl.id, 0) }

    const simZero = drive(explicitZero.doc, explicitZero.compiled)
    simZero.stepFor(30)
    const bZero = simZero.latest()
    simZero.engine.stop()
    const simUnauthored = drive(unauthored.doc, unauthored.compiled)
    simUnauthored.stepFor(30)
    const bUnauthored = simUnauthored.latest()
    simUnauthored.engine.stop()

    expect(bZero.instances[explicitZero.webIid].p99Ms).toBe(bUnauthored.instances[unauthored.webIid].p99Ms)
    expect(bZero.instances[explicitZero.webIid].p50Ms).toBe(bUnauthored.instances[unauthored.webIid].p50Ms)
    expect(bZero.instances[explicitZero.webIid].rps).toBe(bUnauthored.instances[unauthored.webIid].rps)
    expect(bZero.world.internetEgressBytesPerSec).toBe(bUnauthored.world.internetEgressBytesPerSec)
  })
})
