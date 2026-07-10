// src/app/world/panels/TrafficPanel.tsx
// Traffic-authoring tab (Phase 5 D8): populations (incl. globe placement), auto-baseline
// traffic, and routing policy — all three sections write through EXISTING world.store actions
// only (addPopulation/updatePopulation/removePopulation/updateRouting/updateTraffic — Phase 5
// adds no new store actions). Mounted inside WorldPanel's `<fieldset disabled={running}>`
// (WorldPanel.tsx) — this component does NOT duplicate that running-gate itself.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
import { nextPopulationLabel } from '../../../lib/world/populationLabel'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

export interface TrafficPanelProps {
  placeMode: boolean
  onTogglePlaceMode: () => void
  selectedPopulationId: string | null
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

// Same "Number.isFinite, clamp, keep last valid" convention as
// src/app/world/server/inspectorForms.tsx's NumberField (local text buffer, commits on
// blur/Enter, reverts on non-numeric input) — generalized with explicit min/max bounds, since
// that file's version only ever floor-clamps to `>=0` and lat/lon here need a symmetric range.
// On a successful commit the buffer is also reset to the CLAMPED value, so an out-of-range
// entry (e.g. lat 999) visibly snaps to the clamped figure (90) rather than leaving "999"
// displayed while the store silently holds 90.
function NumberField({ label, value, min, max, onCommit }: {
  label: string; value: number; min: number; max: number; onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  return (
    <input
      aria-label={label} style={{ ...field, width: 56, marginBottom: 0 }} value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text)
        if (Number.isFinite(n)) { const c = clamp(n, min, max); onCommit(c); setText(String(c)) }
        else setText(String(value))
      }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

const armedBtn = { border: '1px solid var(--color-accent)', color: 'var(--color-accent)' } as const

export function TrafficPanel({ placeMode, onTogglePlaceMode, selectedPopulationId }: TrafficPanelProps): ReactElement {
  return (
    <div>
      <PopulationsSection selectedPopulationId={selectedPopulationId} placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} />
      <TrafficSection />
      <RoutingSection />
    </div>
  )
}

function PopulationsSection({ selectedPopulationId, placeMode, onTogglePlaceMode }: {
  selectedPopulationId: string | null; placeMode: boolean; onTogglePlaceMode: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  const addPopulation = useWorldStore(s => s.addPopulation)
  const updatePopulation = useWorldStore(s => s.updatePopulation)
  const removePopulation = useWorldStore(s => s.removePopulation)
  const populations = Object.values(doc.populations)
  const labelRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const [draftLabel, setDraftLabel] = useState('')
  const [draftLat, setDraftLat] = useState(40.7)
  const [draftLon, setDraftLon] = useState(-74)
  const [draftRps, setDraftRps] = useState(100)
  const [draftDiurnal, setDraftDiurnal] = useState<DiurnalPattern>('flat')

  // Auto-focus the row for a population just placed via the globe (GlobeView's onPlace selects
  // it) or otherwise externally selected — re-runs whenever the selection changes.
  useEffect(() => {
    if (selectedPopulationId) labelRefs.current[selectedPopulationId]?.focus()
  }, [selectedPopulationId])

  const addDraft = () => {
    // Phase 6 T9 carry-forward: shared max-suffix scan (src/lib/world/populationLabel.ts)
    // instead of `pop-${populations.length + 1}` — a length-based counter reissues a stale
    // label after a remove+re-add (Phase-5 backlog item); GlobeView.tsx's place-on-globe
    // handler uses the same helper so neither authoring surface can collide with the other.
    const label = draftLabel.trim() || nextPopulationLabel(doc.populations)
    // addPopulation's factory hardcodes peakRps:500/diurnal:'flat' (src/lib/world/factories.ts)
    // — it has no param for either, so the draft rps/diurnal only reach the store via this
    // follow-up patch.
    const id = addPopulation(label, draftLat, draftLon)
    updatePopulation(id, { peakRps: draftRps, diurnal: draftDiurnal })
    setDraftLabel('')
  }

  return (
    <div>
      <div style={sectionLabel}>Populations</div>
      {populations.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no populations yet</div>}
      {populations.map(pop => (
        <div key={pop.id} style={row}>
          <input
            ref={el => { labelRefs.current[pop.id] = el }}
            style={{ ...field, width: 64, marginBottom: 0 }} aria-label={`label-${pop.id}`}
            value={pop.label} onChange={e => updatePopulation(pop.id, { label: e.target.value })}
          />
          <NumberField label={`lat-${pop.id}`} value={pop.lat} min={-90} max={90}
            onCommit={n => updatePopulation(pop.id, { lat: n })} />
          <NumberField label={`lon-${pop.id}`} value={pop.lon} min={-180} max={180}
            onCommit={n => updatePopulation(pop.id, { lon: n })} />
          <NumberField label={`rps-${pop.id}`} value={pop.peakRps} min={0} max={Infinity}
            onCommit={n => updatePopulation(pop.id, { peakRps: n })} />
          <select aria-label={`diurnal-${pop.id}`} style={{ ...field, width: 68, marginBottom: 0 }}
            value={pop.diurnal} onChange={e => updatePopulation(pop.id, { diurnal: e.target.value as DiurnalPattern })}>
            <option value="flat">flat</option>
            <option value="day-night">day-night</option>
          </select>
          <button style={dangerBtn} aria-label={`remove-${pop.id}`} onClick={() => removePopulation(pop.id)}>✕</button>
        </div>
      ))}

      <div style={row}>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} placeholder="label" aria-label="new-population-label"
          value={draftLabel} onChange={e => setDraftLabel(e.target.value)} />
        <NumberField label="new-lat" value={draftLat} min={-90} max={90} onCommit={setDraftLat} />
        <NumberField label="new-lon" value={draftLon} min={-180} max={180} onCommit={setDraftLon} />
        <NumberField label="new-rps" value={draftRps} min={0} max={Infinity} onCommit={setDraftRps} />
        <select aria-label="new-diurnal" style={{ ...field, width: 68, marginBottom: 0 }} value={draftDiurnal}
          onChange={e => setDraftDiurnal(e.target.value as DiurnalPattern)}>
          <option value="flat">flat</option>
          <option value="day-night">day-night</option>
        </select>
      </div>
      <div style={row}>
        <button style={smallBtn} onClick={addDraft}>+ add</button>
        <button
          style={{ ...smallBtn, ...(placeMode ? armedBtn : {}) }}
          aria-pressed={placeMode}
          onClick={onTogglePlaceMode}
        >
          + place on globe
        </button>
      </div>
    </div>
  )
}

function TrafficSection() {
  const doc = useWorldStore(s => s.doc)
  const updateTraffic = useWorldStore(s => s.updateTraffic)
  return (
    <div>
      <div style={sectionLabel}>Traffic</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <input type="checkbox" aria-label="autoBaseline" checked={doc.traffic.autoBaseline}
          onChange={e => updateTraffic({ autoBaseline: e.target.checked })} />
        <span>auto-baseline traffic</span>
      </label>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>baselineTotalRps</span>
        <NumberField label="baselineTotalRps" value={doc.traffic.baselineTotalRps} min={0} max={Infinity}
          onCommit={n => updateTraffic({ baselineTotalRps: n })} />
      </label>
    </div>
  )
}

function RoutingSection() {
  const doc = useWorldStore(s => s.doc)
  const updateRouting = useWorldStore(s => s.updateRouting)
  const regions = Object.values(doc.regions)
  const { policy, weights, priorityOrder, dnsTtlSec, healthCheckIntervalMs, healthCheckFailureThreshold } = doc.routing

  const move = (regionId: RegionId, dir: -1 | 1) => {
    const i = priorityOrder.indexOf(regionId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= priorityOrder.length) return
    const next = [...priorityOrder]
    ;[next[i], next[j]] = [next[j], next[i]]
    updateRouting({ priorityOrder: next })
  }

  return (
    <div>
      <div style={sectionLabel}>Routing</div>
      <select aria-label="routing-policy" style={{ ...field, marginBottom: 6 }} value={policy}
        onChange={e => updateRouting({ policy: e.target.value as RoutingPolicyKind })}>
        <option value="latency">latency</option>
        <option value="geo">geo</option>
        <option value="weighted">weighted</option>
        <option value="priority">priority</option>
      </select>

      {policy === 'weighted' && regions.map(region => (
        <div key={region.id} style={row}>
          <span style={{ flex: 1 }}>{region.catalogId}</span>
          <NumberField label={`weight-${region.id}`} value={weights[region.id] ?? 0} min={0} max={Infinity}
            onCommit={n => updateRouting({ weights: { ...weights, [region.id]: n } })} />
        </div>
      ))}

      {policy === 'priority' && priorityOrder.map((regionId, i) => {
        const label = doc.regions[regionId]?.catalogId ?? regionId
        return (
          <div key={regionId} style={row}>
            <span style={{ flex: 1 }}>{i + 1}. {label}</span>
            <button style={smallBtn} aria-label={`move ${label} up`} disabled={i === 0} onClick={() => move(regionId, -1)}>↑</button>
            <button style={smallBtn} aria-label={`move ${label} down`} disabled={i === priorityOrder.length - 1} onClick={() => move(regionId, 1)}>↓</button>
          </div>
        )
      })}

      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 6 }}>
        <span>dnsTtlSec</span>
        <NumberField label="dnsTtlSec" value={dnsTtlSec} min={1} max={Infinity}
          onCommit={n => updateRouting({ dnsTtlSec: n })} />
      </label>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>healthCheckIntervalMs</span>
        <NumberField label="healthCheckIntervalMs" value={healthCheckIntervalMs} min={1} max={Infinity}
          onCommit={n => updateRouting({ healthCheckIntervalMs: n })} />
      </label>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span>healthCheckFailureThreshold</span>
        <NumberField label="healthCheckFailureThreshold" value={healthCheckFailureThreshold} min={1} max={Infinity}
          onCommit={n => updateRouting({ healthCheckFailureThreshold: n })} />
      </label>
    </div>
  )
}
