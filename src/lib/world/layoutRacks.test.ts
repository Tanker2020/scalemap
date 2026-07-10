// src/lib/world/layoutRacks.test.ts
import { describe, it, expect } from 'vitest'
import { layoutRacks, U_PX, CHASSIS_W, RACK_PAD, RAIL_W, RACK_W, RACK_GAP, PDU_H, MANAGED_H } from './layoutRacks'
import type { Server } from './types'

// Minimal Server fixture — layoutRacks only reads .id/.label/.rack, so the rest of the
// Server shape is filled with harmless placeholder values (mirrors the factory's own
// createServer defaults closely enough without dragging in region/az/preset ceremony
// for a function that doesn't care about any of that).
function mkServer(id: string, rackId: string, unit: number, heightU: 1 | 2, label = id): Server {
  return {
    id, label, azId: 'az-1', kind: heightU === 2 ? 'dedicated' : 'vps', catalogId: null,
    specs: { vcpu: 2, threadsPerCore: 1, ramMb: 4096, diskGb: 40, nicMbps: 500 },
    hourlyUsd: 0.02, oversubscriptionRatio: null, burstable: false,
    firewall: [], stacks: [], rack: { rackId, unit, heightU },
  }
}

describe('layoutRacks', () => {
  it('groups servers into frames by rackId sorted by unit', () => {
    // rack-2's server authored FIRST in the input array — frames must still come out
    // rack-1 then rack-2 (sorted by rackId, not input order).
    const layout = layoutRacks([
      mkServer('r2-a', 'rack-2', 1, 1),
      mkServer('b', 'rack-1', 5, 1),
      mkServer('a', 'rack-1', 1, 1),
    ], [])
    expect(layout.frames.map(f => f.rackId)).toEqual(['rack-1', 'rack-2'])
    expect(layout.frames[0].serverIds).toEqual(['a', 'b'])   // sorted by unit ascending
    expect(layout.frames[1].serverIds).toEqual(['r2-a'])
    expect(layout.frames[0].box.x).toBe(0)
    expect(layout.frames[1].box.x).toBe(RACK_W + RACK_GAP)   // 316
    expect(layout.frames[0].box.y).toBe(0)
  })

  it('chassis height scales with heightU', () => {
    const layout = layoutRacks([
      mkServer('web-01', 'rack-1', 1, 1), mkServer('db-01', 'rack-1', 2, 2),
    ], [])
    expect(layout.chassis['web-01']).toEqual({ rackId: 'rack-1', x: RACK_PAD + RAIL_W, y: 10, w: CHASSIS_W, h: U_PX })
    expect(layout.chassis['db-01']).toEqual({ rackId: 'rack-1', x: RACK_PAD + RAIL_W, y: 58, w: CHASSIS_W, h: 2 * U_PX })
  })

  it('duplicate units re-stack without overlap', () => {
    // Mirrors factories.createServer's own default (rack.unit is ALWAYS 1) — this is the
    // common case in practice, not a contrived edge case.
    const layout = layoutRacks([
      mkServer('a', 'rack-1', 1, 1), mkServer('b', 'rack-1', 1, 1), mkServer('c', 'rack-1', 1, 1),
    ], [])
    expect(layout.chassis['a'].y).toBe(10)
    expect(layout.chassis['b'].y).toBe(58)
    expect(layout.chassis['c'].y).toBe(106)
    expect(layout.chassis['b'].y).toBeGreaterThanOrEqual(layout.chassis['a'].y + layout.chassis['a'].h)
    expect(layout.chassis['c'].y).toBeGreaterThanOrEqual(layout.chassis['b'].y + layout.chassis['b'].h)
  })

  it('blank fillers appear in unit gaps, capped at 3 per frame', () => {
    // 5 servers, each separated by a 1-unit gap -> 4 real gaps, only 3 fillers rendered.
    const layout = layoutRacks([
      mkServer('a', 'rack-1', 1, 1), mkServer('b', 'rack-1', 3, 1), mkServer('c', 'rack-1', 5, 1),
      mkServer('d', 'rack-1', 7, 1), mkServer('e', 'rack-1', 9, 1),
    ], [])
    expect(layout.frames[0].blankUnits).toHaveLength(3)
    expect(layout.frames[0].blankUnits[0]).toEqual({ y: 58, h: U_PX })
  })

  it('pdu sits below last chassis', () => {
    const layout = layoutRacks([
      mkServer('web-01', 'rack-1', 1, 1), mkServer('db-01', 'rack-1', 2, 2),
    ], [])
    const last = layout.chassis['db-01']
    expect(layout.frames[0].pduY).toBe(last.y + last.h + RACK_PAD)   // 58+88+10 = 156
    expect(layout.frames[0].box.h).toBe(layout.frames[0].pduY + PDU_H + RACK_PAD)
  })

  it('managed column right of all frames', () => {
    const layout = layoutRacks([
      mkServer('s1', 'rack-1', 1, 1), mkServer('s2', 'rack-2', 1, 1),
    ], ['m1', 'm2'])
    const expectedX = 1 * (RACK_W + RACK_GAP) + RACK_W + RACK_GAP   // (n-1)*316 + 256 + 60 = 632
    expect(layout.managed['m1']).toEqual({ x: expectedX, y: 0 })
    expect(layout.managed['m2']).toEqual({ x: expectedX, y: MANAGED_H + 20 })
  })

  it('deterministic output; empty AZ still lays out managed services', () => {
    expect(layoutRacks([], [])).toEqual({ frames: [], chassis: {}, managed: {} })
    const empty = layoutRacks([], ['m1'])
    expect(empty.frames).toEqual([])
    expect(empty.managed['m1']).toEqual({ x: 0, y: 0 })
    const a = layoutRacks([mkServer('a', 'rack-1', 1, 1)], ['m1'])
    const b = layoutRacks([mkServer('a', 'rack-1', 1, 1)], ['m1'])
    expect(a).toEqual(b)
  })
})
