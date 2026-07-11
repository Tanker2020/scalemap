// src/app/world/az/floorLayout.ts
// Pure floor-grid layout for the isometric datacenter floor (Polish 3 T4, spec D5). Assigns
// every rack, free-pool server, and managed service a GRID cell — never a pixel coordinate;
// the isometric projection (screen px from grid units) is a separate, purely presentational
// concern (`iso.ts`) so this file stays as framework-free/deterministic as `layoutRacks.ts`
// (deleted this task) and `rackModel.ts` (Polish 3 T2) already are. No React/store imports.
import type { ManagedServiceId, Rack, RackId, Server, ServerId } from '../../../lib/world/types'

export interface FloorPlan {
  cols: number
  rows: number
  tiles: { x: number; y: number }[]
  cabinets: Record<RackId, { x: number; y: number }>
  pods: Record<ServerId, { x: number; y: number }>
  appliances: Record<ManagedServiceId, { x: number; y: number }>
}

const BASE_GRID = 4     // 4×4 = 16 cells before the first ring-growth
const GROWTH_STEP = 2   // each ring adds one cell to both cols and rows (4 -> 6 -> 8 -> ...)

function byLabelThenId(a: { label: string; id: string }, b: { label: string; id: string }): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

// `rackedByRack` is accepted (not merely decorative) because every DatacenterFloor caller
// already has it in hand alongside `racks`/`freePool` for rendering residents — but the FLOOR
// GRID itself only cares about occupant COUNT (one tile per rack regardless of how full it is),
// never contents, so it plays no part in the position math below.
export function layoutFloor(
  racks: Rack[],
  rackedByRack: Record<RackId, Server[]>,
  freePool: Server[],
  managedIds: ManagedServiceId[],
): FloorPlan {
  void rackedByRack

  const occupantCount = racks.length + freePool.length
  let cols = BASE_GRID
  let rows = BASE_GRID
  while (cols * rows < occupantCount) {
    cols += GROWTH_STEP
    rows += GROWTH_STEP
  }

  const tiles: { x: number; y: number }[] = []
  for (let idx = 0; idx < cols * rows; idx++) {
    tiles.push({ x: idx % cols, y: Math.floor(idx / cols) })
  }

  const sortedRacks = [...racks].sort(byLabelThenId)
  const sortedPool = [...freePool].sort(byLabelThenId)

  const cabinets: Record<RackId, { x: number; y: number }> = {}
  sortedRacks.forEach((rack, i) => {
    cabinets[rack.id] = { x: i % cols, y: Math.floor(i / cols) }
  })

  const pods: Record<ServerId, { x: number; y: number }> = {}
  sortedPool.forEach((server, i) => {
    const idx = racks.length + i
    pods[server.id] = { x: idx % cols, y: Math.floor(idx / cols) }
  })

  // One lane past the grid's right edge = "hug the far edge" (spec D5) — managed services
  // never compete with racks/pods for floor tiles.
  const appliances: Record<ManagedServiceId, { x: number; y: number }> = {}
  managedIds.forEach((id, i) => {
    appliances[id] = { x: cols, y: i }
  })

  return { cols, rows, tiles, cabinets, pods, appliances }
}
