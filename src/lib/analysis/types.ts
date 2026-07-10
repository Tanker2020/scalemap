// Analysis engine types (Phase 6 D1). Pure over the compiled world; the optional MetricsBatch is
// input, never fetched. Findings are derived data — never stored or serialized.
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { MetricsBatch } from '../worldEngine/types'

export type AnalysisFamily = 'structural' | 'network' | 'capacity'
export type AnalysisSeverity = 'critical' | 'warning' | 'info'

export interface AnalysisFinding {
  id: string                 // `${ruleId}:${primaryAffectedId}` (world-scoped rules use `:world`)
  ruleId: string
  family: AnalysisFamily
  severity: AnalysisSeverity
  title: string              // short, e.g. 'Single-AZ region'
  why: string                // one/two sentences with concrete entity names inlined
  fix: string                // actionable; names the panel/edit that resolves it
  affected: string[]         // entity ids, most-specific first
}

export interface AnalysisInput { doc: WorldDoc; compiled: CompiledWorld; lastBatch: MetricsBatch | null }
export interface AnalysisRule { id: string; family: AnalysisFamily; run: (input: AnalysisInput) => AnalysisFinding[] }
