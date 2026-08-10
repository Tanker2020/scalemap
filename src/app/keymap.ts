// Single keybinding registry — replaces the two independent `keydown` listeners that used to
// live in App.tsx (⌘N) and WorldShell.tsx (⌘Z/⇧⌘Z/Escape). installKeymap() sets up exactly ONE
// window-level `keydown` listener, applying the SAME focused-input guard to every binding
// uniformly (App.tsx's old ⌘N handler had no such guard — that gap is closed here as a natural
// side effect of consolidation).
//
// This is also the seam later ergonomics-pack tasks (command palette, keyboard-map overlay)
// build on: both read REGISTRY/Binding/CommandContext from here rather than re-deriving bindings.
// keymap.ts itself has no React/hook dependency — CommandContext is a plain bag of function
// references, so REGISTRY's matching/enabling logic is unit-testable headlessly.

export interface CommandContext {
  running: boolean
  newWorld: () => void
  goGlobe: () => void
  setFilePath: (p: string | null) => void
  setShowHome: (b: boolean) => void
  undo: () => void
  redo: () => void
  goUp: () => void
  exitPlaceMode: () => void
  isInPlaceMode: () => boolean
  // wave 5 task 16 — toggles the command palette's ui.store-backed open state (see ui.store.ts's
  // paletteOpen for why it isn't WorldShell-local).
  togglePalette: () => void
  // wave 5 task 19 — toggles the self-maintaining keyboard-map overlay's ui.store-backed open
  // state, the same lift pattern as togglePalette one task earlier.
  toggleHelp: () => void
}

export interface Binding {
  id: string
  keys: string
  label: string
  group: 'file' | 'navigate' | 'author' | 'chaos' | 'view'
  when?: 'always' | 'running' | 'stopped'
  // Controls WHEN (if at all) installKeymap calls e.preventDefault() for this binding, matching
  // the exact per-handler timing of the two pre-migration listeners this file replaces (see
  // task-15-report.md's "Fix round 1" section):
  //   - 'match'   — as soon as the key combo matches, BEFORE the `when`/isEnabled gate. This is
  //                 the old WorldShell.tsx ⌘Z/⇧⌘Z behavior: the browser default was suppressed
  //                 even when the running-gate skipped the actual undo/redo.
  //   - 'enabled' (default) — after the binding passes isEnabled, matching old App.tsx's ⌘N
  //                 (which had no gate, so 'match' and 'enabled' are equivalent for it).
  //   - 'never'   — old WorldShell.tsx's Escape branch NEVER called preventDefault; the escape
  //                 binding uses this to reproduce that exactly (leaves the browser's native
  //                 Escape default action — e.g. exiting fullscreen — untouched, as before).
  preventDefault?: 'match' | 'enabled' | 'never'
  run: (ctx: CommandContext) => void
}

function parseKeys(keys: string): { key: string; meta: boolean; shift: boolean } {
  const shift = keys.includes('⇧')
  const meta = keys.includes('⌘')
  const key = keys.replace('⇧', '').replace('⌘', '').toLowerCase()
  return { key, meta, shift }
}

export function matchBinding(e: KeyboardEvent, registry: Binding[]): Binding | null {
  for (const b of registry) {
    const parsed = parseKeys(b.keys)
    const evMeta = e.metaKey || e.ctrlKey
    if (parsed.key === 'escape') {
      if (e.key === 'Escape') return b
      continue
    }
    if (parsed.key.length === 1) {
      // A symbol like '?' already has Shift baked into the browser's e.key (Shift+/ produces
      // key === '?', with e.shiftKey === true even though the binding is authored as a BARE
      // key with no ⇧ glyph). Requiring e.shiftKey === parsed.shift for those would make a bare
      // '?' binding un-triggerable by the only physical key combo that ever produces '?'. Only
      // alphanumeric single-char keys need the explicit shift check — that's what keeps ⌘Z and
      // ⇧⌘Z distinguishable (both parse to key 'z', shift is the only thing telling them apart).
      const isAlphaNum = /[a-z0-9]/.test(parsed.key)
      const shiftOk = isAlphaNum ? e.shiftKey === parsed.shift : true
      if (e.key.toLowerCase() === parsed.key && evMeta === parsed.meta && shiftOk) {
        return b
      }
    }
  }
  return null
}

export function isEnabled(binding: Binding, running: boolean): boolean {
  if (!binding.when || binding.when === 'always') return true
  return binding.when === 'running' ? running : !running
}

export const REGISTRY: Binding[] = [
  {
    id: 'new-world', keys: '⌘N', label: 'New world', group: 'file', when: 'always',
    run: ctx => {
      ctx.newWorld()
      ctx.goGlobe()
      ctx.setFilePath(null)
      // Matches the header New button: a new world starts from the home screen.
      ctx.setShowHome(true)
    },
  },
  { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', preventDefault: 'match', run: ctx => ctx.undo() },
  { id: 'redo', keys: '⇧⌘Z', label: 'Redo', group: 'author', when: 'stopped', preventDefault: 'match', run: ctx => ctx.redo() },
  {
    id: 'toggle-palette', keys: '⌘K', label: 'Command palette', group: 'view', when: 'always',
    run: ctx => ctx.togglePalette(),
  },
  {
    id: 'toggle-help', keys: '⌘/', label: 'Keyboard shortcuts', group: 'view', when: 'always',
    run: ctx => ctx.toggleHelp(),
  },
  {
    // Bare '?' is the conventional "show shortcuts" trigger in most apps, alongside ⌘/. It's a
    // second REGISTRY entry (not a second keys-string on the same binding — matchBinding only
    // ever parses one `keys` string per Binding) so KeymapOverlay lists both ways to open it,
    // same self-maintaining property as every other binding.
    id: 'toggle-help-bare', keys: '?', label: 'Keyboard shortcuts', group: 'view', when: 'always',
    run: ctx => ctx.toggleHelp(),
  },
  {
    id: 'escape', keys: 'Escape', label: 'Back / exit place mode', group: 'navigate', when: 'always', preventDefault: 'never',
    run: ctx => {
      // Escape disarms an armed placeMode BEFORE it climbs a nav level — otherwise a globe-level
      // Esc (nav.up() is already a no-op there) would look like it did nothing, when the
      // actually-visible thing to cancel is the placement mode (Polish 4 T7, spec D9).
      if (ctx.isInPlaceMode()) {
        ctx.exitPlaceMode()
        return
      }
      ctx.goUp()
    },
  },
]

export function installKeymap(registry: Binding[], getCtx: () => CommandContext): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
    const binding = matchBinding(e, registry)
    if (!binding) return
    const pd = binding.preventDefault ?? 'enabled'
    if (pd === 'match') e.preventDefault()
    const ctx = getCtx()
    if (!isEnabled(binding, ctx.running)) return
    if (pd === 'enabled') e.preventDefault()
    binding.run(ctx)
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
