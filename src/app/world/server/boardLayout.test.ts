// src/app/world/server/boardLayout.test.ts
import { describe, it, expect } from 'vitest'
import {
  layoutServerBoard, serverTraces, attributeCores, MAX_BOARD_CHIPS,
} from './boardLayout'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld, instanceId } from '../../../lib/world/compileWorld'
import type { WorldDoc, ComposeStack } from '../../../lib/world/types'

// ── Fixtures: real factories through a real compile ──
function base() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  return { doc, server }
}
function addProcess(doc: WorldDoc, name: string, serverId: string, i: number) {
  const bp = createBlueprint(name, i)
  doc.blueprints[bp.id] = bp
  const pl = createPlacement(bp.id, serverId)
  doc.placements[pl.id] = pl
  return { bp, pl, iid: instanceId(pl.id, 0) }
}
function addContainer(doc: WorldDoc, name: string, serverId: string, stackName: string, i: number) {
  const { bp, pl, iid } = addProcess(doc, name, serverId, i)
  pl.runtime = { type: 'container', stackName, networkNames: [], portMappings: [], cpuLimit: null, memLimitMb: null }
  return { bp, pl, iid }
}
const stack = (name: string, volumes: ComposeStack['volumes'] = []): ComposeStack =>
  ({ name, networks: [{ name: 'net', cidr: '172.18.0.0/16' }], volumes })

describe('layoutServerBoard — zones', () => {
  it('lays out nic, gate, and hardware rail at fixed zones', () => {
    const { doc, server } = base()
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    expect(l.stageW).toBe(1000)
    expect(l.stageH).toBe(560)
    expect(l.nic.box.x).toBe(0)                                  // flush left
    expect(l.gate.box.x).toBeGreaterThanOrEqual(l.nic.box.x + l.nic.box.w)   // gate right of nic
    expect(l.hardware.box.x).toBe(840)                           // fixed right rail
    // cpu/ram/disk nested inside the hardware box
    for (const part of [l.hardware.cpu, l.hardware.ram, l.hardware.disk]) {
      expect(part.x).toBeGreaterThanOrEqual(l.hardware.box.x)
      expect(part.x + part.w).toBeLessThanOrEqual(l.hardware.box.x + l.hardware.box.w)
      expect(part.y).toBeGreaterThanOrEqual(l.hardware.box.y)
      expect(part.y + part.h).toBeLessThanOrEqual(l.hardware.box.y + l.hardware.box.h)
    }
  })

  it('process chips column excludes container chips', () => {
    const { doc, server } = base()
    server.stacks = [stack('app')]
    addProcess(doc, 'nginx', server.id, 0)
    addContainer(doc, 'api', server.id, 'app', 1)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const proc = l.chips.filter(c => c.stackName === null)
    const cont = l.chips.filter(c => c.stackName !== null)
    expect(proc).toHaveLength(1)
    expect(cont).toHaveLength(1)
    // process chip sits in the middle column (x within 250..340)
    expect(proc[0].box.x).toBeGreaterThanOrEqual(250)
    expect(proc[0].box.x + proc[0].box.w).toBeLessThanOrEqual(340)
  })

  it('container chips sit inside their stack plate box', () => {
    const { doc, server } = base()
    server.stacks = [stack('app')]
    addContainer(doc, 'api', server.id, 'app', 0)
    addContainer(doc, 'pg', server.id, 'app', 1)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const plate = l.stacks.find(s => s.stackName === 'app')!
    expect(plate).toBeDefined()
    const cont = l.chips.filter(c => c.stackName === 'app')
    expect(cont).toHaveLength(2)
    for (const c of cont) {
      expect(c.box.x).toBeGreaterThanOrEqual(plate.box.x)
      expect(c.box.x + c.box.w).toBeLessThanOrEqual(plate.box.x + plate.box.w)
      expect(c.box.y).toBeGreaterThanOrEqual(plate.box.y)
      expect(c.box.y + c.box.h).toBeLessThanOrEqual(plate.box.y + plate.box.h)
    }
    expect(plate.chipIds).toEqual(cont.map(c => c.instanceId))
  })

  it('volume cylinders attach to their plate', () => {
    const { doc, server } = base()
    server.stacks = [stack('app', [{ name: 'pgdata', sizeGb: 12 }])]
    addContainer(doc, 'pg', server.id, 'app', 0)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const plate = l.stacks.find(s => s.stackName === 'app')!
    expect(plate.volumes).toHaveLength(1)
    const v = plate.volumes[0]
    expect(v.volumeName).toBe('pgdata')
    expect(v.sizeGb).toBe(12)
    expect(v.box.x).toBeGreaterThanOrEqual(plate.box.x)
    expect(v.box.x + v.box.w).toBeLessThanOrEqual(plate.box.x + plate.box.w)
    expect(v.box.y + v.box.h).toBeLessThanOrEqual(plate.box.y + plate.box.h)
  })

  it('chips overflow beyond MAX_BOARD_CHIPS into overflowCount', () => {
    const { doc, server } = base()
    for (let i = 0; i < MAX_BOARD_CHIPS + 3; i++) addProcess(doc, `svc${i}`, server.id, i)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    expect(l.chips).toHaveLength(MAX_BOARD_CHIPS)
    expect(l.overflowCount).toBe(3)
    // residentInstanceIds is the UNTRUNCATED list — must include the overflow residents too,
    // so gate-block attribution (gateStats.blockedPerSecond) doesn't undercount past 12.
    expect(l.residentInstanceIds).toHaveLength(MAX_BOARD_CHIPS + 3)
  })

  it('anchorFor resolves instance and nic ids and rejects unknown ids', () => {
    const { doc, server } = base()
    const { iid } = addProcess(doc, 'nginx', server.id, 0)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    expect(l.anchorFor(iid)).not.toBeNull()
    expect(l.anchorFor(`nic:${server.id}`)).toEqual(l.nic.anchor)
    expect(l.anchorFor('does-not-exist')).toBeNull()
  })

  it('tracePath routes through the gate for nic endpoints', () => {
    const { doc, server } = base()
    const { iid } = addProcess(doc, 'nginx', server.id, 0)
    const l = layoutServerBoard(server, doc, compileWorld(doc))
    const viaGate = l.tracePath(`nic:${server.id}`, iid)
    // contains both gate anchors' coordinates → the packet threads the gate
    expect(viaGate).toContain(`${l.gate.inAnchor.x} ${l.gate.inAnchor.y}`)
    expect(viaGate).toContain(`${l.gate.outAnchor.x} ${l.gate.outAnchor.y}`)
    // a non-nic path is a single cubic (no gate anchors)
    const direct = l.tracePath(iid, iid)
    expect(direct).not.toContain(`${l.gate.outAnchor.x} ${l.gate.outAnchor.y}`)
  })

  it('is deterministic — same inputs produce deep-equal output twice', () => {
    const { doc, server } = base()
    server.stacks = [stack('app', [{ name: 'pgdata', sizeGb: 12 }])]
    addProcess(doc, 'nginx', server.id, 0)
    addContainer(doc, 'api', server.id, 'app', 1)
    const compiled = compileWorld(doc)
    const a = layoutServerBoard(server, doc, compiled)
    const b = layoutServerBoard(server, doc, compiled)
    // compare the serialisable core (functions excluded)
    const strip = (l: ReturnType<typeof layoutServerBoard>) =>
      ({ ...l, anchorFor: undefined, tracePath: undefined })
    expect(strip(a)).toEqual(strip(b))
  })
})

describe('serverTraces', () => {
  // web(public) + api on server1; db on server2 (off-server, binds 5432); api -> db
  // (cross-server, port 5432) and api -> managed cache (off-server).
  function tracedWorld() {
    const { doc, server } = base()
    const az = doc.azs[Object.keys(doc.azs)[0]]
    const server2 = createServer(az.id, getPreset('vps-medium')!)
    doc.servers[server2.id] = server2

    const web = createBlueprint('web', 0)
    web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    const api = createBlueprint('api', 1)
    const db = createBlueprint('db', 2)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]   // bind the dep port so a real firewall verdict is reached
    const cache = { id: 'ms-cache', label: 'cache', nodeType: 'redis', scope: { kind: 'az' as const, azId: az.id }, provider: 'aws' as const, port: 6379 }
    doc.managedServices[cache.id] = cache
    web.dependencies = [{ id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null }]
    api.dependencies = [
      { id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null },
      { id: 'd-cache', target: { kind: 'managed', managedServiceId: cache.id }, port: 6379, protocol: 'event', packetTemplateId: null },
    ]
    Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db })

    createPlacementInto(doc, web.id, server.id)
    createPlacementInto(doc, api.id, server.id)
    createPlacementInto(doc, db.id, server2.id)   // db off-server → collapses to nic
    return { doc, server, server2 }
  }
  function createPlacementInto(doc: WorldDoc, bpId: string, serverId: string) {
    const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl
  }

  it('collapses off-server and managed targets to nic', () => {
    const { doc, server } = tracedWorld()
    const traces = serverTraces(server.id, doc, compileWorld(doc))
    expect(traces.find(t => t.protocol === 'db')?.toId).toBe(`nic:${server.id}`)      // off-server db
    expect(traces.find(t => t.protocol === 'event')?.toId).toBe(`nic:${server.id}`)   // managed cache
  })

  it('carries the firewall-deny label for a blocked path', () => {
    const { doc, server, server2 } = tracedWorld()
    server2.firewall = [{ id: 'fw-deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]  // TARGET server denies 5432
    const traces = serverTraces(server.id, doc, compileWorld(doc))
    const dbTrace = traces.find(t => t.protocol === 'db')
    expect(dbTrace?.verdict).toBe('blocked')
    expect(dbTrace?.label).toBeTruthy()
    expect(dbTrace?.label).toMatch(/firewall/i)
  })

  it('adds an inbound trace for public-port blueprints', () => {
    const { doc, server } = tracedWorld()
    const traces = serverTraces(server.id, doc, compileWorld(doc))
    const inbound = traces.filter(t => t.fromId === `nic:${server.id}`)
    expect(inbound.length).toBeGreaterThanOrEqual(1)
    expect(inbound.every(t => t.verdict === 'permitted')).toBe(true)
  })

  // D7 acceptance story: a server's own firewall deny on an INBOUND path (source resident
  // elsewhere) must show up on ITS board — since firewallVerdict() evaluates the TARGET
  // server's rules — so the inspector rail on that server's board can actually fix it.
  it('surfaces the target server\'s own firewall deny as an inbound trace, and flips on repair', () => {
    const { doc, server: serverA } = base()   // serverA will host db
    const az = doc.azs[Object.keys(doc.azs)[0]]
    const serverB = createServer(az.id, getPreset('vps-medium')!)
    doc.servers[serverB.id] = serverB

    const db = createBlueprint('db', 0)
    db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]   // bind the dep port
    const api = createBlueprint('api', 1)
    api.dependencies = [
      { id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null },
    ]
    Object.assign(doc.blueprints, { [db.id]: db, [api.id]: api })

    const plDb = createPlacement(db.id, serverA.id); doc.placements[plDb.id] = plDb
    const plApi = createPlacement(api.id, serverB.id); doc.placements[plApi.id] = plApi
    const dbIid = instanceId(plDb.id, 0)
    const apiIid = instanceId(plApi.id, 0)

    // TARGET server (serverA) denies port 5432.
    serverA.firewall = [{ id: 'fw-deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]

    let compiled = compileWorld(doc)
    const tracesA = serverTraces(serverA.id, doc, compiled)
    const inboundDb = tracesA.find(t => t.fromId === `nic:${serverA.id}` && t.toId === dbIid)
    expect(inboundDb).toBeDefined()
    expect(inboundDb?.verdict).toBe('blocked')
    expect(inboundDb?.label).toBeTruthy()
    expect(inboundDb?.protocol).toBe('db')

    // Additive, not a replacement: the SOURCE server (serverB) still shows its own outbound
    // blocked trace (collapsed to its nic, unchanged behavior).
    const tracesB = serverTraces(serverB.id, doc, compiled)
    const outboundApi = tracesB.find(t => t.fromId === apiIid && t.toId === `nic:${serverB.id}`)
    expect(outboundApi).toBeDefined()
    expect(outboundApi?.verdict).toBe('blocked')

    // Repair: allow rule placed ABOVE the deny on the TARGET server (serverA) — recompile.
    serverA.firewall = [
      { id: 'fw-allow', action: 'allow', port: 5432, protocol: 'tcp', source: 'any' },
      { id: 'fw-deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
    ]
    compiled = compileWorld(doc)
    const tracesA2 = serverTraces(serverA.id, doc, compiled)
    const inboundDb2 = tracesA2.find(t => t.fromId === `nic:${serverA.id}` && t.toId === dbIid)
    expect(inboundDb2?.verdict).toBe('permitted')
    expect(inboundDb2?.label).toBeNull()
  })
})

describe('attributeCores', () => {
  it('greedy assignment and dominant owner', () => {
    const r = attributeCores(4, [
      { instanceId: 'a', blueprintId: 'bpX', cpuCoresUsed: 1.2 },
      { instanceId: 'b', blueprintId: 'bpY', cpuCoresUsed: 0.8 },
    ])
    expect(r).toHaveLength(4)
    expect(r[0].dominantBlueprintId).toBe('bpX')
    expect(r[0].shares).toHaveLength(1)
    expect(r[0].shares[0].fraction).toBeCloseTo(1.0)
    expect(r[1].dominantBlueprintId).toBe('bpY')          // b's 0.8 beats a's 0.2 on core1
    const aShare = r[1].shares.find(s => s.instanceId === 'a')!
    const bShare = r[1].shares.find(s => s.instanceId === 'b')!
    expect(aShare.fraction).toBeCloseTo(0.2)
    expect(bShare.fraction).toBeCloseTo(0.8)
    expect(r[2].dominantBlueprintId).toBeNull()
    expect(r[3].shares).toEqual([])
  })

  it('returns null dominants for zero demand', () => {
    const r = attributeCores(2, [
      { instanceId: 'a', blueprintId: 'bpX', cpuCoresUsed: 0 },
      { instanceId: 'b', blueprintId: 'bpY', cpuCoresUsed: 0 },
    ])
    expect(r.map(c => c.dominantBlueprintId)).toEqual([null, null])
    expect(r.every(c => c.shares.length === 0)).toBe(true)
  })
})
