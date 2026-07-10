// src/app/world/globe/RegionPins.test.ts
// Pure-logic coverage for RegionPins.tsx's two exported helpers (pinColor, isPulsing) — the
// component itself is R3F and NOT jsdom-tested (no WebGL there); this task's live smoke is its
// gate. Runs in the default node env (no environment override in this file): importing
// RegionPins.tsx pulls in @react-three/fiber/drei, which are import-safe outside a browser
// (see fragment header J3).
import { describe, it, expect } from 'vitest'
import { pinColor, isPulsing } from './RegionPins'
import type { EngineEvent } from '../../../lib/worldEngine/types'

function evt(over: Partial<EngineEvent>): EngineEvent {
  return { id: 'e', simMs: 0, kind: 'outage_triggered', severity: 'critical', message: '', affected: [], ...over }
}

describe('pinColor', () => {
  it('maps health states', () => {
    expect(pinColor('healthy')).toBe('#22C55E')
    expect(pinColor('degraded')).toBe('#F59E0B')
    expect(pinColor('down')).toBe('#EF4444')
  })
})

describe('isPulsing', () => {
  it('pulses within 10s of a region outage event', () => {
    const events = [evt({ kind: 'outage_triggered', affected: ['r1'], simMs: 5000 })]
    expect(isPulsing(events, 'r1', 12_000)).toBe(true)   // 7s old
  })

  it('stops after 10s', () => {
    const events = [evt({ kind: 'outage_triggered', affected: ['r1'], simMs: 5000 })]
    expect(isPulsing(events, 'r1', 15_001)).toBe(false)  // 10.001s old
  })

  it('ignores events for other regions and non-failover/outage kinds', () => {
    const events = [
      evt({ kind: 'outage_triggered', affected: ['other-region'], simMs: 9000 }),
      evt({ kind: 'oom_kill', affected: ['r1'], simMs: 9500 }),
    ]
    expect(isPulsing(events, 'r1', 10_000)).toBe(false)
  })

  it('a failover_started event also triggers the pulse', () => {
    const events = [evt({ kind: 'failover_started', affected: ['r1'], simMs: 8000 })]
    expect(isPulsing(events, 'r1', 8500)).toBe(true)
  })
})
