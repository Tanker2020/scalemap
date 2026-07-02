import { motion, AnimatePresence } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { NODE_CONFIG, type NodeType } from '../../lib/nodeConfig'
import styles from './MetricsDrawer.module.css'

interface MetricsDrawerProps {
  open: boolean
  onToggle: () => void
}

export function MetricsDrawer({ open, onToggle }: MetricsDrawerProps) {
  const running     = useSimulationStore(s => s.running)
  const nodeMetrics = useSimulationStore(s => s.nodeMetrics)
  const events      = useSimulationStore(s => s.events)
  const runs        = useSimulationStore(s => s.runs)
  const { nodes }   = useCanvasStore()
  const { setSelectedNode, setSimConfigOpen, setSimConfigPanelNode, openDockTab } = useUiStore()

  const lastRun = runs[0] ?? null

  if (!running && events.length === 0 && runs.length === 0) return null

  const activeNodes = nodes.filter(n => {
    const cfg = NODE_CONFIG[n.type as NodeType]
    return cfg && !cfg.isGroup
  })

  function handleDotClick(nodeId: string) {
    setSimConfigPanelNode(nodeId)
    setSimConfigOpen(true)
    setSelectedNode(nodeId)
  }

  return (
    <div className={styles.wrapper}>
      <button className={styles.toggleBar} onClick={onToggle}>
        <span className={styles.toggleLabel}>
          {running ? 'Live Metrics' : 'Last Run'} {open ? '▾' : '▴'}
        </span>
        {running && <span className={styles.liveIndicator}>● LIVE</span>}
        {!running && lastRun && (
          <span
            className={styles.lastRunPill}
            onClick={e => { e.stopPropagation(); openDockTab('reports') }}
          >
            ▶ {Math.floor(lastRun.durationS / 60) > 0 ? `${Math.floor(lastRun.durationS / 60)}m ${lastRun.durationS % 60}s` : `${lastRun.durationS}s`}
            {' · '}{lastRun.sloViolations > 0 ? `${lastRun.sloViolations} SLO violation${lastRun.sloViolations > 1 ? 's' : ''}` : 'All SLOs passed'}
            {' →'}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.body}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 120, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Health strip */}
            <div className={styles.strip}>
              <span className={styles.stripLabel}>Nodes</span>
              <div className={styles.dots}>
                {activeNodes.map(node => {
                  const m    = nodeMetrics.get(node.id)
                  const util = m?.utilization ?? 0
                  const color = util >= 1 ? '#EF4444' : util >= 0.8 ? '#F59E0B' : util > 0 ? '#22C55E' : '#2A2E38'
                  return (
                    <button
                      key={node.id}
                      className={styles.healthDot}
                      style={{ background: color }}
                      title={`${(node.data as { label?: string }).label ?? node.id} — ${Math.round(util * 100)}% — click to inspect`}
                      onClick={() => handleDotClick(node.id)}
                    />
                  )
                })}
              </div>
            </div>

            {/* Event feed */}
            <div className={styles.eventFeed}>
              {events.slice(0, 8).map(ev => (
                <div key={ev.id} className={styles.feedItem}>
                  <span style={{ color: ev.severity === 'critical' ? '#EF4444' : ev.severity === 'warn' ? '#F59E0B' : '#475569' }}>●</span>
                  <span className={styles.feedTime}>{ev.elapsedS}s</span>
                  <span className={styles.feedMsg}>{ev.message}</span>
                </div>
              ))}
              {events.length === 0 && <span className={styles.feedEmpty}>No events yet</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
