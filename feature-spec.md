# Visual Infrastructure Simulator: Feature Expansion Spec

**Assessed:** Scalemap as of `main` @ `b307eff` (2026-07-31), across three vectors — simulation
fidelity & real-world physics, advanced configurability & blueprinting, and UX / visual inspector /
operational clarity.

**Date:** 2026-07-31 · **Features:** 15, in 7 dependency-ordered waves

**How to use this document.** Work the waves in order. Within a wave, features are independent
unless a `Depends on` line says otherwise. Every feature carries numbered Execution Steps that name
their files and concrete changes, and Acceptance Criteria that must be demonstrable in the running
app, not just in a test. Do not start a wave before its predecessors are green. This is a *feature*
spec, not a bug audit — it is the successor body of work to `audit-spec.md`, whose 19 issues are
substantially landed on `main`.

---

## Executive Overview

- **Core Focus Areas:** Turn a high-fidelity *steady-state* simulator into a **chaos engineering and
  FinOps instrument**. Three strategic moves: (1) replace the single binary kill switch with a real
  fault-injection substrate plus a reproducible scenario timeline, so failure becomes something you
  *design and re-run* rather than something you click; (2) close the remaining stateful-physics gaps
  — cache hit ratios, replication lag/RPO, disk IOPS, cold start, autoscaling — that currently make
  recovery look instant and free; (3) surface the 300 metric frames the engine already retains as
  time-series, cost-velocity, and A/B comparison surfaces, so a user can answer "what did that
  outage cost me, and was version B actually better?"
- **Total Feature Specifications:** 15
- **Target Areas:** Fidelity (6) | Configurability (5) | Usability (4)

---

## Reader Orientation — capabilities that already ship

This codebase is materially more mature than a first-pass reading suggests. The following are
**already implemented and verified in source**. Proposing any of them is rework, and a spec that
does so will send an implementing agent to rebuild working machinery:

| Commonly assumed missing | Reality |
|---|---|
| Static constant RPS | `demand.ts` runs diurnal curves × seeded **Poisson** arrivals (`samplePoisson`, `demand.ts:40`) × MMPP-flavored flash-crowd bursts, with a per-population `burstiness` knob |
| No connection-pool exhaustion | `hostScheduler.poolCheckoutFor` (`hostScheduler.ts:39`, M/M/c/K-shaped) plus `managedDbRuntime`'s `connectionRefusedRps` both ship |
| No timeouts / circuit breakers | Per-dependency breakers (`breakers.ts`) + analytic log-normal `timeoutErrorFraction` (`latency.ts`), applied at `flows.ts:791` |
| No TLS handshake cost | `connectionModel.ts` charges a 15 ms handshake + 2 ms/req CPU on `short-lived` connections |
| No cross-AZ latency penalty | `networkRuntime.baseHopLatencyMs` (`:26`) prices localhost / same-az / cross-az / cross-region / internet |
| No async messaging | `broker.ts` models topics: backlog, consumer lag, retention drop, redelivery, DLQ |
| No replay | `replay.ts:18` `createReplayBuffer(cap = 300)` — a 300-frame (5 min @ 1 Hz) ring of complete `MetricsBatch` snapshots |
| No composed latency | `p50Ms`/`p99Ms` are end-to-end composed (audit ISSUE-003); `serviceP50Ms` preserves the self-only reading |
| No queueing model | `flows.ts` serves `min(capacity, arrivals + backlog)` against a persistent per-instance queue |

**Two structural facts every feature below is designed around:**

1. **`doc` and `compiled` are frozen at `start()`.** Roughly ten prebuilt lookup indexes depend on
   it — `index.ts:322` and `:326` both carry the comment "the doc is frozen for the run, so these
   can never go stale." Topology is edit-locked while running (`world.store.ts`, plus every modal
   gating on `running`). **No feature here may mutate the doc or re-compile mid-run.** FEAT-008 is
   the one that most wants to, and its entire design is an answer to this constraint.
2. **The divergence class is this repo's most common defect shape** — a derived quantity computed
   once for *enforcement* and once for *display*, which then drift. `audit-spec.md` found six
   instances. Every feature that touches load, RAM, or connections must extend the existing single
   resolution point rather than adding a parallel one.

---

## Cross-Cutting Constraints — apply to every feature

Stated once here rather than repeated fifteen times. Binding on all of FEAT-001…015. Sources:
`docs/agent-onboarding.md` §3 (hard laws) and `CLAUDE.md` (Key Architecture Decisions).

1. **Compiled-world gate.** Nothing downstream reads the raw `WorldDoc` for anything derived —
   views, the engine, and the analysis rules all read `compileWorld(doc)`'s output. Extend
   `CompiledWorld` (`world/types.ts:462`: `instances`/`paths`/`routing`/`findings`) **additively**.
2. **Engine seam.** `simulation.store.ts` is the ONLY file permitted to call the engine facade.
   Views read the store. A new engine method means a new store action, never a direct view call.
3. **Regression floor.** Every new doc field is optional; absent ⇒ today's exact behavior,
   **byte-identical**. This repo asserts its regression floor with `toBe`, not `toBeCloseTo` — hold
   that standard. **FEAT-008 is the single sanctioned exception** (it changes `compiled.instances`
   cardinality) and carries its own explicit re-baseline procedure.
4. **Contract drift.** `src/lib/worldEngine/types.ts` is a frozen contract. The user has authorized
   *breaking* changes to it where the current shape is genuinely limiting — but default to additive
   where additive suffices, and log **every** change in `.superpowers/sdd/contract-drift.md`.
   FEAT-001 (`setFault` replacing `setOutage`) is the only intentional signature break; everything
   else is additive.
5. **The two-call-site invariant.** Little's law is computed in exactly two places —
   `hostScheduler`'s `InstanceLoad.activeConnections` (drives RAM growth and OOM victim selection)
   and `metrics.ts`'s published `InstanceMetrics.activeConnections` (drives every view and the
   `ram-oversubscribed` rule). Both MUST call `connectionModel`'s `activeConnections()`.
   **FEAT-004, FEAT-007, and FEAT-008 all change instance load** and must keep `index.test.ts`'s
   `DIVERGENCE GUARD` test green. Any new enforced-vs-displayed quantity gets its own parallel guard.
6. **Do not add a parallel resolution point.** `connectionModel.ts` is the one connection-semantics
   point; `packetResolve.ts` is the one mix→wire-bytes point; `poolCheckoutFor` and
   `managedDbRuntimeFor` already share the `base / (1 - saturation)` queueing curve
   (`hostScheduler.ts:32-33` says so explicitly). Extend these; never re-derive alongside them.
7. **Perf envelope.** The engine runs ~2 ms/step at ~2,000 instances against a 4 ms budget;
   `DEGRADE_THRESHOLD_MS = 4` (`index.ts:65`) halves the tick rate past it and emits
   `engine_degraded`. Every feature below states its per-step cost. Run
   `bench/enginePerf.bench.test.ts` after every wave — this is a hard gate, not a guideline.
8. **60 FPS render budget.** Caps are engine-enforced: `MAX_AZ_PARTICLES = 400`,
   `MAX_SERVER_PARTICLES = 50` (`index.ts:58,62`), `MAX_GLOBE_ARCS = 200` (`worldEngine/types.ts`).
   New visuals compute on the **1 Hz metrics batch**, never per animation frame. The render loop and
   the simulation loop are distinct — a cost in `renderAll` is a 60 Hz cost, a cost in `runStep` is
   a 10 Hz cost, and conflating them misprioritises by 6×.
9. **Determinism.** All randomness flows through the seeded `rng` (`rng.ts`). `Math.random()` is
   forbidden inside `worldEngine`. Replay determinism is sacred: no new rng draws in the render path.
   A feature that adds rng draws to the step path shifts the stream for everything after it and
   requires a deliberate re-baseline.
10. **Theme law.** Every color in new UI is `var(--color-*)` from `src/lib/theme.ts`. No hardcoded
    hexes. Both themes are user-reachable (⚙ Settings → Appearance) — verify new UI in dark **and**
    light.
11. **Price law.** Every money value app-wide renders in `var(--color-price)`. No exceptions. This
    binds FEAT-010 and FEAT-011 especially.
12. **No emojis. Ever.** Plain-text glyphs are fine and already in use: `▸ ✕ ⇄ ⌬ ⏎ ↺ ⊘ ⌖ − ● ◷ ¤ →`.
    If unsure whether a character is a glyph or an emoji, use a word.
13. **Motion budget.** Animation encodes DATA, never decoration. Flow dashes march only when rate
    > 0; region/floor animate only the top `TOP_ANIMATED = 5` flows; at most `MAX_ANIMATED_LEDS = 3`
    blink. `prefers-reduced-motion` ⇒ fully static, zero infinite animations (smoke-tested). Any
    looping `stroke-dashoffset` must travel an integer multiple of its dash period per loop.
14. **Edit-lock law.** While the simulation runs, authoring controls are disabled; destructive
    "chaos" actions are the inverse — enabled ONLY while running. Tooltip copy is standardized:
    `stop the simulation to edit` / `start the simulation to break things`. **FEAT-001, 002, and 003
    all add chaos controls and must follow the inverse-lock side of this law.**
15. **Serializer is additive.** `.scalemap` is at v3 (`serializer.ts:38`); v1 and v2 are rejected at
    the version gate with dedicated messages. New doc fields must be optional-on-load and normalized
    in `deserializeWorld`'s defaulting block (`serializer.ts:153-156` is the existing pattern).
    **Never write derived/ephemeral state into the file** — this is what forbids FEAT-011's baselines
    from living in `.scalemap`.
16. **Analysis rules go only in `ANALYSIS_RULES`** (`src/lib/analysis/runAnalysis.ts`), spread from
    the `structural`/`network`/`capacity` rule files. Rules never duplicate `compiled.findings`.
17. **Done bar, per feature:** `npx tsc --noEmit` clean → `npx vitest run` green → `npm run build`
    green → **live smoke in the running app** (`npm run tauri dev`) with zero new console errors.
18. **Docs.** Update `docs/module-boundaries.md` after each wave (standing repo instruction in
    `CLAUDE.md`), adding/adjusting the row for files changed rather than appending narrative.

**High-conflict hub files** (`agent-onboarding.md` §8) — coordinate, edit sequentially, never in
parallel: `src/app/world/panels/WorldPanel.tsx`, `src/app/store/world.store.ts`,
`src/lib/world/types.ts`, `src/lib/worldEngine/types.ts`, `src/app/world/WorldShell.tsx`,
`src/lib/theme.ts`, `src/lib/serializer.ts`. Everything under a single view directory (`az/`,
`server/`, `region/`, `globe/`, `dock/`) is safe to own independently.

---

## Execution Order

| Wave | Features | Rationale |
|---|---|---|
| **1** | 001, 002, 003 | **Fault & scenario substrate.** Everything else builds on this, and the three are strictly ordered: 001 defines `FaultSpec`, 002 defines `PartitionFault`, and 003's `ScenarioAction` union references both. 003 is also the precondition for FEAT-011's benchmarking — without a deterministic scenario, an A/B comparison is noise. |
| **2** | 004, 005, 006 | **Stateful fidelity.** Independent of each other; all three depend only on Wave 1 for their fault-driven demos. 006 additionally contributes the `disk-stall` variant back to 001's fault union. **004 is the highest teaching-value-per-line feature in the set.** |
| **3** | 007, 008 | **Elasticity.** 008 depends on 007 — scale-out that helps instantly is a lie, and cold start is what makes the autoscaler's cooldown meaningful. Both depend on Wave 1. 008 is the largest single change in this spec and the only sanctioned regression-floor break. |
| **4** | 009, 010 | **Observability.** 009 depends on nothing and could land at any point — it is sequenced here so it can chart the state Waves 1–3 introduce. 010 depends on 009's time-series scaffolding and on 008 (a fleet that never moves makes cost velocity a flat line). |
| **5** | 011, 012, 013 | **Comparison, environments, ergonomics.** 011 depends on 003 (determinism) and 010 (cost aggregates). 012 and 013 are independent of everything and can be parallelised against each other. |
| **6** | 014 | **Network topology.** VPC/subnet/route-table/NAT/security-group addressing, replacing today's flat per-server firewall list. Depends only on FEAT-002 (extends its `LinkEndpoint` vocabulary additively). Sequenced after Waves 1–5 because it is the largest single schema addition since FEAT-008 and benefits from landing on a settled fault/scenario substrate, not because anything in Waves 2–5 is a prerequisite. |
| **7** | 015 | **DNS & traffic management.** Depends on 014 — a DNS failover record only becomes an interesting lesson once a target can be topologically unreachable (no NAT route, wrong security group), not merely health-check-marked-down. Also depends on 001 (`dns-resolution-failure` fault kind) and 003 (canary-weight-shift scenario steps). |

No feature depends on a feature in a later wave. Verified by walking the list: 002→001, 003→001,
004/005/006→Wave 1, 007→Wave 1, 008→007, 009→∅, 010→009, 011→003+010, 012→∅, 013→∅, 014→002,
015→001+003+014.

---

## Housekeeping (do this first — five minutes, prevents a wasted session)

**1. Delete `sampleInterRegionLatencyMs` (`src/lib/regionConfig.ts:61`).** It calls `Math.random()`,
which is forbidden inside `worldEngine` (Cross-Cutting Constraint 9), and it has **zero production
callers** — the only reference outside its own tests is a comment at
`src/lib/worldEngine/networkRuntime.ts:55` explaining that the engine deliberately avoids it. Left
in place, it is a loaded gun: the next agent looking for "the jittered latency function" will find
it and wire it into the step path, silently breaking replay determinism.

Deleting it is **not free** — it also requires removing three cases from
`src/lib/regionConfig.test.ts` (lines ~9, ~14, ~23: the "varies across repeated calls", "centered
near the deterministic base value", and same-region-zero tests) and rewriting the
`networkRuntime.ts:55` comment to stop naming a symbol that no longer exists. Do all three in one
commit. `interRegionLatencyMs` itself stays — it is pure, deterministic, and genuinely used.

**2. Fix the stale serializer version in `docs/agent-onboarding.md` §3, law 12.** It reads
"`.scalemap` v2 only" while `serializer.ts:38` writes `version: '3'` and both v1 and v2 are rejected
at the version gate (`serializer.ts:53-63`). An agent trusting the onboarding doc will author a v2
migration path that the serializer will refuse. One-line fix.

**3. Add a `docs/module-boundaries.md` placeholder row per new module** listed in the wave you are
about to start, so parallel workers can see ownership before the files exist.

---

## Feature Specifications

### [FEAT-001]: Fault Injection Primitives

- **Category:** Simulation Fidelity
- **Target Impact:** High
- **Affected System Areas:** Engine facade (`worldEngine/index.ts`, `worldEngine/types.ts`), new
  `worldEngine/faults.ts`, host scheduler, flow solver, failover state, `simulation.store.ts`, chaos
  controls across `region/AzRow.tsx` · `dock/ServerFaceplate.tsx` · `dock/AzConfigTab.tsx` ·
  `RegionView.tsx` · `az/DatacenterFloor.tsx` · `ui/overlays/RegionOverlay.tsx`
- **Problem / Gap:** The entire chaos surface of this simulator is one boolean.
  `WorldEngineApi.setOutage(scope, id, down)` (`worldEngine/types.ts:275`) is the only failure switch
  the engine exposes, and it models exactly one failure: instantaneous, total, clean death. Every
  chaos control in the UI — six call sites, all verified — dispatches that same boolean through
  `simulation.store.ts:278`.

  Real infrastructure almost never fails that way. It fails *partially and ambiguously*: a host with
  a noisy neighbour that halves its usable CPU; a service that leaks 40 MB/minute and dies in twenty
  minutes; a NIC or hypervisor that adds 200 ms to everything without dropping a packet; a
  dependency returning 5xx on 10% of calls. These are the failures that are actually hard to
  diagnose, and they are precisely the ones a simulator should teach. A hard kill is the *easy* case
  — the health check catches it in one interval and failover does the rest.

  The gap is not that the engine lacks the machinery to model these. It is that the machinery exists
  and nothing can reach it: `effectiveVcpu` reduction, `ramBaseMb` growth with OOM victim selection,
  per-server additive latency, and per-dependency error fractions are all live code paths driven
  today only by *organic* load. This feature gives the operator a handle on each.
- **Proposed Technical Design & Models:**

  A discriminated union replaces the boolean. Five kinds ship in this feature; FEAT-006 adds a sixth
  (`disk-stall`) additively once an IOPS ceiling exists to stall against.

  ```ts
  // src/lib/worldEngine/types.ts — replaces the boolean in setOutage
  export type FaultKind = 'down' | 'latency-add' | 'cpu-brownout' | 'memory-leak' | 'error-inject'

  export type FaultSpec =
    | { kind: 'down' }                                        // today's behavior, exactly
    | { kind: 'latency-add'; ms: number }                      // additive per-server service latency
    | { kind: 'cpu-brownout'; capacityFraction: number }        // 0..1 of effectiveVcpu retained
    | { kind: 'memory-leak'; mbPerMinute: number }              // grows ramBaseMb until OOM
    | { kind: 'error-inject'; errorFraction: number }           // 0..1 of admitted rps → errors

  export type FaultScope = 'server' | 'az' | 'region' | 'managed'
  ```

  **Engine state** — an overlay, never a doc mutation. This follows the precedent set by
  `failover.ts`'s `promotedAt` (`failover.ts:53`, resolved through `effectiveRoleResolver` at
  `failover.ts:303`): engine-owned mutable state layered over a frozen `compiled`.

  ```ts
  // src/lib/worldEngine/faults.ts (new)
  export interface FaultState {
    active: Map<string, FaultSpec>        // keyed by failover.ts's existing outageKey(scope, id)
    leakAccumMb: Map<InstanceId, number>  // memory-leak accumulator, reset on restart/clear
  }
  ```

  **Scope resolution.** A fault on a region applies to every server in it. Reuse the hierarchy walk
  `manualOutages` already performs — do not write a second one. `faultsForServer(serverId, state,
  indexes)` returns the resolved list, consulting the `serversByAz`/`azsByRegion` indexes already
  built at `start()` (`index.ts:323-324`).

  **Per-kind wiring — each lands on machinery that already exists:**

  | Kind | Insertion point | Formula |
  |---|---|---|
  | `down` | unchanged — `failover.ts`'s `manualOutages` | today's exact path |
  | `latency-add` | `index.ts:951`, the `extraLatencyMsByServer` accumulator | `extra[serverId] = queuedMs + faultMs` |
  | `cpu-brownout` | the `effectiveVcpu` argument to `stepHost` (`hostScheduler.ts:117`) | `effectiveVcpu × capacityFraction`, composed *multiplicatively* with `vpsModel`'s `effectiveVcpuFactor` (`vpsModel.ts:86`) |
  | `memory-leak` | `InstanceLoad.ramBaseMb` (`hostScheduler.ts:12`) | `ramBaseMb + leakAccumMb`, where `leakAccumMb += mbPerMinute × stepSec / 60` |
  | `error-inject` | `flows.ts`'s dependency loop, beside the existing timeout path (`flows.ts:791-797`) | `errorRps += admitted × errorFraction`, recorded via `addDownstream(..., true, 'fault')` |

  ⚠ **`latency-add` must ADD, not assign.** `index.ts:951` already writes the NIC queued-latency
  settlement into `extraLatencyMsByServer` (`if (queuedMs > 0) extraLatencyMsByServer[server.id] =
  queuedMs`). An assignment here would silently erase NIC backpressure whenever a latency fault is
  active — a bug that would present as "injecting latency made the network problem disappear."

  **`memory-leak` needs no new failure path.** Growing `ramBaseMb` feeds the host scheduler's
  existing RAM accounting (`hostScheduler.ts:174`), which selects an `oomVictim`, which
  `index.ts:959-962` turns into an `oom_kill` event plus an `OOM_RESTART_MS` (5 s) restart timer.
  The leak accumulator must be cleared when the instance restarts, or the instance will re-OOM
  immediately on every cycle — that is a *choice*, and the correct default is to clear (a restarted
  process has a fresh heap).

  **New event kinds:** `fault_injected` / `fault_cleared`, appended to `EngineEventKind`
  (`worldEngine/types.ts:171-192`). `outage_triggered`/`outage_cleared` remain for `down`, so the
  existing Events tab and event-log tests are unchanged.

  **Perf.** The dominant cost is a `Map` lookup per server per step, and it is skippable entirely:
  guard the whole subsystem behind `if (state.active.size === 0) return` so a world with no active
  faults pays literally nothing. Expected steady-state delta: **0 ms/step with no faults, < 0.05
  ms/step at ~2,000 instances with faults active.**

  **UI.** A "Chaos" section on the existing chaos surfaces: the kill button becomes a split control —
  primary action still `down`, a `▾` opens the fault-kind picker with that kind's one parameter.
  Per the edit-lock law these are enabled **only while running**, tooltip
  `start the simulation to break things`. A faulted entity renders with a distinct non-fatal
  affordance (amber hatch) versus a killed one (existing dark/struck treatment) so "degraded by
  operator" is never confused with "dead."
- **Execution Steps for Developer Agent:**
  1. In `src/lib/worldEngine/types.ts`, add `FaultKind`, `FaultSpec`, and `FaultScope` as above.
     Change `WorldEngineApi.setOutage` (`:275`) to `setFault: (scope: FaultScope, id: string, spec:
     FaultSpec | null) => void`, and keep `setOutage: (scope, id, down: boolean) => void` on the
     interface as a thin documented alias so no existing caller breaks in this step.
  2. Append `'fault_injected' | 'fault_cleared'` to `EngineEventKind` (`types.ts:171-192`).
  3. Log both changes in `.superpowers/sdd/contract-drift.md` — the `setFault` signature is this
     spec's only intentional contract break; note that `setOutage` survives as an alias.
  4. Create `src/lib/worldEngine/faults.ts` exporting `FaultState`, `createFaultState()`,
     `setFault(state, scope, id, spec, simMs): EngineEvent[]` (idempotent, mirroring
     `failover.ts:setOutage`'s event-emitting shape), `faultsForServer(serverId, state, indexes)`,
     and `stepLeaks(state, loads, stepSec)`. Pure — no engine imports, matching `managedDbRuntime.ts`'s
     precedent.
  5. In `src/lib/worldEngine/index.ts`, hold a `FaultState` alongside the `FailoverState`. Route
     `{ kind: 'down' }` and `null`-on-a-`down` straight through to the existing
     `failover.setOutage` so that path is byte-identical.
  6. Wire `cpu-brownout` where `effectiveVcpu` is computed for `stepHost` — multiply, do not replace,
     so a brownout on a VPS composes with its steal fraction rather than overriding it.
  7. Wire `memory-leak`: call `stepLeaks` before building `InstanceLoad[]`, add `leakAccumMb` into
     each affected load's `ramBaseMb`, and clear the accumulator in the `oomRestartAt` handler at
     `index.ts:959-962` and on fault clear.
  8. Wire `latency-add` at `index.ts:951` — **`extraLatencyMsByServer[server.id] = queuedMs +
     faultMs`**, and drop the `if (queuedMs > 0)` guard to `if (queuedMs + faultMs > 0)`.
  9. Wire `error-inject` in `flows.ts`'s dependency loop next to the timeout branch (`:791-797`),
     adding a `'fault'` reason to the blocked-row reason union.
  10. In `src/app/store/simulation.store.ts`, add `setFault` beside the existing `setOutage`
      (`:278-279`); reimplement `setOutage` in terms of `setFault`. This is the ONLY file permitted
      to call the engine facade.
  11. Add the split chaos control to `dock/ServerFaceplate.tsx`, `dock/AzConfigTab.tsx`,
      `region/AzRow.tsx`, `RegionView.tsx`, and `ui/overlays/RegionOverlay.tsx`. Per the
      relocated-dispatch contract, all five reuse the SAME store action — do not fork a variant.
  12. Add a `fault-injected` info-severity finding to the capacity rules in
      `src/lib/analysis/rules/capacity.ts` so the Analysis tab states plainly that observed
      degradation is operator-induced, not architectural.
- **Acceptance & Verification Criteria:**
  - With no fault active, `runStep` output is **byte-identical** to pre-feature for a fixed seed —
    asserted with `toBe`, not `toBeCloseTo`, in `src/lib/worldEngine/index.test.ts`.
  - `setOutage(scope, id, true)` and `setFault(scope, id, { kind: 'down' })` produce identical engine
    state and identical emitted events.
  - `latency-add` of 200 ms on a server raises its instances' `p50Ms` by ~200 ms **and** leaves a
    concurrently-queued NIC latency intact — a regression test asserting `extraLatencyMsByServer`
    equals `queuedMs + faultMs`, not `faultMs`. This is the specific bug this design exists to avoid.
  - `cpu-brownout` at `capacityFraction: 0.5` on a saturated host doubles `latencyMultiplier` and
    halves `admittedScale`, composing correctly with a non-zero VPS steal fraction.
  - `memory-leak` at 60 MB/min on an instance with headroom H MB emits `oom_kill` at approximately
    `H` minutes of sim time, then `instance_restarted` 5 s later with `leakAccumMb` reset to 0.
  - `error-inject` at 0.1 raises the target's `errorRate` to ~0.1 and, sustained, trips the caller's
    circuit breaker via the existing `breakers.ts` path — no new breaker logic.
  - `index.test.ts`'s `DIVERGENCE GUARD` remains green (memory-leak changes RAM on the enforcement
    side; the published `ramMb` must move with it).
  - `bench/enginePerf.bench.test.ts` shows **no measurable regression** with zero faults active, and
    < 0.05 ms/step with faults active at 2,000 instances.
  - **Live smoke:** start the sim, apply a CPU brownout to one server from the faceplate, watch that
    server's cores redden and its latency chip climb while neighbours stay flat; clear it and watch
    recovery. Chaos controls are disabled while stopped and enabled while running, with the
    standardized tooltip. Verified in dark and light themes.

---

### [FEAT-002]: Network Partition & Link Impairment

- **Category:** Simulation Fidelity
- **Target Impact:** High
- **Affected System Areas:** `worldEngine/faults.ts`, `worldEngine/flows.ts` (path verdicts),
  `worldEngine/networkRuntime.ts`, `worldEngine/routingRuntime.ts`, `globe/ArcsLayer`,
  `region/CrossAzColumn`, `az/DatacenterFloor.tsx` flow traces
- **Depends on:** FEAT-001 (shares `FaultState` and the `setFault` entry point)
- **Problem / Gap:** FEAT-001 faults a *node*. Nothing in the engine can fault a *link*. This is a
  genuinely different insertion point, not a variation: node faults touch host state, link faults
  touch **path verdicts** — the `CompiledPath` list that `compileWorld` produces and `flows.ts`
  walks.

  The codebase already anticipates this. `src/lib/regionConfig.ts:57-58` carries the comment:
  "Optionally coupling jitter magnitude to link-congestion state … is a plausible follow-up; not
  implemented here." It was correctly deferred; this feature is the follow-up.

  The consequence of the gap is that **the single most instructive distributed-systems failure is
  unreachable in this simulator**: split-brain. You cannot demonstrate it by killing nodes, because a
  killed node stops answering health checks and the system correctly fails over. Split-brain requires
  an *asymmetric* partition — health checks succeeding in one direction while writes fail in the
  other, so two regions each conclude they are primary. Today, with only symmetric node death
  available, a user can build a multi-region active-active topology, kill things all day, and never
  see the failure mode that makes multi-region hard.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/worldEngine/types.ts (additive)
  export type LinkEndpoint =
    | { kind: 'region'; id: RegionId }
    | { kind: 'az'; id: AzId }
    | { kind: 'server'; id: ServerId }
    | { kind: 'internet' }

  export interface PartitionFault {
    from: LinkEndpoint
    to: LinkEndpoint
    mode: 'drop' | 'loss' | 'delay'
    lossFraction?: number    // mode 'loss': 0..1 of attempts dropped
    delayMs?: number         // mode 'delay': additive one-way latency
    symmetric: boolean       // false ⇒ from→to only; the split-brain enabler
  }
  ```

  Partitions live in `FaultState` as a flat `PartitionFault[]` (there will never be many; a linear
  scan is cheaper than a keyed structure and avoids a key-collision design).

  **Evaluation.** A single predicate, evaluated once per step per distinct path — never per request:

  ```
  impairmentFor(path: CompiledPath, faults: PartitionFault[]) -> { blocked, lossFraction, delayMs }
  ```

  A path matches a `PartitionFault` when its endpoints fall inside the endpoint scopes, honouring
  direction unless `symmetric`. `CompiledPath` already carries `hopClass` and both endpoints, so no
  new compile output is needed — this reads `compiled.paths` (`world/types.ts:464`) as-is.

  **Per-mode semantics, each landing on an existing mechanism:**

  - `drop` — the path is treated as blocked. This is the **same verdict `flows.ts` already produces
    for a firewall block** (`flows.ts:675-680`), including its `structuralRefusedRps` classification.
    Reuse that branch verbatim: a partition is structurally indistinguishable from a firewall rule
    from the flow solver's point of view, and audit ISSUE-008 already established that structural
    refusals must not feed the overload-shedding signal.
  - `loss` — `lossFraction` of the share is refused, the remainder proceeds. Models a degraded link
    (the case that is far nastier than a clean cut, because retries mask it until they don't).
  - `delay` — `delayMs` is added to that hop's latency via `networkRuntime.baseHopLatencyMs`'s
    result at the call site in the flow solver's composed-latency pass. This is where
    `regionConfig.ts`'s deferred "couple jitter to link-congestion state" note is finally honoured.

  **Health-check asymmetry is the whole point.** `routingRuntime.ts` performs health checks along
  paths; those checks must consult the SAME `impairmentFor` predicate. When `symmetric: false`, a
  region A → region B partition means B's health probes of A fail while A's probes of B succeed.
  Each side promotes locally. The engine emits `replica_promoted` on both — and the Analysis tab
  gets a new `split-brain-risk` rule (`analysis/rules/structural.ts`) that fires when two instances
  of the same `blueprintId|regionId` cluster hold `primary` simultaneously.

  **Perf.** `impairmentFor` is O(paths × faults) per step, but memoized per step into a
  `Map<pathKey, Impairment>` built once at the top of `runStep` and read by both the flow solver and
  the routing runtime — the same one-step-memo pattern `index.ts:328` already uses for the role
  resolver. With zero partitions the memo build short-circuits. Expected: **0 ms/step with no
  partitions; < 0.1 ms/step with a handful.**

  **Visuals, on the 1 Hz batch only.** A severed link renders as a broken great-circle arc on the
  globe (`ArcsLayer` — gap in the middle, endpoints intact), a struck-through cross-AZ column in
  `region/`, and a dashed-red flow trace on the floor. `loss` renders as a thinned/stippled line
  rather than a break; `delay` renders normally but the latency chip on affected hops rises. No
  per-frame work: the impairment set changes only when the operator changes it.
- **Execution Steps for Developer Agent:**
  1. Add `LinkEndpoint` and `PartitionFault` to `src/lib/worldEngine/types.ts` (additive); log in
     `contract-drift.md`.
  2. Extend `FaultState` in `worldEngine/faults.ts` with `partitions: PartitionFault[]`, plus
     `addPartition` / `removePartition` / `impairmentFor(path, faults)`. Keep `faults.ts` pure.
  3. In `worldEngine/index.ts`'s `runStep`, build the per-step impairment memo before the flow
     solve, guarded by `partitions.length === 0`.
  4. In `flows.ts`, consult the memo in the dependency loop: route `drop` into the **existing**
     structural-refusal branch at `:675-680` (do not write a new refusal path), apply `loss` as a
     partial refusal, and add `delay` to the hop's composed latency.
  5. In `routingRuntime.ts`, apply the same memo to health-check evaluation so probes fail
     directionally. This is the change that makes split-brain reachable.
  6. Add `partition_started` / `partition_healed` to `EngineEventKind`.
  7. Add a `split-brain-risk` rule to `src/lib/analysis/rules/structural.ts` and spread it into
     `ANALYSIS_RULES` — fires when >1 effective primary exists in one `blueprintId|regionId` cluster.
  8. Add `setPartition` to `simulation.store.ts` (engine seam) and a "Partitions" authoring surface
     to the region-scope chaos controls — an endpoint pair, a mode, and a symmetric toggle.
  9. Render severed/impaired links in `globe/ArcsLayer`, `region/CrossAzColumn`, and
     `az/DatacenterFloor.tsx`, all driven off the 1 Hz batch, using `var(--color-danger)` and
     respecting `prefers-reduced-motion`.
- **Acceptance & Verification Criteria:**
  - With no partitions, engine output is byte-identical for a fixed seed (`toBe`).
  - A symmetric `drop` between two regions zeroes cross-region dependency flow and increments
    `structuralRefusedRps` — **not** the overload-shedding signal (asserts audit ISSUE-008's
    distinction still holds).
  - A `loss` partition at `lossFraction: 0.3` refuses ~30% of attempts on matching paths only;
    unmatched paths are unchanged to the digit.
  - A `delay` partition at 150 ms raises composed `p50Ms` on matching hops by ~150 ms and leaves
    same-AZ hops untouched.
  - **The split-brain test:** an asymmetric region A→B partition on an active-active two-region
    world produces two simultaneous effective primaries in the same cluster, `replica_promoted` on
    both sides, and a `split-brain-risk` finding in the Analysis tab. This single test is the
    feature's reason for existing — if it does not pass, the feature is not done.
  - Healing a partition restores flow and clears the finding within one health-check interval.
  - `bench/enginePerf.bench.test.ts`: no regression at zero partitions.
  - **Live smoke:** partition two regions asymmetrically from the region view; the globe arc breaks,
    both regions show a promoted primary, and the Analysis tab explains why. Verified in both themes.

---

### [FEAT-003]: Scenario Timeline

- **Category:** System Configurability
- **Target Impact:** High
- **Affected System Areas:** `src/lib/world/types.ts` (`WorldDoc.scenario`), `src/lib/serializer.ts`,
  `src/app/store/world.store.ts`, `worldEngine/index.ts` (step-boundary application),
  `worldEngine/demand.ts`, `SimControls.tsx`, new `panels/ScenarioPanel.tsx`
- **Depends on:** FEAT-001 (scenario steps reference `FaultSpec`), FEAT-002 (partition steps)
- **Problem / Gap:** Chaos in this simulator is **manual clicking**, and therefore unrepeatable.
  There is no `scenario` field anywhere in `WorldDoc` (`world/types.ts:360-380` — verified; the only
  `scenario` identifier in `src/` is an unrelated test-fixture helper in
  `analysis/__fixtures__/worlds.ts`). To demonstrate a failure you must start the sim, wait, click
  the right control at the right moment, and hope. To demonstrate it *twice the same way* — the
  entire basis of a before/after comparison — is impossible.

  This has a second-order cost: it makes FEAT-011 (A/B comparison) meaningless. Comparing two
  architectures under two hand-clicked, differently-timed chaos sequences measures the operator's
  reflexes, not the architectures. **A reproducible scenario is the precondition for every
  benchmarking claim this tool might make.**

  Related, and fixed here because it is the same authoring surface: demand shape is a two-value
  enum. `DiurnalPattern = 'flat' | 'day-night'` (`world/types.ts:38`) runs against a hardcoded
  two-minute compressed day (`demand.ts:16`, `DAY_MS = 120_000`). A user cannot author "flat until
  09:00, 4× ramp over ten minutes, sustained peak, decay" — the Black Friday shape that makes
  autoscaling and cost velocity interesting.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts (additive, optional)
  export type ScenarioAction =
    | { type: 'inject-fault'; scope: FaultScope; id: string; spec: FaultSpec }
    | { type: 'clear-fault'; scope: FaultScope; id: string }
    | { type: 'partition'; fault: PartitionFault }
    | { type: 'heal-partition'; index: number }
    | { type: 'demand-multiplier'; factor: number; rampSec: number }        // world-wide
    | { type: 'set-population-rps'; populationId: PopulationId; peakRps: number; rampSec: number }

  export interface ScenarioStep { atMs: number; action: ScenarioAction; note?: string }

  export interface Scenario {
    id: string
    label: string
    seed: number                 // pins the engine rng — this is what makes a run reproducible
    durationMs: number
    steps: ScenarioStep[]
  }

  // WorldDoc gains:  scenario?: Scenario
  ```

  **Application is at the step boundary, from the frozen doc.** `runStep` advances `simMs` by
  `stepMs`; before solving, it applies every step whose `atMs` falls in `(prevSimMs, simMs]`. Because
  the doc is frozen at `start()` and the scenario is read from it, and because `seed` pins the rng,
  **scenario + seed is exactly reproducible**. This is the property FEAT-011 depends on, and it is
  worth stating as an invariant: *two runs of the same scenario at the same seed against the same
  doc must produce identical `MetricsBatch` sequences.* Assert it with a test that runs 60 s twice
  and deep-equals the batches.

  Steps are pre-sorted by `atMs` at `start()` into an array plus a cursor index — an O(1) advance per
  step, not a scan. This mirrors the `start()`-time index pattern at `index.ts:320-327`.

  **Demand shaping.** `demand-multiplier` and `set-population-rps` write into an engine-owned
  overlay (again: *not* the doc), consumed by `demand.ts`'s `populationDemandRps` as a multiplier on
  the diurnal mean **before** the Poisson draw — so bursts and variance still compose naturally
  rather than being replaced by a deterministic ramp. `rampSec` linearly interpolates the multiplier
  rather than stepping it, because an instantaneous 4× is a different (and less realistic) test than
  a ten-minute ramp.

  Additionally widen `DiurnalPattern` to `'flat' | 'day-night' | 'custom'` with an optional
  `ClientPopulation.curve?: { atFraction: number; multiplier: number }[]` — piecewise-linear over the
  compressed day, interpolated. Absent ⇒ existing enum behavior, byte-identical.

  **Persistence.** The scenario **is** serialized into `.scalemap`. This does not violate the
  serializer law: a scenario is *authored configuration*, not derived state — the same category as
  routing policy or a packet template. It normalizes in `deserializeWorld`'s existing defaulting
  block (`serializer.ts:153-156` pattern), defaulting to `undefined`.

  **UI.** A `ScenarioPanel` at world scope: a horizontal time ruler with draggable step markers,
  a step list, and per-step editing. `SimControls` gains a scenario selector plus a "run scenario"
  mode where the ruler doubles as a progress indicator. Authoring is edit-locked while running;
  *running* a scenario is the run-only inverse.

  **Perf.** One integer comparison per step against the cursor. **Effectively 0 ms/step.**
- **Execution Steps for Developer Agent:**
  1. Add `ScenarioAction`, `ScenarioStep`, and `Scenario` to `src/lib/world/types.ts`; add
     `scenario?: Scenario` to `WorldDoc` (`:360`). Add `curve?` to `ClientPopulation` and `'custom'`
     to `DiurnalPattern` (`:38`).
  2. Normalize `scenario` in `src/lib/serializer.ts`'s defaulting block alongside
     `racks`/`loadBalancers`/`packets` (`:153-156`) — absent ⇒ `undefined`, no version bump (v3 is
     unchanged; this is an additive optional field).
  3. Add scenario CRUD actions to `src/app/store/world.store.ts`, all routed through the internal
     `mutate()` helper so undo/redo and dirty-marking come for free.
  4. In `worldEngine/index.ts`, sort scenario steps at `start()` into a cursor-indexed array; apply
     due steps at the top of `runStep` before demand generation. Seed the rng from `scenario.seed`
     when a scenario is present.
  5. Add an engine-owned demand-overlay map; consume it in `demand.ts`'s `populationDemandRps` as a
     multiplier on the diurnal mean **before** `samplePoisson` (`demand.ts:89`), so variance still
     composes.
  6. Implement piecewise-linear `curve` interpolation in `demand.ts`, defaulting to the existing
     `flat`/`day-night` branches when absent.
  7. Add `scenario_step_applied` (info) to `EngineEventKind` so the Events tab and the durable
     event log narrate the run.
  8. Create `src/app/world/panels/ScenarioPanel.tsx` (time ruler + step list + editor) and register
     a `'scenario'` tab in `ui.store.ts`'s `PanelTab` union (`:33`) and `dock/scope.ts`'s
     `WORLD_TABS` (`:62`). **`WorldPanel.tsx` is a hub file — edit it sequentially, not in parallel
     with other waves.**
  9. Add scenario selection + run/progress to `src/app/world/SimControls.tsx`.
  10. Add 2–3 built-in example scenarios (regional failure, Black Friday ramp, creeping memory leak)
      to `src/lib/vault/exampleWorlds.ts` so the feature is discoverable without authoring.
- **Acceptance & Verification Criteria:**
  - **The determinism test, which is the feature's core claim:** running the same scenario at the
    same seed against the same doc twice produces deep-equal `MetricsBatch` sequences over 60 s of
    sim time. Without this, FEAT-011 cannot be built.
  - A world with no `scenario` is byte-identical to pre-feature for a fixed seed (`toBe`).
  - A `.scalemap` saved with a scenario reopens with it intact; a pre-feature v3 file still loads
    (no version bump, additive normalization only).
  - `inject-fault` at `atMs: 30000` fires between step 299 and 300 at 100 ms steps — asserted on the
    `fault_injected` event's `simMs`, exactly once, never twice.
  - `demand-multiplier` at `factor: 4, rampSec: 600` reaches ~4× mean demand at +10 min, with Poisson
    variance still present (assert variance ≈ mean, not a smooth deterministic curve — the ramp must
    scale the mean, not replace the distribution).
  - A `custom` curve interpolates piecewise-linearly; `flat`/`day-night` are unchanged to the digit.
  - Scenario authoring is disabled while running with the `stop the simulation to edit` tooltip; the
    run control is enabled only while running.
  - `bench/enginePerf.bench.test.ts`: no measurable regression.
  - **Live smoke:** load the built-in "regional failure" scenario, run it, and watch the timeline
    advance while the region drops and traffic fails over — then run it again and confirm the same
    events land at the same timestamps. Verified in both themes.

---

### [FEAT-004]: Cache Hit Ratio & Cold-Cache Thundering Herd

- **Category:** Simulation Fidelity
- **Target Impact:** High
- **Affected System Areas:** `src/lib/world/types.ts` (`ServiceBlueprint.cacheConfig`,
  `BlueprintDependency.cacheAsideVia`), new `worldEngine/cache.ts`, `worldEngine/flows.ts`,
  `worldEngine/index.ts`, `analysis/rules/capacity.ts`, `panels/BlueprintModal.tsx`,
  `connections/EdgeInspector`
- **Depends on:** FEAT-001 (the restart/fault path that makes a cold cache demonstrable)
- **Problem / Gap:** `BlueprintKind` includes `'cache'` (`world/types.ts:202`) and the app lets you
  author one — `BlueprintModal.tsx:62` offers the label, `serviceDraft.ts:20,75` picks a workload
  preset for it. **But the kind carries no caching semantics whatsoever.** `hitRatio` returns zero
  hits across the entire repository. A Redis instance in this simulator is an ordinary service with a
  cache-flavoured CPU profile: it absorbs requests, uses CPU, and forwards *every single one* of them
  to whatever it depends on.

  That is not a cosmetic gap. It inverts the economics of the most common performance topology in
  production. Today, putting a cache in front of a database makes the database's load **strictly
  worse** (an extra hop, an extra latency term, zero traffic reduction). The user learns the opposite
  of the lesson.

  It also makes the single most instructive cache failure unreachable: the **thundering herd**. When
  a cache restarts, its hit ratio is zero, and 100% of the traffic it was absorbing lands on the
  database at once — a load spike of `1/(1-hitRatio)` times normal. At a realistic 95% hit ratio that
  is a **20× instantaneous spike** on the database. Teams have taken multi-hour outages to exactly
  this, and it is invisible here.

  This is the highest teaching-value-per-line-of-code feature in the spec: the mechanism is a single
  multiplier, and the behavior it unlocks is a cascading failure that no amount of node-killing can
  currently produce.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts (additive, optional)
  export interface CacheConfig {
    hitRatio: number       // 0..1 steady-state hit ratio
    warmupSec: number      // seconds from cold (0%) to steady-state hitRatio
    ttlSec: number         // entry lifetime; drives the ambient miss floor
  }
  // ServiceBlueprint gains:      cacheConfig?: CacheConfig     (meaningful when kind === 'cache')
  // ManagedService gains:        cacheConfig?: CacheConfig     (meaningful for redis/memcached nodeTypes)
  // BlueprintDependency gains:   cacheAsideVia?: string        // dependency id of the cache edge
  ```

  **Two topologies, one hit-ratio resolver.** Real systems cache in two shapes, and the spec supports
  both from a single resolution point (Cross-Cutting Constraint 6):

  - **Read-through / proxy** (`api → cache → db`). The cache instance itself has dependencies. Its
    miss fraction is a **fan-out multiplier** on everything it calls: in `flows.ts`'s dependency
    loop, when the calling instance's blueprint has a `cacheConfig`, multiply the computed `share`
    by `(1 - effectiveHitRatio)` before `addDownstream` (`flows.ts:467`).
  - **Cache-aside / look-aside** (`api → cache` *and* `api → db`, the far more common Redis shape).
    The DB edge declares `cacheAsideVia: <id of the cache edge>`; its share is multiplied by
    `(1 - effectiveHitRatio)` of the cache that edge points at. **This is the only shape that works
    for a managed cache**, because managed targets are terminal in the flow solver
    (`flows.ts:739` — "managed targets are terminal — no capacity subtree to propagate into"), so a
    managed Redis can never fan out to a DB on its own. Spec this explicitly; an implementer who
    only builds the proxy shape will ship a feature that does nothing for `ManagedService` users.

  **The warm-up ramp — the herd mechanism:**

  ```
  effectiveHitRatio(t) = hitRatio × min(1, (t - warmSinceMs) / (warmupSec × 1000))
  ```

  `warmSinceMs` is engine-owned per instance (an overlay, following `promotedAt`'s precedent), set at
  `start()` and **reset to the current `simMs` whenever the instance restarts** — the OOM restart
  path at `index.ts:959-962`, and any FEAT-001 `down` fault clear. A cache that dies at 95% hit ratio
  comes back at 0% and ramps over `warmupSec`, and the DB behind it eats a 20× spike that decays as
  the cache refills. That is the entire feature.

  **The TTL floor.** A cache with a finite `ttlSec` can never reach a 100% hit ratio — entries expire.
  Model the ambient miss floor as `max(1 - hitRatio, stepSec / ttlSec)`, so an aggressive
  `hitRatio: 0.999` with a 10 s TTL still produces a realistic miss stream rather than a physically
  impossible zero.

  **One resolver, no divergence.** `worldEngine/cache.ts` exports
  `effectiveMissFraction(instanceId, cfg, warmSinceMs, simMs, stepSec): number` — pure, no engine
  imports, matching `managedDbRuntime.ts`'s shape. Both topologies call it. The published
  `InstanceMetrics` gains an additive-optional `cacheHitRatio?: number` read from **the same call**,
  never re-derived — a hit ratio the user sees that differs from the one the solver applied would be
  a textbook instance of this repo's divergence class.

  **Analysis.** A new `cache-miss-storm` rule in `analysis/rules/capacity.ts` fires when a cache's
  effective hit ratio is below half its configured value *and* its downstream dependency is above
  80% capacity — naming the cause ("cache X is 40% warm; database Y is absorbing 3.2× its steady
  load") rather than reporting the database as generically overloaded.

  **Perf.** One multiplication and one `Map` lookup per cache-bearing dependency row per step. Worlds
  with no `cacheConfig` skip via a `start()`-time "has any cache" flag. Expected: **0 ms/step
  without caches, < 0.05 ms/step with them.**
- **Execution Steps for Developer Agent:**
  1. Add `CacheConfig` to `src/lib/world/types.ts`; add `cacheConfig?` to `ServiceBlueprint` (`:216`)
     and `ManagedService` (`:267`), and `cacheAsideVia?: string` to `BlueprintDependency`.
  2. Normalize all three as optional in `src/lib/serializer.ts` (absent ⇒ no caching semantics, the
     regression floor).
  3. Create `src/lib/worldEngine/cache.ts` with `effectiveMissFraction(...)` as specified — pure,
     no engine imports. Include the TTL floor.
  4. In `worldEngine/index.ts`, hold `warmSinceMs: Map<InstanceId, number>`; initialize at `start()`;
     reset in the OOM-restart handler (`:959-962`) and on FEAT-001 fault clear. Build a
     `hasAnyCache` flag at `start()` for the fast path.
  5. In `flows.ts`'s dependency loop, apply the proxy-shape multiplier to `share` before
     `addDownstream` (`:467`) when the **calling** instance has a `cacheConfig`.
  6. In the same loop, apply the cache-aside multiplier when `dep.cacheAsideVia` is set, resolving the
     referenced cache edge through a `start()`-time dependency index (reuse the index audit ISSUE-014
     added — do not add a sixth `dependencies.find` per row).
  7. Add `cacheHitRatio?: number` to `InstanceMetrics` (`worldEngine/types.ts:26`), populated in
     `metrics.ts` from the same `effectiveMissFraction` call the solver used. Log in
     `contract-drift.md`.
  8. Add `cache_cold` / `cache_warm` to `EngineEventKind` so the Events tab narrates the herd.
  9. Add the `cache-miss-storm` rule to `src/lib/analysis/rules/capacity.ts`; spread into
     `ANALYSIS_RULES`.
  10. Author `cacheConfig` in `panels/BlueprintModal.tsx` (shown only when `kind === 'cache'`) and in
      the managed-service editor for redis/memcached node types; author `cacheAsideVia` as a
      dropdown in the Connections graph's `EdgeInspector`, listing sibling cache dependencies.
  11. Show the live hit ratio on the cache's service chip in `ServerView` and on its floor node,
      driven off the 1 Hz batch, with a distinct treatment while warming.
- **Acceptance & Verification Criteria:**
  - A blueprint with no `cacheConfig` produces byte-identical engine output for a fixed seed (`toBe`).
  - **The economics invert correctly:** in an `api → cache → db` topology at `hitRatio: 0.9`, the
    database's admitted rps is ~10% of the cache's, not 100%. This is the assertion that the feature
    exists at all.
  - **The thundering-herd test:** at `hitRatio: 0.95, warmupSec: 60`, killing and restoring the cache
    drives the downstream DB to ~20× its steady rps immediately after restart, decaying back over
    ~60 s. Assert both the peak multiple and the decay.
  - Cache-aside works for a **managed** Redis: `cacheAsideVia` on the DB edge reduces DB rps even
    though the managed cache is a terminal node in the solver.
  - The TTL floor holds: `hitRatio: 0.999, ttlSec: 10` yields a miss fraction ≥ `stepSec / 10`, never 0.
  - Published `InstanceMetrics.cacheHitRatio` equals the value the flow solver applied in the same
    step — a divergence guard in the style of `index.test.ts`'s existing one.
  - `cache-miss-storm` fires during the herd and clears once warm.
  - `index.test.ts`'s `DIVERGENCE GUARD` stays green (downstream load changes ⇒ connections and RAM
    change on both call sites).
  - `bench/enginePerf.bench.test.ts`: no regression without caches.
  - **Live smoke:** build api → cache → db, run, kill the cache, and watch the DB's cores spike and
    its latency chip climb while the cache's hit-ratio readout ramps from 0. Both themes.

---

### [FEAT-005]: Replication Lag & RPO

- **Category:** Simulation Fidelity
- **Target Impact:** High
- **Affected System Areas:** `src/lib/world/types.ts` (`DbConfig`), new
  `worldEngine/replication.ts`, `worldEngine/failover.ts`, `worldEngine/flows.ts`,
  `worldEngine/metrics.ts`, `analysis/rules/structural.ts`, `region/TimelineV2.tsx`
- **Depends on:** FEAT-001 (fault-driven promotion is how lag becomes visible)
- **Problem / Gap:** Failover in this simulator is **instantaneous and lossless**.
  `failover.ts:335`'s `promoteReplicas` selects a healthy sibling replica and promotes it in the same
  step, with no notion of how far behind that replica was. `replicationLag` returns zero hits
  repo-wide.

  This makes the simulator quietly dishonest about the central trade-off in every replicated data
  store. A user can build a cross-region replica, kill the primary, watch a clean promotion, and
  conclude their design has no data-loss exposure — when a real cross-region async replica running
  80 ms behind under write load would have lost every transaction in that window. **RPO (recovery
  point objective) is the number that decides whether a topology is acceptable to a business**, and
  this tool currently reports it as implicitly zero for every configuration.

  The second consequence is stale reads. The engine already splits reads from writes —
  `dep.writeFraction` is derived from the packet mix (audit ISSUE-001) and managed DBs carry separate
  read/write ceilings — so reads *are* routed to replicas. But a replica that is behind serves stale
  data, and nothing here models that. A read-replica topology therefore looks strictly free.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts — DbConfig (additive, optional)
  export interface DbConfig {
    // ... existing engine field
    replicationMode?: 'async' | 'semi-sync'   // absent ⇒ 'async'
    applyRatePerReplica?: number              // writes/sec a replica can apply; absent ⇒ derived
    rpoTargetSec?: number                     // authored objective; drives the analysis rule
    hotKeyCount?: number                      // stale-read model denominator; absent ⇒ 1000
  }
  ```

  **Lag as a bounded backlog.** Per cluster (`blueprintId|regionId`, the key `promoteReplicas`
  already uses at `failover.ts:351`) and per replica:

  ```
  applyCapacity  = applyRatePerReplica ?? (replica's serviceRateByInstance × writeApplyEfficiency)
  backlogWrites += (writeRps - applyCapacity) × stepSec        // clamped at >= 0
  lagSec         = backlogWrites / max(applyCapacity, ε) + localityFloorSec
  ```

  `writeRps` comes from the **existing** write/read split — `dep.writeFraction` resolved through
  `packetResolve` (do not re-derive it; audit ISSUE-001 exists precisely because it was derived
  twice). `writeApplyEfficiency` is a documented constant (~0.7): applying a replicated write is
  cheaper than originating one, but not free.

  **The locality floor** is where a replica's placement finally has a data consequence:

  | Replica locality | Floor |
  |---|---|
  | same AZ | 5 ms |
  | cross-AZ | 20 ms |
  | cross-region | `interRegionLatencyMs(from, to) / 1000` |

  This reuses `regionConfig.ts`'s **pure, deterministic** `interRegionLatencyMs` — explicitly not
  `sampleInterRegionLatencyMs`, which the Housekeeping section deletes for calling `Math.random()`.
  A cross-region replica lags more than a same-AZ one even at zero write load, which is exactly the
  physical truth the current model omits.

  **Stale reads.** Model the probability that a given read touches a key written within the lag
  window as a Poisson collision over a hot keyspace:

  ```
  staleReadFraction = 1 - exp(-(writeRps × lagSec) / hotKeyCount)
  ```

  At 100 writes/sec, 2 s of lag, and 1,000 hot keys: ~18% of replica reads are stale. Stale reads are
  **not errors** — they succeed, with correct latency. They are published as a distinct
  `InstanceMetrics.staleReadFraction?` and surfaced as a warning-severity signal, because a system
  that silently serves stale data is precisely the failure users need shown to them rather than
  inferred. `semi-sync` mode clamps `lagSec` to the replication round-trip and instead charges the
  **primary** that latency on every write — the honest trade, not a free upgrade.

  **RPO at promotion.** In `promoteReplicas` (`failover.ts:335`), stamp the chosen replica's current
  `lagSec` onto the `replica_promoted` event as a data-loss window, and add
  `dataLossWindowSec` + `estimatedLostWrites = lagSec × writeRps` to the event payload. The Region
  view's failover timeline (`region/TimelineV2.tsx`) renders it as a labelled band on the causality
  swimlane — the moment of promotion is exactly when a user is looking, and exactly when this number
  matters.

  **Selection changes too, and should.** `promoteReplicas` currently picks by health; it should
  prefer the **least-lagged** healthy replica, which is what a real orchestrator does. This is a
  behavior change to an existing code path — call it out in the wave's re-baseline notes.

  **Analysis.** `replication-lag-exceeds-rpo` (structural rules) fires when sustained `lagSec` exceeds
  `rpoTargetSec`, naming the cluster and the observed lag.

  **Perf.** O(replicas) per step — a handful of arithmetic ops on a set that is orders of magnitude
  smaller than the instance set. Skipped entirely when no cluster has replicas. Expected:
  **< 0.02 ms/step.**
- **Execution Steps for Developer Agent:**
  1. Add the four optional fields to `DbConfig` in `src/lib/world/types.ts:210-214`; normalize as
     optional in `serializer.ts`.
  2. Create `src/lib/worldEngine/replication.ts` — pure, exporting `ReplicationState`,
     `createReplicationState()`, `stepReplication(state, clusters, writeRpsByCluster, stepSec)`, and
     `localityFloorSec(primary, replica, doc)`. Import `interRegionLatencyMs` from `regionConfig.ts`
     (**not** the deleted sampled variant).
  3. In `worldEngine/index.ts`, build the cluster→replica index at `start()` (the doc is frozen, so
     this is safe — same rationale as `index.ts:322`); call `stepReplication` after the flow solve,
     sourcing `writeRps` from the resolved `dep.writeFraction` path, never re-derived.
  4. In `flows.ts`, apply `staleReadFraction` to replica-targeted read rows — as a published
     attribute of the row, **not** as an error (a stale read succeeds).
  5. Add `replicationLagSec?` (cluster-level, via a new additive-optional `MetricsBatch.clusters?`
     map) and `staleReadFraction?` to `InstanceMetrics`. Log both in `contract-drift.md`.
  6. In `failover.ts:335`'s `promoteReplicas`: change replica selection to prefer least-lagged among
     healthy candidates, and stamp `dataLossWindowSec` + `estimatedLostWrites` onto the
     `replica_promoted` event.
  7. Implement `semi-sync`: clamp lag to the replication RTT and add that RTT to the primary's write
     latency in the flow solver's composed-latency pass.
  8. Add `replication_lag_high` and `stale_read_served` (rate-limited, mirroring
     `REFUSED_EVENT_MIN_GAP_MS` at `index.ts:63`) to `EngineEventKind`.
  9. Add the `replication-lag-exceeds-rpo` rule to `analysis/rules/structural.ts`; spread into
     `ANALYSIS_RULES`.
  10. Render the data-loss window as a labelled band in `region/TimelineV2.tsx`, and lag as a live
      readout on replica chips in `ServerView` / the floor.
  11. Author `replicationMode` / `rpoTargetSec` in the DB blueprint's config drawer.
- **Acceptance & Verification Criteria:**
  - A world with no replicas, or with `DbConfig` fields absent, is byte-identical for a fixed seed
    (`toBe`).
  - At zero write load, a same-AZ replica shows ~5 ms lag and a cross-region replica shows
    `interRegionLatencyMs / 1000` — the locality floor is present without load.
  - Write load above `applyCapacity` grows `lagSec` monotonically; dropping below it drains the
    backlog to the floor.
  - **The RPO test:** kill a primary under sustained write load and assert the `replica_promoted`
    event carries a non-zero `dataLossWindowSec` matching the promoted replica's lag at that step,
    and that `estimatedLostWrites ≈ lagSec × writeRps`.
  - Promotion selects the **least-lagged** healthy replica, not merely the first healthy one.
  - `staleReadFraction` matches the Poisson formula to the digit, and stale reads do **not** raise
    `errorRate`.
  - `semi-sync` clamps lag **and** raises primary write latency — assert both, so the mode cannot be
    mistaken for a free improvement.
  - `replication-lag-exceeds-rpo` fires above the authored target and clears below it.
  - `bench/enginePerf.bench.test.ts`: < 0.02 ms/step delta.
  - **Live smoke:** cross-region primary + replica under write load; kill the primary; the timeline
    shows the promotion band labelled with the data-loss window in seconds and lost writes. Both
    themes.

---

### [FEAT-006]: Disk & IOPS as a Real Capacity Axis

- **Category:** Simulation Fidelity
- **Target Impact:** Medium
- **Affected System Areas:** `src/lib/world/types.ts` (`ServerSpecs`), `worldEngine/hostScheduler.ts`,
  `worldEngine/metrics.ts`, `worldEngine/faults.ts` (contributes the `disk-stall` variant),
  `costModelV2.ts`, `analysis/rules/capacity.ts`, `dock/drawers/Hardware`
- **Depends on:** FEAT-001 (contributes the sixth `FaultSpec` variant back to its union)
- **Problem / Gap:** Disk is **decorative**. `ServerMetrics.diskIoFraction` is computed at
  `metrics.ts:368` as `Math.min(1, diskIo / 100)` against a norm the comment itself describes as
  arbitrary ("documented norm: 100 io-units/sec = saturated"). It constrains no admission, adds no
  latency, and triggers no event. `ServerSpecs` (`world/types.ts:80-86`) carries `diskGb` — a
  *capacity* number used for cost — but **no IOPS or throughput dimension at all**.

  Meanwhile `ManagedService.provisionedIops` exists and is *billed* (`costModelV2.ts:99,129`, audit
  ISSUE-059 added gp3-shaped pricing above a free baseline) — so the app charges the user real money
  for provisioned IOPS that have **no behavioral consequence whatsoever**. A user can provision 20,000
  IOPS, pay for them, and observe precisely nothing. That is the sharpest form of this gap: the cost
  model and the simulation disagree about whether a resource exists.

  This matters most for exactly the workloads users care about. A database is disk-bound long before
  it is CPU-bound; today it can only ever fail on CPU, RAM, or connections. The classic "storage
  saturated, everything queues behind fsync" incident is unreachable.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts — ServerSpecs (additive, optional)
  export interface ServerSpecs {
    vcpu: number; threadsPerCore: number; ramMb: number; diskGb: number; nicMbps: number
    diskIops?: number                          // absent ⇒ derived from diskType; both absent ⇒ unbounded
    diskType?: 'hdd' | 'ssd' | 'nvme'          // 150 / 16_000 / 100_000 IOPS defaults
  }
  ```

  **Absent both fields ⇒ unbounded**, which is today's exact behavior and the regression floor —
  mirroring the convention `WorkloadProfile.maxConnections` already established
  (`world/types.ts:168`: absent ⇒ unbounded).

  **Demand is already computed.** `metrics.ts:352-355` sums
  `Σ rps × workload.diskIoPerRequest` per server. That sum currently feeds only the decorative
  fraction. Hoist it to the step path and it becomes the demand side of a real ceiling:

  ```
  ρ_disk = demandIops / diskIops
  ```

  **Reuse the queueing curve — do not derive a third one.** `hostScheduler.ts:32-33` documents that
  `poolCheckoutFor` deliberately shares `managedDbRuntime`'s `base / (1 - saturation)` shape. The
  disk ceiling makes it three consumers of one curve:

  ```
  diskWaitMs = 0                                                  when ρ_disk <= 1
  diskWaitMs = BASE_DISK_MS / (1 - min(ρ_disk - 1, 0.98))          when ρ_disk >  1
  ```

  `BASE_DISK_MS` is per `diskType` (hdd 8, ssd 0.5, nvme 0.1) — the device's unloaded service time.
  `diskWaitMs` is added to the instance's service latency on the same additive path
  `checkoutWaitMs` already travels, so it composes into end-to-end latency and therefore into
  Little's-law connections and RAM. **This is why the two-call-site invariant applies:** disk wait
  changes `activeConnections`, so `hostScheduler`'s enforced value and `metrics.ts`'s published value
  must move together.

  **`diskIoFraction` becomes real — carefully.** When `diskIops` is resolvable, publish
  `min(1, ρ_disk)`. When it is not, keep the legacy `diskIo / 100`. Two behaviors for one field is
  ordinarily a smell, but here it is what preserves the regression floor for every existing
  `.scalemap`; document it at the field and plan to retire the legacy branch once presets carry
  `diskType`.

  **Managed services.** `ManagedService.provisionedIops` becomes the ceiling for managed DB
  instances, finally connecting the billed knob to behavior. Route it through
  `managedDbRuntimeFor`'s existing saturation math rather than a parallel path.

  **The `disk-stall` fault.** This feature contributes the sixth variant to FEAT-001's union:
  `{ kind: 'disk-stall'; iopsFraction: number }`, which multiplies the effective `diskIops` — the
  precise analogue of `cpu-brownout`. Deferring it to this wave is deliberate: there was nothing to
  stall against in Wave 1.

  **Analysis.** `iops-saturated` (capacity rules) fires when sustained `ρ_disk > 0.9`, naming the
  server, the offending instances by `diskIoPerRequest`, and the headroom needed.

  **Perf.** One division and one comparison per server per step, on a sum that is already being
  computed once per second — hoisting it to per-step is the only new cost. Skipped when no server has
  a resolvable ceiling. Expected: **< 0.05 ms/step at ~2,000 instances.**
- **Execution Steps for Developer Agent:**
  1. Add `diskIops?` and `diskType?` to `ServerSpecs` (`world/types.ts:80-86`); normalize as optional
     in `serializer.ts`. Add `diskType` to the presets in `world/instanceCatalog.ts` so new servers
     get a sensible ceiling without authoring.
  2. Add `diskIoDemandFor(loads, blueprints)` to `hostScheduler.ts`, reusing the summation shape at
     `metrics.ts:352-355` — one implementation, called from both places.
  3. Add `diskWaitFor(demandIops, diskIops, diskType)` next to `poolCheckoutFor`
     (`hostScheduler.ts:39`), returning `null` when no ceiling is resolvable — the same
     "not capacity-modelled" convention `poolCheckoutFor` and `managedDbRuntimeFor` share.
  4. Fold `diskWaitMs` into instance service latency on the **same** additive path as
     `checkoutWaitMs`, and thread it through `HostStepResult` so both RAM call sites see one value.
  5. Add `diskWaitMs?` to `InstanceMetrics` and change `ServerMetrics.diskIoFraction` to the dual
     behavior above. Log in `contract-drift.md`.
  6. Extend the divergence guard: assert enforced and published disk-driven `activeConnections` agree.
  7. Route `ManagedService.provisionedIops` into `managedDbRuntimeFor`'s saturation math as an IOPS
     ceiling.
  8. Add `{ kind: 'disk-stall'; iopsFraction: number }` to `FaultSpec` (FEAT-001's union) and apply it
     as a multiplier on effective `diskIops` in `faults.ts`.
  9. Add `disk_saturated` to `EngineEventKind` (rate-limited) and the `iops-saturated` rule to
     `analysis/rules/capacity.ts`.
  10. Author `diskIops` / `diskType` in the Hardware drawer (`dock/drawers/`), and show live disk
      saturation on the server board's hardware platform alongside CPU and NIC.
- **Acceptance & Verification Criteria:**
  - A server with neither `diskIops` nor `diskType` produces byte-identical output for a fixed seed
    (`toBe`), and `diskIoFraction` still reads `diskIo / 100` — the legacy branch is preserved exactly.
  - With a ceiling authored, `ρ_disk <= 1` yields `diskWaitMs === 0` — identical to the unbounded case,
    so authoring a *generous* ceiling changes nothing.
  - Above saturation, `diskWaitMs` matches `BASE_DISK_MS / (1 - overshoot)` **to the digit**, against
    the same formula `poolCheckoutFor` uses — assert against the shared shape, proving reuse.
  - A disk-bound DB (high `diskIoPerRequest`, low `diskIops`) fails on **disk** — rising latency and
    connections — while CPU stays moderate. This is the failure mode the feature exists to make
    reachable.
  - `provisionedIops` on a managed DB now changes behavior, not just price: raising it raises the
    admitted rps ceiling.
  - `disk-stall` at `iopsFraction: 0.1` drives an unsaturated server into disk saturation.
  - `DIVERGENCE GUARD` green; new parallel guard for disk-driven connections green.
  - `iops-saturated` fires above 90% sustained and names the top `diskIoPerRequest` contributors.
  - `bench/enginePerf.bench.test.ts`: < 0.05 ms/step delta.
  - **Live smoke:** set a DB server to `hdd`, drive write load, and watch disk saturation redline
    while CPU sits low — then switch it to `nvme` and watch the bottleneck move. Both themes.

---

### [FEAT-007]: Instance Cold Start

- **Category:** Simulation Fidelity
- **Target Impact:** Medium
- **Affected System Areas:** `src/lib/world/types.ts` (`WorkloadProfile`),
  `worldEngine/hostScheduler.ts`, `worldEngine/index.ts`, `worldEngine/metrics.ts`,
  `worldEngine/flows.ts`, `ServerView` service chips, `az/DatacenterFloor.tsx` LEDs
- **Depends on:** FEAT-001 (fault-driven restarts are how cold start becomes observable)
- **Problem / Gap:** Restart is free and instantaneous. `index.ts:56`'s `OOM_RESTART_MS = 5000`
  returns an instance to the pool after five seconds **at full capacity and full speed**. `coldStart`
  returns zero hits repo-wide.

  Real processes do not come back like that. A JVM restarts into interpreted bytecode and needs
  thousands of invocations before the JIT reaches steady state; a connection pool must re-establish
  every connection; caches (in-process and remote) are empty; lazily-initialised singletons resolve
  on first request. For the first tens of seconds a restarted instance is typically 2–5× slower and
  serves a fraction of its rated capacity.

  This matters beyond realism, because it is the mechanism behind **restart storms** — the failure
  where an overloaded service is killed, comes back cold and slow, is immediately handed its full
  share of traffic by a load balancer that has no idea it is warming, falls over again, and repeats.
  With instantaneous restart, that loop is unreachable: recovery here is always monotonic.

  It also silently props up FEAT-008. An autoscaler whose new instances are useful the instant they
  appear makes scaling look like a solved problem and renders `cooldownSec` meaningless. Cold start
  is what makes the autoscaler's timing a real design decision, which is why it lands first in the
  same wave.

  ⚠ **Do not confuse this with the existing engine warm-up badge.** Audit ISSUE-019 added a UI
  affordance for *engine-level* metric convergence after a stop→edit→start cycle (EMAs, health
  hysteresis, burst credits re-settling). That is about the observer. This feature is about the
  *instance* being genuinely less capable for a while. They are unrelated mechanisms with similar
  names, and an implementer who merges them will produce a badge that lies.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts — WorkloadProfile (additive, optional)
  coldStartMs?: number             // absent ⇒ 0, instant readiness (today's exact behavior)
  warmCapacityFraction?: number    // capacity at t=0 as a fraction of rated; absent ⇒ 0.3
  ```

  **Engine-owned warm-up state**, following the `promotedAt` overlay precedent:
  `warmingUntil: Map<InstanceId, number>`, holding the `simMs` at which the instance reaches full
  capability.

  **Instances are warm at `start()`.** This is deliberate and is the regression floor: a user who
  presses Simulate has, conceptually, already started their fleet. Cold start applies to instances
  that come back or come *new*:
  - the OOM restart path (`index.ts:959-962`),
  - a FEAT-001 `down` fault being cleared,
  - a FEAT-008 scale-out unparking an instance (wired in that feature, not this one).

  **The ramp** — linear in capability over `coldStartMs`:

  ```
  warmth(t)   = clamp01((simMs - startedMs) / coldStartMs)            // 0 cold → 1 warm
  capacity(t) = rated × (warmCapacityFraction + (1 - warmCapacityFraction) × warmth)
  latency(t)  = base / (warmCapacityFraction + (1 - warmCapacityFraction) × warmth)
  ```

  Capacity scales *down* and latency scales *up* by the same factor, which is the correct coupling:
  a cold instance is slow because it is doing more work per request, not because it is throttled.

  **Insertion points, both existing:**
  - Capacity — multiply the instance's entry in `serviceRateByInstance` (`hostScheduler.ts:131`,
    the weighted fair-share water-fill). Applying it *there* rather than at admission means a cold
    instance's unused share is redistributed to warm siblings by the existing work-conserving logic,
    for free.
  - Latency — multiply `effectiveCpuMsByInstance`, which `flows.ts:442` already reads as the p50
    basis. No new latency path.

  **Health during warm-up.** A warming instance publishes `'degraded'`, never `'healthy'` — reusing
  the same lift the starved-instance override at `metrics.ts:305-307` already performs. This is what
  lets a load balancer's health check see it, and it is the hook that makes the restart-storm loop
  demonstrable rather than merely modelled.

  **Perf.** One `Map` lookup and two multiplications per instance per step, skipped entirely when
  `warmingUntil.size === 0` — the common case, since warm-up is transient by construction. Expected:
  **0 ms/step at steady state, < 0.05 ms/step during a mass restart.**
- **Execution Steps for Developer Agent:**
  1. Add `coldStartMs?` and `warmCapacityFraction?` to `WorkloadProfile`
     (`src/lib/world/types.ts:149-172`); normalize as optional in `serializer.ts`. Set sensible
     defaults on the workload presets in `world/serviceDraft.ts` (a `db-sql` preset should carry a
     visibly longer cold start than a `worker`).
  2. In `worldEngine/index.ts`, add `warmingUntil: Map<InstanceId, number>`; populate it in the
     OOM-restart handler (`:959-962`) and on FEAT-001 `down`-fault clear. Leave it empty at `start()`.
  3. Add `warmthOf(instanceId, warmingUntil, simMs, coldStartMs): number` to `hostScheduler.ts` —
     one resolver, called by both the capacity and latency sites so they can never disagree.
  4. Apply the capacity factor to `serviceRateByInstance` inside `stepHost` (`hostScheduler.ts:131`),
     after the water-fill, so redistribution to warm siblings happens through existing logic.
  5. Apply the latency factor to `effectiveCpuMsByInstance` before it reaches `flows.ts:442`.
  6. In `metrics.ts`, lift a warming instance's health to `'degraded'` using the same override shape
     as the starved case (`:305-307`), and publish an additive-optional
     `InstanceMetrics.warmth?: number` (0..1). Log in `contract-drift.md`.
  7. Ensure `routingRuntime.ts`'s health checks see the degraded state so LB target selection reacts —
     this is the link that makes restart storms reachable.
  8. Add `instance_warming` / `instance_warm` to `EngineEventKind`.
  9. Render warm-up in the UI: a ramping fill on the service chip in `ServerView` and a distinct LED
     state on `az/DatacenterFloor.tsx`, driven off the 1 Hz batch, respecting
     `prefers-reduced-motion` (a static partial fill under reduced motion, not a pulse).
  10. Author `coldStartMs` in the service config drawer, defaulting to the preset value.
- **Acceptance & Verification Criteria:**
  - `coldStartMs` absent ⇒ byte-identical engine output for a fixed seed (`toBe`).
  - At `coldStartMs: 30000, warmCapacityFraction: 0.3`, a restarted instance serves ~30% of rated
    capacity at t=0, ~65% at t=15 s, and 100% at t=30 s, with latency tracking the reciprocal.
  - Capacity withheld from a cold instance is **redistributed to warm siblings** by the existing
    water-fill — assert total host throughput does not drop by the full withheld amount.
  - A warming instance publishes `'degraded'`, and `routingRuntime`'s health check observes it.
  - **The restart-storm test:** a single-instance service at 90% CPU, killed, comes back cold, is
    handed full traffic, and re-saturates — producing a second `oom_kill` without any new operator
    action. Under the pre-feature engine this loop does not occur; assert both behaviors.
  - `warmingUntil` clears exactly when warmth reaches 1, and the map is empty at steady state (a leak
    here would make the fast path useless).
  - `DIVERGENCE GUARD` green — cold start changes capacity, therefore connections, therefore RAM.
  - `bench/enginePerf.bench.test.ts`: no regression at steady state.
  - **Live smoke:** kill a service and watch its chip refill gradually while its latency chip decays
    back to baseline — not an instant snap. Both themes, and static under reduced motion.

---

### [FEAT-008]: Horizontal Autoscaling Policy

- **Category:** System Configurability
- **Target Impact:** High
- **Affected System Areas:** `src/lib/world/types.ts` (`Placement`), `src/lib/world/compileWorld.ts`,
  new `worldEngine/autoscale.ts`, `worldEngine/index.ts`, `worldEngine/hostScheduler.ts`,
  `worldEngine/routingRuntime.ts`, `worldEngine/metrics.ts`, `costModelV2.ts`,
  `analysis/rules/capacity.ts`, `dock/drawers/Placement`
- **Depends on:** FEAT-007 (scale-out must not be instantly useful), Wave 1
- **Problem / Gap:** Fleet size is **immutable for the life of a run**. `Placement.count`
  (`world/types.ts:258`) is a static integer, expanded once by `compileWorld.ts:27`
  (`for (let i = 0; i < pl.count; i++)`) and frozen thereafter. `autoscal` returns zero hits repo-wide.

  Every modern deployment target — ASG, HPA, Cloud Run, ECS service — scales on load. Its absence
  here has three compounding consequences:

  1. **Every capacity finding is a static-provisioning finding.** The analysis rules can only ever
     say "you are under-provisioned for peak," never "your scaling policy reacts too slowly," which
     is the far more common real defect.
  2. **Cost is a constant.** This is the load-bearing one for the FinOps framing. If fleet size never
     moves, hourly cost never moves, and FEAT-010's cost-velocity chart is a flat line by
     construction. **Autoscaling is what makes cost a dynamic quantity**, and therefore what makes
     cost/performance trade-offs expressible at all.
  3. **The interesting failures are unreachable** — scaling into a downstream bottleneck (more app
     servers, same database, now with more connections), thrash from too-tight thresholds, and
     hitting a `maxCount` ceiling mid-incident.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts — Placement (additive, optional)
  export interface AutoscalePolicy {
    minCount: number
    maxCount: number
    targetCpuPercent: number      // 0..100, the HPA-style setpoint
    scaleUpCooldownSec: number    // typically short (30-60)
    scaleDownCooldownSec: number  // typically long (300+) — asymmetry prevents thrash
    scaleStep?: number            // max instances added/removed per decision; absent ⇒ unbounded
  }
  // Placement gains:  autoscale?: AutoscalePolicy
  ```

  ⚠ **The central design constraint.** `doc` and `compiled` are frozen at `start()`, and roughly ten
  prebuilt lookup indexes depend on that — `index.ts:322` and `:326` say so in comments
  (`serversByAz`, `azsByRegion`, `instancesByServer`, the dependency index, the byte/connection
  maps). **Autoscaling must not mutate the doc and must not recompile mid-run.**

  *Alternative considered and rejected:* have the engine synthesize new `ServiceInstance` objects at
  runtime. This invalidates every frozen index, requires an incremental recompile of `compiled.paths`
  (firewall and network-isolation verdicts are per-instance), and would turn a frozen contract into a
  mutable one. The cost is not worth it.

  **The design: compile the envelope, park the surplus.**

  - `compileWorld` emits `autoscale ? maxCount : count` instances for a placement — the full possible
    envelope, computed once, statically. All existing indexes stay valid because the instance set
    never changes during a run.
  - The engine owns `desiredCount: Map<PlacementId, number>`, initialized to
    `autoscale?.minCount ?? count`.
  - A `runningSetResolver(compiled, desiredCount)` returns `(instanceId) => boolean`, treating any
    instance with `indexInPlacement >= desiredCount` as **parked**. This is precisely the
    `effectiveRoleResolver` / `promotedAt` pattern (`failover.ts:303`) applied to a running-set
    instead of a role-set, including its `size === 0` fast path.
  - A parked instance: is excluded from LB target selection (`routingRuntime.ts`), is omitted from
    `InstanceLoad[]` so it contributes **no CPU and no RAM** (`hostScheduler.ts`), is omitted from
    published `MetricsBatch.instances`, and **accrues no cost**.

  ⚠ **This is the one sanctioned break of the regression floor, and it is a semantic break, not a
  type break.** A world with no `autoscale` authored compiles to exactly the same instances as before
  and simulates byte-identically. What changes is an *invariant*: it is no longer true that
  "every instance in `compiled.instances` is running." **Every consumer of `compiled.instances` must
  be audited** — the analysis rules (all three families iterate it), the cost model, the AZ floor,
  the connections graph, the LLM review context builder, and the AI chat digest. Consumers that mean
  "running" must consult the resolver; consumers that mean "possible" (capacity planning, the
  topology view) should keep iterating the full set. Enumerate the audit in the execution steps and
  do not treat it as incidental — this is the single largest source of risk in the spec.

  **The control loop** — evaluated once per `min(cooldown)` boundary, not per step:

  ```
  observedCpu = mean(cpuCoresUsed / vcpuShare) over RUNNING instances of the placement
  ratio      = observedCpu / (targetCpuPercent / 100)
  proposed   = ceil(desiredCount × ratio)
  next       = clamp(proposed, minCount, maxCount)                       // then clamped by scaleStep
  ```

  Standard HPA arithmetic, deliberately: it is the algorithm users will recognize, and its
  pathologies (thrash near the setpoint, slow reaction under a fast ramp) are exactly the ones worth
  teaching. Direction-asymmetric cooldowns are the standard mitigation and are authored, not hidden.

  **Interaction with FEAT-007 (why the ordering matters).** An unparked instance is registered in
  `warmingUntil` and starts cold. Scale-out therefore does **not** help immediately, the autoscaler
  may over-provision while waiting, and `scaleUpCooldownSec` becomes a genuine design decision rather
  than a decorative field.

  **Scale-in must drain, not kill.** A parked instance stops receiving *new* traffic first; its
  in-flight connections are allowed to complete over a drain window. Reuse `failover.ts`'s existing
  `drainFactor` / `drainUntil` machinery (`failover.ts:52`) rather than writing a second drain path.

  **Cost must follow the running set.** `computeWorldCost` (`costModelV2.ts:189`) takes
  `(doc, world, managed)` and derives compute cost from the **doc**, which knows nothing about
  `desiredCount`. Add an additive-optional `MetricsBatch.runningByPlacement?: Record<PlacementId,
  number>`, published by `metrics.ts`, and have `computeWorldCost` prefer it when present. Without
  this wiring the headline number stays constant while the fleet moves — the exact display/enforcement
  divergence this repo keeps having.

  **Analysis.** `autoscale-ceiling-reached` (capacity rules) fires when a placement sits at
  `maxCount` while above its CPU target — the "you are out of runway" finding. A companion
  `autoscale-thrash` fires when `desiredCount` changes direction more than N times in a window.

  **Perf.** The control loop runs on a cooldown boundary (seconds), not per step. The per-step cost is
  one resolver call per instance, with the `desiredCount`-unchanged fast path — the same shape
  `effectiveRoleResolver` already uses. Expected: **< 0.1 ms/step at ~2,000 instances**, and
  **0 ms** for worlds with no autoscaling authored. Note that `maxCount` envelopes make `compiled`
  larger, so bench with a realistic envelope, not with `minCount`.
- **Execution Steps for Developer Agent:**
  1. Add `AutoscalePolicy` to `src/lib/world/types.ts`; add `autoscale?` to `Placement` (`:254-261`);
     normalize as optional in `serializer.ts`.
  2. In `compileWorld.ts:27`, expand to `pl.autoscale ? pl.autoscale.maxCount : pl.count`. Add a
     compile finding when `minCount > maxCount` or `count` is outside `[minCount, maxCount]`.
  3. Create `src/lib/worldEngine/autoscale.ts` — pure: `AutoscaleState`, `createAutoscaleState(doc)`,
     `runningSetResolver(compiled, desiredCount)` (mirroring `effectiveRoleResolver`'s shape and fast
     path), and `evaluatePolicy(placement, observedCpu, state, simMs)`.
  4. **Audit every consumer of `compiled.instances`** and classify each as "running" or "possible":
     `analysis/rules/{structural,network,capacity}.ts`, `costModelV2.ts`, `az/DatacenterFloor.tsx` +
     `floorData.ts`, `connections/`, `panels/TopologyPanel`, `llmReview.ts`, `aiChat/context.ts`,
     `entityNav.ts`. Route the "running" set through the resolver. **List the outcome of this audit
     in the PR description** — it is the feature's main risk surface.
  5. In `worldEngine/index.ts`, hold `AutoscaleState`; exclude parked instances when building
     `InstanceLoad[]` for `stepHost`; run `evaluatePolicy` on cooldown boundaries.
  6. Exclude parked instances from LB target selection in `routingRuntime.ts`.
  7. Register newly-unparked instances in FEAT-007's `warmingUntil` so scale-out starts cold.
  8. Implement drain-on-scale-in by reusing `failover.ts`'s `drainFactor`/`drainUntil` — do not add a
     second drain implementation.
  9. In `metrics.ts`, omit parked instances from `MetricsBatch.instances` and publish
     `runningByPlacement`. Log in `contract-drift.md`.
  10. In `costModelV2.ts`, prefer `runningByPlacement` over `Placement.count` when present; keep the
      doc-only path for the no-metrics case (the Cost tab renders before a run starts).
  11. Add `scale_out` / `scale_in` / `autoscale_ceiling` to `EngineEventKind`.
  12. Add `autoscale-ceiling-reached` and `autoscale-thrash` to `analysis/rules/capacity.ts`.
  13. Author the policy in the placement drawer (`dock/drawers/`); show live
      `desired / running / max` on the placement's dock row and a scale marker on the region timeline.
- **Acceptance & Verification Criteria:**
  - A placement with no `autoscale` compiles to exactly `count` instances and simulates
    byte-identically for a fixed seed (`toBe`) — the floor holds for every existing world.
  - With `autoscale` authored, `compiled.instances` contains `maxCount` entries while
    `MetricsBatch.instances` contains only `desiredCount` — assert both, so the envelope/running-set
    split is explicit.
  - Parked instances contribute **zero** CPU, **zero** RAM, and **zero** cost: assert host
    `ramUsedMb` and `computeWorldCost().monthlyUsd` are identical to a hand-built world containing
    only the running instances.
  - Sustained load above `targetCpuPercent` scales out, respecting `scaleUpCooldownSec` and
    `scaleStep`; load below it scales in after `scaleDownCooldownSec`; neither exceeds
    `[minCount, maxCount]`.
  - **The asymmetry test:** identical policies differing only in `scaleDownCooldownSec` produce
    materially different thrash counts under an oscillating load — proving the knob is real.
  - **The cold-start interaction test:** with `coldStartMs: 60000`, a scale-out event does not reduce
    p99 for ~60 s, and the autoscaler may over-provision in the interim. This is correct behavior and
    must be asserted, not treated as a bug.
  - Scale-in **drains** rather than dropping: in-flight connections on a scaled-in instance complete;
    `errorRate` does not spike at scale-in.
  - `autoscale-ceiling-reached` fires at `maxCount` under sustained overload.
  - `DIVERGENCE GUARD` green; the consumer audit from step 4 is complete and documented.
  - `bench/enginePerf.bench.test.ts`: < 0.1 ms/step delta, benchmarked at a realistic `maxCount`
    envelope rather than at `minCount`.
  - **Live smoke:** author an autoscaled tier with a Black Friday scenario (FEAT-003); watch instance
    count and hourly cost climb together during the ramp and recede after — the FinOps story this
    whole spec is aimed at. Both themes.

---

### [FEAT-009]: "Signals" — Time-Series APM Panel

- **Category:** UX & Observability
- **Target Impact:** High
- **Affected System Areas:** new `src/app/world/panels/SignalsPanel.tsx` + `signalsSeries.ts`,
  `worldEngine/metrics.ts` (`p90Ms`), `worldEngine/types.ts`, `app/store/simulation.store.ts`,
  `app/store/ui.store.ts` (`PanelTab`), `dock/scope.ts`, `panels/WorldPanel.tsx` (**hub file**)
- **Depends on:** nothing — this can land at any point; it is sequenced after Waves 1–3 only so it
  can chart the state they introduce.
- **Problem / Gap:** **The engine retains five minutes of complete history and the UI shows only the
  current instant.** `replay.ts:18` maintains `createReplayBuffer(cap = 300)` — a ring of 300 full
  `MetricsBatch` snapshots at 1 Hz, each holding the entire instance→server→AZ→region→world pyramid.
  Every surface in the app reads `latestBatch` (or `scrubBatch ?? latestBatch`) and renders a single
  number.

  This is the largest UX gap in the product, and it is almost entirely a *rendering* gap: the data is
  already there, already deterministic, already scrubbable. What is missing is the chart.

  The consequence is that the app cannot answer the questions operators actually ask. Not "what is
  p99 now" but "when did p99 start climbing, and what else moved at that moment?" A single instant
  cannot show a trend, a spike, a correlation, or a recovery — and every feature in Waves 1–3 of this
  spec produces behavior whose entire meaning is in its *shape over time*: the cache herd's decay,
  replication lag accumulating, an autoscaler's reaction delay, a cold instance warming.

  There is also a specific missing statistic. `InstanceMetrics` publishes `p50Ms` and `p99Ms`
  (`worldEngine/types.ts:30-31`) with nothing between them. p99 is dominated by outliers and p50 hides
  everything interesting; **p90 is the percentile most SLOs are actually written against.** It is a
  one-line addition — `metrics.ts:292,296` already call `percentile(sorted, p)` with an arbitrary `p`.
- **Proposed Technical Design & Models:**

  **Data source: the existing replay ring.** `WorldEngineApi.getReplayFrames()`
  (`worldEngine/types.ts:278`) returns `ReplayFrame[]` — `{ simMs, batch, events }`. Per the engine
  seam, `simulation.store.ts` is the only permitted caller; the panel reads the store. `ScrubberV2`
  already consumes these frames — reuse its access path rather than adding a second one.

  **`p90Ms`.** Add to `InstanceMetrics` beside `p99Ms`, computed as `percentile(sorted, 0.9)`.
  **Publish it un-smoothed**, following `p99Ms`'s convention rather than `p50Ms`'s: audit ISSUE-037
  established that EMA-smoothing a tail statistic attenuates a 1 s spike to ~30% of its size, hiding
  exactly the transients a tail metric exists to show. Aggregate it up the AZ/region/world pyramid
  using the same rps-weighted mean the existing `p50` rollup uses (`metrics.ts:379-382`).

  **Series extraction — pure, testable, no React:**

  ```ts
  // src/app/world/panels/signalsSeries.ts
  export type SignalKey =
    | 'rps' | 'errorRate' | 'p50Ms' | 'p90Ms' | 'p99Ms'
    | 'activeConnections' | 'cpu' | 'queueDepth' | 'ramMb'

  export function extractSeries(
    frames: ReplayFrame[], scope: DockScope, key: SignalKey,
  ): { simMs: number; value: number }[]

  export function downsample(
    points: { simMs: number; value: number }[], targetWidth: number,
  ): { simMs: number; min: number; max: number; value: number }[]
  ```

  `extractSeries` resolves the scope against the right pyramid level — reusing `dock/scope.ts`'s
  existing `DockScope` (`scope.ts:12`) so Signals works identically at world, region, AZ, and server
  scope with no per-scope special-casing.

  **Downsampling must preserve extrema, not average them.** 300 points into a ~320 px panel is
  near 1:1, but at 4× time scale or with a future longer ring it matters. Bucket by pixel column and
  keep `{ min, max }` per bucket, rendering a thin band between them with the mean as the line. A
  mean-only downsample silently deletes the latency spike that is the entire reason to look at the
  chart.

  **Perf — the explicit 60 FPS constraint.** Series are recomputed **only** on the 1 Hz metrics batch
  and on a scrub change, never per animation frame. Memoize on
  `(frames.length, lastFrameSimMs, scope key, signal key, panel width)`. The output is a plain SVG
  `<polyline>` per series plus one `<path>` for the min/max band — no canvas, no chart library, no
  per-frame layout. Rendering cost is O(panel width), bounded at a few hundred points regardless of
  ring size. **Budget: < 2 ms per 1 Hz update; 0 ms per animation frame.**

  **Interaction.** Clicking or dragging on the chart sets `simulation.store`'s existing
  `setScrubIndex(i, frames)` (`simulation.store.ts:160`) — the chart becomes a second scrubber, and
  every other view in the app follows it for free because they already read
  `scrubBatch ?? latestBatch`. A vertical playhead marks the current scrub position. Engine events in
  the window render as small markers on the time axis (`ReplayFrame.events` already carries them), so
  "p99 climbed *here*, and here is the `breaker_open` that explains it" is one glance.

  **Layout.** A `signals` tab available at **every** scope — added to both `WORLD_TABS` and
  `SCOPED_TABS` in `dock/scope.ts:62-63`. Stacked small-multiples (one row per signal, shared x-axis)
  rather than a single multi-axis chart: shared-axis small multiples make correlation across
  different units legible, which is the whole point.

  **Theme and motion.** All colors from `var(--color-*)`; series colors from `CATEGORY_COLORS` so
  they stay distinct in both themes. The playhead does not animate. No infinite animations, so
  `prefers-reduced-motion` requires no special case beyond the standard check.
- **Execution Steps for Developer Agent:**
  1. Add `p90Ms: number` to `InstanceMetrics` (`worldEngine/types.ts:26-50`) and the corresponding
     percentile to `AzMetrics`/`RegionMetrics`/`WorldMetrics` rollups. Compute in `metrics.ts` as
     `percentile(sorted, 0.9)` beside `:296`, **un-smoothed**. Log in `contract-drift.md` (additive).
  2. Aggregate `p90` up the pyramid with the same rps-weighted mean as the existing `p50` rollup
     (`metrics.ts:379-382`) — one shape, not a new one.
  3. Expose replay frames through `simulation.store.ts` if `ScrubberV2` does not already select them
     in a reusable way; do **not** call `worldEngine.getReplayFrames()` from a view.
  4. Create `src/app/world/panels/signalsSeries.ts` with `extractSeries` and `downsample` as
     specified — pure, no React imports, unit-testable in the node env.
  5. Create `src/app/world/panels/SignalsPanel.tsx`: stacked small-multiples, SVG polylines plus a
     min/max band, a playhead, and event markers from `ReplayFrame.events`.
  6. Memoize series on `(frames.length, lastFrameSimMs, scope, signal, width)`; assert in a test that
     the extractor is not invoked on a re-render with unchanged inputs.
  7. Register `'signals'` in `ui.store.ts`'s `PanelTab` union (`:33`), add it to both `WORLD_TABS`
     and `SCOPED_TABS` (`dock/scope.ts:62-63`), and wire the tab body in `panels/WorldPanel.tsx`
     beside the existing `analysis`/`events`/`cost` cases (`:328-330`, `:351-355`).
     **`WorldPanel.tsx` is a hub file — edit sequentially.**
  8. Wire chart interaction to `setScrubIndex`, and confirm the globe/region/AZ/server views follow
     the scrub because they already read `scrubBatch ?? latestBatch`.
  9. Add a signature header for the tab in `WorldPanel.tsx`'s header switch, matching the existing
     per-tab glyph/accent convention.
- **Acceptance & Verification Criteria:**
  - `p90Ms` sits between `p50Ms` and `p99Ms` for every instance in every batch — a property test over
    a simulated run.
  - `p90Ms` is **not** EMA-smoothed: a 1 s injected latency spike appears at full magnitude, matching
    `p99Ms`'s established behavior rather than `p50Ms`'s.
  - `extractSeries` returns one point per frame for a scope with data and an empty array for a scope
    with none (no crash on an empty AZ) — unit-tested without React.
  - `downsample` **preserves extrema**: a single-frame spike in a 300-point series survives
    downsampling to 50 columns. Assert the spike's magnitude, not just its presence.
  - Series recompute exactly once per 1 Hz batch and once per scrub change — asserted with a spy;
    zero recomputes on unrelated re-renders.
  - Clicking the chart sets `scrubIndex`, and the AZ floor / server board follow to the same instant.
  - Engine event markers align with the frame in which the event was emitted.
  - The panel renders correctly at world, region, AZ, and server scope with no per-scope branching in
    the extractor.
  - No new console errors; no hardcoded hexes; correct in dark and light; no infinite animations.
  - **Live smoke:** run a scenario with a regional failure, open Signals at region scope, and read the
    story off the chart — error rate steps up, p99 spikes, a `failover_started` marker sits at the
    inflection, connections drain. Then scrub back to the spike and watch every other view follow.

---

### [FEAT-010]: Cost Velocity & Attribution

- **Category:** UX & Observability
- **Target Impact:** High
- **Affected System Areas:** `src/app/world/CostTab.tsx` (**note: at `app/world/`, not
  `app/world/panels/`**), `src/lib/costModelV2.ts`, `src/lib/cloudRegistry.ts`,
  `panels/signalsSeries.ts`, `worldEngine/metrics.ts`
- **Depends on:** FEAT-009 (series extraction + downsampling), FEAT-008 (a fleet that moves is what
  makes velocity non-constant)
- **Problem / Gap:** Cost is a **single monthly scalar with no time dimension and no attribution**.
  `CostTab.tsx` renders `cost.monthlyUsd`, a per-region list, a per-AZ list, and egress line items —
  all recomputed from the current batch, all instantaneous.

  For a tool aiming at FinOps, three things are missing and each blocks a question users have:

  1. **No $/hr velocity.** "$4,182/mo" is a projection of *this instant* held constant forever. It
     cannot show that the last ten minutes cost 3× the previous ten, which is the actual signal
     during an incident or a traffic spike.
  2. **No per-service attribution.** Cost is broken down by *location* (region, AZ) but never by
     *what is running*. "Which service costs the most" — the first question in every cost review — is
     unanswerable. This is showback, and its absence is why the current tab is an infrastructure
     inventory rather than a FinOps surface.
  3. **No incident cost.** The single most valuable number a chaos-plus-cost simulator can produce is
     "that outage cost you $840" — the marginal spend between two moments, over and above the
     counterfactual baseline. Nothing in the app can express a *delta* in cost at all.
- **Proposed Technical Design & Models:**

  **$/hr as the primary unit; monthly as the projection.** `WorldCostResult.monthlyUsd`
  (`costModelV2.ts:49`) stays as-is for compatibility. Add `hourlyUsd` alongside it (`monthlyUsd /
  730`, the hours-per-month constant the model already implies), and lead the tab with $/hr, since
  that is the quantity that actually varies during a run.

  **The cost series, and its performance problem.** `computeWorldCost(doc, world, managed)`
  (`costModelV2.ts:189`) walks every server, managed service, and load balancer. Calling it across
  300 replay frames on every 1 Hz tick is ~300× the per-tick cost of a function that was designed to
  run once per second. **Memoize per frame index** in a `Map<number, WorldCostResult>` keyed by frame
  identity, invalidated when the doc changes (the doc is frozen during a run, so in practice the
  cache is only ever appended to — one new frame per second, one new computation per second). State
  this explicitly; a naive implementation here will visibly degrade the app.

  **Per-service attribution (showback).** A server's hourly cost must be divided among the instances
  resident on it. Use the same weight the scheduler uses for capacity — `WorkloadProfile.cpuShares`
  (`world/types.ts:154`, absent ⇒ 1) — so the cost split and the capacity split tell one story:

  ```
  instanceCost = serverHourlyCost × (cpuShares_i / Σ cpuShares_on_server)
  blueprintCost = Σ instanceCost over running instances of that blueprint
  ```

  Managed services attribute directly (they are already priced per service). Egress attributes to the
  **calling** blueprint via the flow solver's existing per-dependency byte totals (`depBytesById`) —
  do not re-derive byte attribution; audit ISSUE-001 is the cautionary tale for deriving the same
  quantity twice. Parked instances (FEAT-008) contribute nothing, via `runningByPlacement`.

  **Incident cost.** Given a scrub range `[a, b]`:

  ```
  actualUsd     = Σ over frames in [a,b] of hourlyUsd(frame) × frameSec / 3600
  baselineUsd   = hourlyUsd(a) × (b - a) / 3600           // counterfactual: rate at 'a' held
  incidentUsd   = actualUsd - baselineUsd                  // marginal spend, may be negative
  ```

  Negative is meaningful and must be shown as such: an outage that sheds load *saves* money while
  failing customers, and that trade is precisely what the number is for. Present it alongside the
  error/latency deltas over the same window so cost is never read in isolation.

  **UI.** The Cost tab gains: a $/hr headline with a sparkline (reusing FEAT-009's `extractSeries` +
  `downsample`, not a second charting path), a "By service" section ranked by cost, and an
  "Incident cost" readout bound to the current scrub selection. Every money value renders in
  `var(--color-price)` — the price law admits no exceptions, and this tab is where it is most likely
  to be violated by a delta styled as a status color. A negative delta uses the price token with a
  `−` glyph, not `var(--color-success)`.

  **Perf.** With memoization, the marginal cost is one `computeWorldCost` per second — what the tab
  already pays today. Sparkline rendering is FEAT-009's, already bounded. **Budget: < 3 ms per 1 Hz
  update, 0 ms per animation frame.**
- **Execution Steps for Developer Agent:**
  1. Add `hourlyUsd` to `WorldCostResult` (`costModelV2.ts:48-60`) and populate it beside
     `monthlyUsd` (`:267-272`).
  2. Add `attributeByBlueprint(doc, compiled, batch, runningByPlacement)` to `costModelV2.ts`,
     implementing the `cpuShares`-weighted split above and sourcing egress from the flow solver's
     existing per-dependency byte totals.
  3. Add a frame-indexed memo for `computeWorldCost` — a `Map<frameIndex, WorldCostResult>` in the
     Cost tab's module scope or a small `costSeries.ts`, invalidated on doc identity change. **Do not
     recompute 300 frames per tick.**
  4. Add `costUsdPerHour` as a `SignalKey` in `panels/signalsSeries.ts` so cost charts through the
     same extractor and downsampler as every other signal — one charting path, not two.
  5. Rewrite `src/app/world/CostTab.tsx`: $/hr headline + sparkline, monthly projection secondary,
     existing region/AZ/egress sections retained, new "By service" ranked section.
  6. Add the "Incident cost" readout, bound to the scrub range, showing `incidentUsd` beside the
     error-rate and p99 deltas over the same window.
  7. Verify every money value uses `var(--color-price)`, including negative deltas — add a test that
     greps the rendered tree for a `$` under any other color token if the existing suite has a
     precedent for it; otherwise assert on the style prop directly.
  8. Update `docs/module-boundaries.md` for `CostTab.tsx`'s expanded role and the new `costSeries`
     module.
- **Acceptance & Verification Criteria:**
  - `hourlyUsd × 730 === monthlyUsd` exactly, for every world — one number, two units, never two
    independent computations.
  - Per-service attribution **sums to the compute total**: `Σ blueprintCost + managedCost + egress`
    equals `monthlyUsd` to floating-point tolerance. An attribution that does not reconcile is worse
    than none.
  - `cpuShares`-weighted split is correct: two instances on one server at shares 1 and 3 receive 25%
    and 75% of that server's cost.
  - Parked instances (FEAT-008) contribute zero — assert against a world scaled to `minCount`.
  - **The memoization test:** rendering the tab across 300 frames calls `computeWorldCost` at most
    once per *new* frame, not once per frame per render. Assert with a spy — this is the specific
    performance trap the design exists to avoid.
  - **The incident-cost test:** run a scenario with a regional failure and a scale-out; assert
    `incidentUsd` over the incident window equals `actual − baseline` and is positive when the
    autoscaler responds, negative when load is shed without scaling.
  - Every money value renders in `var(--color-price)`, including negatives; verified in dark and light.
  - **Live smoke:** run a Black Friday scenario, scrub across the ramp, and read the incident cost of
    the autoscaling response — the headline FinOps deliverable of this spec.

---

### [FEAT-011]: Baseline Capture & A/B Comparison

- **Category:** UX & Observability
- **Target Impact:** High
- **Affected System Areas:** new `src/app/store/baseline.store.ts`, new
  `src/app/world/panels/ComparePanel.tsx`, new `src/lib/runSummary.ts`,
  `src/lib/world/types.ts` (`WorldDoc.slo`), `app/store/simulation.store.ts`, `SimControls.tsx`
- **Depends on:** FEAT-003 (deterministic scenarios — **without this the feature is meaningless**),
  FEAT-010 (cost aggregates)
- **Problem / Gap:** There is **no way to compare two runs**. `baseline` appears in the codebase only
  in unrelated senses (baseline latency floors, VPS credit baselines). A user can change their
  architecture and re-run, but the previous run's numbers are gone — held nowhere except in the
  user's memory of a chip they glanced at.

  This caps what the tool can conclude. Every valuable statement about an architecture is
  comparative: "adding a read replica cut p99 by 40% and raised cost 18%"; "variant B is 12% cheaper
  but breaches its p99 SLO under the regional-failure scenario." The app can currently produce the
  left side of each of those sentences, never the right, and never the comparison that gives either
  one meaning.

  There is also nothing to breach. The app has no notion of an objective — no SLO — so "worse" has no
  definition beyond a number moving. A comparison surface needs a target to compare against.

  **This is why FEAT-003 is a hard prerequisite.** Comparing two runs under two hand-clicked,
  differently-timed chaos sequences measures the operator's reflexes, not the architecture. A
  comparison is only sound when scenario, seed, and duration are identical — and FEAT-003 is what
  makes that possible.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts — authored objectives (additive, optional, serialized)
  export interface SloTargets {
    p99Ms?: number
    errorRate?: number        // 0..1
    availabilityPercent?: number
    monthlyUsdBudget?: number
  }
  // WorldDoc gains:  slo?: SloTargets

  // src/lib/runSummary.ts — derived, ephemeral, NEVER serialized into .scalemap
  export interface RunSummary {
    id: string
    label: string
    capturedIso: string
    scenarioId: string | null
    seed: number
    docFingerprint: string          // structural hash — what makes a comparison honest
    durationMs: number
    latency: { p50Ms: number; p90Ms: number; p99Ms: number }   // time-weighted means
    errorRate: number
    peakRps: number
    cost: { meanHourlyUsd: number; totalUsd: number; peakHourlyUsd: number }
    slo: { target: SloTargets; breaches: { key: keyof SloTargets; worst: number; breachedSec: number }[] }
    eventCounts: Record<EngineEventKind, number>
  }
  ```

  **`docFingerprint` is the integrity mechanism.** A stable structural hash over the compiled world
  (instance count per blueprint, dependency edges, placements, server specs) — deliberately *not* a
  hash of the whole doc, so cosmetic edits like renaming a region do not invalidate a comparison. The
  compare view uses it to classify a pairing: same scenario + same seed + different fingerprint is a
  **valid A/B**; anything else is shown with an explicit warning banner naming what differs. The tool
  must never present an unsound comparison as a clean one — a plausible-looking but invalid diff is
  worse than refusing to draw it.

  **Capture.** A `RunSummary` is built from the replay ring plus the durable event log at the moment
  of capture, in `src/lib/runSummary.ts` (pure — takes frames and a doc, returns a summary; no store
  or engine imports, matching `managedDbRuntime.ts`'s precedent). Latency aggregates are
  **time-weighted**, not means-of-means: a 10 s spike in a 300 s run must not carry the same weight as
  290 s of calm.

  **Storage — explicitly not in `.scalemap`.** Cross-Cutting Constraint 15 forbids derived state in
  the file, and a `RunSummary` is derived by construction. Baselines live in a new session-scoped
  `baseline.store.ts` (Zustand, one store per domain — the established pattern), with an **explicit**
  export to a `.scalemap-runs.json` sidecar and a matching import. Explicit is right here: a user
  choosing to keep a benchmark is making a decision, and silent persistence of ephemeral run data is
  how files rot.

  **The compare view.** Two summaries side by side: aligned metric rows, absolute and percentage
  deltas, direction-aware coloring (lower latency is good; lower cost is good; lower rps may be bad),
  SLO breach badges per side, and an event-count diff that surfaces categorical differences ("variant
  B: 3 `oom_kill`, 0 in A"). Deltas below a noise floor render as "no change" rather than as
  meaningless precision. Money in `var(--color-price)`, always.

  **Perf.** Capture is a one-shot walk of ≤300 frames on an explicit user action — not on a tick.
  **Zero steady-state cost.** The compare view renders static numbers.
- **Execution Steps for Developer Agent:**
  1. Add `SloTargets` to `src/lib/world/types.ts` and `slo?: SloTargets` to `WorldDoc`; normalize as
     optional in `serializer.ts`. This one **is** authored config and belongs in the file.
  2. Create `src/lib/runSummary.ts`: `buildRunSummary(frames, events, doc, compiled, scenario, seed)`
     and `docFingerprint(compiled)`. Pure, no store/engine imports. Time-weight all latency aggregates.
  3. Create `src/app/store/baseline.store.ts`: `summaries: RunSummary[]`, `capture()`, `remove()`,
     `exportJson()`, `importJson()`, plus `compareA`/`compareB` selection. Session-scoped; **never
     touched by `serializer.ts`.**
  4. Add a "Capture baseline" action to `SimControls.tsx`, enabled only when a run has produced
     frames. Reach replay frames through `simulation.store.ts` (engine seam), never the engine.
  5. Create `src/app/world/panels/ComparePanel.tsx`: two-column diff, direction-aware deltas, SLO
     badges, event-count diff, and the **validity banner** driven by scenario/seed/fingerprint
     agreement.
  6. Register a `'compare'` tab in `ui.store.ts`'s `PanelTab` and in `dock/scope.ts`'s `WORLD_TABS`
     (world scope only — a comparison is a whole-world statement). Wire it in `WorldPanel.tsx`
     (**hub file, edit sequentially**).
  7. Implement SLO evaluation in `runSummary.ts`: per target, the worst observed value and total
     seconds in breach. Surface breaches as badges, not as free-text.
  8. Add JSON export/import via the existing Tauri file-dialog wrappers in `src/lib/tauri.ts` — with
     the `tauriMock.ts` fallback so browser-only dev works.
  9. Update `CLAUDE.md`'s Known Issues / Roadmap: baselines are session + explicit-export only,
     confirming that "LLM review persistence" and this are separate, both still absent from
     `.scalemap`.
- **Acceptance & Verification Criteria:**
  - **The determinism precondition holds:** two captures of the same scenario at the same seed against
    the same doc produce `RunSummary` objects that are equal on every metric field. If this fails,
    FEAT-003 is not correctly implemented and this feature must not ship.
  - `docFingerprint` is stable across cosmetic edits (renaming a region, moving a node in the
    connections layout) and changes when structure changes (adding a replica, changing server specs).
  - A comparison of two runs with different scenarios or seeds renders the **validity warning**, and
    the deltas are visibly marked as unsound.
  - Latency aggregates are time-weighted: a run with a 10 s spike in 300 s reports a p99 mean closer
    to the calm value than a naive mean-of-frames would. Assert against a hand-built frame sequence.
  - SLO breaches report both worst value and seconds-in-breach; a run inside its targets reports zero
    breaches and no badges.
  - Baselines survive an export → import round trip byte-for-byte, and **never** appear in a saved
    `.scalemap` — assert by saving a world with baselines captured and diffing the serialized output
    against the same world without them.
  - Money in `var(--color-price)`; deltas direction-aware; correct in dark and light.
  - **Live smoke:** run the regional-failure scenario, capture a baseline, add a read replica, re-run
    the same scenario at the same seed, and read the sentence off the compare panel — "p99 down 38%,
    cost up 22%, 0 SLO breaches vs 2."

---

### [FEAT-012]: Environment & Vendor Profiles

- **Category:** System Configurability
- **Target Impact:** Medium
- **Affected System Areas:** `src/lib/world/types.ts` (`WorldDoc.environments`, `Placement`),
  `src/lib/world/compileWorld.ts`, `src/lib/serializer.ts`, `src/lib/cloudRegistry.ts`,
  `worldEngine/routingRuntime.ts`, `panels/TopologyPanel`, `SettingsModal.tsx`
- **Problem / Gap:** Three related gaps, all about a world being **one fixed configuration**.

  1. **No environments.** A world is a single sizing. Modelling "the same architecture at staging
     scale and at production scale" means maintaining two `.scalemap` files that drift apart
     immediately. The interesting question — "does this topology *survive* being scaled down 10×, and
     what does it cost at each size?" — cannot be asked.
  2. **Vendor selection is per-service only.** `cloudRegistry.ts` carries per-provider pricing and
     egress tables, but `ManagedService.provider` (`world/types.ts:272`) is the only thing that
     selects from them. There is no world-level "price this architecture on GCP instead of AWS,"
     which is a first-order FinOps question and is nearly free given the tables already exist.
  3. **`'canary'` is dead code.** `PlacementRole = 'primary' | 'replica' | 'canary'`
     (`world/types.ts:233`) — and `'canary'` is referenced **nowhere else in `src/`**. It compiles,
     it is selectable in the type, and it does absolutely nothing. Progressive delivery — send 5% of
     traffic to a new version and watch its error rate — is one of the most common real deployment
     patterns and one of the most instructive to simulate.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts (additive, optional, serialized — all authored config)
  export interface Environment {
    id: string
    label: string                                   // 'staging' | 'production' | anything
    serverCountFactor?: number                      // scales replica-style placements
    populationRpsFactor?: number                    // scales every population's peakRps
    placementCountOverrides?: Record<PlacementId, number>
    instanceClassOverrides?: Record<ServerId, string>   // catalogId swap
  }
  // WorldDoc gains:  environments?: Record<string, Environment>
  //                  activeEnvironmentId?: string
  //                  cloudProfile?: 'generic' | 'aws' | 'gcp' | 'azure'
  // Placement gains:  canaryWeight?: number         // 0..1 traffic share for role 'canary'
  ```

  **Environments apply at compile time, which is the only correct seam.** `compileWorld(doc)` reads
  `activeEnvironmentId` and applies the overlay while expanding placements and resolving specs. Every
  downstream consumer — engine, views, analysis, cost — reads `compiled` and therefore sees the
  active environment automatically, with **zero** changes anywhere else. This is the compiled-world
  gate paying for itself, and it is why the overlay must not be applied anywhere later in the
  pipeline.

  Ordering is explicit and must be documented at the type: `placementCountOverrides` (exact) wins over
  `serverCountFactor` (proportional). `populationRpsFactor` multiplies `peakRps` *before* the diurnal
  curve and the Poisson draw, so variance still scales correctly rather than being flattened.

  **Vendor profile.** `cloudProfile` sets the default provider for new managed services and selects
  the world's egress pricing table from `cloudRegistry.ts`. Existing per-service `provider` values
  continue to win — the world profile is a default, not an override, so switching it never silently
  reprices a service the user deliberately pinned. The Cost tab gains a "price this world as…"
  comparison row: the same architecture's monthly cost under each of the four profiles, computed by
  running the existing cost model against each pricing table. This is a handful of extra
  `computeWorldCost` calls on an explicit user action, not per tick.

  **Canary, finally activated.** A placement with `role: 'canary'` and `canaryWeight: 0.05` receives
  5% of the traffic that would otherwise go to the `primary` instances of the same blueprint in the
  same region. Implement in `routingRuntime.ts`'s target selection — the same place LB targets are
  already chosen, using the existing effective-role resolver so promotion logic and canary logic
  cannot disagree about a role. Canary instances participate in metrics **separately**, so a canary
  with an elevated error rate is legible as a canary rather than smeared into the blueprint's average.
  Add a `canary-failing` analysis rule: canary error rate materially above primary error rate for a
  sustained window — the automated judgment a real progressive-delivery system makes.

  **Perf.** Environments cost nothing at runtime — they are resolved once, at compile. Canary routing
  adds one weighted branch to target selection, on a path that already performs weighted selection.
  **Expected: 0 ms/step.**
- **Execution Steps for Developer Agent:**
  1. Add `Environment` to `src/lib/world/types.ts`; add `environments?`, `activeEnvironmentId?`, and
     `cloudProfile?` to `WorldDoc` (`:360-380`); add `canaryWeight?` to `Placement` (`:254-261`).
     Normalize all as optional in `serializer.ts`.
  2. Apply the environment overlay in `compileWorld.ts` during placement expansion (`:27`) and spec
     resolution. Document the precedence order at the type. Emit a compile finding when
     `activeEnvironmentId` names a missing environment.
  3. Apply `populationRpsFactor` in `compileWorld` (not `demand.ts`) so the engine sees an already-
     scaled `peakRps` and the Poisson variance scales with it.
  4. Add environment CRUD + an environment switcher to `world.store.ts`, routed through `mutate()`
     for undo/dirty. Switching environments is an **authoring** action — edit-locked while running.
  5. Route `cloudProfile` into `cloudRegistry.ts`'s pricing/egress lookup as a default; per-service
     `provider` continues to win.
  6. Add a "price as…" comparison row to `CostTab.tsx`, computed on demand across the four profiles.
  7. Implement canary weighting in `routingRuntime.ts`'s target selection, resolving roles through
     the existing `effectiveRoleResolver` (`failover.ts:303`) — never a second role lookup.
  8. Publish canary instances separately in `metrics.ts` (they are already distinct instances; ensure
     rollups do not smear them into the primary's aggregate for the canary comparison).
  9. Add the `canary-failing` rule to `analysis/rules/structural.ts`; spread into `ANALYSIS_RULES`.
  10. Author environments in a world-scope surface (Topology panel section or the Settings modal) and
      `canaryWeight` in the placement drawer. Show the active environment in the header breadcrumb —
      mistaking staging for production is the exact error this feature could otherwise introduce.
- **Acceptance & Verification Criteria:**
  - A world with no `environments` compiles identically to pre-feature (`toBe`) — the regression floor.
  - Switching the active environment changes `compiled` and therefore every downstream surface, with
    **no** changes required in the engine, views, analysis, or cost code paths. Assert by diffing
    `compiled` across a switch and confirming no consumer needed modification.
  - Precedence holds: `placementCountOverrides` wins over `serverCountFactor` for the same placement.
  - `populationRpsFactor: 0.1` scales both mean demand **and** its Poisson variance (assert variance
    ≈ mean at the new scale, proving the factor was applied before the draw, not after).
  - `cloudProfile` changes cost without changing simulated behavior; a per-service `provider` pin is
    **not** overridden by the world profile.
  - The "price as…" row produces four totals that each match a direct `computeWorldCost` call under
    that profile.
  - **The canary test:** `canaryWeight: 0.05` routes ~5% of the blueprint's regional traffic to canary
    instances; a canary with an injected error fault (FEAT-001) raises canary error rate without
    materially moving the primary's, and `canary-failing` fires.
  - The active environment is visible in the header at all times.
  - `bench/enginePerf.bench.test.ts`: no measurable delta.
  - **Live smoke:** build a production world, define a staging environment at 0.1× scale, switch, and
    watch instance counts and cost drop while topology stays identical. Both themes.

---

### [FEAT-013]: Ergonomics Pack — Command Palette, Multi-Select, Keyboard Map

- **Category:** UX & Observability
- **Target Impact:** Medium
- **Affected System Areas:** new `src/app/world/CommandPalette.tsx` + `src/app/world/commands.ts`,
  new `src/app/keymap.ts`, `src/App.tsx`, `src/app/world/WorldShell.tsx` (**hub file**),
  `az/DatacenterFloor.tsx`, `panels/TopologyPanel`, `app/store/ui.store.ts`
- **Problem / Gap:** Keyboard and batch affordances are close to absent. The **entire** shortcut
  surface is three keys, split across two files: `⌘N` in `App.tsx:43-53`, and `⌘Z` / `⇧⌘Z` in
  `WorldShell.tsx:96-102`. `multiSelect`, `hotkey`, and `shortcut` all return zero hits repo-wide.

  Two costs follow. First, **every action is a mouse journey** — navigating to a region, opening a
  tab, killing a server, and switching a theme all require hunting a control. In an app with four
  zoom levels and ten dock tabs, that is the dominant interaction cost for anyone past their first
  session.

  Second, **every edit is singular**. Changing the instance class on twelve servers means twelve
  identical drawer visits. There is no multi-select anywhere: not on the AZ floor, not in the
  Topology panel. This makes authoring a large world tedious in a way that is purely mechanical, and
  it is why users build small worlds — which then under-exercise the engine this spec spent four
  waves improving.

  A third, smaller issue: the existing shortcuts are **split across two files with two independent
  `keydown` listeners**, which is already a maintenance seam and will not survive a fourth binding.
- **Proposed Technical Design & Models:**

  **One keymap registry, replacing two ad-hoc listeners.**

  ```ts
  // src/app/keymap.ts
  export interface Binding {
    id: string
    keys: string            // '⌘K', '⌘Z', '⇧⌘Z', '⌘N', 'g r', '?'
    label: string
    group: 'file' | 'navigate' | 'author' | 'chaos' | 'view'
    when?: 'always' | 'running' | 'stopped'   // enforces the edit-lock law declaratively
    run: (ctx: CommandContext) => void
  }
  ```

  `when` is how the edit-lock law becomes structural rather than remembered: `author` commands are
  `'stopped'`, `chaos` commands are `'running'`, and the palette and the key handler both consult the
  same field. A future binding cannot forget the rule, because the rule is a property of the binding.

  **The palette (⌘K)** is a filter over that registry plus dynamic entity entries. It dispatches
  **existing** actions only — no new mutation paths, per the relocated-dispatch contract:
  - `world.store` actions (add server, add region, undo, redo, …), all already routed through
    `mutate()` for undo/dirty;
  - navigation via `entityNav.ts`'s `navigateToEntity(id, doc, compiled, nav)` (`:15`) with
    `entityLabel` (`:29`) for display — the fuzzy entity search is nearly free because both functions
    exist;
  - dock tab switches via `ui.store`'s `pendingPanelTab`;
  - chaos actions via `simulation.store`'s `setFault` (FEAT-001), `'running'`-gated.

  Disabled commands are **shown greyed with the reason**, not hidden — using the standardized tooltip
  copy (`stop the simulation to edit` / `start the simulation to break things`). Hiding them teaches
  nothing; showing them teaches the edit-lock model.

  **Multi-select.** A `selectedEntityIds: Set<string>` in `ui.store.ts` (lifted alongside the existing
  `selectedServerId`, which it must stay consistent with — single-select remains the degenerate case
  of the set, not a parallel concept). Interactions: click (replace), ⌘/⇧-click (toggle/range),
  marquee drag on the AZ floor, and select-all-in-scope. Batch operations run through the **same**
  store actions as single edits, in one `mutate()` call so the whole batch is a single undo step —
  a batch that undoes one server at a time would be worse than no batch at all.

  **Keyboard map overlay (`?` or `⌘/`)** rendered directly from the registry, grouped by `group`,
  showing `when` state. Self-maintaining: a new binding appears in the help automatically.

  **Perf.** One `keydown` listener replacing two. The palette mounts lazily on first open and filters
  a list bounded by entity count with a simple ranked substring match — no fuzzy-search dependency,
  no index. Marquee selection hit-tests against the floor's existing layout data (`floorLayout.ts`),
  which is already computed. **Zero engine cost; no render-loop cost.**

  **Motion and theme.** The palette fades/scales on open only, respecting `useReducedMotion()`. All
  colors `var(--color-*)`. No emojis — `group` icons use the sanctioned glyph set (`▸ ⌬ ⊘ ⌖ ●`).
- **Execution Steps for Developer Agent:**
  1. Create `src/app/keymap.ts` with `Binding` and the registry. **Migrate the three existing
     bindings into it**: `⌘N` from `App.tsx:43-53` and `⌘Z`/`⇧⌘Z` from `WorldShell.tsx:96-102`,
     deleting both ad-hoc listeners so exactly one remains.
  2. Create `src/app/world/commands.ts`: `buildCommands(ctx)` returning static bindings plus dynamic
     entity-navigation entries built from `entityNav.ts`'s `navigateToEntity`/`entityLabel`.
  3. Create `src/app/world/CommandPalette.tsx` — ⌘K, ranked substring filter, keyboard-navigable,
     disabled entries shown with the standardized tooltip reason.
  4. Add `selectedEntityIds: Set<string>` to `ui.store.ts`, keeping `selectedServerId` consistent as
     the single-select degenerate case (`dock/scope.ts:33` reads it — do not break `deriveScope`).
  5. Add ⌘/⇧-click and marquee selection to `az/DatacenterFloor.tsx`, hit-testing against the existing
     `floorLayout.ts` geometry.
  6. Add multi-select + batch actions to the Topology panel.
  7. Implement batch operations as a **single** `mutate()` call in `world.store.ts` so a batch is one
     undo step.
  8. Create the keyboard-map overlay, rendered from the registry, opened with `?` / `⌘/`.
  9. Enforce `when` in both the key handler and the palette — one check, one source of truth.
  10. Document the keymap in `docs/agent-onboarding.md` §5 (user-visible feature map) and add the new
      modules to `docs/module-boundaries.md`.
- **Acceptance & Verification Criteria:**
  - Exactly **one** global `keydown` listener exists after the migration; `⌘N`, `⌘Z`, and `⇧⌘Z` behave
    identically to before (assert against the existing behavior, not just that they fire).
  - ⌘K opens the palette; typing a region name and pressing Enter navigates there via
    `navigateToEntity` — no new navigation path.
  - **The edit-lock test:** while running, `author`-group commands are visibly disabled with
    `stop the simulation to edit`, and `chaos`-group commands are enabled; while stopped, the inverse.
    Assert both directions — this is a hard law and the palette is the easiest place to violate it.
  - Selecting eight servers and applying an instance-class change produces **one** undo step that
    restores all eight.
  - `selectedServerId` and `selectedEntityIds` never disagree; `dock/scope.ts`'s `deriveScope`
    continues to resolve correctly for single selection.
  - Marquee selection on the floor selects exactly the servers whose layout rects intersect the
    marquee — asserted against `floorLayout.ts` geometry, not against pixels.
  - The keyboard-map overlay lists every registered binding; adding a binding in a test makes it
    appear without touching the overlay.
  - No emojis anywhere in the new UI; all colors `var(--color-*)`; palette animation respects
    `prefers-reduced-motion`; correct in dark and light.
  - **Live smoke:** with the sim stopped, ⌘K → "add server" works and chaos entries are greyed; start
    the sim and the states swap. Multi-select eight servers on the floor, change their class in one
    action, ⌘Z once, and confirm all eight revert together.

---

### [FEAT-014]: Network Topology — VPC, Subnets, Route Tables, NAT, Security Groups

- **Category:** System Configurability
- **Target Impact:** High
- **Affected System Areas:** `src/lib/world/types.ts` (new `Vpc`/`Subnet`/`RouteTable`/
  `InternetGateway`/`NatGateway`/`SecurityGroup`, additive `Server.subnetId`/
  `Server.securityGroupIds`), `src/lib/world/network.ts` (path evaluation), `src/lib/world/
  compileWorld.ts`, `src/lib/worldEngine/networkRuntime.ts` (NAT gateway byte cap),
  `src/lib/worldEngine/faults.ts` (`LinkEndpoint` extension), `src/lib/costModelV2.ts`,
  `src/lib/analysis/rules/network.ts`, `src/lib/serializer.ts`, new `panels/NetworkPanel.tsx`
  (VPC/subnet/SG authoring), `dock/drawers/` (SG picker replacing the per-server firewall rule
  editor), `az/DatacenterFloor.tsx` (subnet boundary rendering)
- **Depends on:** FEAT-002 (extends its `LinkEndpoint`/`PartitionFault` vocabulary additively —
  no redesign of the fault substrate)
- **Problem / Gap:** "Network" in this simulator is a stub wearing AWS vocabulary. `Server.firewall`
  is a flat, ordered, per-server port/protocol rule list, explicitly documented in `network.ts:6-13`
  as **not** AWS Security Group semantics — first-match-wins over an unstructured list, not a named,
  reusable, stateful object. `FirewallSource` (`world/types.ts:92`) accepts CIDR-shaped strings, but
  they are cosmetic: `evaluateFirewall`/`firewallFirstMatch` (`network.ts:36-52`) ignore `source`
  entirely when deciding a verdict — only the analysis layer parses it, for display, via its own
  reimplementation (`analysis/rules/network.ts`, which deliberately does not import `network.ts`'s
  evaluator for exactly this reason).

  There is no IP addressing, no subnet, no VPC, no route table, and no NAT/internet gateway
  anywhere in the codebase (confirmed repo-wide). `hopClassBetween` (`network.ts:54-64`) classifies
  a server pair into `localhost|same-az|cross-az|cross-region` purely from AZ/region ids — there is
  no notion of *why* a path is reachable beyond "same server," "same AZ," or "a firewall rule says
  so." Consequently, the single most common real-world connectivity failure — a private subnet with
  no route to the internet, or a security group that references a peer group nobody peered with —
  is structurally unreachable here. A user can build a textbook-correct three-tier topology, wire it
  wrong at the network layer the way real engineers actually do, and the simulator will never notice,
  because it has no layer at which "wrong" could be represented.

  This also caps FEAT-015 (DNS/traffic management): a DNS failover record pointing at an unreachable
  target is only a *lesson* if "unreachable" can mean something other than a health check tripping —
  it should also be able to mean "the route table has no path there," which requires this feature
  to exist first.
- **Proposed Technical Design & Models:**

  **New entities, all additive** (`src/lib/world/types.ts`):

  ```ts
  export interface Vpc {
    id: string
    regionId: RegionId
    label: string
    cidrBlock: string                    // display/authoring only in this feature — see note below
  }

  export interface Subnet {
    id: string
    vpcId: string
    azId: AzId
    kind: 'public' | 'private'
    cidrBlock: string
    routeTableId: string
  }

  export type RouteTarget =
    | { kind: 'local' }
    | { kind: 'internetGateway'; id: string }
    | { kind: 'natGateway'; id: string }

  export interface RouteTable {
    id: string
    vpcId: string
    routes: Array<{ destinationCidr: string; target: RouteTarget }>
  }

  export interface InternetGateway { id: string; vpcId: string }
  export interface NatGateway { id: string; subnetId: string; label: string }   // lives in a public subnet

  export interface SecurityGroup {
    id: string
    vpcId: string
    label: string
    rules: Array<{ port: number; protocol: 'tcp' | 'udp'; source: FirewallSource }>  // allow-only
  }
  // WorldDoc gains: vpcs/subnets/routeTables/internetGateways/natGateways/securityGroups,
  // all Record<id, T>, mirroring every other entity collection's shape.
  // Server gains (both optional): subnetId?: string; securityGroupIds?: string[]
  ```

  **Regression floor.** A `Server` with no `subnetId` behaves **exactly** as today — `network.ts`
  keeps evaluating its legacy `firewall: FirewallRule[]` unchanged, and no route-table lookup runs
  for it. This is the same additive-optionality pattern every prior feature in this spec uses; it
  means existing `.scalemap` v3 files need **no version bump and no migration**, only the standard
  defaulting-block entries in `serializer.ts` (empty collections, same pattern as `racks`/
  `loadBalancers`/`packets`).

  **Path evaluation — one new stage, ahead of the existing firewall check.** In
  `evaluateInstancePath` (`network.ts:87-172`), when the *source* server has a `subnetId`:

  1. Resolve the source subnet's `RouteTable`. Find the most-specific matching route for the
     destination (same-VPC traffic always resolves via the implicit `local` route; cross-VPC/
     internet/managed-service/region traffic needs an explicit `internetGateway`/`natGateway`
     route). No match ⇒ new verdict, not a firewall verdict:
     `BlockReason.kind: 'no-egress-route'` (extends the existing union at `world/types.ts:437-441`
     alongside `no-port-binding`/`firewall-deny`/`network-isolation`).
  2. If a route exists, evaluate security groups **instead of** the legacy firewall list when
     `securityGroupIds` is set: allow-only, implicit-deny, union of all attached groups' rules —
     genuinely different from `firewall`'s ordered first-match-wins semantics, which is the whole
     point (closing the "not an AWS SG" gap `network.ts:6-13` calls out by name).
  3. Container-level bridge/overlay/host-port checks (`network.ts:104-159`) are unaffected — they run
     after this stage, exactly as they run after the firewall check today.

  **NAT gateway — a second choke point, not a rule.** A `NatGateway` gets the same NIC-cap/backlog
  treatment `networkRuntime.ts`'s `NicState` (`:74-145`) already gives per-server NICs, applied once
  at the gateway rather than per server — every private-subnet server routing through the same NAT
  shares its cap, which is exactly the real-world "NAT gateway is an underprovisioned SPOF for an
  entire AZ" failure. Reuse the cap/backlog/shed formulas verbatim; do not re-derive them.

  **Cost.** Extend `costModelV2.ts`'s existing tiered-egress model with a NAT-gateway line: an hourly
  charge plus a per-GB data-processing charge on bytes that traverse it — the real AWS bill surprise
  this teaches (NAT data processing is routinely a larger line item than the instances behind it).

  **Fault/partition integration — additive, no substrate redesign.** `LinkEndpoint`
  (`worldEngine/types.ts`, consumed by `faults.ts`'s `endpointMatches`, `:142-147`) gains two
  variants: `{ kind: 'subnet'; id: string }` and `{ kind: 'natGateway'; id: string }`. `PartitionFault`
  (`faults.ts`, `addPartition`/`impairmentFor`, `:101` and `:149-166`) needs **no code change** — it
  already matches on endpoint scope generically. This is what makes "sever this subnet's NAT route"
  or "kill this NAT gateway" reachable from the same chaos/scenario surface as everything else in
  Wave 1, at zero marginal design cost.

  **Analysis.** New rules in `analysis/rules/network.ts`: `no-egress-route` (info-severity, names the
  subnet and the missing route), `unpeered-security-group-reference` (a rule referencing a group in a
  different, unpeered VPC — always a misconfiguration, never intentional), `nat-gateway-spof` (>1 AZ's
  private subnets routing through a single NAT gateway).

  **Perf.** Route-table resolution is a `start()`-time index (`routeTableForSubnet`, `Map` lookup),
  not a per-step computation — it only re-runs when a path is first evaluated at compile time, same
  cost class as today's firewall check. NAT gateway NIC accounting is per-step but bounded by NAT
  gateway count, which is small. Expected: **effectively 0 ms/step** beyond what `networkRuntime.ts`
  already spends on NIC accounting; the compile-time cost is one-time, not per-tick.

  **UI.** `panels/NetworkPanel.tsx` (world scope): VPC list → subnet list (public/private badge,
  route-table summary) → NAT/IGW authoring. Security-group authoring replaces the current per-server
  firewall-rule editor in the server drawer **only when `subnetId` is set** — an un-networked server
  keeps today's flat firewall editor untouched, per the regression floor. Subnet boundaries render on
  `az/DatacenterFloor.tsx` as a labeled dashed outline around the racks/pods inside them, public
  subnets tinted with `var(--color-accent)` at low opacity, private with `var(--color-text-muted)`.
- **Execution Steps for Developer Agent:**
  1. Add `Vpc`/`Subnet`/`RouteTable`/`RouteTarget`/`InternetGateway`/`NatGateway`/`SecurityGroup` to
     `src/lib/world/types.ts`; add the six `Record<id, T>` collections to `WorldDoc`; add optional
     `subnetId`/`securityGroupIds` to `Server`. Extend `BlockReason.kind` with `'no-egress-route'`.
  2. Normalize all six new collections as empty-default in `src/lib/serializer.ts`'s existing
     defaulting block, matching the `racks`/`loadBalancers`/`packets` pattern exactly — no version
     bump.
  3. Add CRUD actions for the six new entities to `src/app/store/world.store.ts`, routed through
     `mutate()` for undo/dirty, matching every other entity's action shape.
  4. In `src/lib/world/network.ts`, add `resolveRoute(sourceSubnet, destination, routeTables):
     RouteTarget | null` — pure, most-specific-CIDR-match, `local` for same-VPC. Wire it into
     `evaluateInstancePath` (`:87-172`) ahead of the firewall/security-group check, short-circuiting
     to `no-egress-route` on no match, only when the source server has a `subnetId`.
  5. Add `evaluateSecurityGroups(server, doc): FirewallVerdict` — allow-only, implicit-deny, union of
     attached groups' rules — and call it instead of `evaluateFirewall` when `securityGroupIds` is
     set; call the legacy path unchanged otherwise.
  6. In `worldEngine/networkRuntime.ts`, add a `NatGatewayState` map reusing `NicState`'s cap/backlog/
     shed formulas verbatim, keyed by `NatGateway.id`; route bytes through it for any flow whose
     resolved `RouteTarget` is `natGateway`.
  7. Extend `costModelV2.ts` with an hourly NAT-gateway charge plus a per-GB processing charge on
     bytes recorded by step 6's `NatGatewayState`.
  8. Add `{ kind: 'subnet' }` / `{ kind: 'natGateway' }` to `LinkEndpoint`
     (`worldEngine/types.ts`); no other change to `faults.ts` — `endpointMatches`/`impairmentFor`
     already generalize. Log the type addition in `.superpowers/sdd/contract-drift.md`.
  9. Add `no-egress-route`, `unpeered-security-group-reference`, and `nat-gateway-spof` rules to
     `src/lib/analysis/rules/network.ts`; spread into `ANALYSIS_RULES`.
  10. Build `panels/NetworkPanel.tsx` (VPC/subnet/NAT/IGW authoring) and register a `'network'` tab
      in `ui.store.ts`'s `PanelTab` union and `dock/scope.ts`'s `WORLD_TABS`. **`WorldPanel.tsx` is a
      hub file — edit sequentially.**
  11. Add security-group authoring to the server drawer, gated on `subnetId` being set; leave the
      existing firewall editor as the fallback path for un-networked servers.
  12. Render subnet boundaries on `az/DatacenterFloor.tsx`, driven off compiled doc state (not the 1
      Hz batch — topology is static during a run), respecting both themes.
- **Acceptance & Verification Criteria:**
  - A doc with zero `Vpc`/`Subnet` entries and no server carrying `subnetId` produces byte-identical
    `compileWorld` output to pre-feature (`toBe`) — the regression floor this feature is built around.
  - **The no-egress-route test:** a server in a private subnet whose route table has no
    `natGateway`/`internetGateway` route to a cross-region dependency produces a `blocked` path with
    `BlockReason.kind === 'no-egress-route'`, distinct from `firewall-deny`.
  - Adding a NAT gateway route to that subnet's route table flips the same path to `permitted` with
    no other change.
  - **The security-group test:** a server with `securityGroupIds` set is evaluated by
    `evaluateSecurityGroups`, not `evaluateFirewall` — allow-only semantics verified by asserting a
    group with no matching rule denies, where the legacy ordered-list evaluator would have needed an
    explicit deny rule to produce the same verdict.
  - A partition/scenario step targeting `{ kind: 'subnet', id }` blocks all cross-subnet traffic from
    that subnet without any change to `faults.ts` beyond the `LinkEndpoint` type — asserted by reusing
    FEAT-002's existing partition test harness unmodified aside from the new endpoint kind.
  - NAT gateway bandwidth: two private-subnet servers sharing one NAT gateway and both saturating it
    each receive roughly half the gateway's cap, mirroring `NicState`'s existing per-server shedding
    behavior at the gateway level instead.
  - `unpeered-security-group-reference` fires for a rule whose `source` names a group in a different
    VPC with no peering record; `nat-gateway-spof` fires when >1 AZ's private subnets share one NAT
    gateway.
  - `bench/enginePerf.bench.test.ts`: no measurable regression for docs without networked servers;
    route-table resolution cost is one-time at compile, not per-step.
  - **Live smoke:** build a two-AZ topology, put one AZ's servers in a private subnet with no NAT
    route, watch their outbound dependency paths show blocked with the new reason in the Analysis
    tab; add the NAT route and watch them recover. Verified in dark and light themes.

---

### [FEAT-015]: DNS & Traffic Management

- **Category:** System Configurability
- **Target Impact:** High
- **Affected System Areas:** `src/lib/world/types.ts` (`WorldDoc.dnsZones`/`DnsRecord`),
  `src/lib/serializer.ts`, `src/app/store/world.store.ts`, `src/lib/worldEngine/routingRuntime.ts`
  (record-driven resolution), `src/lib/worldEngine/types.ts` (`FaultSpec` extension,
  `EngineEventKind`), `src/lib/world/types.ts` (`ScenarioAction` extension), new
  `panels/DnsPanel.tsx`, `src/lib/analysis/rules/network.ts`
- **Depends on:** FEAT-014 (a failover target can now be topologically unreachable, not merely
  health-check-down — the failure class this feature exists to make visible); FEAT-001 (`FaultSpec`
  union gains `dns-resolution-failure`); FEAT-003 (scenario steps drive weight shifts)
- **Problem / Gap:** DNS/GSLB routing is a real, working subsystem in this engine — and entirely
  invisible to the user. `RoutingConfig` (`world/types.ts:19-33`) plus one `LoadBalancer` per region
  (`:349-362`) get compiled into static rankings (`routing.ts`'s `computeRouting`, `:56-89`) and made
  live by `routingRuntime.ts`: per-population DNS-TTL caching (`popCache`, `:9-12,25-29`), health
  checks with hysteresis (`runHealthChecks`, `:91-117`), AZ split, and instance round-robin. The TTL
  lag in `resolveRegion` (`:53-73`) is, right now, *the entire reason failover isn't instantaneous* —
  and it is a single hardcoded `dnsTtlSec` on `RoutingConfig`, never surfaced as an authored, named,
  inspectable object anywhere in the UI.

  Three consequences follow from DNS having no first-class representation:

  1. **The TTL-lag mechanism can't be taught.** A user watching a region fail over has no way to see
     *why* it took the time it took, or to experiment with the tradeoff (short TTL = faster failover,
     more DNS query load; long TTL = the opposite) — the number that controls it isn't a thing they
     can point at.
  2. **There is exactly one routing policy for the whole world.** `RoutingConfig.policy` is global.
     A canary release, a weighted A/B split for one hostname, or a failover record independent of the
     world's general routing policy are all unrepresentable — real traffic management is per-record,
     not per-world.
  3. **DNS failure as its own failure mode doesn't exist.** Every failure in this simulator today is
     "the backend is unhealthy." A resolver timeout or NXDOMAIN — where the backend is perfectly
     healthy and *nobody can find it* — is a materially different, common, and currently unreachable
     failure.

  This feature is deliberately scoped to **ingress only** (client → region). Internal service-to-
  service discovery — dependency edges resolving via name instead of hardwired blueprint id — was
  considered and explicitly deferred: it would require restructuring `compileWorld`'s dependency
  resolution, a much larger and riskier change than surfacing the DNS layer that already exists.
- **Proposed Technical Design & Models:**

  ```ts
  // src/lib/world/types.ts (additive, optional)
  export type DnsRecordType = 'A' | 'ALIAS' | 'CNAME' | 'WEIGHTED' | 'FAILOVER' | 'LATENCY'

  export interface DnsTarget {
    loadBalancerRegionId: RegionId    // the region whose compiled LoadBalancer this points at
    weight?: number                   // meaningful for WEIGHTED
    isPrimary?: boolean               // meaningful for FAILOVER
  }

  export interface DnsRecord {
    id: string
    hostname: string
    type: DnsRecordType
    targets: DnsTarget[]
    ttlSec: number                    // authored — replaces reading RoutingConfig.dnsTtlSec directly
    healthCheckId?: string            // reuses failover.ts's existing health state; no new health model
  }

  export interface DnsZone { id: string; label: string; records: Record<string, DnsRecord> }
  // WorldDoc gains: dnsZones?: Record<string, DnsZone>
  ```

  **This sits *on top of* `RoutingConfig`/`LoadBalancer`, not in place of them.** A `DnsRecord`
  resolves to one or more regions' already-compiled `LoadBalancer`; it does not duplicate AZ split or
  instance pick, which stay exactly as `routingRuntime.ts` computes them today. A population with no
  bound `DnsRecord` keeps using `RoutingConfig.policy` unchanged — this is the regression floor.

  **Runtime — extend `resolveRegion`, don't replace it.** `routingRuntime.ts`'s `popCache`
  (`:9-12,25-29`) becomes keyed by `DnsRecord.id` when a population is bound to one, using that
  record's `ttlSec` instead of the global `dnsTtlSec`. `WEIGHTED` reuses the existing `pickWeighted`
  (`:35-45`) verbatim over `targets`' weights. `FAILOVER` picks the first target whose
  `healthCheckId` resolves healthy via the **same** health-state lookup `runHealthChecks`
  (`:91-117`) already populates — no second health model. `LATENCY` reuses `regionOrderFor`'s
  (`routing.ts:28-54`) existing great-circle ranking, restricted to the record's `targets`.

  **The TTL lesson, made visible.** Because `popCache` already carries an `expiresAtMs` and a stale
  entry is what causes failover lag, exposing `ttlSec` per-record and rendering the cache's current
  expiry in `panels/DnsPanel.tsx` turns an invisible constant into an inspectable, tunable one — the
  live view can show "this hostname will re-resolve in Xs" during an active outage.

  **New fault kind.** `FaultSpec` (`worldEngine/types.ts`) gains
  `{ kind: 'dns-resolution-failure'; recordId: string; failFraction: number }` — a fraction of
  resolution attempts for that record return no usable target (NXDOMAIN/timeout) even though every
  target's backend is healthy. Wired in `routingRuntime.ts`'s resolution path, beside (not instead
  of) the health-check gate — the two are independent and can compose (a client can experience DNS
  failure against a perfectly healthy topology, or health-check failure against perfect DNS).

  **Scenario integration.** `ScenarioAction` (`world/types.ts`, FEAT-003) gains
  `{ type: 'shift-dns-weight'; recordId: string; targetRegionId: RegionId; weight: number; rampSec: number }`
  — a reproducible, seeded canary/blue-green cutover, ramped rather than instantaneous for the same
  reason `demand-multiplier`'s `rampSec` is (an instantaneous weight flip is a different, less
  realistic test than a ramped one).

  **Why this depends on FEAT-014.** A `FAILOVER` record's secondary target can now be a region whose
  entry point is, say, behind a private subnet with no NAT route — a genuinely new "the DNS failover
  succeeded but the destination was never reachable" lesson that has no analog without topology
  underneath it. This is the reasoning that put Wave 6 before Wave 7.

  **Perf.** Resolution stays exactly as cheap as today's `resolveRegion` — a `Map` lookup plus a
  cache-expiry comparison. `dns-resolution-failure` adds one probability draw from the seeded `rng`
  only when the fault is active, guarded the same way `faults.ts` guards its other kinds
  (`if (state.active.size === 0) return`). Expected: **0 ms/step with no records/faults bound, < 0.02
  ms/step with them.**

  **UI.** `panels/DnsPanel.tsx` (world scope): zone list → record list (hostname, type, targets,
  live TTL countdown while running) → record editor. `SimControls` needs no change — DNS resolution
  is continuous engine behavior, not a run-mode toggle like FEAT-003's scenarios. Authoring is
  edit-locked while running (`stop the simulation to edit`), per the standard law.
- **Execution Steps for Developer Agent:**
  1. Add `DnsRecordType`, `DnsTarget`, `DnsRecord`, `DnsZone` to `src/lib/world/types.ts`; add
     `dnsZones?: Record<string, DnsZone>` to `WorldDoc`.
  2. Normalize `dnsZones` as empty-default in `src/lib/serializer.ts`'s defaulting block — additive,
     no version bump.
  3. Add zone/record CRUD to `src/app/store/world.store.ts`, routed through `mutate()`.
  4. Add `{ kind: 'dns-resolution-failure'; recordId: string; failFraction: number }` to `FaultSpec`
     (`worldEngine/types.ts`); log in `contract-drift.md`. Add `dns_resolution_failed` to
     `EngineEventKind`.
  5. Add `{ type: 'shift-dns-weight'; ... }` to `ScenarioAction` (`world/types.ts`).
  6. In `routingRuntime.ts`, extend `resolveRegion` (`:53-73`) to key `popCache` by `DnsRecord.id`
     when a population is bound to one, using the record's `ttlSec`. Implement `WEIGHTED` via the
     existing `pickWeighted` (`:35-45`), `FAILOVER` via the existing health-state lookup
     `runHealthChecks` already populates (`:91-117`), and `LATENCY` via `routing.ts`'s
     `regionOrderFor` (`:28-54`) restricted to the record's targets.
  7. Wire `dns-resolution-failure` into the same resolution path, independent of the health-check
     gate — a probability draw from the seeded `rng`, guarded by `state.active.size === 0` short
     circuit matching `faults.ts`'s existing pattern.
  8. Wire `shift-dns-weight` scenario steps to linearly ramp a `WEIGHTED` record's target weight over
     `rampSec`, mirroring `demand-multiplier`'s interpolation.
  9. Add a population→`DnsRecord` binding (optional field on `ClientPopulation` or a lookup table —
     match whichever shape `RoutingConfig`'s existing per-population wiring already uses, do not
     invent a second one).
  10. Build `panels/DnsPanel.tsx` (zone/record authoring, live TTL countdown while running); register
      a `'dns'` tab in `ui.store.ts`'s `PanelTab` union and `dock/scope.ts`'s `WORLD_TABS`.
      **`WorldPanel.tsx` is a hub file — edit sequentially.**
  11. Add a `dns-unreachable-failover-target` finding to `analysis/rules/network.ts` — fires when a
      `FAILOVER` record's non-primary target resolves to a region with a compile-time
      `no-egress-route`/`firewall-deny` path from its LB, naming the FEAT-014 topology cause.
- **Acceptance & Verification Criteria:**
  - A world with no `dnsZones` is byte-identical to pre-feature for a fixed seed (`toBe`) — no bound
    population changes its resolution behavior at all.
  - **The TTL test:** a `FAILOVER` record at `ttlSec: 30` continues resolving to a just-failed
    primary for up to 30s of sim time after it goes unhealthy, then switches — asserted against
    `popCache`'s `expiresAtMs`, proving the mechanism is the same one `resolveRegion` already uses,
    not a parallel implementation.
  - `WEIGHTED` at a 90/10 split routes traffic in that ratio across two regions over a sustained
    window (statistical assertion, matching `pickWeighted`'s existing test style).
  - `dns-resolution-failure` at `failFraction: 0.2` causes ~20% of resolution attempts for that
    record to fail even when every target's health check passes — asserted as independent of the
    health-check gate (toggling health check state does not change the DNS-failure rate).
  - `shift-dns-weight` at `rampSec: 60` linearly interpolates a `WEIGHTED` record's split over 60s of
    sim time, reproducibly at a fixed seed (two runs deep-equal, per FEAT-003's determinism
    invariant).
  - **The FEAT-014 integration test:** a `FAILOVER` record's secondary target sits behind a subnet
    with no NAT route; failing the primary causes DNS to fail over to it, but the compiled path
    remains blocked with `no-egress-route`, and `dns-unreachable-failover-target` fires naming both
    the record and the topology cause. This is the test that justifies FEAT-015 depending on
    FEAT-014 rather than shipping standalone.
  - `bench/enginePerf.bench.test.ts`: no measurable regression with no records bound.
  - **Live smoke:** author a `FAILOVER` record over two regions, start the sim, kill the primary
    region, and watch the DNS panel's live TTL countdown before the client-facing traffic actually
    moves — then repeat with a short TTL and observe the faster cutover. Verified in both themes.

---

## Closing Notes for the Executing Agent

**What "done" means for a wave.** All features in the wave meet their Acceptance Criteria; `npx tsc
--noEmit`, `npx vitest run`, and `npm run build` are green; `bench/enginePerf.bench.test.ts` is
within the stated per-feature budget and the aggregate is under `DEGRADE_THRESHOLD_MS = 4` ms/step;
`docs/module-boundaries.md` is updated; every `worldEngine/types.ts` change is logged in
`.superpowers/sdd/contract-drift.md`; and the wave has been smoke-tested live in `npm run tauri dev`
in **both** themes with zero new console errors.

**The two changes that carry real risk**, called out so they are not discovered late:

1. **FEAT-008's invariant break.** After it lands, "exists in `compiled.instances`" no longer implies
   "is running." The consumer audit in its step 4 is the feature, as much as the control loop is —
   an unaudited consumer will silently count parked instances toward capacity, cost, or a finding.
2. **FEAT-005's promotion-order change.** Preferring the least-lagged replica alters an existing code
   path (`failover.ts:335`) that current tests pin. Re-baseline deliberately and state in the commit
   which assertions moved and why.
3. **FEAT-014's dual evaluation path.** `network.ts` now has two firewall verdict paths — the legacy
   ordered `evaluateFirewall` for un-networked servers and `evaluateSecurityGroups` for anything with
   `subnetId` set. This is intentional (the regression floor requires it), but it means a bug fixed
   in one path will not automatically apply to the other; any future firewall-semantics change must
   be checked against both.

**Where this spec deliberately stops.** Consistent with `CLAUDE.md`'s Known Issues / Roadmap, nothing
here introduces: a k8s/ECS scheduler (FEAT-008 is a declarative scale-out policy on the existing
explicit placement model, not a scheduler); a scenario/override **expression language** (FEAT-003 is
declarative config — an expression language would revive the parked ScaleScript v2); Terraform import
or export; AI watch-mode; spot-instance modeling; managed-service pseudo-internals; or LLM
review/chat persistence. Landing any parked item remains a deliberate scope decision that must edit
that roadmap section in the same change.
