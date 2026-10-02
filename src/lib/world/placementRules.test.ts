import { describe, it, expect } from 'vitest'
import { placementViolation, allowedBlueprintKinds, canPlace } from './placementRules'
import { createWorld, createAz, createRegion, createServer, createBlueprint, createDbServer } from './factories'
import { getPreset } from './instanceCatalog'
import type { BlueprintKind, ServerKind } from './types'

const srv = (kind: ServerKind) => ({ kind })
const bp = (kind: BlueprintKind, ownerServerKind: ServerKind | null = null) => ({ kind, ownerServerKind })

describe('placementViolation — the appliance rule', () => {
  it('lets a general host run any non-database service', () => {
    for (const k of ['api', 'worker', 'cache', 'proxy'] as const) {
      expect(placementViolation(srv('vps'), bp(k))).toBeNull()
      expect(placementViolation(srv('dedicated'), bp(k))).toBeNull()
    }
  })
  it('refuses any database on a general host — owned or free', () => {
    expect(placementViolation(srv('vps'), bp('db-sql', 'db-sql'))).toMatch(/own database box/)
    expect(placementViolation(srv('dedicated'), bp('db-nosql'))).toMatch(/own database box/)
  })
  it('lets a database box run only its own engine', () => {
    expect(placementViolation(srv('db-sql'), bp('db-sql', 'db-sql'))).toBeNull()
    expect(placementViolation(srv('db-nosql'), bp('db-nosql', 'db-nosql'))).toBeNull()
  })
  it('refuses a SQL database on a NoSQL box and vice versa', () => {
    expect(placementViolation(srv('db-nosql'), bp('db-sql', 'db-sql'))).toMatch(/SQL database can't run on a NoSQL/)
    expect(placementViolation(srv('db-sql'), bp('db-nosql', 'db-nosql'))).toMatch(/NoSQL database can't run on a SQL/)
  })
  it('refuses a box\'s service whose kind was retyped away from the box engine', () => {
    expect(placementViolation(srv('db-sql'), bp('db-nosql', 'db-sql'))).not.toBeNull()
  })
  it('refuses a non-database service on a database box', () => {
    expect(placementViolation(srv('db-sql'), bp('api'))).toMatch(/runs only its own database, not a api/)
    expect(placementViolation(srv('db-nosql'), bp('proxy'))).not.toBeNull()
  })
})

describe('allowedBlueprintKinds', () => {
  it('locks a box-owned database to its engine', () => {
    expect(allowedBlueprintKinds(bp('db-sql', 'db-sql'))).toEqual(['db-sql'])
    expect(allowedBlueprintKinds(bp('db-nosql', 'db-nosql'))).toEqual(['db-nosql'])
  })
  it('never offers a database kind to a free service', () => {
    expect(allowedBlueprintKinds(bp('api'))).toEqual(['api', 'worker', 'cache', 'proxy'])
  })
  it('keeps a legacy free database showing its own kind, but not the other engine', () => {
    expect(allowedBlueprintKinds(bp('db-sql'))).toEqual(['api', 'worker', 'cache', 'proxy', 'db-sql'])
  })
})

describe('canPlace', () => {
  it('resolves ids against the doc and refuses unknown ones', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1'); const a = createAz(r.id, 'us-east-1a')
    doc.regions[r.id] = r; doc.azs[a.id] = a
    const vps = createServer(a.id, getPreset('vps-medium')!); doc.servers[vps.id] = vps
    const api = createBlueprint('api', 0); doc.blueprints[api.id] = api
    const box = createDbServer(a.id, getPreset('db-sql-small')!, 'db')
    doc.servers[box.server.id] = box.server; doc.blueprints[box.blueprint.id] = box.blueprint
    expect(canPlace(doc, api.id, vps.id)).toBe(true)
    expect(canPlace(doc, box.blueprint.id, vps.id)).toBe(false)
    expect(canPlace(doc, api.id, box.server.id)).toBe(false)
    expect(canPlace(doc, 'nope', vps.id)).toBe(false)
  })
})
