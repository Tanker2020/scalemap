// src/app/world/server/FirewallGate.tsx
// Amber gate arch the NIC traffic threads through. T5 adds the blocked/s line.
import type { CSSProperties, ReactElement } from 'react'
import type { Box } from './boardLayout'

const AMBER = '#F59E0B'

export interface FirewallGateProps {
  box: Box
  ruleCount: number
  blockedPerSecond?: number       // T5
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
}

export function FirewallGate({ box, ruleCount, blockedPerSecond, selected, dimmed, onSelect }: FirewallGateProps): ReactElement {
  const arch: CSSProperties = {
    position: 'absolute', inset: 0, border: `1.5px solid ${selected ? AMBER : '#F59E0BAA'}`,
    borderRadius: 8, background: 'linear-gradient(180deg,#F59E0B11,#F59E0B04)',
    boxShadow: '0 0 16px #F59E0B33, inset 0 0 12px #F59E0B22',
  }
  return (
    <div data-firewall
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, cursor: 'pointer', opacity: dimmed ? 0.45 : 1 }}
      onClick={onSelect}>
      <div style={arch} />
      <div style={{ position: 'absolute', top: -14, width: '100%', textAlign: 'center', fontSize: 9, color: '#FBBF24', textShadow: `0 0 6px ${AMBER}` }}>🛡</div>
      <div style={{ position: 'absolute', bottom: -26, width: 130, left: (box.w - 130) / 2, textAlign: 'center', fontSize: 7, color: '#D9A24A', font: '7px var(--font-mono)' }}>
        FIREWALL · {ruleCount} rules
        {blockedPerSecond !== undefined && blockedPerSecond > 0 && (
          <><br /><span style={{ color: 'var(--color-danger)' }}>✕ {blockedPerSecond >= 1 ? blockedPerSecond.toFixed(0) : blockedPerSecond.toFixed(1)}/s blocked</span></>
        )}
      </div>
    </div>
  )
}
