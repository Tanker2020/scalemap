// The app's entire post-home body: breadcrumb header + animated level router.
// AZ level renders <AzCanvas/> (Task 13); Task 14 adds file actions here.
import { useEffect, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavStore } from '../store/nav.store'
import { useFileStore } from '../store/file.store'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { Breadcrumb } from './Breadcrumb'
import { SimControls } from './SimControls'
import { ScrubberV2 } from './ScrubberV2'
import { GlobeView } from './GlobeView'
import { RegionView } from './RegionView'
import { ServerView } from './ServerView'
import { WorldPanel } from './panels/WorldPanel'
import { AzCanvas } from './AzCanvas'
import { openWorldViaDialog, saveWorld } from './fileOps'

const hdrBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}

export function WorldShell() {
  const nav = useNavStore()
  const reduced = useReducedMotion()
  const dirty = useFileStore(s => s.dirty)
  const [fileError, setFileError] = useState<string | null>(null)
  const running = useSimulationStore(s => s.running)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return

      if (e.key === 'Escape') {
        useNavStore.getState().up()
        return
      }
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        useWorldStore.getState().redo()
        return
      }
      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        useWorldStore.getState().undo()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const view =
    nav.level === 'globe' ? <GlobeView /> :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzCanvas /> :
    <ServerView />

  // Key by full focus path so descending re-animates even within one level.
  const viewKey = `${nav.level}:${nav.regionId ?? ''}:${nav.azId ?? ''}:${nav.serverId ?? ''}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', borderBottom: '1px solid var(--color-toolbar-border)',
        background: 'var(--color-toolbar)',
      }}>
        <Breadcrumb />
        <SimControls />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
          {dirty && <span style={{ color: 'var(--color-warning)', font: '10px var(--font-mono)' }}>● unsaved</span>}
          <button style={hdrBtn} onClick={() => { useWorldStore.getState().newWorld(); useFileStore.getState().setFilePath(null); useNavStore.getState().goGlobe() }}>New</button>
          <button style={hdrBtn} onClick={() => { openWorldViaDialog().catch(e => setFileError(e instanceof Error ? e.message : 'open failed')) }}>Open</button>
          <button style={hdrBtn} onClick={() => { saveWorld().catch(e => setFileError(e instanceof Error ? e.message : 'save failed')) }}>Save</button>
          <button style={hdrBtn} onClick={() => { saveWorld({ forceDialog: true }).catch(e => setFileError(e instanceof Error ? e.message : 'save failed')) }}>Save As</button>
        </div>
      </header>
      {fileError && (
        <div style={{ padding: '4px 16px', font: '11px var(--font-mono)', color: 'var(--color-danger)', borderBottom: '1px solid var(--color-toolbar-border)' }}>
          {fileError} <button style={{ ...hdrBtn, padding: '0 6px' }} onClick={() => setFileError(null)}>dismiss</button>
        </div>
      )}
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
        <WorldPanel running={running} />
      </div>
      <ScrubberV2 />
    </div>
  )
}
