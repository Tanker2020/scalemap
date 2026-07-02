import { useState, useEffect, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ShieldCheck, AlertCircle, AlertTriangle, ChevronDown,
  Unplug, ShieldAlert, Inbox, Send, PlugZap, RefreshCcw, Waypoints, Scale, GitBranchPlus,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { NODE_CONFIG, type NodeType, type NodeData } from '../../lib/nodeConfig'
import { LINT_RULES } from '../../lib/lint/rules'
import type { LintIssue } from '../../lib/lint/lintGraph'
import styles from './DiagnosticsPanel.module.css'

type SeverityFilter = 'all' | 'error' | 'warn'

const SEVERITY_COLOR: Record<LintIssue['severity'], string> = {
  error: 'var(--color-danger)',
  warn:  'var(--color-warning)',
}

// Human title + icon per ruleId — the rule functions themselves stay untouched;
// this is presentation-only metadata for grouping the flat issue list.
const RULE_META: Record<string, { title: string; icon: LucideIcon }> = {
  'isolated-node':      { title: 'Isolated Nodes',          icon: Unplug },
  'exposed-db':          { title: 'Exposed Databases',       icon: ShieldAlert },
  'no-queue-consumer':   { title: 'Unconsumed Queues',       icon: Inbox },
  'no-queue-producer':   { title: 'Unproduced Queues',       icon: Send },
  'lambda-direct-db':    { title: 'Lambda → DB Direct',      icon: PlugZap },
  'circular-dep':        { title: 'Circular Dependencies',   icon: RefreshCcw },
  'single-entry-spof':   { title: 'Single Points of Failure', icon: Waypoints },
  'unbalanced-lb':        { title: 'Unbalanced Load Balancers', icon: Scale },
  'deep-sync-chain':     { title: 'Deep Sync Chains',        icon: GitBranchPlus },
}

const FALLBACK_RULE_META = { title: 'Other Findings', icon: AlertTriangle }

// Highlight pulse self-clears after this long — long enough to register as "look here",
// short enough it doesn't fight the user's own subsequent selection.
const HIGHLIGHT_MS = 2200

const MAX_PATH_CHIPS = 5

function PathChips({ path, nodeById, onFocus }: {
  path: string[]
  nodeById: Map<string, ReturnType<typeof useCanvasStore.getState>['nodes'][number]>
  onFocus: (ids: string[]) => void
}) {
  const overflow = path.length > MAX_PATH_CHIPS
  // Keep first 2 and last 2 hops visible, collapse the middle — the endpoints of a chain/cycle
  // are usually the most meaningful (entry + the flagged node), the middle is "the rest of it".
  const shown = overflow
    ? [...path.slice(0, 2), null, ...path.slice(-2)]
    : path

  return (
    <div className={styles.pathStrip}>
      {shown.map((nodeId, i) => {
        if (nodeId === null) {
          return (
            <span key={`gap-${i}`} className={styles.pathMore}>
              +{path.length - 4} more
            </span>
          )
        }
        const node = nodeById.get(nodeId)
        const nodeType = node?.type as NodeType | undefined
        const cfg = nodeType ? NODE_CONFIG[nodeType] : undefined
        const label = (node?.data as NodeData | undefined)?.label ?? nodeId
        const Icon = cfg?.icon
        return (
          <span key={`${nodeId}-${i}`} className={styles.pathHop}>
            {i > 0 && <span className={styles.pathArrow}>→</span>}
            <button
              type="button"
              className={styles.pathChip}
              onClick={(e) => { e.stopPropagation(); onFocus([nodeId]) }}
              title={label}
            >
              {Icon && <Icon size={9} />}
              <span className={styles.pathChipLabel}>{label}</span>
            </button>
          </span>
        )
      })}
    </div>
  )
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
  const setHighlightedNodes = useUiStore(s => s.setHighlightedNodes)
  const nodes = useCanvasStore(s => s.nodes)
  const [filter, setFilter] = useState<SeverityFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Escape-to-close is owned by UtilityDock (the shared shell) now, not this panel.
  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current) }, [])


  const nodeById = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  // Drop issues whose node was deleted since the snapshot was taken.
  const live = useMemo(
    () => diagnostics.filter(i => !i.nodeId || nodeById.has(i.nodeId)),
    [diagnostics, nodeById],
  )
  const errorCount = live.filter(i => i.severity === 'error').length
  const warnCount  = live.filter(i => i.severity === 'warn').length
  const filtered = filter === 'all' ? live : live.filter(i => i.severity === filter)

  // Group by ruleId, preserving first-seen order, then sort groups with any error first.
  const groups = useMemo(() => {
    const byRule = new Map<string, LintIssue[]>()
    for (const issue of filtered) {
      const arr = byRule.get(issue.ruleId)
      if (arr) arr.push(issue)
      else byRule.set(issue.ruleId, [issue])
    }
    return Array.from(byRule.entries())
      .map(([ruleId, issues]) => ({
        ruleId,
        issues,
        hasError: issues.some(i => i.severity === 'error'),
      }))
      .sort((a, b) => (a.hasError === b.hasError ? 0 : a.hasError ? -1 : 1))
  }, [filtered])

  const focusIssue = (issue: LintIssue) => {
    if (issue.nodeId) setSelectedNode(issue.nodeId)
    const targets = issue.path && issue.path.length > 0 ? issue.path : (issue.nodeId ? [issue.nodeId] : [])
    if (targets.length === 0) return
    focusNodes(targets)
  }

  const focusNodes = (ids: string[]) => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
    setHighlightedNodes(ids)
    clearTimer.current = setTimeout(() => setHighlightedNodes([]), HIGHLIGHT_MS)
  }

  const toggleGroup = (ruleId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(ruleId)) next.delete(ruleId)
      else next.add(ruleId)
      return next
    })
  }

  return (
    <>
      {live.length > 0 && (
        <div className={styles.summary}>
          {errorCount > 0 ? (
            <span>
              <strong className={styles.summaryError}>{errorCount}</strong> critical
              {warnCount > 0 && <> · <strong className={styles.summaryWarn}>{warnCount}</strong> warning{warnCount === 1 ? '' : 's'}</>}
            </span>
          ) : (
            <span><strong className={styles.summaryWarn}>{warnCount}</strong> warning{warnCount === 1 ? '' : 's'} — no critical issues</span>
          )}
        </div>
      )}

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
          <motion.div
            className={styles.empty}
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 340, damping: 22 }}
          >
            <div className={styles.emptyGlow}>
              <ShieldCheck size={30} className={styles.emptyIcon} />
            </div>
            <div className={styles.emptyTitle}>No anti-patterns detected</div>
            <div className={styles.emptySub}>
              {LINT_RULES.length} structural checks passed. Your architecture looks solid.
            </div>
          </motion.div>
        ) : filtered.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptySub}>No {filter === 'error' ? 'errors' : 'warnings'} in this run.</div>
          </div>
        ) : (
          groups.map(group => {
            const meta = RULE_META[group.ruleId] ?? FALLBACK_RULE_META
            const GroupIcon = meta.icon
            const isCollapsed = collapsed.has(group.ruleId)
            const accent = group.hasError ? SEVERITY_COLOR.error : SEVERITY_COLOR.warn

            return (
              <div key={group.ruleId} className={styles.group}>
                <button
                  className={styles.groupHeader}
                  onClick={() => toggleGroup(group.ruleId)}
                  style={{ '--group-accent': accent } as React.CSSProperties}
                >
                  <GroupIcon size={12} className={styles.groupIcon} />
                  <span className={styles.groupTitle}>{meta.title}</span>
                  <span className={styles.groupCount}>{group.issues.length}</span>
                  <ChevronDown
                    size={12}
                    className={`${styles.groupChevron} ${isCollapsed ? styles.groupChevronCollapsed : ''}`}
                  />
                </button>

                <AnimatePresence initial={false}>
                  {!isCollapsed && (
                    <motion.div
                      className={styles.groupBody}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                      {group.issues.map(issue => {
                        const node = issue.nodeId ? nodeById.get(issue.nodeId) : undefined
                        const nodeType = node?.type as NodeType | undefined
                        const cfg = nodeType ? NODE_CONFIG[nodeType] : undefined
                        const label = (node?.data as NodeData | undefined)?.label
                        const color = SEVERITY_COLOR[issue.severity]
                        const Icon = issue.severity === 'error' ? AlertCircle : AlertTriangle
                        const hasPath = issue.path && issue.path.length > 1

                        return (
                          <button
                            key={issue.id}
                            className={styles.issue}
                            onClick={() => focusIssue(issue)}
                            title={issue.nodeId ? 'Select and focus this node on the canvas' : undefined}
                          >
                            <Icon size={14} className={styles.issueIcon} style={{ color }} />
                            <div className={styles.issueBody}>
                              <div className={styles.issueMsg}>{issue.message}</div>
                              <div className={styles.issueRec}>{issue.recommendation}</div>
                              {hasPath ? (
                                <PathChips path={issue.path!} nodeById={nodeById} onFocus={focusNodes} />
                              ) : label && (
                                <div className={styles.issueNode}>
                                  {cfg?.icon && <cfg.icon size={10} />}
                                  <span>{label}</span>
                                </div>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })
        )}
      </div>
    </>
  )
}
