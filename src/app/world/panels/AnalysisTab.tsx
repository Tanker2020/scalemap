// Analysis tab (Phase 6 D4): merges deterministic analysis findings (runAnalysis) with the
// unsuppressed compile findings, grouped by family, with clickable affected chips that navigate.
import { useMemo, type ReactElement, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import type { AnalysisFinding, AnalysisFamily, AnalysisSeverity } from '../../../lib/analysis/types'
import type { WorldDoc, CompiledWorld, CompileFinding } from '../../../lib/world/types'
import { SectionHeader } from '../ui/kit'
import { AiReviewSection } from './AiReviewSection'
import { navigateToEntity, entityLabel } from '../entityNav'

export { navigateToEntity, entityLabel } from '../entityNav'

// Compile findings not already claimed by a blocked-dependency-path analysis finding (D4).
export function unsuppressedCompileFindings(analysis: AnalysisFinding[], compile: CompileFinding[]): CompileFinding[] {
  const claimed = new Set(
    analysis.filter(f => f.ruleId === 'blocked-dependency-path').map(f => f.id.slice('blocked-dependency-path:'.length)),
  )
  return compile.filter(cf => {
    if (cf.kind !== 'blocked-path') return true
    const pathId = cf.id.startsWith('finding-') ? cf.id.slice('finding-'.length) : cf.id
    return !claimed.has(pathId)
  })
}

const FAMILY_HEADER: Record<AnalysisFamily, string> = { structural: '▸ STRUCTURAL', network: '▸ NETWORK', capacity: '▸ CAPACITY' }
const chipBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)', borderRadius: 3,
  padding: '1px 6px', margin: '0 4px 4px 0', cursor: 'pointer',
  font: '10px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const sevChip = (sev: AnalysisSeverity | 'error' | 'warning'): CSSProperties => ({
  padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)', color: 'var(--color-on-accent)',
  background: sev === 'critical' || sev === 'error' ? 'var(--color-danger)'
    : sev === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)',
})

function AffectedChips({ ids, doc, compiled }: { ids: string[]; doc: WorldDoc; compiled: CompiledWorld }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 4 }}>
      {ids.map(id => {
        const canNav = navigateToEntity(id, doc, compiled, { goRegion: () => {}, goAz: () => {}, goServer: () => {} })
        return (
          <button key={id} style={chipBtn} title={canNav ? 'navigate' : 'edit via panels'}
            onClick={() => navigateToEntity(id, doc, compiled, useNavStore.getState())}>
            {entityLabel(id, doc, compiled)}
          </button>
        )
      })}
    </div>
  )
}

function FindingRow({ f, doc, compiled }: { f: AnalysisFinding; doc: WorldDoc; compiled: CompiledWorld }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={sevChip(f.severity)}>{f.severity}</span>
        <span style={{ color: 'var(--color-text-primary)' }}>{f.title}</span>
      </div>
      <div style={{ marginTop: 2, color: 'var(--color-text-secondary)' }}>{f.why}</div>
      <div style={{ marginTop: 2, color: 'var(--color-text-muted)' }}>→ {f.fix}</div>
      {f.affected.length > 0 && <AffectedChips ids={f.affected} doc={doc} compiled={compiled} />}
    </div>
  )
}

export interface AnalysisTabProps {
  openSettings: () => void
}

export function AnalysisTab({ openSettings }: AnalysisTabProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const findings = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const compileExtra = useMemo(() => unsuppressedCompileFindings(findings, compiled.findings), [findings, compiled.findings])

  const families: AnalysisFamily[] = ['structural', 'network', 'capacity']
  const groups = families.map(fam => ({ fam, items: findings.filter(f => f.family === fam) })).filter(g => g.items.length > 0)
  const empty = groups.length === 0 && compileExtra.length === 0

  return (
    <div>
      <AiReviewSection openSettings={openSettings} />
      {empty && <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>}
      {groups.map(g => (
        <div key={g.fam}>
          <SectionHeader label={FAMILY_HEADER[g.fam]} />
          {g.items.map(f => <FindingRow key={f.id} f={f} doc={doc} compiled={compiled} />)}
        </div>
      ))}
      {compileExtra.length > 0 && (
        <div>
          <SectionHeader label="▸ COMPILE" />
          {compileExtra.map(cf => (
            <div key={cf.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={sevChip(cf.severity)}>{cf.severity}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{cf.kind}</span>
              </div>
              <div style={{ marginTop: 2 }}>{cf.message}</div>
              {cf.affected.length > 0 && <AffectedChips ids={cf.affected} doc={doc} compiled={compiled} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
