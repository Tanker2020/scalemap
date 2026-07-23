// src/app/world/globe/ArcsLayer.test.ts
// Pure-logic coverage for ArcsLayer.tsx's exported arcsSignature helper — the component itself
// is R3F and NOT jsdom-tested (no WebGL there); this task's live smoke is its gate. Node env
// (no environment-override pragma) — see fragment header J3 on importing a .tsx that pulls in
// @react-three/fiber/three.
import { describe, it, expect } from 'vitest'
import { arcsSignature, arcsEqual } from './ArcsLayer'
import type { VisualArc } from '../../../lib/worldEngine/types'

function arc(over: Partial<VisualArc>): VisualArc {
  return { fromLatLon: [0, 0], toLatLon: [10, 10], intensity: 0.5, kind: 'client', ...over }
}

describe('arcsSignature', () => {
  it('changes when an endpoint moves', () => {
    const a = [arc({})]
    const b = [arc({ toLatLon: [11, 10] })]
    expect(arcsSignature(a)).not.toBe(arcsSignature(b))
  })

  it('changes when kind changes', () => {
    const a = [arc({ kind: 'client' })]
    const b = [arc({ kind: 'inter-region' })]
    expect(arcsSignature(a)).not.toBe(arcsSignature(b))
  })

  it('does not change when only intensity changes', () => {
    const a = [arc({ intensity: 0.1 })]
    const b = [arc({ intensity: 0.9 })]
    expect(arcsSignature(a)).toBe(arcsSignature(b))
  })

  it('changes on arc count (append/remove), and empty arrays match', () => {
    expect(arcsSignature([arc({})])).not.toBe(arcsSignature([arc({}), arc({ toLatLon: [20, 20] })]))
    expect(arcsSignature([])).toBe(arcsSignature([]))
  })
})

// Audit ISSUE-056: arcsEqual is the zero-allocation replacement the frame loop actually uses —
// it must implement EXACTLY arcsSignature's identity (order-sensitive, intensity-blind).
describe('arcsEqual', () => {
  it('agrees with arcsSignature on every identity case', () => {
    const cases: [VisualArc[], VisualArc[]][] = [
      [[arc({})], [arc({})]],                                          // identical
      [[arc({})], [arc({ toLatLon: [11, 10] })]],                      // endpoint moved
      [[arc({ kind: 'client' })], [arc({ kind: 'drain' })]],           // kind changed
      [[arc({ intensity: 0.1 })], [arc({ intensity: 0.9 })]],          // intensity-only
      [[arc({})], [arc({}), arc({ toLatLon: [20, 20] })]],             // count changed
      [[], []],                                                        // both empty
      [[arc({}), arc({ kind: 'drain' })], [arc({ kind: 'drain' }), arc({})]],   // reorder
    ]
    for (const [a, b] of cases) {
      expect(arcsEqual(a, b)).toBe(arcsSignature(a) === arcsSignature(b))
    }
  })
})
