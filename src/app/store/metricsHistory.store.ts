import { create } from 'zustand'

export interface MetricSnapshot {
  t: number
  inRps: number
  utilization: number
  errorRate: number
  p90LatencyMs: number
}

const MAX_HISTORY = 300 // 5 minutes at 1s resolution

interface MetricsHistoryStore {
  history: Map<string, MetricSnapshot[]>
  systemHistory: MetricSnapshot[]
  record: (nodeId: string, snapshot: MetricSnapshot) => void
  recordSystem: (snapshot: MetricSnapshot) => void
  clearHistory: () => void
}

export const useMetricsHistoryStore = create<MetricsHistoryStore>((set) => ({
  history: new Map(),
  systemHistory: [],

  record: (nodeId, snapshot) =>
    set(s => {
      const next = new Map(s.history)
      const existing = next.get(nodeId) ?? []
      const updated = [...existing, snapshot]
      if (updated.length > MAX_HISTORY) updated.splice(0, updated.length - MAX_HISTORY)
      next.set(nodeId, updated)
      return { history: next }
    }),

  recordSystem: (snapshot) =>
    set(s => {
      const updated = [...s.systemHistory, snapshot]
      if (updated.length > MAX_HISTORY) updated.splice(0, updated.length - MAX_HISTORY)
      return { systemHistory: updated }
    }),

  clearHistory: () => set({ history: new Map(), systemHistory: [] }),
}))
