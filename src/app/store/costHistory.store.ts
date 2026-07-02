import { create } from 'zustand'
import type { NodeCategory } from '../../lib/nodeConfig'

// 1Hz cost sample timeseries, mirroring metricsHistory.store.ts's ring-buffer shape. Sampled
// from the SAME 1s interval SimulationOverlay.tsx already runs for metrics/SLO recording (see
// the `record`/`recordSystem` calls there) — this store just gets a `record` call added
// alongside them, no new timer. Kept as its own store (not folded into metricsHistory.store.ts)
// because cost is a derived-from-config-and-traffic projection recomputed by CostTracker, not a
// raw engine metric, and CostTracker is the only consumer — no reason to widen metricsHistory's
// surface for a single-consumer concern.
export interface CostSnapshot {
  t: number
  totalHourlyUsd: number
  totalMonthlyUsd: number
  byCategory: Partial<Record<NodeCategory, number>> // monthlyUsd per category at this sample
}

const MAX_HISTORY = 300 // 5 minutes at 1s resolution, matches metricsHistory.store.ts

interface CostHistoryStore {
  history: CostSnapshot[]
  record: (snapshot: CostSnapshot) => void
  clearHistory: () => void
}

export const useCostHistoryStore = create<CostHistoryStore>((set) => ({
  history: [],

  record: (snapshot) =>
    set(s => {
      const updated = [...s.history, snapshot]
      if (updated.length > MAX_HISTORY) updated.splice(0, updated.length - MAX_HISTORY)
      return { history: updated }
    }),

  clearHistory: () => set({ history: [] }),
}))
