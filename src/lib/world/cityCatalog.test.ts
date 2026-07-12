import { describe, it, expect } from 'vitest'
import { WORLD_CITIES, nearestCity } from './cityCatalog'
import { greatCircleKm } from './regionGeo'

describe('WORLD_CITIES', () => {
  it('has around 48 entries', () => {
    expect(WORLD_CITIES.length).toBeGreaterThanOrEqual(40)
    expect(WORLD_CITIES.length).toBeLessThanOrEqual(56)
  })

  it('every entry has a real, unique name and valid coordinates', () => {
    const names = new Set<string>()
    for (const city of WORLD_CITIES) {
      expect(city.name.length).toBeGreaterThan(0)
      expect(names.has(city.name)).toBe(false)
      names.add(city.name)
      expect(city.lat).toBeGreaterThanOrEqual(-90)
      expect(city.lat).toBeLessThanOrEqual(90)
      expect(city.lon).toBeGreaterThanOrEqual(-180)
      expect(city.lon).toBeLessThanOrEqual(180)
    }
  })

  it('covers every inhabited continent', () => {
    // Coarse bounding-box sanity check per continent — not exhaustive, just proof the catalog
    // isn't accidentally North-America-only.
    const within = (lat: number, lon: number, latMin: number, latMax: number, lonMin: number, lonMax: number) =>
      lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax
    const hasOneIn = (latMin: number, latMax: number, lonMin: number, lonMax: number) =>
      WORLD_CITIES.some(c => within(c.lat, c.lon, latMin, latMax, lonMin, lonMax))

    expect(hasOneIn(15, 72, -170, -50)).toBe(true)     // North America
    expect(hasOneIn(-56, 13, -82, -34)).toBe(true)     // South America
    expect(hasOneIn(35, 71, -25, 40)).toBe(true)       // Europe
    expect(hasOneIn(-35, 37, -18, 52)).toBe(true)      // Africa
    expect(hasOneIn(-11, 55, 60, 145)).toBe(true)      // Asia
    expect(hasOneIn(-48, -10, 110, 179)).toBe(true)    // Oceania
  })
})

describe('nearestCity', () => {
  it('returns the exact same city when probed at its own coordinates', () => {
    for (const city of WORLD_CITIES) {
      expect(nearestCity(city.lat, city.lon)).toEqual(city)
    }
  })

  it('finds the true nearest city via brute-force cross-check for several probes', () => {
    const probes: [number, number][] = [
      [40.0, -75.0],    // near New York
      [51.0, 0.0],      // near London
      [-23.0, -46.0],   // near São Paulo
      [1.0, 104.0],     // near Singapore
      [-34.0, 150.0],   // near Sydney
      [0.0, 0.0],       // Gulf of Guinea — nearest is whatever's closest, no special case
    ]
    for (const [lat, lon] of probes) {
      const got = nearestCity(lat, lon)
      let expected = WORLD_CITIES[0]
      let bestKm = greatCircleKm(lat, lon, expected.lat, expected.lon)
      for (const city of WORLD_CITIES) {
        const km = greatCircleKm(lat, lon, city.lat, city.lon)
        if (km < bestKm) { expected = city; bestKm = km }
      }
      expect(got).toEqual(expected)
    }
  })

  it('is a pure function of lat/lon — never returns undefined', () => {
    expect(nearestCity(90, 0)).toBeDefined()
    expect(nearestCity(-90, 180)).toBeDefined()
  })
})
