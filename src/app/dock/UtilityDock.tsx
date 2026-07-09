import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X, ClipboardList } from 'lucide-react'
import { useUiStore, type DockTab } from '../store/ui.store'
import { useSimulationStore } from '../store/simulationLegacy.store'
import { ReportsPanel } from '../reports/ReportsPanel'
import styles from './UtilityDock.module.css'

/**
 * Bottom-right drawer hosting the Reports panel.
 *
 * Was originally a two-tab dock (Diagnostics + Reports) unifying what had been two independent
 * `position: fixed; right: 0` overlays that could stack on top of each other at the same screen
 * position. The Diagnostics tab was removed along with the structural linter (2026-07-08,
 * replaced by the Phase 6 Analysis system) — this shell still owns the single dock slot/tab
 * strip so a future panel can reuse the same shared-slot pattern without reintroducing that
 * stacking bug. ReportsPanel's own internal logic (run list, run detail overlay, etc.) is
 * untouched — only the outer chrome (position/header/close button) lives in this file.
 *
 * `position: fixed`, self-gated on `dockOpen` (2026-07-02 canvas-first-overlay pass — see
 * docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md). This supersedes the
 * earlier "must be a flex child, not fixed" rule recorded in docs/module-boundaries.md: that
 * rule was about two *uncoordinated* fixed panels sharing the same right-edge slot. This dock
 * now anchors bottom-right while PropertiesPanel/SimConfigPanel anchor top-right (different
 * corners), and caps its own max-height (UtilityDock.module.css) to reduce the chance it reaches
 * the other panel's corner. That cap shares the same formula as the top panel's, so it's not a
 * hard geometric guarantee: at very short window heights (roughly ≤580px tall) with both panels
 * open and both filled with enough content to hit their max-height cap, they could occupy the
 * same vertical span. In normal desktop use this doesn't happen — flagged here so nobody assumes
 * it's structurally impossible.
 */
export function UtilityDock() {
  const dockOpen = useUiStore(s => s.dockOpen)
  const dockTab = useUiStore(s => s.dockTab)
  const setDockOpen = useUiStore(s => s.setDockOpen)
  const openDockTab = useUiStore(s => s.openDockTab)
  const reduceMotion = useReducedMotion()

  const runs = useSimulationStore(s => s.runs)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setDockOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setDockOpen])

  const tabs: { key: DockTab; label: string; icon: typeof ClipboardList; count: number }[] = [
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
        </AnimatePresence>
      </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
