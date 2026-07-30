// On-demand AI architecture review UI (Phase 6, D8). Mounted at the top of AnalysisTab.
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings } from '../../../lib/tauri'
import { buildReviewContext, requestReview, type AiIssue } from '../../../lib/llmReview'
import { navigateToEntity, entityLabel } from '../entityNav'
import { CATEGORY_COLORS } from '../../../lib/theme'

export interface AiReviewSectionProps {
  openSettings: () => void
}

type ReviewState = 'idle' | 'in-flight' | 'done' | 'error'

const chipStyle: CSSProperties = {
  display: 'inline-block', padding: '1px 6px', borderRadius: 3,
  font: '10px var(--font-mono)', color: 'var(--color-on-accent)', background: CATEGORY_COLORS.messaging.accent,
}
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const linkBtnStyle: CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-accent)', textDecoration: 'underline',
}
const SEVERITY_COLOR = { critical: 'var(--color-danger)', warning: 'var(--color-warning)', info: 'var(--color-text-muted)' } as const

export function AiReviewSection({ openSettings }: AiReviewSectionProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)

  // Recomputed here rather than threaded down as a prop — AiReviewSection's pinned signature is
  // `{ openSettings: () => void }` only, and runAnalysis is a cheap, pure recomputation (spec D3:
  // "analysis runs continuously, cheaply") — so a second call here to avoid a prop is intentional.
  const currentAnalysisFindings = useMemo(
    () => runAnalysis(doc, compiled, displayBatch),
    [doc, compiled, displayBatch],
  )

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [state, setState] = useState<ReviewState>('idle')
  const [issues, setIssues] = useState<AiIssue[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    loadLlmSettings().then(s => setConfigured(s.baseUrl.trim().length > 0))
  }, [])

  const review = async () => {
    setState('in-flight')
    setError('')
    try {
      const settings = await loadLlmSettings()
      const context = buildReviewContext(doc, compiled, currentAnalysisFindings, displayBatch ?? null)
      const result = await requestReview(settings, context)
      setIssues(result)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'review failed')
      setState('error') // previous cards (issues state) are intentionally left untouched
    }
  }

  if (configured === false) {
    return (
      <div style={{ marginBottom: 12 }}>
        <span style={chipStyle}>AI</span>
        <div style={{ marginTop: 4, color: 'var(--color-text-muted)' }}>
          No AI endpoint configured. <button style={linkBtnStyle} onClick={openSettings}>Open Settings</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={chipStyle}>AI</span>
        <button disabled={state === 'in-flight'} onClick={review} style={smallBtnStyle}>
          {state === 'in-flight' ? 'reviewing…' : 'Review architecture'}
        </button>
      </div>
      {state === 'error' && <div style={{ color: 'var(--color-danger)', marginTop: 4 }}>{error}</div>}
      {issues.map((issue, i) => (
        <div key={i} style={{ marginTop: 8, borderTop: '1px solid var(--color-node-border)', paddingTop: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={chipStyle}>AI</span>
            <span>{issue.title}</span>
            <span style={{ color: SEVERITY_COLOR[issue.severity] }}>{issue.severity}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{`${Math.round(issue.confidence * 100)}%`}</span>
          </div>
          <div>{issue.reasoning}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{`→ ${issue.recommendation}`}</div>
          <div style={{ color: 'var(--color-text-muted)' }}>{`${issue.estimated_effort} effort`}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            {issue.affected.map(id => (
              <button key={id} style={smallBtnStyle} onClick={() => navigateToEntity(id, doc, compiled, useNavStore.getState())}>{entityLabel(id, doc, compiled)}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
