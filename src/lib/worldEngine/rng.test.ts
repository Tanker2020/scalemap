import { describe, it, expect } from 'vitest'
import { createRng } from './rng'

describe('rng', () => {
  it('same seed produces the same sequence', () => {
    const a = createRng(42)
    const b = createRng(42)
    const seqA = [a.next(), a.next(), a.next(), a.next()]
    const seqB = [b.next(), b.next(), b.next(), b.next()]
    expect(seqA).toEqual(seqB)
  })

  it('different seeds produce different sequences', () => {
    const a = createRng(1)
    const b = createRng(2)
    expect(a.next()).not.toBe(b.next())
  })

  it('next() stays within [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('range(min, max) stays within bounds', () => {
    const rng = createRng(9)
    for (let i = 0; i < 1000; i++) {
      const v = rng.range(-5, 10)
      expect(v).toBeGreaterThanOrEqual(-5)
      expect(v).toBeLessThan(10)
    }
  })

  it('pick() always returns an element of the array, seeded reproducibly', () => {
    const arr = ['a', 'b', 'c', 'd']
    const a = createRng(123)
    const b = createRng(123)
    const picksA = Array.from({ length: 20 }, () => a.pick(arr))
    const picksB = Array.from({ length: 20 }, () => b.pick(arr))
    expect(picksA).toEqual(picksB)
    for (const p of picksA) expect(arr).toContain(p)
  })

  it('pick() throws loudly on an empty array instead of reading index -1 (audit ISSUE-038)', () => {
    const rng = createRng(5)
    expect(() => rng.pick([])).toThrow('empty array')
  })

  it('createRng() with no seed still produces a deterministic default sequence', () => {
    const a = createRng()
    const b = createRng()
    expect(a.next()).toBe(b.next())
  })
})
