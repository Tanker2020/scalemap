// The analysis registry + runner (Phase 6 D1/D3). ONE array; T2 appends network, T3 appends capacity.
// Pure: builds the input once, concatenates every rule's output, sorts severity→family→ruleId.
import type { WorldDoc, CompiledWorld } from '../world/types'
import type { MetricsBatch } from '../worldEngine/types'
import type { AnalysisFinding, AnalysisRule, AnalysisInput } from './types'
import { structuralRules } from './rules/structural'
import { networkRules } from './rules/network'
// T3: import { capacityRules } from './rules/capacity'

export const ANALYSIS_RULES: AnalysisRule[] = [
  ...structuralRules,
  ...networkRules,
  // ...capacityRules,  // ← T3 uncomments/adds
]

const SEV_RANK: Record<AnalysisFinding['severity'], number> = { critical: 0, warning: 1, info: 2 }
const FAM_RANK: Record<AnalysisFinding['family'], number> = { structural: 0, network: 1, capacity: 2 }

export function runAnalysis(doc: WorldDoc, compiled: CompiledWorld, lastBatch: MetricsBatch | null): AnalysisFinding[] {
  const input: AnalysisInput = { doc, compiled, lastBatch }
  const findings = ANALYSIS_RULES.flatMap(rule => rule.run(input))
  return findings.sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) ||
    (FAM_RANK[a.family] - FAM_RANK[b.family]) ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  )
}
