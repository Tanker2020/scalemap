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
import { SettingsModal } from './SettingsModal'

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
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Lifted here (not into GlobeView) because GlobeView and WorldPanel are SIBLINGS in the flex
  // row below, not parent/child — TrafficPanel (mounted inside WorldPanel) needs to flip the
  // same placeMode boolean GlobeView's GlobeScene reads, so only their common ancestor can own
  // it. No new store — per the skeleton's own constraint, this stays local component state.
  const [placeMode, setPlaceMode] = useState(false)
  const [selectedPopulationId, setSelectedPopulationId] = useState<string | null>(null)

  // Defensive UX, not a named requirement: disarm place-mode if the user navigates away from
  // the globe level while it's armed, so it can't silently stay "armed" somewhere it has no
  // effect (GlobeScene's raycast-click handler only exists at nav.level === 'globe').
  useEffect(() => {
    if (nav.level !== 'globe' && placeMode) setPlaceMode(false)
  }, [nav.level, placeMode])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    // Dev/test-only: lets a scripted Playwright smoke seed a real, cross-region-eligible
    // ClientPopulation via the *already-built* world.store action (no population-authoring UI
    // exists in Phase 2 by design) and call setOutage directly as a fallback if a UI control is
    // awkward to click reliably. Never present in a production build (import.meta.env.DEV is
    // false under `vite build`/`tauri build`).
    ;(window as unknown as { __scalemapDebug: unknown }).__scalemapDebug = { useWorldStore, useSimulationStore }
  }, [])

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
    nav.level === 'globe' ? (
      <GlobeView
        placeMode={placeMode}
        onExitPlaceMode={() => setPlaceMode(false)}
        onPopulationPlaced={setSelectedPopulationId}
      />
    ) :
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
          <button className="kit-press" style={hdrBtn} aria-label="settings" onClick={() => setSettingsOpen(true)}>⚙</button>
          <span style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)' }}>esc = up one level</span>
          {dirty && <span style={{ color: 'var(--color-warning)', font: '10px var(--font-mono)' }}>● unsaved</span>}
          {/* New returns to the home screen (user request 2026-07-10) — the fresh doc is ready
              behind it, so "New World" there drops straight into an empty globe. */}
          <button className="kit-press" style={hdrBtn} onClick={() => { useWorldStore.getState().newWorld(); useFileStore.getState().setFilePath(null); useNavStore.getState().goGlobe(); useFileStore.getState().setShowHome(true) }}>New</button>
          <button className="kit-press" style={hdrBtn} onClick={() => { openWorldViaDialog().catch(e => setFileError(e instanceof Error ? e.message : 'open failed')) }}>Open</button>
          <button className="kit-press" style={hdrBtn} onClick={() => { saveWorld().catch(e => setFileError(e instanceof Error ? e.message : 'save failed')) }}>Save</button>
          <button className="kit-press" style={hdrBtn} onClick={() => { saveWorld({ forceDialog: true }).catch(e => setFileError(e instanceof Error ? e.message : 'save failed')) }}>Save As</button>
        </div>
      </header>
      {fileError && (
        <div style={{ padding: '4px 16px', font: '11px var(--font-mono)', color: 'var(--color-danger)', borderBottom: '1px solid var(--color-toolbar-border)' }}>
          {fileError} <button className="kit-press" style={{ ...hdrBtn, padding: '0 6px' }} onClick={() => setFileError(null)}>dismiss</button>
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
        <WorldPanel
          running={running}
          placeMode={placeMode}
          onTogglePlaceMode={() => setPlaceMode(p => !p)}
          selectedPopulationId={selectedPopulationId}
          openSettings={() => setSettingsOpen(true)}
        />
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ScrubberV2 />
    </div>
  )
}
