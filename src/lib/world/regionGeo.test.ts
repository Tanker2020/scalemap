import { describe, it, expect } from 'vitest'
import { WORLD_REGIONS } from '../regionConfig'
import { REGION_GEO, greatCircleKm } from './regionGeo'

describe('regionGeo', () => {
  it('has coordinates for every catalog region', () => {
    for (const r of WORLD_REGIONS) {
      expect(REGION_GEO[r.id], `missing geo for ${r.id}`).toBeDefined()
      expect(Math.abs(REGION_GEO[r.id].lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(REGION_GEO[r.id].lon)).toBeLessThanOrEqual(180)
    }
  })

  it('computes plausible great-circle distances', () => {
    // Virginia → Oregon is ~3,700 km; allow generous tolerance.
    const va = REGION_GEO['us-east-1']
    const or = REGION_GEO['us-west-2']
    const d = greatCircleKm(va.lat, va.lon, or.lat, or.lon)
    expect(d).toBeGreaterThan(3000)
    expect(d).toBeLessThan(4500)
    expect(greatCircleKm(va.lat, va.lon, va.lat, va.lon)).toBe(0)
  })
})
