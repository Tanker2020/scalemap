import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X, ShieldCheck, ClipboardList } from 'lucide-react'
import { useUiStore, type DockTab } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCanvasStore } from '../store/canvas.store'
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel'
import { ReportsPanel } from '../reports/ReportsPanel'
import styles from './UtilityDock.module.css'

/**
 * Unified bottom-right drawer for Diagnostics + Reports.
 *
 * Previously these were two independent `position: fixed; right: 0` overlays
 * (DiagnosticsPanel, ReportsPanel), each toggled by its own Toolbar button with no
 * coordination — a user could open both and have them render stacked on top of each other
 * at the exact same screen position. This shell owns the single dock slot and a tab strip;
 * only one tab's content is ever mounted-visible at a time, so the two panels can no longer
 * collide. Each panel's own internal logic (filters, run detail overlay, etc.) is untouched —
 * only their outer chrome (position/header/close button) moved up into this file.
 *
 * `position: fixed`, self-gated on `dockOpen` (2026-07-02 canvas-first-overlay pass — see
 * docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md). This supersedes the
 * earlier "must be a flex child, not fixed" rule recorded in docs/module-boundaries.md: that
 * rule was about two *uncoordinated* fixed panels sharing the same right-edge slot. This dock
 * now anchors bottom-right while PropertiesPanel/SimConfigPanel anchor top-right (different
 * corners), and caps its own max-height (UtilityDock.module.css) so it can never grow tall
 * enough to reach the other panel's corner — coordinated by construction, not by accident.
 */
export function UtilityDock() {
  const dockOpen = useUiStore(s => s.dockOpen)
  const dockTab = useUiStore(s => s.dockTab)
  const setDockOpen = useUiStore(s => s.setDockOpen)
  const openDockTab = useUiStore(s => s.openDockTab)
  const reduceMotion = useReducedMotion()

  const nodes = useCanvasStore(s => s.nodes)
  const diagnostics = useDiagnosticsStore(s => s.diagnostics)
  const runs = useSimulationStore(s => s.runs)

  // Same "drop issues whose node was deleted" logic DiagnosticsPanel uses for its own count —
  // duplicated here (cheaply, it's a short filter) so the tab badge matches the list exactly.
  const nodeIds = new Set(nodes.map(n => n.id))
  const liveDiagnosticsCount = diagnostics.filter(i => !i.nodeId || nodeIds.has(i.nodeId)).length

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setDockOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setDockOpen])

  const tabs: { key: DockTab; label: string; icon: typeof ShieldCheck; count: number }[] = [
    { key: 'diagnostics', label: 'Diagnostics', icon: ShieldCheck, count: liveDiagnosticsCount },
    { key: 'reports', label: 'Reports', icon: ClipboardList, count: runs.length },
  ]

  return (
    <AnimatePresence>
      {dockOpen && (
        <motion.aside
          className={styles.dock}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
      <div className={styles.header}>
        <div className={styles.tabs}>
          {tabs.map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              className={`${styles.tab} ${dockTab === key ? styles.tabActive : ''}`}
              onClick={() => openDockTab(key)}
            >
              <Icon size={13} />
              <span>{label}</span>
              {count > 0 && <span className={styles.tabCount}>{count}</span>}
            </button>
          ))}
        </div>
        <button className={styles.closeBtn} onClick={() => setDockOpen(false)} title="Close (Esc)">
          <X size={13} />
        </button>
      </div>

      <div className={styles.content}>
        <AnimatePresence mode="wait" initial={false}>
          {dockTab === 'diagnostics' ? (
            <motion.div
              key="diagnostics"
              className={styles.tabPane}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
            >
              <DiagnosticsPanel />
            </motion.div>
          ) : (
            <motion.div
              key="reports"
              className={styles.tabPane}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
            >
              <ReportsPanel />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
