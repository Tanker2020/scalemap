import { describe, it, expect } from 'vitest'
import { serializeWorld, deserializeWorld } from './serializer'
import { createWorld, createRegion, createAz, createServer, createRack, createBlueprint } from './world/factories'

describe('scalemap v3 serializer', () => {
  it('round-trips a world document with meta and viewState', () => {
    const world = createWorld()
    const region = createRegion('us-east-1')
    world.regions[region.id] = region
    const raw = serializeWorld(world, 'my-world', '2026-07-08T00:00:00.000Z', undefined, { level: 'region', regionId: region.id })
    const parsed = deserializeWorld(raw)
    expect(parsed.version).toBe('3')
    expect(parsed.meta.name).toBe('my-world')
    expect(parsed.meta.created).toBe('2026-07-08T00:00:00.000Z')
    expect(parsed.world.regions[region.id].catalogId).toBe('us-east-1')
    expect(parsed.viewState).toEqual({ level: 'region', regionId: region.id })
  })

  it('rejects v1 files with a message that names the old format', () => {
    const v1 = JSON.stringify({ version: '1', meta: {}, viewport: {}, nodes: [], edges: [] })
    expect(() => deserializeWorld(v1)).toThrowError(/v1|older/i)
  })

  // node-model Phase 5 — clean breaking change. Every world saved before the typed-node redesign
  // is version '2' and is rejected outright (no auto-migration), the same way v1 was rejected when
  // the world model shipped. The message must name the node model so the user understands WHY.
  it('rejects v2 (pre-typed-node) files with a message that names the node model', () => {
    const v2 = JSON.stringify({
      version: '2',
      meta: { name: 'legacy', created: '2026-07-08T00:00:00.000Z', modified: '2026-07-08T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
        racks: {}, loadBalancers: {},
      },
    })
    // Rejected at the version gate BEFORE the world-shape check — even a structurally-complete v2
    // world is refused, because v2 predates the typed-node model.
    expect(() => deserializeWorld(v2)).toThrowError(/v2|node|typed/i)
  })

  it('rejects unknown versions and malformed shapes', () => {
    // A version we have never shipped.
    expect(() => deserializeWorld(JSON.stringify({ version: '4' }))).toThrowError(/version/i)
    // The current version, but with no world document at all — a shape error, not a version error.
    expect(() => deserializeWorld(JSON.stringify({ version: '3' }))).toThrowError(/world/i)
    expect(() => deserializeWorld('not json')).toThrow()
  })

  it('rejects a world document missing required collections', () => {
    const malformed = JSON.stringify({ version: '3', meta: { name: 'x', created: '', modified: '' }, world: { regions: {} } })
    expect(() => deserializeWorld(malformed)).toThrowError(/world/i)
  })

  it('round-trips a full createWorld() document unmodified', () => {
    const world = createWorld()
    const raw = serializeWorld(world, 'untitled', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world).toEqual(world)
  })

  // The additive-normalization block survives the v3 cutover as DEFENSIVE insurance for a
  // hand-authored or partially-constructed v3 file: the serializer itself always writes the full
  // WorldDoc, so a file it produced can never miss these — but a file authored by hand (or by a
  // forward-compat tool) that omits an additive collection still loads with sensible defaults
  // rather than crashing.
  it('a v3 file without racks loads with {} and servers without rack load as null', () => {
    const raw = JSON.stringify({
      version: '3',
      meta: { name: 'partial', created: '2026-07-19T00:00:00.000Z', modified: '2026-07-19T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        populations: {}, regions: {}, azs: {},
        servers: { 's1': { id: 's1', label: 'bare-server', azId: 'az-1' } },
        blueprints: {}, placements: {}, managedServices: {},
        // no `racks` key
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.racks).toEqual({})
    expect(parsed.world.servers['s1'].rack).toBeNull()
  })

  it('a v3 file without loadBalancers loads with {}', () => {
    const raw = JSON.stringify({
      version: '3',
      meta: { name: 'partial', created: '2026-07-19T00:00:00.000Z', modified: '2026-07-19T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
        racks: {},
        // no `loadBalancers` key
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.loadBalancers).toEqual({})
  })

  it('a v3 file without packets loads with an empty registry', () => {
    const raw = JSON.stringify({
      version: '3',
      meta: { name: 'partial', created: '2026-07-19T00:00:00.000Z', modified: '2026-07-19T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
        racks: {}, loadBalancers: {},
        // no `packets` key
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual({ mode: 'generic', templates: {}, nextId: 1 })
  })

  it('round-trips a world.packets route catalog', () => {
    const world = createWorld()
    world.packets = { mode: 'generic', templates: { 1: { id: 1, name: 'api', protocol: 'http', sizeKb: 1, method: 'POST', path: '/api/*', statusCode: 200 } }, nextId: 2 }
    const raw = serializeWorld(world, 'routed', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual(world.packets)
    expect(parsed.world).toEqual(world)
  })

  // node-model Phase 3: writeFraction rides inside a blueprint's dependency, so it needs no
  // dedicated serializer handling — but pin the round-trip so a future serializer change can't
  // silently drop it.
  it('round-trips a dependency writeFraction', () => {
    const world = createWorld()
    const bp = createBlueprint('api', 0)
    bp.dependencies = [{
      id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-db' },
      port: 5432, protocol: 'db', packetTemplateId: null, writeFraction: 0.35,
    }]
    world.blueprints[bp.id] = bp
    const parsed = deserializeWorld(serializeWorld(world, 'wf', '2026-07-19T00:00:00.000Z'))
    expect(parsed.world.blueprints[bp.id].dependencies[0].writeFraction).toBe(0.35)
  })

  // audit ISSUE-012: the boundary must reject present-but-invalid values (a string hourlyUsd
  // poisons computeWorldCost into NaN; an unknown policy left routing scores undefined) while
  // keeping the defensive leniency for MISSING additive fields tested above.
  describe('boundary validation (audit ISSUE-012)', () => {
    function v3With(mutate: (data: { world: Record<string, unknown> }) => void): string {
      const data = JSON.parse(serializeWorld(createWorld(), 'x', '2026-07-22T00:00:00.000Z')) as { world: Record<string, unknown> }
      mutate(data)
      return JSON.stringify(data)
    }
    const server = (over: Record<string, unknown>) => ({
      id: 's1', label: 'bad-server', azId: 'az-1', rack: null,
      specs: { vcpu: 2, threadsPerCore: 1, ramMb: 2048, diskGb: 40, nicMbps: 1000 },
      hourlyUsd: 0.04, ...over,
    })

    it('rejects a server whose hourlyUsd is not a finite number', () => {
      const raw = v3With(d => { (d.world.servers as Record<string, unknown>)['s1'] = server({ hourlyUsd: 'abc' }) })
      expect(() => deserializeWorld(raw)).toThrowError(/hourlyUsd/i)
    })

    it('rejects a server whose specs carry non-finite numbers', () => {
      const raw = v3With(d => {
        (d.world.servers as Record<string, unknown>)['s1'] =
          server({ specs: { vcpu: 2, threadsPerCore: 1, ramMb: 'lots', diskGb: 40, nicMbps: 1000 } })
      })
      expect(() => deserializeWorld(raw)).toThrowError(/ramMb/i)
    })

    it('rejects an unknown routing policy', () => {
      const raw = v3With(d => { (d.world.routing as Record<string, unknown>).policy = 'nonsense' })
      expect(() => deserializeWorld(raw)).toThrowError(/policy/i)
    })

    it('rejects non-finite routing timing fields', () => {
      const raw = v3With(d => { (d.world.routing as Record<string, unknown>).dnsTtlSec = 'forever' })
      expect(() => deserializeWorld(raw)).toThrowError(/dnsTtlSec/i)
    })

    it('defaults missing routing timing fields instead of loading undefined', () => {
      const raw = v3With(d => {
        const routing = d.world.routing as Record<string, unknown>
        delete routing.dnsTtlSec
        delete routing.healthCheckIntervalMs
        delete routing.healthCheckFailureThreshold
      })
      const parsed = deserializeWorld(raw)
      expect(parsed.world.routing.dnsTtlSec).toBe(30)
      expect(parsed.world.routing.healthCheckIntervalMs).toBe(10_000)
      expect(parsed.world.routing.healthCheckFailureThreshold).toBe(3)
    })
  })

  it('round-trips racks and a null server.rack', () => {
    const world = createWorld()
    const region = createRegion('us-east-1')
    world.regions[region.id] = region
    const az = createAz(region.id, 'us-east-1a')
    world.azs[az.id] = az
    const server = createServer(az.id, {
      id: 'vps-medium', kind: 'vps',
      specs: { vcpu: 4, threadsPerCore: 2, ramMb: 8192, diskGb: 80, nicMbps: 1000 },
      hourlyUsd: 0.04, oversubscriptionRatio: 4, burstable: true,
    })
    world.servers[server.id] = server   // rack: null
    const rack = createRack(az.id, 'rack-1')
    world.racks[rack.id] = rack

    const raw = serializeWorld(world, 'racked-world', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world.racks).toEqual(world.racks)
    expect(parsed.world.servers[server.id].rack).toBeNull()
    expect(parsed.world).toEqual(world)
  })
})
