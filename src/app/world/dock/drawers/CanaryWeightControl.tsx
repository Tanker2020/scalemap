// src/app/world/dock/drawers/CanaryWeightControl.tsx
// Wave 5 (Task 14): author a canary placement's `canaryWeight` — the 0..1 authored regional
// traffic fraction `routingRuntime.ts`'s canary routing already reads (`Placement.canaryWeight`,
// world/types.ts: "meaningful only when role === 'canary'"). Mounted inline in ServicesDrawer's
// per-placement chip body, right beside AutoscaleControl, and mirrors that control's exact
// numberField()/`updatePlacement` patch/edit-lock convention rather than inventing a new one —
// this is the smallest addition, a single field, so it inlines the pattern directly instead of
// pulling in AutoscaleControl's full label/onChange helper machinery for one field.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import type { Placement } from '../../../../lib/world/types'

const fieldRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }
const fieldLabel: CSSProperties = { flex: 1, color: 'var(--color-text-muted)', fontSize: 9.5 }
const fieldInput: CSSProperties = {
  width: 62, font: '9.5px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 5px',
  color: 'var(--color-text-primary)',
}

const DEFAULT_CANARY_WEIGHT = 0.05

export interface CanaryWeightControlProps {
  placement: Placement
  running: boolean
}

// Shown ONLY for role: 'canary' — canaryWeight is meaningless (and routingRuntime.ts never
// reads it) for any other role, per the field's own doc comment on `Placement`.
export function CanaryWeightControl({ placement, running }: CanaryWeightControlProps): ReactElement | null {
  if (placement.role !== 'canary') return null

  const value = placement.canaryWeight ?? DEFAULT_CANARY_WEIGHT

  const onChange = (v: number): void => {
    if (Number.isNaN(v)) return
    useWorldStore.getState().updatePlacement(placement.id, { canaryWeight: Math.min(1, Math.max(0, v)) })
  }

  return (
    <div style={fieldRow} data-testid="canary-weight-field">
      <label style={fieldLabel} htmlFor={`canary-weight-${placement.id}`}>canary weight</label>
      <input
        id={`canary-weight-${placement.id}`} aria-label="canary weight" type="number"
        style={fieldInput} value={value} disabled={running}
        min={0} max={1} step={0.01}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  )
}
