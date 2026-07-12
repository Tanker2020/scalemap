import { describe, it, expect } from 'vitest'
import { placeLabels, rectsOverlap, estimateLabelSize, type LabelSpec, type Rect } from './labelLayout'

describe('labelLayout (floor label deconfliction, 2026-07-12)', () => {
  it('a non-colliding label keeps its desired position', () => {
    const out = placeLabels([{ id: 'a', x: 10, y: 10, w: 40, h: 12 }], [])
    expect(out.get('a')).toEqual({ x: 10, y: 10, w: 40, h: 12 })
  })

  it('a label over a box obstacle is pushed above the box', () => {
    const box: Rect = { x: 0, y: 40, w: 100, h: 80 }   // roof top at y=40
    const out = placeLabels([{ id: 'a', x: 20, y: 60, w: 50, h: 14 }], [box])
    const placed = out.get('a')!
    expect(placed.y + placed.h).toBeLessThan(box.y)       // fully above the roof
    expect(placed.x).toBe(20)                             // x never moves
    expect(rectsOverlap(placed, box)).toBe(false)
  })

  it('two labels at the same anchor stack vertically without overlapping', () => {
    const specs: LabelSpec[] = [
      { id: 'first', x: 30, y: 100, w: 60, h: 16 },
      { id: 'second', x: 35, y: 100, w: 60, h: 16 },
    ]
    const out = placeLabels(specs, [])
    expect(out.get('first')).toMatchObject({ y: 100 })    // priority label stays put
    expect(rectsOverlap(out.get('first')!, out.get('second')!)).toBe(false)
    expect(out.get('second')!.y).toBeLessThan(100)        // pushed up, not down
  })

  it('a label clears BOTH an obstacle and an earlier label in one pass', () => {
    const box: Rect = { x: 0, y: 30, w: 200, h: 100 }
    const specs: LabelSpec[] = [
      { id: 'a', x: 50, y: 60, w: 70, h: 18 },
      { id: 'b', x: 60, y: 60, w: 70, h: 18 },
    ]
    const out = placeLabels(specs, [box])
    const a = out.get('a')!, b = out.get('b')!
    expect(rectsOverlap(a, box)).toBe(false)
    expect(rectsOverlap(b, box)).toBe(false)
    expect(rectsOverlap(a, b)).toBe(false)
  })

  it('estimateLabelSize scales with text length and chip padding', () => {
    const chip = estimateLabelSize('rack-1 · 2/8U')
    const text = estimateLabelSize('web-01', 'text')
    expect(chip.w).toBeGreaterThan(text.w)
    expect(chip.h).toBe(19)
    expect(text.h).toBe(12)
  })
})
