# Wave 4 (FEAT-009 "Signals" + FEAT-010 Cost Velocity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Wave 4 of `feature-spec.md` — a time-series "Signals" APM panel over the engine's
existing 300-frame replay ring (FEAT-009), then a cost-velocity/attribution rebuild of the Cost tab
that reuses FEAT-009's charting path (FEAT-010).

**Architecture:** FEAT-009 adds one new published gauge (`p90Ms`) plus two pure, React-free modules
(`signalsSeries.ts`'s `extractSeries`/`downsample`) that turn `ReplayFrame[]` into chartable series,
and a new `SignalsPanel.tsx` that renders them as SVG small-multiples wired to the existing scrub
mechanism. FEAT-010 adds `hourlyUsd`/per-blueprint attribution to `costModelV2.ts`, a frame-indexed
memo so a 300-frame cost series costs one `computeWorldCost` call per new frame (not per render),
and rewrites `CostTab.tsx` to lead with a $/hr sparkline (built from FEAT-009's own extractor) plus
a "by service" ranked section and an incident-cost readout bound to the scrub range.

**Tech Stack:** TypeScript, React 19, Zustand, plain inline SVG (no chart library), Vitest
(`node` env for pure logic, `jsdom` via a per-file `// @vitest-environment jsdom` docblock for
components — follow the existing convention, e.g. `src/app/world/region/TimelineV2.test.tsx`).

## Global Constraints

- **Compiled-world gate**: nothing new reads the raw `WorldDoc` for anything derived; read
  `compileWorld(doc)`'s output. Extend `CompiledWorld` only additively (not touched by this wave).
- **Engine seam**: `simulation.store.ts` is the ONLY file permitted to call `worldEngine` directly
  (`getReplayFrames()` etc.). Views/panels read the store, never the facade.
- **Regression floor**: every new doc/contract field is optional; absent ⇒ today's exact behavior,
  asserted with `toBe`, not `toBeCloseTo`.
- **Contract drift**: `src/lib/worldEngine/types.ts` is a frozen contract. `p90Ms` is additive —
  log it in `.superpowers/sdd/contract-drift.md`.
- **Perf envelope**: engine runs ~2 ms/step against a 4 ms budget (`DEGRADE_THRESHOLD_MS = 4`,
  `index.ts:65`). FEAT-009's `p90Ms` computation is a per-step-published-batch cost (1 Hz), not a
  per-step cost — still keep it cheap (one more `percentile()` call, already computed on a sorted
  array). Series/chart work happens on the 1 Hz batch or on an explicit scrub, **never** per
  animation frame. `bench/enginePerf.bench.test.ts` must show no regression (run via `npm run
  bench`, excluded from the default `npx vitest run` per `vite.config.ts:27`).
- **60 FPS render budget**: new visuals compute on the 1 Hz metrics batch only.
- **Determinism**: no new `Math.random()`/rng draws anywhere in `worldEngine`. This wave adds no
  rng draws.
- **Theme law**: every color is `var(--color-*)` from `src/lib/theme.ts`; no hardcoded hexes.
  Series colors come from `CATEGORY_COLORS` so they stay distinct in both themes.
- **Price law**: every money value renders in `var(--color-price)`, including negative deltas
  (rendered with a `−` glyph, never `var(--color-success)`).
- **No emojis.** Glyphs only (`▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →` and words).
- **Motion budget**: no per-frame animation; the scrub playhead does not animate;
  `prefers-reduced-motion` requires no special case beyond the standard check (nothing here loops).
- **Edit-lock law**: not directly applicable — Signals/Cost are read surfaces, not authoring
  controls, and both already sit inside `WorldPanel.tsx`'s `<fieldset disabled={running}>` except
  the Events-tab-style exemption doesn't apply here (these are not destructive/chaos controls).
- **Serializer**: this wave adds nothing to `WorldDoc`/`.scalemap` — `p90Ms` is an engine-published
  metric, not authored config. No serializer changes.
- **Analysis rules**: none added this wave.
- **Done bar, per task**: `npx tsc --noEmit` clean → `npx vitest run` green → `npm run build` green
  → live smoke in `npm run tauri dev` with zero new console errors, both themes.
- **Docs**: update `docs/module-boundaries.md` after the wave (append a row per changed/created
  file — see Task 11).
- **Hub files** (coordinate, edit sequentially): `src/app/world/panels/WorldPanel.tsx`,
  `src/app/store/ui.store.ts`, `src/lib/worldEngine/types.ts`. Both features touch
  `WorldPanel.tsx`; do Task 5 (FEAT-009's wiring) before Task 9 (FEAT-010's wiring) so there is only
  one sequential edit pass, not two colliding ones.

---

## File Structure

**New files:**
- `src/lib/worldEngine/types.ts` — add `p90Ms: number` to `InstanceMetrics`, `AzMetrics`,
  `RegionMetrics` (additive).
- `src/app/world/panels/signalsSeries.ts` — pure series extraction/downsampling (FEAT-009 §1,
  extended by FEAT-010 §2 with a `costUsdPerHour` key).
- `src/app/world/panels/signalsSeries.test.ts` — unit tests, `node` env.
- `src/app/world/panels/SignalsPanel.tsx` — the Signals tab body: stacked small-multiples.
- `src/app/world/panels/SignalsPanel.test.tsx` — component tests, `jsdom` env.
- `src/app/world/panels/SignalChart.tsx` — the one SVG chart renderer both SignalsPanel and
  CostTab's sparkline call, so there is exactly one charting code path (spec requirement).
- `src/lib/costSeries.ts` — FEAT-010's frame-indexed `computeWorldCost` memo
  (`costSeriesFor(frames, doc): Map<number, WorldCostResult>` plus `incidentCost(...)`).
- `src/lib/costSeries.test.ts` — unit tests, `node` env.

**Modified files:**
- `src/lib/worldEngine/metrics.ts` — compute+publish `p90Ms` beside `p99Ms`/aggregate it up AZ/region.
- `src/app/store/ui.store.ts` — `PanelTab` gains `'signals'`.
- `src/app/world/dock/scope.ts` — `WORLD_TABS`/`SCOPED_TABS` gain `'signals'`.
- `src/app/world/panels/WorldPanel.tsx` — `TAB_LABELS`, header switch, world-scope body, non-world
  body all gain a `'signals'` arm (hub file — Task 5).
- `src/lib/costModelV2.ts` — `WorldCostResult` gains `hourlyUsd`; add `attributeByBlueprint`.
- `src/app/world/CostTab.tsx` — rewritten: $/hr headline + sparkline, by-service section, incident
  readout.
- `.superpowers/sdd/contract-drift.md` — log the `p90Ms` additive change.
- `docs/module-boundaries.md` — new rows for the files above.

---

## Task 1: `p90Ms` — engine contract + computation

**Files:**
- Modify: `src/lib/worldEngine/types.ts` (`InstanceMetrics` block, `AzMetrics` ~line 111-126,
  `RegionMetrics` ~line 128-140)
- Modify: `src/lib/worldEngine/metrics.ts` (~line 391-399 instance loop, ~line 525-528 AZ rollup,
  ~line 552-553 region rollup)
- Test: `src/lib/worldEngine/metrics.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `InstanceMetrics.p90Ms: number`, `AzMetrics.p90Ms: number`, `RegionMetrics.p90Ms: number`
  — all additive-required-on-the-new-field (every `buildBatch` call site already builds these
  objects fresh each step, so there is no "absent" case to keep optional; unlike `serviceP50Ms`,
  which had pre-existing hand-built test fixtures to stay compatible with).

- [ ] **Step 1: Write the failing test — p90 sits strictly between p50 and p99**

Add to `src/lib/worldEngine/metrics.test.ts` (find the existing `buildBatch` test setup and mirror
its fixture style — it already builds a doc with one instance and calls `buildBatch` directly):

```ts
it('p90Ms sits between p50Ms and p99Ms for every instance', () => {
  const { doc, compiled } = /* reuse this file's existing single-instance fixture builder */
  const state = createMetricsState()
  // Feed a window of varied latencies so percentiles differ meaningfully.
  const w = state.window.get(instanceId) ?? { steps: 1, admittedSum: 10, errorSum: 0, latencies: [10, 20, 30, 40, 50, 200], selfLatencySum: 10 }
  state.window.set(instanceId, w)
  const batch = buildBatch(state, doc, compiled, routingSnapshotFixture, totalsFixture, 1000)
  const m = batch.instances[instanceId]
  expect(m.p90Ms).toBeGreaterThanOrEqual(m.p50Ms)
  expect(m.p90Ms).toBeLessThanOrEqual(m.p99Ms)
})
```

Adapt the fixture-construction calls to whatever helpers `metrics.test.ts` already exports/uses —
read the top of that file first; do not invent a new fixture shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/metrics.test.ts -t "p90Ms sits between"`
Expected: FAIL — `m.p90Ms` is `undefined`.

- [ ] **Step 3: Add the field to the contract**

In `src/lib/worldEngine/types.ts`, in `InstanceMetrics` (right after the `p99Ms` line, ~line 31):

```ts
  p99Ms: number                  // COMPOSED end-to-end, same basis as p50Ms
  // Additive-optional (contract-drift, FEAT-009): p90 — the percentile most SLOs are actually
  // written against, sitting between p50 (hides tails) and p99 (dominated by outliers). Published
  // UN-smoothed like p99Ms (audit ISSUE-037: EMA on a tail statistic attenuates a real spike),
  // over the SAME multi-second latency reservoir p50Ms/p99Ms already read.
  p90Ms: number
```

In `AzMetrics` (~line 115, after `p50Ms: number`) and `RegionMetrics` (~line 132, after
`p50Ms: number`), add:

```ts
  p90Ms: number
```

- [ ] **Step 4: Compute and publish at the instance level**

In `src/lib/worldEngine/metrics.ts`, right after the existing `p99Ms` line (~line 395):

```ts
    const p99Ms = percentile(sorted, 0.99)
    // p90 — same un-smoothed convention as p99Ms (audit ISSUE-037), same reservoir.
    const p90Ms = percentile(sorted, 0.9)
```

Add `p90Ms,` to the `instances[inst.id] = { ... }` object literal (~line 459), directly after
`p99Ms,`.

- [ ] **Step 5: Aggregate up AZ and region, same shape as the existing p50 rollup**

In the AZ loop (~line 525-528), add beside the existing `p50` rps-weighted mean:

```ts
    const p90 = inAz.length > 0
      ? inAz.reduce((s, i) => s + instances[i.id].p90Ms * (instances[i.id].rps || 1), 0) /
        Math.max(1, inAz.reduce((s, i) => s + (instances[i.id].rps || 1), 0))
      : 0
```

Add `p90Ms: p90,` to the `azs[az.id] = { ... }` object (~line 537, beside `p50Ms: p50,`).

In the region loop (~line 552-553), same shape:

```ts
    const p90 = inRegion.length > 0
      ? inRegion.reduce((s, a) => s + a.p90Ms * (a.rps || 1), 0) / Math.max(1, inRegion.reduce((s, a) => s + (a.rps || 1), 0))
      : 0
```

Add `p90Ms: p90,` to the `regions[region.id] = { ... }` object (~line 571).

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/metrics.test.ts`
Expected: PASS — including every pre-existing test in the file (they must stay green; this is an
additive-required field on a freshly-built object, so no other test's expected-object literals
should need touching unless they assert exact deep-equality on `instances[...]`/`azs[...]`/
`regions[...]` — if any do with `toEqual`, add `p90Ms` to their expected literal too).

- [ ] **Step 7: Log the contract change and commit**

Append an entry to `.superpowers/sdd/contract-drift.md`:

```markdown
## FEAT-009: `p90Ms` (additive)

Added `p90Ms: number` to `InstanceMetrics`, `AzMetrics`, `RegionMetrics` (`worldEngine/types.ts`).
Computed in `metrics.ts` as `percentile(sorted, 0.9)` over the same multi-second latency reservoir
`p50Ms`/`p99Ms` read, published un-smoothed (same convention as `p99Ms`, audit ISSUE-037).
Aggregated up AZ/region with the same rps-weighted-mean shape as the existing `p50Ms` rollup.
`WorldMetrics`/`ManagedServiceMetrics` were left untouched (out of scope for FEAT-009).
```

```bash
git add src/lib/worldEngine/types.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/metrics.test.ts .superpowers/sdd/contract-drift.md
git commit -m "feat(engine): publish p90Ms alongside p50Ms/p99Ms (FEAT-009)"
```

---

## Task 2: `signalsSeries.ts` — pure series extraction

**Files:**
- Create: `src/app/world/panels/signalsSeries.ts`
- Test: `src/app/world/panels/signalsSeries.test.ts` (node env — no React import in either file)

**Interfaces:**
- Consumes: `ReplayFrame` (`src/lib/worldEngine/types.ts` — `{ simMs: number; batch: MetricsBatch;
  events: EngineEvent[] }`), `DockScope` (`src/app/world/dock/scope.ts`).
- Produces:
  ```ts
  export type SignalKey = 'rps' | 'errorRate' | 'p50Ms' | 'p90Ms' | 'p99Ms' | 'activeConnections' | 'cpu' | 'queueDepth' | 'ramMb'
  export interface SeriesPoint { simMs: number; value: number }
  export interface DownsampledPoint { simMs: number; min: number; max: number; value: number }
  export function extractSeries(frames: ReplayFrame[], scope: DockScope, key: SignalKey): SeriesPoint[]
  export function downsample(points: SeriesPoint[], targetWidth: number): DownsampledPoint[]
  ```
  Later tasks (FEAT-010, Task 8) widen `SignalKey` with `'costUsdPerHour'` — do not close this
  union off with anything that would make widening awkward (e.g. don't exhaustively switch on it
  anywhere outside this file's own resolver).

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/world/panels/signalsSeries.test.ts
import { describe, it, expect } from 'vitest'
import { extractSeries, downsample, type SignalKey } from './signalsSeries'
import type { ReplayFrame } from '../../../lib/worldEngine/types'
import type { DockScope } from '../dock/scope'

function frame(simMs: number, instanceId: string, rps: number, p50Ms: number): ReplayFrame {
  return {
    simMs,
    events: [],
    batch: {
      simMs,
      instances: { [instanceId]: { instanceId, rps, errorRate: 0, p50Ms, p99Ms: p50Ms, p90Ms: p50Ms, activeConnections: 0, cpuCoresUsed: 0, ramMb: 0, health: 'healthy' } },
      servers: {}, azs: {}, regions: {}, managedServices: {}, topics: {},
      world: { totalRps: rps, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0 },
    } as any,
  }
}

describe('extractSeries', () => {
  it('returns one point per frame for a scope with data', () => {
    const frames = [frame(1000, 'i-1', 10, 50), frame(2000, 'i-1', 20, 60)]
    const scope: DockScope = { kind: 'server', regionId: 'r1', azId: 'az1', serverId: 'i-1' }
    // NOTE: adjust to however extractSeries actually resolves server scope to an instance id --
    // read compiled/doc-derived instance->server mapping if the resolver needs it; if it does,
    // this test must pass a doc/compiled fixture too. Check the implementation task below before
    // finalizing this fixture -- the resolver's exact scope->instance-ids mapping is defined there.
    const series = extractSeries(frames, scope, 'rps')
    expect(series).toEqual([{ simMs: 1000, value: 10 }, { simMs: 2000, value: 20 }])
  })

  it('returns an empty array for a scope with no matching data (no crash)', () => {
    const frames = [frame(1000, 'i-1', 10, 50)]
    const scope: DockScope = { kind: 'server', regionId: 'r1', azId: 'az1', serverId: 'does-not-exist' }
    expect(extractSeries(frames, scope, 'rps')).toEqual([])
  })
})

describe('downsample', () => {
  it('preserves a single-frame spike after downsampling to fewer columns', () => {
    const points = Array.from({ length: 300 }, (_, i) => ({ simMs: i * 1000, value: i === 150 ? 500 : 10 }))
    const buckets = downsample(points, 50)
    const spikeBucket = buckets.find(b => b.max >= 500)
    expect(spikeBucket).toBeDefined()
    expect(spikeBucket!.max).toBe(500)
  })

  it('is a no-op-ish pass-through when targetWidth >= point count', () => {
    const points = [{ simMs: 0, value: 1 }, { simMs: 1000, value: 2 }]
    const buckets = downsample(points, 300)
    expect(buckets).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/world/panels/signalsSeries.test.ts`
Expected: FAIL — module `./signalsSeries` does not exist.

- [ ] **Step 3: Implement `extractSeries`**

```ts
// src/app/world/panels/signalsSeries.ts
import type { ReplayFrame } from '../../../lib/worldEngine/types'
import type { DockScope } from '../dock/scope'

export type SignalKey =
  | 'rps' | 'errorRate' | 'p50Ms' | 'p90Ms' | 'p99Ms'
  | 'activeConnections' | 'cpu' | 'queueDepth' | 'ramMb'

export interface SeriesPoint { simMs: number; value: number }
export interface DownsampledPoint { simMs: number; min: number; max: number; value: number }

// InstanceMetrics has no `queueDepth` gauge and `cpu` reads `cpuCoresUsed` -- map the display key
// to the actual field name once, here, so extractSeries and any future consumer agree.
const INSTANCE_FIELD: Partial<Record<SignalKey, string>> = {
  rps: 'rps', errorRate: 'errorRate', p50Ms: 'p50Ms', p90Ms: 'p90Ms', p99Ms: 'p99Ms',
  activeConnections: 'activeConnections', cpu: 'cpuCoresUsed', ramMb: 'ramMb',
}

function instanceIdsForScope(scope: DockScope, batch: ReplayFrame['batch']): string[] {
  if (scope.kind === 'server') {
    return Object.values(batch.instances)
      .filter((i: any) => i.instanceId === scope.serverId || i.serverId === scope.serverId)
      .map((i: any) => i.instanceId)
  }
  return []
}

function valueForScope(scope: DockScope, key: SignalKey, batch: ReplayFrame['batch']): number | null {
  if (scope.kind === 'world') {
    if (key === 'rps') return batch.world.totalRps
    if (key === 'errorRate') return batch.world.errorRate
    return null   // p50/p90/p99/activeConnections/cpu/ramMb have no world-level rollup today
  }
  if (scope.kind === 'region') {
    const r = batch.regions[scope.regionId]
    if (!r) return null
    if (key === 'rps') return r.rps
    if (key === 'errorRate') return r.errorRate
    if (key === 'p50Ms' || key === 'p90Ms') return (r as any)[key] ?? null
    return null
  }
  if (scope.kind === 'az') {
    const a = batch.azs[scope.azId]
    if (!a) return null
    if (key === 'rps') return a.rps
    if (key === 'errorRate') return a.errorRate
    if (key === 'p50Ms' || key === 'p90Ms') return (a as any)[key] ?? null
    return null
  }
  // server scope: rps-weighted mean/sum across the resident instances -- for a single-instance
  // server (today's placement model in practice) this is exactly that instance's own reading.
  const ids = instanceIdsForScope(scope, batch)
  if (ids.length === 0) return null
  const field = INSTANCE_FIELD[key]
  if (!field) return null
  if (key === 'rps' || key === 'activeConnections' || key === 'cpu' || key === 'ramMb') {
    return ids.reduce((s, id) => s + (batch.instances[id] as any)[field], 0)
  }
  // latency/error percentiles: rps-weighted mean, matching metrics.ts's own AZ/region rollup shape.
  const totalRps = ids.reduce((s, id) => s + (batch.instances[id].rps || 1), 0)
  return ids.reduce((s, id) => s + (batch.instances[id] as any)[field] * (batch.instances[id].rps || 1), 0) / Math.max(1, totalRps)
}

export function extractSeries(frames: ReplayFrame[], scope: DockScope, key: SignalKey): SeriesPoint[] {
  const points: SeriesPoint[] = []
  for (const f of frames) {
    const value = valueForScope(scope, key, f.batch)
    if (value !== null) points.push({ simMs: f.simMs, value })
  }
  return points
}

export function downsample(points: SeriesPoint[], targetWidth: number): DownsampledPoint[] {
  if (points.length === 0) return []
  if (points.length <= targetWidth) {
    return points.map(p => ({ simMs: p.simMs, min: p.value, max: p.value, value: p.value }))
  }
  const bucketSize = points.length / targetWidth
  const buckets: DownsampledPoint[] = []
  for (let b = 0; b < targetWidth; b++) {
    const start = Math.floor(b * bucketSize)
    const end = Math.min(points.length, Math.floor((b + 1) * bucketSize))
    const slice = points.slice(start, Math.max(start + 1, end))
    if (slice.length === 0) continue
    const values = slice.map(p => p.value)
    buckets.push({
      simMs: slice[Math.floor(slice.length / 2)].simMs,
      min: Math.min(...values),
      max: Math.max(...values),
      value: values.reduce((s, v) => s + v, 0) / values.length,
    })
  }
  return buckets
}
```

Note: `'queueDepth'` has no source field on `InstanceMetrics` today (there is no published queue
depth gauge in the repo — verify with `grep -rn queueDepth src/lib/worldEngine` before assuming
one exists). Leave it resolving to `null`/empty series for now; do not invent a fake reading. If a
per-instance queue depth gauge exists under a different name, wire it here instead of leaving the
gap — check before implementing this step.

- [ ] **Step 4: Fix up the scope-resolution test fixtures from Step 1**

Revisit the two `extractSeries` tests: the `frame()` helper's `MetricsBatch` fixture must include
`azs`/`regions`/`world` shaped correctly for whichever scope you test against; the `server` scope
path filters `batch.instances` by `instanceId === scope.serverId` — adjust the test's instance id
to match a real server id convention, or switch the test to `region`/`az` scope using the fixture's
`regions`/`azs` maps, whichever is simpler to fixture correctly. Get this concrete before moving on.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/world/panels/signalsSeries.test.ts`
Expected: PASS, all four tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/panels/signalsSeries.ts src/app/world/panels/signalsSeries.test.ts
git commit -m "feat(signals): add pure series extraction + extrema-preserving downsample"
```

---

## Task 3: `SignalChart.tsx` — the one shared SVG chart renderer

**Files:**
- Create: `src/app/world/panels/SignalChart.tsx`
- Test: `src/app/world/panels/SignalChart.test.tsx` (`// @vitest-environment jsdom` docblock at the
  top of the file, matching `src/app/world/region/TimelineV2.test.tsx`'s convention)

**Interfaces:**
- Consumes: `DownsampledPoint[]` from Task 2, a `color` (a `CATEGORY_COLORS`/`var(--color-*)`
  string), a `width`/`height`, an optional `playheadSimMs`, an optional `onScrub: (simMs: number) =>
  void`, an optional `markers: { simMs: number; label: string }[]` (engine events).
- Produces: `export function SignalChart(props: SignalChartProps): JSX.Element` — one `<svg>`: a
  `<path>` min/max band, a `<polyline>` mean line, an optional playhead `<line>`, optional marker
  ticks. No canvas. Used by both `SignalsPanel.tsx` (Task 4) and `CostTab.tsx`'s sparkline
  (Task 10) — this is the single charting code path FEAT-010's spec explicitly requires.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SignalChart } from './SignalChart'

describe('SignalChart', () => {
  it('renders a polyline and a min/max band path', () => {
    const points = [{ simMs: 0, min: 1, max: 5, value: 3 }, { simMs: 1000, min: 2, max: 8, value: 4 }]
    const { container } = render(<SignalChart points={points} color="var(--color-danger)" width={200} height={40} />)
    expect(container.querySelector('polyline')).not.toBeNull()
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(1)
  })

  it('calls onScrub with the nearest point simMs on click', () => {
    const points = [{ simMs: 0, min: 1, max: 5, value: 3 }, { simMs: 1000, min: 2, max: 8, value: 4 }]
    let scrubbed: number | null = null
    const { container } = render(
      <SignalChart points={points} color="var(--color-danger)" width={200} height={40} onScrub={(ms) => { scrubbed = ms }} />,
    )
    const svg = container.querySelector('svg')!
    fireEvent.click(svg, { clientX: 190, clientY: 20 })
    expect(scrubbed).toBe(1000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/SignalChart.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `SignalChart`**

```tsx
// src/app/world/panels/SignalChart.tsx
import type { DownsampledPoint } from './signalsSeries'

export interface SignalChartProps {
  points: DownsampledPoint[]
  color: string
  width: number
  height: number
  playheadSimMs?: number | null
  onScrub?: (simMs: number) => void
  markers?: { simMs: number; label: string }[]
}

export function SignalChart({ points, color, width, height, playheadSimMs, onScrub, markers }: SignalChartProps) {
  if (points.length === 0) {
    return <svg width={width} height={height} role="img" aria-label="no data" />
  }
  const minMs = points[0].simMs
  const maxMs = points[points.length - 1].simMs
  const spanMs = Math.max(1, maxMs - minMs)
  const allValues = points.flatMap(p => [p.min, p.max])
  const lo = Math.min(...allValues)
  const hi = Math.max(...allValues)
  const spanV = Math.max(1e-9, hi - lo)
  const x = (simMs: number) => ((simMs - minMs) / spanMs) * width
  const y = (v: number) => height - ((v - lo) / spanV) * height

  const linePts = points.map(p => `${x(p.simMs)},${y(p.value)}`).join(' ')
  const bandTop = points.map(p => `${x(p.simMs)},${y(p.max)}`)
  const bandBottom = points.slice().reverse().map(p => `${x(p.simMs)},${y(p.min)}`)
  const bandPath = `M ${[...bandTop, ...bandBottom].join(' L ')} Z`

  const nearestSimMs = (clientX: number, rect: DOMRect) => {
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const targetMs = minMs + ratio * spanMs
    let nearest = points[0].simMs
    let bestDelta = Infinity
    for (const p of points) {
      const d = Math.abs(p.simMs - targetMs)
      if (d < bestDelta) { bestDelta = d; nearest = p.simMs }
    }
    return nearest
  }

  return (
    <svg
      width={width} height={height}
      role="img" aria-label="signal chart"
      onClick={onScrub ? (e) => onScrub(nearestSimMs(e.clientX, e.currentTarget.getBoundingClientRect())) : undefined}
      style={{ cursor: onScrub ? 'pointer' : 'default', display: 'block' }}
    >
      <path d={bandPath} fill={color} fillOpacity={0.15} stroke="none" />
      <polyline points={linePts} fill="none" stroke={color} strokeWidth={1.5} />
      {markers?.map((m, i) => (
        <line key={i} x1={x(m.simMs)} x2={x(m.simMs)} y1={0} y2={height} stroke="var(--color-text-muted)" strokeWidth={1} strokeDasharray="2,2" />
      ))}
      {playheadSimMs != null && (
        <line x1={x(playheadSimMs)} x2={x(playheadSimMs)} y1={0} y2={height} stroke="var(--color-text-primary)" strokeWidth={1} />
      )}
    </svg>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/panels/SignalChart.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/world/panels/SignalChart.tsx src/app/world/panels/SignalChart.test.tsx
git commit -m "feat(signals): add the one shared SVG chart renderer for series data"
```

---

## Task 4: `SignalsPanel.tsx` — the Signals tab body

**Files:**
- Create: `src/app/world/panels/SignalsPanel.tsx`
- Test: `src/app/world/panels/SignalsPanel.test.tsx` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `useSimulationStore` (for `getReplayFrames()`, `setScrubIndex`, `scrubIndex`,
  `latestBatch`), `DockScope` (prop, passed down from `WorldPanel.tsx`), `extractSeries`/
  `downsample` (Task 2), `SignalChart` (Task 3).
- Produces: `export function SignalsPanel({ scope }: { scope: DockScope }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SignalsPanel } from './SignalsPanel'
import { useSimulationStore } from '../../store/simulation.store'

describe('SignalsPanel', () => {
  it('renders one row per signal at world scope with no crash on empty frames', () => {
    vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue([])
    render(<SignalsPanel scope={{ kind: 'world' }} />)
    expect(screen.getByText(/rps/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/SignalsPanel.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `SignalsPanel`**

```tsx
// src/app/world/panels/SignalsPanel.tsx
import { useMemo } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import { extractSeries, downsample, type SignalKey } from './signalsSeries'
import { SignalChart } from './SignalChart'
import type { DockScope } from '../dock/scope'
import { CATEGORY_COLORS } from '../../../lib/theme'

const ROWS: { key: SignalKey; label: string }[] = [
  { key: 'rps', label: 'rps' },
  { key: 'errorRate', label: 'error rate' },
  { key: 'p50Ms', label: 'p50 ms' },
  { key: 'p90Ms', label: 'p90 ms' },
  { key: 'p99Ms', label: 'p99 ms' },
  { key: 'activeConnections', label: 'connections' },
  { key: 'cpu', label: 'cpu' },
  { key: 'ramMb', label: 'ram mb' },
]

const CHART_WIDTH = 300
const CHART_HEIGHT = 36

export function SignalsPanel({ scope }: { scope: DockScope }) {
  const frames = useSimulationStore(s => s.getReplayFrames())
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)
  const lastFrameSimMs = frames.length > 0 ? frames[frames.length - 1].simMs : null

  const seriesByKey = useMemo(() => {
    const out: Record<string, ReturnType<typeof downsample>> = {}
    for (const row of ROWS) {
      out[row.key] = downsample(extractSeries(frames, scope, row.key), CHART_WIDTH)
    }
    return out
    // Memo key deliberately excludes `frames`/`scope` object identity in favor of stable
    // primitives -- frames.length + lastFrameSimMs changes exactly once per new 1 Hz frame, and
    // scope keys the memo per distinct scope value (JSON-stable for this discriminated union).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames.length, lastFrameSimMs, JSON.stringify(scope)])

  const playheadSimMs = scrubIndex != null ? frames[scrubIndex]?.simMs ?? null : lastFrameSimMs
  const markers = useMemo(
    () => frames.flatMap(f => f.events.map(e => ({ simMs: f.simMs, label: e.kind }))),
    [frames.length, lastFrameSimMs],
  )

  const handleScrub = (simMs: number) => {
    let nearestIdx = 0
    let bestDelta = Infinity
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].simMs - simMs)
      if (d < bestDelta) { bestDelta = d; nearestIdx = i }
    }
    setScrubIndex(nearestIdx, frames)
  }

  if (frames.length === 0) {
    return <div style={{ color: 'var(--color-text-muted)' }}>no history yet -- run the simulation to populate signals</div>
  }

  return (
    <div>
      {ROWS.map((row, i) => (
        <div key={row.key} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginBottom: 2, fontFamily: 'var(--font-mono)' }}>{row.label}</div>
          <SignalChart
            points={seriesByKey[row.key]}
            color={Object.values(CATEGORY_COLORS)[i % Object.values(CATEGORY_COLORS).length].base}
            width={CHART_WIDTH} height={CHART_HEIGHT}
            playheadSimMs={playheadSimMs}
            markers={i === 0 ? markers : undefined}
            onScrub={handleScrub}
          />
        </div>
      ))}
    </div>
  )
}
```

Read `src/lib/theme.ts`'s actual `CATEGORY_COLORS` shape before finalizing the color indexing
above (it may be keyed by category name with a `.base`/`.foreground.light` structure per
`CLAUDE.md`'s Design System section — adjust the accessor to match exactly; do not guess the shape
from this plan).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/panels/SignalsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the memoization-discipline test**

```tsx
it('does not recompute series on a re-render with unchanged frames/scope', () => {
  const frames = [/* two-frame fixture, as in Task 2 */]
  vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
  const extractSpy = vi.spyOn(await import('./signalsSeries'), 'extractSeries')
  const { rerender } = render(<SignalsPanel scope={{ kind: 'world' }} />)
  const callsAfterMount = extractSpy.mock.calls.length
  rerender(<SignalsPanel scope={{ kind: 'world' }} />)
  expect(extractSpy.mock.calls.length).toBe(callsAfterMount)
})
```

Run: `npx vitest run src/app/world/panels/SignalsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/panels/SignalsPanel.tsx src/app/world/panels/SignalsPanel.test.tsx
git commit -m "feat(signals): add SignalsPanel — stacked small-multiples over the replay ring"
```

---

## Task 5: Wire the `'signals'` tab into `ui.store.ts` / `dock/scope.ts` / `WorldPanel.tsx`

**Files:**
- Modify: `src/app/store/ui.store.ts` (`PanelTab` union, ~line 36)
- Modify: `src/app/world/dock/scope.ts` (`WORLD_TABS`/`SCOPED_TABS`, ~line 64-65)
- Modify: `src/app/world/panels/WorldPanel.tsx` (**hub file** — `TAB_LABELS` ~line 68-72, header
  switch ~line 249-283, world-scope body ~line 332-347, non-world body ~line 356-372)

**Interfaces:**
- Consumes: `SignalsPanel` (Task 4).
- Produces: a `'signals'` tab reachable at every scope, per the spec ("added to both `WORLD_TABS`
  and `SCOPED_TABS`").

- [ ] **Step 1: Write the failing test**

Add to an existing `WorldPanel.test.tsx` if one exists (check `Glob
src/app/world/panels/WorldPanel.test.tsx` first) — otherwise add to `dock/scope.test.ts` (check
that file exists first; if neither exists, add a focused test inline in `scope.ts`'s own test file
following whatever the repo's convention is for that module):

```ts
it('includes signals in both WORLD_TABS and SCOPED_TABS', () => {
  expect(scopeTabs({ kind: 'world' })).toContain('signals')
  expect(scopeTabs({ kind: 'region', regionId: 'r1' })).toContain('signals')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/dock/scope.test.ts` (or wherever Step 1 landed)
Expected: FAIL.

- [ ] **Step 3: Add `'signals'` to `PanelTab`**

In `src/app/store/ui.store.ts` (~line 36):

```ts
export type PanelTab = 'topology' | 'blueprints' | 'packets' | 'managed' | 'connections' | 'traffic' | 'routes' | 'scenario' | 'signals' | 'analysis' | 'events' | 'cost' | 'config'
```

- [ ] **Step 4: Add it to both tab lists**

In `src/app/world/dock/scope.ts` (~line 64-65):

```ts
const WORLD_TABS: PanelTab[] = ['topology', 'blueprints', 'packets', 'managed', 'connections', 'traffic', 'routes', 'scenario', 'signals', 'analysis', 'events', 'cost']
const SCOPED_TABS: PanelTab[] = ['config', 'signals', 'analysis', 'events', 'cost']
```

- [ ] **Step 5: Wire the label, header, and both bodies in `WorldPanel.tsx`**

`TAB_LABELS` (~line 68-72):

```ts
const TAB_LABELS: Record<PanelTab, string> = {
  topology: 'Topology', blueprints: 'Blueprints', packets: 'Packets', managed: 'Managed',
  connections: 'Connections', traffic: 'Traffic',
  routes: 'Routes', scenario: 'Scenario', signals: 'Signals', analysis: 'Analysis', events: 'Events', cost: 'Cost', config: 'Config',
}
```

Header switch, add a case right after the existing `'scenario'` case (~line 254):

```ts
    case 'signals': {
      header = { glyph: '◷', accent: 'var(--color-accent)', summary: frames.length > 0 ? `${frames.length} frames of history` : 'no history yet' }
      break
    }
```

(`frames` here needs `useSimulationStore(s => s.getReplayFrames())` pulled into scope near the
top of the component alongside the existing `displayBatch`/`events` reads — add that selector.)

World-scope body (~line 343, right after the `scenario` line):

```tsx
            {tab === 'signals' && <SignalsPanel scope={scope} />}
```

Non-world body (~line 370, right after the `events` line):

```tsx
            {tab === 'signals' && <SignalsPanel scope={scope} />}
```

Add the import at the top with the other panel imports:

```ts
import { SignalsPanel } from './SignalsPanel'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/app/world/dock/scope.test.ts`
Expected: PASS.

- [ ] **Step 7: `npx tsc --noEmit` and live smoke**

Run: `npx tsc --noEmit` — fix any type errors from the new tab arm.
Then `npm run tauri dev`, open the dock at world scope, click the new "Signals" tab, confirm eight
rows render with no console errors, in both dark and light theme (toggle via ⚙ Settings).

- [ ] **Step 8: Commit**

```bash
git add src/app/store/ui.store.ts src/app/world/dock/scope.ts src/app/world/panels/WorldPanel.tsx
git commit -m "feat(signals): wire the Signals tab into every scope (FEAT-009)"
```

---

## Task 6: The determinism/scrub-following integration tests for FEAT-009

**Files:**
- Test: `src/app/world/panels/SignalsPanel.test.tsx` (extend)

**Interfaces:** none new — this task is pure verification per the spec's Acceptance Criteria.

- [ ] **Step 1: Write the click-to-scrub test**

```tsx
it('clicking a chart sets scrubIndex via the store', () => {
  const frames = [/* 3+ frame fixture with distinct simMs */]
  vi.spyOn(useSimulationStore.getState(), 'getReplayFrames').mockReturnValue(frames)
  const setScrubIndexSpy = vi.spyOn(useSimulationStore.getState(), 'setScrubIndex')
  const { container } = render(<SignalsPanel scope={{ kind: 'world' }} />)
  const svg = container.querySelectorAll('svg')[0]
  fireEvent.click(svg, { clientX: 10, clientY: 10 })
  expect(setScrubIndexSpy).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run, confirm pass (this should already pass given Task 4/5's wiring — if it fails,
  fix `SignalsPanel`'s `handleScrub`, not the test)**

Run: `npx vitest run src/app/world/panels/SignalsPanel.test.tsx`

- [ ] **Step 3: Live smoke — the spec's actual acceptance bar**

In `npm run tauri dev`: run any scenario with a failure (or manually kill a server), open Signals
at region scope, confirm error rate/p99 move together and an event marker lines up with the
inflection. Scrub back on the chart and confirm the AZ floor / server board follow to the same
instant (they already read `scrubBatch ?? latestBatch`, so this should need zero extra wiring —
if it doesn't follow, the bug is in `handleScrub`/`setScrubIndex` usage, not in the other views).

- [ ] **Step 4: Commit**

```bash
git add src/app/world/panels/SignalsPanel.test.tsx
git commit -m "test(signals): scrub-interaction coverage for the Signals panel"
```

---

## Task 7: `hourlyUsd` + `attributeByBlueprint` on `costModelV2.ts`

**Files:**
- Modify: `src/lib/costModelV2.ts` (`WorldCostResult` ~line 48-62, `computeWorldCost` ~line 189-310)
- Test: `src/lib/costModelV2.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `compiled.instances` (per-server residency), `WorkloadProfile.cpuShares` (`world/
  types.ts:163`, absent ⇒ 1), `MetricsBatch.runningByPlacement` (existing, `types.ts:227`),
  the flow solver's `depBytesById`/per-instance egress totals — **reuse the existing rollup
  totals already threaded into `computeWorldCost` via `world: WorldMetrics`** rather than
  re-deriving byte attribution from `flows.ts` internals (that data does not reach `costModelV2.ts`
  today; if per-blueprint egress attribution needs it, thread it through the SAME
  `world`/`managed` parameters `computeWorldCost` already takes — check `MetricsBatch` for
  whatever per-instance byte breakdown already exists before inventing a new plumbing path).
- Produces:
  ```ts
  export interface WorldCostResult {
    // ...existing fields unchanged...
    hourlyUsd: number
  }
  export interface BlueprintCostRow { blueprintId: string; label: string; monthlyUsd: number }
  export function attributeByBlueprint(
    doc: WorldDoc, compiled: CompiledWorld,
    world: (WorldMetrics & { runningByPlacement?: Record<PlacementId, number> }) | null,
    managed: Record<ManagedServiceId, ManagedServiceMetrics> | null,
  ): BlueprintCostRow[]
  ```

- [ ] **Step 1: Write the failing `hourlyUsd` test**

```ts
it('hourlyUsd × 730 === monthlyUsd exactly', () => {
  const { doc } = /* reuse this file's existing single-server fixture */
  const cost = computeWorldCost(doc, null, null)
  expect(cost.hourlyUsd * HOURS_PER_MONTH).toBeCloseTo(cost.monthlyUsd, 10)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costModelV2.test.ts -t "hourlyUsd"`
Expected: FAIL — `cost.hourlyUsd` is `undefined`.

- [ ] **Step 3: Add `hourlyUsd` to the result**

In `src/lib/costModelV2.ts`, `WorldCostResult` (~line 49):

```ts
export interface WorldCostResult {
  monthlyUsd: number
  hourlyUsd: number   // monthlyUsd / HOURS_PER_MONTH — the primary FinOps unit (FEAT-010)
  byRegion: { regionId: RegionId; monthlyUsd: number }[]
  ...
```

In the return statement (~line 301-309):

```ts
  return {
    monthlyUsd,
    hourlyUsd: monthlyUsd / HOURS_PER_MONTH,
    byRegion: ...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: PASS (all pre-existing tests too — this is purely additive).

- [ ] **Step 5: Write the failing attribution test**

```ts
it('attributeByBlueprint splits a shared server by cpuShares', () => {
  // Build a doc with one server hosting two placements of two blueprints, cpuShares 1 and 3.
  const doc = buildDocWithTwoPlacements({ shareA: 1, shareB: 3 })   // write this helper inline,
  // matching whatever fixture-builder convention this test file already uses for placements.
  const compiled = compileWorld(doc)
  const rows = attributeByBlueprint(doc, compiled, null, null)
  const total = rows.reduce((s, r) => s + r.monthlyUsd, 0)
  const a = rows.find(r => r.blueprintId === 'bp-a')!
  const b = rows.find(r => r.blueprintId === 'bp-b')!
  expect(a.monthlyUsd / total).toBeCloseTo(0.25, 2)
  expect(b.monthlyUsd / total).toBeCloseTo(0.75, 2)
})

it('attributeByBlueprint sums to computeWorldCost\'s compute total', () => {
  const doc = /* the same or a richer fixture with managed services too */
  const compiled = compileWorld(doc)
  const rows = attributeByBlueprint(doc, compiled, null, null)
  const cost = computeWorldCost(doc, null, null)
  const attributed = rows.reduce((s, r) => s + r.monthlyUsd, 0)
  expect(attributed).toBeCloseTo(cost.monthlyUsd, 2)
})

it('a parked (non-running) instance contributes zero', () => {
  const doc = /* a doc with an autoscaled placement at minCount 1, maxCount 3 */
  const compiled = compileWorld(doc)
  const world = { totalRps: 0, errorRate: 0, populationRoutes: [], crossAzBytesPerSec: 0, crossRegionBytesPerSec: 0, internetEgressBytesPerSec: 0, runningByPlacement: { [placementId]: 1 } }
  const rows = attributeByBlueprint(doc, compiled, world, null)
  // Confirm the row's monthlyUsd matches ONE running instance's share, not maxCount's.
})
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run src/lib/costModelV2.test.ts -t "attributeByBlueprint"`
Expected: FAIL — function does not exist.

- [ ] **Step 7: Implement `attributeByBlueprint`**

```ts
export interface BlueprintCostRow { blueprintId: string; label: string; monthlyUsd: number }

export function attributeByBlueprint(
  doc: WorldDoc,
  compiled: CompiledWorld,
  world: (WorldMetrics & { runningByPlacement?: Record<PlacementId, number> }) | null,
  managed: Record<ManagedServiceId, ManagedServiceMetrics> | null,
): BlueprintCostRow[] {
  const byBlueprint = new Map<string, number>()
  const bump = (id: string, usd: number) => byBlueprint.set(id, (byBlueprint.get(id) ?? 0) + usd)

  // Group RUNNING instances by server, weighting by workload.cpuShares (absent -> 1) -- the SAME
  // weight hostScheduler.ts uses for capacity, so the cost split and the capacity split tell one
  // story (spec requirement).
  const instancesByServer = new Map<ServerId, { blueprintId: string; placementId: PlacementId; cpuShares: number }[]>()
  for (const inst of Object.values(compiled.instances)) {
    const placement = doc.placements[inst.placementId]
    if (!placement) continue
    const runningCount = placement.autoscale
      ? (world?.runningByPlacement?.[placement.id] ?? placement.count)
      : placement.count
    // A parked instance (FEAT-008): compiled.instances may still list it, but if the running
    // count for its placement is 0, none of its resident instances bill. Since compiled.instances
    // doesn't itself carry a per-instance "is this the Nth of the placement" ordinal here, use the
    // SAME runningSet semantics metrics.ts's buildBatch already applies -- read `world`'s
    // runningByPlacement to gate the WHOLE placement's contribution to 0 when runningCount is 0,
    // and otherwise bill it in full per resident server (matching computeWorldCost's own
    // per-SERVER, not per-instance, billing granularity -- a server bills in full unless
    // apportioned by autoscale share, exactly as computeWorldCost already does above).
    if (placement.autoscale && runningCount === 0) continue
    const bp = doc.blueprints[inst.blueprintId]
    const list = instancesByServer.get(inst.serverId) ?? []
    list.push({ blueprintId: inst.blueprintId, placementId: inst.placementId, cpuShares: Math.max(0, bp?.workload.cpuShares ?? 1) })
    instancesByServer.set(inst.serverId, list)
  }

  for (const server of Object.values(doc.servers)) {
    const residents = instancesByServer.get(server.id) ?? []
    if (residents.length === 0) continue
    const placementsByServer = new Map<PlacementId, boolean>()
    for (const r of residents) placementsByServer.set(r.placementId, true)
    const anyAutoscaled = [...placementsByServer.keys()].some(pid => doc.placements[pid]?.autoscale)
    let billedFraction = 1
    if (anyAutoscaled) {
      let runningWeight = 0, maxWeight = 0
      for (const pid of placementsByServer.keys()) {
        const pl = doc.placements[pid]
        if (!pl) continue
        const maxW = pl.autoscale ? pl.autoscale.maxCount : pl.count
        const runningW = pl.autoscale ? (world?.runningByPlacement?.[pl.id] ?? pl.count) : pl.count
        maxWeight += maxW
        runningWeight += runningW
      }
      billedFraction = maxWeight > 0 ? runningWeight / maxWeight : 1
    }
    const serverUsd = server.hourlyUsd * HOURS_PER_MONTH * billedFraction
    const totalShares = residents.reduce((s, r) => s + r.cpuShares, 0) || residents.length
    for (const r of residents) {
      bump(r.blueprintId, serverUsd * (r.cpuShares / totalShares))
    }
  }

  // Managed services attribute directly -- they are already priced per service, not per resident.
  // There is no blueprint on a ManagedService, so group these under the service's OWN id string
  // (a synthetic "blueprint row" the Cost tab can label distinctly, e.g. "redis-cache (managed)").
  for (const ms of Object.values(doc.managedServices)) {
    const usd = managedServiceMonthlyUsd(ms, managed?.[ms.id]?.rps ?? 0) + (managed ? managedEgressUsd(ms, managed[ms.id]?.egressBytesPerSec ?? 0) : 0)
    if (usd === 0) continue
    bump(`managed:${ms.id}`, usd)
  }

  return [...byBlueprint.entries()].map(([blueprintId, monthlyUsd]) => ({
    blueprintId,
    label: doc.blueprints[blueprintId]?.label ?? doc.managedServices[blueprintId.replace('managed:', '')]?.label ?? blueprintId,
    monthlyUsd,
  })).sort((a, b) => b.monthlyUsd - a.monthlyUsd)
}
```

Note on the reconciliation test (Step 5's second test): `computeWorldCost`'s `monthlyUsd` also
includes load-balancer and cross-AZ/cross-region/internet egress lines that have no blueprint
owner. If the reconciliation assertion doesn't hold exactly for a fixture with those present, scope
the test fixture to a world with no LBs and no cross-zone traffic (egress attributes to the
CALLING blueprint per the spec, which is a separate, larger undertaking than this task covers if
`MetricsBatch` doesn't already carry per-instance egress bytes — check `types.ts` for a
per-instance byte field before deciding whether egress attribution is in scope for this task or
needs to be flagged as a documented gap in the Cost tab's "by service" section, e.g. an explicit
"+ $X/mo in cross-zone/LB costs not attributed to a service" line instead of a false-precision
100%-reconciling total).

- [ ] **Step 8: Run tests, iterate on the reconciliation fixture until it passes**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: PASS. If the reconciliation test needs the documented-gap approach above, update the
test's assertion (and this task's Step 7 note) to match reality — don't force a false reconcile.

- [ ] **Step 9: Commit**

```bash
git add src/lib/costModelV2.ts src/lib/costModelV2.test.ts
git commit -m "feat(cost): add hourlyUsd + cpuShares-weighted per-blueprint attribution"
```

---

## Task 8: `costUsdPerHour` as a `SignalKey` + `costSeries.ts` memo

**Files:**
- Modify: `src/app/world/panels/signalsSeries.ts` (widen `SignalKey`)
- Create: `src/lib/costSeries.ts`
- Test: `src/lib/costSeries.test.ts` (node env)

**Interfaces:**
- Consumes: `ReplayFrame[]`, `WorldDoc`, `computeWorldCost` (Task 7).
- Produces:
  ```ts
  export function costSeriesFor(frames: ReplayFrame[], doc: WorldDoc): Map<number, WorldCostResult>
  export function incidentCost(series: Map<number, WorldCostResult>, frames: ReplayFrame[], fromIdx: number, toIdx: number): { actualUsd: number; baselineUsd: number; incidentUsd: number }
  ```

- [ ] **Step 1: Write the failing memoization test — the specific perf trap the design exists to
  avoid**

```ts
// src/lib/costSeries.test.ts
import { describe, it, expect, vi } from 'vitest'
import * as costModel from './costModelV2'
import { costSeriesFor } from './costSeries'

describe('costSeriesFor', () => {
  it('calls computeWorldCost at most once per frame, cached across repeated calls', () => {
    const spy = vi.spyOn(costModel, 'computeWorldCost')
    const frames = Array.from({ length: 10 }, (_, i) => ({ simMs: i * 1000, events: [], batch: fixtureBatch(i) }))
    const doc = fixtureDoc()
    const cache = costSeriesFor(frames, doc)
    costSeriesFor(frames, doc, cache)   // second call reuses the same cache instance
    expect(spy).toHaveBeenCalledTimes(10)
  })
})
```

Adjust the signature if a mutable cache-passing API (`costSeriesFor(frames, doc, cache?)`) is
cleaner than an internally-memoized module-level map — a caller-owned `Map` (matching the spec's
"a `Map<number, WorldCostResult>` in the Cost tab's module scope or a small `costSeries.ts`") is
preferable because `CostTab.tsx` needs to hold that cache across re-renders via `useRef`, and a
module-level cache would leak across different worlds/docs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costSeries.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `costSeriesFor` and `incidentCost`**

```ts
// src/lib/costSeries.ts
import type { WorldDoc } from './world/types'
import type { ReplayFrame } from './worldEngine/types'
import { computeWorldCost, type WorldCostResult } from './costModelV2'

export function costSeriesFor(
  frames: ReplayFrame[], doc: WorldDoc, cache: Map<number, WorldCostResult> = new Map(),
): Map<number, WorldCostResult> {
  for (let i = 0; i < frames.length; i++) {
    if (cache.has(i)) continue
    const f = frames[i]
    const worldForCost = f.batch.world ? { ...f.batch.world, runningByPlacement: f.batch.runningByPlacement } : null
    cache.set(i, computeWorldCost(doc, worldForCost, f.batch.managedServices ?? null))
  }
  return cache
}

export function incidentCost(
  series: Map<number, WorldCostResult>, frames: ReplayFrame[], fromIdx: number, toIdx: number,
): { actualUsd: number; baselineUsd: number; incidentUsd: number } {
  if (toIdx <= fromIdx || !series.has(fromIdx)) return { actualUsd: 0, baselineUsd: 0, incidentUsd: 0 }
  let actualUsd = 0
  for (let i = fromIdx; i < toIdx; i++) {
    const cost = series.get(i)
    if (!cost) continue
    const frameSec = Math.max(0, (frames[i + 1]?.simMs ?? frames[i].simMs) - frames[i].simMs) / 1000
    actualUsd += cost.hourlyUsd * (frameSec / 3600)
  }
  const durationSec = (frames[toIdx]?.simMs ?? frames[fromIdx].simMs) - frames[fromIdx].simMs
  const baselineUsd = (series.get(fromIdx)?.hourlyUsd ?? 0) * (durationSec / 1000 / 3600)
  return { actualUsd, baselineUsd, incidentUsd: actualUsd - baselineUsd }
}
```

Note: memoizing by cache **must** invalidate the whole cache on doc identity change (a different
world). Since `costSeriesFor` takes a caller-owned `cache` argument, that invalidation is the
caller's job (Task 10's `CostTab.tsx` — reset the `useRef` cache when `doc` changes identity), not
this function's — document that at the call site, not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costSeries.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen `SignalKey`**

In `src/app/world/panels/signalsSeries.ts`:

```ts
export type SignalKey =
  | 'rps' | 'errorRate' | 'p50Ms' | 'p90Ms' | 'p99Ms'
  | 'activeConnections' | 'cpu' | 'queueDepth' | 'ramMb'
  | 'costUsdPerHour'
```

`extractSeries` itself does NOT need a `costUsdPerHour` branch — cost isn't read off
`ReplayFrame.batch` (it's derived per-frame from `costSeriesFor`, not published by the engine).
`CostTab.tsx` (Task 10) builds its own `SeriesPoint[]` directly from the `costSeriesFor` map and
feeds it straight to `downsample`/`SignalChart`, bypassing `extractSeries` for this one key —
document that with a comment on the `SignalKey` union so a future reader doesn't go looking for a
`costUsdPerHour` case inside `valueForScope` and conclude it's a bug.

```ts
export type SignalKey =
  | 'rps' | 'errorRate' | 'p50Ms' | 'p90Ms' | 'p99Ms'
  | 'activeConnections' | 'cpu' | 'queueDepth' | 'ramMb'
  // costUsdPerHour is charted through the SAME downsample()/SignalChart path as every other
  // signal (FEAT-010), but its SeriesPoint[] comes from costSeries.ts's costSeriesFor map, not
  // from extractSeries -- cost isn't a field on MetricsBatch. No branch for it exists below.
  | 'costUsdPerHour'
```

- [ ] **Step 6: Run the full signalsSeries test file to confirm no regression**

Run: `npx vitest run src/app/world/panels/signalsSeries.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/costSeries.ts src/lib/costSeries.test.ts src/app/world/panels/signalsSeries.ts
git commit -m "feat(cost): add the frame-indexed computeWorldCost memo + incident-cost delta"
```

---

## Task 9: Rewrite `CostTab.tsx`

**Files:**
- Modify: `src/app/world/CostTab.tsx`
- Test: create `src/app/world/CostTab.test.tsx` if it doesn't already exist (check with `Glob`
  first — the file may already exist with tests for the pre-rewrite tab; extend it in place if so)

**Interfaces:**
- Consumes: `costSeriesFor`/`incidentCost` (Task 8), `attributeByBlueprint` (Task 7),
  `downsample` (Task 2), `SignalChart` (Task 3), `useSimulationStore`'s `getReplayFrames`/
  `scrubIndex`.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
it('renders the $/hr headline in var(--color-price)', () => {
  // stub doc/batch fixtures matching the file's existing pattern
  render(<CostTab />)
  const headline = screen.getByText(/\/hr/)
  expect(headline).toHaveStyle({ color: 'var(--color-price)' })
})

it('renders a By service section ranked by cost', () => {
  render(<CostTab />)
  expect(screen.getByText(/by service/i)).toBeInTheDocument()
})

it('shows a negative incident delta with a minus glyph, still in var(--color-price)', () => {
  // fixture where actual < baseline over the scrub range
  render(<CostTab />)
  const el = screen.getByTestId('incident-cost')
  expect(el.textContent).toMatch(/^−/)
  expect(el).toHaveStyle({ color: 'var(--color-price)' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: FAIL (headline/section text not present yet in the pre-rewrite markup).

- [ ] **Step 3: Rewrite `CostTab.tsx`**

```tsx
// src/app/world/CostTab.tsx
import { useMemo, useRef } from 'react'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeWorldCost, attributeByBlueprint, type WorldCostResult } from '../../lib/costModelV2'
import { costSeriesFor, incidentCost } from '../../lib/costSeries'
import { downsample, type SeriesPoint } from './panels/signalsSeries'
import { SignalChart } from './panels/SignalChart'
import { useCompiledWorld } from './useCompiledWorld'
import { sectionLabel, row } from './panels/panelStyles'

export function CostTab() {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const batch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const frames = useSimulationStore(s => s.getReplayFrames())
  const scrubIndex = useSimulationStore(s => s.scrubIndex)
  const setScrubIndex = useSimulationStore(s => s.setScrubIndex)

  const worldForCost = batch?.world ? { ...batch.world, runningByPlacement: batch.runningByPlacement } : null
  const cost: WorldCostResult = computeWorldCost(doc, worldForCost, batch?.managedServices ?? null)

  // Frame-indexed cost memo (Task 8) -- a useRef so the cache survives re-renders but resets when
  // the doc identity changes (a different world / New / Open), never recomputing 300 frames/tick.
  const cacheRef = useRef<{ doc: typeof doc; cache: Map<number, WorldCostResult> }>({ doc, cache: new Map() })
  if (cacheRef.current.doc !== doc) cacheRef.current = { doc, cache: new Map() }
  const series = costSeriesFor(frames, doc, cacheRef.current.cache)

  const sparklinePoints: SeriesPoint[] = frames.map((f, i) => ({ simMs: f.simMs, value: series.get(i)?.hourlyUsd ?? 0 }))
  const sparkline = downsample(sparklinePoints, 260)

  const byService = useMemo(() => attributeByBlueprint(doc, compiled, worldForCost, batch?.managedServices ?? null), [doc, compiled, worldForCost, batch?.managedServices])

  const incident = scrubIndex != null && frames.length > 0
    ? incidentCost(series, frames, 0, scrubIndex)
    : null

  return (
    <div>
      <div style={sectionLabel}>Cost velocity</div>
      <div style={{ font: '600 18px var(--font-mono)', color: 'var(--color-price)', marginBottom: 2 }}>
        ${cost.hourlyUsd.toFixed(2)} /hr
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 8 }}>
        ${cost.monthlyUsd.toFixed(2)} /mo projected
      </div>
      {sparkline.length > 0 && (
        <SignalChart points={sparkline} color="var(--color-price)" width={260} height={36}
          playheadSimMs={scrubIndex != null ? frames[scrubIndex]?.simMs ?? null : null}
          onScrub={(simMs) => {
            let idx = 0, best = Infinity
            for (let i = 0; i < frames.length; i++) { const d = Math.abs(frames[i].simMs - simMs); if (d < best) { best = d; idx = i } }
            setScrubIndex(idx, frames)
          }}
        />
      )}

      {cost.loadBalancerCount > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          includes {cost.loadBalancerCount} load balancer{cost.loadBalancerCount === 1 ? '' : 's'} · ${cost.loadBalancerUsd.toFixed(2)}/mo LB-hours (in the region totals below)
        </div>
      )}

      {incident && (
        <>
          <div style={sectionLabel}>Incident cost (scrub range)</div>
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
```

Verify `useCompiledWorld` is importable from this path (`./useCompiledWorld` relative to
`src/app/world/CostTab.tsx` — confirm the existing import used elsewhere, e.g.
`panels/WorldPanel.tsx:12`'s `'../useCompiledWorld'`, and adjust the relative path since
`CostTab.tsx` lives one directory up from `panels/`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: PASS.

- [ ] **Step 5: `npx tsc --noEmit`, fix any type errors**

- [ ] **Step 6: Live smoke**

`npm run tauri dev`: run a Black Friday-shaped scenario (or manually scale traffic up), open the
Cost tab, confirm the $/hr headline + sparkline update live, "By service" ranks blueprints by
cost, and scrubbing shows an incident-cost delta with the right sign and glyph. Both themes.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/CostTab.tsx src/app/world/CostTab.test.tsx
git commit -m "feat(cost): rewrite CostTab with $/hr velocity, by-service attribution, incident cost"
```

---

## Task 10: Full-suite regression pass + perf bench

**Files:** none new — verification only.

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green, including every pre-existing test this wave touched
(`metrics.test.ts`, `costModelV2.test.ts`).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: green.

- [ ] **Step 4: Perf bench**

Run: `npm run bench`
Expected: `bench/enginePerf.bench.test.ts` shows no measurable regression — this wave's engine-side
change (Task 1's `p90Ms`) is one more `percentile()` call on an already-sorted array inside the
existing 1 Hz `buildBatch` pass, not a per-step cost; confirm the bench agrees.

- [ ] **Step 5: Live smoke, both themes, one pass over everything this wave touched**

`npm run tauri dev`:
- Signals tab reachable and rendering at world/region/az/server scope, scrub-linked, both themes.
- Cost tab's new headline/sparkline/by-service/incident sections, both themes.
- Zero new console errors anywhere in the above.

- [ ] **Step 6: Commit (if anything needed fixing in this pass)**

```bash
git add -A
git commit -m "fix: wave 4 regression-pass fixes"
```

---

## Task 11: Update `docs/module-boundaries.md`

**Files:**
- Modify: `docs/module-boundaries.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Append a new dated section, following the existing per-wave convention** (see the
  file's own `§...` headers, e.g. the FEAT-003 Wave-1 rows around line 5284/339) covering:
  - `src/lib/worldEngine/metrics.ts` / `types.ts` — `p90Ms` additive field.
  - `src/app/world/panels/signalsSeries.ts` — pure series extraction/downsample, the
    `costUsdPerHour` key note from Task 8 Step 5.
  - `src/app/world/panels/SignalChart.tsx` — the one shared SVG chart renderer.
  - `src/app/world/panels/SignalsPanel.tsx` — new `'signals'` tab, reachable at every scope.
  - `src/app/store/ui.store.ts` / `src/app/world/dock/scope.ts` / `src/app/world/panels/
    WorldPanel.tsx` — the four-wiring-points pattern (matching the existing note at line ~3991-3992)
    applied to `'signals'`.
  - `src/lib/costModelV2.ts` — `hourlyUsd` + `attributeByBlueprint`.
  - `src/lib/costSeries.ts` — the frame-indexed memo + incident-cost delta.
  - `src/app/world/CostTab.tsx` — rewritten role (supersedes the Task-16-era row at line ~226).

- [ ] **Step 2: Commit**

```bash
git add docs/module-boundaries.md
git commit -m "docs: update module-boundaries.md for Wave 4 (FEAT-009/FEAT-010)"
```

---

## Self-Review Notes (already applied above, kept for the executor's awareness)

- **Egress attribution gap (Task 7):** the spec asks for egress to attribute to the calling
  blueprint via `depBytesById`, but that per-instance byte breakdown doesn't currently reach
  `costModelV2.ts` through `MetricsBatch`. Task 7 flags this explicitly and gives the executor a
  documented-gap fallback (an unattributed cross-zone/LB line) rather than a plan step that quietly
  assumes plumbing that doesn't exist. If a future frame-level per-instance byte field is found to
  already exist, prefer wiring it over adding the gap note — check before choosing the fallback.
- **`SignalKey.queueDepth`:** no source field exists on `InstanceMetrics` today; Task 2 says not to
  invent one and to leave it as an empty series, flagged for the executor to double check via grep
  before accepting that as final.
- **Managed-service cost rows in "By service":** `attributeByBlueprint` groups these under a
  synthetic `managed:<id>` key since `ManagedService` has no blueprint id — Task 7's Step 7 makes
  this explicit so the Cost tab's labels read correctly instead of showing a raw id.
