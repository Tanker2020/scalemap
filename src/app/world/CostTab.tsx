// WorldPanel's Cost tab: monthly total, per-region/per-AZ breakdown, egress line-items from
// live byte rates. Reads scrubBatch ?? latestBatch (Task 15) so scrubbing replays cost too.
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost } from '../../lib/costModelV2'
import { applyEnvironment } from '../../lib/world/environments'
import type { RealProvider } from '../../lib/cloudRegistry'
import { sectionLabel, row } from './panels/panelStyles'

// Task 12 (wave 5): "price this world as…" comparison row — the same compiled world/metrics,
// repriced under each real provider's registry rates via computeWorldCost's providerOverride.
// Purely a display-time reprojection (no store writes, no per-tick cost) — a service with its
// own explicit provider pin still prices at that pin regardless of which row is being shown.
const COMPARISON_PROVIDERS: RealProvider[] = ['aws', 'gcp', 'azure']
const PROVIDER_LABEL: Record<RealProvider, string> = { aws: 'AWS', gcp: 'GCP', azure: 'Azure' }

export function CostTab() {
  const doc = useWorldStore(s => s.doc)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  // FEAT-008 (Task 21, controller-added gap): `runningByPlacement` lives at the MetricsBatch
  // level (Task 16), not on `batch.world` (WorldMetrics) — computeWorldCost's `world` param is
  // typed as an intersection of the two (Task 18) specifically so a caller can fold it in like
  // this. Without it, an autoscaled placement's server cost stays apportioned by its FULL
  // maxCount envelope instead of by live running-instance share, and this number never moves as
  // the fleet scales.
  const worldForCost = batch?.world ? { ...batch.world, runningByPlacement: batch.runningByPlacement } : null
  // computeWorldCost reads doc.servers/doc.placements directly (hourlyUsd, count) -- an active
  // environment's instanceClassOverrides/serverCountFactor/placementCountOverrides must be
  // overlaid here too, or the Cost tab silently shows base-world pricing while Simulate uses the
  // scaled/overridden one.
  const compiledDoc = applyEnvironment(doc)
  const cost = computeWorldCost(compiledDoc, worldForCost, batch?.managedServices ?? null)
  // Computed fresh on this render (not per simulation tick) — CostTab already only re-renders on
  // the 1Hz metrics batch (or a scrub step), so this is cheap and always in sync with `cost` above.
  const providerComparison = COMPARISON_PROVIDERS.map(provider => ({
    provider,
    monthlyUsd: computeWorldCost(compiledDoc, worldForCost, batch?.managedServices ?? null, provider).monthlyUsd,
  }))

  return (
    <div>
      <div style={sectionLabel}>Monthly cost</div>
      <div style={{ font: '600 16px var(--font-mono)', color: 'var(--color-price)', marginBottom: cost.loadBalancerCount > 0 ? 2 : 12 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo
      </div>
      {cost.loadBalancerCount > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          includes {cost.loadBalancerCount} load balancer{cost.loadBalancerCount === 1 ? '' : 's'} · ${cost.loadBalancerUsd.toFixed(2)}/mo LB-hours (in the region totals below)
        </div>
      )}

      <div style={sectionLabel}>By region</div>
      {cost.byRegion.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no regions yet</div>}
      {cost.byRegion.map(r => (
        <div key={r.regionId} style={row}>
          <span style={{ flex: 1 }}>{doc.regions[r.regionId]?.catalogId ?? r.regionId}</span>
          <span style={{ color: 'var(--color-price)' }}>${r.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>By AZ</div>
      {cost.byAz.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no AZs yet</div>}
      {cost.byAz.map(a => (
        <div key={a.azId} style={row}>
          <span style={{ flex: 1 }}>{doc.azs[a.azId]?.label ?? a.azId}</span>
          <span style={{ color: 'var(--color-price)' }}>${a.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>Egress {batch ? '' : '(simulate to populate)'}</div>
      <div style={row}><span style={{ flex: 1 }}>Cross-AZ</span><span style={{ color: 'var(--color-price)' }}>${cost.egress.crossAzUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Cross-region</span><span style={{ color: 'var(--color-price)' }}>${cost.egress.crossRegionUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Internet</span><span style={{ color: 'var(--color-price)' }}>${cost.egress.internetUsd.toFixed(2)}</span></div>

      <div style={sectionLabel}>Price this world as…</div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 8 }}>
        Only unpinned managed services reprice; server and network costs are provider-flat in this model.
      </div>
      {providerComparison.map(p => (
        <div key={p.provider} style={row}>
          <span style={{ flex: 1 }}>{PROVIDER_LABEL[p.provider]}</span>
          {/* Deliberately "$X/mo" (no space) — a distinct text node from the top total's "$X /mo"
              and the by-region/by-AZ rows' bare "$X", so this row never collides with those
              existing getByText/getAllByText queries even when every provider prices identically
              (a server-only world with no managed services, the common case). */}
          <span style={{ color: 'var(--color-price)' }}>${p.monthlyUsd.toFixed(2)}/mo</span>
        </div>
      ))}
    </div>
  )
}
