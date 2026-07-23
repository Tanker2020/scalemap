// src/app/world/region/regionData.test.ts
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import {
  azShares, ribbonAlert, regionEvents, replicationPairs, crossAzEntries, sparklineSeries, dominantBlueprintColor,
  dotStreamParams, replicaRailPairs, regionManagedServices, regionAzManaged,
} from './regionData'
import type { MetricsBatch, EngineEvent, AzMetrics, RegionMetrics, ReplayFrame } from '../../../lib/worldEngine/types'
import type { WorldDoc } from '../../../lib/world/types'

function emptyWorldMetrics(): MetricsBatch['world'] {
  return { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 }
}
function fakeBatch(
  simMs: number, azs: Record<string, AzMetrics> = {}, regions: Record<string, RegionMetrics> = {}, world = emptyWorldMetrics(),
): MetricsBatch {
  return { simMs, instances: {}, servers: {}, azs, regions, world }
}
function az(over: Partial<AzMetrics>): AzMetrics {
  return { azId: '', rps: 0, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', serverCount: 0, instanceCount: 0, ...over }
}
function evt(over: Partial<EngineEvent>): EngineEvent {
  return { id: 'e', simMs: 0, kind: 'engine_degraded', severity: 'info', message: '', affected: [], ...over }
}

// Two-region fixture shared by the region-scoping tests (ribbonAlert, regionEvents, replicationPairs).
function tworegionWorld() {
  const doc = createWorld()
  const regionA = createRegion('us-east-1')
  const regionB = createRegion('eu-west-1')
  const azA = createAz(regionA.id, 'us-east-1a')
  const azB = createAz(regionA.id, 'us-east-1b')
  const azX = createAz(regionB.id, 'eu-west-1a')
  const serverA = createServer(azA.id, getPreset('vps-medium')!)
  const serverB = createServer(azB.id, getPreset('vps-medium')!)
  const serverX = createServer(azX.id, getPreset('vps-medium')!)
  doc.regions[regionA.id] = regionA; doc.regions[regionB.id] = regionB
  doc.azs[azA.id] = azA; doc.azs[azB.id] = azB; doc.azs[azX.id] = azX
  doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB; doc.servers[serverX.id] = serverX
  return { doc, regionA, regionB, azA, azB, azX, serverA, serverB, serverX }
}

describe('azShares', () => {
  it('splits the region ingress by throughput share; down AZs pinned to zero and excluded', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const azC = createAz(region.id, 'us-east-1c')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB; doc.azs[azC.id] = azC
    const batch = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, rps: 600, health: 'healthy' }),   // throughput (incl. internal)
      [azB.id]: az({ azId: azB.id, rps: 400, health: 'healthy' }),
      [azC.id]: az({ azId: azC.id, rps: 250, health: 'down' }),      // stale rps while down — pins to 0
    })
    // Region ingress = 500 (what the sources actually send in) — the shares distribute THIS, not
    // the 1000 of AZ throughput, so a.rps + b.rps === 500, never ~1000.
    batch.world.populationRoutes = [{ populationId: 'p', regionId: region.id, rps: 500 }]
    batch.world.totalRps = 500
    const shares = azShares(region.id, doc, batch)
    expect(shares).toHaveLength(3)
    const a = shares.find(s => s.azId === azA.id)!
    const b = shares.find(s => s.azId === azB.id)!
    const c = shares.find(s => s.azId === azC.id)!
    expect(a.fraction).toBeCloseTo(0.6, 5)
    expect(b.fraction).toBeCloseTo(0.4, 5)
    expect(a.rps).toBeCloseTo(300, 5)   // 0.6 × 500
    expect(b.rps).toBeCloseTo(200, 5)   // 0.4 × 500
    expect(a.rps + b.rps).toBeCloseTo(500, 5)   // sums to the region ingress, NOT 2× it
    expect(c.down).toBe(true)
    expect(c.fraction).toBe(0)
    expect(c.rps).toBe(0)
  })

  // Cross-zone-off forfeiture: one AZ serves, the peer AZ dropped its whole share. The split shows
  // BOTH — the served AZ's delivered share and the empty AZ's dropped share — summing to ingress.
  it('surfaces per-AZ dropped and splits ingress into delivered + dropped', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')   // serves
    const azB = createAz(region.id, 'us-east-1b')   // all dropped (no target here)
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    const batch = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, rps: 200, health: 'healthy' }),   // throughput (incl. internal)
      [azB.id]: az({ azId: azB.id, rps: 0, health: 'healthy' }),
    })
    // Region ingress 540; azB's ~270 was dropped (surfaced on its metric), azA delivered the rest.
    batch.azs[azB.id].droppedRps = 270
    batch.world.populationRoutes = [{ populationId: 'p', regionId: region.id, rps: 540 }]
    const shares = azShares(region.id, doc, batch)
    const a = shares.find(s => s.azId === azA.id)!
    const b = shares.find(s => s.azId === azB.id)!
    expect(a.dropped).toBe(0)
    expect(b.dropped).toBe(270)
    // deliveredIngress = 540 − 270 = 270, all attributed to azA (only AZ with throughput).
    expect(a.rps).toBeCloseTo(270, 5)
    // azB's routed inbound is entirely its dropped share.
    expect(b.rps).toBeCloseTo(270, 5)
    expect(a.rps + b.rps).toBeCloseTo(540, 5)   // still sums to the region ingress
  })

  it('handles null batch', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA
    const shares = azShares(region.id, doc, null)
    expect(shares).toEqual([{ azId: azA.id, fraction: 0, rps: 0, dropped: 0, down: false }])
  })
})

describe('ribbonAlert', () => {
  it('picks critical over newer warning', () => {
    const { doc, regionA, azA } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'w1', kind: 'health_check_failed', severity: 'warning', simMs: 9500, affected: [azA.id], message: 'az flaky' }),
      evt({ id: 'c1', kind: 'outage_triggered', severity: 'critical', simMs: 8000, affected: [azA.id], message: `${azA.label} unhealthy` }),
    ]
    const alert = ribbonAlert(regionA.id, doc, events, 10_000)
    expect(alert).not.toBeNull()
    expect(alert!.severity).toBe('critical')
    expect(alert!.simMs).toBe(8000)
  })

  it('appends redistribution targets for an az outage', () => {
    const { doc, regionA, azA, azB } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'c1', kind: 'outage_triggered', severity: 'critical', simMs: 8000, affected: [azB.id], message: `${azB.label} unhealthy` }),
    ]
    const alert = ribbonAlert(regionA.id, doc, events, 10_000)
    expect(alert).not.toBeNull()
    expect(alert!.message).toContain(azA.label)
    expect(alert!.message).toContain('redistributed to')
  })

  it('null when only info events', () => {
    const { doc, regionA, azA } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'i1', kind: 'instance_restarted', severity: 'info', simMs: 9000, affected: [azA.id] }),
    ]
    expect(ribbonAlert(regionA.id, doc, events, 10_000)).toBeNull()
  })

  it('appends the DNS-TTL note for an unresolved failover (additional coverage beyond the named minimum)', () => {
    const { doc, regionA, azA } = tworegionWorld()
    const events: EngineEvent[] = [
      evt({ id: 'w1', kind: 'health_check_failed', severity: 'warning', simMs: 8000, affected: [azA.id], message: 'unhealthy' }),
      evt({ id: 'f1', kind: 'failover_started', severity: 'warning', simMs: 8100, affected: [regionA.id], message: 'failing over' }),
    ]
    const alert = ribbonAlert(regionA.id, doc, events, 10_000)
    expect(alert!.message).toContain('DNS TTL')
  })
})

describe('regionEvents', () => {
  it('matches az, server, instance, and routed-population ids and excludes other regions', () => {
    const { doc, regionA, azA, serverA, azX, serverX } = tworegionWorld()
    const bp = createBlueprint('web', 0)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, serverA.id)
    doc.placements[pl.id] = pl
    const compiled = compileWorld(doc)
    const instId = Object.keys(compiled.instances)[0]

    const events: EngineEvent[] = [
      evt({ id: 'byRegion', affected: [regionA.id] }),
      evt({ id: 'byAz', affected: [azA.id] }),
      evt({ id: 'byServer', affected: [serverA.id] }),
      evt({ id: 'byInstance', affected: [instId] }),
      evt({ id: 'byPopulation', affected: ['pop-1'] }),
      evt({ id: 'otherRegionAz', affected: [azX.id] }),
      evt({ id: 'otherRegionServer', affected: [serverX.id] }),
    ]
    const batch = fakeBatch(1000, {}, {}, {
      ...emptyWorldMetrics(), populationRoutes: [{ populationId: 'pop-1', regionId: regionA.id, rps: 10 }],
    })
    const matched = regionEvents(regionA.id, doc, compiled, events, batch).map(e => e.id)
    expect(matched).toEqual(expect.arrayContaining(['byRegion', 'byAz', 'byServer', 'byInstance', 'byPopulation']))
    expect(matched).not.toContain('otherRegionAz')
    expect(matched).not.toContain('otherRegionServer')
    expect(matched).toHaveLength(5)
  })
})

describe('replicationPairs', () => {
  it('pairs primary and replica across azs and flags down links', () => {
    const { doc, regionA, azA, azB, serverA, serverB } = tworegionWorld()
    const db = createBlueprint('db', 2)
    db.stateful = true
    db.volumeName = 'data'
    doc.blueprints[db.id] = db
    const primary = createPlacement(db.id, serverB.id)   // primary in azB
    const replica = createPlacement(db.id, serverA.id)
    replica.role = 'replica'                              // replica in azA
    doc.placements[primary.id] = primary
    doc.placements[replica.id] = replica
    const compiled = compileWorld(doc)

    const batchHealthy = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, health: 'healthy' }),
      [azB.id]: az({ azId: azB.id, health: 'healthy' }),
    })
    const pairs = replicationPairs(regionA.id, doc, compiled, batchHealthy)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ blueprintId: db.id, blueprintName: 'db', fromAzId: azB.id, toAzId: azA.id, linkDown: false })

    const batchDown = fakeBatch(1000, {
      [azA.id]: az({ azId: azA.id, health: 'down' }),
      [azB.id]: az({ azId: azB.id, health: 'healthy' }),
    })
    expect(replicationPairs(regionA.id, doc, compiled, batchDown)[0].linkDown).toBe(true)
  })
})

describe('crossAzEntries', () => {
  it('derives pairs from cross-az paths and replication, deduped', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const azB = createAz(region.id, 'us-east-1b')
    const azC = createAz(region.id, 'us-east-1c')
    doc.regions[region.id] = region
    doc.azs[azA.id] = azA; doc.azs[azB.id] = azB; doc.azs[azC.id] = azC
    const serverA = createServer(azA.id, getPreset('vps-medium')!)
    const serverB = createServer(azB.id, getPreset('vps-medium')!)
    const serverC = createServer(azC.id, getPreset('vps-medium')!)
    doc.servers[serverA.id] = serverA; doc.servers[serverB.id] = serverB; doc.servers[serverC.id] = serverC

    const web = createBlueprint('web', 0)
    const db = createBlueprint('db', 2)
    const cache = createBlueprint('cache', 3)
    db.stateful = true
    db.volumeName = 'data'
    web.dependencies = [
      { id: 'dep-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 8080, protocol: 'http', packetTemplateId: null },
      { id: 'dep-cache', target: { kind: 'blueprint', blueprintId: cache.id }, port: 8080, protocol: 'http', packetTemplateId: null },
    ]
    doc.blueprints[web.id] = web; doc.blueprints[db.id] = db; doc.blueprints[cache.id] = cache

    const webPl = createPlacement(web.id, serverA.id)          // web primary @ azA
    const dbPrimary = createPlacement(db.id, serverB.id)       // db primary @ azB
    const dbReplicaOnA = createPlacement(db.id, serverA.id)
    dbReplicaOnA.role = 'replica'                               // db replica @ azA (same server as web)
    const cachePl = createPlacement(cache.id, serverC.id)       // cache primary @ azC
    doc.placements[webPl.id] = webPl
    doc.placements[dbPrimary.id] = dbPrimary
    doc.placements[dbReplicaOnA.id] = dbReplicaOnA
    doc.placements[cachePl.id] = cachePl

    const compiled = compileWorld(doc)
    // Sanity: web(azA) -> db-primary(azB) and web(azA) -> cache(azC) really compile to cross-az
    // paths (proves the fixture exercises the path-derived half of crossAzEntries, not just the
    // replication half).
    expect(compiled.paths.some(p => p.hopClass === 'cross-az')).toBe(true)

    const entries = crossAzEntries(region.id, doc, compiled, null)
    const key = (a: string, b: string) => [a, b].sort().join('::')
    const byPair = new Map(entries.map(e => [key(e.a, e.b), e]))

    // {A,B}: contributed by BOTH the compiled cross-az path (web->db-primary) AND the
    // replication pair (db primary@B / replica@A) — must collapse to exactly one entry.
    expect(byPair.has(key(azA.id, azB.id))).toBe(true)
    expect(byPair.get(key(azA.id, azB.id))!.replication).toHaveLength(1)
    // {A,C}: cross-az path only (web -> cache), no replication.
    expect(byPair.has(key(azA.id, azC.id))).toBe(true)
    expect(byPair.get(key(azA.id, azC.id))!.replication).toHaveLength(0)
    expect(entries).toHaveLength(2)
    expect(byPair.get(key(azA.id, azB.id))!.latencyMs).toBe(1.5)
  })
})

describe('sparklineSeries', () => {
  it('pads and orders oldest-first', () => {
    const regionId = 'r1'
    const frames: ReplayFrame[] = [1000, 2000, 3000].map((simMs, i) => ({
      simMs, events: [],
      batch: fakeBatch(simMs, {}, { [regionId]: { regionId, rps: (i + 1) * 10, errorRate: 0, p50Ms: 0, healthScore: 100, health: 'healthy', inboundByPopulation: [] } }),
    }))
    const series = sparklineSeries(frames, regionId, 5)
    expect(series).toEqual([0, 0, 10, 20, 30])
  })
})

describe('dotStreamParams', () => {
  it('maps rps quartiles to 1/2/3 dots and clamps the period', () => {
    expect(dotStreamParams(0, 1000)).toEqual({ dots: 1, periodSec: 3.0 })
    const low = dotStreamParams(200, 1000)
    expect(low.dots).toBe(1)
    expect(dotStreamParams(500, 1000)).toEqual({ dots: 2, periodSec: 2.1 })
    expect(dotStreamParams(1000, 1000)).toEqual({ dots: 3, periodSec: 1.2 })
  })

  it('treats a zero maxRps as ratio 0 (no division by zero)', () => {
    expect(dotStreamParams(50, 0)).toEqual({ dots: 1, periodSec: 3.0 })
  })
})

describe('replicaRailPairs', () => {
  it('pairs primary and replica across azs and ignores same-az pairs', () => {
    const { doc, regionA, azB, serverA, serverB } = tworegionWorld()
    const db = createBlueprint('db', 2)
    db.stateful = true
    db.volumeName = 'data'
    doc.blueprints[db.id] = db
    const primary = createPlacement(db.id, serverB.id)   // primary in azB
    const replica = createPlacement(db.id, serverA.id)
    replica.role = 'replica'                              // replica in azA — cross-AZ, should pair
    doc.placements[primary.id] = primary
    doc.placements[replica.id] = replica

    // A second replica placement on the SAME server as the primary (same AZ) — must be ignored.
    const sameAzServer = createServer(azB.id, getPreset('vps-medium')!)
    doc.servers[sameAzServer.id] = sameAzServer
    const sameAzReplica = createPlacement(db.id, sameAzServer.id)
    sameAzReplica.role = 'replica'
    doc.placements[sameAzReplica.id] = sameAzReplica

    const compiled = compileWorld(doc)
    const pairs = replicaRailPairs(doc, compiled, regionA.id)
    expect(pairs).toEqual([{ primaryServerId: serverB.id, replicaServerId: serverA.id, blueprintId: db.id }])
  })

  it('returns empty when there is no cross-az replica', () => {
    const { doc, regionA } = tworegionWorld()
    const compiled = compileWorld(doc)
    expect(replicaRailPairs(doc, compiled, regionA.id)).toEqual([])
  })
})

describe('dominantBlueprintColor', () => {
  it('picks the most-placed blueprint', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const azA = createAz(region.id, 'us-east-1a')
    const server = createServer(azA.id, getPreset('vps-medium')!)
    doc.regions[region.id] = region; doc.azs[azA.id] = azA; doc.servers[server.id] = server
    const minor = createBlueprint('cache', 0)
    const major = createBlueprint('web', 1)
    doc.blueprints[minor.id] = minor; doc.blueprints[major.id] = major
    const plMinor = createPlacement(minor.id, server.id)
    plMinor.count = 1
    const plMajor = createPlacement(major.id, server.id)
    plMajor.count = 3
    doc.placements[plMinor.id] = plMinor; doc.placements[plMajor.id] = plMajor

    const compiled = compileWorld(doc)
    expect(dominantBlueprintColor(server.id, doc, compiled)).toBe(major.color)
  })
})

describe('regionManagedServices', () => {
  function world() {
    const doc = createWorld()
    const rA = createRegion('us-east-1')
    const rB = createRegion('eu-west-1')
    const azA = createAz(rA.id, 'us-east-1a')
    const azX = createAz(rB.id, 'eu-west-1a')
    doc.regions[rA.id] = rA; doc.regions[rB.id] = rB
    doc.azs[azA.id] = azA; doc.azs[azX.id] = azX
    doc.managedServices['m-region'] = { id: 'm-region', label: 'SQL', nodeType: 'dbSql', scope: { kind: 'region', regionId: rA.id }, provider: 'aws', port: 5432 } as never
    doc.managedServices['m-az'] = { id: 'm-az', label: 'Redis', nodeType: 'redis', scope: { kind: 'az', azId: azA.id }, provider: 'aws', port: 6379 } as never
    doc.managedServices['m-other'] = { id: 'm-other', label: 'Queue', nodeType: 'queue', scope: { kind: 'az', azId: azX.id }, provider: 'aws', port: 5672 } as never
    return { doc, rA }
  }

  it('includes region-scoped + in-region az-scoped services, excludes other regions, sorted by label', () => {
    const { doc, rA } = world()
    const entries = regionManagedServices(rA.id, doc, null)
    expect(entries.map(e => e.id)).toEqual(['m-az', 'm-region'])   // 'Redis' < 'SQL'
    expect(entries.find(e => e.id === 'm-az')!.azLabel).toBe('us-east-1a')
    expect(entries.find(e => e.id === 'm-region')!.scope).toBe('region')
    expect(entries.every(e => e.rps === 0)).toBe(true)             // no batch → at-rest 0
  })

  it('reads live rps/refused/health from batch.managedServices', () => {
    const { doc, rA } = world()
    const batch = fakeBatch(1000)
    batch.managedServices = {
      'm-region': { managedServiceId: 'm-region', rps: 300, refusedRps: 40, utilization: 0.9, health: 'degraded', egressBytesPerSec: 0 },
    }
    const entries = regionManagedServices(rA.id, doc, batch)
    const sql = entries.find(e => e.id === 'm-region')!
    expect(sql.rps).toBe(300)
    expect(sql.refusedRps).toBe(40)
    expect(sql.health).toBe('degraded')
  })
})

describe('regionAzManaged', () => {
  // Phase 5.4 changed this deliberately: an AZ card now also lists the REGION-scoped services
  // (they serve every AZ, and the AZ floor has always drawn them). Other AZs' services stay out.
  it('returns this AZ\'s services plus the region-wide ones, with a non-DB capacity', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1')
    const azA = createAz(r.id, 'us-east-1a')
    const azB = createAz(r.id, 'us-east-1b')
    doc.regions[r.id] = r; doc.azs[azA.id] = azA; doc.azs[azB.id] = azB
    doc.managedServices['q-a'] = { id: 'q-a', label: 'Q', nodeType: 'queue', scope: { kind: 'az', azId: azA.id }, provider: 'aws', port: 5672 } as never
    doc.managedServices['q-b'] = { id: 'q-b', label: 'Q2', nodeType: 'queue', scope: { kind: 'az', azId: azB.id }, provider: 'aws', port: 5672 } as never
    doc.managedServices['r-wide'] = { id: 'r-wide', label: 'CDN', nodeType: 'cdn', scope: { kind: 'region', regionId: r.id }, provider: 'aws', port: 443 } as never
    const entries = regionAzManaged(azA.id, doc, null)
    expect(entries.map(e => e.id).sort()).toEqual(['q-a', 'r-wide'])   // az-B's service excluded
    expect(entries.find(e => e.id === 'q-a')!.capacityRps).toBe(5000)  // queue per-type default ceiling
    expect(entries.find(e => e.id === 'r-wide')!.scope).toBe('region')
  })
})

// node-model Phase 5.4: region-SCOPED managed services were missing from the AZ cards entirely —
// they only appeared in the region strip, so an AZ card and the AZ floor disagreed about what is
// in the AZ. They are region-wide, so they now appear in EVERY AZ card of that region, tagged.
describe('regionAzManaged — region-scoped services + runtime metrics (Phase 5.4)', () => {
  function world() {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az1 = createAz(region.id, 'us-east-1a')
    const az2 = createAz(region.id, 'us-east-1b')
    doc.regions[region.id] = region
    doc.azs[az1.id] = az1
    doc.azs[az2.id] = az2
    doc.managedServices['ms-az'] = {
      id: 'ms-az', label: 'az-cache', nodeType: 'redis', provider: 'aws',
      scope: { kind: 'az', azId: az1.id }, port: 6379,
    } as WorldDoc['managedServices'][string]
    doc.managedServices['ms-region'] = {
      id: 'ms-region', label: 'orders-db', nodeType: 'dbSql', provider: 'aws',
      scope: { kind: 'region', regionId: region.id }, port: 5432, instanceClassId: 'sql.small',
    } as WorldDoc['managedServices'][string]
    return { doc, region, az1, az2 }
  }

  it('includes region-scoped services in every AZ card of the region', () => {
    const { doc, az1, az2 } = world()
    expect(regionAzManaged(az1.id, doc, null).map(e => e.id).sort()).toEqual(['ms-az', 'ms-region'])
    expect(regionAzManaged(az2.id, doc, null).map(e => e.id)).toEqual(['ms-region'])
  })

  it('tags which entries are region-scoped so the card can mark them', () => {
    const { doc, az1 } = world()
    const byId = Object.fromEntries(regionAzManaged(az1.id, doc, null).map(e => [e.id, e]))
    expect(byId['ms-region'].scope).toBe('region')
    expect(byId['ms-az'].scope).toBe('az')
  })

  it('carries the Phase 5.4 DB gauges through to the card', () => {
    const { doc, az1 } = world()
    const batch = {
      simMs: 1000, instances: {}, servers: {}, azs: {}, regions: {},
      world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
      managedServices: {
        'ms-region': {
          managedServiceId: 'ms-region', rps: 900, refusedRps: 20, utilization: 0.4,
          health: 'degraded' as const, egressBytesPerSec: 0,
          saturation: 0.62, p50Ms: 7.9, p99Ms: 23.7, connections: 71, errorRps: 12,
        },
      },
    } as unknown as MetricsBatch
    const e = regionAzManaged(az1.id, doc, batch).find(x => x.id === 'ms-region')!
    expect(e.saturation).toBeCloseTo(0.62)
    expect(e.p50Ms).toBeCloseTo(7.9)
    expect(e.connections).toBe(71)
    expect(e.errorRps).toBe(12)
  })

  it('defaults the gauges to 0 for a service with no metrics', () => {
    const { doc, az1 } = world()
    const e = regionAzManaged(az1.id, doc, null).find(x => x.id === 'ms-az')!
    expect(e.saturation).toBe(0)
    expect(e.p50Ms).toBe(0)
    expect(e.connections).toBe(0)
    expect(e.errorRps).toBe(0)
  })
})
