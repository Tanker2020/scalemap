// WorldPanel's Cost tab (FEAT-010): a $/hr velocity headline + sparkline leads the tab, followed
// by an incident-cost readout bound to the current scrub range, a By-service attribution
// breakdown, then the pre-existing monthly total, per-region/per-AZ breakdown, and egress
// line-items from live byte rates. Reads scrubBatch ?? latestBatch (Task 15) so scrubbing
// replays cost too.
import { useMemo, useRef } from 'react'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost, attributeByBlueprint } from '../../lib/costModelV2'
import { costSeriesFor, incidentCost } from '../../lib/costSeries'
import { downsample, type SeriesPoint } from './panels/signalsSeries'
import { SignalChart } from './panels/SignalChart'
import { useCompiledWorld } from './useCompiledWorld'
import { sectionLabel, row } from './panels/panelStyles'
import type { WorldDoc } from '../../lib/world/types'

const SPARKLINE_WIDTH = 300
const SPARKLINE_HEIGHT = 36

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
  const cost = computeWorldCost(doc, worldForCost, batch?.managedServices ?? null)

  // Frame-indexed cost memo (Task 8) -- a useRef so the cache survives re-renders but resets
  // whenever `doc` changes identity (a different world, New, Open, or undo/redo restoring a
  // prior snapshot reference), so a stale WorldCostResult from a PREVIOUS world's frame index
  // never leaks into the current world's sparkline/incident readout.
  const cacheRef = useRef<{ doc: WorldDoc; cache: ReturnType<typeof costSeriesFor> }>({ doc, cache: new Map() })
  if (cacheRef.current.doc !== doc) cacheRef.current = { doc, cache: new Map() }
  const series = costSeriesFor(frames, doc, cacheRef.current.cache)

  const sparklinePoints: SeriesPoint[] = frames.map((f, i) => ({ simMs: f.simMs, value: series.get(i)?.hourlyUsd ?? 0 }))
  const sparkline = downsample(sparklinePoints, SPARKLINE_WIDTH)

  const byService = useMemo(
    () => attributeByBlueprint(doc, compiled, worldForCost, batch?.managedServices ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, compiled, batch],
  )

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
    </div>
  )
}
