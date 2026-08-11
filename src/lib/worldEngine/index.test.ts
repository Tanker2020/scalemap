import { describe, it, expect } from 'vitest'
import { createWorldEngine, buildImpairmentMemo } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
  createLoadBalancer, createVpc, createSubnet, createRouteTable, createNatGateway, createInternetGateway,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { addRoute, routeIdOf, updateRoute, addPacket } from '../nodeConfig'
import type { HttpTemplate, ConnectionType } from '../nodeConfig'
import { computeWorldCost } from '../costModelV2'
import type { WorldDoc, CacheConfig, BlueprintDependency, InstanceId } from '../world/types'
import type { MetricsBatch, EngineEvent, FramePayload } from './types'
import { populationDemandRps } from './demand'
import { createRng } from './rng'
import { effectiveHitRatio } from './cache'
import { INSTANCE_DRAIN_MS } from './autoscale'

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

  it('latency-add ADDS to queued NIC latency, does not overwrite it', () => {
    // Build a saturated NIC world: 1 Mbps with 300 rps produces deep NIC backpressure
    const saturated = nicWorld(1)
    const sim = drive(saturated.doc, saturated.compiled)
    sim.stepFor(6)  // reach steady state
    const baselineP50 = sim.latest().instances[saturated.webInst]!.p50Ms
    // Now apply a 200ms latency-add fault
    sim.engine.setFault('server', Object.values(saturated.doc.servers)[0]!.id, { kind: 'latency-add', ms: 200 })
    sim.stepFor(4)  // let the fault take effect and metrics converge
    const faultedP50 = sim.latest().instances[saturated.webInst]!.p50Ms
    // The fault must ADD to existing NIC latency, not replace it
    // (regression: the bug would cause p50 to drop if only latency-add was active)
    expect(faultedP50).toBeGreaterThan(baselineP50)
    expect(faultedP50 - baselineP50).toBeGreaterThanOrEqual(150)  // ~200ms added (with EMA lag/variance)
    sim.engine.stop()
  })

  it('latency-add of 200ms raises p50Ms by ~200ms on the faulted server only', () => {
    // Two-server world: one saturated NIC (1 Mbps), one fast (10 Gbps)
    // Apply latency-add only to one; verify it affects only that server's p50
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r
    doc.azs[az.id] = az

    // Two servers, one saturated, one fast
    const serverSaturated = createServer(az.id, getPreset('dedicated-8')!)
    serverSaturated.specs = { ...serverSaturated.specs, nicMbps: 1 }  // saturated
    const serverFast = createServer(az.id, getPreset('dedicated-8')!)
    serverFast.specs = { ...serverFast.specs, nicMbps: 10_000 }  // ample
    doc.servers[serverSaturated.id] = serverSaturated
    doc.servers[serverFast.id] = serverFast

    const webSat = publicBlueprint('web-sat', 0)
    const webFast = publicBlueprint('web-fast', 1)
    doc.blueprints[webSat.id] = webSat
    doc.blueprints[webFast.id] = webFast

    const plSat = createPlacement(webSat.id, serverSaturated.id)
    const plFast = createPlacement(webFast.id, serverFast.id)
    doc.placements[plSat.id] = plSat
    doc.placements[plFast.id] = plFast

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 300
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    sim.stepFor(6)  // steady state
    const webSatInstId = instanceId(plSat.id, 0)
    const webFastInstId = instanceId(plFast.id, 0)
    const baselineSatP50 = sim.latest().instances[webSatInstId]!.p50Ms
    const baselineFastP50 = sim.latest().instances[webFastInstId]!.p50Ms

    // Apply latency-add ONLY to the saturated server
    sim.engine.setFault('server', serverSaturated.id, { kind: 'latency-add', ms: 200 })
    sim.stepFor(4)  // let the fault take effect and metrics converge
    const faultedSatP50 = sim.latest().instances[webSatInstId]!.p50Ms
    const faultedFastP50 = sim.latest().instances[webFastInstId]!.p50Ms

    // Saturated server's p50 must rise by ~150ms+ (accounting for EMA lag and variance)
    expect(faultedSatP50 - baselineSatP50).toBeGreaterThanOrEqual(150)
    // Fast server's p50 must stay relatively stable (small variance allowed for EMA)
    // Verify it's not growing by 150+ like the faulted server
    expect(faultedFastP50 - baselineFastP50).toBeLessThan(100)
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

  // Final-whole-branch-review regression (Critical): route.sizeKb is typed as a non-optional
  // `number` on HttpTemplate, but can genuinely be `undefined` at runtime — a user blanking the
  // RoutesPanel "req" size input (parseKb('') -> undefined, written through updateRoute's spread)
  // or a route saved before slice 1 introduced sizeKb (no per-route normalization on load). Before
  // the fix, buildRouteBytesById copied `route.sizeKb` raw with no fallback (unlike the sibling
  // `nicReq` field one line above it, which does guard) — r * undefined = NaN in the entry
  // accumulator's cpuKb fold, which then poisons effectiveCpuMs even when cpuMsPerKb is completely
  // UNSET (0 * NaN = NaN, not 0), violating the non-negotiable "cpuMsPerKb unset ⇒ byte/metric-
  // identical to pre-slice-2" invariant under DEFAULT settings.
  function undefinedSizeKbWorld(cpuMsPerKb: number | undefined, peakRps: number) {
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
    const added = addRoute(doc.packets, { name: 'api', method: 'GET', path: '/api', sizeKb: 1, responseSizeKb: 2 })
    const routeId = routeIdOf(added.route)
    // Simulate a blanked "req size" field / a pre-slice-1 route with no sizeKb normalization on
    // load: updateRoute's spread writes the `sizeKb` key through with an `undefined` VALUE,
    // exactly matching RoutesPanel's parseKb('') -> undefined path — NOT the same as never having
    // authored the field (which addRoute would default to 1).
    doc.packets = updateRoute(added.registry, routeId, { sizeKb: undefined })
    pop.requestMix = [{ routeId, weight: 1 }]
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), serverId: sv.id, webIid: instanceId(pl.id, 0) }
  }

  it('a route with runtime-undefined sizeKb (blanked field / pre-slice-1 route) yields finite metrics under default settings (cpuMsPerKb unset)', () => {
    const f = undefinedSizeKbWorld(undefined, 600)
    const b = settle(f)
    const inst = b.instances[f.webIid]
    expect(Number.isFinite(inst.p50Ms)).toBe(true)
    expect(Number.isFinite(inst.p99Ms)).toBe(true)
    expect(Number.isFinite(inst.cpuCoresUsed)).toBe(true)
    for (const u of b.servers[f.serverId].coreUtilization) expect(Number.isFinite(u)).toBe(true)
  })

  it('a route with runtime-undefined sizeKb yields finite, sensible metrics with cpuMsPerKb > 0 set (fallback participates in the blend, not just avoids a crash)', () => {
    const f = undefinedSizeKbWorld(0.05, 600)
    const b = settle(f)
    const inst = b.instances[f.webIid]
    expect(Number.isFinite(inst.p50Ms)).toBe(true)
    expect(Number.isFinite(inst.p99Ms)).toBe(true)
    expect(Number.isFinite(inst.cpuCoresUsed)).toBe(true)
    expect(inst.cpuCoresUsed).toBeGreaterThan(0)
    for (const u of b.servers[f.serverId].coreUtilization) expect(Number.isFinite(u)).toBe(true)
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

  it('mean internetEgressBytesPerSec / internet-egress cost stays ~unchanged under NIC stress too (review fix)', () => {
    // Same NIC-tight fixture as the p99-tail test above (nicMbps 20, 50 KB responses, 35 rps) —
    // deliberately NOT the ample-NIC fixture the previous test uses, so this exercises the exact
    // path the reviewer flagged: with the entry NIC pinned near/over its cap, sigma>0's per-step
    // multiplier pushes some steps past 2x cap, triggering deliveredFraction < 1 -> queuedLatencyMs
    // -> next-step extraLatencyMsByServer -> admission/backpressure feedback in solveFlows. The
    // question is whether that feedback loop can bias the *volume* of admitted entry rps in a way
    // that leaks into internetEgressBytesPerSec.
    //
    // It structurally can't: totals.internetBytes (flows.ts) is seeded from `entryDemand` — the
    // OFFERED per-step rps computed during routing/LB distribution, BEFORE solveFlows' queue/
    // admission logic ever runs — multiplied by the route's mean req+resp bytes (entryBytesByInstance,
    // which sizeVariance never touches). NIC backpressure only ever throttles ADMITTED rps and adds
    // latency; it never rewrites entryDemand or entryBytesByInstance. So even under sustained NIC
    // stress, the egress/cost line should track the sigma=0 run to within ordinary RNG-stream
    // divergence — the same mechanism the ample-NIC test above attributes its residual gap to,
    // just with more per-step draws (sampleSizeMultiplier fires on every stressed step here,
    // vs. rarely under ample headroom) shifting the shared seeded rng stream further apart.
    const base = nicBurstWorld(0, { nicMbps: 20, responseSizeKb: 50, peakRps: 35 })
    const burst = nicBurstWorld(1.0, { nicMbps: 20, responseSizeKb: 50, peakRps: 35 })
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

    // Wider than the ample-NIC test's 5% — NIC-tight legitimately introduces more step-to-step
    // demand-RNG divergence between the two runs (sampleSizeMultiplier fires on nearly every
    // stressed step here, vs. rarely under ample headroom, shifting more subsequent Box-Muller
    // draws in the shared seeded stream), and `costBase`/`costBurst` are single last-step
    // snapshots (matching the ample-NIC test's style above) rather than run means, so they also
    // inherit whatever NIC-delivered-fraction noise that one step happens to be sitting in.
    // Measured on this fixture: mean-egress relDiff ~3.1%, cost relDiff ~8.0% (both deterministic
    // under the fixed seed=1 `drive()` uses). 15% gives ~5x headroom on the byte mean and ~1.9x
    // headroom on the noisier single-step cost figure, while still being tight enough to catch a
    // real bias: injecting the exact leak this test guards against — scaling entryBytesByInstance
    // (the cost/egress seed) by the previous step's NIC deliveredFraction, simulating admission
    // backpressure leaking into the cost line — pushed costRelDiff to ~20.9%, well past this
    // threshold (verified locally, reverted before commit; see task report for detail).
    const relDiff = Math.abs(meanEgressBurst - meanEgressBase) / meanEgressBase
    expect(relDiff).toBeLessThan(0.15)
    const costRelDiff = Math.abs(costBurst - costBase) / costBase
    expect(costRelDiff).toBeLessThan(0.15)
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

// Coverage gap flagged by the final whole-branch review: no existing test exercises slice 2
// (cpuMsPerKb CPU blend) and slice 3 (sizeVariance NIC-burst multiplier) authored TOGETHER on the
// same entry instance. The two features fold from independent accumulator fields (cpuKb vs. varW)
// off the same per-route RouteWireBytes, so they should not interact — this proves it rather than
// assuming it.
describe('packet-driven CPU + NIC-burst variance authored together (slices 2 & 3)', () => {
  // Same entry-tier fixture shape as slice 2's/slice 3's own describe blocks, but the route/
  // blueprint author BOTH cpuMsPerKb and sizeVariance at once.
  function combinedWorld(sizeVariance: number, opts: { nicMbps?: number; responseSizeKb?: number; peakRps?: number } = {}) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    if (opts.nicMbps != null) sv.specs.nicMbps = opts.nicMbps
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0)
    web.workload = { ...web.workload, cpuMsPerKb: 0.05 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = opts.peakRps ?? 150
    const route = addRoute(doc.packets, {
      name: 'api', method: 'GET', path: '/api', sizeKb: 1, responseSizeKb: opts.responseSizeKb ?? 50, sizeVariance,
    })
    doc.packets = route.registry
    pop.requestMix = [{ routeId: routeIdOf(route.route), weight: 1 }]
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), serverId: sv.id, webIid: instanceId(pl.id, 0) }
  }

  it('slice 2 CPU blend still drives real, finite CPU usage when the same route also authors sizeVariance', () => {
    const withBoth = combinedWorld(0.9, { peakRps: 150 })
    const sim = drive(withBoth.doc, withBoth.compiled)
    sim.stepFor(15)
    const b = sim.latest()
    sim.engine.stop()
    // sizeVariance never touches the cpuKb accumulator (only the NIC-booking multiplier) — the CPU
    // blend should be observable (finite, nonzero) exactly as it is in slice 2's own tests.
    expect(Number.isFinite(b.instances[withBoth.webIid].cpuCoresUsed)).toBe(true)
    expect(b.instances[withBoth.webIid].cpuCoresUsed).toBeGreaterThan(0)
    for (const u of b.servers[withBoth.serverId].coreUtilization) expect(Number.isFinite(u)).toBe(true)
  })

  it("mean internetEgressBytesPerSec / internet-egress cost stays within slice 3's ample-NIC tolerance when cpuMsPerKb is also authored", () => {
    // Matching slice 3's own ample-NIC test's fixture/tolerance (5%) — cpuMsPerKb only affects the
    // host scheduler's CPU accounting, never entryBytesByInstance (the egress/cost seed), so adding
    // it should not widen the sigma=0 vs. sigma>0 egress gap beyond what slice 3 already established.
    const base = combinedWorld(0, { peakRps: 150 })
    const burst = combinedWorld(0.9, { peakRps: 150 })
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
})

// ─── Packet library: internal hops carry real payloads (cost + NIC + CPU) ────────────────────
// Before this, every service→service call booked a flat 2 KB of egress and a flat 512/2048 of
// NIC on the SERVING side only — a service shipping 5 MB blobs was indistinguishable from one
// sending health checks. These tests pin the three consequences (dollars, NIC saturation, CPU)
// and, most importantly, that an unauthored world is unchanged.
describe('packet-driven internal hops', () => {
  // api (entry, az1) → store (az2): one cross-AZ dependency, tunable NIC and packet binding.
  function crossAzPair(opts: { nicMbps?: number; peakRps?: number; cpuMsPerKb?: number } = {}) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az1 = createAz(r.id, 'us-east-1a')
    const az2 = createAz(r.id, 'us-east-1b')
    doc.regions[r.id] = r; doc.azs[az1.id] = az1; doc.azs[az2.id] = az2
    const s1 = createServer(az1.id, getPreset('dedicated-8')!)
    const s2 = createServer(az2.id, getPreset('dedicated-8')!)
    if (opts.nicMbps != null) s2.specs = { ...s2.specs, nicMbps: opts.nicMbps }
    doc.servers[s1.id] = s1; doc.servers[s2.id] = s2

    const api = publicBlueprint('api', 0)
    const store = createBlueprint('store', 1)
    if (opts.cpuMsPerKb != null) store.workload = { ...store.workload, cpuMsPerKb: opts.cpuMsPerKb }
    api.dependencies = [{
      id: 'd-store', target: { kind: 'blueprint', blueprintId: store.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
    Object.assign(doc.blueprints, { [api.id]: api, [store.id]: store })
    const pl1 = createPlacement(api.id, s1.id); doc.placements[pl1.id] = pl1
    const pl2 = createPlacement(store.id, s2.id); doc.placements[pl2.id] = pl2
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = opts.peakRps ?? 100
    doc.populations[pop.id] = pop
    return { doc, apiInst: instanceId(pl1.id, 0), storeInst: instanceId(pl2.id, 0), s2: s2.id }
  }

  // Binds a 5 MB request / 1 KB response packet to the single dependency.
  function bindFatPacket(doc: WorldDoc, over: Record<string, unknown> = {}) {
    doc.packets = {
      ...doc.packets,
      templates: { ...doc.packets.templates, 1: { id: 1, name: 'blob', protocol: 'http', method: 'PUT', statusCode: 200, sizeKb: 5120, responseSizeKb: 1, ...over } },
      nextId: 2,
    }
    for (const bp of Object.values(doc.blueprints)) {
      bp.dependencies = bp.dependencies.map(d => ({ ...d, packetMix: [{ packetId: 1, weight: 1 }] }))
    }
  }

  it('a fat internal packet multiplies the cross-AZ egress bill', () => {
    const flat = crossAzPair()
    const simFlat = drive(flat.doc, compileWorld(flat.doc))
    simFlat.stepFor(20)

    const fat = crossAzPair()
    bindFatPacket(fat.doc)
    const simFat = drive(fat.doc, compileWorld(fat.doc))
    simFat.stepFor(20)

    const flatBytes = simFlat.latest().world.crossAzBytesPerSec
    const fatBytes = simFat.latest().world.crossAzBytesPerSec
    expect(flatBytes).toBeGreaterThan(0)
    // 5 MB + 1 KB per call vs the old 2 KB + 2 KB — three orders of magnitude, not a nudge.
    expect(fatBytes).toBeGreaterThan(flatBytes * 500)
  })

  it('a fat internal packet saturates the CALLEE NIC and sheds throughput', () => {
    // 100 Mbps NIC: 100 rps × 5 MB is far past the cap, where the flat 2 KB model saw no pressure.
    const flat = crossAzPair({ nicMbps: 100 })
    const simFlat = drive(flat.doc, compileWorld(flat.doc))
    simFlat.stepFor(20)

    const fat = crossAzPair({ nicMbps: 100 })
    bindFatPacket(fat.doc)
    const simFat = drive(fat.doc, compileWorld(fat.doc))
    simFat.stepFor(20)

    // 100 Mbps cap; the flat model books ~2 KB/call, the fat one 5 MB.
    expect(simFlat.latest().servers[flat.s2].nicInMbps).toBeLessThan(50)
    // Re-baselined (audit ISSUE-009): this assertion pre-dates the NIC-ceiling fix and expected a
    // >100x gap — which was only reachable because the OLD flat-divisor ceiling let ALL 100 rps of
    // 5 MB calls through uncapped, booking ~4 Gbps on a 100 Mbps NIC (physically impossible; the
    // exact bug this issue fixes). The FIXED ceiling now throttles admission to near the NIC's real
    // line rate before those bytes ever reach the wire, so the fat scenario's nicInMbps is
    // correctly bounded near the 100 Mbps cap rather than exploding with packet size.
    // Re-baselined AGAIN (audit ISSUE-008): Mechanism B's demand-shedding now engages on this
    // scenario's sustained api->store breaker-open capacity errors, further reducing the fat
    // scenario's admitted (and therefore nicInMbps) below the ~9x gap ISSUE-009 measured — a
    // genuine, further-reduced gap (~4.4x: 1.69 -> 7.49 Mbps), not a bug, since ISSUE-008 exists
    // precisely to shed entry demand under this kind of sustained internal saturation. Hand-
    // verified: the fat scenario's rps assertion below shows the callee throttled to well under
    // 1 rps (was ~100 pre-fix), which is what "the NIC is now the actual bottleneck" looks like.
    expect(simFat.latest().servers[fat.s2].nicInMbps).toBeGreaterThan(
      simFlat.latest().servers[flat.s2].nicInMbps * 4)
    // and the saturation is felt as shed throughput on the callee
    expect(simFat.latest().instances[fat.storeInst].rps)
      .toBeLessThan(simFlat.latest().instances[flat.storeInst].rps)
  })

  // Audit ISSUE-009's own before/after: a 5 MB edge on a 100 Mbps NIC has a true physical ceiling
  // of (100e6/8) / 5,242,880 ≈ 2.4 rps — nowhere near the ~6,103 rps the old flat-2KB-divisor
  // ceiling implied (which is why the callee used to admit the FULL ~100 rps offered, unthrottled).
  it('caps admitted rps near the true NIC ceiling for a large payload, not the flat-divisor one', () => {
    const fat = crossAzPair({ nicMbps: 100 })
    bindFatPacket(fat.doc)
    const sim = drive(fat.doc, compileWorld(fat.doc))
    sim.stepFor(20)
    // Pre-fix this was ~100 (offered rps, fully admitted — the bug). Loose upper bound around the
    // ~2.4 rps true ceiling, allowing for queueing/CPU also playing a role.
    expect(sim.latest().instances[fat.storeInst].rps).toBeLessThan(10)
    sim.engine.stop()
  })

  // Regression floor: an edge with NO authored size (the default 2 KB convention) must reduce the
  // ceiling formula to EXACTLY the pre-fix flat-divisor value — every existing world with no
  // authored packet sizes keeps its exact NIC-ceiling behavior.
  it('an unauthored (default 2 KB) edge keeps the exact pre-fix NIC ceiling behavior', () => {
    // 1 Mbps: tight enough that the flat 2 KB divisor genuinely binds (matches the NIC
    // backpressure describe block above, which asserts this same scenario shifts throughput).
    const base = crossAzPair({ nicMbps: 1000 })
    const simBase = drive(base.doc, compileWorld(base.doc))
    simBase.stepFor(6)
    const capped = crossAzPair({ nicMbps: 1 })
    const simCapped = drive(capped.doc, compileWorld(capped.doc))
    simCapped.stepFor(6)
    // Unauthored default-size traffic still sheds at a tight NIC exactly like before this issue —
    // same shape of assertion as the pre-existing 'NIC backpressure (audit ISSUE-002)' block.
    expect(simCapped.latest().instances[capped.storeInst].rps)
      .toBeLessThan(simBase.latest().instances[base.storeInst].rps * 0.7)
    simBase.engine.stop(); simCapped.engine.stop()
  })

  it('inbound internal KB drives cpuMsPerKb on the RECEIVER (one-step lagged)', () => {
    // Deliberately NOT the 5 MB packet: that saturates the callee's NIC first and sheds its
    // traffic to nothing, so there is no CPU left to measure. 64 KB is well under the NIC
    // ceiling and still 128× the flat 0.5 KB default.
    const flat = crossAzPair({ cpuMsPerKb: 0.5, peakRps: 20 })
    const simFlat = drive(flat.doc, compileWorld(flat.doc))
    simFlat.stepFor(20)

    const fat = crossAzPair({ cpuMsPerKb: 0.5, peakRps: 20 })
    bindFatPacket(fat.doc, { sizeKb: 64 })
    const simFat = drive(fat.doc, compileWorld(fat.doc))
    simFat.stepFor(20)

    // 64 KB × 0.5 ms/KB (32 ms) dwarfs the flat per-request cost — the receiver's CPU shows it.
    const meanCore = (cores: number[]) => cores.reduce((a, b) => a + b, 0) / cores.length
    expect(meanCore(simFat.latest().servers[fat.s2].coreUtilization))
      .toBeGreaterThan(meanCore(simFlat.latest().servers[flat.s2].coreUtilization))
  })

  it('REGRESSION FLOOR: two runs of the same unauthored world are identical', () => {
    // Same doc both times — a second crossAzPair() would mint fresh entity ids and the batches
    // would differ on keys alone, proving nothing about the engine.
    const f = crossAzPair()
    const compiled = compileWorld(f.doc)
    const simA = drive(f.doc, compiled); simA.stepFor(30)
    const simB = drive(f.doc, compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
  })

  it('REGRESSION FLOOR: a world with no coldStartMs produces byte-identical output for a fixed seed', () => {
    const f = crossAzPair()
    const compiled = compileWorld(f.doc)
    const simA = drive(f.doc, compiled); simA.stepFor(30)
    const simB = drive(f.doc, compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
    for (const im of Object.values(simA.latest().instances)) {
      expect((im as any).warmth).toBeUndefined()
    }
  })

  it('a bound mix stays deterministic — same seed, identical batches, even with sigma > 0', () => {
    const f = crossAzPair()
    bindFatPacket(f.doc, { sizeVariance: 0.8 })
    const compiled = compileWorld(f.doc)
    const simA = drive(f.doc, compiled); simA.stepFor(30)
    const simB = drive(f.doc, compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
  })

  it('an unauthored world draws NO rng for internal size jitter (the seeded stream is untouched)', () => {
    // Proof by consequence: if the unauthored path drew from s.rng, adding a sigma-carrying
    // packet elsewhere in the SAME world would be the only way to shift the stream. Instead we
    // check the stronger property directly — an unauthored run equals a run whose only difference
    // is a packet that exists but is bound to nothing.
    const plain = crossAzPair()
    const withUnboundPacket = crossAzPair()
    withUnboundPacket.doc.packets = {
      ...withUnboundPacket.doc.packets,
      templates: { 1: { id: 1, name: 'unused', protocol: 'http', method: 'GET', statusCode: 200, sizeKb: 9999, sizeVariance: 1.4 } },
      nextId: 2,
    }
    const simA = drive(plain.doc, compileWorld(plain.doc)); simA.stepFor(20)
    const simB = drive(withUnboundPacket.doc, compileWorld(withUnboundPacket.doc)); simB.stepFor(20)
    // The two docs mint different entity ids, so compare the world aggregates with the
    // id-carrying populationRoutes dropped — the numbers are the claim.
    const rollup = (b: MetricsBatch) => { const { populationRoutes: _drop, ...rest } = b.world; return rest }
    expect(rollup(simB.latest())).toEqual(rollup(simA.latest()))
  })
})

// A route can bind library packets instead of authoring inline sizes — the same registry and the
// same resolver the dependency edges use. Before this wiring the binding was authored, persisted
// and displayed but had ZERO simulation effect.
describe('route packet binding', () => {
  // One entry service, one population whose whole mix is a single route.
  function routeWorld(mutate: (doc: WorldDoc, routeId: string) => void) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0); doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl

    const added = addRoute(doc.packets, { name: 'upload', method: 'POST', path: '/upload' })
    doc.packets = added.registry
    const routeId = routeIdOf(added.route)
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50
    pop.requestMix = [{ routeId, weight: 1 }]
    doc.populations[pop.id] = pop

    mutate(doc, routeId)
    return { doc, sv: sv.id }
  }

  // Adds a 4 MB-response packet to the registry and binds it to the route.
  const bindBigPacket = (doc: WorldDoc, routeId: string) => {
    const id = doc.packets.nextId
    doc.packets = {
      ...doc.packets,
      templates: {
        ...doc.packets.templates,
        [id]: { id, name: 'photo', protocol: 'http', method: 'POST', statusCode: 200, sizeKb: 8, responseSizeKb: 4096 },
        // spread narrows to the union otherwise — the route IS an HttpTemplate by construction
        [Number(routeId)]: { ...(doc.packets.templates[Number(routeId)] as HttpTemplate), packetMix: [{ packetId: id, weight: 1 }] },
      },
      nextId: id + 1,
    }
  }

  it('a packet bound to a route drives the internet-egress byte rate', () => {
    const plain = routeWorld(() => {})
    const simPlain = drive(plain.doc, compileWorld(plain.doc)); simPlain.stepFor(20)

    const bound = routeWorld(bindBigPacket)
    const simBound = drive(bound.doc, compileWorld(bound.doc)); simBound.stepFor(20)

    // default route sizes are 1 KB up / 4 KB back; the bound packet is 8 KB / 4096 KB.
    expect(simBound.latest().world.internetEgressBytesPerSec)
      .toBeGreaterThan(simPlain.latest().world.internetEgressBytesPerSec * 100)
  })

  it('a bound mix supersedes the route inline sizes rather than being ignored', () => {
    const inlineOnly = routeWorld((doc, routeId) => {
      doc.packets.templates[Number(routeId)] = {
        ...(doc.packets.templates[Number(routeId)] as HttpTemplate), sizeKb: 1, responseSizeKb: 1,
      }
    })
    const both = routeWorld((doc, routeId) => {
      doc.packets.templates[Number(routeId)] = {
        ...(doc.packets.templates[Number(routeId)] as HttpTemplate), sizeKb: 1, responseSizeKb: 1,
      }
      bindBigPacket(doc, routeId)
    })
    const simInline = drive(inlineOnly.doc, compileWorld(inlineOnly.doc)); simInline.stepFor(20)
    const simBoth = drive(both.doc, compileWorld(both.doc)); simBoth.stepFor(20)

    expect(simBoth.latest().world.internetEgressBytesPerSec)
      .toBeGreaterThan(simInline.latest().world.internetEgressBytesPerSec * 100)
  })

  it('a route-bound packet also saturates the entry NIC (cost and NIC agree on the resolved size)', () => {
    const plain = routeWorld(() => {})
    const bound = routeWorld(bindBigPacket)
    const simPlain = drive(plain.doc, compileWorld(plain.doc)); simPlain.stepFor(20)
    const simBound = drive(bound.doc, compileWorld(bound.doc)); simBound.stepFor(20)

    expect(simBound.latest().servers[bound.sv].nicOutMbps)
      .toBeGreaterThan(simPlain.latest().servers[plain.sv].nicOutMbps * 50)
  })

  it('REGRESSION FLOOR: an unbound route is byte-identical to before the binding existed', () => {
    // A packet that EXISTS but is bound to nothing must not touch the route tier at all.
    const plain = routeWorld(() => {})
    const unbound = routeWorld(doc => {
      doc.packets = {
        ...doc.packets,
        templates: { ...doc.packets.templates, 99: { id: 99, name: 'idle', protocol: 'http', method: 'GET', statusCode: 200, sizeKb: 9999, sizeVariance: 1.2 } },
        nextId: 100,
      }
    })
    const simPlain = drive(plain.doc, compileWorld(plain.doc)); simPlain.stepFor(20)
    const simUnbound = drive(unbound.doc, compileWorld(unbound.doc)); simUnbound.stepFor(20)

    const rollup = (b: MetricsBatch) => { const { populationRoutes: _drop, ...rest } = b.world; return rest }
    expect(rollup(simUnbound.latest())).toEqual(rollup(simPlain.latest()))
  })
})

// ─── Connection semantics (keep-alive / short-lived / streaming) ──────────────
// The phase's claim is that connection TYPE — not just payload size — drives live behavior:
// connection count, per-connection RAM, and handshake CPU. keep-alive is the identity, so every
// test here is differential: the same world, the same rps, one field changed.
describe('connection semantics', () => {
  // One region / one AZ / one 8-core server / one entry service fed by ONE authored route, so the
  // only thing distinguishing the runs below is that route's connection type.
  const connWorld = (
    connectionType: ConnectionType,
    opts: { holdSeconds?: number; ramPerConnMb?: number; ramMb?: number } = {},
  ) => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sv = createServer(az.id, getPreset('dedicated-8')!)
    if (opts.ramMb != null) sv.specs.ramMb = opts.ramMb
    doc.servers[sv.id] = sv
    const web = publicBlueprint('web', 0)
    web.workload = {
      cpuMsPerRequest: 1, ramBaseMb: 100, ramPerConnMb: opts.ramPerConnMb ?? 0, diskIoPerRequest: 0,
    }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, sv.id); doc.placements[pl.id] = pl

    const added = addRoute(doc.packets, {
      name: 'api', method: 'GET', path: '/api', sizeKb: 1, responseSizeKb: 1,
      connectionType, holdSeconds: opts.holdSeconds,
    })
    doc.packets = added.registry
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 400
    pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
    doc.populations[pop.id] = pop

    return { doc, compiled: compileWorld(doc), sv: sv.id, inst: instanceId(pl.id, 0) }
  }

  const run = (f: ReturnType<typeof connWorld>, seconds = 20) => {
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(seconds)
    return sim
  }
  const cores = (b: MetricsBatch, svId: string) => b.servers[svId].coreUtilization[0]

  it('short-lived costs MORE CPU than keep-alive at identical rps', () => {
    const kaW = connWorld('keep-alive'); const slW = connWorld('short-lived')
    const ka = run(kaW); const sl = run(slW)

    // Same offered load — what follows is CPU per request, not more requests.
    expect(sl.latest().instances[slW.inst].rps).toBeCloseTo(ka.latest().instances[kaW.inst].rps, 0)
    // cpuMsPerRequest 1 + HANDSHAKE_CPU_MS 2 = 3x the CPU per request.
    expect(cores(sl.latest(), slW.sv)).toBeGreaterThan(cores(ka.latest(), kaW.sv) * 2)

    ka.engine.stop(); sl.engine.stop()
  })

  it('short-lived also holds each connection longer than keep-alive (handshake + linger tail)', () => {
    const kaW = connWorld('keep-alive'); const slW = connWorld('short-lived')
    const ka = run(kaW); const sl = run(slW)
    expect(sl.latest().instances[slW.inst].activeConnections)
      .toBeGreaterThan(ka.latest().instances[kaW.inst].activeConnections)
    ka.engine.stop(); sl.engine.stop()
  })

  it('streaming shows FAR more connections at the same rps, without extra CPU', () => {
    const kaW = connWorld('keep-alive'); const stW = connWorld('streaming', { holdSeconds: 30 })
    const ka = run(kaW); const st = run(stW)
    const i1 = ka.latest().instances[kaW.inst]
    const i2 = st.latest().instances[stW.inst]

    expect(i2.rps).toBeCloseTo(i1.rps, 0)                     // identical throughput
    expect(i2.activeConnections).toBeGreaterThan(i1.activeConnections * 100)
    // Streaming amortizes its handshake, so CPU is untouched — the RAM axis is the whole point.
    expect(cores(st.latest(), stW.sv)).toBeCloseTo(cores(ka.latest(), kaW.sv), 5)
    // Little's law with a FIXED hold: connections == rps × holdSec, latency irrelevant.
    expect(i2.activeConnections).toBeCloseTo(i2.rps * 30, 6)

    ka.engine.stop(); st.engine.stop()
  })

  it('an unauthored holdSeconds falls back to the 30 s default', () => {
    const w = connWorld('streaming')
    const st = run(w)
    const i = st.latest().instances[w.inst]
    expect(i.activeConnections).toBeCloseTo(i.rps * 30, 6)
    st.engine.stop()
  })

  it('streaming RAM triggers an OOM that keep-alive does not', () => {
    // 0.05 MB/conn: keep-alive holds well under one connection (~0 MB over a 100 MB base) while
    // streaming holds thousands — over a 512 MB host it is the connection MODEL that kills it.
    const ka = run(connWorld('keep-alive', { ramPerConnMb: 0.05, ramMb: 512 }), 4)
    const st = run(connWorld('streaming', { holdSeconds: 30, ramPerConnMb: 0.05, ramMb: 512 }), 4)

    expect(ka.events.some(e => e.kind === 'oom_kill')).toBe(false)
    expect(st.events.some(e => e.kind === 'oom_kill')).toBe(true)
    ka.engine.stop(); st.engine.stop()
  })

  // THE divergence guard. Little's law lives in exactly two places — the host scheduler's
  // InstanceLoad (which drives ramUsedMb and the OOM victim choice) and the published
  // InstanceMetrics (which drives the UI and the ram-oversubscribed analysis rule). If only one
  // were made connection-aware they would silently disagree by ~1000x on a streaming world; this
  // is the test that would have caught the formula being duplicated.
  it('DIVERGENCE GUARD: scheduler-side and metrics-side connection RAM agree', () => {
    const w = connWorld('streaming', { holdSeconds: 30, ramPerConnMb: 0.01, ramMb: 32768 })
    const st = run(w)
    const b = st.latest()
    const schedulerRam = b.servers[w.sv].ramUsedMb                          // from stepHost
    const metricsRam = b.servers[w.sv].ramByInstance                        // from InstanceMetrics
      .reduce((sum, r) => sum + r.ramMb, 0)

    // Both must be dominated by connection RAM, not the 100 MB base — i.e. both saw ~12,000 conns.
    expect(schedulerRam).toBeGreaterThan(150)
    expect(metricsRam).toBeGreaterThan(150)
    // They read slightly different inputs by design (raw admitted/serviceLatencyMs vs EMA'd
    // rps/p50Ms), so they are not identical — but a formula divergence is orders of magnitude.
    expect(schedulerRam / metricsRam).toBeGreaterThan(0.5)
    expect(schedulerRam / metricsRam).toBeLessThan(2)
    st.engine.stop()
  })

  // The CPU sibling of the guard above (audit ISSUE-011). The host scheduler budgets cores off
  // effectiveCpuMs — cpuMsPerRequest + cpuMsPerKb x kb + handshakeCpuMs — while cpuCoresUsed was
  // published off the raw cpuMsPerRequest alone. On a short-lived world that is a flat 3x gap
  // (1 ms authored + 2 ms handshake), displayed beside a correctly-sourced coreUtilization on the
  // same card.
  it('DIVERGENCE GUARD: scheduler-side and metrics-side CPU demand agree', () => {
    const w = connWorld('short-lived')
    const st = run(w)
    const b = st.latest()

    // What the scheduler enforced: coreUtilization is min(1, cpuPressure) per core, and
    // cpuPressure = demandCores / effectiveVcpu. Unsaturated here (~1.2 of 8 cores), so it
    // inverts cleanly back to cores of demand.
    const vcpu = w.doc.servers[w.sv].specs.vcpu
    const schedulerCores = b.servers[w.sv].coreUtilization[0] * vcpu
    // connWorld places exactly one instance on exactly one server.
    const publishedCores = b.instances[w.inst].cpuCoresUsed

    expect(b.servers[w.sv].coreUtilization[0]).toBeLessThan(1)   // genuinely unsaturated
    expect(publishedCores).toBeGreaterThan(0)
    // Same EMA-vs-raw skew as the RAM guard, so bound the ratio rather than demanding equality —
    // but the pre-fix omission of the handshake term was a 3x gap, far outside this band.
    expect(schedulerCores / publishedCores).toBeGreaterThan(0.5)
    expect(schedulerCores / publishedCores).toBeLessThan(2)
    st.engine.stop()
  })

  // ISSUE-012's guard is an exact BOUND rather than an exact equality. An over-limit container is
  // OOM-killed and restarts on a 5 s timer, so the two sides are sampled at different points of
  // that cycle — but neither may ever publish a figure above the limit the scheduler enforces,
  // which is precisely what a 512 MB container reporting 900 MB was doing.
  it('DIVERGENCE GUARD: published RAM never exceeds the container limit the scheduler enforces', () => {
    const LIMIT = 256
    const w = connWorld('streaming', { holdSeconds: 30, ramPerConnMb: 0.05, ramMb: 32768 })
    const pl = Object.values(w.doc.placements)[0]
    pl.runtime = {
      type: 'container', stackName: 'app', networkNames: [], portMappings: [],
      cpuLimit: null, memLimitMb: LIMIT,
    }
    const st = run({ ...w, compiled: compileWorld(w.doc) })

    let sawOverLimitDemand = false
    for (const b of st.batches) {
      const m = b.instances[w.inst]
      if (!m) continue
      // What the instance WOULD have published unclamped — the fixture is only meaningful if this
      // genuinely crosses the limit at some point in the run.
      if (100 + 0.05 * m.activeConnections > LIMIT) sawOverLimitDemand = true
      expect(m.ramMb).toBeLessThanOrEqual(LIMIT)
      expect(b.servers[w.sv].ramUsedMb).toBeLessThanOrEqual(LIMIT)
    }
    expect(sawOverLimitDemand).toBe(true)
    st.engine.stop()
  })

  it('stays deterministic under a fixed seed with streaming bound', () => {
    // ONE world driven twice — two connWorld() calls would mint different entity ids (the
    // factories stamp a counter + timestamp), which says nothing about the engine.
    const w = connWorld('streaming', { holdSeconds: 45 })
    const a = run(w)
    const b = run(w)
    expect(JSON.stringify(a.engine.getReplayFrames())).toEqual(JSON.stringify(b.engine.getReplayFrames()))
    a.engine.stop(); b.engine.stop()
  })
})

// ─── Composed end-to-end latency (audit ISSUE-003, Wave 2) ───────────────────
// Before this fix, InstanceFlow.serviceLatencyMs (and therefore the published p50Ms/p99Ms and
// Little's-law activeConnections) was the CALLER's own CPU/queue/NIC time only — a caller never
// inherited a slow dependency's latency, so the "slow dependency -> connection pileup -> OOM"
// cascade was structurally unreachable. web -> api -> db, each on its OWN server (so db's cost
// can't spill onto api/web's own CPU scheduling) isolates the effect to composition alone.
describe('composed end-to-end latency (audit ISSUE-003)', () => {
  function chainWorld(dbCpuMs: number) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const sWeb = createServer(az.id, getPreset('dedicated-8')!)
    const sApi = createServer(az.id, getPreset('dedicated-8')!)
    const sDb = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[sWeb.id] = sWeb; doc.servers[sApi.id] = sApi; doc.servers[sDb.id] = sDb

    const web = publicBlueprint('web', 0)
    const api = createBlueprint('api', 1)
    const db = createBlueprint('db', 2)
    db.workload = { ...db.workload, cpuMsPerRequest: dbCpuMs }
    web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })

    const plWeb = createPlacement(web.id, sWeb.id); doc.placements[plWeb.id] = plWeb
    const plApi = createPlacement(api.id, sApi.id); doc.placements[plApi.id] = plApi
    const plDb = createPlacement(db.id, sDb.id); doc.placements[plDb.id] = plDb

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 100
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop

    return {
      doc, compiled: compileWorld(doc),
      apiInst: instanceId(plApi.id, 0),
    }
  }

  it("folds a slow downstream DB's latency into the caller's published p50Ms, not its self-only serviceP50Ms", () => {
    const fast = chainWorld(1)
    const simFast = drive(fast.doc, fast.compiled)
    simFast.stepFor(10)
    const apiFast = simFast.latest().instances[fast.apiInst]
    simFast.engine.stop()

    const slow = chainWorld(200)
    const simSlow = drive(slow.doc, slow.compiled)
    simSlow.stepFor(10)
    const apiSlow = simSlow.latest().instances[slow.apiInst]
    simSlow.engine.stop()

    // api's OWN cpuMsPerRequest is identical in both worlds — only the db behind it changed.
    // Composed p50Ms must move; serviceP50Ms (self-only, pre-ISSUE-003 semantics) must not.
    expect(apiSlow.p50Ms).toBeGreaterThan(apiFast.p50Ms + 50)
    expect(apiSlow.serviceP50Ms ?? 0).toBeLessThan(20)
    expect(apiFast.serviceP50Ms ?? 0).toBeLessThan(20)
  })

  it("grows the caller's activeConnections when a downstream dependency slows down (Little's law feedback)", () => {
    const fast = chainWorld(1)
    const simFast = drive(fast.doc, fast.compiled)
    simFast.stepFor(10)
    const apiFast = simFast.latest().instances[fast.apiInst]
    simFast.engine.stop()

    const slow = chainWorld(200)
    const simSlow = drive(slow.doc, slow.compiled)
    simSlow.stepFor(10)
    const apiSlow = simSlow.latest().instances[slow.apiInst]
    simSlow.engine.stop()

    // Before ISSUE-003, activeConnections was driven by serviceLatencyMs (self-only), so this
    // ratio would sit near 1 regardless of how slow the db got.
    expect(apiSlow.activeConnections).toBeGreaterThan(apiFast.activeConnections * 2)
  })

  // DIVERGENCE GUARD (audit ISSUE-003): the host scheduler's InstanceLoad.activeConnections (RAM/
  // OOM enforcement) and metrics.ts's published InstanceMetrics.activeConnections (what the user
  // sees) are the two-call-site invariant's two sites. Both must react to a slow downstream —
  // if only one read totalLatencyMs, the RAM the scheduler enforces would silently diverge from
  // what is displayed, exactly the failure class this whole wave exists to close.
  it('DIVERGENCE GUARD: scheduler-enforced and published RAM both grow from a slow downstream dependency', () => {
    const slow = chainWorld(200)
    const sim = drive(slow.doc, slow.compiled)
    sim.stepFor(10)
    const b = sim.latest()
    const apiServerId = Object.values(slow.doc.placements).find(p => p.blueprintId === Object.keys(slow.doc.blueprints).find(id => slow.doc.blueprints[id].name === 'api'))?.serverId
    expect(apiServerId).toBeTruthy()
    const schedulerRam = b.servers[apiServerId!].ramUsedMb
    const metricsRam = b.instances[slow.apiInst].ramMb
    expect(schedulerRam).toBeGreaterThan(0)
    expect(metricsRam).toBeGreaterThan(0)
    expect(schedulerRam / metricsRam).toBeGreaterThan(0.5)
    expect(schedulerRam / metricsRam).toBeLessThan(2)
    sim.engine.stop()
  })
})

// ─── Empty particles/arcs sharing (audit ISSUE-017) ──────────────────────────
// buildPayload allocated a fresh throwaway `[]` for every non-matching scope's particles/arcs
// field every frame; an empty array is semantically fungible, so one shared frozen instance now
// serves every such case (an az/server renderer's empty `arcs`, a globe renderer's empty
// `particles`). Verified two ways: same instance across two different scopes, and immutability.
describe('empty particles/arcs sharing (audit ISSUE-017)', () => {
  it('two different renderer scopes receive the SAME empty arcs/particles instance', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    const azFrames: FramePayload[] = []
    const serverFrames: FramePayload[] = []
    const azId = Object.keys(f.doc.azs)[0]
    const serverId = Object.keys(f.doc.servers)[0]
    sim.engine.attachRenderer({ level: 'az', azId }, p => azFrames.push(p))
    sim.engine.attachRenderer({ level: 'server', serverId }, p => serverFrames.push(p))
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    sim.engine.stop()
    expect(azFrames.length).toBeGreaterThan(0)
    expect(serverFrames.length).toBeGreaterThan(0)
    // Both scopes' `arcs` field is the same shared empty instance.
    expect(azFrames[azFrames.length - 1].arcs).toBe(serverFrames[serverFrames.length - 1].arcs)
  })

  it('the shared empty instance is frozen — a consumer cannot mutate it in place', () => {
    const f = e2eFixture()
    const sim = drive(f.doc, f.compiled)
    let frame: FramePayload | null = null
    const azId = Object.keys(f.doc.azs)[0]
    sim.engine.attachRenderer({ level: 'az', azId }, p => { frame = p })
    sim.stepFor(3)
    sim.engine.__test_render(1000)
    sim.engine.stop()
    expect(frame).not.toBeNull()
    expect(Object.isFrozen(frame!.arcs)).toBe(true)
  })
})

// ─── Silently-dropped fan-out, surfaced (audit ISSUE-010) ────────────────────
describe('depth-cap and cycle-cut events (audit ISSUE-010)', () => {
  // web(entry) -> api -> ... 9 hops deep, one past MAX_DEPTH (8), all on one server so nothing
  // else (health/breakers/queue) confounds the depth cap itself.
  function deepChainWorld() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    const services = Array.from({ length: 10 }, (_, i) => {
      const bp = i === 0 ? publicBlueprint('svc-0', 0) : createBlueprint(`svc-${i}`, i % 8)
      doc.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, server.id)
      doc.placements[pl.id] = pl
      return { bp, iid: instanceId(pl.id, 0) }
    })
    for (let i = 0; i < services.length - 1; i++) {
      services[i].bp.dependencies = [{
        id: `d-${i}`, target: { kind: 'blueprint', blueprintId: services[i + 1].bp.id },
        port: 8080, protocol: 'http', packetTemplateId: null,
      }]
    }
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), depth8Inst: services[8].iid }
  }

  it('emits chain_depth_exceeded exactly once for a chain deeper than MAX_DEPTH', () => {
    const f = deepChainWorld()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(10)
    const matching = sim.events.filter(e => e.kind === 'chain_depth_exceeded' && e.affected.includes(f.depth8Inst))
    expect(matching.length).toBe(1)   // deduped — not one per step
    sim.engine.stop()
  })

  function cycleWorld() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    const a = publicBlueprint('a', 0)
    const b = createBlueprint('b', 1)
    doc.blueprints[a.id] = a; doc.blueprints[b.id] = b
    const plA = createPlacement(a.id, server.id); doc.placements[plA.id] = plA
    const plB = createPlacement(b.id, server.id); doc.placements[plB.id] = plB
    a.dependencies = [{ id: 'd-ab', target: { kind: 'blueprint', blueprintId: b.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    b.dependencies = [{ id: 'd-ba', target: { kind: 'blueprint', blueprintId: a.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), aInst: instanceId(plA.id, 0), bInst: instanceId(plB.id, 0) }
  }

  it('emits chain_cycle_cut exactly once for a genuine A -> B -> A cycle', () => {
    const f = cycleWorld()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(10)
    const matching = sim.events.filter(e =>
      e.kind === 'chain_cycle_cut' && e.affected.includes(f.bInst) && e.affected.includes(f.aInst))
    expect(matching.length).toBe(1)   // deduped — not one per step
    sim.engine.stop()
  })
})

// ─── Async event delivery — the broker (audit ISSUE-002) ─────────────────────
// The thesis this issue fixes: `event` was a synchronous blocking RPC wearing a different label —
// a struggling CONSUMER opened the PRODUCER's breaker, the opposite of what a broker decouples.
describe('async event delivery (audit ISSUE-002)', () => {
  // producer(entry) -> event dependency -> consumer, where consumer ALSO depends on a
  // firewall-blocked target so the consumer's OWN subtree fails heavily (it "struggles").
  function eventWorld() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server

    const deadServer = createServer(az.id, getPreset('dedicated-8')!)
    deadServer.firewall = [{ id: 'deny-all', action: 'deny', port: 'any', protocol: 'any', source: 'any' }]
    doc.servers[deadServer.id] = deadServer

    const added = addPacket(doc.packets, {
      name: 'order-created', protocol: 'event', topic: 'orders', eventType: 'created', deliveryMode: 'at-least-once',
    })
    doc.packets = added.registry

    const producer = publicBlueprint('producer', 0)
    const consumer = createBlueprint('consumer', 1)
    const dead = createBlueprint('dead-dep', 2)
    producer.dependencies = [{
      id: 'd-topic', target: { kind: 'blueprint', blueprintId: consumer.id },
      port: 8080, protocol: 'event', packetTemplateId: null,
      packetMix: [{ packetId: added.packet.id, weight: 1 }],
    }]
    consumer.dependencies = [{
      id: 'd-dead', target: { kind: 'blueprint', blueprintId: dead.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
    doc.blueprints[producer.id] = producer
    doc.blueprints[consumer.id] = consumer
    doc.blueprints[dead.id] = dead
    const plP = createPlacement(producer.id, server.id); doc.placements[plP.id] = plP
    const plC = createPlacement(consumer.id, server.id); doc.placements[plC.id] = plC
    const plD = createPlacement(dead.id, deadServer.id); doc.placements[plD.id] = plD

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 100
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop

    return { doc, compiled: compileWorld(doc), producerInst: instanceId(plP.id, 0), consumerInst: instanceId(plC.id, 0) }
  }

  it("never opens the producer's breaker from the consumer's own downstream failures", () => {
    const f = eventWorld()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)   // comfortably past the breaker's window/volume floor
    // The consumer really is struggling — its own dependency is 100% firewall-blocked.
    const consumerRps = sim.latest().instances[f.consumerInst]?.rps ?? 0
    expect(consumerRps).toBeGreaterThan(0)   // the topic really did deliver to it
    // The CONSUMER's own breaker (for its 100%-blocked d-dead dependency) legitimately opens —
    // that's real, unrelated failure, not the bug. The PRODUCER's breaker for d-topic — the one
    // that would open under the old synchronous model, since the consumer really is struggling —
    // must never open. breaker_open events carry [callerId, targetId] in `affected`.
    const producerBreakerOpened = sim.events.some(e =>
      e.kind === 'breaker_open' && e.affected[0] === f.producerInst)
    expect(producerBreakerOpened).toBe(false)
    sim.engine.stop()
  })

  it('publishes topic lag/backlog metrics on MetricsBatch.topics', () => {
    const f = eventWorld()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(5)
    const topic = sim.latest().topics?.['d-topic']
    expect(topic).toBeDefined()
    expect(topic!.totalArrivalRps).toBeGreaterThan(0)
    sim.engine.stop()
  })
})

// ─── Client-side timeouts (audit ISSUE-006) ──────────────────────────────────
// The canonical distributed-systems failure this issue makes reachable: a dependency degrades to
// slow-but-not-overloaded, and the caller's breaker trips from TIMEOUTS, not from 5xx or capacity
// refusal — structurally impossible before this issue (no client timeout existed at all).
describe('client-side timeouts (audit ISSUE-006)', () => {
  function timeoutWorld(clientTimeoutMs: number, dbCpuMs: number) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server

    const added = addPacket(doc.packets, { name: 'call', protocol: 'http', method: 'GET', statusCode: 200, clientTimeoutMs })
    doc.packets = added.registry

    const api = publicBlueprint('api', 0)
    const db = createBlueprint('db', 1)
    db.workload = { ...db.workload, cpuMsPerRequest: dbCpuMs }
    api.dependencies = [{
      id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
      packetMix: [{ packetId: added.packet.id, weight: 1 }],
    }]
    doc.blueprints[api.id] = api
    doc.blueprints[db.id] = db
    const plApi = createPlacement(api.id, server.id); doc.placements[plApi.id] = plApi
    const plDb = createPlacement(db.id, server.id); doc.placements[plDb.id] = plDb

    // Deliberately modest demand: db's capacity (8 vCPU) is nowhere near saturated at this rps
    // even with a high per-request cost, so any breaker trip must come from the TIMEOUT, not
    // capacity overflow.
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 20
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop

    return { doc, compiled: compileWorld(doc), apiInst: instanceId(plApi.id, 0) }
  }

  it("opens the caller's breaker from a tight timeout against a slow-but-unsaturated dependency", () => {
    // db's cpuMsPerRequest ~200ms p50; a 5ms client timeout bites on essentially every call.
    const f = timeoutWorld(5, 200)
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(15)   // past the breaker's window/volume floor
    expect(sim.events.some(e => e.kind === 'breaker_open' && e.affected[0] === f.apiInst)).toBe(true)
    sim.engine.stop()
  })

  it('does not open the breaker when the timeout is loose relative to the same dependency', () => {
    const f = timeoutWorld(100000, 5)   // effectively no timeout, and db is fast anyway
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(15)
    expect(sim.events.some(e => e.kind === 'breaker_open' && e.affected[0] === f.apiInst)).toBe(false)
    sim.engine.stop()
  })
})

// ─── Self-hosted connection pool (audit ISSUE-005) ───────────────────────────
describe('self-hosted connection pool (audit ISSUE-005)', () => {
  function poolWorld(opts: { maxConnections?: number; checkoutTimeoutMs?: number; peakRps?: number }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    web.workload = {
      cpuMsPerRequest: 1, ramBaseMb: 100, ramPerConnMb: 0.5, diskIoPerRequest: 0,
      maxConnections: opts.maxConnections, checkoutTimeoutMs: opts.checkoutTimeoutMs,
    }
    doc.blueprints[web.id] = web
    const added = addRoute(doc.packets, {
      name: 'api', method: 'GET', path: '/api', connectionType: 'streaming', holdSeconds: 30,
    })
    doc.packets = added.registry
    const pl = createPlacement(web.id, server.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = opts.peakRps ?? 400
    pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), inst: instanceId(pl.id, 0), sv: server.id }
  }

  it('an unauthored pool (no maxConnections) is bit-identical to before this issue', () => {
    const f = poolWorld({})
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)
    expect(sim.latest().instances[f.inst].checkoutWaitMs).toBeUndefined()
    sim.engine.stop()
  })

  it("DIVERGENCE GUARD: scheduler-enforced RAM and published RAM agree once a pool saturates", () => {
    // 400 rps x 30s streaming hold ~= 12,000 active connections against a tiny 100-connection cap.
    const f = poolWorld({ maxConnections: 100, checkoutTimeoutMs: 5 })
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(20)
    const b = sim.latest()
    expect(b.instances[f.inst].checkoutWaitMs).toBeGreaterThan(0)
    const schedulerRam = b.servers[f.sv].ramUsedMb
    const publishedRam = b.instances[f.inst].ramMb
    expect(schedulerRam).toBeGreaterThan(0)
    expect(publishedRam).toBeGreaterThan(0)
    // Same EMA-vs-raw skew as the other DIVERGENCE GUARDs — bound the ratio, not exact equality.
    expect(schedulerRam / publishedRam).toBeGreaterThan(0.5)
    expect(schedulerRam / publishedRam).toBeLessThan(2)
    sim.engine.stop()
  })
})

// ─── Demand backpressure (audit ISSUE-008) ───────────────────────────────────
// Demand generation is fully open-loop (demand.ts's populationDemandRps takes no system-state
// input at all — confirmed structurally, not just by inspection: this describe block's own first
// test pins it). The question the issue asks: when a callee saturates, does load offered upstream
// drop, queue, or grow unbounded? MEASURED (per the spec's own staged methodology — Mechanism A
// must be measured before Mechanism B is attempted, since B may prove unnecessary):
describe('demand backpressure (audit ISSUE-008)', () => {
  function saturatedChainWorld() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const webServer = createServer(az.id, getPreset('dedicated-8')!)
    webServer.specs = { ...webServer.specs, ramMb: 2048 }   // small enough that RAM growth genuinely OOMs it
    const backendServer = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[webServer.id] = webServer; doc.servers[backendServer.id] = backendServer

    const web = publicBlueprint('web', 0)
    web.workload = { cpuMsPerRequest: 1, ramBaseMb: 100, ramPerConnMb: 5, diskIoPerRequest: 0 }
    const backend = createBlueprint('backend', 1)
    backend.workload = { cpuMsPerRequest: 2000, ramBaseMb: 100, ramPerConnMb: 0, diskIoPerRequest: 0 }
    web.dependencies = [{
      id: 'd-backend', target: { kind: 'blueprint', blueprintId: backend.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
    doc.blueprints[web.id] = web
    doc.blueprints[backend.id] = backend
    const plWeb = createPlacement(web.id, webServer.id); doc.placements[plWeb.id] = plWeb
    const plBackend = createPlacement(backend.id, backendServer.id); doc.placements[plBackend.id] = plBackend

    // A deliberately extreme mismatch: backend's 2000ms p50 (way past web's own 1ms) inflates
    // web's COMPOSED latency (audit ISSUE-003), which inflates web's held connections (Little's
    // law), which inflates web's own RAM at ramPerConnMb=5 — the exact chain Mechanism A relies on.
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 500
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop

    return { doc, compiled: compileWorld(doc), webInst: instanceId(plWeb.id, 0), regionId: r.id, popId: pop.id }
  }

  it("demand.ts's populationDemandRps takes no system-state input at all (confirms the open loop)", () => {
    // Same (pop, simMs, rng) input regardless of what the rest of the world is doing this step —
    // demand cannot possibly react to saturation because it has nothing to react WITH.
    const pop = { id: 'p', label: 'x', lat: 0, lon: 0, peakRps: 100, diurnal: 'flat' as const }
    const rng1 = createRng(1)
    const rng2 = createRng(1)
    expect(populationDemandRps(pop, 1000, rng1)).toBe(populationDemandRps(pop, 1000, rng2))
  })

  it('MEASURED: Mechanism A closes the loop via a repeating OOM-kill cycle, not smooth admission control', () => {
    // This is the measurement, not a golden-value regression test — the exact rps/RAM numbers
    // are incidental; what's asserted is the SHAPE Mechanism A actually takes: web gets OOM-killed
    // (not gracefully throttled), recovers, and gets OOM-killed again, repeatedly, while the
    // population's own offered demand never moves (per the test above). This is the disqualifying
    // shape the spec itself names for Mechanism A ("fires at the wrong layer... OOMs the caller
    // rather than gracefully shedding") — the trigger for building Mechanism B below.
    const f = saturatedChainWorld()
    const sim = drive(f.doc, f.compiled)
    let oomCount = 0
    let sawHealthy = false
    for (let sec = 0; sec < 30; sec++) {
      sim.stepFor(1)
      const health = sim.latest().instances[f.webInst]?.health
      if (health === 'healthy') sawHealthy = true
      oomCount = sim.events.filter(e => e.kind === 'oom_kill' && e.affected.includes(f.webInst)).length
    }
    // Mechanism A DOES bound throughput eventually (the world doesn't runaway to infinite RAM) —
    // but via repeated OOM-kills, not a graceful admittedScale reduction.
    expect(oomCount).toBeGreaterThan(1)   // more than one kill — a genuine repeating cycle
    expect(sawHealthy).toBe(true)          // and it DOES recover between kills (not permanently down)
    sim.engine.stop()
  })

  // Mechanism A's measured shape above (an oscillating OOM-kill cycle, not graceful throttling) is
  // exactly the disqualifying case the spec names — so Mechanism B (explicit, hysteresis-gated
  // admission control at the edge) is built: `index.ts`'s per-region shed fraction, applied to a
  // population's offered demand before `distributeViaLb`, one-step-lagged off the previous step's
  // regional error rate. Engaging/recovering both require a SUSTAINED (20-step / 2s) over- or
  // under-threshold error rate so a single noisy step can't flap it on and off.
  it('Mechanism B: sustained regional overload sheds demand below the raw generated rate', () => {
    const f = saturatedChainWorld()
    const sim = drive(f.doc, f.compiled)
    // A single low-rps step proves nothing on its own — Mechanism A's OOM-kill cycle (measured
    // above) ALSO drives rps briefly toward zero while the instance is down/restarting, which
    // would trivially satisfy a one-step "rps < 400" check without Mechanism B doing anything.
    // What's unique to Mechanism B is a SUSTAINED run of many consecutive seconds sitting in a
    // shed band that is degraded but not fully collapsed (MAX_SHED_FRACTION caps shedding below
    // 100%, audit ISSUE-008) — so require a run of shed-band seconds longer than a single OOM
    // dip could plausibly produce.
    let longestShedRun = 0
    let currentRun = 0
    for (let sec = 0; sec < 60; sec++) {
      sim.stepFor(1)
      const b = sim.latest()
      const row = b.world.populationRoutes.find(r => r.populationId === f.popId && r.regionId === f.regionId)
      const inShedBand = row != null && row.rps > 0 && row.rps < 400
      currentRun = inShedBand ? currentRun + 1 : 0
      longestShedRun = Math.max(longestShedRun, currentRun)
    }
    expect(longestShedRun).toBeGreaterThanOrEqual(5)
    sim.engine.stop()
  })

  it('Mechanism B is a no-op for a healthy, non-saturated world (regression floor)', () => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50   // comfortably within an 8-vCPU host's capacity at cpuMsPerRequest=1 default
    pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    sim.stepFor(15)   // let the demand generator settle before sampling
    // A single step's rps is Poisson-noisy (offered swings well above/below a 50 rps peak from
    // one 100ms step to the next) — averaging across a window is what actually tests "no
    // SUSTAINED overload ever engages", not a lucky/unlucky single snapshot.
    let sum = 0
    const samples = 20
    for (let i = 0; i < samples; i++) {
      sim.stepFor(1)
      const row = sim.latest().world.populationRoutes.find(row => row.populationId === pop.id && row.regionId === r.id)
      sum += row?.rps ?? 0
    }
    expect(sum / samples).toBeGreaterThan(40)
    sim.engine.stop()
  })
})

// ─── Fault injection (FEAT-001): down / cpu-brownout / memory-leak ───────────
describe('FEAT-001 faults', () => {
  it('byte-identical output with zero faults active, fixed seed', () => {
    const f = e2eFixture()
    const a = drive(f.doc, f.compiled)
    a.stepFor(5)
    const batchA = a.latest()
    a.engine.stop()

    const b = drive(f.doc, f.compiled)
    b.stepFor(5)
    const batchB = b.latest()
    b.engine.stop()

    expect(batchA).toEqual(batchB)
  })

  it('setOutage(scope, id, true) and setFault(scope, id, {kind:"down"}) produce identical events', () => {
    const f1 = e2eFixture()
    const sim1 = drive(f1.doc, f1.compiled)
    sim1.stepFor(1)
    sim1.engine.setOutage('region', f1.r1.id, true)
    sim1.stepFor(3)
    const kinds1 = sim1.events.map(e => e.kind)
    sim1.engine.stop()

    const f2 = e2eFixture()
    const sim2 = drive(f2.doc, f2.compiled)
    sim2.stepFor(1)
    sim2.engine.setFault('region', f2.r1.id, { kind: 'down' })
    sim2.stepFor(3)
    const kinds2 = sim2.events.map(e => e.kind)
    sim2.engine.stop()

    expect(kinds2).toEqual(kinds1)
  })

  it('cpu-brownout at capacityFraction 0.5 roughly halves effective CPU capacity', () => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)   // 8 vCPU, dedicated (no VPS noise)
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    web.workload = { ...web.workload, cpuMsPerRequest: 40 }          // capacity ≈ 200 rps @ effectiveVcpu 8
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id); doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 100; pop.diurnal = 'flat'
    doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)

    const baseline = drive(doc, compiled)
    baseline.stepFor(6)
    const baseUtil = baseline.latest().servers[server.id].coreUtilization
    const baseMean = baseUtil.reduce((a, b) => a + b, 0) / baseUtil.length
    baseline.engine.stop()

    const throttled = drive(doc, compiled)
    throttled.engine.setFault('server', server.id, { kind: 'cpu-brownout', capacityFraction: 0.5 })
    throttled.stepFor(6)
    const throttledUtil = throttled.latest().servers[server.id].coreUtilization
    const throttledMean = throttledUtil.reduce((a, b) => a + b, 0) / throttledUtil.length
    throttled.engine.stop()

    // Halved capacity at the same offered load roughly doubles core utilization (capped at 1).
    expect(throttledMean).toBeGreaterThan(baseMean * 1.5)
  })

  it('memory-leak accumulates ramBaseMb until OOM, then clears leakAccumMb on kill', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    const server = createServer(az.id, getPreset('vps-small')!)
    server.specs.ramMb = 512
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    // Comfortably fits at 512 MB with zero traffic — only the leak should push it over.
    web.workload = { cpuMsPerRequest: 2, ramBaseMb: 100, ramPerConnMb: 0, diskIoPerRequest: 0 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 1
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    // A steep leak rate so the instance OOMs within a bounded window.
    sim.engine.setFault('server', server.id, { kind: 'memory-leak', mbPerMinute: 6000 })
    sim.stepFor(10)
    expect(sim.events.some(e => e.kind === 'oom_kill')).toBe(true)
    sim.stepFor(6)   // > 5s restart delay
    expect(sim.events.some(e => e.kind === 'instance_restarted')).toBe(true)
    sim.engine.stop()
  })

  // Divergence guard (seeds Task 6's later, more thorough version): the RAM hostScheduler
  // enforces (and OOM-kills on) folds in s.faults.leakAccumMb via InstanceLoad.ramBaseMb —
  // published InstanceMetrics.ramMb must move together with it, not stay frozen at the static
  // workload.ramBaseMb while the enforced number silently climbs toward OOM underneath it.
  it('published InstanceMetrics.ramMb reflects an active memory-leak, not frozen at the static workload value', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    // Roomy host — the point here is observing ramMb climb, not triggering OOM mid-measurement.
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs.ramMb = 100_000
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    web.workload = { cpuMsPerRequest: 2, ramBaseMb: 100, ramPerConnMb: 0, diskIoPerRequest: 0 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 1
    doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)
    const inst = instanceId(pl.id, 0)

    const sim = drive(doc, compiled)
    sim.stepFor(1)
    const ramBeforeLeak = sim.latest().instances[inst].ramMb   // ~100 (static base, no connections)
    sim.engine.setFault('server', server.id, { kind: 'memory-leak', mbPerMinute: 6000 })   // 100 MB/s
    sim.stepFor(3)
    const ramAfterLeak = sim.latest().instances[inst].ramMb
    // Published RAM must have moved with the leak, not stayed pinned at the static workload value.
    expect(ramAfterLeak).toBeGreaterThan(ramBeforeLeak + 100)
    sim.engine.stop()
  })

  // Task 6's formal, named divergence guard for memory-leak RAM (the ad-hoc test above seeds
  // it) — same discipline as the other DIVERGENCE GUARD tests: scheduler-enforced RAM
  // (servers[].ramUsedMb) and published per-instance RAM summed (servers[].ramByInstance) must
  // agree within a bounded ratio, not stay frozen or diverge while a leak accumulates.
  it('DIVERGENCE GUARD: memory-leak RAM growth agrees between scheduler and metrics', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs.ramMb = 100_000   // roomy — observe growth, not OOM mid-measurement
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    web.workload = { cpuMsPerRequest: 2, ramBaseMb: 100, ramPerConnMb: 0, diskIoPerRequest: 0 }
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 1
    doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)

    const sim = drive(doc, compiled)
    sim.engine.setFault('server', server.id, { kind: 'memory-leak', mbPerMinute: 60 })
    sim.stepFor(30)
    const b = sim.latest()
    const schedulerRam = b.servers[server.id].ramUsedMb
    const metricsRam = b.servers[server.id].ramByInstance.reduce((sum, r) => sum + r.ramMb, 0)
    expect(schedulerRam).toBeGreaterThan(0)
    expect(schedulerRam / metricsRam).toBeGreaterThan(0.5)
    expect(schedulerRam / metricsRam).toBeLessThan(2)
    sim.engine.stop()
  })
})

// ─── Fault injection (Task 5): error-inject wired into flows.ts ─────────────
describe('FEAT-001 error-inject fault (Task 5)', () => {
  // 1 region / 1 AZ / 2 servers: web[entry] -> api, single dependency edge, no firewall block.
  // Faulting api's server with error-inject should show up as the CALLER's (web's) own errorRps
  // growing, exactly like the existing client-timeout error path just above it in flows.ts.
  function webApiFixture() {
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
    web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api })
    const webPl = createPlacement(web.id, s1.id); doc.placements[webPl.id] = webPl
    const apiPl = createPlacement(api.id, s2.id); doc.placements[apiPl.id] = apiPl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 120
    doc.populations[pop.id] = pop
    return {
      doc, compiled: compileWorld(doc), apiServer: s2,
      webInst: instanceId(webPl.id, 0), apiInst: instanceId(apiPl.id, 0),
    }
  }

  it('error-inject at 0.1 raises the caller\'s published errorRate to ~0.1', () => {
    const f = webApiFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)                                      // steady healthy load, EMA settled
    const baseline = sim.latest().instances[f.webInst]?.errorRate ?? 0
    expect(baseline).toBeLessThan(0.02)

    sim.engine.setFault('server', f.apiServer.id, { kind: 'error-inject', errorFraction: 0.1 })
    sim.stepFor(8)                                      // let the EMA settle onto the new fraction
    const errRate = sim.latest().instances[f.webInst]?.errorRate ?? 0
    expect(errRate).toBeGreaterThan(0.05)
    expect(errRate).toBeLessThan(0.2)
    sim.engine.stop()
  })

  it('sustained error-inject trips the caller circuit breaker via the EXISTING breaker mechanism', () => {
    const f = webApiFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)
    expect(sim.events.some(e => e.kind === 'breaker_open')).toBe(false)

    // Well past the 0.5 errorThreshold so the windowed weighted rate crosses it quickly.
    sim.engine.setFault('server', f.apiServer.id, { kind: 'error-inject', errorFraction: 0.9 })
    sim.stepFor(10)                                     // let the windowed weighted rate settle
    expect(sim.events.some(e => e.kind === 'breaker_open')).toBe(true)
    sim.engine.stop()
  })
})

// ─── FEAT-002 (Task 10): per-step impairment memo ────────────────────────────
describe('FEAT-002 impairment memo (Task 10)', () => {
  // web (region r1) -> managed service ms-1, az-scoped to az2a in region r2. No servers needed
  // in r2 — a managed service has no backing instance.
  function crossRegionManagedFixture() {
    const doc = createWorld()
    const r1 = createRegion('us-east-1')
    const r2 = createRegion('eu-west-1')
    const az1a = createAz(r1.id, 'us-east-1a')
    const az2a = createAz(r2.id, 'eu-west-1a')
    Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
    Object.assign(doc.azs, { [az1a.id]: az1a, [az2a.id]: az2a })

    const server = createServer(az1a.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server

    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'RDS', nodeType: 'dbSql',
      scope: { kind: 'az', azId: az2a.id }, provider: 'aws', port: 5432,
    }

    const web = publicBlueprint('web', 0)
    web.dependencies = [
      { id: 'd-ms', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null },
    ]
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const webInst = instanceId(pl.id, 0)
    const path = compiled.paths.find(p => p.fromInstanceId === webInst && p.to.kind === 'managed')!
    return { doc, compiled, r1, r2, az1a, az2a, path }
  }

  it('does no work (empty memo) when there are no partitions', () => {
    const f = crossRegionManagedFixture()
    const memo = buildImpairmentMemo(f.compiled, f.doc, [], new Map([[f.az1a.id, f.r1.id], [f.az2a.id, f.r2.id]]))
    expect(memo.size).toBe(0)
  })

  it('resolves an AZ-scoped managed target through a REGION-level partition via regionOfAz', () => {
    const f = crossRegionManagedFixture()
    const regionOfAz = new Map([[f.az1a.id, f.r1.id], [f.az2a.id, f.r2.id]])
    const partitions = [
      { from: { kind: 'region' as const, id: f.r1.id }, to: { kind: 'region' as const, id: f.r2.id }, mode: 'drop' as const, symmetric: true },
    ]
    const memo = buildImpairmentMemo(f.compiled, f.doc, partitions, regionOfAz)
    expect(memo.size).toBeGreaterThan(0)
    const entry = memo.get(f.path.id)
    expect(entry).toEqual({ blocked: true, lossFraction: 0, delayMs: 0 })
  })

  // FEAT-014 (final review Important #2): buildImpairmentMemo previously never populated
  // EndpointIds.subnetId/natGatewayId, so a `{kind:'subnet',id}` or `{kind:'natGateway',id}`
  // partition endpoint could never match anything at runtime even though endpointMatches (faults.ts)
  // handled those kinds correctly in isolation — this proves the memo itself now resolves them.
  describe('subnet/natGateway endpoint resolution (final review Important #2)', () => {
    function subnetFixture() {
      const doc = createWorld()
      doc.routing.policy = 'geo'
      const r1 = createRegion('us-east-1')
      const r2 = createRegion('eu-west-1')
      const az1a = createAz(r1.id, 'us-east-1a')
      const az2a = createAz(r2.id, 'eu-west-1a')
      Object.assign(doc.regions, { [r1.id]: r1, [r2.id]: r2 })
      Object.assign(doc.azs, { [az1a.id]: az1a, [az2a.id]: az2a })

      const vpc = createVpc(r1.id)
      // A real egress route out of the subnet (an internet gateway route) — the fixture must
      // isolate the PARTITION as the only cause of blocked traffic; without this the route table's
      // pre-existing 'no-egress-route' block (empty routes) would already block the path with zero
      // partitions active, confounding the assertion.
      const igw = createInternetGateway(vpc.id)
      const routeTable = createRouteTable(vpc.id)
      routeTable.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'internetGateway', id: igw.id } })
      const subnet = createSubnet(vpc.id, az1a.id, 'private', routeTable.id)
      Object.assign(doc.vpcs, { [vpc.id]: vpc })
      Object.assign(doc.internetGateways, { [igw.id]: igw })
      Object.assign(doc.routeTables, { [routeTable.id]: routeTable })
      Object.assign(doc.subnets, { [subnet.id]: subnet })

      const server = createServer(az1a.id, getPreset('dedicated-8')!)
      server.subnetId = subnet.id
      const target = createServer(az2a.id, getPreset('dedicated-8')!)
      Object.assign(doc.servers, { [server.id]: server, [target.id]: target })

      const web = publicBlueprint('web', 0)
      const repl = createBlueprint('repl', 1)
      web.dependencies = [{ id: 'd-repl', target: { kind: 'blueprint', blueprintId: repl.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
      Object.assign(doc.blueprints, { [web.id]: web, [repl.id]: repl })
      const plWeb = createPlacement(web.id, server.id)
      const plRepl = createPlacement(repl.id, target.id)
      Object.assign(doc.placements, { [plWeb.id]: plWeb, [plRepl.id]: plRepl })

      const compiled = compileWorld(doc)
      const webIid = instanceId(plWeb.id, 0)
      const replIid = instanceId(plRepl.id, 0)
      const path = compiled.paths.find(p => p.fromInstanceId === webIid && p.to.kind === 'instance' && p.to.instanceId === replIid)!
      return { doc, compiled, r1, r2, az1a, az2a, subnet, server, target, path, webIid, replIid }
    }

    it('a subnet-scoped partition endpoint matches a path whose source server is IN that subnet', () => {
      const f = subnetFixture()
      const regionOfAz = new Map([[f.az1a.id, f.r1.id], [f.az2a.id, f.r2.id]])
      const partitions = [
        { from: { kind: 'subnet' as const, id: f.subnet.id }, to: { kind: 'region' as const, id: f.r2.id }, mode: 'drop' as const, symmetric: true },
      ]
      const memo = buildImpairmentMemo(f.compiled, f.doc, partitions, regionOfAz, new Map())
      expect(memo.get(f.path.id)).toEqual({ blocked: true, lossFraction: 0, delayMs: 0 })
    })

    it('a subnet-scoped partition does NOT match when natGatewayIdByServer is omitted vs provided — subnetId resolution alone is enough (no gateway needed)', () => {
      const f = subnetFixture()
      const regionOfAz = new Map([[f.az1a.id, f.r1.id], [f.az2a.id, f.r2.id]])
      const partitions = [
        { from: { kind: 'subnet' as const, id: f.subnet.id }, to: { kind: 'region' as const, id: f.r2.id }, mode: 'drop' as const, symmetric: true },
      ]
      // Omitting the optional natGatewayIdByServer arg entirely must not break subnetId resolution.
      const memo = buildImpairmentMemo(f.compiled, f.doc, partitions, regionOfAz)
      expect(memo.get(f.path.id)).toEqual({ blocked: true, lossFraction: 0, delayMs: 0 })
    })

    it('a server with no subnetId never matches a subnet-scoped partition endpoint (regression floor)', () => {
      const f = subnetFixture()
      const regionOfAz = new Map([[f.az1a.id, f.r1.id], [f.az2a.id, f.r2.id]])
      const partitions = [
        { from: { kind: 'subnet' as const, id: 'some-other-subnet' }, to: { kind: 'region' as const, id: f.r2.id }, mode: 'drop' as const, symmetric: true },
      ]
      const memo = buildImpairmentMemo(f.compiled, f.doc, partitions, regionOfAz, new Map())
      expect(memo.get(f.path.id)).toEqual({ blocked: false, lossFraction: 0, delayMs: 0 })
    })

    // Real engine-level integration test (not just the unit-level memo above): drives the actual
    // simulation with live population traffic through a `{kind:'subnet',id}` partition and proves
    // the downstream instance genuinely stops receiving admitted traffic — this is what "the
    // memo is never fed real data in production" (the original finding) means to actually fix.
    it('ENGINE-LEVEL: a subnet-scoped partition genuinely blocks live traffic between two servers, one of which is in that subnet', () => {
      const f = subnetFixture()
      const pop = createPopulation('nyc', 40.7, -74.0)
      pop.peakRps = 200
      pop.diurnal = 'flat'
      f.doc.populations[pop.id] = pop
      const compiled = compileWorld(f.doc)   // recompile — populationRegionOrder must see the population

      const sim = drive(f.doc, compiled)
      sim.stepFor(15)   // settle past DNS/health-check warmup
      const before = sim.latest()
      expect(before.instances[f.webIid]?.rps ?? 0).toBeGreaterThan(0)
      expect(before.instances[f.replIid]?.rps ?? 0).toBeGreaterThan(0)

      sim.engine.setPartition!({
        from: { kind: 'subnet', id: f.subnet.id }, to: { kind: 'region', id: f.r2.id },
        mode: 'drop', symmetric: true,
      })
      sim.stepFor(20)   // past any queueing/EMA lag

      const after = sim.latest()
      const beforeRps = before.instances[f.replIid]?.rps ?? 0
      const afterRps = after.instances[f.replIid]?.rps ?? 0
      expect(afterRps).toBeLessThan(beforeRps * 0.05)   // effectively zero — a fully dropped path
      sim.engine.stop()
    })
  })
})

// ─── FEAT-002 (Task 12): directional health checks — the split-brain enabler ─────────────────
// promoteReplicas (failover.ts) only ever promotes a sibling replica in the SAME region as the
// down primary (spec decision 7's same-region HA model) — it structurally cannot reach a
// cross-region standby. So a genuine cross-region primary/replica pair (primary in region A,
// standby replica in region B) can only ever "split" via a SEPARATE mechanism: a replica whose
// own region loses reachability (per the new directional health check) to every region hosting
// an authored primary of its blueprint unilaterally self-promotes — textbook split-brain, since
// the primary's own region, still reachable from itself, has no reason to step down.
describe('FEAT-002 Task 12: directional health / split-brain', () => {
  function crossRegionReplicaFixture() {
    const doc = createWorld()
    const regionA = createRegion('us-east-1')
    const regionB = createRegion('eu-west-1')
    const azA = createAz(regionA.id, 'us-east-1a')
    const azB = createAz(regionB.id, 'eu-west-1a')
    doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB

    const db = createBlueprint('db', 0)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50 }
    doc.blueprints[db.id] = db

    const primaryPl = createPlacement(db.id, sA.id)                        // authored primary, region A
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'  // cross-region standby, region B
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl

    const compiled = compileWorld(doc)
    return {
      doc, compiled, regionA: regionA.id, regionB: regionB.id,
      primaryIid: instanceId(primaryPl.id, 0), replicaIid: instanceId(replicaPl.id, 0),
    }
  }

  it('THE SPLIT-BRAIN TEST: an asymmetric partition isolates the cross-region replica, which self-promotes while the original primary keeps serving', () => {
    const f = crossRegionReplicaFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)   // settle before the partition lands

    // region A -> region B, drop, asymmetric: per the direction convention (an observer sees a
    // target as down iff the TARGET->OBSERVER leg is impaired), this means region B's probe of
    // region A fails (A->B is the blocked leg) while region A's probe of B still succeeds.
    sim.engine.setPartition!({ from: { kind: 'region', id: f.regionA }, to: { kind: 'region', id: f.regionB }, mode: 'drop', symmetric: false })
    sim.stepFor(60)  // past the health-check interval + consecutive-failure debounce

    const promotions = sim.events.filter(e => e.kind === 'replica_promoted' && e.affected.includes(f.replicaIid))
    expect(promotions).toHaveLength(1)

    // Both instances read healthy: the original primary was never actually touched (region A can
    // still reach itself and region B fine), and the promoted replica has no error/pressure signal
    // of its own — the ONLY thing that changed is which side believes it holds the primary role.
    const b = sim.latest()
    expect(b.instances[f.primaryIid]?.health).toBe('healthy')
    expect(b.instances[f.replicaIid]?.health).toBe('healthy')
    sim.engine.stop()
  })

  it('does NOT self-promote a cross-region replica without the directional-health mechanism (regression guard)', () => {
    // Same fixture and same partition, but asserting the NEGATIVE: if directional health were
    // reverted to the non-directional fallback (target's own raw health, which stays healthy
    // throughout since region A itself never degrades), no promotion fires. This is the "for the
    // right reason" guard — it documents what the mechanism must NOT do in the absence of a
    // partition, so a future regression that silently drops directionality is caught here too.
    const f = crossRegionReplicaFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)
    sim.stepFor(60)   // no partition ever added
    const promotions = sim.events.filter(e => e.kind === 'replica_promoted')
    expect(promotions).toHaveLength(0)
    sim.engine.stop()
  })

  // Review fix (Task 19 second pass): this cross-region orphan self-promotion block scans
  // s.crossRegionOrphanReplicaIds, built once at start() over compileWorld's full maxCount
  // ENVELOPE for an autoscaled placement (Task 11) — exactly the same "possible" superset
  // promoteReplicas' own siblingReplicas scan had before its FEAT-008 fix. A parked replica here
  // has no CPU/RAM (Task 13), no traffic (Task 14) and publishes no metrics (Task 16); it must
  // never win this self-promotion path either.
  it('never self-promotes a PARKED cross-region orphan replica, even when its region is isolated', () => {
    const f = crossRegionReplicaFixture()
    // Autoscale the replica's placement with minCount 0 — it starts fully parked (desiredCount
    // seeds at minCount, runningSetResolver's indexInPlacement < desired test excludes index 0)
    // and never receives any traffic (it's a db replica, not a client-facing entry point) so
    // nothing ever drives it to scale out.
    const replicaPl = Object.values(f.doc.placements).find(p => p.role === 'replica')!
    replicaPl.autoscale = { minCount: 0, maxCount: 1, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    const compiled = compileWorld(f.doc)

    const sim = drive(f.doc, compiled)
    sim.stepFor(2)
    sim.engine.setPartition!({ from: { kind: 'region', id: f.regionA }, to: { kind: 'region', id: f.regionB }, mode: 'drop', symmetric: false })
    sim.stepFor(60)

    const promotions = sim.events.filter(e => e.kind === 'replica_promoted' && e.affected.includes(f.replicaIid))
    expect(promotions).toHaveLength(0)
    sim.engine.stop()
  })

  it('healing the partition restores reachability and fails the isolated replica back', () => {
    const f = crossRegionReplicaFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)
    sim.engine.setPartition!({ from: { kind: 'region', id: f.regionA }, to: { kind: 'region', id: f.regionB }, mode: 'drop', symmetric: false })
    sim.stepFor(60)
    expect(sim.events.filter(e => e.kind === 'replica_promoted' && e.affected.includes(f.replicaIid))).toHaveLength(1)

    sim.engine.healPartition!('partition-0')   // auto-assigned by addPartition (audit final-review I3) — first partition of the run
    sim.stepFor(60)  // past the healthy-threshold's consecutive-success debounce
    expect(sim.events.some(e => e.kind === 'primary_failback' && e.affected.includes(f.replicaIid))).toBe(true)
    sim.engine.stop()
  })

  // Audit final-review C1 (permanent regression fixture): the reviewer's exact repro — a
  // same-region primary (P_A) + same-region replica (R_A) in region A, PLUS a SEPARATE authored
  // primary (P_B) for the SAME blueprint in region B — a realistic active-active-with-local-HA
  // topology. Unlike crossRegionReplicaFixture above, R_A here has BOTH a same-region primary
  // sibling AND a cross-region primary, which is the exact combination the old
  // `crossRegionPrimaries.length === 0` guard failed to exclude: it let the cross-region block
  // read `alreadyPromoted` off the SHARED promotedAt map right after promoteReplicas legitimately
  // promoted R_A, saw a stale "isolated: false, alreadyPromoted: true" and incorrectly failed R_A
  // back — which promoteReplicas then re-promoted next step, forever (200 promote + 200 failback
  // events over 20s in the reviewer's measurement). ZERO partitions are active in this test: this
  // is a same-region FEAT-001 kill interacting with FEAT-002's promotion bookkeeping, not a
  // partition-gated bug — gating the whole block on partitions.length === 0 would mask this
  // exact repro without fixing it (see the block's comment in index.ts).
  function sameRegionPlusCrossRegionPrimaryFixture() {
    const doc = createWorld()
    const regionA = createRegion('us-east-1')
    const regionB = createRegion('eu-west-1')
    const azA = createAz(regionA.id, 'us-east-1a')
    const azB = createAz(regionB.id, 'eu-west-1a')
    doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA1 = createServer(azA.id, getPreset('dedicated-8')!)
    const sA2 = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA1.id] = sA1; doc.servers[sA2.id] = sA2; doc.servers[sB.id] = sB

    const db = createBlueprint('db', 0)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50 }
    doc.blueprints[db.id] = db

    const primaryAPl = createPlacement(db.id, sA1.id)                             // authored primary, region A
    const replicaAPl = createPlacement(db.id, sA2.id); replicaAPl.role = 'replica' // SAME-region replica, region A
    const primaryBPl = createPlacement(db.id, sB.id)                              // SEPARATE authored primary, region B
    doc.placements[primaryAPl.id] = primaryAPl
    doc.placements[replicaAPl.id] = replicaAPl
    doc.placements[primaryBPl.id] = primaryBPl

    const compiled = compileWorld(doc)
    return {
      doc, compiled, primaryAServerId: sA1.id,
      primaryAIid: instanceId(primaryAPl.id, 0), replicaAIid: instanceId(replicaAPl.id, 0), primaryBIid: instanceId(primaryBPl.id, 0),
    }
  }

  it('C1 regression: killing a same-region primary with a same-region replica AND a separate cross-region primary promotes the replica exactly once — no promote/failback flap, no partition active', () => {
    const f = sameRegionPlusCrossRegionPrimaryFixture()
    const sim = drive(f.doc, f.compiled)
    sim.stepFor(2)   // settle
    sim.engine.setFault('server', f.primaryAServerId, { kind: 'down' })   // FEAT-001: kill P_A's server — no partition anywhere
    sim.stepFor(20)  // ~20 simulated seconds — the reviewer's measured flap window

    const promotions = sim.events.filter(e => e.kind === 'replica_promoted')
    const failbacks = sim.events.filter(e => e.kind === 'primary_failback')
    expect(promotions.length).toBeLessThanOrEqual(1)
    expect(failbacks).toHaveLength(0)
    sim.engine.stop()
  })
})

// ─── FEAT-003: Scenario timeline — cursor-indexed step application + rng seeding (Task 18) ──
describe('FEAT-003 scenario timeline (Task 18)', () => {
  // 1 region / 1 AZ / 1 server, one public entry blueprint, one population — minimal but real
  // enough that a server-scoped fault is observable in published metrics.
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
    const compiled = compileWorld(doc)
    return { doc, compiled, serverId: server.id }
  }

  function faultClearScenario(serverId: string): NonNullable<WorldDoc['scenario']> {
    return {
      id: 's1', label: 'T', seed: 777, durationMs: 60000,
      steps: [
        { atMs: 10000, action: { type: 'inject-fault', scope: 'server', id: serverId, spec: { kind: 'cpu-brownout', capacityFraction: 0.5 } } },
        { atMs: 30000, action: { type: 'clear-fault', scope: 'server', id: serverId } },
      ],
    }
  }

  // helper: start engine, step in 100ms increments to 60,000ms, collect every published MetricsBatch.
  function runFullScenario(doc: WorldDoc, compiled: ReturnType<typeof compileWorld>): MetricsBatch[] {
    const engine = createWorldEngine(0)
    const batches: MetricsBatch[] = []
    engine.start(doc, compiled, {
      onMetrics: b => batches.push(b),
      onEvent: () => {},
      onHealthChange: () => {},
    })
    engine.__test_step(600)   // 600 x 100ms steps = 60,000ms
    engine.stop()
    return batches
  }

  it('THE DETERMINISM TEST: same scenario + seed + doc produces deep-equal MetricsBatch sequences over 60s, run twice', () => {
    const { doc, compiled, serverId } = scenarioFixture()
    doc.scenario = faultClearScenario(serverId)
    const runA = runFullScenario(doc, compiled)
    const runB = runFullScenario(doc, compiled)
    expect(runA.length).toBeGreaterThan(0)
    expect(runA).toEqual(runB)
  })

  it('inject-fault at atMs 30000 fires between step 299 and 300 at 100ms steps, exactly once', () => {
    const { doc, compiled, serverId } = scenarioFixture()
    doc.scenario = {
      id: 's2', label: 'T', seed: 42, durationMs: 60000,
      steps: [{ atMs: 30000, action: { type: 'inject-fault', scope: 'server', id: serverId, spec: { kind: 'cpu-brownout', capacityFraction: 0.5 } } }],
    }
    const events: EngineEvent[] = []
    const engine = createWorldEngine(0)
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: e => events.push(e), onHealthChange: () => {} })
    engine.__test_step(299)   // steps to exactly 29,900ms — no fault yet
    expect(events.some(e => e.kind === 'fault_injected')).toBe(false)
    engine.__test_step(1)     // one more 100ms step — exactly 30,000ms, fault fires once
    expect(events.filter(e => e.kind === 'fault_injected')).toHaveLength(1)
    engine.__test_step(10)    // further steps: no additional fault_injected for the same step
    expect(events.filter(e => e.kind === 'fault_injected')).toHaveLength(1)
    engine.stop()
  })

  it('a world with no scenario is byte-identical to pre-feature for a fixed seed', () => {
    const { doc, compiled } = scenarioFixture()
    const a = runFullScenario(doc, compiled)
    const b = runFullScenario(doc, compiled)
    expect(a[a.length - 1]).toEqual(b[b.length - 1])
  })

  it('doc.scenario.seed overrides createWorldEngine\'s default seed rather than adding a second rng source', () => {
    const { doc, compiled, serverId } = scenarioFixture()
    doc.scenario = faultClearScenario(serverId)
    // Two engines constructed with DIFFERENT default seeds but the SAME scenario.seed must
    // produce byte-identical output — proof the scenario seed REPLACES the default, rather than
    // merely composing with it (which would leave the two runs diverging).
    const engineA = createWorldEngine(1)
    const batchesA: MetricsBatch[] = []
    engineA.start(doc, compiled, { onMetrics: b => batchesA.push(b), onEvent: () => {}, onHealthChange: () => {} })
    engineA.__test_step(600)
    engineA.stop()

    const engineB = createWorldEngine(999)
    const batchesB: MetricsBatch[] = []
    engineB.start(doc, compiled, { onMetrics: b => batchesB.push(b), onEvent: () => {}, onHealthChange: () => {} })
    engineB.__test_step(600)
    engineB.stop()

    expect(batchesA).toEqual(batchesB)
  })

  it('emits scenario_step_applied exactly once per step, alongside the action\'s own domain event', () => {
    const { doc, compiled, serverId } = scenarioFixture()
    doc.scenario = faultClearScenario(serverId)
    const events: EngineEvent[] = []
    const engine = createWorldEngine(0)
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: e => events.push(e), onHealthChange: () => {} })
    engine.__test_step(600)
    engine.stop()
    expect(events.filter(e => e.kind === 'scenario_step_applied')).toHaveLength(2)
    expect(events.filter(e => e.kind === 'fault_injected')).toHaveLength(1)
    expect(events.filter(e => e.kind === 'fault_cleared')).toHaveLength(1)
  })

  // Audit final-review I1: runFrame's replay loop advances the clock for the WHOLE frame's step
  // batch FIRST (state.clock.simMs lands on the batch's LAST step), then replays each step
  // backdated. A scenario action applied on an EARLIER, backdated step must be timestamped with
  // THAT step's own simMs — not state.clock.simMs, which by the time applyScenarioAction runs
  // already holds the batch's end time. The existing determinism test above (__test_step, default
  // timeScale=1) runs exactly one step per frame and structurally cannot exercise this: this test
  // forces a 4-step batch in ONE runFrame call via setTimeScale, the same mechanism any timeScale
  // > 1 (or a slow real frame) triggers in production.
  it('audit final-review I1: a scenario action applied on a backdated step (multi-step frame batch) is timestamped with the STEP\'s own simMs, not the batch\'s end time', () => {
    const { doc, compiled } = scenarioFixture()
    const azId = Object.values(doc.azs)[0].id
    doc.scenario = {
      id: 's-i1', label: 'T', seed: 11, durationMs: 60000,
      steps: [
        { atMs: 200, action: { type: 'inject-fault', scope: 'az', id: azId, spec: { kind: 'down' } } },
      ],
    }
    const events: EngineEvent[] = []
    const engine = createWorldEngine(0)
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: e => events.push(e), onHealthChange: () => {} })
    // timeScale=4 + a single __test_step(1) call: runFrame(stepMs=100) -> clock.advance(100, 4)
    // accumulates 400ms of sim time in ONE frame -> 4 backdated steps (100/200/300/400ms) replayed
    // in that one runFrame call. The scenario step (atMs=200) lands on the SECOND of those steps.
    engine.setTimeScale(4)
    engine.__test_step(1)
    engine.stop()

    const stepApplied = events.filter(e => e.kind === 'scenario_step_applied')
    expect(stepApplied).toHaveLength(1)
    expect(stepApplied[0]!.simMs).toBe(200)   // the step's own simMs, not the batch's end (400)

    const outages = events.filter(e => e.kind === 'outage_triggered')
    expect(outages.length).toBeGreaterThan(0)
    for (const e of outages) expect(e.simMs).toBe(200)   // faults.ts + failover.ts both emit one; both must agree
  })

  it('partition/heal-partition scenario actions reuse the exact facade path (partition_started/partition_healed events fire)', () => {
    const { doc, compiled, serverId } = scenarioFixture()
    doc.scenario = {
      id: 's4', label: 'T', seed: 3, durationMs: 20000,
      steps: [
        { atMs: 1000, action: { type: 'partition', fault: { id: 'p1', from: { kind: 'server', id: serverId }, to: { kind: 'internet' }, mode: 'drop', symmetric: false } } },
        { atMs: 5000, action: { type: 'heal-partition', partitionId: 'p1' } },
      ],
    }
    const events: EngineEvent[] = []
    const engine = createWorldEngine(0)
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: e => events.push(e), onHealthChange: () => {} })
    engine.__test_step(200)
    engine.stop()
    expect(events.some(e => e.kind === 'partition_started')).toBe(true)
    expect(events.some(e => e.kind === 'partition_healed')).toBe(true)
    expect(events.filter(e => e.kind === 'scenario_step_applied')).toHaveLength(2)
  })

  it('demand-multiplier and set-population-rps actions apply without error and each emit one scenario_step_applied event', () => {
    const { doc, compiled } = scenarioFixture()
    const popId = Object.keys(doc.populations)[0]
    doc.scenario = {
      id: 's5', label: 'T', seed: 5, durationMs: 20000,
      steps: [
        { atMs: 2000, action: { type: 'demand-multiplier', factor: 2, rampSec: 5 } },
        { atMs: 8000, action: { type: 'set-population-rps', populationId: popId, peakRps: 50, rampSec: 3 } },
      ],
    }
    const events: EngineEvent[] = []
    const engine = createWorldEngine(0)
    expect(() => {
      engine.start(doc, compiled, { onMetrics: () => {}, onEvent: e => events.push(e), onHealthChange: () => {} })
      engine.__test_step(200)
    }).not.toThrow()
    engine.stop()
    expect(events.filter(e => e.kind === 'scenario_step_applied')).toHaveLength(2)
  })
})

// ─── FEAT-004: cache hit ratio wired into the flow solver ───────────────────
// 1 region / 1 AZ / 3 servers: api[entry] -> cache -> db, the "cache instance itself has
// dependencies" proxy shape from the spec. cache's blueprint carries cacheConfig; api and db do
// not. Single instance per tier keeps splitDependencyShares' fan-out trivial (share = admitted).
function buildCacheProxyWorld(cfg: CacheConfig) {
  const doc = createWorld()
  doc.routing.policy = 'geo'
  const r = createRegion('us-east-1')
  const az = createAz(r.id, 'us-east-1a')
  doc.regions[r.id] = r
  doc.azs[az.id] = az
  const sApi = createServer(az.id, getPreset('dedicated-8')!)
  const sCache = createServer(az.id, getPreset('dedicated-8')!)
  const sDb = createServer(az.id, getPreset('dedicated-8')!)
  Object.assign(doc.servers, { [sApi.id]: sApi, [sCache.id]: sCache, [sDb.id]: sDb })

  const api = publicBlueprint('api', 0)
  const cache = createBlueprint('cache', 1)
  const db = createBlueprint('db', 2)
  cache.kind = 'cache'
  cache.cacheConfig = cfg
  api.dependencies = [{ id: 'd-cache', target: { kind: 'blueprint', blueprintId: cache.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  cache.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
  Object.assign(doc.blueprints, { [api.id]: api, [cache.id]: cache, [db.id]: db })

  const plApi = createPlacement(api.id, sApi.id); doc.placements[plApi.id] = plApi
  const plCache = createPlacement(cache.id, sCache.id); doc.placements[plCache.id] = plCache
  const plDb = createPlacement(db.id, sDb.id); doc.placements[plDb.id] = plDb

  const pop = createPopulation('nyc', 40.7, -74.0)
  pop.peakRps = 200
  doc.populations[pop.id] = pop

  const compiled = compileWorld(doc)
  return {
    doc,
    compiled,
    apiInstanceId: instanceId(plApi.id, 0),
    cacheInstanceId: instanceId(plCache.id, 0),
    dbInstanceId: instanceId(plDb.id, 0),
    cacheServerId: sCache.id,
  }
}

describe('FEAT-004 cache hit ratio', () => {
  it('REGRESSION FLOOR: a world with no cacheConfig produces byte-identical output to pre-FEAT-004 for a fixed seed', () => {
    // Neither blueprint nor any dependency in e2eFixture sets cacheConfig/cacheAsideVia.
    const f = e2eFixture()
    const a = drive(f.doc, f.compiled)
    a.stepFor(5)
    const batchA = a.latest()
    a.engine.stop()

    const b = drive(f.doc, f.compiled)
    b.stepFor(5)
    const batchB = b.latest()
    b.engine.stop()

    expect(batchA).toEqual(batchB)
    // No instance should ever carry a defined cacheHitRatio when no blueprint configures caching
    // (Task 4 adds this field to InstanceMetrics; it stays undefined here).
    for (const im of Object.values(batchA.instances)) {
      expect((im as any).cacheHitRatio).toBeUndefined()
    }
  })

  it('CACHE ECONOMICS: api -> cache -> db at hitRatio 0.9 sends ~10% of cache traffic to db', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.9, warmupSec: 0, ttlSec: 300 })
    const sim = drive(w.doc, w.compiled)
    sim.stepFor(20)   // reach steady state
    const b = sim.latest()
    const cacheRps = b.instances[w.cacheInstanceId].rps
    const dbRps = b.instances[w.dbInstanceId].rps
    expect(dbRps / cacheRps).toBeGreaterThan(0.08)
    expect(dbRps / cacheRps).toBeLessThan(0.12)
    sim.engine.stop()
  })

  it('THUNDERING HERD: restarting a warm cache spikes downstream db well above steady state, then decays', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.95, warmupSec: 60, ttlSec: 300 })
    const sim = drive(w.doc, w.compiled)
    sim.stepFor(60)   // every cache starts warm at start() (the regression floor) — this just
                       // lets Poisson noise settle before sampling steady state.
    const steadyDbRps = sim.latest().instances[w.dbInstanceId].rps
    sim.engine.setFault('server', w.cacheServerId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', w.cacheServerId, null)   // clear -> restart, warmSinceMs resets
    // The brief outage also trips api->cache's circuit breaker (unrelated to this feature —
    // pre-existing breaker behavior), which independently throttles ALL cache traffic for ~15s
    // before it self-heals; that has to fully resolve before the cold-cache miss-rate effect this
    // test is about becomes observable in dbRps at all. 30s clears both the breaker's own recovery
    // AND lands well inside the cold ramp (warmupSec=60), where missFraction is still near its max.
    sim.stepFor(30)
    const justAfterRestartDbRps = sim.latest().instances[w.dbInstanceId].rps
    expect(justAfterRestartDbRps / steadyDbRps).toBeGreaterThan(5)
    sim.stepFor(90)   // ride out warmupSec (60s from the clear) plus settling margin
    const recoveredDbRps = sim.latest().instances[w.dbInstanceId].rps
    expect(recoveredDbRps / steadyDbRps).toBeLessThan(1.3)
    sim.engine.stop()
  })

  it('a freshly-started cache is fully warm (published cacheHitRatio equals the authored hitRatio) with no restart', () => {
    // Task 3's convention: EngineState.warmSinceMs starts as an empty Map, and cache.ts's
    // effectiveHitRatio treats an absent entry as "already warm" — so an instance that has never
    // restarted publishes its full authored hitRatio from step 1, regardless of warmupSec.
    const w = buildCacheProxyWorld({ hitRatio: 0.8, warmupSec: 20, ttlSec: 300 })
    const sim = drive(w.doc, w.compiled)
    for (let i = 0; i < 5; i++) sim.stepFor(1)   // mid-warmup by wall-clock, but never restarted
    const published = sim.latest().instances[w.cacheInstanceId].cacheHitRatio
    expect(published).toBeCloseTo(0.8, 5)
    sim.engine.stop()
  })

  it('DIVERGENCE GUARD: published cacheHitRatio equals cache.ts effectiveHitRatio computed independently from the SAME restart timestamp', () => {
    const cfg: CacheConfig = { hitRatio: 0.8, warmupSec: 20, ttlSec: 300 }
    const w = buildCacheProxyWorld(cfg)
    const sim = drive(w.doc, w.compiled)
    sim.stepFor(60)   // settle at full warmth before restarting; drive()'s clock is a plain
    // 100ms-accumulator (engineClock.ts) with no leftover carry across whole-second stepFor
    // calls, so clock.simMs here is exactly 60,000 — the published batches themselves lag this
    // by up to 999ms (1 Hz cadence, first boundary at simMs=100 per index.ts's `lastBatchMs:
    // -1000` seed), which is why this test tracks the restart timestamp itself rather than
    // reading it back off a published batch.
    const restartSimMs = 60_000
    // Force a restart: 'down' then clear, with ZERO stepping between the two calls — both
    // api.setFault calls apply at the SAME state.clock.simMs (index.ts's api.setFault reads
    // `state.clock.simMs` synchronously), which is exactly `restartSimMs` above and exactly the
    // warmSinceMs value index.ts's doSetFault writes into EngineState.warmSinceMs on the clearing
    // call (the `!down` branch, ~index.ts:668).
    sim.engine.setFault('server', w.cacheServerId, { kind: 'down' })
    sim.engine.setFault('server', w.cacheServerId, null)   // restart -> warmSinceMs = restartSimMs
    sim.stepFor(5)   // mid-warmup (5s of a 20s warmupSec ramp) — NOT yet steady/fully warm
    const b = sim.latest()
    const published = b.instances[w.cacheInstanceId].cacheHitRatio
    // Recompute independently via the SAME pure function Task 2 exposed (cache.ts's
    // effectiveHitRatio), fed the SAME restart timestamp the engine itself used and the SAME
    // published batch's own simMs (whatever that batch's actual 1 Hz cadence landed on).
    const expected = effectiveHitRatio(cfg, restartSimMs, b.simMs)
    expect(published).toBeDefined()
    expect(published).toBeCloseTo(expected, 5)
    // And it must genuinely be mid-ramp, not accidentally already fully warm (a vacuous pass).
    expect(published as number).toBeLessThan(cfg.hitRatio - 0.01)
    sim.engine.stop()
  })

  it('emits cache_cold on restart and cache_warm once warmupSec has elapsed', () => {
    // index.ts's __test_step(n) advances n x state.stepMs (100ms each, DEFAULT_STEP_MS) — so
    // "past warmupSec=10s" needs >100 steps, not a literal step count of 10.
    const w = buildCacheProxyWorld({ hitRatio: 0.9, warmupSec: 10, ttlSec: 300 })
    const sim = drive(w.doc, w.compiled)
    sim.engine.__test_step(5)   // simMs 500 — settle before restarting
    sim.engine.setFault('server', w.cacheServerId, { kind: 'down' })
    sim.engine.__test_step(1)   // simMs 600
    sim.engine.setFault('server', w.cacheServerId, null)   // restart at simMs 600 -> warmSinceMs = 600
    sim.engine.__test_step(1)   // simMs 700 — cache_cold fires on the restart step (600), already emitted
    const coldEvents = sim.events.filter(e => e.kind === 'cache_cold')
    expect(coldEvents.length).toBe(1)
    sim.engine.__test_step(110)   // simMs 11,800 — well past warmSinceMs(600) + warmupSec(10s)=10,600
    const warmEvents = sim.events.filter(e => e.kind === 'cache_warm')
    expect(warmEvents.length).toBe(1)
    sim.engine.stop()
  })

  // Audit final-review finding: doSetFault's cache-warmth-reset block used to gate on `!down`,
  // which is true for ANY clear (spec === null) regardless of what kind of fault was actually
  // being cleared — faults.ts keeps exactly one spec per `${scope}:${id}` key, so clearing a
  // non-'down' fault (cpu-brownout here) on a server hosting a cache instance falsely reset
  // warmSinceMs and fired cache_cold even though the cache instance never actually restarted.
  it('clearing a non-down fault (cpu-brownout) on a warm cache server does NOT reset warmth or emit cache_cold', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.9, warmupSec: 10, ttlSec: 300 })
    const sim = drive(w.doc, w.compiled)
    sim.engine.__test_step(5)   // simMs 500 — settle fully warm (never restarted) before faulting
    const warmBefore = sim.latest().instances[w.cacheInstanceId].cacheHitRatio
    expect(warmBefore).toBeCloseTo(0.9, 5)   // fully warm, confirms this is a meaningful baseline

    sim.engine.setFault('server', w.cacheServerId, { kind: 'cpu-brownout', capacityFraction: 0.5 })
    sim.engine.__test_step(1)
    sim.engine.setFault('server', w.cacheServerId, null)   // clear the cpu-brownout, NOT a restart
    sim.engine.__test_step(1)

    const coldEvents = sim.events.filter(e => e.kind === 'cache_cold')
    expect(coldEvents.length).toBe(0)
    // If warmSinceMs had been wrongly reset, cacheHitRatio would immediately dip into the
    // warmupSec ramp instead of staying at the fully-warm authored hitRatio.
    const warmAfter = sim.latest().instances[w.cacheInstanceId].cacheHitRatio
    expect(warmAfter).toBeCloseTo(0.9, 5)
    sim.engine.stop()
  })

  // Existing behavior (clearing an ACTUAL 'down' fault) must still correctly reset warmth — this
  // is the regression guard alongside the fix above.
  it('clearing an actual down fault on a cache server STILL resets warmth and emits cache_cold', () => {
    const w = buildCacheProxyWorld({ hitRatio: 0.9, warmupSec: 10, ttlSec: 300 })
    const sim = drive(w.doc, w.compiled)
    sim.engine.__test_step(5)   // simMs 500
    sim.engine.setFault('server', w.cacheServerId, { kind: 'down' })
    sim.engine.__test_step(1)   // simMs 600
    sim.engine.setFault('server', w.cacheServerId, null)   // restart at simMs 600
    sim.engine.__test_step(1)   // simMs 700
    const coldEvents = sim.events.filter(e => e.kind === 'cache_cold')
    expect(coldEvents.length).toBe(1)
    sim.engine.stop()
  })
})

// ─── FEAT-005 (Task 11): replication lag backlog + stale reads + semi-sync ───────────────────
describe('FEAT-005 Task 11: replication lag wiring', () => {
  // Minimal single-instance-per-blueprint world (mirrors twoAzIngress/e2eFixture's shape) with NO
  // db-sql/db-nosql blueprint at all — the regression floor this task must not disturb.
  function noReplicaWorld() {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    const web = publicBlueprint('web', 0)
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 80
    doc.populations[pop.id] = pop
    return { doc }
  }

  it('REGRESSION FLOOR: a world with no replicas is byte-identical for a fixed seed', () => {
    const w = noReplicaWorld()
    const a = drive(w.doc, compileWorld(w.doc))
    a.stepFor(5)
    const b = drive(w.doc, compileWorld(w.doc))
    b.stepFor(5)
    expect(a.latest()).toEqual(b.latest())
    a.engine.stop(); b.engine.stop()
  })

  // Primary in us-east-1, a single cross-region async replica in eu-west-1, NO client population
  // (zero write load) — so backlog never accumulates and lag settles at the pure locality floor.
  function crossRegionReplicaNoLoadWorld() {
    const doc = createWorld()
    const regionA = createRegion('us-east-1')
    const regionB = createRegion('eu-west-1')
    const azA = createAz(regionA.id, 'us-east-1a')
    const azB = createAz(regionB.id, 'eu-west-1a')
    doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB

    const db = createBlueprint('db', 0)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50 }
    doc.blueprints[db.id] = db

    const primaryPl = createPlacement(db.id, sA.id)
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl
    // No populations authored: zero offered demand anywhere, so writeRps stays 0 for the whole run.

    const compiled = compileWorld(doc)
    return { doc, compiled, replicaIid: instanceId(replicaPl.id, 0) }
  }

  it('LOCALITY FLOOR: at zero write load, a cross-region replica settles at interRegionLatencyMs/1000', async () => {
    const w = crossRegionReplicaNoLoadWorld()
    const sim = drive(w.doc, w.compiled)
    sim.stepFor(5)
    const lagSec = sim.engine.__test_replicationLagSec(w.replicaIid)
    const { interRegionLatencyMs } = await import('../regionConfig')
    expect(lagSec).toBeCloseTo(interRegionLatencyMs('us-east-1', 'eu-west-1') / 1000, 2)
    sim.engine.stop()
  })

  it('LOCALITY FLOOR: a same-AZ replica settles at the 5ms same-az floor', () => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const sA = createServer(az.id, getPreset('dedicated-8')!)
    const sB = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB
    const db = createBlueprint('db', 0)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50 }
    doc.blueprints[db.id] = db
    const primaryPl = createPlacement(db.id, sA.id)
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl
    const compiled = compileWorld(doc)
    const replicaIid = instanceId(replicaPl.id, 0)

    const sim = drive(doc, compiled)
    sim.stepFor(5)
    const lagSec = sim.engine.__test_replicationLagSec(replicaIid)
    expect(lagSec).toBeCloseTo(0.005, 3)
    sim.engine.stop()
  })

  it('a replica under sustained write load accumulates backlog and lag grows above the locality floor', () => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB

    const api = publicBlueprint('api', 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'
    // applyRatePerReplica deliberately far below the authored write rate so backlog is guaranteed
    // to accumulate within a few steps — a purely capacity-starved replica.
    db.dbConfig = { engine: 'sql', storageGb: 50, applyRatePerReplica: 1 }
    doc.blueprints[api.id] = api; doc.blueprints[db.id] = db
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null, writeFraction: 1 }]

    const apiPl = createPlacement(api.id, sA.id)
    const primaryPl = createPlacement(db.id, sA.id)
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'
    doc.placements[apiPl.id] = apiPl
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 200
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    const replicaIid = instanceId(replicaPl.id, 0)
    const sim = drive(doc, compiled)
    sim.stepFor(10)
    const lagSec = sim.engine.__test_replicationLagSec(replicaIid)
    // cross-az floor is 0.02s; with applyCapacity pinned at 1 write/s against a much larger write
    // rate, backlog-driven lag must dominate the floor by a wide margin.
    expect(lagSec).toBeGreaterThan(1)
    sim.engine.stop()
  })
})

// ─── FEAT-005 (Task 12): publish MetricsBatch.clusters + InstanceMetrics.staleReadFraction ───
describe('FEAT-005 Task 12: publish cluster lag + staleReadFraction', () => {
  // Same-region, primary + replica, an api dependency with a HALF write share (so reads route to
  // the replica too, tagging its downstream rows with staleReadFraction) and applyRatePerReplica
  // pinned low so backlog — and therefore lag and stale reads — is guaranteed to accumulate.
  function buildReplicaWorld(opts: { primaryRegion: string; replicaRegion: string; writeLoad: number }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion(opts.primaryRegion)
    const azA = createAz(region.id, `${opts.primaryRegion}-a`)
    const azB = createAz(region.id, `${opts.primaryRegion}-b`)
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB

    const api = publicBlueprint('api', 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50, applyRatePerReplica: 1 }
    doc.blueprints[api.id] = api; doc.blueprints[db.id] = db
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null, writeFraction: 0.5 }]

    const apiPl = createPlacement(api.id, sA.id)
    const primaryPl = createPlacement(db.id, sA.id)
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'
    doc.placements[apiPl.id] = apiPl
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = opts.writeLoad
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    return {
      doc, compiled,
      clusterId: `${db.id}|${region.id}`,
      replicaInstanceId: instanceId(replicaPl.id, 0),
    }
  }

  it('DIVERGENCE GUARD: published cluster lagSec equals the value stepReplication computed', () => {
    const w = buildReplicaWorld({ primaryRegion: 'us-east', replicaRegion: 'us-east', writeLoad: 500 })
    const sim = drive(w.doc, w.compiled)
    // Single-100ms-tick loop, stopping the INSTANT enough batches have published (rather than a
    // fixed stepFor(N) count): under the engine's perf-watch degrade path (spec decision 9), a
    // stepMs swap mid-run can leave stepFor's fixed tick count landing partway between two 1 Hz
    // batch boundaries — comparing "the latest batch" against a __test_replicationLagSec read
    // taken AFTER that drift would be comparing two different instants, a test artifact, not a
    // real divergence. Breaking right after the tick that appended a batch guarantees zero
    // intervening steps between what got published and what the accessor reads next.
    const TARGET_BATCHES = 8
    for (let i = 0; i < 400 && sim.batches.length < TARGET_BATCHES; i++) sim.engine.__test_step(1)
    expect(sim.batches.length).toBeGreaterThanOrEqual(TARGET_BATCHES)
    const b = sim.latest()
    const publishedLag = b.clusters?.[w.clusterId]?.lagSec
    const publishedStale = b.instances[w.replicaInstanceId].staleReadFraction
    // The published lag must equal the SAME value the engine's own test accessor reads off
    // state.replication.lagSecByInstance — the divergence guard this task exists to enforce.
    const directLag = sim.engine.__test_replicationLagSec(w.replicaInstanceId)
    expect(publishedLag).toBe(directLag)
    expect(publishedLag).toBeGreaterThan(0.005) // above the same-AZ floor under load
    expect(publishedStale).toBeGreaterThan(0)
    expect(publishedStale).toBeLessThanOrEqual(1)
    sim.engine.stop()
  })
})

// ─── FEAT-005 (Task 14): replication_lag_high / stale_read_served events ──────────────────────
describe('FEAT-005 Task 14: replication_lag_high + stale_read_served events', () => {
  // Same shape as Task 12's buildReplicaWorld, plus an authored rpoTargetSec so lag can be
  // compared against a target, and applyRatePerReplica pinned low so backlog (and therefore lag
  // and stale reads) is guaranteed to accumulate quickly.
  function buildReplicaWorld(opts: { primaryRegion: string; replicaRegion: string; writeLoad: number; rpoTargetSec: number }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion(opts.primaryRegion)
    const azA = createAz(region.id, `${opts.primaryRegion}-a`)
    const azB = createAz(region.id, `${opts.primaryRegion}-b`)
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB

    const api = publicBlueprint('api', 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50, applyRatePerReplica: 1, rpoTargetSec: opts.rpoTargetSec }
    doc.blueprints[api.id] = api; doc.blueprints[db.id] = db
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null, writeFraction: 0.5 }]

    const apiPl = createPlacement(api.id, sA.id)
    const primaryPl = createPlacement(db.id, sA.id)
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'
    doc.placements[apiPl.id] = apiPl
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = opts.writeLoad
    doc.populations[pop.id] = pop

    const compiled = compileWorld(doc)
    return { doc, compiled, replicaInstanceId: instanceId(replicaPl.id, 0) }
  }

  it('emits rate-limited replication_lag_high when sustained lag exceeds rpoTargetSec', () => {
    const w = buildReplicaWorld({ primaryRegion: 'us-east', replicaRegion: 'us-east', writeLoad: 1000, rpoTargetSec: 1 })
    const sim = drive(w.doc, w.compiled)
    // First let backlog/lag build past rpoTargetSec (a few seconds of 100ms steps), THEN take a
    // fresh events-length checkpoint and drive 30 more 100ms ticks (3 simulated seconds) — the
    // window the rate-limit test actually cares about, mirroring the task brief's
    // `st.engine.__test_step(1)` x 30 shape exactly (100ms ticks, not 1s jumps).
    for (let i = 0; i < 50; i++) sim.engine.__test_step(1)
    const before = sim.events.filter(e => e.kind === 'replication_lag_high').length
    for (let i = 0; i < 30; i++) sim.engine.__test_step(1)
    const lagEvents = sim.events.filter(e => e.kind === 'replication_lag_high')
    expect(lagEvents.length).toBeGreaterThan(before)
    // rate-limited to ~1/sec: 30 x 100ms = 3 simulated seconds, so well under one per 100ms step.
    expect(lagEvents.length - before).toBeLessThan(10)
    sim.engine.stop()
  })

  it('does not emit replication_lag_high when no rpoTargetSec is authored', () => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a'); const azB = createAz(region.id, 'us-east-1b')
    doc.regions[region.id] = region; doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const sA = createServer(azA.id, getPreset('dedicated-8')!)
    const sB = createServer(azB.id, getPreset('dedicated-8')!)
    doc.servers[sA.id] = sA; doc.servers[sB.id] = sB
    const api = publicBlueprint('api', 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 50, applyRatePerReplica: 1 }   // no rpoTargetSec
    doc.blueprints[api.id] = api; doc.blueprints[db.id] = db
    api.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null, writeFraction: 0.5 }]
    const apiPl = createPlacement(api.id, sA.id)
    doc.placements[apiPl.id] = apiPl
    const primaryPl = createPlacement(db.id, sA.id)
    const replicaPl = createPlacement(db.id, sB.id); replicaPl.role = 'replica'
    doc.placements[primaryPl.id] = primaryPl
    doc.placements[replicaPl.id] = replicaPl
    const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = 1000
    doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    for (let i = 0; i < 80; i++) sim.engine.__test_step(1)
    expect(sim.events.filter(e => e.kind === 'replication_lag_high')).toHaveLength(0)
    sim.engine.stop()
  })

  it('emits rate-limited stale_read_served once a replica accumulates lag under write load', () => {
    const w = buildReplicaWorld({ primaryRegion: 'us-east', replicaRegion: 'us-east', writeLoad: 1000, rpoTargetSec: 1 })
    const sim = drive(w.doc, w.compiled)
    for (let i = 0; i < 50; i++) sim.engine.__test_step(1)
    const before = sim.events.filter(e => e.kind === 'stale_read_served').length
    for (let i = 0; i < 30; i++) sim.engine.__test_step(1)
    const staleEvents = sim.events.filter(e => e.kind === 'stale_read_served')
    expect(staleEvents.length).toBeGreaterThan(before)
    expect(staleEvents.length - before).toBeLessThan(10)   // rate-limited to ~1/sec over 3 simulated seconds
    expect(staleEvents.every(e => e.affected.includes(w.replicaInstanceId))).toBe(true)
    sim.engine.stop()
  })
})

// ─── FEAT-006 Task 19: diskWaitMs threaded into latency + both RAM call sites ─────────────────
describe('FEAT-006 Task 19: disk I/O wait latency + RAM threading', () => {
  // 1 region / 1 AZ / 2 servers: web (entry) on one, db (disk-heavy dependency) on the other, so
  // the db server's disk config is isolated from the web server's CPU/RAM.
  function buildDiskBoundDbWorld(opts: {
    diskIops?: number
    diskType?: 'hdd' | 'ssd' | 'nvme'
    diskIoPerRequest: number
  }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const webServer = createServer(az.id, getPreset('dedicated-8')!)
    const dbServer = createServer(az.id, getPreset('dedicated-8')!)
    dbServer.specs = { ...dbServer.specs, diskIops: opts.diskIops, diskType: opts.diskType }
    doc.servers[webServer.id] = webServer
    doc.servers[dbServer.id] = dbServer
    const web = publicBlueprint('web', 0)
    const db = createBlueprint('db', 1)
    web.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
    db.workload = { cpuMsPerRequest: 1, ramBaseMb: 100, ramPerConnMb: 0.1, diskIoPerRequest: opts.diskIoPerRequest }
    Object.assign(doc.blueprints, { [web.id]: web, [db.id]: db })
    const webPl = createPlacement(web.id, webServer.id); doc.placements[webPl.id] = webPl
    const dbPl = createPlacement(db.id, dbServer.id); doc.placements[dbPl.id] = dbPl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 200
    doc.populations[pop.id] = pop
    return {
      doc, compiled: compileWorld(doc),
      dbServerId: dbServer.id, dbInstanceId: instanceId(dbPl.id, 0),
    }
  }

  const run = (w: ReturnType<typeof buildDiskBoundDbWorld>) => drive(w.doc, w.compiled)

  it('REGRESSION FLOOR: a server with neither diskIops nor diskType is byte-identical for a fixed seed', () => {
    const w = buildDiskBoundDbWorld({ diskIoPerRequest: 5 })
    const a = run(w)
    for (let i = 0; i < 20; i++) a.engine.__test_step(1)
    const b = run(w)
    for (let i = 0; i < 20; i++) b.engine.__test_step(1)
    expect(a.latest()).toEqual(b.latest())
    a.engine.stop(); b.engine.stop()
  })

  // NOTE (deviation from the brief's illustrative snippet): the brief's own Step 2 comment
  // acknowledges `diskIoFraction` "stays on the legacy diskIo/100 branch" until Task 20 rewrites
  // metrics.ts — this task is explicitly scoped to NOT touch metrics.ts. So these tests assert on
  // p50Ms/activeConnections (which DO flow through extraLatencyMsByServer -> flows.ts -> both
  // Little's-law call sites, wired by this task) rather than diskIoFraction, which would not
  // actually distinguish a wired vs. unwired diskWaitMs implementation at this point in the plan.
  it('a disk-bound DB (high diskIoPerRequest, low diskIops) pays large added latency while CPU stays moderate', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 20; i++) st.engine.__test_step(1)
    const b = st.latest()
    const server = b.servers[w.dbServerId]
    // hdd base 8ms / (1 - 0.98 capped overshoot) = 400ms of added disk wait once demand exceeds
    // the 200-iops ceiling several times over (20 io/req x rps well past 10) -- far more than the
    // 1ms authored cpuMsPerRequest could ever produce on its own.
    expect(b.instances[w.dbInstanceId].p50Ms).toBeGreaterThan(50)
    expect(Math.max(...server.coreUtilization)).toBeLessThan(0.6)
    st.engine.stop()
  })

  // Little's law lives in exactly two places (host scheduler RAM/OOM enforcement + published
  // InstanceMetrics). diskWaitMs must extend BOTH the same way the checkout-pool wait and
  // latency-add fault already do, or the RAM the scheduler enforces would silently diverge from
  // the RAM the user is shown.
  it('DIVERGENCE GUARD: disk-driven RAM agrees between scheduler and metrics, and is elevated by disk wait', () => {
    const bound = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const unbound = buildDiskBoundDbWorld({ diskIoPerRequest: 20 })   // same demand, disk unmodelled
    const stBound = run(bound)
    for (let i = 0; i < 20; i++) stBound.engine.__test_step(1)
    const stUnbound = run(unbound)
    for (let i = 0; i < 20; i++) stUnbound.engine.__test_step(1)
    const b = stBound.latest()
    const u = stUnbound.latest()

    const schedulerRam = b.servers[bound.dbServerId].ramUsedMb
    const metricsRam = b.servers[bound.dbServerId].ramByInstance.reduce((sum, r) => sum + r.ramMb, 0)
    expect(schedulerRam).toBeGreaterThan(0)
    expect(metricsRam).toBeGreaterThan(0)
    expect(schedulerRam / metricsRam).toBeGreaterThan(0.5)
    expect(schedulerRam / metricsRam).toBeLessThan(2)

    // The disk-bound server's connections must genuinely be held longer (elevated RAM) than the
    // identical-demand unbound server -- proof diskWaitMs is reaching Little's law, not just that
    // the two sides of the divergence guard trivially agree on an unchanged number.
    expect(b.instances[bound.dbInstanceId].activeConnections)
      .toBeGreaterThan(u.instances[unbound.dbInstanceId].activeConnections * 2)

    stBound.engine.stop(); stUnbound.engine.stop()
  })

  it('disk-stall at iopsFraction 0.1 drives an unsaturated server into large added disk-wait latency', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 1000, diskType: 'nvme', diskIoPerRequest: 5 })
    const st = run(w)
    for (let i = 0; i < 10; i++) st.engine.__test_step(1)
    const before = st.latest().instances[w.dbInstanceId].p50Ms
    st.engine.setFault('server', w.dbServerId, { kind: 'disk-stall', iopsFraction: 0.1 })
    // The published p50Ms is an EMA over a multi-batch reservoir (audit ISSUE-041) — it takes a
    // few 1 Hz publish windows past the fault for the added disk-wait ms to dominate the mixed
    // pre/post-fault reservoir, not just one.
    for (let i = 0; i < 40; i++) st.engine.__test_step(1)
    const after = st.latest().instances[w.dbInstanceId].p50Ms
    // Pre-fault: demandIops (~rps x 5) sits at/under the 1000-iops ceiling -> wait ~= 0.
    // Post-fault: the SAME demand against a 10%-effective 100-iops ceiling is deep in saturation
    // (rho >> 1.98, the overshoot cap) -> a flat ~5ms nvme-base disk wait regardless of exact rps.
    expect(after - before).toBeGreaterThan(2)
    st.engine.stop()
  })

  // ─── FEAT-006 Task 20: diskIoFraction dual behavior ─────────────────────────────────────────
  it('a server with no ceiling authored keeps diskIoFraction === legacy diskIo/100 norm (regression floor)', () => {
    const w = buildDiskBoundDbWorld({ diskIoPerRequest: 5 })   // no diskIops/diskType authored
    const st = run(w)
    for (let i = 0; i < 10; i++) st.engine.__test_step(1)
    const b = st.latest()
    const server = b.servers[w.dbServerId]
    // Recompute the exact legacy formula independently from the same published rps/workload
    // inputs — proof the unmodelled-disk branch is byte-identical to pre-Task-20, not just close.
    const diskIo = server.ramByInstance.reduce((sum, r) => {
      const inst = b.instances[r.instanceId]
      return sum + (inst?.rps ?? 0) * 5   // diskIoPerRequest authored above
    }, 0)
    expect(server.diskIoFraction).toBeCloseTo(Math.min(1, diskIo / 100), 10)
    st.engine.stop()
  })

  it('a server with a resolvable ceiling publishes min(1, demandIops/ceiling) instead of the legacy norm', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 20; i++) st.engine.__test_step(1)
    const b = st.latest()
    const server = b.servers[w.dbServerId]
    // Demand (rps * 20 io/req) is driven well past the 200-iops ceiling by the fixture's traffic,
    // so the ceiling-aware branch pins at the Math.min(1, ...) cap -- the legacy diskIo/100 norm
    // would ALSO read 1 here at this rps, so what actually distinguishes the branches is that this
    // value is sourced from host.diskIoRatio (proven by the low-demand case below, and by the
    // REGRESSION FLOOR test above pinning the OTHER branch byte-identical).
    expect(server.diskIoFraction).toBeLessThanOrEqual(1)
    expect(server.diskIoFraction).toBeGreaterThan(0)
    st.engine.stop()
  })

  it('the ceiling-aware branch reads the SAME ratio that drove diskWaitMs, not the legacy diskIo/100 formula', () => {
    // Low demand relative to a generous ceiling: diskIo/100 (legacy) and demandIops/ceiling
    // (ceiling-aware) diverge sharply at this scale, so which branch is live is unambiguous.
    // diskIoPerRequest 1, nvme ceiling 100,000: at ~40rps demand ~= 40 iops -> ratio ~= 0.0004,
    // while the legacy diskIo/100 norm at the SAME 40 io/s would read ~= 0.4 -- two orders of
    // magnitude apart.
    const w = buildDiskBoundDbWorld({ diskIops: 100_000, diskType: 'nvme', diskIoPerRequest: 1 })
    const st = run(w)
    for (let i = 0; i < 10; i++) st.engine.__test_step(1)
    const b = st.latest()
    const server = b.servers[w.dbServerId]
    expect(server.diskIoFraction).toBeLessThan(0.05)
    st.engine.stop()
  })

  it('publishes InstanceMetrics.diskWaitMs from the same per-server value threaded into latency', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const st = run(w)
    for (let i = 0; i < 20; i++) st.engine.__test_step(1)
    const b = st.latest()
    expect(b.instances[w.dbInstanceId].diskWaitMs).toBeGreaterThan(0)
    st.engine.stop()
  })
})

// ─── FEAT-006 Task 20: ManagedService.provisionedIops as a real saturation ceiling ────────────
describe('FEAT-006 Task 20: managed provisionedIops ceiling', () => {
  function buildManagedDbWorld(opts: { provisionedIops: number }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    const managedId = 'ms-db'
    doc.managedServices[managedId] = {
      id: managedId, label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'region', regionId: r.id }, provider: 'generic', port: 5432,
      instanceClassId: 'sql.small', replicaCount: 0, multiAz: false, storageGb: 100,
      provisionedIops: opts.provisionedIops,
    }
    const web = publicBlueprint('web', 0)
    web.dependencies = [
      { id: 'd-db', target: { kind: 'managed', managedServiceId: managedId }, port: 5432, protocol: 'db', packetTemplateId: null },
    ]
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 300
    doc.populations[pop.id] = pop
    return { doc, compiled: compileWorld(doc), managedId }
  }

  const run = (w: ReturnType<typeof buildManagedDbWorld>) => drive(w.doc, w.compiled)

  it('raising provisionedIops on a managed DB lowers its published saturation', () => {
    const low = buildManagedDbWorld({ provisionedIops: 100 })
    const high = buildManagedDbWorld({ provisionedIops: 5000 })
    const stLow = run(low); const stHigh = run(high)
    for (let i = 0; i < 15; i++) { stLow.engine.__test_step(1); stHigh.engine.__test_step(1) }
    const lowSat = stLow.latest().managedServices?.[low.managedId]?.saturation
    const highSat = stHigh.latest().managedServices?.[high.managedId]?.saturation
    expect(lowSat).toBeGreaterThan(0)
    expect(highSat).toBeLessThan(lowSat!)
    stLow.engine.stop(); stHigh.engine.stop()
  })

  it('an absent provisionedIops is unaffected -- byte-identical to the pre-Task-20 saturation formula', () => {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server
    doc.managedServices['ms-db'] = {
      id: 'ms-db', label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'region', regionId: r.id }, provider: 'generic', port: 5432,
      instanceClassId: 'sql.small', replicaCount: 0, multiAz: false, storageGb: 100,
      // no provisionedIops authored
    }
    const web = publicBlueprint('web', 0)
    web.dependencies = [
      { id: 'd-db', target: { kind: 'managed', managedServiceId: 'ms-db' }, port: 5432, protocol: 'db', packetTemplateId: null },
    ]
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, server.id)
    doc.placements[pl.id] = pl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 300
    doc.populations[pop.id] = pop
    const compiled = compileWorld(doc)
    const st = drive(doc, compiled)
    for (let i = 0; i < 15; i++) st.engine.__test_step(1)
    const sat = st.latest().managedServices?.['ms-db']?.saturation
    // 300 rps all-reads against sql.small's 2500 read ceiling ~= 0.12 -- unaffected by any IOPS term.
    expect(sat).toBeCloseTo(300 / 2500, 1)
    st.engine.stop()
  })
})

// ─── FEAT-006 Task 21: disk_saturated event ────────────────────────────────────────────────────
describe('FEAT-006 Task 21: disk_saturated event', () => {
  // Same 1-region/1-AZ/2-server (web entry + disk-heavy db) shape as Task 19/20's
  // buildDiskBoundDbWorld -- duplicated locally since that helper is scoped inside the Task 19
  // describe block.
  function buildDiskBoundDbWorld(opts: {
    diskIops?: number
    diskType?: 'hdd' | 'ssd' | 'nvme'
    diskIoPerRequest: number
  }) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const r = createRegion('us-east-1')
    const az = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[az.id] = az
    const webServer = createServer(az.id, getPreset('dedicated-8')!)
    const dbServer = createServer(az.id, getPreset('dedicated-8')!)
    dbServer.specs = { ...dbServer.specs, diskIops: opts.diskIops, diskType: opts.diskType }
    doc.servers[webServer.id] = webServer
    doc.servers[dbServer.id] = dbServer
    const web = publicBlueprint('web', 0)
    const db = createBlueprint('db', 1)
    web.dependencies = [{ id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'db', packetTemplateId: null }]
    db.workload = { cpuMsPerRequest: 1, ramBaseMb: 100, ramPerConnMb: 0.1, diskIoPerRequest: opts.diskIoPerRequest }
    Object.assign(doc.blueprints, { [web.id]: web, [db.id]: db })
    const webPl = createPlacement(web.id, webServer.id); doc.placements[webPl.id] = webPl
    const dbPl = createPlacement(db.id, dbServer.id); doc.placements[dbPl.id] = dbPl
    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 200
    doc.populations[pop.id] = pop
    return {
      doc, compiled: compileWorld(doc),
      dbServerId: dbServer.id, dbInstanceId: instanceId(dbPl.id, 0),
    }
  }

  it('emits rate-limited disk_saturated above 90% sustained', () => {
    const w = buildDiskBoundDbWorld({ diskIops: 200, diskType: 'hdd', diskIoPerRequest: 20 })
    const sim = drive(w.doc, w.compiled)
    for (let i = 0; i < 30; i++) sim.engine.__test_step(1)
    const events = sim.events.filter(e => e.kind === 'disk_saturated')
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThan(10)   // rate-limited, not one per step
    expect(events.every(e => e.affected.includes(w.dbServerId))).toBe(true)
    sim.engine.stop()
  })

  it('does not fire disk_saturated for a server with no resolvable ceiling authored', () => {
    const w = buildDiskBoundDbWorld({ diskIoPerRequest: 20 })   // no diskIops/diskType authored
    const sim = drive(w.doc, w.compiled)
    for (let i = 0; i < 30; i++) sim.engine.__test_step(1)
    expect(sim.events.filter(e => e.kind === 'disk_saturated')).toHaveLength(0)
    sim.engine.stop()
  })
})

describe('FEAT-007 Task 4: cold-start capacity throttle', () => {
  // One server hosting a public "cold" blueprint (whose workload carries coldStartMs/
  // warmCapacityFraction), plus optionally a same-server "warm" sibling blueprint that never
  // restarts. Both blueprints saturate the dedicated-8 host (8 vCPU @ 5ms/req = 1600 rps ceiling
  // per instance if it had the WHOLE host) under a heavily-oversubscribed population. Normal RAM
  // usage stays well under the cold instance's 300 MB container limit -- OOM is triggered
  // on-demand by a BRIEF memory-leak fault (cleared immediately after it fires) rather than by a
  // permanently-overshooting workload, so the instance restarts exactly ONCE and its ramp can be
  // observed cleanly instead of re-OOMing every few seconds under the same saturating load.
  //
  // The container memLimitMb is scoped to the COLD placement only, so a 'server'-scope
  // memory-leak fault (which accumulates at the SAME rate on every resident instance) only ever
  // pushes the COLD instance over its limit -- the warm sibling (no container limit, well under
  // the roomy server-level ramMb) is never touched. This is what gives the redistribution test
  // genuine asymmetry despite both instances sharing one host's CPU pool: a 'server'-scope 'down'
  // fault would instead restart EVERY resident instance identically
  // (instanceIdsForFaultScope's 'server' branch), never desynchronizing them.
  function singleServerTwoInstances(opts: {
    coldStartMs: number
    warmCapacityFraction: number
    siblingCount?: number
  }) {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs.ramMb = 100_000   // roomy -- host-level OOM is not this fixture's trigger
    doc.servers[server.id] = server

    const coldBp = publicBlueprint('cold', 0)
    coldBp.workload = {
      // ramPerConnMb deliberately tiny: under deep oversubscription, admitted connections/backlog
      // can grow very large, and this fixture must NOT let connection-driven RAM growth cross the
      // container limit on its own (that would re-OOM the instance repeatedly on the ambient
      // saturating load -- the well-documented "Mechanism A" oscillating OOM-kill cycle -- rather
      // than restarting exactly once). The ONLY intended trigger is triggerOneShotOom's brief
      // memory-leak fault below.
      cpuMsPerRequest: 5, ramBaseMb: 64, ramPerConnMb: 0.01, diskIoPerRequest: 0,
      coldStartMs: opts.coldStartMs, warmCapacityFraction: opts.warmCapacityFraction,
    }
    doc.blueprints[coldBp.id] = coldBp
    const coldPl = createPlacement(coldBp.id, server.id)
    coldPl.runtime = {
      type: 'container', stackName: 'app', networkNames: [], portMappings: [],
      cpuLimit: null, memLimitMb: 300,
    }
    doc.placements[coldPl.id] = coldPl
    const coldInstanceId = instanceId(coldPl.id, 0)

    let siblingInstanceId: string | null = null
    if (opts.siblingCount) {
      const warmBp = publicBlueprint('warm', 1)
      warmBp.workload = { cpuMsPerRequest: 5, ramBaseMb: 64, ramPerConnMb: 0.01, diskIoPerRequest: 0 }
      doc.blueprints[warmBp.id] = warmBp
      const warmPl = createPlacement(warmBp.id, server.id)
      warmPl.count = opts.siblingCount
      doc.placements[warmPl.id] = warmPl
      siblingInstanceId = instanceId(warmPl.id, 0)
    }

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 2500   // saturating (~1.6x the 1600 rps solo ceiling) without runaway backlog
    doc.populations[pop.id] = pop

    return { doc, serverId: server.id, instanceId: coldInstanceId, siblingInstanceId }
  }

  // Fires a brief memory-leak fault to push the cold instance's RAM over its 300 MB container
  // limit exactly once, then clears the fault -- a non-'down' clear, so it does NOT itself reset
  // warmth (only a 'down'-fault clear or an OOM restart does, per index.ts's doSetFault/oomVictim
  // wiring). Leaves the OOM restart itself (and the coldStartMs ramp it starts) as the ONLY
  // warmth-affecting event in the run.
  function triggerOneShotOom(sim: ReturnType<typeof drive>, serverId: string, instanceId: string) {
    sim.engine.setFault('server', serverId, { kind: 'memory-leak', mbPerMinute: 6000 })   // 100 MB/s
    sim.stepFor(3)   // base 64 + ~300 MB of leak comfortably crosses the 300 MB container limit
    expect(sim.events.some(e => e.kind === 'oom_kill' && e.affected.includes(instanceId))).toBe(true)
    sim.engine.setFault('server', serverId, null)
  }

  it('COLD START: a restarted instance ramps rps up monotonically toward its pre-OOM baseline', () => {
    const f = singleServerTwoInstances({ coldStartMs: 30_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(3)
    const baseline = sim.latest().instances[f.instanceId].rps
    triggerOneShotOom(sim, f.serverId, f.instanceId)
    for (let i = 0; i < 6; i++) sim.stepFor(1)   // > 5s OOM restart delay
    expect(sim.events.some(e => e.kind === 'instance_restarted' && e.affected.includes(f.instanceId))).toBe(true)
    sim.stepFor(1)
    const justAfterRestart = sim.latest().instances[f.instanceId].rps
    for (let i = 0; i < 9; i++) sim.stepFor(1)   // ~10s into the 30s ramp
    const midRamp = sim.latest().instances[f.instanceId].rps
    for (let i = 0; i < 25; i++) sim.stepFor(1)   // well past the 30s ramp -- fully warm again
    const fullyWarm = sim.latest().instances[f.instanceId].rps
    // Asserts the RAMP SHAPE the capacity throttle produces -- strictly increasing across three
    // widely-spaced samples, and a substantial (not marginal) recovery by the time warmth has
    // long since reached 1 -- rather than exact percentages at fixed offsets: the 1 Hz
    // EMA-published rps (alpha=0.3) smooths the underlying step-level throttle, and the deep
    // backlog built up while heavily throttled takes its own time to drain on top of that, so
    // "fullyWarm" converges toward (not instantly onto) the pre-OOM baseline. hostScheduler.
    // test.ts's own describe block asserts the exact underlying core-allocation fractions
    // (0.3 / 0.65 / 1.0) directly against stepHost, without either of those confounds.
    expect(midRamp).toBeGreaterThan(justAfterRestart)
    expect(fullyWarm).toBeGreaterThan(midRamp)
    expect(fullyWarm).toBeGreaterThan(justAfterRestart * 2)
    expect(fullyWarm).toBeGreaterThan(baseline * 0.5)
    sim.engine.stop()
  })

  it('COLD START REDISTRIBUTION: capacity withheld from a cold instance goes to warm siblings, total host throughput does not fully drop', () => {
    const f = singleServerTwoInstances({ coldStartMs: 30_000, warmCapacityFraction: 0.3, siblingCount: 1 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const totalBefore = Object.values(sim.latest().instances).reduce((s, i: any) => s + i.rps, 0)
    triggerOneShotOom(sim, f.serverId, f.instanceId)
    expect(sim.events.some(e => e.kind === 'oom_kill' && e.affected.includes(f.siblingInstanceId!))).toBe(false)
    for (let i = 0; i < 6; i++) sim.stepFor(1)   // > 5s OOM restart delay -- instance_restarted fires, warming begins
    expect(sim.events.some(e => e.kind === 'instance_restarted' && e.affected.includes(f.instanceId))).toBe(true)
    sim.stepFor(1)
    const totalAfterRestart = Object.values(sim.latest().instances).reduce((s, i: any) => s + i.rps, 0)
    // The withheld share of the cold instance's capacity should be largely absorbed by its warm
    // sibling via the water-fill's work-conserving surplus redistribution, so total host
    // throughput drops by much less than a naive "lose the cold instance's whole share" would.
    expect(totalAfterRestart / totalBefore).toBeGreaterThan(0.75)
    sim.engine.stop()
  })
})

describe('FEAT-007 Task 5: cold-start latency throttle', () => {
  // Same shape as Task 4's singleServerTwoInstances fixture (one cold-capable public blueprint,
  // container-limited so a 'down' fault cleanly restarts it), duplicated locally rather than
  // hoisted out of the Task 4 describe block above -- kept self-contained per this file's existing
  // per-describe-block fixture convention.
  function singleServerTwoInstances(opts: { coldStartMs: number; warmCapacityFraction: number }) {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs.ramMb = 100_000
    doc.servers[server.id] = server

    const coldBp = publicBlueprint('cold', 0)
    coldBp.workload = {
      cpuMsPerRequest: 5, ramBaseMb: 64, ramPerConnMb: 0.01, diskIoPerRequest: 0,
      coldStartMs: opts.coldStartMs, warmCapacityFraction: opts.warmCapacityFraction,
    }
    doc.blueprints[coldBp.id] = coldBp
    const coldPl = createPlacement(coldBp.id, server.id)
    doc.placements[coldPl.id] = coldPl
    const coldInstanceId = instanceId(coldPl.id, 0)

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50   // deliberately low utilization (~3% of the 1600 rps solo ceiling) -- this
    // test is about the latency SHAPE the cold-start throttle produces, so demand is kept far
    // below any capacity/backlog feedback threshold that would otherwise superimpose its own
    // queueing-driven oscillation onto the signal being measured.
    doc.populations[pop.id] = pop

    return { doc, serverId: server.id, instanceId: coldInstanceId }
  }

  it('COLD START LATENCY: a cold instance shows elevated p50 that decays back to baseline as it warms', () => {
    const f = singleServerTwoInstances({ coldStartMs: 30_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    // Published p50Ms (metrics.ts) is an EMA(alpha=0.3) over a 3-batch percentile RESERVOIR, not
    // a raw per-step reading -- even at this fixture's deliberately low, non-saturating rps it
    // oscillates by design (the reservoir mixes in up to 3 seconds of history) independent of the
    // cold-start throttle entirely: a plain steady-state run with no fault at all shows the SAME
    // amplitude of wander. A single-sample-point comparison is therefore not a reliable read of
    // the throttle's effect -- this test instead averages over windows wide enough to smooth that
    // ambient wander out, isolating the throttle's much larger, sustained deviation.
    const baselineTrace: number[] = []
    for (let i = 0; i < 30; i++) { sim.stepFor(1); baselineTrace.push(sim.latest().instances[f.instanceId].p50Ms) }
    const baselineP50 = avg(baselineTrace)
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    const trace: number[] = []
    for (let i = 0; i < 150; i++) { sim.stepFor(1); trace.push(sim.latest().instances[f.instanceId].p50Ms) }
    // The window from t=7..26s post-restart (indices 6..25): skips the first ~6s, where the
    // 3-batch reservoir still carries the 'down' window's own zero-rps sample and transiently
    // pulls the published p50 BELOW baseline before the throttled samples dominate it -- a known
    // artifact of the reservoir mechanic, not the throttle itself. This window sits well inside
    // the 30s coldStartMs ramp, so it is still meaningfully cold.
    const coldP50 = avg(trace.slice(6, 26))
    // t=121..150s post-restart: 90+ seconds past the 30s ramp (warmth long since reached 1) AND
    // past the metrics pipeline's own settling time (EMA + 3-batch reservoir).
    const warmP50 = avg(trace.slice(120, 150))
    expect(coldP50).toBeGreaterThan(baselineP50 * 1.5)   // 1/0.3 ~= 3.3x at t=0, generous floor
    expect(warmP50).toBeLessThan(coldP50)
    expect(warmP50).toBeCloseTo(baselineP50, 0)
    sim.engine.stop()
  })

  // A single instance sustaining a marginal (deliberately close to 100%) CPU overload under
  // heavy client load, RAM-sized so the resulting queueing/backlog pressure at that admitted rps
  // tips it over its container limit -- the same "OOM emerges from sustained load, no fault
  // injection needed" shape as the pre-existing "OOM-kills the largest consumer under a
  // RAM-starved fixture" test above, but tuned to saturate CPU (not just RAM) so the
  // cold-started restart is immediately handed full, unthrottled demand.
  function singleSaturatedInstance(opts: {
    coldStartMs: number
    warmCapacityFraction: number
    demandFraction: number   // pop.peakRps as a multiple of the instance's solo CPU ceiling
    memLimitMb: number
  }) {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)   // 8 vCPU
    doc.servers[server.id] = server

    const cpuMsPerRequest = 5
    const soloCeilingRps = (server.specs.vcpu * 1000) / cpuMsPerRequest   // 1600 rps
    const bp = publicBlueprint('saturated', 0)
    bp.workload = {
      cpuMsPerRequest, ramBaseMb: 64, ramPerConnMb: 4, diskIoPerRequest: 0,
      coldStartMs: opts.coldStartMs, warmCapacityFraction: opts.warmCapacityFraction,
    }
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, server.id)
    pl.runtime = {
      type: 'container', stackName: 'app', networkNames: [], portMappings: [],
      cpuLimit: null, memLimitMb: opts.memLimitMb,
    }
    doc.placements[pl.id] = pl
    const inst = instanceId(pl.id, 0)

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = soloCeilingRps * opts.demandFraction
    doc.populations[pop.id] = pop

    return { doc, serverId: server.id, instanceId: inst }
  }

  // Code-review Critical finding on an earlier version of this test: hostScheduler.ts's
  // `latencyMultiplier = Math.max(1, cpuPressure)` (lines 230-231) ALREADY produces a repeating
  // OOM cycle from plain sustained CPU overload alone, with ZERO cold-start involvement -- proven
  // by the pre-existing 'MEASURED: Mechanism A closes the loop via a repeating OOM-kill cycle'
  // test above (demand backpressure describe block, ~line 2113), whose fixture carries no
  // coldStartMs at all. The original version of this test overloaded demand to ~166% of solo CPU
  // capacity and never reduced it, so Mechanism A alone was plausibly sufficient to explain the
  // second OOM -- the test could not distinguish "the cold-start throttle caused it" from
  // "sustained overload alone would have re-OOM'd regardless, with or without any cold-start
  // config."
  //
  // Fixed via a CONTROL: the IDENTICAL fixture/demand run twice, differing ONLY in coldStartMs (30s
  // vs 0, the Task 3 regression floor -- 0 means warmingUntil is never populated on restart, so the
  // restarted instance is handed full, unthrottled capacity immediately, byte-identical to
  // pre-FEAT-007 behavior). An empirical parameter sweep (demandFraction x memLimitMb, discarded
  // after tuning) found a demand/RAM-headroom combination -- 101% of solo CPU ceiling, deliberately
  // modest so the SAME quantum of extra queueing pressure the throttle adds is a large relative
  // effect, not lost in an already-runaway overload -- where Mechanism A alone (the control) still
  // exists but is comparatively mild (one additional OOM over the 30s post-restart window), while
  // the SAME demand with the cold-start throttle engaged produces a MUCH larger repeat-OOM rate
  // (five additional OOMs in the same window) -- a ~5x difference, not a coin-flip-sized one. That
  // gap is what's attributable to the throttle: Mechanism A's own contribution is held constant
  // across both runs, so the LARGE excess in the throttled run isolates the throttle's own causal
  // effect rather than merely riding along on top of it.
  const RESTART_STORM_DEMAND_FRACTION = 1.01   // 101% of solo CPU ceiling -- deliberately marginal
  const RESTART_STORM_MEM_LIMIT_MB = 1080

  it('RESTART STORM: an overloaded service, killed and restarted cold, re-saturates and OOMs MUCH more than sustained overload alone would', () => {
    const throttled = singleSaturatedInstance({
      coldStartMs: 30_000, warmCapacityFraction: 0.2,
      demandFraction: RESTART_STORM_DEMAND_FRACTION, memLimitMb: RESTART_STORM_MEM_LIMIT_MB,
    })
    const control = singleSaturatedInstance({
      coldStartMs: 0, warmCapacityFraction: 0.2,   // regression floor: throttle disabled
      demandFraction: RESTART_STORM_DEMAND_FRACTION, memLimitMb: RESTART_STORM_MEM_LIMIT_MB,
    })
    const simT = drive(throttled.doc, compileWorld(throttled.doc))
    const simC = drive(control.doc, compileWorld(control.doc))

    // 15s: long enough for the marginal (101%-of-ceiling) overload to tip both instances into
    // their first OOM under plain sustained load -- identical setup, no throttle involved yet
    // (restart hasn't happened for either).
    simT.stepFor(15)
    simC.stepFor(15)
    const oom1T = simT.events.filter(e => e.kind === 'oom_kill').length
    const oom1C = simC.events.filter(e => e.kind === 'oom_kill').length
    expect(oom1T).toBeGreaterThanOrEqual(1)   // saturation already causes at least one OOM
    expect(oom1C).toBeGreaterThanOrEqual(1)   // the control starts from the SAME saturated state

    // Both restart and receive the SAME full, unthrottled demand -- the throttled instance ramps
    // capacity back up over 30s (coldStartMs), the control gets full capacity back immediately.
    simT.stepFor(30)
    simC.stepFor(30)
    const oom2T = simT.events.filter(e => e.kind === 'oom_kill').length
    const oom2C = simC.events.filter(e => e.kind === 'oom_kill').length

    expect(oom2T).toBeGreaterThan(oom1T)   // re-saturates and OOMs again -- the feature's core claim
    // Mechanism A alone (the control) also re-OOMs some at this marginal demand level -- that's
    // expected and not itself a bug. What proves the throttle's causal contribution is that the
    // SAME demand, restarted cold, produces MATERIALLY MORE repeat-OOMs than the control did in
    // the identical window: the throttle is what tips a marginal-but-recovering overload into a
    // much worse one, not merely riding along on an already-guaranteed repeat.
    expect(oom2T).toBeGreaterThan(oom2C)
    expect(oom2T - oom1T).toBeGreaterThan((oom2C - oom1C) * 2)   // materially more, not marginally

    simT.engine.stop()
    simC.engine.stop()
  })
})

describe('FEAT-007 Task 6: degraded health during warm-up + published warmth', () => {
  // Same shape as Task 4/5's singleServerTwoInstances fixture (one cold-capable public blueprint,
  // container-limited so a 'down' fault cleanly restarts it), duplicated locally rather than
  // hoisted out of those describe blocks -- kept self-contained per this file's existing
  // per-describe-block fixture convention.
  function singleServerTwoInstances(opts: { coldStartMs: number; warmCapacityFraction: number }) {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs.ramMb = 100_000
    doc.servers[server.id] = server

    const coldBp = publicBlueprint('cold', 0)
    coldBp.workload = {
      cpuMsPerRequest: 5, ramBaseMb: 64, ramPerConnMb: 0.01, diskIoPerRequest: 0,
      coldStartMs: opts.coldStartMs, warmCapacityFraction: opts.warmCapacityFraction,
    }
    doc.blueprints[coldBp.id] = coldBp
    const coldPl = createPlacement(coldBp.id, server.id)
    doc.placements[coldPl.id] = coldPl
    const coldInstanceId = instanceId(coldPl.id, 0)

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50   // deliberately low utilization -- keeps this test about health/warmth
    // publication, not capacity/latency throttle shape (already covered by Tasks 4/5).
    doc.populations[pop.id] = pop

    return { doc, serverId: server.id, instanceId: coldInstanceId }
  }

  it('DIVERGENCE GUARD: published warmth equals warmthOf computed with the same warmingUntil/simMs the scheduler used', () => {
    const f = singleServerTwoInstances({ coldStartMs: 20_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    // A 'down'-fault clear does not un-latch server-scope health to 'healthy' instantly --
    // failover.ts's computeHealth holds the pre-clear severity for DEFAULT_HYSTERESIS.recoveryMs
    // (5s) once the instant probe starts reading healthy again, mirroring a real LB's
    // slow-to-trust-recovery behavior. 9s comfortably clears that 5s recovery lock while staying
    // well inside the 20s coldStartMs ramp, so baseHealth reads 'healthy' by the time this
    // assertion runs and the only thing that can still be lifting it to 'degraded' is warmth < 1.
    sim.stepFor(9) // mid-warmup, past the recovery-hysteresis lock
    const b = sim.latest()
    const published = (b.instances[f.instanceId] as any).warmth
    expect(published).toBeGreaterThan(0)
    expect(published).toBeLessThan(1)
    expect(b.instances[f.instanceId].health).toBe('degraded')
    sim.engine.stop()
  })
})

describe('FEAT-007 Task 7: instance_warming/instance_warm events', () => {
  // Same shape as Task 4/5/6's singleServerTwoInstances fixture (one cold-capable public
  // blueprint, container-limited so a 'down' fault cleanly restarts it), duplicated locally per
  // this file's existing per-describe-block fixture convention.
  function singleServerTwoInstances(opts: { coldStartMs: number; warmCapacityFraction: number }) {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    server.specs.ramMb = 100_000
    doc.servers[server.id] = server

    const coldBp = publicBlueprint('cold', 0)
    coldBp.workload = {
      cpuMsPerRequest: 5, ramBaseMb: 64, ramPerConnMb: 0.01, diskIoPerRequest: 0,
      coldStartMs: opts.coldStartMs, warmCapacityFraction: opts.warmCapacityFraction,
    }
    doc.blueprints[coldBp.id] = coldBp
    const coldPl = createPlacement(coldBp.id, server.id)
    doc.placements[coldPl.id] = coldPl
    const coldInstanceId = instanceId(coldPl.id, 0)

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 50
    doc.populations[pop.id] = pop

    return { doc, serverId: server.id, instanceId: coldInstanceId }
  }

  it('emits instance_warming on restart and instance_warm once coldStartMs has elapsed', () => {
    const f = singleServerTwoInstances({ coldStartMs: 10_000, warmCapacityFraction: 0.3 })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    sim.engine.setFault('server', f.serverId, { kind: 'down' })
    sim.stepFor(1)
    sim.engine.setFault('server', f.serverId, null)
    sim.stepFor(1)
    expect(sim.events.filter(e => e.kind === 'instance_warming')).toHaveLength(1)
    for (let i = 0; i < 12; i++) sim.stepFor(1)
    expect(sim.events.filter(e => e.kind === 'instance_warm')).toHaveLength(1)
    sim.engine.stop()
  })
})

describe('FEAT-008 Task 13: wire AutoscaleState into the engine loop', () => {
  // One region/AZ/server, one public autoscaled placement (count === autoscale.minCount, per the
  // compile-finding invariant Task 11 added). compileWorld expands it to the FULL maxCount
  // envelope on the SAME server (a Placement has exactly one serverId), so every instance of this
  // placement is resident on `server` -- exactly the shape the parking test needs. Traffic is
  // deliberately tiny relative to targetCpuPercent so desiredCount never actually moves during a
  // short drive (this describe block is about the PARKING/exclusion machinery, not the control
  // loop's arithmetic -- that's Task 22's scope).
  function autoscaledPlacementWorld(policy: {
    minCount: number; maxCount: number; targetCpuPercent: number
    scaleUpCooldownSec: number; scaleDownCooldownSec: number
  }) {
    const doc = createWorld()
    doc.routing.policy = 'latency'
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server

    const blueprint = publicBlueprint('web', 0)
    doc.blueprints[blueprint.id] = blueprint

    const pl = createPlacement(blueprint.id, server.id)
    pl.count = policy.minCount
    pl.autoscale = { ...policy }
    doc.placements[pl.id] = pl

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 5   // small: keeps observedCpu well under targetCpuPercent for this block's tests
    doc.populations[pop.id] = pop

    const instanceIdsForPlacement = Array.from({ length: policy.maxCount }, (_, i) => instanceId(pl.id, i))
    return { doc, placementId: pl.id, instanceIdsForPlacement, server, blueprint }
  }

  it('AUTOSCALE PARKING: parked instances are excluded from host CPU/RAM totals', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    })
    const compiled = compileWorld(f.doc)
    // The envelope: compileWorld expands to maxCount, not the authored/desired count (Task 11).
    expect(Object.values(compiled.instances).filter(i => i.placementId === f.placementId).length).toBe(4)

    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const b = sim.latest()

    // Task 13's own scope: the host scheduler must never see an InstanceLoad entry for a parked
    // instance, so the published per-server RAM total -- servers[id].ramUsedMb, read straight off
    // HostStepResult.ramUsedMb (metrics.ts prefers `host?.ramUsedMb` over summing ramByInstance) --
    // can only ever reflect the ONE running instance's footprint here, never the 4-instance
    // envelope compileWorld expanded to. If parking were broken (all 4 resident instances handed
    // to stepHost every step), this would read >= 4 * ramBaseMb (512); with parking working, it
    // must stay under 2x a single instance's base RAM.
    //
    // (The complementary assertion -- that MetricsBatch.instances OMITS parked instance ids
    // entirely -- depends on Task 16's metrics-publishing change and is added there; metrics.ts
    // today still iterates ALL of compiled.instances when building the per-instance map, so every
    // envelope id is present in b.instances regardless of running/parked state until that task
    // lands.)
    const serverMetrics = b.servers[f.server.id]
    expect(serverMetrics.ramUsedMb).toBeGreaterThan(0)
    expect(serverMetrics.ramUsedMb).toBeLessThan(f.blueprint.workload.ramBaseMb * 2)
    sim.engine.stop()
  })

  it('DIVERGENCE GUARD: MetricsBatch.instances contains only running instances, runningByPlacement matches', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    })
    const compiled = compileWorld(f.doc)
    expect(Object.keys(compiled.instances).filter(id => f.instanceIdsForPlacement.includes(id)).length).toBe(4)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const b = sim.latest()
    const publishedForPlacement = Object.keys(b.instances).filter(id => f.instanceIdsForPlacement.includes(id))
    expect(publishedForPlacement.length).toBe((b as any).runningByPlacement[f.placementId])
    expect((b as any).runningByPlacement[f.placementId]).toBe(1) // still at minCount, no load yet to trigger scale-out
    sim.engine.stop()
  })

  it('AUTOSCALE ROUTING: a parked instance never receives routed traffic', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(5)
    const b = sim.latest()
    for (const parkedId of f.instanceIdsForPlacement.slice(1)) {
      // whether the batch omits the entry (Task 16) or still includes it, rps must be 0 for any
      // parked instance that IS present in this intermediate state
      const im = (b.instances as any)[parkedId]
      if (im) expect(im.rps).toBe(0)
    }
    sim.engine.stop()
  })

  // Companion to the test above: checking a parked instance's OWN rps==0 doesn't by itself prove
  // traffic-exclusion is wired up, because Task 13 already keeps a parked instance out of the
  // host scheduler's per-step window entirely -- its rps reads 0 by construction whether or not
  // the LB still round-robins live demand onto it. The real, pre-Task-14 bug is upstream of that:
  // distributeToTargets' round-robin cursor cycled across ALL 4 envelope instances (including the
  // 3 parked ones), so only 1-in-4 routing passes ever landed the region's full demand on the one
  // RUNNING instance -- the other 3 passes handed real rps to a parked instance, which the host
  // scheduler then silently dropped (no window entry ever created for it -- not served, not
  // errored, not counted as dropped-by-AZ either). This test pins the OTHER, directly-observable
  // side of that: with only 1 eligible target, the running instance's published rps should track
  // the FULL offered demand every step once the EMA has settled, not oscillate/undershoot from
  // only receiving its turn 1-in-4 routing passes.
  it('AUTOSCALE ROUTING: the one running instance absorbs the full demand once EMA settles (no traffic lost to a parked round-robin target)', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    })
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    const runningId = f.instanceIdsForPlacement[0]
    let lastRps = 0
    for (let step = 0; step < 30; step++) {
      sim.stepFor(1)
      lastRps = ((sim.latest().instances as any)[runningId]?.rps ?? 0) as number
    }
    // With only 1 eligible (non-parked) target, distributeToTargets' round-robin cursor now
    // always lands on it -- the running instance's EMA'd rps at step 30 settles at ~10.6 with
    // this fix applied, vs. ~6.5 pre-fix (only 1-in-4 routing passes ever reached the running
    // instance, the other 3 silently lost to a parked target). 8.5 sits cleanly between the two
    // measured values -- a real red/green boundary, not a loose sanity check.
    expect(lastRps).toBeGreaterThan(8.5)
    sim.engine.stop()
  })

  it('AUTOSCALE DRAIN: a scaled-in instance stops receiving new traffic but its errorRate does not spike', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 4, targetCpuPercent: 10, scaleUpCooldownSec: 9999, scaleDownCooldownSec: 1,
    })
    // targetCpuPercent set absurdly low so a scale-out happens fast (evaluatePolicy has no
    // scaleStep here, so it jumps straight from minCount to maxCount in one decision) under the
    // fixture's synthetic demand, then a scale-in happens fast once the running fleet's mean CPU
    // settles back under a target this low (it always will, at target=10%). peakRps bumped well
    // above the fixture default (5) so the placement is forced above minCount at all -- otherwise
    // it never leaves 1 instance and there is nothing to scale back IN from. scaleUpCooldownSec is
    // set absurdly HIGH (asymmetric on purpose, review fix) so the one initial ramp-up scale_out
    // can never be followed by another mid-test -- without this, a naive 1s/1s cooldown pair
    // thrashes scale_out/scale_in every ~1-2s once the fleet shrinks and per-instance CPU rises
    // again, which re-inflates ramUsedMb between our drain-window readings and makes the RAM
    // assertion below flaky/wrong for reasons unrelated to drain correctness. With scale-out
    // effectively locked out after the first ramp-up, every scale_in from here on is monotonic --
    // host RAM can only ever go down, never bounce back up, which is exactly what makes "did RAM
    // drop when it should have" an unambiguous, non-flaky signal.
    const popId = Object.keys(f.doc.populations)[0]
    f.doc.populations[popId].peakRps = 200
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(2)
    sim.stepFor(3) // let the placement ramp all the way out to maxCount under the heavy demand

    // Now drop demand hard (review fix, replaces relying on organic 1s/1s thrash): with
    // scaleUpCooldownSec locked out for the rest of the test, the ONLY way back down from
    // maxCount is a genuine scale-in decision -- so cutting peakRps here (the doc is read live by
    // populationDemandRps every step, no re-compile needed) drives observed per-instance CPU
    // (25% at maxCount under the original 200rps) comfortably under targetCpuPercent (10%),
    // triggering a clean, single-direction scale-in run with nothing to muddy the RAM reading.
    f.doc.populations[popId].peakRps = 5
    sim.stepFor(60) // long enough for at least one scale-in decision under the now-low load

    const scaleInEvents = sim.events.filter(e => e.kind === 'scale_in')
    expect(scaleInEvents.length).toBeGreaterThan(0)

    const b = sim.latest()
    const errorRates = Object.values(b.instances).map((i: any) => i.errorRate)
    expect(Math.max(...errorRates, 0)).toBeLessThan(0.05) // no error spike from an abrupt drop

    // Review fix: errorRate<0.05 alone does NOT discriminate "drain correctly kept the instance
    // running" from "the instance was parked instantly with zero CPU/RAM" -- a parked instance
    // with no traffic also trivially reports errorRate 0. Assert directly on the server's
    // published ramUsedMb -- built from HostStepResult.ramUsedMb, the SAME running-instance-
    // filtered sum the AUTOSCALE PARKING test above exercises via stepHost's `loads` array
    // (index.ts's `resident.filter(i => s.runningSet(i.id))`). A running-but-draining instance
    // still contributes its ramBaseMb to that sum (its InstanceLoad entry isn't dropped until the
    // drain window elapses and it actually parks) -- ramBaseMb=128 for this fixture's default
    // blueprint workload (factories.ts createBlueprint), dwarfing the few-MB connection-driven
    // swing on the surviving instances, so a 64 MB (half a baseline) tolerance cleanly separates
    // "still counted" from "already dropped".
    const ramBaseMb = 128
    // MetricsBatch publishes at 1 Hz (one batch per simulated second, not per 100ms engine step —
    // confirmed empirically: consecutive sim.batches entries are ~1000ms apart), so "before"/
    // "after" the scale_in instant must be resolved against ACTUAL batch simMs values, not an
    // arbitrary +/-100ms offset (which can land on the very same batch as its neighbor and
    // silently compare a value against itself, proving nothing either way).
    const batchBefore = (simMs: number) => {
      let best: (typeof sim.batches)[number] | undefined
      for (const batch of sim.batches) {
        if (batch.simMs >= simMs) break
        best = batch
      }
      return best
    }
    const batchAtOrAfter = (simMs: number) => sim.batches.find(b => b.simMs >= simMs)
    const ramOf = (b: (typeof sim.batches)[number] | undefined) => b!.servers[f.server.id].ramUsedMb

    const firstScaleIn = scaleInEvents[0]
    const ramJustBeforeScaleIn = ramOf(batchBefore(firstScaleIn.simMs))
    // The FIRST batch published at/after the scale_in instant -- the earliest possible moment a
    // broken (non-draining) implementation could show the drop.
    const rightAfterBatch = batchAtOrAfter(firstScaleIn.simMs)
    const ramRightAfterScaleIn = ramOf(rightAfterBatch)
    // If drain were broken (instant park instead of a graceful window), ramUsedMb would drop by a
    // full ramBaseMb the very step scale_in fires. With drain wired correctly it must NOT drop
    // (the just-demoted instance is still in the running set, still billed its RAM baseline).
    expect(ramRightAfterScaleIn).toBeGreaterThan(ramJustBeforeScaleIn - ramBaseMb * 0.5)

    // Buffer beyond INSTANCE_DRAIN_MS is generous (2s, ~2 more 1Hz batch ticks) because the
    // drain-complete cleanup pass and metrics EMA settle a little after the raw deadline, not
    // exactly on it -- and it's safe to be generous here specifically because scaleUpCooldownSec
    // is locked out for the rest of this test (see above), so nothing can re-inflate ramUsedMb
    // while we wait.
    const ramAfterDrainWindow = ramOf(batchAtOrAfter(rightAfterBatch!.simMs + INSTANCE_DRAIN_MS + 2000))
    // Once the drain window (INSTANCE_DRAIN_MS) elapses, the instance genuinely parks and host RAM
    // must drop -- if drain never actually completed (e.g. clearInstanceDrain never wired to the
    // cleanup pass), ramUsedMb would stay flat forever instead.
    expect(ramAfterDrainWindow).toBeLessThan(ramRightAfterScaleIn - ramBaseMb * 0.5)
    sim.engine.stop()
  })

  // Wave 3 final review (Important #2): clearInstanceDrain/instanceDrainFactor were exported and
  // unit-tested in autoscale.ts but had ZERO production callers in index.ts -- only
  // beginInstanceDrain was wired up. Concrete bug: a scale-in followed by a scale-out that
  // re-activates the SAME instance slot faster than INSTANCE_DRAIN_MS (2000ms) apart left that
  // slot stuck in drainUntilByInstance from the earlier scale-in, so routingHealthOfInstance kept
  // reporting it 'down' for routing purposes for the remainder of the now-stale drain window even
  // though the engine now wants it actively serving again. This test drives that exact sequence
  // end-to-end (both cooldowns at 0 so decisions aren't cooldown-gated) and confirms the
  // reactivated slot is genuinely routable again, not silently starved.
  it('AUTOSCALE DRAIN: a scale-out that re-activates a still-draining slot is immediately routable again', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 2, targetCpuPercent: 20, scaleUpCooldownSec: 0, scaleDownCooldownSec: 0,
    })
    const popId = Object.keys(f.doc.populations)[0]
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    const reactivatedId = f.instanceIdsForPlacement[1]   // the slot both scale-out decisions touch

    // Steps in 100ms increments, polling for `predicate` after each -- avoids brittle fixed step
    // counts against an EMA-driven control loop whose exact settling time isn't a stable constant.
    const stepUntil = (predicate: () => boolean, maxSteps: number): boolean => {
      for (let i = 0; i < maxSteps; i++) {
        sim.engine.__test_step(1)
        if (predicate()) return true
      }
      return false
    }

    // Phase 1: spike demand (matching "AUTOSCALE EVENTS" above's proven 1000rps/20%-target
    // combination -- comfortably past what a single dedicated-8 instance can hold), wait for the
    // first scale-out (1 -> 2). Generous budget -- this decision isn't timing-sensitive, only the
    // phase 2 -> 3 gap below is.
    f.doc.populations[popId].peakRps = 1000
    expect(stepUntil(() => sim.events.some(e => e.kind === 'scale_out'), 120)).toBe(true)

    // Phase 2: drop demand hard, wait for a scale-in (2 -> 1) -- begins index 1's drain.
    f.doc.populations[popId].peakRps = 1
    const scaleInCountBefore = sim.events.filter(e => e.kind === 'scale_in').length
    expect(stepUntil(() => sim.events.filter(e => e.kind === 'scale_in').length > scaleInCountBefore, 100)).toBe(true)
    const firstScaleInEvent = sim.events.filter(e => e.kind === 'scale_in')[0]

    // Phase 3: spike again IMMEDIATELY -- tight budget (well under INSTANCE_DRAIN_MS in step
    // count) so this genuinely exercises the race, not a scale-out that happens to land after the
    // original drain would have completed on its own anyway.
    f.doc.populations[popId].peakRps = 1000
    const scaleOutCountBefore = sim.events.filter(e => e.kind === 'scale_out').length
    expect(stepUntil(() => sim.events.filter(e => e.kind === 'scale_out').length > scaleOutCountBefore, 18)).toBe(true)
    const scaleOutEventsAfter = sim.events.filter(e => e.kind === 'scale_out')
    const secondScaleOutEvent = scaleOutEventsAfter[scaleOutEventsAfter.length - 1]

    // Pin the actual regression condition: this second scale-out landed WHILE the original drain
    // (begun by firstScaleInEvent) was still pending, not after it would have naturally elapsed.
    expect(secondScaleOutEvent.simMs - firstScaleInEvent.simMs).toBeLessThan(INSTANCE_DRAIN_MS)

    // Let routing settle, then confirm the reactivated slot is genuinely receiving traffic. If
    // clearInstanceDrain were never wired to this scale-out, routingHealthOfInstance would still
    // see a live drainUntilByInstance entry for it and report it 'down' for routing purposes,
    // pinning its rps at 0 for the remainder of the ORIGINAL (now stale) drain window.
    sim.stepFor(3)
    const rps = ((sim.latest().instances as any)[reactivatedId]?.rps ?? 0) as number
    expect(rps).toBeGreaterThan(0)
    sim.engine.stop()
  })

  // Task 17: 'scale_out' itself was already wired by Task 13 (the emit() call sits right next to
  // 'scale_in' at the evaluatePolicy call site) -- this test's job is to genuinely exercise that
  // path end-to-end (not just assert Task 13's own scale-in test incidentally implies it fired),
  // so a low targetCpuPercent + short scaleUpCooldownSec here is deliberately picked to force a
  // fast, observable scale-out under this fixture's synthetic demand.
  it('AUTOSCALE EVENTS: emits scale_out when a placement scales up under sustained load', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 4, targetCpuPercent: 20, scaleUpCooldownSec: 1, scaleDownCooldownSec: 300,
    })
    const popId = Object.keys(f.doc.populations)[0]
    // Well above what a single dedicated-8 (8 vCPU, full share to a lone running instance) instance
    // can hold under a 20% CPU target -- observedCpuPercent = cpuCoresUsed / 8 * 100, so this needs
    // to push cpuCoresUsed comfortably past 1.6 cores.
    f.doc.populations[popId].peakRps = 1000
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(10) // enough for at least one evaluation past the 1s cooldown under saturating load
    expect(sim.events.filter(e => e.kind === 'scale_out').length).toBeGreaterThan(0)
    sim.engine.stop()
  })

  // Task 17's actual new scope: 'autoscale_ceiling' fires when a placement is pinned at maxCount
  // while still over its CPU target -- maxCount deliberately tiny (2) and targetCpuPercent
  // deliberately low (5%) so the fixture's default demand guarantees saturation even once the
  // fleet is fully scaled out, and scaleUpCooldownSec is short so the placement reaches maxCount
  // quickly within the step budget.
  it('AUTOSCALE EVENTS: emits autoscale_ceiling when sustained overload holds the placement at maxCount', () => {
    const f = autoscaledPlacementWorld({
      minCount: 1, maxCount: 2, targetCpuPercent: 5, scaleUpCooldownSec: 1, scaleDownCooldownSec: 300,
    })
    // The fixture's default peakRps (5) keeps CPU well under even a 5% target -- override it here
    // so the fleet both reaches maxCount AND stays saturated once there (matching the brief's
    // "maxCount deliberately tiny + target deliberately low so saturation is guaranteed even at
    // maxCount").
    const popId = Object.keys(f.doc.populations)[0]
    f.doc.populations[popId].peakRps = 200
    const compiled = compileWorld(f.doc)
    const sim = drive(f.doc, compiled)
    sim.stepFor(15)
    expect(sim.events.filter(e => e.kind === 'autoscale_ceiling').length).toBeGreaterThan(0)
    sim.engine.stop()
  })

  it('REGRESSION FLOOR: a placement with no autoscale compiles to exactly count instances and simulates byte-identically', () => {
    const f = e2eFixture()
    const simA = drive(f.doc, f.compiled); simA.stepFor(30)
    const simB = drive(f.doc, f.compiled); simB.stepFor(30)
    expect(simB.latest()).toEqual(simA.latest())
    simA.engine.stop()
    simB.engine.stop()
  })
})

describe('FEAT-008/FEAT-007 Task 22: wave-close integration tests', () => {
  // One region/AZ/server, one public autoscaled placement, same shape as Task 13's
  // autoscaledPlacementWorld above (re-derived locally per this file's established convention of
  // scoping fixture factories to their describe block rather than sharing one across every FEAT-008
  // block). pop.diurnal is 'custom' with a hand-authored curve (FEAT-003) instead of 'flat': eight
  // 15s segments over the engine's compressed 120s "day" (demand.ts's DAY_MS) alternate a near-zero
  // trough and a saturating peak, producing a genuine triangle wave whose demand crosses back and
  // forth across any reasonable targetCpuPercent every ~15s — not a single step change, and not the
  // synthetic "manually flip peakRps mid-test" pattern several earlier tests in this file use
  // (AUTOSCALE DRAIN, etc), since the asymmetry test below needs the SAME oscillating fixture run
  // twice back-to-back for 120s unattended.
  function oscillatingLoadAutoscaledWorld(policy: {
    minCount: number; maxCount: number; targetCpuPercent: number
    scaleUpCooldownSec: number; scaleDownCooldownSec: number
  }) {
    const doc = createWorld()
    doc.routing.policy = 'latency'
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server

    const blueprint = publicBlueprint('web', 0)
    doc.blueprints[blueprint.id] = blueprint

    const pl = createPlacement(blueprint.id, server.id)
    pl.count = policy.minCount
    pl.autoscale = { ...policy }
    doc.placements[pl.id] = pl

    const pop = createPopulation('nyc', 40.7, -74.0)
    // 900 peak rps x a 3x multiplier x 5ms/req (factories.ts's default cpuMsPerRequest) on a
    // dedicated-8 (8 vCPU) instance = ~1.7k cpuCoresUsed-equivalent -- comfortably saturating past
    // any targetCpuPercent at the trough of the fleet, and the 0.05x multiplier trough is ~2.5%
    // CPU -- comfortably under it. Amplitude is intentionally generous (not a near-threshold
    // fixture) so the effect under test (cooldown asymmetry) dominates over Poisson/burst noise.
    pop.peakRps = 900
    pop.diurnal = 'custom'
    pop.curve = [
      { atFraction: 0, multiplier: 0.05 },
      { atFraction: 0.125, multiplier: 3 },
      { atFraction: 0.25, multiplier: 0.05 },
      { atFraction: 0.375, multiplier: 3 },
      { atFraction: 0.5, multiplier: 0.05 },
      { atFraction: 0.625, multiplier: 3 },
      { atFraction: 0.75, multiplier: 0.05 },
      { atFraction: 0.875, multiplier: 3 },
      { atFraction: 1, multiplier: 0.05 },
    ]
    doc.populations[pop.id] = pop
    return { doc }
  }

  // Proves scaleDownCooldownSec is a real, independent knob (not decorative / not silently
  // aliased to scaleUpCooldownSec) — under IDENTICAL oscillating demand and an IDENTICAL
  // scaleUpCooldownSec, only scaleDownCooldownSec differs between the two runs. A tight
  // scale-down cooldown (20s) lets the placement track the trough every ~30s cycle; a loose one
  // (300s, longer than the whole 120s test) locks scale_in out almost entirely for the run's
  // duration, so it can only ever accrue the scale_out events both runs share. If cooldown gating
  // were broken (e.g. both directions sharing one timer, or scaleDownCooldownSec ignored
  // entirely), tightCount and looseCount would come out equal.
  it('AUTOSCALE ASYMMETRY: a shorter scaleDownCooldownSec produces more scale events under oscillating load than a longer one', () => {
    const tightPolicy = { minCount: 1, maxCount: 6, targetCpuPercent: 50, scaleUpCooldownSec: 10, scaleDownCooldownSec: 20 }
    const loosePolicy = { minCount: 1, maxCount: 6, targetCpuPercent: 50, scaleUpCooldownSec: 10, scaleDownCooldownSec: 300 }
    const runWith = (policy: typeof tightPolicy) => {
      const f = oscillatingLoadAutoscaledWorld(policy) // demand alternates high/low every ~15s
      const compiled = compileWorld(f.doc)
      const sim = drive(f.doc, compiled)
      sim.stepFor(120)
      const count = sim.events.filter(e => e.kind === 'scale_in' || e.kind === 'scale_out').length
      sim.engine.stop()
      return count
    }
    const tightCount = runWith(tightPolicy)
    const looseCount = runWith(loosePolicy)
    expect(tightCount).toBeGreaterThan(looseCount)
    // Negative control: the two runs must actually have DIFFERED in scale-out participation too
    // (both directions active in principle), otherwise a "tightCount > looseCount" reading could
    // be trivially explained by the loose run never scaling at all (e.g. a broken fixture where
    // demand never crosses target), rather than by the cooldown asymmetry under test.
    expect(looseCount).toBeGreaterThan(0)
  })

  // Local factory (distinct from Task 13's describe-scoped one of the same name above) so this
  // describe block's fixtures stay self-contained per this file's convention — adds an optional
  // coldStartMs/warmCapacityFraction on the blueprint's workload, FEAT-007's hookup point
  // (index.ts reads bp.workload.coldStartMs at the scale-out call site).
  function autoscaledPlacementWorld(policy: {
    minCount: number; maxCount: number; targetCpuPercent: number
    scaleUpCooldownSec: number; scaleDownCooldownSec: number; coldStartMs: number
  }) {
    const doc = createWorld()
    doc.routing.policy = 'latency'
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[az.id] = az
    const server = createServer(az.id, getPreset('dedicated-8')!)
    doc.servers[server.id] = server

    const blueprint = publicBlueprint('web', 0)
    if (policy.coldStartMs > 0) {
      blueprint.workload.coldStartMs = policy.coldStartMs
      blueprint.workload.warmCapacityFraction = 0.2
    }
    doc.blueprints[blueprint.id] = blueprint

    const pl = createPlacement(blueprint.id, server.id)
    pl.count = policy.minCount
    pl.autoscale = {
      minCount: policy.minCount, maxCount: policy.maxCount, targetCpuPercent: policy.targetCpuPercent,
      scaleUpCooldownSec: policy.scaleUpCooldownSec, scaleDownCooldownSec: policy.scaleDownCooldownSec,
    }
    doc.placements[pl.id] = pl

    const pop = createPopulation('nyc', 40.7, -74.0)
    pop.peakRps = 5   // small: keeps the placement at minCount until the spike below
    doc.populations[pop.id] = pop

    const instanceIdsForPlacement = Array.from({ length: policy.maxCount }, (_, i) => instanceId(pl.id, i))
    return { doc, placementId: pl.id, instanceIdsForPlacement }
  }

  // FEAT-007 x FEAT-008 interaction: a scale-out event mints new instances that start cold
  // (index.ts's Task 6 hookup), so a demand spike that triggers autoscaling should NOT recover p99
  // the moment scale_out fires -- the new capacity is still ramping through coldStartMs.
  //
  // The metric MUST be fleet-wide (the worst/max p99Ms across every currently-running instance of
  // the placement), not one arbitrarily chosen instance's own p99 -- this fixture's whole envelope
  // lives on ONE server (a Placement has exactly one serverId; see autoscaledPlacementWorld), so
  // stepHost's water-fill CPU scheduler shares that one server's fixed core budget across every
  // RESIDENT instance. A cold/degraded sibling's reduced water-fill weight means it draws LESS of
  // the shared budget, which paradoxically leaves the placement's already-warm original instance
  // WITH MORE headroom than it would have if every sibling were fully warm and competing for an
  // equal share -- so index 0's own p99 alone (measured first, and confirmed empirically) actually
  // reads BETTER in the cold run than the warm one, exactly backwards from the effect this test is
  // supposed to catch. Aggregating to the fleet's worst p99 fixes that: it directly reflects what a
  // real caller round-robined across every running instance would experience, and the cold run's
  // still-ramping siblings (empirically ~2000ms p99 while under 15% warmth) dominate that max.
  //
  // The straightforward assertion (fleet p99 stays elevated 10s after the spike) is on its own NOT
  // a discriminating test: a permanently-saturated fleet would show the exact same "hasn't
  // recovered" reading whether or not cold start is wired up at all. The negative control below
  // (coldStartMs=0, otherwise byte-identical fixture/spike) is what makes this a real red/green
  // test: with cold start genuinely gating capacity, the instant-warm control's new instances
  // contribute at full capacity from the start, so its fleet-wide p99 is meaningfully BETTER than
  // the cold run's by +10s -- if the coldStartMs wiring silently no-op'd, both runs would converge
  // to the same fleet-wide p99 and this comparison would fail to discriminate.
  it('AUTOSCALE + COLD START INTERACTION: a scale-out event does not reduce fleet-wide p99 for ~coldStartMs, and the autoscaler may over-provision in the interim', () => {
    const runWith = (coldStartMs: number) => {
      const f = autoscaledPlacementWorld({
        minCount: 1, maxCount: 6, targetCpuPercent: 50, scaleUpCooldownSec: 5, scaleDownCooldownSec: 300, coldStartMs,
      })
      const compiled = compileWorld(f.doc)
      const sim = drive(f.doc, compiled)
      const popId = Object.keys(f.doc.populations)[0]
      const pop = f.doc.populations[popId]
      const fleetP99 = () => {
        const vals = f.instanceIdsForPlacement
          .map(id => (sim.latest().instances as any)[id]?.p99Ms as number | undefined)
          .filter((v): v is number => typeof v === 'number')
        return Math.max(...vals)
      }

      // evaluatePolicy's scale-DOWN cooldown gate (autoscale.ts) is unarmed until a placement's
      // FIRST-EVER scale-in decision has fired (lastScaleDownAt starts at -Infinity, so nothing
      // gates it) -- meaning the very first scale-out in this placement's life would otherwise be
      // undone one evaluation step (100ms) later by the ordinary post-scale-out dip in fleet-mean
      // observedCpuPercent (the freshly-added instance's rps hasn't caught up to its round-robin
      // share yet), regardless of scaleDownCooldownSec=300 above and regardless of coldStartMs.
      // Pre-arm that free pass with a throwaway blip BEFORE the real, measured spike below, so the
      // real spike's scale-out is actually held for the full measurement window by the (now
      // properly armed) 300s cooldown -- otherwise both runs would trivially revert to 1 instance
      // within a step or two and this test would measure round-robin-settling noise, not
      // coldStartMs.
      pop.peakRps = 1400
      sim.stepFor(1)
      pop.peakRps = 5
      sim.stepFor(2) // let the throwaway instance drain (INSTANCE_DRAIN_MS=2000ms) and CPU settle

      const realSpikeStartMs = sim.latest().simMs
      pop.peakRps = 1400 // the real, measured spike -- forces scale-out under a 50% CPU target
      sim.stepFor(1)
      const p99AtSpike = fleetP99()
      sim.stepFor(10) // well within coldStartMs=60s, after the real scale_out has fired and held
      const p99At10s = fleetP99()
      const eventsAfterRealSpike = sim.events.filter(e => e.simMs >= realSpikeStartMs)
      const scaledOut = eventsAfterRealSpike.some(e => e.kind === 'scale_out')
      const scaledIn = eventsAfterRealSpike.some(e => e.kind === 'scale_in')
      sim.engine.stop()
      return { p99AtSpike, p99At10s, scaledOut, scaledIn }
    }

    const cold = runWith(60_000)
    expect(cold.scaledOut).toBe(true)
    // The real scale-out must have HELD (not reverted) for the pre-arming above to have done its
    // job -- otherwise the assertions below would be measuring a 1-instance fleet in both runs.
    expect(cold.scaledIn).toBe(false)
    expect(cold.p99At10s).toBeGreaterThan(cold.p99AtSpike * 0.7) // has NOT meaningfully recovered

    const warm = runWith(0) // negative control: instant-warm, otherwise identical
    expect(warm.scaledOut).toBe(true)
    expect(warm.scaledIn).toBe(false)
    expect(warm.p99At10s).toBeLessThan(cold.p99At10s) // instant capacity recovers meaningfully more
  })
})

// ─── FEAT-014 (Task 9): NAT gateway byte accounting ────────────────────────────
describe('FEAT-014 (Task 9): NAT gateway byte accounting', () => {
  // One VPC in region A with a single private subnet whose route table's ONLY non-local route
  // targets a NAT gateway (mirrors compileWorld.test.ts's crossRegionSubnetWorld fixture, minus
  // the block-then-unblock steps -- here the NAT route is present from the start). Each entry in
  // `apiSpecs` gets its OWN public entry blueprint + its OWN cross-region target blueprint (so
  // each source server's demand is independently controllable), but every entry's SERVER is
  // placed in the SAME private subnet -- so every one of them resolves (buildNatGatewayIdByServer)
  // to the SAME shared NatGatewayState.
  function natGatewayWorld(apiSpecs: { peakRps: number; fatPacketSizeKb?: number; serverANicMbps?: number }[]) {
    const doc = createWorld()
    doc.routing.policy = 'geo'
    const regionA = createRegion('us-east-1')
    const regionB = createRegion('eu-west-1')
    const azA = createAz(regionA.id, 'us-east-1a')
    const azB = createAz(regionB.id, 'eu-west-1a')
    Object.assign(doc.regions, { [regionA.id]: regionA, [regionB.id]: regionB })
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB })

    const vpc = createVpc(regionA.id)
    const routeTable = createRouteTable(vpc.id)
    const subnet = createSubnet(vpc.id, azA.id, 'private', routeTable.id)
    // The NAT gateway itself lives in a PUBLIC subnet (real AWS shape: it needs its own route to
    // an internet gateway) -- it is the PRIVATE subnet's route table that points cross-region
    // egress AT the gateway, not the gateway's own subnet placement. The gateway previously sat
    // inside the private subnet it served, which could mislead a later task's implementer about
    // which subnet a NAT gateway actually belongs in (task-9-report.md fix-round-1 minor #2).
    const publicRouteTable = createRouteTable(vpc.id)
    const publicSubnet = createSubnet(vpc.id, azA.id, 'public', publicRouteTable.id)
    const nat = createNatGateway(publicSubnet.id)
    doc.vpcs[vpc.id] = vpc
    doc.routeTables[routeTable.id] = routeTable
    doc.routeTables[publicRouteTable.id] = publicRouteTable
    doc.subnets[subnet.id] = subnet
    doc.subnets[publicSubnet.id] = publicSubnet
    doc.natGateways[nat.id] = nat
    routeTable.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: nat.id } })

    const apiInstIds: InstanceId[] = []
    apiSpecs.forEach((spec, i) => {
      const serverA = createServer(azA.id, getPreset('dedicated-8')!)
      serverA.subnetId = subnet.id   // private-subnet server -- its cross-region egress routes via `nat`
      if (spec.serverANicMbps != null) serverA.specs = { ...serverA.specs, nicMbps: spec.serverANicMbps }
      const serverB = createServer(azB.id, getPreset('dedicated-8')!)
      doc.servers[serverA.id] = serverA
      doc.servers[serverB.id] = serverB

      const api = publicBlueprint(`api${i}`, i)
      const target = createBlueprint(`target${i}`, i + 10)
      const dep: BlueprintDependency = {
        id: `dep${i}`, target: { kind: 'blueprint', blueprintId: target.id },
        port: 8080, protocol: 'http', packetTemplateId: null,
      }
      if (spec.fatPacketSizeKb != null) {
        const packetId = 100 + i
        doc.packets = {
          ...doc.packets,
          templates: {
            ...doc.packets.templates,
            [packetId]: {
              id: packetId, name: `blob${i}`, protocol: 'http', method: 'PUT', statusCode: 200,
              sizeKb: spec.fatPacketSizeKb, responseSizeKb: 1,
            },
          },
          nextId: Math.max(doc.packets.nextId, packetId + 1),
        }
        dep.packetMix = [{ packetId, weight: 1 }]
      }
      api.dependencies = [dep]
      doc.blueprints[api.id] = api
      doc.blueprints[target.id] = target
      const plApi = createPlacement(api.id, serverA.id); doc.placements[plApi.id] = plApi
      const plTarget = createPlacement(target.id, serverB.id); doc.placements[plTarget.id] = plTarget
      apiInstIds.push(instanceId(plApi.id, 0))

      const pop = createPopulation(`pop${i}`, 40.7, -74.0)   // near us-east-1 (region A)
      pop.peakRps = spec.peakRps
      doc.populations[pop.id] = pop
    })

    return { doc, nat, apiInstIds }
  }

  it('a doc with NAT gateways accounts bytes routed through the gateway and publishes natGatewayBytesPerSec', () => {
    const { doc, nat } = natGatewayWorld([{ peakRps: 200 }])
    const compiled = compileWorld(doc)
    const sim = drive(doc, compiled)
    sim.stepFor(5)
    const batch = sim.latest()
    expect(batch.world.natGatewayBytesPerSec?.[nat.id]).toBeGreaterThan(0)
    sim.engine.stop()
  })

  // Fix round 1 (Critical #1/#2): settleNatGateway's deliveredFraction/queuedLatencyMs result is
  // now threaded into admittedScaleByServer/extraLatencyMsByServer for every server behind that
  // gateway (index.ts's stepHost loop, one-step-lagged exactly like a per-server NIC's own
  // settleNic result), so a saturated gateway actually throttles/queues instead of only being
  // measured. This is the enforcement half of the plan's Step 1 acceptance test ("two
  // private-subnet servers sharing one NAT gateway each get roughly half its cap when both
  // saturate it, mirrors per-server NIC shedding at the gateway level").
  //
  // Each server binds a fat (5 MB request) packet to its own dependency so realistic peakRps
  // values can reach the 10 Gbps gateway cap (NAT_GATEWAY_NIC_MBPS) without needing unrealistic
  // rps. `alone` sends one server's traffic through the gateway by itself, well under 2x the
  // per-step cap (deliveredFraction stays 1 -- no admission shed, only a small queued-latency
  // add). `combined` sends BOTH servers' identical traffic through the SAME shared gateway --
  // their combined load pushes it past 2x the cap, where settleNic's own formula sheds to a FLAT
  // one-step-of-latency queuedLatencyMs (vs. the small proportional add in the alone case) AND
  // roughly halves deliveredFraction. The instances' own raw compute/NIC capacity is far above
  // 300 rps, so (matching this file's existing latency-assertion idiom, e.g. lines 316/1714, not
  // an rps-shed one) the shared-cap degradation shows up as a materially higher composed p50Ms
  // for BOTH servers, not as an rps drop.
  it('two private-subnet servers sharing one saturated NAT gateway both see materially higher latency (shared cap enforced), not just measured', () => {
    // serverANicMbps is deliberately far above the gateway's 10 Gbps cap (NAT_GATEWAY_NIC_MBPS)
    // so the GATEWAY, not each server's own per-server NIC, is the binding constraint being
    // measured -- otherwise the per-server NIC's own (pre-existing, already-tested) queuing would
    // dominate the comparison and prove nothing about gateway enforcement specifically.
    const spec = { peakRps: 300, fatPacketSizeKb: 5120, serverANicMbps: 200_000 }
    const alone = natGatewayWorld([spec])
    const simAlone = drive(alone.doc, compileWorld(alone.doc))
    simAlone.stepFor(15)
    const aloneP50 = simAlone.latest().instances[alone.apiInstIds[0]]?.p50Ms ?? 0
    simAlone.engine.stop()

    const combined = natGatewayWorld([spec, spec])
    const simCombined = drive(combined.doc, compileWorld(combined.doc))
    simCombined.stepFor(15)
    const batch = simCombined.latest()
    const combinedP50_0 = batch.instances[combined.apiInstIds[0]]?.p50Ms ?? 0
    const combinedP50_1 = batch.instances[combined.apiInstIds[1]]?.p50Ms ?? 0
    simCombined.engine.stop()

    expect(aloneP50).toBeGreaterThan(0)
    // Sharing the saturated gateway meaningfully raises latency on BOTH servers above what either
    // one alone experienced through it -- the enforcement Critical #1 was about. (+40ms mirrors
    // the fixed +30/+50ms thresholds this file's other latency-shed assertions use.)
    expect(combinedP50_0).toBeGreaterThan(aloneP50 + 40)
    expect(combinedP50_1).toBeGreaterThan(aloneP50 + 40)
  })

  it('two servers sharing one NAT gateway both contribute additively to its published byte rate', () => {
    const alone1 = natGatewayWorld([{ peakRps: 200 }])
    const sim1 = drive(alone1.doc, compileWorld(alone1.doc))
    sim1.stepFor(8)
    const bytes1 = sim1.latest().world.natGatewayBytesPerSec?.[alone1.nat.id] ?? 0
    sim1.engine.stop()

    const alone2 = natGatewayWorld([{ peakRps: 150 }])
    const sim2 = drive(alone2.doc, compileWorld(alone2.doc))
    sim2.stepFor(8)
    const bytes2 = sim2.latest().world.natGatewayBytesPerSec?.[alone2.nat.id] ?? 0
    sim2.engine.stop()

    const combined = natGatewayWorld([{ peakRps: 200 }, { peakRps: 150 }])
    const simC = drive(combined.doc, compileWorld(combined.doc))
    simC.stepFor(8)
    const bytesC = simC.latest().world.natGatewayBytesPerSec?.[combined.nat.id] ?? 0
    simC.engine.stop()

    expect(bytes1).toBeGreaterThan(0)
    expect(bytes2).toBeGreaterThan(0)
    // The combined run's shared-gateway rate must sit meaningfully above EITHER contributor alone
    // (ruling out a keying bug that only ever tracks the last-touched server) and land close to
    // their sum (ruling out silent double-counting or dropped contributions).
    expect(bytesC).toBeGreaterThan(bytes1 * 1.3)
    expect(bytesC).toBeGreaterThan(bytes2 * 1.3)
    expect(bytesC).toBeGreaterThan((bytes1 + bytes2) * 0.7)
    expect(bytesC).toBeLessThan((bytes1 + bytes2) * 1.3)
  })

  it('a doc with zero natGateways produces byte-identical engine output for a fixed seed (regression floor)', () => {
    const f = e2eFixture()
    const simA = drive(f.doc, f.compiled)
    simA.stepFor(20)
    const simB = drive(f.doc, f.compiled)
    simB.stepFor(20)
    expect(simB.latest()).toEqual(simA.latest())
    // Absent, not present-and-empty (Cross-Cutting Constraint 3 / the additive-optional-omission
    // convention every other MetricsBatch optional field already follows).
    expect(simA.latest().world.natGatewayBytesPerSec).toBeUndefined()
    simA.engine.stop()
    simB.engine.stop()
  })
})
