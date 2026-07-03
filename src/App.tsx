import { useEffect, useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { DARK_COLORS, LIGHT_COLORS, FONT_DISPLAY, FONT_BODY, FONT_MONO, SPACING, MOTION } from './lib/theme'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import { Toolbar } from './app/toolbar/Toolbar'
import { NodePalette } from './app/sidebar/NodePalette'
import { Canvas } from './app/canvas/Canvas'
import { PropertiesPanel } from './app/sidebar/PropertiesPanel'
import { StatusBar } from './app/StatusBar'
import { HomeScreen } from './app/home/HomeScreen'
import { MetricsDrawer } from './app/analytics/MetricsDrawer'
import { SimConfigPanel } from './app/simulation/SimConfigPanel'
import { UtilityDock } from './app/dock/UtilityDock'
import { PacketEditor } from './app/simulation/PacketEditor'
import { useFileStore } from './app/store/file.store'
import { useCanvasStore } from './app/store/canvas.store'
import { useSimulationStore } from './app/store/simulation.store'
import { useMetricsHistoryStore } from './app/store/metricsHistory.store'
import { useDiagnosticsStore } from './app/store/diagnostics.store'
import { useUiStore } from './app/store/ui.store'
import { serialize } from './lib/serializer'
import styles from './App.module.css'

const AUTOSAVE_KEY = 'scalemap-autosave'

function useThemeBootstrap() {
  const themeMode = useUiStore(s => s.themeMode)

  useEffect(() => {
    const colors = themeMode === 'light' ? LIGHT_COLORS : DARK_COLORS
    const root = document.documentElement.style
    for (const [key, value] of Object.entries(colors)) {
      const kebab = key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)
      root.setProperty(`--color-${kebab}`, value)
    }
    root.setProperty('--font-display', FONT_DISPLAY)
    root.setProperty('--font-body', FONT_BODY)
    root.setProperty('--font-mono', FONT_MONO)
    for (const [key, value] of Object.entries(SPACING)) {
      root.setProperty(`--space-${key.replace('space', '')}`, `${value}px`)
    }
    root.setProperty('--motion-breathe-ms', `${MOTION.breatheDurationMs}ms`)
    root.setProperty('--motion-hover-ms', `${MOTION.hoverDurationMs}ms`)
    root.setProperty('--motion-panel-ms', `${MOTION.panelDurationMs}ms`)
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])
}

export default function App() {
  useThemeBootstrap()
  const showHome = useFileStore(s => s.showHome)
  const running = useSimulationStore(s => s.running)
  const packetEditorOpen = useUiStore(s => s.packetEditorOpen)
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
        useDiagnosticsStore.getState().clearDiagnostics()
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
      const { nodes, edges, viewport, packetMode, packetTemplates, nextTemplateId } = useCanvasStore.getState()
      const { fileName } = useFileStore.getState()
      const name = fileName?.replace('.scalemap', '') || 'untitled'
      try {
        const json = serialize(nodes, edges, viewport, name, new Date().toISOString(), {
          mode: packetMode, templates: packetTemplates, nextId: nextTemplateId,
        })
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
            <SimConfigPanel />
            <PropertiesPanel />
            <UtilityDock />
          </>
        )}
      </div>
      <StatusBar onToggleDrawer={() => setDrawerOpen(o => !o)} drawerOpen={drawerOpen} />
      <AnimatePresence>
        {packetEditorOpen && <PacketEditor key="packet-editor" />}
      </AnimatePresence>
    </div>
  )
}
