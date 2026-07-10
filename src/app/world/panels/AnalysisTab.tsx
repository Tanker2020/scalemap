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
import { sectionLabel } from './panelStyles'

export interface NavApi {
  goRegion: (regionId: string) => void
  goAz: (regionId: string, azId: string) => void
  goServer: (regionId: string, azId: string, serverId: string) => void
}

// Resolve an entity id against doc → compiled maps and navigate; returns whether nav happened.
export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean {
  if (doc.regions[id]) { nav.goRegion(id); return true }
  const az = doc.azs[id]
  if (az) { nav.goAz(az.regionId, id); return true }
  const server = doc.servers[id]
  if (server) {
    const a = doc.azs[server.azId]
    if (a) { nav.goServer(a.regionId, a.id, id); return true }
  }
  const inst = compiled.instances[id]
  if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false // blueprint/placement/population/managed → no nav (shown in panels)
}

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

const FAMILY_LABEL: Record<AnalysisFamily, string> = { structural: 'Structural', network: 'Network', capacity: 'Capacity' }
const chipBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)', borderRadius: 3,
  padding: '1px 6px', margin: '0 4px 4px 0', cursor: 'pointer',
  font: '10px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const sevChip = (sev: AnalysisSeverity | 'error' | 'warning'): CSSProperties => ({
  padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)', color: '#fff',
  background: sev === 'critical' || sev === 'error' ? 'var(--color-danger)'
    : sev === 'warning' ? 'var(--color-warning)' : 'var(--color-text-muted)',
})

function entityLabel(id: string, doc: WorldDoc, compiled: CompiledWorld): string {
  if (doc.regions[id]) return doc.regions[id].catalogId
  if (doc.azs[id]) return doc.azs[id].label
  if (doc.servers[id]) return doc.servers[id].label
  if (doc.blueprints[id]) return doc.blueprints[id].name
  if (doc.managedServices[id]) return doc.managedServices[id].label
  if (doc.populations[id]) return doc.populations[id].label
  const inst = compiled.instances[id]
  if (inst) return `${doc.servers[inst.serverId]?.label ?? inst.serverId}·${doc.blueprints[inst.blueprintId]?.name ?? ''}`
  return id
}

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

export function AnalysisTab(): ReactElement {
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
      {empty && <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>}
      {groups.map(g => (
        <div key={g.fam}>
          <div style={sectionLabel}>{FAMILY_LABEL[g.fam]}</div>
          {g.items.map(f => <FindingRow key={f.id} f={f} doc={doc} compiled={compiled} />)}
        </div>
      ))}
      {compileExtra.length > 0 && (
        <div>
          <div style={sectionLabel}>Compile</div>
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
