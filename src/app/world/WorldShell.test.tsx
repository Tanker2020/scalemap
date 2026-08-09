// @vitest-environment jsdom
// Polish 4 T8 (carry-forward from T1+T7): WorldShell owns two nav-adjacent behaviors neither of
// which had a dedicated test file before this — T1's selection-clear effect (ui.store's
// `selectedServerId` resets on ANY nav.level/nav.azId change, so a stale floor selection from a
// previously-visited AZ can't silently revive itself and narrow the dock's scope on a later
// return visit) and T7's Escape-disarms-placeMode-before-nav.up priority (an armed globe
// place-mode must be the thing a plain Escape cancels, not something nav.up() silently no-ops
// past). GlobeView falls back to <GlobeCards/> in jsdom (no WebGL — see globe/webgl.ts), so
// place-mode is armed via TrafficPanel's own "+ place on globe" toggle (the same `placeMode`
// boolean GlobeScene's HUD button would flip, just reached through the dock instead — see
// WorldShell.tsx's own comment on why the two share one lifted boolean).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { WorldShell } from './WorldShell'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import { useFileStore } from '../store/file.store'
import { getPreset } from '../../lib/world/instanceCatalog'
import { REGISTRY, installKeymap } from '../keymap'

// The ⌘Z/⇧⌘Z/Escape bindings this file exercises now come from the single app-level registry
// (src/app/keymap.ts), installed once in App.tsx above WorldShell — not from a listener owned by
// WorldShell itself (wave 5 task 15). These tests render <WorldShell/> in isolation, so they
// install the same registry here, mirroring what App.tsx does in the real tree.
let uninstallKeymap: (() => void) | undefined

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useUiStore.setState({ selectedServerId: null, placeMode: false })
  useSimulationStore.getState().resetSession()
  useFileStore.setState({ dirty: false })
  uninstallKeymap = installKeymap(REGISTRY, () => ({
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
  }))
})

afterEach(() => {
  uninstallKeymap?.()
})

describe('WorldShell — selection-clear effect (Polish 4 T1)', () => {
  it('clears ui.store.selectedServerId when nav.azId changes, so a stale floor selection cannot revive on a later visit', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const az1 = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const az2 = useWorldStore.getState().addAz(regionId, 'us-east-1b')
    const serverId = useWorldStore.getState().addServer(az1, getPreset('vps-medium')!)
    act(() => { useNavStore.getState().goAz(regionId, az1) })

    render(<WorldShell />)

    // Simulate the user selecting a server on the floor AFTER mount (mount itself always clears
    // any incoming selection, by design — this proves ordinary in-AZ selection is untouched).
    act(() => { useUiStore.getState().setSelectedServerId(serverId) })
    expect(useUiStore.getState().selectedServerId).toBe(serverId)

    // Navigating to a different AZ must clear the stale selection.
    act(() => { useNavStore.getState().goAz(regionId, az2) })
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })

  it('clears the selection when nav.level changes even with azId unset (e.g. climbing back to region)', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    act(() => { useNavStore.getState().goAz(regionId, azId) })

    render(<WorldShell />)
    act(() => { useUiStore.getState().setSelectedServerId(serverId) })
    expect(useUiStore.getState().selectedServerId).toBe(serverId)

    act(() => { useNavStore.getState().goRegion(regionId) })
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })
})

describe('WorldShell — undo/redo gated on running sim (audit ISSUE-004)', () => {
  it('Ctrl+Z during a running sim is a no-op — the engine keeps ticking the doc it started with', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<WorldShell />)

    // Mirror the edit-lock: the sim is running (state flag is what the handler reads — the
    // real engine isn't needed to prove the gate).
    act(() => { useSimulationStore.setState({ running: true }) })
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })

    expect(useWorldStore.getState().doc.regions[regionId]).toBeDefined()
  })

  it('Ctrl+Shift+Z during a running sim is a no-op', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useWorldStore.getState().undo()
    expect(useWorldStore.getState().doc.regions[regionId]).toBeUndefined()
    render(<WorldShell />)

    act(() => { useSimulationStore.setState({ running: true }) })
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })

    expect(useWorldStore.getState().doc.regions[regionId]).toBeUndefined()
  })

  it('undo works again once the sim is stopped', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<WorldShell />)

    act(() => { useSimulationStore.setState({ running: true }) })
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(useWorldStore.getState().doc.regions[regionId]).toBeDefined()

    act(() => { useSimulationStore.setState({ running: false }) })
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(useWorldStore.getState().doc.regions[regionId]).toBeUndefined()
  })
})

describe('WorldShell — Escape disarms place-mode before nav.up (Polish 4 T7)', () => {
  it('a plain Escape while place-mode is armed disarms it and does NOT call nav.up()', () => {
    render(<WorldShell />)

    fireEvent.click(screen.getByText('Traffic'))
    const placeToggle = screen.getByText('+ place on globe')
    fireEvent.click(placeToggle)
    expect(placeToggle).toHaveAttribute('aria-pressed', 'true')

    const upSpy = vi.spyOn(useNavStore.getState(), 'up')
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(placeToggle).toHaveAttribute('aria-pressed', 'false')
    expect(upSpy).not.toHaveBeenCalled()
    upSpy.mockRestore()
  })

  it('a plain Escape with place-mode NOT armed falls through to nav.up() as before', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    act(() => { useNavStore.getState().goRegion(regionId) })
    render(<WorldShell />)

    const upSpy = vi.spyOn(useNavStore.getState(), 'up')
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(upSpy).toHaveBeenCalledTimes(1)
    upSpy.mockRestore()
  })
})
