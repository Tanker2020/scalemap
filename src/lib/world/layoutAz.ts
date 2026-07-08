// Deterministic grid layout for the static AZ canvas. Positions are derived per render —
// Phase 1 has no drag-persistence; a future phase can add a positions map to the doc.
export const AZ_LAYOUT = { cols: 3, xGap: 280, yGap: 190, managedYExtra: 80 }

export function layoutAzGrid(
  serverIds: string[],
  managedIds: string[],
): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {}
  serverIds.forEach((id, i) => {
    pos[id] = { x: (i % AZ_LAYOUT.cols) * AZ_LAYOUT.xGap, y: Math.floor(i / AZ_LAYOUT.cols) * AZ_LAYOUT.yGap }
  })
  const managedRow = Math.ceil(serverIds.length / AZ_LAYOUT.cols)
  managedIds.forEach((id, i) => {
    pos[id] = { x: (i % AZ_LAYOUT.cols) * AZ_LAYOUT.xGap, y: managedRow * AZ_LAYOUT.yGap + AZ_LAYOUT.managedYExtra }
  })
  return pos
}
