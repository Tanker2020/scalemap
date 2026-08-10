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

// I1 fix (final wave-5 review): `importJson` used to push whatever `parsed.summaries` contained
// with zero shape validation — a well-formed-JSON-but-wrong-shape file produced entries that
// rendered fine in the compare-panel picker, then threw uncaught inside ComparePanel.tsx's
// MetricRow (`format(n) => n.toFixed(0)` on a non-number) the moment it was actually selected for
// comparison, with no error boundary anywhere in the app to catch it — a white-screen crash. This
// is a minimal structural check, not a full schema validator: just enough to guarantee every
// field ComparePanel's render path actually dereferences (id/label plus the numeric latency/cost
// fields `format()` calls `.toFixed()` on) is present and the right type before it ever reaches
// `summaries`.
function isValidRunSummaryShape(x: unknown): x is RunSummary {
  if (typeof x !== 'object' || x === null) return false
  const r = x as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.label !== 'string') return false
  const latency = r.latency as Record<string, unknown> | null | undefined
  if (typeof latency !== 'object' || latency === null) return false
  if (typeof latency.p50Ms !== 'number' || typeof latency.p90Ms !== 'number' || typeof latency.p99Ms !== 'number') return false
  const cost = r.cost as Record<string, unknown> | null | undefined
  if (typeof cost !== 'object' || cost === null) return false
  if (typeof cost.meanHourlyUsd !== 'number' || typeof cost.totalUsd !== 'number' || typeof cost.peakHourlyUsd !== 'number') return false
  return true
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
    const parsed: unknown = JSON.parse(json)
    const summaries = (parsed as { summaries?: unknown } | null)?.summaries
    if (!Array.isArray(summaries) || !summaries.every(isValidRunSummaryShape)) {
      // Thrown, never caught here: ComparePanel.tsx's Import button already wraps this call in a
      // try/catch that routes any failure into its existing `fileError` banner (Task 7) — no new
      // error UI. Throwing (rather than silently no-op-ing) also guarantees `summaries` in the
      // store is left untouched on a shape mismatch, not partially corrupted.
      throw new Error('Malformed baseline export: expected { summaries: RunSummary[] } with valid id/label/latency/cost fields.')
    }
    set(s => ({ summaries: [...s.summaries, ...summaries] }))
  },
}))
