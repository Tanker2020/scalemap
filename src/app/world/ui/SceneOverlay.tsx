// In-scene overlay card shell (Polish 2 D3) — the mockup's .ovl, tokenized. Plain DOM
// (mounted inside drei <Html> by the globe layers) so it and its content stay jsdom-testable.
import type { CSSProperties, ReactNode } from 'react'

const OVL_STYLE_ID = 'scalemap-scene-overlay-styles'
if (typeof document !== 'undefined' && !document.getElementById(OVL_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = OVL_STYLE_ID
  style.textContent = `
@keyframes scene-ovl-in { from { opacity: 0; transform: scale(0.92) translateY(-6px); } }
@keyframes scene-ovl-fade { from { opacity: 0; } }
.scene-ovl { animation: scene-ovl-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2); transform-origin: top left; }
@media (prefers-reduced-motion: reduce) {
  .scene-ovl { animation: scene-ovl-fade 0.15s ease; }
}
`
  document.head.appendChild(style)
}

const HEALTH_DOT: Record<'healthy' | 'degraded' | 'down', string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}

// Shared action-button styles for overlay footers (the mockup's .act family) — consumed by
// the T4 content components; exported here so every overlay speaks one dialect.
export const ovlAct: CSSProperties = {
  font: '11px var(--font-mono)', borderRadius: 5, padding: '5px 12px', cursor: 'pointer',
  border: '1px solid var(--color-node-border)', background: 'var(--color-node-base)',
  color: 'var(--color-text-primary)',
}
export const ovlActPrimary: CSSProperties = {
  ...ovlAct, borderColor: 'var(--kit-accent-dim)', color: 'var(--kit-accent)',
}
export const ovlActDanger: CSSProperties = { ...ovlAct, color: 'var(--color-danger)' }

export interface SceneOverlayProps {
  title: string
  health?: 'healthy' | 'degraded' | 'down' | null
  subtitle?: string
  /** Header dot for non-health entities (population teal). Health wins when both given. */
  dotColor?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Additive (Polish 2 T7): header dot ripples while true. Callers gate on `running` (or
   *  equivalent live-read) — never on by default. */
  ripple?: boolean
}

export function SceneOverlay({ title, health, subtitle, dotColor, onClose, children, footer, ripple }: SceneOverlayProps) {
  const dot = health ? HEALTH_DOT[health] : dotColor
  return (
    <div
      className="scene-ovl"
      style={{
        width: 296, borderRadius: 9,
        background: 'color-mix(in srgb, var(--color-node-base) 93%, transparent)',
        border: '1px solid var(--color-node-border)', backdropFilter: 'blur(6px)',
        boxShadow: '0 14px 40px rgba(0,0,0,0.66), 0 0 0 1px color-mix(in srgb, var(--kit-accent) 7%, transparent)',
        font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
      }}
    >
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px 9px',
        borderBottom: '1px solid var(--color-toolbar-border)',
      }}>
        {dot && (
          <span data-testid="scene-ovl-dot" className={ripple ? 'kit-ripple' : undefined} style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: dot, boxShadow: `0 0 6px ${dot}`,
            ...(ripple ? { color: dot } : null),
          }} />
        )}
        <b style={{ fontSize: 12, fontWeight: 600 }}>{title}</b>
        <small style={{ color: 'var(--color-text-muted)', fontSize: 10, marginLeft: 'auto' }}>
          {health ?? subtitle}
        </small>
      </header>
      {children}
      <footer style={{
        display: 'flex', gap: 7, padding: '10px 13px 12px', marginTop: 6,
        borderTop: '1px solid var(--color-toolbar-border)',
      }}>
        {footer}
        <button type="button" className="kit-press" style={{ ...ovlAct, marginLeft: 'auto' }} onClick={onClose}>
          esc
        </button>
      </footer>
    </div>
  )
}
