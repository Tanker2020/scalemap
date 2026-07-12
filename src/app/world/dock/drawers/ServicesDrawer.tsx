// src/app/world/dock/drawers/ServicesDrawer.tsx
// Polish 4 T4 (spec D6): the SERVICES drawer body — one chip line per placement resident on this
// server (blueprint color swatch, name, `:port · role`, a count stepper), plus a ghosted
// "+ mount a blueprint…" line that expands to a blueprint `<select>` and dispatches
// `addPlacement(blueprintId, serverId)` — PlacementPanel's exact dispatch (relocated-dispatch
// contract). The count stepper reuses `updatePlacement(id, { count })`, clamped >= 1 (mirrors
// PlacementPanel's own `Math.max(1, ...)` clamp).
import { useState, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import type { Placement, Server, WorldDoc } from '../../../../lib/world/types'

export function servicesPv(serverId: string, doc: WorldDoc): string {
  const placements = Object.values(doc.placements).filter(p => p.serverId === serverId)
  if (placements.length === 0) return '—'
  if (placements.length === 1) {
    const pl = placements[0]
    const bp = doc.blueprints[pl.blueprintId]
    return `${bp?.name ?? '?'} ×${pl.count} · ${pl.role}`
  }
  return `${placements.length} services`
}

export interface ServicesDrawerProps {
  server: Server
  doc: WorldDoc
  running: boolean
}

export function ServicesDrawer({ server, doc, running }: ServicesDrawerProps): ReactElement {
  const [mounting, setMounting] = useState(false)
  const placements = Object.values(doc.placements).filter(p => p.serverId === server.id)
  const blueprints = Object.values(doc.blueprints)

  const step = (pl: Placement, delta: number) => {
    useWorldStore.getState().updatePlacement(pl.id, { count: Math.max(1, pl.count + delta) })
  }

  const mount = (blueprintId: string) => {
    if (!blueprintId) return
    useWorldStore.getState().addPlacement(blueprintId, server.id)
    setMounting(false)
  }

  return (
    <div data-testid="services-drawer-body">
      {placements.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', padding: '4px 2px' }}>No services mounted here yet.</div>
      )}
      {placements.map(pl => {
        const bp = doc.blueprints[pl.blueprintId]
        return (
          <div
            key={pl.id} data-testid="service-chip-line" className="kit-row"
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 6px', borderRadius: 5 }}
          >
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: bp?.color ?? 'var(--color-text-muted)', flexShrink: 0 }} />
            <span style={{ color: 'var(--color-text-primary)' }}>{bp?.name ?? '?'}</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 9.5 }}>
              :{bp?.ports[0]?.port ?? '—'} · {pl.role}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>
              <button
                type="button" className="kit-press" aria-label={`decrease ${bp?.name ?? 'placement'} count`}
                disabled={running} title={running ? 'stop the simulation to edit' : undefined}
                style={stepBtnStyle} onClick={() => step(pl, -1)}
              >
                −
              </button>
              <button
                type="button" className="kit-press" aria-label={`increase ${bp?.name ?? 'placement'} count`}
                disabled={running} title={running ? 'stop the simulation to edit' : undefined}
                style={stepBtnStyle} onClick={() => step(pl, 1)}
              >
                +
              </button>
            </span>
            <span data-testid="service-chip-count" style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              ×{pl.count}
            </span>
          </div>
        )
      })}

      {mounting ? (
        <select
          aria-label="mount a blueprint" autoFocus disabled={running}
          style={{
            width: '100%', marginTop: 6, background: 'var(--color-node-base)',
            border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
            font: '10.5px var(--font-mono)', color: 'var(--color-text-primary)',
          }}
          defaultValue=""
          onChange={e => mount(e.target.value)}
          onBlur={() => setMounting(false)}
        >
          <option value="" disabled>choose a blueprint…</option>
          {blueprints.map(bp => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
        </select>
      ) : (
        <div
          role="button" tabIndex={running ? -1 : 0} data-testid="mount-blueprint-ghost"
          aria-disabled={running || blueprints.length === 0}
          style={{
            fontSize: 10, color: 'var(--color-text-muted)', padding: '6px 6px', marginTop: 4,
            cursor: running || blueprints.length === 0 ? 'default' : 'pointer',
            opacity: running || blueprints.length === 0 ? 0.5 : 1,
          }}
          title={running ? 'stop the simulation to edit' : undefined}
          onClick={() => { if (!running && blueprints.length > 0) setMounting(true) }}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ' ') && !running && blueprints.length > 0) {
              e.preventDefault(); setMounting(true)
            }
          }}
        >
          + mount a blueprint…
        </div>
      )}
    </div>
  )
}

const stepBtnStyle = {
  width: 18, height: 18, background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 10, lineHeight: 1,
} as const
