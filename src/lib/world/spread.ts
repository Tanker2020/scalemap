// src/lib/world/spread.ts
// Pure AZ-spread planner: "replicate this service into these AZs."
//
// Answers the design brief's fifth pain point — replicating a service across AZs used to mean
// hand-placing N placements onto N servers that happened to live in different AZs. Spread is one
// click; per-server control survives as an OVERRIDE (drag it elsewhere afterwards), not as a
// requirement.
//
// PURE: plans only. It allocates no ids and mutates nothing, so world.store can apply the whole
// plan inside ONE mutate() and undo the entire spread as a single step. No React/store imports —
// node-env testable, same contract as rackModel.ts beside it.
import { isDbServerKind, type BlueprintId, type ServiceBlueprint, type Server, type WorldDoc } from './types'

// Per target AZ: reuse a host that fits, or stand up a new one cloned from the source's preset.
export type SpreadTarget =
  | { azId: string; kind: 'existing'; serverId: string }
  | { azId: string; kind: 'new'; presetId: string }

// Resident base RAM on a host — the sum of one copy of each placed blueprint's base footprint.
// RAM (not CPU) is the admission test: an over-committed host OOM-kills a victim outright, while
// CPU contention only degrades latency, which the engine already models gracefully.
function residentRamMb(doc: WorldDoc, serverId: string): number {
  let total = 0
  for (const placement of Object.values(doc.placements)) {
    if (placement.serverId !== serverId) continue
    const bp = doc.blueprints[placement.blueprintId]
    if (bp) total += bp.workload.ramBaseMb * placement.count
  }
  return total
}

// A host can take this blueprint if the appliance rules allow it AND there is RAM headroom.
// Appliance rule, both directions: an appliance box owns exactly one blueprint and accepts no
// other service; an appliance-owned blueprint only ever lands on a box of its own kind.
function canHost(doc: WorldDoc, server: Server, bp: ServiceBlueprint): boolean {
  if (bp.ownerServerKind !== null) {
    if (server.kind !== bp.ownerServerKind) return false
  } else if (isDbServerKind(server.kind)) {
    return false
  }
  return residentRamMb(doc, server.id) + bp.workload.ramBaseMb <= server.specs.ramMb
}

// The preset a newly-created host should clone. Taken from a server ALREADY running this
// blueprint, so spreading a db blueprint stands up another db box (never a plain VPS) and
// spreading a big service doesn't silently land on a small default.
function sourcePresetId(doc: WorldDoc, blueprintId: BlueprintId): string | null {
  for (const placement of Object.values(doc.placements)) {
    if (placement.blueprintId !== blueprintId) continue
    const server = doc.servers[placement.serverId]
    if (server?.catalogId) return server.catalogId
  }
  return null
}

function azsAlreadyHosting(doc: WorldDoc, blueprintId: BlueprintId): Set<string> {
  const azIds = new Set<string>()
  for (const placement of Object.values(doc.placements)) {
    if (placement.blueprintId !== blueprintId) continue
    const server = doc.servers[placement.serverId]
    if (server) azIds.add(server.azId)
  }
  return azIds
}

// Plans one target per requested AZ, in the order given. AZs that already host the blueprint are
// SKIPPED rather than stacked, so spreading twice is idempotent.
//
// Returns [] for a blueprint that isn't placed anywhere: spread replicates an existing service,
// so with no source placement there is nothing to replicate and no preset to clone.
export function planSpread(doc: WorldDoc, blueprintId: BlueprintId, targetAzIds: string[]): SpreadTarget[] {
  const bp = doc.blueprints[blueprintId]
  if (!bp) return []

  const presetId = sourcePresetId(doc, blueprintId)
  if (presetId === null) return []

  const occupied = azsAlreadyHosting(doc, blueprintId)
  const targets: SpreadTarget[] = []

  for (const azId of targetAzIds) {
    if (occupied.has(azId)) continue

    const candidates = Object.values(doc.servers)
      .filter(s => s.azId === azId && canHost(doc, s, bp))
      // Least-loaded first; tie-break on id so a plan is deterministic given the same doc.
      .sort((a, b) => residentRamMb(doc, a.id) - residentRamMb(doc, b.id) || a.id.localeCompare(b.id))

    targets.push(candidates.length > 0
      ? { azId, kind: 'existing', serverId: candidates[0].id }
      : { azId, kind: 'new', presetId })
    // Guard against a repeated AZ in the same request stacking two copies.
    occupied.add(azId)
  }

  return targets
}
