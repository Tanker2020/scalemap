// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { matchBinding, isEnabled, type Binding } from './keymap'

describe('keymap', () => {
  const undoBinding: Binding = { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: vi.fn() }

  it('matchBinding finds ⌘Z on a KeyboardEvent with metaKey/ctrlKey + z, not shift', () => {
    const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true })
    expect(matchBinding(e, [undoBinding])).toBe(undoBinding)
    const shiftE = new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })
    expect(matchBinding(shiftE, [undoBinding])).toBeNull()
  })

  it('matchBinding also matches ctrlKey (non-Mac) for the same binding', () => {
    const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })
    expect(matchBinding(e, [undoBinding])).toBe(undoBinding)
  })

  it('matchBinding finds Escape regardless of modifier keys config', () => {
    const escBinding: Binding = { id: 'escape', keys: 'Escape', label: 'Back', group: 'navigate', when: 'always', run: vi.fn() }
    const e = new KeyboardEvent('keydown', { key: 'Escape' })
    expect(matchBinding(e, [escBinding])).toBe(escBinding)
  })

  it('matchBinding finds ⇧⌘Z (redo) only when shift is held', () => {
    const redoBinding: Binding = { id: 'redo', keys: '⇧⌘Z', label: 'Redo', group: 'author', when: 'stopped', run: vi.fn() }
    const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })
    expect(matchBinding(e, [redoBinding])).toBe(redoBinding)
    const noShift = new KeyboardEvent('keydown', { key: 'z', metaKey: true })
    expect(matchBinding(noShift, [redoBinding])).toBeNull()
  })

  it('matchBinding returns null when nothing matches', () => {
    const e = new KeyboardEvent('keydown', { key: 'x', metaKey: true })
    expect(matchBinding(e, [undoBinding])).toBeNull()
  })

  it('isEnabled respects when: stopped/running/always', () => {
    expect(isEnabled(undoBinding, false)).toBe(true)
    expect(isEnabled(undoBinding, true)).toBe(false)
    const chaosBinding: Binding = { ...undoBinding, when: 'running' }
    expect(isEnabled(chaosBinding, true)).toBe(true)
    expect(isEnabled(chaosBinding, false)).toBe(false)
    const alwaysBinding: Binding = { ...undoBinding, when: 'always' }
    expect(isEnabled(alwaysBinding, true)).toBe(true)
    expect(isEnabled(alwaysBinding, false)).toBe(true)
  })
})
