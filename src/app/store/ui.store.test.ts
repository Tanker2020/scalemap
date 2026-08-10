// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useUiStore } from './ui.store'

beforeEach(() => useUiStore.setState({ sceneOverlay: null, selectedServerId: null, selectedEntityIds: new Set() }))

describe('ui.store sceneOverlay', () => {
  it('setSceneOverlay stores and clears the selection', () => {
    useUiStore.getState().setSceneOverlay({ kind: 'region', id: 'r-1' })
    expect(useUiStore.getState().sceneOverlay).toEqual({ kind: 'region', id: 'r-1' })
    useUiStore.getState().setSceneOverlay(null)
    expect(useUiStore.getState().sceneOverlay).toBeNull()
  })
  it('starts null and leaves the existing fields untouched', () => {
    expect(useUiStore.getState().sceneOverlay).toBeNull()
    expect(typeof useUiStore.getState().setThemeMode).toBe('function')
    expect(useUiStore.getState().pendingPanelTab).toBeNull()
  })
})

describe('ui.store selectedServerId (Polish 4 T1, spec D1)', () => {
  it('starts null', () => {
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })
  it('setSelectedServerId stores and clears the floor selection', () => {
    useUiStore.getState().setSelectedServerId('srv-1')
    expect(useUiStore.getState().selectedServerId).toBe('srv-1')
    useUiStore.getState().setSelectedServerId(null)
    expect(useUiStore.getState().selectedServerId).toBeNull()
  })
})

describe('ui.store selectedEntityIds (wave 5 ergonomics, task 17)', () => {
  it('starts empty', () => {
    expect(useUiStore.getState().selectedEntityIds.size).toBe(0)
  })

  it('selectedServerId tracks the single-select degenerate case of selectedEntityIds', () => {
    useUiStore.getState().setSelectedEntityIds(new Set(['server-1']))
    expect(useUiStore.getState().selectedServerId).toBe('server-1')

    useUiStore.getState().setSelectedEntityIds(new Set(['server-1', 'server-2']))
    expect(useUiStore.getState().selectedServerId).toBeNull() // multi-select: no single scope target

    useUiStore.getState().clearSelection()
    expect(useUiStore.getState().selectedServerId).toBeNull()
    expect(useUiStore.getState().selectedEntityIds.size).toBe(0)
  })

  it('setSelectedServerId keeps selectedEntityIds in sync (single-select flows elsewhere)', () => {
    useUiStore.getState().setSelectedServerId('srv-1')
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set(['srv-1']))
    useUiStore.getState().setSelectedServerId(null)
    expect(useUiStore.getState().selectedEntityIds.size).toBe(0)
  })

  it('toggleSelectedEntity adds/removes and keeps selectedServerId in sync', () => {
    useUiStore.getState().toggleSelectedEntity('a')
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set(['a']))
    expect(useUiStore.getState().selectedServerId).toBe('a')

    useUiStore.getState().toggleSelectedEntity('b')
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set(['a', 'b']))
    expect(useUiStore.getState().selectedServerId).toBeNull()

    useUiStore.getState().toggleSelectedEntity('a')
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set(['b']))
    expect(useUiStore.getState().selectedServerId).toBe('b')
  })

  it('selectEntityRange replaces the whole selection', () => {
    useUiStore.getState().setSelectedEntityIds(new Set(['x']))
    useUiStore.getState().selectEntityRange(['a', 'b', 'c'])
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set(['a', 'b', 'c']))
    expect(useUiStore.getState().selectedServerId).toBeNull()

    useUiStore.getState().selectEntityRange(['solo'])
    expect(useUiStore.getState().selectedEntityIds).toEqual(new Set(['solo']))
    expect(useUiStore.getState().selectedServerId).toBe('solo')
  })
})
