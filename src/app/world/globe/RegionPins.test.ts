// src/app/world/globe/RegionPins.test.ts
// Pure-logic coverage for RegionPins.tsx's two exported helpers (pinColor, isPulsing) — the
// component itself is R3F and NOT jsdom-tested (no WebGL there); this task's live smoke is its
// gate. @react-three/fiber/drei are import-safe outside a browser (see fragment header J3), but
// as of Polish 2 T3 this module also imports ui.store.ts, which touches `localStorage` at
// module init — jsdom (not the default node env) so that global resolves.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { pinColor, isPulsing, isFrontFacing } from './RegionPins'
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

describe('isFrontFacing', () => {
  // Camera at the default distance 2.8: horizon at dot = 1/2.8 + 0.05 margin ≈ 0.407.
  it('shows a label whose pin faces the camera head-on', () => {
    expect(isFrontFacing(1, 2.8)).toBe(true)
  })

  it('hides a label at the limb (dot 0) and on the far side (dot -1)', () => {
    expect(isFrontFacing(0, 2.8)).toBe(false)
    expect(isFrontFacing(-1, 2.8)).toBe(false)
  })

  it('the horizon widens as the camera zooms out', () => {
    // dot = 0.3: hidden at distance 2.8 (threshold ≈ .407), visible zoomed out to 5 (≈ .25)
    expect(isFrontFacing(0.3, 2.8)).toBe(false)
    expect(isFrontFacing(0.3, 5)).toBe(true)
  })
})
