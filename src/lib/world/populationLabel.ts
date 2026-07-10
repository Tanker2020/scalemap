// src/lib/world/populationLabel.ts
// Shared default-label generator for client populations (Phase 6 T9 carry-forward, closing a
// Phase-5 backlog item). TrafficPanel.tsx's "+ add" and GlobeView.tsx's click-to-place handler
// each independently derived `pop-${N}` from a LENGTH counter (`populations.length + 1` /
// `populationCount + 1`) — after a remove+re-add from either surface the two counters can
// re-issue the SAME default label (labels are user-editable free text, not unique ids, but a
// silent duplicate default is still a rough edge worth closing). This scans the actual
// populations map for the highest existing `pop-<N>` suffix and returns `pop-<max+1>`, so neither
// authoring surface can collide with the other, or with a population manually renamed back to a
// `pop-N`-shaped label.
import type { ClientPopulation, PopulationId } from './types'

const POP_LABEL_RE = /^pop-(\d+)$/

export function nextPopulationLabel(populations: Record<PopulationId, ClientPopulation>): string {
  let max = 0
  for (const pop of Object.values(populations)) {
    const m = POP_LABEL_RE.exec(pop.label)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `pop-${max + 1}`
}
