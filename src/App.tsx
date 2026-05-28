import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Toolbar } from './app/toolbar/Toolbar'
import { NodePalette } from './app/sidebar/NodePalette'
import { Canvas } from './app/canvas/Canvas'
import { PropertiesPanel } from './app/sidebar/PropertiesPanel'
import { StatusBar } from './app/StatusBar'
import { HomeScreen } from './app/home/HomeScreen'
import { MetricsDrawer } from './app/analytics/MetricsDrawer'
import { SimConfigPanel } from './app/simulation/SimConfigPanel'
import { ReportsPanel } from './app/reports/ReportsPanel'
import { useFileStore } from './app/store/file.store'
import { useCanvasStore } from './app/store/canvas.store'
import { useSimulationStore } from './app/store/simulation.store'
import { useMetricsHistoryStore } from './app/store/metricsHistory.store'
import { useUiStore } from './app/store/ui.store'
import { serialize } from './lib/serializer'
import styles from './App.module.css'

const AUTOSAVE_KEY = 'scalemap-autosave'

export default function App() {
  const showHome = useFileStore(s => s.showHome)
  const running = useSimulationStore(s => s.running)
  const simConfigOpen = useUiStore(s => s.simConfigOpen)
  const reportsPanelOpen = useUiStore(s => s.reportsPanelOpen)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    if (running) setDrawerOpen(true)
  }, [running])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'n') {
        e.preventDefault()
        useSimulationStore.getState().reset()
        useMetricsHistoryStore.getState().clearHistory()
        useCanvasStore.setState({ nodes: [], edges: [], history: [], future: [] })
        useFileStore.getState().setShowHome(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      const { dirty } = useFileStore.getState()
      if (!dirty) return
      const { nodes, edges, viewport } = useCanvasStore.getState()
      const { fileName } = useFileStore.getState()
      const name = fileName?.replace('.scalemap', '') || 'untitled'
      try {
        const json = serialize(nodes, edges, viewport, name, new Date().toISOString())
        localStorage.setItem(AUTOSAVE_KEY, json)
        useFileStore.getState().markSaved()
        useFileStore.getState().setLastAutosave(new Date())
      } catch {
        // localStorage full or unavailable — silently skip
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={styles.app}>
      <Toolbar />
      <div className={styles.body}>
        {showHome ? (
          <HomeScreen />
        ) : (
          <>
            <NodePalette />
            <div className={styles.canvasColumn}>
              <Canvas />
              <MetricsDrawer open={drawerOpen} onToggle={() => setDrawerOpen(o => !o)} />
            </div>
            <AnimatePresence mode="wait">
              {simConfigOpen ? (
                <motion.div
                  key="inspector"
                  style={{ display: 'flex' }}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <SimConfigPanel />
                </motion.div>
              ) : (
                <motion.div
                  key="properties"
                  style={{ display: 'flex' }}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.15 }}
                >
                  <PropertiesPanel />
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
      <StatusBar onToggleDrawer={() => setDrawerOpen(o => !o)} drawerOpen={drawerOpen} />
      {reportsPanelOpen && <ReportsPanel />}
    </div>
  )
}
