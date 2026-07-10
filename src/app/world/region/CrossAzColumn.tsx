// src/app/world/region/CrossAzColumn.tsx
// Fixed-width column right of the AZ row stack (D5, mockup lines 249-253): one line per AZ
// pair sharing cross-az traffic or replication, its latency, and replication summaries.
import type { ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { crossAzEntries } from './regionData'
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
        return (
          <div key={`${entry.a}::${entry.b}`} style={{ color: BODY_COLOR }}>
            <div>
              {labelA} ⇄ {labelB}{' '}
              {entry.linkDown
                ? <span style={{ color: DOWN_COLOR }}>✕ link down</span>
                : <span style={{ color: LATENCY_COLOR }}>{entry.latencyMs}ms</span>}
            </div>
            {entry.replication.map(r => <div key={r.blueprintId}>{r.blueprintName} repl</div>)}
          </div>
        )
      })}
    </div>
  )
}
