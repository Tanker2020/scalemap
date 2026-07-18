import { describe, it, expect } from 'vitest'
import { planSpread } from './spread'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createDbServer } from './factories'
import { getPreset } from './instanceCatalog'
import type { WorldDoc, ServiceBlueprint, Server } from './types'

// A world with one region and however many AZs are asked for.
function seed(azCount: number): { doc: WorldDoc; azIds: string[] } {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  doc.regions[region.id] = region
  const azIds: string[] = []
  for (let i = 0; i < azCount; i++) {
    const az = createAz(region.id, `us-east-1${String.fromCharCode(97 + i)}`)
    doc.azs[az.id] = az
    azIds.push(az.id)
  }
  return { doc, azIds }
}

function addServer(doc: WorldDoc, azId: string, presetId = 'vps-medium'): Server {
  const server = createServer(azId, getPreset(presetId)!)
  doc.servers[server.id] = server
  return server
}

function addBlueprint(doc: WorldDoc, name = 'api'): ServiceBlueprint {
  const bp = createBlueprint(name, 0)
  doc.blueprints[bp.id] = bp
  return bp
}

function place(doc: WorldDoc, blueprintId: string, serverId: string): void {
  const pl = createPlacement(blueprintId, serverId)
  doc.placements[pl.id] = pl
}

describe('planSpread', () => {
  it('places onto an existing host in the target AZ when one fits', () => {
    const { doc, azIds } = seed(2)
    const source = addServer(doc, azIds[0])
    const target = addServer(doc, azIds[1])
    const bp = addBlueprint(doc)
    place(doc, bp.id, source.id)

    const plan = planSpread(doc, bp.id, [azIds[1]])

    expect(plan).toEqual([{ azId: azIds[1], kind: 'existing', serverId: target.id }])
  })

  // The one-click promise: an AZ with no hardware still succeeds, by cloning the source's preset.
  it('creates a host cloned from the source preset when the target AZ has none', () => {
    const { doc, azIds } = seed(2)
    const source = addServer(doc, azIds[0], 'vps-large')
    const bp = addBlueprint(doc)
    place(doc, bp.id, source.id)

    const plan = planSpread(doc, bp.id, [azIds[1]])

    expect(plan).toEqual([{ azId: azIds[1], kind: 'new', presetId: 'vps-large' }])
  })

  // Spread must be idempotent — clicking the same AZ twice should not stack duplicate copies.
  it('skips an AZ that already hosts the blueprint', () => {
    const { doc, azIds } = seed(2)
    const source = addServer(doc, azIds[0])
    const existing = addServer(doc, azIds[1])
    const bp = addBlueprint(doc)
    place(doc, bp.id, source.id)
    place(doc, bp.id, existing.id)

    expect(planSpread(doc, bp.id, [azIds[1]])).toEqual([])
  })

  it('prefers the least-loaded fitting host when several exist', () => {
    const { doc, azIds } = seed(2)
    const source = addServer(doc, azIds[0])
    const busy = addServer(doc, azIds[1])
    const idle = addServer(doc, azIds[1])
    const bp = addBlueprint(doc)
    place(doc, bp.id, source.id)
    // Load `busy` with an unrelated resident service so `idle` is the better home.
    const other = addBlueprint(doc, 'other')
    place(doc, other.id, busy.id)

    const plan = planSpread(doc, bp.id, [azIds[1]])

    expect(plan).toEqual([{ azId: azIds[1], kind: 'existing', serverId: idle.id }])
  })

  // RAM is the hard constraint (an over-committed host OOM-kills); CPU only degrades. A host
  // without room for another copy's base footprint is not a candidate.
  it('creates a host rather than overcommitting one with no RAM headroom', () => {
    const { doc, azIds } = seed(2)
    const source = addServer(doc, azIds[0])
    const cramped = addServer(doc, azIds[1], 'vps-small')   // 4 GB
    const bp = addBlueprint(doc)
    bp.workload.ramBaseMb = 3500
    place(doc, bp.id, source.id)

    const hog = addBlueprint(doc, 'hog')
    hog.workload.ramBaseMb = 3500
    place(doc, hog.id, cramped.id)

    const plan = planSpread(doc, bp.id, [azIds[1]])

    // Note the preset: cloned from the SOURCE host (vps-medium), not from the cramped box we
    // declined to use (vps-small). Spreading a big service must not silently shrink it to
    // whatever happened to be sitting in the target AZ.
    expect(plan).toEqual([{ azId: azIds[1], kind: 'new', presetId: 'vps-medium' }])
  })

  // An appliance box owns exactly one blueprint — a general service must never land on it.
  it('never places a general service onto a db appliance box', () => {
    const { doc, azIds } = seed(2)
    const source = addServer(doc, azIds[0])
    const appliance = createDbServer(azIds[1], getPreset('db-sql-medium')!, 'sql-1')
    doc.servers[appliance.server.id] = appliance.server
    doc.blueprints[appliance.blueprint.id] = appliance.blueprint
    doc.placements[appliance.placement.id] = appliance.placement

    const bp = addBlueprint(doc)
    place(doc, bp.id, source.id)

    const plan = planSpread(doc, bp.id, [azIds[1]])

    expect(plan).toEqual([{ azId: azIds[1], kind: 'new', presetId: 'vps-medium' }])
  })

  // Spreading a DB replicates the cluster: the copy must land on a matching appliance box,
  // and cloning the source preset means a new one is a db box too, never a plain VPS.
  it('spreads a db blueprint onto a new appliance box of the same kind', () => {
    const { doc, azIds } = seed(2)
    const appliance = createDbServer(azIds[0], getPreset('db-sql-medium')!, 'sql-1')
    doc.servers[appliance.server.id] = appliance.server
    doc.blueprints[appliance.blueprint.id] = appliance.blueprint
    doc.placements[appliance.placement.id] = appliance.placement

    const plan = planSpread(doc, appliance.blueprint.id, [azIds[1]])

    expect(plan).toEqual([{ azId: azIds[1], kind: 'new', presetId: 'db-sql-medium' }])
  })

  it('returns nothing for a blueprint that is not placed anywhere yet', () => {
    const { doc, azIds } = seed(2)
    const bp = addBlueprint(doc)
    expect(planSpread(doc, bp.id, [azIds[1]])).toEqual([])
  })

  it('plans several target AZs in one call, in the order given', () => {
    const { doc, azIds } = seed(3)
    const source = addServer(doc, azIds[0])
    const bp = addBlueprint(doc)
    place(doc, bp.id, source.id)

    const plan = planSpread(doc, bp.id, [azIds[2], azIds[1]])

    expect(plan.map(t => t.azId)).toEqual([azIds[2], azIds[1]])
  })
})
