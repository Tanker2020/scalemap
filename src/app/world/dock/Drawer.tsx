// src/app/world/dock/Drawer.tsx
// Polish 4 T4 (spec D6): the generic accordion drawer every faceplate section (HARDWARE/
// FIREWALL/SERVICES/PLACEMENT) mounts identically — a full-width header (tri + letter-spaced
// title + the ALWAYS-visible `pv` one-line readout, "closed ≠ hidden") and a body that slides
// open. `ServerFaceplate.tsx` owns the one-open-at-a-time state; this component is a dumb,
// controlled accordion leaf with zero store/React-Router coupling of its own.
//
// The header is a `<div role="button">`, NOT a `<button>` — this dock renders inside WorldPanel's
// `<fieldset disabled={running}>` (T3's documented lesson, see task-4-brief.md): T5 (next task)
// needs these headers to stay open/closeable WHILE running (watching mode reads drawers as
// gauges), which a native `<button>` would silently forbid for the run's entire duration. Toggling
// a drawer is navigation-of-attention, not authoring, so it is never edit-locked either.
import { type CSSProperties, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'

export interface DrawerProps {
  accent: string        // left-border color (per-drawer category hue)
  title: string          // 'HARDWARE' | 'FIREWALL' | 'SERVICES' | 'PLACEMENT'
  readout: ReactNode     // the pv — always visible, even closed
  open: boolean
  onToggle: () => void
  children: ReactNode
}

const OPEN_MAX_HEIGHT = 340

export function Drawer({ accent, title, readout, open, onToggle, children }: DrawerProps) {
  const reduced = useReducedMotion() ?? false

  const headerStyle: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '8px 11px', cursor: 'pointer',
    fontSize: 9.5, letterSpacing: '0.13em', color: 'var(--color-text-secondary)',
  }
  const triStyle: CSSProperties = {
    display: 'inline-block', color: 'var(--kit-accent)', fontSize: 9, lineHeight: 1,
    transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
    transition: reduced ? undefined : 'transform 0.18s',
  }
  const bodyStyle: CSSProperties = {
    overflow: 'hidden',
    maxHeight: open ? OPEN_MAX_HEIGHT : 0,
    opacity: open ? 1 : 0,
    padding: open ? '2px 11px 10px' : '0 11px',
    transition: reduced ? undefined : 'max-height 0.26s cubic-bezier(0.3, 0.8, 0.3, 1), opacity 0.18s, padding 0.2s',
  }

  return (
    <div
      data-testid="drawer" data-open={open ? 'true' : 'false'} data-drawer={title}
      style={{
        border: '1px solid var(--color-node-border)', borderLeft: `2px solid ${accent}`,
        borderRadius: 7, marginBottom: 7, overflow: 'hidden', background: 'var(--color-node-base)',
      }}
    >
      <div
        role="button" tabIndex={0} data-testid="drawer-header" aria-expanded={open}
        style={headerStyle}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
      >
        <span aria-hidden style={triStyle}>▸</span>
        <span>{title}</span>
        <span data-testid="drawer-pv" style={{
          marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: 9,
          letterSpacing: 0, fontVariantNumeric: 'tabular-nums',
        }}>
          {readout}
        </span>
      </div>
      <div data-testid="drawer-body" style={bodyStyle}>
        {children}
      </div>
    </div>
  )
}
