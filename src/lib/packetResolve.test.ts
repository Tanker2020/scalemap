import { describe, it, expect } from 'vitest'
import { addPacket, addRoute, emptyPacketRegistry } from './nodeConfig'
import type { PacketFields, PacketRegistry } from './nodeConfig'
import {
  resolveWireSize, routeIngressBytes, pickPacketByIndex,
  DEFAULT_PACKET_BYTES_EACH_WAY, WAL_WRITE_AMPLIFICATION,
} from './packetResolve'

const KB = 1024

// Seed a registry with named packets, returning the registry plus a name → id map.
function seed(...packets: PacketFields[]): { reg: PacketRegistry; id: Record<string, number> } {
  let reg = emptyPacketRegistry()
  const id: Record<string, number> = {}
  for (const p of packets) {
    const r = addPacket(reg, p)
    reg = r.registry
    id[p.name] = r.packet.id
  }
  return { reg, id }
}

const httpPacket = (name: string, sizeKb: number, responseSizeKb?: number, over: Partial<PacketFields> = {}): PacketFields =>
  ({ name, protocol: 'http', method: 'POST', statusCode: 200, sizeKb, responseSizeKb, ...over }) as PacketFields

const dbPacket = (name: string, over: Partial<{ sizeKb: number; resultSizeKb: number; queryType: 'read' | 'write' | 'transaction'; isWAL: boolean }> = {}): PacketFields =>
  ({
    name, protocol: 'db', sizeKb: over.sizeKb ?? 1, resultSizeKb: over.resultSizeKb ?? 64,
    queryType: over.queryType ?? 'read', isWAL: over.isWAL ?? false,
  }) as PacketFields

describe('resolveWireSize — the four-tier fallback', () => {
  it('tier 4: nothing authored anywhere ⇒ the historical 2 KB each way, sigma 0', () => {
    const w = resolveWireSize(emptyPacketRegistry(), undefined)
    expect(w).toEqual({
      reqBytes: DEFAULT_PACKET_BYTES_EACH_WAY, respBytes: DEFAULT_PACKET_BYTES_EACH_WAY,
      sizeKb: 2, sigma: 0, amplification: 1,
    })
    expect(w.writeFraction).toBeUndefined()
  })

  it('tier 3: registry defaultPacket supersedes the 2 KB constant', () => {
    const reg = { ...emptyPacketRegistry(), defaultPacket: { reqKb: 8, respKb: 32 } }
    expect(resolveWireSize(reg, undefined)).toMatchObject({ reqBytes: 8 * KB, respBytes: 32 * KB, sizeKb: 8 })
  })

  it('tier 2: inline sizes supersede the registry default, per leg independently', () => {
    const reg = { ...emptyPacketRegistry(), defaultPacket: { reqKb: 8, respKb: 32 } }
    expect(resolveWireSize(reg, undefined, 1)).toMatchObject({ reqBytes: 1 * KB, respBytes: 32 * KB })
    expect(resolveWireSize(reg, undefined, undefined, 4)).toMatchObject({ reqBytes: 8 * KB, respBytes: 4 * KB })
  })

  it('tier 1: a bound mix supersedes inline sizes entirely', () => {
    const { reg, id } = seed(httpPacket('blob', 5000, 1))
    const w = resolveWireSize(reg, [{ packetId: id.blob, weight: 1 }], 1, 1)
    expect(w).toMatchObject({ reqBytes: 5000 * KB, respBytes: 1 * KB, sizeKb: 5000 })
  })

  it('takes the WEIGHTED MEAN across a multi-packet mix', () => {
    const { reg, id } = seed(httpPacket('small', 10, 10), httpPacket('big', 110, 210))
    // 3:1 small:big ⇒ req (3×10 + 1×110)/4 = 35 KB, resp (3×10 + 1×210)/4 = 60 KB
    const w = resolveWireSize(reg, [{ packetId: id.small, weight: 3 }, { packetId: id.big, weight: 1 }])
    expect(w.reqBytes).toBeCloseTo(35 * KB)
    expect(w.respBytes).toBeCloseTo(60 * KB)
    expect(w.sizeKb).toBeCloseTo(35)
  })

  it('sigma is the weighted mean of the mix\'s size variance', () => {
    const { reg, id } = seed(httpPacket('calm', 1, 1, { sizeVariance: 0 }), httpPacket('bursty', 1, 1, { sizeVariance: 1 }))
    expect(resolveWireSize(reg, [{ packetId: id.calm, weight: 1 }, { packetId: id.bursty, weight: 1 }]).sigma).toBeCloseTo(0.5)
  })

  it('ignores zero/negative-weight and dangling entries, and falls through when nothing survives', () => {
    const { reg, id } = seed(httpPacket('a', 100, 100))
    const w = resolveWireSize(reg, [{ packetId: id.a, weight: 0 }, { packetId: 999, weight: 5 }], 7, 9)
    expect(w).toMatchObject({ reqBytes: 7 * KB, respBytes: 9 * KB })
  })

  it('a packet with no responseSizeKb falls through to the default for the RESPONSE leg only', () => {
    const { reg, id } = seed(httpPacket('req-only', 40))
    const w = resolveWireSize(reg, [{ packetId: id['req-only'], weight: 1 }])
    expect(w).toMatchObject({ reqBytes: 40 * KB, respBytes: DEFAULT_PACKET_BYTES_EACH_WAY })
  })
})

describe('resolveWireSize — db semantics', () => {
  it('a db packet answers with resultSizeKb, not responseSizeKb', () => {
    const { reg, id } = seed(dbPacket('read', { sizeKb: 2, resultSizeKb: 512 }))
    expect(resolveWireSize(reg, [{ packetId: id.read, weight: 1 }])).toMatchObject({ reqBytes: 2 * KB, respBytes: 512 * KB })
  })

  it('derives writeFraction from queryType — write and transaction both count as writes', () => {
    const { reg, id } = seed(
      dbPacket('r', { queryType: 'read' }), dbPacket('w', { queryType: 'write' }), dbPacket('tx', { queryType: 'transaction' }),
    )
    const mix = [{ packetId: id.r, weight: 2 }, { packetId: id.w, weight: 1 }, { packetId: id.tx, weight: 1 }]
    expect(resolveWireSize(reg, mix).writeFraction).toBeCloseTo(0.5)
  })

  it('leaves writeFraction UNDEFINED when the mix carries no db packet (the edge keeps its own)', () => {
    const { reg, id } = seed(httpPacket('call', 4, 4))
    expect(resolveWireSize(reg, [{ packetId: id.call, weight: 1 }]).writeFraction).toBeUndefined()
  })

  it('non-db packets in a db mix dilute the write fraction (they are calls that do not mutate)', () => {
    const { reg, id } = seed(dbPacket('w', { queryType: 'write' }), httpPacket('call', 4, 4))
    const mix = [{ packetId: id.w, weight: 1 }, { packetId: id.call, weight: 3 }]
    expect(resolveWireSize(reg, mix).writeFraction).toBeCloseTo(0.25)
  })

  it('isWAL raises write amplification; a non-WAL / non-db mix stays at 1', () => {
    const { reg, id } = seed(dbPacket('wal', { isWAL: true }), dbPacket('plain', { isWAL: false }))
    expect(resolveWireSize(reg, [{ packetId: id.wal, weight: 1 }]).amplification).toBe(WAL_WRITE_AMPLIFICATION)
    expect(resolveWireSize(reg, [{ packetId: id.plain, weight: 1 }]).amplification).toBe(1)
    // half-and-half ⇒ the mean of 2 and 1
    expect(resolveWireSize(reg, [{ packetId: id.wal, weight: 1 }, { packetId: id.plain, weight: 1 }]).amplification).toBeCloseTo(1.5)
  })
})

describe('routeIngressBytes (unchanged behavior, moved from nodeConfig)', () => {
  it('reads sizeKb / responseSizeKb off the route', () => {
    const { route } = addRoute(emptyPacketRegistry(), { name: 'img', method: 'GET', path: '/img', sizeKb: 3, responseSizeKb: 10 })
    expect(routeIngressBytes(route)).toEqual({ reqBytes: 3072, respBytes: 10240 })
  })

  it('falls back to 2 KB each way when the route is absent (the implicit default route)', () => {
    expect(routeIngressBytes(undefined)).toEqual({ reqBytes: 2048, respBytes: 2048 })
  })

  it('falls back to 2 KB for the response when only the request size is authored', () => {
    const route = { id: 1, name: 'api', protocol: 'http' as const, sizeKb: 1, method: 'GET' as const, path: '/api', statusCode: 200 }
    expect(routeIngressBytes(route)).toEqual({ reqBytes: 1024, respBytes: 2048 })
  })
})

describe('pickPacketByIndex — deterministic, rng-free particle tinting', () => {
  it('returns null for an empty or all-zero-weight mix', () => {
    expect(pickPacketByIndex(undefined, 0)).toBeNull()
    expect(pickPacketByIndex([], 3)).toBeNull()
    expect(pickPacketByIndex([{ packetId: 7, weight: 0 }], 3)).toBeNull()
  })

  it('is a pure function of the index — same k, same packet, every call', () => {
    const mix = [{ packetId: 1, weight: 1 }, { packetId: 2, weight: 3 }]
    for (const k of [0, 1, 5, 63, 64, 1000]) {
      expect(pickPacketByIndex(mix, k)).toBe(pickPacketByIndex(mix, k))
    }
  })

  it('distributes indices in proportion to the weights', () => {
    const mix = [{ packetId: 1, weight: 1 }, { packetId: 2, weight: 3 }]
    const picks = Array.from({ length: 64 }, (_, k) => pickPacketByIndex(mix, k))
    expect(picks.filter(p => p === 1).length).toBe(16)
    expect(picks.filter(p => p === 2).length).toBe(48)
  })

  it('handles negative indices without falling off the pattern', () => {
    expect(pickPacketByIndex([{ packetId: 4, weight: 1 }], -3)).toBe(4)
  })
})

describe('pickPacketByIndex — interleaving (why the radical inverse)', () => {
  it('samples the minority packet within the FIRST FEW indices, not after the majority block', () => {
    // 3:1 — a linear k/N mapping would put the minority packet at index 48 of 64, so a hop
    // rendering 4 particles would render four identical ones and the mix would look 100:0.
    const mix = [{ packetId: 1, weight: 3 }, { packetId: 2, weight: 1 }]
    const firstFour = [0, 1, 2, 3].map(k => pickPacketByIndex(mix, k))
    expect(new Set(firstFour).size).toBe(2)
  })
})
