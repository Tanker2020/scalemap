// src/app/world/globe/geo.test.ts
import { describe, it, expect } from 'vitest'
import { latLonToVec3, vec3ToLatLon, greatCirclePoints } from './geo'

// atan2's range is (-180, 180], so a point exactly on the antimeridian resolves to +180, never
// -180 — raw subtraction fails there. Wrap-aware comparison (GROUNDING-verified convention).
function lonDiff(a: number, b: number): number {
  return ((a - b + 540) % 360) - 180
}

describe('latLonToVec3', () => {
  it('poles and equator land on axes', () => {
    const cases: [number, number, [number, number, number]][] = [
      [90, 0, [0, 1, 0]],
      [-90, 0, [0, -1, 0]],
      [0, 0, [0, 0, 1]],
      [0, 90, [1, 0, 0]],
      [0, -90, [-1, 0, 0]],
      [0, 180, [0, 0, -1]],
    ]
    for (const [lat, lon, [ex, ey, ez]] of cases) {
      const v = latLonToVec3(lat, lon, 1)
      expect(v.x).toBeCloseTo(ex, 5)
      expect(v.y).toBeCloseTo(ey, 5)
      expect(v.z).toBeCloseTo(ez, 5)
    }
  })
})

describe('vec3ToLatLon', () => {
  it('round-trips random points within 1e-6', () => {
    let maxLatErr = 0
    let maxLonErr = 0
    for (let i = 0; i < 10_000; i++) {
      const lat = Math.random() * 180 - 90
      const lon = Math.random() * 360 - 180
      const r = 0.5 + Math.random() * 5
      const back = vec3ToLatLon(latLonToVec3(lat, lon, r))
      maxLatErr = Math.max(maxLatErr, Math.abs(back.lat - lat))
      maxLonErr = Math.max(maxLonErr, Math.abs(lonDiff(back.lon, lon)))
    }
    expect(maxLatErr).toBeLessThan(1e-6)
    expect(maxLonErr).toBeLessThan(1e-6)
  })

  it('antimeridian round-trip', () => {
    const { lat, lon } = vec3ToLatLon(latLonToVec3(10, 180, 2))
    expect(lat).toBeCloseTo(10, 5)
    expect(lonDiff(lon, 180)).toBeCloseTo(0, 5)
  })
})

describe('greatCirclePoints', () => {
  it('returns n+1 points, ends on the surface, apex lifted', () => {
    const points = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }, 1, 48)
    expect(points).toHaveLength(49)
    expect(points[0].length()).toBeCloseTo(1, 5)
    expect(points[48].length()).toBeCloseTo(1, 5)
    const expectedApex = 1 + 0.25 * (Math.PI / 2) / Math.PI   // = 1.125
    expect(points[24].length()).toBeCloseTo(expectedApex, 5)
  })

  it('zero-distance pair degenerates safely', () => {
    const points = greatCirclePoints({ lat: 20, lon: 30 }, { lat: 20, lon: 30 }, 2, 48)
    expect(points).toHaveLength(49)
    for (const p of points) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
      expect(p.length()).toBeCloseTo(2, 5)
    }
  })
})
