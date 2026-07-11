// Population command overlay content (Polish 2 D3). Demand slider commits on release with
// TrafficPanel's exact updatePopulation patch; drag only moves a local draft (the
// DerivedField commitSlider discipline, kit.tsx:251-256, transcribed — the overlay needs
// step=50, which DerivedField does not expose).
import { useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { useUiStore } from '../../../store/ui.store'
import { useCompiledWorld } from '../../useCompiledWorld'
import type { PopulationId } from '../../../../lib/world/types'
import { SceneOverlay, ovlActPrimary, ovlActDanger } from '../SceneOverlay'
import { populationLanding } from '../derived'

export function PopulationOverlay({ populationId, onClose }: { populationId: PopulationId; onClose: () => void }): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const updatePopulation = useWorldStore(s => s.updatePopulation)
  const removePopulation = useWorldStore(s => s.removePopulation)
  const setPendingPanelTab = useUiStore(s => s.setPendingPanelTab)
  const compiled = useCompiledWorld()

  const pop = doc.populations[populationId]
  const [draft, setDraft] = useState(pop?.peakRps ?? 0)
  const interacted = useRef(false)
  if (!pop) return null

  const commit = () => {
    if (!interacted.current) return
    interacted.current = false
    if (draft !== pop.peakRps) updatePopulation(populationId, { peakRps: draft })
  }

  const landing = populationLanding(pop, doc, compiled)
  const hint = landing
    ? `→ lands on ${landing.regionCatalogId} · ${landing.latencyMs} ms away`
    : `routed by ${doc.routing.policy}`

  return (
    <SceneOverlay title={pop.label} subtitle="client population" dotColor="var(--kit-teal)" onClose={onClose}
      footer={
        <>
          <button type="button" className="kit-press" style={ovlActPrimary}
            onClick={() => { setPendingPanelTab('traffic'); onClose() }}>
            traffic panel →
          </button>
          <button type="button" className="kit-press" style={ovlActDanger}
            onClick={() => { removePopulation(populationId); onClose() }}>
            remove
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 13px 2px', fontSize: 11 }}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 10, width: 64, flexShrink: 0 }}>demand</span>
        <input
          type="range" aria-label="demand" min={50} max={5000} step={50} value={draft}
          style={{ flex: 1, accentColor: 'var(--kit-teal)', height: 3 }}
          onChange={e => { interacted.current = true; setDraft(Number(e.target.value)) }}
          onMouseUp={commit} onTouchEnd={commit} onKeyUp={commit} onBlur={commit}
        />
        <span style={{ width: 70, textAlign: 'right', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
          {draft} rps
        </span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--kit-teal)', padding: '4px 13px 4px 85px' }}>{hint}</div>
    </SceneOverlay>
  )
}
