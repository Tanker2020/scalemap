# Polish 2 plan fragment — Tasks 5–7 (guided console · plain words · motion pass + phase gate)

> Fragment scope: Task 5 (world summary strip + traffic hero + population sentence rows +
> `frontlineCapacityRps`), Task 6 (topology health words + firewall rule sentences), Task 7
> (motion application pass, module-boundaries §Q, phase gate). Global Constraints / File
> Structure live in the assembled plan header.
>
> Grounding status: same controller-verified base as the tasks-01-04 fragment (branch
> `polish2-overlays-motion` from `main` @ `8e798c0`, 2026-07-10). Additional files read in
> full for THIS fragment: `TopologyPanel.test.tsx` (the `serverBatch` fixture at 66-81:
> coreUtilization [0.62, 0.62], ram 4096/8192 → healthWord 'comfortable'), `SimControls.tsx`,
> `CostTab.tsx`, `costModelV2.ts` exports, `AzCanvas.tsx` (edge building at 130-139),
> `RegionView.tsx` + `CrossAzColumn.tsx` (no flow line — see decision 12), `InspectorRail.tsx`
> + `InspectorRail.test.tsx` + `inspectorForms.tsx` (FirewallEditor at 86-120).
>
> **Grounded controller decisions (apply as written; continues the numbering from
> tasks-01-04):**
> 9. **World-level latency figure:** the frozen `WorldMetrics` exposes NO p50/p99
>    (`worldEngine/types.ts:87-96`) — the spec's "p99 N ms if the world metrics expose it
>    (else p50)" resolves to the **rps-weighted mean of region `p50Ms`**, labeled `p50 N ms`
>    (the same weighting idiom `metrics.ts` uses to aggregate az → region).
> 10. **$/hr reuse:** the CostTab's helper is `computeWorldCost(doc, batch?.world ?? null)`
>    (`CostTab.tsx:11`), which is MONTHLY. The summary divides by `HOURS_PER_MONTH` (730) —
>    T5 changes `const HOURS_PER_MONTH` → `export const HOURS_PER_MONTH` in `costModelV2.ts`
>    (additive export, zero behavior change) rather than re-deriving the constant.
> 11. **ruleSentence protocol suffix — refinement of the skeleton's "not tcp":** appended
>    only for `udp`. Every fresh server ships the factory rule `allow any any internal`
>    (`factories.ts:65`), which under a literal "not tcp" rule would read "Let internal
>    traffic reach any port any" — the most common rule in the app must not be the ugliest.
>    Canonical copy (scratch-verified): `Let anyone reach https :443` ·
>    `Block internal traffic reaching redis :6379` · `Let internal traffic reach any port` ·
>    `Let 10.0.0.0/8 reach :9200 udp` · `Block anyone reaching ssh :22`.
> 12. **Flow shimmer scope:** AzCanvas edges only. `CrossAzColumn.tsx` renders text lines
>    (labels + latency), not a flow line, and `SplitLines` already animates — the skeleton's
>    "RegionView cross-AZ columns if they render a flow line" resolves to NO region-view
>    change (ledger note, not silent).
> 13. **Per-edge "flow > 0" signal in AzCanvas:** compiled paths carry no rps. The grounded
>    proxy: an edge shimmer-animates when it is unblocked AND its SOURCE server's resident
>    instances sum to > 0 rps in the display batch (the same per-server rps quantity the
>    chassis metrics block already computes, `AzCanvas.tsx:99`).
> 14. **Existing-test mechanical updates (restyle-contract precedent, Polish 1 correction
>    #2):** where THIS spec relocates or re-voices a control, the affected tests' interaction
>    or text-assertion lines are mechanically updated to drive/read the new widget, and every
>    STORE assertion stays byte-identical. The full inventory of touched tests is enumerated
>    per task below — nothing outside that inventory may change.
> 15. **Selected population rows auto-expand:** `TrafficPanel`'s `selectedPopulationId`
>    auto-focus (`TrafficPanel.tsx:78-80`, test at `TrafficPanel.test.tsx:60`) targets a
>    field that now lives inside a collapsed row. Rows render EXPANDED when
>    `pop.id === selectedPopulationId` (and the focus effect re-runs after expansion) so the
>    place-on-globe → tune flow and its test keep working untouched.

---

## Task 5: Guided console — world summary strip, traffic hero, sentence rows `[sonnet]`

**Files:** extend `src/app/world/ui/derived.ts` + `derived.test.ts`; modify
`src/lib/costModelV2.ts` (export keyword only), `src/app/world/panels/WorldPanel.tsx` +
`WorldPanel.test.tsx`, `src/app/world/panels/TrafficPanel.tsx` + `TrafficPanel.test.tsx`.

### Grounding — dispatch inventory that MUST survive byte-for-byte

| Control | Today | Exact dispatch (unchanged) |
|---|---|---|
| Hero rps slider (NEW position for the same field) | `TrafficPanel.tsx:164-165` NumberField | `updateTraffic({ baselineTotalRps: n })` — commit on release only |
| "exact value" NumberField (relocated under expander) | `TrafficPanel.tsx:162-166` | same `updateTraffic({ baselineTotalRps: n })`, same `aria-label="baselineTotalRps"` |
| autoBaseline checkbox | `TrafficPanel.tsx:157-161` | `updateTraffic({ autoBaseline: e.target.checked })` — NOT moved |
| Policy Segmented (relocated into the hero sentence) | `TrafficPanel.tsx:196-206` | identical JSX: `ariaLabel="routing-policy"`, same 4 options, `onChange={v => updateRouting({ policy: v })}` |
| Population tuning fields (re-wrapped, not rebuilt) | `TrafficPanel.tsx:100-123` | `updatePopulation(pop.id, { label/lat/lon/peakRps/diurnal })`, `removePopulation(pop.id)` — same aria-labels |

Other verified facts:

- Entry-blueprint predicate (READ ONLY, reimplemented purely): `worldEngine/index.ts:122-123`
  — `bp.ports.some(p => p.visibility === 'public')`.
- `frontlineCapacityRps` fixture number scratch-verified: web (cpuMs 8, public) on
  vps-medium (4 vcpu) + dedicated-8 (8 vcpu) = 500 + 1000 = **1500**; an internal `api`
  blueprint placement on the same host adds nothing.
- `hostRpsCapacity` already exists (`derived.ts:11-14`).
- WorldPanel summary sits ABOVE the tab bar, OUTSIDE the `<fieldset disabled={running}>` —
  it is a read surface and must not gray out while running.
- Mockup `.worldsum` (transcribed): border `--border` radius 7, padding `11px 13px`,
  `linear-gradient(180deg, #13161e, #10131a)` → `linear-gradient(180deg,
  var(--color-surface-hover), var(--color-node-base))`; line1 12.5px with `--hud` bold
  numbers → `var(--kit-accent)`, weight 600; line2 10.5px muted, flex gap 10.
- Mockup `.bigslider`/`.hint` (transcribed): top row 10px muted "quiet day"/"launch day"
  justify-between; hint 10.5px teal, `.warn` → `--warning`.
- Existing `TrafficPanel.test.tsx` inventory this task touches (decision 14 — mechanical
  updates ONLY, store assertions byte-identical):
  - `add and edit population dispatches store actions with exact patches` — insert one
    `fireEvent.click` on the new population sentence row before driving the per-row fields.
  - `remove population dispatches removePopulation` — same one-line expand-first insert.
  - `lat clamps to [-90,90]` — same insert.
  - `selectedPopulationId row auto-focuses its label input` — UNTOUCHED (decision 15).
  - `traffic toggles dispatch updateTraffic` — insert one click on the `exact value`
    expander before `getByLabelText('baselineTotalRps')`.
  - All routing tests — UNTOUCHED (the Segmented's buttons render in the hero with the same
    text; the Explainer stays in the ROUTING section).

### Step 5.1 — failing tests first: `derived.test.ts` addition

```ts
describe('frontlineCapacityRps', () => {
  it('sums vcpu·1000/cpuMs over entry placements only', () => {
    const doc = createWorld()
    const r = createRegion('us-east-1'); doc.regions[r.id] = r
    const az = createAz(r.id, 'us-east-1a'); doc.azs[az.id] = az
    const s1 = createServer(az.id, getPreset('vps-medium')!); doc.servers[s1.id] = s1      // 4 vcpu
    const s2 = createServer(az.id, getPreset('dedicated-8')!); doc.servers[s2.id] = s2     // 8 vcpu
    const web = createBlueprint('web', 0)
    web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
    web.workload.cpuMsPerRequest = 8
    doc.blueprints[web.id] = web
    const api = createBlueprint('api', 1)          // default port is internal → not an entry
    doc.blueprints[api.id] = api
    const p1 = createPlacement(web.id, s1.id); doc.placements[p1.id] = p1
    const p2 = createPlacement(web.id, s2.id); doc.placements[p2.id] = p2
    const p3 = createPlacement(api.id, s1.id); doc.placements[p3.id] = p3
    expect(frontlineCapacityRps(doc, compileWorld(doc))).toBe(1500)   // 4·125 + 8·125, api excluded
  })
  it('is 0 with no entry placements', () => {
    expect(frontlineCapacityRps(createWorld(), compileWorld(createWorld()))).toBe(0)
  })
})
```

### Step 5.2 — `derived.ts` additions

```ts
import type { ServiceBlueprint } from '../../../lib/world/types'
```

```ts
// The engine's client-entry predicate (worldEngine/index.ts:122-123), reimplemented purely —
// never imported from engine internals (Global Constraints).
export function isEntryBlueprint(bp: ServiceBlueprint): boolean {
  return bp.ports.some(p => p.visibility === 'public')
}

// Total rps the frontline (entry-blueprint placements) can absorb at 100% cpu: Σ
// hostRpsCapacity(host vcpu, blueprint cpuMs) over every placement of an entry blueprint.
// The compiled world is accepted for signature symmetry with its consumers (and future
// instance-count refinements) — the sum itself is authored-doc math.
export function frontlineCapacityRps(doc: WorldDoc, _compiled: CompiledWorld): number {
  let sum = 0
  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server || !isEntryBlueprint(bp)) continue
    sum += hostRpsCapacity(server.specs.vcpu, bp.workload.cpuMsPerRequest)
  }
  return sum
}
```

`costModelV2.ts`: `const HOURS_PER_MONTH = 730` → `export const HOURS_PER_MONTH = 730`
(line 7 — the only change to the file).

### Step 5.3 — failing test: WorldPanel summary at rest

Append to `WorldPanel.test.tsx`:

```tsx
  it('world summary at rest counts the authored doc', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    expect(screen.getByText(/1 region · 1 server · baseline 1,000 rps/)).toBeInTheDocument()
  })
```

(`getPreset` joins the imports. Pluralization: `region`/`regions`, `server`/`servers` by
count; `baseline` uses `doc.traffic.baselineTotalRps.toLocaleString('en-US')`.)

### Step 5.4 — WorldPanel summary strip

In `WorldPanel.tsx`, above the tab-bar `<div>` (inside `<aside>`, OUTSIDE the fieldset),
insert a `WorldSummary` sibling component (same file, below `WorldPanel`):

```tsx
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
  const healthText = downCount > 0
    ? `● ${downCount} region${downCount === 1 ? '' : 's'} down`
    : degradedCount > 0
      ? `● ${degradedCount} region${degradedCount === 1 ? '' : 's'} degraded`
      : '● all healthy'
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
      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', marginTop: 3, display: 'flex', gap: 10, flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: healthColor }}>{healthText}</span>
        <span>${hourlyUsd.toFixed(2)}/hr</span>
        <span>p50 {Math.round(p50)} ms</span>
      </div>
    </div>
  )
}
```

Imports added to WorldPanel.tsx: `useRollingNumber` from `../ui/motion`, `computeWorldCost`
+ `HOURS_PER_MONTH` from `../../../lib/costModelV2`, `type CSSProperties` from react.
Mount: `<WorldSummary />` as the first child of `<aside>`.

### Step 5.5 — failing tests: traffic hero

Append to `TrafficPanel.test.tsx`:

```tsx
describe('TrafficPanel — hero sentence (Polish 2)', () => {
  function seedFrontline() {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const s1 = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)     // 4 vcpu
    const s2 = useWorldStore.getState().addServer(azId, getPreset('dedicated-8')!)    // 8 vcpu
    const bpId = useWorldStore.getState().addBlueprint('web')
    useWorldStore.getState().updateBlueprint(bpId, {
      ports: [{ port: 8080, protocol: 'tcp', visibility: 'public' }],
      workload: { cpuMsPerRequest: 8, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
    })
    useWorldStore.getState().addPlacement(bpId, s1)
    useWorldStore.getState().addPlacement(bpId, s2)
    // frontline capacity = 1500 rps across 2 entry placements
  }

  it('hero slider commits baselineTotalRps on release with the exact patch', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const slider = screen.getByLabelText('hero-baseline-rps')
    fireEvent.change(slider, { target: { value: '5000' } })
    expect(useWorldStore.getState().doc.traffic.baselineTotalRps).toBe(1000)   // drag = draft only
    fireEvent.mouseUp(slider)
    expect(useWorldStore.getState().doc.traffic.baselineTotalRps).toBe(5000)
  })

  it('hero hint turns warning at 70% of frontline capacity and sheds at 100%', () => {
    seedFrontline()
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    const slider = screen.getByLabelText('hero-baseline-rps')

    fireEvent.change(slider, { target: { value: '900' } })    // 60% of 1500
    expect(screen.getByText('≈ 450 rps per frontline replica — comfortable (est. 60% cpu)')).toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '1200' } })   // 80%
    expect(screen.getByText('≈ 600 rps per frontline replica — tight (est. 80% cpu)')).toBeInTheDocument()

    fireEvent.change(slider, { target: { value: '1600' } })   // 107%
    expect(screen.getByText('≈ 800 rps per frontline replica — ✗ will shed load (est. 107% cpu). Add replicas or bigger presets.')).toBeInTheDocument()
  })

  it('hero hint hides when the world has no entry placements', () => {
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByText(/frontline replica/)).not.toBeInTheDocument()
  })

  it('population sentence row expands to the existing fields and their dispatch is unchanged', () => {
    const id = useWorldStore.getState().addPopulation('São Paulo', -23.55, -46.63)
    render(<TrafficPanel placeMode={false} onTogglePlaceMode={noop} selectedPopulationId={null} />)
    expect(screen.queryByLabelText(`rps-${id}`)).not.toBeInTheDocument()          // collapsed
    fireEvent.click(screen.getByText(/São Paulo/))
    const rpsInput = screen.getByLabelText(`rps-${id}`)                            // same aria-label
    fireEvent.change(rpsInput, { target: { value: '250' } })
    fireEvent.blur(rpsInput)
    expect(useWorldStore.getState().doc.populations[id].peakRps).toBe(250)         // same dispatch
  })
})
```

(`getPreset` joins the imports. Mechanical updates to the five existing tests per the
Grounding inventory — expand-row / open-expander clicks inserted, every store assertion
byte-identical.)

### Step 5.6 — TrafficPanel reshape

Order inside the component: **hero → populations (sentence rows) → routing** (the traffic
hero absorbs the old TrafficSection position at the top — it IS the headline control now).

**Hero block** (new `TrafficHero` function in the same file, replacing `TrafficSection`'s
slider role — `TrafficSection` itself is dissolved into it):

```tsx
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
          { value: 'latency', label: '⚡ latency' },
          { value: 'geo', label: '🌍 geo' },
          { value: 'weighted', label: '⚖ weighted' },
          { value: 'priority', label: '1-2-3 priority' },
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
```

The RANGE and the NumberField are two inputs over the SAME field with the SAME dispatch
shape — `updateTraffic({ baselineTotalRps: … })` — which is the relocated-dispatch contract
holding for both.

**RoutingSection**: DELETE the `Segmented` block (relocated above — the section keeps its
`SectionHeader`, the `Explainer` line, the weighted/priority editors, and the
ttl/health fields, all byte-identical).

**Population sentence rows** (`PopulationsSection`'s map body re-wrapped — the fields and
the add-draft row below stay byte-identical inside the expanded branch):

```tsx
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
                {/* EXISTING field row, byte-identical: label input, lat/lon/rps NumberFields,
                    diurnal select, remove button — moved inside, aria-labels unchanged */}
              </div>
            )}
          </div>
        )
      })}
```

(`expanded` is new local state `useState<string | null>(null)`; `compiled` via
`useCompiledWorld()`; `populationLanding` imported from `../ui/derived`. The EdgeRow wrapper
for population rows is replaced by this sentence row — presentation only; the inner
`<div style={{ display:'flex', … }}>` with all fields moves verbatim into the expanded
branch.)

### Step 5.7 — verify

```bash
npx vitest run src/app/world/ui/derived.test.ts src/app/world/panels/TrafficPanel.test.tsx src/app/world/panels/WorldPanel.test.tsx
# expect: new frontline/hero/summary/sentence tests green; every pre-existing store
# assertion untouched and green (5 tests carry the enumerated one-line mechanical updates)
npx vitest run && npm run build
```

### Step 5.8 — live smoke (controller runs it)

- [ ] Three-tier example → Traffic tab: hero sentence with the policy segmented embedded;
      drag to 12,000 → hint flips to the ✗ shed wording before release; release persists
      (exact value expander shows 12000).
- [ ] Simulate → world summary strip: numbers ROLL, health dot line, $/hr and p50 populate.
      At rest it shows the authored counts line.
- [ ] Population sentence row: collapsed shows "São Paulo sends N rps → lands on …";
      expand → existing tuning fields; commit round-trips; place-on-globe still lands
      focused in the new population's label field (auto-expand).
- [ ] Dark + light screenshots: summary strip + hero + sentence rows →
      `.superpowers/sdd/screenshots/polish2-t5-*`.

**Commit:** `feat(console): world summary strip, traffic hero sentence-slider, population sentence rows`

---

## Task 6: Plain words — topology health words + firewall sentences `[sonnet]`

**Files:** modify `src/app/world/panels/TopologyPanel.tsx` + `TopologyPanel.test.tsx`;
create `src/app/world/server/ruleSentence.ts` + `ruleSentence.test.ts`; modify
`src/app/world/server/InspectorRail.tsx` + `InspectorRail.test.tsx`.
`src/app/world/server/inspectorForms.tsx` is NOT touched — every firewall dispatch lives
there and stays byte-identical by construction.

### Grounding

- `TopologyPanel.tsx:159-160` already computes `cpuMean`/`ramFrac`; the word renders in the
  trailing cluster after `MicroBars`, only when `metrics` exists. Existing `serverBatch`
  fixture (`TopologyPanel.test.tsx:66-81`): coreUtilization [0.62, 0.62], ram 4096/8192 →
  `healthWord(0.62, 0.5) === 'comfortable'`.
- `InspectorRail.tsx:79-92` rule rows: ordinal, `ALLOW`/`DENY` tint, `:{port} {protocol}`,
  `from {source}`, `data-testid="fw-rule-row"`, click → `onSelect({ kind: 'rule', ruleId })`.
  `FirewallEditor` mounts at line 93 (currently ALWAYS); caption line 78 and DENIED footer
  line 94 are untouched (tests reference them).
- Existing InspectorRail tests touched (decision 14 inventory — text assertions only):
  - `firewall stack renders order numbers and flow captions`: `'ALLOW'` →
    `'Let'`; `'DENY'` → `'Block'`; `'from any'` → `'anyone'`; the ordinal, caption, and
    DENIED assertions stay byte-identical. Store assertions: none in this test.
  - `firewall selection lists rules in order and drills into a rule`: UNTOUCHED (click →
    `onSelect({kind:'rule', ruleId:'r2'})` still fires — see behavior below).
  - Every `inspector editing forms` test: UNTOUCHED (inspectorForms.tsx unchanged).
- New behavior: clicking a sentence row toggles — not-selected → `onSelect({ kind: 'rule',
  ruleId })`; already-selected → `onSelect({ kind: 'firewall' })` (collapse back). The
  `FirewallEditor` block renders ONLY when `selection.kind === 'rule'` — "clicking a row
  toggles its edit inputs" (spec D7) with the editor's dispatches untouched.
- `ruleSentence` copy: decision 11's canonical five, scratch-verified.

### Step 6.1 — failing tests first: `ruleSentence.test.ts`

Create `src/app/world/server/ruleSentence.test.ts` (node env):

```ts
import { describe, it, expect } from 'vitest'
import { ruleSentence } from './ruleSentence'

describe('ruleSentence', () => {
  it('allow 443 tcp any → "Let anyone reach https :443"', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 443, protocol: 'tcp', source: 'any' }))
      .toBe('Let anyone reach https :443')
  })
  it('deny 6379 tcp internal → "Block internal traffic reaching redis :6379"', () => {
    expect(ruleSentence({ id: 'r', action: 'deny', port: 6379, protocol: 'tcp', source: 'internal' }))
      .toBe('Block internal traffic reaching redis :6379')
  })
  it('factory default allow any any internal reads clean (no protocol noise)', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 'any', protocol: 'any', source: 'internal' }))
      .toBe('Let internal traffic reach any port')
  })
  it('udp is the only spelled protocol; unknown ports stay bare; CIDRs verbatim', () => {
    expect(ruleSentence({ id: 'r', action: 'allow', port: 9200, protocol: 'udp', source: '10.0.0.0/8' }))
      .toBe('Let 10.0.0.0/8 reach :9200 udp')
    expect(ruleSentence({ id: 'r', action: 'deny', port: 22, protocol: 'tcp', source: 'any' }))
      .toBe('Block anyone reaching ssh :22')
  })
})
```

### Step 6.2 — `ruleSentence.ts`

```ts
// Plain-words rendering of a firewall rule (Polish 2 D7). Pure — the InspectorRail renders
// the pieces with tint/bold spans; this string form is the single copy source both use.
import type { FirewallRule } from '../../../lib/world/types'

export const PORT_SERVICE_WORDS: Record<number, string> = {
  443: 'https', 80: 'http', 5432: 'postgres', 6379: 'redis', 22: 'ssh',
}

export function ruleSourceWords(source: FirewallRule['source']): string {
  return source === 'any' ? 'anyone' : source === 'internal' ? 'internal traffic' : source
}

export function rulePortPhrase(rule: FirewallRule): string {
  if (rule.port === 'any') return 'any port'
  const svc = PORT_SERVICE_WORDS[rule.port]
  return `${svc ? `${svc} ` : ''}:${rule.port}`
}

// Protocol appended only for udp — tcp is the default voice, and 'any' on the factory
// default rule (`allow any any internal`) would read "…any port any" (plan decision 11).
export function ruleSentence(rule: FirewallRule): string {
  const proto = rule.protocol === 'udp' ? ' udp' : ''
  return rule.action === 'allow'
    ? `Let ${ruleSourceWords(rule.source)} reach ${rulePortPhrase(rule)}${proto}`
    : `Block ${ruleSourceWords(rule.source)} reaching ${rulePortPhrase(rule)}${proto}`
}
```

### Step 6.3 — InspectorRail re-voicing

Rule rows (`InspectorRail.tsx:79-92`) become sentence rows — testid, key, ordinal span, and
row styling preserved; click toggles per the Grounding note:

```tsx
        {rules.map((r, i) => {
          const selected = selection.kind === 'rule' && selection.ruleId === r.id
          return (
            <div key={r.id} data-testid="fw-rule-row"
              onClick={() => onSelect(selected ? { kind: 'firewall' } : { kind: 'rule', ruleId: r.id })}
              style={{
                display: 'flex', gap: 6, fontSize: 10.5, padding: '4px 6px', borderRadius: 4,
                cursor: 'pointer', alignItems: 'baseline',
                background: selected ? 'color-mix(in srgb, var(--color-text-primary) 3%, transparent)' : undefined,
              }}>
              <span style={{ color: 'var(--color-text-muted)', width: 12, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <span>
                <span style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {r.action === 'allow' ? 'Let' : 'Block'}
                </span>{' '}
                <b style={{ color: '#DBEAFE' }}>{ruleSourceWords(r.source)}</b>{' '}
                {r.action === 'allow' ? 'reach' : 'reaching'}{' '}
                <b style={{ color: '#DBEAFE' }}>{rulePortPhrase(r)}</b>
                {r.protocol === 'udp' ? ' udp' : ''}
              </span>
            </div>
          )
        })}
        {selection.kind === 'rule' && <FirewallEditor key={serverId} serverId={serverId} />}
```

(The `#DBEAFE` bold tint is the rail's existing always-dark emphasis color,
`InspectorRail.tsx:52` — this rail keeps a hardcoded dark background by design, see its
header comment.) Imports: `ruleSentence` pieces from `./ruleSentence`.

### Step 6.4 — TopologyPanel health word

In `ServerRow`'s trailing cluster, insert after `{metrics && <MicroBars …/>}`:

```tsx
            {metrics && (() => {
              const word = healthWord(cpuMean, ramFrac)
              const color = word === 'comfortable' ? 'var(--color-success)'
                : word === 'tight' ? 'var(--color-warning)' : 'var(--color-danger)'
              return <span style={{ fontSize: 10, color }}>{word}</span>
            })()}
```

Import `healthWord` from `../ui/derived`.

### Step 6.5 — failing tests: extensions

`TopologyPanel.test.tsx` — append to the instrument-restyle describe:

```tsx
  it('healthWord chip appears only with metrics and uses the status color', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const serverId = useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    useSimulationStore.setState({ latestBatch: serverBatch(serverId, regionId) })
    render(<TopologyPanel />)
    const word = screen.getByText('comfortable')          // healthWord(0.62, 0.5)
    expect(word).toHaveStyle({ color: 'var(--color-success)' })
    useSimulationStore.setState({ latestBatch: null })
  })

  it('no health word at rest', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
    render(<TopologyPanel />)
    expect(screen.queryByText(/comfortable|tight|straining/)).not.toBeInTheDocument()
  })
```

`InspectorRail.test.tsx` — mechanical text updates to `firewall stack renders order numbers
and flow captions` per the Grounding inventory, plus one NEW test:

```tsx
  it('firewall reorder and remove dispatches are unchanged after the re-voicing', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateServer')
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'rule', ruleId: 'r1' }} onSelect={() => {}} />)
    expect(screen.getByText('Let')).toBeInTheDocument()                       // sentence read view
    expect(screen.getByText('postgres :5432')).toBeInTheDocument()            // service word
    fireEvent.click(screen.getAllByLabelText('move rule down')[0])            // FirewallEditor visible when a rule is selected
    expect(spy).toHaveBeenCalledWith(serverId, { firewall: [
      expect.objectContaining({ id: 'r2' }), expect.objectContaining({ id: 'r1' }),
    ] })
  })
```

Also mechanically update `firewall selection lists rules in order and drills into a rule` —
NO change needed to its assertions (click on rows[1] from `{kind:'firewall'}` still calls
`onSelect({kind:'rule', ruleId:'r2'})`); verify it passes as-is.

### Step 6.6 — verify

```bash
npx vitest run src/app/world/server src/app/world/panels/TopologyPanel.test.tsx
# expect: 4 ruleSentence tests + 2 topology tests + 1 rail test new-green; every existing
# rail/forms test green (one test carries the enumerated text-assertion updates)
npx vitest run && npm run build
```

### Step 6.7 — live smoke (controller runs it)

- [ ] Teaching world → cache server → server view → firewall: the deny :6379 rule reads
      "Block … redis :6379" as a sentence; the factory rule reads "Let internal traffic
      reach any port".
- [ ] Click the deny sentence → edit inputs appear beneath the stack; fix the rule (deny →
      allow) → Analysis count drops live; click the row again → inputs collapse.
- [ ] Reorder ↑/↓ and ✕ still work from the editor; caption + DENIED footer unchanged.
- [ ] Topology tab under simulation: each server row shows its word in the right color;
      stress one server (kill its sibling) → word flips tight/straining.
- [ ] Dark + light screenshots: firewall sentences + topology words →
      `.superpowers/sdd/screenshots/polish2-t6-*`.

**Commit:** `feat(words): topology health words + firewall rule sentences`

---

## Task 7: Motion application pass + phase gate `[sonnet]`

**Files:** modify `src/app/world/panels/WorldPanel.tsx` (+ test — tab ink), className sweep
across `src/app/world/panels/TopologyPanel.tsx` / `TrafficPanel.tsx` / `BlueprintPanel.tsx` /
`PlacementPanel.tsx`, `src/app/world/WorldShell.tsx` (hdrBtn), `src/app/world/SimControls.tsx`,
`src/app/world/ui/kit.tsx` (className additions inside `Segmented`/`PresetCardGrid` buttons
— presentation-only, zero API change), `src/app/world/AzCanvas.tsx` (flow shimmer);
`docs/module-boundaries.md` §Q; `.superpowers/sdd/progress.md` `## POLISH 2`.

### Grounding

- Tab bar today: `WorldPanel.tsx:50-67` — per-button `borderBottom: tab === t.id ? '2px
  solid var(--color-accent)' : '2px solid transparent'`. The ink replaces exactly that
  border; the click dispatch `onClick={() => setTab(t.id)}` and the Analysis ChipValue stay.
- Mockup ink behavior (`config-overlays-v1.html:436-442`, exercised live): ink sits under
  the ACTIVE tab; hovering another tab slides the ink there as a preview;
  `mouseleave` on the bar returns it to the active tab; clicking commits.
- `.kit-ink` CSS shipped in T1 (`position: absolute; bottom: 0; height: 2px; …transition
  left/width`); the bar container needs `position: relative`.
- Flow shimmer: decision 13 (source-server rps proxy); edges built at `AzCanvas.tsx:130-139`;
  per-server rps already computed for chassis at line 99 — lift it into a `Map` before the
  edge map. React Flow's `animated: true` renders the dashed-flow treatment; reduced-motion
  no-op shipped in T1's stylesheet block.
- Ripples: `.kit-ripple` wraps a dot; color rides `currentColor`. Consumers gated on
  `running`:
  - `EdgeRow` (kit.tsx): additive optional prop `ripple?: boolean` — when true AND status is
    non-null, the dot span gains `className="kit-ripple"` and `style.color = STATUS_COLOR[status]`.
    Additive prop = allowed (the T1 no-API-change constraint bound T1 only; Global
    Constraints bind dispatches and worldEngine, not kit props).
  - `TopologyPanel` ServerRow passes `ripple={running}` (add `const running =
    useSimulationStore(s => s.running)` — a read, not a dispatch).
  - `WorldSummary`'s health `●` (T5) — wrap in a `.kit-ripple` span while a batch is live.
  - `SceneOverlay` gains additive `ripple?: boolean`; `RegionOverlay` passes
    `ripple={running}`.
- Button-press sweep — `className="kit-press"` added to every `<button>` currently styled
  with `smallBtn`/`dangerBtn` in the four panels, WorldShell's `hdrBtn` buttons, SimControls'
  Simulate/Stop button, and the `Segmented`/`PresetCardGrid` buttons inside kit.tsx.
  EXCLUDE: TopologyPanel's `unstyledButton` ChipValue wrapper (no border to glow) and any
  button already carrying `kit-press` from T3/T4.

### Step 7.1 — tab ink

In `WorldPanel.tsx`, the tab bar becomes:

```tsx
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
```

```tsx
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
```

(The per-button `borderBottom` line is DELETED — the ink is the underline now. `useRef`/
`useLayoutEffect` join the react import. Every tab-click dispatch and the ChipValue stay
byte-identical; all five WorldPanel tests plus T4/T5's additions must stay green — jsdom
gives offsetLeft/Width = 0, which renders a 0-width ink and breaks nothing.)

### Step 7.2 — ripples + press sweep + shimmer

Per the Grounding list:

1. `kit.tsx` `EdgeRow`: additive `ripple?: boolean` prop; dot span gains
   `className={ripple && status ? 'kit-ripple' : undefined}` and, when rippling,
   `color: STATUS_COLOR[status]` in its style (background/boxShadow lines unchanged).
2. `kit.tsx` `Segmented` + `PresetCardGrid` buttons: `className="kit-press"` (PresetCardGrid
   keeps its existing `"kit-pcard kit-t"` — append: `"kit-pcard kit-t kit-press"`).
3. `TopologyPanel` ServerRow: `ripple={running}` on its EdgeRow; `className="kit-press"` on
   every smallBtn/dangerBtn button in the file.
4. `TrafficPanel` / `BlueprintPanel` / `PlacementPanel`: `className="kit-press"` on every
   smallBtn/dangerBtn button.
5. `WorldShell.tsx` hdrBtn buttons (⚙/New/Open/Save/Save As/dismiss) + `SimControls.tsx`
   Simulate/Stop: `className="kit-press"`.
6. `WorldSummary` (T5): health `●` wrapped in `<span className={batch ? 'kit-ripple' : undefined} …>`
   with the dot's color as `color` — display batch presence is the running-gate at this
   surface (scrub replays ripple too, matching every other live read).
7. `SceneOverlay`: additive `ripple?: boolean`; header dot gains the class when set;
   `RegionOverlay` passes `ripple={running}` (running selector already in scope).
8. `AzCanvas.tsx`: before the edge map, build
   `const rpsByServer = new Map(servers.map(s => [s.id, Object.values(compiled.instances).filter(i => i.serverId === s.id).reduce((sum, i) => sum + (batch?.instances[i.id]?.rps ?? 0), 0)]))`
   then in the edge object add:
   `animated: e.blocked === 0 && (rpsByServer.get(e.source) ?? 0) > 0,`
   (Blocked edges keep their static red dash — never shimmer a refused path.)

### Step 7.3 — failing test guard (tab dispatch survives the ink)

Append to `WorldPanel.test.tsx`:

```tsx
  it('tab ink slides — clicking a tab still switches content with the ink element present', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} openSettings={() => {}} />)
    fireEvent.click(screen.getByText('Traffic'))
    expect(screen.getByLabelText('autoBaseline')).toBeInTheDocument()
    expect(document.querySelector('.kit-ink')).not.toBeNull()
  })
```

### Step 7.4 — docs

- `docs/module-boundaries.md` — append **§Q — Polish 2: command overlays, guided console,
  motion**, listing: the ui kit additions (`motion.ts`, `HoldToEnter.tsx`, `SceneOverlay.tsx`,
  `overlays/RegionOverlay.tsx`, `overlays/PopulationOverlay.tsx`, `ruleSentence.ts`), the ONE
  additive ui.store field (`sceneOverlay` + setter), the reactive `pendingPanelTab` note
  (initializer + reactive one-shot consume), the relocated-dispatch contract statement
  ("every relocated/added control reuses an existing store dispatch byte-for-byte; new store
  surface = sceneOverlay only"), the `HOURS_PER_MONTH`/`isEntryBlueprint`/
  `frontlineCapacityRps`/`populationLanding` derived additions, the SpecBar carry-forward
  retirement (consumed by RegionOverlay), and the decision-12 region-view shimmer no-op.
- `.superpowers/sdd/progress.md` — `## POLISH 2` phase summary + open items + drift state
  (expected: none) — written at the phase gate, after the final review.

### Step 7.5 — verify

```bash
npx vitest run
npm run build
```

### Step 7.6 — PHASE GATE (live, fresh session, zero console errors — controller runs it)

The spec's full story, in order, screenshotting every new surface dark AND light into
`.superpowers/sdd/screenshots/polish2-*`:

- [ ] Open the multi-region failover example.
- [ ] Tap us-east-1 → overlay chips/role/capacity · hold the pin → ring charges → region
      view opens → back.
- [ ] Tap São Paulo → drag rps slider (hint updates) → release → Traffic tab shows the value.
- [ ] Traffic hero → 12,000 → warning wording.
- [ ] Simulate → world summary rolls · health dots ripple · kill eu-west-1 from its overlay
      → arcs re-route (TTL story) → restore.
- [ ] Tab ink slides across all seven tabs (hover previews, leave returns).
- [ ] AZ canvas: unblocked edges shimmer while flow runs; blocked edge stays static red.
- [ ] Firewall sentences + topology words (T6 story still green through the motion pass).
- [ ] Reduced-motion pass: hold ring still sweeps; ripple/roll/ink/shimmer static.
- [ ] Light-mode pass over overlays, summary strip, hero, sentence rows, firewall sentences.
- [ ] Zero app console errors across the whole story.

**Commit:** `feat(motion): app-wide motion pass — tab ink, press states, health ripples, flow shimmer`
(docs commit alongside: module-boundaries §Q + progress.md at the gate.)
