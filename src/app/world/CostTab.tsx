// WorldPanel's Cost tab (FEAT-010): a $/hr velocity headline + sparkline leads the tab, followed
// by an incident-cost readout bound to the current scrub range, a By-service attribution
// breakdown, then the pre-existing monthly total, per-region/per-AZ breakdown, and egress
// line-items from live byte rates. Reads scrubBatch ?? latestBatch (Task 15) so scrubbing
// replays cost too.
import { useMemo, useRef } from 'react'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost, attributeByBlueprint, defaultProviderFromDoc } from '../../lib/costModelV2'
import { costSeriesFor, incidentCost, createCostSeriesCache, type CostSeriesCache } from '../../lib/costSeries'
import { downsample, type SeriesPoint } from './panels/signalsSeries'
import { SignalChart } from './panels/SignalChart'
import { useCompiledWorld } from './useCompiledWorld'
import { applyEnvironment } from '../../lib/world/environments'
import type { RealProvider } from '../../lib/cloudRegistry'
import { sectionLabel, row } from './panels/panelStyles'
import type { WorldDoc } from '../../lib/world/types'

const SPARKLINE_WIDTH = 300
const SPARKLINE_HEIGHT = 36

// Task 12 (wave 5): "price this world as…" comparison row — the same compiled world/metrics,
// repriced under each real provider's registry rates via computeWorldCost's providerOverride.
// Purely a display-time reprojection (no store writes, no per-tick cost) — a service with its
// own explicit provider pin still prices at that pin regardless of which row is being shown.
const COMPARISON_PROVIDERS: RealProvider[] = ['aws', 'gcp', 'azure']
const PROVIDER_LABEL: Record<RealProvider, string> = { aws: 'AWS', gcp: 'GCP', azure: 'Azure' }

export function CostTab() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  // Deliberately NOT `useSimulationStore(s => s.getReplayFrames())`: worldEngine's real
  // getReplayFrames() returns a freshly-allocated array on every call (`[...frames]`, or a bare
  // `[]` literal before any run has started) -- referentially unstable across calls, which
  // trips React's useSyncExternalStore consistency check into "Maximum update depth exceeded"
  // the instant this component mounts with no run active (confirmed against WorldPanel.test.tsx,
  // which renders every tab -- including this one -- with no run started). SignalsPanel.tsx
  // carries the exact same subscription pattern and the exact same latent hazard; every one of
  // its tests mocks getReplayFrames before rendering for precisely this reason, so the bug has
  // stayed hidden there. Reading it as a plain (non-subscribed) call instead sidesteps the crash:
  // this component still re-renders on every new batch/scrub-index/doc change below, so a fresh
  // frames array is picked up on the next render regardless.
  const frames = useSimulationStore.getState().getReplayFrames()
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)

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
  // I3 fix (final wave-5 review): the headline "this world's own cost" figure now defaults any
  // unpinned managed service's provider to `doc.cloudProfile` (when set to something other than
  // 'generic') — previously the only reader of `cloudProfile` was the dropdown that WRITES it.
  // The three-way comparison row below deliberately does NOT read it: it explicitly reprices
  // under aws/gcp/azure regardless of the world's own profile, which is the whole point of that row.
  const cost = computeWorldCost(compiledDoc, worldForCost, batch?.managedServices ?? null, defaultProviderFromDoc(doc))
  // Computed fresh on this render (not per simulation tick) — CostTab already only re-renders on
  // the 1Hz metrics batch (or a scrub step), so this is cheap and always in sync with `cost` above.
  const providerComparison = COMPARISON_PROVIDERS.map(provider => ({
    provider,
    monthlyUsd: computeWorldCost(compiledDoc, worldForCost, batch?.managedServices ?? null, provider).monthlyUsd,
  }))

  // simMs-keyed cost memo (Task 8; re-keyed off array index in the Wave 4 final review, Critical
  // #1 -- the replay ring is a ROLLING 300-frame window, not append-only, so an array index does
  // not stably identify a frame past 5 minutes of runtime) -- a useRef so the cache survives
  // re-renders but resets whenever `doc` changes identity (a different world, New, Open, or
  // undo/redo restoring a prior snapshot reference), so a stale WorldCostResult from a PREVIOUS
  // world never leaks into the current world's sparkline/incident readout. A same-doc run
  // restart (stop -> start) is handled INSIDE costSeriesFor itself via lastMaxSimMs.
  const cacheRef = useRef<{ doc: WorldDoc; cache: CostSeriesCache }>({ doc, cache: createCostSeriesCache() })
  if (cacheRef.current.doc !== doc) cacheRef.current = { doc, cache: createCostSeriesCache() }
  const series = costSeriesFor(frames, doc, cacheRef.current.cache)

  const sparklinePoints: SeriesPoint[] = frames.map(f => ({ simMs: f.simMs, value: series.get(f.simMs)?.hourlyUsd ?? 0 }))
  const sparkline = downsample(sparklinePoints, SPARKLINE_WIDTH)

  const byService = useMemo(
    () => attributeByBlueprint(doc, compiled, worldForCost, batch?.managedServices ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, compiled, batch],
  )
  // costModelV2.ts's attributeByBlueprint doc comment: cross-zone/LB costs are left unattributed
  // to any one blueprint, so a reconciling caller should show an explicit residual line computed
  // exactly this way.
  const residualUsd = cost.monthlyUsd - byService.reduce((s, r) => s + r.monthlyUsd, 0)

  // Bound to "from the start of the replay window through the current scrub point" -- there is
  // no separate authored incident-start marker in this UI, so the whole visible history up to
  // the scrub playhead is the range being priced. incidentCost's toIdx is exclusive, so the
  // scrubbed frame itself is included via `scrubIndex + 1`.
  const incident = scrubIndex != null && frames.length > 0
    ? incidentCost(series, frames, 0, scrubIndex + 1)
    : null

  return (
    <div>
      <div style={sectionLabel}>Cost velocity</div>
      <div style={{ font: '600 18px var(--font-mono)', color: 'var(--color-price)', marginBottom: 8 }}>
        ${cost.hourlyUsd.toFixed(2)} /hr
      </div>
      {sparkline.length > 0 && (
        <SignalChart
          points={sparkline} color="var(--color-price)" width={SPARKLINE_WIDTH} height={SPARKLINE_HEIGHT}
          playheadSimMs={scrubIndex != null ? frames[scrubIndex]?.simMs ?? null : null}
          onScrub={(simMs) => {
            let idx = 0, best = Infinity
            for (let i = 0; i < frames.length; i++) {
              const d = Math.abs(frames[i].simMs - simMs)
              if (d < best) { best = d; idx = i }
            }
            setScrubIndex(idx, frames)
          }}
        />
      )}

      {incident && (
        <>
          <div style={sectionLabel}>Incident cost (scrub range)</div>
          {/* Price law is absolute: a negative delta is still money, rendered in
              var(--color-price) with a minus GLYPH (−, not a hyphen) -- never recolored into
              var(--color-success) just because "cheaper is good news." */}
          <div data-testid="incident-cost" style={{ color: 'var(--color-price)', marginBottom: 12, font: '600 13px var(--font-mono)' }}>
            {incident.incidentUsd < 0 ? '−' : ''}${Math.abs(incident.incidentUsd).toFixed(2)}
          </div>
        </>
      )}

      <div style={sectionLabel}>By service</div>
      {byService.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no services yet</div>}
      {byService.map(r => (
        <div key={r.blueprintId} style={row}>
          <span style={{ flex: 1 }}>{r.label}</span>
          <span style={{ color: 'var(--color-price)' }}>${r.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}
      {/* Wave 4 final review, Important #2: attributeByBlueprint (costModelV2.ts) documents that
          cross-zone/LB costs are NOT attributable to any one blueprint -- its own comment prescribes
          this exact residual line for a caller (like this tab) that needs the rows to reconcile with
          the monthly total. Epsilon guards against a spurious "$0.00" row in a world with no LB and
          no cross-zone/cross-region/internet traffic. */}
      {residualUsd > 0.005 && (
        <div style={row} data-testid="cost-residual">
          <span style={{ flex: 1, color: 'var(--color-text-muted)' }}>unattributed (cross-zone/LB)</span>
          <span style={{ color: 'var(--color-price)' }}>${residualUsd.toFixed(2)}</span>
        </div>
      )}

      <div style={sectionLabel}>Monthly cost</div>
      <div style={{ font: '600 16px var(--font-mono)', color: 'var(--color-price)', marginBottom: cost.loadBalancerCount > 0 ? 2 : 12 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo
      </div>
      {cost.loadBalancerCount > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          includes {cost.loadBalancerCount} load balancer{cost.loadBalancerCount === 1 ? '' : 's'} ·{' '}
          <span data-testid="lb-hours-amount" style={{ color: 'var(--color-price)' }}>${cost.loadBalancerUsd.toFixed(2)}/mo</span>
          {' '}LB-hours (in the region totals below)
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
