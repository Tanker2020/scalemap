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
}

export interface Binding {
  id: string
  keys: string
  label: string
  group: 'file' | 'navigate' | 'author' | 'chaos' | 'view'
  when?: 'always' | 'running' | 'stopped'
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
    if (parsed.key.length === 1 && e.key.toLowerCase() === parsed.key && evMeta === parsed.meta && e.shiftKey === parsed.shift) {
      return b
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
  { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: ctx => ctx.undo() },
  { id: 'redo', keys: '⇧⌘Z', label: 'Redo', group: 'author', when: 'stopped', run: ctx => ctx.redo() },
  {
    id: 'escape', keys: 'Escape', label: 'Back / exit place mode', group: 'navigate', when: 'always',
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
    const ctx = getCtx()
    if (!isEnabled(binding, ctx.running)) return
    e.preventDefault()
    binding.run(ctx)
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
