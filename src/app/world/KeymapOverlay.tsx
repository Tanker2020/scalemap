// Keyboard-map overlay (`?` / `⌘/`) — a self-maintaining read-only view over keymap.ts's
// REGISTRY: every current binding's keys/label/group, grouped, with disabled bindings shown
// dimmed against the CURRENT running flag (via keymap.ts's own `isEnabled`, so this component
// never re-derives the enable rule — a future `when` value works here for free). A future
// binding needs ZERO changes to this file to show up; it just needs to exist in REGISTRY.
// Mirrors CommandPalette.tsx's overlay/portal pattern (backdrop + centered surface, click-away
// closes, reduced-motion gated) so it reads as the SAME kind of modal as the rest of the app.
import { type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { isEnabled, type Binding } from '../keymap'

export interface KeymapOverlayProps {
  open: boolean
  registry: Binding[]
  running: boolean
  onClose: () => void
}

const GROUP_LABELS: Record<Binding['group'], string> = {
  file: 'File',
  navigate: 'Navigate',
  author: 'Author',
  chaos: 'Chaos',
  view: 'View',
}

// Registry order is authorial (roughly file → navigate → author → chaos → view as bindings were
// added); render groups in that same fixed order rather than Map insertion order so the overlay
// doesn't reshuffle sections as bindings are added/removed from REGISTRY.
const GROUP_ORDER: Binding['group'][] = ['file', 'navigate', 'author', 'chaos', 'view']

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
}
const surfaceStyle: CSSProperties = {
  width: 460, maxWidth: '92vw', maxHeight: '76vh', display: 'flex', flexDirection: 'column',
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)', borderRadius: 8,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)', overflow: 'hidden',
}
const headerStyle: CSSProperties = {
  padding: '10px 14px', borderBottom: '1px solid var(--color-node-border)',
  font: '12px var(--font-mono)', color: 'var(--color-text-primary)', fontWeight: 600,
}
const bodyStyle: CSSProperties = { overflowY: 'auto', padding: '6px 14px 14px' }
const groupTitleStyle: CSSProperties = {
  font: '10px var(--font-mono)', color: 'var(--color-text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.06em', margin: '10px 0 4px',
}
const listStyle: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 }

function itemStyle(enabled: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '5px 4px', font: '12px var(--font-mono)',
    color: enabled ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
    opacity: enabled ? 1 : 0.5,
  }
}
const kbdStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '1px 6px', font: '11px var(--font-mono)',
  color: 'var(--color-text-secondary)',
}

export function KeymapOverlay({ open, registry, running, onClose }: KeymapOverlayProps) {
  const reduced = useReducedMotion()
  if (!open) return null

  const byGroup = new Map<Binding['group'], Binding[]>()
  for (const b of registry) {
    if (!byGroup.has(b.group)) byGroup.set(b.group, [])
    byGroup.get(b.group)!.push(b)
  }
  // Any group not in GROUP_ORDER (there shouldn't be one — Binding['group'] is a closed union —
  // but this keeps the render additive-safe rather than silently dropping a future group value)
  // renders after the known groups, in first-seen order.
  const orderedGroups = [...GROUP_ORDER, ...[...byGroup.keys()].filter(g => !GROUP_ORDER.includes(g))]

  return createPortal(
    <div
      data-testid="keymap-overlay"
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
        <div style={headerStyle}>Keyboard shortcuts</div>
        <div style={bodyStyle}>
          {orderedGroups.map(group => {
            const bindings = byGroup.get(group)
            if (!bindings || bindings.length === 0) return null
            return (
              <section key={group}>
                <div style={groupTitleStyle}>{GROUP_LABELS[group] ?? group}</div>
                <ul style={listStyle}>
                  {bindings.map(b => {
                    const enabled = isEnabled(b, running)
                    return (
                      <li key={b.id} aria-disabled={!enabled} style={itemStyle(enabled)}>
                        <span>{b.label}</span>
                        <kbd style={kbdStyle}>{b.keys}</kbd>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}
