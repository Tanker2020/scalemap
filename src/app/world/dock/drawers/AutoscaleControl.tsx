// src/app/world/dock/drawers/AutoscaleControl.tsx
// FEAT-008 (Task 21): author a placement's `AutoscalePolicy` (Task 10) inline, right beside
// SpreadControl in ServicesDrawer's per-placement chip body. A static-count placement (`count`,
// the existing stepper) and an autoscaled one (`minCount`/`maxCount`/`targetCpuPercent`/
// cooldowns/`scaleStep`, Task 11-13's runtime) are mutually exclusive on the SAME `Placement` —
// the toggle below is what switches a placement between those two authored shapes.
//
// Live-edit convention (matches EditServiceForm.tsx, not AddServiceForm's local-draft+submit):
// every field dispatches `updatePlacement` immediately, no separate "apply" step. Edit-lock law:
// the whole control is disabled while `running` (mirrors the count stepper right above it).
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import type { AutoscalePolicy, Placement } from '../../../../lib/world/types'

const DEFAULT_POLICY: Omit<AutoscalePolicy, 'minCount' | 'maxCount'> = {
  targetCpuPercent: 70,
  scaleUpCooldownSec: 60,
  scaleDownCooldownSec: 300,
}

const pillRow: CSSProperties = { display: 'flex', gap: 4, marginTop: 5 }
const pillBase: CSSProperties = {
  font: '9.5px var(--font-mono)', border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '2px 8px', cursor: 'pointer', background: 'var(--color-node-base)', color: 'var(--color-text-secondary)',
}
// Full `border` shorthand (not a `borderColor` longhand override on top of pillBase's
// shorthand `border`) — mixing the two across a re-render is exactly what React warns about
// ("Removing a style property during rerender... don't mix shorthand and non-shorthand
// properties"), verified live via a smoke test that caught the warning on the toggle click.
const pillActive: CSSProperties = {
  ...pillBase, background: 'color-mix(in srgb, var(--kit-cat-network) 18%, var(--color-node-base))',
  border: '1px solid var(--kit-cat-network)', color: 'var(--color-text-primary)',
}
const pillLocked: CSSProperties = { ...pillBase, opacity: 0.35, cursor: 'default' }
const panelStyle: CSSProperties = {
  marginTop: 5, padding: '6px 8px', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, font: '9.5px var(--font-mono)',
}
const fieldRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }
const fieldLabel: CSSProperties = { flex: 1, color: 'var(--color-text-muted)' }
const fieldInput: CSSProperties = {
  width: 62, font: '9.5px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 5px',
  color: 'var(--color-text-primary)',
}

export interface AutoscaleControlProps {
  placement: Placement
  running: boolean
}

export function AutoscaleControl({ placement, running }: AutoscaleControlProps): ReactElement {
  const isAutoscale = placement.autoscale != null

  const patch = (p: Partial<Placement>): void =>
    useWorldStore.getState().updatePlacement(placement.id, p)

  const tune = (p: Partial<AutoscalePolicy>): void => {
    if (!placement.autoscale) return
    patch({ autoscale: { ...placement.autoscale, ...p } })
  }

  const pickStatic = (): void => {
    if (running || !isAutoscale) return
    // Dropping `autoscale` (not merely emptying its fields) makes `count` authoritative again —
    // exactly the union the model documents (`Placement.autoscale?`).
    patch({ autoscale: undefined })
  }

  const pickAutoscale = (): void => {
    if (running || isAutoscale) return
    patch({
      autoscale: {
        ...DEFAULT_POLICY,
        minCount: Math.max(1, placement.count),
        maxCount: Math.max(2, placement.count * 2),
      },
    })
  }

  const numberField = (
    label: string, value: number, onChange: (v: number) => void,
    opts?: { min?: number; max?: number; step?: number },
  ): ReactElement => (
    <div style={fieldRow}>
      <label style={fieldLabel}>{label}</label>
      <input
        aria-label={label} type="number" style={fieldInput} value={value} disabled={running}
        min={opts?.min} max={opts?.max} step={opts?.step}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  )

  return (
    <div>
      <div style={pillRow} role="group" aria-label="scaling mode">
        <button
          type="button" className="kit-press" aria-pressed={!isAutoscale}
          style={running ? pillLocked : (!isAutoscale ? pillActive : pillBase)}
          disabled={running} onClick={pickStatic}
        >
          static count
        </button>
        <button
          type="button" className="kit-press" aria-pressed={isAutoscale}
          style={running ? pillLocked : (isAutoscale ? pillActive : pillBase)}
          disabled={running} onClick={pickAutoscale}
        >
          autoscale
        </button>
      </div>

      {isAutoscale && placement.autoscale && (
        <div style={panelStyle} data-testid="autoscale-fields">
          {numberField('min count', placement.autoscale.minCount, v => tune({ minCount: Math.max(1, v) }), { min: 1, step: 1 })}
          {numberField('max count', placement.autoscale.maxCount, v => tune({ maxCount: Math.max(placement.autoscale!.minCount, v) }), { min: 1, step: 1 })}
          {numberField('target cpu %', placement.autoscale.targetCpuPercent, v => tune({ targetCpuPercent: v }), { min: 1, max: 100, step: 5 })}
          {numberField('scale-up cooldown (s)', placement.autoscale.scaleUpCooldownSec, v => tune({ scaleUpCooldownSec: Math.max(0, v) }), { min: 0, step: 10 })}
          {numberField('scale-down cooldown (s)', placement.autoscale.scaleDownCooldownSec, v => tune({ scaleDownCooldownSec: Math.max(0, v) }), { min: 0, step: 10 })}
          {numberField('scale step (optional)', placement.autoscale.scaleStep ?? 0, v => tune({ scaleStep: v > 0 ? v : undefined }), { min: 0, step: 1 })}
        </div>
      )}
    </div>
  )
}
