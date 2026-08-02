// src/app/world/globe/ArcsLayer.test.ts
// Pure-logic coverage for ArcsLayer.tsx's exported arcsSignature helper — the component itself
// is R3F and NOT jsdom-tested (no WebGL there); this task's live smoke is its gate. Node env
// (no environment-override pragma) — see fragment header J3 on importing a .tsx that pulls in
// @react-three/fiber/three.
import { describe, it, expect } from 'vitest'
import { arcsSignature, arcsEqual, buildRegionGeoIndex, arcImpairment } from './ArcsLayer'
import { REGION_GEO } from '../../../lib/world/regionGeo'
import type { VisualArc, PartitionFault } from '../../../lib/worldEngine/types'
import type { WorldDoc, Region } from '../../../lib/world/types'

// Minimal fake doc — buildRegionGeoIndex only reads doc.regions, so a partial cast avoids
// standing up a full WorldDoc (factories.createWorldDoc doesn't exist; world.store's newWorld
// is a Zustand action, not a pure doc builder).
function fakeDoc(regions: Region[]): WorldDoc {
  return { regions: Object.fromEntries(regions.map(r => [r.id, r])) } as unknown as WorldDoc
}

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

// FEAT-002 Task 14: buildRegionGeoIndex/arcImpairment resolve an arc's lat/lon endpoints back to
// region ids (via the SAME REGION_GEO table RegionPins uses) and reuse impairmentFor's exact
// matching semantics — the render-file smoke test for "ArcsLayer renders a broken arc for a
// dropped partition matching its endpoints" (this is the WebGL-free, pure-logic half of that).
describe('arcImpairment', () => {
  const usEast = { id: 'r-us-east', catalogId: 'us-east-1', role: 'active' } as Region
  const euWest = { id: 'r-eu-west', catalogId: 'eu-west-1', role: 'active' } as Region
  const doc = fakeDoc([usEast, euWest])
  const geoIndex = buildRegionGeoIndex(doc)
  const interRegionArc = arc({
    kind: 'inter-region',
    fromLatLon: [REGION_GEO['us-east-1'].lat, REGION_GEO['us-east-1'].lon],
    toLatLon: [REGION_GEO['eu-west-1'].lat, REGION_GEO['eu-west-1'].lon],
  })

  it('renders a broken arc (blocked) for a dropped partition matching its endpoints', () => {
    const partitions: PartitionFault[] = [
      { from: { kind: 'region', id: usEast.id }, to: { kind: 'region', id: euWest.id }, mode: 'drop', symmetric: true },
    ]
    expect(arcImpairment(interRegionArc, geoIndex, partitions)).toEqual({ blocked: true, lossFraction: 0, delayMs: 0 })
  })

  it('reports a lossFraction (not blocked) for a loss-mode partition', () => {
    const partitions: PartitionFault[] = [
      { from: { kind: 'region', id: usEast.id }, to: { kind: 'region', id: euWest.id }, mode: 'loss', lossFraction: 0.4, symmetric: true },
    ]
    expect(arcImpairment(interRegionArc, geoIndex, partitions)).toEqual({ blocked: false, lossFraction: 0.4, delayMs: 0 })
  })

  it('does not match an unrelated region pair', () => {
    const otherRegion = { id: 'r-ap', catalogId: 'ap-southeast-1', role: 'active' } as Region
    const partitions: PartitionFault[] = [
      { from: { kind: 'region', id: usEast.id }, to: { kind: 'region', id: otherRegion.id }, mode: 'drop', symmetric: true },
    ]
    expect(arcImpairment(interRegionArc, geoIndex, partitions).blocked).toBe(false)
  })

  it('an asymmetric partition only blocks the authored direction', () => {
    const partitions: PartitionFault[] = [
      { from: { kind: 'region', id: usEast.id }, to: { kind: 'region', id: euWest.id }, mode: 'drop', symmetric: false },
    ]
    const reversedArc = arc({ kind: 'inter-region', fromLatLon: interRegionArc.toLatLon, toLatLon: interRegionArc.fromLatLon })
    expect(arcImpairment(interRegionArc, geoIndex, partitions).blocked).toBe(true)
    expect(arcImpairment(reversedArc, geoIndex, partitions).blocked).toBe(false)
  })

  it('a client arc (unresolvable non-region endpoint) never matches', () => {
    const clientArc = arc({ kind: 'client', fromLatLon: [1.23, 4.56], toLatLon: interRegionArc.toLatLon })
    const partitions: PartitionFault[] = [
      { from: { kind: 'region', id: usEast.id }, to: { kind: 'region', id: euWest.id }, mode: 'drop', symmetric: true },
    ]
    expect(arcImpairment(clientArc, geoIndex, partitions).blocked).toBe(false)
  })

  it('is a zero-cost no-op when there are no active partitions', () => {
    expect(arcImpairment(interRegionArc, geoIndex, [])).toEqual({ blocked: false, lossFraction: 0, delayMs: 0 })
  })
})
