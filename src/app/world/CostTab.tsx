// WorldPanel's Cost tab: monthly total, per-region/per-AZ breakdown, egress line-items from
// live byte rates. Reads scrubBatch ?? latestBatch (Task 15) so scrubbing replays cost too.
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost } from '../../lib/costModelV2'
import { sectionLabel, row } from './panels/panelStyles'

export function CostTab() {
  const doc = useWorldStore(s => s.doc)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const cost = computeWorldCost(doc, batch?.world ?? null)

  return (
    <div>
      <div style={sectionLabel}>Monthly cost</div>
      <div style={{ font: '600 16px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 12 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo
      </div>

      <div style={sectionLabel}>By region</div>
      {cost.byRegion.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no regions yet</div>}
      {cost.byRegion.map(r => (
        <div key={r.regionId} style={row}>
          <span style={{ flex: 1 }}>{doc.regions[r.regionId]?.catalogId ?? r.regionId}</span>
          <span>${r.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>By AZ</div>
      {cost.byAz.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no AZs yet</div>}
      {cost.byAz.map(a => (
        <div key={a.azId} style={row}>
          <span style={{ flex: 1 }}>{doc.azs[a.azId]?.label ?? a.azId}</span>
          <span>${a.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>Egress {batch ? '' : '(simulate to populate)'}</div>
      <div style={row}><span style={{ flex: 1 }}>Cross-AZ</span><span>${cost.egress.crossAzUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Cross-region</span><span>${cost.egress.crossRegionUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Internet</span><span>${cost.egress.internetUsd.toFixed(2)}</span></div>
    </div>
  )
}
