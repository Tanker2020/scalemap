import { describe, it, expect } from 'vitest'
import { createReplayBuffer, createTracer, scopeKey } from './replay'
import { createRng } from './rng'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from '../world/factories'
import { getPreset } from '../world/instanceCatalog'
import { compileWorld, instanceId } from '../world/compileWorld'
import type { InstanceFlow } from './flows'
import { MANAGED_SERVICE_LATENCY_MS } from './flows'
import { managedDbRuntimeFor } from '../managedDbRuntime'
import type { WorldDoc } from '../world/types'
import type { MetricsBatch, ReplayFrame } from './types'

const emptyBatch = (simMs: number): MetricsBatch => ({
  simMs, instances: {}, servers: {}, azs: {}, regions: {},
  world: { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
})
const frame = (simMs: number, eventIds: string[] = []): ReplayFrame => ({
  simMs, batch: emptyBatch(simMs),
  events: eventIds.map(id => ({ id, simMs, kind: 'oom_kill' as const, severity: 'critical' as const, message: id, affected: [] })),
})

describe('replay buffer', () => {
  it('wraps at 300 frames, dropping oldest', () => {
    const buf = createReplayBuffer()
    for (let i = 0; i < 305; i++) buf.push(frame(i * 1000))
    const frames = buf.getFrames()
    expect(frames).toHaveLength(300)
    expect(frames[0].simMs).toBe(5000)
    expect(frames[299].simMs).toBe(304_000)
  })

  it('keeps each frame\'s event window intact and separate', () => {
    const buf = createReplayBuffer(10)
    buf.push(frame(1000, ['evt-1', 'evt-2']))
    buf.push(frame(2000, ['evt-3']))
    const [f1, f2] = buf.getFrames()
    expect(f1.events.map(e => e.id)).toEqual(['evt-1', 'evt-2'])
    expect(f2.events.map(e => e.id)).toEqual(['evt-3'])
  })
})

// api on web-server → pg on db-server (permitted, same az). One entry, one hop.
function tracedFixture() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const web = createServer(az.id, getPreset('vps-medium')!)
  const db = createServer(az.id, getPreset('dedicated-8')!)
  const api = createBlueprint('api', 0)
  const pg = createBlueprint('pg', 1)
  pg.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  api.dependencies = [{ id: 'dep-1', target: { kind: 'blueprint', blueprintId: pg.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  Object.assign(doc.servers, { [web.id]: web, [db.id]: db })
  Object.assign(doc.blueprints, { [api.id]: api, [pg.id]: pg })
  const plApi = createPlacement(api.id, web.id)
  const plPg = createPlacement(pg.id, db.id)
  Object.assign(doc.placements, { [plApi.id]: plApi, [plPg.id]: plPg })
  const compiled = compileWorld(doc)
  const apiInst = instanceId(plApi.id, 0)
  const pgInst = instanceId(plPg.id, 0)
  const flows: Record<string, InstanceFlow> = {
    [apiInst]: {
      instanceId: apiInst, offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0, serviceLatencyMs: 8,
      downstream: [{ dependencyId: 'dep-1', toInstanceId: pgInst, rps: 100, hopClass: 'same-az', blocked: false }],
    },
    [pgInst]: {
      instanceId: pgInst, offeredRps: 100, admittedRps: 100, errorRps: 0, refusedRps: 0, serviceLatencyMs: 4,
      downstream: [],
    },
  }
  return { doc, compiled, az, web, db, apiInst, pgInst, flows }
}

describe('tracer', () => {
  it('walks a real permitted path from an entry instance', () => {
    const f = tracedFixture()
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    const traces = tracer.getTraced({ level: 'az', azId: f.az.id })
    expect(traces).toHaveLength(1)
    const t = traces[0]
    expect(t.hops).toHaveLength(1)
    expect(t.hops[0]).toMatchObject({ fromId: f.apiInst, toId: f.pgInst, hopClass: 'same-az', outcome: 'ok' })
    // hop latency = same-az network latency (0.5ms +-10% jitter) + pg's serviceLatencyMs (4)
    expect(t.hops[0].latencyMs).toBeGreaterThanOrEqual(4 + 0.45)
    expect(t.hops[0].latencyMs).toBeLessThanOrEqual(4 + 0.55)
    expect(t.outcome).toBe('ok')
    // totalMs = entry serviceLatencyMs (8) + hop latencyMs
    expect(t.totalMs).toBeGreaterThanOrEqual(8 + 4 + 0.45)
    expect(t.totalMs).toBeLessThanOrEqual(8 + 4 + 0.55)
    expect(t.populationId).toBeNull()
    // The traced hop corresponds to a compiled permitted path.
    expect(f.compiled.paths.some(p =>
      p.verdict === 'permitted' && p.fromInstanceId === t.hops[0].fromId &&
      p.to.kind === 'instance' && p.to.instanceId === t.hops[0].toId)).toBe(true)
  })

  it('marks a blocked hop and the whole request as refused', () => {
    const f = tracedFixture()
    f.flows[f.apiInst].downstream[0].blocked = true
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    const [t] = tracer.getTraced({ level: 'server', serverId: f.web.id })
    expect(t.hops[0].outcome).toBe('refused')
    expect(t.hops[0].latencyMs).toBe(0)
    expect(t.outcome).toBe('refused')
  })

  // Audit ISSUE-040: sampling is rps-weighted — a trickle path must not trace as often as the
  // main path. With a 10 000:1 rps skew, ~200 samples should overwhelmingly follow the heavy
  // edge (uniform sampling would split them ~50/50).
  it('weights hop sampling by rps (ISSUE-040)', () => {
    const f = tracedFixture()
    // Second, near-idle downstream row beside the 100-rps main path.
    f.flows[f.apiInst].downstream.push(
      { dependencyId: 'dep-1', toInstanceId: f.pgInst, rps: 0.01, hopClass: 'same-az', blocked: true })
    const tracer = createTracer(createRng(7))
    for (let s = 1; s <= 200; s++) tracer.sample(f.flows, f.compiled, f.doc, s * 1000)
    const traces = tracer.getTraced({ level: 'globe' })
    const refused = traces.filter(t => t.outcome === 'refused').length
    expect(refused).toBeLessThanOrEqual(1)   // the 0.01-rps blocked edge is ~never drawn
  })

  // Audit ISSUE-039: with several populations feeding one region, traces are attributed by a
  // weighted draw over their rps — not always to the first region match.
  it('attributes traces across converging populations in proportion to rps (ISSUE-039)', () => {
    const f = tracedFixture()
    const tracer = createTracer(createRng(11))
    const feeding = [
      { populationId: 'pop-heavy', rps: 90 },
      { populationId: 'pop-light', rps: 10 },
    ]
    const counts = new Map<string, number>()
    for (let s = 1; s <= 300; s++) {
      tracer.sample(f.flows, f.compiled, f.doc, s * 1000, () => feeding)
    }
    // getTraced caps at 10 per scope; count across MANY windows via fresh tracers instead.
    for (let s = 1; s <= 300; s++) {
      const t = createTracer(createRng(s))
      t.sample(f.flows, f.compiled, f.doc, 1000, () => feeding)
      const [trace] = t.getTraced({ level: 'globe' })
      counts.set(trace.populationId!, (counts.get(trace.populationId!) ?? 0) + 1)
    }
    const heavy = counts.get('pop-heavy') ?? 0
    const light = counts.get('pop-light') ?? 0
    expect(heavy + light).toBe(300)
    expect(light).toBeGreaterThan(0)            // the light population is represented…
    expect(heavy).toBeGreaterThan(light * 4)    // …but ∝ its share (~90/10), not uniformly
  })

  it('samples at most one trace per scope per 1s window, keeping the last 10', () => {
    const f = tracedFixture()
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    tracer.sample(f.flows, f.compiled, f.doc, 1000)   // same window → no second trace
    expect(tracer.getTraced({ level: 'az', azId: f.az.id })).toHaveLength(1)
    for (let s = 2; s <= 14; s++) tracer.sample(f.flows, f.compiled, f.doc, s * 1000)
    const traces = tracer.getTraced({ level: 'az', azId: f.az.id })
    expect(traces).toHaveLength(10)                    // capped
    expect(traces[9].id).not.toBe(traces[0].id)        // oldest → newest, distinct ids
  })
})

describe('scopeKey', () => {
  it('keys every RenderScope level distinctly', () => {
    expect(scopeKey({ level: 'globe' })).toBe('globe')
    expect(scopeKey({ level: 'region', regionId: 'r1' })).toBe('region:r1')
    expect(scopeKey({ level: 'az', azId: 'a1' })).toBe('az:a1')
    expect(scopeKey({ level: 'server', serverId: 's1' })).toBe('server:s1')
  })
})

// node-model Phase 5.4: a managed DB hop used a flat 3ms constant, so a traced request through a
// saturated DB reported ~3ms while the metrics pyramid reported hundreds. The runtime's p50 is now
// threaded through so replay and live metrics agree.
describe('tracer — managed-DB hop latency (Phase 5.4)', () => {
  function managedFixture() {
    const f = tracedFixture()
    const msId = 'ms-db'
    f.doc.managedServices[msId] = {
      id: msId, label: 'orders-db', nodeType: 'dbSql',
      scope: { kind: 'az', azId: f.az.id }, provider: 'aws', port: 5432, instanceClassId: 'sql.small',
    } as WorldDoc['managedServices'][string]
    f.flows[f.apiInst].downstream = [
      { dependencyId: 'dep-db', toManagedServiceId: msId, rps: 100, hopClass: 'same-az', blocked: false },
    ]
    // The api no longer feeds pg, so pg would qualify as a second (hopless) entry and the tracer
    // could pick it. Drop it — this fixture is about the api → managed hop.
    delete f.flows[f.pgInst]
    return { ...f, msId }
  }

  it('uses the flat managed constant when no runtime is supplied', () => {
    const f = managedFixture()
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000)
    const hop = tracer.getTraced({ level: 'az', azId: f.az.id })[0].hops[0]
    expect(hop.latencyMs).toBeGreaterThan(0)
    expect(hop.latencyMs).toBeLessThan(MANAGED_SERVICE_LATENCY_MS + 5)   // + a small network hop
  })

  it('books the runtime p50 for a saturated managed DB', () => {
    const f = managedFixture()
    // 2400 rps of reads against a 2500 read ceiling ⇒ deep queueing, p50 far above 3ms.
    const rt = managedDbRuntimeFor(f.doc.managedServices[f.msId], 2400, 0)!
    expect(rt.p50Ms).toBeGreaterThan(50)
    const tracer = createTracer(createRng(42))
    tracer.sample(f.flows, f.compiled, f.doc, 1000, undefined, { [f.msId]: rt })
    const hop = tracer.getTraced({ level: 'az', azId: f.az.id })[0].hops[0]
    expect(hop.latencyMs).toBeGreaterThan(rt.p50Ms)   // service time + the network hop
  })
})
