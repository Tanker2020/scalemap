// src/app/world/panels/TrafficPanel.tsx
// Traffic-authoring tab (Phase 5 D8): populations (incl. globe placement), auto-baseline
// traffic, and routing policy — all three sections write through EXISTING world.store actions
// only (addPopulation/updatePopulation/removePopulation/updateRouting/updateTraffic — Phase 5
// adds no new store actions). Mounted inside WorldPanel's `<fieldset disabled={running}>`
// (WorldPanel.tsx) — this component does NOT duplicate that running-gate itself.
//
// Polish 2 T5 reshape: hero → populations (sentence rows) → routing. The traffic hero
// (`TrafficHero`) absorbs the old `TrafficSection`'s baselineTotalRps slider role — that
// section is dissolved into it — and embeds the routing-policy Segmented from RoutingSection
// (RoutingSection keeps its own SectionHeader/Explainer/weighted-priority editors/ttl fields).
// Population rows became sentence rows (collapsed summary, click to expand into the existing
// tuning fields) instead of always-open EdgeRows; every store dispatch is unchanged.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
import { nextPopulationLabel } from '../../../lib/world/populationLabel'
import { field, smallBtn, dangerBtn, row } from './panelStyles'
import { SectionHeader, DerivedField, Segmented, Explainer } from '../ui/kit'
import { ttlLagHint, populationLanding, frontlineCapacityRps, isEntryBlueprint } from '../ui/derived'
import { useCompiledWorld } from '../useCompiledWorld'

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
      <TrafficHero />
      <PopulationsSection selectedPopulationId={selectedPopulationId} placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} />
      <RoutingSection />
    </div>
  )
}

// The headline control (Polish 2 T5): a sentence-slider over baselineTotalRps with the
// routing-policy Segmented embedded mid-sentence, a frontline-capacity hint, and the
// autoBaseline checkbox + exact-value NumberField folded in below (same field, same dispatch
// — updateTraffic({ baselineTotalRps })  — as the pre-Polish-2 TrafficSection).
function TrafficHero() {
  const doc = useWorldStore(s => s.doc)
  const updateTraffic = useWorldStore(s => s.updateTraffic)
  const updateRouting = useWorldStore(s => s.updateRouting)
  const compiled = useCompiledWorld()
  const [draft, setDraft] = useState(doc.traffic.baselineTotalRps)
  const interacted = useRef(false)
  const [exactOpen, setExactOpen] = useState(false)
  useEffect(() => { setDraft(doc.traffic.baselineTotalRps); interacted.current = false }, [doc.traffic.baselineTotalRps])

  const commit = () => {
    if (!interacted.current) return
    interacted.current = false
    if (draft !== doc.traffic.baselineTotalRps) updateTraffic({ baselineTotalRps: draft })
  }

  const capacity = frontlineCapacityRps(doc, compiled)
  const entryPlacements = Object.values(doc.placements)
    .filter(pl => { const bp = doc.blueprints[pl.blueprintId]; return bp != null && isEntryBlueprint(bp) }).length
  const ratio = capacity > 0 ? draft / capacity : 0
  const cpuPct = Math.round(ratio * 100)
  const perReplica = entryPlacements > 0 ? Math.round(draft / entryPlacements) : 0
  const hint = capacity <= 0 ? null
    : ratio >= 1 ? { text: `≈ ${perReplica} rps per frontline replica — ✗ will shed load (est. ${cpuPct}% cpu). Add replicas or bigger presets.`, tone: 'var(--color-danger)' }
    : ratio >= 0.7 ? { text: `≈ ${perReplica} rps per frontline replica — tight (est. ${cpuPct}% cpu)`, tone: 'var(--color-warning)' }
    : { text: `≈ ${perReplica} rps per frontline replica — comfortable (est. ${cpuPct}% cpu)`, tone: 'var(--kit-teal)' }

  return (
    <div>
      <SectionHeader label="▸ INCOMING TRAFFIC" />
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 2.15 }}>
        Send <b style={{ color: 'var(--color-text-primary)', fontVariantNumeric: 'tabular-nums' }}>{draft.toLocaleString('en-US')}</b> requests/sec,
        routed to the
      </div>
      <Segmented<RoutingPolicyKind>
        ariaLabel="routing-policy"
        value={doc.routing.policy}
        onChange={v => updateRouting({ policy: v })}
        options={[
          { value: 'latency', label: 'latency' },
          { value: 'geo', label: 'geo' },
          { value: 'weighted', label: 'weighted' },
          { value: 'priority', label: 'priority' },
        ]}
      />
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginLeft: 6 }}>region.</span>
      <div style={{ margin: '10px 0 2px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }}>
          <span>quiet day</span><span>launch day</span>
        </div>
        <input
          type="range" aria-label="hero-baseline-rps" min={100} max={20000} step={100} value={draft}
          style={{ width: '100%', accentColor: 'var(--color-accent)' }}
          onChange={e => { interacted.current = true; setDraft(Number(e.target.value)) }}
          onMouseUp={commit} onTouchEnd={commit} onKeyUp={commit} onBlur={commit}
        />
        {hint && <div style={{ fontSize: 10.5, marginTop: 5, color: hint.tone }}>{hint.text}</div>}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0 4px' }}>
        <input type="checkbox" aria-label="autoBaseline" checked={doc.traffic.autoBaseline}
          onChange={e => updateTraffic({ autoBaseline: e.target.checked })} />
        <span>auto-baseline traffic</span>
      </label>
      <button type="button" className="kit-press" style={{ ...smallBtn }} aria-expanded={exactOpen}
        onClick={() => setExactOpen(o => !o)}>
        {exactOpen ? '▾' : '▸'} exact value
      </button>
      {exactOpen && (
        <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 4 }}>
          <span>baselineTotalRps</span>
          <NumberField label="baselineTotalRps" value={doc.traffic.baselineTotalRps} min={0} max={Infinity}
            onCommit={n => updateTraffic({ baselineTotalRps: n })} />
        </label>
      )}
    </div>
  )
}

function PopulationsSection({ selectedPopulationId, placeMode, onTogglePlaceMode }: {
  selectedPopulationId: string | null; placeMode: boolean; onTogglePlaceMode: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const addPopulation = useWorldStore(s => s.addPopulation)
  const updatePopulation = useWorldStore(s => s.updatePopulation)
  const removePopulation = useWorldStore(s => s.removePopulation)
  const populations = Object.values(doc.populations)
  const labelRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  const [draftLabel, setDraftLabel] = useState('')
  const [draftLat, setDraftLat] = useState(40.7)
  const [draftLon, setDraftLon] = useState(-74)
  const [draftRps, setDraftRps] = useState(100)
  const [draftDiurnal, setDraftDiurnal] = useState<DiurnalPattern>('flat')

  // Auto-focus the row for a population just placed via the globe (GlobeView's onPlace selects
  // it) or otherwise externally selected — re-runs whenever the selection changes. The row
  // itself auto-expands for the same id (decision 15, see `open` below), so the label input is
  // already mounted by the time this effect runs.
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
      <SectionHeader label="▸ POPULATIONS" />
      {populations.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no populations yet</div>}
      {populations.map(pop => {
        const landing = populationLanding(pop, doc, compiled)
        const open = expanded === pop.id || pop.id === selectedPopulationId   // decision 15
        return (
          <div key={pop.id} className="kit-row kit-t"
            style={{ borderLeft: '2px solid var(--kit-teal)', background: 'var(--color-node-base)', borderRadius: 5, padding: '8px 11px', marginBottom: 6, cursor: 'pointer' }}
            onClick={() => setExpanded(e => (e === pop.id ? null : pop.id))}>
            <div style={{ fontSize: 11.5 }}>
              <b style={{ color: 'var(--color-text-primary)' }}>{pop.label}</b> sends{' '}
              <em style={{ color: 'var(--kit-teal)', fontStyle: 'normal' }}>{pop.peakRps} rps</em>
              {landing ? <> → lands on {landing.regionCatalogId}</> : <> · routed by {doc.routing.policy}</>}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {landing ? `${landing.latencyMs} ms away · ` : ''}routed by {doc.routing.policy} · click to tune
            </div>
            {open && (
              <div style={{ borderTop: '1px dashed var(--color-toolbar-border)', marginTop: 8, paddingTop: 8 }}
                onClick={e => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--kit-teal)', flexShrink: 0 }} />
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
                  <button className="kit-press" style={dangerBtn} aria-label={`remove-${pop.id}`} onClick={() => removePopulation(pop.id)}>✕</button>
                </div>
              </div>
            )}
          </div>
        )
      })}

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
        <button className="kit-press" style={smallBtn} onClick={addDraft}>+ add</button>
        <button
          className="kit-press"
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

const POLICY_EXPLAINER: Record<RoutingPolicyKind, string> = {
  latency: 'each population is served by its fastest healthy region; failover honors the DNS TTL',
  geo: 'each population is pinned to its nearest region by great-circle distance',
  weighted: 'traffic splits by the region weights below — heavier weight, more traffic',
  priority: 'all traffic goes to the highest-priority healthy region in the order below',
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
      <SectionHeader label="▸ ROUTING" />
      <Explainer>{POLICY_EXPLAINER[policy]}</Explainer>

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
            <button className="kit-press" style={smallBtn} aria-label={`move ${label} up`} disabled={i === 0} onClick={() => move(regionId, -1)}>↑</button>
            <button className="kit-press" style={smallBtn} aria-label={`move ${label} down`} disabled={i === priorityOrder.length - 1} onClick={() => move(regionId, 1)}>↓</button>
          </div>
        )
      })}

      <div style={{ marginTop: 6 }}>
        <DerivedField
          label="dnsTtlSec"
          value={dnsTtlSec}
          min={1}
          deriveTone="warning"
          derive={v => ttlLagHint({ ...doc.routing, dnsTtlSec: v }) ?? ''}
          onCommit={n => updateRouting({ dnsTtlSec: n })}
        />
      </div>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 6 }}>
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
