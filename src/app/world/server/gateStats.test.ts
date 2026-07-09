// src/app/world/server/gateStats.test.ts
import { describe, it, expect } from 'vitest'
import { blockedPerSecond } from './gateStats'
import type { EngineEvent } from '../../../lib/worldEngine/types'

const ev = (simMs: number, affected: string[], kind: EngineEvent['kind'] = 'connection_refused'): EngineEvent =>
  ({ id: `${simMs}-${affected.join()}`, simMs, kind, severity: 'warning', message: '', affected })

describe('blockedPerSecond', () => {
  it('counts a refused event whose affected contains a resident instance id (real engine shape)', () => {
    // The engine puts source+target INSTANCE ids in `affected`, never the serverId.
    const events = [
      ev(9000, ['pl-7-abc#0', 'pl-8-xyz#0']),
      ev(9500, ['pl-7-abc#0', 'pl-9-def#0']),
      ev(9800, ['pl-99-other#0', 'pl-8-xyz#0']), // neither end resident at srv-1
      ev(9900, ['pl-7-abc#0'], 'oom_kill'),      // wrong kind
    ]
    // window (5000, 10000], 5s → 2 events touch resident pl-7-abc#0 → 2 / 5 = 0.4
    expect(blockedPerSecond(events, 'srv-1', ['pl-7-abc#0'], 10000)).toBeCloseTo(0.4)
  })

  it('still counts an event whose affected contains the serverId directly (defensive)', () => {
    const events = [ev(9000, ['srv-1']), ev(9500, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', ['pl-7-abc#0'], 10000)).toBeCloseTo(0.4)
  })

  it('does not count an event whose affected contains neither the serverId nor any resident id', () => {
    const events = [ev(9000, ['pl-99-other#0', 'pl-100-other#0'])]
    expect(blockedPerSecond(events, 'srv-1', ['pl-7-abc#0'], 10000)).toBe(0)
  })

  it('returns 0 outside the window', () => {
    const events = [ev(1000, ['pl-7-abc#0']), ev(2000, ['pl-7-abc#0'])]
    expect(blockedPerSecond(events, 'srv-1', ['pl-7-abc#0'], 10000)).toBe(0)
  })

  it('scales to per-second by the window width', () => {
    const events = [ev(9000, ['pl-7-abc#0']), ev(9200, ['pl-7-abc#0']), ev(9400, ['pl-7-abc#0'])]
    expect(blockedPerSecond(events, 'srv-1', ['pl-7-abc#0'], 10000, 2000)).toBeCloseTo(1.5)   // 3 / (2000/1000)
  })
})
