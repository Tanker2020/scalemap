// src/lib/world/placementRules.ts
// The ONE definition of which service may run on which server — the appliance rule — read by
// every layer that can create or validate a placement: spread's planner, world.store's placement
// actions, the two "mount a blueprint" pickers, the Blueprints catalog's kind picker, and
// compileWorld's `placement-host-mismatch` safety net for hand-edited files.
//
// The rule, both directions:
//   • A DB box (ServerKind 'db-sql' / 'db-nosql') hosts only its OWN kind of database service: a
//     blueprint stamped `ownerServerKind` === the box's kind whose `kind` is that same db kind. A
//     SQL service never lands on a NoSQL box or vice versa, and no api/worker/cache/proxy lands on
//     either.
//   • A general-purpose host (vps / dedicated) hosts no database: no appliance-owned blueprint and
//     no blueprint of kind 'db-sql'/'db-nosql'. Databases arrive as boxes (the AZ's ADD A NODE
//     palette), never as a free service mounted on a VPS.
// PURE: no React/store imports.
import type { BlueprintKind, ServerKind, ServiceBlueprint, Server, WorldDoc } from './types'
import { isDbServerKind } from './types'

export function isDbBlueprintKind(kind: BlueprintKind): boolean {
  return kind === 'db-sql' || kind === 'db-nosql'
}

// Why this blueprint can't run on this server, or null when it can. The reason is user-facing
// (compile finding message, disabled-control titles), so it names the mismatch plainly.
export function placementViolation(server: Pick<Server, 'kind'>, bp: Pick<ServiceBlueprint, 'kind' | 'ownerServerKind'>): string | null {
  if (isDbServerKind(server.kind)) {
    const label = server.kind === 'db-sql' ? 'SQL' : 'NoSQL'
    if (bp.ownerServerKind !== server.kind || bp.kind !== server.kind) {
      if (isDbBlueprintKind(bp.kind)) return `a ${bp.kind === 'db-sql' ? 'SQL' : 'NoSQL'} database can't run on a ${label} database box`
      return `a ${label} database box runs only its own database, not a ${bp.kind} service`
    }
    return null
  }
  if (bp.ownerServerKind !== null || isDbBlueprintKind(bp.kind)) {
    return 'a database runs only on its own database box, not on a general-purpose server'
  }
  return null
}

export function canPlace(doc: WorldDoc, blueprintId: string, serverId: string): boolean {
  const bp = doc.blueprints[blueprintId]
  const server = doc.servers[serverId]
  return !!bp && !!server && placementViolation(server, bp) === null
}

// The kinds a blueprint may be (re)typed to. An appliance-owned blueprint is locked to its box's
// kind. A free blueprint may be any non-database kind; a free blueprint that is ALREADY a db kind
// (only possible in a hand-edited/legacy file) keeps its own kind listed so it still displays, but
// can't be retyped to the other engine.
export function allowedBlueprintKinds(bp: Pick<ServiceBlueprint, 'kind' | 'ownerServerKind'>): BlueprintKind[] {
  if (bp.ownerServerKind !== null) return isDbServerKind(bp.ownerServerKind) ? [ownerKind(bp.ownerServerKind)] : [bp.kind]
  const free: BlueprintKind[] = ['api', 'worker', 'cache', 'proxy']
  return isDbBlueprintKind(bp.kind) ? [...free, bp.kind] : free
}

function ownerKind(kind: ServerKind): BlueprintKind {
  return kind === 'db-nosql' ? 'db-nosql' : 'db-sql'
}
