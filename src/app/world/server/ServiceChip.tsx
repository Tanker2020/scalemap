// src/app/world/server/ServiceChip.tsx
// Process/container service chip. T4 fills the conn/p50 line + health dot; T6 adds dim/glow.
import type { CSSProperties, ReactElement } from 'react'
import type { ChipLayout } from './boardLayout'
import type { HealthState } from '../../../lib/worldEngine/types'

const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}

export interface ServiceChipProps {
  chip: ChipLayout
  name: string
  color: string
  portsLabel: string           // ":443 :80" or ":3000→8080"
  health?: HealthState
  connLabel?: string           // "1.1k conn · p50 2.1ms" — T4; T3 passes "—"
  selected?: boolean
  hovered?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function ServiceChip({ chip, name, color, portsLabel, health = 'healthy', connLabel = '—', selected, hovered, dimmed, onSelect, onHover }: ServiceChipProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: chip.box.x, top: chip.box.y, width: chip.box.w, minHeight: chip.box.h,
    background: 'linear-gradient(160deg,#16202E,#0E141E)',
    border: `1px solid ${selected || hovered ? color : color + '88'}`, borderRadius: 6, padding: 6,
    boxShadow: hovered ? `0 0 16px ${color}` : `0 0 10px ${color}22`,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '9px var(--font-mono)',
    transition: 'opacity 0.15s, box-shadow 0.15s',
  }
  return (
    <div data-chip data-instance={chip.instanceId} style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ color: '#DBEAFE' }}><span data-chip-tab style={{ color }}>▮</span> {name}</span>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: HEALTH_COLOR[health], boxShadow: `0 0 5px ${HEALTH_COLOR[health]}` }} />
      </div>
      <div style={{ color: '#7CFFE9', marginTop: 2, fontSize: 7 }}>{portsLabel}</div>
      <div style={{ color: 'var(--color-text-secondary)', fontSize: 7 }}>{connLabel}</div>
    </div>
  )
}
