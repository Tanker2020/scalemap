// src/app/world/dock/drawers/SpreadControl.tsx
// "Replicate this service into other AZs" — the UI for world.store.spreadBlueprint.
//
// The design brief's fifth pain point: replicating a service across AZs used to mean hand-placing
// N placements onto N servers that happened to live in different AZs, with nothing in the app
// naming the concept. This is one control: tick the AZs, press spread. Per-server control
// survives as an OVERRIDE afterwards (drag the copy elsewhere), not as a prerequisite.
//
// SCOPE — same region only. "Spread" here means multi-AZ high availability, which is what the
// brief asked for ("replicating a service across AZs"). Standing a service up in ANOTHER REGION
// is a different concern with its own machinery (region role active/passive, DNS failover, the
// routing policy) and deliberately does not hide behind this button.
import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'

const btnStyle: CSSProperties = {
  font: '9.5px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 8px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}

const btnLockedStyle: CSSProperties = { ...btnStyle, opacity: 0.35, cursor: 'default' }

const panelStyle: CSSProperties = {
  marginTop: 5, marginLeft: 15, padding: '6px 8px',
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 5, font: '9.5px var(--font-mono)',
}

export interface SpreadControlProps {
  blueprintId: string
  /** The host this copy runs on — its AZ's region scopes the candidate list. */
  serverId: string
  running: boolean
}

export function SpreadControl({ blueprintId, serverId, running }: SpreadControlProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  // Candidates: AZs of this server's region that do NOT already run the service. An AZ that
  // already hosts it is not offered at all — planSpread would skip it, so listing it would invite
  // a click that silently does nothing.
  const candidates = useMemo(() => {
    const server = doc.servers[serverId]
    if (!server) return []
    const regionId = doc.azs[server.azId]?.regionId
    if (!regionId) return []

    const occupied = new Set<string>()
    for (const placement of Object.values(doc.placements)) {
      if (placement.blueprintId !== blueprintId) continue
      const host = doc.servers[placement.serverId]
      if (host) occupied.add(host.azId)
    }

    return Object.values(doc.azs)
      .filter(az => az.regionId === regionId && !occupied.has(az.id))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [doc, blueprintId, serverId])

  const toggle = (azId: string): void => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(azId)) next.delete(azId)
      else next.add(azId)
      return next
    })
  }

  const apply = (): void => {
    useWorldStore.getState().spreadBlueprint(blueprintId, [...checked])
    // Collapse back to rest: the candidate list has just changed under the user, and leaving a
    // stale set of ticked boxes open invites a second click that does nothing.
    setChecked(new Set())
    setOpen(false)
  }

  return (
    <div>
      <button
        type="button" className="kit-press"
        style={running ? btnLockedStyle : btnStyle}
        disabled={running}
        title={running ? 'stop the simulation to edit' : 'replicate this service into other AZs'}
        onClick={() => setOpen(o => !o)}
      >
        spread ⇢
      </button>

      {open && (
        <div style={panelStyle}>
          {candidates.length === 0 ? (
            <div style={{ color: 'var(--color-text-muted)' }}>
              Already in every AZ of this region.
            </div>
          ) : (
            <>
              {candidates.map(az => (
                <label
                  key={az.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    aria-label={az.label}
                    checked={checked.has(az.id)}
                    onChange={() => toggle(az.id)}
                  />
                  <span style={{ color: 'var(--color-text-primary)' }}>{az.label}</span>
                </label>
              ))}
              <button
                type="button" className="kit-press"
                style={{ ...(checked.size === 0 ? btnLockedStyle : btnStyle), marginTop: 5 }}
                disabled={checked.size === 0}
                onClick={apply}
              >
                spread into {checked.size} AZ{checked.size === 1 ? '' : 's'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
