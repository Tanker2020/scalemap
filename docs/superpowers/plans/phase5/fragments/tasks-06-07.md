# Phase 5 plan fragment — Tasks 6–7 (traffic authoring tab + place-on-globe · integration,
# fps probe, §N, region/rack carry-forwards)

> Fragment scope: Task 6 (`TrafficPanel.tsx` — populations/traffic/routing authoring, wired to
> globe place-mode) and Task 7 (final integration: fps probe, `docs/module-boundaries.md` §N,
> the five D10 carry-forward fixes). Global Constraints / File Structure live in the skeleton's
> assembled header (`docs/superpowers/plans/phase5/skeleton.md`) — not repeated here. Both tasks
> are grounded against real current source (`phase5-globe`, cut from `main @ 9784434`) as it
> exists *before* Tasks 1–5 run — Tasks 1–5 have not executed yet at fragment-writing time, so
> `GlobeView.tsx`'s Task-6 diff is written against a **reconstruction** of Task 3's output (its
> exact contract — `GlobeSceneProps`, `webglAvailable()`, the `GlobeScene`/`GlobeCards` split —
> is already pinned verbatim in `skeleton.md` and `GROUNDING.md`, so the reconstruction is
> contract-accurate even though the literal file doesn't exist yet). This is flagged explicitly
> at that step; every other edit in this fragment (`WorldPanel.tsx`, `WorldShell.tsx`,
> `WorldPanel.test.tsx`, `CrossAzColumn.tsx`, `TimelineStrip.tsx`, `SplitLines.tsx`,
> `RackNodes.tsx`, `AzRow.tsx`, `RegionView.tsx`) is grounded in real, currently-committed source
> quoted verbatim below.

**Judgment call flagged up front (governs Task 6's whole shape):** the skeleton's Task 6 file
list says GlobeView.tsx should "own `placeMode` state." Reading `WorldShell.tsx` (real source,
quoted in Task 6 Step 6) shows `GlobeView`/`RegionView`/`AzCanvas`/`ServerView` (the `view` local)
and `WorldPanel` are **siblings** in one `flex` row — `WorldPanel` is not a child of `GlobeView`
and vice versa. Since `TrafficPanel` (mounted inside `WorldPanel`) must toggle the same
`placeMode` boolean that `GlobeView` reads to arm `GlobeScene`'s raycast-click handler, the state
physically cannot live inside `GlobeView.tsx` while `WorldPanel.tsx` also needs to flip it — only
their common ancestor, `WorldShell.tsx`, can own it. This fragment lifts `placeMode` and
`selectedPopulationId` to two `useState`s in `WorldShell.tsx` and threads them down as props to
both `GlobeView` (`placeMode`, `onExitPlaceMode`, `onPopulationPlaced`) and `WorldPanel`
(`placeMode`, `onTogglePlaceMode`, `selectedPopulationId`, which `WorldPanel` passes straight
through to `TrafficPanel`) — no new store, per the skeleton's own constraint. This satisfies the
skeleton's *intent* (GlobeView still does the actual `addPopulation` call and owns the
raycast→lat/lon→placement wiring; it just doesn't own the armed/disarmed boolean itself).

---

## Task 6: Traffic authoring tab + place-on-globe `[sonnet]`

**Files:** create `src/app/world/panels/TrafficPanel.tsx`, `TrafficPanel.test.tsx`; modify
`src/app/world/panels/WorldPanel.tsx`, `src/app/world/panels/WorldPanel.test.tsx`,
`src/app/world/GlobeView.tsx` (Task 3's output — reconstructed, see the fragment header),
`src/app/world/GlobeView.test.tsx` (same caveat), `src/app/world/WorldShell.tsx`.

**Grounding — store actions (verified verbatim, `src/app/store/world.store.ts`):**
```ts
addPopulation: (label, lat, lon) => string
updatePopulation: (id, patch: Partial<ClientPopulation>) => void
removePopulation: (id) => void
updateRouting: (patch: Partial<RoutingConfig>) => void
updateTraffic: (patch: Partial<TrafficConfig>) => void
```
`createPopulation(label, lat, lon)` (`src/lib/world/factories.ts:95-97`) hardcodes
`peakRps: 500, diurnal: 'flat'` — `addPopulation` has **no** peakRps/diurnal parameter, so the
"+ add" form's rps/diurnal drafts must be applied via a follow-up `updatePopulation(id, {
peakRps, diurnal })` call right after `addPopulation` returns the new id (verified: this is not
optional plumbing, it's the only way those two fields reach a value other than the factory's
500/flat default).

**Grounding — types** (`src/lib/world/types.ts`): `ClientPopulation { id; label; lat; lon;
peakRps; diurnal: 'flat'|'day-night' }`; `RoutingConfig { policy: 'latency'|'geo'|'weighted'|
'priority'; weights: Record<RegionId,number>; priorityOrder: RegionId[];
healthCheckIntervalMs; healthCheckFailureThreshold; dnsTtlSec }`; `TrafficConfig { autoBaseline;
baselineTotalRps }`.

**Grounding — numeric-field convention** (`src/app/world/server/inspectorForms.tsx:15-26`,
quoted verbatim):
```ts
function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span>{label}</span>
      <input aria-label={label} style={inp} value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => { const n = Number(text); if (Number.isFinite(n) && n >= 0) onCommit(n); else setText(String(value)) }}
        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    </label>
  )
}
```
Local text buffer, commits on blur/Enter, reverts to the last committed value on non-numeric
text. This file's version only ever floor-clamps to `>=0` (no upper bound, no lower bound below
0) — `TrafficPanel.tsx` needs a **symmetric range** clamp for lat (`[-90,90]`) and lon
(`[-180,180]`), so Task 6 declares its own generalized `NumberField` with explicit `min`/`max`
rather than importing the `inspectorForms.tsx` one (which isn't exported). Same "Number.isFinite,
clamp, keep last valid" convention, extended to clamp in-range finite values instead of only
floor-clamping.

**Grounding — panel styles** (`src/app/world/panels/panelStyles.ts`, unchanged, reused
verbatim): `panel`, `sectionLabel`, `field`, `smallBtn`, `dangerBtn`, `row`.

- [ ] **Step 1: Write the failing test `TrafficPanel.test.tsx`**

```tsx
// src/app/world/panels/TrafficPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TrafficPanel } from './TrafficPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

const noop = () => {}

describe('TrafficPanel — populations', () => {
  it('add and edit population dispatches store actions with exact patches', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)

    fireEvent.click(screen.getByText('+ add'))
    const pops = Object.values(useWorldStore.getState().doc.populations)
    expect(pops).toHaveLength(1)
    expect(pops[0]).toMatchObject({ label: 'pop-1', lat: 40.7, lon: -74, peakRps: 100, diurnal: 'flat' })

    const id = pops[0].id
    fireEvent.change(screen.getByLabelText(`label-${id}`), { target: { value: 'nyc' } })
    expect(useWorldStore.getState().doc.populations[id].label).toBe('nyc')

    const latInput = screen.getByLabelText(`lat-${id}`)
    fireEvent.change(latInput, { target: { value: '51.5' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(51.5)

    const rpsInput = screen.getByLabelText(`rps-${id}`)
    fireEvent.change(rpsInput, { target: { value: '250' } })
    fireEvent.blur(rpsInput)
    expect(useWorldStore.getState().doc.populations[id].peakRps).toBe(250)

    fireEvent.change(screen.getByLabelText(`diurnal-${id}`), { target: { value: 'day-night' } })
    expect(useWorldStore.getState().doc.populations[id].diurnal).toBe('day-night')
  })

  it('remove population dispatches removePopulation', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByLabelText(`remove-${id}`))
    expect(useWorldStore.getState().doc.populations[id]).toBeUndefined()
  })

  it('lat clamps to [-90,90]', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const latInput = screen.getByLabelText(`lat-${id}`)

    fireEvent.change(latInput, { target: { value: '999' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(90)

    fireEvent.change(latInput, { target: { value: '-999' } })
    fireEvent.blur(latInput)
    expect(useWorldStore.getState().doc.populations[id].lat).toBe(-90)
  })

  it('selectedPopulationId row auto-focuses its label input', () => {
    const id = useWorldStore.getState().addPopulation('nyc', 40.7, -74)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={id} />)
    expect(screen.getByLabelText(`label-${id}`)).toHaveFocus()
  })
})

describe('TrafficPanel — place mode', () => {
  it('place toggle fires onTogglePlaceMode', () => {
    const onToggle = vi.fn()
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={onToggle} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText('+ place on globe'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reflects armed state via aria-pressed while placeMode is true', () => {
    render(<TrafficPanel placeMode={true} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.getByText('+ place on globe')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('TrafficPanel — traffic', () => {
  it('traffic toggles dispatch updateTraffic', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    fireEvent.click(screen.getByLabelText('autoBaseline'))
    expect(useWorldStore.getState().doc.traffic.autoBaseline).toBe(true)

    const rps = screen.getByLabelText('baselineTotalRps')
    fireEvent.change(rps, { target: { value: '250' } })
    fireEvent.blur(rps)
    expect(useWorldStore.getState().doc.traffic.baselineTotalRps).toBe(250)
  })
})

describe('TrafficPanel — routing', () => {
  it('weights editor only for weighted policy', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByLabelText(`weight-${regionId}`)).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('routing-policy'), { target: { value: 'weighted' } })
    const w = screen.getByLabelText(`weight-${regionId}`)
    expect(w).toBeInTheDocument()
    fireEvent.change(w, { target: { value: '3' } })
    fireEvent.blur(w)
    expect(useWorldStore.getState().doc.routing.weights[regionId]).toBe(3)

    fireEvent.change(screen.getByLabelText('routing-policy'), { target: { value: 'geo' } })
    expect(screen.queryByLabelText(`weight-${regionId}`)).not.toBeInTheDocument()
  })

  it('priority order buttons reorder priorityOrder', () => {
    const r1 = useWorldStore.getState().addRegion('us-east-1')
    const r2 = useWorldStore.getState().addRegion('eu-west-1')
    useWorldStore.getState().updateRouting({ policy: 'priority', priorityOrder: [r1, r2] })
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)

    fireEvent.click(screen.getByLabelText('move eu-west-1 up'))
    expect(useWorldStore.getState().doc.routing.priorityOrder).toEqual([r2, r1])

    fireEvent.click(screen.getByLabelText('move eu-west-1 down'))
    expect(useWorldStore.getState().doc.routing.priorityOrder).toEqual([r1, r2])
  })

  it('health/ttl numerics dispatch updateRouting with a floor of 1', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const ttl = screen.getByLabelText('dnsTtlSec')
    fireEvent.change(ttl, { target: { value: '0' } })
    fireEvent.blur(ttl)
    expect(useWorldStore.getState().doc.routing.dnsTtlSec).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/world/panels/TrafficPanel.test.tsx`
Expected: FAIL — `Cannot find module './TrafficPanel'`.

- [ ] **Step 3: Write `TrafficPanel.tsx`**

```tsx
// src/app/world/panels/TrafficPanel.tsx
// Traffic-authoring tab (Phase 5 D8): populations (incl. globe placement), auto-baseline
// traffic, and routing policy — all three sections write through EXISTING world.store actions
// only (addPopulation/updatePopulation/removePopulation/updateRouting/updateTraffic — Phase 5
// adds no new store actions). Mounted inside WorldPanel's `<fieldset disabled={running}>`
// (WorldPanel.tsx) — this component does NOT duplicate that running-gate itself.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import type { DiurnalPattern, RegionId, RoutingPolicyKind } from '../../../lib/world/types'
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
    const label = draftLabel.trim() || `pop-${populations.length + 1}`
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
```

**Judgment call — routing regions not yet in `priorityOrder`:** `world.store.ts`'s `withoutRegion`
already prunes a deleted region out of `priorityOrder`/`weights`, but nothing auto-appends a
newly-added region INTO `priorityOrder`. This panel renders `priorityOrder` strictly as-is (a
freshly added region simply doesn't appear in the priority list until something puts it there) —
no auto-append UI was in the skeleton's spec, so none was invented here. Flagged as a known gap,
not fixed this task.

- [ ] **Step 4: Modify `WorldPanel.tsx`**

Current file (verbatim, 67 lines) — the tab union, `tabs` array, and `<fieldset>` body all need
one addition each; everything else (topology/blueprints/placements/findings/events/cost) is
unchanged.

```diff
 import { useState } from 'react'
 import { TopologyPanel } from './TopologyPanel'
 import { BlueprintPanel } from './BlueprintPanel'
 import { PlacementPanel } from './PlacementPanel'
+import { TrafficPanel } from './TrafficPanel'
 import { useCompiledWorld } from '../useCompiledWorld'
 import { EventsTab } from '../EventsTab'
 import { CostTab } from '../CostTab'
 import { panel, smallBtn, sectionLabel } from './panelStyles'

-type Tab = 'topology' | 'blueprints' | 'placements' | 'findings' | 'events' | 'cost'
+type Tab = 'topology' | 'blueprints' | 'placements' | 'traffic' | 'findings' | 'events' | 'cost'

-export function WorldPanel({ running }: { running: boolean }) {
+export interface WorldPanelProps {
+  running: boolean
+  placeMode: boolean
+  onTogglePlaceMode: () => void
+  selectedPopulationId: string | null
+}
+
+export function WorldPanel({ running, placeMode, onTogglePlaceMode, selectedPopulationId }: WorldPanelProps) {
   const [tab, setTab] = useState<Tab>('topology')
   const { findings } = useCompiledWorld()
   const tabs: { id: Tab; label: string }[] = [
     { id: 'topology', label: 'Topology' },
     { id: 'blueprints', label: 'Blueprints' },
     { id: 'placements', label: 'Placements' },
+    { id: 'traffic', label: 'Traffic' },
     { id: 'findings', label: `Findings (${findings.length})` },
     { id: 'events', label: 'Events' },
     { id: 'cost', label: 'Cost' },
   ]
   return (
     <aside style={panel}>
       ...(tab strip unchanged)...
       <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
         {tab === 'topology' && <TopologyPanel />}
         {tab === 'blueprints' && <BlueprintPanel />}
         {tab === 'placements' && <PlacementPanel />}
+        {tab === 'traffic' && (
+          <TrafficPanel placeMode={placeMode} onTogglePlaceMode={onTogglePlaceMode} selectedPopulationId={selectedPopulationId} />
+        )}
         {tab === 'findings' && ( ...unchanged... )}
         {tab === 'events' && <EventsTab />}
         {tab === 'cost' && <CostTab />}
       </fieldset>
     </aside>
   )
 }
```

`TrafficPanel` is mounted **inside** the existing `<fieldset disabled={running}>` — same
running-gate every other tab already gets, no duplicate gating added.

- [ ] **Step 4b: Modify `WorldPanel.test.tsx`** (existing prop signature is now insufficient)

Both existing `render(<WorldPanel running={false} />)` / `render(<WorldPanel running={false} />)`
call sites (`src/app/world/panels/WorldPanel.test.tsx`, real source quoted earlier) need the three
new required props stubbed — behavior of both existing findings-tab cases is unaffected.

```diff
-    render(<WorldPanel running={false} />)
+    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} />)
     fireEvent.click(screen.getByText(/Findings \(\d+\)/))
```
(applied to both `it` blocks in that file).

- [ ] **Step 5: Modify `GlobeView.tsx`** — reconstruction of Task 3's output, see fragment header

Task 3 rewrites `GlobeView.tsx` into a WebGL-scene/card-fallback split per its exact `Produces`
block (`GlobeSceneProps { placeMode; onPlace; children }`, `webglAvailable()`,
`GlobeCards` extracted verbatim, an always-present visually-hidden a11y region list, the canvas
container `aria-hidden`). Since Tasks 1–5 haven't run yet, this step's "before" is a
contract-accurate reconstruction of that output, not a literal read — the executor running this
task AFTER Task 3 has actually landed must apply this diff's **intent** (prop signature,
`handlePlace` wiring, `GlobeScene`/layer passthrough) against the real file rather than pasting
the reconstruction verbatim if the real Task-3 file's internal structure differs in ways that
don't affect the pinned contract.

Reconstructed Task-3 output (contract-accurate):
```tsx
// src/app/world/GlobeView.tsx (Task 3 output, reconstructed)
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { webglAvailable } from './globe/webgl'
import { GlobeScene } from './globe/GlobeScene'
import { GlobeCards } from './GlobeCards'
import { RegionPins } from './globe/RegionPins'
import { PopulationMarkers } from './globe/PopulationMarkers'
import { ArcsLayer } from './globe/ArcsLayer'

export function GlobeView() {
  const doc = useWorldStore(s => s.doc)
  const goRegion = useNavStore(s => s.goRegion)
  const regions = Object.values(doc.regions)

  const a11yList = (
    <div className="visually-hidden" role="navigation" aria-label="regions">
      {regions.map(r => <button key={r.id} onClick={() => goRegion(r.id)}>{r.catalogId}</button>)}
    </div>
  )

  if (!webglAvailable()) {
    return <>{a11yList}<GlobeCards /></>
  }

  return (
    <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
      {a11yList}
      <GlobeScene placeMode={false} onPlace={() => {}}>
        <RegionPins />
        <PopulationMarkers />
        <ArcsLayer />
      </GlobeScene>
    </div>
  )
}
```

Task 6 diff on top of that:
```diff
+export interface GlobeViewProps {
+  placeMode: boolean
+  onExitPlaceMode: () => void
+  onPopulationPlaced: (id: string) => void
+}
+
-export function GlobeView() {
+export function GlobeView({ placeMode, onExitPlaceMode, onPopulationPlaced }: GlobeViewProps) {
   const doc = useWorldStore(s => s.doc)
+  const addPopulation = useWorldStore(s => s.addPopulation)
   const goRegion = useNavStore(s => s.goRegion)
   const regions = Object.values(doc.regions)

+  const handlePlace = (lat: number, lon: number) => {
+    const label = `pop-${Object.keys(doc.populations).length + 1}`
+    const id = addPopulation(label, lat, lon)
+    onExitPlaceMode()
+    onPopulationPlaced(id)
+  }
+
   const a11yList = ( ...unchanged... )

   if (!webglAvailable()) {
     return <>{a11yList}<GlobeCards /></>
   }

   return (
     <div aria-hidden="true" style={{ width: '100%', height: '100%' }}>
       {a11yList}
-      <GlobeScene placeMode={false} onPlace={() => {}}>
+      <GlobeScene placeMode={placeMode} onPlace={handlePlace}>
         <RegionPins />
         <PopulationMarkers />
         <ArcsLayer />
       </GlobeScene>
     </div>
   )
 }
```

- [ ] **Step 5b: Modify `GlobeView.test.tsx`** — same reconstruction caveat

Task 3's two named jsdom cases (`renders GlobeCards when webgl unavailable`,
`hidden a11y region list navigates` — both exercise only the fallback branch, mocking
`webgl.ts`) need their `render(<GlobeView />)` call updated to the new required props:

```diff
-      render(<GlobeView />)
+      render(<GlobeView placeMode={false} onExitPlaceMode={() => {}} onPopulationPlaced={() => {}} />)
```
applied at both call sites. Neither case's assertions change — the fallback branch never reads
`placeMode`/the two callbacks.

- [ ] **Step 6: Modify `WorldShell.tsx`** — the state lift (see fragment header's judgment call)

Current file (verbatim, quoted in full earlier in this session's grounding — relevant excerpts):
```tsx
import { useEffect, useState, type CSSProperties } from 'react'
...
export function WorldShell() {
  const nav = useNavStore()
  ...
  const view =
    nav.level === 'globe' ? <GlobeView /> :
    nav.level === 'region' ? <RegionView /> :
    nav.level === 'az' ? <AzCanvas /> :
    <ServerView />
  ...
        <WorldPanel running={running} />
```

Diff:
```diff
 export function WorldShell() {
   const nav = useNavStore()
   const reduced = useReducedMotion()
   const dirty = useFileStore(s => s.dirty)
   const [fileError, setFileError] = useState<string | null>(null)
   const running = useSimulationStore(s => s.running)
+  // Lifted here (not into GlobeView) because GlobeView and WorldPanel are SIBLINGS in the flex
+  // row below, not parent/child — TrafficPanel (mounted inside WorldPanel) needs to flip the
+  // same placeMode boolean GlobeView's GlobeScene reads, so only their common ancestor can own
+  // it. No new store — per the skeleton's own constraint, this stays local component state.
+  const [placeMode, setPlaceMode] = useState(false)
+  const [selectedPopulationId, setSelectedPopulationId] = useState<string | null>(null)
+
+  // Defensive UX, not a named requirement: disarm place-mode if the user navigates away from
+  // the globe level while it's armed, so it can't silently stay "armed" somewhere it has no
+  // effect (GlobeScene's raycast-click handler only exists at nav.level === 'globe').
+  useEffect(() => {
+    if (nav.level !== 'globe' && placeMode) setPlaceMode(false)
+  }, [nav.level, placeMode])

   ...(useEffect blocks unchanged)...

   const view =
-    nav.level === 'globe' ? <GlobeView /> :
+    nav.level === 'globe' ? (
+      <GlobeView
+        placeMode={placeMode}
+        onExitPlaceMode={() => setPlaceMode(false)}
+        onPopulationPlaced={setSelectedPopulationId}
+      />
+    ) :
     nav.level === 'region' ? <RegionView /> :
     nav.level === 'az' ? <AzCanvas /> :
     <ServerView />
```
and further down:
```diff
-        <WorldPanel running={running} />
+        <WorldPanel
+          running={running}
+          placeMode={placeMode}
+          onTogglePlaceMode={() => setPlaceMode(p => !p)}
+          selectedPopulationId={selectedPopulationId}
+        />
```
(`useEffect`/`useState` are already both imported on `WorldShell.tsx`'s existing React import
line — no import change needed.)

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run src/app/world/panels/TrafficPanel.test.tsx` → PASS (10 tests: 4 populations +
2 place-mode + 1 traffic + 3 routing).
Run: `npx vitest run src/app/world/panels/WorldPanel.test.tsx` → PASS (2 tests, unaffected
assertions, updated call sites).
Run: `npx vitest run src/app/world/GlobeView.test.tsx` → PASS (2 tests, updated call sites) — only
runnable once Task 3's real file exists; if this task executes immediately after Task 3 (per the
skeleton's serial dependency order T3→T4→T5→T6), the real file/test already exist and this is a
normal diff-and-rerun, not a reconstruction exercise.
Run: `npm run build` → succeeds (strict tsc, vite build green, three vendor chunk unaffected).
Run: `npx vitest run` → full suite green.

- [ ] **Step 8: Live smoke**

Strict port 1420, zero app console errors, screenshots, stop server after (per Global
Constraints). Story: open the Traffic tab → `+ place on globe` (button turns accent-armed,
`aria-pressed="true"`) → click a point on the globe → a teal population marker appears at the
clicked lat/lon, place-mode disarms, the tab's population list shows the new row with its label
input focused → rename it, edit `peakRps` → Simulate → the corresponding client arc's opacity
visibly reflects the new intensity (`0.25 + 0.75×intensity` per T5's `ArcsLayer`) as the value
changes. Also verify: switching `routing.policy` to `weighted` reveals one weight input per
region and switching to `priority` reveals the ordered list with working ↑/↓; toggling
`autoBaseline` and editing `baselineTotalRps` takes effect on the next Simulate (baseline
populations' synthetic per-region demand, per `buildArcs`'s existing `startsWith('baseline:')`
skip — client arcs remain population-driven only, unaffected by the auto-baseline toggle itself,
which only affects total demand shape, not arc rendering).

- [ ] **Step 9: Commit**

```bash
git add src/app/world/panels/TrafficPanel.tsx src/app/world/panels/TrafficPanel.test.tsx \
  src/app/world/panels/WorldPanel.tsx src/app/world/panels/WorldPanel.test.tsx \
  src/app/world/GlobeView.tsx src/app/world/GlobeView.test.tsx src/app/world/WorldShell.tsx
git commit -m "feat(traffic): population, baseline-traffic, and routing authoring with globe placement"
```

---

## Task 7: Integration, fps probe, §N, carry-forwards `[sonnet]`

**Files:** `docs/module-boundaries.md` (§N + a one-line §M amendment); modify
`src/app/world/region/CrossAzColumn.tsx`, `src/app/world/region/TimelineStrip.tsx`,
`src/app/world/region/SplitLines.tsx`, `src/app/world/RackNodes.tsx`,
`src/app/world/RegionView.tsx`, `src/app/world/region/AzRow.tsx`; append to
`.superpowers/sdd/progress.md` `## PHASE 5` and (if the T2 engine-internal `Map` note wasn't
already logged in Task 2) `.superpowers/sdd/contract-drift.md` `## PHASE 5`.

**Grounding — where these five carry-forwards actually came from:** all five are the exact
"OPEN ITEMS for Phase 5 / backlog" the Phase-4 final review logged at the bottom of
`.superpowers/sdd/progress.md`'s `## PHASE 4 COMPLETE` section (quoted verbatim below per item) —
this task is closing that backlog, not inventing new scope.

### (a) `CrossAzColumn.tsx` — replication-list dup-key

Backlog text: *"CrossAzColumn repl-list dup-key → key by `${bp}:${from}:${to}` [exotic
bidirectional multi-primary same-pair topology only]."*

Current line (`src/app/world/region/CrossAzColumn.tsx:42`, verbatim):
```tsx
            {entry.replication.map(r => <div key={r.blueprintId}>{r.blueprintName} repl</div>)}
```
Diff:
```diff
-            {entry.replication.map(r => <div key={r.blueprintId}>{r.blueprintName} repl</div>)}
+            {entry.replication.map(r => (
+              <div key={`${r.blueprintId}:${r.fromAzId}:${r.toAzId}`}>{r.blueprintName} repl</div>
+            ))}
```
`ReplicationPair` (`src/app/world/region/regionData.ts`) already carries `fromAzId`/`toAzId` — no
new data needed, purely a key-uniqueness fix for the (currently impossible in this fixture set,
but not type-impossible) case of two replication pairs of the same blueprint sharing one AZ pair.

### (b) `TimelineStrip.tsx` — out-of-window events pile at the left edge

Backlog text: *"TimelineStrip clamps out-of-120s-window events to the left edge → should
`return null if simMs < startMs` [glyph pile-up on >120s sims]."*

Current code (`src/app/world/region/TimelineStrip.tsx:68-86`, verbatim):
```tsx
        {scoped.map(e => {
          const clamped = Math.min(endMs, Math.max(startMs, e.simMs))
          const pct = ((clamped - startMs) / WINDOW_MS) * 100
          return (
            <button
              key={e.id}
              title={running ? 'stop the simulation to scrub to this event' : `${e.message} · t+${(e.simMs / 1000).toFixed(1)}s`}
              onClick={() => onEventClick(e)}
              disabled={running}
              style={{
                position: 'absolute', left: `${pct}%`, top: '50%', transform: 'translate(-50%, -50%)',
                background: 'none', border: 'none', padding: 2, cursor: running ? 'default' : 'pointer',
                color: SEVERITY_COLOR[e.severity], fontSize: 11, lineHeight: 1,
              }}
            >
              {GLYPH[e.kind]}
            </button>
          )
        })}
```
Diff:
```diff
         {scoped.map(e => {
-          const clamped = Math.min(endMs, Math.max(startMs, e.simMs))
-          const pct = ((clamped - startMs) / WINDOW_MS) * 100
+          if (e.simMs < startMs) return null
+          const pct = ((e.simMs - startMs) / WINDOW_MS) * 100
           return (
             <button
```
`scoped` (from `regionEvents`) is still the full un-windowed set — this per-event guard is what
actually enforces the 120s window on the timeline strip; `regionEvents` itself is untouched (it's
shared with `AlertRibbon`'s 30s window via a different caller, so windowing stays local to this
component rather than moving into the shared selector).

### (c) `SplitLines.tsx` + `RackNodes.tsx` — R2 token bypass

Backlog text: *"R2 token bypass (latent, no live theme toggle wired): SplitLines
DOWN_RED='#EF4444' + RackNodes CHASSIS_BORDER.degraded='#F59E0B55' vs sibling
var(--color-danger)/var(--color-warning)."* Both literals are **exact** hex matches for
`DARK_COLORS.danger`/`.warning` (`src/index.css`: `--color-danger: #EF4444`,
`--color-warning: #F59E0B`) — real R2 bypasses, not decorative chrome (R2's own carve-out is for
scene chrome and alpha-tinted variants that AREEN'T a plain `var()` substitution; `DOWN_RED` isn't
alpha-tinted at all, and `CHASSIS_BORDER.degraded`'s alpha component can be reproduced with
`color-mix()`, so neither needs the carve-out).

`SplitLines.tsx` current (verbatim):
```tsx
const TEAL = '#2DD4BF'
const DOWN_RED = '#EF4444'
const LABEL_COLOR = '#94A3B8'
```
used at:
```tsx
        const stroke = s.down ? DOWN_RED : TEAL
...
            <text x={midX} y={y - 6} fill={s.down ? DOWN_RED : LABEL_COLOR} fontSize={9}>
```
Diff:
```diff
 const TEAL = '#2DD4BF'
-const DOWN_RED = '#EF4444'
 const LABEL_COLOR = '#94A3B8'
```
```diff
-        const stroke = s.down ? DOWN_RED : TEAL
+        const stroke = s.down ? 'var(--color-danger)' : TEAL
```
```diff
-            <text x={midX} y={y - 6} fill={s.down ? DOWN_RED : LABEL_COLOR} fontSize={9}>
+            <text x={midX} y={y - 6} fill={s.down ? 'var(--color-danger)' : LABEL_COLOR} fontSize={9}>
```
`TEAL` and `LABEL_COLOR` are untouched — neither matches a `ColorTokens` value (`TEAL` isn't
`--color-accent`'s `#4A9EFF`; `LABEL_COLOR` happens to equal `--color-text-secondary` but the
backlog item names only the two danger/warning bypasses, and this is scene-chrome/label text, not
a health/severity signal — left local per R2, consistent with the narrower reading the backlog
item itself uses).

`RackNodes.tsx` current (verbatim, line 86):
```tsx
const CHASSIS_BORDER: Record<HealthState, string> = {
  healthy: '1px solid #2A303C', degraded: '1px solid #F59E0B55', down: '1px solid var(--color-danger)',
}
```
Diff (alpha ≈ `0x55/0xFF` = 33.3%, reproduced with `color-mix()` — the same idiom
`docs/module-boundaries.md`'s historical note already cites for this exact
"hex → `var()`/`color-mix()`" migration class):
```diff
 const CHASSIS_BORDER: Record<HealthState, string> = {
-  healthy: '1px solid #2A303C', degraded: '1px solid #F59E0B55', down: '1px solid var(--color-danger)',
+  healthy: '1px solid #2A303C',
+  degraded: '1px solid color-mix(in srgb, var(--color-warning) 33%, transparent)',
+  down: '1px solid var(--color-danger)',
 }
```
`healthy`'s `#2A303C` is a neutral chrome border (not a status hex — doesn't match any
`ColorTokens` value) and is untouched; `down` already used `var(--color-danger)`.

### (d) `AzRow.tsx` / `RegionView.tsx` — uncached per-row `computeWorldCost`

Backlog text: *"AzRow calls computeWorldCost per-row unmemoized (O(AZs×world) redundant at 1Hz) —
hoist to RegionView, pass monthlyUsd."* `docs/module-boundaries.md` §M's own Blast-radius section
already names this exact gap (*"AzRow.tsx's own call is uncached (one whole-WorldDoc
computeWorldCost walk per AZ row per render, not per region) — worth hoisting into
RegionView.tsx if AZ counts grow enough for it to show up in a profile, not fixed this task"*) —
this task fixes it and the §N edit below closes that stale note out.

`AzRow.tsx` current (verbatim):
```tsx
import { computeWorldCost } from '../../../lib/costModelV2'
...
export interface AzRowProps {
  azId: AzId
  regionId: RegionId
  onNavigateAz: () => void
  onNavigateServer: (serverId: ServerId) => void
}

export function AzRow({ azId, regionId, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  ...
  const usd = computeWorldCost(doc, batch?.world ?? null).byAz.find(e => e.azId === azId)?.monthlyUsd ?? 0
```
Diff:
```diff
-import { computeWorldCost } from '../../../lib/costModelV2'
 ...
 export interface AzRowProps {
   azId: AzId
   regionId: RegionId
+  monthlyUsd: number
   onNavigateAz: () => void
   onNavigateServer: (serverId: ServerId) => void
 }

-export function AzRow({ azId, regionId, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
+export function AzRow({ azId, regionId, monthlyUsd, onNavigateAz, onNavigateServer }: AzRowProps): ReactElement {
   const doc = useWorldStore(s => s.doc)
   const compiled = useCompiledWorld()
   const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
   ...
-  const usd = computeWorldCost(doc, batch?.world ?? null).byAz.find(e => e.azId === azId)?.monthlyUsd ?? 0
+  const usd = monthlyUsd
```
(the render body's `${Math.round(usd)}/mo` usage is unchanged — only the source of `usd` moves.)

`RegionView.tsx` current (verbatim, relevant excerpts):
```tsx
import { azShares, ribbonAlert, sparklineSeries } from './region/regionData'
...
  const shares = azShares(regionId, doc, batch)
  const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
...
            {azs.map(az => (
              <AzRow
                key={az.id} azId={az.id} regionId={regionId}
                onNavigateAz={() => goAz(regionId, az.id)}
                onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
              />
            ))}
```
Diff:
```diff
+import { computeWorldCost } from '../../lib/costModelV2'
 import { azShares, ribbonAlert, sparklineSeries } from './region/regionData'
 ...
   const shares = azShares(regionId, doc, batch)
   const alert = ribbonAlert(regionId, doc, events, batch?.simMs ?? 0)
+  const costs = computeWorldCost(doc, batch?.world ?? null)
 ...
             {azs.map(az => (
               <AzRow
-                key={az.id} azId={az.id} regionId={regionId}
+                key={az.id} azId={az.id} regionId={regionId}
+                monthlyUsd={costs.byAz.find(e => e.azId === az.id)?.monthlyUsd ?? 0}
                 onNavigateAz={() => goAz(regionId, az.id)}
                 onNavigateServer={serverId => goServer(regionId, az.id, serverId)}
               />
             ))}
```
One `computeWorldCost` call per region render instead of one per AZ row — same result set
(`costs.byAz`), just computed once and sliced per row. `RegionView.test.tsx` has no cost
assertions (verified — `grep -n "usd\|monthlyUsd\|computeWorldCost" RegionView.test.tsx` returns
nothing), so none of its 6 existing cases need updating; `AzRow.tsx` has no dedicated test file of
its own (confirmed — none exists in `src/app/world/region/`), so this prop addition is exercised
only through `RegionView.test.tsx`'s existing render-through coverage.

- [ ] **Step 1: Apply the four code diffs above** (a–d), then run:

Run: `npx vitest run src/app/world/region/RegionView.test.tsx` → PASS (6/6, unaffected — no cost
assertions to break).
Run: `npx vitest run` → full suite green.
Run: `npm run build` → strict tsc + vite build green.

- [ ] **Step 2: `docs/module-boundaries.md` — §N**

Append after §M's closing `---` (before "## 2. Shared 'hub' files"), modeled on §M's own
structure (intro paragraph → file table → Boundary rules → Frozen-contract note → Blast radius):

```markdown
### N. R3F globe + traffic authoring — Phase 5 Level-1 view (`src/app/world/globe/`, `src/app/world/panels/TrafficPanel.tsx`, 2026-07-09)

Replaces the Phase-1 placeholder `GlobeView` card grid (§1J) with a real three.js globe
(react-three-fiber): NASA night-lights earth + atmosphere shader, health-colored region pins,
teal population markers, and engine-driven great-circle traffic arcs (client/inter-region/
drain). Ships the traffic-authoring UI the world.store actions had no reader for since Phase 1
(`addPopulation`/`updatePopulation`/`removePopulation`/`updateRouting`/`updateTraffic`) via a new
`TrafficPanel.tsx` tab plus click-the-globe population placement. Built across Tasks 1–7 (spec:
`docs/superpowers/specs/2026-07-09-phase5-globe-design.md`); this task (7) is final integration —
fps probe, this section, and closing out the Phase-4 backlog (see the four carry-forward rows
below).

| File | Role |
|---|---|
| `src/app/world/globe/geo.ts` (Task 1) | Pure spherical math, no React/store reads: `latLonToVec3(lat,lon,r)`/`vec3ToLatLon(v)` (inverse, used for click-to-place) under the app's fixed convention (lat 90→+Y pole, lon 0→+Z meridian, lon 90E→+X), `greatCirclePoints(from,to,r,n)` (slerped great-circle points with an altitude bump peaking at the midpoint). Everything under `globe/` that needs spherical geometry goes through this module; nothing else in the app does its own trig |
| `src/app/world/globe/webgl.ts` (Task 3) | `webglAvailable()` — one-shot cached WebGL context-creation feature-detect. Sole gate deciding `GlobeView`'s scene-vs-`GlobeCards` branch |
| `src/app/world/globe/GlobeScene.tsx` (Task 3) | `<Canvas>` (dpr [1,2]) + night-earth sphere (T1 texture) + fresnel atmosphere shell + `OrbitControls` (no pan, clamped zoom) + idle rotation (paused on pointer-down and under reduced motion) + place-mode raycast-to-click (`vec3ToLatLon` on the hit point → `onPlace(lat,lon)`). `GlobeSceneProps { placeMode; onPlace; children }` is the seam T4/T5's layers and T6's placement wiring all mount through |
| `src/app/world/globe/RegionPins.tsx`, `PopulationMarkers.tsx` (Task 4) | Health-colored region pins (pulse on a recent failover/outage event, drei `Html` label, click→`goRegion`) and teal population markers (hover label `label · peakRps rps`, no click behavior — editing lives in `TrafficPanel`). Both read stores directly, no props |
| `src/app/world/globe/ArcsLayer.tsx` (Task 5) | `attachRenderer({level:'globe'}, onFrame)` once per `running` (T14-lesson renderer-attach discipline); rebuilds a pooled set of `THREE.Line` great-circle geometries only when the arc set's signature changes (`arcsSignature`, kind+endpoints), advances dash offset in refs every frame (never `setState`). Colors: client teal `#2DD4BF`, inter-region blue `#4A9EFF`, drain red `#EF4444` — local consts, not tokens, matching spec D6/R2's scene-chrome carve-out (arc colors have no `ColorTokens` equivalent) |
| `src/app/world/GlobeCards.tsx` (Task 3) | The pre-Phase-5 card grid, extracted verbatim from the old `GlobeView.tsx` — the WebGL-unavailable fallback AND the permanent a11y/screen-reader path (the canvas is `aria-hidden`, so a visually-hidden region-nav list is duplicated into both branches of `GlobeView.tsx`, not just this one) |
| `src/app/world/GlobeView.tsx` (Task 3, extended Task 6) | Composition root: `webglAvailable() ? <GlobeScene>{RegionPins,PopulationMarkers,ArcsLayer}</GlobeScene> : <GlobeCards/>`, plus the a11y list in both branches. **Task 6** gave it a `GlobeViewProps { placeMode; onExitPlaceMode; onPopulationPlaced }` — it does NOT own `placeMode` itself (see the Boundary rules note below on why) — and a `handlePlace(lat,lon)` that calls `addPopulation` + disarms + reports the new id up, passed as `GlobeScene`'s `onPlace` |
| `src/lib/worldEngine/index.ts` (Task 2, `buildArcs` only) | Extended (additive, no type change) to also emit `kind:'inter-region'` arcs (aggregated cross-region dependency flows, region→region, intensity by rps share) and `kind:'drain'` arcs (population's failover pending, or still routed to a `down` region during the TTL-lag window) — the pre-Phase-5 `kind:'client'` arcs stay byte-identical and first in the returned array; total capped at the existing `MAX_GLOBE_ARCS=200`, order client→inter-region→drain. One new engine-internal `Map<PopulationId, RegionId>` (prev-region-during-drain memory) — logged as the phase's one informational drift item, see the Frozen-contract note |
| `src/app/world/panels/TrafficPanel.tsx` (Task 6) | Three sections (POPULATIONS/TRAFFIC/ROUTING) writing through the pre-existing `world.store.ts` actions only (Phase 5 adds none) — see the Boundary rules note. `placeMode`/`selectedPopulationId` arrive as props, NOT read from a store — the panel is a pure controlled component over state `WorldShell.tsx` owns (see next row) |
| `src/app/world/panels/WorldPanel.tsx` (Task 6) | Gained a `'traffic'` tab entry and three new required props (`placeMode`/`onTogglePlaceMode`/`selectedPopulationId`), threaded straight through to `TrafficPanel` inside the existing `<fieldset disabled={running}>` — no new gating logic |
| `src/app/world/WorldShell.tsx` (Task 6) | Owns `placeMode`/`selectedPopulationId` `useState`s and threads them to both `GlobeView` and `WorldPanel` — the ONLY place they can live, since those two are siblings in `WorldShell`'s `flex` row (not parent/child), and `TrafficPanel` (a `WorldPanel` descendant) needs to toggle the same boolean `GlobeView`'s `GlobeScene` reads to arm its raycast handler. No new store — this is Zustand-free, plain lifted `useState`, per the Phase 5 constraint that no store action was added |

**Boundary rules:** `src/app/world/globe/*` imports `three`/`@react-three/fiber`/`@react-three/drei`
(Task 1 deps, no other new dependency anywhere per Global Constraints), `lib/world/types` +
`lib/world/regionGeo` + `lib/worldEngine/types` (type-only, `VisualArc`), and app stores
(`useWorldStore` read-only `doc`, `useSimulationStore` `attachRenderer`/`scrubBatch`/
`latestBatch`/`events`, `useNavStore` `goRegion`) — nothing under `globe/` imports
`worldEngine/index.ts` (the executable engine facade) directly; only `useSimulationStore` does,
continuing the seam §K/§L/§M each independently established. `TrafficPanel.tsx` writes through
`useWorldStore`'s five pre-existing population/traffic/routing actions ONLY — grep-verified no
new action was added to `world.store.ts` this phase. `GlobeView.tsx`/`WorldPanel.tsx`/
`WorldShell.tsx` together are the ONE place in the app where `placeMode` is threaded as plain
props across a sibling boundary rather than through a store — a deliberate, narrow exception
(two `useState`s, no persistence, no other reader) rather than a precedent for avoiding stores
generally elsewhere in `world/`.

**Frozen-contract note:** `VisualArc { fromLatLon; toLatLon; intensity; kind:
'client'|'inter-region'|'drain' }` (`worldEngine/types.ts`) was already frozen with all three
`kind` members before Phase 5 — `buildArcs` v2 only starts POPULATING the two kinds it previously
never emitted; no type under `worldEngine/` changed. The one informational drift item (a new
engine-internal `Map<PopulationId, RegionId>` added to `EngineState` in `worldEngine/index.ts` to
remember each population's previous region during a drain window) is logged in
`.superpowers/sdd/contract-drift.md` `## PHASE 5` as engine-internal state, not a contract change
— mirrors how Phase 4's item 8 (`CROSS_AZ_HOP_MS` local mirror) was logged as a transparency
record rather than a violation.

**Blast radius / Phase-4 backlog closed this task:** the four Phase-4-final-review backlog items
this task fixes (full text in `.superpowers/sdd/progress.md`'s `## PHASE 4 COMPLETE` "OPEN ITEMS
for Phase 5" list) — `CrossAzColumn.tsx`'s replication-list key now includes `fromAzId`/`toAzId`;
`TimelineStrip.tsx` now excludes (not clamps) events older than its 120s window;
`SplitLines.tsx`'s `DOWN_RED` and `RackNodes.tsx`'s `CHASSIS_BORDER.degraded` now route through
`var(--color-danger)`/`color-mix(in srgb, var(--color-warning) 33%, transparent)` instead of raw
hex; and **§M's own Blast-radius paragraph is hereby corrected** — its "AzRow.tsx's own call is
uncached ... not fixed this task" note is now stale, since `computeWorldCost` is hoisted to
`RegionView.tsx` (one call per region render, `monthlyUsd` passed down) as of this task. The
other three backlog categories from that same list (test-coverage gaps, cosmetic geometry nits,
the two PARKED items needing engine work) are out of Phase-5 scope and remain open.

---
```

Also append this one-line correction directly onto §M's existing Blast-radius paragraph (find the
sentence `AzRow.tsx's own call is uncached (one whole-WorldDoc computeWorldCost walk per AZ row
per render, not per region) — worth hoisting into RegionView.tsx if AZ counts grow enough for it
to show up in a profile, not fixed this task.` and append, in the same sentence's spirit as this
doc's other lazy-reconciliation notes, e.g. `➜ RESOLVED Phase 5 Task 7 — hoisted to RegionView.tsx, see §N.`).

- [ ] **Step 3: fps probe**

Author a 6-region/6-population world with a full arc payload (via the Traffic tab + Topology
tab, or the `window.__scalemapDebug` hook for scripted reproducibility) — 6 regions each with
≥1 AZ/server/cross-region-eligible blueprint dependency (to populate inter-region arcs), 6
populations spread globally (to populate client arcs), then simulate under enough load that
`buildArcs` approaches its `MAX_GLOBE_ARCS=200` cap. With the globe rendering live, run this
twice in the devtools console (or via a Playwright `browser_evaluate` call) and log both results
in the task report:
```js
let n = 0
const t0 = performance.now()
function tick(t) { n++; if (t - t0 < 3000) requestAnimationFrame(tick); else console.log('fps ~', (n / 3).toFixed(1)) }
requestAnimationFrame(tick)
```
Both runs must report **≥30fps**. Per spec D9, if either run fails, the first fallback is
reducing `ArcsLayer`'s great-circle segment count from 48 to 32 before any other optimization —
not required if the probe passes on the first attempt.

- [ ] **Step 4: Phase-gate live story, reduced-motion, WebGL-fallback**

Strict port 1420, zero app console errors throughout, screenshots at each major beat, server
stopped after. Story (per the design spec's "Testing & verification" section): author 2 regions +
an NYC population via the Traffic tab → globe shows night earth, pins, teal marker, client arc
under load → kill the target region (existing `setOutage`/region-outage control) → pin turns red
and pulses, a red drain arc appears, TTL expiry moves the client arc to the surviving region →
click a pin → region flow page opens → run the fps probe (Step 3) → toggle
`prefers-reduced-motion` and confirm no idle rotation / pin pulse / arc dash flow → force
`webglAvailable()` false (or use a browser context without WebGL) and confirm `GlobeCards` +
working a11y region-nav list render with zero errors.

- [ ] **Step 5: Ledger entry**

Append to `.superpowers/sdd/progress.md`, modeled on the `## PHASE 4` section's exact shape
(Plan/Branch/Contract-drift-log header lines, one paragraph per task, a `COMPLETE` line, a DONE
BAR, an OPEN ITEMS list, a DRIFT STATE line):

```markdown
## PHASE 5 — R3F globe + traffic authoring
Plan: docs/superpowers/plans/phase5/skeleton.md (+ fragments/tasks-06-07.md and this fragment's siblings)
Branch: phase5-globe (cut from main @ 9784434)
Contract drift log: .superpowers/sdd/contract-drift.md §PHASE 5 (one informational item: buildArcs v2's new engine-internal prev-region Map — RESOLVED, no contract/type change; no other drift expected)

Task 1: complete (<commit range>, <n>/<n> tests, build green). three/r3f/drei deps + NASA night texture + geo.ts.
Task 2: complete (<commit range>, <n>/<n> tests). buildArcs v2 — inter-region + drain arcs, client arcs byte-identical.
Task 3: complete (<commit range>, <n>/<n> tests). GlobeScene/webgl.ts/GlobeCards + GlobeView rewrite.
Task 4: complete (<commit range>). RegionPins/PopulationMarkers.
Task 5: complete (<commit range>, <n>/<n> tests). ArcsLayer.
Task 6: complete (<commit range>, TrafficPanel <n>/<n>, WorldPanel/GlobeView/WorldShell updated call sites). Traffic tab + place-on-globe; placeMode/selectedPopulationId lifted to WorldShell (GlobeView/WorldPanel are siblings, not parent/child — see §N).
Task 7: complete (<commit range>). fps probe <run1>fps/<run2>fps (≥30 both); §N written; 4 Phase-4 backlog items closed (CrossAzColumn key, TimelineStrip window, SplitLines/RackNodes token bypass, AzRow cost hoist); phase-gate live story + reduced-motion + WebGL-fallback passed.

=== ALL 7 TASKS COMPLETE. Suite <n>/<n> green, build green. HEAD <hash>. ===

## PHASE 5 COMPLETE — R3F globe + traffic authoring (branch phase5-globe, HEAD <hash>)

DONE BAR:
1. Full suite green; npm run build green.
2. fps probe ≥30fps, both runs, logged above.
3. Phase-gate live story passed end-to-end, zero console errors, screenshots in .superpowers/sdd/screenshots/phase5/.
4. Reduced-motion pass (no rotation/pulse/dash flow) and WebGL-fallback pass (GlobeCards + a11y list) both verified live.
5. docs/module-boundaries.md §N written; §M's stale AzRow blast-radius note corrected.
6. contract-drift.md §PHASE 5: exactly one informational item (buildArcs v2's prev-region Map).

OPEN ITEMS for Phase 6 / backlog: none blocking — Phase 6 (analysis engine + LLM reviewer) is the next and last phase per the umbrella spec.

DRIFT STATE: exactly ONE entry (contract-drift.md §PHASE 5 — buildArcs v2 prev-region Map) — informational, engine-internal, no contract/type change.
```

- [ ] **Step 6: Commit**

```bash
git add docs/module-boundaries.md \
  src/app/world/region/CrossAzColumn.tsx src/app/world/region/TimelineStrip.tsx \
  src/app/world/region/SplitLines.tsx src/app/world/RackNodes.tsx \
  src/app/world/RegionView.tsx src/app/world/region/AzRow.tsx
git commit -m "docs: update module boundaries for the globe (§N); region/rack carry-forwards"
```
(`.superpowers/sdd/progress.md`/`contract-drift.md` are gitignored per Phase 4's Task 8 note — not
part of this commit's `git add`.)
