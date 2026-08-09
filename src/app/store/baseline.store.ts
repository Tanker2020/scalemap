import { create } from 'zustand'
import { buildRunSummary, type RunSummary } from '../../lib/runSummary'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type { ReplayFrame } from '../../lib/worldEngine/types'

interface BaselineState {
  summaries: RunSummary[]
  compareA: string | null
  compareB: string | null
  capture: (frames: ReplayFrame[], doc: WorldDoc, compiled: CompiledWorld, label: string) => void
  remove: (id: string) => void
  setCompareA: (id: string | null) => void
  setCompareB: (id: string | null) => void
  exportJson: () => string
  importJson: (json: string) => void
}

export const useBaselineStore = create<BaselineState>((set, get) => ({
  summaries: [],
  compareA: null,
  compareB: null,
  capture: (frames, doc, compiled, label) => {
    const summary = buildRunSummary(frames, doc, compiled, label)
    set(s => ({ summaries: [...s.summaries, summary] }))
  },
  remove: (id) => set(s => ({
    summaries: s.summaries.filter(x => x.id !== id),
    compareA: s.compareA === id ? null : s.compareA,
    compareB: s.compareB === id ? null : s.compareB,
  })),
  setCompareA: (id) => set({ compareA: id }),
  setCompareB: (id) => set({ compareB: id }),
  exportJson: () => JSON.stringify({ summaries: get().summaries }, null, 2),
  importJson: (json) => {
    const parsed = JSON.parse(json) as { summaries: RunSummary[] }
    set(s => ({ summaries: [...s.summaries, ...parsed.summaries] }))
  },
}))
