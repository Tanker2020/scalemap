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
