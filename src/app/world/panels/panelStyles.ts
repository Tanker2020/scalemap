import type { CSSProperties } from 'react'

export const panel: CSSProperties = {
  width: 300, flexShrink: 0, overflowY: 'auto', padding: 12,
  borderLeft: '1px solid var(--color-toolbar-border)', background: 'var(--color-surface)',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
export const sectionLabel: CSSProperties = {
  font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)',
  textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 6px',
}
export const field: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 4,
}
export const smallBtn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
export const dangerBtn: CSSProperties = { ...smallBtn, color: 'var(--color-danger)' }
export const row: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }
