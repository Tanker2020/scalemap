// The app's entire post-home body: breadcrumb header + animated level router.
// Task 13 replaces the AZ placeholder with <AzCanvas/>; Task 14 adds file actions here.
import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavStore } from '../store/nav.store'
import { Breadcrumb } from './Breadcrumb'
import { GlobeView } from './GlobeView'
import { RegionView } from './RegionView'
import { ServerView } from './ServerView'
import { WorldPanel } from './panels/WorldPanel'

function AzView() {
  // Placeholder until Task 13's AzCanvas.
  return <div style={{ padding: 24, font: '12px var(--font-mono)', color: 'var(--color-text-muted)' }}>AZ canvas arrives in Task 13.</div>
}

export function WorldShell() {
  const nav = useNavStore()
  const reduced = useReducedMotion()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const view =
    nav.level === 'globe' ? <GlobeView /> :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzView /> :
    <ServerView />

  // Key by full focus path so descending re-animates even within one level.
  const viewKey = `${nav.level}:${nav.regionId ?? ''}:${nav.azId ?? ''}:${nav.serverId ?? ''}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas-bg)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', borderBottom: '1px solid var(--color-toolbar-border)',
        background: 'var(--color-toolbar)',
      }}>
        <Breadcrumb />
        <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <main style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={viewKey}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.04 }}
              transition={{ duration: 0.18 }}
              style={{ height: '100%' }}
            >
              {view}
            </motion.div>
          </AnimatePresence>
        </main>
        <WorldPanel />
      </div>
    </div>
  )
}
