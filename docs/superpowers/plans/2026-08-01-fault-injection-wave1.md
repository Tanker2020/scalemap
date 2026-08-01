# Fault & Scenario Substrate (Housekeeping + Wave 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the housekeeping cleanup plus Wave 1 of `feature-spec.md` — FEAT-001 (Fault Injection
Primitives), FEAT-002 (Network Partition & Link Impairment), FEAT-003 (Scenario Timeline) — the
foundation every later wave in the spec depends on.

**Architecture:** Replace the single boolean `setOutage` kill switch with a discriminated-union
`FaultSpec` overlay (`worldEngine/faults.ts`), layered over the frozen `compiled` world exactly the
way `failover.ts`'s `promotedAt` already is — engine-owned mutable state, never a doc mutation, never
a mid-run recompile. FEAT-002 extends the same `FaultState` with a flat `PartitionFault[]` list and a
per-step memoized `impairmentFor` predicate consulted by both the flow solver and the routing runtime,
making asymmetric (split-brain-capable) partitions possible for the first time. FEAT-003 adds an
optional, serialized `Scenario` to `WorldDoc` — a seed-pinned, pre-sorted list of timestamped
`ScenarioAction`s (which reference `FaultSpec` and `PartitionFault` from FEAT-001/002) applied at
step boundaries from the frozen doc, making a chaos sequence exactly reproducible.

**Tech Stack:** TypeScript, Zustand (`simulation.store.ts`/`world.store.ts`), Vitest (node env for
`worldEngine`/`analysis`, jsdom for components), the existing seeded `Rng` (`rng.ts`).

## Global Constraints

These apply to every task below; re-stated here so no task has to repeat them.

- **Compiled-world gate**: nothing reads the raw `WorldDoc` for anything derived; extend
  `CompiledWorld` (`src/lib/world/types.ts:462`) additively only, never reshape it.
- **Engine seam**: `src/app/store/simulation.store.ts` is the ONLY file allowed to call the engine
  facade (`worldEngine` singleton / `createWorldEngine()`). Every new engine capability gets a new
  store action; views call the store, never the facade.
- **Regression floor**: every new doc/engine field is optional; absent ⇒ today's exact behavior,
  asserted with `toBe` (not `toBeCloseTo`) against a fixed seed.
- **Contract drift**: `src/lib/worldEngine/types.ts` is a frozen contract. Log every change —
  additive or the one sanctioned break (`setOutage` → `setFault`) — in `.superpowers/sdd/contract-drift.md`.
- **Two-call-site invariant**: Little's law is computed in exactly two places — `hostScheduler`'s
  `InstanceLoad.activeConnections` (RAM enforcement) and `metrics.ts`'s published
  `InstanceMetrics.activeConnections` (RAM display). Any fault/partition that changes load must keep
  both in sync and keep `index.test.ts`'s `DIVERGENCE GUARD` tests green (see Task 9, Task 19).
- **No parallel resolution points**: extend `connectionModel.ts`/`packetResolve.ts`/the shared
  `base / (1 - saturation)` queueing curve; never re-derive alongside them.
- **Perf envelope**: engine runs ~2 ms/step at ~2,000 instances against a 4 ms budget
  (`DEGRADE_THRESHOLD_MS = 4`, `index.ts:64`). Every fault/partition subsystem must short-circuit to
  ~0 ms/step when inactive. Run `npm run bench` (⇒ `vitest run --config vitest.bench.config.ts` on
  `bench/enginePerf.bench.test.ts`) after Wave 1 lands — hard gate, not a guideline.
- **60 FPS render budget**: new visuals compute on the 1 Hz metrics batch, never per animation frame.
- **Determinism**: all randomness flows through the seeded `Rng` (`rng.ts`). `Math.random()` is
  forbidden inside `worldEngine` — this is exactly what the Housekeeping task removes.
- **Theme law**: every color in new UI is `var(--color-*)` (`src/lib/theme.ts`). No hardcoded hexes.
  Verify new UI in dark **and** light.
- **No emojis. Ever.** Glyphs already in use: `▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →`.
- **Motion budget**: animation encodes data only; `prefers-reduced-motion` ⇒ fully static.
- **Edit-lock law**: chaos controls are the inverse of normal edit-lock — enabled ONLY while running.
  Tooltip: `start the simulation to break things`. Authoring (scenario steps, partitions) is disabled
  while running with tooltip `stop the simulation to edit`.
- **Serializer is additive**: `.scalemap` stays at v3. New doc fields are optional-on-load, normalized
  in `deserializeWorld`'s defaulting block (`src/lib/serializer.ts:148-157`'s pattern) — no version bump.
- **Analysis rules** go only in the `structural`/`network`/`capacity` rule files, spread into
  `ANALYSIS_RULES` (`src/lib/analysis/runAnalysis.ts:10-14`). Never duplicate `compiled.findings`.
- **Done bar, per task**: `npx tsc --noEmit` clean → `npx vitest run` green → (`npm run build` once
  per feature, not per task) → live smoke in `npm run tauri dev` with zero new console errors.
- **High-conflict hub files** — edit sequentially, never in parallel with other work:
  `src/app/world/panels/WorldPanel.tsx`, `src/app/store/world.store.ts`, `src/lib/world/types.ts`,
  `src/lib/worldEngine/types.ts`, `src/app/world/WorldShell.tsx`, `src/lib/theme.ts`,
  `src/lib/serializer.ts`.

---

## Task 0: Housekeeping

Three independent cleanups, done in one commit per the spec's instruction ("do all three in one
commit").

**Files:**
- Modify: `src/lib/regionConfig.ts` (delete `sampleInterRegionLatencyMs`)
- Modify: `src/lib/regionConfig.test.ts` (remove 3 tests referencing the deleted function)
- Modify: `src/lib/worldEngine/networkRuntime.ts` (rewrite the comment near its `hopLatencyMs`
  wrapper that names the deleted symbol)
- Modify: `docs/agent-onboarding.md` (fix the stale "`.scalemap` v2 only" line in §3 law 12)
- Modify: `docs/module-boundaries.md` (add placeholder rows for the new modules this plan creates)

**Interfaces:**
- Produces: nothing consumed by later tasks — this is pure cleanup, safe to do first and in
  isolation.

- [ ] **Step 1: Delete the non-deterministic sampler**

  In `src/lib/regionConfig.ts`, delete `sampleInterRegionLatencyMs` (currently lines 61-66) in its
  entirety, including its JSDoc/comment block if any precedes it. Leave `interRegionLatencyMs`
  (lines 42-52) untouched — it is pure, deterministic, and used by FEAT-005 later (out of scope
  here, but do not break it).

- [ ] **Step 2: Remove the three tests that exercise the deleted function**

  In `src/lib/regionConfig.test.ts`, delete the three `it(...)` blocks:
  - `'sampleInterRegionLatencyMs varies across repeated calls...'` (currently ~line 9)
  - `'sampleInterRegionLatencyMs is centered near the deterministic base value'` (currently ~line 14)
  - the same-region-zero-floor test that references the sampled variant (currently ~line 22 —
    check its body; if it also exercises `interRegionLatencyMs`'s zero floor independently, keep
    that assertion and only strip the `sampleInterRegionLatencyMs` half)

  Keep the `'interRegionLatencyMs remains deterministic...'` test (~line 5) untouched.

- [ ] **Step 3: Run the test file to confirm it still passes with the sampler gone**

  Run: `npx vitest run src/lib/regionConfig.test.ts`
  Expected: PASS, with 1 fewer (or 2 fewer, depending on Step 2's exact split) test than before.

- [ ] **Step 4: Rewrite the comment in `networkRuntime.ts` that names the deleted symbol**

  In `src/lib/worldEngine/networkRuntime.ts`, find the comment above the jittered `hopLatencyMs`
  wrapper (~line 55) that explains why the engine avoids `sampleInterRegionLatencyMs`. Replace it
  with a comment that no longer names a symbol that doesn't exist:

  ```ts
  // Jittered wrapper for simulation use. The engine's own seeded Rng drives the jitter here —
  // NOT regionConfig.ts's interRegionLatencyMs, which stays pure/deterministic for callers
  // relying on stable cost/region-metadata display (Math.random() is forbidden inside worldEngine).
  ```

- [ ] **Step 5: Fix the stale serializer version claim in the onboarding doc**

  In `docs/agent-onboarding.md`, find §3's law 12 (the line reading `.scalemap` v2 only or similar).
  Replace it with the accurate v3 statement, matching `CLAUDE.md`'s own wording: `.scalemap` is at
  v3 (`serializer.ts:38`); both v1 and v2 are rejected at the version gate
  (`serializer.ts:53-64`).

- [ ] **Step 6: Add placeholder ownership rows to module-boundaries.md**

  In `docs/module-boundaries.md`, under the `K. World engine — Phase 2 substrate engine` section
  (~line 292), add a short placeholder subsection (a few lines, not full narrative) naming the new
  files this plan will create, so parallel workers can see ownership before the files exist:
  `src/lib/worldEngine/faults.ts` (FEAT-001/002 fault + partition state), and note that
  `src/lib/world/types.ts`, `src/lib/worldEngine/types.ts`, `src/app/store/simulation.store.ts`,
  and `src/app/world/panels/WorldPanel.tsx` will all receive Wave-1 edits and should be touched
  sequentially per the hub-file rule.

- [ ] **Step 7: Type-check and full test run**

  Run: `npx tsc --noEmit`
  Expected: clean.
  Run: `npx vitest run`
  Expected: all green, no new failures.

- [ ] **Step 8: Commit**

  ```bash
  git add src/lib/regionConfig.ts src/lib/regionConfig.test.ts src/lib/worldEngine/networkRuntime.ts docs/agent-onboarding.md docs/module-boundaries.md
  git commit -m "chore: delete non-deterministic sampleInterRegionLatencyMs, fix stale docs"
  ```

---

# FEAT-001: Fault Injection Primitives

## Task 1: Contract types — `FaultKind`/`FaultSpec`/`FaultScope` and the `setFault` API break

**Files:**
- Modify: `src/lib/worldEngine/types.ts` (`WorldEngineApi.setOutage` → add `setFault`, new types,
  `EngineEventKind` additions)
- Modify: `.superpowers/sdd/contract-drift.md` (log the break)

**Interfaces:**
- Produces: `FaultKind`, `FaultSpec` (discriminated union), `FaultScope`, `WorldEngineApi.setFault`,
  `WorldEngineApi.setOutage` (kept, now documented as a thin alias), `EngineEventKind` gains
  `'fault_injected' | 'fault_cleared'`. These are the exact names every later task in this feature
  imports.

- [ ] **Step 1: Add the fault types**

  In `src/lib/worldEngine/types.ts`, near the existing `WorldEngineApi` interface (currently lines
  265-281), add:

  ```ts
  export type FaultKind = 'down' | 'latency-add' | 'cpu-brownout' | 'memory-leak' | 'error-inject'

  export type FaultSpec =
    | { kind: 'down' }
    | { kind: 'latency-add'; ms: number }
    | { kind: 'cpu-brownout'; capacityFraction: number }
    | { kind: 'memory-leak'; mbPerMinute: number }
    | { kind: 'error-inject'; errorFraction: number }

  export type FaultScope = 'server' | 'az' | 'region' | 'managed'
  ```

- [ ] **Step 2: Break `setOutage`'s signature into `setFault`, keep `setOutage` as a documented alias**

  Replace the current `setOutage` line in `WorldEngineApi` (line 275: `setOutage: (scope: 'server' |
  'az' | 'region' | 'managed', id: string, down: boolean) => void`) with:

  ```ts
  // Fault injection (spec FEAT-001). setFault(scope, id, null) clears any active fault on that
  // scope/id. Idempotent; emits fault_injected/fault_cleared (or outage_triggered/cleared for
  // the 'down' kind, unchanged from today).
  setFault: (scope: FaultScope, id: string, spec: FaultSpec | null) => void
  // Alias for setFault(scope, id, down ? { kind: 'down' } : null) — kept so no existing caller
  // breaks. New code should prefer setFault.
  setOutage: (scope: FaultScope, id: string, down: boolean) => void
  ```

- [ ] **Step 3: Add the new event kinds**

  In the `EngineEventKind` union (currently lines 171-191), add a new line after
  `'outage_triggered' | 'outage_cleared'`:

  ```ts
  | 'fault_injected' | 'fault_cleared'   // FEAT-001 fault-kind spec (down/latency-add/cpu-brownout/memory-leak/error-inject)
  ```

- [ ] **Step 4: Log the contract change**

  Append an entry to `.superpowers/sdd/contract-drift.md` (create the file with a one-line header
  if it does not yet exist) stating: `setOutage(scope, id, down: boolean)` on `WorldEngineApi` is
  superseded by `setFault(scope, id, spec: FaultSpec | null)`; `setOutage` survives as a
  documented alias implemented in terms of `setFault`. New `FaultKind`/`FaultSpec`/`FaultScope`
  types added. New `EngineEventKind` members `fault_injected`/`fault_cleared` added. Date this
  entry with today's date.

- [ ] **Step 5: Type-check (expect breakage — this is the contract break)**

  Run: `npx tsc --noEmit`
  Expected: FAILS — `worldEngine/index.ts` no longer satisfies `WorldEngineApi` because it doesn't
  export `setFault` yet. This is expected; Task 2 fixes it. Confirm the failure is exactly the
  missing-`setFault` shape, nothing else.

- [ ] **Step 6: Commit**

  ```bash
  git add src/lib/worldEngine/types.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): add FaultSpec union and setFault contract (breaking, aliased)"
  ```

---

## Task 2: `worldEngine/faults.ts` — pure fault state module

**Files:**
- Create: `src/lib/worldEngine/faults.ts`
- Test: `src/lib/worldEngine/faults.test.ts`

**Interfaces:**
- Consumes: `FaultKind`/`FaultSpec`/`FaultScope` (Task 1), `EngineEvent`/`EngineEventKind` (existing
  `types.ts`), `outageKey` shape from `failover.ts` (mirror it, do not import — `faults.ts` must stay
  pure per the `managedDbRuntime.ts` precedent, no engine imports).
- Produces: `FaultState` interface, `createFaultState()`, `setFault(state, scope, id, spec, simMs):
  EngineEvent[]`, `faultsForServer(serverId, state, indexes): FaultSpec[]`, `stepLeaks(state, loads,
  stepSec): void`. Task 3 (`index.ts` wiring) and Task 4/5 (flows.ts) call these exact names.

- [ ] **Step 1: Write the failing tests for `createFaultState`/`setFault`**

  ```ts
  // src/lib/worldEngine/faults.test.ts
  import { describe, it, expect } from 'vitest'
  import { createFaultState, setFault } from './faults'

  describe('faults: setFault', () => {
    it('is idempotent — setting the same spec twice emits only once', () => {
      const state = createFaultState()
      const first = setFault(state, 'server', 'srv-1', { kind: 'cpu-brownout', capacityFraction: 0.5 }, 1000)
      expect(first).toHaveLength(1)
      expect(first[0].kind).toBe('fault_injected')
      const second = setFault(state, 'server', 'srv-1', { kind: 'cpu-brownout', capacityFraction: 0.5 }, 2000)
      expect(second).toHaveLength(0)
      expect(state.active.get('server:srv-1')).toEqual({ kind: 'cpu-brownout', capacityFraction: 0.5 })
    })

    it('clearing an active fault emits fault_cleared and removes it', () => {
      const state = createFaultState()
      setFault(state, 'server', 'srv-1', { kind: 'error-inject', errorFraction: 0.1 }, 1000)
      const cleared = setFault(state, 'server', 'srv-1', null, 2000)
      expect(cleared).toHaveLength(1)
      expect(cleared[0].kind).toBe('fault_cleared')
      expect(state.active.has('server:srv-1')).toBe(false)
    })

    it('clearing a fault that is not active emits nothing', () => {
      const state = createFaultState()
      expect(setFault(state, 'server', 'srv-1', null, 1000)).toHaveLength(0)
    })

    it('down-kind faults use outage_triggered/outage_cleared, not fault_injected/cleared', () => {
      const state = createFaultState()
      const injected = setFault(state, 'server', 'srv-1', { kind: 'down' }, 1000)
      expect(injected[0].kind).toBe('outage_triggered')
      const cleared = setFault(state, 'server', 'srv-1', null, 2000)
      expect(cleared[0].kind).toBe('outage_cleared')
    })

    it('clears leakAccumMb for the affected instance when a memory-leak fault is cleared', () => {
      const state = createFaultState()
      state.leakAccumMb.set('inst-1' as any, 42)
      setFault(state, 'server', 'srv-1', { kind: 'memory-leak', mbPerMinute: 10 }, 1000)
      setFault(state, 'server', 'srv-1', null, 2000, ['inst-1' as any])
      expect(state.leakAccumMb.get('inst-1' as any)).toBeUndefined()
    })
  })
  ```

  Note the last test anticipates `setFault` taking an optional 5th parameter (affected instance
  ids) so it can clear `leakAccumMb` on clear — add that parameter in Step 3.

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run src/lib/worldEngine/faults.test.ts`
  Expected: FAIL — module `./faults` does not exist.

- [ ] **Step 3: Implement `faults.ts`**

  ```ts
  // src/lib/worldEngine/faults.ts
  import type { EngineEvent, FaultKind, FaultScope, FaultSpec } from './types'
  import type { InstanceId } from '../world/types'

  export interface FaultState {
    active: Map<string, FaultSpec>        // keyed `${scope}:${id}`, mirrors failover.ts's outageKey shape
    leakAccumMb: Map<InstanceId, number>  // memory-leak accumulator, reset on restart/clear
  }

  export function createFaultState(): FaultState {
    return { active: new Map(), leakAccumMb: new Map() }
  }

  function faultKey(scope: FaultScope, id: string): string {
    return `${scope}:${id}`
  }

  function specsEqual(a: FaultSpec, b: FaultSpec): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  function faultEvent(
    kind: 'fault_injected' | 'fault_cleared' | 'outage_triggered' | 'outage_cleared',
    scope: FaultScope,
    id: string,
    faultKind: FaultKind | undefined,
    simMs: number,
  ): EngineEvent {
    const suffix = faultKind && faultKind !== 'down' ? ` (${faultKind})` : ''
    return {
      kind,
      severity: kind === 'fault_cleared' || kind === 'outage_cleared' ? 'info' : 'warning',
      message: `${scope} ${id}${suffix} ${kind.endsWith('cleared') ? 'fault cleared' : 'fault injected'}`,
      affected: [id],
      simMs,
    }
  }

  export function setFault(
    state: FaultState,
    scope: FaultScope,
    id: string,
    spec: FaultSpec | null,
    simMs: number,
    affectedInstanceIds: InstanceId[] = [],
  ): EngineEvent[] {
    const key = faultKey(scope, id)
    const existing = state.active.get(key)

    if (spec === null) {
      if (!existing) return []
      state.active.delete(key)
      for (const instId of affectedInstanceIds) state.leakAccumMb.delete(instId)
      return [faultEvent(existing.kind === 'down' ? 'outage_cleared' : 'fault_cleared', scope, id, existing.kind, simMs)]
    }

    if (existing && specsEqual(existing, spec)) return []
    state.active.set(key, spec)
    return [faultEvent(spec.kind === 'down' ? 'outage_triggered' : 'fault_injected', scope, id, spec.kind, simMs)]
  }

  export interface FaultIndexes {
    azOfServer: Map<string, string>
    regionOfAz: Map<string, string>
  }

  export function faultsForServer(serverId: string, azId: string, regionId: string, state: FaultState): FaultSpec[] {
    const out: FaultSpec[] = []
    const serverSpec = state.active.get(faultKey('server', serverId))
    if (serverSpec) out.push(serverSpec)
    const azSpec = state.active.get(faultKey('az', azId))
    if (azSpec) out.push(azSpec)
    const regionSpec = state.active.get(faultKey('region', regionId))
    if (regionSpec) out.push(regionSpec)
    return out
  }

  export function stepLeaks(
    state: FaultState,
    activeLeaks: { instanceId: InstanceId; mbPerMinute: number }[],
    stepSec: number,
  ): void {
    for (const { instanceId, mbPerMinute } of activeLeaks) {
      const prev = state.leakAccumMb.get(instanceId) ?? 0
      state.leakAccumMb.set(instanceId, prev + (mbPerMinute * stepSec) / 60)
    }
  }
  ```

  Note: `faultsForServer`'s final signature takes `serverId, azId, regionId, state` directly rather
  than a bundled `indexes` object — simpler for the caller in `index.ts`, which already has
  `serversByAz`/`azsByRegion` to look up `azId`/`regionId` for a given server before calling this.
  Adjust Task 3's call site accordingly (it will look up `azId`/`regionId` first, then call this).

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run src/lib/worldEngine/faults.test.ts`
  Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/lib/worldEngine/faults.ts src/lib/worldEngine/faults.test.ts
  git commit -m "feat(engine): add pure FaultState module (faults.ts)"
  ```

---

## Task 3: Wire `FaultState` into `index.ts` — `down`, `cpu-brownout`, `memory-leak`

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `src/lib/worldEngine/index.test.ts` (add new `describe('FEAT-001 faults', ...)` block)

**Interfaces:**
- Consumes: `createFaultState`, `setFault`, `faultsForServer`, `stepLeaks` (Task 2); `setFault` on
  `WorldEngineApi` (Task 1).
- Produces: `state.faults: FaultState` held alongside `state.failover: FailoverState`; the engine's
  exported `setFault`/`setOutage` facade methods, wired for real. Task 4 (latency-add) and Task 5
  (error-inject) both read `state.faults` this task establishes.

- [ ] **Step 1: Write failing tests — byte-identical with no faults, `down` alias parity, brownout math**

  Add to `src/lib/worldEngine/index.test.ts` (follow the existing `run(world)`/`connWorld(...)`
  test-harness helpers already in this file — do not write new harness code, reuse what's there):

  ```ts
  describe('FEAT-001 faults', () => {
    it('byte-identical output with zero faults active, fixed seed', () => {
      const w = /* reuse an existing small fixture builder already in this file, e.g. connWorld or threeTierWorld */
      const a = run(w)
      const b = run(w)
      expect(a.latest()).toEqual(b.latest())
      a.engine.stop(); b.engine.stop()
    })

    it('setOutage(scope, id, true) and setFault(scope, id, {kind:"down"}) produce identical state and events', () => {
      const w = /* fixture with one server */
      const st1 = run(w)
      st1.engine.setOutage('server', w.sv, true)
      st1.engine.step(1000)
      const events1 = st1.engine.drainEvents?.() ?? []

      const st2 = run(w)
      st2.engine.setFault('server', w.sv, { kind: 'down' })
      st2.engine.step(1000)
      const events2 = st2.engine.drainEvents?.() ?? []

      expect(events1.map(e => e.kind)).toEqual(events2.map(e => e.kind))
      st1.engine.stop(); st2.engine.stop()
    })

    it('cpu-brownout at capacityFraction 0.5 halves effectiveVcpu multiplicatively with vps steal', () => {
      // build a saturated single-server world, capture baseline latencyMultiplier/admittedScale,
      // then setFault cpu-brownout 0.5 and assert the server's effective capacity roughly halves
      // relative to baseline (composing with any existing vpsFactor rather than overriding it).
    })

    it('memory-leak accumulates ramBaseMb until OOM, then resets leakAccumMb on restart', () => {
      // small headroom instance, memory-leak at a rate that OOMs within a bounded sim window;
      // assert an oom_kill event fires, then instance_restarted OOM_RESTART_MS later, and that
      // faults state's leakAccumMb for that instance is back to 0/undefined after restart.
    })
  })
  ```

  Fill in the three fixture-dependent tests using whatever world-builder helpers already exist
  earlier in this same file (the file already has extensive fixtures — grep for `function
  connWorld` / `function run(` at the top of `index.test.ts` and reuse those exact helpers rather
  than inventing new ones).

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "FEAT-001 faults"`
  Expected: FAIL — `setFault` not implemented on the engine yet.

- [ ] **Step 3: Hold `FaultState`, wire `setFault`/`setOutage`**

  In `src/lib/worldEngine/index.ts`:
  - Import `createFaultState, setFault as setFaultPure, faultsForServer, stepLeaks` from
    `./faults`.
  - Add a `faults: FaultState` field to the internal `EngineState` interface, next to `failover:
    FailoverState` (currently declared line 359).
  - In `start()`'s state construction (currently lines 1565-1600, `createFailoverState()` called at
    line 1585), add `faults: createFaultState(),` alongside it.
  - Implement the facade methods (near wherever `setOutage` was previously implemented as a
    pass-through — search for the existing `setOutage:` property in the returned `WorldEngineApi`
    object):

    ```ts
    setFault: (scope, id, spec) => {
      if (!state) return
      const events = setFaultPure(state.faults, scope, id, spec, state.simMs)
      for (const e of events) emitEvent(e)   // use whatever the existing emit helper is named in this file
      // 'down' routes to the existing failover path so that behavior stays byte-identical:
      if (spec === null || spec.kind === 'down') {
        const downEvents = setOutagePure(state.failover, scope, id, spec !== null, state.simMs)
        for (const e of downEvents) emitEvent(e)
      }
    },
    setOutage: (scope, id, down) => {
      // thin alias, per contract-drift.md
      api.setFault(scope, id, down ? { kind: 'down' } : null)
    },
    ```

    Adjust `emitEvent`/the events-array-append convention to match this file's actual existing
    idiom (do not guess a helper name that doesn't exist — grep `EngineCallbacks` and the existing
    `outage_triggered` emission for the correct call shape, then mirror it exactly).

- [ ] **Step 4: Wire `cpu-brownout` at the `effectiveVcpu` computation**

  At the `effectiveVcpu` line (currently `index.ts:916`: `const effectiveVcpu = server.specs.vcpu *
  (s.vpsFactor.get(server.id) ?? 1)`), before `stepHost` is called (line 917), resolve any active
  `cpu-brownout` fault for this server (via `faultsForServer(server.id, azId, regionId,
  s.faults)`, where `azId`/`regionId` come from the existing `serversByAz`/`azsByRegion` indexes
  built at `start()`) and fold it in multiplicatively:

  ```ts
  const activeFaults = faultsForServer(server.id, s.azOfServer.get(server.id)!, s.regionOfAz.get(s.azOfServer.get(server.id)!)!, s.faults)
  const brownout = activeFaults.find((f): f is Extract<FaultSpec, { kind: 'cpu-brownout' }> => f.kind === 'cpu-brownout')
  const effectiveVcpu = server.specs.vcpu * (s.vpsFactor.get(server.id) ?? 1) * (brownout?.capacityFraction ?? 1)
  const host = stepHost(server, loads, effectiveVcpu, s.rng)
  ```

  (Use whatever the actual index field names are for server→AZ→region lookups per the existing
  `EngineState` shape at lines 319-334 — `serversByAz`/`azsByRegion` were confirmed to exist there;
  invert/derive an `azOfServer`/`regionOfAz` lookup from them at `start()` if a direct reverse map
  doesn't already exist, adding it to the frozen index block.)

- [ ] **Step 5: Wire `memory-leak`**

  Before the RAM/load-building step that constructs `InstanceLoad[]` for `stepHost`, call
  `stepLeaks(s.faults, activeLeakList, stepSec)` where `activeLeakList` is built by scanning each
  server's `faultsForServer(...)` result for a `memory-leak` spec and mapping to that server's
  instance ids. Then, when building each `InstanceLoad.ramBaseMb`, add
  `s.faults.leakAccumMb.get(instanceId) ?? 0`.

  In the OOM-restart handler (currently lines 959-962), after setting `s.oomRestartAt` and
  `s.instanceHealth`, also clear the leak accumulator for that instance:
  `s.faults.leakAccumMb.delete(host.oomVictim)`.

  Also clear it whenever a `down`-kind fault is cleared for the scope containing that instance (the
  `setFault` facade call in Step 3 already threads `affectedInstanceIds` through to the pure
  `setFault` — pass the resolved instance id list for that scope there too).

- [ ] **Step 6: Run the new tests, iterate to green**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "FEAT-001 faults"`
  Expected: all pass. Debug against the actual current line numbers/helper names in `index.ts` —
  they were confirmed close to but not always exactly at the line numbers cited above (the spec
  was written against a slightly earlier snapshot); read the surrounding ~30 lines at each edit
  point before writing the diff.

- [ ] **Step 7: Full test suite + type-check**

  Run: `npx tsc --noEmit` → clean.
  Run: `npx vitest run` → all green, including every pre-existing `index.test.ts` test (this is the
  byte-identical regression floor check).

- [ ] **Step 8: Commit**

  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): wire down/cpu-brownout/memory-leak faults into index.ts"
  ```

---

## Task 4: Wire `latency-add` — the additive-not-assignment fix

**Files:**
- Modify: `src/lib/worldEngine/index.ts` (the `extraLatencyMsByServer` accumulator, currently line
  951)
- Test: `src/lib/worldEngine/index.test.ts`

**Interfaces:**
- Consumes: `state.faults` (Task 3), `extraLatencyMsByServer: Record<ServerId, number>` (already
  declared at `index.ts:873`).
- Produces: no new exports — this task's deliverable is the corrected accumulation, verified by test.

- [ ] **Step 1: Write the regression test that pins the exact bug this design exists to avoid**

  ```ts
  it('latency-add ADDS to queued NIC latency, does not overwrite it', () => {
    // Build a world where NIC backpressure alone already produces a non-zero queuedMs for a
    // server (a saturated NIC), capture that baseline extraLatencyMsByServer value, then apply
    // setFault('server', id, { kind: 'latency-add', ms: 200 }) and assert the new value equals
    // baseline + 200, not just 200.
  })

  it('latency-add of 200ms raises p50Ms by ~200ms on the faulted server only', () => {
    // two-server world, fault only one; assert its p50Ms rises ~200ms and the other server's
    // does not move.
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "latency-add"`
  Expected: FAIL (feature not wired yet).

- [ ] **Step 3: Fix the accumulator**

  At the current line (`index.ts:951`): `if (queuedMs > 0) extraLatencyMsByServer[server.id] =
  queuedMs`. Change to:

  ```ts
  const latencyFault = activeFaults.find((f): f is Extract<FaultSpec, { kind: 'latency-add' }> => f.kind === 'latency-add')
  const faultMs = latencyFault?.ms ?? 0
  if (queuedMs + faultMs > 0) extraLatencyMsByServer[server.id] = queuedMs + faultMs
  ```

  Reuse the `activeFaults` list already resolved in Task 3 Step 4 for this same server in this same
  step — do not call `faultsForServer` a second time per server per step.

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run src/lib/worldEngine/index.test.ts -t "latency-add"`
  Expected: PASS.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): wire latency-add fault, additive not assignment"
  ```

---

## Task 5: Wire `error-inject` in `flows.ts`

**Files:**
- Modify: `src/lib/worldEngine/flows.ts` (dependency loop, near the timeout branch at lines 787-798)
- Modify: `src/lib/worldEngine/index.ts` (pass `state.faults` into the flow-solve call)
- Test: `src/lib/worldEngine/flows.test.ts` (or `index.test.ts` if `flows.ts` has no standalone test
  file — check which exists first)

**Interfaces:**
- Consumes: `state.faults`, `faultsForServer` (Task 2/3).
- Produces: a `'fault'` reason added to the blocked-row reason union that `addDownstream` accepts —
  check the existing reason union (used at the `path.verdict === 'blocked'` branch, line ~680, which
  passes `true` for a boolean-shaped "structural" flag today per the earlier research — confirm its
  actual shape before adding a case) and extend it additively.

- [ ] **Step 1: Write the failing test**

  ```ts
  it('error-inject at 0.1 raises target errorRate to ~0.1 without a compile-time block', () => {
    // single dependency edge, no firewall block; setFault error-inject 0.1 on the target's
    // scope; run several steps; assert errorRate on that instance's metrics ≈ 0.1 (tolerance
    // reflecting Poisson variance), and that sustained error-inject trips the caller's circuit
    // breaker via the EXISTING breakers.ts path (assert a breaker_open event fires) — no new
    // breaker logic introduced by this task.
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "error-inject"`
  Expected: FAIL.

- [ ] **Step 3: Implement**

  In `flows.ts`'s dependency loop, beside the existing timeout/error branch (lines 787-798), add a
  check for an active `error-inject` fault on the target instance's server (resolved via
  `faultsForServer`, passed into the flow-solve call from `index.ts` — thread `faults: FaultState`
  as a new parameter on whatever the flow-solve entry function's input type is, alongside the
  existing `extraLatencyMsByServer`):

  ```ts
  const errorFault = faultsForServer(target.serverId, ...).find(
    (f): f is Extract<FaultSpec, { kind: 'error-inject' }> => f.kind === 'error-inject',
  )
  if (errorFault) {
    const faultErrorRps = admitted * errorFault.errorFraction
    flow.errorRps += faultErrorRps
    addDownstream(flow, dep.id, target, faultErrorRps, path.hopClass, true, 'fault')
  }
  ```

  Place this so it composes with (does not replace) the existing timeout-driven error path — both
  can be non-zero simultaneously, matching how `cpu-brownout` composes with VPS steal in Task 3.
  Extend `addDownstream`'s reason-tagging parameter (whatever its actual current type is — confirm
  by reading its real signature at `flows.ts:467` before editing) with a `'fault'` case.

- [ ] **Step 4: Wire the `FaultState` parameter through from `index.ts`**

  Find the call site in `index.ts`'s `runStep` that invokes the flow solver (the function whose
  body contains the dependency loop edited in Step 3 — likely called `solveFlows` or similar; grep
  for the flows.ts export used there) and add `faults: s.faults` to its input object, alongside the
  existing `extraLatencyMsByServer`.

- [ ] **Step 5: Run tests, verify pass**

  Run: `npx vitest run -t "error-inject"`
  Expected: PASS, including the breaker-trip assertion (confirms no new breaker logic needed — it
  should already trip from the existing `errorRate` signal `breakers.ts` reads).

- [ ] **Step 6: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/flows.ts src/lib/worldEngine/index.ts
  git commit -m "feat(engine): wire error-inject fault into flow solver"
  ```

---

## Task 6: `simulation.store.ts` — `setFault` store action + divergence/perf guards

**Files:**
- Modify: `src/app/store/simulation.store.ts`
- Test: `src/app/store/simulation.store.test.ts` (check if this file exists; if not, add fault
  coverage to whichever test file already covers `setOutage`)
- Modify: `src/lib/worldEngine/index.test.ts` (add the FEAT-001 `DIVERGENCE GUARD` test)
- Reference only (no edit unless a regression appears): `bench/enginePerf.bench.test.ts`

**Interfaces:**
- Consumes: `WorldEngineApi.setFault`/`setOutage` (Task 1/3).
- Produces: `SimulationStore.setFault: (scope: FaultScope, id: string, spec: FaultSpec | null) =>
  void`, added to the store interface alongside the existing `setOutage` field (currently line 156).
  This is the exact name Task 8's UI components call.

- [ ] **Step 1: Write the failing store test**

  ```ts
  it('setFault delegates to the engine facade and updates healthOverrides for a down fault', () => {
    const store = useSimulationStore.getState()
    store.setFault('server', 'srv-1', { kind: 'down' })
    expect(useSimulationStore.getState().healthOverrides['srv-1']).toBe(true)
    store.setFault('server', 'srv-1', null)
    expect(useSimulationStore.getState().healthOverrides['srv-1']).toBe(false)
  })

  it('setOutage still works, implemented in terms of setFault', () => {
    const store = useSimulationStore.getState()
    store.setOutage('server', 'srv-1', true)
    expect(useSimulationStore.getState().healthOverrides['srv-1']).toBe(true)
  })
  ```

  (Mock/stub `worldEngine` per whatever mocking convention this store's existing tests already use
  — do not introduce a new mocking pattern.)

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "setFault"`
  Expected: FAIL — `setFault` not on the store yet.

- [ ] **Step 3: Add the store action**

  In `src/app/store/simulation.store.ts`, add `setFault` to the store interface (near line 156,
  beside `setOutage`), and implement it (near lines 278-281, replacing/extending the current
  `setOutage`):

  ```ts
  setFault: (scope, id, spec) => {
    worldEngine.setFault(scope, id, spec)
    set((s) => ({ healthOverrides: { ...s.healthOverrides, [id]: spec !== null } }))
  },
  setOutage: (scope, id, down) => {
    get().setFault(scope, id, down ? { kind: 'down' } : null)
  },
  ```

  (`healthOverrides[id] = spec !== null` treats ANY active fault, not just `down`, as worth
  flagging in `healthOverrides` — confirm this is the desired UI signal by checking how
  `healthOverrides` is consumed downstream; if it specifically means "hard down" for existing
  consumers, keep `setOutage`'s existing narrower semantics and give `setFault` its own separate
  `faultOverrides` map instead so non-`down` faults don't get misread as full outages by existing
  UI. Prefer the separate-map approach — it is more conservative and won't require auditing every
  existing `healthOverrides` consumer.)

- [ ] **Step 4: Run store tests, verify pass**

  Run: `npx vitest run -t "setFault"`
  Expected: PASS.

- [ ] **Step 5: Add the FEAT-001 `DIVERGENCE GUARD` test**

  Per the repo's established convention (`index.test.ts`'s five existing `DIVERGENCE GUARD` tests),
  add a sixth for memory-leak-driven RAM, since that's the fault kind that changes load:

  ```ts
  it('DIVERGENCE GUARD: memory-leak RAM growth agrees between scheduler and metrics', () => {
    const w = /* single-instance world with headroom */
    const st = run(w)
    st.engine.setFault('server', w.sv, { kind: 'memory-leak', mbPerMinute: 60 })
    st.engine.step(30_000)
    const b = st.latest()
    const schedulerRam = b.servers[w.sv].ramUsedMb
    const metricsRam = b.servers[w.sv].ramByInstance.reduce((sum, r) => sum + r.ramMb, 0)
    expect(schedulerRam).toBeGreaterThan(0)
    expect(schedulerRam / metricsRam).toBeGreaterThan(0.5)
    expect(schedulerRam / metricsRam).toBeLessThan(2)
    st.engine.stop()
  })
  ```

- [ ] **Step 6: Run the perf bench in isolation**

  Run: `npm run bench`
  Expected: no measurable regression with zero faults active (the common case); with faults active
  at ~2,000 instances, step cost stays under the spec's 0.05 ms/step delta budget. If the bench
  shows a bigger delta, profile whether `faultsForServer` is being called more than once per
  server per step (Task 3-5 all reuse a single per-step `activeFaults` resolution — verify that
  discipline held).

- [ ] **Step 7: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/app/store/simulation.store.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(store): add setFault action, divergence guard for memory-leak RAM"
  ```

---

## Task 7: `fault-injected` analysis finding

**Files:**
- Modify: `src/lib/analysis/rules/capacity.ts`
- Test: `src/lib/analysis/rules/capacity.test.ts` (or wherever this file's sibling rules are tested)

**Interfaces:**
- Consumes: `AnalysisRule`/`AnalysisFinding`/`AnalysisInput` shapes (`src/lib/analysis/types.ts` —
  read this file first to get the exact field names before writing the rule; the earlier research
  pass did not confirm its exact contents).
- Produces: a new rule spread into `capacityRules` (`capacity.ts:179`), consumed by
  `ANALYSIS_RULES` (`runAnalysis.ts:10-14`) automatically — no other file needs to change.

- [ ] **Step 1: Read `src/lib/analysis/types.ts` to confirm exact types**

  Read the file. Confirm `AnalysisRule`, `AnalysisFinding`, `AnalysisInput` field names exactly —
  the `singleAzRegion` example from `structural.ts` (reproduced in this plan's research) gives the
  shape (`id, ruleId, family, severity, title, why, fix, affected`), but verify against the actual
  type definitions before writing code that must compile.

- [ ] **Step 2: Write the failing test**

  ```ts
  it('fault-injected fires an info finding when any operator fault is active', () => {
    const compiled = /* fixture compiled world */
    const doc = /* fixture doc */
    // lastBatch or however this rule family learns about active faults — if AnalysisInput has
    // no notion of "active faults" today, this rule needs a new additive-optional field on
    // whatever input shape carries live engine state (likely lastBatch/MetricsBatch, extended
    // in a way consistent with how other capacity rules read live metrics). Confirm the actual
    // plumbing path before finalizing this test.
    const findings = faultInjected.run({ doc, compiled, lastBatch })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('info')
  })
  ```

  If `AnalysisInput` has no path to "is a fault currently active," this task additionally needs a
  small additive field on `MetricsBatch` (or wherever `lastBatch` originates) surfacing the active
  fault count/ids — coordinate this with Task 3's engine-side work rather than duplicating a
  resolution point. Add `MetricsBatch.activeFaultCount?: number` (additive-optional) populated in
  `metrics.ts` from `state.faults.active.size`, and log it in `contract-drift.md`.

- [ ] **Step 3: Implement the rule**

  ```ts
  const faultInjected: AnalysisRule = {
    id: 'fault-injected', family: 'capacity',
    run: ({ lastBatch }) => {
      if (!lastBatch?.activeFaultCount) return []
      return [{
        id: 'fault-injected', ruleId: 'fault-injected', family: 'capacity', severity: 'info',
        title: 'Operator-induced fault active',
        why: `${lastBatch.activeFaultCount} fault${lastBatch.activeFaultCount === 1 ? ' is' : 's are'} currently injected by the operator — observed degradation may be intentional, not architectural.`,
        fix: 'Clear active faults from the Chaos controls to see baseline behavior.',
        affected: [],
      }]
    },
  }
  ```

  Spread `faultInjected` into `capacityRules` (`capacity.ts:179`).

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run -t "fault-injected"`
  Expected: PASS.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/analysis/rules/capacity.ts src/lib/worldEngine/metrics.ts src/lib/worldEngine/types.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(analysis): add fault-injected info finding"
  ```

---

## Task 8: Chaos UI — split control on the five call sites

**Files:**
- Modify: `src/app/world/dock/ServerFaceplate.tsx` (call site ~lines 299-309)
- Modify: `src/app/world/dock/AzConfigTab.tsx` (call site ~lines 356-366)
- Modify: `src/app/world/region/AzRow.tsx` (call site ~lines 127-133)
- Modify: `src/app/world/RegionView.tsx` (call site ~lines 135-143)
- Modify: `src/app/world/ui/overlays/RegionOverlay.tsx` (call site ~lines 62-66)
- Create: `src/app/world/dock/ChaosControl.tsx` — the shared split-button component, so the five
  call sites share ONE implementation instead of five forked variants (per the spec's explicit
  instruction: "all five reuse the SAME store action — do not fork a variant")

**Interfaces:**
- Consumes: `useSimulationStore(s => s.setFault)`, `useSimulationStore(s => s.healthOverrides)` (or
  the separate fault-overrides map decided in Task 6 Step 3), `FaultScope`/`FaultSpec` types.
- Produces: `<ChaosControl scope={...} id={...} running={boolean} />` — a single reusable component
  each of the five call sites renders in place of their current bare kill button.

- [ ] **Step 1: Build `ChaosControl.tsx`**

  A split button: primary click still calls `setFault(scope, id, currentlyFaulted ? null : {
  kind: 'down' })` (today's exact behavior when the `▾` menu is never opened — the regression
  floor for anyone who doesn't discover the new menu). A `▾` opens a small popover listing the
  other four `FaultKind`s, each with its one numeric parameter (a `NumberField`-style input,
  reusing whatever the existing shared numeric input component is — check `panels/NumberField` per
  `CLAUDE.md`'s reference to `PacketMixEditor/NumberField` as shared controls, reuse it here rather
  than building a new numeric input).

  Disabled (both primary and `▾`) when `!running`, with the standardized tooltip `start the
  simulation to break things`. When a fault (any kind) is active, render the entity with the amber
  hatch non-fatal-fault affordance if the kind is non-`down`, or the existing dark/struck treatment
  if `down` — both driven by `var(--color-*)` tokens, no hardcoded hex, checked in both themes.

  ```tsx
  // src/app/world/dock/ChaosControl.tsx
  import { useState } from 'react'
  import { useSimulationStore } from '../../store/simulation.store'
  import type { FaultKind, FaultScope, FaultSpec } from '../../../lib/worldEngine/types'

  const FAULT_LABELS: Record<FaultKind, string> = {
    down: 'Kill',
    'latency-add': 'Add latency',
    'cpu-brownout': 'CPU brownout',
    'memory-leak': 'Memory leak',
    'error-inject': 'Inject errors',
  }

  export function ChaosControl({ scope, id, running }: { scope: FaultScope; id: string; running: boolean }) {
    const setFault = useSimulationStore((s) => s.setFault)
    const activeFault = useSimulationStore((s) => s.activeFaults?.[id] ?? null)
    const [menuOpen, setMenuOpen] = useState(false)
    const isFaulted = activeFault !== null

    const apply = (spec: FaultSpec | null) => {
      setFault(scope, id, spec)
      setMenuOpen(false)
    }

    return (
      <div className="chaos-control">
        <button
          type="button"
          disabled={!running}
          title={running ? undefined : 'start the simulation to break things'}
          onClick={() => apply(isFaulted ? null : { kind: 'down' })}
        >
          {isFaulted && activeFault?.kind === 'down' ? 'Restore' : 'Kill'}
        </button>
        <button
          type="button"
          disabled={!running}
          title={running ? undefined : 'start the simulation to break things'}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {'▾'}
        </button>
        {menuOpen && (
          <div className="chaos-menu">
            {(Object.keys(FAULT_LABELS) as FaultKind[])
              .filter((k) => k !== 'down')
              .map((kind) => (
                <ChaosMenuItem key={kind} kind={kind} onApply={(spec) => apply(spec)} />
              ))}
            {isFaulted && (
              <button type="button" onClick={() => apply(null)}>
                Clear fault
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  function ChaosMenuItem({ kind, onApply }: { kind: Exclude<FaultKind, 'down'>; onApply: (spec: FaultSpec) => void }) {
    const [value, setValue] = useState(kind === 'cpu-brownout' ? 0.5 : kind === 'error-inject' ? 0.1 : kind === 'memory-leak' ? 60 : 200)
    const param = kind === 'latency-add' ? { ms: value } : kind === 'cpu-brownout' ? { capacityFraction: value } : kind === 'memory-leak' ? { mbPerMinute: value } : { errorFraction: value }
    return (
      <div className="chaos-menu-item">
        <span>{FAULT_LABELS[kind]}</span>
        <input type="number" value={value} onChange={(e) => setValue(Number(e.target.value))} />
        <button type="button" onClick={() => onApply({ kind, ...param } as FaultSpec)}>
          Apply
        </button>
      </div>
    )
  }
  ```

  Style `.chaos-control`/`.chaos-menu`/`.chaos-menu-item` using `var(--color-*)` tokens only —
  match the existing dock control styling conventions (check a sibling file like
  `ServerFaceplate.tsx`'s existing button CSS/CSS-in-JS approach and mirror it, don't introduce a
  new styling method).

  This task also needs `activeFaults: Record<string, FaultSpec | null>` added to the simulation
  store (Task 6's separate-map decision) if not already added there — coordinate: if Task 6 chose
  the separate-map approach, this component reads that map; if Task 6 reused `healthOverrides`,
  simplify `ChaosControl` to read the boolean-only signal instead and drop the `activeFault?.kind`
  distinction (in which case the amber-hatch-vs-struck visual distinction from the spec can't be
  rendered accurately, so prefer the separate-map approach in Task 6).

- [ ] **Step 2: Replace the five call sites**

  In each of `ServerFaceplate.tsx`, `AzConfigTab.tsx`, `AzRow.tsx`, `RegionView.tsx`,
  `RegionOverlay.tsx`: replace the existing bare kill `<button onClick={() =>
  setOutage(scope, id, !isManuallyDown)}>` with `<ChaosControl scope="server|az|region|managed"
  id={...} running={running} />`, passing the correct literal scope string per file (server for
  `ServerFaceplate`, az for `AzConfigTab`/the AZ button in `AzRow`, managed for the managed-service
  buttons in `AzRow`/`RegionView`/`DatacenterFloor` (bonus site found during research), region for
  `RegionView`'s region button and `RegionOverlay`).

  Leave every other prop/behavior on these five components untouched — this is a narrow,
  mechanical swap of one control for another at each site.

- [ ] **Step 3: Component smoke test for `ChaosControl`**

  ```tsx
  // src/app/world/dock/ChaosControl.test.tsx
  it('disables both buttons when not running, with the standardized tooltip', () => {
    render(<ChaosControl scope="server" id="s1" running={false} />)
    const kill = screen.getByRole('button', { name: /kill/i })
    expect(kill).toBeDisabled()
    expect(kill).toHaveAttribute('title', 'start the simulation to break things')
  })

  it('primary click applies a down fault when running', () => {
    // mock useSimulationStore, assert setFault called with ('server', 's1', { kind: 'down' })
  })

  it('menu apply sends the typed FaultSpec', () => {
    // open menu, pick cpu-brownout, change the numeric input, click Apply, assert setFault
    // called with ('server', 's1', { kind: 'cpu-brownout', capacityFraction: <value> })
  })
  ```

  Run: `npx vitest run src/app/world/dock/ChaosControl.test.tsx`
  Expected: PASS.

- [ ] **Step 4: Live smoke in the running app**

  Run `npm run tauri dev`. Start a simulation, open a server's faceplate, apply a CPU brownout via
  the `▾` menu, watch that server's cores redden and its latency chip climb while neighbouring
  servers stay flat. Clear it and watch recovery. Repeat once in light theme. Confirm zero new
  console errors.

- [ ] **Step 5: Type-check, full test suite, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/app/world/dock/ChaosControl.tsx src/app/world/dock/ChaosControl.test.tsx src/app/world/dock/ServerFaceplate.tsx src/app/world/dock/AzConfigTab.tsx src/app/world/region/AzRow.tsx src/app/world/RegionView.tsx src/app/world/ui/overlays/RegionOverlay.tsx src/app/world/az/DatacenterFloor.tsx
  git commit -m "feat(ui): add shared ChaosControl split button, replace 5 kill-button call sites"
  ```

This completes FEAT-001.

---

# FEAT-002: Network Partition & Link Impairment

## Task 9: `LinkEndpoint`/`PartitionFault` types + `FaultState` extension + `impairmentFor`

**Files:**
- Modify: `src/lib/worldEngine/types.ts` (add `LinkEndpoint`, `PartitionFault`; add
  `'partition_started' | 'partition_healed'` to `EngineEventKind`)
- Modify: `src/lib/worldEngine/faults.ts` (extend `FaultState` with `partitions`, add
  `addPartition`/`removePartition`/`impairmentFor`)
- Test: `src/lib/worldEngine/faults.test.ts`
- Modify: `.superpowers/sdd/contract-drift.md`

**Interfaces:**
- Produces: `LinkEndpoint`, `PartitionFault`, `FaultState.partitions: PartitionFault[]`,
  `addPartition(state, fault, simMs): EngineEvent`, `removePartition(state, index, simMs):
  EngineEvent`, `impairmentFor(path: CompiledPath, partitions: PartitionFault[]): { blocked:
  boolean; lossFraction: number; delayMs: number }`. Task 10 (`index.ts` per-step memo) and Task 11
  (`flows.ts`)/Task 12 (`routingRuntime.ts`) consume this exact signature.

- [ ] **Step 1: Add the types**

  In `src/lib/worldEngine/types.ts`, near the FEAT-001 types added in Task 1:

  ```ts
  export type LinkEndpoint =
    | { kind: 'region'; id: string }
    | { kind: 'az'; id: string }
    | { kind: 'server'; id: string }
    | { kind: 'internet' }

  export interface PartitionFault {
    from: LinkEndpoint
    to: LinkEndpoint
    mode: 'drop' | 'loss' | 'delay'
    lossFraction?: number
    delayMs?: number
    symmetric: boolean
  }
  ```

  (Use plain `string` ids rather than the branded `RegionId`/`AzId`/`ServerId` types from
  `world/types.ts` if `worldEngine/types.ts` doesn't already import those branded types elsewhere —
  check the file's existing id conventions first and match them exactly.)

  Add to `EngineEventKind`: `| 'partition_started' | 'partition_healed'`.

  Log both additions in `contract-drift.md`.

- [ ] **Step 2: Write failing tests for `impairmentFor`**

  ```ts
  describe('faults: impairmentFor', () => {
    const path = (hopClass: string, from: LinkEndpoint, to: LinkEndpoint): any => ({ hopClass, fromEndpoint: from, toEndpoint: to /* match CompiledPath's real shape once confirmed */ })

    it('returns no impairment when there are no partitions', () => {
      const result = impairmentFor(somePath, [])
      expect(result).toEqual({ blocked: false, lossFraction: 0, delayMs: 0 })
    })

    it('a symmetric drop blocks paths in both directions between the endpoints', () => {
      const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
      expect(impairmentFor(pathFromTo('r1', 'r2'), [partition]).blocked).toBe(true)
      expect(impairmentFor(pathFromTo('r2', 'r1'), [partition]).blocked).toBe(true)
    })

    it('an asymmetric drop blocks only from->to, leaving to->from untouched', () => {
      const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: false }
      expect(impairmentFor(pathFromTo('r1', 'r2'), [partition]).blocked).toBe(true)
      expect(impairmentFor(pathFromTo('r2', 'r1'), [partition]).blocked).toBe(false)
    })

    it('loss mode returns the configured lossFraction, not blocked', () => {
      const partition: PartitionFault = { from: { kind: 'az', id: 'az1' }, to: { kind: 'az', id: 'az2' }, mode: 'loss', lossFraction: 0.3, symmetric: true }
      const result = impairmentFor(pathBetweenAzs('az1', 'az2'), [partition])
      expect(result.blocked).toBe(false)
      expect(result.lossFraction).toBe(0.3)
    })

    it('delay mode returns the configured delayMs', () => {
      const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'delay', delayMs: 150, symmetric: true }
      expect(impairmentFor(pathFromTo('r1', 'r2'), [partition]).delayMs).toBe(150)
    })

    it('an unrelated path is untouched to the digit', () => {
      const partition: PartitionFault = { from: { kind: 'region', id: 'r1' }, to: { kind: 'region', id: 'r2' }, mode: 'drop', symmetric: true }
      expect(impairmentFor(pathFromTo('r3', 'r4'), [partition])).toEqual({ blocked: false, lossFraction: 0, delayMs: 0 })
    })
  })
  ```

  Before writing the real assertions, read `CompiledPath`'s actual fields (`world/types.ts:412-420`,
  confirmed to exist in this range from the earlier research) to know exactly what a path exposes
  about its endpoints (region/AZ/server ids, `hopClass`) — write `pathFromTo`/`pathBetweenAzs` test
  helpers against the real shape, not a guessed one.

- [ ] **Step 3: Run to confirm failure**

  Run: `npx vitest run -t "impairmentFor"`
  Expected: FAIL.

- [ ] **Step 4: Implement**

  Extend `FaultState` in `faults.ts`:

  ```ts
  export interface FaultState {
    active: Map<string, FaultSpec>
    leakAccumMb: Map<InstanceId, number>
    partitions: PartitionFault[]
  }

  export function createFaultState(): FaultState {
    return { active: new Map(), leakAccumMb: new Map(), partitions: [] }
  }

  export function addPartition(state: FaultState, fault: PartitionFault, simMs: number): EngineEvent {
    state.partitions.push(fault)
    return { kind: 'partition_started', severity: 'warning', message: `partition ${endpointLabel(fault.from)} -> ${endpointLabel(fault.to)} (${fault.mode})`, affected: [], simMs }
  }

  export function removePartition(state: FaultState, index: number, simMs: number): EngineEvent {
    const [removed] = state.partitions.splice(index, 1)
    return { kind: 'partition_healed', severity: 'info', message: `partition healed: ${endpointLabel(removed.from)} -> ${endpointLabel(removed.to)}`, affected: [], simMs }
  }

  function endpointLabel(e: LinkEndpoint): string {
    return e.kind === 'internet' ? 'internet' : `${e.kind}:${e.id}`
  }

  function endpointMatches(endpoint: LinkEndpoint, scope: 'region' | 'az' | 'server', id: string, hierarchyIds: { regionId: string; azId: string; serverId: string }): boolean {
    if (endpoint.kind === 'internet') return false
    if (endpoint.kind === 'region') return hierarchyIds.regionId === endpoint.id
    if (endpoint.kind === 'az') return hierarchyIds.azId === endpoint.id
    return hierarchyIds.serverId === endpoint.id
  }

  export function impairmentFor(
    fromIds: { regionId: string; azId: string; serverId: string },
    toIds: { regionId: string; azId: string; serverId: string },
    partitions: PartitionFault[],
  ): { blocked: boolean; lossFraction: number; delayMs: number } {
    let blocked = false
    let lossFraction = 0
    let delayMs = 0
    for (const p of partitions) {
      const forward = endpointMatches(p.from, p.from.kind as any, '', fromIds) && endpointMatches(p.to, p.to.kind as any, '', toIds)
      const backward = !p.symmetric ? false : endpointMatches(p.to, p.to.kind as any, '', fromIds) && endpointMatches(p.from, p.from.kind as any, '', toIds)
      if (!forward && !backward) continue
      if (p.mode === 'drop') blocked = true
      if (p.mode === 'loss') lossFraction = Math.max(lossFraction, p.lossFraction ?? 0)
      if (p.mode === 'delay') delayMs += p.delayMs ?? 0
    }
    return { blocked, lossFraction, delayMs }
  }
  ```

  Note: the `endpointMatches` signature above is awkward (it takes an unused `scope`/`id` pair
  alongside `hierarchyIds`) — simplify it during implementation to just `endpointMatches(endpoint:
  LinkEndpoint, hierarchyIds): boolean` once actually writing this, since the scope is already
  encoded in `endpoint.kind`. This plan's pseudocode should not be copied verbatim without that
  cleanup; write the clean version directly.

- [ ] **Step 5: Run tests, verify pass**

  Run: `npx vitest run -t "impairmentFor"`
  Expected: PASS.

- [ ] **Step 6: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/types.ts src/lib/worldEngine/faults.ts src/lib/worldEngine/faults.test.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat(engine): add PartitionFault type and pure impairmentFor predicate"
  ```

---

## Task 10: Per-step impairment memo in `runStep`

**Files:**
- Modify: `src/lib/worldEngine/index.ts`

**Interfaces:**
- Consumes: `impairmentFor` (Task 9), `state.faults.partitions`.
- Produces: a per-step `Map<pathKey, Impairment>` built once at the top of `runStep`, exposed to
  Task 11 (`flows.ts`) and Task 12 (`routingRuntime.ts`) via whatever parameter each already
  receives from `index.ts` (extend the same input objects Task 5 extended with `faults`).

- [ ] **Step 1: Write a failing perf-shape test**

  ```ts
  it('builds no impairment memo work when there are no partitions', () => {
    // spy on impairmentFor (or count calls via a wrapping counter) and assert it is never
    // invoked when state.faults.partitions is empty, confirming the short-circuit guard exists.
  })
  ```

- [ ] **Step 2: Implement the memo**

  At the top of `runStep` (near where other per-step precomputation happens, following the
  "one-step-memo pattern `index.ts:328` already uses for the role resolver" cited in the spec),
  add:

  ```ts
  const impairmentMemo: Map<string, { blocked: boolean; lossFraction: number; delayMs: number }> = new Map()
  if (s.faults.partitions.length > 0) {
    for (const path of compiled.paths) {
      const key = pathKeyFor(path)   // reuse whatever existing pathKey helper flows.ts/routingRuntime.ts already use
      impairmentMemo.set(key, impairmentFor(path.fromIds, path.toIds, s.faults.partitions))
    }
  }
  ```

  Confirm `pathKeyFor`/the equivalent already exists (grep `pathKey` across `flows.ts`); if not,
  add one keyed on the same fields `CompiledPath` already uses for identity elsewhere in the file,
  reusing that identity scheme rather than inventing a new one.

  Thread `impairmentMemo` into both the flow-solve call (Task 5 already added a `faults` parameter
  there — add `impairmentMemo` alongside it) and the health-check call site (Task 12).

- [ ] **Step 3: Run the perf-shape test, verify pass**

  Run: `npx vitest run -t "builds no impairment memo"`
  Expected: PASS.

- [ ] **Step 4: Type-check, commit**

  Run: `npx tsc --noEmit`
  ```bash
  git add src/lib/worldEngine/index.ts
  git commit -m "feat(engine): build per-step partition impairment memo"
  ```

---

## Task 11: Consult the memo in `flows.ts`

**Files:**
- Modify: `src/lib/worldEngine/flows.ts`
- Test: `flows.test.ts` (or `index.test.ts`, matching Task 5's file choice)

**Interfaces:**
- Consumes: `impairmentMemo` (Task 10), threaded as a new field on the flow-solver's input type.
- Produces: partition-aware refusal/latency behavior in the dependency loop — no new exported
  functions, this is behavior wired into the existing loop.

- [ ] **Step 1: Write failing tests**

  ```ts
  it('a symmetric drop partition zeroes cross-region flow via the existing structural-refusal branch', () => {
    // two-region world, dependency crossing regions, addPartition drop symmetric between them;
    // run; assert admitted rps to the far region is 0 and structuralRefusedRps rose by the
    // full offered share — NOT the general overload-shedding signal (assert that separately,
    // e.g. some other flag/counter the repo already uses for Mechanism B stays untouched).
  })

  it('a loss partition at 0.3 refuses ~30% of attempts on matching paths, unmatched paths untouched to the digit', () => {
    // same two-region world; addPartition loss 0.3; assert ~30% refusal rate on matching flow,
    // and a THIRD region's unrelated path shows byte-identical numbers to a zero-partition run.
  })

  it('a delay partition at 150ms raises composed p50Ms on matching hops, same-AZ hops untouched', () => {
    // assert delta ~150ms on the cross-region p50 and exact-zero delta on a same-AZ p50 in the
    // same world.
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "partition"`
  Expected: FAIL.

- [ ] **Step 3: Implement**

  In the dependency loop, at the existing `path.verdict === 'blocked'` branch (lines 673-681) and
  immediately before it, check the memo:

  ```ts
  const impairment = impairmentMemo?.get(pathKeyFor(path)) ?? { blocked: false, lossFraction: 0, delayMs: 0 }

  if (path.verdict === 'blocked' || impairment.blocked) {
    flow.refusedRps += share
    flow.structuralRefusedRps = (flow.structuralRefusedRps ?? 0) + share
    addDownstream(flow, dep.id, target, share, path.hopClass, true, path.verdict === 'blocked' ? undefined : 'partition')
    continue
  }

  const lossShare = share * impairment.lossFraction
  const passedShare = share - lossShare
  if (lossShare > 0) {
    flow.refusedRps += lossShare
    flow.structuralRefusedRps = (flow.structuralRefusedRps ?? 0) + lossShare
    addDownstream(flow, dep.id, target, lossShare, path.hopClass, true, 'partition')
  }
  // continue with `passedShare` instead of `share` for the remainder of this iteration's
  // normal (non-blocked) admission/latency logic below.
  ```

  Fold `impairment.delayMs` into the hop's latency where `networkRuntime.baseHopLatencyMs`'s
  result is consumed in this same loop (the composed-latency pass) — add it additively to
  whatever variable already accumulates hop latency there.

  Route `impairment.lossFraction` refusals into `structuralRefusedRps`, matching the `drop` case —
  per the spec, a partition (loss or drop) is structurally indistinguishable from a firewall block
  from the flow solver's point of view, so both must avoid feeding Mechanism B's overload-shedding
  signal (whatever that signal's actual variable name is — confirm it's genuinely separate from
  `structuralRefusedRps` by reading the surrounding code before asserting the test in Step 1
  distinguishes them correctly).

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run -t "partition"`
  Expected: PASS.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/flows.ts
  git commit -m "feat(engine): consult partition impairment memo in flow solver"
  ```

---

## Task 12: Directional health checks in `routingRuntime.ts` — the split-brain enabler

**Files:**
- Modify: `src/lib/worldEngine/routingRuntime.ts`
- Modify: `src/lib/worldEngine/index.ts` (the `probeOfScope` computation, ~lines 657-663, must
  consult the memo before health checks run)
- Test: `src/lib/worldEngine/routingRuntime.test.ts` (or `index.test.ts`)

**Interfaces:**
- Consumes: `impairmentMemo` (Task 10).
- Produces: directional health-probe failure — when `symmetric: false`, region B's probe of region
  A fails while region A's probe of region B succeeds, feeding `runHealthChecks`'s existing
  `scopes[].health` input with a partition-aware value instead of the raw uniform one.

- [ ] **Step 1: Write the split-brain test — this is the feature's reason for existing**

  ```ts
  it('THE SPLIT-BRAIN TEST: an asymmetric partition produces two simultaneous effective primaries', () => {
    const w = /* active-active two-region world, a replicated service with a primary in region A */
    const st = run(w)
    st.engine.setPartition({ from: { kind: 'region', id: w.regionA }, to: { kind: 'region', id: w.regionB }, mode: 'drop', symmetric: false })
    st.engine.step(60_000)   // give health checks + promotion time to converge
    const b = st.latest()
    const primariesInCluster = /* count instances with role === 'primary' for the replicated blueprintId across both regions */
    expect(primariesInCluster).toBe(2)
    const events = st.engine.drainEvents?.() ?? []
    expect(events.filter((e) => e.kind === 'replica_promoted')).toHaveLength(2)
    st.engine.stop()
  })

  it('healing a partition restores flow and clears split-brain within one health-check interval', () => {
    // same setup; after asserting split-brain, call setPartition-heal (or setFault clearing the
    // partition via whatever the store/engine API names it — see Task 13), step forward one
    // health-check interval, and assert back to one effective primary.
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "SPLIT-BRAIN"`
  Expected: FAIL.

- [ ] **Step 3: Implement**

  In `index.ts`, where `probeOfScope` is currently computed (lines 657-663: `hasOutage(s.failover,
  scope, id) ? 'down' : (s.probePrev.get(id) ?? 'healthy')`), extend it so a scope whose *inbound*
  health-check path is impaired reports `'down'` even though the target itself is healthy. This
  requires computing health from the PROBING scope's point of view, not just the target's: for
  each region A checking region B, look up `impairmentMemo` for the A→B direction specifically
  (not B→A) and force `'down'` if `blocked` there, regardless of B's own health.

  This is the crux of the split-brain mechanism: `runHealthChecks` (`routingRuntime.ts:82-108`)
  itself needs NO changes — it already just consumes whatever `health` value each scope is handed.
  The change is entirely in how `index.ts` computes that per-direction `health` value before
  calling `runHealthChecks`, now asking "is MY path to the thing I'm checking impaired" rather
  than "is the thing I'm checking down."

  Concretely: `runHealthChecks` needs to be called once per DIRECTION when partitions are active,
  not once per scope globally — or `probeOfScope` needs to become
  `probeOfScope(observerRegionId, targetScope, targetId)` so the same target can report different
  health to different observers. Confirm which shape the existing call site more naturally
  supports before choosing; the directional-probe-per-observer shape is more correct but is a
  larger change to the call site's signature — do the smaller change that still produces correct
  asymmetric results (a per-observer-region health map is likely sufficient, since `LinkEndpoint`
  partitions are scoped at region/az/server granularity, not per-instance).

- [ ] **Step 4: Run the split-brain test, verify pass**

  Run: `npx vitest run -t "SPLIT-BRAIN"`
  Expected: PASS. This is the load-bearing test for the entire feature — do not consider Task 12
  done until it passes for real, not via a shortcut that merely forces two primaries without the
  directional-health mechanism actually producing them.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/routingRuntime.ts src/lib/worldEngine/index.ts
  git commit -m "feat(engine): directional health checks under asymmetric partition (split-brain)"
  ```

---

## Task 13: `split-brain-risk` analysis rule + `setPartition` store action

**Files:**
- Modify: `src/lib/analysis/rules/structural.ts`
- Modify: `src/app/store/simulation.store.ts` (`setPartition`/`healPartition` actions)
- Test: `src/lib/analysis/rules/structural.test.ts`, simulation store test file

**Interfaces:**
- Consumes: `PartitionFault` type; `addPartition`/`removePartition` (Task 9); the engine-facade
  methods this task adds to `WorldEngineApi` (`setPartition`, `healPartition` — additive, not a
  break, unlike `setFault`).
- Produces: `SimulationStore.setPartition(fault: PartitionFault): void`,
  `SimulationStore.healPartition(index: number): void` — the exact names the Task 14 UI calls.

- [ ] **Step 1: Add `setPartition`/`healPartition` to `WorldEngineApi`**

  In `worldEngine/types.ts`, add (additive, log in `contract-drift.md`):

  ```ts
  setPartition: (fault: PartitionFault) => void
  healPartition: (index: number) => void
  ```

  Implement in `index.ts`'s facade, delegating to `addPartition`/`removePartition` from `faults.ts`
  and emitting the returned event.

- [ ] **Step 2: Write failing tests for the structural rule**

  ```ts
  it('split-brain-risk fires when two effective primaries exist in one blueprintId|regionId cluster', () => {
    // fixture compiled world with two instances of the same blueprintId marked primary in the
    // same conceptual cluster; assert one finding, family structural, naming both regions.
  })
  it('split-brain-risk does not fire with exactly one primary per cluster', () => {
    const findings = splitBrainRisk.run({ doc, compiled, lastBatch })
    expect(findings).toHaveLength(0)
  })
  ```

- [ ] **Step 3: Run to confirm failure**

  Run: `npx vitest run -t "split-brain-risk"`
  Expected: FAIL.

- [ ] **Step 4: Implement the rule**

  ```ts
  const splitBrainRisk: AnalysisRule = {
    id: 'split-brain-risk', family: 'structural',
    run: ({ compiled, lastBatch }) => {
      const primariesByCluster = new Map<string, string[]>()
      for (const inst of Object.values(compiled.instances)) {
        const role = lastBatch?.instances?.[inst.id]?.role   // confirm the real field name on InstanceMetrics before writing this line
        if (role !== 'primary') continue
        const clusterKey = `${inst.blueprintId}|${inst.regionId}`
        const list = primariesByCluster.get(clusterKey) ?? []
        list.push(inst.id)
        primariesByCluster.set(clusterKey, list)
      }
      const out: AnalysisFinding[] = []
      for (const [clusterKey, instanceIds] of primariesByCluster) {
        if (instanceIds.length <= 1) continue
        out.push({
          id: `split-brain-risk:${clusterKey}`, ruleId: 'split-brain-risk', family: 'structural', severity: 'critical',
          title: 'Split-brain: multiple effective primaries',
          why: `${instanceIds.length} instances in cluster ${clusterKey} are all acting as primary simultaneously — likely an asymmetric network partition.`,
          fix: 'Heal the partition, or demote all but one primary once connectivity is restored.',
          affected: instanceIds,
        })
      }
      return out
    },
  }
  ```

  Spread into `structuralRules` (`structural.ts:247`). Note: the `clusterKey` here is
  `blueprintId|regionId`, matching `promoteReplicas`'s existing cluster key convention
  (`failover.ts:351`) — reuse that exact key derivation if it's already available as a helper
  rather than re-deriving it inline.

- [ ] **Step 5: Run tests, verify pass**

  Run: `npx vitest run -t "split-brain-risk"`
  Expected: PASS.

- [ ] **Step 6: Add store actions with tests**

  ```ts
  // simulation.store.ts
  setPartition: (fault) => {
    worldEngine.setPartition(fault)
  },
  healPartition: (index) => {
    worldEngine.healPartition(index)
  },
  ```

  Add store-level tests mirroring Task 6 Step 1's shape (mock the facade, assert delegation).

- [ ] **Step 7: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/analysis/rules/structural.ts src/lib/worldEngine/types.ts src/lib/worldEngine/index.ts src/app/store/simulation.store.ts .superpowers/sdd/contract-drift.md
  git commit -m "feat: add split-brain-risk rule and setPartition/healPartition store actions"
  ```

---

## Task 14: Partitions authoring UI + link visuals

**Files:**
- Create: `src/app/world/panels/PartitionsSection.tsx` (a small authoring surface added to the
  region-scope chaos controls — an endpoint pair, a mode, a symmetric toggle; per the spec, this
  lives alongside the region-scope config, not as a new top-level tab)
- Modify: `src/app/world/globe/ArcsLayer.tsx` (severed/impaired arc rendering)
- Modify: `src/app/world/region/CrossAzColumn.tsx` (struck-through / dashed column rendering)
- Modify: `src/app/world/az/DatacenterFloor.tsx` (dashed-red flow trace rendering)
- Test: `PartitionsSection.test.tsx`, plus visual-regression-style unit assertions on the three
  render files (assert the right CSS class/stroke-dash attribute appears given a partitioned prop,
  not a pixel-diff test)

**Interfaces:**
- Consumes: `useSimulationStore(s => s.setPartition)`, `useSimulationStore(s => s.healPartition)`,
  and a new `useSimulationStore(s => s.activePartitions)` selector (add this array to the store,
  populated from whatever the 1 Hz batch or a dedicated engine query exposes — since partitions are
  operator-authored state, not derived metrics, prefer holding them directly in the store rather
  than round-tripping through `MetricsBatch`; add a `partitions: PartitionFault[]` field to the
  store, updated locally on `setPartition`/`healPartition` calls rather than read back from the
  engine each tick).

- [ ] **Step 1: Add local partition list state to the store**

  ```ts
  // simulation.store.ts
  partitions: [] as PartitionFault[],
  setPartition: (fault) => {
    worldEngine.setPartition(fault)
    set((s) => ({ partitions: [...s.partitions, fault] }))
  },
  healPartition: (index) => {
    worldEngine.healPartition(index)
    set((s) => ({ partitions: s.partitions.filter((_, i) => i !== index) }))
  },
  ```

- [ ] **Step 2: Build `PartitionsSection.tsx`**

  A form: two endpoint pickers (scope dropdown: region/az/server/internet, then an id picker
  scoped to the compiled world's actual entities), a mode dropdown (drop/loss/delay), a
  conditional numeric field (`lossFraction` for loss, `delayMs` for delay), a symmetric checkbox,
  and an "Add partition" button calling `setPartition`. Below it, a list of `partitions` each with
  a "Heal" button calling `healPartition(index)`. Disabled while running is NOT correct here per
  the edit-lock law's inverse — partitions ARE a chaos action, so this form should follow the SAME
  inverse rule as `ChaosControl`: enabled only while running, tooltip `start the simulation to
  break things`.

  Style with `var(--color-*)` tokens only, verified in both themes.

- [ ] **Step 3: Component test**

  ```tsx
  it('Add partition calls setPartition with the authored fault', () => { /* ... */ })
  it('Heal calls healPartition with the correct index', () => { /* ... */ })
  it('form is disabled when not running', () => { /* ... */ })
  ```

  Run: `npx vitest run src/app/world/panels/PartitionsSection.test.tsx`
  Expected: PASS.

- [ ] **Step 4: Render severed/impaired links**

  In `ArcsLayer.tsx`, `CrossAzColumn.tsx`, `DatacenterFloor.tsx`: for each rendered link/arc/trace,
  check `partitions` from the store for a match against that link's endpoints (reuse whatever
  matching logic Task 9's `impairmentFor` established, or a simplified client-side version since
  this is presentation-only and doesn't need to be perf-sensitive). `drop` ⇒ break the arc/strike
  the column/dash-red the trace; `loss` ⇒ thin/stipple the line; `delay` ⇒ normal rendering, but
  the latency chip on that hop (already driven by the 1 Hz batch elsewhere) reflects the added
  delay automatically once Task 11's engine-side change is live — no extra UI work needed for the
  delay case beyond confirming the existing latency chip picks it up.

  All three use `var(--color-danger)` for `drop`, respect `prefers-reduced-motion` (no new
  looping animation — a broken arc is a static gap, not a pulse), and compute purely from the 1 Hz
  batch / the store's `partitions` array, never per animation frame.

- [ ] **Step 5: Render tests**

  ```tsx
  it('ArcsLayer renders a broken arc for a droppped partition matching its endpoints', () => { /* ... */ })
  it('CrossAzColumn strikes through when partitioned', () => { /* ... */ })
  it('DatacenterFloor dashes red for a partitioned flow trace', () => { /* ... */ })
  ```

  Run: `npx vitest run -t "partition"`
  Expected: PASS.

- [ ] **Step 6: Live smoke**

  Run `npm run tauri dev`. Partition two regions asymmetrically from the new Partitions section;
  confirm the globe arc breaks, both regions show a promoted primary, and the Analysis tab shows
  the `split-brain-risk` finding. Verify in both themes. Zero new console errors.

- [ ] **Step 7: Full suite + type-check + build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`
  ```bash
  git add src/app/world/panels/PartitionsSection.tsx src/app/world/panels/PartitionsSection.test.tsx src/app/world/globe/ArcsLayer.tsx src/app/world/region/CrossAzColumn.tsx src/app/world/az/DatacenterFloor.tsx src/app/store/simulation.store.ts
  git commit -m "feat(ui): add partition authoring surface and severed-link visuals"
  ```

- [ ] **Step 8: Run the perf bench**

  Run: `npm run bench`
  Expected: no regression at zero partitions; acceptable delta with a handful active, per the
  spec's < 0.1 ms/step budget.

This completes FEAT-002.

---

# FEAT-003: Scenario Timeline

## Task 15: `ScenarioAction`/`ScenarioStep`/`Scenario` types on `WorldDoc`

**Files:**
- Modify: `src/lib/world/types.ts` (add types near `WorldDoc`, lines 360-381; widen
  `DiurnalPattern`, line 38; add `curve?` to `ClientPopulation`)
- Test: none yet — pure type addition, verified by the type-check in later tasks' steps

**Interfaces:**
- Consumes: `FaultScope`, `FaultSpec` (FEAT-001, `worldEngine/types.ts`), `PartitionFault`
  (FEAT-002, `worldEngine/types.ts`) — note this makes `world/types.ts` depend on
  `worldEngine/types.ts`; confirm this import direction doesn't already violate a boundary rule
  (check `docs/module-boundaries.md` for a stated layering rule between `lib/world` and
  `lib/worldEngine` before adding this import — if the codebase currently keeps `world/types.ts`
  free of any `worldEngine` import, prefer re-declaring narrow structural-equivalent types in
  `world/types.ts` instead of importing, to avoid introducing a new cross-module dependency the
  boundaries doc doesn't already sanction).
- Produces: `ScenarioAction`, `ScenarioStep`, `Scenario`, `WorldDoc.scenario?: Scenario`,
  `ClientPopulation.curve?`, `DiurnalPattern` widened to include `'custom'`. Every later task in
  this feature imports these exact names.

- [ ] **Step 1: Check the import-direction question first**

  Read `docs/module-boundaries.md`'s section on `lib/world` vs `lib/worldEngine` layering (search
  for whichever section discusses the compiled-world gate / engine seam boundary). If `world/`
  must not import from `worldEngine/`, restate `FaultSpec`/`PartitionFault`'s shape locally in
  `world/types.ts` as `ScenarioFaultSpec`/`ScenarioPartitionFault` (structurally identical
  discriminated unions) rather than importing — document the duplication with a one-line comment
  pointing at the canonical definitions in `worldEngine/types.ts`, and keep them in sync by hand
  (this is the same category of tradeoff the spec's own "no parallel resolution points" constraint
  warns about, but a type re-declaration for a doc-authoring boundary is different from a
  computed-value divergence — it's acceptable here specifically because `world/` types must stay
  engine-independent).

- [ ] **Step 2: Add the types**

  ```ts
  // src/lib/world/types.ts, near WorldDoc (lines 360-381)
  export type ScenarioAction =
    | { type: 'inject-fault'; scope: FaultScope; id: string; spec: FaultSpec }
    | { type: 'clear-fault'; scope: FaultScope; id: string }
    | { type: 'partition'; fault: PartitionFault }
    | { type: 'heal-partition'; index: number }
    | { type: 'demand-multiplier'; factor: number; rampSec: number }
    | { type: 'set-population-rps'; populationId: string; peakRps: number; rampSec: number }

  export interface ScenarioStep {
    atMs: number
    action: ScenarioAction
    note?: string
  }

  export interface Scenario {
    id: string
    label: string
    seed: number
    durationMs: number
    steps: ScenarioStep[]
  }
  ```

  Add `scenario?: Scenario` to `WorldDoc`.

  Widen `DiurnalPattern` (line 38): `export type DiurnalPattern = 'flat' | 'day-night' | 'custom'`.

  Add to `ClientPopulation` (lines 49-64): `curve?: { atFraction: number; multiplier: number }[]`.

- [ ] **Step 3: Type-check**

  Run: `npx tsc --noEmit`
  Expected: clean (this is additive-optional; nothing consumes these fields yet, so nothing should
  break).

- [ ] **Step 4: Commit**

  ```bash
  git add src/lib/world/types.ts
  git commit -m "feat(world): add Scenario/ScenarioStep/ScenarioAction types, custom DiurnalPattern"
  ```

---

## Task 16: Serializer normalization

**Files:**
- Modify: `src/lib/serializer.ts`
- Test: `src/lib/serializer.test.ts`

**Interfaces:**
- Consumes: `Scenario` (Task 15).
- Produces: `scenario` normalized (defaulted to `undefined`) in `deserializeWorld`'s output, and
  included verbatim in `serializeWorld`'s output when present.

- [ ] **Step 1: Write failing tests**

  ```ts
  it('a world with a scenario round-trips through serialize/deserialize intact', () => {
    const doc = { ...baseDoc, scenario: { id: 's1', label: 'Test', seed: 42, durationMs: 60000, steps: [] } }
    const serialized = serializeWorld(doc, meta)
    const { world } = deserializeWorld(JSON.parse(serialized))
    expect(world.scenario).toEqual(doc.scenario)
  })

  it('a pre-feature v3 file with no scenario field still loads, scenario undefined', () => {
    const legacyV3 = { version: '3', meta: {...}, world: { routing: {}, populations: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {} } }
    const { world } = deserializeWorld(legacyV3)
    expect(world.scenario).toBeUndefined()
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "scenario"`
  Expected: FAIL (or trivially pass if `scenario` already round-trips via the `...src.world`
  spread — if so, this task only needs the explicit normalization line for clarity/consistency
  with the file's own convention, not new behavior; write the test either way to pin it down).

- [ ] **Step 3: Add explicit normalization**

  In the defaulting block (lines 148-157), add `scenario: src.world.scenario ?? undefined,`
  alongside the existing `racks`/`loadBalancers`/`packets`/`connectionLayout` lines — even though
  `?? undefined` is a no-op, it documents the field explicitly per this file's established pattern
  rather than relying on the implicit spread.

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run -t "scenario"`
  Expected: PASS.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/serializer.ts src/lib/serializer.test.ts
  git commit -m "feat(serializer): normalize optional Scenario field"
  ```

---

## Task 17: Scenario CRUD in `world.store.ts`

**Files:**
- Modify: `src/app/store/world.store.ts`
- Test: `world.store.test.ts`

**Interfaces:**
- Consumes: `Scenario`/`ScenarioStep` (Task 15), the store's internal `mutate()` helper (existing —
  confirm its exact name/signature by reading the file before use).
- Produces: `setScenario(scenario: Scenario | null)`, `addScenarioStep(step: ScenarioStep)`,
  `removeScenarioStep(index: number)`, `updateScenarioStep(index: number, step: ScenarioStep)` — all
  routed through `mutate()` so undo/redo and dirty-marking come for free. Task 20 (`ScenarioPanel`)
  calls these exact names.

- [ ] **Step 1: Write failing tests**

  ```ts
  it('setScenario replaces the doc scenario and marks dirty', () => {
    const store = useWorldStore.getState()
    store.setScenario({ id: 's1', label: 'Test', seed: 1, durationMs: 60000, steps: [] })
    expect(useWorldStore.getState().doc.scenario?.id).toBe('s1')
  })
  it('addScenarioStep appends a step, pushable to undo/redo history', () => {
    const store = useWorldStore.getState()
    store.setScenario({ id: 's1', label: 'Test', seed: 1, durationMs: 60000, steps: [] })
    store.addScenarioStep({ atMs: 30000, action: { type: 'clear-fault', scope: 'server', id: 's1' } })
    expect(useWorldStore.getState().doc.scenario?.steps).toHaveLength(1)
    store.undo()
    expect(useWorldStore.getState().doc.scenario?.steps).toHaveLength(0)
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "Scenario"`
  Expected: FAIL.

- [ ] **Step 3: Implement, routed through `mutate()`**

  Read the file's existing `mutate()` helper and a sibling CRUD action (e.g. how `placements` CRUD
  is implemented) to match its exact call shape, then:

  ```ts
  setScenario: (scenario) => set(mutate((doc) => ({ ...doc, scenario: scenario ?? undefined }))),
  addScenarioStep: (step) => set(mutate((doc) => ({
    ...doc,
    scenario: doc.scenario ? { ...doc.scenario, steps: [...doc.scenario.steps, step] } : doc.scenario,
  }))),
  removeScenarioStep: (index) => set(mutate((doc) => ({
    ...doc,
    scenario: doc.scenario ? { ...doc.scenario, steps: doc.scenario.steps.filter((_, i) => i !== index) } : doc.scenario,
  }))),
  updateScenarioStep: (index, step) => set(mutate((doc) => ({
    ...doc,
    scenario: doc.scenario ? { ...doc.scenario, steps: doc.scenario.steps.map((s, i) => (i === index ? step : s)) } : doc.scenario,
  }))),
  ```

  (Adjust to the file's ACTUAL `mutate()` signature — it may take a producer function differently
  than shown here; this is illustrative and must be corrected against the real helper before
  compiling.)

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run -t "Scenario"`
  Expected: PASS.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/app/store/world.store.ts src/app/store/world.store.test.ts
  git commit -m "feat(store): add scenario CRUD actions routed through mutate()"
  ```

---

## Task 18: Cursor-indexed step application + rng seeding in `index.ts`

**Files:**
- Modify: `src/lib/worldEngine/index.ts`
- Test: `index.test.ts`

**Interfaces:**
- Consumes: `WorldDoc.scenario` (Task 15), `state.faults` (`setFault`/`addPartition` pure
  functions from `faults.ts`), `Rng` (`rng.ts`).
- Produces: scenario steps applied exactly once each, at the correct `simMs`; `s.rng` seeded from
  `scenario.seed` when present. `scenario_step_applied` event kind.

- [ ] **Step 1: Write the failing determinism test — the feature's core claim**

  ```ts
  it('THE DETERMINISM TEST: same scenario + seed + doc produces deep-equal MetricsBatch sequences over 60s, run twice', () => {
    const doc = { ...baseDoc, scenario: { id: 's1', label: 'T', seed: 777, durationMs: 60000, steps: [
      { atMs: 10000, action: { type: 'inject-fault', scope: 'server', id: baseDoc.someServerId, spec: { kind: 'cpu-brownout', capacityFraction: 0.5 } } },
      { atMs: 30000, action: { type: 'clear-fault', scope: 'server', id: baseDoc.someServerId } },
    ] } }
    const runA = runFullScenario(doc)   // helper: start engine, step in 100ms increments to 60000ms, collect every MetricsBatch
    const runB = runFullScenario(doc)
    expect(runA).toEqual(runB)
  })

  it('inject-fault at atMs 30000 fires between step 299 and 300 at 100ms steps, exactly once', () => {
    // step to exactly 29900ms: no fault_injected event yet. step one more 100ms: exactly one
    // fault_injected event at simMs 30000. step further: no additional fault_injected for the
    // same step.
  })

  it('a world with no scenario is byte-identical to pre-feature for a fixed seed', () => {
    const a = run(baseDocWithoutScenario)
    const b = run(baseDocWithoutScenario)
    expect(a.latest()).toEqual(b.latest())
  })
  ```

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "DETERMINISM"`
  Expected: FAIL.

- [ ] **Step 3: Implement**

  In `start()`: if `doc.scenario` is present, sort `doc.scenario.steps` by `atMs` into a cursor-
  indexed array held on `state` (e.g. `state.scenarioSteps: ScenarioStep[]`, `state.scenarioCursor:
  number = 0`), and seed `s.rng` from `doc.scenario.seed` instead of whatever the engine's default
  seed source is (find that default seed source first — likely a constructor parameter or a fixed
  constant — and make scenario-seeding an override of it, not a second independent rng instance).

  At the top of `runStep`, before demand generation, advance the cursor and apply every due step:

  ```ts
  while (state.scenarioCursor < state.scenarioSteps.length && state.scenarioSteps[state.scenarioCursor].atMs <= simMs) {
    const step = state.scenarioSteps[state.scenarioCursor]
    applyScenarioAction(state, step.action, simMs)   // new small dispatcher function
    emitEvent({ kind: 'scenario_step_applied', severity: 'info', message: step.note ?? describeAction(step.action), affected: [], simMs })
    state.scenarioCursor += 1
  }
  ```

  `applyScenarioAction` dispatches on `action.type`:
  - `'inject-fault'` / `'clear-fault'` ⇒ call the same `setFaultPure`/facade path Task 3 built
    (do not duplicate the down/latency-add/etc. wiring — this must go through the identical code
    path a UI-driven `setFault` call uses).
  - `'partition'` / `'heal-partition'` ⇒ call `addPartition`/`removePartition` from `faults.ts`.
  - `'demand-multiplier'` / `'set-population-rps'` ⇒ write into the engine-owned demand overlay
    map Task 19 introduces (this task can stub these two cases as a TODO-free no-op ONLY if Task
    19 lands in the same PR before this task's tests are asserted as complete — since both tasks
    are in this same plan and execute in order, implement the overlay write here referencing
    Task 19's map, and have Task 19 focus purely on `demand.ts`'s consumption side).

- [ ] **Step 4: Run tests, verify pass**

  Run: `npx vitest run -t "DETERMINISM"`
  Expected: PASS — including two full 60s runs producing deep-equal batch sequences.

- [ ] **Step 5: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/index.ts src/lib/worldEngine/index.test.ts
  git commit -m "feat(engine): apply scenario steps at step boundary, seed rng from scenario.seed"
  ```

---

## Task 19: Demand overlay + piecewise-linear `curve` interpolation in `demand.ts`

**Files:**
- Modify: `src/lib/worldEngine/demand.ts`
- Modify: `src/lib/worldEngine/index.ts` (hold the demand-overlay map, populate it from
  `'demand-multiplier'`/`'set-population-rps'` scenario actions per Task 18)
- Test: `demand.test.ts`

**Interfaces:**
- Consumes: `state.demandOverlay: Map<PopulationId, { multiplier: number; targetMultiplier: number;
  rampStartMs: number; rampSec: number }>` (new engine-owned overlay).
- Produces: `populationDemandRps` reads the overlay as a multiplier on the diurnal mean BEFORE the
  Poisson draw; `curve` interpolation for `'custom'` diurnal pattern.

- [ ] **Step 1: Write failing tests**

  ```ts
  it('demand-multiplier at factor 4, rampSec 600 reaches ~4x mean demand at +10min, Poisson variance still present', () => {
    // run a population for 10 simulated minutes after applying the overlay directly (bypassing
    // full scenario machinery — test demand.ts in isolation); sample rps across many steps near
    // t=10min, assert mean ≈ 4x baseline AND variance/mean ratio stays consistent with Poisson
    // (i.e. it is NOT a smooth deterministic curve — sample stddev should be roughly sqrt(mean)).
  })

  it('a custom curve interpolates piecewise-linearly between authored points', () => {
    const pop = { ...basePop, diurnal: 'custom', curve: [{ atFraction: 0, multiplier: 0.2 }, { atFraction: 0.5, multiplier: 1.0 }, { atFraction: 1, multiplier: 0.2 }] }
    expect(diurnalMultiplierFor(pop, 0)).toBeCloseTo(0.2)
    expect(diurnalMultiplierFor(pop, DAY_MS / 2)).toBeCloseTo(1.0)
    expect(diurnalMultiplierFor(pop, DAY_MS / 4)).toBeCloseTo(0.6)   // midpoint of the first segment
  })

  it('flat and day-night diurnal patterns are unchanged to the digit', () => {
    // pin exact pre-feature output values for both existing patterns at a few sample times.
  })
  ```

  (`diurnalMultiplierFor` is a name inferred for wherever the existing flat/day-night logic
  currently lives inside `populationDemandRps` — read the real function/inline-expression first
  and either extract it to a named helper with this shape, or adjust the test to call whatever the
  real extraction point ends up being.)

- [ ] **Step 2: Run to confirm failure**

  Run: `npx vitest run -t "curve"`
  Expected: FAIL.

- [ ] **Step 3: Implement the overlay consumption**

  In `populationDemandRps` (lines 59-91), before the Poisson draw at line 89, multiply the diurnal
  mean by the overlay's current ramped multiplier (1 when no overlay entry exists for this
  population):

  ```ts
  const overlay = demandOverlay?.get(population.id)
  const overlayMultiplier = overlay
    ? overlay.multiplier + (overlay.targetMultiplier - overlay.multiplier) * clamp01((simMs - overlay.rampStartMs) / (overlay.rampSec * 1000))
    : 1
  const mean = diurnalMean * overlayMultiplier
  const draw = samplePoisson(mean, rng)
  ```

  Thread `demandOverlay` as a new parameter into `populationDemandRps`'s call site in `index.ts`,
  sourced from `state.demandOverlay` (new `Map`, populated in Task 18's `applyScenarioAction` for
  the two demand-shaping action types, held alongside `state.faults` at `start()`).

- [ ] **Step 4: Implement `curve` interpolation**

  Extract or add a `diurnalMultiplierFor(population, simMs)` helper: for `'flat'`/`'day-night'`,
  preserve the exact existing branches unchanged; for `'custom'`, take `population.curve`, compute
  `atFraction = (simMs % DAY_MS) / DAY_MS`, find the bracketing two curve points, and linearly
  interpolate `multiplier` between them (clamp to the first/last point's value outside the
  authored range).

- [ ] **Step 5: Run tests, verify pass**

  Run: `npx vitest run -t "curve"`
  Expected: PASS, including the variance-preserved assertion (this is the test that catches "the
  ramp scales the mean, not replace the distribution" — a common shortcut bug where an
  implementer replaces the Poisson draw with a deterministic value instead of scaling its mean).

- [ ] **Step 6: Full suite + type-check, commit**

  Run: `npx tsc --noEmit && npx vitest run`
  ```bash
  git add src/lib/worldEngine/demand.ts src/lib/worldEngine/index.ts
  git commit -m "feat(engine): demand overlay multiplier + custom piecewise diurnal curve"
  ```

- [ ] **Step 7: Run the perf bench**

  Run: `npm run bench`
  Expected: effectively 0 ms/step delta (one integer comparison per step against the cursor, per
  the spec).

---

## Task 20: `ScenarioPanel.tsx` + tab registration + `SimControls` integration

**Files:**
- Modify: `src/app/store/ui.store.ts` (`PanelTab` union, line 33)
- Modify: `src/app/world/dock/scope.ts` (`WORLD_TABS`, line 62)
- Modify: `src/app/world/panels/WorldPanel.tsx` (`TAB_LABELS`, lines 67-71; the tab-body render
  switch, ~line 290+) — **hub file, edit sequentially, coordinate if other Wave-1 UI tasks are
  running in parallel**
- Create: `src/app/world/panels/ScenarioPanel.tsx`
- Modify: `src/app/world/SimControls.tsx`
- Test: `ScenarioPanel.test.tsx`, `SimControls.test.tsx` (extend existing)

**Interfaces:**
- Consumes: `world.store.ts`'s scenario CRUD (Task 17), a new `simulation.store.ts` scenario-run
  action (`runScenario(): void` / `stopScenario(): void` plus a `scenarioProgressMs` selector —
  add these to the store as part of this task, delegating to the engine facade's normal
  `start`/`stop`/`step` machinery rather than inventing a parallel run loop; "running a scenario"
  is simply running the engine with `doc.scenario` present, so this is mostly UI wiring plus a
  progress readout derived from `latestBatch.simMs` against `doc.scenario.durationMs`).

- [ ] **Step 1: Register the tab**

  In `ui.store.ts` line 33, widen `PanelTab` to include `'scenario'`. In `scope.ts` line 62, add
  `'scenario'` to `WORLD_TABS`. In `WorldPanel.tsx`'s `TAB_LABELS` (lines 67-71), add `scenario:
  'Scenario'`. Find the tab-body conditional render (grep `tab === 'events'` in `WorldPanel.tsx`)
  and add a `tab === 'scenario'` branch rendering `<ScenarioPanel />`.

- [ ] **Step 2: Build `ScenarioPanel.tsx`**

  A horizontal time ruler (0 to `scenario.durationMs`, with draggable step markers positioned by
  `atMs / durationMs`), a step list below it (each row: `atMs`, a human-readable description of
  `action`, a note field, edit/delete controls), and an "Add step" form. All authoring controls
  disabled while running (`stop the simulation to edit` tooltip) — this is the NORMAL edit-lock
  direction, not the inverse chaos-control one, since authoring a scenario is configuration, not a
  live chaos action.

  When no `doc.scenario` exists yet, show a simple "Create scenario" button that calls
  `setScenario({ id: crypto.randomUUID(), label: 'New scenario', seed: <some default>, durationMs:
  300000, steps: [] })`.

  Style with `var(--color-*)` tokens only, verified in both themes, `prefers-reduced-motion`
  respected for the ruler's progress indicator (a static position update on the 1 Hz batch, not a
  smooth 60 Hz animation).

- [ ] **Step 3: Add scenario-run state + actions to `simulation.store.ts`**

  ```ts
  scenarioRunning: false,
  runScenario: () => {
    get().start()   // reuses the existing start() action — running a scenario IS running the engine
    set({ scenarioRunning: true })
  },
  stopScenario: () => {
    get().stop()
    set({ scenarioRunning: false })
  },
  ```

  (Adjust to the store's actual existing `start`/`stop` action names/signatures — confirm before
  writing.)

- [ ] **Step 4: Add the scenario selector + run/progress control to `SimControls.tsx`**

  Add a `<select>` for choosing among `doc.scenario` (single active scenario per doc per this
  spec's model — no multi-select needed) — actually, re-reading the spec: there is exactly one
  `scenario?: Scenario` per doc, not a library of scenarios to choose from within a single world.
  So `SimControls` needs only a "Run scenario" toggle/button (visible when `doc.scenario` exists)
  plus a progress readout (`latestBatch.simMs / doc.scenario.durationMs`, rendered as a filled bar
  on the same ruler component `ScenarioPanel` uses, or a simple percentage chip — reuse
  `ScenarioPanel`'s ruler as a shared component if that's cleaner than duplicating the progress
  visualization).

- [ ] **Step 5: Component tests**

  ```tsx
  it('ScenarioPanel shows Create scenario when doc.scenario is undefined', () => { /* ... */ })
  it('adding a step calls addScenarioStep with the authored action', () => { /* ... */ })
  it('authoring controls are disabled while running, with stop-to-edit tooltip', () => { /* ... */ })
  it('SimControls shows a run-scenario control only when doc.scenario exists', () => { /* ... */ })
  ```

  Run: `npx vitest run -t "Scenario"`
  Expected: PASS.

- [ ] **Step 6: Add 2-3 built-in example scenarios to `exampleWorlds.ts`**

  Following the file's existing `VaultEntry`/`build(): WorldDoc` pattern (confirmed structure: an
  `id`/`name`/`blurb`/`tags`/`difficulty`/`build` object, pure, no engine/store imports), either
  extend one or two of the existing four entries (`three-tier`, `multi-region-failover`,
  `event-driven`, `broken-teaching`) with an authored `scenario` field on their built `WorldDoc`,
  or add new entries specifically for this — the spec names "regional failure," "Black Friday
  ramp," and "creeping memory leak" as the three examples. Prefer attaching a scenario to
  `multi-region-failover` (regional failure) and adding scenario fields to one or two others
  rather than growing the vault's entry count, unless the existing four don't fit the Black
  Friday/memory-leak shapes at all — use judgment matching the file's existing scope.

  Each scenario's `steps` should be small and legible (3-6 steps), demonstrating the
  `inject-fault`/`clear-fault`/`demand-multiplier` action types built in this feature.

- [ ] **Step 7: Live smoke — the scenario's determinism, shown live**

  Run `npm run tauri dev`. Load the "regional failure" example, open the Scenario panel, run it,
  watch the timeline advance while the region drops and traffic fails over. Stop and run it again;
  confirm the same events land at the same timestamps (spot-check the Events tab's timestamps
  across the two runs). Verify in both themes. Zero new console errors.

- [ ] **Step 8: Full suite + type-check + build, commit**

  Run: `npx tsc --noEmit && npx vitest run && npm run build`
  ```bash
  git add src/app/store/ui.store.ts src/app/world/dock/scope.ts src/app/world/panels/WorldPanel.tsx src/app/world/panels/ScenarioPanel.tsx src/app/world/panels/ScenarioPanel.test.tsx src/app/world/SimControls.tsx src/app/store/simulation.store.ts src/lib/vault/exampleWorlds.ts
  git commit -m "feat(ui): add ScenarioPanel, scenario tab, run control, built-in examples"
  ```

This completes FEAT-003 and Wave 1.

---

## Task 21: Wave-1 close-out — full regression sweep, docs, bench

**Files:**
- Modify: `docs/module-boundaries.md` (replace Task 0's placeholder rows with the real, final
  ownership entries for every file touched across Tasks 1-20)
- No code changes beyond docs and any fixes surfaced by this sweep

- [ ] **Step 1: Full type-check**

  Run: `npx tsc --noEmit`
  Expected: clean.

- [ ] **Step 2: Full test suite**

  Run: `npx vitest run`
  Expected: all green, including every pre-existing test (the byte-identical regression floor for
  FEAT-001/002/003 all absent) and every new test from Tasks 1-20.

- [ ] **Step 3: Full production build**

  Run: `npm run build`
  Expected: clean build, no new TypeScript or bundler warnings.

- [ ] **Step 4: Perf bench, in isolation**

  Run: `npm run bench`
  Expected: no measurable regression at zero faults/partitions/scenario; per-feature deltas within
  budget when active (FEAT-001 < 0.05 ms/step, FEAT-002 < 0.1 ms/step, FEAT-003 effectively 0
  ms/step).

- [ ] **Step 5: Live smoke, end to end, both themes**

  Run `npm run tauri dev`. Exercise, in one session: a `ChaosControl` fault on a server (Task 8), a
  partitioned pair of regions producing split-brain (Task 14), and a full scenario run (Task 20) —
  toggle the theme mid-session and confirm every new surface (chaos menu, partitions form,
  scenario panel, severed arcs) reads correctly in both. Confirm zero console errors throughout.

- [ ] **Step 6: Update `docs/module-boundaries.md` with final ownership rows**

  Replace Task 0's placeholder with real entries: `src/lib/worldEngine/faults.ts` (fault +
  partition state, pure, no engine imports), and one-line notes on every hub file that received
  Wave-1 edits (`world/types.ts`, `worldEngine/types.ts`, `simulation.store.ts`, `world.store.ts`,
  `WorldPanel.tsx`) describing what Wave 1 added, following the file's existing dated-entry
  convention (add a new `## Fault & Scenario Substrate — Wave 1` section near the other dated
  entries, not a rewrite of the narrative sections).

- [ ] **Step 7: Commit**

  ```bash
  git add docs/module-boundaries.md
  git commit -m "docs: update module-boundaries.md for Wave 1 (fault/partition/scenario substrate)"
  ```
