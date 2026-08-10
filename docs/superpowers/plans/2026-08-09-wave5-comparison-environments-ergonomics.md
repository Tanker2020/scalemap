# Wave 5 (FEAT-011 Baseline Capture & A/B Comparison + FEAT-012 Environment & Vendor Profiles +
FEAT-013 Ergonomics Pack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Wave 5 of `feature-spec.md` — a deterministic run-comparison surface (FEAT-011), a
compile-time environment/vendor-profile overlay plus an activated canary role (FEAT-012), and a
unified keymap/command-palette/multi-select ergonomics pack (FEAT-013).

**Architecture:** FEAT-011 is pure-derivation-then-storage: `runSummary.ts` turns
`ReplayFrame[]` + the doc into a `RunSummary` (never touching the engine or a store), a new
session-scoped `baseline.store.ts` holds captured summaries, and `ComparePanel.tsx` renders two
side by side with a validity banner gated on scenario/seed/`docFingerprint` agreement. FEAT-012
adds an `Environment` overlay applied inside `compileWorld()` — the one seam every downstream
consumer already reads through, so nothing else in the engine/views/analysis/cost needs to change
— plus a `canaryWeight` field (net-new; `PlacementRole.canary` already exists but does nothing)
wired into `routingRuntime.ts`'s existing weighted target selection. FEAT-013 replaces the app's
two independent `keydown` listeners with one `keymap.ts` registry that both a new
`CommandPalette.tsx` and a keyboard-map overlay render from, and adds a `Set`-based multi-select
to `ui.store.ts` that batches edits through a single `mutate()` call.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest (`node` env for pure logic, `jsdom` via a
per-file `// @vitest-environment jsdom` docblock for components), Tauri file-dialog commands
already used for `.scalemap` I/O.

## Global Constraints

- **Compiled-world gate**: nothing new reads the raw `WorldDoc` for anything derived; read
  `compileWorld(doc)`'s output. `CompiledWorld` is extended only additively.
- **Engine seam**: `simulation.store.ts` is the ONLY file permitted to call `worldEngine` directly.
  `runSummary.ts` takes `ReplayFrame[]` handed to it by a caller that got them from the store's
  `getReplayFrames()` — it never imports the engine facade itself.
- **Regression floor**: every new doc field (`slo?`, `environments?`, `activeEnvironmentId?`,
  `cloudProfile?`, `Placement.canaryWeight?`) is optional; absent ⇒ today's exact behavior,
  asserted with `toBe`, not `toBeCloseTo`.
- **Contract drift**: `src/lib/worldEngine/types.ts` is frozen; this wave makes no engine-contract
  changes (FEAT-011 reads existing `ReplayFrame`/`MetricsBatch`; FEAT-012's canary weighting is a
  `routingRuntime.ts`-internal change, not a new published field — canary instances are already
  distinct `InstanceMetrics` rows keyed by instance id, so "publish separately" requires no schema
  change, only ensuring rollup code doesn't average them into the primary's).
- **Perf envelope**: engine runs ~2 ms/step against a 4 ms budget (`DEGRADE_THRESHOLD_MS = 4`).
  FEAT-011 capture is a one-shot walk of ≤300 frames on an explicit user click — zero steady-state
  cost. FEAT-012 environment overlay resolves once at `compileWorld()` — zero runtime cost; canary
  weighting adds one weighted branch to a selection path that already does weighted selection.
  FEAT-013 is UI-only — zero engine cost. `bench/enginePerf.bench.test.ts` must show no
  regression.
- **60 FPS render budget**: no new per-frame work anywhere in this wave.
- **Determinism**: no new `Math.random()`/rng draws in `worldEngine`. `docFingerprint` must be a
  pure structural hash (no rng).
- **Theme law**: every color is `var(--color-*)`. Compare-panel deltas, environment badges, and
  palette/keymap UI all use theme tokens, no hardcoded hexes.
- **Price law**: every money value (`RunSummary.cost.*`, the "price as…" comparison row) renders in
  `var(--color-price)`, including negative deltas (use a `−` glyph, never recolor to success/danger).
- **No emojis.** Glyphs only (`▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →` and words). Command-palette group icons
  use this same glyph set.
- **Motion budget**: palette fade/scale on open only, `useReducedMotion()`-gated; no looping
  animation anywhere in this wave.
- **Edit-lock law**: FEAT-011's "Capture baseline" is a read action (allowed while running or
  stopped — it just snapshots). FEAT-012's environment switcher and `canaryWeight` authoring are
  **authoring** actions — edit-locked while running, tooltip `stop the simulation to edit`.
  FEAT-013's palette shows `author`-group commands disabled while running and `chaos`-group
  commands disabled while stopped, both with the standardized tooltip text.
- **Serializer**: `slo?`, `environments?`, `activeEnvironmentId?`, `cloudProfile?`, and
  `Placement.canaryWeight?` are all authored config and DO get serialized — normalize each as
  optional in `serializer.ts`'s defaulting block, following the existing `scenario: src.world.scenario
  ?? undefined` pattern. `RunSummary`/baselines are derived/ephemeral and must NEVER be serialized
  into `.scalemap` — session-scoped store only, with explicit JSON export/import via the same
  `saveDiagram`/`loadDiagram`/`saveFileDialog`/`openFileDialog` wrappers already used for
  `.scalemap` files (no new Tauri commands needed).
- **Analysis rules**: add `canary-failing` to `src/lib/analysis/rules/structural.ts`, spread into
  `ANALYSIS_RULES` (`runAnalysis.ts`). No other new rules this wave.
- **Done bar, per task**: `npx tsc --noEmit` clean → `npx vitest run` green → `npm run build` green
  → live smoke in `npm run tauri dev` with zero new console errors, both themes.
- **Docs**: update `docs/module-boundaries.md` after the wave (Task 19).
- **Hub files** (coordinate, edit sequentially, never in parallel): `src/app/world/panels/WorldPanel.tsx`,
  `src/app/store/world.store.ts`, `src/app/store/ui.store.ts`, `src/lib/world/types.ts`,
  `src/lib/serializer.ts`, `src/app/world/WorldShell.tsx`, `src/App.tsx`. FEAT-011 touches
  `WorldPanel.tsx`/`ui.store.ts` for the `'compare'` tab; FEAT-012 touches `world.store.ts`/
  `ui.store.ts`/`world/types.ts`/`serializer.ts` for environments; FEAT-013 touches
  `App.tsx`/`WorldShell.tsx`/`ui.store.ts`. Do these edits in task order below (11 → 12 → 13) so
  each hub file gets one sequential pass per feature, not three colliding ones.

**Corrections vs. the spec's assumed starting state** (verified against current `main`, see
verification notes below each affected task):
- `CostTab.tsx` lives at `src/app/world/CostTab.tsx`, not `src/app/world/panels/CostTab.tsx`.
- `entityNav.ts` lives at `src/app/world/entityNav.ts`, not `src/lib/entityNav.ts`.
- `PlacementRole` already includes `'canary'` (dead value today), but **`Placement.canaryWeight`
  does not exist** and there is no weighted-canary traffic split anywhere in `routingRuntime.ts` —
  Task 13 builds this from scratch, it does not "activate" a half-built mechanism.
- No `'compare'`/environment-related `PanelTab`, `WorldDoc.environments`, or `cloudProfile` exist
  yet — FEAT-011's Compare tab and FEAT-012's environments are fully greenfield.
- There is no existing "run summary" persistence anywhere (the durable event log persists events
  only, never metrics/cost snapshots) — `runSummary.ts` and `baseline.store.ts` are net-new with no
  partial precedent to extend.
- `App.tsx`'s existing `⌘N` handler has no focused-input guard (unlike `WorldShell.tsx`'s handler).
  Task 14's migration into `keymap.ts` fixes this as part of consolidating to one listener.

---

## File Structure

**New files:**
- `src/lib/world/types.ts` — add `SloTargets`, `Environment` (modifications, not new file).
- `src/lib/runSummary.ts` — `buildRunSummary`, `docFingerprint`, SLO breach evaluation. Pure.
- `src/lib/runSummary.test.ts` — unit tests, `node` env.
- `src/app/store/baseline.store.ts` — `summaries`, `capture`, `remove`, `exportJson`, `importJson`,
  `compareA`/`compareB` selection.
- `src/app/store/baseline.store.test.ts` — unit tests, `jsdom` env (Zustand store).
- `src/app/world/panels/ComparePanel.tsx` — two-column diff view.
- `src/app/world/panels/ComparePanel.test.tsx` — component tests, `jsdom` env.
- `src/app/world/environments.ts` — pure `applyEnvironment(doc, envId): WorldDoc` overlay resolver
  called from `compileWorld.ts` (kept as its own module so `compileWorld.ts` doesn't balloon).
- `src/app/world/environments.test.ts` — unit tests, `node` env.
- `src/app/keymap.ts` — `Binding` type + the single registry, replacing both ad-hoc listeners.
- `src/app/keymap.test.ts` — unit tests, `node` env.
- `src/app/world/commands.ts` — `buildCommands(ctx)`: static bindings + dynamic entity-nav entries.
- `src/app/world/CommandPalette.tsx` — ⌘K palette.
- `src/app/world/CommandPalette.test.tsx` — component tests, `jsdom` env.
- `src/app/world/KeymapOverlay.tsx` — `?` / `⌘/` help overlay, rendered from the registry.

**Modified files:**
- `src/lib/world/types.ts` — `SloTargets`, `WorldDoc.slo?`; `Environment`, `WorldDoc.environments?`/
  `activeEnvironmentId?`/`cloudProfile?`; `Placement.canaryWeight?`.
- `src/lib/serializer.ts` — normalize all five new optional fields in the defaulting block.
- `src/lib/world/compileWorld.ts` — apply the environment overlay during placement expansion; emit
  a compile finding when `activeEnvironmentId` names a missing environment.
- `src/lib/worldEngine/demand.ts` — none (population `peakRps` is already scaled pre-compile by
  `environments.ts`, so `demand.ts` sees an already-scaled number and needs no change — confirms
  the "apply at compile time" design actually needs zero engine changes).
- `src/lib/worldEngine/routingRuntime.ts` — canary weighting in target selection, resolving roles
  through the existing `effectiveRoleResolver`.
- `src/lib/worldEngine/metrics.ts` — confirm/ensure canary instances are not smeared into
  blueprint-level rollups used for the canary-vs-primary comparison (read-only audit + fix if
  found, no schema change).
- `src/lib/cloudRegistry.ts` — none needed structurally; `cloudProfile` reads `RealProvider`/
  `CLOUD_REGISTRY`/`PROVIDER_EGRESS` as-is.
- `src/lib/costModelV2.ts` — accept an optional provider override parameter so `CostTab.tsx` can
  compute the four-profile comparison without mutating the doc.
- `src/lib/analysis/rules/structural.ts` — add `canary-failing`.
- `src/app/store/simulation.store.ts` — no new engine calls needed (capture reads
  `getReplayFrames()`, already exposed); add nothing new here beyond what already exists — verify
  during Task 3.
- `src/app/store/world.store.ts` — `addEnvironment`/`updateEnvironment`/`removeEnvironment`/
  `setActiveEnvironment`/`setCloudProfile`, all via `mutate()`; `updatePlacement` gains
  `canaryWeight` support (likely already generic enough via patch — verify); batch multi-select
  actions (`batchUpdateServers`, etc.) as single `mutate()` calls.
- `src/app/store/ui.store.ts` — `PanelTab` gains `'compare'`; `selectedEntityIds: Set<string>` added
  alongside `selectedServerId`.
- `src/app/world/dock/scope.ts` — `WORLD_TABS` gains `'compare'`.
- `src/app/world/panels/WorldPanel.tsx` — `TAB_LABELS`, header switch, world-scope body gain
  `'compare'` (hub file).
- `src/app/world/SimControls.tsx` — "Capture baseline" action; scenario tie-in already exists
  (Wave 1-4 work) — just add the capture button.
- `src/app/world/CostTab.tsx` — "price this world as…" comparison row.
- `src/app/world/az/DatacenterFloor.tsx` — ⌘/⇧-click + marquee multi-select, hit-tested against
  `floorLayout.ts`'s existing grid + the isometric projection module.
- `src/app/world/panels/TopologyPanel` (whatever file implements it — confirm at Task 16) — batch
  actions on multi-selected entities.
- `src/App.tsx` — delete the ad-hoc `⌘N` listener, migrate into `keymap.ts`.
- `src/app/world/WorldShell.tsx` — delete the ad-hoc `⌘Z`/`⇧⌘Z`/`Escape` listener, migrate into
  `keymap.ts`; mount `CommandPalette` and `KeymapOverlay`.
- `docs/agent-onboarding.md` — §5 keymap documentation (Task 18); §3 already fixed in prior-wave
  housekeeping.
- `docs/module-boundaries.md` — new rows (Task 19).

---

## Task 1: `SloTargets` type + serializer normalization

**Files:**
- Modify: `src/lib/world/types.ts` (near other top-level optional `WorldDoc` config, e.g. beside
  `scenario?: Scenario`)
- Modify: `src/lib/serializer.ts` (defaulting block, same pattern as `scenario: src.world.scenario
  ?? undefined`)
- Test: `src/lib/serializer.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `SloTargets { p99Ms?: number; errorRate?: number; availabilityPercent?: number;
  monthlyUsdBudget?: number }`, `WorldDoc.slo?: SloTargets`.

- [ ] **Step 1: Write the failing serializer test**

```ts
it('round-trips slo targets and defaults to undefined when absent', () => {
  const doc = { ...emptyWorldDoc(), slo: { p99Ms: 300, errorRate: 0.01 } }
  const json = serializeWorld({ name: 'x' }, doc)
  const loaded = deserializeWorld(JSON.parse(json))
  expect(loaded.world.slo).toEqual({ p99Ms: 300, errorRate: 0.01 })

  const legacy = JSON.parse(json)
  delete legacy.world.slo
  const loadedLegacy = deserializeWorld(legacy)
  expect(loadedLegacy.world.slo).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/serializer.test.ts -t "round-trips slo targets"`
Expected: FAIL — `slo` not defined on `WorldDoc`.

- [ ] **Step 3: Add the type**

In `src/lib/world/types.ts`, near `scenario?: Scenario` on `WorldDoc`:

```ts
export interface SloTargets {
  p99Ms?: number
  errorRate?: number              // 0..1
  availabilityPercent?: number
  monthlyUsdBudget?: number
}
// WorldDoc gains:
  slo?: SloTargets
```

- [ ] **Step 4: Normalize in the serializer**

In `src/lib/serializer.ts`'s `normalizedWorld` object (alongside `scenario: src.world.scenario ??
undefined`):

```ts
  slo: src.world.slo ?? undefined,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/serializer.test.ts -t "round-trips slo targets"`
Expected: PASS

- [ ] **Step 6: Run full serializer suite to confirm no regression**

Run: `npx vitest run src/lib/serializer.test.ts`
Expected: all PASS, including pre-existing v1/v2-rejection and v3-defaulting tests.

- [ ] **Step 7: Commit**

```bash
git add src/lib/world/types.ts src/lib/serializer.ts src/lib/serializer.test.ts
git commit -m "feat(wave5): add SloTargets to WorldDoc"
```

---

## Task 2: `runSummary.ts` — `docFingerprint` and `buildRunSummary`

**Files:**
- Create: `src/lib/runSummary.ts`
- Test: `src/lib/runSummary.test.ts`

**Interfaces:**
- Consumes: `ReplayFrame { simMs: number; batch: MetricsBatch; events: EngineEvent[] }` (from
  `src/lib/worldEngine/types.ts`, already exported), `WorldDoc`, `CompiledWorld`, `Scenario | null`
  (from `src/lib/world/types.ts`), `SloTargets` (Task 1).
- Produces:
  ```ts
  export interface RunSummary {
    id: string
    label: string
    capturedIso: string
    scenarioId: string | null
    seed: number
    docFingerprint: string
    durationMs: number
    latency: { p50Ms: number; p90Ms: number; p99Ms: number }
    errorRate: number
    peakRps: number
    cost: { meanHourlyUsd: number; totalUsd: number; peakHourlyUsd: number }
    slo: { target: SloTargets; breaches: { key: keyof SloTargets; worst: number; breachedSec: number }[] }
    eventCounts: Record<string, number>
  }
  export function docFingerprint(compiled: CompiledWorld): string
  export function buildRunSummary(
    frames: ReplayFrame[],
    doc: WorldDoc,
    compiled: CompiledWorld,
    label: string,
  ): RunSummary
  ```
  These two functions are the only exports later tasks depend on.

- [ ] **Step 1: Write the failing test for `docFingerprint` stability**

```ts
// src/lib/runSummary.test.ts
import { describe, it, expect } from 'vitest'
import { docFingerprint, buildRunSummary } from './runSummary'
import { compileWorld } from './world/compileWorld'
import { emptyWorldDoc, createRegion, createAz, createServer } from './world/factories' // use actual factory names from factories.ts

describe('docFingerprint', () => {
  it('is stable across a cosmetic rename and changes when structure changes', () => {
    const doc = buildTwoTierWorld() // helper built in this test file from factories, mirrors existing compileWorld.test.ts fixtures
    const compiled = compileWorld(doc)
    const fp1 = docFingerprint(compiled)

    const renamed = { ...doc, regions: { ...doc.regions, [Object.keys(doc.regions)[0]]: { ...Object.values(doc.regions)[0], label: 'renamed' } } }
    const fp2 = docFingerprint(compileWorld(renamed))
    expect(fp2).toBe(fp1)

    const scaled = addAnotherReplica(doc) // helper: adds a placement/instance
    const fp3 = docFingerprint(compileWorld(scaled))
    expect(fp3).not.toBe(fp1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/runSummary.test.ts`
Expected: FAIL — `./runSummary` module does not exist.

- [ ] **Step 3: Implement `docFingerprint`**

```ts
// src/lib/runSummary.ts
import type { CompiledWorld } from './world/types'
import type { WorldDoc } from './world/types'
import type { ReplayFrame, EngineEventKind } from './worldEngine/types'
import type { SloTargets } from './world/types'

export function docFingerprint(compiled: CompiledWorld): string {
  // Deliberately structural, not a hash of the whole doc: instance count per blueprint,
  // dependency edge shape, and server specs — so renaming a region or moving a node in the
  // connections layout does not invalidate a comparison, but adding a replica or resizing a
  // server does.
  const instanceShape = [...compiled.instances]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(i => `${i.blueprintId}:${i.serverId}:${i.role}`)
    .join('|')
  const pathShape = [...compiled.paths]
    .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))
    .map(p => `${p.from}>${p.to}:${p.permitted ? 1 : 0}`)
    .join('|')
  const input = `${instanceShape}##${pathShape}`
  return fnv1a(input)
}

function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
```

Adjust the exact `CompiledWorld.instances`/`.paths` field names to whatever `world/types.ts`
actually exports (verify with a quick read of that interface before finalizing — the shapes named
above are `ServiceInstance`/`CompiledPath` per `CLAUDE.md`'s architecture section; use their real
field names, e.g. `blueprintId`, `serverId`, `role`/`effectiveRole`, `from`/`to`, `permitted`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/runSummary.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for time-weighted latency aggregation**

```ts
it('time-weights latency: a 10s spike in a 300s run stays close to the calm value', () => {
  const calmFrames: ReplayFrame[] = buildFrames({ count: 290, p50Ms: 20, p99Ms: 40 })
  const spikeFrames: ReplayFrame[] = buildFrames({ count: 10, p50Ms: 20, p99Ms: 2000 })
  const frames = [...calmFrames, ...spikeFrames]
  const summary = buildRunSummary(frames, doc, compiled, 'test')
  // naive mean-of-frames would be (290*40 + 10*2000)/300 ≈ 105.7ms; time-weighted (1s/frame here)
  // should land much closer to 40 since only 10 of 300 seconds are elevated.
  expect(summary.latency.p99Ms).toBeLessThan(70)
  expect(summary.latency.p99Ms).toBeGreaterThan(38)
})
```

`buildFrames` is a small local helper constructing `ReplayFrame[]` with `simMs` spaced 1000ms
apart and a `MetricsBatch.world` (or wherever world-level `p50Ms`/`p99Ms`/`p90Ms` live in
`MetricsBatch` — confirm the exact field per `worldEngine/types.ts` before writing) set per frame.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/lib/runSummary.test.ts -t "time-weights latency"`
Expected: FAIL — `buildRunSummary` not defined.

- [ ] **Step 7: Implement `buildRunSummary`**

```ts
export function buildRunSummary(
  frames: ReplayFrame[],
  doc: WorldDoc,
  compiled: CompiledWorld,
  label: string,
): RunSummary {
  if (frames.length === 0) throw new Error('buildRunSummary: no frames to summarize')
  const sorted = [...frames].sort((a, b) => a.simMs - b.simMs)
  const durationMs = sorted[sorted.length - 1].simMs - sorted[0].simMs

  // Per-frame dt in ms, defaulting the first frame's weight to the gap to frame 2 (or 1000ms if
  // there's only one frame) so no frame is silently weighted zero.
  const weights = sorted.map((f, i) => {
    if (i === sorted.length - 1) return i === 0 ? 1000 : sorted[i].simMs - sorted[i - 1].simMs
    return sorted[i + 1].simMs - f.simMs
  })
  const totalWeight = weights.reduce((a, b) => a + b, 0)

  const wMean = (pick: (f: ReplayFrame) => number) =>
    sorted.reduce((sum, f, i) => sum + pick(f) * weights[i], 0) / totalWeight

  const latency = {
    p50Ms: wMean(f => f.batch.world.p50Ms),
    p90Ms: wMean(f => f.batch.world.p90Ms),
    p99Ms: wMean(f => f.batch.world.p99Ms),
  }
  const errorRate = wMean(f => f.batch.world.errorRate)
  const peakRps = Math.max(...sorted.map(f => f.batch.world.admittedRps ?? 0))

  const hourlyUsds = sorted.map(f => f.batch.world.costHourlyUsd ?? 0) // see Task note below
  const meanHourlyUsd = wMean(f => f.batch.world.costHourlyUsd ?? 0)
  const peakHourlyUsd = Math.max(...hourlyUsds)
  const totalUsd = meanHourlyUsd * (durationMs / 3_600_000)

  const eventCounts: Record<string, number> = {}
  for (const f of sorted) for (const e of f.events) eventCounts[e.kind] = (eventCounts[e.kind] ?? 0) + 1

  const target = doc.slo ?? {}
  const breaches = evaluateSloBreaches(sorted, weights, target)

  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    capturedIso: new Date().toISOString(),
    scenarioId: doc.scenario?.id ?? null,
    seed: doc.scenario?.seed ?? 0,
    docFingerprint: docFingerprint(compiled),
    durationMs,
    latency,
    errorRate,
    peakRps,
    cost: { meanHourlyUsd, totalUsd, peakHourlyUsd },
    slo: { target, breaches },
    eventCounts,
  }
}

function evaluateSloBreaches(
  frames: ReplayFrame[],
  weights: number[],
  target: SloTargets,
): { key: keyof SloTargets; worst: number; breachedSec: number }[] {
  const out: { key: keyof SloTargets; worst: number; breachedSec: number }[] = []
  if (target.p99Ms != null) {
    let worst = 0
    let breachedMs = 0
    frames.forEach((f, i) => {
      const v = f.batch.world.p99Ms
      worst = Math.max(worst, v)
      if (v > target.p99Ms!) breachedMs += weights[i]
    })
    if (breachedMs > 0) out.push({ key: 'p99Ms', worst, breachedSec: breachedMs / 1000 })
  }
  if (target.errorRate != null) {
    let worst = 0
    let breachedMs = 0
    frames.forEach((f, i) => {
      const v = f.batch.world.errorRate
      worst = Math.max(worst, v)
      if (v > target.errorRate!) breachedMs += weights[i]
    })
    if (breachedMs > 0) out.push({ key: 'errorRate', worst, breachedSec: breachedMs / 1000 })
  }
  // availabilityPercent / monthlyUsdBudget follow the identical shape — implement once the exact
  // MetricsBatch fields for availability/cost-to-date are confirmed against worldEngine/types.ts;
  // if no direct field exists, derive availability from (1 - errorRate) as the working definition
  // and monthlyUsdBudget from cost.totalUsd projected to 730 hours (costModelV2.ts's HOURS_PER_MONTH).
  return out
}
```

Note on `f.batch.world.costHourlyUsd`: per the verification pass, `MetricsBatch` carries no direct
cost field — cost is computed separately via `computeWorldCost(doc, world, managed)`. Adjust Step 7
to instead call `computeWorldCost` per frame (or per a downsampled subset — 300 calls is still
cheap, one-shot, user-triggered) using each frame's `batch` as the `world`/`managed` metrics
arguments, and use `.hourlyUsd` from `WorldCostResult`. This keeps `runSummary.ts` as the single
place display cost is derived, mirroring FEAT-010's `computeWorldCost` signature exactly rather
than inventing a parallel cost field.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/lib/runSummary.test.ts`
Expected: PASS

- [ ] **Step 9: Add the determinism test — the feature's core precondition**

```ts
it('two captures of the same scenario+seed+doc produce equal RunSummary metric fields', () => {
  const frames1 = runScenarioToFrames(doc, scenario, seed) // test helper: drives worldEngine directly
  const frames2 = runScenarioToFrames(doc, scenario, seed)
  const s1 = buildRunSummary(frames1, doc, compiled, 'a')
  const s2 = buildRunSummary(frames2, doc, compiled, 'b')
  expect(s1.docFingerprint).toBe(s2.docFingerprint)
  expect(s1.latency).toEqual(s2.latency)
  expect(s1.errorRate).toBe(s2.errorRate)
  expect(s1.cost).toEqual(s2.cost)
  expect(s1.eventCounts).toEqual(s2.eventCounts)
})
```

If this fails, the bug is in FEAT-003's scenario determinism (already shipped in Wave 1), not in
this task — do not paper over it here; escalate and fix the root cause in `worldEngine/index.ts`'s
scenario-seeding path before proceeding.

- [ ] **Step 10: Run full file, then commit**

Run: `npx vitest run src/lib/runSummary.test.ts`
Expected: all PASS

```bash
git add src/lib/runSummary.ts src/lib/runSummary.test.ts
git commit -m "feat(wave5): add runSummary — docFingerprint + time-weighted RunSummary capture"
```

---

## Task 3: `baseline.store.ts` — session-scoped capture/compare storage

**Files:**
- Create: `src/app/store/baseline.store.ts`
- Test: `src/app/store/baseline.store.test.ts`

**Interfaces:**
- Consumes: `RunSummary`, `buildRunSummary` (Task 2).
- Produces:
  ```ts
  export const useBaselineStore: UseBoundStore<...> // Zustand
  // state: summaries: RunSummary[]; compareA: string | null; compareB: string | null
  // actions: capture(frames, doc, compiled, label) => void
  //          remove(id: string) => void
  //          setCompareA(id: string | null) => void
  //          setCompareB(id: string | null) => void
  //          exportJson() => string
  //          importJson(json: string) => void   // merges, does not replace
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useBaselineStore } from './baseline.store'

describe('baseline.store', () => {
  beforeEach(() => useBaselineStore.setState({ summaries: [], compareA: null, compareB: null }))

  it('captures, exports, clears, and re-imports byte-identically', () => {
    useBaselineStore.getState().capture(fakeFrames, fakeDoc, fakeCompiled, 'run A')
    expect(useBaselineStore.getState().summaries).toHaveLength(1)
    const json = useBaselineStore.getState().exportJson()

    useBaselineStore.setState({ summaries: [] })
    useBaselineStore.getState().importJson(json)
    expect(useBaselineStore.getState().summaries).toEqual(JSON.parse(json).summaries)
  })

  it('remove() drops exactly the targeted summary and clears matching compare selections', () => {
    useBaselineStore.getState().capture(fakeFrames, fakeDoc, fakeCompiled, 'A')
    useBaselineStore.getState().capture(fakeFrames, fakeDoc, fakeCompiled, 'B')
    const [a, b] = useBaselineStore.getState().summaries
    useBaselineStore.getState().setCompareA(a.id)
    useBaselineStore.getState().remove(a.id)
    expect(useBaselineStore.getState().summaries.map(s => s.id)).toEqual([b.id])
    expect(useBaselineStore.getState().compareA).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/baseline.store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the store**

```ts
// src/app/store/baseline.store.ts
import { create } from 'zustand'
import { buildRunSummary, type RunSummary } from '../../lib/runSummary'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type { ReplayFrame } from '../../lib/worldEngine/types'

interface BaselineState {
  summaries: RunSummary[]
  compareA: string | null
  compareB: string | null
  capture: (frames: ReplayFrame[], doc: WorldDoc, compiled: CompiledWorld, label: string) => void
  remove: (id: string) => void
  setCompareA: (id: string | null) => void
  setCompareB: (id: string | null) => void
  exportJson: () => string
  importJson: (json: string) => void
}

export const useBaselineStore = create<BaselineState>((set, get) => ({
  summaries: [],
  compareA: null,
  compareB: null,
  capture: (frames, doc, compiled, label) => {
    const summary = buildRunSummary(frames, doc, compiled, label)
    set(s => ({ summaries: [...s.summaries, summary] }))
  },
  remove: (id) => set(s => ({
    summaries: s.summaries.filter(x => x.id !== id),
    compareA: s.compareA === id ? null : s.compareA,
    compareB: s.compareB === id ? null : s.compareB,
  })),
  setCompareA: (id) => set({ compareA: id }),
  setCompareB: (id) => set({ compareB: id }),
  exportJson: () => JSON.stringify({ summaries: get().summaries }, null, 2),
  importJson: (json) => {
    const parsed = JSON.parse(json) as { summaries: RunSummary[] }
    set(s => ({ summaries: [...s.summaries, ...parsed.summaries] }))
  },
}))
```

This store is deliberately never imported by `serializer.ts` or `world.store.ts` — grep both files
after this task to confirm zero references, enforcing Cross-Cutting Constraint 15.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/store/baseline.store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/store/baseline.store.ts src/app/store/baseline.store.test.ts
git commit -m "feat(wave5): add session-scoped baseline.store for run capture"
```

---

## Task 4: "Capture baseline" action in `SimControls.tsx`

**Files:**
- Modify: `src/app/world/SimControls.tsx`
- Test: `src/app/world/SimControls.test.tsx` (existing file — add cases; if it doesn't exist,
  create it following the `jsdom` docblock convention used by sibling component tests)

**Interfaces:**
- Consumes: `useSimulationStore.getState().getReplayFrames()` (existing, engine-seam-compliant),
  `useBaselineStore.getState().capture` (Task 3), `useWorldStore` for `doc`/`compiled`.

- [ ] **Step 1: Write the failing test**

```ts
it('Capture baseline button captures a RunSummary from the current replay buffer, disabled with no frames', () => {
  render(<SimControls />)
  const btn = screen.getByRole('button', { name: /capture baseline/i })
  expect(btn).toBeDisabled() // no frames yet

  act(() => { useSimulationStore.setState({ /* seed a fake latestBatch/frames path if store exposes it, else drive via a mocked getReplayFrames */ }) })
  // Prefer: spy/mock useSimulationStore.getState().getReplayFrames to return >0 frames, re-render, assert enabled.
  ...
  fireEvent.click(btn)
  expect(useBaselineStore.getState().summaries).toHaveLength(1)
})
```

Adapt to however `SimControls.test.tsx`'s existing tests mock `useSimulationStore` (read the file
first — Wave 1-4 already added scenario-run controls here, so a mocking convention exists; reuse
it, do not invent a second one).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/SimControls.test.tsx -t "Capture baseline"`
Expected: FAIL — no such button.

- [ ] **Step 3: Add the button**

In `src/app/world/SimControls.tsx`, alongside the existing sim control buttons:

```tsx
const frames = useSimulationStore(s => s.getReplayFrames)
const doc = useWorldStore(s => s.doc)
const compiled = useCompiledWorld() // existing hook per useCompiledWorld.ts
const capture = useBaselineStore(s => s.capture)
const frameCount = useSimulationStore.getState().getReplayFrames().length // or track via a subscribed count if available

<button
  onClick={() => capture(useSimulationStore.getState().getReplayFrames(), doc, compiled, `Run ${new Date().toLocaleTimeString()}`)}
  disabled={frameCount === 0}
  title={frameCount === 0 ? 'run the simulation to produce frames first' : 'capture a baseline for comparison'}
>
  Capture baseline
</button>
```

Wire `frameCount` reactively (e.g. derive it off `latestBatch` changing, since `getReplayFrames()`
itself isn't a reactive selector) rather than reading it once at mount.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/SimControls.test.tsx -t "Capture baseline"`
Expected: PASS

- [ ] **Step 5: Run full SimControls suite**

Run: `npx vitest run src/app/world/SimControls.test.tsx`
Expected: all PASS, no regression to existing scenario-run controls.

- [ ] **Step 6: Commit**

```bash
git add src/app/world/SimControls.tsx src/app/world/SimControls.test.tsx
git commit -m "feat(wave5): add Capture baseline action to SimControls"
```

---

## Task 5: `'compare'` tab plumbing — `ui.store.ts`, `dock/scope.ts`

**Files:**
- Modify: `src/app/store/ui.store.ts`
- Modify: `src/app/world/dock/scope.ts`
- Test: `src/app/world/dock/scope.test.ts` (existing file)

- [ ] **Step 1: Write the failing test**

```ts
it("scopeTabs includes 'compare' at world scope only", () => {
  expect(scopeTabs({ kind: 'world' })).toContain('compare')
  expect(scopeTabs({ kind: 'region', regionId: 'r1' })).not.toContain('compare')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/dock/scope.test.ts -t "compare"`
Expected: FAIL

- [ ] **Step 3: Add `'compare'` to `PanelTab` and `WORLD_TABS`**

In `src/app/store/ui.store.ts`:

```ts
export type PanelTab = 'topology' | 'blueprints' | 'packets' | 'managed' | 'connections' | 'traffic'
  | 'routes' | 'scenario' | 'signals' | 'analysis' | 'events' | 'cost' | 'compare' | 'config'
```

In `src/app/world/dock/scope.ts`:

```ts
const WORLD_TABS: PanelTab[] = ['topology', 'blueprints', 'packets', 'managed', 'connections',
  'traffic', 'routes', 'scenario', 'signals', 'analysis', 'events', 'cost', 'compare']
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/dock/scope.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/store/ui.store.ts src/app/world/dock/scope.ts src/app/world/dock/scope.test.ts
git commit -m "feat(wave5): register world-scope 'compare' panel tab"
```

---

## Task 6: `ComparePanel.tsx`

**Files:**
- Create: `src/app/world/panels/ComparePanel.tsx`
- Create: `src/app/world/panels/ComparePanel.test.tsx` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes: `useBaselineStore` (Task 3): `summaries`, `compareA`, `compareB`, `setCompareA`,
  `setCompareB`, `remove`, `exportJson`, `importJson`.

- [ ] **Step 1: Write the failing test**

```tsx
it('shows a validity warning when scenarioId or seed differ, none when they match', () => {
  useBaselineStore.setState({
    summaries: [runSummaryFixture({ id: 'a', scenarioId: 's1', seed: 1, docFingerprint: 'fp1' }),
                runSummaryFixture({ id: 'b', scenarioId: 's2', seed: 1, docFingerprint: 'fp2' })],
    compareA: 'a', compareB: 'b',
  })
  render(<ComparePanel />)
  expect(screen.getByText(/differ/i)).toBeInTheDocument()

  useBaselineStore.setState({
    summaries: [runSummaryFixture({ id: 'a', scenarioId: 's1', seed: 1, docFingerprint: 'fp1' }),
                runSummaryFixture({ id: 'b', scenarioId: 's1', seed: 1, docFingerprint: 'fp2' })],
    compareA: 'a', compareB: 'b',
  })
  render(<ComparePanel />)
  expect(screen.queryByText(/differ/i)).not.toBeInTheDocument()
})

it('renders direction-aware deltas: lower latency is good, lower cost is good', () => {
  useBaselineStore.setState({
    summaries: [
      runSummaryFixture({ id: 'a', latency: { p50Ms: 10, p90Ms: 20, p99Ms: 100 }, cost: { meanHourlyUsd: 5, totalUsd: 100, peakHourlyUsd: 8 } }),
      runSummaryFixture({ id: 'b', latency: { p50Ms: 10, p90Ms: 20, p99Ms: 62 }, cost: { meanHourlyUsd: 6.1, totalUsd: 120, peakHourlyUsd: 9 } }),
    ],
    compareA: 'a', compareB: 'b',
  })
  render(<ComparePanel />)
  expect(screen.getByText(/p99.*(-38|down 38)/i)).toBeInTheDocument()
  expect(screen.getByText(/cost.*(\+22|up 22)/i)).toBeInTheDocument()
})
```

Write `runSummaryFixture(partial)` as a small local helper filling in every `RunSummary` field with
a sane default, overridden by `partial`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/ComparePanel.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `ComparePanel.tsx`**

```tsx
// src/app/world/panels/ComparePanel.tsx
import { useBaselineStore } from '../../store/baseline.store'
import type { RunSummary } from '../../../lib/runSummary'

const NOISE_FLOOR = 0.01 // 1% — deltas below this render as "no change"

function pctDelta(a: number, b: number): number | null {
  if (a === 0) return b === 0 ? 0 : null
  return (b - a) / a
}

function DeltaCell({ a, b, lowerIsBetter, format }: { a: number; b: number; lowerIsBetter: boolean; format: (n: number) => string }) {
  const delta = pctDelta(a, b)
  if (delta === null || Math.abs(delta) < NOISE_FLOOR) {
    return <span className="delta-noise">{format(a)} → {format(b)} (no change)</span>
  }
  const good = lowerIsBetter ? delta < 0 : delta > 0
  const sign = delta < 0 ? '−' : '+'
  return (
    <span className={good ? 'delta-good' : 'delta-bad'}>
      {format(a)} → {format(b)} ({sign}{Math.abs(Math.round(delta * 100))}%)
    </span>
  )
}

export function ComparePanel() {
  const { summaries, compareA, compareB, setCompareA, setCompareB, remove, exportJson, importJson } = useBaselineStore()
  const a = summaries.find(s => s.id === compareA) ?? null
  const b = summaries.find(s => s.id === compareB) ?? null

  return (
    <div className="compare-panel">
      <div className="compare-selectors">
        <select value={compareA ?? ''} onChange={e => setCompareA(e.target.value || null)}>
          <option value="">Select run A</option>
          {summaries.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <select value={compareB ?? ''} onChange={e => setCompareB(e.target.value || null)}>
          <option value="">Select run B</option>
          {summaries.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {a && b && (a.scenarioId !== b.scenarioId || a.seed !== b.seed) && (
        <div className="compare-warning" role="alert">
          Runs differ in {a.scenarioId !== b.scenarioId ? 'scenario' : ''}{a.seed !== b.seed ? ' seed' : ''} —
          this comparison is not sound.
        </div>
      )}
      {a && b && a.scenarioId === b.scenarioId && a.seed === b.seed && a.docFingerprint === b.docFingerprint && (
        <div className="compare-warning" role="alert">
          Runs share an identical architecture fingerprint — nothing changed structurally between A and B.
        </div>
      )}

      {a && b && (
        <table>
          <tbody>
            <tr><td>p50</td><td><DeltaCell a={a.latency.p50Ms} b={b.latency.p50Ms} lowerIsBetter format={n => `${n.toFixed(0)}ms`} /></td></tr>
            <tr><td>p90</td><td><DeltaCell a={a.latency.p90Ms} b={b.latency.p90Ms} lowerIsBetter format={n => `${n.toFixed(0)}ms`} /></td></tr>
            <tr><td>p99</td><td><DeltaCell a={a.latency.p99Ms} b={b.latency.p99Ms} lowerIsBetter format={n => `${n.toFixed(0)}ms`} /></td></tr>
            <tr><td>error rate</td><td><DeltaCell a={a.errorRate} b={b.errorRate} lowerIsBetter format={n => `${(n * 100).toFixed(2)}%`} /></td></tr>
            <tr><td>peak rps</td><td><DeltaCell a={a.peakRps} b={b.peakRps} lowerIsBetter={false} format={n => n.toFixed(0)} /></td></tr>
            <tr><td>mean $/hr</td><td className="price" style={{ color: 'var(--color-price)' }}><DeltaCell a={a.cost.meanHourlyUsd} b={b.cost.meanHourlyUsd} lowerIsBetter format={n => `$${n.toFixed(2)}`} /></td></tr>
            <tr><td>SLO breaches</td><td>{a.slo.breaches.length} vs {b.slo.breaches.length}</td></tr>
          </tbody>
        </table>
      )}

      <ul className="compare-list">
        {summaries.map(s => (
          <li key={s.id}>
            {s.label} <button onClick={() => remove(s.id)}>remove</button>
          </li>
        ))}
      </ul>
      <button onClick={() => { const blob = exportJson(); void blob /* wire to Tauri save dialog in Task 7 */ }}>Export</button>
    </div>
  )
}
```

Direction-aware coloring uses `var(--color-success)`/`var(--color-danger)` classes defined in the
theme stylesheet, never hardcoded hexes — add `.delta-good { color: var(--color-success) }` /
`.delta-bad { color: var(--color-danger) }` / `.delta-noise { color: var(--color-text-secondary) }`
to whichever stylesheet sibling panels use (check `CostTab.tsx`'s CSS module/co-located styles for
the established pattern and mirror it — do not invent a new styling approach).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/panels/ComparePanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire into `WorldPanel.tsx` (hub file — this is the ONE sequential edit for FEAT-011)**

In `src/app/world/panels/WorldPanel.tsx`: add `compare: 'Compare'` to `TAB_LABELS`; add a
`case 'compare':` arm to the header switch (mirror the `'cost'` arm's shape for a simple title, no
signature-header data needed); add `{tab === 'compare' && <ComparePanel />}` inside the
`scope.kind === 'world'` branch. Import `ComparePanel` from `./ComparePanel`.

- [ ] **Step 6: Run WorldPanel's existing test suite to confirm no regression**

Run: `npx vitest run src/app/world/panels/WorldPanel.test.tsx`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/world/panels/ComparePanel.tsx src/app/world/panels/ComparePanel.test.tsx src/app/world/panels/WorldPanel.tsx
git commit -m "feat(wave5): add ComparePanel with validity banner and direction-aware deltas"
```

---

## Task 7: Baseline JSON export/import via Tauri file dialogs

**Files:**
- Modify: `src/app/world/panels/ComparePanel.tsx` (wire the Export button from Task 6)
- Test: `src/app/world/panels/ComparePanel.test.tsx` (add case)

**Interfaces:**
- Consumes: `saveFileDialog`, `saveDiagram`, `openFileDialog`, `loadDiagram` from `src/lib/tauri.ts`
  (already exist, already used for `.scalemap` I/O — reuse verbatim, no new Tauri commands).

- [ ] **Step 1: Write the failing test**

```tsx
it('Export calls saveFileDialog then saveDiagram with the store JSON; Import calls openFileDialog then loadDiagram and merges', async () => {
  vi.mock('../../../lib/tauri', () => ({ saveFileDialog: vi.fn().mockResolvedValue('/x/runs.json'), saveDiagram: vi.fn(), openFileDialog: vi.fn().mockResolvedValue('/x/runs.json'), loadDiagram: vi.fn().mockResolvedValue(JSON.stringify({ summaries: [runSummaryFixture({ id: 'imported' })] })) }))
  useBaselineStore.setState({ summaries: [runSummaryFixture({ id: 'existing' })], compareA: null, compareB: null })
  render(<ComparePanel />)
  fireEvent.click(screen.getByRole('button', { name: /export/i }))
  await waitFor(() => expect(saveDiagram).toHaveBeenCalledWith('/x/runs.json', expect.stringContaining('existing')))

  fireEvent.click(screen.getByRole('button', { name: /import/i }))
  await waitFor(() => expect(useBaselineStore.getState().summaries.map(s => s.id)).toEqual(['existing', 'imported']))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/panels/ComparePanel.test.tsx -t "Export calls"`
Expected: FAIL — no Import button, Export not wired.

- [ ] **Step 3: Wire both buttons**

```tsx
import { saveFileDialog, saveDiagram, openFileDialog, loadDiagram } from '../../../lib/tauri'
// ...
<button onClick={async () => {
  const path = await saveFileDialog()
  if (!path) return
  await saveDiagram(path, exportJson())
}}>Export</button>
<button onClick={async () => {
  const path = await openFileDialog()
  if (!path) return
  const json = await loadDiagram(path)
  importJson(json)
}}>Import</button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/panels/ComparePanel.test.tsx`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/world/panels/ComparePanel.tsx src/app/world/panels/ComparePanel.test.tsx
git commit -m "feat(wave5): wire baseline export/import to existing Tauri file dialogs"
```

---

## Task 8: `Environment` type + `WorldDoc` fields + serializer normalization

**Files:**
- Modify: `src/lib/world/types.ts`
- Modify: `src/lib/serializer.ts`
- Test: `src/lib/serializer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Environment {
    id: string
    label: string
    serverCountFactor?: number
    populationRpsFactor?: number
    placementCountOverrides?: Record<string, number>   // PlacementId
    instanceClassOverrides?: Record<string, string>     // ServerId -> catalogId
  }
  // WorldDoc gains: environments?: Record<string, Environment>
  //                 activeEnvironmentId?: string
  //                 cloudProfile?: 'generic' | 'aws' | 'gcp' | 'azure'
  ```
  Also add `canaryWeight?: number` to `Placement` in the same file (grouped here since both are
  additive `world/types.ts` edits — one sequential pass through the hub file).

- [ ] **Step 1: Write the failing test**

```ts
it('round-trips environments/activeEnvironmentId/cloudProfile/canaryWeight and defaults when absent', () => {
  const doc = {
    ...emptyWorldDoc(),
    environments: { staging: { id: 'staging', label: 'Staging', serverCountFactor: 0.1 } },
    activeEnvironmentId: 'staging',
    cloudProfile: 'aws' as const,
  }
  const json = serializeWorld({ name: 'x' }, doc)
  const loaded = deserializeWorld(JSON.parse(json))
  expect(loaded.world.environments).toEqual(doc.environments)
  expect(loaded.world.activeEnvironmentId).toBe('staging')
  expect(loaded.world.cloudProfile).toBe('aws')

  const legacy = JSON.parse(json)
  delete legacy.world.environments
  delete legacy.world.activeEnvironmentId
  delete legacy.world.cloudProfile
  const loadedLegacy = deserializeWorld(legacy)
  expect(loadedLegacy.world.environments).toEqual({})
  expect(loadedLegacy.world.activeEnvironmentId).toBeUndefined()
  expect(loadedLegacy.world.cloudProfile).toBeUndefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/serializer.test.ts -t "round-trips environments"`
Expected: FAIL

- [ ] **Step 3: Add the types**

In `src/lib/world/types.ts`:

```ts
export interface Environment {
  id: string
  label: string
  serverCountFactor?: number
  populationRpsFactor?: number
  placementCountOverrides?: Record<PlacementId, number>
  instanceClassOverrides?: Record<ServerId, string>
}
// on WorldDoc:
  environments?: Record<string, Environment>
  activeEnvironmentId?: string
  cloudProfile?: 'generic' | 'aws' | 'gcp' | 'azure'
```

And on `Placement` (near `role: PlacementRole`):

```ts
  canaryWeight?: number   // 0..1, meaningful only when role === 'canary'; Task 13 wires this up
```

- [ ] **Step 4: Normalize in the serializer**

```ts
  environments: src.world.environments ?? {},
  activeEnvironmentId: src.world.activeEnvironmentId ?? undefined,
  cloudProfile: src.world.cloudProfile ?? undefined,
```

`canaryWeight` needs no normalization line of its own — it's a per-`Placement` optional field
already covered by `Placement` objects passing through untouched; only container-level `WorldDoc`
fields need the defaulting block treatment.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/serializer.test.ts`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/world/types.ts src/lib/serializer.ts src/lib/serializer.test.ts
git commit -m "feat(wave5): add Environment/cloudProfile/canaryWeight to WorldDoc schema"
```

---

## Task 9: `environments.ts` overlay resolver + `compileWorld.ts` integration

**Files:**
- Create: `src/app/world/environments.ts` (pure; despite living under `app/world/`, it must import
  only from `src/lib/world/types.ts` — no store/React — because `compileWorld.ts` in `src/lib/`
  calls it. If the repo's import-direction convention forbids `lib/` importing from `app/`, put
  this file at `src/lib/world/environments.ts` instead — verify `compileWorld.ts`'s existing import
  directions before choosing the path, and prefer `src/lib/world/environments.ts` if in doubt, since
  `compileWorld.ts` already lives in `src/lib/world/`)
- Test: `src/lib/world/environments.test.ts`
- Modify: `src/lib/world/compileWorld.ts`
- Test: `src/lib/world/compileWorld.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `applyEnvironment(doc: WorldDoc): WorldDoc` — returns `doc` unchanged (same reference)
  when `activeEnvironmentId` is absent or unresolvable; otherwise returns a new `WorldDoc` with
  placements/populations/server-class overrides applied per the precedence rule.
  `compileWorld.ts` calls this as the very first step, before any existing expansion logic, so
  everything downstream (placement expansion, spec resolution) already sees the scaled doc.

- [ ] **Step 1: Write the failing test — regression floor**

```ts
it('a doc with no environments compiles identically to a doc without the field at all', () => {
  const withField = { ...baseDoc, environments: {}, activeEnvironmentId: undefined }
  const withoutField = baseDoc
  expect(compileWorld(withField)).toEqual(compileWorld(withoutField))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/world/compileWorld.test.ts -t "no environments compiles identically"`
Expected: PASS immediately, actually — since `applyEnvironment` doesn't exist yet, `compileWorld`
is unmodified and both docs already compile identically. This step just establishes the regression
baseline test exists BEFORE the overlay is wired in, so Step 6 below (wiring it in) can't silently
break it. Confirm it passes here, then proceed.

- [ ] **Step 3: Write the failing test — precedence and scaling**

```ts
// src/lib/world/environments.test.ts
import { describe, it, expect } from 'vitest'
import { applyEnvironment } from './environments' // or app/world/environments, matching Step 0's path decision
import { emptyWorldDoc } from './factories'

describe('applyEnvironment', () => {
  it('placementCountOverrides wins over serverCountFactor for the same placement', () => {
    const doc = buildDocWithOnePlacement({ count: 4 }) // helper
    const doc2 = {
      ...doc,
      environments: { s: { id: 's', label: 'S', serverCountFactor: 0.5, placementCountOverrides: { p1: 10 } } },
      activeEnvironmentId: 's',
    }
    const result = applyEnvironment(doc2)
    expect(result.placements.p1.count).toBe(10) // override wins, not 4*0.5=2
  })

  it('serverCountFactor scales placements with no override', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    const doc2 = { ...doc, environments: { s: { id: 's', label: 'S', serverCountFactor: 0.5 } }, activeEnvironmentId: 's' }
    const result = applyEnvironment(doc2)
    expect(result.placements.p1.count).toBe(2)
  })

  it('populationRpsFactor scales peakRps before compile, preserving downstream Poisson variance scaling', () => {
    const doc = buildDocWithOnePopulation({ peakRps: 1000 })
    const doc2 = { ...doc, environments: { s: { id: 's', label: 'S', populationRpsFactor: 0.1 } }, activeEnvironmentId: 's' }
    const result = applyEnvironment(doc2)
    expect(Object.values(result.populations)[0].peakRps).toBe(100)
  })

  it('returns the same doc reference when activeEnvironmentId is absent', () => {
    const doc = buildDocWithOnePlacement({ count: 4 })
    expect(applyEnvironment(doc)).toBe(doc)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/lib/world/environments.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 5: Implement `applyEnvironment`**

```ts
// src/lib/world/environments.ts
import type { WorldDoc } from './types'

export function applyEnvironment(doc: WorldDoc): WorldDoc {
  const envId = doc.activeEnvironmentId
  if (!envId) return doc
  const env = doc.environments?.[envId]
  if (!env) return doc // compileWorld.ts emits a compile finding for this case (Step 6)

  let placements = doc.placements
  if (env.serverCountFactor != null || env.placementCountOverrides) {
    placements = Object.fromEntries(Object.entries(doc.placements).map(([id, p]) => {
      const override = env.placementCountOverrides?.[id]
      if (override != null) return [id, { ...p, count: override }]
      if (env.serverCountFactor != null) {
        return [id, { ...p, count: Math.max(1, Math.round(p.count * env.serverCountFactor)) }]
      }
      return [id, p]
    }))
  }

  let populations = doc.populations
  if (env.populationRpsFactor != null) {
    populations = Object.fromEntries(Object.entries(doc.populations).map(([id, pop]) =>
      [id, { ...pop, peakRps: pop.peakRps * env.populationRpsFactor! }]))
  }

  let servers = doc.servers
  if (env.instanceClassOverrides) {
    servers = Object.fromEntries(Object.entries(doc.servers).map(([id, s]) => {
      const catalogId = env.instanceClassOverrides![id]
      return catalogId ? [id, { ...s, catalogId }] : [id, s]
    }))
  }

  return { ...doc, placements, populations, servers }
}
```

Adjust field names (`catalogId`, `peakRps`, `count`) to whatever `Server`/`ClientPopulation`/
`Placement` actually name them in `world/types.ts` — verify before finalizing.

- [ ] **Step 6: Wire into `compileWorld.ts`**

```ts
// src/lib/world/compileWorld.ts, at the very top of compileWorld(doc)
export function compileWorld(rawDoc: WorldDoc): CompiledWorld {
  const doc = applyEnvironment(rawDoc)
  const findings: CompileFinding[] = []
  if (rawDoc.activeEnvironmentId && !rawDoc.environments?.[rawDoc.activeEnvironmentId]) {
    findings.push({ /* match existing CompileFinding shape */ severity: 'warning', message: `Active environment "${rawDoc.activeEnvironmentId}" not found`, ... })
  }
  // ...rest of existing compileWorld body, entirely unchanged, operating on `doc` instead of a
  // parameter previously also called `doc` — rename the existing parameter to `rawDoc` and every
  // internal reference stays `doc` by virtue of the new local binding above.
}
```

- [ ] **Step 7: Run all tests to verify pass + no regression**

Run: `npx vitest run src/lib/world/environments.test.ts src/lib/world/compileWorld.test.ts`
Expected: all PASS, including the Step 1/2 regression-floor test.

- [ ] **Step 8: Commit**

```bash
git add src/lib/world/environments.ts src/lib/world/environments.test.ts src/lib/world/compileWorld.ts src/lib/world/compileWorld.test.ts
git commit -m "feat(wave5): apply Environment overlay at compile time"
```

---

## Task 10: Environment CRUD + switcher in `world.store.ts`

**Files:**
- Modify: `src/app/store/world.store.ts`
- Test: `src/app/store/world.store.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `addEnvironment(label: string)`, `updateEnvironment(id: string, patch: Partial<Environment>)`,
  `removeEnvironment(id: string)`, `setActiveEnvironment(id: string | null)`, `setCloudProfile(profile:
  'generic' | 'aws' | 'gcp' | 'azure')` — all via `mutate()`.

- [ ] **Step 1: Write the failing test**

```ts
it('addEnvironment/setActiveEnvironment/removeEnvironment go through mutate (one undo step each)', () => {
  const before = useWorldStore.getState().doc
  useWorldStore.getState().addEnvironment('staging')
  const [id] = Object.keys(useWorldStore.getState().doc.environments!)
  expect(useWorldStore.getState().doc.environments![id].label).toBe('staging')

  useWorldStore.getState().setActiveEnvironment(id)
  expect(useWorldStore.getState().doc.activeEnvironmentId).toBe(id)

  useWorldStore.getState().undo()
  expect(useWorldStore.getState().doc.activeEnvironmentId).toBeUndefined()
  useWorldStore.getState().undo()
  expect(useWorldStore.getState().doc.environments).toEqual(before.environments ?? {})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/world.store.test.ts -t "addEnvironment"`
Expected: FAIL — actions don't exist.

- [ ] **Step 3: Implement, mirroring the `addRack`/`updateRack`/`removeRack` pattern**

```ts
addEnvironment: (label) => mutate(d => {
  const id = `env-${Object.keys(d.environments ?? {}).length + 1}`
  return { ...d, environments: { ...(d.environments ?? {}), [id]: { id, label } } }
}),
updateEnvironment: (id, patch) => mutate(d => {
  const existing = d.environments?.[id]
  if (!existing) return d
  return { ...d, environments: { ...d.environments, [id]: { ...existing, ...patch } } }
}),
removeEnvironment: (id) => mutate(d => {
  if (!d.environments?.[id]) return d
  const environments = { ...d.environments }
  delete environments[id]
  const activeEnvironmentId = d.activeEnvironmentId === id ? undefined : d.activeEnvironmentId
  return { ...d, environments, activeEnvironmentId }
}),
setActiveEnvironment: (id) => mutate(d => ({ ...d, activeEnvironmentId: id ?? undefined })),
setCloudProfile: (profile) => mutate(d => ({ ...d, cloudProfile: profile })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/store/world.store.test.ts -t "addEnvironment"`
Expected: PASS

- [ ] **Step 5: Run full world.store suite**

Run: `npx vitest run src/app/store/world.store.test.ts`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/store/world.store.ts src/app/store/world.store.test.ts
git commit -m "feat(wave5): add environment CRUD + switcher actions to world.store"
```

---

## Task 11: Environment authoring UI + header breadcrumb indicator

**Files:**
- Modify: `src/app/world/panels/TopologyPanel*` (confirm exact filename first — the Topology tab's
  implementing file) or a new section within it, for an "Environments" list/editor
- Modify: `src/app/world/Breadcrumb.tsx` — show active environment label when set
- Test: `src/app/world/Breadcrumb.test.tsx` (existing or new)

- [ ] **Step 1: Write the failing test**

```tsx
it('shows the active environment label in the breadcrumb when set', () => {
  useWorldStore.setState({ doc: { ...useWorldStore.getState().doc, environments: { s: { id: 's', label: 'Staging' } }, activeEnvironmentId: 's' } })
  render(<Breadcrumb />)
  expect(screen.getByText(/staging/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/Breadcrumb.test.tsx -t "active environment"`
Expected: FAIL

- [ ] **Step 3: Add the breadcrumb chip**

In `Breadcrumb.tsx`, read `doc.activeEnvironmentId`/`doc.environments` and render a small chip
(e.g. `▸ Staging`) next to the world name, styled with `var(--color-*)` tokens — no hardcoded color,
and visually distinct enough that mistaking staging for production (the spec's explicit concern) is
hard: use `var(--color-warning)` for any non-default (non-"production"/unset) environment.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/Breadcrumb.test.tsx`
Expected: PASS

- [ ] **Step 5: Add an "Environments" section to the Topology panel**

List existing environments with label/factor inputs (`serverCountFactor`, `populationRpsFactor`),
an "add environment" button, a delete button per row, and a select-driven "active environment"
switcher plus a `cloudProfile` select — all disabled while running per the edit-lock law (this
section already lives inside `WorldPanel.tsx`'s running-disabled `<fieldset>`, so no new gating
code is needed beyond placing the controls there — verify by reading how the Topology panel already
nests inside that fieldset).

- [ ] **Step 6: Manual smoke test in `npm run tauri dev`**

Create an environment, scale it to 0.1×, switch to it, confirm instance counts and the breadcrumb
chip update; switch back, confirm they revert.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/Breadcrumb.tsx src/app/world/Breadcrumb.test.tsx src/app/world/panels/TopologyPanel*
git commit -m "feat(wave5): environment authoring UI + breadcrumb indicator"
```

---

## Task 12: `cloudProfile` cost comparison — "price this world as…" row

**Files:**
- Modify: `src/lib/costModelV2.ts` — accept an optional provider-override parameter
- Modify: `src/app/world/CostTab.tsx`
- Test: `src/lib/costModelV2.test.ts` (existing file — add cases)

**Interfaces:**
- Modifies: `computeWorldCost(doc, world, managed, providerOverride?: RealProvider)` — when passed,
  pricing/egress lookups use `providerOverride` for any service whose own `provider` is unset,
  mirroring the "world profile is a default, not an override" rule from the spec: a service with an
  explicit `provider` pin always wins regardless of `providerOverride`.

- [ ] **Step 1: Write the failing test**

```ts
it('providerOverride reprices unpinned services but never overrides an explicit per-service provider pin', () => {
  const doc = buildDocWithTwoManagedServices({ pinned: 'gcp', unpinned: undefined })
  const genericResult = computeWorldCost(doc, world, managed)
  const awsResult = computeWorldCost(doc, world, managed, 'aws')
  // the unpinned service's contribution changes; the gcp-pinned one's does not
  expect(awsResult.monthlyUsd).not.toBe(genericResult.monthlyUsd)
  const gcpOnlyResult = computeWorldCost({ ...doc, /* only the pinned service present */ }, world, managed, 'aws')
  expect(gcpOnlyResult.monthlyUsd).toBe(computeWorldCost({ ...doc /* same pinned-only doc */ }, world, managed)['monthlyUsd']) // unaffected by override
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/costModelV2.test.ts -t "providerOverride"`
Expected: FAIL

- [ ] **Step 3: Implement the parameter**

In `costModelV2.ts`, thread `providerOverride?: RealProvider` through to wherever a service's
`provider` is resolved for pricing/egress lookup (likely a small `resolveProvider(service,
worldDefault)` helper if one doesn't exist yet — add it, single resolution point, used by every
call site that currently reads `service.provider` directly):

```ts
function resolveProvider(explicit: CloudProvider | undefined, override: RealProvider | undefined): RealProvider {
  if (explicit && explicit !== 'generic') return explicit
  return override ?? 'aws' // existing default fallback — confirm against current behavior, keep byte-identical when override is undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/costModelV2.test.ts`
Expected: all PASS, including pre-existing tests (confirms the no-override path is byte-identical).

- [ ] **Step 5: Add the "price as…" row to `CostTab.tsx`**

```tsx
const profiles: RealProvider[] = ['aws', 'gcp', 'azure']
const results = profiles.map(p => ({ provider: p, result: computeWorldCost(doc, world, managed, p) }))
// render a row per profile, monthlyUsd in var(--color-price), computed on demand (this render),
// not per tick — CostTab already only re-renders on the 1Hz batch per existing Wave 4 design.
```

- [ ] **Step 6: Run CostTab's existing test suite**

Run: `npx vitest run src/app/world/CostTab.test.tsx`
Expected: all PASS, no regression to Wave 4's $/hr velocity work.

- [ ] **Step 7: Commit**

```bash
git add src/lib/costModelV2.ts src/lib/costModelV2.test.ts src/app/world/CostTab.tsx
git commit -m "feat(wave5): add cloudProfile 'price this world as...' comparison row"
```

---

## Task 13: Canary weighting in `routingRuntime.ts`

**Files:**
- Modify: `src/lib/worldEngine/routingRuntime.ts`
- Modify: `src/lib/worldEngine/metrics.ts` (audit only — confirm canary instances already publish
  as separate `InstanceMetrics` rows and are not averaged into a blueprint rollup used by the
  canary-failing rule; fix only if an actual smearing bug is found)
- Test: `src/lib/worldEngine/routingRuntime.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `Placement.canaryWeight?: number` (Task 8), `effectiveRoleResolver` (existing,
  `failover.ts:303`).
- Produces: no new exported function signature — modifies target-selection internals so that when
  a blueprint has both `primary` and `canary` placements in the same region, `canaryWeight` fraction
  of traffic routes to canary instances.

- [ ] **Step 1: Write the failing test**

```ts
it('routes ~canaryWeight fraction of regional traffic to canary instances of the same blueprint', () => {
  const doc = buildDocWithPrimaryAndCanary({ canaryWeight: 0.05, primaryCount: 4, canaryCount: 1 })
  const compiled = compileWorld(doc)
  const counts = { primary: 0, canary: 0 }
  const rng = createRng(1)
  for (let i = 0; i < 10000; i++) {
    const target = selectTarget(/* existing selectTarget or equivalent target-selection fn, with args matching current signature */)
    counts[target.role === 'canary' ? 'canary' : 'primary']++
  }
  const canaryFraction = counts.canary / (counts.canary + counts.primary)
  expect(canaryFraction).toBeGreaterThan(0.03)
  expect(canaryFraction).toBeLessThan(0.07)
})
```

Adapt to `routingRuntime.ts`'s actual exported target-selection function name/signature — read the
file first (it already performs weighted selection for region/AZ routing per the spec; canary
weighting is meant to reuse that same weighted-choice utility, not add a new one).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/worldEngine/routingRuntime.test.ts -t "canaryWeight fraction"`
Expected: FAIL — canary instances currently receive 0% or are not distinguished.

- [ ] **Step 3: Implement canary weighting**

Locate the existing per-blueprint-per-region target list build in `routingRuntime.ts`. Before the
existing weighted-selection call, partition targets by `effectiveRoleResolver(...)` into
`primary`/`replica` vs `canary` groups. If a `canary` group is non-empty and its placement carries
`canaryWeight`, use a two-stage weighted pick: first roll against `canaryWeight` to choose the
group, then weighted-select within that group using the SAME weighting utility already used for
the rest of target selection (do not add a second weighting formula). If no canary placement or no
`canaryWeight` set, behavior is unchanged — this is the regression-floor guarantee.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/worldEngine/routingRuntime.test.ts -t "canaryWeight fraction"`
Expected: PASS (within statistical tolerance at seed 1 — if flaky, increase iteration count rather
than loosening the tolerance, to keep the assertion meaningful)

- [ ] **Step 5: Regression-floor test — no canary placement, byte-identical**

```ts
it('a world with no canary placements routes byte-identically to pre-feature', () => {
  const doc = buildDocWithOnlyPrimaryReplicas()
  // run N steps with a fixed seed, compare full MetricsBatch sequence against a pre-recorded
  // golden fixture, or against a second run of the same doc through an unmodified code path if
  // no golden fixture exists yet — assert with toBe/toEqual, not toBeCloseTo.
})
```

- [ ] **Step 6: Run full `routingRuntime.test.ts` + `index.test.ts`'s DIVERGENCE GUARD**

Run: `npx vitest run src/lib/worldEngine/routingRuntime.test.ts src/lib/worldEngine/index.test.ts`
Expected: all PASS, DIVERGENCE GUARD green (canary routing changes which instance receives load,
so both `hostScheduler`'s enforcement-side and `metrics.ts`'s published-side must agree — canary
instances are ordinary `ServiceInstance`s already flowing through both call sites, so this should
hold without extra work; the test confirms it).

- [ ] **Step 7: Audit `metrics.ts` for blueprint-level rollups that would smear canary into primary**

Grep `metrics.ts` for any aggregate keyed by `blueprintId` alone (not `blueprintId + role`). If
found and it feeds a UI surface meant to represent "the primary's error rate," fix it to exclude
`canary`-role instances from that specific rollup. Add a regression test asserting a canary
instance's elevated error rate does not move the primary's published aggregate.

- [ ] **Step 8: Commit**

```bash
git add src/lib/worldEngine/routingRuntime.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/routingRuntime.test.ts src/lib/worldEngine/index.test.ts
git commit -m "feat(wave5): activate canaryWeight in routingRuntime target selection"
```

---

## Task 14: `canary-failing` analysis rule + `canaryWeight` authoring UI

**Files:**
- Modify: `src/lib/analysis/rules/structural.ts`
- Test: `src/lib/analysis/rules/structural.test.ts` (existing file)
- Modify: the placement drawer component (`dock/drawers/Placement*` per `CLAUDE.md`'s file map)

- [ ] **Step 1: Write the failing test**

```ts
it('canary-failing fires when a canary instance error rate materially exceeds its primary sibling, sustained', () => {
  const metrics = buildMetricsWithCanaryErrorSpike({ primaryErrorRate: 0.01, canaryErrorRate: 0.3, sustainedSteps: 10 })
  const findings = canaryFailingRule.evaluate(compiled, metrics)
  expect(findings.some(f => f.ruleId === 'canary-failing')).toBe(true)
})

it('does not fire on a transient one-step blip', () => {
  const metrics = buildMetricsWithCanaryErrorSpike({ primaryErrorRate: 0.01, canaryErrorRate: 0.3, sustainedSteps: 1 })
  const findings = canaryFailingRule.evaluate(compiled, metrics)
  expect(findings.some(f => f.ruleId === 'canary-failing')).toBe(false)
})
```

Match this test's shape to how sibling rules in `structural.test.ts` are actually invoked (a rule
object with an `evaluate`/similar method, per `ANALYSIS_RULES`'s existing shape) — read one
existing rule + its test first, mirror exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/analysis/rules/structural.test.ts -t "canary-failing"`
Expected: FAIL — rule doesn't exist.

- [ ] **Step 3: Implement the rule**

Add a `canaryFailingRule` to `structural.ts` following the file's existing rule-object convention,
comparing a canary instance's `errorRate` against its primary sibling's (same `blueprintId` +
region) over a sustained window (reuse whatever windowing/sustained-condition helper existing rules
in this file already use — e.g. a rule tracking consecutive-batches state, per the breaker/timeout
rules' precedent). Spread it into `ANALYSIS_RULES` in `runAnalysis.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/analysis/rules/structural.test.ts`
Expected: all PASS

- [ ] **Step 5: Add `canaryWeight` input to the placement drawer**

A numeric 0–1 input, shown only when `role === 'canary'`, wired through `world.store.ts`'s existing
`updatePlacement` action (verify it already accepts a generic patch — if so, no new store action is
needed here, just a form field).

- [ ] **Step 6: Manual smoke test**

Build a blueprint with a primary placement and a `role: 'canary'` placement at `canaryWeight: 0.05`
in the same region, run, inject an `error-inject` fault (FEAT-001, Wave 1) on the canary instance
only, confirm the canary's error chip climbs while the primary's stays flat, and `canary-failing`
appears in the Analysis tab.

- [ ] **Step 7: Commit**

```bash
git add src/lib/analysis/rules/structural.ts src/lib/analysis/rules/structural.test.ts src/lib/analysis/runAnalysis.ts
git commit -m "feat(wave5): add canary-failing analysis rule + canaryWeight authoring"
```

---

## Task 15: `keymap.ts` registry — migrate the two existing listeners

**Files:**
- Create: `src/app/keymap.ts`
- Create: `src/app/keymap.test.ts`
- Modify: `src/App.tsx` (delete lines ~41-55's ad-hoc listener)
- Modify: `src/app/world/WorldShell.tsx` (delete lines ~80-109's ad-hoc listener)

**Interfaces:**
- Produces:
  ```ts
  export interface CommandContext {
    running: boolean
    // + whatever store getters/actions bindings need — worldStore, navStore, fileStore,
    // simulationStore accessors, passed as plain function references so keymap.ts has no
    // hook/React dependency and can be unit-tested headlessly.
  }
  export interface Binding {
    id: string
    keys: string
    label: string
    group: 'file' | 'navigate' | 'author' | 'chaos' | 'view'
    when?: 'always' | 'running' | 'stopped'
    run: (ctx: CommandContext) => void
  }
  export const REGISTRY: Binding[]
  export function matchBinding(e: KeyboardEvent, registry: Binding[]): Binding | null
  export function isEnabled(binding: Binding, running: boolean): boolean
  export function installKeymap(registry: Binding[], getCtx: () => CommandContext): () => void
  ```

- [ ] **Step 1: Write the failing test for `matchBinding`/`isEnabled`**

```ts
import { describe, it, expect, vi } from 'vitest'
import { matchBinding, isEnabled, type Binding } from './keymap'

describe('keymap', () => {
  const undoBinding: Binding = { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: vi.fn() }

  it('matchBinding finds ⌘Z on a KeyboardEvent with metaKey/ctrlKey + z, not shift', () => {
    const e = new KeyboardEvent('keydown', { key: 'z', metaKey: true })
    expect(matchBinding(e, [undoBinding])).toBe(undoBinding)
    const shiftE = new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })
    expect(matchBinding(shiftE, [undoBinding])).toBeNull()
  })

  it('isEnabled respects when: stopped/running/always', () => {
    expect(isEnabled(undoBinding, false)).toBe(true)
    expect(isEnabled(undoBinding, true)).toBe(false)
    const chaosBinding: Binding = { ...undoBinding, when: 'running' }
    expect(isEnabled(chaosBinding, true)).toBe(true)
    expect(isEnabled(chaosBinding, false)).toBe(false)
    const alwaysBinding: Binding = { ...undoBinding, when: 'always' }
    expect(isEnabled(alwaysBinding, true)).toBe(true)
    expect(isEnabled(alwaysBinding, false)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/keymap.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `keymap.ts`'s matching primitives**

```ts
// src/app/keymap.ts
export interface CommandContext {
  running: boolean
  newWorld: () => void
  goGlobe: () => void
  setFilePath: (p: string | null) => void
  setShowHome: (b: boolean) => void
  undo: () => void
  redo: () => void
  goUp: () => void
  exitPlaceMode: () => void
  isInPlaceMode: () => boolean
}

export interface Binding {
  id: string
  keys: string
  label: string
  group: 'file' | 'navigate' | 'author' | 'chaos' | 'view'
  when?: 'always' | 'running' | 'stopped'
  run: (ctx: CommandContext) => void
}

function parseKeys(keys: string): { key: string; meta: boolean; shift: boolean } {
  const shift = keys.includes('⇧')
  const meta = keys.includes('⌘')
  const key = keys.replace('⇧', '').replace('⌘', '').toLowerCase()
  return { key, meta, shift }
}

export function matchBinding(e: KeyboardEvent, registry: Binding[]): Binding | null {
  for (const b of registry) {
    const parsed = parseKeys(b.keys)
    const evMeta = e.metaKey || e.ctrlKey
    if (parsed.key === 'escape' && e.key === 'Escape') return b
    if (parsed.key.length === 1 && e.key.toLowerCase() === parsed.key && evMeta === parsed.meta && e.shiftKey === parsed.shift) {
      return b
    }
  }
  return null
}

export function isEnabled(binding: Binding, running: boolean): boolean {
  if (!binding.when || binding.when === 'always') return true
  return binding.when === 'running' ? running : !running
}

export const REGISTRY: Binding[] = [
  { id: 'new-world', keys: '⌘N', label: 'New world', group: 'file', when: 'always', run: ctx => {
    ctx.newWorld(); ctx.goGlobe(); ctx.setFilePath(null); ctx.setShowHome(true)
  } },
  { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: ctx => ctx.undo() },
  { id: 'redo', keys: '⇧⌘Z', label: 'Redo', group: 'author', when: 'stopped', run: ctx => ctx.redo() },
  { id: 'escape', keys: 'Escape', label: 'Back / exit place mode', group: 'navigate', when: 'always', run: ctx => {
    if (ctx.isInPlaceMode()) { ctx.exitPlaceMode(); return }
    ctx.goUp()
  } },
]

export function installKeymap(registry: Binding[], getCtx: () => CommandContext): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
    const binding = matchBinding(e, registry)
    if (!binding) return
    const ctx = getCtx()
    if (!isEnabled(binding, ctx.running)) return
    e.preventDefault()
    binding.run(ctx)
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
```

Note this fixes the focused-input guard gap flagged in the verification pass: `⌘N` now goes through
the same guard `⌘Z`/Escape already had, closing a real (if minor) pre-existing bug as a side effect
of consolidation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/keymap.test.ts`
Expected: PASS

- [ ] **Step 5: Delete the ad-hoc listener in `App.tsx`, install the registry instead**

Replace the `useEffect` at `App.tsx:41-55` with:

```tsx
useEffect(() => installKeymap(REGISTRY, () => ({
  running: useSimulationStore.getState().running,
  newWorld: () => useWorldStore.getState().newWorld(),
  goGlobe: () => useNavStore.getState().goGlobe(),
  setFilePath: (p) => useFileStore.getState().setFilePath(p),
  setShowHome: (b) => useFileStore.getState().setShowHome(b),
  undo: () => useWorldStore.getState().undo(),
  redo: () => useWorldStore.getState().redo(),
  goUp: () => useNavStore.getState().up(),
  exitPlaceMode: () => { /* placeMode lives in WorldShell's local state today — see Step 6 */ },
  isInPlaceMode: () => false,
})), [])
```

- [ ] **Step 6: Delete the ad-hoc listener in `WorldShell.tsx`, fold `placeMode` into the context**

`placeMode` is local `useState` in `WorldShell.tsx`. Since `installKeymap` is now installed once
(in `App.tsx`) rather than per-component, either (a) lift `placeMode` into `ui.store.ts` so both
`App.tsx`'s installed handler and `WorldShell.tsx`'s place-mode UI read the same source of truth,
or (b) install the keymap from `WorldShell.tsx` instead of `App.tsx` if `App.tsx` mounts before
`WorldShell` and place-mode state isn't reachable there. Prefer (a): add `placeMode`/`setPlaceMode`
to `ui.store.ts` (small, low-risk addition, and it removes a second source of "where does UI modal
state live" ambiguity). Update `WorldShell.tsx`'s existing place-mode toggle UI to read/write the
store instead of local state. Delete `WorldShell.tsx:80-109`'s listener entirely.

- [ ] **Step 7: Run existing tests covering ⌘N/⌘Z/⇧⌘Z/Escape behavior**

Run: `npx vitest run src/App.test.tsx src/app/world/WorldShell.test.tsx` (exact filenames — confirm
via glob first)
Expected: all PASS, behavior identical to pre-migration (this is the acceptance criterion: "assert
against the existing behavior, not just that they fire").

- [ ] **Step 8: Manually confirm exactly one `keydown` listener**

In the running dev app's devtools, or via a quick grep of `window.addEventListener('keydown'` across
`src/` — should return exactly one call site (inside `keymap.ts`'s `installKeymap`).

- [ ] **Step 9: Commit**

```bash
git add src/app/keymap.ts src/app/keymap.test.ts src/App.tsx src/app/world/WorldShell.tsx src/app/store/ui.store.ts
git commit -m "feat(wave5): consolidate keydown handling into one keymap.ts registry"
```

---

## Task 16: `commands.ts` + `CommandPalette.tsx`

**Files:**
- Create: `src/app/world/commands.ts`
- Create: `src/app/world/CommandPalette.tsx`
- Create: `src/app/world/CommandPalette.test.tsx`
- Modify: `src/app/world/WorldShell.tsx` (mount the palette, add `⌘K` to `keymap.ts`'s `REGISTRY`)
- Modify: `src/app/keymap.ts` (add the `⌘K` binding that toggles palette-open state)

**Interfaces:**
- Consumes: `navigateToEntity`, `entityLabel` from `src/app/world/entityNav.ts` (confirmed path);
  `useWorldStore` actions (add server/region/etc., undo/redo); `useSimulationStore.getState().setFault`
  (Wave 1); `useUiStore`'s `pendingPanelTab` setter.
- Produces: `buildCommands(ctx): PaletteCommand[]` where
  ```ts
  export interface PaletteCommand {
    id: string
    label: string
    group: Binding['group']
    when?: Binding['when']
    run: () => void
  }
  export function buildCommands(ctx: PaletteContext): PaletteCommand[]
  ```

- [ ] **Step 1: Write the failing test for `buildCommands`**

```ts
it('includes dynamic entity-navigation commands built from entityNav', () => {
  const ctx = fakePaletteContext({ doc, compiled })
  const commands = buildCommands(ctx)
  expect(commands.some(c => c.label.includes('us-east'))).toBe(true) // a region label present in doc fixture
})

it('chaos commands are when: running, author commands are when: stopped', () => {
  const commands = buildCommands(fakePaletteContext({}))
  const addServer = commands.find(c => c.id === 'add-server')!
  expect(addServer.when).toBe('stopped')
  const injectFault = commands.find(c => c.id.startsWith('inject-fault'))
  expect(injectFault?.when).toBe('running')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/commands.test.ts`
Expected: FAIL — module does not exist. (Add `src/app/world/commands.test.ts` as part of this
step's file creation.)

- [ ] **Step 3: Implement `commands.ts`**

```ts
// src/app/world/commands.ts
import { navigateToEntity, entityLabel } from './entityNav'
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'
import type { NavApi } from './entityNav'

export interface PaletteContext {
  doc: WorldDoc
  compiled: CompiledWorld
  nav: NavApi
  addServer: () => void
  addRegion: () => void
  undo: () => void
  redo: () => void
  setPendingTab: (tab: string) => void
}

export interface PaletteCommand {
  id: string
  label: string
  group: 'file' | 'navigate' | 'author' | 'chaos' | 'view'
  when?: 'always' | 'running' | 'stopped'
  run: () => void
}

export function buildCommands(ctx: PaletteContext): PaletteCommand[] {
  const staticCommands: PaletteCommand[] = [
    { id: 'add-server', label: 'Add server', group: 'author', when: 'stopped', run: ctx.addServer },
    { id: 'add-region', label: 'Add region', group: 'author', when: 'stopped', run: ctx.addRegion },
    { id: 'undo', label: 'Undo', group: 'author', when: 'stopped', run: ctx.undo },
    { id: 'redo', label: 'Redo', group: 'author', when: 'stopped', run: ctx.redo },
    { id: 'goto-cost', label: 'Go to Cost tab', group: 'view', when: 'always', run: () => ctx.setPendingTab('cost') },
    { id: 'goto-compare', label: 'Go to Compare tab', group: 'view', when: 'always', run: () => ctx.setPendingTab('compare') },
  ]

  const entityCommands: PaletteCommand[] = [
    ...Object.keys(ctx.doc.regions).map(id => ({
      id: `nav-${id}`, label: `Go to ${entityLabel(id, ctx.doc, ctx.compiled)}`, group: 'navigate' as const, when: 'always' as const,
      run: () => navigateToEntity(id, ctx.doc, ctx.compiled, ctx.nav),
    })),
    ...Object.keys(ctx.doc.servers).map(id => ({
      id: `nav-${id}`, label: `Go to ${entityLabel(id, ctx.doc, ctx.compiled)}`, group: 'navigate' as const, when: 'always' as const,
      run: () => navigateToEntity(id, ctx.doc, ctx.compiled, ctx.nav),
    })),
  ]

  return [...staticCommands, ...entityCommands]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/commands.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for `CommandPalette.tsx`**

```tsx
it('filters commands by ranked substring match and runs the selected one on Enter', () => {
  render(<CommandPalette open commands={[{ id: 'add-server', label: 'Add server', group: 'author', when: 'stopped', run: vi.fn() }]} onClose={vi.fn()} running={false} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'add ser' } })
  expect(screen.getByText('Add server')).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  // assert the command's run() was called
})

it('shows disabled commands greyed with the standardized tooltip, does not hide them', () => {
  const run = vi.fn()
  render(<CommandPalette open commands={[{ id: 'add-server', label: 'Add server', group: 'author', when: 'stopped', run }]} onClose={vi.fn()} running={true} />)
  const item = screen.getByText('Add server')
  expect(item.closest('[aria-disabled="true"]')).toBeTruthy()
  expect(screen.getByTitle('stop the simulation to edit')).toBeInTheDocument()
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/app/world/CommandPalette.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement `CommandPalette.tsx`**

```tsx
// src/app/world/CommandPalette.tsx
import { useState, useMemo, useEffect, useRef } from 'react'
import type { PaletteCommand } from './commands'

function rank(query: string, label: string): number {
  const q = query.toLowerCase()
  const l = label.toLowerCase()
  const idx = l.indexOf(q)
  return idx === -1 ? -1 : idx
}

export function CommandPalette({ open, commands, onClose, running }: {
  open: boolean; commands: PaletteCommand[]; onClose: () => void; running: boolean
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) { setQuery(''); setActiveIndex(0) } }, [open])
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])

  const filtered = useMemo(() => {
    if (!query) return commands
    return commands
      .map(c => ({ c, r: rank(query, c.label) }))
      .filter(x => x.r !== -1)
      .sort((a, b) => a.r - b.r)
      .map(x => x.c)
  }, [query, commands])

  if (!open) return null

  const isEnabled = (c: PaletteCommand) => !c.when || c.when === 'always' || (c.when === 'running') === running

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          role="textbox"
          value={query}
          onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
            if (e.key === 'ArrowUp') setActiveIndex(i => Math.max(i - 1, 0))
            if (e.key === 'Enter') {
              const cmd = filtered[activeIndex]
              if (cmd && isEnabled(cmd)) { cmd.run(); onClose() }
            }
          }}
        />
        <ul>
          {filtered.map((c, i) => {
            const enabled = isEnabled(c)
            const tooltip = c.when === 'stopped' ? 'stop the simulation to edit'
              : c.when === 'running' ? 'start the simulation to break things'
              : undefined
            return (
              <li
                key={c.id}
                aria-disabled={!enabled}
                title={tooltip}
                className={i === activeIndex ? 'active' : ''}
                onClick={() => { if (enabled) { c.run(); onClose() } }}
              >
                {c.label}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
```

Style with `var(--color-*)` tokens matching sibling overlay components (check `SettingsModal.tsx`
for the established modal-overlay CSS pattern and mirror it); fade/scale-in only on open, gated by
`useReducedMotion()`.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/app/world/CommandPalette.test.tsx`
Expected: PASS

- [ ] **Step 9: Wire `⌘K` and mount the palette in `WorldShell.tsx`**

Add an `open`/`setOpen` piece of state (local `useState` is fine here — it's transient UI state, not
needed elsewhere), add a `toggle-palette` binding to `keymap.ts`'s `REGISTRY` with `when: 'always'`
that calls a `togglePalette` context function, and render `<CommandPalette open={...} commands=
{buildCommands(paletteCtx)} onClose={...} running={running} />` inside `WorldShell.tsx`.

- [ ] **Step 10: Manual smoke test**

`⌘K` opens the palette; typing a region name and pressing Enter navigates there; while running,
`author`-group entries are greyed with the correct tooltip and `chaos`-group entries (once any
exist — Wave 1's fault actions can be added to `commands.ts` here too) are enabled.

- [ ] **Step 11: Commit**

```bash
git add src/app/world/commands.ts src/app/world/commands.test.ts src/app/world/CommandPalette.tsx src/app/world/CommandPalette.test.tsx src/app/world/WorldShell.tsx src/app/keymap.ts
git commit -m "feat(wave5): add command palette (⌘K) over the keymap registry"
```

---

## Task 17: Multi-select — `ui.store.ts` + AZ floor marquee/click selection

**Files:**
- Modify: `src/app/store/ui.store.ts`
- Modify: `src/app/world/az/DatacenterFloor.tsx`
- Test: `src/app/store/ui.store.test.ts` (existing or new)
- Test: `src/app/world/az/DatacenterFloor.test.tsx` (existing file — add cases)

**Interfaces:**
- Produces: `selectedEntityIds: Set<string>`, `setSelectedEntityIds(ids: Set<string>)`,
  `toggleSelectedEntity(id: string)`, `selectEntityRange(ids: string[])`, `clearSelection()`. Must
  keep `selectedServerId` consistent: setting a single-entity selection also sets
  `selectedServerId` to that id (when it's a server) or `null` otherwise; `dock/scope.ts`'s
  `deriveScope` continues reading `selectedServerId` unchanged.

- [ ] **Step 1: Write the failing test — consistency invariant**

```ts
it('selectedServerId tracks the single-select degenerate case of selectedEntityIds', () => {
  useUiStore.getState().setSelectedEntityIds(new Set(['server-1']))
  expect(useUiStore.getState().selectedServerId).toBe('server-1')

  useUiStore.getState().setSelectedEntityIds(new Set(['server-1', 'server-2']))
  expect(useUiStore.getState().selectedServerId).toBeNull() // multi-select: no single scope target

  useUiStore.getState().clearSelection()
  expect(useUiStore.getState().selectedServerId).toBeNull()
  expect(useUiStore.getState().selectedEntityIds.size).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/ui.store.test.ts -t "selectedServerId tracks"`
Expected: FAIL

- [ ] **Step 3: Implement in `ui.store.ts`**

```ts
selectedEntityIds: new Set<string>(),
setSelectedEntityIds: (ids) => set({
  selectedEntityIds: ids,
  selectedServerId: ids.size === 1 ? [...ids][0] : null,
}),
toggleSelectedEntity: (id) => set(s => {
  const next = new Set(s.selectedEntityIds)
  next.has(id) ? next.delete(id) : next.add(id)
  return { selectedEntityIds: next, selectedServerId: next.size === 1 ? [...next][0] : null }
}),
selectEntityRange: (ids) => set({
  selectedEntityIds: new Set(ids),
  selectedServerId: ids.length === 1 ? ids[0] : null,
}),
clearSelection: () => set({ selectedEntityIds: new Set(), selectedServerId: null }),
```

Note the existing `setSelectedServerId` setter should remain for single-click-to-inspect flows
elsewhere in the app that don't go through multi-select — but it must also sync
`selectedEntityIds` to keep them from disagreeing: `setSelectedServerId: (id) => set({
selectedServerId: id, selectedEntityIds: id ? new Set([id]) : new Set() })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/store/ui.store.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for marquee hit-testing on the floor**

```tsx
it('marquee selection selects exactly the servers whose floor layout rects intersect the marquee', () => {
  render(<DatacenterFloor azId="az-1" /* fixture props */ />)
  const svg = screen.getByTestId('datacenter-floor-svg')
  fireEvent.mouseDown(svg, { clientX: 0, clientY: 0 })
  fireEvent.mouseMove(svg, { clientX: 200, clientY: 200 })
  fireEvent.mouseUp(svg, { clientX: 200, clientY: 200 })
  // assert useUiStore.getState().selectedEntityIds equals exactly the set of server ids whose
  // projected screen rects (via the floor's iso projection) intersect [0,0]-[200,200]
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/az/DatacenterFloor.test.tsx -t "marquee selection"`
Expected: FAIL

- [ ] **Step 7: Implement ⌘/⇧-click + marquee**

In `DatacenterFloor.tsx`: single click on a pod → `setSelectedEntityIds(new Set([id]))`; `⌘/ctrl`-
click → `toggleSelectedEntity(id)`; `⇧`-click → `selectEntityRange` from the last-clicked id to the
current one (compute the range via layout order, e.g. row-major over `floorLayout.ts`'s `tiles`);
mouse-down-drag-up on empty canvas → track a marquee rect in local state, on mouse-up hit-test every
rendered pod/cabinet/appliance's screen-space rect (from the existing iso-projection module) against
the marquee rect, call `selectEntityRange` with the intersecting ids.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/app/world/az/DatacenterFloor.test.tsx`
Expected: PASS, plus all pre-existing `DatacenterFloor.test.tsx` cases still green.

- [ ] **Step 9: Commit**

```bash
git add src/app/store/ui.store.ts src/app/store/ui.store.test.ts src/app/world/az/DatacenterFloor.tsx src/app/world/az/DatacenterFloor.test.tsx
git commit -m "feat(wave5): add multi-select (click/⌘-click/⇧-click/marquee) to ui.store + AZ floor"
```

---

## Task 18: Batch operations as a single undo step

**Files:**
- Modify: `src/app/store/world.store.ts`
- Modify: the Topology panel's implementing component (confirm filename — verify during this task)
- Test: `src/app/store/world.store.test.ts`

**Interfaces:**
- Produces: `batchUpdateServers(ids: string[], patch: Partial<Server>)` — single `mutate()` call.

- [ ] **Step 1: Write the failing test**

```ts
it('batchUpdateServers applies to all targeted servers in one undo step', () => {
  const ids = Object.keys(useWorldStore.getState().doc.servers).slice(0, 3)
  const before = useWorldStore.getState().doc.servers
  useWorldStore.getState().batchUpdateServers(ids, { catalogId: 'c5.large' })
  ids.forEach(id => expect(useWorldStore.getState().doc.servers[id].catalogId).toBe('c5.large'))
  useWorldStore.getState().undo()
  ids.forEach(id => expect(useWorldStore.getState().doc.servers[id]).toEqual(before[id]))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/store/world.store.test.ts -t "batchUpdateServers"`
Expected: FAIL — action doesn't exist.

- [ ] **Step 3: Implement**

```ts
batchUpdateServers: (ids, patch) => mutate(d => {
  const servers = { ...d.servers }
  for (const id of ids) {
    if (servers[id]) servers[id] = { ...servers[id], ...patch }
  }
  return { ...d, servers }
}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/store/world.store.test.ts -t "batchUpdateServers"`
Expected: PASS

- [ ] **Step 5: Wire a batch-edit control into the Topology panel**

When `selectedEntityIds.size > 1` and every selected id is a server, show a small "apply to N
selected" affordance (e.g. an instance-class dropdown) that calls `batchUpdateServers([...ids],
patch)`.

- [ ] **Step 6: Manual smoke test**

Select eight servers on the floor (marquee), apply an instance-class change from the Topology
panel's batch control, confirm all eight update, then `⌘Z` once and confirm all eight revert
together.

- [ ] **Step 7: Commit**

```bash
git add src/app/store/world.store.ts src/app/store/world.store.test.ts
git commit -m "feat(wave5): batch server edits as a single undo step"
```

---

## Task 19: Keyboard-map overlay (`?` / `⌘/`)

**Files:**
- Create: `src/app/world/KeymapOverlay.tsx`
- Create: `src/app/world/KeymapOverlay.test.tsx`
- Modify: `src/app/keymap.ts` (add the `toggle-help` binding)
- Modify: `src/app/world/WorldShell.tsx` (mount the overlay)

- [ ] **Step 1: Write the failing test**

```tsx
it('lists every registered binding grouped by group, and reflects when-state for the current running flag', () => {
  render(<KeymapOverlay open registry={[
    { id: 'undo', keys: '⌘Z', label: 'Undo', group: 'author', when: 'stopped', run: () => {} },
  ]} running={false} onClose={() => {}} />)
  expect(screen.getByText('Undo')).toBeInTheDocument()
  expect(screen.getByText('⌘Z')).toBeInTheDocument()
})

it('a newly-added binding appears without touching the overlay component', () => {
  const registry = [...REGISTRY, { id: 'new-thing', keys: 'g x', label: 'New thing', group: 'view' as const, when: 'always' as const, run: () => {} }]
  render(<KeymapOverlay open registry={registry} running={false} onClose={() => {}} />)
  expect(screen.getByText('New thing')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/world/KeymapOverlay.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```tsx
// src/app/world/KeymapOverlay.tsx
import type { Binding } from '../keymap'

const GROUP_LABELS: Record<Binding['group'], string> = {
  file: 'File', navigate: 'Navigate', author: 'Author', chaos: 'Chaos', view: 'View',
}

export function KeymapOverlay({ open, registry, running, onClose }: {
  open: boolean; registry: Binding[]; running: boolean; onClose: () => void
}) {
  if (!open) return null
  const byGroup = new Map<Binding['group'], Binding[]>()
  for (const b of registry) {
    if (!byGroup.has(b.group)) byGroup.set(b.group, [])
    byGroup.get(b.group)!.push(b)
  }
  return (
    <div className="keymap-overlay" onClick={onClose}>
      <div className="keymap-panel" onClick={e => e.stopPropagation()}>
        {[...byGroup.entries()].map(([group, bindings]) => (
          <section key={group}>
            <h3>{GROUP_LABELS[group]}</h3>
            <ul>
              {bindings.map(b => {
                const enabled = !b.when || b.when === 'always' || (b.when === 'running') === running
                return (
                  <li key={b.id} aria-disabled={!enabled}>
                    <kbd>{b.keys}</kbd> {b.label}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/world/KeymapOverlay.test.tsx`
Expected: PASS

- [ ] **Step 5: Add `?`/`⌘/` binding and mount**

Add to `keymap.ts`'s `REGISTRY`: `{ id: 'toggle-help', keys: '⌘/', label: 'Keyboard shortcuts',
group: 'view', when: 'always', run: ctx => ctx.toggleHelp() }` (extend `CommandContext` with
`toggleHelp`). Also handle bare `?` (no modifier) — extend `matchBinding`/`parseKeys` to support a
bare-key form if `?` isn't already expressible via the `⌘`/`⇧` prefix scheme (a bare `?` binding has
`meta: false, shift: false, key: '?'`, which the existing `parseKeys` already produces correctly
since it only strips `⇧`/`⌘` glyphs — confirm with a quick test before assuming). Mount
`<KeymapOverlay ... />` in `WorldShell.tsx` alongside the palette.

- [ ] **Step 6: Manual smoke test**

`⌘/` opens the overlay listing all current bindings (⌘N, ⌘Z, ⇧⌘Z, Escape, ⌘K, ⌘/) grouped
correctly, with `author` entries shown disabled while running.

- [ ] **Step 7: Commit**

```bash
git add src/app/world/KeymapOverlay.tsx src/app/world/KeymapOverlay.test.tsx src/app/keymap.ts src/app/world/WorldShell.tsx
git commit -m "feat(wave5): add self-maintaining keyboard-map overlay"
```

---

## Task 20: Wave-wide verification, perf gate, docs

**Files:**
- Modify: `docs/module-boundaries.md`
- Modify: `docs/agent-onboarding.md` (§5 user-visible feature map)
- No new code changes — this task is the wave's exit gate.

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: clean, zero errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all green, including every test added in Tasks 1-19 and the full pre-existing Wave 1-4
suite (confirms no cross-wave regression).

- [ ] **Step 3: Perf gate**

Run: `npm run bench` (or the direct path if no script alias exists:
`npx vitest run bench/enginePerf.bench.test.ts`)
Expected: no measurable regression at zero faults/partitions/environments/canary — this wave adds
zero steady-state engine cost per the Global Constraints section, so any regression here is a bug,
not an acceptable tradeoff.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: clean build, zero new TypeScript or bundler warnings.

- [ ] **Step 5: Live smoke — FEAT-011**

`npm run tauri dev`. Run the regional-failure scenario (Wave 1's example scenario), capture a
baseline, add a read replica, re-run the same scenario at the same seed, open the Compare tab, and
confirm a sentence like "p99 down N%, cost up M%, 0 SLO breaches vs K" is readable off the panel.
Verify in dark and light themes.

- [ ] **Step 6: Live smoke — FEAT-012**

Build a production-sized world, define a staging environment at 0.1× `serverCountFactor`, switch to
it via the breadcrumb-adjacent switcher, confirm instance counts and cost drop while topology stays
identical, confirm the breadcrumb chip reads "Staging". Add a canary placement at `canaryWeight:
0.05`, inject an `error-inject` fault on it, confirm `canary-failing` appears in Analysis without
the primary's error rate moving. Verify both themes.

- [ ] **Step 7: Live smoke — FEAT-013**

With the sim stopped, `⌘K` → "Add server" works and any chaos entries are greyed; start the sim and
the states swap. Multi-select eight servers on the floor via marquee, change their class in one
batch action, `⌘Z` once, confirm all eight revert together. `⌘/` lists every binding. Confirm via
devtools or grep that exactly one `keydown` listener exists app-wide.

- [ ] **Step 8: Update `docs/module-boundaries.md`**

Add one row per new/changed file from this wave's File Structure section above (`runSummary.ts`,
`baseline.store.ts`, `ComparePanel.tsx`, `environments.ts`, `keymap.ts`, `commands.ts`,
`CommandPalette.tsx`, `KeymapOverlay.tsx`, plus the modified hub files), following the existing
row format (path, responsibility, fan-in/fan-out notes) — do not append narrative, only rows, per
the standing repo instruction in `CLAUDE.md`.

- [ ] **Step 9: Update `docs/agent-onboarding.md` §5**

Document the new keymap (`⌘N`/`⌘Z`/`⇧⌘Z`/`Escape`/`⌘K`/`⌘/`), the Compare tab, and the environment
switcher as user-visible features, per Task 15/19's own execution steps.

- [ ] **Step 10: Commit**

```bash
git add docs/module-boundaries.md docs/agent-onboarding.md
git commit -m "docs(wave5): update module-boundaries and onboarding for FEAT-011/012/013"
```
