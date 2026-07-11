import { useState, useMemo, useEffect } from 'react'
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
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id}
            type="button"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', background: 'transparent',
              border: '1px solid transparent',
              borderBottom: tab === t.id ? '2px solid var(--color-accent)' : '2px solid transparent',
              color: tab === t.id ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              cursor: 'pointer', font: '11px var(--font-mono)',
            }}
            onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'analysis' && <ChipValue>{analysisCount}</ChipValue>}
          </button>
        ))}
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
