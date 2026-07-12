// Parity test for the Polish 4 T7 routing.ts extraction (spec D9): regionOrderFor is a pure
// extraction of computeRouting's per-population ordering loop — this file proves the two never
// diverge, across all four routing policies, without touching routing.test.ts (which must stay
// byte-identical per the task's constraints).
import { describe, it, expect } from 'vitest'
import { computeRouting, regionOrderFor } from './routing'
import { createWorld, createRegion, createPopulation } from './factories'
import type { RoutingPolicyKind } from './types'

function threeRegionWorld() {
  const doc = createWorld()
  const useast = createRegion('us-east-1')
  const euwest = createRegion('eu-west-1')
  const sydney = createRegion('ap-southeast-2')
  for (const r of [useast, euwest, sydney]) doc.regions[r.id] = r
  return { doc, useast, euwest, sydney }
}

const POLICIES: RoutingPolicyKind[] = ['geo', 'latency', 'weighted', 'priority']

describe('regionOrderFor / computeRouting parity', () => {
  it('matches computeRouting order for every policy', () => {
    const { doc, useast, euwest, sydney } = threeRegionWorld()
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    const berlin = createPopulation('Berlin users', 52.5, 13.4)
    doc.populations[nyc.id] = nyc
    doc.populations[berlin.id] = berlin
    doc.routing.weights = { [euwest.id]: 100, [useast.id]: 10, [sydney.id]: 1 }
    doc.routing.priorityOrder = [sydney.id, euwest.id, useast.id]

    for (const policy of POLICIES) {
      doc.routing = { ...doc.routing, policy }
      const { populationRegionOrder } = computeRouting(doc, {})
      for (const pop of [nyc, berlin]) {
        expect(regionOrderFor(pop, doc)).toEqual(populationRegionOrder[pop.id])
      }
    }
  })

  it('matches computeRouting order when a region is passive (partition still applied)', () => {
    const { doc, useast } = threeRegionWorld()
    doc.regions[useast.id] = { ...useast, role: 'passive' }
    const nyc = createPopulation('NYC users', 40.7, -74.0)
    doc.populations[nyc.id] = nyc

    for (const policy of POLICIES) {
      doc.routing = { ...doc.routing, policy }
      const { populationRegionOrder } = computeRouting(doc, {})
      expect(regionOrderFor(nyc, doc)).toEqual(populationRegionOrder[nyc.id])
    }
  })

  it('accepts a bare {lat, lon} (e.g. a WorldCity) — not just a real ClientPopulation', () => {
    const { doc } = threeRegionWorld()
    const city = { lat: -23.5505, lon: -46.6333 }   // São Paulo — no PopulationId
    expect(() => regionOrderFor(city, doc)).not.toThrow()
    expect(regionOrderFor(city, doc).length).toBe(3)
  })
})
