import { describe, it, expect } from 'vitest'
import { DB_INSTANCE_CLASSES, getDbInstanceClass, defaultDbClassId } from './dbInstanceClasses'

describe('DB_INSTANCE_CLASSES', () => {
  it('offers classes for both engines', () => {
    expect(DB_INSTANCE_CLASSES.some(c => c.engine === 'sql')).toBe(true)
    expect(DB_INSTANCE_CLASSES.some(c => c.engine === 'nosql')).toBe(true)
  })

  // The whole point of the class is that a bigger box costs more AND lifts the write ceiling —
  // so within an engine, price and writeRps must move together (a strictly increasing ladder).
  it('has price and write ceiling increase together within each engine', () => {
    for (const engine of ['sql', 'nosql'] as const) {
      const ladder = DB_INSTANCE_CLASSES.filter(c => c.engine === engine)
        .sort((a, b) => a.hourlyUsd - b.hourlyUsd)
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i].writeRps).toBeGreaterThan(ladder[i - 1].writeRps)
      }
    }
  })

  it('gives every class a read ceiling at least as high as its write ceiling', () => {
    // Reads are cheaper than writes on any DB, so a class serves at least as many reads as writes.
    for (const c of DB_INSTANCE_CLASSES) expect(c.readRps).toBeGreaterThanOrEqual(c.writeRps)
  })

  it('carries positive specs, ceilings and price for every class', () => {
    for (const c of DB_INSTANCE_CLASSES) {
      expect(c.vcpu).toBeGreaterThan(0)
      expect(c.ramMb).toBeGreaterThan(0)
      expect(c.writeRps).toBeGreaterThan(0)
      expect(c.hourlyUsd).toBeGreaterThan(0)
    }
  })
})

describe('getDbInstanceClass', () => {
  it('resolves a known class id', () => {
    const id = DB_INSTANCE_CLASSES[0].id
    expect(getDbInstanceClass(id)?.id).toBe(id)
  })

  it('returns undefined for an unknown id', () => {
    expect(getDbInstanceClass('nope')).toBeUndefined()
  })
})

describe('defaultDbClassId', () => {
  it('returns a resolvable class of the requested engine', () => {
    const sqlId = defaultDbClassId('sql')
    expect(getDbInstanceClass(sqlId)?.engine).toBe('sql')
    const nosqlId = defaultDbClassId('nosql')
    expect(getDbInstanceClass(nosqlId)?.engine).toBe('nosql')
  })
})
