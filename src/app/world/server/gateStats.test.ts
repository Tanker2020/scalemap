// src/app/world/server/gateStats.test.ts
import { describe, it, expect } from 'vitest'
import { blockedPerSecond } from './gateStats'
import type { EngineEvent } from '../../../lib/worldEngine/types'

const ev = (simMs: number, affected: string[], kind: EngineEvent['kind'] = 'connection_refused'): EngineEvent =>
  ({ id: `${simMs}-${affected.join()}`, simMs, kind, severity: 'warning', message: '', affected })

describe('blockedPerSecond', () => {
  it('counts only this server refused events in the window', () => {
    const events = [
      ev(9000, ['srv-1']), ev(9500, ['srv-1']), ev(9800, ['srv-2']),
      ev(9900, ['srv-1'], 'oom_kill'),
    ]
    // window (5000, 10000], 5s → 2 srv-1 refused / 5 = 0.4
    expect(blockedPerSecond(events, 'srv-1', 10000)).toBeCloseTo(0.4)
  })

  it('returns 0 outside the window', () => {
    const events = [ev(1000, ['srv-1']), ev(2000, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', 10000)).toBe(0)
  })

  it('scales to per-second by the window width', () => {
    const events = [ev(9000, ['srv-1']), ev(9200, ['srv-1']), ev(9400, ['srv-1'])]
    expect(blockedPerSecond(events, 'srv-1', 10000, 2000)).toBeCloseTo(1.5)   // 3 / (2000/1000)
  })
})
