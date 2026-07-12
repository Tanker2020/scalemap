// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { useUiStore } from './ui.store'

beforeEach(() => useUiStore.setState({ sceneOverlay: null, selectedServerId: null }))

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
