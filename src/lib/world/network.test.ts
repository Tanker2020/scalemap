import { describe, it, expect } from 'vitest'
import { evaluateFirewall } from './network'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld } from './compileWorld'
import type { FirewallRule, PlacementRuntime } from './types'

const allowAll: FirewallRule = { id: 'r-allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' }
const denyDb: FirewallRule = { id: 'r-deny-db', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }

describe('evaluateFirewall', () => {
  it('first matching rule wins, in array order', () => {
    expect(evaluateFirewall([denyDb, allowAll], 5432)).toEqual({ allowed: false, matchedRuleId: 'r-deny-db' })
    expect(evaluateFirewall([allowAll, denyDb], 5432)).toEqual({ allowed: true, matchedRuleId: 'r-allow' })
    expect(evaluateFirewall([denyDb, allowAll], 8080)).toEqual({ allowed: true, matchedRuleId: 'r-allow' })
  })

  it('default-denies when nothing matches', () => {
    expect(evaluateFirewall([], 443)).toEqual({ allowed: false, matchedRuleId: null })
    expect(evaluateFirewall([denyDb], 443)).toEqual({ allowed: false, matchedRuleId: null })
  })
})

// Two servers in one AZ + a third in another region, wired through a full compile.
function twoServerWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const region2 = createRegion('eu-west-1')
  const az = createAz(region.id, 'us-east-1a')
  const az2 = createAz(region.id, 'us-east-1b')
  const azEu = createAz(region2.id, 'eu-west-1a')
  const web = createServer(az.id, getPreset('vps-medium')!)
  const db = createServer(az.id, getPreset('dedicated-8')!)
  const dbB = createServer(az2.id, getPreset('dedicated-8')!)
  const dbEu = createServer(azEu.id, getPreset('dedicated-8')!)
  Object.assign(doc.regions, { [region.id]: region, [region2.id]: region2 })
  Object.assign(doc.azs, { [az.id]: az, [az2.id]: az2, [azEu.id]: azEu })
  Object.assign(doc.servers, { [web.id]: web, [db.id]: db, [dbB.id]: dbB, [dbEu.id]: dbEu })
  return { doc, region, az, az2, azEu, web, db, dbB, dbEu }
}

describe('evaluateInstancePath / compileWorld paths', () => {
  it('permits a cross-server path through an allow rule with same-az hop class', () => {
    const { doc, web, db } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const plApi = createPlacement(api.id, web.id)
    const plPg = createPlacement(pg.id, db.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })

    const compiled = compileWorld(doc)
    expect(compiled.paths).toHaveLength(1)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'same-az' })
    expect(compiled.findings).toHaveLength(0)
  })

  it('blocks with firewall-deny (and emits a finding) when the target denies the port', () => {
    const { doc, web, db } = twoServerWorld()
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
    expect(compiled.paths[0].verdict).toBe('blocked')
    expect(compiled.paths[0].blockReason).toMatchObject({ kind: 'firewall-deny', firewallRuleId: 'deny5432' })
    expect(compiled.findings.some(f => f.kind === 'blocked-path' && f.severity === 'error')).toBe(true)
  })

  it('blocks with no-port-binding when the blueprint never binds the port', () => {
    const { doc, web, db } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = []   // nothing bound
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, db.id), id: 'b' },
    })
    expect(compileWorld(doc).paths[0].blockReason?.kind).toBe('no-port-binding')
  })

  it('same-server loopback skips the firewall entirely', () => {
    const { doc, web } = twoServerWorld()
    web.firewall = []   // default deny everything — loopback must still pass
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, web.id), id: 'b' },
    })
    const compiled = compileWorld(doc)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'localhost' })
  })

  it('containers on the same server need a shared network — else network-isolation', () => {
    const { doc, web } = twoServerWorld()
    web.stacks = [{ name: 'app', networks: [{ name: 'front', cidr: '172.18.0.0/16' }, { name: 'back', cidr: '172.19.0.0/16' }], volumes: [] }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const mk = (_bp: string, nets: string[]): PlacementRuntime =>
      ({ type: 'container', stackName: 'app', networkNames: nets, portMappings: [], cpuLimit: null, memLimitMb: null })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a', runtime: mk(api.id, ['front']) },
      b: { ...createPlacement(pg.id, web.id), id: 'b', runtime: mk(pg.id, ['back']) },
    })
    expect(compileWorld(doc).paths[0].blockReason?.kind).toBe('network-isolation')

    // Now join both to 'back' → permitted via the shared bridge.
    ;(doc.placements['a'].runtime as Extract<PlacementRuntime, { type: 'container' }>).networkNames = ['front', 'back']
    expect(compileWorld(doc).paths[0].verdict).toBe('permitted')
  })

  it('cross-server container targets require a host port mapping, firewalled on the host port', () => {
    const { doc, web, db } = twoServerWorld()
    db.stacks = [{ name: 'data', networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }]
    db.firewall = [{ id: 'allow15432', action: 'allow', port: 15432, protocol: 'tcp', source: 'internal' }]
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const pgRuntime: PlacementRuntime = { type: 'container', stackName: 'data', networkNames: ['default'], portMappings: [{ host: 15432, container: 5432 }], cpuLimit: null, memLimitMb: null }
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, db.id), id: 'b', runtime: pgRuntime },
    })
    expect(compileWorld(doc).paths[0].verdict).toBe('permitted')

    // Remove the mapping → unreachable from off-host.
    ;(doc.placements['b'].runtime as Extract<PlacementRuntime, { type: 'container' }>).portMappings = []
    expect(compileWorld(doc).paths[0].blockReason?.kind).toBe('no-port-binding')
  })

  it('classifies cross-az and cross-region hops', () => {
    const { doc, web, dbB, dbEu } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    Object.assign(doc.placements, {
      a: { ...createPlacement(api.id, web.id), id: 'a' },
      b: { ...createPlacement(pg.id, dbB.id), id: 'b' },
      c: { ...createPlacement(pg.id, dbEu.id), id: 'c' },
    })
    const compiled = compileWorld(doc)
    const classes = compiled.paths.map(p => p.hopClass).sort()
    expect(classes).toEqual(['cross-az', 'cross-region'])
  })

  it('managed targets are always permitted, hop class from scope', () => {
    const { doc, az, web } = twoServerWorld()
    doc.managedServices['ms-1'] = { id: 'ms-1', label: 'RDS', nodeType: 'rds', scope: { kind: 'az', azId: az.id }, provider: 'aws', port: 5432 }
    const api = createBlueprint('api', 0)
    api.dependencies = [{ id: 'dep-1', target: { kind: 'managed', managedServiceId: 'ms-1' }, port: 5432, protocol: 'db', packetTemplateId: null }]
    doc.blueprints[api.id] = api
    doc.placements['a'] = { ...createPlacement(api.id, web.id), id: 'a' }
    const compiled = compileWorld(doc)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'same-az', to: { kind: 'managed', managedServiceId: 'ms-1' } })
  })
})
