import { describe, it, expect } from 'vitest'
import { solveFlows, BYTES_PER_REQUEST_EACH_WAY, MANAGED_SERVICE_LATENCY_MS } from './flows'
import type { FlowInput } from './flows'
import { pathKey } from './breakers'
import { createRng } from './rng'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import { managedDbRuntime } from '../managedDbRuntime'
import type { WorldDoc, BlueprintDependency } from '../world/types'
import type { HealthState } from './types'

// ─── Fixture helpers (real lib/world factories through a real compile) ────────

function dep(id: string, targetBpId: string): BlueprintDependency {
  return { id, target: { kind: 'blueprint', blueprintId: targetBpId }, port: 8080, protocol: 'http', packetTemplateId: null }
}

// One region, one AZ, one server; blueprints wired by the caller. Default factory
// blueprints bind port 8080 and the default firewall allows all internal traffic, so
// same-server paths compile permitted with hopClass 'localhost'.
function oneServerWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('dedicated-8')!)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  return { doc, region, az, server }
}

function addService(doc: WorldDoc, name: string, serverId: string, colorIndex = 0) {
  const bp = createBlueprint(name, colorIndex)
  doc.blueprints[bp.id] = bp
  const pl = createPlacement(bp.id, serverId)
  doc.placements[pl.id] = pl
  return { bp, pl, iid: instanceId(pl.id, 0) }
}

function baseInput(doc: WorldDoc, entryDemand: Record<string, number>, overrides: Partial<FlowInput> = {}): FlowInput {
  return {
    compiled: compileWorld(doc),
    doc,
    entryDemand,
    admittedScaleByServer: {},
    latencyMultiplierByServer: {},
    breakerOpen: () => false,
    healthOf: () => 'healthy',
    rng: createRng(11),
    ...overrides,
  }
}

describe('solveFlows — propagation', () => {
  it('propagates full rps down a linear chain (api -> svc -> db)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const svc = addService(doc, 'svc', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-svc', svc.bp.id)]
    svc.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[api.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0 })
    expect(flows[svc.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100 })
    expect(flows[db.iid]).toMatchObject({ offeredRps: 100, admittedRps: 100 })
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-svc', toInstanceId: svc.iid, rps: 100, hopClass: 'localhost', blocked: false },
    ])
    expect(flows[db.iid].downstream).toEqual([])
  })

  it('fans out the FULL admitted rps to every dependency (call-per-request model)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const cache = addService(doc, 'cache', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-cache', cache.bp.id), dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[cache.iid].offeredRps).toBe(100)   // duplicated, not split across deps
    expect(flows[db.iid].offeredRps).toBe(100)
    expect(flows[api.iid].downstream).toHaveLength(2)
  })

  it('splits one dependency\'s demand evenly across multiple target instances', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const bp = createBlueprint('svc', 1)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    doc.placements[pl.id] = pl
    api.bp.dependencies = [dep('d-svc', bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[instanceId(pl.id, 0)].offeredRps).toBe(50)
    expect(flows[instanceId(pl.id, 1)].offeredRps).toBe(50)
    const rows = flows[api.iid].downstream
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.rps).toBe(50)
  })

  it('applies the server admittedScale and books the shed demand as errorRps', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, {
      admittedScaleByServer: { [server.id]: 0.5 },
    }))
    expect(flows[api.iid].admittedRps).toBe(50)
    expect(flows[api.iid].errorRps).toBe(50)
    // downstream fans out the ADMITTED rps, then db admits 0.5 of ITS offered again
    expect(flows[api.iid].downstream[0].rps).toBe(50)
    expect(flows[db.iid].offeredRps).toBe(50)
    expect(flows[db.iid].admittedRps).toBe(25)
  })

  it('a degraded instance admits 0.7x of offered', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const healthOf = (id: string): HealthState => (id === api.iid ? 'degraded' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[api.iid].admittedRps).toBeCloseTo(70, 9)
    expect(flows[api.iid].errorRps).toBeCloseTo(30, 9)
  })

  it('a down instance zeroes its whole subtree', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const svc = addService(doc, 'svc', server.id, 1)
    const db = addService(doc, 'db', server.id, 2)
    api.bp.dependencies = [dep('d-svc', svc.bp.id)]
    svc.bp.dependencies = [dep('d-db', db.bp.id)]
    const healthOf = (id: string): HealthState => (id === svc.iid ? 'down' : 'healthy')

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[svc.iid]).toMatchObject({ offeredRps: 100, admittedRps: 0, errorRps: 100 })
    expect(flows[svc.iid].downstream).toEqual([])   // nothing fans out of a down instance
    expect(flows[db.iid]).toBeUndefined()           // subtree never reached
  })
})

describe('solveFlows — refusals', () => {
  it('blocked paths refuse at the CALLER, emit a blocked row, and never reach the target', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    // db as a separate server so the target firewall applies, then deny its port.
    const db2srv = createServer(doc.servers[server.id].azId, getPreset('dedicated-8')!)
    db2srv.firewall = [{ id: 'deny-all', action: 'deny', port: 'any', protocol: 'any', source: 'any' }]
    doc.servers[db2srv.id] = db2srv
    const db = addService(doc, 'db', db2srv.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const input = baseInput(doc, { [api.iid]: 100 })
    expect(input.compiled.paths[0].verdict).toBe('blocked')   // fixture sanity
    const { flows, totals } = solveFlows(input)
    expect(flows[api.iid].refusedRps).toBe(100)
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-db', toInstanceId: db.iid, rps: 100, hopClass: 'same-az', blocked: true },
    ])
    expect(flows[db.iid]).toBeUndefined()
    expect(totals.crossAzBytes).toBe(0)   // refused attempts carry no payload
  })

  it('an open breaker short-circuits the whole dependency: refused, NO downstream rows', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, {
      breakerOpen: key => key === pathKey(api.iid, 'd-db'),
    }))
    expect(flows[api.iid].refusedRps).toBe(100)
    expect(flows[api.iid].downstream).toEqual([])
    expect(flows[db.iid]).toBeUndefined()
  })
})

describe('solveFlows — depth, cycles, managed', () => {
  it('caps propagation at depth 8: the 9th hop lands, the 10th is never offered', () => {
    const { doc, server } = oneServerWorld()
    // Chain of 11 services: s0 -> s1 -> ... -> s10. Depths: s0=0 ... s10=10.
    const services = Array.from({ length: 11 }, (_, i) => addService(doc, `s${i}`, server.id, i))
    for (let i = 0; i < 10; i++) {
      services[i].bp.dependencies = [dep(`d-${i}`, services[i + 1].bp.id)]
    }
    const { flows } = solveFlows(baseInput(doc, { [services[0].iid]: 100 }))
    expect(flows[services[8].iid]).toMatchObject({ offeredRps: 100 })  // depth 8 still lands
    expect(flows[services[8].iid].downstream).toEqual([])              // but fans out no further
    expect(flows[services[9].iid]).toBeUndefined()
    expect(flows[services[10].iid]).toBeUndefined()
  })

  it('guards cycles: a -> b -> a terminates and never re-inflates the entry', () => {
    const { doc, server } = oneServerWorld()
    const a = addService(doc, 'a', server.id, 0)
    const b = addService(doc, 'b', server.id, 1)
    a.bp.dependencies = [dep('d-ab', b.bp.id)]
    b.bp.dependencies = [dep('d-ba', a.bp.id)]

    const { flows } = solveFlows(baseInput(doc, { [a.iid]: 100 }))
    expect(flows[a.iid].offeredRps).toBe(100)   // the back-edge did NOT re-offer demand
    expect(flows[b.iid].offeredRps).toBe(100)
    // the back-edge is still visible as a downstream row (particles/edges render it)
    expect(flows[b.iid].downstream).toEqual([
      { dependencyId: 'd-ba', toInstanceId: a.iid, rps: 100, hopClass: 'localhost', blocked: false },
    ])
  })

  it('managed targets get a downstream row, no flow record, and a fixed-latency export', () => {
    const { doc, server, az } = oneServerWorld()
    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'RDS', nodeType: 'rds',
      scope: { kind: 'az', azId: az.id }, provider: 'aws', port: 5432,
    }
    const api = addService(doc, 'api', server.id, 0)
    api.bp.dependencies = [{ id: 'd-ms', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null }]

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(flows[api.iid].downstream).toEqual([
      { dependencyId: 'd-ms', toManagedServiceId: 'ms-1', rps: 100, hopClass: 'same-az', blocked: false },
    ])
    expect(flows['ms-1']).toBeUndefined()
    expect(MANAGED_SERVICE_LATENCY_MS).toBe(3)
  })
})

describe('solveFlows — byte totals and latency', () => {
  it('buckets bytes by hopClass at 2KB per request both directions; entry demand is internet', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const region2 = createRegion('eu-west-1')
    const az1 = createAz(region.id, 'us-east-1a')
    const az2 = createAz(region.id, 'us-east-1b')
    const azEu = createAz(region2.id, 'eu-west-1a')
    Object.assign(doc.regions, { [region.id]: region, [region2.id]: region2 })
    Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2, [azEu.id]: azEu })
    const s1 = createServer(az1.id, getPreset('dedicated-8')!)
    const s2 = createServer(az2.id, getPreset('dedicated-8')!)
    const s3 = createServer(azEu.id, getPreset('dedicated-8')!)
    Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2, [s3.id]: s3 })

    const api = addService(doc, 'api', s1.id, 0)
    const svc = addService(doc, 'svc', s2.id, 1)     // cross-az from api
    const repl = addService(doc, 'repl', s3.id, 2)   // cross-region from api
    api.bp.dependencies = [dep('d-svc', svc.bp.id), dep('d-repl', repl.bp.id)]

    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    const perHop = 100 * BYTES_PER_REQUEST_EACH_WAY * 2   // rps x 2KB x both directions
    expect(totals.internetBytes).toBe(perHop)             // client -> entry
    expect(totals.crossAzBytes).toBe(perHop)
    expect(totals.crossRegionBytes).toBe(perHop)
  })

  it('same-az and localhost hops cost no bytes', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)   // same server: localhost
    api.bp.dependencies = [dep('d-db', db.bp.id)]
    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(totals.crossAzBytes).toBe(0)
    expect(totals.crossRegionBytes).toBe(0)
    expect(totals.internetBytes).toBe(100 * BYTES_PER_REQUEST_EACH_WAY * 2)
  })

  it('serviceLatencyMs scales with the server latency multiplier (same seed, 2x multiplier)', () => {
    const mkWorld = () => {
      const { doc, server } = oneServerWorld()
      const api = addService(doc, 'api', server.id, 0)
      return { doc, server, api }
    }
    const w1 = mkWorld()
    const base = solveFlows(baseInput(w1.doc, { [w1.api.iid]: 100 }, { rng: createRng(5) }))
    const w2 = mkWorld()
    const doubled = solveFlows(baseInput(w2.doc, { [w2.api.iid]: 100 }, {
      rng: createRng(5),
      latencyMultiplierByServer: { [w2.server.id]: 2 },
    }))
    const l1 = base.flows[w1.api.iid].serviceLatencyMs
    const l2 = doubled.flows[w2.api.iid].serviceLatencyMs
    expect(l1).toBeGreaterThan(0)
    expect(l2).toBeCloseTo(l1 * 2, 9)
  })
})

// ─── DB read/write routing (node-model Phase 3) ──────────────────────────────
// A DB cluster is one blueprint with a primary placement and replica placements. Writes route to
// the primary, reads to the replicas — driven by BlueprintDependency.writeFraction. These tests
// go through the REAL compile + solveFlows, complementing readWriteSplit.test.ts's unit coverage
// of the share math.
describe('solveFlows — DB read/write routing', () => {
  // Build an api that depends on a SQL DB cluster: 1 primary instance + `replicas` replica
  // instances (each its own placement on the shared server), with the given writeFraction.
  function apiToSqlCluster(writeFraction: number, replicas: number, engine: 'sql' | 'nosql' = 'sql') {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)

    const db = createBlueprint('db', 1)
    db.kind = engine === 'nosql' ? 'db-nosql' : 'db-sql'
    db.dbConfig = { engine, storageGb: 100 }
    doc.blueprints[db.id] = db

    const primaryPl = createPlacement(db.id, server.id)   // role 'primary' by default
    doc.placements[primaryPl.id] = primaryPl
    const primaryIid = instanceId(primaryPl.id, 0)

    const replicaIids: string[] = []
    for (let i = 0; i < replicas; i++) {
      const rp = createPlacement(db.id, server.id)
      rp.role = 'replica'
      doc.placements[rp.id] = rp
      replicaIids.push(instanceId(rp.id, 0))
    }

    api.bp.dependencies = [{ ...dep('d-db', db.id), writeFraction }]
    return { doc, api, primaryIid, replicaIids }
  }

  it('routes SQL writes to the primary and reads to the replica', () => {
    const { doc, api, primaryIid, replicaIids } = apiToSqlCluster(0.2, 1)
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 1000 }))
    // 200 writes → primary; 800 reads → the single replica.
    expect(flows[primaryIid].offeredRps).toBeCloseTo(200)
    expect(flows[replicaIids[0]].offeredRps).toBeCloseTo(800)
  })

  it('spreads reads across multiple SQL replicas while the primary takes only writes', () => {
    const { doc, api, primaryIid, replicaIids } = apiToSqlCluster(0.1, 2)
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 1000 }))
    expect(flows[primaryIid].offeredRps).toBeCloseTo(100)             // 10% writes
    expect(flows[replicaIids[0]].offeredRps).toBeCloseTo(450)         // 900 reads / 2
    expect(flows[replicaIids[1]].offeredRps).toBeCloseTo(450)
  })

  // The SQL single-writer ceiling: NoSQL spreads writes across every node, so the same cluster
  // puts LESS load on any one node than SQL does on its lone primary.
  it('spreads NoSQL writes across every node instead of concentrating on one', () => {
    const { doc, api, primaryIid, replicaIids } = apiToSqlCluster(0.5, 2, 'nosql')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 900 }))
    // Every node (primary + 2 replicas) gets an equal 300 total; no single write bottleneck.
    expect(flows[primaryIid].offeredRps).toBeCloseTo(300)
    expect(flows[replicaIids[0]].offeredRps).toBeCloseTo(300)
    expect(flows[replicaIids[1]].offeredRps).toBeCloseTo(300)
  })

  // A dependency with no writeFraction (undefined) on a DB target means pure reads — the primary
  // is spared entirely when replicas exist.
  it('treats an absent writeFraction as pure reads', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'; db.dbConfig = { engine: 'sql', storageGb: 100 }
    doc.blueprints[db.id] = db
    const primaryPl = createPlacement(db.id, server.id)
    doc.placements[primaryPl.id] = primaryPl
    const replicaPl = createPlacement(db.id, server.id); replicaPl.role = 'replica'
    doc.placements[replicaPl.id] = replicaPl
    api.bp.dependencies = [dep('d-db', db.id)]   // no writeFraction

    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 500 }))
    // A zero-traffic instance gets no flow record at all (as any idle instance does today),
    // so read it defensively — the point is the primary saw no load.
    expect(flows[instanceId(primaryPl.id, 0)]?.offeredRps ?? 0).toBeCloseTo(0)
    expect(flows[instanceId(replicaPl.id, 0)].offeredRps).toBeCloseTo(500)
  })
})

// ─── Health-aware internal fan-out (audit ISSUE-006) ─────────────────────────
// The entry tier (routingRuntime.distributeToTargets) already excludes down instances; internal
// service-to-service fan-out did not — a 3-replica group with one down replica kept sending 1/3
// of calls into the dead node (33% group error, forever). Shares are now weighted by target
// health: down ⇒ 0, degraded ⇒ ×0.7, renormalized over the survivors.
describe('solveFlows — health-aware dependency fan-out (audit ISSUE-006)', () => {
  // api → one service blueprint placed `count` times on the shared server.
  function apiToGroup(count: number) {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const bp = createBlueprint('svc', 1)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, server.id)
    pl.count = count
    doc.placements[pl.id] = pl
    api.bp.dependencies = [dep('d-svc', bp.id)]
    const iids = Array.from({ length: count }, (_, i) => instanceId(pl.id, i))
    return { doc, api, iids }
  }

  it('routes no traffic into a down target — the healthy targets absorb 100% and group errors stay ~0', () => {
    const { doc, api, iids } = apiToGroup(3)
    const healthOf = (id: string): HealthState => (id === iids[1] ? 'down' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 90 }, { healthOf }))
    expect(flows[iids[0]].offeredRps).toBeCloseTo(45)
    expect(flows[iids[2]].offeredRps).toBeCloseTo(45)
    expect(flows[iids[1]]).toBeUndefined()   // the dead node saw zero traffic
    const groupErrors = (flows[iids[0]]?.errorRps ?? 0) + (flows[iids[2]]?.errorRps ?? 0)
    expect(groupErrors).toBeCloseTo(0)
  })

  it('down-weights a degraded target by its admit factor and renormalizes', () => {
    const { doc, api, iids } = apiToGroup(2)
    const healthOf = (id: string): HealthState => (id === iids[1] ? 'degraded' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    expect(flows[iids[0]].offeredRps).toBeCloseTo(100 * (1 / 1.7))    // weight 1
    expect(flows[iids[1]].offeredRps).toBeCloseTo(100 * (0.7 / 1.7))  // weight 0.7
  })

  it('keeps the even split when ALL targets are down, so the attempts still fail live at the targets', () => {
    const { doc, api, iids } = apiToGroup(2)
    const healthOf = (id: string): HealthState => (iids.includes(id) ? 'down' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 100 }, { healthOf }))
    // Nothing to route around — the attempts land and error at the dead targets (this is the
    // 100%-error signal ISSUE-001's breaker feed needs to trip the caller's breaker).
    expect(flows[iids[0]]).toMatchObject({ offeredRps: 50, admittedRps: 0, errorRps: 50 })
    expect(flows[iids[1]]).toMatchObject({ offeredRps: 50, admittedRps: 0, errorRps: 50 })
  })

  it('spills SQL reads to the primary when EVERY replica is down (reads can always be served by a primary; writes never spill to replicas)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 100 }
    doc.blueprints[db.id] = db
    const primaryPl = createPlacement(db.id, server.id)
    doc.placements[primaryPl.id] = primaryPl
    const primaryIid = instanceId(primaryPl.id, 0)
    const replicaPl = createPlacement(db.id, server.id)
    replicaPl.role = 'replica'
    doc.placements[replicaPl.id] = replicaPl
    const replicaIid = instanceId(replicaPl.id, 0)
    api.bp.dependencies = [{ ...dep('d-db', db.id), writeFraction: 0.5 }]

    const healthOf = (id: string): HealthState => (id === replicaIid ? 'down' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 1000 }, { healthOf }))
    // The whole call volume (500 writes + 500 spilled reads) lands on the healthy primary.
    expect(flows[primaryIid].offeredRps).toBeCloseTo(1000)
    expect(flows[primaryIid].errorRps).toBeCloseTo(0)
    expect(flows[replicaIid]).toBeUndefined()
  })

  it('shifts SQL reads onto the surviving replicas when one replica is down', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = createBlueprint('db', 1)
    db.kind = 'db-sql'
    db.dbConfig = { engine: 'sql', storageGb: 100 }
    doc.blueprints[db.id] = db
    const primaryPl = createPlacement(db.id, server.id)
    doc.placements[primaryPl.id] = primaryPl
    const primaryIid = instanceId(primaryPl.id, 0)
    const replicaIids: string[] = []
    for (let i = 0; i < 2; i++) {
      const rp = createPlacement(db.id, server.id)
      rp.role = 'replica'
      doc.placements[rp.id] = rp
      replicaIids.push(instanceId(rp.id, 0))
    }
    api.bp.dependencies = [{ ...dep('d-db', db.id), writeFraction: 0.1 }]

    const healthOf = (id: string): HealthState => (id === replicaIids[0] ? 'down' : 'healthy')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 1000 }, { healthOf }))
    expect(flows[primaryIid].offeredRps).toBeCloseTo(100)      // writes untouched
    expect(flows[replicaIids[1]].offeredRps).toBeCloseTo(900)  // ALL reads on the survivor
    expect(flows[replicaIids[0]]).toBeUndefined()
  })
})

// ─── Cloud-managed DB write ceiling (node-model Phase 3) ─────────────────────
describe('solveFlows — cloud-managed DB ceiling', () => {
  // api → a managed SQL DB with a chosen instance class. Returns the api iid + the ms id.
  function apiToManagedDb(instanceClassId: string | null, writeFraction: number, over: Record<string, unknown> = {}) {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const msId = 'ms-db'
    doc.managedServices[msId] = {
      id: msId, label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'az', azId: Object.keys(doc.azs)[0] }, provider: 'aws', port: 5432,
      instanceClassId, ...over,
    }
    api.bp.dependencies = [{
      id: 'd-db', target: { kind: 'managed', managedServiceId: msId },
      port: 5432, protocol: 'db', packetTemplateId: null, writeFraction,
    }]
    return { doc, api, msId }
  }

  function managedRow(flow: { downstream: Array<{ toManagedServiceId?: string; rps: number; blocked: boolean }> }, msId: string, blocked: boolean) {
    return flow.downstream.filter(d => d.toManagedServiceId === msId && d.blocked === blocked).reduce((a, d) => a + d.rps, 0)
  }

  it('admits all traffic to a managed DB under its ceiling', () => {
    // sql.small writeRps 500. 300 writes (w=1) < 500 → nothing refused.
    const { doc, api, msId } = apiToManagedDb('sql.small', 1)
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 300 }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(0)
    expect(managedRow(flows[api.iid], msId, false)).toBeCloseTo(300)
  })

  it('throttles managed-DB writes above the class ceiling, refusing the excess on the caller', () => {
    // sql.small writeRps 500. 800 writes → 300 refused, 500 admitted.
    const { doc, api, msId } = apiToManagedDb('sql.small', 1)
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 800 }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(300)
    expect(managedRow(flows[api.iid], msId, false)).toBeCloseTo(500)   // admitted
    expect(managedRow(flows[api.iid], msId, true)).toBeCloseTo(300)    // throttled row
  })

  // Back-compat: a managed DB with no class chosen keeps the pre-Phase-3 always-admit behavior.
  it('leaves an unclassed managed DB uncapped', () => {
    const { doc, api, msId } = apiToManagedDb(null, 1)
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 99999 }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(0)
    expect(managedRow(flows[api.iid], msId, false)).toBeCloseTo(99999)
  })
})

describe('solveFlows — non-DB managed capacity (Phase 5.2)', () => {
  function apiToManaged(nodeType: string, over: Record<string, unknown> = {}) {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const msId = 'ms-q'
    doc.managedServices[msId] = {
      id: msId, label: 'q', nodeType,
      scope: { kind: 'az', azId: Object.keys(doc.azs)[0] }, provider: 'aws', port: 5672, ...over,
    }
    api.bp.dependencies = [{
      id: 'd-q', target: { kind: 'managed', managedServiceId: msId },
      port: 5672, protocol: 'event', packetTemplateId: null,
    }]
    return { doc, api, msId }
  }
  const row = (flow: { downstream: Array<{ toManagedServiceId?: string; rps: number; blocked: boolean }> }, msId: string, blocked: boolean) =>
    flow.downstream.filter(d => d.toManagedServiceId === msId && d.blocked === blocked).reduce((a, d) => a + d.rps, 0)

  it('refuses non-DB traffic above the per-type default ceiling (queue = 5000 rps)', () => {
    const { doc, api, msId } = apiToManaged('queue')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 8000 }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(3000)                  // 8000 − 5000
    expect(row(flows[api.iid], msId, false)).toBeCloseTo(5000)           // admitted at ceiling
    expect(row(flows[api.iid], msId, true)).toBeCloseTo(3000)            // throttled row
  })

  it('honors a per-service capacityRps override', () => {
    const { doc, api, msId } = apiToManaged('queue', { capacityRps: 1000 })
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 1500 }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(500)
    expect(row(flows[api.iid], msId, false)).toBeCloseTo(1000)
  })

  it('leaves a type with no default ceiling uncapped', () => {
    const { doc, api } = apiToManaged('someUnmappedType')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 999_999 }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(0)
  })

  it('refuses ALL traffic to a manually-downed managed service (Phase 5.2 outage)', () => {
    const { doc, api, msId } = apiToManaged('queue')
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 3000 }, { managedDown: (id) => id === msId }))
    expect(flows[api.iid].refusedRps).toBeCloseTo(3000)          // whole call volume fails
    expect(row(flows[api.iid], msId, true)).toBeCloseTo(3000)    // all on the blocked row
    expect(row(flows[api.iid], msId, false)).toBeCloseTo(0)      // nothing admitted
  })
})

// ─── Promotion overlay routing (node-model Phase 4) ──────────────────────────
// solveFlows accepts a roleOf override carrying the promotion overlay. These tests feed it
// directly (the resolver itself is unit-tested in failover.test.ts, and the end-to-end step
// wiring in index.test.ts) to prove writes follow the EFFECTIVE primary, not the compiled one.
describe('solveFlows — promotion overlay', () => {
  function apiToSqlCluster(writeFraction: number) {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = createBlueprint('db', 1); db.kind = 'db-sql'; db.dbConfig = { engine: 'sql', storageGb: 100 }
    doc.blueprints[db.id] = db
    const primaryPl = createPlacement(db.id, server.id)
    doc.placements[primaryPl.id] = primaryPl
    const replicaPl = createPlacement(db.id, server.id); replicaPl.role = 'replica'
    doc.placements[replicaPl.id] = replicaPl
    api.bp.dependencies = [{ ...dep('d-db', db.id), writeFraction }]
    return { doc, api, primaryIid: instanceId(primaryPl.id, 0), replicaIid: instanceId(replicaPl.id, 0) }
  }

  it('routes writes to the compiled primary with no overlay', () => {
    const { doc, api, primaryIid, replicaIid } = apiToSqlCluster(0.3)
    const { flows } = solveFlows(baseInput(doc, { [api.iid]: 1000 }))
    expect(flows[primaryIid].offeredRps).toBeCloseTo(300)   // 30% writes → compiled primary
    expect(flows[replicaIid].offeredRps).toBeCloseTo(700)
  })

  // With the overlay flipping roles (replica promoted, primary demoted), writes follow the NEW
  // primary — this is real failover, not an event.
  it('routes writes to the promoted replica once the overlay flips roles', () => {
    const { doc, api, primaryIid, replicaIid } = apiToSqlCluster(0.3)
    // Overlay: the replica is now the effective primary, the old primary demoted.
    const roleOf = (id: string) => id === replicaIid ? 'primary' as const : id === primaryIid ? 'replica' as const : 'primary' as const
    const { flows } = solveFlows({ ...baseInput(doc, { [api.iid]: 1000 }), roleOf })
    expect(flows[replicaIid].offeredRps).toBeCloseTo(300)   // writes now go to the promoted node
    expect(flows[primaryIid].offeredRps).toBeCloseTo(700)   // demoted node serves reads
  })
})

// ─── Aggregate managed-DB runtime (node-model Phase 5.4) ─────────────────────
// The per-caller ceiling path could not see total load: N callers each got N x the capacity.
// solveFlows now applies ONE aggregate refusal fraction computed by managedDbRuntime from the
// PREVIOUS step's flows (the same one-step lag as admittedScale).
describe('solveFlows — aggregate managed-DB runtime (Phase 5.4)', () => {
  function twoCallersToManagedDb(over: Record<string, unknown> = {}) {
    const { doc, server } = oneServerWorld()
    const a = addService(doc, 'api-a', server.id, 0)
    const b = addService(doc, 'api-b', server.id, 1)
    const msId = 'ms-db'
    doc.managedServices[msId] = {
      id: msId, label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'az', azId: Object.keys(doc.azs)[0] }, provider: 'aws', port: 5432,
      instanceClassId: 'sql.small', ...over,
    }
    const d = (id: string) => ({
      id, target: { kind: 'managed' as const, managedServiceId: msId },
      port: 5432, protocol: 'db' as const, packetTemplateId: null, writeFraction: 1,
    })
    a.bp.dependencies = [d('d-db')]
    b.bp.dependencies = [d('d-db')]
    return { doc, a, b, msId }
  }

  const rowOf = (flow: { downstream: Array<{ toManagedServiceId?: string; rps: number; blocked: boolean }> }, msId: string, blocked: boolean) =>
    flow.downstream.filter(d => d.toManagedServiceId === msId && d.blocked === blocked).reduce((a, d) => a + d.rps, 0)

  it('throttles two callers proportionally against the AGGREGATE ceiling', () => {
    // sql.small writeRps 500. Two callers x 400 rps = 800 aggregate. Neither exceeds 500 alone,
    // so the old per-caller path admitted all 800 — the bug this fixes.
    const { doc, a, b, msId } = twoCallersToManagedDb()
    const compiled = compileWorld(doc)
    const demand = { [a.iid]: 400, [b.iid]: 400 }

    const first = solveFlows(baseInput(doc, demand))
    expect(first.flows[a.iid].refusedRps).toBeCloseTo(0)   // step 1: no history yet

    const runtime = managedDbRuntime(first.flows, doc, compiled)
    expect(runtime[msId].totalRps).toBeCloseTo(800)
    expect(runtime[msId].refusalFraction).toBeCloseTo(300 / 800, 5)

    const { flows } = solveFlows(baseInput(doc, demand, { managedDbRuntime: runtime }))
    expect(flows[a.iid].refusedRps).toBeCloseTo(150)       // 400 x 0.375, proportional
    expect(flows[b.iid].refusedRps).toBeCloseTo(150)
    const admitted = rowOf(flows[a.iid], msId, false) + rowOf(flows[b.iid], msId, false)
    expect(admitted).toBeCloseTo(500)                       // the aggregate ceiling, at last
  })

  it('propagates query-timeout errors to the caller below the rps ceiling', () => {
    // 1900 rps of reads is only 76% of the 2500 read ceiling — nothing is throttled for
    // throughput — but a 10ms timeout still makes a share of calls fail.
    const { doc, a, msId } = twoCallersToManagedDb({ queryTimeoutMs: 10 })
    a.bp.dependencies[0].writeFraction = 0
    const compiled = compileWorld(doc)
    const demand = { [a.iid]: 1900 }

    const runtime = managedDbRuntime(solveFlows(baseInput(doc, demand)).flows, doc, compiled)
    expect(runtime[msId].ceilingRefusedRps).toBe(0)
    expect(runtime[msId].timeoutErrorFraction).toBeGreaterThan(0)

    const { flows } = solveFlows(baseInput(doc, demand, { managedDbRuntime: runtime }))
    expect(flows[a.iid].refusedRps).toBeGreaterThan(0)
    expect(rowOf(flows[a.iid], msId, true)).toBeGreaterThan(0)
    // Tagged so the metric can tell a timeout apart from a throughput throttle.
    expect(flows[a.iid].downstream.some(d => d.failure === 'timeout')).toBe(true)
  })

  it('propagates connection-ceiling refusal to the caller', () => {
    const { doc, a, msId } = twoCallersToManagedDb({ maxConnections: 2 })
    a.bp.dependencies[0].writeFraction = 0
    const compiled = compileWorld(doc)
    const demand = { [a.iid]: 2000 }

    const runtime = managedDbRuntime(solveFlows(baseInput(doc, demand)).flows, doc, compiled)
    expect(runtime[msId].connectionRefusedRps).toBeGreaterThan(0)

    const { flows } = solveFlows(baseInput(doc, demand, { managedDbRuntime: runtime }))
    expect(flows[a.iid].refusedRps).toBeGreaterThan(0)
    expect(rowOf(flows[a.iid], msId, false)).toBeLessThan(2000)
  })

  it('falls back to the per-caller ceiling when no runtime is supplied (back-compat)', () => {
    const { doc, a, msId } = twoCallersToManagedDb()
    const { flows } = solveFlows(baseInput(doc, { [a.iid]: 800 }))
    expect(flows[a.iid].refusedRps).toBeCloseTo(300)        // 800 − 500, exactly as before 5.4
    expect(rowOf(flows[a.iid], msId, false)).toBeCloseTo(500)
  })
})

// ─── Queue model (audit ISSUE-013 / -016 / -018) ──────────────────────────────
// Supplying serviceRateByInstance + queueDepth + stepSec activates the queueing path:
// served = min(capacity, arrivals + backlog); excess fills a bounded queue carried across
// ticks; ONLY overflow past the bound (capacity × MAX_QUEUE_SEC) errors.
describe('solveFlows — queue model (ISSUE-013)', () => {
  function queueWorld() {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    return { doc, server, api }
  }
  const STEP = 0.1

  function tick(doc: WorldDoc, iid: string, offered: number, capacity: number, queueDepth: Map<string, number>) {
    return solveFlows(baseInput(doc, offered > 0 ? { [iid]: offered } : {}, {
      serviceRateByInstance: { [iid]: capacity },
      queueDepth, stepSec: STEP,
    })).flows[iid]
  }

  it('constant overload converges: served pins at capacity, no oscillation (ISSUE-016)', () => {
    const { doc, api } = queueWorld()
    const qd = new Map<string, number>()
    const admitted: number[] = []
    for (let i = 0; i < 30; i++) admitted.push(tick(doc, api.iid, 200, 100, qd).admittedRps)
    // Every tick serves exactly the service rate — the old proportional shed flapped ~0.5×/1×.
    for (const a of admitted) expect(a).toBeCloseTo(100, 6)
  })

  it('queue builds to the bound, then overflow becomes the only error source', () => {
    const { doc, api } = queueWorld()
    const qd = new Map<string, number>()
    // capacity 100, offered 200 ⇒ +10 queued requests per 100ms tick; bound = 100 × 2s = 200.
    let f = tick(doc, api.iid, 200, 100, qd)
    expect(f.errorRps).toBeCloseTo(0, 6)                 // first tick: everything fits the queue
    for (let i = 0; i < 19; i++) f = tick(doc, api.iid, 200, 100, qd)
    expect(qd.get(api.iid)).toBeCloseTo(200, 6)          // bound reached after ~2s of overload
    f = tick(doc, api.iid, 200, 100, qd)
    expect(f.errorRps).toBeCloseTo(100, 6)               // past the bound: excess times out
  })

  it('latency rises with queue depth (Little\'s law wait term)', () => {
    const { doc, api } = queueWorld()
    const qd = new Map<string, number>()
    const first = tick(doc, api.iid, 200, 100, qd)
    for (let i = 0; i < 15; i++) tick(doc, api.iid, 200, 100, qd)
    const later = tick(doc, api.iid, 200, 100, qd)
    expect(later.serviceLatencyMs).toBeGreaterThan(first.serviceLatencyMs + 1000)   // ~1.6s of wait
  })

  it('removing the load drains the queue over several ticks, not instantly (ISSUE-013/014)', () => {
    const { doc, api } = queueWorld()
    const qd = new Map<string, number>()
    for (let i = 0; i < 10; i++) tick(doc, api.iid, 200, 100, qd)   // build ~100 queued requests
    const built = qd.get(api.iid)!
    expect(built).toBeCloseTo(100, 6)
    // Load drops to 50 rps: spare capacity 50 rps drains 5 requests per tick — NOT all at once.
    const f1 = tick(doc, api.iid, 50, 100, qd)
    expect(f1.admittedRps).toBeCloseTo(100, 6)           // still serving at full rate (drain)
    expect(qd.get(api.iid)!).toBeCloseTo(built - 5, 6)
    let ticks = 0
    while ((qd.get(api.iid) ?? 0) > 1e-9 && ticks < 100) { tick(doc, api.iid, 50, 100, qd); ticks++ }
    expect(ticks).toBeGreaterThan(5)                     // a drain CURVE, not a cliff
    const settled = tick(doc, api.iid, 50, 100, qd)
    expect(settled.admittedRps).toBeCloseTo(50, 6)       // steady state after the drain
  })

  it('an instance with zero arrivals still drains its backlog (and fans out the served work)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const db = addService(doc, 'db', server.id, 1)
    api.bp.dependencies = [dep('d-db', db.bp.id)]
    const qd = new Map<string, number>([[api.iid, 10]])
    const { flows } = solveFlows(baseInput(doc, {}, {
      serviceRateByInstance: { [api.iid]: 100, [db.iid]: 100 },
      queueDepth: qd, stepSec: STEP,
    }))
    expect(flows[api.iid].admittedRps).toBeCloseTo(100, 6)   // 10 requests / 0.1s = 100 rps of drain
    expect(qd.get(api.iid)).toBeCloseTo(0, 6)
    expect(flows[db.iid]?.offeredRps ?? 0).toBeGreaterThan(0)   // drained work still called the db
  })

  // Audit ISSUE-042 (verified subsumed by the queue model): the old proportional path errored
  // 30% of a degraded instance's offered load unconditionally — "errors" that fed the health
  // error-rate signal and could push a merely-degraded scope toward down. In queue mode a
  // degraded instance just has 0.7× capacity; under light load it serves EVERYTHING, so no
  // phantom error signal exists to spiral on.
  it('a degraded instance under light load reports zero errors, not 30% (ISSUE-042)', () => {
    const { doc, api } = queueWorld()
    const qd = new Map<string, number>()
    for (let i = 0; i < 10; i++) {
      const f = solveFlows(baseInput(doc, { [api.iid]: 50 }, {
        serviceRateByInstance: { [api.iid]: 100 },   // degraded ⇒ effective capacity 70 > 50 offered
        queueDepth: qd, stepSec: STEP,
        healthOf: () => 'degraded' as HealthState,
      })).flows[api.iid]
      expect(f.admittedRps).toBeCloseTo(50, 6)
      expect(f.errorRps).toBeCloseTo(0, 6)
    }
  })

  it('a down instance has zero capacity AND zero queue — its demand errors instantly', () => {
    const { doc, api } = queueWorld()
    const qd = new Map<string, number>([[api.iid, 50]])
    const f = solveFlows(baseInput(doc, { [api.iid]: 200 }, {
      serviceRateByInstance: { [api.iid]: 100 },
      queueDepth: qd, stepSec: STEP,
      healthOf: () => 'down' as HealthState,
    })).flows[api.iid]
    expect(f.admittedRps).toBe(0)
    // 200 rps of arrivals + the 50-request carried queue (500 rps equivalent) all fail.
    expect(f.errorRps).toBeCloseTo(200 + 50 / STEP, 6)
    expect(qd.get(api.iid)).toBeCloseTo(0, 6)
  })
})

// Packet-driven CPU (slice 2): effectiveCpuMsByInstance overrides the p50 latency seed
// (bp.workload.cpuMsPerRequest) per-instance, so a bigger blended ms/request samples a higher
// service latency. Optional and additive — absent must leave today's output unchanged.
describe('solveFlows — effectiveCpuMsByInstance (packet-driven CPU, slice 2)', () => {
  it('raises the sampled serviceLatencyMs p50 for the affected instance', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const base = solveFlows(baseInput(doc, { [api.iid]: 10 }, { rng: createRng(7) }))
    const boosted = solveFlows(baseInput(doc, { [api.iid]: 10 }, {
      rng: createRng(7),
      effectiveCpuMsByInstance: { [api.iid]: base.flows[api.iid].serviceLatencyMs * 5 },
    }))
    expect(boosted.flows[api.iid].serviceLatencyMs).toBeGreaterThan(base.flows[api.iid].serviceLatencyMs)
  })

  it('leaves output unchanged when the field is absent (back-compat)', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const a = solveFlows(baseInput(doc, { [api.iid]: 10 }, { rng: createRng(3) }))
    const b = solveFlows(baseInput(doc, { [api.iid]: 10 }, { rng: createRng(3) }))
    expect(a.flows[api.iid].serviceLatencyMs).toBe(b.flows[api.iid].serviceLatencyMs)
  })

  it('an instance with no entry in effectiveCpuMsByInstance falls back to cpuMsPerRequest', () => {
    const { doc, server } = oneServerWorld()
    const api = addService(doc, 'api', server.id, 0)
    const withMap = solveFlows(baseInput(doc, { [api.iid]: 10 }, {
      rng: createRng(9), effectiveCpuMsByInstance: {},
    }))
    const withoutMap = solveFlows(baseInput(doc, { [api.iid]: 10 }, { rng: createRng(9) }))
    expect(withMap.flows[api.iid].serviceLatencyMs).toBe(withoutMap.flows[api.iid].serviceLatencyMs)
  })
})

// ─── Packet-driven internal-hop bytes (packet library) ───────────────────────────────────────
// The old model booked `rps × 2048 × 2` for EVERY service→service call regardless of payload.
// `depBytesById` is the optional FlowInput that makes those bytes reflect what the edge carries;
// omitting it must reproduce the old constant exactly, which is the regression floor.
describe('depBytesById — packet-sized internal hops', () => {
  function crossAzWorld() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az1 = createAz(region.id, 'us-east-1a')
    const az2 = createAz(region.id, 'us-east-1b')
    Object.assign(doc.regions, { [region.id]: region })
    Object.assign(doc.azs, { [az1.id]: az1, [az2.id]: az2 })
    const s1 = createServer(az1.id, getPreset('dedicated-8')!)
    const s2 = createServer(az2.id, getPreset('dedicated-8')!)
    Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })
    const api = addService(doc, 'api', s1.id, 0)
    const blob = addService(doc, 'blob', s2.id, 1)
    api.bp.dependencies = [dep('d-blob', blob.bp.id)]
    return { doc, api }
  }

  it('omitting depBytesById reproduces the historical rps × 2 KB × 2', () => {
    const { doc, api } = crossAzWorld()
    const { totals } = solveFlows(baseInput(doc, { [api.iid]: 100 }))
    expect(totals.crossAzBytes).toBe(100 * BYTES_PER_REQUEST_EACH_WAY * 2)
  })

  it('a bound packet scales cross-AZ bytes by its actual payload size', () => {
    const { doc, api } = crossAzWorld()
    const { totals } = solveFlows({
      ...baseInput(doc, { [api.iid]: 100 }),
      depBytesById: {
        'd-blob': { reqBytes: 5 * 1024 * 1024, respBytes: 1024, sizeKb: 5120, sigma: 0, amplification: 1 },
      },
    })
    expect(totals.crossAzBytes).toBe(100 * (5 * 1024 * 1024 + 1024))
  })

  it('WAL amplification doubles only the WRITE share of the request leg', () => {
    const { doc, api } = crossAzWorld()
    const wire = { reqBytes: 1000, respBytes: 200, sizeKb: 1, sigma: 0, amplification: 2 }
    const run = (writeFraction: number) => solveFlows({
      ...baseInput(doc, { [api.iid]: 100 }),
      depBytesById: { 'd-blob': { ...wire, writeFraction } },
    }).totals.crossAzBytes

    expect(run(0)).toBe(100 * (1000 + 200))          // all reads — amplification is inert
    expect(run(1)).toBe(100 * (2000 + 200))          // all writes — request written twice
    expect(run(0.5)).toBe(100 * (1500 + 200))        // half and half
  })

  it('a dependency with no entry in the map keeps the flat fallback', () => {
    const { doc, api } = crossAzWorld()
    const { totals } = solveFlows({
      ...baseInput(doc, { [api.iid]: 100 }),
      depBytesById: { 'some-other-dep': { reqBytes: 9e6, respBytes: 9e6, sizeKb: 1, sigma: 0, amplification: 1 } },
    })
    expect(totals.crossAzBytes).toBe(100 * BYTES_PER_REQUEST_EACH_WAY * 2)
  })
})
