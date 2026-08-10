import { describe, it, expect } from 'vitest'
import { evaluateFirewall, isInternetSource, resolveRoute, evaluateSecurityGroups, evaluateInstancePath } from './network'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld } from './compileWorld'
import type { FirewallRule, PlacementRuntime, RouteTable as RouteTableT, SecurityGroup as SecurityGroupT } from './types'

const allowAll: FirewallRule = { id: 'r-allow', action: 'allow', port: 'any', protocol: 'any', source: 'internal' }
const denyDb: FirewallRule = { id: 'r-deny-db', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }

// audit ISSUE-011: the shared internet-open test — 'any' plus every /0 CIDR spelling.
describe('isInternetSource', () => {
  it('treats any, 0.0.0.0/0, ::/0 and any /0 prefix as internet-open', () => {
    expect(isInternetSource('any')).toBe(true)
    expect(isInternetSource('0.0.0.0/0')).toBe(true)
    expect(isInternetSource('::/0')).toBe(true)
    expect(isInternetSource('1.2.3.4/0')).toBe(true)   // prefix length 0 covers everything
  })

  it('is false for internal and genuinely-scoped CIDR ranges', () => {
    expect(isInternetSource('internal')).toBe(false)
    expect(isInternetSource('10.0.0.0/8')).toBe(false)
    expect(isInternetSource('192.168.1.0/24')).toBe(false)
    expect(isInternetSource('203.0.113.7/32')).toBe(false)
  })
})

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

  // Audit ISSUE-065: overlay networks (Swarm/CNI semantics) span SERVERS — co-networked
  // containers on different hosts communicate without publishing host ports, while plain
  // compose bridge networks stay per-host.
  it('permits cross-server container traffic over a shared overlay network without host publishing (ISSUE-065)', () => {
    const { doc, web, db } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const containerOn = (overlay: boolean): PlacementRuntime => ({
      type: 'container', stackName: 'app', networkNames: ['backend'],
      ...(overlay ? { overlayNetworkNames: ['mesh'] } : {}),
      portMappings: [], cpuLimit: null, memLimitMb: null,   // NOTHING published on the host
    })
    const plApi = { ...createPlacement(api.id, web.id), runtime: containerOn(true) }
    const plPg = { ...createPlacement(pg.id, db.id), runtime: containerOn(true) }
    Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })

    const compiled = compileWorld(doc)
    expect(compiled.paths).toHaveLength(1)
    // Permitted over the overlay; the hop keeps its REAL network class (the overlay removes the
    // publishing barrier, not the physical distance).
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'same-az' })

    // Same stack + same bridge network name but NO overlay: bridges are per-host — still blocked
    // without a host port mapping (the pre-ISSUE-065 behavior is preserved).
    plApi.runtime = containerOn(false)
    plPg.runtime = containerOn(false)
    const withoutOverlay = compileWorld(doc)
    expect(withoutOverlay.paths[0]).toMatchObject({ verdict: 'blocked' })
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

  it('a context with no fromSubnet/fromRouteTable skips the route check entirely (regression floor)', () => {
    const { doc, web, db } = twoServerWorld()
    const api = createBlueprint('api', 0)
    const pg = createBlueprint('pg', 1)
    pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
    Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
    const plApi = createPlacement(api.id, web.id)
    const plPg = createPlacement(pg.id, db.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })

    // Baseline: compileWorld (Task 6 hasn't wired fromSubnet/fromRouteTable through yet, so this
    // is byte-identical to the pre-feature behavior).
    const compiled = compileWorld(doc)
    expect(compiled.paths[0]).toMatchObject({ verdict: 'permitted', hopClass: 'same-az' })

    // Directly exercise evaluateInstancePath with a ctx that omits fromSubnet/fromRouteTable
    // (and securityGroups) — must produce the exact same verdict as an equivalent ctx that
    // never knew these fields existed.
    const ctx = {
      fromServer: web,
      toServer: db,
      fromRuntime: plApi.runtime,
      toRuntime: plPg.runtime,
      toBlueprint: pg,
      port: 5432,
      azs: doc.azs,
    }
    expect(evaluateInstancePath(ctx)).toEqual({ hopClass: 'same-az', verdict: 'permitted', blockReason: null })
  })
})

describe('resolveRoute', () => {
  const rt: RouteTableT = { id: 'rt-1', vpcId: 'vpc-1', routes: [] }

  it('returns the local target for same-VPC traffic with no explicit match needed', () => {
    expect(resolveRoute(rt, false)).toEqual({ kind: 'local' })
  })

  it('returns null when internet/cross-region traffic has no internetGateway/natGateway route', () => {
    expect(resolveRoute(rt, true)).toBeNull()
  })

  it('returns the natGateway target when a 0.0.0.0/0 route points at one', () => {
    const rtWithNat: RouteTableT = {
      id: 'rt-1',
      vpcId: 'vpc-1',
      routes: [{ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: 'nat-1' } }],
    }
    expect(resolveRoute(rtWithNat, true)).toEqual({ kind: 'natGateway', id: 'nat-1' })
  })
})

describe('evaluateSecurityGroups', () => {
  it('denies when no attached group has a matching allow rule (allow-only, implicit deny)', () => {
    const server = { securityGroupIds: ['sg-1'] } as any
    const groups: Record<string, SecurityGroupT> = {
      'sg-1': { id: 'sg-1', vpcId: 'vpc-1', label: 'sg', rules: [{ port: 443, protocol: 'tcp', source: 'any' }] },
    }
    expect(evaluateSecurityGroups(server, groups, 5432).allowed).toBe(false)
  })

  it('allows when any attached group has a matching rule — union semantics, not first-match', () => {
    const server = { securityGroupIds: ['sg-1', 'sg-2'] } as any
    const groups: Record<string, SecurityGroupT> = {
      'sg-1': { id: 'sg-1', vpcId: 'vpc-1', label: 'a', rules: [{ port: 443, protocol: 'tcp', source: 'any' }] },
      'sg-2': { id: 'sg-2', vpcId: 'vpc-1', label: 'b', rules: [{ port: 5432, protocol: 'tcp', source: 'internal' }] },
    }
    expect(evaluateSecurityGroups(server, groups, 5432).allowed).toBe(true)
  })

  it('a security group with a matching rule allows even where the equivalent flat firewall would need an explicit deny to differ from allow', () => {
    // demonstrates allow-only union vs ordered-list semantics — the whole point of this evaluator.
    const server = { securityGroupIds: ['sg-1'] } as any
    const groups: Record<string, SecurityGroupT> = { 'sg-1': { id: 'sg-1', vpcId: 'vpc-1', label: 'a', rules: [] } }
    expect(evaluateSecurityGroups(server, groups, 80).allowed).toBe(false) // empty group = implicit deny, no rule needed to express it
  })
})
