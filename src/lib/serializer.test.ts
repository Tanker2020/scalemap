import { describe, it, expect } from 'vitest'
import { serializeWorld, deserializeWorld } from './serializer'
import { createWorld, createRegion, createAz, createServer, createRack } from './world/factories'

describe('scalemap v2 serializer', () => {
  it('round-trips a world document with meta and viewState', () => {
    const world = createWorld()
    const region = createRegion('us-east-1')
    world.regions[region.id] = region
    const raw = serializeWorld(world, 'my-world', '2026-07-08T00:00:00.000Z', undefined, { level: 'region', regionId: region.id })
    const parsed = deserializeWorld(raw)
    expect(parsed.version).toBe('2')
    expect(parsed.meta.name).toBe('my-world')
    expect(parsed.meta.created).toBe('2026-07-08T00:00:00.000Z')
    expect(parsed.world.regions[region.id].catalogId).toBe('us-east-1')
    expect(parsed.viewState).toEqual({ level: 'region', regionId: region.id })
  })

  it('rejects v1 files with a message that names the old format', () => {
    const v1 = JSON.stringify({ version: '1', meta: {}, viewport: {}, nodes: [], edges: [] })
    expect(() => deserializeWorld(v1)).toThrowError(/v1|older/i)
  })

  it('rejects unknown versions and malformed shapes', () => {
    expect(() => deserializeWorld(JSON.stringify({ version: '3' }))).toThrowError(/version/i)
    expect(() => deserializeWorld(JSON.stringify({ version: '2' }))).toThrowError(/world/i)
    expect(() => deserializeWorld('not json')).toThrow()
  })

  it('rejects a world document missing required collections', () => {
    const malformed = JSON.stringify({ version: '2', meta: { name: 'x', created: '', modified: '' }, world: { regions: {} } })
    expect(() => deserializeWorld(malformed)).toThrowError(/world/i)
  })

  it('round-trips a full createWorld() document unmodified', () => {
    const world = createWorld()
    const raw = serializeWorld(world, 'untitled', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world).toEqual(world)
  })

  it('a v2 file without racks loads with {} and servers without rack load as null', () => {
    // Simulates a pre-Polish-3 file: no `racks` collection at all, and this server's
    // `rack` key is entirely absent (not merely null) from its JSON — the shape any file
    // saved before racks existed would have.
    const raw = JSON.stringify({
      version: '2',
      meta: { name: 'legacy', created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        traffic: { autoBaseline: true, baselineTotalRps: 1000 },
        populations: {}, regions: {}, azs: {},
        servers: { 's1': { id: 's1', label: 'legacy-server', azId: 'az-1' } },
        blueprints: {}, placements: {}, managedServices: {},
        // no `racks` key
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.racks).toEqual({})
    expect(parsed.world.servers['s1'].rack).toBeNull()
  })

  it('a v2 file without loadBalancers loads with {} (pre-LB back-compat)', () => {
    // Simulates a file saved before the regional load balancer existed: no `loadBalancers`
    // key. compileWorld synthesizes a default LB per region, so behavior is unchanged.
    const raw = JSON.stringify({
      version: '2',
      meta: { name: 'legacy', created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        traffic: { autoBaseline: true, baselineTotalRps: 1000 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
        racks: {},
        // no `loadBalancers` key
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.loadBalancers).toEqual({})
  })

  it('a v2 file without packets loads with an empty registry (pre-route back-compat)', () => {
    const raw = JSON.stringify({
      version: '2',
      meta: { name: 'legacy', created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z' },
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        traffic: { autoBaseline: true, baselineTotalRps: 1000 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
        racks: {}, loadBalancers: {},
        // no `packets` key
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual({ mode: 'generic', templates: {}, nextId: 1 })
  })

  it('folds a legacy top-level packets slot into world.packets', () => {
    // Any file that DID carry the vestigial top-level `packets` sibling must not lose its routes.
    const legacyPackets = { mode: 'custom', templates: { 5: { id: 5, name: 'api', protocol: 'http', sizeKb: 2, method: 'GET', path: '/api/*', statusCode: 200 } }, nextId: 6 }
    const raw = JSON.stringify({
      version: '2',
      meta: { name: 'legacy', created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z' },
      packets: legacyPackets,
      world: {
        routing: { policy: 'latency', weights: {}, priorityOrder: [], healthCheckIntervalMs: 10_000, healthCheckFailureThreshold: 3, dnsTtlSec: 30 },
        traffic: { autoBaseline: true, baselineTotalRps: 1000 },
        populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {},
        racks: {}, loadBalancers: {},
        // no world.packets — the legacy top-level slot is the only carrier
      },
    })
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual(legacyPackets)
  })

  it('round-trips a world.packets route catalog', () => {
    const world = createWorld()
    world.packets = { mode: 'generic', templates: { 1: { id: 1, name: 'api', protocol: 'http', sizeKb: 1, method: 'POST', path: '/api/*', statusCode: 200 } }, nextId: 2 }
    const raw = serializeWorld(world, 'routed', '2026-07-08T00:00:00.000Z')
    const parsed = deserializeWorld(raw)
    expect(parsed.world.packets).toEqual(world.packets)
    expect(parsed.world).toEqual(world)
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
