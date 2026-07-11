// src/app/world/az/iso.ts
// Isometric tile projection + 3-face box geometry for the datacenter floor (Polish 3 T4,
// mockup `.iso3`). The mockup is a single fixed illustration (2 racks + 2 pods, viewBox
// 900×430, floor diamond `M450 88 L830 278 L450 424 L74 278 Z`) — this file generalizes its
// STRUCTURE (a classic 2:1 dimetric grid; a box = a roof cap + two visible walls, all three
// sharing edges with the tile's own diamond footprint) to an arbitrary N×N `layoutFloor` grid,
// which the mockup never had to render. `FLOOR_W`/`FLOOR_H` are fixed regardless of grid size —
// growing the ring shrinks each tile instead of the overall scene, which is what the mockup's
// caption means by "the camera refits". Calibration: solving the mockup's 4 diamond corners for
// a standard `screenX = ORIGIN_X + (gx-gy)*halfW; screenY = ORIGIN_Y + (gx+gy)*halfH` mapping
// (gx,gy in tile-corner units 0..cols) reproduces its diamond within a few px — see the task
// report for the corner-by-corner derivation. No React/store imports.
export interface Pt { x: number; y: number }

export const VIEW_W = 900
export const VIEW_H = 430
const ORIGIN_X = VIEW_W / 2
const ORIGIN_Y = 92
const FLOOR_W = 760
const FLOOR_H = 328

export function tileMetrics(cols: number): { halfW: number; halfH: number } {
  return { halfW: FLOOR_W / cols / 2, halfH: FLOOR_H / cols / 2 }
}

// gx/gy are tile-CORNER coordinates (0..cols / 0..rows) — pass +0.5 for a tile's center.
export function tileToScreen(gx: number, gy: number, cols: number): Pt {
  const { halfW, halfH } = tileMetrics(cols)
  return { x: ORIGIN_X + (gx - gy) * halfW, y: ORIGIN_Y + (gx + gy) * halfH }
}

export function tileCenter(cellX: number, cellY: number, cols: number): Pt {
  return tileToScreen(cellX + 0.5, cellY + 0.5, cols)
}

const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const fmt = (p: Pt) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`
const poly = (ps: Pt[]) => ps.map(fmt).join(' ')

// The whole grid's outer boundary — the floor diamond itself (mockup's `path d="M450 88 L830
// 278 L450 424 L74 278 Z"`, generalized to cols×rows).
export function floorOutline(cols: number, rows: number): string {
  return poly([
    tileToScreen(0, 0, cols), tileToScreen(cols, 0, cols),
    tileToScreen(cols, rows, cols), tileToScreen(0, rows, cols),
  ])
}

// One tile's own diamond outline at floor level (used for the faint grid + the ghost/"+rack"
// affordance tile) — corners SW/SE/NE/NW of grid cell (cellX,cellY).
export function tileOutline(cellX: number, cellY: number, cols: number): string {
  return poly([
    tileToScreen(cellX, cellY + 1, cols), tileToScreen(cellX + 1, cellY + 1, cols),
    tileToScreen(cellX + 1, cellY, cols), tileToScreen(cellX, cellY, cols),
  ])
}

export interface IsoBox {
  roofSW: Pt; roofSE: Pt; roofNE: Pt; roofNW: Pt
  floorSE: Pt; floorNE: Pt
  top: string    // roof cap (racktop gradient)
  front: string  // SW-edge wall (rackfront gradient)
  side: string   // SE-edge wall (rackside gradient)
}

// A standard isometric 3-face box: a `scale`-sized footprint centered on tile (cellX,cellY),
// extruded `heightPx` UP from floor level. Mirrors the mockup's g.rack3/pod3 vertex order
// exactly (front = [roofSW, roofSE, floorSE, floorSW]; side = [roofSE, roofNE, floorNE,
// floorSE]; top = [roofSW, roofSE, roofNE, roofNW]) — only the pixel calibration is generalized.
export function isoBox(cellX: number, cellY: number, cols: number, heightPx: number, scale = 0.78): IsoBox {
  const { halfW, halfH } = tileMetrics(cols)
  const c = tileCenter(cellX, cellY, cols)
  const bw = halfW * scale, bh = halfH * scale
  const floorLeft: Pt = { x: c.x - bw, y: c.y }
  const WV: Pt = { x: bw, y: bh }    // "+x" tile step (front face's top edge)
  const DV: Pt = { x: bw, y: -bh }   // "-y" tile step (side face's top edge)
  const roofSW: Pt = { x: floorLeft.x, y: floorLeft.y - heightPx }
  const roofSE = add(roofSW, WV)
  const roofNE = add(roofSE, DV)
  const roofNW = add(roofSW, DV)
  const H: Pt = { x: 0, y: heightPx }
  const floorSW = add(roofSW, H)
  const floorSE = add(roofSE, H)
  const floorNE = add(roofNE, H)
  return {
    roofSW, roofSE, roofNE, roofNW, floorSE, floorNE,
    top: poly([roofSW, roofSE, roofNE, roofNW]),
    front: poly([roofSW, roofSE, floorSE, floorSW]),
    side: poly([roofSE, roofNE, floorNE, floorSE]),
  }
}

// A thin horizontal slat within a box's front face, at vertical offset [yTop,yBottom] below the
// roof line (mockup's per-slot polygons + LED-near-the-right-edge language). Front-face side
// edges are always pure-vertical (the extrusion is straight down), so a slat is just the same
// SW/SE pair shifted down by yTop/yBottom.
export function isoSlat(box: IsoBox, yTop: number, yBottom: number): { poly: string; led: Pt } {
  const sw0: Pt = { x: box.roofSW.x, y: box.roofSW.y + yTop }
  const se0: Pt = { x: box.roofSE.x, y: box.roofSE.y + yTop }
  const se1: Pt = { x: box.roofSE.x, y: box.roofSE.y + yBottom }
  const sw1: Pt = { x: box.roofSW.x, y: box.roofSW.y + yBottom }
  return { poly: poly([sw0, se0, se1, sw1]), led: { x: se0.x - 5, y: (se0.y + se1.y) / 2 } }
}
