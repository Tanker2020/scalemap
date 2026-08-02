// src/app/world/region/CrossAzColumn.tsx
// Fixed-width column right of the AZ row stack (D5, mockup lines 249-253): one line per AZ
// pair sharing cross-az traffic or replication, its latency, and replication summaries.
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { crossAzEntries } from './regionData'
// FEAT-002 Task 14: impairmentFor is a pure predicate (no engine-runtime deps), safe to import
// directly rather than reimplementing its forward/backward matching by hand.
import { impairmentFor } from '../../../lib/worldEngine/faults'
import type { RegionId } from '../../../lib/world/types'

const HEADING_COLOR = 'var(--color-text-muted)'
const BODY_COLOR = 'var(--color-text-secondary)'
const LATENCY_COLOR = '#2DD4BF'
const DOWN_COLOR = 'var(--color-danger)'

export interface CrossAzColumnProps { regionId: RegionId }

export function CrossAzColumn({ regionId }: CrossAzColumnProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const partitions = useSimulationStore(s => s.partitions)
  const entries = crossAzEntries(regionId, doc, compiled, batch)

  return (
    <div style={{
      width: 130, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center',
      gap: 6, paddingLeft: 14, font: '9px var(--font-mono)',
    }}>
      <div style={{ color: HEADING_COLOR, textTransform: 'uppercase', letterSpacing: '0.06em' }}>cross-AZ</div>
      {entries.length === 0 && <div style={{ color: HEADING_COLOR }}>no cross-AZ links</div>}
      {entries.map(entry => {
        const labelA = doc.azs[entry.a]?.label ?? entry.a
        const labelB = doc.azs[entry.b]?.label ?? entry.b
        // FEAT-002 (Task 14): a partition authored against these two AZs (either direction, or
        // the observed direction only when NOT symmetric) impairs this cross-AZ link. `drop`
        // strikes it through exactly like an organic link-down; `loss` stipples it with an
        // amber-red dashed underline instead — the link is still up, just lossy.
        const impairment = impairmentFor({ azId: entry.a }, { azId: entry.b }, partitions)
        const partitioned = impairment.blocked
        const lossy = !partitioned && impairment.lossFraction > 0
        return (
          <div key={`${entry.a}::${entry.b}`} style={{ color: BODY_COLOR }}>
            <div>
              {labelA} ⇄ {labelB}{' '}
              {entry.linkDown || partitioned
                ? (
                  <span data-testid="crossaz-link-severed" style={{ color: DOWN_COLOR, textDecoration: 'line-through' }}>
                    ✕ {partitioned && !entry.linkDown ? 'partitioned' : 'link down'}
                  </span>
                )
                : lossy
                  ? (
                    <span data-testid="crossaz-link-lossy" style={{ color: DOWN_COLOR, textDecoration: 'underline dashed' }}>
                      ‡ lossy {Math.round(impairment.lossFraction * 100)}%
                    </span>
                  )
                  : <span style={{ color: LATENCY_COLOR }}>{entry.latencyMs}ms</span>}
            </div>
            {entry.replication.map(r => (
              <div key={`${r.blueprintId}:${r.fromAzId}:${r.toAzId}`}>{r.blueprintName} repl</div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
