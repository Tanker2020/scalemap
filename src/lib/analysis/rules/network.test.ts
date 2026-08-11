import { describe, it, expect } from 'vitest'
import { scenario, dep } from '../__fixtures__/worlds'
import { runAnalysis } from '../runAnalysis'
import {
  createLoadBalancer, createVpc, createSubnet, createRouteTable, createNatGateway, createSecurityGroup,
} from '../../world/factories'
import { addRoute, routeIdOf } from '../../nodeConfig'
import type { AnalysisFinding } from '../types'
import type { FirewallRule } from '../../world/types'

const ids = (fs: AnalysisFinding[], ruleId: string) => fs.filter(f => f.ruleId === ruleId)
const run = (s: ReturnType<typeof scenario>) => runAnalysis(s.doc, s.compile(), null)
const allowAny = (port: number): FirewallRule => ({ id: `fw-open-${port}`, action: 'allow', port, protocol: 'tcp', source: 'any' })
const allowFrom = (port: number, source: string): FirewallRule => ({ id: `fw-open-${port}`, action: 'allow', port, protocol: 'tcp', source })

describe('network: blocked-dependency-path', () => {
  it('fires for a firewall-denied cross-server path and names the rule in the fix', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    // web (process) → db (process on s2) over port 5432, but s2's firewall denies 5432.
    s2.firewall = [{ id: 'deny-5432', action: 'deny', port: 5432, protocol: 'tcp', source: 'internal' }, ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'blocked-dependency-path')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].id.startsWith('blocked-dependency-path:')).toBe(true)
    expect(f[0].fix).toMatch(/firewall/i)
  })
  it('silent when the path is permitted', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const api = s.blueprint('api', 1)
    api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-api', api.id, 'http', 8080)]
    s.placement(web.id, s1.id); s.placement(api.id, s1.id) // localhost → permitted
    expect(ids(run(s), 'blocked-dependency-path')).toHaveLength(0)
  })
})

describe('network: db-port-exposed', () => {
  it('fires when a db target server allows the port from any source', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowAny(5432), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(s2.id)
  })
  // Audit ISSUE-068: sub-rule (b) is placement-gated — an UNPLACED blueprint with a public db
  // port is a design sketch, not a live "critical" exposure; placing it makes it one.
  it('stays silent for an unplaced public-port db blueprint until it is placed (ISSUE-068)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id)   // db NOT placed anywhere
    expect(ids(run(s), 'db-port-exposed').some(x => x.affected[0] === db.id)).toBe(false)
    s.placement(db.id, s1.id)    // now it's live
    expect(ids(run(s), 'db-port-exposed').some(x => x.affected[0] === db.id)).toBe(true)
  })
  it('fires via public visibility even without a firewall hole', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }] // public db port
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s1.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.some(x => x.affected[0] === db.id)).toBe(true)
  })
  // audit ISSUE-011: '0.0.0.0/0' (and '::/0') IS the entire internet — a valid CIDR
  // FirewallSource that must be treated exactly like the literal 'any'.
  it('fires when a db target server allows the port from 0.0.0.0/0', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowFrom(5432, '0.0.0.0/0'), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    const f = ids(run(s), 'db-port-exposed')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(s2.id)
  })
  it('fires for the IPv6 ::/0 form as well', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)
    s2.firewall = [allowFrom(5432, '::/0'), ...s2.firewall]
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)
    expect(ids(run(s), 'db-port-exposed').length).toBeGreaterThanOrEqual(1)
  })
  it('silent for a db target behind the default internal firewall', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s1.id)
    expect(ids(run(s), 'db-port-exposed')).toHaveLength(0)
  })

  // Final review Important #5: an SG-governed server (subnetId set + securityGroupIds non-empty)
  // is evaluated via its attached groups' rules at compile/engine time, never server.firewall —
  // db-port-exposed must ask the same question or it silently misses the real exposure.
  it('fires for an SG-governed server with an internet-open security-group rule (previously a false negative)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)

    const vpc = createVpc(r.id)
    const routeTable = createRouteTable(vpc.id)
    const subnet = createSubnet(vpc.id, az.id, 'private', routeTable.id)
    const sg = createSecurityGroup(vpc.id, 'open-sg')
    sg.rules = [{ port: 5432, protocol: 'tcp', source: 'any' }]
    s2.subnetId = subnet.id
    s2.securityGroupIds = [sg.id]
    s.doc.vpcs[vpc.id] = vpc
    s.doc.routeTables[routeTable.id] = routeTable
    s.doc.subnets[subnet.id] = subnet
    s.doc.securityGroups[sg.id] = sg

    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)

    const f = ids(run(s), 'db-port-exposed')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(s2.id)
    expect(f[0].fix).toMatch(/security group/i)
  })

  it('does NOT fire from a leftover permissive firewall rule on an SG-governed server whose attached group is closed (previously a false positive)', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); const s2 = s.server(az.id)

    const vpc = createVpc(r.id)
    const routeTable = createRouteTable(vpc.id)
    const subnet = createSubnet(vpc.id, az.id, 'private', routeTable.id)
    const sg = createSecurityGroup(vpc.id, 'closed-sg')
    sg.rules = [{ port: 5432, protocol: 'tcp', source: 'internal' }]   // NOT internet-open
    s2.subnetId = subnet.id
    s2.securityGroupIds = [sg.id]
    // A leftover permissive legacy rule — inert now that the SG governs, must NOT be read.
    s2.firewall = [allowAny(5432), ...s2.firewall]
    s.doc.vpcs[vpc.id] = vpc
    s.doc.routeTables[routeTable.id] = routeTable
    s.doc.subnets[subnet.id] = subnet
    s.doc.securityGroups[sg.id] = sg

    const web = s.blueprint('web', 0); const db = s.blueprint('db', 1)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-db', db.id, 'db', 5432)]
    s.placement(web.id, s1.id); s.placement(db.id, s2.id)

    expect(ids(run(s), 'db-port-exposed')).toHaveLength(0)
  })
})

describe('network: entry-unreachable', () => {
  it('fires for a public port with no hosting server allowing it from any', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id) // default firewall: source 'internal', not 'any'
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const f = ids(run(s), 'entry-unreachable')
    expect(f).toHaveLength(1)
    expect(f[0].affected[0]).toBe(web.id)
  })
  it('silent once a hosting server allows the port from any', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); s1.firewall = [allowAny(443), ...s1.firewall]
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    expect(ids(run(s), 'entry-unreachable')).toHaveLength(0)
  })
  // audit ISSUE-011: a public port reachable via 0.0.0.0/0 is reachable — no false positive.
  it('silent when a hosting server allows the port from 0.0.0.0/0', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id); s1.firewall = [allowFrom(443, '0.0.0.0/0'), ...s1.firewall]
    const web = s.blueprint('web', 0)
    web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    expect(ids(run(s), 'entry-unreachable')).toHaveLength(0)
  })
})

describe('network: lb-listener-target-absent', () => {
  it('fires when an L7 listener rule points at a service with no instance in the region', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const api = s.blueprint('api', 0); api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    const ghost = s.blueprint('ghost', 1); ghost.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(api.id, s1.id)   // ghost intentionally NOT placed
    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'rg', pathPattern: '/ghost/*', targetBlueprintId: ghost.id }]
    s.doc.loadBalancers[lb.id] = lb
    const f = ids(run(s), 'lb-listener-target-absent')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toContain(ghost.id)
    expect(f[0].why).toMatch(/ghost/i)
  })

  it('silent when the rule target is present, or the LB is L4', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const api = s.blueprint('api', 0); api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(api.id, s1.id)
    const lb = createLoadBalancer(r.id)   // L4 with an authored rule → no L7 semantics, no finding
    lb.listenerRules = [{ id: 'ra', pathPattern: '/api/*', targetBlueprintId: api.id }]
    s.doc.loadBalancers[lb.id] = lb
    expect(ids(run(s), 'lb-listener-target-absent')).toHaveLength(0)
  })
})

describe('network: lb-route-dropped', () => {
  it('fires for a request-mix route matching no listener rule with no default action', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const added = addRoute(s.doc.packets, { name: 'health', method: 'GET', path: '/health/live' })
    s.doc.packets = added.registry
    const pop = s.population('nyc', 40.7, -74.0)
    pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'ra', pathPattern: '/api/*', targetBlueprintId: web.id }]
    lb.defaultTargetBlueprintId = 'bp-absent'   // default resolves to no in-region instance ⇒ empty
    s.doc.loadBalancers[lb.id] = lb
    const f = ids(run(s), 'lb-route-dropped')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toContain(pop.id)
    expect(f[0].why).toMatch(/health/i)
  })

  it('silent when a default action exists to catch the unmatched route', () => {
    const s = scenario()
    const r = s.region('us-east-1'); const az = s.az(r.id, 'us-east-1a')
    const s1 = s.server(az.id)
    const web = s.blueprint('web', 0); web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
    s.placement(web.id, s1.id)
    const added = addRoute(s.doc.packets, { name: 'health', method: 'GET', path: '/health/live' })
    s.doc.packets = added.registry
    const pop = s.population('nyc', 40.7, -74.0)
    pop.requestMix = [{ routeId: routeIdOf(added.route), weight: 1 }]
    const lb = createLoadBalancer(r.id)
    lb.mode = 'l7'
    lb.listenerRules = [{ id: 'ra', pathPattern: '/api/*', targetBlueprintId: web.id }]
    // defaultTargetBlueprintId null ⇒ default = present entry blueprints (web) ⇒ non-empty
    s.doc.loadBalancers[lb.id] = lb
    expect(ids(run(s), 'lb-route-dropped')).toHaveLength(0)
  })
})

describe('network: no-egress-route', () => {
  it('fires when a private-subnet server has no NAT/IGW route for a cross-region dependency', () => {
    const s = scenario()
    const rA = s.region('us-east-1'); const azA = s.az(rA.id, 'us-east-1a')
    const rB = s.region('eu-west-1'); const azB = s.az(rB.id, 'eu-west-1a')
    const s1 = s.server(azA.id); const s2 = s.server(azB.id)

    const vpc = createVpc(rA.id)
    const routeTable = createRouteTable(vpc.id) // no routes -> no egress
    const subnet = createSubnet(vpc.id, azA.id, 'private', routeTable.id)
    s1.subnetId = subnet.id
    s.doc.vpcs[vpc.id] = vpc
    s.doc.routeTables[routeTable.id] = routeTable
    s.doc.subnets[subnet.id] = subnet

    const web = s.blueprint('web', 0); const api = s.blueprint('api', 1)
    api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-api', api.id, 'http', 8080)]
    const plWeb = s.placement(web.id, s1.id); s.placement(api.id, s2.id)

    const f = ids(run(s), 'no-egress-route')
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].affected).toContain(`${plWeb.id}#0`)
    expect(f[0].why).toMatch(/route/i)
  })

  it('silent when the subnet has an egress route', () => {
    const s = scenario()
    const rA = s.region('us-east-1'); const azA = s.az(rA.id, 'us-east-1a')
    const rB = s.region('eu-west-1'); const azB = s.az(rB.id, 'eu-west-1a')
    const s1 = s.server(azA.id); const s2 = s.server(azB.id)

    const vpc = createVpc(rA.id)
    const routeTable = createRouteTable(vpc.id)
    const subnet = createSubnet(vpc.id, azA.id, 'private', routeTable.id)
    s1.subnetId = subnet.id
    const nat = createNatGateway(subnet.id)
    routeTable.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: nat.id } })
    s.doc.vpcs[vpc.id] = vpc
    s.doc.routeTables[routeTable.id] = routeTable
    s.doc.subnets[subnet.id] = subnet
    s.doc.natGateways[nat.id] = nat

    const web = s.blueprint('web', 0); const api = s.blueprint('api', 1)
    api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
    web.dependencies = [dep('d-api', api.id, 'http', 8080)]
    s.placement(web.id, s1.id); s.placement(api.id, s2.id)

    expect(ids(run(s), 'no-egress-route')).toHaveLength(0)
  })
})

describe('network: unpeered-security-group-reference', () => {
  it('fires when a security group rule sources another group in a different VPC', () => {
    const s = scenario()
    const rA = s.region('us-east-1')
    const vpcA = createVpc(rA.id); const vpcB = createVpc(rA.id)
    const sgA = createSecurityGroup(vpcA.id, 'sg-a')
    const sgB = createSecurityGroup(vpcB.id, 'sg-b')
    sgA.rules = [{ port: 5432, protocol: 'tcp', source: sgB.id }]
    s.doc.vpcs[vpcA.id] = vpcA; s.doc.vpcs[vpcB.id] = vpcB
    s.doc.securityGroups[sgA.id] = sgA; s.doc.securityGroups[sgB.id] = sgB

    const f = ids(run(s), 'unpeered-security-group-reference')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([sgA.id, sgB.id])
    expect(f[0].why).toMatch(/sg-a|sg-b/i)
  })

  it('silent when the referenced group is in the same VPC', () => {
    const s = scenario()
    const rA = s.region('us-east-1')
    const vpc = createVpc(rA.id)
    const sgA = createSecurityGroup(vpc.id, 'sg-a')
    const sgB = createSecurityGroup(vpc.id, 'sg-b')
    sgA.rules = [{ port: 5432, protocol: 'tcp', source: sgB.id }]
    s.doc.vpcs[vpc.id] = vpc
    s.doc.securityGroups[sgA.id] = sgA; s.doc.securityGroups[sgB.id] = sgB

    expect(ids(run(s), 'unpeered-security-group-reference')).toHaveLength(0)
  })

  it('silent for an ordinary CIDR/any/internal source', () => {
    const s = scenario()
    const rA = s.region('us-east-1')
    const vpc = createVpc(rA.id)
    const sgA = createSecurityGroup(vpc.id, 'sg-a')
    sgA.rules = [{ port: 5432, protocol: 'tcp', source: '10.0.0.0/8' }]
    s.doc.vpcs[vpc.id] = vpc
    s.doc.securityGroups[sgA.id] = sgA

    expect(ids(run(s), 'unpeered-security-group-reference')).toHaveLength(0)
  })
})

describe('network: nat-gateway-spof', () => {
  it('fires when two AZs\' private subnets share one NAT gateway', () => {
    const s = scenario()
    const r = s.region('us-east-1')
    const azA = s.az(r.id, 'us-east-1a'); const azB = s.az(r.id, 'us-east-1b')
    const vpc = createVpc(r.id)
    const rtA = createRouteTable(vpc.id); const rtB = createRouteTable(vpc.id)
    const subnetA = createSubnet(vpc.id, azA.id, 'private', rtA.id)
    const subnetB = createSubnet(vpc.id, azB.id, 'private', rtB.id)
    const nat = createNatGateway(subnetA.id, 'shared-nat')
    rtA.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: nat.id } })
    rtB.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: nat.id } })

    s.doc.vpcs[vpc.id] = vpc
    s.doc.routeTables[rtA.id] = rtA; s.doc.routeTables[rtB.id] = rtB
    s.doc.subnets[subnetA.id] = subnetA; s.doc.subnets[subnetB.id] = subnetB
    s.doc.natGateways[nat.id] = nat

    const f = ids(run(s), 'nat-gateway-spof')
    expect(f).toHaveLength(1)
    expect(f[0].affected).toEqual([nat.id])
    expect(f[0].why).toMatch(/2 availability zones/i)
  })

  it('silent when each AZ has its own NAT gateway', () => {
    const s = scenario()
    const r = s.region('us-east-1')
    const azA = s.az(r.id, 'us-east-1a'); const azB = s.az(r.id, 'us-east-1b')
    const vpc = createVpc(r.id)
    const rtA = createRouteTable(vpc.id); const rtB = createRouteTable(vpc.id)
    const subnetA = createSubnet(vpc.id, azA.id, 'private', rtA.id)
    const subnetB = createSubnet(vpc.id, azB.id, 'private', rtB.id)
    const natA = createNatGateway(subnetA.id, 'nat-a')
    const natB = createNatGateway(subnetB.id, 'nat-b')
    rtA.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: natA.id } })
    rtB.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: natB.id } })

    s.doc.vpcs[vpc.id] = vpc
    s.doc.routeTables[rtA.id] = rtA; s.doc.routeTables[rtB.id] = rtB
    s.doc.subnets[subnetA.id] = subnetA; s.doc.subnets[subnetB.id] = subnetB
    s.doc.natGateways[natA.id] = natA; s.doc.natGateways[natB.id] = natB

    expect(ids(run(s), 'nat-gateway-spof')).toHaveLength(0)
  })
})
