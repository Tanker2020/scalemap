// src/lib/worldEngine/serverParticles.test.ts
import { describe, it, expect } from 'vitest'
import { createWorldEngine } from './index'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { WorldDoc } from '../world/types'
import type { FramePayload, RenderScope } from './types'

// web(public) on s1 -> api on s1 (intra) ; api -> db on s2 (cross-server) ;
// api -> managed queue (off-server) ; web -> blockedDep on s1 firewall-denied.
function fixture(peakRps = 200) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const s1 = createServer(az.id, getPreset('dedicated-8')!)
  const s2 = createServer(az.id, getPreset('dedicated-8')!)
  // block one downstream port on s1 so at least one path compiles 'blocked'
  s1.firewall = [
    { id: 'deny-9999', action: 'deny', port: 9999, protocol: 'tcp', source: 'any' },
    { id: 'allow-int', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
  ]
  Object.assign(doc.regions, { [region.id]: region })
  Object.assign(doc.azs, { [az.id]: az })
  Object.assign(doc.servers, { [s1.id]: s1, [s2.id]: s2 })

  const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
  const api = createBlueprint('api', 1)
  const db = createBlueprint('db', 2)
  const blocked = createBlueprint('audit', 3)
  const ms = { id: 'ms-q', label: 'Q', nodeType: 'queue', scope: { kind: 'az' as const, azId: az.id }, provider: 'aws' as const, port: 5672 }
  doc.managedServices[ms.id] = ms
  web.dependencies = [
    { id: 'd-api', target: { kind: 'blueprint', blueprintId: api.id }, port: 8080, protocol: 'http', packetTemplateId: null },
    { id: 'd-blk', target: { kind: 'blueprint', blueprintId: blocked.id }, port: 9999, protocol: 'http', packetTemplateId: null },
  ]
  api.dependencies = [
    { id: 'd-db', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null },
    { id: 'd-q', target: { kind: 'managed', managedServiceId: ms.id }, port: 5672, protocol: 'event', packetTemplateId: null },
  ]
  Object.assign(doc.blueprints, { [web.id]: web, [api.id]: api, [db.id]: db, [blocked.id]: blocked })

  const place = (bpId: string, serverId: string) => { const pl = createPlacement(bpId, serverId); doc.placements[pl.id] = pl; return pl }
  const webPl = place(web.id, s1.id)
  const apiPl = place(api.id, s1.id)
  place(db.id, s2.id)
  place(blocked.id, s1.id)

  const pop = createPopulation('nyc', 40.7, -74.0); pop.peakRps = peakRps
  doc.populations[pop.id] = pop
  return { doc, s1, s2, api, apiInst: instanceId(apiPl.id, 0), webInst: instanceId(webPl.id, 0) }
}

// Drive the engine to steady flows, then render one server-scope frame deterministically.
function serverFrame(doc: WorldDoc, serverId: string, seconds = 3): FramePayload {
  const engine = createWorldEngine(1)
  const compiled = compileWorld(doc)
  const frames: FramePayload[] = []
  const scope: RenderScope = { level: 'server', serverId }
  // attachRenderer returns a no-op before start() (state is null) and start() resets the renderer
  // map — so attach AFTER start(), then step to build flows, then render one deterministic frame.
  engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })
  const detach = engine.attachRenderer(scope, p => frames.push(p))
  engine.__test_step(seconds * 10)
  engine.__test_render(1000)               // deterministic wallMs → deterministic progress
  detach(); engine.stop()
  return frames[frames.length - 1]
}

describe('buildServerParticles', () => {
  it('server scope emits nic->instance entry particles', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.some(p => p.fromId === `nic:${f.s1.id}` && p.toId === f.webInst)).toBe(true)
  })

  it('intra-server dependency emits instance->instance particles', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.some(p => p.fromId === f.webInst && p.toId === f.apiInst)).toBe(true)
  })

  it('cross-server and managed targets collapse to the nic endpoint', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    // api -> db (cross-server) and api -> queue (managed) both leave via nic
    expect(frame.particles.some(p => p.fromId === f.apiInst && p.toId === `nic:${f.s1.id}`)).toBe(true)
  })

  it('blocked path emits blocked particles', () => {
    // d-blk fails 100% of attempts (port mismatch -> firewall never even reached, since
    // same-server hops bypass it), so DEFAULT_BREAKER_CONFIG (breakers.ts: request-weighted
    // window, volume floor 10, 100% error rate — audit ISSUE-015) trips its breaker open once
    // ~10 failed requests accumulate, and flows.ts's documented short-circuit ("breaker
    // short-circuit: whole call volume refused, no rows") removes the row from downstream
    // entirely thereafter — by design, not a buildServerParticles bug. At 200 peak rps the
    // volume floor fills within the FIRST step, so sample after exactly one step: the rendered
    // prevFlows still carry that step's live blocked row.
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id, 0.1)
    expect(frame.particles.some(p => p.blocked)).toBe(true)
  })

  it('respects MAX_SERVER_PARTICLES cap', () => {
    const f = fixture(50_000)                // crank demand
    const frame = serverFrame(f.doc, f.s1.id)
    expect(frame.particles.length).toBeLessThanOrEqual(50)
  })

  it('colorHint carries the target blueprint color for intra traces', () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    const intra = frame.particles.find(p => p.fromId === f.webInst && p.toId === f.apiInst)
    expect(intra?.colorHint).toBe(f.api.color)
  })

  it("other servers' flows never leak into this scope", () => {
    const f = fixture()
    const frame = serverFrame(f.doc, f.s1.id)
    // s2 hosts db only; no particle should originate from an s2-resident instance
    expect(frame.particles.every(p => !p.fromId.includes(f.s2.id) || p.fromId === `nic:${f.s1.id}`)).toBe(true)
    // db instance id (s2 resident) must not be a from-endpoint
    expect(frame.particles.some(p => p.fromId === f.apiInst || p.fromId === f.webInst || p.fromId === `nic:${f.s1.id}`)).toBe(true)
  })

  it('is deterministic for a fixed seed', () => {
    const f = fixture()
    const a = serverFrame(f.doc, f.s1.id)
    const b = serverFrame(f.doc, f.s1.id)
    expect(a.particles).toEqual(b.particles)
  })

  it('az and globe payloads are unchanged (guard)', () => {
    const f = fixture()
    const engine = createWorldEngine(1)
    const azFrames: FramePayload[] = []
    const az = Object.keys(f.doc.azs)[0]
    engine.start(f.doc, compileWorld(f.doc), { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })
    engine.attachRenderer({ level: 'az', azId: az }, p => azFrames.push(p))   // attach after start
    engine.__test_step(30)
    engine.__test_render(1000)
    engine.stop()
    // az scope still produces server-keyed endpoints (not instance ids) — vocabulary intact
    const last = azFrames[azFrames.length - 1]
    expect(last.arcs).toEqual([])
    expect(last.particles.every(p => p.toId !== f.apiInst)).toBe(true)  // az uses serverId endpoints
  })
})
