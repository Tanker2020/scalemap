# Phase 2 plan fragment — Tasks 13–18 (UI + AZ overlay + scrubber/inspector v2 + cost v2 + legacy deletion + perf/final verify)

> Fragment scope: this file contains ONLY Task 13 through Task 18. It assumes Tasks 1–12 are
> already implemented per `phase2-plan-skeleton.md` (engine subsystems, `WorldEngineApi` facade
> at `src/lib/worldEngine/index.ts`, and `src/app/store/simulation.store.ts` rewritten to v2).
> The controller owns assembling this with the other fragments and the shared Global
> Constraints / File Structure header — this file does not repeat those verbatim.

## SKELETON CONCERNS

1. **Build cannot stay green from T12 through T17 unless T12 already fixed a legacy straggler.**
   `src/lib/costModel.ts` (v1 cost model, on the T17 deletion list) does
   `import type { NodeMetrics } from '../app/store/simulation.store'`. T12 rewrites
   `simulation.store.ts` to the v2 shape ("old shape retired") — `NodeMetrics` (the old
   per-node metrics type) will not exist in that file anymore. Verified by grep against the
   actual repo: every other file that imports the old `NodeMetrics`/`useSimulationStore` shape
   lives inside `src/app/canvas/**`, `src/app/simulation/**`, `src/app/sidebar/**`,
   `src/app/toolbar/**`, `src/app/dock/**`, `src/app/reports/**` (all deleted wholesale in T17)
   or is `src/lib/scalescript.ts` (also deleted in T17) — `costModel.ts`/`costModel.test.ts`/
   `costModel.compute.test.ts` are the only stragglers **outside** those directories. Since the
   skeleton sequences legacy deletion at T17 (after T13–T16, "so nothing mounted references
   legacy code"), `npm run build` cannot actually be green between T12 landing and T17 running
   unless T12's own implementer applied a Phase-1-Task-9-style "fix each importer, keep
   compiling" patch to `costModel.ts` (or simply left it broken and accepted a red build for
   several tasks, which contradicts "suite stays green throughout"). This fragment's T13–T16
   "verify build green" steps assume that gap was already closed by T12. If it wasn't, the fix
   is a minimal edit to `costModel.ts` (stop importing `NodeMetrics`, inline the two or three
   fields it actually uses) — not a full deletion, which is still T17's job.

2. **The frozen contracts' "Store publication" section says the store holds "exactly" 5
   fields, but T15 and T18 (both in this same skeleton) require more.** The contracts doc says
   `simulation.store.ts` holds "exactly: `running`, `timeScale`, `latestBatch`, `events`,
   `healthOverrides`, and actions mirroring `WorldEngineApi` control calls." T15's own spec
   text says "store gains `scrubIndex: number | null`" (plus, by necessity, a `scrubBatch` the
   views read). T18 needs a `degraded` store flag. I'm treating these as sanctioned additive
   extensions — consistent with the contracts doc's opening line ("Additive extension (new
   optional fields) is allowed") even though that line is written under the `types.ts` section,
   not this one — since refusing to add them would contradict two explicit, later-numbered
   skeleton tasks. Flagging the literal tension rather than silently resolving it.

3. **T18's "T12 built the hook" claim isn't in T12's own spec text.** My dispatch instructions
   say "degradation logic lives in the facade (T12 built the hook — your task wires threshold +
   store flag + SimControls chip)." But T12's skeleton spec (lines 192–196) never mentions a
   perf/degradation hook, rolling-mean-step-cost tracking, or an `engine_degraded` event — only
   Global Constraints line 21 and spec decision 9 mention step-rate degradation at all, and
   neither is listed as T12's deliverable. I'm taking the dispatch instructions as authoritative
   (T12 already implements the rolling-mean watch + the actual `stepMs` 100→200 halving + emits
   `engine_degraded`) and scoping T18 to the thin store-flag + chip wiring + the bench test, per
   those instructions. Flagging so whoever actually implements/reviews T12 knows this behavior
   must exist there, since neither T12's task text nor the frozen contracts assign it anywhere
   else.

4. **Bench file naming conflicts with itself.** The skeleton's file-structure block (line 53)
   names the perf bench `bench/enginePerf.bench.ts`; T18's task text (line 219) calls it "a
   plain vitest test with generous timeout, tagged `bench.test.ts`". These are incompatible:
   Vitest's default `include` glob is `**/*.{test,spec}.?(c|m)[jt]s?(x)` — a bare `*.bench.ts`
   file is **excluded** from `npx vitest run` and is instead Vitest's own separate `bench()`-API
   convention (run via `vitest bench`, a benchmark.js-style reporter, not `expect()`
   pass/fail). The task text wants real assertions ("assert mean step ≤4ms... fail only >8ms")
   running under the normal suite. Resolved below by naming the file
   `bench/enginePerf.bench.test.ts` — keeps the skeleton's "bench" naming intent *and* Vitest's
   default `*.test.ts` inclusion, using plain `describe/it/expect`.

5. **Pre-existing Phase-1 naming mismatch would silently zero out managed-service cost.**
   `src/app/world/panels/PlacementPanel.tsx`'s `MANAGED_TYPES` constant (already in the repo,
   Task 12 of Phase 1) is `['rds', 's3', 'sqs', 'redis', 'cdn', 'apiGateway', 'lambda']` — these
   strings are written verbatim into `ManagedService.nodeType`. `src/lib/cloudRegistry.ts`'s
   actual `CLOUD_REGISTRY` keys are the canonical `NodeType`s: `dbSql`, `objectStorage`,
   `queue`, `redis`, `cdn`, `apiGateway`, `lambda`. Three of the seven (`rds`/`s3`/`sqs`) don't
   match any `CLOUD_REGISTRY` key, so `getServiceSpec('rds', provider)` returns `undefined` and
   those managed services would cost $0 with no indication why. Not a skeleton defect (the
   skeleton doesn't mention this), but it directly affects Task 16's correctness — resolved
   there with a small alias table, documented in that task's code.

6. **`ui.store.ts`'s "trimmed to fields world UI uses" survivor set is smaller than Phase 1's
   own note implied.** Phase 1's module-boundaries.md §C says `highlightedNodeIds`/
   `setHighlightedNodes` "survived" the linter deletion, "kept for reuse by whatever panel wants
   that behavior next." Verified by grep against the actual repo: **nothing** under
   `src/app/world/` or `src/App.tsx` reads `highlightedNodeIds` or any other `ui.store` field
   except `themeMode`/`setThemeMode` — every other field (`activeTool`, sidebars, `rightTab`,
   selected node/edge, `gridEnabled`, `connectSourceId`, `contextMenu`, `simConfigOpen`,
   `simConfigPanelNodeId`, `dockOpen`/`dockTab`, `packetEditorOpen`, `highlightedNodeIds`) is
   read only by files inside the directories T17 deletes. Task 17 trims `ui.store.ts` to
   `themeMode`/`setThemeMode` only — Phase 1's anticipated reuse of `highlightedNodeIds` never
   materialized in Phases 1–2; a future phase that wants a "focus this node" pulse can re-add it
   then.

7. **"Failover with TTL lag visible" (Global Constraints line 21, T18's smoke) cannot be
   demonstrated through Phase 2's real UI surface as specced, for two compounding reasons.**
   First, Phase 1's own plan explicitly defers all routing/traffic config UI (which includes
   authoring a named `ClientPopulation`) to Phase 4/5: *"Routing/traffic config UI is
   intentionally absent in Phase 1... the editing surface belongs to the region page in Phase 4
   and the globe in Phase 5. Do not add ad-hoc UI for it here."* Decision 11 (Phase 2's own
   spec) likewise lists no population-authoring control for Phase 2. Second, and independently,
   `tasks-01-05.md`'s controller ruling #1 states baseline (auto) populations "bypass DNS
   resolution entirely; T12's facade routes them directly to their own region" — they exist to
   seed ambient load, not to exercise geo-routing/failover at all. Put together: there is no
   population in a Phase-2-authorable world that ever re-resolves across regions, and no UI to
   add one. Resolved in Task 18 with a `import.meta.env.DEV`-gated debug hook
   (`window.__scalemapDebug`) exposing the *already-built* `useWorldStore`/`useSimulationStore`
   hooks — not new product functionality, just enough to let the live smoke call the existing
   `addPopulation` store action once (to seed a single real, cross-region-eligible population)
   before triggering the region-outage toggle Task 14 adds as real UI. Escalate if a real
   product decision is wanted here instead (e.g., explicitly allowing minimal population UI in
   Phase 2).

## Assumed `simulation.store.ts` v2 surface (T12, out of this fragment's scope)

Restated here because Tasks 13–18 all write code against it and T12's own spec text doesn't
spell out action names beyond "mirroring `WorldEngineApi` control calls." If T12 landed with
different names, only the call sites below need adjusting — nothing in this fragment's design
depends on the exact names.

```ts
import type {
  MetricsBatch, EngineEvent, RenderScope, FramePayload, DetachFn, ReplayFrame, TracedRequest,
} from '../../lib/worldEngine/types'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'

interface SimulationStoreV2 {
  running: boolean
  timeScale: number
  latestBatch: MetricsBatch | null
  events: EngineEvent[]                        // ring, cap 500, oldest → newest
  healthOverrides: Record<string, boolean>      // manual outage flags, keyed by entity id
  scrubIndex: number | null                     // added by Task 15
  scrubBatch: MetricsBatch | null               // added by Task 15, computed at setScrubIndex time
  degraded: boolean                             // added by Task 18

  start: (doc: WorldDoc, compiled: CompiledWorld) => void   // builds EngineCallbacks internally, calls the facade
  stop: () => void
  setTimeScale: (scale: number) => void
  setOutage: (scope: 'server' | 'az' | 'region', id: string, down: boolean) => void
  setScrubIndex: (i: number | null) => void                  // added by Task 15
  attachRenderer: (scope: RenderScope, onFrame: (p: FramePayload) => void) => DetachFn
  getReplayFrames: () => ReplayFrame[]
  getTracedRequests: (scope: RenderScope) => TracedRequest[]
}
```

---

### Task 13: UI — sim controls, events tab, live metrics cards [sonnet + live smoke]

**Files:**
- Create: `src/app/world/SimControls.tsx`
- Create: `src/app/world/SimControls.test.tsx`
- Create: `src/app/world/EventsTab.tsx`
- Modify: `src/app/world/panels/WorldPanel.tsx` (add `Events` tab, add a `running` editing-lock gate)
- Modify: `src/app/world/WorldShell.tsx` (mount `<SimControls />` in the header, pass `running` to `WorldPanel`)
- Modify: `src/app/world/GlobeView.tsx` (live rps/err/health per region card)
- Modify: `src/app/world/RegionView.tsx` (live rps/err/health per AZ card)

**Interfaces:**
- Consumes: `useSimulationStore` (assumed v2 surface above), `useWorldStore`, `useCompiledWorld`.
- Produces: `<SimControls />` (Simulate/Stop + timeScale select + running dot), `<EventsTab />`
  (severity-colored event feed, newest first), `WorldPanel`'s new `running: boolean` prop that
  disables every authoring control while a sim is running (same editing-lock *intent* as the
  legacy `canvas.store`'s `running` gate documented in `docs/module-boundaries.md` §1A, but
  implemented with a single `<fieldset disabled={running}>` wrapper rather than per-action
  checks — `TopologyPanel`/`BlueprintPanel`/`PlacementPanel`'s controls are all native
  `<button>`/`<input>`/`<select>` elements, which HTML's `fieldset disabled` already cascades
  into automatically with zero changes to those three files).

- [ ] **Step 1: Write the failing `SimControls` test**

```tsx
// src/app/world/SimControls.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false, timeScale: 1 })
})

describe('SimControls', () => {
  it('calls start with the current doc + compiled world when clicking Simulate', () => {
    const startSpy = vi.spyOn(useSimulationStore.getState(), 'start').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.click(screen.getByText('Simulate'))
    expect(startSpy).toHaveBeenCalledTimes(1)
    const [doc, compiled] = startSpy.mock.calls[0]
    expect(doc).toBe(useWorldStore.getState().doc)
    expect(compiled.instances).toEqual({})   // fresh world → compileWorld returns no instances
  })

  it('shows Stop and calls stop() when running', () => {
    useSimulationStore.setState({ running: true })
    const stopSpy = vi.spyOn(useSimulationStore.getState(), 'stop').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.click(screen.getByText('Stop'))
    expect(stopSpy).toHaveBeenCalledTimes(1)
  })

  it('changes timeScale via the select while running', () => {
    useSimulationStore.setState({ running: true })
    const setTimeScaleSpy = vi.spyOn(useSimulationStore.getState(), 'setTimeScale').mockImplementation(() => {})
    render(<SimControls />)
    fireEvent.change(screen.getByLabelText('time-scale'), { target: { value: '4' } })
    expect(setTimeScaleSpy).toHaveBeenCalledWith(4)
  })

  it('disables the timeScale select while stopped', () => {
    render(<SimControls />)
    expect(screen.getByLabelText('time-scale')).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: FAIL — `Cannot find module './SimControls'`

- [ ] **Step 3: Write `SimControls.tsx`**

```tsx
// src/app/world/SimControls.tsx
// Simulate/Stop + timeScale controls for WorldShell's header. Never touches the engine facade
// directly — contracts: "views... read this store; only control actions call the facade."
// (T18 later adds a `degraded` amber chip here once simulation.store gains that field — not
// this task's job; see Task 18.)
import type { CSSProperties } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import { useWorldStore } from '../store/world.store'
import { useCompiledWorld } from './useCompiledWorld'

const btn: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const btnRunning: CSSProperties = { ...btn, color: 'var(--color-danger)', border: '1px solid var(--color-danger)' }
const selectStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 6px', font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}

export function SimControls() {
  const running = useSimulationStore(s => s.running)
  const timeScale = useSimulationStore(s => s.timeScale)
  const start = useSimulationStore(s => s.start)
  const stop = useSimulationStore(s => s.stop)
  const setTimeScale = useSimulationStore(s => s.setTimeScale)
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const reduced = useReducedMotion()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {running && (
        <motion.span
          aria-hidden
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-success)' }}
          animate={reduced ? { opacity: 1 } : { opacity: [1, 0.35, 1] }}
          transition={reduced ? undefined : { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <button
        style={running ? btnRunning : btn}
        onClick={() => (running ? stop() : start(doc, compiled))}
      >
        {running ? 'Stop' : 'Simulate'}
      </button>
      <select
        aria-label="time-scale"
        style={selectStyle}
        value={timeScale}
        disabled={!running}
        onChange={e => setTimeScale(Number(e.target.value))}
      >
        <option value={1}>1x</option>
        <option value={2}>2x</option>
        <option value={4}>4x</option>
      </select>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Write `EventsTab.tsx`**

```tsx
// src/app/world/EventsTab.tsx
// WorldPanel's Events tab: the store's `events` ring (contracts: cap 500, oldest→newest),
// rendered newest-first with severity-colored left borders.
import { useSimulationStore } from '../store/simulation.store'
import { sectionLabel } from './panels/panelStyles'

const SEVERITY_COLOR: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--color-text-muted)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
}

export function EventsTab() {
  const events = useSimulationStore(s => s.events)
  const ordered = [...events].reverse()

  return (
    <div>
      <div style={sectionLabel}>Events ({events.length})</div>
      {ordered.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)' }}>No events yet — start the simulation.</div>
      )}
      {ordered.map(e => (
        <div key={e.id} style={{
          marginBottom: 6, borderLeft: `2px solid ${SEVERITY_COLOR[e.severity]}`, paddingLeft: 6,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: SEVERITY_COLOR[e.severity] }}>
            <span>{e.kind}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{(e.simMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)' }}>{e.message}</div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Add the Events tab + running gate to `WorldPanel.tsx`**

Current `src/app/world/panels/WorldPanel.tsx` (from Phase 1 Task 11/final-review batch):

```tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'findings'

export function WorldPanel() {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'findings', label: `Findings (${findings.length})` },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', border: '1px solid var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'topology' && <TopologyPanel />}
      {tab === 'blueprints' && <BlueprintPanel />}
      {tab === 'placements' && <PlacementPanel />}
      {tab === 'findings' && (
        <div>
          <div style={sectionLabel}>Findings</div>
          {findings.length === 0 && (
            <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
          )}
          {findings.map(f => (
            <div key={f.id} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)',
                  color: '#fff',
                  background: f.severity === 'error' ? 'var(--color-danger)' : 'var(--color-warning)',
                }}>{f.severity}</span>
                <span style={{ color: 'var(--color-text-secondary)' }}>{f.kind}</span>
              </div>
              <div style={{ marginTop: 2 }}>{f.message}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
```

Replace it wholesale with:

```tsx
import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { EventsTab } from '../EventsTab'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'findings' | 'events'

export function WorldPanel({ running }: { running: boolean }) {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'findings', label: `Findings (${findings.length})` },
    { id: 'events', label: 'Events' },
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
        {tab === 'findings' && (
          <div>
            <div style={sectionLabel}>Findings</div>
            {findings.length === 0 && (
              <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
            )}
            {findings.map(f => (
              <div key={f.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)',
                    color: '#fff',
                    background: f.severity === 'error' ? 'var(--color-danger)' : 'var(--color-warning)',
                  }}>{f.severity}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{f.kind}</span>
                </div>
                <div style={{ marginTop: 2 }}>{f.message}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'events' && <EventsTab />}
      </fieldset>
    </aside>
  )
}
```

- [ ] **Step 7: Mount `SimControls` and pass `running` in `WorldShell.tsx`**

In `src/app/world/WorldShell.tsx`, add two imports:

```ts
import { SimControls } from './SimControls'
import { useSimulationStore } from '../store/simulation.store'
```

Add inside the component body (alongside the existing `dirty`/`fileError` state):

```ts
const running = useSimulationStore(s => s.running)
```

Change the header's `<Breadcrumb />` line to render `SimControls` between the breadcrumb and
the existing right-side file-actions cluster:

```tsx
<Breadcrumb />
<SimControls />
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  {/* ...unchanged: esc hint, dirty dot, New/Open/Save/Save As... */}
</div>
```

And change the `<WorldPanel />` call at the bottom to:

```tsx
<WorldPanel running={running} />
```

- [ ] **Step 8: Live metrics on `GlobeView.tsx`'s region cards**

In `src/app/world/GlobeView.tsx`, add the import and a health-color map:

```ts
import { useSimulationStore } from '../store/simulation.store'
```

```ts
const HEALTH_COLOR = { healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)' } as const
```

Inside `GlobeView()`, add:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

Change the region card's body from:

```tsx
<button key={r.id} style={card} onClick={() => goRegion(r.id)}>
  <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
  <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
  </div>
</button>
```

to:

```tsx
<button key={r.id} style={card} onClick={() => goRegion(r.id)}>
  <div style={{ fontWeight: 600 }}>{r.catalogId}</div>
  <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {azs.length} AZ · {serverCount} server{serverCount === 1 ? '' : 's'} · {r.role}
  </div>
  {latestBatch?.regions[r.id] && (
    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
      <span style={{ color: HEALTH_COLOR[latestBatch.regions[r.id].health] }}>● {latestBatch.regions[r.id].health}</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.regions[r.id].rps.toFixed(0)} rps</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.regions[r.id].errorRate * 100).toFixed(1)}% err</span>
    </div>
  )}
</button>
```

- [ ] **Step 9: Live metrics on `RegionView.tsx`'s AZ cards**

Same pattern in `src/app/world/RegionView.tsx` — add the `useSimulationStore` import and
`HEALTH_COLOR` map, add `const latestBatch = useSimulationStore(s => s.latestBatch)`, and change
the AZ card body from:

```tsx
<button key={az.id} style={card} onClick={() => goAz(regionId, az.id)}>
  <div style={{ fontWeight: 600 }}>{az.label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} instance{instanceCount === 1 ? '' : 's'}
  </div>
</button>
```

to:

```tsx
<button key={az.id} style={card} onClick={() => goAz(regionId, az.id)}>
  <div style={{ fontWeight: 600 }}>{az.label}</div>
  <div style={{ color: 'var(--color-text-muted)', marginTop: 8 }}>
    {servers.length} server{servers.length === 1 ? '' : 's'} · {instanceCount} instance{instanceCount === 1 ? '' : 's'}
  </div>
  {latestBatch?.azs[az.id] && (
    <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
      <span style={{ color: HEALTH_COLOR[latestBatch.azs[az.id].health] }}>● {latestBatch.azs[az.id].health}</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{latestBatch.azs[az.id].rps.toFixed(0)} rps</span>
      <span style={{ color: 'var(--color-text-secondary)' }}>{(latestBatch.azs[az.id].errorRate * 100).toFixed(1)}% err</span>
    </div>
  )}
</button>
```

- [ ] **Step 10: Verify build + tests**

Run: `npx vitest run src/app/world/SimControls.test.tsx` → PASS (4 tests)
Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green (see Task 17's SKELETON CONCERN #1 if `costModel.test.ts` fails here)

- [ ] **Step 11: Live Playwright smoke** (dev server, strict port 1420)

1. Start the dev server in the background: Bash `npm run dev` with `run_in_background: true`.
   Wait for `Local:   http://localhost:1420/` in its output before proceeding.
2. `browser_navigate` → `http://localhost:1420`.
3. `browser_snapshot` → confirm the Home screen ("scalemap" logo, "New World" button).
4. `browser_click` "New World" → confirm the breadcrumb reads "World" and GlobeView shows
   "No regions yet".
5. In the WorldPanel's Topology tab: `browser_select_option` the `add-region-select` to
   `us-east-1`, `browser_click` "+ Region"; `browser_click` "+ AZ" (under the new region card);
   `browser_click` "+ Server" (uses the default `vps-medium` preset).
6. Switch WorldPanel to the Blueprints tab (`browser_click` "Blueprints"); `browser_type` "web"
   into the "new blueprint name" field, `browser_click` "+ Blueprint".
7. Switch to the Placements tab (`browser_click` "Placements"); `browser_click` "+ Place" under
   the `web` blueprint card.
8. `browser_click` "Simulate" in the header. `browser_snapshot` → confirm the button now reads
   "Stop" and a running dot is present; confirm the Topology/Blueprints/Placements tab controls
   are now disabled (fieldset gate).
9. `browser_wait_for` ~3 seconds (allow at least one 1Hz metrics batch to publish).
10. `browser_snapshot` → confirm the GlobeView's region card now shows a health dot + "N rps" +
    "N% err" line that wasn't there before starting.
11. Switch WorldPanel to the new "Events" tab (`browser_click` "Events") → confirm at least one
    event row is rendered (any kind is fine — this world has no failure conditions configured,
    so events may just be routine health-check/breaker info-level entries; absence of ANY event
    after several seconds of a running sim would indicate a wiring bug worth investigating before
    proceeding).
12. `browser_console_messages` → assert zero `error`-level entries.
13. `browser_take_screenshot` → save to the scratchpad (e.g. `task13-running.png`).
14. `browser_click` "Stop" → confirm the button reads "Simulate" again and the running dot is
    gone; confirm the Topology tab controls are enabled again.
15. `browser_console_messages` again → assert zero new errors from the stop transition.
16. Stop the dev server (terminate the background Bash shell from step 1).

- [ ] **Step 12: Commit**

```bash
git add src/app/world/SimControls.tsx src/app/world/SimControls.test.tsx \
        src/app/world/EventsTab.tsx src/app/world/panels/WorldPanel.tsx \
        src/app/world/WorldShell.tsx src/app/world/GlobeView.tsx src/app/world/RegionView.tsx
git commit -m "feat(engine): add sim controls, events tab, and live metrics cards"
```

---

### Task 14: AZ canvas sim overlay [sonnet + live smoke]

**Files:**
- Create: `src/app/world/AzSimOverlay.tsx`
- Modify: `src/app/world/AzCanvas.tsx` (mount the overlay; pass live `health`/`cpuPct`/`ramUsedMb`/`ramTotalMb` into server node data)
- Modify: `src/app/world/WorldServerNode.tsx` (extend `WorldServerNodeData` additively; render health-tinted border + a CPU/RAM line)
- Modify: `src/app/world/RegionView.tsx` (add a manual region-outage toggle — see note below)

**Design note (documented, not a skeleton concern):** decision 11's Phase-2 UI list doesn't
itemize a manual-outage control, but the contracts' `setOutage` is a first-class part of
`WorldEngineApi`, Global Constraints line 21 requires step-rate degradation to be *observable*,
and — more concretely — Task 15's and Task 18's live smokes both require an "outage moment" to
scrub back to / a failover to demonstrate. A single region-level toggle is the smallest UI
surface that exercises this: region scope (rather than AZ or server) is what actually produces
the TTL-gated cross-region re-resolution decision 7 describes, and `RegionView.tsx` is the
existing page for "this region." AZ-internal drain (down AZ → same-region re-split, ~2s) doesn't
need a manual switch for Task 14's own smoke below — that one uses the *already-existing*
Phase-1 firewall "deny" rule to produce a blocked path, which is a different (and already-built)
mechanism.

**Interfaces:**
- Consumes: `attachRenderer({level:'az', azId}, onFrame)` from `simulation.store` (per-frame
  `FramePayload`), `@xyflow/react`'s `useReactFlow()`/`useViewport()`, `latestBatch.servers`.
- Produces: `<AzSimOverlay azId={string} />` — an absolutely-positioned `<canvas>` drawing
  `VisualParticle`s along server-pair screen positions; `WorldServerNodeData` additively gains
  `health?: HealthState`, `cpuPct?: number`, `ramUsedMb?: number`, `ramTotalMb?: number`.

- [ ] **Step 1: Write `AzSimOverlay.tsx`**

```tsx
// src/app/world/AzSimOverlay.tsx
// Canvas overlay for the focused AZ: draws live particles from the engine's per-frame
// attachRenderer payload along the same server-pair positions AzCanvas lays its nodes out at.
// Read-only, pointer-events: none — all real interaction stays on the ReactFlow pane underneath.
import { useEffect, useRef } from 'react'
import { useReactFlow, useViewport } from '@xyflow/react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { VisualParticle } from '../../lib/worldEngine/types'

// Approximate on-screen footprint of WorldServerNode/WorldManagedNode. React Flow only reports
// *measured* dimensions once a node has actually painted; this overlay must be able to draw on
// frame 1, so a fixed approximation is used instead of waiting on measurement. Good enough for a
// Phase-2 "minimal, contracts-shaped" overlay — Phase 4/5 can read real measured dimensions.
const SERVER_W = 220, SERVER_H = 96
const MANAGED_W = 170, MANAGED_H = 60

const PROTOCOL_COLOR: Record<VisualParticle['protocol'], string> = {
  http: '#4A9EFF', db: '#F5A623', event: '#A78BFA', stream: '#2DD4BF',
}

interface Props { azId: string }

export function AzSimOverlay({ azId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { getNode } = useReactFlow()
  const viewport = useViewport()
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion()
  const lastDrawRef = useRef(0)

  // Keep the canvas's pixel buffer matched to its container — avoids CSS-stretch distortion,
  // which would otherwise throw off the screen-space math below.
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const resize = () => { canvas.width = parent.clientWidth; canvas.height = parent.clientHeight }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!running) {
      const ctx = canvasRef.current?.getContext('2d')
      if (ctx && canvasRef.current) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
      return
    }

    const detach = useSimulationStore.getState().attachRenderer({ level: 'az', azId }, (payload) => {
      // Reduced-motion: throttle redraws to ~2/sec (still shows real, current state, just not
      // smooth motion) rather than fully suppressing the visualization — this canvas IS the
      // simulation's primary information channel here, not decorative chrome.
      const now = performance.now()
      if (reduced && now - lastDrawRef.current < 500) return
      lastDrawRef.current = now

      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const toScreen = (id: string, fallback: { x: number; y: number }) => {
        if (id.startsWith('edge:')) return { x: -40 * viewport.zoom + viewport.x, y: fallback.y }
        const node = getNode(id)
        if (!node) return fallback
        const w = node.type === 'worldManaged' ? MANAGED_W : SERVER_W
        const h = node.type === 'worldManaged' ? MANAGED_H : SERVER_H
        return {
          x: (node.position.x + w / 2) * viewport.zoom + viewport.x,
          y: (node.position.y + h / 2) * viewport.zoom + viewport.y,
        }
      }

      for (const p of payload.particles) {
        const to = toScreen(p.toId, { x: canvas.width / 2, y: canvas.height / 2 })
        const from = toScreen(p.fromId, to)
        const x = from.x + (to.x - from.x) * p.progress
        const y = from.y + (to.y - from.y) * p.progress

        if (p.blocked && p.progress > 0.85) {
          const burst = (p.progress - 0.85) / 0.15
          ctx.beginPath()
          ctx.arc(to.x, to.y, 4 + burst * 10, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(239, 68, 68, ${1 - burst})`   // var(--color-danger) #EF4444
          ctx.lineWidth = 2
          ctx.stroke()
          continue
        }

        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fillStyle = p.colorHint ?? PROTOCOL_COLOR[p.protocol]
        ctx.fill()
      }
    })

    return detach
  }, [running, azId, getNode, viewport, reduced])

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  )
}
```

- [ ] **Step 2: Extend `WorldServerNodeData` and render health tint + CPU/RAM in `WorldServerNode.tsx`**

Current `src/app/world/WorldServerNode.tsx`:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Server } from '../../lib/world/types'

export interface WorldServerNodeData {
  server: Server
  chips: { color: string; name: string; role: string; runtime: string }[]
  internalBlocked: number
  [key: string]: unknown
}

export function WorldServerNode({ data }: NodeProps) {
  const { server, chips, internalBlocked } = data as WorldServerNodeData
  return (
    <div style={{
      width: 220, background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>{server.label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{server.kind}</span>
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
        {server.specs.vcpu} vCPU · {Math.round(server.specs.ramMb / 1024)} GB · {server.firewall.length} fw rules
      </div>
      {chips.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
          <span>{c.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{c.role} · {c.runtime}</span>
        </div>
      ))}
      {chips.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>empty</div>}
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 10, marginTop: 4 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
```

(`WorldManagedNode` below it is unchanged.) Replace `WorldServerNodeData` and `WorldServerNode` with:

```tsx
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Server } from '../../lib/world/types'
import type { HealthState } from '../../lib/worldEngine/types'

export interface WorldServerNodeData {
  server: Server
  chips: { color: string; name: string; role: string; runtime: string }[]
  internalBlocked: number
  health?: HealthState
  cpuPct?: number
  ramUsedMb?: number
  ramTotalMb?: number
  [key: string]: unknown
}

const HEALTH_BORDER: Record<HealthState, string> = {
  healthy: '1px solid var(--color-node-border)',
  degraded: '1px solid var(--color-warning)',
  down: '1px solid var(--color-danger)',
}

export function WorldServerNode({ data }: NodeProps) {
  const { server, chips, internalBlocked, health, cpuPct, ramUsedMb, ramTotalMb } = data as WorldServerNodeData
  return (
    <div style={{
      width: 220, background: 'var(--color-node-base)', border: HEALTH_BORDER[health ?? 'healthy'],
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    }}>
      <Handle type="target" position={Position.Left} />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>{server.label}</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>{server.kind}</span>
      </div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
        {server.specs.vcpu} vCPU · {Math.round(server.specs.ramMb / 1024)} GB · {server.firewall.length} fw rules
      </div>
      {cpuPct !== undefined && (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginBottom: 6 }}>
          CPU {cpuPct.toFixed(0)}% · RAM {Math.round(ramUsedMb ?? 0)}/{Math.round(ramTotalMb ?? 0)} MB
        </div>
      )}
      {chips.map((c, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: c.color, flexShrink: 0 }} />
          <span>{c.name}</span>
          <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>{c.role} · {c.runtime}</span>
        </div>
      ))}
      {chips.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>empty</div>}
      {internalBlocked > 0 && (
        <div style={{ color: 'var(--color-danger)', fontSize: 10, marginTop: 4 }}>
          ✕ {internalBlocked} blocked internal path{internalBlocked > 1 ? 's' : ''}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
```

- [ ] **Step 3: Mount the overlay and feed live server data in `AzCanvas.tsx`**

In `src/app/world/AzCanvas.tsx`, add imports:

```ts
import { useSimulationStore } from '../store/simulation.store'
import { AzSimOverlay } from './AzSimOverlay'
```

Inside `AzCanvas()`, add:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

and add it to the `useMemo`'s dependency array (`[doc, compiled, azId, regionId, latestBatch]`).
Inside the server-node-building `.map`, extend the `data` object from:

```tsx
data: {
  server,
  chips: Object.values(compiled.instances)
    .filter(i => i.serverId === server.id)
    .map(i => {
      const bp = doc.blueprints[i.blueprintId]
      const pl = doc.placements[i.placementId]
      return { color: bp?.color ?? '#888', name: bp?.name ?? '?', role: i.role, runtime: pl?.runtime.type ?? 'process' }
    }),
  internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
},
```

to:

```tsx
data: {
  server,
  chips: Object.values(compiled.instances)
    .filter(i => i.serverId === server.id)
    .map(i => {
      const bp = doc.blueprints[i.blueprintId]
      const pl = doc.placements[i.placementId]
      return { color: bp?.color ?? '#888', name: bp?.name ?? '?', role: i.role, runtime: pl?.runtime.type ?? 'process' }
    }),
  internalBlocked: internalBlockedByServer.get(server.id) ?? 0,
  health: latestBatch?.servers[server.id]?.health,
  cpuPct: latestBatch?.servers[server.id]
    ? (latestBatch.servers[server.id].coreUtilization.reduce((a, b) => a + b, 0) /
       Math.max(1, latestBatch.servers[server.id].coreUtilization.length)) * 100
    : undefined,
  ramUsedMb: latestBatch?.servers[server.id]?.ramUsedMb,
  ramTotalMb: latestBatch?.servers[server.id]?.ramTotalMb,
},
```

Finally, change the returned JSX from:

```tsx
return (
  <div style={{ width: '100%', height: '100%' }}>
    <ReactFlow ...>
      <Background gap={24} color="var(--color-canvas-dots)" />
    </ReactFlow>
  </div>
)
```

to:

```tsx
return (
  <div style={{ width: '100%', height: '100%', position: 'relative' }}>
    <ReactFlow ...>
      <Background gap={24} color="var(--color-canvas-dots)" />
    </ReactFlow>
    <AzSimOverlay azId={azId} />
  </div>
)
```

(`...` = the existing `nodes`/`edges`/`nodeTypes`/`fitView`/`nodesDraggable`/`nodesConnectable`/
`onNodeClick`/`proOptions` props, unchanged.)

- [ ] **Step 4: Region-outage toggle in `RegionView.tsx`**

In `src/app/world/RegionView.tsx`, add the import:

```ts
import { useSimulationStore } from '../store/simulation.store'
```

Inside `RegionView()`, add:

```ts
const running = useSimulationStore(s => s.running)
const isDown = useSimulationStore(s => s.healthOverrides[regionId ?? ''] ?? false)
const setOutage = useSimulationStore(s => s.setOutage)
```

Change the region title line from:

```tsx
<div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 16 }}>
  {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
</div>
```

to:

```tsx
<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
  <div style={{ font: '600 14px var(--font-mono)', color: 'var(--color-text-primary)' }}>
    {doc.regions[regionId].catalogId} — {azs.length} availability zone{azs.length === 1 ? '' : 's'}
  </div>
  {running && (
    <button
      style={{
        background: 'var(--color-node-base)',
        border: `1px solid ${isDown ? 'var(--color-danger)' : 'var(--color-node-border)'}`,
        borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
        font: '11px var(--font-mono)', color: isDown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
      }}
      onClick={() => setOutage('region', regionId, !isDown)}
    >
      {isDown ? '✓ Clear region outage' : '⚡ Simulate region outage'}
    </button>
  )}
</div>
```

- [ ] **Step 5: Verify build**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green

- [ ] **Step 6: Live Playwright smoke**

1. Start the dev server in the background: `npm run dev`. Wait for the ready URL.
2. `browser_navigate` → `http://localhost:1420`.
3. `browser_click` "New World"; author a small AZ with two dependent blueprints so a path
   exists to break: add region `us-east-1` → "+ AZ" → "+ Server" twice (two servers in the AZ);
   Blueprints tab: create `api` and `pg`; expand `api`'s "▸ deps", click "+ Dependency" (defaults
   to targeting `pg` on port 8080/http — leave it, the block only needs SOME dependency path to
   exist); Placements tab: "+ Place" `api` onto server 1, "+ Place" `pg` onto server 2.
4. Navigate into the AZ (breadcrumb: click the region, then click an AZ card, or click "+ AZ"'s
   resulting AZ card from RegionView) so `AzCanvas`/`AzSimOverlay` are mounted.
   `browser_snapshot` → confirm two server nodes render with instance chips.
5. `browser_click` "Simulate" in the header.
6. `browser_wait_for` ~3 seconds. `browser_take_screenshot` → confirm particles are visible
   moving between the two server nodes (dots along the edge line) — save as
   `task14-particles-flowing.png`.
7. While still running, go back to the WorldPanel's Topology tab (fieldset-disabled per Task
   13 — confirm via snapshot that its controls are indeed disabled, then Stop the simulation via
   the header "Stop" button to re-enable editing), expand server 2 (`pg`'s server), add a
   firewall rule `deny :8080 tcp from any` ABOVE the default allow-all (use the `↑` reorder
   button so it evaluates first), then `browser_click` "Simulate" again to restart with the new
   topology.
8. `browser_wait_for` ~3 seconds. `browser_take_screenshot` → confirm a red burst animation is
   visible at the target server node (the now-blocked path) — save as
   `task14-blocked-path-burst.png`. Confirm the target server node's border reflects the block
   via the `internalBlocked`/edge styling already present from Phase 1 (same-server vs
   cross-server blocking renders per `AzCanvas.tsx`'s existing aggregation — since these two
   servers are different, this renders as a red dashed edge with `✕ firewall-deny`, consistent
   with Phase 1's AzCanvas behavior; `AzSimOverlay`'s red burst is the additional live-particle
   evidence this task adds).
9. `browser_console_messages` → assert zero errors.
10. Click "Stop". Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/AzSimOverlay.tsx src/app/world/AzCanvas.tsx \
        src/app/world/WorldServerNode.tsx src/app/world/RegionView.tsx
git commit -m "feat(engine): render AZ canvas particle overlay with health-tinted nodes"
```

---

### Task 15: Scrubber v2 + inspector v2 [sonnet + live smoke]

**Files:**
- Modify: `src/app/store/simulation.store.ts` (additive: `scrubIndex`, `scrubBatch`, `setScrubIndex`)
- Create: `src/app/world/ScrubberV2.tsx`
- Create: `src/app/world/InspectorV2.tsx`
- Modify: `src/app/world/WorldShell.tsx` (mount `<ScrubberV2 />` as a bottom bar)
- Modify: `src/app/world/AzCanvas.tsx` (mount `<InspectorV2 azId={azId} />`; swap `latestBatch` reads to `scrubBatch ?? latestBatch`)
- Modify: `src/app/world/GlobeView.tsx`, `src/app/world/RegionView.tsx` (swap `latestBatch` reads to `scrubBatch ?? latestBatch`, so scrubbing replays health/rps across every view, not just the AZ canvas)

**Interfaces:**
- Consumes: `getReplayFrames()`, `getTracedRequests(scope)` (both plain, non-reactive methods on
  the store per the assumed T12 surface — this task polls/snapshots them locally rather than
  expecting them to be reactive state).
- Produces: `store.scrubIndex: number | null`, `store.scrubBatch: MetricsBatch | null`,
  `store.setScrubIndex(i)` (looks up `getReplayFrames()[i]?.batch` and sets both fields
  atomically); `<ScrubberV2 />` — a bottom bar, visible only when `!running && frames.length > 0`,
  a horizontal strip of ticks colored by that frame's worst-AZ `healthScore`, click/drag to
  scrub; `<InspectorV2 azId={string} />` — lists `getTracedRequests({level:'az', azId})`,
  refreshed on a 1s poll, click a row to expand its hop table.

- [ ] **Step 1: Extend `simulation.store.ts` (additive)**

This is a modification to the file T12 already produced. Add to the store's public interface:

```ts
scrubIndex: number | null
scrubBatch: MetricsBatch | null
setScrubIndex: (i: number | null) => void
```

Add to its initial state:

```ts
scrubIndex: null,
scrubBatch: null,
```

Add the action (reads the facade's `getReplayFrames()` — already exposed on the store per the
assumed T12 surface):

```ts
setScrubIndex: (i) => {
  if (i == null) return set({ scrubIndex: null, scrubBatch: null })
  const frames = get().getReplayFrames()
  set({ scrubIndex: i, scrubBatch: frames[i]?.batch ?? null })
},
```

In whichever existing action resets run state on `start()` (T12's `start` action), add
`scrubIndex: null, scrubBatch: null` to that action's `set(...)` call, so starting a fresh run
always exits scrub mode.

- [ ] **Step 2: Write `ScrubberV2.tsx`**

```tsx
// src/app/world/ScrubberV2.tsx
// Bottom-bar playback scrubber. Shown only once replay frames exist and the sim is stopped
// (contracts: replay is a 1Hz, 300-frame ring — "scrubbing any level reads one frame").
import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useSimulationStore } from '../store/simulation.store'
import type { ReplayFrame } from '../../lib/worldEngine/types'

const HEALTH_TICK_COLOR = (score: number): string => {
  if (score >= 80) return 'var(--color-success)'
  if (score >= 40) return 'var(--color-warning)'
  return 'var(--color-danger)'
}

function worstAzHealthScore(frame: ReplayFrame): number {
  const scores = Object.values(frame.batch.azs).map(az => az.healthScore)
  return scores.length === 0 ? 100 : Math.min(...scores)
}

export function ScrubberV2() {
  const running = useSimulationStore(s => s.running)
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  const [frames, setFrames] = useState<ReplayFrame[]>([])
  const reduced = useReducedMotion()

  useEffect(() => {
    if (running) return
    setFrames(useSimulationStore.getState().getReplayFrames())
  }, [running])

  if (running || frames.length === 0) return null

  const pick = (clientX: number, target: HTMLDivElement) => {
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    setScrubIndex(Math.min(frames.length - 1, Math.floor(ratio * frames.length)))
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px',
      borderTop: '1px solid var(--color-toolbar-border)', background: 'var(--color-toolbar)',
      font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
    }}>
      <span>Replay</span>
      <div
        role="slider"
        aria-label="replay-scrubber"
        aria-valuemin={0}
        aria-valuemax={frames.length - 1}
        aria-valuenow={scrubIndex ?? frames.length - 1}
        style={{
          flex: 1, height: 18, display: 'flex', cursor: 'pointer', borderRadius: 3, overflow: 'hidden',
          border: '1px solid var(--color-node-border)',
        }}
        onClick={e => pick(e.clientX, e.currentTarget)}
      >
        {frames.map((f, i) => (
          <div
            key={f.simMs}
            style={{
              flex: 1, background: HEALTH_TICK_COLOR(worstAzHealthScore(f)),
              opacity: scrubIndex === i ? 1 : 0.55,
              transition: reduced ? undefined : 'opacity 120ms ease',
            }}
          />
        ))}
      </div>
      <span>{scrubIndex == null ? 'live' : `${(frames[scrubIndex].simMs / 1000).toFixed(1)}s`}</span>
      {scrubIndex != null && (
        <button
          style={{
            background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
            borderRadius: 4, padding: '2px 8px', cursor: 'pointer',
            font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
          }}
          onClick={() => setScrubIndex(null)}
        >
          Exit scrub
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Write `InspectorV2.tsx`**

```tsx
// src/app/world/InspectorV2.tsx
// AZ-view overlay listing traced requests for the focused AZ (contracts: "engine samples ≤1
// traced request per second per scope" — polled locally since getTracedRequests is a plain
// method, not reactive state).
import { useEffect, useState } from 'react'
import { useSimulationStore } from '../store/simulation.store'
import type { TracedRequest } from '../../lib/worldEngine/types'

const OUTCOME_COLOR: Record<TracedRequest['outcome'], string> = {
  ok: 'var(--color-success)', refused: 'var(--color-danger)',
  error: 'var(--color-danger)', timeout: 'var(--color-warning)',
}

interface Props { azId: string }

export function InspectorV2({ azId }: Props) {
  const [traces, setTraces] = useState<TracedRequest[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const poll = () => setTraces(useSimulationStore.getState().getTracedRequests({ level: 'az', azId }))
    poll()
    const id = setInterval(poll, 1000)
    return () => clearInterval(id)
  }, [azId])

  if (traces.length === 0) return null

  return (
    <div style={{
      position: 'absolute', left: 12, bottom: 12, width: 260, maxHeight: 260, overflowY: 'auto',
      background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
      borderRadius: 8, padding: 10, font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
      pointerEvents: 'auto',
    }}>
      <div style={{ font: '600 10px var(--font-mono)', color: 'var(--color-text-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
        Traced requests
      </div>
      {traces.map(t => (
        <div key={t.id} style={{ marginBottom: 6 }}>
          <button
            style={{
              display: 'flex', justifyContent: 'space-between', width: '100%',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: OUTCOME_COLOR[t.outcome], font: '11px var(--font-mono)',
            }}
            onClick={() => setExpandedId(id => id === t.id ? null : t.id)}
          >
            <span>{t.outcome}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{t.totalMs.toFixed(1)}ms</span>
          </button>
          {expandedId === t.id && (
            <div style={{ marginTop: 4, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
              {t.hops.map((h, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--color-text-secondary)' }}>
                  <span>{h.fromId} → {h.toId} ({h.hopClass})</span>
                  <span style={{ color: OUTCOME_COLOR[h.outcome] }}>{h.outcome} · {h.latencyMs.toFixed(1)}ms</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Mount `ScrubberV2` in `WorldShell.tsx`**

Add the import `import { ScrubberV2 } from './ScrubberV2'`. Change the outer return from:

```tsx
return (
  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
    <header>...</header>
    {fileError && (...)}
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <main>...</main>
      <WorldPanel running={running} />
    </div>
  </div>
)
```

to:

```tsx
return (
  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-canvas)' }}>
    <header>...</header>
    {fileError && (...)}
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <main>...</main>
      <WorldPanel running={running} />
    </div>
    <ScrubberV2 />
  </div>
)
```

- [ ] **Step 5: Mount `InspectorV2` and switch to `scrubBatch ?? latestBatch` in `AzCanvas.tsx`**

Add the import `import { InspectorV2 } from './InspectorV2'`. Change the batch selector from:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

to:

```ts
const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
```

and update every `latestBatch?.servers[...]` reference added in Task 14 to `batch?.servers[...]`
(three occurrences: `health`, `cpuPct`'s condition + computation, `ramUsedMb`/`ramTotalMb`).
Update the `useMemo` dependency array's `latestBatch` entry to `batch`. Change the returned JSX
from:

```tsx
<div style={{ width: '100%', height: '100%', position: 'relative' }}>
  <ReactFlow ...>
    <Background gap={24} color="var(--color-canvas-dots)" />
  </ReactFlow>
  <AzSimOverlay azId={azId} />
</div>
```

to:

```tsx
<div style={{ width: '100%', height: '100%', position: 'relative' }}>
  <ReactFlow ...>
    <Background gap={24} color="var(--color-canvas-dots)" />
  </ReactFlow>
  <AzSimOverlay azId={azId} />
  <InspectorV2 azId={azId} />
</div>
```

- [ ] **Step 6: Switch `GlobeView.tsx` and `RegionView.tsx` to `scrubBatch ?? latestBatch`**

In both files, change:

```ts
const latestBatch = useSimulationStore(s => s.latestBatch)
```

to:

```ts
const latestBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
```

(No other changes needed — both files already read `latestBatch` by that name from Task 13; this
swaps what the selector returns without touching the render logic below it. `RegionView.tsx`'s
Task 14 outage-toggle code stays reading `running`/`healthOverrides`/`setOutage` directly from
the store, unaffected by this swap.)

- [ ] **Step 7: Verify build**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green

- [ ] **Step 8: Live Playwright smoke**

1. Start the dev server in the background: `npm run dev`. Wait for the ready URL.
2. `browser_navigate` → `http://localhost:1420`. Author the same small two-server AZ world as
   Task 14's smoke (region → AZ → 2 servers → `api`/`pg` blueprints with a dependency → 2
   placements), and navigate into the AZ.
3. `browser_click` "Simulate". While running, go to RegionView (breadcrumb: click the region
   segment) and `browser_click` "⚡ Simulate region outage".
4. `browser_wait_for` ~10 seconds (accumulates ≥1 replay frame at the outage and several
   afterward — replay snapshots at 1Hz per contracts).
5. `browser_click` "Stop". `browser_snapshot` → confirm a bottom "Replay" scrubber bar is now
   present with colored ticks (it wasn't visible while running).
6. `browser_click` on an early (left-ish) tick in the scrubber strip — pick one that should
   correspond to the outage window. `browser_snapshot`/`browser_take_screenshot` → confirm at
   least one tick renders red/amber (worst-AZ healthScore dip) and that the label next to the
   strip shows a simulated-time value, not "live" — save as `task15-scrubbed-outage.png`.
7. Navigate back into the AZ (breadcrumb) → confirm the server nodes' health border reflects the
   scrubbed frame (not necessarily "live" state) and `InspectorV2`'s traced-request list is
   present in the bottom-left corner. `browser_click` one of its rows → confirm it expands into a
   hop table with `hopClass`/latency/outcome columns. `browser_take_screenshot` → save as
   `task15-trace-expanded.png`.
8. `browser_click` "Exit scrub" → confirm the scrubber label reads "live" again.
9. `browser_console_messages` → assert zero errors across the whole sequence.
10. Stop the dev server.

- [ ] **Step 9: Commit**

```bash
git add src/app/store/simulation.store.ts src/app/world/ScrubberV2.tsx \
        src/app/world/InspectorV2.tsx src/app/world/WorldShell.tsx \
        src/app/world/AzCanvas.tsx src/app/world/GlobeView.tsx src/app/world/RegionView.tsx
git commit -m "feat(engine): add replay scrubber v2 and traced-request inspector v2"
```

---

### Task 16: Cost model v2 + Cost tab [sonnet]

**Files:**
- Create: `src/lib/costModelV2.ts`
- Create: `src/lib/costModelV2.test.ts`
- Create: `src/app/world/CostTab.tsx`
- Create: `src/app/world/CostTab.test.tsx`
- Modify: `src/app/world/panels/WorldPanel.tsx` (add a `Cost` tab)

**Interfaces:**
- Consumes: `WorldDoc`, `WorldMetrics` (from `worldEngine/types`), `getServiceSpec`/
  `egressMonthlyCost` from `cloudRegistry.ts`.
- Produces: `computeWorldCost(doc: WorldDoc, world: WorldMetrics | null): { monthlyUsd,
  byRegion, byAz, egress }` exactly per the skeleton's signature; `<CostTab />`.

- [ ] **Step 1: Write the failing `costModelV2` test**

```ts
// src/lib/costModelV2.test.ts
import { describe, it, expect } from 'vitest'
import { computeWorldCost } from './costModelV2'
import { createWorld, createRegion, createAz, createServer } from './world/factories'
import { getPreset } from './world/instanceCatalog'
import type { WorldDoc } from './world/types'

function twoServerWorld(): { doc: WorldDoc; regionId: string; azId: string } {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  const s1 = createServer(az.id, getPreset('vps-medium')!)   // 0.036 usd/hr
  const s2 = createServer(az.id, getPreset('dedicated-8')!)  // 0.34 usd/hr
  doc.servers[s1.id] = s1
  doc.servers[s2.id] = s2
  return { doc, regionId: region.id, azId: az.id }
}

describe('computeWorldCost', () => {
  it('sums server hourly costs exactly (× 730 hr/mo), same total in byRegion and byAz', () => {
    const { doc, regionId, azId } = twoServerWorld()
    const result = computeWorldCost(doc, null)
    const expected = (0.036 + 0.34) * 730
    expect(result.monthlyUsd).toBeCloseTo(expected, 5)
    expect(result.byRegion).toEqual([{ regionId, monthlyUsd: expect.closeTo(expected, 5) }])
    expect(result.byAz).toEqual([{ azId, monthlyUsd: expect.closeTo(expected, 5) }])
  })

  it('null world metrics → egress is all zero', () => {
    const { doc } = twoServerWorld()
    const result = computeWorldCost(doc, null)
    expect(result.egress).toEqual({ crossAzUsd: 0, crossRegionUsd: 0, internetUsd: 0 })
  })

  it('resolves managed-service pricing via the rds/s3/sqs alias map, ignores generic provider', () => {
    const { doc, regionId, azId } = twoServerWorld()
    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'db', nodeType: 'rds', provider: 'aws',
      scope: { kind: 'az', azId }, port: 5432,
    }
    doc.managedServices['ms-2'] = {
      id: 'ms-2', label: 'generic-thing', nodeType: 'rds', provider: 'generic',
      scope: { kind: 'region', regionId }, port: 5432,
    }
    const withMs = computeWorldCost(doc, null)
    const withoutMs = computeWorldCost({ ...doc, managedServices: {} }, null)
    // ms-1 (aws/rds → dbSql) contributes a nonzero instanceHourly cost; ms-2 (generic) contributes $0.
    expect(withMs.monthlyUsd).toBeGreaterThan(withoutMs.monthlyUsd)
    const azDelta = withMs.byAz.find(a => a.azId === azId)!.monthlyUsd - withoutMs.byAz.find(a => a.azId === azId)!.monthlyUsd
    expect(azDelta).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: FAIL — `Cannot find module './costModelV2'`

- [ ] **Step 3: Write `costModelV2.ts`**

```ts
// src/lib/costModelV2.ts
// World-level monthly cost projection (spec decision 8): Σ server hourlyUsd×730 + managed
// service pricing (reused from cloudRegistry) + egress from live WorldMetrics byte rates.
import type { WorldDoc, RegionId, AzId } from './world/types'
import type { WorldMetrics } from './worldEngine/types'
import { getServiceSpec, egressMonthlyCost, type CloudProvider } from './cloudRegistry'

const HOURS_PER_MONTH = 730
const CROSS_AZ_USD_PER_GB = 0.01
const CROSS_REGION_USD_PER_GB = 0.02
const BYTES_PER_GB = 1024 ** 3
const SECONDS_PER_MONTH = 2_630_000   // spec decision 8's documented ~30.4-day constant

// PlacementPanel.tsx's managed-service picker (Phase 1) stores a handful of short,
// human-friendly nodeType strings ('rds', 's3', 'sqs') that predate — and don't match —
// CLOUD_REGISTRY's actual keys ('dbSql', 'objectStorage', 'queue'). This alias table bridges
// the two so managed-service pricing actually resolves instead of silently pricing at $0. If
// PlacementPanel's MANAGED_TYPES ever changes to use canonical NodeTypes directly, every entry
// below becomes an identity no-op.
const MANAGED_TYPE_ALIASES: Record<string, string> = {
  rds: 'dbSql', s3: 'objectStorage', sqs: 'queue',
  redis: 'redis', cdn: 'cdn', apiGateway: 'apiGateway', lambda: 'lambda',
}

export interface WorldCostResult {
  monthlyUsd: number
  byRegion: { regionId: RegionId; monthlyUsd: number }[]
  byAz: { azId: AzId; monthlyUsd: number }[]
  egress: { crossAzUsd: number; crossRegionUsd: number; internetUsd: number }
}

function managedServiceMonthlyUsd(nodeType: string, provider: CloudProvider): number {
  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[nodeType] ?? nodeType, provider)
  if (!spec) return 0   // 'generic' provider or unmapped nodeType — documented Phase-2 $0
  let usd = 0
  for (const c of spec.pricing) {
    if (c.kind === 'instanceHourly') usd += c.defaultRateUsdHr * c.defaultCount * HOURS_PER_MONTH
    else if (c.kind === 'fixedMonthly') usd += c.usd
    // requestsPerMillion / storageGbMonth / computeResource / egress: skipped in Phase 2 — no
    // per-service traffic volume or provisioned capacity is modeled on ManagedService yet.
  }
  return usd
}

export function computeWorldCost(doc: WorldDoc, world: WorldMetrics | null): WorldCostResult {
  const byRegionMap = new Map<RegionId, number>()
  const byAzMap = new Map<AzId, number>()
  const bump = (map: Map<string, number>, key: string, usd: number) => map.set(key, (map.get(key) ?? 0) + usd)

  for (const server of Object.values(doc.servers)) {
    const usd = server.hourlyUsd * HOURS_PER_MONTH
    bump(byAzMap, server.azId, usd)
    const az = doc.azs[server.azId]
    if (az) bump(byRegionMap, az.regionId, usd)
  }

  for (const ms of Object.values(doc.managedServices)) {
    const usd = managedServiceMonthlyUsd(ms.nodeType, ms.provider)
    if (usd === 0) continue
    if (ms.scope.kind === 'az') {
      bump(byAzMap, ms.scope.azId, usd)
      const az = doc.azs[ms.scope.azId]
      if (az) bump(byRegionMap, az.regionId, usd)
    } else {
      bump(byRegionMap, ms.scope.regionId, usd)
    }
  }

  const crossAzUsd = world ? (world.crossAzBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_AZ_USD_PER_GB : 0
  const crossRegionUsd = world ? (world.crossRegionBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_REGION_USD_PER_GB : 0
  // Internet egress bills at PROVIDER_EGRESS.aws's tiered schedule regardless of the world's
  // actual provider mix — Phase 2 doesn't yet attribute egress cost per-provider (that requires
  // tracking which provider's traffic produced which bytes, not modeled yet). Documented
  // simplification; a future phase can split this once egress is attributed per-provider.
  const internetGbMonth = world ? (world.internetEgressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB : 0
  const internetUsd = world ? egressMonthlyCost('aws', internetGbMonth) : 0

  // byRegionMap already sums every server + every managed service exactly once (each managed
  // service contributes to exactly one region, directly or via its AZ's region) — safe to use
  // directly as the compute total, no need to re-walk doc.servers/managedServices again.
  const computeTotal = [...byRegionMap.values()].reduce((a, b) => a + b, 0)
  const monthlyUsd = computeTotal + crossAzUsd + crossRegionUsd + internetUsd

  return {
    monthlyUsd,
    byRegion: [...byRegionMap.entries()].map(([regionId, monthlyUsd]) => ({ regionId, monthlyUsd })),
    byAz: [...byAzMap.entries()].map(([azId, monthlyUsd]) => ({ azId, monthlyUsd })),
    egress: { crossAzUsd, crossRegionUsd, internetUsd },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing `CostTab` test**

```tsx
// src/app/world/CostTab.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CostTab } from './CostTab'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { getPreset } from '../../lib/world/instanceCatalog'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ latestBatch: null, scrubBatch: null })
})

describe('CostTab', () => {
  it('renders exact monthly math for a server-only world', () => {
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)   // 0.036 usd/hr
    render(<CostTab />)
    expect(screen.getByText('$26.28 /mo')).toBeInTheDocument()   // 0.036 * 730
  })

  it('shows a zero-state before any regions exist', () => {
    render(<CostTab />)
    expect(screen.getByText('$0.00 /mo')).toBeInTheDocument()
    expect(screen.getByText('no regions yet')).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: FAIL — `Cannot find module './CostTab'`

- [ ] **Step 7: Write `CostTab.tsx`**

```tsx
// src/app/world/CostTab.tsx
// WorldPanel's Cost tab: monthly total, per-region/per-AZ breakdown, egress line-items from
// live byte rates. Reads scrubBatch ?? latestBatch (Task 15) so scrubbing replays cost too.
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost } from '../../lib/costModelV2'
import { sectionLabel, row } from './panels/panelStyles'

export function CostTab() {
  const doc = useWorldStore(s => s.doc)
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const cost = computeWorldCost(doc, batch?.world ?? null)

  return (
    <div>
      <div style={sectionLabel}>Monthly cost</div>
      <div style={{ font: '600 16px var(--font-mono)', color: 'var(--color-text-primary)', marginBottom: 12 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo
      </div>

      <div style={sectionLabel}>By region</div>
      {cost.byRegion.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no regions yet</div>}
      {cost.byRegion.map(r => (
        <div key={r.regionId} style={row}>
          <span style={{ flex: 1 }}>{doc.regions[r.regionId]?.catalogId ?? r.regionId}</span>
          <span>${r.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>By AZ</div>
      {cost.byAz.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no AZs yet</div>}
      {cost.byAz.map(a => (
        <div key={a.azId} style={row}>
          <span style={{ flex: 1 }}>{doc.azs[a.azId]?.label ?? a.azId}</span>
          <span>${a.monthlyUsd.toFixed(2)}</span>
        </div>
      ))}

      <div style={sectionLabel}>Egress {batch ? '' : '(simulate to populate)'}</div>
      <div style={row}><span style={{ flex: 1 }}>Cross-AZ</span><span>${cost.egress.crossAzUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Cross-region</span><span>${cost.egress.crossRegionUsd.toFixed(2)}</span></div>
      <div style={row}><span style={{ flex: 1 }}>Internet</span><span>${cost.egress.internetUsd.toFixed(2)}</span></div>
    </div>
  )
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 9: Add the Cost tab to `WorldPanel.tsx`**

Add the import `import { CostTab } from '../CostTab'`. Change `type Tab` from
`'topology' | 'blueprints' | 'placements' | 'findings' | 'events'` to
`'topology' | 'blueprints' | 'placements' | 'findings' | 'events' | 'cost'`, append
`{ id: 'cost', label: 'Cost' }` to the `tabs` array, and add `{tab === 'cost' && <CostTab />}`
alongside the other tab bodies inside the `<fieldset>`.

- [ ] **Step 10: Verify full build**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green

- [ ] **Step 11: Commit**

```bash
git add src/lib/costModelV2.ts src/lib/costModelV2.test.ts \
        src/app/world/CostTab.tsx src/app/world/CostTab.test.tsx \
        src/app/world/panels/WorldPanel.tsx
git commit -m "feat(engine): add cost model v2 and cost tab"
```

---

### Task 17: Legacy engine + UI deletion [sonnet]

Same discipline as Phase 1 Task 9. Runs after Task 16 so nothing mounted references legacy
code. All grep/enumerate commands below were run against the actual repo (`world-rebuild`
branch, current HEAD) while authoring this fragment — the "Expected" output is the real,
verified result, not a guess.

**Files:**
- Delete: `src/app/canvas/` (entire directory — `Canvas.tsx`/`.module.css`, `edges/`, `nodes/`, `simulation/` incl. `particleEngine.ts` + `particleEngine/*.ts` + all its `*.test.ts`)
- Delete: `src/app/simulation/` (entire directory — `CostDashboard.tsx`/`.module.css`, `CostTracker.tsx`/`.module.css`, `EventLogPanel.tsx`/`.module.css`, `PacketEditor.tsx`/`.module.css`, `SimConfigPanel.tsx`/`.module.css`, `computeDefaults.test.ts`, `defaults.ts`)
- Delete: `src/app/sidebar/` (entire directory — `ContextMenu.tsx`/`.module.css`, `EdgeConfigForm.tsx`, `NodePalette.tsx`/`.module.css`, `PropertiesPanel.tsx`/`.module.css`, `Sparkline.tsx`)
- Delete: `src/app/toolbar/` (entire directory — `FileMenu.tsx`, `Toolbar.tsx`/`.module.css`)
- Delete: `src/app/dock/` (entire directory — `UtilityDock.tsx`/`.module.css`)
- Delete: `src/app/analytics/` (entire directory — `MetricGraphOverlay.tsx`/`.module.css`, `MetricsDrawer.tsx`/`.module.css`)
- Delete: `src/app/reports/` (entire directory — `ReportsPanel.tsx`/`.module.css`)
- Delete: `src/app/StatusBar.tsx`, `src/app/StatusBar.module.css`
- Delete: `src/app/hooks/useSaveDiagram.ts` (dead code — imports `useCanvasStore`/v1 `serialize`; unreferenced since Phase 1 Task 12 rewired `HomeScreen.tsx` to `fileOps.ts`, verified by grep below)
- Delete: `src/app/store/canvas.store.ts`, `src/app/store/replay.store.ts`, `src/app/store/metricsHistory.store.ts`, `src/app/store/costHistory.store.ts`
- Delete: `src/app/store/simulationLegacy.store.ts` — the verbatim build-green shim Task 12 introduced (a copy of the retired v1 `simulation.store`). Nothing outside the legacy trees deleted here imports it, and it itself imports `costModel`/`scalescript` (also deleted this task), so it MUST go with them or tsc breaks. (Step 1's grep surfaces it via those imports; it is on the list.)
- Delete: `src/lib/costModel.ts`, `src/lib/costModel.test.ts`, `src/lib/costModel.compute.test.ts`
- Delete: `src/lib/scalescript.ts`
- Delete: `src/lib/terraform/` (entire directory — `exportTerraform.ts`)
- Delete: `src/lib/vault/` (entire directory — `templates.ts`)
- Modify (trim, not delete): `src/app/store/ui.store.ts` (down to `themeMode`/`setThemeMode` only — see SKELETON CONCERN #6)
- Modify (trim, not delete): `src/lib/serializer.ts` (remove the v1 `DiagramFile` interface + `serialize`/`deserialize` functions — their only callers, `FileMenu.tsx` and `useSaveDiagram.ts`, are both deleted above)
- Modify (cleanup): `src/App.module.css` (remove the now-fully-dead `.canvasColumn` class — its only remaining reference was a comment inside `MetricsDrawer.module.css`, itself deleted above)

**Survivors (explicitly untouched):** `src/lib/theme.ts`, `src/lib/nodeConfig.ts` (types + icons,
including the packet types `PacketTemplate`/`PacketMode`/`PacketRegistry`/etc. — still actively
used by `WorldDoc`'s `BlueprintDependency.packetTemplateId` and `ScalemapFileV2.packets`),
`src/lib/cloudRegistry.ts`, `src/lib/regionConfig.ts`, `src/lib/tauri.ts`/`tauriMock.ts`,
everything under `src/lib/world/`, `src/lib/worldEngine/`, `src/app/world/`, `src/app/home/`,
`src/app/store/{world,nav,file,ui(trimmed),simulation(v2)}.store.ts`, `src/App.tsx` (already
clean — verified below, imports nothing from any deleted path).

**Interfaces:** Consumes: nothing new. Produces: a tree with zero references to any deleted
module, and a green `npm run build` + `npx vitest run`.

- [ ] **Step 1: Enumerate every reference before deleting**

Run (exactly as executed while authoring this plan):

```bash
grep -rln "app/canvas\|app/simulation\|app/sidebar\|app/toolbar\|app/dock\|app/analytics\|app/reports\|StatusBar\|store/canvas.store\|store/replay.store\|store/metricsHistory.store\|store/costHistory.store\|lib/costModel'\|lib/scalescript\|lib/terraform\|lib/vault" src/ --include='*.ts' --include='*.tsx' | grep -v -E "^src/(app/canvas|app/simulation|app/sidebar|app/toolbar|app/dock|app/analytics|app/reports)/"
```

Expected (verified real output — every hit is itself something on the deletion list above, so
none of these are "stragglers" requiring a separate fix):
```
src/lib/costModel.ts                    (imports app/simulation/defaults — both deleted together)
src/lib/costModel.compute.test.ts       (same)
src/app/hooks/useSaveDiagram.ts         (imports store/canvas.store — both deleted together)
```

Also run, to enumerate every remaining `NodeMetrics`/old-`simulation.store`-shape reference:

```bash
grep -rln "useSimulationStore\|NodeMetrics" src/ --include='*.ts' --include='*.tsx' | grep -v -E "^src/(app/canvas|app/simulation|app/sidebar|app/toolbar|app/dock|app/analytics|app/reports)/"
```

Expected: `src/lib/costModel.ts`, `src/lib/costModel.test.ts`, `src/lib/scalescript.ts` — all on
the deletion list. (`src/app/store/simulation.store.ts` and `src/app/world/*.tsx` also match
`useSimulationStore` textually, but that's the *v2* store and its legitimate consumers from
Tasks 13–16 — not a straggler.)

If either grep surfaces anything NOT already on this task's deletion list (e.g. a file introduced
between authoring this plan and executing it), treat it the same way Phase 1 Task 9 did: remove
the dead import/usage in that file — never resurrect a deleted module to satisfy it.

- [ ] **Step 2: Delete the legacy directories and files**

```bash
git rm -r src/app/canvas src/app/simulation src/app/sidebar src/app/toolbar \
          src/app/dock src/app/analytics src/app/reports \
          src/app/StatusBar.tsx src/app/StatusBar.module.css \
          src/app/hooks/useSaveDiagram.ts \
          src/app/store/canvas.store.ts src/app/store/replay.store.ts \
          src/app/store/metricsHistory.store.ts src/app/store/costHistory.store.ts \
          src/app/store/simulationLegacy.store.ts \
          src/lib/costModel.ts src/lib/costModel.test.ts src/lib/costModel.compute.test.ts \
          src/lib/scalescript.ts src/lib/terraform src/lib/vault
```

- [ ] **Step 3: Trim `ui.store.ts` to `themeMode` only**

Replace the entire file with:

```ts
// src/app/store/ui.store.ts
// Trimmed 2026-07-08 (Phase 2 Task 17): every field except themeMode was read only by legacy
// canvas/simulation/sidebar/toolbar/dock/reports UI, all deleted this task (verified by grep —
// see SKELETON CONCERN #6). If a future phase wants a "focus this node" pulse or similar, re-add
// the relevant field then rather than resurrecting the whole old surface.
import { create } from 'zustand'

interface UiStore {
  themeMode: 'dark' | 'light'
  setThemeMode: (mode: 'dark' | 'light') => void
}

export const useUiStore = create<UiStore>((set) => ({
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
  setThemeMode: (mode) => {
    localStorage.setItem('scalemap-theme-mode', mode)
    set({ themeMode: mode })
  },
}))
```

- [ ] **Step 4: Trim `serializer.ts` to v2-only**

In `src/lib/serializer.ts`, remove the `DiagramFile` interface and the `serialize`/`deserialize`
functions (lines 5–37 of the current file) along with the now-stale comment above the v2 section
referencing "v1 exports above are retained ONLY so unmounted legacy UI keeps compiling" (replace
it with a short note that v1 support was removed in Task 17). The file's `NodeData`/`EdgeData`/
`PacketRegistry` type import from `./nodeConfig` becomes partially unused — check with
`noUnusedLocals`; if `NodeData`/`EdgeData` are no longer referenced anywhere in the trimmed file,
remove them from the import, keeping only `PacketRegistry` (still used by `ScalemapFileV2`).
`@xyflow/react`'s `Viewport`/`Node`/`Edge` type imports also become unused once `DiagramFile` is
gone — remove them too. Result: the file starts directly with the `WorldViewState`/
`ScalemapFileV2` interfaces and `serializeWorld`/`deserializeWorld`, unchanged in substance from
today.

- [ ] **Step 5: Remove dead CSS**

In `src/App.module.css`, delete the `.canvasColumn` rule (no longer referenced by any `.tsx`
after this task, and its only remaining textual mention — a comment in
`MetricsDrawer.module.css` — was deleted with `src/app/analytics/` in Step 2).

- [ ] **Step 6: Verify no references remain and the build is green**

```bash
grep -rn "useCanvasStore\|useReplayStore\|useMetricsHistoryStore\|useCostHistoryStore\|particleEngine\|NodeMetrics\|DiagramFile\|exportTerraform\|parseScaleScript\|applyScaleScript\|VAULT_TEMPLATES" src/
```
Expected: prints nothing (exit 1).

```bash
npm run build
```
Expected: succeeds. (If this fails on a straggler not caught by Step 1's greps, fix that file's
dead import per Step 1's fallback instruction, then re-run.)

```bash
npx vitest run
```
Expected: PASS — every deleted `*.test.ts` simply no longer runs (`particleEngine/*.test.ts`,
`costModel*.test.ts`, `cloudRegistry.test.ts` if it referenced deleted exports — check; it should
not, `cloudRegistry.ts` itself survives); all remaining suites green, including
`src/lib/serializer.test.ts` (already v2-only per Phase 1, unaffected by Step 4's trim) and every
Task 13–16 suite from this fragment.

- [ ] **Step 7: Live smoke — confirm the app still runs with only the world UI mounted**

1. Start the dev server in the background: `npm run dev`. Wait for the ready URL.
2. `browser_navigate` → `http://localhost:1420`. `browser_snapshot` → Home screen renders.
3. `browser_click` "New World" → WorldShell renders (breadcrumb, SimControls in the header,
   WorldPanel with all six tabs including the new Events/Cost tabs, empty ScrubberV2 correctly
   absent since there are no replay frames yet).
4. `browser_console_messages` → assert zero errors (this is the most important check here — a
   missed straggler import typically shows up as a console error or blank page, not necessarily
   a build failure, since some legacy references could be inside code paths `tsc`/`vitest` don't
   exercise but the running app does).
5. Stop the dev server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(engine)!: delete legacy canvas/simulation UI and engine, keep world model"
```

---

### Task 18: Perf benchmark + degradation + final verify [sonnet]

**Files:**
- Create: `bench/enginePerf.bench.test.ts` (see SKELETON CONCERN #4 for the naming fix vs. the skeleton's literal `bench/enginePerf.bench.ts`)
- Modify: `tsconfig.json` (add `"bench"` to `include`, mirroring the `vitest.setup.ts` precedent from Phase 1 Task 10 — otherwise `npm run build`'s `tsc` step never type-checks this new top-level directory)
- Modify: `src/app/store/simulation.store.ts` (additive: `degraded: boolean`, set from the facade's `engine_degraded` event, reset on `start()`)
- Modify: `src/app/world/SimControls.tsx` (amber "degraded tick" chip)
- Modify: `src/app/world/SimControls.test.tsx` (one more test for the chip)
- Modify: `src/app/world/WorldShell.tsx` (dev-only debug hook — see SKELETON CONCERN #7)
- Modify: `docs/module-boundaries.md` (§J Phase-2 update + mark deleted sections)

**Interfaces:**
- Consumes: `src/lib/worldEngine/index.ts`'s exported facade. This plan assumes it exports a
  factory `createWorldEngine(): WorldEngineApi` (for isolated instances in this bench, and for
  T12's own integration test which per its spec text "export[s] a `__test_step` hook") alongside
  a standalone `__test_step(engine, stepMs)` helper that drives one fixed step directly,
  bypassing `requestAnimationFrame`. If T12 instead exports a bare module-level singleton with
  `__test_step` as a method on the returned API object, adjust the two import lines in Step 1
  below accordingly — the bench's assertions and structure are unaffected either way.
- Produces: a perf-budget regression test in the normal suite; `simulation.store.degraded`;
  `SimControls`'s degraded chip; the dev-only `window.__scalemapDebug` hook; a fully updated
  `docs/module-boundaries.md`.

- [ ] **Step 1: Write `bench/enginePerf.bench.test.ts`**

```ts
// bench/enginePerf.bench.test.ts
// Perf budget (Global Constraints / spec decision 9): ≤4ms mean step at 2,000 instances.
// This is a correctness-style assertion test using plain describe/it/expect, run under the
// normal `npx vitest run` suite so CI catches regressions — NOT vitest's separate `bench()`
// benchmarking API (see this fragment's SKELETON CONCERN #4 for why the file is named
// `*.bench.test.ts` rather than the skeleton's literal `*.bench.ts`). CI-tolerant per spec:
// only FAILS above 8ms/step (2× budget); 4–8ms warns via console.warn so a loaded CI box
// doesn't flake the build.
import { describe, it, expect } from 'vitest'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../src/lib/world/factories'
import { getPreset } from '../src/lib/world/instanceCatalog'
import { compileWorld } from '../src/lib/world/compileWorld'
import { createWorldEngine, __test_step } from '../src/lib/worldEngine'
import type { WorldDoc } from '../src/lib/world/types'

const REGIONS = 6, AZS_PER_REGION = 3, SERVERS_PER_AZ = 12, INSTANCE_BUDGET = 2000

function buildSyntheticWorld(): WorldDoc {
  const doc = createWorld()
  const blueprints = Array.from({ length: 5 }, (_, i) => createBlueprint(`svc-${i}`, i))
  for (const bp of blueprints) doc.blueprints[bp.id] = bp
  // Chain each blueprint to the next so flows.ts has real fan-out work to do per hop.
  for (let i = 0; i < blueprints.length - 1; i++) {
    blueprints[i].dependencies = [{
      id: `dep-${i}`, target: { kind: 'blueprint', blueprintId: blueprints[i + 1].id },
      port: 8080, protocol: 'http', packetTemplateId: null,
    }]
  }

  let remaining = INSTANCE_BUDGET
  for (let r = 0; r < REGIONS && remaining > 0; r++) {
    const region = createRegion('us-east-1')
    doc.regions[region.id] = region
    for (let a = 0; a < AZS_PER_REGION && remaining > 0; a++) {
      const az = createAz(region.id, `bench-${r}${String.fromCharCode(97 + a)}`)
      doc.azs[az.id] = az
      for (let s = 0; s < SERVERS_PER_AZ && remaining > 0; s++) {
        const server = createServer(az.id, getPreset('vps-medium')!)
        doc.servers[server.id] = server
        for (const bp of blueprints) {
          if (remaining <= 0) break
          const pl = createPlacement(bp.id, server.id)
          doc.placements[pl.id] = pl
          remaining--
        }
      }
    }
  }
  const pop = createPopulation('bench-clients', 38.9, -77.5)
  pop.peakRps = 50_000
  doc.populations[pop.id] = pop
  return doc
}

describe('engine perf budget', () => {
  it('averages ≤4ms/step over 100 steps at ~2,000 instances (fails only above 8ms; 4–8ms warns)', () => {
    const doc = buildSyntheticWorld()
    const compiled = compileWorld(doc)
    const instanceCount = Object.keys(compiled.instances).length
    expect(instanceCount).toBeGreaterThan(1800)   // sanity: fixture actually hits the target scale
    expect(instanceCount).toBeLessThanOrEqual(2000)

    const engine = createWorldEngine()
    engine.start(doc, compiled, { onMetrics: () => {}, onEvent: () => {}, onHealthChange: () => {} })

    const durationsMs: number[] = []
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now()
      __test_step(engine, 100)
      durationsMs.push(performance.now() - t0)
    }
    engine.stop()

    const mean = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length
    if (mean > 4 && mean <= 8) {
      console.warn(`[enginePerf] mean step ${mean.toFixed(2)}ms exceeds the 4ms budget (still under the 8ms CI-fail line) at ${instanceCount} instances`)
    }
    expect(mean).toBeLessThanOrEqual(8)
  }, 30_000)
})
```

- [ ] **Step 2: Include `bench/` in `tsconfig.json`**

Change:

```json
"include": ["src", "vitest.setup.ts"],
```

to:

```json
"include": ["src", "vitest.setup.ts", "bench"],
```

- [ ] **Step 3: Run the bench test**

Run: `npx vitest run bench/enginePerf.bench.test.ts`
Expected: PASS (1 test). If it prints the `[enginePerf]` warning, that's an accepted "over
budget but under the CI-fail line" result, not a failure — investigate the regression before the
next release but don't block this task on it.

- [ ] **Step 4: Wire the `degraded` store flag**

In `src/app/store/simulation.store.ts` (already extended once in Task 15), add to the interface:

```ts
degraded: boolean
```

Add to initial state:

```ts
degraded: false,
```

In the store's `onEvent` callback (the one T12 wires into `EngineCallbacks.onEvent`, which
already pushes into the `events` ring per the contracts), fold in the flag:

```ts
onEvent: (event) => {
  set(state => ({
    events: [...state.events, event].slice(-500),
    degraded: state.degraded || event.kind === 'engine_degraded',
  }))
  // ...whatever else this callback already does (e.g. onHealthChange plumbing) is unchanged
},
```

In the `start()` action, add `degraded: false` to its reset `set(...)` call (alongside the
`scrubIndex: null, scrubBatch: null` reset Task 15 added), so every fresh run starts un-degraded.

- [ ] **Step 5: Add the degraded chip to `SimControls.tsx`**

Add to the destructured store reads:

```ts
const degraded = useSimulationStore(s => s.degraded)
```

Add this constant near the other style constants:

```ts
const degradedChip: CSSProperties = {
  padding: '2px 6px', borderRadius: 3, font: '10px var(--font-mono)',
  color: 'var(--color-warning)', border: '1px solid var(--color-warning)',
}
```

Add, as the last child of the returned `<div>`:

```tsx
{degraded && (
  <span style={degradedChip} title="Sustained step-cost overrun — the engine halved its tick rate to keep up (see Events)">
    degraded tick
  </span>
)}
```

- [ ] **Step 6: Extend `SimControls.test.tsx`**

Add one test to the existing `describe('SimControls', ...)` block:

```tsx
it('shows the degraded chip when the store flag is set', () => {
  useSimulationStore.setState({ running: true, degraded: true })
  render(<SimControls />)
  expect(screen.getByText('degraded tick')).toBeInTheDocument()
})
```

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 7: Add the dev-only debug hook to `WorldShell.tsx`**

Add the import:

```ts
import { useWorldStore } from '../store/world.store'
```

(if not already imported by that exact name — Task 14 onward may already import it; check
before duplicating.) Add a one-time effect inside `WorldShell()`:

```ts
useEffect(() => {
  if (!import.meta.env.DEV) return
  // Dev/test-only: lets a scripted Playwright smoke seed a real, cross-region-eligible
  // ClientPopulation via the *already-built* world.store action (no population-authoring UI
  // exists in Phase 2 by design — see this fragment's SKELETON CONCERN #7) and call setOutage
  // directly as a fallback if a UI control is awkward to click reliably. Never present in a
  // production build (import.meta.env.DEV is false under `vite build`/`tauri build`).
  ;(window as unknown as { __scalemapDebug: unknown }).__scalemapDebug = { useWorldStore, useSimulationStore }
}, [])
```

- [ ] **Step 8: Verify build + full suite**

Run: `npm run build` → succeeds
Run: `npx vitest run` → all suites green, including `bench/enginePerf.bench.test.ts` and the
updated `SimControls.test.tsx` (5 tests)

- [ ] **Step 9: Update `docs/module-boundaries.md`**

The current file has sections `### A` through `### J` (§J already covers Phase 1's world model).
Apply these edits:

**9a. Mark fully-deleted sections.** Replace the ENTIRE body of `### A. Canvas graph editing`
(everything from its `| File | Role |` table through its "Blast radius" paragraph, i.e. from
just after the section heading down to — but not including — `### B. Simulation engine & live
metrics`) with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `src/app/canvas/` (Canvas.tsx, edges/, nodes/,
simulation/ incl. particleEngine.ts) and `src/app/sidebar/` (PropertiesPanel/ContextMenu/
EdgeConfigForm/NodePalette/Sparkline) were removed outright — the world model
(`src/lib/world/`) plus the new engine (`src/lib/worldEngine/`, §J) replace this whole layer.
See `docs/superpowers/plans/2026-07-08-phase2-substrate-engine-design.md` Task 17.
```

Similarly replace `### B. Simulation engine & live metrics`'s entire body with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `particleEngine.ts` and every `particleEngine/*.ts`
submodule (circuitBreakers/backpressure/chaos/lbRouting/compute/circuitVisual),
`SimulationOverlay.tsx`, `useDisplayMetrics.ts`, `PlaybackScrubber.tsx`, `RequestInspector.tsx`,
`replay.store.ts`, `metricsHistory.store.ts` were removed outright — `src/lib/worldEngine/`
(§J) is their replacement, ported per spec decision 2 (log-normal latency, breaker state
machine, EMA smoothing, health hysteresis) rather than rewritten from scratch.
`simulation.store.ts` was not deleted — it was rewritten in place to the v2 shape (contracts:
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`).
```

Replace `### D. Cost modeling & cloud pricing`'s table + blast-radius paragraph (keep the
section heading) with:

```markdown
| File | Role |
|---|---|
| `src/lib/costModelV2.ts` (Phase 2 Task 16) | World-level monthly cost: Σ server hourlyUsd×730 + managed-service pricing (reused from `cloudRegistry.ts`) + egress from live `WorldMetrics` byte rates |
| `src/lib/cloudRegistry.ts` (~295 lines) | Per-provider service/pricing catalog, egress tiers, provider-aware label rewrite (`resolveProviderLabel`) — **survived Task 17 unchanged**, now consumed by `costModelV2.ts` instead of the deleted `costModel.ts` |
| `src/lib/regionConfig.ts` (58 lines) | Region metadata — survived Task 17 unchanged |
| `src/app/world/CostTab.tsx` (Phase 2 Task 16) | WorldPanel's Cost tab — replaces the deleted `CostTracker.tsx`/`CostDashboard.tsx` |

**DELETED 2026-07-08 (Phase 2 Task 17):** `src/lib/costModel.ts` (v1), `src/app/simulation/
CostTracker.tsx`, `src/app/simulation/CostDashboard.tsx`.

**Blast radius:** `costModelV2.ts` is imported only by `CostTab.tsx` today — far narrower fan-in
than the deleted v1 `costModel.ts` had (which touched `BaseNode.tsx`/`particleEngine.ts`/
`nodeConfig.ts`/`PropertiesPanel.tsx`, all also deleted).
```

Replace `### E. Packet system (Flyweight templates)`'s table + blast-radius paragraph with:

```markdown
| File | Role |
|---|---|
| `nodeConfig.ts` packet types (`PacketTemplate`, `PacketMode`, `PacketRegistry`, `BasePacketTemplate`, `HttpTemplate`/`EventTemplate`/`StreamTemplate`/`DbTemplate`) | **Survived Task 17** — still referenced by `WorldDoc`'s `BlueprintDependency.packetTemplateId` and `ScalemapFileV2.packets` (`src/lib/serializer.ts`) |

**DELETED 2026-07-08 (Phase 2 Task 17):** `src/app/simulation/PacketEditor.tsx` (the "packet
anatomy" card editor) and `canvas.store.ts`'s packet-registry CRUD slice — no packet-authoring
UI exists in Phase 2; the types remain load-bearing for the file format and blueprint
dependencies, but editing a packet template is not yet possible again (Phase 3+ can reintroduce
an editor over the world model if needed).
```

Replace `### F. Terraform export / Vault templates / ScaleScript / Serialization`'s table with:

```markdown
| File | Role | Callers |
|---|---|---|
| `src/lib/serializer.ts` (trimmed, Phase 2 Task 17) | `.scalemap` v2 JSON read/write only — the v1 `serialize`/`deserialize`/`DiagramFile` exports were removed once their only callers (`FileMenu.tsx`, `useSaveDiagram.ts`) were deleted | `file.store.ts` (indirectly via `fileOps.ts`), `tauri.ts` |

**DELETED 2026-07-08 (Phase 2 Task 17):** `src/lib/terraform/exportTerraform.ts` (HCL export),
`src/lib/vault/templates.ts` (prebuilt starter diagrams), `src/lib/scalescript.ts` (the v1 DSL +
`applyScaleScript()`). None have a Phase 2 replacement yet — Terraform/vault/ScaleScript v2 are
explicitly out of scope for this phase (spec "Out of scope").
```

Leave `### G. Rust / Tauri backend` entirely unchanged (nothing there was touched).

Replace `### H. Utility dock (Reports)`'s entire body (from just after its heading through its
final "Blast radius" line) with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `src/app/dock/UtilityDock.tsx` and
`src/app/reports/ReportsPanel.tsx` were removed outright — Phase 2 has no dock/reports
equivalent; `WorldPanel`'s tab strip (§J) is the only floating-panel-style UI that survives, and
it was never part of this dock.
```

Replace `### I. Toolbar declutter`'s entire body with:

```markdown
**DELETED 2026-07-08 (Phase 2 Task 17).** `src/app/toolbar/Toolbar.tsx` and
`src/app/toolbar/FileMenu.tsx` were removed outright. This section's 2026-07-08 "orphaned from
the app root" note (Phase 1 Task 10) is now moot — the files it described as "unmounted but
still compiling" no longer exist. `WorldShell.tsx`'s header (breadcrumb + `SimControls`, §J +
Phase 2 Task 13 + this task) is the toolbar's replacement; it has no theme toggle yet (Phase 1's
`ui.store.themeMode`/`setThemeMode` survived Task 17 — see §2 — but nothing currently calls
`setThemeMode`; a future task should add a toggle button back to `WorldShell.tsx`'s header,
flagged here rather than silently left dead).
```

**9b. Append the Phase 2 subsection to `### J. World model & navigation shell`.** After its
existing "Blast radius" paragraph (the one ending "...would fully restore the old app if ever
needed."), append:

```markdown
#### Phase 2 update (2026-07-08+): the substrate engine

Branch: `world-rebuild` (unchanged). Spec:
`docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md`; contracts (FROZEN):
`docs/superpowers/specs/2026-07-08-world-engine-contracts.md`; plan:
`docs/superpowers/plans/2026-07-08-phase2-substrate-engine.md`. The app simulates again after
this phase (spec's stated goal) — `particleEngine.ts` and everything that rendered its output
were deleted (§C's sibling notes on §A/§B/§D/§E/§F/§H/§I above) once `src/lib/worldEngine/`'s
ports of the same math (log-normal latency, circuit breakers, EMA smoothing, health hysteresis
— spec decision 2) landed and every consumer was rebuilt against the new contracts.

| File | Role |
|---|---|
| `src/lib/worldEngine/types.ts` | Contracts transcribed verbatim (Task 1) — `MetricsBatch`/`EngineEvent`/`WorldEngineApi`/`RenderScope`/`VisualParticle`/`VisualArc`/`ReplayFrame`/`TracedRequest`. FROZEN — additive-optional extension only |
| `src/lib/worldEngine/{rng,engineClock,demand,routingRuntime,hostScheduler,vpsModel,networkRuntime,breakers,flows,failover,metrics,events,replay,latency}.ts` | One headless fixed-step (100ms) engine subsystem per file (Tasks 1–11) — seeded RNG only, no `Math.random`, no `src/app/` imports |
| `src/lib/worldEngine/index.ts` | `WorldEngineApi` facade (Task 12) — the ONLY thing `simulation.store.ts` imports from `worldEngine/`; step order documented in-file (clock → demand → routing → host scheduler (prev-step flows) → vps → flows → NIC → breakers → failover/health → metrics → 1Hz batch+replay+trace → render payload) |
| `src/app/store/simulation.store.ts` | REWRITTEN (Task 12) to the v2 shape: `running`/`timeScale`/`latestBatch`/`events`/`healthOverrides`, plus `scrubIndex`/`scrubBatch` (Task 15) and `degraded` (Task 18) as sanctioned additive extensions beyond the contracts' literal "exactly" list (see the Phase 2 plan fragment's SKELETON CONCERN #2). Views never import the engine directly — only this store's control actions (`start`/`stop`/`setTimeScale`/`setOutage`/`setScrubIndex`) call the facade |
| `src/app/world/SimControls.tsx` (Task 13) | Simulate/Stop + timeScale select + running dot in `WorldShell`'s header; also renders the Task 18 "degraded tick" amber chip |
| `src/app/world/EventsTab.tsx` (Task 13) | `WorldPanel`'s Events tab — the store's `events` ring, newest-first, severity-colored |
| `src/app/world/panels/WorldPanel.tsx` | Gained a `running: boolean` prop (Task 13) — wraps every tab body in `<fieldset disabled={running}>` (the Phase 2 equivalent of the legacy `canvas.store` "simulation lock" §A used to describe, implemented via native HTML cascade instead of per-action checks) and two new tabs (Events, Task 13; Cost, Task 16) |
| `src/app/world/AzSimOverlay.tsx` (Task 14) | Absolutely-positioned `<canvas>` over `AzCanvas`'s ReactFlow viewport, drawn from `attachRenderer({level:'az'})`'s per-frame `VisualParticle[]`; refused particles burst red at their target |
| `src/app/world/WorldServerNode.tsx` | `WorldServerNodeData` gained `health?`/`cpuPct?`/`ramUsedMb?`/`ramTotalMb?` (Task 14, additive) — health-tinted border + a CPU/RAM readout line |
| `src/app/world/RegionView.tsx` | Gained a manual "Simulate region outage" toggle (Task 14, calls `setOutage('region', id, down)`) — the only manual-failure UI in Phase 2 (see the Phase 2 plan fragment's SKELETON CONCERN #7 for why this exists despite decision 11 not itemizing it) |
| `src/app/world/ScrubberV2.tsx` (Task 15) | Bottom-bar replay scrubber — visible only when stopped and replay frames exist; ticks colored by each frame's worst-AZ `healthScore` |
| `src/app/world/InspectorV2.tsx` (Task 15) | AZ-view floating panel listing `getTracedRequests({level:'az'})`, polled at 1Hz; click a row for its hop table |
| `src/lib/costModelV2.ts` (Task 16) | `computeWorldCost(doc, world)` — server + managed-service (aliased through a small `rds`→`dbSql`-style table, since `PlacementPanel.tsx`'s `MANAGED_TYPES` predates `CLOUD_REGISTRY`'s canonical keys) + egress cost |
| `src/app/world/CostTab.tsx` (Task 16) | `WorldPanel`'s Cost tab — monthly total, by-region/by-AZ rows, egress line items |
| `bench/enginePerf.bench.test.ts` (Task 18) | Perf-budget regression: ≤4ms mean step (fails >8ms, warns 4–8ms) at ~2,000 instances, run under the normal suite (not `vitest bench` — see the plan fragment's SKELETON CONCERN #4) |

**What did NOT survive Task 17** (Phase 1's "unmounted but still compiling" legacy tree — see
§A/§B/§D/§E/§F/§H/§I above, all now marked DELETED): `src/app/canvas/`, `src/app/simulation/`,
`src/app/sidebar/`, `src/app/toolbar/`, `src/app/dock/`, `src/app/analytics/`,
`src/app/reports/`, `src/app/StatusBar.tsx`, `src/app/store/{canvas,replay,metricsHistory,
costHistory}.store.ts`, `src/lib/costModel.ts`, `src/lib/scalescript.ts`,
`src/lib/terraform/`, `src/lib/vault/`. Reverting `App.tsx` alone no longer restores the old
app (Phase 1's §J note above is now stale) — the old UI is actually gone, not just unmounted.

**`ui.store.ts` is now themeMode-only** (Task 17) — every other field it used to hold
(`activeTool`, sidebar/dock/panel-open booleans, `contextMenu`, `highlightedNodeIds`, etc.) was
read exclusively by deleted files; Phase 1's §C note that `highlightedNodeIds` "survived...for
reuse by whatever panel wants that behavior next" never actually got reused and is gone too.

**Blast radius:** `worldEngine/types.ts` is imported by every engine subsystem AND by
`simulation.store.ts` AND transitively by every Task 13–16 view/panel — it is now the single
highest-fan-in file in the repo (surpassing even `nodeConfig.ts`, §2), and it's FROZEN by
contract: extend additively, never reshape. `simulation.store.ts` is the sole bridge between
`worldEngine/` and every `app/world/` consumer — the same "never import the engine directly"
rule Phase 1 applied to `compileWorld`'s output now applies one layer up.
```

**9c. Update §2 hub-file entries.** In `## 2. Shared "hub" files`, replace the
`src/app/store/simulation.store.ts` row's description from `NodeMetrics`/`SimEvent`/
`SloStatus`... to:

```markdown
| `src/app/store/simulation.store.ts` | v2 shape (contracts, Phase 2): `running`/`timeScale`/`latestBatch: MetricsBatch`/`events`/`healthOverrides` + `scrubIndex`/`scrubBatch` (Task 15) + `degraded` (Task 18) | every `app/world/*.tsx` view/panel that reads live metrics |
```

Remove the `src/app/canvas/simulation/particleEngine.ts` row entirely (file deleted). Update the
`src/app/store/ui.store.ts` row's description to just: `themeMode: 'dark' \| 'light'` +
`setThemeMode` — every other field this row used to describe was trimmed in Task 17 (see §J's
Phase 2 update above)`.

**9d. Update §3's ownership-split list.** Strike or annotate items 1, 3, 6 (they describe
`particleEngine.ts`, `PacketEditor.tsx`, and dock/floating-panel work — all deleted); item 4
("Cost/pricing model work → §1D") now reads "isolated unless changing `costModelV2.ts`'s
`computeWorldCost` signature."

- [ ] **Step 10: Final whole-phase verification checklist**

```bash
npm run build
npx vitest run
```
Expected: build green; full suite green, including every subsystem test from Tasks 1–12
(assumed already passing), this fragment's `SimControls.test.tsx` (5 tests), `costModelV2.test.ts`
(3 tests), `CostTab.test.tsx` (2 tests), and `bench/enginePerf.bench.test.ts` (1 test, may warn
but not fail).

Full live-smoke checklist (dev server, strict port 1420; screenshots at each starred step):

1. `npm run dev` in the background; `browser_navigate` → `http://localhost:1420`.
2. **Author:** "New World" → add region `us-east-1` + region `eu-west-1`, one AZ each, one
   server each (`vps-medium`); Blueprints: `web` (no dependencies needed); Placements: "+ Place"
   `web` onto both servers; Managed services: add one `redis` (aws) scoped to the `us-east-1`
   AZ, to exercise a nonzero managed-service cost line. ★ `browser_take_screenshot` →
   `task18-authored-world.png`.
3. **Simulate:** set timeScale to `4x`, click "Simulate". `browser_wait_for` ~5s.
   ★ `browser_take_screenshot` of GlobeView showing both regions' live rps/health →
   `task18-simulating.png`.
4. **Seed a real population + failover with TTL lag visible:** via `browser_evaluate`, call
   `window.__scalemapDebug.useWorldStore.getState().addPopulation('bench-clients', 38.9, -77.5)`
   (seeds a real, cross-region-eligible population — see SKELETON CONCERN #7 for why this can't
   be done through real UI in Phase 2). Navigate to the `us-east-1` RegionView and click "⚡
   Simulate region outage". `browser_wait_for` ~10 real seconds (≥30 simulated seconds at 4x —
   the default `dnsTtlSec: 30`). ★ Open the Events tab, `browser_take_screenshot` → confirm a
   `ttl_lag_expired` and/or `failover_started`/`failover_completed` event is present with a
   `simMs` timestamp ≥30_000ms after the outage → `task18-failover-events.png`. Confirm
   `eu-west-1`'s GlobeView rps increased relative to step 3's screenshot.
5. **Scrub:** click "Stop". ★ Drag/click the ScrubberV2 strip back to a tick at or before the
   outage; confirm the region-outage red state is visible → `task18-scrub-outage.png`.
6. **Trace:** navigate into the `us-east-1` AZ; click a row in InspectorV2's traced-request list;
   confirm the hop table expands → `task18-trace.png`.
7. **Cost tab:** click "Exit scrub"; open the Cost tab; confirm a nonzero monthly total, two
   by-region rows, one by-AZ-with-redis-attributed row, and (if the sim ran long enough to
   produce nonzero cross-region bytes) a nonzero egress line → `task18-cost.png`.
8. **Save/reload:** click "Save" (tauriMock auto-generates a filename in browser-dev mode);
   click "New" (world resets to empty); click "Open" (tauriMock's `open_file_dialog` returns the
   most-recently-saved path automatically); confirm both regions/AZs/servers/blueprints/
   placements/managed service/population reappear exactly as authored.
9. `browser_console_messages` → assert zero errors across the entire sequence above.
10. Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add bench/enginePerf.bench.test.ts tsconfig.json \
        src/app/store/simulation.store.ts src/app/world/SimControls.tsx \
        src/app/world/SimControls.test.tsx src/app/world/WorldShell.tsx \
        docs/module-boundaries.md
git commit -m "feat(engine): add perf benchmark, step-rate degradation UI, and finish Phase 2 verification"
```
