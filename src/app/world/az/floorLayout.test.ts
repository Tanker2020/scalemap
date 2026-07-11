import { describe, it, expect } from 'vitest'
import { layoutFloor } from './floorLayout'
import type { Rack, Server } from '../../../lib/world/types'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'

function seedAz() {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  return { doc, azId: az.id }
}

function mkServer(azId: string, label: string): Server {
  const { doc } = seedAz()
  const s = createServer(azId, getPreset('vps-medium')!)
  s.label = label
  void doc
  return s
}

function mkRack(id: string, azId: string, label: string): Rack {
  return { id, azId, label, capacityU: 8 }
}

function fill<T>(n: number, make: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => make(i))
}

describe('layoutFloor', () => {
  const azId = 'az-1'

  it('grows 4×4 → 6×6 at the exact occupant count', () => {
    // 16 occupants (all free-pool servers, no racks) -> stays at the 4×4 base grid.
    const pool16 = fill(16, i => mkServer(azId, `s${String(i).padStart(2, '0')}`))
    expect(layoutFloor([], {}, pool16, [])).toMatchObject({ cols: 4, rows: 4 })

    // 17th occupant tips it into the next ring: 6×6.
    const pool17 = fill(17, i => mkServer(azId, `s${String(i).padStart(2, '0')}`))
    expect(layoutFloor([], {}, pool17, [])).toMatchObject({ cols: 6, rows: 6 })

    // 36 occupants exactly fill 6×6 — no further growth.
    const pool36 = fill(36, i => mkServer(azId, `s${String(i).padStart(2, '0')}`))
    expect(layoutFloor([], {}, pool36, [])).toMatchObject({ cols: 6, rows: 6 })

    // 37th occupant tips it into 8×8.
    const pool37 = fill(37, i => mkServer(azId, `s${String(i).padStart(2, '0')}`))
    expect(layoutFloor([], {}, pool37, [])).toMatchObject({ cols: 8, rows: 8 })
  })

  it('tiles cover every cell of the grid, row-major', () => {
    const plan = layoutFloor([], {}, [], [])
    expect(plan.tiles).toHaveLength(16)
    expect(plan.tiles[0]).toEqual({ x: 0, y: 0 })
    expect(plan.tiles[1]).toEqual({ x: 1, y: 0 })
    expect(plan.tiles[4]).toEqual({ x: 0, y: 1 })
    expect(plan.tiles[15]).toEqual({ x: 3, y: 3 })
  })

  it('pods flow after cabinets and appliances hug the far edge', () => {
    const rackA = mkRack('rack-a', azId, 'rack-a')
    const rackB = mkRack('rack-b', azId, 'rack-b')
    const pod1 = mkServer(azId, 'pod-1')
    const pod2 = mkServer(azId, 'pod-2')

    const plan = layoutFloor([rackB, rackA], {}, [pod2, pod1], ['ms-1'])

    // Cabinets sorted by label first: rack-a at cell 0, rack-b at cell 1.
    expect(plan.cabinets[rackA.id]).toEqual({ x: 0, y: 0 })
    expect(plan.cabinets[rackB.id]).toEqual({ x: 1, y: 0 })

    // Pods continue row-major from cell index racks.length (=2): pod-1 (sorts first) at cell 2,
    // pod-2 at cell 3 — cabinet cells strictly precede pod cells.
    expect(plan.pods[pod1.id]).toEqual({ x: 2, y: 0 })
    expect(plan.pods[pod2.id]).toEqual({ x: 3, y: 0 })

    // Appliances hug the far edge: one lane past the grid's right edge (x === cols).
    expect(plan.appliances['ms-1']).toEqual({ x: plan.cols, y: 0 })
  })

  it('is deterministic and orders by label then id', () => {
    const rackZ: Rack = { id: 'aaa', azId, label: 'rack-z', capacityU: 8 }
    const rackA: Rack = { id: 'zzz', azId, label: 'rack-a', capacityU: 8 }
    const plan = layoutFloor([rackZ, rackA], {}, [], [])
    expect(plan.cabinets[rackA.id]).toEqual({ x: 0, y: 0 })
    expect(plan.cabinets[rackZ.id]).toEqual({ x: 1, y: 0 })
  })
})
