import { describe, it, expect } from 'vitest'
import { serializeWorld, deserializeWorld } from './serializer'
import { createWorld, createRegion } from './world/factories'

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
})
