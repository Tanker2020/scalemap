import { useCallback, useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../../../lib/nodeConfig'
import { NODE_CONFIG, GROUPING_TYPES, type NodeType } from '../../../lib/nodeConfig'
import { CATEGORY_COLORS } from '../../../lib/theme'
import { PROVIDER_COLORS, PROVIDER_LABELS } from '../../../lib/cloudRegistry'
import { useCanvasStore } from '../../store/canvas.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useDiagnosticsStore } from '../../store/diagnostics.store'
import { useDisplayMetrics } from '../simulation/useDisplayMetrics'
import { useUiStore } from '../../store/ui.store'
import styles from './BaseNode.module.css'

export function BaseNode({ id, type, data, selected }: NodeProps) {
  const nodeData = data as NodeData
  const nodeType = type as NodeType

  if (GROUPING_TYPES.has(nodeType)) return null

  const config = NODE_CONFIG[nodeType]
  if (!config) return null

  const colors = CATEGORY_COLORS[config.category]
  const Icon = config.icon
  const themeMode = useUiStore(s => s.themeMode)
  const accentColor = themeMode === 'light' ? colors.foreground.light : colors.accent
  // CATEGORY_COLORS.bg/.border have no light-mode variant (dark navy/teal/etc squares) — fine as
  // a single icon chip on a canvas, but reads as "still dark mode" when the raw dark value is
  // used verbatim in light mode. Blend a soft tint of the (already-swapped) accent color instead.
  const iconChipBg     = themeMode === 'light' ? `color-mix(in srgb, ${accentColor} 12%, var(--color-node-base))` : colors.bg
  const iconChipBorder = themeMode === 'light' ? `color-mix(in srgb, ${accentColor} 35%, transparent)` : colors.border

  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(nodeData.label)
  const inputRef = useRef<HTMLInputElement>(null)
  const updateNodeData = useCanvasStore(s => s.updateNodeData)
  // Replay-aware: while scrubbing this resolves to the recorded metrics at the cursor.
  const m = useDisplayMetrics(id)
  const metrics = m
    ? { utilization: m.utilization, errorRate: m.errorRate, healthState: m.healthState, droppedRequests: m.droppedRequests }
    : null
  const isBottleneck = useSimulationStore(s => s.bottlenecks.has(id))
  const running    = useSimulationStore(s => s.running)
  const isConnectSource = useUiStore(s => s.connectSourceId === id)
  const lintIssues = useDiagnosticsStore(s => s.byNodeId.get(id))
  const isHighlighted = useUiStore(s => s.highlightedNodeIds.includes(id))

  const utilization  = metrics?.utilization ?? 0
  const isSaturated  = utilization >= 1.0

  // Hysteresis: enter critical at 82%, exit at 70% — prevents flickering near threshold
  const critRef = useRef(false)
  critRef.current = utilization >= 0.82 ? true : utilization <= 0.70 ? false : critRef.current
  const isCritical = isBottleneck && critRef.current

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  const commitEdit = useCallback(() => {
    setEditing(false)
    if (editValue.trim() && editValue !== nodeData.label) {
      updateNodeData(id, { label: editValue.trim(), labelCustomized: true })
    } else {
      setEditValue(nodeData.label)
    }
  }, [editValue, nodeData.label, id, updateNodeData])

  // Live health state from simulation overrides the static canvas status while running
  const displayStatus = (running && metrics?.healthState) ? metrics.healthState : nodeData.status
  const statusColor = {
    healthy:  'var(--color-success)',
    degraded: 'var(--color-warning)',
    down:     'var(--color-danger)',
    idle:     'var(--color-text-muted)',
  }[displayStatus] ?? 'var(--color-text-muted)'

  // Saturation border overrides the normal border during simulation
  const saturationBorderColor = isSaturated
    ? 'var(--color-danger)'
    : isCritical
    ? 'var(--color-warning)'
    : undefined

  // Utilization bar color
  const utilColor = utilization >= 0.8
    ? 'var(--color-danger)'
    : utilization >= 0.5
    ? 'var(--color-warning)'
    : accentColor

  // Lint diagnostics: colour by the most severe issue on this node, tooltip lists them all.
  const hasLintError = !!lintIssues?.some(i => i.severity === 'error')
  const lintColor = hasLintError ? 'var(--color-danger)' : 'var(--color-warning)'
  const lintTitle = lintIssues
    ?.map(i => `${i.severity === 'error' ? '✕' : '⚠'} ${i.message} — ${i.recommendation}`)
    .join('\n')

  // Breathing glow only for nodes that are actually healthy/active — not idle, degraded, or down
  const isHealthy = displayStatus === 'healthy'

  return (
    <motion.div
      className={[
        styles.node,
        selected ? styles.selected : '',
        isConnectSource ? styles.connectSource : '',
        isSaturated ? styles.saturated : isCritical ? styles.critical : '',
        isHighlighted ? styles.diagnosticPulse : '',
      ].filter(Boolean).join(' ')}
      style={{
        '--accent': accentColor,
        '--node-accent': accentColor,
        '--node-bg': iconChipBg,
        '--node-border': iconChipBorder,
        ...(saturationBorderColor && {
          '--saturation-border': saturationBorderColor,
        }),
      } as React.CSSProperties}
      data-healthy={isHealthy}
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.8, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
    >
      <Handle type="target" position={Position.Top}    className={styles.handle} />
      <Handle type="target" position={Position.Left}   className={styles.handle} />
      <Handle type="source" position={Position.Bottom} className={styles.handle} />
      <Handle type="source" position={Position.Right}  className={styles.handle} />

      <div className={styles.iconWrap}>
        <Icon className={styles.nodeIcon} size={14} strokeWidth={1.5} />
      </div>

      <div className={styles.body}>
        {editing ? (
          <input
            ref={inputRef}
            className={styles.labelInput}
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') { setEditing(false); setEditValue(nodeData.label) }
            }}
          />
        ) : (
          <div
            className={styles.label}
            onDoubleClick={() => { if (running) return; setEditing(true); setEditValue(nodeData.label) }}
          >
            {nodeData.label}
          </div>
        )}
        {nodeData.subtitle && <div className={styles.subtitle}>{nodeData.subtitle}</div>}
        {nodeData.provider && nodeData.provider !== 'generic' && (
          <div
            className={styles.providerBadge}
            style={{ '--prov-color': PROVIDER_COLORS[nodeData.provider] } as React.CSSProperties}
          >
            {PROVIDER_LABELS[nodeData.provider]}
          </div>
        )}

        {/* Universal utilization bar — shown for all node types during simulation */}
        {running && utilization > 0 && (
          <div className={styles.utilBar}>
            <motion.div
              className={`${styles.utilFill} ${utilization >= 0.8 ? styles.utilPulse : ''}`}
              style={{ background: utilColor }}
              animate={{ width: `${Math.round(Math.min(1, utilization) * 100)}%` }}
              transition={{ type: 'tween', duration: 0.3 }}
            />
          </div>
        )}
        {running && (metrics?.droppedRequests ?? 0) > 0 && (
          <div className={styles.droppedCount} title="Requests dropped at this node since simulation start">
            ↓ {(metrics!.droppedRequests! >= 1000
              ? `${(metrics!.droppedRequests! / 1000).toFixed(1)}k`
              : metrics!.droppedRequests)} dropped
          </div>
        )}
      </div>

      <div className={styles.right}>
        {/* Architectural lint badge — from on-demand diagnostics, severity-coloured */}
        {lintIssues && lintIssues.length > 0 && (
          <div
            className={styles.lintBadge}
            style={{ '--lint-color': lintColor } as React.CSSProperties}
            title={lintTitle}
          >
            {lintIssues.length > 9 ? '9+' : lintIssues.length}
          </div>
        )}
        {/* Bottleneck badge — simulation-driven, does not mutate NodeData.status */}
        {running && isCritical && (
          <div
            className={styles.bottleneckBadge}
            title={isSaturated ? 'Saturated — requests being dropped' : 'High utilization — approaching capacity'}
          >
            {isSaturated ? '●' : '▲'}
          </div>
        )}
        {nodeData.warnings.length > 0 && (
          <div className={styles.warnDot} title={nodeData.warnings.join('\n')}>!</div>
        )}
        <div
          className={styles.statusDot}
          style={{ background: statusColor, boxShadow: `0 0 6px color-mix(in srgb, ${statusColor} 60%, transparent)` }}
        />
      </div>
    </motion.div>
  )
}
