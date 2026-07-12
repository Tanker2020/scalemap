import { describe, it, expect } from 'vitest'
import { aggregateFlows, ledParams, serverAccents } from './floorData'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { CompiledWorld, PlacementRuntime, ServerId, WorldDoc } from '../../../lib/world/types'

// Mirrors network.test.ts's `twoServerWorld` fixture shape (compileWorld.test.ts / network.test.ts
// precedent) — 3 servers in one AZ + 1 in a second AZ, for cross-AZ-skip coverage.
function seedWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const az2 = createAz(region.id, 'us-east-1b')
  const web = createServer(az.id, getPreset('vps-medium')!)
  const db = createServer(az.id, getPreset('dedicated-8')!)
  const otherAzServer = createServer(az2.id, getPreset('vps-medium')!)
  Object.assign(doc.regions, { [region.id]: region })
  Object.assign(doc.azs, { [az.id]: az, [az2.id]: az2 })
  Object.assign(doc.servers, { [web.id]: web, [db.id]: db, [otherAzServer.id]: otherAzServer })
  return { doc, az, az2, web, db, otherAzServer }
}

describe('aggregateFlows', () => {
  it('sums a permitted edge total and reports zero blocked', () => {
    const { doc, az, web, db } = seedWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const plApi = createPlacement(api.id, web.id)
    const plPg = createPlacement(pg.id, db.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })

    const compiled = compileWorld(doc)
    const flows = aggregateFlows(compiled, az.id, new Set())
    expect(flows).toEqual([{ source: web.id, target: db.id, total: 1, blocked: 0, reason: null }])
  })

  it('carries the first block reason on a blocked edge', () => {
    const { doc, az, web, db } = seedWorld()
    db.firewall = [{ id: 'deny5432', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, db.id), id: 'b' },
    })

    const compiled = compileWorld(doc)
    const flows = aggregateFlows(compiled, az.id, new Set())
    expect(flows).toEqual([{ source: web.id, target: db.id, total: 1, blocked: 1, reason: 'firewall-deny' }])
  })

  it('produces NO edge for a same-server blocked path (network-isolation)', () => {
    const { doc, az, web } = seedWorld()
    web.stacks = [{ name: 'app', networks: [{ name: 'front', cidr: '172.18.0.0/16' }, { name: 'back', cidr: '172.19.0.0/16' }], volumes: [] }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const mk = (nets: string[]): PlacementRuntime =>
      ({ type: 'container', stackName: 'app', networkNames: nets, portMappings: [], cpuLimit: null, memLimitMb: null })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a', runtime: mk(['front']) },
      b: { ...createPlacement(pg.id, web.id), id: 'b', runtime: mk(['back']) },
    })

    const compiled = compileWorld(doc)
    // Sanity: compileWorld really did produce a blocked same-server path.
    expect(compiled.paths[0].blockReason?.kind).toBe('network-isolation')
    const flows = aggregateFlows(compiled, az.id, new Set())
    expect(flows).toEqual([])
  })

  it('skips a managed target outside managedHere and skips cross-AZ instance targets', () => {
    const { doc, az, az2, web, otherAzServer } = seedWorld()
    doc.managedServices['ms-1'] = { id: 'ms-1', label: 'RDS', nodeType: 'rds', scope: { kind: 'az', azId: az.id }, provider: 'aws', port: 5432 }
    const api = createBlueprint('api', 0)
    const cross = createBlueprint('cross', 1)
    api.dependencies = [
      { id: 'dep-ms', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null },
      { id: 'dep-cross', target: { kind: 'blueprint', blueprintId: cross.id }, port: 80, protocol: 'http', packetTemplateId: null },
    ]
    cross.ports = [{ port: 80, protocol: 'tcp', visibility: 'internal' }]
    Object.assign(doc.blueprints, { [api.id]: api, [cross.id]: cross })
    const plApi = createPlacement(api.id, web.id)
    const plCross = createPlacement(cross.id, otherAzServer.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plCross.id]: plCross })
    void az2

    const compiled = compileWorld(doc)
    // managedHere excludes ms-1 -> its permitted path is dropped; cross-AZ target dropped too.
    expect(aggregateFlows(compiled, az.id, new Set())).toEqual([])
    // Once ms-1 is declared in-scope, its path becomes a real edge.
    const flows = aggregateFlows(compiled, az.id, new Set(['ms-1']))
    expect(flows).toEqual([{ source: web.id, target: 'ms-1', total: 1, blocked: 0, reason: null }])
  })
})

describe('ledParams', () => {
  it('thresholds at 0.7/0.9', () => {
    expect(ledParams(0)).toEqual({ lit: 0, color: 'success' })
    expect(ledParams(0.7)).toEqual({ lit: 5, color: 'warning' })
    expect(ledParams(0.9)).toEqual({ lit: 6, color: 'danger' })
  })

  it('clamps lit between 0 and 6', () => {
    expect(ledParams(-1).lit).toBe(0)
    expect(ledParams(1).lit).toBe(6)
  })
})

// Polish 4 T3: `serverAccents` is a pure-function extraction of DatacenterFloor.tsx's pre-T3
// inline `accentsByServer` useMemo (verbatim body, just lifted out) — the `inlineAccentsByServer`
// helper below is that ORIGINAL inline derivation, copied byte-for-byte, kept here only to prove
// the extraction changed nothing observable.
function inlineAccentsByServer(doc: WorldDoc, compiled: CompiledWorld): Map<ServerId, string[]> {
  const m = new Map<ServerId, string[]>()
  for (const inst of Object.values(compiled.instances)) {
    const color = doc.blueprints[inst.blueprintId]?.color
    if (!color) continue
    const list = m.get(inst.serverId) ?? []
    if (!list.includes(color)) list.push(color)
    m.set(inst.serverId, list)
  }
  return m
}

describe('serverAccents', () => {
  it('collects each resident blueprint color once, in first-seen order', () => {
    const { doc, web } = seedWorld()
    const api = createBlueprint('api', 0)      // BLUEPRINT_COLORS[0]
    const cache = createBlueprint('cache', 1)  // BLUEPRINT_COLORS[1]
    Object.assign(doc.blueprints, { [api.id]: api, [cache.id]: cache })
    const plApi = createPlacement(api.id, web.id)
    const plCache = createPlacement(cache.id, web.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plCache.id]: plCache })

    const compiled = compileWorld(doc)
    const accents = serverAccents(doc, compiled)
    expect(accents.get(web.id)).toEqual([api.color, cache.color])
  })

  it('dedupes when two blueprints on the same server share a color index', () => {
    const { doc, web } = seedWorld()
    const api = createBlueprint('api', 0)
    const worker = createBlueprint('worker', 0)   // same colorIndex -> same color as `api`
    Object.assign(doc.blueprints, { [api.id]: api, [worker.id]: worker })
    const plApi = createPlacement(api.id, web.id)
    const plWorker = createPlacement(worker.id, web.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plWorker.id]: plWorker })

    const compiled = compileWorld(doc)
    expect(serverAccents(doc, compiled).get(web.id)).toEqual([api.color])
  })

  it('gives a server with no resident instances no map entry', () => {
    const { doc, db } = seedWorld()
    const compiled = compileWorld(doc)
    expect(serverAccents(doc, compiled).has(db.id)).toBe(false)
  })

  it('matches the prior inline derivation for a multi-server, multi-blueprint fixture', () => {
    const { doc, web, db } = seedWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 2)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const plApi = createPlacement(api.id, web.id)
    const plPg = createPlacement(pg.id, db.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })

    const compiled = compileWorld(doc)
    expect(serverAccents(doc, compiled)).toEqual(inlineAccentsByServer(doc, compiled))
  })
})
