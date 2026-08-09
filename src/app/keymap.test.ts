// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { matchBinding, isEnabled, installKeymap, REGISTRY, type Binding, type CommandContext } from './keymap'

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

  // Fix round 1 (task 15 review): preventDefault timing must match the two pre-migration
  // listeners exactly, not just app-state outcomes — see keymap.ts's `Binding.preventDefault`
  // doc comment for the three timings this covers.
  describe('preventDefault timing matches pre-migration handlers', () => {
    function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
      return {
        running: false,
        newWorld: vi.fn(),
        goGlobe: vi.fn(),
        setFilePath: vi.fn(),
        setShowHome: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        goUp: vi.fn(),
        exitPlaceMode: vi.fn(),
        isInPlaceMode: () => false,
        togglePalette: vi.fn(),
        ...overrides,
      }
    }

    it('Escape never calls preventDefault, matching old WorldShell.tsx (which had no such call)', () => {
      const ctx = makeCtx()
      const uninstall = installKeymap(REGISTRY, () => ctx)
      const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
      expect(ctx.goUp).toHaveBeenCalledTimes(1)
      uninstall()
    })

    it('⌘Z calls preventDefault even while running (gated off), matching old WorldShell.tsx timing', () => {
      const ctx = makeCtx({ running: true })
      const uninstall = installKeymap(REGISTRY, () => ctx)
      const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true })
      window.dispatchEvent(e)
      // The old handler called e.preventDefault() as soon as meta+Z matched, BEFORE checking
      // `running` — so the browser default was suppressed even though undo() itself is skipped.
      expect(e.defaultPrevented).toBe(true)
      expect(ctx.undo).not.toHaveBeenCalled()
      uninstall()
    })

    it('⌘Z calls preventDefault and runs undo() when stopped', () => {
      const ctx = makeCtx({ running: false })
      const uninstall = installKeymap(REGISTRY, () => ctx)
      const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true, cancelable: true })
      window.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(true)
      expect(ctx.undo).toHaveBeenCalledTimes(1)
      uninstall()
    })
  })

  // wave 5 task 16 — the ⌘K command-palette binding added to REGISTRY.
  it('⌘K calls togglePalette regardless of running state (when: always)', () => {
    function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
      return {
        running: false,
        newWorld: vi.fn(),
        goGlobe: vi.fn(),
        setFilePath: vi.fn(),
        setShowHome: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        goUp: vi.fn(),
        exitPlaceMode: vi.fn(),
        isInPlaceMode: () => false,
        togglePalette: vi.fn(),
        ...overrides,
      }
    }
    const ctx = makeCtx({ running: true })
    const uninstall = installKeymap(REGISTRY, () => ctx)
    const e = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true })
    window.dispatchEvent(e)
    expect(ctx.togglePalette).toHaveBeenCalledTimes(1)
    uninstall()
  })
})
