import { create } from 'zustand'
import type { LintIssue } from '../../lib/lint/lintGraph'

// Holds the most recent on-demand lint run. Snapshot semantics: results persist until the next run
// or an explicit clear — they are NOT recomputed reactively. byNodeId is derived once per run so
// node components get a stable O(1) lookup with a reference that only changes when results change.
interface DiagnosticsStore {
  diagnostics: LintIssue[]
  byNodeId: Map<string, LintIssue[]>
  setDiagnostics: (issues: LintIssue[]) => void
  clearDiagnostics: () => void
}

function indexByNode(issues: LintIssue[]): Map<string, LintIssue[]> {
  const map = new Map<string, LintIssue[]>()
  for (const issue of issues) {
    if (!issue.nodeId) continue
    const arr = map.get(issue.nodeId)
    if (arr) arr.push(issue)
    else map.set(issue.nodeId, [issue])
  }
  return map
}

export const useDiagnosticsStore = create<DiagnosticsStore>((set) => ({
  diagnostics: [],
  byNodeId: new Map(),
  setDiagnostics: (issues) => set({ diagnostics: issues, byNodeId: indexByNode(issues) }),
  clearDiagnostics: () => set({ diagnostics: [], byNodeId: new Map() }),
}))
