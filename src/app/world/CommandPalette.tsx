// Command palette (⌘K) — filterable UI over commands.ts's buildCommands() list. Mirrors
// SettingsModal.tsx's overlay/portal pattern (backdrop + centered surface, click-away closes) so
// it reads as the SAME kind of modal as the rest of the app, not a bespoke widget.
import { useState, useMemo, useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import type { PaletteCommand } from './commands'

export interface CommandPaletteProps {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
  running: boolean
}

// Standardized tooltip copy — MUST match the wording used by every other running-gated author
// control in the app (dock drawers, WorldPanel's fieldset) so the palette doesn't invent a
// second phrasing for the same rule.
const STOPPED_TOOLTIP = 'stop the simulation to edit'
const RUNNING_TOOLTIP = 'start the simulation to break things'

function isEnabledFor(c: PaletteCommand, running: boolean): boolean {
  if (!c.when || c.when === 'always') return true
  return c.when === 'running' ? running : !running
}

function tooltipFor(c: PaletteCommand): string | undefined {
  if (c.when === 'stopped') return STOPPED_TOOLTIP
  if (c.when === 'running') return RUNNING_TOOLTIP
  return undefined
}

// Ranked substring match: a command whose label contains the query earlier (closer to the
// start) ranks higher — a plain indexOf is a fine, cheap proxy for "how good a match is this"
// at palette scale (dozens of commands, not thousands).
function rank(query: string, label: string): number {
  return label.toLowerCase().indexOf(query.toLowerCase())
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh', zIndex: 1100,
}
const surfaceStyle: CSSProperties = {
  width: 480, maxWidth: '92vw', maxHeight: '60vh', display: 'flex', flexDirection: 'column',
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)', borderRadius: 8,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)', overflow: 'hidden',
}
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)', border: 'none',
  borderBottom: '1px solid var(--color-node-border)', padding: '10px 12px', fontSize: 13,
  fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)', outline: 'none',
}
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 4, overflowY: 'auto' }
const emptyStyle: CSSProperties = {
  padding: '16px 12px', font: '11px var(--font-mono)', color: 'var(--color-text-muted)', textAlign: 'center',
}

const GROUP_GLYPH: Record<PaletteCommand['group'], string> = {
  file: '●', navigate: '▸', author: '⌬', chaos: '⊘', view: '⌖',
}

function itemStyle(active: boolean, enabled: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 4,
    cursor: enabled ? 'pointer' : 'not-allowed',
    background: active ? 'var(--color-node-hover, var(--color-surface-hover))' : 'transparent',
    color: enabled ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    opacity: enabled ? 1 : 0.55,
    font: '12px var(--font-mono)',
  }
}

export function CommandPalette({ open, commands, onClose, running }: CommandPaletteProps) {
  const reduced = useReducedMotion()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) { setQuery(''); setActiveIndex(0) }
  }, [open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const filtered = useMemo(() => {
    if (!query) return commands
    return commands
      .map(c => ({ c, r: rank(query, c.label) }))
      .filter(x => x.r !== -1)
      .sort((a, b) => a.r - b.r)
      .map(x => x.c)
  }, [query, commands])

  // Query/command-set changes can leave activeIndex pointing past the new filtered list (or at a
  // stale index after a keystroke narrows the results) — clamp every render rather than only on
  // the two triggering effects above, so it's never observably out of range for a render that
  // slips between those effects and the list below.
  const clampedIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1)

  if (!open) return null

  const runIfEnabled = (c: PaletteCommand) => {
    if (!isEnabledFor(c, running)) return
    c.run()
    onClose()
  }

  return createPortal(
    <div
      data-testid="command-palette-overlay"
      style={backdropStyle}
      onClick={onClose}
    >
      <motion.div
        style={surfaceStyle}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -6 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.14 }}
        onClick={e => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          aria-label="command palette search"
          placeholder="Type a command…"
          style={inputStyle}
          value={query}
          onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
          onKeyDown={e => {
            if (e.key === 'Escape') { onClose(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, filtered.length - 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); return }
            if (e.key === 'Enter') {
              const cmd = filtered[clampedIndex]
              if (cmd) runIfEnabled(cmd)
            }
          }}
        />
        {filtered.length === 0 ? (
          <div style={emptyStyle}>no matching commands</div>
        ) : (
          <ul style={listStyle}>
            {filtered.map((c, i) => {
              const enabled = isEnabledFor(c, running)
              return (
                <li
                  key={c.id}
                  aria-disabled={!enabled}
                  title={tooltipFor(c)}
                  style={itemStyle(i === clampedIndex, enabled)}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => runIfEnabled(c)}
                >
                  <span aria-hidden style={{ color: 'var(--color-text-secondary)' }}>{GROUP_GLYPH[c.group]}</span>
                  <span>{c.label}</span>
                </li>
              )
            })}
          </ul>
        )}
      </motion.div>
    </div>,
    document.body,
  )
}
