import { describe, it, expect } from 'vitest'
import {
  KEEP_ALIVE_PROFILE, HANDSHAKE_MS, LINGER_MS, HANDSHAKE_CPU_MS, DEFAULT_HOLD_SEC,
  connectionClassOf, profileFor, resolveConnectionProfile, activeConnections,
} from './connectionModel'
import type { PacketRegistry, PacketTemplate } from './nodeConfig'

const reg = (templates: PacketTemplate[]): PacketRegistry => ({
  mode: 'generic',
  templates: Object.fromEntries(templates.map(t => [t.id, t])),
  nextId: templates.length + 1,
})

const http = (id: number, extra: Partial<PacketTemplate> = {}): PacketTemplate =>
  ({ id, name: `h${id}`, protocol: 'http', sizeKb: 1, method: 'GET', statusCode: 200, ...extra }) as PacketTemplate

describe('connectionClassOf — protocol wins for the non-http kinds', () => {
  it('reads an http template\'s authored connectionType', () => {
    expect(connectionClassOf(http(1, { connectionType: 'short-lived' } as never))).toBe('short-lived')
    expect(connectionClassOf(http(1, { connectionType: 'streaming' } as never))).toBe('streaming')
  })

  it('defaults an unauthored http template to keep-alive', () => {
    expect(connectionClassOf(http(1))).toBe('keep-alive')
  })

  it('treats a stream packet as streaming regardless of any http field', () => {
    const s = { id: 2, name: 's', protocol: 'stream', sizeKb: 1, streamId: 'x', compressionType: 'none' } as PacketTemplate
    expect(connectionClassOf(s)).toBe('streaming')
  })

  it('treats db and event packets as keep-alive (pooled / shared broker connections)', () => {
    const db = { id: 3, name: 'd', protocol: 'db', sizeKb: 1, queryType: 'read', isWAL: false, resultSizeKb: 2 } as PacketTemplate
    const ev = { id: 4, name: 'e', protocol: 'event', sizeKb: 1, topic: 't', eventType: 'x', deliveryMode: 'at-least-once' } as PacketTemplate
    expect(connectionClassOf(db)).toBe('keep-alive')
    expect(connectionClassOf(ev)).toBe('keep-alive')
  })

  it('treats an absent template as keep-alive', () => {
    expect(connectionClassOf(undefined)).toBe('keep-alive')
  })
})

describe('profileFor', () => {
  it('keep-alive is the zero-cost, fully latency-coupled identity', () => {
    expect(profileFor('keep-alive')).toEqual(KEEP_ALIVE_PROFILE)
    expect(KEEP_ALIVE_PROFILE).toEqual({ latencyShare: 1, fixedHoldSec: 0, extraHoldSec: 0, handshakeCpuMs: 0 })
  })

  it('short-lived adds the handshake + linger tail and handshake CPU', () => {
    const p = profileFor('short-lived')
    expect(p.latencyShare).toBe(1)
    expect(p.extraHoldSec).toBeCloseTo((HANDSHAKE_MS + LINGER_MS) / 1000, 12)
    expect(p.handshakeCpuMs).toBe(HANDSHAKE_CPU_MS)
    expect(p.fixedHoldSec).toBe(0)
  })

  it('streaming decouples from latency and uses the authored hold, defaulting to the constant', () => {
    expect(profileFor('streaming')).toEqual({
      latencyShare: 0, fixedHoldSec: DEFAULT_HOLD_SEC, extraHoldSec: 0, handshakeCpuMs: 0,
    })
    expect(profileFor('streaming', 60).fixedHoldSec).toBe(60)
  })

  it('ignores a non-finite or non-positive authored hold', () => {
    expect(profileFor('streaming', 0).fixedHoldSec).toBe(DEFAULT_HOLD_SEC)
    expect(profileFor('streaming', -5).fixedHoldSec).toBe(DEFAULT_HOLD_SEC)
    expect(profileFor('streaming', NaN).fixedHoldSec).toBe(DEFAULT_HOLD_SEC)
  })

  it('ignores holdSeconds for the latency-coupled classes', () => {
    expect(profileFor('keep-alive', 60)).toEqual(KEEP_ALIVE_PROFILE)
    expect(profileFor('short-lived', 60).fixedHoldSec).toBe(0)
  })
})

describe('activeConnections — THE formula', () => {
  it('keep-alive returns EXACTLY rps × latency/1000 (the regression floor)', () => {
    for (const [rps, ms] of [[100, 40], [3.7, 12.5], [0, 90], [12345, 1.25]]) {
      expect(activeConnections(rps, ms, KEEP_ALIVE_PROFILE)).toBe(rps * (ms / 1000))
    }
  })

  it('short-lived holds the connection for latency + handshake + linger', () => {
    const p = profileFor('short-lived')
    expect(activeConnections(100, 40, p)).toBeCloseTo(100 * ((40 + HANDSHAKE_MS + LINGER_MS) / 1000), 12)
    expect(activeConnections(100, 40, p)).toBeGreaterThan(activeConnections(100, 40, KEEP_ALIVE_PROFILE))
  })

  it('streaming ignores latency entirely', () => {
    const p = profileFor('streaming', 30)
    expect(activeConnections(10, 5, p)).toBe(300)
    expect(activeConnections(10, 5000, p)).toBe(300)
  })

  it('streaming decouples connections from throughput: low rps, huge connection count', () => {
    const ka = activeConnections(10, 5, KEEP_ALIVE_PROFILE)          // 0.05
    const st = activeConnections(10, 5, profileFor('streaming', 30)) // 300
    expect(st / ka).toBeGreaterThan(1000)
  })

  it('is guarded against a non-finite latency sample', () => {
    expect(activeConnections(10, NaN, KEEP_ALIVE_PROFILE)).toBe(0)
    expect(activeConnections(NaN, 10, KEEP_ALIVE_PROFILE)).toBe(0)
    expect(activeConnections(-5, 10, KEEP_ALIVE_PROFILE)).toBe(0)
  })
})

describe('resolveConnectionProfile — weighted blending over a mix', () => {
  it('an absent/empty mix falls back to keep-alive', () => {
    expect(resolveConnectionProfile(reg([]), undefined)).toEqual(KEEP_ALIVE_PROFILE)
    expect(resolveConnectionProfile(reg([]), [])).toEqual(KEEP_ALIVE_PROFILE)
  })

  it('honours an explicit fallback class when unbound', () => {
    expect(resolveConnectionProfile(reg([]), undefined, 'short-lived')).toEqual(profileFor('short-lived'))
  })

  it('a single-packet mix reproduces that packet\'s profile', () => {
    const r = reg([http(1, { connectionType: 'short-lived' } as never)])
    expect(resolveConnectionProfile(r, [{ packetId: 1, weight: 3 }])).toEqual(profileFor('short-lived'))
  })

  it('blends a 50/50 keep-alive + streaming mix into half of each', () => {
    const r = reg([
      http(1),
      http(2, { connectionType: 'streaming', holdSeconds: 30 } as never),
    ])
    const p = resolveConnectionProfile(r, [{ packetId: 1, weight: 1 }, { packetId: 2, weight: 1 }])
    expect(p.latencyShare).toBeCloseTo(0.5, 12)
    expect(p.fixedHoldSec).toBeCloseTo(15, 12)
    // 100 rps at 40 ms: half the calls hold for latency, half hold 30 s.
    expect(activeConnections(100, 40, p)).toBeCloseTo(100 * (0.5 * 0.04 + 15), 9)
  })

  it('blends handshake CPU proportionally to the short-lived share', () => {
    const r = reg([http(1), http(2, { connectionType: 'short-lived' } as never)])
    const p = resolveConnectionProfile(r, [{ packetId: 1, weight: 3 }, { packetId: 2, weight: 1 }])
    expect(p.handshakeCpuMs).toBeCloseTo(HANDSHAKE_CPU_MS * 0.25, 12)
    expect(p.extraHoldSec).toBeCloseTo(((HANDSHAKE_MS + LINGER_MS) / 1000) * 0.25, 12)
  })

  it('normalizes over weights that do not sum to 1', () => {
    const r = reg([http(1, { connectionType: 'streaming', holdSeconds: 10 } as never)])
    expect(resolveConnectionProfile(r, [{ packetId: 1, weight: 7 }]).fixedHoldSec).toBeCloseTo(10, 12)
  })

  it('ignores dangling ids and non-positive weights, falling through when nothing survives', () => {
    const r = reg([http(1, { connectionType: 'streaming' } as never)])
    expect(resolveConnectionProfile(r, [{ packetId: 99, weight: 1 }])).toEqual(KEEP_ALIVE_PROFILE)
    expect(resolveConnectionProfile(r, [{ packetId: 1, weight: 0 }])).toEqual(KEEP_ALIVE_PROFILE)
    expect(resolveConnectionProfile(r, [{ packetId: 1, weight: -2 }])).toEqual(KEEP_ALIVE_PROFILE)
  })

  it('a mix of only keep-alive packets is byte-identical to the identity', () => {
    const r = reg([http(1), http(2, { connectionType: 'keep-alive' } as never)])
    const p = resolveConnectionProfile(r, [{ packetId: 1, weight: 2 }, { packetId: 2, weight: 5 }])
    expect(p).toEqual(KEEP_ALIVE_PROFILE)
    expect(activeConnections(100, 40, p)).toBe(100 * 0.04)
  })
})
