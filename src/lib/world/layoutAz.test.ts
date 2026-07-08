import { describe, it, expect } from 'vitest'
import { layoutAzGrid, AZ_LAYOUT } from './layoutAz'

describe('layoutAzGrid', () => {
  it('lays servers in rows of 3 and managed services below', () => {
    const pos = layoutAzGrid(['a', 'b', 'c', 'd'], ['m1'])
    expect(pos['a']).toEqual({ x: 0, y: 0 })
    expect(pos['c']).toEqual({ x: 2 * AZ_LAYOUT.xGap, y: 0 })
    expect(pos['d']).toEqual({ x: 0, y: AZ_LAYOUT.yGap })
    expect(pos['m1'].y).toBe(2 * AZ_LAYOUT.yGap + AZ_LAYOUT.managedYExtra)
  })

  it('is deterministic and total', () => {
    expect(layoutAzGrid([], [])).toEqual({})
    expect(layoutAzGrid(['x'], [])).toEqual(layoutAzGrid(['x'], []))
  })
})
