// src/app/world/region/RegionLbCard.tsx
// Region flow page (Phase 3): a compact, read-only view of the regional load balancer that sits
// conceptually between the DNS-outcome "who's sending" column and the region→AZ ingress beams —
// visualizing the L7 listener rules → services and the cross-zone fan-out setting. Reads the
// COMPILED lb routing (compiled.routing.lbRouting), so it reflects the synthesized default LB too,
// never the raw doc. Full authoring stays in the dock's RegionConfigTab; this is the at-a-glance
// flow-page instrument. Token-only styling (var(--color-*)) so it is theme-correct in both modes.
import type { ReactElement, CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import type { RegionId } from '../../../lib/world/types'

export interface RegionLbCardProps { regionId: RegionId }

export function RegionLbCard({ regionId }: RegionLbCardProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const lb = compiled.routing.lbRouting[regionId]
  if (!lb) return null

  const name = (bpId: string): string => doc.blueprints[bpId]?.name ?? bpId
  const isL7 = lb.mode === 'l7'
  const defaultLabel = lb.defaultTargetBlueprintIds.length > 0
    ? lb.defaultTargetBlueprintIds.map(name).join(', ')
    : '(none — dropped)'

  const service: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-primary)' }

  return (
    <div
      data-testid="region-lb-card"
      style={{
        width: 152, flexShrink: 0, alignSelf: 'center',
        border: '1px solid var(--color-node-border)', borderRadius: 8,
        background: 'var(--color-node-base)', padding: '9px 10px', margin: '0 6px',
        font: '9px var(--font-mono)', color: 'var(--color-text-secondary)',
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: '0.1em', color: 'var(--color-text-muted)', marginBottom: 6 }}>▸ REGIONAL LB</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: 'var(--color-accent)' }}>{isL7 ? 'ALB · L7' : 'NLB · L4'}</span>
        <span style={{
          fontSize: 8, padding: '1px 5px', borderRadius: 4, border: '1px solid var(--color-node-border)',
          color: lb.crossZone ? 'var(--color-success)' : 'var(--color-text-muted)',
        }}>
          cross-zone {lb.crossZone ? 'on' : 'off'}
        </span>
      </div>

      {isL7 ? (
        <div style={{ display: 'grid', gap: 3 }}>
          {lb.rules.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no listener rules</div>}
          {lb.rules.map((r, i) => (
            <div key={i} data-testid="lb-rule" style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0 }}>
              <span style={{ color: 'var(--color-accent)', flexShrink: 0 }}>{r.pathPattern}</span>
              <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>→</span>
              <span style={service}>{name(r.targetBlueprintId)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 4, marginTop: 2, borderTop: '1px dashed var(--color-toolbar-border)', paddingTop: 3 }}>
            <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>default →</span>
            <span style={service}>{defaultLabel}</span>
          </div>
        </div>
      ) : (
        <div style={{ color: 'var(--color-text-muted)' }}>
          all traffic → <span style={service}>{defaultLabel}</span>
        </div>
      )}

      <div style={{ fontSize: 8, color: 'var(--color-text-muted)', marginTop: 6 }}>
        {lb.crossZone ? 'spreads ingress across every AZ' : 'each AZ serves its own share'}
      </div>
    </div>
  )
}
