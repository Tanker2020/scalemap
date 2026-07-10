// src/lib/world/layoutRacks.ts
// Pure, deterministic rack-frame layout for the AZ canvas (Phase 4 D7). Replaces
// layoutAzGrid (deleted in Task 5 once AzCanvas stops importing it): servers group into
// per-rack frames (React Flow parent/group nodes, Task 5); chassis stack inside a frame
// by rack.unit, with colliding/duplicate units re-stacking without overlap; blank-U
// filler strips mark unused unit gaps (capped at 3 per frame); a PDU strip sits at the
// frame's bottom. Managed services lay out in a single column right of all frames. No
// React/store/engine imports — lib/ code stays framework-free (see useCompiledWorld.ts's
// own "lib/ must never import app stores" note; layoutRacks goes one further and avoids
// even app-shaped concepts like ids-with-semantics, staying pure geometry).
import type { Server, ServerId } from './types'

export const U_PX = 44
export const CHASSIS_W = 220
export const RACK_PAD = 10          // frame padding around the chassis column (and the gap before the PDU strip)
export const RAIL_W = 8
export const RACK_W = CHASSIS_W + 2 * (RACK_PAD + RAIL_W)   // 256
export const RACK_GAP = 60
export const PDU_H = 18
export const MANAGED_W = 170
export const MANAGED_H = 60

const MAX_FILLERS = 3
const UNIT_PITCH = U_PX + 4          // one rack-unit slot + a 4px gutter, 48px

export interface RackBox { x: number; y: number; w: number; h: number }

export interface RackFrame {
  rackId: string
  box: RackBox                       // absolute canvas coords
  serverIds: ServerId[]              // sorted by rack.unit ascending
  blankUnits: { y: number; h: number }[]   // frame-relative filler strips
  pduY: number                       // frame-relative
}

export interface RackLayout {
  frames: RackFrame[]                            // sorted by rackId
  chassis: Record<ServerId, { rackId: string; x: number; y: number; w: number; h: number }>
  // chassis x/y are FRAME-RELATIVE (React Flow child positions); h = rack.heightU × U_PX
  managed: Record<string, { x: number; y: number }>  // absolute, single column right of frames
}

export function layoutRacks(servers: Server[], managedIds: string[]): RackLayout {
  const byRack = new Map<string, Server[]>()
  for (const s of servers) {
    const list = byRack.get(s.rack.rackId) ?? []
    list.push(s)
    byRack.set(s.rack.rackId, list)
  }
  const rackIds = [...byRack.keys()].sort()

  const frames: RackFrame[] = []
  const chassis: RackLayout['chassis'] = {}

  rackIds.forEach((rackId, frameIndex) => {
    const rackServers = byRack.get(rackId)!
    // Stacking + collision-resolution order: authored unit ascending, label as a
    // deterministic tie-break. This order matters because factories.createServer always
    // seeds unit:1 — every server in a frame collides on the same unit unless the
    // caller/UI has moved it, so re-stacking is the common path, not an edge case.
    const sorted = [...rackServers].sort((a, b) => a.rack.unit - b.rack.unit || a.label.localeCompare(b.label))
    const minUnit = Math.min(...sorted.map(s => s.rack.unit))

    // Re-stack: each server claims max(its own authored unit, the next free slot), so
    // occupied spans never overlap regardless of how many servers share a unit number or
    // how far apart authored units jump.
    let nextUnit = minUnit
    const placed: { server: Server; unit: number }[] = []
    for (const s of sorted) {
      const unit = Math.max(nextUnit, s.rack.unit)
      placed.push({ server: s, unit })
      nextUnit = unit + s.rack.heightU
    }

    const frameX = frameIndex * (RACK_W + RACK_GAP)
    const serverIds: ServerId[] = []
    const blankUnits: { y: number; h: number }[] = []
    let maxBottom = 0

    placed.forEach((p, i) => {
      const y = RACK_PAD + (p.unit - minUnit) * UNIT_PITCH
      const h = p.server.rack.heightU * U_PX
      chassis[p.server.id] = { rackId, x: RACK_PAD + RAIL_W, y, w: CHASSIS_W, h }
      serverIds.push(p.server.id)
      maxBottom = Math.max(maxBottom, y + h)

      const next = placed[i + 1]
      if (next) {
        const curBottomUnit = p.unit + p.server.rack.heightU
        const gapUnits = next.unit - curBottomUnit
        // One filler strip per contiguous gap region (not per empty unit-slot), capped at
        // 3 strips per frame — a server authored far from its neighbors shouldn't draw
        // dozens of filler strips. Chassis positions are unaffected either way.
        if (gapUnits > 0 && blankUnits.length < MAX_FILLERS) {
          blankUnits.push({
            y: RACK_PAD + (curBottomUnit - minUnit) * UNIT_PITCH,
            h: gapUnits * U_PX + (gapUnits - 1) * 4,
          })
        }
      }
    })

    const pduY = maxBottom + RACK_PAD
    const frameH = pduY + PDU_H + RACK_PAD

    frames.push({ rackId, box: { x: frameX, y: 0, w: RACK_W, h: frameH }, serverIds, blankUnits, pduY })
  })

  const n = frames.length
  const framesRightEdge = n === 0 ? 0 : (n - 1) * (RACK_W + RACK_GAP) + RACK_W
  const managedX = n === 0 ? 0 : framesRightEdge + RACK_GAP

  const managed: RackLayout['managed'] = {}
  managedIds.forEach((id, i) => { managed[id] = { x: managedX, y: i * (MANAGED_H + 20) } })

  return { frames, chassis, managed }
}
