import { useEffect } from 'react'
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
import { HomeScreen } from './app/home/HomeScreen'
import { WorldShell } from './app/world/WorldShell'
import { useFileStore } from './app/store/file.store'
import { useWorldStore } from './app/store/world.store'
import { useUiStore } from './app/store/ui.store'
import { serializeWorld } from './lib/serializer'
import styles from './App.module.css'

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'n') {
        e.preventDefault()
        useWorldStore.getState().newWorld()
        useFileStore.getState().setFilePath(null)
        useFileStore.getState().setShowHome(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      const { dirty, fileName, createdIso } = useFileStore.getState()
      if (!dirty) return
      try {
        const json = serializeWorld(
          useWorldStore.getState().doc,
          fileName?.replace('.scalemap', '') || 'untitled',
          createdIso ?? new Date().toISOString(),
        )
        localStorage.setItem('scalemap-autosave-v2', json)
        useFileStore.getState().setLastAutosave(new Date())
      } catch {
        // localStorage full or unavailable — silently skip
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className={styles.app}>
      <div className={styles.body}>
        {showHome ? <HomeScreen /> : <WorldShell />}
      </div>
    </div>
  )
}
