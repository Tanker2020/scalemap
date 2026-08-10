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

  // Packet-driven CPU (slice 2): cpuMsPerKb is an optional, additive WorkloadProfile field —
  // round-trips when authored, and stays absent (⇒ 0 / flat pre-slice-2 behavior) when not.
  it('round-trips workload.cpuMsPerKb when authored, and leaves it undefined when not', () => {
    const world = createWorld()
    const bp = createBlueprint('api', 0)
    bp.workload.cpuMsPerKb = 0.75
    world.blueprints[bp.id] = bp
    const raw = serializeWorld(world, 'untitled', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world.blueprints[bp.id].workload.cpuMsPerKb).toBe(0.75)

    const bare = createWorld()
    const bareBp = createBlueprint('api2', 1)
    bare.blueprints[bareBp.id] = bareBp
    const rawBare = serializeWorld(bare, 'untitled', '2026-07-08T00:00:00.000Z')
    const parsedBare = deserializeWorld(rawBare)
    expect(parsedBare.world.blueprints[bareBp.id].workload.cpuMsPerKb).toBeUndefined()
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

  // Audit ISSUE-070: externally-authored files may carry `"version": 3` as a JSON number.
  // Same format — accept it; numeric 1/2 still land on their dedicated rejection messages.
  it('accepts a numeric version 3 and still rejects numeric 1/2 with their own messages', () => {
    const world = createWorld()
    const asNumber = JSON.parse(serializeWorld(world, 'n', '2026-07-19T00:00:00.000Z')) as { version: unknown }
    asNumber.version = 3
    const parsed = deserializeWorld(JSON.stringify(asNumber))
    expect(parsed.world).toEqual(world)
    expect(() => deserializeWorld(JSON.stringify({ version: 1 }))).toThrowError(/v1|older/i)
    expect(() => deserializeWorld(JSON.stringify({ version: 2 }))).toThrowError(/v2|node|typed/i)
  })

  // Audit ISSUE-069: normalization builds a NEW file object rather than writing defaults onto
  // the parsed input. The observable consequences pinned here: the vestigial LEGACY top-level
  // `packets` slot folds into world.packets and is NOT retained on the returned file.
  it('folds a legacy top-level packets slot into world.packets without retaining the slot', () => {
    const legacy = { mode: 'generic', templates: { 1: { id: 1, name: 'api', protocol: 'http', sizeKb: 1, method: 'GET', path: '/api/*', statusCode: 200 } }, nextId: 2 }
    const raw = JSON.stringify({
      version: '3',
      meta: { name: 'legacy-slot', created: '2026-07-19T00:00:00.000Z', modified: '2026-07-19T00:00:00.000Z' },
      packets: legacy,   // vestigial top-level slot — the running app never populated this
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [] },   // timing fields omitted
        populations: {}, regions: {}, azs: {},
        servers: { 's1': { id: 's1', label: 'bare-server', azId: 'az-1' } },   // no `rack` key
        blueprints: {}, placements: {}, managedServices: {},
        // racks / loadBalancers / world.packets / connectionLayout all omitted
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual(legacy)
    expect('packets' in parsed).toBe(false)   // the normalized copy drops the vestigial slot
    // The rest of the additive defaults land on the copy too.
    expect(parsed.world.racks).toEqual({})
    expect(parsed.world.servers['s1'].rack).toBeNull()
    expect(parsed.world.routing.dnsTtlSec).toBe(30)
  })

  it('round-trips a world.packets route catalog', () => {
    const world = createWorld()
    world.packets = { mode: 'generic', templates: { 1: { id: 1, name: 'api', protocol: 'http', sizeKb: 1, method: 'POST', path: '/api/*', statusCode: 200 } }, nextId: 2 }
    const raw = serializeWorld(world, 'routed', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual(world.packets)
    expect(parsed.world).toEqual(world)
  })

  it('a world with a scenario round-trips through serialize/deserialize intact', () => {
    const world = createWorld()
    world.scenario = { id: 's1', label: 'Test', seed: 42, durationMs: 60000, steps: [] }
    const serialized = serializeWorld(world, 'with-scenario', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(serialized)
    expect(parsed.world.scenario).toEqual(world.scenario)
  })

  it('a pre-feature v3 file with no scenario field still loads, scenario undefined', () => {
    const legacyV3 = JSON.stringify({
      version: '3',
      meta: { name: 'legacy', created: '2026-07-08T00:00:00.000Z', modified: '2026-07-08T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
      },
    })
    const parsed = deserializeWorld(legacyV3)
    expect(parsed.world.scenario).toBeUndefined()
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

  // Packet library: the deprecated single-slot packetTemplateId is folded into a 1-entry mix on
  // load, and — the regression floor — a document written before the library existed must come
  // back BIT-IDENTICAL, since that identity is what keeps the engine's byte totals unchanged.
  describe('packet-library normalization', () => {
    function depWorld(dep: Record<string, unknown>) {
      const world = createWorld()
      const bp = createBlueprint('api', 0)
      bp.dependencies = [{
        id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-db' },
        port: 5432, protocol: 'db', packetTemplateId: null, ...dep,
      } as never]
      world.blueprints[bp.id] = bp
      return { world, bpId: bp.id }
    }

    it('migrates a non-null packetTemplateId into a 1-entry packetMix', () => {
      const { world, bpId } = depWorld({ packetTemplateId: 7 })
      const parsed = deserializeWorld(serializeWorld(world, 'legacy', '2026-07-28T00:00:00.000Z'))
      expect(parsed.world.blueprints[bpId].dependencies[0].packetMix).toEqual([{ packetId: 7, weight: 1 }])
    })

    it('leaves an already-bound mix alone rather than clobbering it with the legacy slot', () => {
      const mix = [{ packetId: 3, weight: 2 }]
      const { world, bpId } = depWorld({ packetTemplateId: 7, packetMix: mix })
      const parsed = deserializeWorld(serializeWorld(world, 'both', '2026-07-28T00:00:00.000Z'))
      expect(parsed.world.blueprints[bpId].dependencies[0].packetMix).toEqual(mix)
    })

    it('REGRESSION FLOOR: a packetTemplateId-null world round-trips completely untouched', () => {
      const { world, bpId } = depWorld({})
      const parsed = deserializeWorld(serializeWorld(world, 'floor', '2026-07-28T00:00:00.000Z'))
      expect(parsed.world.blueprints[bpId].dependencies[0].packetMix).toBeUndefined()
      expect(parsed.world).toEqual(world)
    })

    it('leaves defaultPacket absent on load — absence IS the 2 KB convention', () => {
      const parsed = deserializeWorld(serializeWorld(createWorld(), 'd', '2026-07-28T00:00:00.000Z'))
      expect(parsed.world.packets.defaultPacket).toBeUndefined()
    })

    it('round-trips an authored defaultPacket and a bound route packetMix', () => {
      const world = createWorld()
      world.packets = {
        ...world.packets,
        defaultPacket: { reqKb: 8, respKb: 16 },
        templates: {
          1: { id: 1, name: 'r', protocol: 'http', method: 'GET', path: '/a', statusCode: 200, sizeKb: 1, packetMix: [{ packetId: 2, weight: 1 }] },
          2: { id: 2, name: 'q', protocol: 'db', sizeKb: 1, queryType: 'write', isWAL: true, resultSizeKb: 32 },
        },
        nextId: 3,
      }
      const parsed = deserializeWorld(serializeWorld(world, 'pk', '2026-07-28T00:00:00.000Z'))
      expect(parsed.world.packets).toEqual(world.packets)
    })
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

  it('a pre-feature v3 file with no network-topology collections loads with them defaulted to empty', () => {
    const legacy = {
      version: '3',
      meta: { name: 'x', created: '', modified: '' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
      },
    }
    const doc = deserializeWorld(JSON.stringify(legacy)).world
    expect(doc.vpcs).toEqual({})
    expect(doc.subnets).toEqual({})
    expect(doc.routeTables).toEqual({})
    expect(doc.internetGateways).toEqual({})
    expect(doc.natGateways).toEqual({})
    expect(doc.securityGroups).toEqual({})
  })
})
