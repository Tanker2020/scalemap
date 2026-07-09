// src/app/world/server/NicBlock.tsx
// Teal edge connector on the left rail. T4 adds the live in/out bar; T3 shows the link speed.
import type { CSSProperties, ReactElement } from 'react'
import type { Box } from './boardLayout'

const TEAL = '#2DD4BF', TEAL_TEXT = '#7CFFE9'

export interface NicBlockProps {
  box: Box
  nicMbps: number
  inMbps?: number
  outMbps?: number
  utilFraction?: number        // (in+out)/nicMbps, 0..1 — T4
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function NicBlock({ box, nicMbps, inMbps, outMbps, utilFraction, selected, dimmed, onSelect, onHover }: NicBlockProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: box.x, top: box.y, width: box.w,
    background: 'linear-gradient(90deg,#0A2A26,#0E1A18)',
    border: `1px solid ${selected ? TEAL : '#2DD4BF66'}`, borderLeft: `3px solid ${TEAL}`,
    borderRadius: '0 6px 6px 0', padding: 6, boxShadow: '0 0 14px #2DD4BF22', cursor: 'pointer',
    opacity: dimmed ? 0.45 : 1, font: '8px var(--font-mono)',
  }
  return (
    <div data-nic style={style} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <div style={{ color: TEAL_TEXT, fontSize: 8.5 }}>eth0</div>
      <div style={{ color: '#5EEAD4', opacity: 0.8 }}>{nicMbps} Mbps</div>
      {inMbps !== undefined && outMbps !== undefined && (
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 3 }}>↓{Math.round(inMbps)} ↑{Math.round(outMbps)} Mb/s</div>
      )}
      <div style={{ height: 3, background: '#0F2B27', borderRadius: 2, marginTop: 3 }}>
        <div style={{ width: `${Math.min(100, (utilFraction ?? 0) * 100)}%`, height: '100%', background: TEAL, borderRadius: 2, boxShadow: `0 0 4px ${TEAL}` }} />
      </div>
    </div>
  )
}
