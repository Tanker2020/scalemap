import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, BLUEPRINT_COLORS } from './factories'

describe('world factories', () => {
  it('creates an empty world with sane routing defaults', () => {
    const w = createWorld()
    expect(w.routing.policy).toBe('latency')
    expect(w.routing.healthCheckIntervalMs).toBe(10_000)
    expect(w.routing.dnsTtlSec).toBe(30)
    expect(Object.keys(w.regions)).toHaveLength(0)
    expect(w.traffic.autoBaseline).toBe(true)
  })

  it('creates linked region → az → server with default-internal firewall', () => {
    const region = createRegion('us-east-1')
    const az = createAz(region.id, 'us-east-1a')
    const server = createServer(az.id, {
      id: 'vps-medium', kind: 'vps',
      specs: { vcpu: 4, threadsPerCore: 2, ramMb: 8192, diskGb: 80, nicMbps: 1000 },
      hourlyUsd: 0.04, oversubscriptionRatio: 4, burstable: true,
    })
    expect(az.regionId).toBe(region.id)
    expect(server.azId).toBe(az.id)
    expect(server.kind).toBe('vps')
    expect(server.oversubscriptionRatio).toBe(4)
    expect(server.firewall).toHaveLength(1)
    expect(server.firewall[0]).toMatchObject({ action: 'allow', port: 'any', source: 'internal' })
  })

  it('assigns cycling signature colors to blueprints', () => {
    const a = createBlueprint('api', 0)
    const b = createBlueprint('db', 1)
    expect(a.color).toBe(BLUEPRINT_COLORS[0])
    expect(b.color).toBe(BLUEPRINT_COLORS[1])
    expect(createBlueprint('x', BLUEPRINT_COLORS.length).color).toBe(BLUEPRINT_COLORS[0])
  })

  it('creates placements defaulting to a single process instance', () => {
    const p = createPlacement('bp-1', 'srv-1')
    expect(p).toMatchObject({ blueprintId: 'bp-1', serverId: 'srv-1', count: 1, role: 'primary', runtime: { type: 'process' } })
  })

  it('generates unique ids', () => {
    const ids = new Set([createRegion('us-east-1').id, createRegion('us-east-1').id, createRegion('us-east-1').id])
    expect(ids.size).toBe(3)
  })
})
