// src/app/world/dock/drawers/RoleControl.tsx
// Wave 5 (Task 14b, supplementary): author a placement's `role` ('primary' | 'replica' |
// 'canary') — until this task there was NO UI path anywhere in the app to ever set a placement's
// role to 'canary', making the already-built CanaryWeightControl.tsx (Task 14) and the
// canary-failing analysis rule fully correct but functionally unreachable. Mounted inline in
// ServicesDrawer's per-placement chip body, directly above CanaryWeightControl, so switching TO
// 'canary' here reveals that field immediately in the same drawer (it already gates on
// `placement.role === 'canary'`).
//
// Mirrors CanaryWeightControl's own fieldRow/fieldLabel/fieldInput style constants and
// `updatePlacement` live-dispatch convention exactly, rather than inventing a new one.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import type { Placement, PlacementRole } from '../../../../lib/world/types'

const fieldRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }
const fieldLabel: CSSProperties = { flex: 1, color: 'var(--color-text-muted)', fontSize: 9.5 }
const fieldInput: CSSProperties = {
  width: 90, font: '9.5px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 5px',
  color: 'var(--color-text-primary)',
}

const ROLE_OPTIONS: PlacementRole[] = ['primary', 'replica', 'canary']

export interface RoleControlProps {
  placement: Placement
  running: boolean
}

export function RoleControl({ placement, running }: RoleControlProps): ReactElement {
  const onChange = (role: PlacementRole): void => {
    // Switching AWAY from 'canary' drops canaryWeight rather than leaving it stale-but-hidden —
    // mirrors AutoscaleControl's pickStatic, which drops the whole `autoscale` policy (not just
    // empties its fields) when a placement leaves autoscaled mode, making `count` authoritative
    // again. Same precedent here: canaryWeight is documented as "meaningful only when
    // role === 'canary'" (world/types.ts), so a primary/replica placement should never carry a
    // set-but-meaningless weight a future canary-role switch could resurrect unexpectedly.
    const patch: Partial<Placement> = { role }
    if (role !== 'canary') patch.canaryWeight = undefined
    useWorldStore.getState().updatePlacement(placement.id, patch)
  }

  return (
    <div style={fieldRow}>
      <label style={fieldLabel} htmlFor={`role-${placement.id}`}>role</label>
      <select
        id={`role-${placement.id}`} aria-label="role" style={fieldInput}
        value={placement.role} disabled={running}
        onChange={e => onChange(e.target.value as PlacementRole)}
      >
        {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
      </select>
    </div>
  )
}
