import { useState, useMemo, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { TrafficPanel } from './TrafficPanel'
import { AnalysisTab, unsuppressedCompileFindings } from './AnalysisTab'
import { useCompiledWorld } from '../useCompiledWorld'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useUiStore, type PanelTab } from '../../store/ui.store'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { EventsTab } from '../EventsTab'
import { CostTab } from '../CostTab'
import { panel } from './panelStyles'
import { ChipValue } from '../ui/kit'
import { useRollingNumber } from '../ui/motion'
import { computeWorldCost, HOURS_PER_MONTH } from '../../../lib/costModelV2'

export interface WorldPanelProps {
  running: boolean
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
  openSettings: () => void
}

export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId, openSettings }: WorldPanelProps) {
  const [tab, setTab] = useState<PanelTab>(() => useUiStore.getState().pendingPanelTab ?? 'topology')
  const pendingPanelTab = useUiStore(s => s.pendingPanelTab)
  useEffect(() => {
    // One-shot consume, now reactive (Polish 2 D4): the vault path still lands via the
    // mount-time initializer above (this effect's first run just re-selects the same tab and
    // clears the field — the previous mount-only effect's behavior, subsumed); a
    // pendingPanelTab set while the panel is ALREADY mounted (scene overlay "traffic panel →")
    // now switches the tab too. Clear via getState() so the write doesn't re-fire the effect.
    if (pendingPanelTab) {
      setTab(pendingPanelTab)
      useUiStore.getState().setPendingPanelTab(null)
    }
  }, [pendingPanelTab])
  const compiled = useCompiledWorld()
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const analysis = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const analysisCount = analysis.length + unsuppressedCompileFindings(analysis, compiled.findings).length
  const tabs: { id: PanelTab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'analysis', label: 'Analysis' },
    { id: 'events', label: 'Events' },
    { id: 'cost', label: 'Cost' },
  ]

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const barRef = useRef<HTMLDivElement>(null)
  const [ink, setInk] = useState<{ left: number; width: number; top: number }>({ left: 0, width: 0, top: 0 })

  const placeInk = (id: PanelTab) => {
    const el = tabRefs.current[id]
    // top is tracked per-tab because the bar WRAPS (flexWrap, 7 tabs in a 360px dock) — a
    // bottom-anchored ink would underline the container's last row for every tab. With an
    // explicit height + top, the .kit-ink CSS `bottom: 0` is overconstrained-ignored.
    if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop + el.offsetHeight - 2 })
  }
  useLayoutEffect(() => { placeInk(tab) }, [tab])

  return (
    <aside style={panel}>
      <WorldSummary />
      <div ref={barRef} onMouseLeave={() => placeInk(tab)}
        style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap', position: 'relative' }}>
        {tabs.map(t => (
          <button key={t.id}
            ref={el => { tabRefs.current[t.id] = el }}
            type="button"
            onMouseEnter={() => placeInk(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', background: 'transparent',
              border: '1px solid transparent',
              color: tab === t.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              cursor: 'pointer', font: '11px var(--font-mono)',
            }}
            onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'analysis' && <ChipValue>{analysisCount}</ChipValue>}
          </button>
        ))}
        <span className="kit-ink" aria-hidden style={{ left: ink.left, width: ink.width, top: ink.top }} />
      </div>
      {/* Native fieldset-disabled cascades into every descendant button/input/select with zero
          changes to TopologyPanel/BlueprintPanel/PlacementPanel. Findings/Events have no form
          controls, so wrapping them here too is a harmless no-op — kept uniform on purpose. */}
      {/* minInlineSize 0: a fieldset defaults to min-inline-size:min-content and refuses to
          shrink to the dock's width, pushing rows past the viewport edge. */}
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
        {tab === 'topology' && <TopologyPanel />}
        {tab === 'blueprints' && <BlueprintPanel />}
        {tab === 'placements' && <PlacementPanel />}
        {tab === 'traffic' && (
          <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} />
        )}
        {tab === 'analysis' && <AnalysisTab openSettings={openSettings} />}
        {tab === 'events' && <EventsTab />}
        {tab === 'cost' && <CostTab />}
      </fieldset>
    </aside>
  )
}

// World summary strip (Polish 2 D5): a read surface above the tab bar, OUTSIDE the
// fieldset — it must not gray out while the sim is running. At rest (no metrics batch yet)
// it shows the authored doc's counts; once metrics are flowing it becomes the live sentence
// (rolling rps, health dot, $/hr, p50).
function WorldSummary() {
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const rolledRps = useRollingNumber(displayBatch?.world.totalRps ?? 0)

  const regionCount = Object.keys(doc.regions).length
  const serverCount = Object.keys(doc.servers).length
  const cityCount = Object.keys(doc.populations).length

  const box: CSSProperties = {
    border: '1px solid var(--color-node-border)', borderRadius: 7, padding: '11px 13px',
    background: 'linear-gradient(180deg, var(--color-surface-hover), var(--color-node-base))',
    marginBottom: 8,
  }

  if (!displayBatch) {
    return (
      <div style={box} data-testid="world-summary">
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {regionCount} region{regionCount === 1 ? '' : 's'} · {serverCount} server{serverCount === 1 ? '' : 's'} · baseline {doc.traffic.baselineTotalRps.toLocaleString('en-US')} rps
        </div>
      </div>
    )
  }

  const regions = Object.values(displayBatch.regions)
  const downCount = regions.filter(r => r.health === 'down').length
  const degradedCount = regions.filter(r => r.health === 'degraded').length
  // The dot glyph moved out of this string into its own .kit-ripple span (Polish 2 T7) — a
  // ripple radiating from an inline text run spanning "N regions down" would paint an oval
  // over the words, not a dot; the dot needs its own small, roughly-square box.
  const healthLabel = downCount > 0
    ? `${downCount} region${downCount === 1 ? '' : 's'} down`
    : degradedCount > 0
      ? `${degradedCount} region${degradedCount === 1 ? '' : 's'} degraded`
      : 'all healthy'
  const healthColor = downCount > 0 ? 'var(--color-danger)' : degradedCount > 0 ? 'var(--color-warning)' : 'var(--color-success)'
  // Decision 9: WorldMetrics exposes no latency — rps-weighted mean of region p50Ms.
  const totalRps = regions.reduce((s, r) => s + r.rps, 0)
  const p50 = totalRps > 0 ? regions.reduce((s, r) => s + r.p50Ms * r.rps, 0) / totalRps : 0
  const hourlyUsd = computeWorldCost(doc, displayBatch.world).monthlyUsd / HOURS_PER_MONTH

  return (
    <div style={box} data-testid="world-summary">
      <div style={{ fontSize: 12.5 }}>
        Handling <b style={{ color: 'var(--kit-accent)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{Math.round(rolledRps).toLocaleString('en-US')} rps</b>
        {' '}from {cityCount} {cityCount === 1 ? 'city' : 'cities'} across {regionCount} region{regionCount === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: healthColor }}>
          <span className={displayBatch ? 'kit-ripple' : undefined} style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
          {healthLabel}
        </span>
        <span style={{ color: 'var(--color-price)' }}>${hourlyUsd.toFixed(2)}/hr</span>
        <span>p50 {Math.round(p50)} ms</span>
      </div>
    </div>
  )
}
