// src/lib/world/rackModel.ts
// Pure rack capacity/placement model (Polish 3 Task 2, spec D4). Racks are OPTIONAL
// authored containers over the server free pool — no engine/compile/analysis/cost
// semantics live here or read this file. No store/React imports: consumed by
// world.store.ts's rack actions (and, later, rack-authoring UI).
import type { AzId, Rack, RackId, RackPosition, Server, ServerId, WorldDoc } from './types'

export const RACK_CAPACITY_DEFAULT = 8
export const RACK_CAPACITY_MIN = 4
export const RACK_CAPACITY_MAX = 42

// 1U vps / 2U everything else (dedicated boxes and db appliances are full chassis) — matches
// the old factory seeding, which hardcoded the same split when every server was born pre-racked.
// POSITIVE test on the 1U case so a new ServerKind defaults to a full 2U chassis rather than
// silently claiming a VPS-sized slice.
export function serverHeightU(server: Server): number {
  return server.kind === 'vps' ? 1 : 2
}

export function rackUsedU(doc: WorldDoc, rackId: RackId): number {
  let used = 0
  for (const s of Object.values(doc.servers)) {
    if (s.rack?.rackId === rackId) used += serverHeightU(s)
  }
  return used
}

// false when the server or rack doesn't exist; otherwise true iff the server (excluding
// its own current usage, if it's already in this rack) plus its own height fits capacityU.
export function canAssign(doc: WorldDoc, serverId: ServerId, rackId: RackId): boolean {
  const server = doc.servers[serverId]
  const rack = doc.racks[rackId]
  if (!server || !rack) return false
  let usedExcludingSelf = 0
  for (const s of Object.values(doc.servers)) {
    if (s.id === serverId) continue
    if (s.rack?.rackId === rackId) usedExcludingSelf += serverHeightU(s)
  }
  return usedExcludingSelf + serverHeightU(server) <= rack.capacityU
}

export interface AutoArrangePlan {
  assignments: Record<ServerId, RackPosition>
  newRacks: Rack[]
}

// Deterministic (no Date.now()/nextWorldId ids anywhere in here — new racks are named
// rack-<n>, the smallest globally-unused integer):
//   1. freePool = servers in this az with rack === null, sorted by label asc (id tie-break).
//   2. Target racks = existing racks in this az sorted by label asc (id tie-break); each is
//      filled bottom-up from its current rackUsedU before advancing to the next target.
//   3. Once every existing target is exhausted, new racks (capacityU 8) are created on
//      demand, id === label === rack-<n>, uniqueness checked against ALL of doc.racks
//      (world-wide, not just this az) plus racks already created earlier in this same plan.
export function autoArrangePlan(doc: WorldDoc, azId: AzId): AutoArrangePlan {
  const freePool = Object.values(doc.servers)
    .filter(s => s.azId === azId && s.rack === null)
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))

  const existingRacks = Object.values(doc.racks)
    .filter(r => r.azId === azId)
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))

  const assignments: Record<ServerId, RackPosition> = {}
  const newRacks: Rack[] = []
  const targets: Rack[] = [...existingRacks]
  const usedU = new Map<RackId, number>(existingRacks.map(r => [r.id, rackUsedU(doc, r.id)]))

  const takenIds = new Set(Object.keys(doc.racks))
  let nextRackNum = 1
  function allocateRackId(): string {
    while (takenIds.has(`rack-${nextRackNum}`)) nextRackNum++
    const id = `rack-${nextRackNum}`
    takenIds.add(id)
    return id
  }

  let targetIdx = 0
  for (const server of freePool) {
    const h = serverHeightU(server)
    for (;;) {
      if (targetIdx >= targets.length) {
        const id = allocateRackId()
        const rack: Rack = { id, azId, label: id, capacityU: RACK_CAPACITY_DEFAULT }
        targets.push(rack)
        newRacks.push(rack)
        usedU.set(rack.id, 0)
      }
      const rack = targets[targetIdx]
      const used = usedU.get(rack.id) ?? 0
      if (used + h <= rack.capacityU) {
        assignments[server.id] = { rackId: rack.id, unit: used + 1, heightU: h }
        usedU.set(rack.id, used + h)
        break
      }
      targetIdx++
    }
  }

  return { assignments, newRacks }
}
