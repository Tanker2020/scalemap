import { useState, useMemo } from 'react'
import { ShieldCheck, AlertCircle, AlertTriangle } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { NODE_CONFIG, type NodeType, type NodeData } from '../../lib/nodeConfig'
import type { LintIssue } from '../../lib/lint/lintGraph'
import styles from './DiagnosticsPanel.module.css'

type SeverityFilter = 'all' | 'error' | 'warn'

const SEVERITY_COLOR: Record<LintIssue['severity'], string> = {
  error: '#EF4444',
  warn:  '#F59E0B',
}

/**
 * Diagnostics tab body — mounted inside UtilityDock (src/app/dock/UtilityDock.tsx), which
 * owns the shared right-edge shell (position, header, tab strip, Escape-to-close). This
 * component only renders the filter chips + issue list; it no longer manages its own
 * fixed-position chrome or close button (previously duplicated ReportsPanel's, which is how
 * the two ended up stacking on top of each other at the same right-edge position).
 */
export function DiagnosticsPanel() {
  const diagnostics = useDiagnosticsStore(s => s.diagnostics)
  const setSelectedNode = useUiStore(s => s.setSelectedNode)
  const nodes = useCanvasStore(s => s.nodes)
  const [filter, setFilter] = useState<SeverityFilter>('all')

  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // Drop issues whose node was deleted since the snapshot was taken.
  const live = useMemo(
    () => diagnostics.filter(i => !i.nodeId || nodeById.has(i.nodeId)),
    [diagnostics, nodeById],
  )
  const errorCount = live.filter(i => i.severity === 'error').length
  const warnCount  = live.filter(i => i.severity === 'warn').length
  const shown = filter === 'all' ? live : live.filter(i => i.severity === filter)

  const focusNode = (nodeId?: string) => {
    if (nodeId) setSelectedNode(nodeId)
  }

  return (
    <>
      {live.length > 0 && (
        <div className={styles.filters}>
          <button
            className={`${styles.chip} ${filter === 'all' ? styles.chipActive : ''}`}
            onClick={() => setFilter('all')}
          >
            All <span className={styles.chipCount}>{live.length}</span>
          </button>
          <button
            className={`${styles.chip} ${filter === 'error' ? styles.chipActive : ''}`}
            onClick={() => setFilter('error')}
            style={{ '--chip-accent': SEVERITY_COLOR.error } as React.CSSProperties}
          >
            Errors <span className={styles.chipCount}>{errorCount}</span>
          </button>
          <button
            className={`${styles.chip} ${filter === 'warn' ? styles.chipActive : ''}`}
            onClick={() => setFilter('warn')}
            style={{ '--chip-accent': SEVERITY_COLOR.warn } as React.CSSProperties}
          >
            Warnings <span className={styles.chipCount}>{warnCount}</span>
          </button>
        </div>
      )}

      <div className={styles.body}>
        {live.length === 0 ? (
          <div className={styles.empty}>
            <ShieldCheck size={26} className={styles.emptyIcon} />
            <div className={styles.emptyTitle}>No anti-patterns detected</div>
            <div className={styles.emptySub}>Your architecture passed all checks.</div>
          </div>
        ) : shown.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptySub}>No {filter === 'error' ? 'errors' : 'warnings'} in this run.</div>
          </div>
        ) : (
          shown.map(issue => {
            const node = issue.nodeId ? nodeById.get(issue.nodeId) : undefined
            const nodeType = node?.type as NodeType | undefined
            const cfg = nodeType ? NODE_CONFIG[nodeType] : undefined
            const label = (node?.data as NodeData | undefined)?.label
            const color = SEVERITY_COLOR[issue.severity]
            const Icon = issue.severity === 'error' ? AlertCircle : AlertTriangle
            return (
              <button
                key={issue.id}
                className={styles.issue}
                onClick={() => focusNode(issue.nodeId)}
                title={issue.nodeId ? 'Select this node on the canvas' : undefined}
              >
                <Icon size={14} className={styles.issueIcon} style={{ color }} />
                <div className={styles.issueBody}>
                  <div className={styles.issueMsg}>{issue.message}</div>
                  <div className={styles.issueRec}>{issue.recommendation}</div>
                  {label && (
                    <div className={styles.issueNode}>
                      {cfg?.icon && <cfg.icon size={10} />}
                      <span>{label}</span>
                    </div>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
