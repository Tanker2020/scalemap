// @vitest-environment jsdom
// Locks in ⌘N's behavior now that it's routed through the single app-level keymap registry
// (src/app/keymap.ts, installed once in App.tsx — wave 5 task 15) instead of App.tsx's own
// ad-hoc listener. Also covers the focused-input guard gap that consolidation closed: the old
// ad-hoc ⌘N listener had NO such guard (unlike WorldShell's old ⌘Z/Escape listener), so typing
// "n" with a modifier while focused in a text field used to still fire New World.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import App from './App'
import { useWorldStore } from './app/store/world.store'
import { useNavStore } from './app/store/nav.store'
import { useFileStore } from './app/store/file.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  useFileStore.setState({ showHome: true, filePath: null, dirty: false })
})

describe('App — ⌘N (wave 5 task 15 migration)', () => {
  it('⌘N resets to a new world, navigates to globe, clears the file path, and shows the home screen', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    useNavStore.setState({ level: 'server', regionId, azId: null, serverId: null })
    useFileStore.setState({ filePath: '/tmp/foo.scalemap', showHome: false })

    render(<App />)
    fireEvent.keyDown(document.body, { key: 'n', metaKey: true })

    expect(useWorldStore.getState().doc.regions[regionId]).toBeUndefined()
    expect(useNavStore.getState().level).toBe('globe')
    expect(useFileStore.getState().filePath).toBeNull()
    expect(useFileStore.getState().showHome).toBe(true)
  })

  it('⌘N does nothing while a text input is focused (closes the pre-existing guard gap)', () => {
    useFileStore.setState({ showHome: false })
    render(<App />)

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    const regionId = useWorldStore.getState().addRegion('us-east-1')
    fireEvent.keyDown(input, { key: 'n', metaKey: true })

    expect(useWorldStore.getState().doc.regions[regionId]).toBeDefined()
    document.body.removeChild(input)
  })
})
