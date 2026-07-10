import { useState, useMemo } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { TrafficPanel } from './TrafficPanel'
import { AnalysisTab, unsuppressedCompileFindings } from './AnalysisTab'
import { useCompiledWorld } from '../useCompiledWorld'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { EventsTab } from '../EventsTab'
import { CostTab } from '../CostTab'
import { panel, smallBtn } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'analysis' | 'events' | 'cost'

export interface WorldPanelProps {
  running: boolean
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
  openSettings: () => void
}

export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId, openSettings }: WorldPanelProps) {
  const [tab, setTab] = useState<Tab>('topology')
  const compiled = useCompiledWorld()
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const analysis = useMemo(() => runAnalysis(doc, compiled, displayBatch), [compiled, displayBatch?.simMs])
  const analysisCount = analysis.length + unsuppressedCompileFindings(analysis, compiled.findings).length
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'analysis', label: `Analysis (${analysisCount})` },
    { id: 'events', label: 'Events' },
    { id: 'cost', label: 'Cost' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', border: '1px solid var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {/* Native fieldset-disabled cascades into every descendant button/input/select with zero
          changes to TopologyPanel/BlueprintPanel/PlacementPanel. Findings/Events have no form
          controls, so wrapping them here too is a harmless no-op — kept uniform on purpose. */}
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
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
