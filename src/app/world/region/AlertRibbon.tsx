// src/app/world/region/AlertRibbon.tsx
// Single alert ribbon above the region flow (D3/D6, mockup line 174). Renders the region's
// single most-severe active event; null renders nothing (no persistent "all clear" chrome,
// mirroring InspectorV2's null-when-empty convention).
import type { ReactElement } from 'react'
import type { RibbonAlert } from './regionData'

// Alpha-tinted bg/border + a lighter text tint for contrast aren't expressible via a plain
// var() substitution — same local-hex-constant carve-out as Phase 3's FirewallGate.tsx AMBER
// constant (R2).
const RIBBON_BG: Record<RibbonAlert['severity'], string> = { critical: '#EF444412', warning: '#F59E0B12' }
const RIBBON_BORDER: Record<RibbonAlert['severity'], string> = { critical: '#EF444433', warning: '#F59E0B33' }
const RIBBON_TEXT: Record<RibbonAlert['severity'], string> = { critical: '#FCA5A5', warning: '#FDE68A' }

export interface AlertRibbonProps { alert: RibbonAlert | null; onTimelineClick: () => void }

export function AlertRibbon({ alert, onTimelineClick }: AlertRibbonProps): ReactElement | null {
  if (!alert) return null
  return (
    <div
      role="alert"
      style={{
        background: RIBBON_BG[alert.severity], border: `1px solid ${RIBBON_BORDER[alert.severity]}`,
        borderRadius: 6, padding: '5px 10px', font: '9px var(--font-mono)',
        color: RIBBON_TEXT[alert.severity], marginBottom: 14,
      }}
    >
      ⚠ {alert.message}{' · '}
      <span
        role="button" tabIndex={0}
        style={{ textDecoration: 'underline', cursor: 'pointer' }}
        onClick={onTimelineClick}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTimelineClick() } }}
      >
        timeline
      </span>
    </div>
  )
}
