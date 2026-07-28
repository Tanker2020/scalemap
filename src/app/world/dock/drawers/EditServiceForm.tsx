// src/app/world/dock/drawers/EditServiceForm.tsx
// Post-creation service editor (node-model Phase 5).
//
// AddServiceForm (the "VPS door") sets a service's name/workload/ports/stateful ONCE, at creation.
// The retired BlueprintPanel was the only surface that could change them afterwards; this compact
// form restores that — reachable from a service's chip in the ServicesDrawer — so an existing
// service stays editable without recreating it. Dependencies are deliberately NOT here: those are
// authored in the Connections tab (the logical graph), which owns the edge shape end-to-end.
//
// Edits are LIVE (each change dispatches updateBlueprint, mutate()-wrapped for undo/dirty), matching
// the pre-Phase-5 panels. The whole form is disabled while the simulation runs — the same edit-lock
// every authoring surface honors.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import type { ServiceBlueprint, WorkloadProfile } from '../../../../lib/world/types'

const field: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '3px 6px', color: 'var(--color-text-primary)', width: '100%',
}
const btn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 10px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const rowLabel: CSSProperties = { color: 'var(--color-text-muted)', display: 'block', marginBottom: 2 }
const rowGap: CSSProperties = { marginBottom: 7 }

export interface EditServiceFormProps {
  blueprintId: string
  running: boolean
  onDone: () => void
}

export function EditServiceForm({ blueprintId, running, onDone }: EditServiceFormProps): ReactElement | null {
  const bp = useWorldStore(s => s.doc.blueprints[blueprintId])
  if (!bp) return null

  const upd = (patch: Partial<ServiceBlueprint>): void =>
    useWorldStore.getState().updateBlueprint(blueprintId, patch)
  const tuneWorkload = (patch: Partial<WorkloadProfile>): void =>
    upd({ workload: { ...bp.workload, ...patch } })

  const port = bp.ports[0]

  const numberField = (
    label: string, value: number, onChange: (v: number) => void,
  ): ReactElement => (
    <div style={rowGap}>
      <label style={rowLabel}>{label}</label>
      <input
        aria-label={label} type="number" style={field} value={value} disabled={running}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  )

  return (
    <div style={{ font: '10px var(--font-mono)', padding: '6px 2px', borderLeft: '1px solid var(--color-node-border)', paddingLeft: 8 }}>
      <div style={rowGap}>
        <label htmlFor={`edit-name-${bp.id}`} style={rowLabel}>service name</label>
        <input
          id={`edit-name-${bp.id}`} aria-label="service name" style={field} value={bp.name} disabled={running}
          onChange={e => upd({ name: e.target.value })}
        />
      </div>

      {port ? (
        <div style={{ display: 'flex', gap: 6, ...rowGap }}>
          <div style={{ flex: '0 0 70px' }}>
            <label style={rowLabel}>port</label>
            <input
              aria-label="port" type="number" style={field} value={port.port} disabled={running}
              onChange={e => upd({ ports: bp.ports.map((p, i) => i === 0 ? { ...p, port: Number(e.target.value) } : p) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={rowLabel}>reachable from</label>
            <select
              aria-label="visibility" style={field} value={port.visibility} disabled={running}
              onChange={e => upd({ ports: bp.ports.map((p, i) => i === 0 ? { ...p, visibility: e.target.value as 'public' | 'internal' } : p) })}
            >
              <option value="internal">internal only</option>
              <option value="public">the internet</option>
            </select>
          </div>
        </div>
      ) : (
        <div style={{ ...rowGap, color: 'var(--color-text-muted)' }}>no inbound port (worker)</div>
      )}

      {numberField('cpu / request', bp.workload.cpuMsPerRequest, v => tuneWorkload({ cpuMsPerRequest: v }))}
      {numberField('cpu / KB', bp.workload.cpuMsPerKb ?? 0, v => tuneWorkload({ cpuMsPerKb: v }))}
      {numberField('ram base', bp.workload.ramBaseMb, v => tuneWorkload({ ramBaseMb: v }))}
      {numberField('ram per connection', bp.workload.ramPerConnMb, v => tuneWorkload({ ramPerConnMb: v }))}
      {numberField('disk io per request', bp.workload.diskIoPerRequest, v => tuneWorkload({ diskIoPerRequest: v }))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...rowGap }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-muted)', flex: 1 }}>
          <input
            type="checkbox" aria-label="stateful" checked={bp.stateful} disabled={running}
            onChange={e => upd({ stateful: e.target.checked, volumeName: e.target.checked ? (bp.volumeName ?? `${bp.name}-data`) : null })}
          />
          stateful
        </label>
        {bp.stateful && (
          <input
            aria-label="volume name" style={{ ...field, flex: 1 }} placeholder="volume name"
            value={bp.volumeName ?? ''} disabled={running}
            onChange={e => upd({ volumeName: e.target.value || null })}
          />
        )}
      </div>

      <button type="button" className="kit-press" style={btn} onClick={onDone}>done</button>
    </div>
  )
}
