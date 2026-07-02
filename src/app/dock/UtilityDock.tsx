import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ShieldCheck, ClipboardList } from 'lucide-react'
import { useUiStore, type DockTab } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCanvasStore } from '../store/canvas.store'
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel'
import { ReportsPanel } from '../reports/ReportsPanel'
import { panelTransition } from '../../lib/motion'
import styles from './UtilityDock.module.css'

/**
 * Unified right-edge dock for Diagnostics + Reports.
 *
 * Previously these were two independent `position: fixed; right: 0` overlays
 * (DiagnosticsPanel, ReportsPanel), each toggled by its own Toolbar button with no
 * coordination — a user could open both and have them render stacked on top of each other
 * at the exact same screen position. This shell owns the single right-edge slot and a tab
 * strip; only one tab's content is ever mounted-visible at a time, so the two panels can no
 * longer collide. Each panel's own internal logic (filters, run detail overlay, etc.) is
 * untouched — only their outer chrome (position/header/close button) moved up into this file.
 */
// Mounted by App.tsx only while useUiStore.dockOpen is true (mirrors the PacketEditor
// mount pattern) so AnimatePresence sees a real mount/unmount transition.
export function UtilityDock() {
  const dockTab = useUiStore(s => s.dockTab)
  const setDockOpen = useUiStore(s => s.setDockOpen)
  const openDockTab = useUiStore(s => s.openDockTab)

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
    <motion.aside
      className={styles.dock}
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={panelTransition}
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
  )
}
