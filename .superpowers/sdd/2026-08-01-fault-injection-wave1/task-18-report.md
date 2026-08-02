# Task 18 report — Cursor-indexed step application + rng seeding in `index.ts`

Branch: `worktree-fault-injection-wave1`. Base commit: `c830b18f39786f7001ba88a7fcfcc9ddedd0e3ed`.

## Summary

Implemented FEAT-003's first engine-integration slice in `src/lib/worldEngine/index.ts`:

1. **Cursor-indexed scenario step application.** `EngineState` gained `scenarioSteps:
   ScenarioStep[]` (sorted once by `atMs` in `start()`) and `scenarioCursor: number` (0 at
   start). A new block at the top of `runStep`, before demand generation, advances the cursor
   in a `while` loop and applies every step whose `atMs <= simMs`, via a new `applyScenarioAction`
   dispatcher, then emits a new `scenario_step_applied` event (`step.note ?? describeScenarioAction
   (step.action)`). `<=` plus a monotonic cursor guarantees exactly-once application even when
   multiple steps share a boundary or land inside one 100ms step.

2. **`applyScenarioAction` reuses existing code paths verbatim** — no duplicated fault/partition
   logic:
   - `inject-fault`/`clear-fault` → `api.setFault(scope, id, spec | null)` (the same facade a
     UI-driven `setFault` call uses — `down` faults still route through `failoverSetOutage` +
     `applyAzOutageToManaged` exactly as before).
   - `partition`/`heal-partition` → `api.setPartition(fault)` / `api.healPartition(index)` (Task
     12's thin wrappers over `faults.ts`'s `addPartition`/`removePartition`).
   - `demand-multiplier`/`set-population-rps` → write into a new `EngineState.demandOverlay: Map
     <PopulationId, { multiplier; targetMultiplier; rampStartMs; rampSec }>` (see below). This
     task only writes it; Task 19 makes `demand.ts`'s `populationDemandRps` read it.

3. **rng seeding.** `doc.scenario?.seed`, when present, now REPLACES `createWorldEngine`'s
   constructor-seed default (`effectiveSeed = doc.scenario?.seed ?? seed`), used for BOTH
   `state.rng` and the tracer's independent rng (`createTracer(createRng(effectiveSeed ^
   0x1234))`) — one seeded source, not two. Verified with a test constructing two engines with
   different default seeds (`1` and `999`) but the same `scenario.seed` (`777`), asserting
   byte-identical `MetricsBatch` output.

4. **New `EngineEventKind` member** `scenario_step_applied`, added additively to
   `worldEngine/types.ts`. This required a matching case in `src/lib/aiChat/eventCausality.ts`'s
   exhaustive `decodeAffected` switch (`{ primaryId: affected[0] ?? '', secondaryId: affected[1]
   || null }` — `affected` is always `[]` for this event today, matching the brief).

## Demand overlay conversion choices (not fully pinned down by the brief — flagging per the ask)

- **`demand-multiplier`** applies to every population currently in `doc.populations` — read via
  `Object.keys(s.doc.populations)`. Each entry's `multiplier` (ramp start value) is seeded from
  `effectiveOverlayMultiplier(existingEntry, simMs)` if an overlay entry already exists for that
  population, else `1` (baseline). `targetMultiplier = action.factor`, `rampStartMs = simMs`,
  `rampSec = action.rampSec`.
- **`set-population-rps`** targets one population. `basePeakRps = doc.populations[id]?.peakRps ??
  0`; `targetMultiplier = basePeakRps === 0 ? 0 : action.peakRps / basePeakRps`. I chose `0` over
  skipping the write for the zero-baseline case: every overlay entry then has a uniform shape
  (always has a `targetMultiplier`), and "target a population with no authored baseline" reads as
  "stays at zero" rather than a silent no-op that leaves a possibly-stale prior overlay entry
  behind. Same "seed from current effective value" rule as `demand-multiplier`.
- **`effectiveOverlayMultiplier(entry, simMs)`** is a small local linear-ramp helper (`entry.
  rampSec <= 0` ⇒ jump straight to target; else linear interpolate over `rampSec` seconds from
  `rampStartMs`). It exists ONLY so a second demand-shaping action fired mid-ramp continues
  smoothly from wherever the ramp currently is, rather than resetting to 1. Task 19's `demand.ts`
  consumption side will need to compute the same "current effective value" shape when it reads
  `demandOverlay` per step — I did NOT export/share this helper across files since Task 19 wasn't
  in scope here and its brief may want the ramp math to live in `demand.ts` itself (a pure module,
  matching its existing "demand.ts stays a pure function" discipline) rather than importing an
  engine-internal helper from `index.ts`. If Task 19 wants byte-identical ramp semantics, it
  should mirror this exact linear-interpolation shape (or the two of us should hoist it to a
  shared module) — flagging so that decision is made deliberately, not by accident.

## Tests added (`src/lib/worldEngine/index.test.ts`, new `describe('FEAT-003 scenario timeline
(Task 18)')` block, 7 tests)

1. **THE DETERMINISM TEST** (brief's core claim) — same scenario (seed 777, an inject-fault at
   10s + clear-fault at 30s) run twice over a full 600-step (60s) drive, `toEqual` on the entire
   `MetricsBatch[]` sequence.
2. inject-fault at `atMs: 30000` fires between step 299 and 300 at 100ms steps, exactly once (no
   `fault_injected` at 29,900ms; exactly one at 30,000ms; still exactly one after 10 more steps).
3. A world with no `scenario` is byte-identical to pre-feature for a fixed seed (`.latest()`
   equality across two runs).
4. `doc.scenario.seed` overrides the constructor seed rather than adding a second rng source (two
   engines, different constructor seeds, same `scenario.seed` → identical output).
5. `scenario_step_applied` fires exactly once per step, alongside the action's own domain event
   (2 steps → 2 `scenario_step_applied`, 1 `fault_injected`, 1 `fault_cleared`).
6. `partition`/`heal-partition` scenario actions produce `partition_started`/`partition_healed`
   through the reused facade path.
7. `demand-multiplier`/`set-population-rps` actions apply without throwing and each emit exactly
   one `scenario_step_applied` event (Task 19 will add the demand-side assertions once `demand.ts`
   actually reads the overlay).

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **1800 passed, 0 failed** (147 test files), including the new 7 tests and
  every pre-existing `worldEngine`/`aiChat` suite (confirming the new `EngineEventKind` member and
  the `eventCausality.ts` exhaustive-switch fix didn't regress anything).

## Files touched

- `src/lib/worldEngine/index.ts` — the implementation (imports, `EngineState` fields, `start()`,
  `runStep`'s cursor loop, `applyScenarioAction`/`effectiveOverlayMultiplier`/
  `describeScenarioAction`/`linkLabel` helpers).
- `src/lib/worldEngine/index.test.ts` — new test block.
- `src/lib/worldEngine/types.ts` — new `scenario_step_applied` `EngineEventKind` member (additive).
- `src/lib/aiChat/eventCausality.ts` — new `decodeAffected` case for the new event kind (required
  by the exhaustive switch, not optional).
- `.superpowers/sdd/contract-drift.md` — new entry.
- `docs/module-boundaries.md` — extended the existing `worldEngine/index.ts` Wave-1 row with a
  Task 18 sub-entry.
