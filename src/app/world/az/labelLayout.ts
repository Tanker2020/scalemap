// src/app/world/az/labelLayout.ts
// Floating-label placement for the datacenter floor (user report 2026-07-12: pod names, the
// FREE POOL badge, and dep chips overlapped each other AND the iso boxes — "make the text
// overlay on top of the servers but not on them, and make sure it doesn't overlap other
// servers or other text"). Pure: DatacenterFloor supplies desired label rects (anchored above
// each box's roof, or at a flow's midpoint) plus the boxes' bounding rects as obstacles; each
// label is pushed straight UP until it clears every obstacle and every previously placed label.
// Up is always eventually free on this floor (nothing renders above the back row's roofline),
// so the greedy pass terminates without a fallback. No React/store imports.

export interface Rect { x: number; y: number; w: number; h: number }
export interface LabelSpec extends Rect { id: string }

// 2px breathing margin so "cleared" never means "touching".
const MARGIN = 2

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w + MARGIN && a.x + a.w + MARGIN > b.x &&
    a.y < b.y + b.h + MARGIN && a.y + a.h + MARGIN > b.y
}

// The label chips render at font 9px JetBrains Mono (advance ≈ 0.6em) with 7px side padding +
// 1px borders; plain-text pod names render bare at 8px. Estimates only feed the overlap test —
// a few px of slack is what MARGIN is for.
export function estimateLabelSize(text: string, kind: 'chip' | 'text' = 'chip'): { w: number; h: number } {
  return kind === 'chip'
    ? { w: Math.ceil(text.length * 5.4) + 16, h: 19 }
    : { w: Math.ceil(text.length * 4.9), h: 12 }
}

/** Place labels in the given order (earlier = higher priority, keeps closest to its anchor).
 *  Each label starts at its desired rect and moves UP in `step`-px increments until it clears
 *  all obstacles and all already-placed labels. Returns id → final rect. */
export function placeLabels(
  labels: readonly LabelSpec[],
  obstacles: readonly Rect[],
  step = 4,
  maxSteps = 150,
): Map<string, Rect> {
  const placed = new Map<string, Rect>()
  const settled: Rect[] = []
  for (const label of labels) {
    const rect: Rect = { x: label.x, y: label.y, w: label.w, h: label.h }
    let steps = 0
    while (
      steps < maxSteps &&
      (obstacles.some(o => rectsOverlap(rect, o)) || settled.some(s => rectsOverlap(rect, s)))
    ) {
      rect.y -= step
      steps++
    }
    placed.set(label.id, rect)
    settled.push(rect)
  }
  return placed
}
