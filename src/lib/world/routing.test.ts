import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation, createLoadBalancer } from './factories'
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

  // audit ISSUE-009: the old formula added baseLatencyMs×10 — a distance-from-a-US-East-reference
  // constant — biasing every population toward low-baseLatency regions. Eastern Colorado sits
  // ~1746 km from us-west-1 but ~2120 km from us-east-1; the reference constant (68 vs 15 ⇒
  // +680 vs +150) flipped the order toward Virginia.
  it('latency policy ranks by true great-circle distance, not the US-East reference constant', () => {
    const doc = createWorld()
    const va = createRegion('us-east-1')
    const ca = createRegion('us-west-1')
    doc.regions[va.id] = va
    doc.regions[ca.id] = ca
    const pop = createPopulation('Eastern Colorado users', 38.5, -102)
    doc.populations[pop.id] = pop

    const { routing } = compileWorld(doc)
    expect(routing.populationRegionOrder[pop.id]).toEqual([ca.id, va.id])
  })

  // audit ISSUE-012 defense-in-depth: an unrecognized policy (e.g. from a corrupt file that
  // slipped the boundary) must fall back to geo ordering, never leave scores undefined.
  it('an unknown routing policy falls back to geo ordering', () => {
    const doc = createWorld()
    const sydney = createRegion('ap-southeast-2')   // inserted first — the winner if sort is a no-op
    const useast = createRegion('us-east-1')
    doc.regions[sydney.id] = sydney
    doc.regions[useast.id] = useast
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    doc.populations[nyc.id] = nyc
    doc.routing = { ...doc.routing, policy: 'nonsense' as never }

    const { routing } = compileWorld(doc)
    expect(routing.populationRegionOrder[nyc.id][0]).toBe(useast.id)
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

describe('lbRouting (regional load balancer compilation)', () => {
  function entryBlueprint(name: string, colorIndex: number) {
    const bp = createBlueprint(name, colorIndex)
    bp.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    return bp
  }

  it('synthesizes a default L4 cross-zone-off LB per region targeting entry blueprints', () => {
    const { doc, useast, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!)
    doc.servers[srv.id] = srv
    const web = entryBlueprint('web', 0)
    doc.blueprints[web.id] = web
    const pl = createPlacement(web.id, srv.id)
    doc.placements[pl.id] = pl

    const { routing } = compileWorld(doc)
    expect(routing.lbRouting[useast.id]).toEqual({
      mode: 'l4',
      crossZone: false,
      algorithm: 'round-robin',
      rules: [],
      defaultTargetBlueprintIds: [web.id],
      azWeights: {},
    })
  })

  it('excludes internal-only blueprints from default targets', () => {
    const { doc, useast, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!)
    doc.servers[srv.id] = srv
    const web = entryBlueprint('web', 0)          // public :443 — an entry
    const api = createBlueprint('api', 1)         // internal :8080 only — not an entry
    doc.blueprints[web.id] = web
    doc.blueprints[api.id] = api
    const plWeb = createPlacement(web.id, srv.id); doc.placements[plWeb.id] = plWeb
    const plApi = createPlacement(api.id, srv.id); doc.placements[plApi.id] = plApi

    const { routing } = compileWorld(doc)
    expect(routing.lbRouting[useast.id].defaultTargetBlueprintIds).toEqual([web.id])
  })

  it('an authored load balancer overrides the synthesized default', () => {
    const { doc, useast, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!)
    doc.servers[srv.id] = srv
    const web = entryBlueprint('web', 0)
    doc.blueprints[web.id] = web
    const plWeb = createPlacement(web.id, srv.id); doc.placements[plWeb.id] = plWeb
    const lb = createLoadBalancer(useast.id)
    lb.crossZone = true
    doc.loadBalancers[lb.id] = lb

    const { routing } = compileWorld(doc)
    expect(routing.lbRouting[useast.id].crossZone).toBe(true)
  })

  it('an L4 LB compiles no listener rules even if some are authored', () => {
    const { doc, useast, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!); doc.servers[srv.id] = srv
    const web = entryBlueprint('web', 0); doc.blueprints[web.id] = web
    const api = entryBlueprint('api', 1); doc.blueprints[api.id] = api
    doc.placements['p1'] = createPlacement(web.id, srv.id)
    doc.placements['p2'] = createPlacement(api.id, srv.id)
    const lb = createLoadBalancer(useast.id)   // mode 'l4' by default
    lb.listenerRules = [{ id: 'r1', pathPattern: '/api/*', targetBlueprintId: api.id }]
    doc.loadBalancers[lb.id] = lb

    const { routing } = compileWorld(doc)
    expect(routing.lbRouting[useast.id].rules).toEqual([])
  })

  it('an L7 LB compiles its listener rules verbatim, in authored order', () => {
    const { doc, useast, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!); doc.servers[srv.id] = srv
    const web = entryBlueprint('web', 0); doc.blueprints[web.id] = web
    const api = entryBlueprint('api', 1); doc.blueprints[api.id] = api
    doc.placements['p1'] = createPlacement(web.id, srv.id)
    doc.placements['p2'] = createPlacement(api.id, srv.id)
    const lb = createLoadBalancer(useast.id)
    lb.mode = 'l7'
    lb.listenerRules = [
      { id: 'r1', pathPattern: '/api/*', targetBlueprintId: api.id },
      { id: 'r2', pathPattern: '/*', targetBlueprintId: web.id },
    ]
    lb.defaultTargetBlueprintId = web.id
    doc.loadBalancers[lb.id] = lb

    const { routing } = compileWorld(doc)
    const compiled = routing.lbRouting[useast.id]
    expect(compiled.mode).toBe('l7')
    expect(compiled.rules).toEqual([
      { pathPattern: '/api/*', targetBlueprintId: api.id },
      { pathPattern: '/*', targetBlueprintId: web.id },
    ])
    expect(compiled.defaultTargetBlueprintIds).toEqual([web.id])
  })

  it('keeps an L7 rule whose target has no instance (accurate first-match; engine drops it)', () => {
    const { doc, useast, az1 } = geoWorld()
    const srv = createServer(az1.id, getPreset('vps-medium')!); doc.servers[srv.id] = srv
    const web = entryBlueprint('web', 0); doc.blueprints[web.id] = web
    const ghost = entryBlueprint('ghost', 1); doc.blueprints[ghost.id] = ghost   // declared, never placed
    doc.placements['p1'] = createPlacement(web.id, srv.id)
    const lb = createLoadBalancer(useast.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'r1', pathPattern: '/ghost/*', targetBlueprintId: ghost.id }]
    doc.loadBalancers[lb.id] = lb

    const { routing } = compileWorld(doc)
    expect(routing.lbRouting[useast.id].rules).toEqual([{ pathPattern: '/ghost/*', targetBlueprintId: ghost.id }])
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

// Audit ISSUE-021: computeRouting emits normalized regionProportions for the weighted policy.
describe('regionProportions (ISSUE-021)', () => {
  it('normalizes positive weights to a sum of 1 and omits zero-weight regions', async () => {
    const { createWorld, createRegion } = await import('./factories')
    const { computeRouting } = await import('./routing')
    const doc = createWorld()
    const a = createRegion('us-east-1'); const b = createRegion('eu-west-1'); const c = createRegion('ap-southeast-1')
    doc.regions[a.id] = a; doc.regions[b.id] = b; doc.regions[c.id] = c
    doc.routing.policy = 'weighted'
    doc.routing.weights = { [a.id]: 70, [b.id]: 30, [c.id]: 0 }
    const routing = computeRouting(doc, {})
    expect(routing.regionProportions).toEqual({ [a.id]: 0.7, [b.id]: 0.3 })
  })

  it('is undefined for all-zero weights and for non-weighted policies', async () => {
    const { createWorld, createRegion } = await import('./factories')
    const { computeRouting } = await import('./routing')
    const doc = createWorld()
    const a = createRegion('us-east-1'); doc.regions[a.id] = a
    doc.routing.policy = 'weighted'
    doc.routing.weights = {}
    expect(computeRouting(doc, {}).regionProportions).toBeUndefined()
    doc.routing.policy = 'geo'
    doc.routing.weights = { [a.id]: 50 }
    expect(computeRouting(doc, {}).regionProportions).toBeUndefined()
  })
})
