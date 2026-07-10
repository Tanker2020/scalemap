// src/app/world/globe/geo.ts
// Pure spherical geometry for the globe view (Phase 5 D3): lat/lon <-> unit-sphere vec3
// conversion and great-circle arc point sampling. Convention: lat 90 -> +Y pole; lon 0 -> +Z
// meridian; lon 90E -> +X (right-handed, texture-aligned — GlobeScene.tsx (T3) aligns the
// night-texture's UV offset to this same convention). Nothing outside this module does
// spherical math (spec D3) — GlobeScene/RegionPins/PopulationMarkers/ArcsLayer (T3-T5) call in.
import { Vector3 } from 'three'

export function latLonToVec3(lat: number, lon: number, r: number): Vector3 {
  const latRad = (lat * Math.PI) / 180
  const lonRad = (lon * Math.PI) / 180
  const y = r * Math.sin(latRad)
  const x = r * Math.cos(latRad) * Math.sin(lonRad)
  const z = r * Math.cos(latRad) * Math.cos(lonRad)
  return new Vector3(x, y, z)
}

// Inverse of latLonToVec3, any radius (normalizes internally via v.length()). lon is
// atan2-derived, so a point exactly on the antimeridian resolves to +180 (never -180) —
// callers comparing lon values across the wrap must compare via
// ((a - b + 540) % 360) - 180, not raw subtraction.
export function vec3ToLatLon(v: Vector3): { lat: number; lon: number } {
  const len = v.length()
  const lat = (Math.asin(v.y / len) * 180) / Math.PI
  const lon = (Math.atan2(v.x, v.z) * 180) / Math.PI
  return { lat, lon }
}

interface LatLon { lat: number; lon: number }

// n+1 points from `from` to `to` along the great circle (slerp between the unit-sphere
// endpoints), lifted by an altitude bump proportional to angular distance:
// r * (1 + 0.25 * (angularDistance / PI) * sin(PI * t)) at parameter t = i/n — 0 at both ends
// (sin(0) = sin(PI) = 0, landing exactly on the surface), peaking at
// r * (1 + 0.25 * angularDistance / PI) at the apex (t = 0.5). Zero-distance pairs
// (angularDistance ~ 0) degenerate safely to n+1 copies of the same surface point — no NaN
// (the slerp denominator is guarded in the helper below).
export function greatCirclePoints(from: LatLon, to: LatLon, r: number, n: number): Vector3[] {
  const a = latLonToVec3(from.lat, from.lon, 1)
  const b = latLonToVec3(to.lat, to.lon, 1)
  const dot = Math.max(-1, Math.min(1, a.dot(b)))
  const angularDistance = Math.acos(dot)
  const points: Vector3[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = slerp(a, b, t, angularDistance)
    const bump = 1 + 0.25 * (angularDistance / Math.PI) * Math.sin(Math.PI * t)
    points.push(p.normalize().multiplyScalar(r * bump))
  }
  return points
}

// Spherical linear interpolation between two UNIT vectors. Falls back to a plain copy of `a`
// when the angle is ~0 (identical or numerically antipodal-adjacent points) to avoid a 0/0
// division — the caller always normalizes the result, so this degenerate case is safe.
function slerp(a: Vector3, b: Vector3, t: number, theta: number): Vector3 {
  if (theta < 1e-9) return a.clone()
  const s0 = Math.sin((1 - t) * theta) / Math.sin(theta)
  const s1 = Math.sin(t * theta) / Math.sin(theta)
  return new Vector3(
    a.x * s0 + b.x * s1,
    a.y * s0 + b.y * s1,
    a.z * s0 + b.z * s1,
  )
}
