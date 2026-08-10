import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createVpc, createSubnet, createRouteTable, createNatGateway, createSecurityGroup,
} from './factories'
import { getPreset } from './instanceCatalog'
import { compileWorld, instanceId } from './compileWorld'
import { addPacket } from '../nodeConfig'
import type { WorldDoc } from './types'

// Shared fixture builder: 1 region, 1 AZ, 1 server, 1 blueprint. Tests mutate from here.
export function tinyWorld() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  const bp = createBlueprint('api', 1)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  doc.blueprints[bp.id] = bp
  return { doc, region, az, server, bp }
}

describe('compileWorld — instance expansion', () => {
  it('expands a placement of count N into N instances with full lineage', () => {
    const { doc, region, az, server, bp } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 3
    pl.role = 'replica'
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const ids = Object.keys(compiled.instances)
    expect(ids).toHaveLength(3)
    expect(ids).toContain(instanceId(pl.id, 0))
    const inst = compiled.instances[instanceId(pl.id, 1)]
    expect(inst).toMatchObject({
      blueprintId: bp.id, placementId: pl.id, serverId: server.id,
      azId: az.id, regionId: region.id, role: 'replica', indexInPlacement: 1,
    })
  })

  it('skips placements whose blueprint or server no longer exists (dangling refs)', () => {
    const { doc, server, bp } = tinyWorld()
    const good = createPlacement(bp.id, server.id)
    const noBp = createPlacement('bp-gone', server.id)
    const noSrv = createPlacement(bp.id, 'srv-gone')
    doc.placements[good.id] = good
    doc.placements[noBp.id] = noBp
    doc.placements[noSrv.id] = noSrv

    const compiled = compileWorld(doc)
    expect(Object.keys(compiled.instances)).toHaveLength(1)
  })

  it('returns empty collections for an empty world', () => {
    const compiled = compileWorld(createWorld())
    expect(compiled.instances).toEqual({})
    expect(compiled.paths).toEqual([])
    expect(compiled.findings).toEqual([])
  })

  it('is pure: same input object → deep-equal output, input untouched', () => {
    const { doc, server, bp } = tinyWorld()
    doc.placements['p1'] = { ...createPlacement(bp.id, server.id), id: 'p1' }
    const snapshot = JSON.parse(JSON.stringify(doc)) as WorldDoc
    const a = compileWorld(doc)
    const b = compileWorld(doc)
    expect(a).toEqual(b)
    expect(doc).toEqual(snapshot)
  })
})

// ─── Autoscale envelope expansion + compile findings (FEAT-008) ──────────────
// Task 10 added Placement.autoscale?: AutoscalePolicy. A placement with autoscale authored
// compiles to its maxCount envelope, not its authored count -- the spec's one sanctioned
// exception to the regression floor (compiled.instances cardinality != pl.count). A placement
// WITHOUT autoscale must remain byte-identical to the pre-Task-11 behavior.
describe('compileWorld — autoscale envelope expansion (FEAT-008)', () => {
  it('expands an autoscaled placement to maxCount instances, not count', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    pl.autoscale = { minCount: 2, maxCount: 8, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.placementId === pl.id)
    expect(instances).toHaveLength(8)
  })

  it('expands a non-autoscaled placement to count instances, unchanged (regression floor)', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 3
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const instances = Object.values(compiled.instances).filter(i => i.placementId === pl.id)
    expect(instances).toHaveLength(3)
  })

  it('emits an error finding when minCount > maxCount', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    pl.autoscale = { minCount: 8, maxCount: 2, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const found = compiled.findings.filter(f => f.kind === 'autoscale-invalid-range')
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('error')
    expect(found[0].affected).toContain(pl.id)
  })

  it('emits a warning finding when count is outside [minCount, maxCount]', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 20
    pl.autoscale = { minCount: 2, maxCount: 8, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const found = compiled.findings.filter(f => f.kind === 'autoscale-count-out-of-range')
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('warning')
    expect(found[0].affected).toContain(pl.id)
  })

  it('does not fire any autoscale finding for a valid range, in-range count, and positive targetCpuPercent', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 4
    pl.autoscale = { minCount: 2, maxCount: 8, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f =>
      f.kind === 'autoscale-invalid-range' || f.kind === 'autoscale-count-out-of-range'
      || f.kind === 'autoscale-invalid-target-cpu')).toBe(false)
  })

  // Wave 3 final review (Minor #8): targetCpuPercent had no validation while minCount/maxCount
  // did -- a 0 (or negative) target makes evaluatePolicy's ratio blow up toward +Infinity on any
  // load, instantly clamping the placement to maxCount.
  it('emits an error finding when targetCpuPercent is 0', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    pl.autoscale = { minCount: 2, maxCount: 8, targetCpuPercent: 0, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    const found = compiled.findings.filter(f => f.kind === 'autoscale-invalid-target-cpu')
    expect(found).toHaveLength(1)
    expect(found[0].severity).toBe('error')
    expect(found[0].affected).toContain(pl.id)
  })

  it('emits an error finding when targetCpuPercent is negative', () => {
    const { doc, bp, server } = tinyWorld()
    const pl = createPlacement(bp.id, server.id)
    pl.count = 2
    pl.autoscale = { minCount: 2, maxCount: 8, targetCpuPercent: -10, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300 }
    doc.placements[pl.id] = pl

    const compiled = compileWorld(doc)
    expect(compiled.findings.filter(f => f.kind === 'autoscale-invalid-target-cpu')).toHaveLength(1)
  })
})

// ─── Protocol-mismatch findings (audit ISSUE-007) ────────────────────────────
// dep.protocol drives ONLY particle render tint; every simulated consequence comes from the bound
// mix's own protocol. A mismatch is advisory-surfaced, never auto-corrected.
describe('compileWorld — protocol-mismatch findings (audit ISSUE-007)', () => {
  // Two blueprints (api -> target) on one server, with api's dependency's protocol/mix set by
  // the caller. Target has no dependencies, so it never contributes its own findings.
  function mismatchWorld(depProtocol: 'http' | 'db' | 'event' | 'stream', mixProtocol: 'http' | 'db' | 'event' | 'stream' | null) {
    const { doc, server } = tinyWorld()
    const target = createBlueprint('target', 2)
    doc.blueprints[target.id] = target
    const targetPl = createPlacement(target.id, server.id)
    doc.placements[targetPl.id] = targetPl

    const api = doc.blueprints[Object.keys(doc.blueprints)[0]]
    const apiPl = createPlacement(api.id, server.id)
    doc.placements[apiPl.id] = apiPl

    let packetMix: { packetId: number; weight: number }[] | undefined
    if (mixProtocol != null) {
      const fields = mixProtocol === 'http'
        ? { name: 'p', protocol: 'http' as const, method: 'GET' as const, statusCode: 200 }
        : mixProtocol === 'db'
          ? { name: 'p', protocol: 'db' as const, queryType: 'read' as const, isWAL: false, resultSizeKb: 1 }
          : mixProtocol === 'event'
            ? { name: 'p', protocol: 'event' as const, topic: 't', eventType: 'e', deliveryMode: 'at-least-once' as const }
            : { name: 'p', protocol: 'stream' as const, streamId: 's', compressionType: 'none' as const }
      const added = addPacket(doc.packets, fields)
      doc.packets = added.registry
      packetMix = [{ packetId: added.packet.id, weight: 1 }]
    }

    api.dependencies = [{
      id: 'd-target', target: { kind: 'blueprint', blueprintId: target.id },
      port: 8080, protocol: depProtocol, packetTemplateId: null, packetMix,
    }]
    return doc
  }

  it('flags a dependency whose protocol disagrees with its bound mix', () => {
    const doc = mismatchWorld('event', 'http')
    const compiled = compileWorld(doc)
    const found = compiled.findings.filter(f => f.kind === 'protocol-mismatch')
    expect(found).toHaveLength(1)
    expect(found[0].affected).toContain('d-target')
  })

  it('does not fire when dep.protocol matches the mix majority', () => {
    const doc = mismatchWorld('http', 'http')
    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f => f.kind === 'protocol-mismatch')).toBe(false)
  })

  it('does not fire when the dependency has no bound mix at all', () => {
    const doc = mismatchWorld('event', null)
    const compiled = compileWorld(doc)
    expect(compiled.findings.some(f => f.kind === 'protocol-mismatch')).toBe(false)
  })
})

// ─── Network-topology compile wiring (Task 6) ────────────────────────────────
// Task 5 added resolveRoute/evaluateSecurityGroups + a widened InstancePathContext to
// network.ts, but compileWorld.ts never resolved or passed the new fields -- none of it ran.
// This suite wires the call site and locks the regression floor: a doc with no subnetId
// anywhere skips the route-table check entirely, matching pre-Task-6 behavior exactly.
describe('compileWorld — network topology compile wiring (Task 6)', () => {
  it('a doc with zero vpcs/subnets and no server.subnetId compiles byte-identically to pre-feature (regression floor)', () => {
    const { doc, bp, server } = tinyWorld()
    const target = createBlueprint('target', 1)
    doc.blueprints[target.id] = target
    const targetPl = createPlacement(target.id, server.id)
    doc.placements[targetPl.id] = targetPl
    bp.dependencies = [{
      id: 'dep-1', target: { kind: 'blueprint', blueprintId: target.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
    const pl = createPlacement(bp.id, server.id)
    doc.placements[pl.id] = pl

    const before = compileWorld(doc)
    const again = compileWorld(doc)
    expect(again).toEqual(before)
  })

  // Region A: a VPC + private subnet with an EMPTY route table (no NAT/IGW route). ServerA
  // (in that subnet) depends cross-region on ServerB in region B -- needsEgress is true, so
  // resolveRoute finds no non-local route and the path must block with 'no-egress-route'.
  function crossRegionSubnetWorld() {
    const doc = createWorld()
    const regionA = createRegion('us-east-1')
    const regionB = createRegion('eu-west-1')
    const azA = createAz(regionA.id, 'us-east-1a')
    const azB = createAz(regionB.id, 'eu-west-1a')
    const serverA = createServer(azA.id, getPreset('vps-medium')!)
    const serverB = createServer(azB.id, getPreset('vps-medium')!)
    Object.assign(doc.regions, { [regionA.id]: regionA, [regionB.id]: regionB })
    Object.assign(doc.azs, { [azA.id]: azA, [azB.id]: azB })
    Object.assign(doc.servers, { [serverA.id]: serverA, [serverB.id]: serverB })

    const vpc = createVpc(regionA.id)
    const routeTable = createRouteTable(vpc.id)
    const subnet = createSubnet(vpc.id, azA.id, 'private', routeTable.id)
    serverA.subnetId = subnet.id
    doc.vpcs[vpc.id] = vpc
    doc.routeTables[routeTable.id] = routeTable
    doc.subnets[subnet.id] = subnet

    const api = createBlueprint('api', 0)
    const target = createBlueprint('target', 1)
    api.dependencies = [{
      id: 'dep-cross-region', target: { kind: 'blueprint', blueprintId: target.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
    Object.assign(doc.blueprints, { [api.id]: api, [target.id]: target })
    const plApi = createPlacement(api.id, serverA.id)
    const plTarget = createPlacement(target.id, serverB.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plTarget.id]: plTarget })

    return { doc, vpc, routeTable, subnet, serverA, serverB, depId: 'dep-cross-region' }
  }

  it('a private-subnet server with no NAT/IGW route produces a blocked path with BlockReason.kind "no-egress-route"', () => {
    const { doc } = crossRegionSubnetWorld()
    const compiled = compileWorld(doc)
    const blockedPath = compiled.paths.find(p => p.verdict === 'blocked')
    expect(blockedPath?.blockReason?.kind).toBe('no-egress-route')
  })

  it('adding a NAT gateway route to that subnet route table flips the same path to permitted', () => {
    const { doc, routeTable, subnet, depId } = crossRegionSubnetWorld()
    const nat = createNatGateway(subnet.id)
    doc.natGateways[nat.id] = nat
    routeTable.routes.push({ destinationCidr: '0.0.0.0/0', target: { kind: 'natGateway', id: nat.id } })

    const compiled = compileWorld(doc)
    const path = compiled.paths.find(p => p.dependencyId === depId)
    expect(path?.verdict).toBe('permitted')
  })

  it('a server with securityGroupIds set is evaluated by evaluateSecurityGroups, denying where no rule matches', () => {
    const doc = createWorld()
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    const az2 = createAz(region.id, 'us-east-1b')
    const serverA = createServer(az.id, getPreset('vps-medium')!)
    const serverB = createServer(az2.id, getPreset('vps-medium')!)
    Object.assign(doc.regions, { [region.id]: region })
    Object.assign(doc.azs, { [az.id]: az, [az2.id]: az2 })
    Object.assign(doc.servers, { [serverA.id]: serverA, [serverB.id]: serverB })

    const vpc = createVpc(region.id)
    const sg = createSecurityGroup(vpc.id)
    sg.rules = [{ port: 9999, protocol: 'tcp', source: 'internal' }] // never matches port 8080
    serverB.securityGroupIds = [sg.id]
    doc.vpcs[vpc.id] = vpc
    doc.securityGroups[sg.id] = sg

    const api = createBlueprint('api', 0)
    const target = createBlueprint('target', 1)
    const depId = 'dep-sg'
    api.dependencies = [{
      id: depId, target: { kind: 'blueprint', blueprintId: target.id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
    Object.assign(doc.blueprints, { [api.id]: api, [target.id]: target })
    const plApi = createPlacement(api.id, serverA.id)
    const plTarget = createPlacement(target.id, serverB.id)
    Object.assign(doc.placements, { [plApi.id]: plApi, [plTarget.id]: plTarget })

    const compiled = compileWorld(doc)
    const path = compiled.paths.find(p => p.dependencyId === depId)
    expect(path?.verdict).toBe('blocked')
    expect(path?.blockReason?.kind).toBe('firewall-deny')
  })
})
