import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld, instanceId } from './compileWorld'
import { volumeFindings } from './routing'

function geoWorld() {
  const doc = createWorld()
  const useast = createRegion('us-east-1')
  const euwest = createRegion('eu-west-1')
  const sydney = createRegion('ap-southeast-2')
  for (const r of [useast, euwest, sydney]) doc.regions[r.id] = r
  const az1 = createAz(useast.id, 'us-east-1a')
  const az2 = createAz(useast.id, 'us-east-1b')
  const azEu = createAz(euwest.id, 'eu-west-1a')
  const azAp = createAz(sydney.id, 'ap-southeast-2a')
  for (const a of [az1, az2, azEu, azAp]) doc.azs[a.id] = a
  return { doc, useast, euwest, sydney, az1, az2, azEu, azAp }
}

describe('computeRouting (via compileWorld)', () => {
  it('latency policy orders regions by proximity to each population', () => {
    const { doc, useast, euwest, sydney } = geoWorld()
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    const berlin = createPopulation('Berlin users', 52.5, 13.4)
    doc.populations[nyc.id] = nyc
    doc.populations[berlin.id] = berlin

    const { routing } = compileWorld(doc)
    expect(routing.populationRegionOrder[nyc.id][0]).toBe(useast.id)
    expect(routing.populationRegionOrder[nyc.id][2]).toBe(sydney.id)
    expect(routing.populationRegionOrder[berlin.id][0]).toBe(euwest.id)
  })

  it('passive regions always sort last regardless of proximity', () => {
    const { doc, useast, euwest } = geoWorld()
    doc.regions[useast.id] = { ...useast, role: 'passive' }
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    doc.populations[nyc.id] = nyc
    const { routing } = compileWorld(doc)
    const order = routing.populationRegionOrder[nyc.id]
    expect(order[order.length - 1]).toBe(useast.id)
    expect(order[0]).toBe(euwest.id)
  })

  it('priority policy follows priorityOrder, weighted follows weights desc', () => {
    const { doc, useast, euwest, sydney } = geoWorld()
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    doc.populations[nyc.id] = nyc

    doc.routing = { ...doc.routing, policy: 'priority', priorityOrder: [sydney.id, euwest.id, useast.id] }
    expect(compileWorld(doc).routing.populationRegionOrder[nyc.id][0]).toBe(sydney.id)

    doc.routing = { ...doc.routing, policy: 'weighted', weights: { [euwest.id]: 100, [useast.id]: 10, [sydney.id]: 1 } }
    expect(compileWorld(doc).routing.populationRegionOrder[nyc.id]).toEqual([euwest.id, useast.id, sydney.id])
  })

  it('builds regionAzSpread (sorted by label) and azBlueprintTargets', () => {
    const { doc, useast, az1, az2 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!)
    doc.servers[srv.id] = srv
    const bp = createBlueprint('api', 0)
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, srv.id)
    pl.count = 2
    doc.placements[pl.id] = pl

    const { routing } = compileWorld(doc)
    expect(routing.regionAzSpread[useast.id]).toEqual([az1.id, az2.id])
    expect(routing.azBlueprintTargets[az1.id][bp.id]).toEqual([instanceId(pl.id, 0), instanceId(pl.id, 1)])
  })
})

describe('volumeFindings', () => {
  it('warns on stateful blueprint without a volume name', () => {
    const { doc, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('dedicated-8')!)
    doc.servers[srv.id] = srv
    const bp = createBlueprint('pg', 1)
    bp.stateful = true // volumeName left null
    doc.blueprints[bp.id] = bp
    const findings = volumeFindings(doc)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'stateful-without-volume', severity: 'warning', affected: [bp.id] })
  })

  it('errors when a container placement of a stateful blueprint lacks the volume in its stack', () => {
    const { doc, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('dedicated-8')!)
    srv.stacks = [{ name: 'data', networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }] // no volumes!
    doc.servers[srv.id] = srv
    const bp = createBlueprint('pg', 1)
    bp.stateful = true
    bp.volumeName = 'pgdata'
    doc.blueprints[bp.id] = bp
    const pl = createPlacement(bp.id, srv.id)
    pl.runtime = { type: 'container', stackName: 'data', networkNames: ['default'], portMappings: [], cpuLimit: null, memLimitMb: null }
    doc.placements[pl.id] = pl

    const findings = volumeFindings(doc)
    expect(findings.some(f => f.kind === 'missing-volume' && f.severity === 'error')).toBe(true)

    // Add the volume → clean.
    srv.stacks[0].volumes = [{ name: 'pgdata', sizeGb: 20 }]
    expect(volumeFindings(doc)).toHaveLength(0)
  })
})
