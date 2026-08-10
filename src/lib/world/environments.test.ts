import { describe, it, expect } from 'vitest'
import { applyEnvironment } from './environments'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation } from './factories'
import { getPreset } from './instanceCatalog'

// Local fixture builders (mirrors compileWorld.test.ts's tinyWorld pattern) — a doc with exactly
// one placement, or one population, ready for an environments overlay to be applied to.
function buildDocWithOnePlacement(opts: { count: number }) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  const bp = createBlueprint('api', 0)
  const pl = createPlacement(bp.id, server.id)
  pl.id = 'p1'
  pl.count = opts.count
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  doc.servers[server.id] = server
  doc.blueprints[bp.id] = bp
  doc.placements[pl.id] = pl
  return doc
}

function buildDocWithOnePopulation(opts: { peakRps: number }) {
  const doc = createWorld()
  const pop = createPopulation('users', 0, 0)
  pop.peakRps = opts.peakRps
  doc.populations[pop.id] = pop
  return doc
}

describe('applyEnvironment', () => {
  it('placementCountOverrides wins over serverCountFactor for the same placement', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    const doc2 = {
      ...doc,
      environments: { s: { id: 's', label: 'S', serverCountFactor: 0.5, placementCountOverrides: { p1: 10 } } },
      activeEnvironmentId: 's',
    }
    const result = applyEnvironment(doc2)
    expect(result.placements.p1.count).toBe(10) // override wins, not 4*0.5=2
  })

  it('serverCountFactor scales placements with no override', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    const doc2 = { ...doc, environments: { s: { id: 's', label: 'S', serverCountFactor: 0.5 } }, activeEnvironmentId: 's' }
    const result = applyEnvironment(doc2)
    expect(result.placements.p1.count).toBe(2)
  })

  it('populationRpsFactor scales peakRps before compile, preserving downstream Poisson variance scaling', () => {
    const doc = buildDocWithOnePopulation({ peakRps: 1000 })
    const doc2 = { ...doc, environments: { s: { id: 's', label: 'S', populationRpsFactor: 0.1 } }, activeEnvironmentId: 's' }
    const result = applyEnvironment(doc2)
    expect(Object.values(result.populations)[0].peakRps).toBe(100)
  })

  it('returns the same doc reference when activeEnvironmentId is absent', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    expect(applyEnvironment(doc)).toBe(doc)
  })

  it('returns the same doc reference when activeEnvironmentId names a missing environment', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    const doc2 = { ...doc, environments: {}, activeEnvironmentId: 'nope' }
    expect(applyEnvironment(doc2)).toBe(doc2)
  })

  it('instanceClassOverrides swaps a server catalogId AND re-resolves specs/hourlyUsd (not just the label)', () => {
    const doc = buildDocWithOnePlacement({ count: 1 })
    const serverId = Object.keys(doc.servers)[0]
    const doc2 = {
      ...doc,
      environments: { s: { id: 's', label: 'S', instanceClassOverrides: { [serverId]: 'vps-large' } } },
      activeEnvironmentId: 's',
    }
    const result = applyEnvironment(doc2)
    const preset = getPreset('vps-large')!
    expect(result.servers[serverId].catalogId).toBe('vps-large')
    expect(result.servers[serverId].specs).toEqual(preset.specs)
    expect(result.servers[serverId].hourlyUsd).toBe(preset.hourlyUsd)
  })

  it('instanceClassOverrides leaves the server unchanged when the catalog id does not resolve', () => {
    const doc = buildDocWithOnePlacement({ count: 1 })
    const serverId = Object.keys(doc.servers)[0]
    const original = doc.servers[serverId]
    const doc2 = {
      ...doc,
      environments: { s: { id: 's', label: 'S', instanceClassOverrides: { [serverId]: 'not-a-real-preset' } } },
      activeEnvironmentId: 's',
    }
    const result = applyEnvironment(doc2)
    expect(result.servers[serverId]).toEqual(original)
  })

  it('serverCountFactor scales an autoscaled placement\'s minCount/maxCount envelope, not just count', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    doc.placements.p1.autoscale = {
      minCount: 2, maxCount: 10, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    }
    const doc2 = { ...doc, environments: { s: { id: 's', label: 'S', serverCountFactor: 0.5 } }, activeEnvironmentId: 's' }
    const result = applyEnvironment(doc2)
    expect(result.placements.p1.count).toBe(2)
    expect(result.placements.p1.autoscale).toEqual({
      minCount: 1, maxCount: 5, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    })
  })

  it('placementCountOverrides scales an autoscaled placement\'s envelope proportionally and clamps minCount <= maxCount', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    doc.placements.p1.autoscale = {
      minCount: 3, maxCount: 4, targetCpuPercent: 60, scaleUpCooldownSec: 30, scaleDownCooldownSec: 300,
    }
    const doc2 = {
      ...doc,
      environments: { s: { id: 's', label: 'S', placementCountOverrides: { p1: 2 } } },
      activeEnvironmentId: 's',
    }
    const result = applyEnvironment(doc2)
    expect(result.placements.p1.count).toBe(2)
    // factor = 2/4 = 0.5 -> maxCount round(4*0.5)=2, minCount round(3*0.5)=2 (already <= maxCount)
    expect(result.placements.p1.autoscale!.maxCount).toBe(2)
    expect(result.placements.p1.autoscale!.minCount).toBe(2)
    expect(result.placements.p1.autoscale!.minCount).toBeLessThanOrEqual(result.placements.p1.autoscale!.maxCount)
  })
})
