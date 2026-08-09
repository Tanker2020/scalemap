import { useEffect } from 'react'
import { DARK_COLORS, LIGHT_COLORS, FONT_MONO, SPACING, MOTION } from './lib/theme'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import { HomeScreen } from './app/home/HomeScreen'
import { WorldShell } from './app/world/WorldShell'
import { useFileStore } from './app/store/file.store'
import { useWorldStore } from './app/store/world.store'
import { useNavStore } from './app/store/nav.store'
import { useUiStore } from './app/store/ui.store'
import { useSimulationStore } from './app/store/simulation.store'
import { REGISTRY, installKeymap } from './app/keymap'
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

  // Single app-level keymap install (wave 5 task 15) — replaces this component's own ad-hoc ⌘N
  // listener AND WorldShell.tsx's separate ⌘Z/⇧⌘Z/Escape listener with ONE window `keydown`
  // listener (src/app/keymap.ts's installKeymap). Installed here, above WorldShell, so it's live
  // even on the home screen (⌘N works whether or not a world is currently open). Consolidating
  // also closes a real gap: this handler previously had NO focused-input guard (unlike
  // WorldShell's old one) — installKeymap applies that guard uniformly to every binding now.
  useEffect(() => installKeymap(REGISTRY, () => ({
    running: useSimulationStore.getState().running,
    newWorld: () => useWorldStore.getState().newWorld(),
    goGlobe: () => useNavStore.getState().goGlobe(),
    setFilePath: (p) => useFileStore.getState().setFilePath(p),
    setShowHome: (b) => useFileStore.getState().setShowHome(b),
    undo: () => useWorldStore.getState().undo(),
    redo: () => useWorldStore.getState().redo(),
    goUp: () => useNavStore.getState().up(),
    exitPlaceMode: () => useUiStore.getState().setPlaceMode(false),
    isInPlaceMode: () => useUiStore.getState().placeMode,
  })), [])

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
