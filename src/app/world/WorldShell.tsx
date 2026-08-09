// The app's entire post-home body: breadcrumb header + animated level router.
// AZ level renders <DatacenterFloor/> (Polish 3 T4 — the isometric floor scene that replaced
// the React Flow AZ canvas; @xyflow/react has no remaining consumer anywhere in the app).
import { useEffect, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useNavStore } from '../store/nav.store'
import { useFileStore } from '../store/file.store'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { useUiStore } from '../store/ui.store'
import { Breadcrumb } from './Breadcrumb'
import { SimControls } from './SimControls'
import { ScrubberV2 } from './ScrubberV2'
import { GlobeView } from './GlobeView'
import { RegionView } from './RegionView'
import { ServerView } from './ServerView'
import { WorldPanel } from './panels/WorldPanel'
import { DatacenterFloor } from './az/DatacenterFloor'
import { openWorldViaDialog, saveWorld } from './fileOps'
import { SettingsModal } from './SettingsModal'
import { ConnectionsView } from './connections/ConnectionsView'
import { FirewallRulesModal } from './server/FirewallRulesModal'
import { AssistantView } from './ai/AssistantView'
import { CommandPalette } from './CommandPalette'
import { buildCommands, type PaletteContext } from './commands'
import { useCompiledWorld } from './useCompiledWorld'
import { WORLD_REGIONS } from '../../lib/regionConfig'
import { getPreset } from '../../lib/world/instanceCatalog'

const hdrBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
// The accent-filled "🔗 Connections" header button is GONE (node-model Phase 2). Connections is
// now a world tab in the dock (panels/ConnectionsPanel.tsx), which is where the rest of the
// world's authoring surfaces already live; the full-screen canvas below is opened from that tab
// instead of from a header button that looked like a mode switch.

export function WorldShell() {
  const nav = useNavStore()
  const reduced = useReducedMotion()
  const dirty = useFileStore(s => s.dirty)
  const [fileError, setFileError] = useState<string | null>(null)
  const running = useSimulationStore(s => s.running)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [firewallRulesServerId, setFirewallRulesServerId] = useState<string | null>(null)
  const openFirewallRules = (serverId: string) => setFirewallRulesServerId(serverId)
  // placeMode now lives in ui.store (lifted 2026-08-09, wave 5 task 15) rather than local
  // useState: keymap.ts's app-level Escape binding needs to read/disarm the SAME "armed" globe
  // traffic-placement mode from outside this component's tree (it's installed once in App.tsx,
  // above WorldShell). GlobeView's own HUD button and WorldPanel's TrafficPanel toggle still both
  // flip the same boolean, just via the store instead of a locally-lifted callback.
  const placeMode = useUiStore(s => s.placeMode)
  const setPlaceMode = useUiStore(s => s.setPlaceMode)
  const [selectedPopulationId, setSelectedPopulationId] = useState<string | null>(null)
  // The command palette's open state (wave 5 task 16) — lives in ui.store, not a local useState,
  // because keymap.ts's app-level ⌘K binding is installed in App.tsx, above this component; see
  // ui.store.ts's paletteOpen doc comment.
  const paletteOpen = useUiStore(s => s.paletteOpen)
  const setPaletteOpen = useUiStore(s => s.setPaletteOpen)
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()

  // Defensive UX, not a named requirement: disarm place-mode if the user navigates away from
  // the globe level while it's armed, so it can't silently stay "armed" somewhere it has no
  // effect (GlobeScene's raycast-click handler only exists at nav.level === 'globe').
  useEffect(() => {
    if (nav.level !== 'globe' && placeMode) setPlaceMode(false)
  }, [nav.level, placeMode])

  // Selection lifecycle (Polish 4 Task 1, spec D1): the floor's tap-to-select now lives in
  // ui.store (lifted off DatacenterFloor's own local state) so "select there, configure here"
  // — the dock's scope narrows off the SAME field. That means it no longer auto-resets on
  // remount, so this is the one place that clears it on ANY nav.level/nav.azId change (entering
  // a different AZ, drilling into a server board, climbing back out, jumping to a different
  // region entirely) — without it, a stale selection from a previously-visited AZ could revive
  // itself (and silently narrow the dock's scope) on a later return visit to that same AZ.
  useEffect(() => {
    useUiStore.getState().setSelectedServerId(null)
  }, [nav.level, nav.azId])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    // Dev/test-only: lets a scripted Playwright smoke seed a real, cross-region-eligible
    // ClientPopulation via the *already-built* world.store action (no population-authoring UI
    // exists in Phase 2 by design) and call setOutage directly as a fallback if a UI control is
    // awkward to click reliably. Never present in a production build (import.meta.env.DEV is
    // false under `vite build`/`tauri build`).
    ;(window as unknown as { __scalemapDebug: unknown }).__scalemapDebug = { useWorldStore, useSimulationStore }
  }, [])

  // The ⌘Z/⇧⌘Z (undo/redo, gated on !running — audit ISSUE-004) and Escape (disarm placeMode
  // before climbing a nav level — Polish 4 T7, spec D9) bindings that used to live in a
  // component-local listener here now come from the single app-level registry installed once in
  // App.tsx (src/app/keymap.ts's REGISTRY + installKeymap) — see that file for the exact behavior.

  // Two arms, one state (Polish 4 T7, spec D9): GlobeView's own HUD "+ traffic" button and
  // WorldPanel's TrafficPanel toggle both flip the SAME placeMode boolean via this one callback.
  const onTogglePlaceMode = () => setPlaceMode(p => !p)

  // Command palette context (wave 5 task 16). addServer/addRegion in world.store both take real
  // args (`addServer(azId, preset)` / `addRegion(catalogId)` — there is no bare "quick add"
  // action anywhere in the app; TopologyPanel's own "+ Region" button and the VPS door both pick
  // a target first). These closures supply the SAME kind of default a palette invocation implies
  // ("just add one") rather than inventing a UI to pick a target inline: add-region picks the
  // first catalog region not already in the doc (no-op if every WORLD_REGIONS entry is used),
  // add-server targets the currently-focused AZ if one exists, else the first AZ in the doc (no-op
  // if the world has no AZ yet) with the same 'vps-medium' default AddServiceForm reaches for.
  const paletteCtx: PaletteContext = {
    doc,
    compiled,
    nav: { goRegion: nav.goRegion, goAz: nav.goAz, goServer: nav.goServer },
    focusedServerId: nav.serverId,
    addServer: () => {
      const azId = nav.azId ?? Object.keys(doc.azs)[0]
      const preset = getPreset('vps-medium')
      if (!azId || !preset) return
      useWorldStore.getState().addServer(azId, preset)
    },
    addRegion: () => {
      const used = new Set(Object.values(doc.regions).map(r => r.catalogId))
      const next = WORLD_REGIONS.find(w => !used.has(w.id))
      if (!next) return
      useWorldStore.getState().addRegion(next.id)
    },
    undo: () => useWorldStore.getState().undo(),
    redo: () => useWorldStore.getState().redo(),
    setPendingTab: (tab) => useUiStore.getState().setPendingPanelTab(tab),
  }

  const view =
    nav.level === 'globe' ? (
      <GlobeView
        placeMode={placeMode}
        onExitPlaceMode={() => setPlaceMode(false)}
        onPopulationPlaced={setSelectedPopulationId}
        onTogglePlaceMode={onTogglePlaceMode}
      />
    ) :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <DatacenterFloor /> :
    <ServerView onOpenFirewallRules={openFirewallRules} />

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
          <button className="kit-press" style={hdrBtn} aria-label="ai assistant" onClick={() => setChatOpen(true)}>ai</button>
          <button className="kit-press" style={hdrBtn} aria-label="settings" onClick={() => setSettingsOpen(true)}>settings</button>
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
          onTogglePlaceMode={onTogglePlaceMode}
          selectedPopulationId={selectedPopulationId}
          openSettings={() => setSettingsOpen(true)}
          openConnections={() => setConnectionsOpen(true)}
          openFirewallRules={openFirewallRules}
        />
      </div>
      <CommandPalette
        open={paletteOpen}
        commands={buildCommands(paletteCtx)}
        onClose={() => setPaletteOpen(false)}
        running={running}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ConnectionsView open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />
      <AssistantView open={chatOpen} onClose={() => setChatOpen(false)} openSettings={() => setSettingsOpen(true)} />
      <FirewallRulesModal
        open={firewallRulesServerId !== null}
        serverId={firewallRulesServerId}
        onClose={() => setFirewallRulesServerId(null)}
      />
      <ScrubberV2 />
    </div>
  )
}
