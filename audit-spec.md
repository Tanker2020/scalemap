# Multi-Protocol Connection Audit — Execution Specification

**Audited:** the protocol expansion from flat HTTP traffic to four paradigms (`http`, `db`,
`event`, `stream`) — the packet library (`WorldDoc.packets`, `src/lib/nodeConfig.ts`,
`src/lib/packetResolve.ts`) and the connection-semantics phase (`src/lib/connectionModel.ts`),
as they interact with the simulation engine (`src/lib/worldEngine/`).

**Date:** 2026-07-29 · **Findings:** 19 (5 Critical · 9 Major · 5 Minor; 5 of them Performance)

**How to use this document.** Work the waves in order. Within a wave, issues are independent
unless a `Depends on` line says otherwise. Every issue carries numbered Execution Steps that name
their files, and a Verification Test with a *before* assertion that passes today (documenting the
bug) and an *after* assertion that must pass once fixed. Do not start a wave before its
predecessors are green.

---

## Reader Orientation

### Three premises you may arrive with that this codebase does not match

If you were briefed before reading this, correct these first — otherwise you will spend real time
hunting for code that does not exist.

1. **There is no 60 FPS tick engine and there are no "edge controllers."** The simulation is a
   fixed-step discrete solver at `DEFAULT_STEP_MS = 100` (`src/lib/worldEngine/index.ts:54`),
   degrading to 200 ms under load. The rAF callback `tick()` (`index.ts:1323`) drives *two*
   distinct things: `runFrame()` (the ~10 Hz simulation) and `renderAll()` (the ~60 Hz particle
   rebuild). **Every performance finding must be attributed to the correct loop** — a cost in
   `renderAll` is a 60 Hz cost, a cost in `runStep` is a 10 Hz cost, and conflating them
   misprioritises the fix by 6×. Wave 3 labels each issue with its loop for exactly this reason.
2. **Particles cannot leak.** `buildAzParticles` / `buildServerParticles`
   (`index.ts:1241-1316`) re-derive a fresh array from `prevFlows` every frame; nothing survives a
   frame boundary. The real defect is the inverse of a leak — per-frame allocation *churn*
   (ISSUE-013, ISSUE-017).
3. **Topology is edit-locked while the simulation runs.** `world.store.ts:189,203` plus every
   modal gate on `useSimulationStore(s => s.running)`; `doc` and `compiled` are frozen at
   `start()`. A mid-run protocol switch is impossible, so there is no orphaned-state or
   dangling-subscription class here. That same freeze is what makes hoisting loop-invariant work
   to `start()` safe — the single biggest lever in Wave 3.

### The thesis

> **Protocol is a *pricing and holding* attribute in this engine. It is never a *delivery*
> attribute.**

`connectionClassOf` (`src/lib/connectionModel.ts:66-71`) collapses `db` → keep-alive, `event` →
keep-alive, `stream` → hold-duration. `packetResolve` turns every protocol into bytes. **No code
path anywhere branches delivery semantics on protocol.**

Every fidelity gap in this audit follows from that one fact: no broker, no consumer lag, no
ACK/NACK/DLQ (ISSUE-002); no pool checkout or connection ceiling (ISSUE-005); no stream framing,
heartbeat, or compression (ISSUE-004); no client timeout, therefore no latency-triggered breaker
(ISSUE-006); no response-leg latency at all (ISSUE-003). These are not nineteen unrelated bugs.
They are one architectural decision, observed from nineteen angles.

### Cross-cutting root cause: the divergence class

The most common defect shape in this repo is a derived quantity computed **twice** — once for
*enforcement* (the engine acts on it) and once for *display* (the user sees it) — which then
drift. The user is then shown a number the simulator is not using.

The repo already knows this failure mode and defends it **exactly once**: the `DIVERGENCE GUARD`
test in `src/lib/worldEngine/index.test.ts`, which pins the two `activeConnections()` call sites
together (documented as the two-call-site invariant in `CLAUDE.md`).

**Three more undefended instances of the same class exist**, all in Wave 1:

| Issue | Enforced by | Displayed by | Drift |
|---|---|---|---|
| ISSUE-001 | `flows.ts:557` routing on raw `dep.writeFraction` | `ConnectionsView.tsx:363-370` shows the packet-derived value | user sees derived, engine routes on raw |
| ISSUE-011 | `hostScheduler` charges `cpuMsPerKb` + `handshakeCpuMs` | `metrics.ts:285` publishes raw `cpuMsPerRequest` | display reads ⅓ of true load |
| ISSUE-012 | `hostScheduler.ts:128-133` clamps RAM to `memLimitMb` | `metrics.ts:286` publishes unclamped | shows a physically impossible state |

**Fix every one with the same discipline the repo already established: one shared resolver, plus
one guard test asserting `enforced === displayed`.** A fix that corrects the number without adding
the guard has not closed the issue.

### Verified-path note

Three independent verification passes over this spec found the same citation error in the
commissioning notes: **`managedDbRuntime.ts` lives at `src/lib/managedDbRuntime.ts`, not
`src/lib/worldEngine/managedDbRuntime.ts`.** There is no `managedDbRuntime.ts` under
`worldEngine/`. All paths below are corrected. Where a line number drifted, the issue body cites
what is actually in the file today and notes the correction.

---

## Findings Summary

| ID | Sev | Category | Protocol | Primary site | Finding |
|---|---|---|---|---|---|
| 001 | **Crit** | Fidelity | db | `flows.ts:557`, `managedDbRuntime.ts:169` | Packet-derived `writeFraction` ignored by DB routing and managed-DB capacity; user sees the derived value, engine routes on the raw one. A 100 %-write mix measures against `readCeiling` — the single-writer ceiling vanishes. |
| 002 | **Crit** | Fidelity / Backpressure | event | `connectionModel.ts:66-71`, `flows.ts:545-637` | `event` is a synchronous blocking RPC — consumer errors open the *producer's* breaker. No queue, lag, retention, ACK, or DLQ. Teaches the opposite of decoupling. ⚠️ parked |
| 003 | **Crit** | Fidelity | all | `flows.ts:365-386`, `metrics.ts:266-273`, `replay.ts:113-127` | Response-leg latency never joins the caller, so non-leaf p50/p99 are wrong, `activeConnections` is wrong → RAM is wrong → the slow-dependency → pileup → OOM cascade is **unreachable**. Tracer contradicts the p50 chip. |
| 008 | **Crit** | Backpressure | all | `demand.ts`, `index.ts:500-509`, `flows.ts:488-536` | Demand is fully open-loop; excess is **deleted** past `MAX_QUEUE_SEC = 2`. A saturated callee cannot slow its caller. Answer to "drops or grows unbounded": naively drops at a 2 s horizon. |
| 013 | **Crit** | Performance | all | `packetResolve.ts:148-159`, called `index.ts:1265,1310` | `pickPacketByIndex` filters + reduces **per particle per frame** — ~24 000 allocs+scans/sec of loop-invariant work. Largest avoidable cost in the engine. |
| 004 | Major | Fidelity | stream | `connectionModel.ts:68,83-88`, `nodeConfig.ts:71-78` | One `rps` scalar serves three quantities (connection rate, frame rate, compute rate). **No authoring produces a correct stream.** No heartbeat, so idle streams are free. |
| 005 | Major | Backpressure | db pool | `world/types.ts:149-155` vs `managedDbRuntime.ts:123-129` | Managed DBs get a connection ceiling; self-hosted DB blueprints get none. Unbounded connections, OOM the only failure. No checkout wait. ⚠️ parked |
| 006 | Major | Fidelity | http | `nodeConfig.ts:53`, `flows.ts:488-536` | No client timeout, so a breaker can open **only on capacity overflow, never on latency** — the canonical slow-dependency trip is unreachable. `statusCode` hardcoded to 200, zero readers. |
| 009 | Major | Backpressure / Fidelity | all | `index.ts:760-761` | NIC service-rate ceiling divides by the module constant 2048 B, not the resolved wire size — while NIC *booking* is fully packet-aware. A 5 MB edge on 1 Gbps models 61 035 rps vs a true ~25: **~2 400× overstated.** |
| 010 | Major | Fidelity | all | `flows.ts:539,552,635` | Depth cap, cycle cut, and dangling-dep all discard fan-out with **no event and no metric**. Hop 9+ of a 9-hop chain reports zero traffic, zero cost, `healthy`. Silent under-reporting reads as "your architecture is fine." |
| 011 | Major | State lifecycle | all | `metrics.ts:285` vs `index.ts:696-714` | `cpuCoresUsed` published from raw `cpuMsPerRequest`, omitting `cpuMsPerKb × kb` and `handshakeCpuMs` that the scheduler enforces. Sits beside a *correct* `coreUtilization` on the same panel. |
| 014 | Major | Performance | all | `index.ts:1262,1305` (60 Hz); `managedDbRuntime.ts:169` (10 Hz) | `dependencies.find(...)` per row. **Fifth recurrence** of the unindexed-lookup class already fixed as ISSUE-032/073/075/076. |
| 017 | Major | Performance | all | `index.ts:1241-1316,1128-1136` | ~24 000 particle allocations/sec, no pooling; `buildPayload` allocates throwaway empty arrays per non-matching scope per renderer. |
| 018 | Major | Fidelity (types) | all | `nodeConfig.ts:32,176-181,222-226` | `sizeKb: number` declared non-optional but genuinely `undefined` at runtime (`index.ts:131-136` patches one NaN path). NaN reaches `serviceRateByInstance`, where every comparison goes false. Plus two `as` casts voiding discriminated-union checking. |
| 007 | Minor | Fidelity | all | `world/types.ts:172`, `index.ts:1266,1311` | Two unreconciled protocol declarations: `dep.protocol` (render tint only) vs the bound mix's protocol (all semantics). `dep.protocol='event'` + http mix renders violet "event" particles for a keep-alive HTTP call. |
| 012 | Minor | State lifecycle | all | `metrics.ts:286` vs `hostScheduler.ts:128-133` | Published `ramMb` unclamped by `memLimitMb` — a 512 MB container displays 900 MB, shown exactly when the user asks why it was OOM-killed. |
| 015 | Minor | Performance | all | `index.ts:1247-1269,1289-1313` | Particle cap enforced only in the inner loop; outer loops run to completion doing lookups, `.find`s, and a fresh `Object.values(prevFlows)` after the last slot is filled. |
| 016 | Minor | Performance | all | `PacketLayer.tsx:34-58` | `pathCache` memoises the path element but not its length — `getTotalLength()` per particle per frame on immutable geometry. Also `PROTOCOL_COLOR` hardcodes 4 hexes, violating the `var(--color-*)`-only law. |
| 019 | Minor | State lifecycle | all | `index.ts:1334-1370`, `simulation.store.ts:170-224` | All slow-converging state (burst credits, health hysteresis, EMAs, latency reservoir) is destroyed on every stop→edit→start. Correct, but **unacknowledged in the UI** — users compare a settled run against an unsettled one. |

---

## Execution Order

| Wave | Issues | Rationale |
|---|---|---|
| **1** | 001, 011, 012, 018 | Pure divergence and type bugs. Small, independent, no contract changes. **001 is the single highest-value fix in the audit.** |
| **2** | **003** | Unlocks 005, 006, and most of 008. Touches the rng stream — **land alone, re-baseline deliberately.** |
| **3** | 013, 015, 007, 014, 016 | Render hot path. Independent of waves 1–2, parallelisable. 014 largely closes as a consequence of 007 + 013. Re-benchmark before attempting 017. |
| **4** | 009, 010 | Capacity truth. Much easier to verify once wave 2's latency is trustworthy. |
| **5** | 002 | Largest change: new `broker.ts`, new contract fields, new analysis rule. Not before wave 2. ⚠️ parked |
| **6** | 004, 005, 006 | Depend on 002's `protocolOf` and 003's `totalLatencyMs`. ⚠️ 005 parked |
| **7** | 008, 019 | 008's Mechanism A must be **measured** after wave 2 before Mechanism B is built — B may prove unnecessary. |

`⚠️ parked` marks a capability listed as intentionally out of scope in `CLAUDE.md`'s Known Issues /
Roadmap. Those issues are fully specified here, but landing one is a **deliberate scope decision**
and must edit that roadmap section in the same change.

---

## Global Constraints — apply to every wave

1. **Run `npx vitest` and `bench/enginePerf.bench.test.ts` after every wave.**
   `DEGRADE_THRESHOLD_MS = 4` ms/step is a hard gate, not a guideline.
2. **The existing bench only measures `runStep`.** A new render-path benchmark (`__test_render()`
   driven in a tight loop at 400 particles) is a **prerequisite** for judging Wave 3 at all — it
   is specified as ISSUE-013, step 5. Do not attempt Wave 3 without it.
3. **`src/lib/worldEngine/types.ts` is a frozen contract.** Changes are additive only, and each
   one is logged in `.superpowers/sdd/contract-drift.md`.
4. **Every new optional field must default to the exact current behaviour**, so an existing
   `.scalemap` loads and simulates byte-identically. This repo asserts its regression floor with
   `toBe`, not `toBeCloseTo` — hold that standard. ISSUE-003 is the single sanctioned exception,
   and only via its explicit re-baseline procedure plus the preserved `serviceP50Ms` floor.
5. **Fix the divergence class properly:** one shared resolver, one guard test asserting the
   enforced value equals the displayed value. Correcting the number without the guard does not
   close the issue.
6. **Respect the two-call-site invariant.** Little's law lives in exactly two places —
   `hostScheduler`'s `InstanceLoad.activeConnections` (drives RAM and OOM victim selection) and
   `metrics.ts`'s `InstanceMetrics.activeConnections` (drives every view and the
   `ram-oversubscribed` rule). Both must call `connectionModel`'s `activeConnections()`.
7. **Do not add a parallel resolution point.** `connectionModel.ts` is the one connection-semantics
   point; `packetResolve.ts` is the one mix→wire-bytes point; `buildDepWireBytes` already collapses
   write-fraction. Extend these; never re-derive alongside them.
8. **Replay determinism is sacred.** No new rng draws in the render path —
   `pickPacketByIndex` is deliberately rng-free.
9. **New analysis rules go only in `ANALYSIS_RULES`** (`src/lib/analysis/runAnalysis.ts`).
10. **UI colour is `var(--color-*)` from `src/lib/theme.ts` only** — never a hex literal — correct
    in both dark and light mode. Animations respect `prefers-reduced-motion`.
11. **ISSUE-017 changes an ownership guarantee**, not a shape: the renderer would receive a
    borrowed, reused array. Audit every `attachRenderer` consumer before landing, and close it as
    not-needed if the Wave 3 re-benchmark already shows the budget met.
12. **Update `docs/module-boundaries.md` after each wave**, per the standing repo instruction.

---

## Reuse Map — extend the existing single-resolution points

Fixes in this spec deliberately do **not** introduce new resolution points. Each need below
already has an in-repo home:

| Need | Reuse |
|---|---|
| write-fraction resolution | `buildDepWireBytes` (`index.ts:184-193`) **already** collapses this correctly into `depBytesById` — make consumers read it; do not re-derive a third time |
| connection / pool semantics | `connectionModel.ts`, the declared single point. `ConnectionProfile` is documented closed under weighted blending, so `frameMultiplier` slots in cleanly |
| mix → bytes | `packetResolve.resolveWireSize` — put the stream compression ratio here so cost, NIC, and `cpuMsPerKb` all inherit it for free |
| `start()`-time index maps | the `depBytesById` / `depConnById` / `routeBytesById` pattern (`index.ts:1345,1347`) — safe because `doc` is frozen for the run |
| aggregate one-step-lagged runtime | `src/lib/managedDbRuntime.ts`'s shape (pure, no engine imports) — the template for a new `broker.ts` |
| carry-over backpressure | `networkRuntime.ts:118-128`'s `settleNic` bounded-backlog → `deliveredFraction` — the correct in-repo template for carrying load over rather than deleting it |
| rps-weighted sampling | `replay.ts`'s `pickWeighted`, if particle representativeness is ever needed |
| profile blending | `addProfile` / `meanProfile` (`index.ts:222-233`) — one helper, both tiers, never special-cased |
| latency distribution | `latency.ts`'s `sampleLatencyMs` mu/sigma derivation — reuse for the analytic timeout CDF; do not re-derive a distribution |

---

## Housekeeping (do this first — it is five minutes and prevents a wasted session)

**Relocate `SRE_Critique.md` → `docs/history/2026-07-legacy-canvas-sre-critique.md`** and prepend a
header marking it historical.

That document audits `particleEngine.ts` and five sibling files that were **deleted wholesale in
the Phase 2 rebuild**. Every finding in it — `_activeWorkers`, `MAX_PARTICLES`, the `setTimeout`
leaks — refers to code that is not in the repository. Left at the repo root beside this spec, it
will send the next agent hunting for absent modules and will contradict the orientation section
above. Note that `docs/history/` does not exist yet and must be created.

Suggested header:

```markdown
> **Historical document — does not describe the current codebase.**
> This critique audits the legacy React-Flow canvas app (`particleEngine.ts` and siblings),
> deleted wholesale in the Phase 2 rebuild (2026-07-08). None of the files or symbols it
> references exist today. Retained for design-rationale history only.
> For the current engine, see `docs/agent-onboarding.md` and `audit-spec.md`.
```

---
## Wave 1 — Divergence and Type Bugs

This wave fixes four small, independent bugs that share one root cause: a derived quantity is computed once for an enforcement path and re-derived (differently, or not at all) for a display path, so the number the engine acts on and the number the user sees can silently disagree — the same failure class the existing `DIVERGENCE GUARD` test in `src/lib/worldEngine/index.test.ts` defends for `activeConnections()`. None of these fixes touch `src/lib/worldEngine/types.ts`'s frozen render contract; all resolvers being introduced or reused are plain internal functions/maps threaded through existing optional parameters, so every pre-existing `.scalemap` world and every existing test keeps its exact numeric output by default.

### ISSUE-001: Route DB write-fraction routing and managed-DB aggregate load through the packet-derived resolver, not the raw dependency field

- **Category:** Fidelity
- **Severity:** Critical
- **Protocol Affected:** db
- **File(s):** `src/lib/worldEngine/flows.ts:557` — `splitDependencyShares` call inside the BFS dependency loop; `src/lib/managedDbRuntime.ts:169` — `aggregateManagedDbLoad`'s per-row write-weight lookup

**Problem Description**

Byte accounting (`flows.ts`'s `bucketBytes`, WAL amplification at line 435) and the per-caller managed-service fallback (`flows.ts:601`, already fixed in a prior wave — it reads `input.depBytesById?.[dep.id]?.writeFraction ?? dep.writeFraction ?? 0`) honour the packet-derived write fraction. Two other consumers of the same quantity do not:

1. `flows.ts:557` — `splitDependencyShares(admitted, candidates, roleOf, targetBp, dep.writeFraction ?? 0, healthWeightOf)` reads the raw, hand-authored `dep.writeFraction` directly. This is the function that decides, for a SQL primary/replica cluster, which admitted rps goes to the primary (writes) vs. the replicas (reads). A bound db packet mix that derives `writeFraction: 1` (e.g. a 100%-INSERT query-type mix) has zero effect here — the primary keeps receiving whatever the stale/absent hand-authored slider says (commonly 0, since `EdgeInspector` hides that slider and shows a read-only derived readout once a mix is bound, so the underlying `dep.writeFraction` field is never updated to match). The single-writer SPOF the whole mechanism exists to model (`flows.ts:55-58`'s comment: "Writes concentrating on one primary is the single-writer ceiling... the SPOF falls out for free") silently does not fall out.

2. `managedDbRuntime.ts:169` — `aggregateManagedDbLoad`'s per-row weight: `const w = Math.min(1, Math.max(0, bp?.dependencies.find(d => d.id === row.dependencyId)?.writeFraction ?? 0))`. This is the AGGREGATE path that `managedDbRuntimeFor` (the primary, Phase-5.4 mechanism — see that file's header comment: "a DB with a live runtime entry no longer reaches" the per-caller fallback) uses to split `totalRps` into `offeredWrite`/`offeredRead` before comparing each against `writeCeiling`/`readCeiling`. It also reads the raw `dep.writeFraction`, not the packet-derived value.

Worked example: a dependency edge binds a db packet mix whose query types are 100% INSERT, so `resolveWireSize` derives `writeFraction: 1` (visible in `EdgeInspector` as "100% write"). The edge's stored `BlueprintDependency.writeFraction` field is left at its default, `0`. At `managedDbRuntime.ts:169`, `w` resolves to `0`, so `aggregateManagedDbLoad` reports `offeredWrite: 0, offeredRead: totalRps`. `managedDbRuntimeFor` then measures saturation and refusal against `readCeiling` (often far larger than `writeCeiling`) instead of `writeCeiling`. A DB that should be visibly refusing/timing out at its single-writer ceiling instead reads as comfortably under capacity. Symmetrically, at `flows.ts:557`, the same edge's SQL cluster keeps splitting traffic by the stale `dep.writeFraction ?? 0` — i.e., routes the whole 100%-write load as if it were 100% reads, sending it to the replicas instead of the primary.

**Proposed Real-World Model / Fix**

Real systems don't have two independent opinions about a query mix's read/write split — a connection pool driver classifies each query once (by its SQL verb / query type) and every downstream capacity check (connection limits, read-replica routing, write-ahead-log throughput) reads that one classification. The repo already built this single point: `buildDepWireBytes` (`index.ts:184-193`) resolves `wire.writeFraction ?? dep.writeFraction ?? 0` into `depBytesById[dep.id].writeFraction` exactly once per run-start, from the frozen doc. The fix is to make both remaining consumers read `depBytesById` instead of re-deriving from `dep.writeFraction ?? 0` — never adding a third derivation.

- `flows.ts:557`: change the writeFraction argument to `input.depBytesById?.[dep.id]?.writeFraction ?? dep.writeFraction ?? 0` — textually identical to the fallback chain already used two lines away at `flows.ts:601`, so the file becomes internally consistent instead of split.
- `managedDbRuntime.ts:169`: `aggregateManagedDbLoad` has no visibility into `depBytesById` today — it only receives `prevFlows`, `doc`, `compiled`. Thread it through as a new parameter (mirroring how `flows.ts`'s `FlowInput.depBytesById` is already optional-by-default) so the aggregate path and the per-caller fallback path read the identical resolved number.

```
w = depBytesById?.[row.dependencyId]?.writeFraction ?? dep.writeFraction ?? 0
```

**Execution Steps**

1. In `src/lib/worldEngine/flows.ts`, at the `splitDependencyShares` call (currently `flows.ts:557`), change `dep.writeFraction ?? 0` to `input.depBytesById?.[dep.id]?.writeFraction ?? dep.writeFraction ?? 0`.
2. In `src/lib/managedDbRuntime.ts`, add an optional 4th parameter `depBytesById?: Record<string, { writeFraction?: number }>` to `aggregateManagedDbLoad` (signature at line 155-159), and use it in the per-row weight at line 169: `const w = Math.min(1, Math.max(0, depBytesById?.[row.dependencyId]?.writeFraction ?? bp?.dependencies.find(d => d.id === row.dependencyId)?.writeFraction ?? 0))`. Keep the parameter optional so every existing direct caller/test of `aggregateManagedDbLoad` (`managedDbRuntime.test.ts` if any call it directly, plus `flows.test.ts`) is unaffected by omission.
3. Thread the same optional parameter through `managedDbRuntime` (`managedDbRuntime.ts:185-198`, the whole-per-step wrapper) so it can pass it to `aggregateManagedDbLoad`.
4. In `src/lib/worldEngine/index.ts`, at the call site `const managedDbRt = s.hasManagedDbs ? managedDbRuntime(s.prevFlows, doc, compiled) : {}` (line 829), pass `s.depBytesById` as the new 4th argument: `managedDbRuntime(s.prevFlows, doc, compiled, s.depBytesById)`.
5. Do NOT re-import or reconstruct `resolveWireSize`/`buildDepWireBytes` inside `managedDbRuntime.ts` — the whole point is one resolution point (`index.ts:184-193`) feeding every consumer; a new import there would recreate the divergence class this fix removes.

**Verification Test**

- **File:** `src/lib/worldEngine/flows.test.ts` (extend the existing `describe('solveFlows — DB read/write routing', ...)` block, `flows.test.ts:298-373`)
- **Before:** a new test binding a `depBytesById` entry with `writeFraction: 1` for `d-db` while `dep('d-db', db.id)` carries no (or a contradicting) `writeFraction` shows the primary receiving 0 rps and the replica receiving the full admitted rps — i.e. `flows[primaryIid].offeredRps` is `0` even though the bound mix says 100% write. Assert this with `toBeCloseTo(0)` to pin the CURRENT (buggy) behavior before the fix lands, then delete/flip once fixed.
- **After:** same setup, `solveFlows(baseInput(doc, { [api.iid]: 1000 }, { depBytesById: { 'd-db': { reqBytes: 0, respBytes: 0, writeFraction: 1 } } }))` (adjust to whatever shape `baseInput`/`FlowInput` require for `depBytesById`) must show `flows[primaryIid].offeredRps` at `toBeCloseTo(1000)` and the replica at `toBeCloseTo(0)` — the packet-derived value now governs routing, matching what `EdgeInspector` displays.
- **File:** `src/lib/managedDbRuntime.test.ts` — add a guard test asserting `aggregateManagedDbLoad`'s returned `writeFraction` for a managed-DB dependency prefers `depBytesById`'s value over the dependency's raw `writeFraction` when both are supplied and disagree, e.g. `depBytesById: { 'd-db': { writeFraction: 1 } }` + `dep.writeFraction: 0` → `load[msId].writeFraction` must be `1`, not `0`.
- **Guard (divergence class):** add a test asserting the value `EdgeInspector` displays (`resolveWireSize(...).writeFraction`, `ConnectionsView.tsx:369`) equals the value `splitDependencyShares` and `aggregateManagedDbLoad` actually route on for the same edge, for at least one non-degenerate mix (e.g. mixed 70/30 read/write query types) — asserted with `toBe`, following the DIVERGENCE GUARD idiom in `src/lib/worldEngine/index.test.ts:1442-1457`.

---

### ISSUE-011: Publish CPU cores used from the same effective-CPU value the host scheduler enforces

- **Category:** State lifecycle
- **Severity:** Major
- **Protocol Affected:** all protocols (most visible on `short-lived`, whose handshake CPU term is otherwise invisible)
- **File(s):** `src/lib/worldEngine/metrics.ts:285` — published `cpuCoresUsed`; `src/lib/worldEngine/index.ts:696-714` — `effectiveCpuMs`/`effectiveCpuMsByInstance`, the value the host scheduler actually enforces against (fed into `InstanceLoad.cpuMsPerRequest` at `index.ts:736`, consumed by `hostScheduler.ts:82,101,108`)

**Problem Description**

`metrics.ts:285` publishes `cpuCoresUsed: rps * workload.cpuMsPerRequest / 1000` — the RAW, blueprint-authored `cpuMsPerRequest`, with no `cpuMsPerKb × sizeKb` term and no `handshakeCpuMs` term. But the host scheduler, which actually allocates cores and decides admission (`hostScheduler.ts:82`'s `demandCores`, `:101`'s `capCores`, `:108`'s `serviceRateByInstance`), is fed `cpuMsPerRequest: effectiveCpuMs(i.id, bp)` (`index.ts:736`), where `effectiveCpuMs` (`index.ts:696-701`) is:

```
effectiveCpuMs = cpuMsPerRequest + cpuMsPerKb × sizeKb + handshakeCpuMs
```

For a `short-lived`-connection route, `handshakeCpuMs` is `HANDSHAKE_CPU_MS = 2` ms per request (per the connection-semantics phase, `connectionModel.ts`). Worked example: `cpuMsPerRequest = 1` ms authored on the blueprint, `rps = 1000`, connection type `short-lived` (handshake 2 ms/req, no packet-size term). The host scheduler computes demand off `effectiveCpuMs = 1 + 2 = 3` ms → `demandCores = 1000 × 3 / 1000 = 3` cores, and throttles/admits accordingly. `metrics.ts:285` publishes `cpuCoresUsed = 1000 × 1 / 1000 = 1` core — one third of what the scheduler is actually enforcing. This sits directly next to `coreUtilization` (`metrics.ts:306`, sourced correctly from `host?.coreUtilization`) on the same server card, so the panel shows a utilization bar consistent with 3 cores of demand next to a `cpuCoresUsed` figure consistent with 1 — an internally contradictory display at the exact moment a user is trying to understand CPU saturation.

**Proposed Real-World Model / Fix**

A hypervisor's per-VM CPU-used gauge and its own scheduler's admission-control CPU estimate are computed from the same cgroup accounting — there is one CPU-time meter, read by both. The engine already built the single resolution point: `effectiveCpuMs` / `effectiveCpuMsByInstance` (`index.ts:696-714`), which folds in the packet-size CPU blend and the handshake CPU term and is already the value the host scheduler enforces against. The fix threads that same per-instance value into `buildBatch` (mirroring how `connProfiles` is already threaded, `metrics.ts:225` / `index.ts:1075`) and uses it in place of the raw `workload.cpuMsPerRequest` at `metrics.ts:285`.

```
cpuCoresUsed = rps × effectiveCpuMsByInstance[instanceId] / 1000   (fallback: workload.cpuMsPerRequest when absent)
```

**Execution Steps**

1. In `src/lib/worldEngine/metrics.ts`, add a new optional parameter to `buildBatch` (after the existing `connProfiles` param, `metrics.ts:225`): `effectiveCpuMsByInstance?: Record<InstanceId, number>`. Document it the same way as `connProfiles` — optional, defaulting to the pre-existing raw-`cpuMsPerRequest` behavior so every direct `buildBatch` caller/test that omits it is byte-identical.
2. At `metrics.ts:285`, change `cpuCoresUsed: rps * workload.cpuMsPerRequest / 1000` to `cpuCoresUsed: rps * (effectiveCpuMsByInstance?.[inst.id] ?? workload.cpuMsPerRequest) / 1000`.
3. In `src/lib/worldEngine/index.ts`, at the `buildBatch` call site (line 1075), pass the already-computed `effectiveCpuMsByInstance` map (built at `index.ts:706-714`) as the new argument: `buildBatch(s.metrics, doc, compiled, s.lastRoutingSnapshot, { ...s.windowTotals }, simMs, starved, connProfileByInstance, effectiveCpuMsByInstance)`.
4. Do not change `hostScheduler.ts` or `effectiveCpuMs` itself — this is a read-side fix only; the enforcement formula is already correct and is the source of truth being propagated.

**Verification Test**

- **File:** `src/lib/worldEngine/metrics.test.ts`
- **Before:** calling `buildBatch` with a fixture instance whose blueprint has `cpuMsPerRequest: 1` and passing an `effectiveCpuMsByInstance` map with `{ [instanceId]: 3 }` (simulating a short-lived-route instance) still yields `instances[instanceId].cpuCoresUsed` computed off the raw `1` ms — document this as the pre-fix assertion if writing a regression-style before/after pair, or skip straight to the after-assertion if this is a fresh test authored post-fix.
- **After:** same fixture, `instances[instanceId].cpuCoresUsed` must equal `rps * 3 / 1000` (`toBe`, not `toBeCloseTo`, following the repo's regression-floor convention), and omitting the new parameter entirely must reproduce the exact pre-existing value `rps * workload.cpuMsPerRequest / 1000` for every existing `metrics.test.ts` case (regression floor).
- **Guard (divergence class):** in `src/lib/worldEngine/index.test.ts`, extend the pattern used by the DIVERGENCE GUARD test (`index.test.ts:1442-1457`) with a CPU-specific sibling: run a `short-lived` connection world, read the host scheduler's implied demand (`server.specs.vcpu × host?.cpuPressure` or equivalent from `hostResults`) and the published `batch.instances[...].cpuCoresUsed` summed per server, and assert they agree (bounded ratio, `toBeGreaterThan`/`toBeLessThan` around 1, same style as the RAM guard) rather than differing by the ~3x the handshake term currently causes.

---

### ISSUE-012: Clamp published `ramMb` by the instance's container `memLimitMb`, matching what the host scheduler enforces

- **Category:** State lifecycle
- **Severity:** Minor
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/worldEngine/metrics.ts:286` — published `ramMb`; `src/lib/worldEngine/hostScheduler.ts:127-133` — the clamp the scheduler actually applies before OOM accounting

**Problem Description**

`metrics.ts:286` publishes `ramMb: workload.ramBaseMb + workload.ramPerConnMb * activeConnections` with no ceiling. The host scheduler, per-instance, clamps this exact quantity before it ever contributes to `ramUsedMb` or OOM victim selection:

```ts
// hostScheduler.ts:127-133
let instanceRam = l.ramBaseMb + l.ramPerConnMb * l.activeConnections
if (l.memLimitMb !== null && instanceRam > l.memLimitMb) {
  instanceRam = l.memLimitMb
  if (oomVictim === null) oomVictim = l.instanceId
}
```

Worked example: a container-runtime placement with `memLimitMb: 512`, `ramBaseMb: 100`, `ramPerConnMb: 0.8`, and 1,000 active connections. Unclamped: `100 + 0.8 × 1000 = 900` MB. The scheduler clamps its own accounting to `500 - wait, to memLimitMb = 512` MB and marks this instance the OOM victim — a real, observable kill. `metrics.ts:286` still publishes `ramMb: 900` — an impossible reading for a 512 MB-limited container, shown on the exact panel a user opens right after seeing an `oom_kill` event, at the exact moment they're asking "why did this get killed if it's not even full." Additionally, since `servers[server.id].ramByInstance` (`metrics.ts:297-299`) is built by mapping over `instances[i.id]?.ramMb`, the per-server sum of `ramByInstance` can exceed the scheduler's own `ramUsedMb` (`host?.ramUsedMb`, correctly clamped) shown on the same server card — two numbers on one card that should agree, don't.

**Proposed Real-World Model / Fix**

A container's own cgroup memory accounting is what `docker stats` / `kubectl top pod` reports — never a number computed independently of the limit that would trigger the OOM killer. The resolution point is the same clamp the scheduler already applies (`hostScheduler.ts:129-130`); `metrics.ts` needs only the per-instance `memLimitMb`, which is already reachable the same way `index.ts:746` reaches it — via `doc.placements[instance.placementId]?.runtime`. Since `buildBatch` already receives `doc` and `compiled` (which carries `placementId` on each `ServiceInstance`), no new parameter is needed — the lookup can be done inline at the same place `instances[inst.id]` is built.

```
memLimitMb = doc.placements[inst.placementId]?.runtime?.type === 'container'
  ? doc.placements[inst.placementId].runtime.memLimitMb : null
ramMb = memLimitMb != null ? Math.min(rawRamMb, memLimitMb) : rawRamMb
```

**Execution Steps**

1. In `src/lib/worldEngine/metrics.ts`, inside the `for (const inst of Object.values(compiled.instances))` loop (around line 247-288), before constructing the `instances[inst.id]` object, compute `const runtime = doc.placements[inst.placementId]?.runtime` and `const memLimitMb = runtime && runtime.type === 'container' ? runtime.memLimitMb : null` — mirroring `hostScheduler`'s own lookup at `index.ts:746` exactly (same conditions, same field), so the two can never read a different limit for the same instance.
2. Change line 286 from `ramMb: workload.ramBaseMb + workload.ramPerConnMb * activeConnections` to compute the raw value first, then clamp: `const rawRamMb = workload.ramBaseMb + workload.ramPerConnMb * activeConnections` followed by `ramMb: memLimitMb != null ? Math.min(rawRamMb, memLimitMb) : rawRamMb`.
3. Do not add a `memLimitMb`-carrying parameter to `buildBatch`'s signature — `doc`/`compiled` are already in scope and are the same source `hostScheduler`'s caller (`index.ts:746`) reads from, so introducing a second plumbing path would itself create a new instance of the divergence class this fix is removing.

**Verification Test**

- **File:** `src/lib/worldEngine/metrics.test.ts`
- **Before:** a fixture instance placed via a container-runtime placement with `memLimitMb: 512` and enough `activeConnections`/`ramPerConnMb` to raw-compute 900 MB currently publishes `instances[instanceId].ramMb` at `900` (unclamped) — this is the bug; write it as the documented pre-fix value if keeping a before/after pair, otherwise proceed directly to the after-assertion.
- **After:** same fixture, `instances[instanceId].ramMb` must be `toBe(512)`, and a non-container placement (or a container with a higher/no limit) must be unaffected — `toBe` the raw unclamped value, exactly reproducing every pre-existing `metrics.test.ts` assertion (regression floor).
- **Guard (divergence class):** extend or add a guard test (`metrics.test.ts` or `index.test.ts`, following the DIVERGENCE GUARD idiom at `index.test.ts:1442-1457`) asserting that for a memory-capped, over-limit instance, `hostResults[server.id].ramUsedMb`'s per-instance contribution and `batch.instances[instanceId].ramMb` are both clamped to the same `memLimitMb` value — `toBe`, not a bounded ratio, since post-fix these two should be EXACTLY equal (both apply the identical clamp), unlike the CPU/RAM-via-connections guards above which tolerate EMA-vs-raw skew.

---

### ISSUE-018: Make `sizeKb` genuinely optional in the packet-template type, and replace the two unchecked `as` casts on the packet-registry discriminated union with exhaustive per-protocol construction

- **Category:** Fidelity (types)
- **Severity:** Major
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/nodeConfig.ts:32` — `BasePacketTemplate.sizeKb: number`; `src/lib/nodeConfig.ts:176-181` — `updateRoute`'s `as HttpTemplate` cast; `src/lib/nodeConfig.ts:222-226` — `updatePacket`'s `as PacketTemplate` cast

**Problem Description**

`BasePacketTemplate.sizeKb` is declared `number` (non-optional) at `nodeConfig.ts:32`, but `src/lib/worldEngine/index.ts:131-136` documents, in its own comment, that this is false at runtime: "`route.sizeKb` is typed as a non-optional `number` on `HttpTemplate` but can genuinely be `undefined` at runtime (a blanked RoutesPanel 'req' size input, or a route saved before slice 1 introduced `sizeKb` with no per-route normalization on load)". That code site was patched (a prior review fix, per the same comment: "unguarded, this NaN'd cpuKb even with `cpuMsPerKb` unset — `0 * NaN = NaN`") — but only at that one call site. The type itself still asserts `sizeKb` is always a `number`, so every OTHER reader gets zero compiler protection against the same `undefined`. Concretely: `packetResolve.ts`'s `resolveWireSize`/`routeIngressBytes` and any future caller can multiply an `undefined` `sizeKb` into a byte/KB figure, producing `NaN`, which then propagates into `serviceRateByInstance` (`hostScheduler.ts:108`: `(cores * 1000) / Math.max(0.0001, l.cpuMsPerRequest)` — a `NaN` `cpuMsPerRequest` numerator makes the whole rate `NaN`). Once a served-capacity figure is `NaN`, every downstream comparison against it (`Math.min`, `>`, `<`) silently evaluates `false`, so an over-capacity instance stops being flagged as such — a silent, no-crash failure that only ever surfaces as "the numbers don't add up."

Separately, `updateRoute` (`nodeConfig.ts:176-181`) and `updatePacket` (`nodeConfig.ts:222-226`) each build their return value with an unchecked cast — `{ ...existing, ...patch } as HttpTemplate` and `{ ...fields, id: packetId } as PacketTemplate` respectively — across a discriminated union keyed on `protocol`. TypeScript's discriminant narrowing exists specifically to catch a patch that mixes fields from two different protocols (e.g. an `event`-only `topic` field surviving onto an object whose `protocol` is `db`); the `as` cast defeats that check entirely, so a caller that accidentally passes a mismatched-protocol patch gets no compile error and a malformed template at runtime.

**Proposed Real-World Model / Fix**

A real schema validator (e.g. a Zod/io-ts discriminated union) makes the missing-field case unrepresentable — `sizeKb` should be `number | undefined` in the type since the type is the contract every reader relies on, not just the one already-patched call site. The single resolution point is `packetResolve.ts`'s `resolveWireSize`/`routeIngressBytes`, which must be (and, per the `index.ts:136` comment, already is meant to be) the ONLY place an absent `sizeKb` gets its fallback applied — every other reader should go through it rather than reading `.sizeKb` directly.

1. Change `sizeKb: number` to `sizeKb?: number` in `BasePacketTemplate` (`nodeConfig.ts:33`), matching the sibling `responseSizeKb?: number` right below it and the runtime reality `index.ts:131-136` already documents.
2. Grep every direct reader of `.sizeKb` across the codebase (not just the already-patched `index.ts:136`) and confirm each either already null-coalesces or is routed through `packetResolve.ts`'s resolver; add `?? <fallback>` anywhere it doesn't (this is a type-only change surfacing pre-existing runtime gaps as compiler errors — TypeScript will point at every unguarded read once the field is optional).
3. Replace `updateRoute`'s cast (`nodeConfig.ts:179`) with a construction that keeps the discriminant checked: since `existing.protocol === 'http'` is already verified on the line above (`nodeConfig.ts:178`), spread onto a variable already typed `HttpTemplate` rather than casting the spread result — e.g. `const updated: HttpTemplate = { ...existing, ...patch }` only type-checks without `as` if `patch`'s type (`Partial<RouteFields>`) is provably assignable; if not, narrow `patch` to only `HttpTemplate`-legal keys instead of casting the OUTPUT.
4. Replace `updatePacket`'s cast (`nodeConfig.ts:224`) similarly — since `fields: PacketFields` is already the distributive-omit union type (`nodeConfig.ts:208`) and is protocol-tagged, construct via a switch/discriminated branch on `fields.protocol` (four short branches, one per `PacketProtocol`) instead of one blanket `as PacketTemplate`, so a future protocol added to the union produces a compile error here instead of silently falling through the cast.

**Execution Steps**

1. In `src/lib/nodeConfig.ts:33`, change `sizeKb: number` to `sizeKb?: number` on `BasePacketTemplate`; update its comment to state the field may be absent (mirroring `responseSizeKb`'s existing comment style).
2. Run `npx tsc --noEmit` (or `npm run build`) and fix every new type error this surfaces — expected sites: `packetResolve.ts` (`routeIngressBytes`/`resolveWireSize`), `nodeConfig.ts`'s own `routeIngressBytes`-adjacent helpers if any remain, `RoutesPanel.tsx`/`PacketsPanel.tsx`/`PacketModal.tsx` display code, and any test fixture in `nodeConfig.test.ts`/`packetResolve.test.ts` constructing a template literal with `sizeKb` — most will already pass a number and need no change; the goal is to confirm no live code path assumes non-optional without also removing the redundant runtime guard.
3. In `src/lib/worldEngine/index.ts:131-136`, the existing `route.sizeKb ?? (routeIngressBytes(undefined).reqBytes / 1024)` guard can stay exactly as-is (it becomes doubly-justified: the type now agrees with it) — do not remove it, since it also serves the "no per-route normalization on load" back-compat case, not just the type gap.
4. In `src/lib/nodeConfig.ts`, rewrite `updateRoute` (lines 176-181) to avoid the `as HttpTemplate` cast on its return value — construct/validate the merged object so the discriminant (`protocol: 'http'`) is provably preserved by the type system, not asserted.
5. In `src/lib/nodeConfig.ts`, rewrite `updatePacket` (lines 222-226) to avoid the `as PacketTemplate` cast — branch on `fields.protocol` and construct each of the four kinds (`http`, `event`, `stream`, `db`) explicitly, or use a helper that narrows `PacketFields` to `PacketTemplate` via an exhaustive switch with a `never`-check default so a fifth protocol added later fails to compile here.
6. Update `docs/module-boundaries.md`'s entry for `src/lib/nodeConfig.ts` to note `sizeKb` is optional (not just `responseSizeKb`), and that `updateRoute`/`updatePacket` no longer cast across the discriminated union.

**Verification Test**

- **File:** `src/lib/nodeConfig.test.ts`
- **Before:** constructing a `BasePacketTemplate`-derived object with `sizeKb` omitted currently requires a type-error workaround (e.g. `as any` or `sizeKb: undefined!`) in a test fixture, since the field is declared non-optional — this itself is evidence of the bug; note it if writing a before/after commentary.
- **After:** a fixture template with `sizeKb` genuinely omitted must type-check with no cast, and `listRoutes`/`listPackets`/`getRoute`/`getPacket` must handle it without producing `NaN` anywhere downstream (add a targeted `packetResolve.test.ts` case: `resolveWireSize` / `routeIngressBytes` called with a template whose `sizeKb` is `undefined` must return a finite fallback byte count, `toBe`-asserted against the documented 2 KB convention, not `NaN`).
- **File:** `src/lib/nodeConfig.test.ts`
- Add a case for `updateRoute` and one for `updatePacket` where the patch is deliberately protocol-mismatched (e.g. patching an `http` route with a field only `EventTemplate` has) — post-fix this must either fail to compile (if caught statically by removing the cast) or be demonstrably impossible to construct through the new branch-based code path; if TypeScript can't fully prevent it at the call boundary (patch objects are still loosely typed `Partial<RouteFields>`), add a runtime assertion test confirming the returned object's discriminant fields are internally consistent (no stray `topic`/`queryType`/`method` cross-contamination) rather than merely trusting the cast.
- **Guard (regression floor):** run the full `npx vitest` suite after the type change — this is a type-only edit at its core (step 1) plus two localized construction rewrites (steps 4-5), so no numeric assertion anywhere in the suite should change; a passing run with zero diffs in existing `toBe`/`toBeCloseTo` values is the confirmation this issue's fix introduced no behavior change, only removed the unsound `number`/cast guarantees.
## Wave 2 — The Latency Keystone (lands alone)

This wave is a single issue that changes engine-computed numbers (`serviceLatencyMs` composition, downstream `activeConnections`, and every published p50/p99), so it must land in its own commit/PR, with golden metric values re-baselined deliberately as part of the change — never as an incidental side effect of an unrelated diff. Everything in Wave 4 (and the parked ISSUE-005/006/008) depends on this landing first and cleanly.

### ISSUE-003: Compose downstream latency into the caller's serviceLatencyMs

- **Category:** Fidelity / Backpressure
- **Severity:** Critical
- **Protocol Affected:** all protocols (http, db, event, stream)
- **File(s):** `src/lib/worldEngine/flows.ts:365-386` (`getFlow`'s first-touch `serviceLatencyMs` sample, line 384 is the sample call itself), `src/lib/worldEngine/metrics.ts:271-273` (Little's-law `activeConnections` fed by `p50Ms`), `src/lib/worldEngine/replay.ts:113-127,153` (the tracer's `latencyMs = networkHopLatencyMs + downstreamServiceMs`, and the final `totalMs` sum) — confirmed at the current lines; the spec's cited ranges are accurate to within a few lines of drift.

**Problem Description**

`getFlow()` in `flows.ts` samples `serviceLatencyMs` for an instance exactly once, in BFS creation order, from that instance's OWN cpu/queue/NIC time only (line 384: `sampleLatencyMs(p50, p50 * SERVICE_P99_OVER_P50, rng) * multiplier + extraMs`). Nothing ever adds a callee's `serviceLatencyMs` back into its caller's. A three-hop chain `web → api → db`, each individually sampling ~20 ms, therefore reports `web.serviceLatencyMs ≈ 20 ms` — identical to a leaf service with no dependencies at all — when the true end-to-end cost of a `web` request is `20 + 20 + 20 = 60 ms`.

This is wrong in three compounding ways:

(a) **Every non-leaf p50/p99 is wrong.** `metrics.ts:266-270` derives `p50Ms`/`p99Ms` from the same per-instance `serviceLatencyMs` samples (via `state.window`/`latencyHistory`), so the published percentile for `web` is its own compute time, not what a real client experienced.

(b) **`activeConnections` is wrong, so RAM is wrong, so the OOM cascade is unreachable.** `metrics.ts:273`: `activeConnectionsOf(rps, p50Ms, profile)` — Little's law, `connections ≈ rps × holdTime(p50Ms)`. With `p50Ms` undercounted by every downstream hop's latency, a caller blocked on a slow dependency (e.g. a DB p50 spiking from 20 ms to 2000 ms under load) never shows the corresponding spike in the *caller's* `activeConnections`/RAM — only the DB instance's own metrics move. The canonical "slow dependency → connection pileup → OOM" cascade that `ram-oversubscribed` and the OOM-kill path exist to catch literally cannot be produced by this engine today, because the caller's held-connection time never inherits the callee's latency.

(c) **The tracer already does this correctly, so two panels on the same screen disagree.** `replay.ts:113-127` computes each hop's `latencyMs` as `networkHopLatencyMs + downstreamServiceMs` (where `downstreamServiceMs` reads the callee's `flows[toInstanceId].serviceLatencyMs`), and `totalMs` at line 153 sums `entry.serviceLatencyMs + Σ hops[].latencyMs` — a fully composed end-to-end number. Meanwhile the Analysis/metrics p50 chip for the SAME entry instance shows only its own uncomposed `serviceLatencyMs`. Opening the Trace panel next to the instance's p50 chip on the same web instance at the same second shows two different "latency" numbers with no explanation.

Worked example: `web` (own 5 ms) → `api` (own 15 ms) → `db` (own 40 ms), all keep-alive, rps=100.
- Today: `web.p50Ms ≈ 5`, `web.activeConnections ≈ 100 × 0.005 = 0.5`.
- Correct: `web.totalLatencyMs ≈ 5+15+40 = 60`, `web.activeConnections ≈ 100 × 0.06 = 6` — a 12x difference in the RAM the caller is charged for, which is exactly the number `ram-oversubscribed` and OOM-kill selection consume.

**Proposed Real-World Model / Fix**

Real systems (APM tools, distributed tracing) compute "service time" (self time, what this fix must NOT disturb — it is the existing `serviceLatencyMs` regression floor) separately from "total/span latency" (self + all synchronous children, what a client or an upstream caller actually waits on). The engine already computes the composed number once, correctly, inside the tracer (`replay.ts`); the fix is to make `flows.ts` compute the SAME composition for every instance, not just the one sampled path the tracer happens to walk, and to feed metrics from that composed value instead of the raw self-only sample.

Single resolution point: add a **post-pass composition step in `solveFlows`** (after the BFS in `flows.ts` has populated every `InstanceFlow.downstream[]` row, i.e. right before `return { flows, totals }` at the end of the function). Do NOT try to compose latency inline during BFS traversal — `flows` are built in first-touch (not necessarily topological) order and a downstream instance's `serviceLatencyMs` may not be fully known yet when its parent is first touched via one path but reached again via a different, longer path. Instead, walk the flow graph once in a second pass, memoized per instance (it's a DAG for composition purposes — the existing `chainHas` cycle guard at `flows.ts:635` already prevents true cycles in `downstream`, so a memoized DFS terminates):

```
totalLatencyMs(instanceId) =
  serviceLatencyMs(instanceId)                          // self: own CPU + queue + NIC (unchanged)
  + Σ over non-blocked downstream rows d of instanceId:
      (d.rps / Σ sibling rps at same instanceId) is NOT the weight —
      weight each row by its OWN rps share of the row's dependency call,
      i.e. rps-weighted mean over downstream rows:
        Σ_d ( d.rps × ( networkHopLatencyMs(d.hopClass) + calleeTotalLatencyMs(d) ) ) / Σ_d d.rps
  where calleeTotalLatencyMs(d) =
    d.toInstanceId != null ? totalLatencyMs(d.toInstanceId)
    : d.toManagedServiceId != null ? managedServiceLatencyMs(d.toManagedServiceId)  // reuse the
        // same managedDbRuntime.p50Ms / managedBaseLatencyMs fallback replay.ts already uses
    : 0   // blocked rows contribute 0 (they don't complete a call the caller waits on)
```

Reuse `hopLatencyMs` (already imported in `replay.ts`) for the network leg so the network-time model is not re-derived twice. Reuse `src/lib/worldEngine/latency.ts`'s `sampleLatencyMs` mu/sigma derivation ONLY for the self-time sample already at `flows.ts:384` (unchanged) — do not re-derive or re-sample latency in the composition pass; composition is pure arithmetic over already-sampled values, not a new rng draw (this also protects determinism: no new rng consumption means no reseeding/replay drift beyond the intended re-baseline).

Store the composed value as a NEW field, `InstanceFlow.totalLatencyMs`, added to the `InstanceFlow` interface at `flows.ts:282-290` (additive — `serviceLatencyMs` stays exactly as-is, self-only). Metrics then must swap which field feeds the public API:

- `types.ts`'s `InstanceMetrics` (currently `flows.ts:26-36` region — see `types.ts:26-36`) gets ONE new field, `serviceP50Ms: number` (self-only regression floor — the exact value `p50Ms` carries today), added additively per the frozen-contract rule. Log this in `.superpowers/sdd/contract-drift.md`.
- The existing `p50Ms`/`p99Ms`/`activeConnections` fields become the COMPOSED numbers (fed from `totalLatencyMs` samples instead of `serviceLatencyMs` samples) — this is the deliberate, documented behavior change this wave exists to make, not a silent one.
- `metrics.ts`'s `state.window` per-instance latency samples (feeding `history`/`sorted`/`percentile()` at `metrics.ts:255-270`) must record `totalLatencyMs`, not `serviceLatencyMs`, for the composed p50/p99/activeConnections; wherever the window-recording call site captures a per-step latency sample (search for where `w.latencies` is pushed, upstream of `metrics.ts` in the per-step sampling call, likely in `index.ts`'s per-step metrics-sampling call into `metrics.ts`), it must additionally record the self-only sample into a second reservoir (or capture both scalars per step) so `serviceP50Ms` can be computed the same way (EMA'd percentile) off the self-only stream.

**Execution Steps**

1. In `src/lib/worldEngine/flows.ts`, add `totalLatencyMs: number` to the `InstanceFlow` interface (line ~282-290), documented as "self + composed downstream, rps-weighted mean over non-blocked rows; blocked/refused rows and dangling deps contribute 0."
2. In `solveFlows` (same file), after the BFS loop completes and before `return { flows, totals }`, add a memoized recursive (or explicit-stack, to avoid recursion-depth surprises at `MAX_DEPTH = 8`) composition pass that fills `totalLatencyMs` for every entry in `flows`, using the formula above. Reuse `hopLatencyMs` — import it from wherever `replay.ts` imports it (`./networkRuntime` or similar; verify the import path) — and reuse the SAME managed-service latency fallback chain `replay.ts:119-125` uses (`managedDbRuntime?.[id]?.p50Ms ?? managedBaseLatencyMs(...)`), which means `solveFlows`'s signature/call sites need access to `managedDbRuntime` if they don't already — check `FlowInput` in `flows.ts` and thread it through additively if missing.
3. In `src/lib/worldEngine/types.ts`, add `serviceP50Ms: number` to `InstanceMetrics` (near line 26-36), with a one-line comment: "self-only p50 (pre-ISSUE-003 semantics); `p50Ms` below is now composed end-to-end." Log the addition in `.superpowers/sdd/contract-drift.md` with today's date and a one-line rationale.
4. In `src/lib/worldEngine/metrics.ts`, locate the per-instance latency-window bookkeeping (`state.window`, `w.latencies`, lines ~255-270) and the per-step call site upstream (in `index.ts`) that pushes a step's sampled latency into that window. Change the composed stream (`p50Ms`/`p99Ms`/`activeConnections` at lines 266-273) to source from `flow.totalLatencyMs` instead of `flow.serviceLatencyMs`; add a second EMA'd/percentile stream sourced from `flow.serviceLatencyMs` to populate the new `serviceP50Ms` field (a simple EMA is sufficient — it does not need the multi-second reservoir/un-smoothed-p99 treatment `p99Ms` gets, since there is no `serviceP99Ms` counterpart requested).
5. In `src/lib/worldEngine/replay.ts`, leave `latencyMs`/`totalMs` (lines 113-153) exactly as-is — they already compute the correct composed number by a different route (hop-by-hop tracing) and remain a useful cross-check; do not refactor them to call the new `totalLatencyMs` field, since the tracer intentionally follows ONE sampled path (rng-selected) rather than the rps-weighted mean the metrics composition uses — they are different statistics (a sampled realization vs. an expectation) and should stay computed independently as a built-in consistency check between the two.
6. Grep the codebase for every other reader of `InstanceMetrics.p50Ms`/`p99Ms`/`activeConnections` (analysis rules in `src/lib/analysis/rules/*.ts`, especially `capacity.ts`'s `ram-oversubscribed`, and any UI component under `src/app/world/` that renders a p50/p99 chip) to confirm none of them special-cased the old self-only semantics in a way that now reads as double-counted or nonsensical — they should all continue to compile and read correctly since the field's TYPE didn't change, only its computed value.

**Verification Test**

- **File:** `src/lib/worldEngine/index.test.ts` (engine-level integration tests; also add a focused unit test in a new or existing `src/lib/worldEngine/flows.test.ts` if one exists — check first).
- **Before:** construct a 3-hop fixture (`web → api → db`, each with an authored `cpuMsPerRequest` giving a known self-latency, e.g. 5/15/40 ms) and assert TODAY's (pre-fix) behavior as a documented-bug baseline in a throwaway/temporary assertion during development only — do not commit a "bug-documenting" test; instead, go straight to the post-fix assertions below, since Wave 2 is explicitly a deliberate re-baseline, not a bug-preserving change.
- **After:** `expect(b.instances[web].serviceP50Ms).toBeCloseTo(5, 0)` (self-only floor, matches historical value — regression floor, should use `toBe`/`toBeCloseTo` matching how existing self-latency assertions in the fixture are checked elsewhere in the suite; verify the neighboring convention — `index.test.ts` uses `toBe` for exact/deterministic values and reserves approximation for anything rng- or EMA-derived, so `serviceP50Ms`, being EMA'd, should use `toBeCloseTo`), and `expect(b.instances[web].p50Ms).toBeGreaterThan(b.instances[web].serviceP50Ms)` plus a looser bound like `expect(b.instances[web].p50Ms).toBeCloseTo(60, -1)` (composed self+api+db, within the EMA/reservoir's settling tolerance — run enough steps for the EMA to converge before asserting, matching how other EMA-fed fields are asserted elsewhere in the file, e.g. around the `health` EMA tests).
- **Re-baseline procedure (mandatory, explicit):** any existing golden-value test elsewhere in the suite (`worldEngine/*.test.ts`, `app/world/**/*.test.tsx` snapshot-style assertions, and any `bench/` fixture) that hardcodes a specific `p50Ms`/`p99Ms`/`activeConnections`/`ramMb` numeric literal for a MULTI-INSTANCE (non-leaf) fixture will change value under this fix — run the full `npx vitest` suite, collect every failing numeric assertion caused solely by the composition change (not a logic error), and update each literal in the SAME commit with a comment `// re-baselined ISSUE-003: was self-only latency, now composed`. Do not silently `git commit -am` a mass find/replace of expected numbers — each changed literal must be individually diffed against a hand-computed expectation (self + weighted downstream) to confirm the new number is CORRECT, not merely different, before accepting it as the new golden value.
- **Divergence guard:** add a test mirroring the existing `DIVERGENCE GUARD` pattern (`index.test.ts:1442-1458`) but for `serviceLatencyMs` vs. `totalLatencyMs` vs. the tracer's `totalMs`: run a 3-hop fixture with `getTracedRequests()` sampled many times (or seed-forced to walk the full chain), and assert `Math.abs(trace.totalMs - flows[entry].totalLatencyMs)` stays within a small tolerance (they are different statistics — sampled path vs. rps-weighted mean — so use a loose bound, e.g. `toBeLessThan(flows[entry].totalLatencyMs * 0.5)`, not exact equality) — this catches a future edit that updates one composition path (tracer's hop-walk) without updating the other (the new `solveFlows` post-pass), which is exactly the "two call sites drift" failure mode this whole wave exists to close off, one level up from the connectionModel guard.

## Wave 3 — Render Hot Path

This wave sits entirely inside two loops that must never be conflated: the **10 Hz sim loop**
(`runFrame`/`runStep`, `DEFAULT_STEP_MS = 100`, `src/lib/worldEngine/index.ts:54`) which advances
world state, and the **60 Hz render loop** (`renderAll` → `buildPayload` → `buildAzParticles` /
`buildServerParticles`, driven by `tick()`'s `requestAnimationFrame` at `index.ts:1323`) which
rebuilds a fresh, un-pooled particle array from the last completed step's `prevFlows` every frame.
A cost that lives in `buildAzParticles`/`buildServerParticles`/`buildPayload` runs 60x/sec
regardless of sim rate (including the 200 ms degraded step); a cost in `aggregateManagedDbLoad`
(called once per `runStep` at `index.ts:829`) runs at the sim rate, 10x/sec undegraded. Getting
this attribution right is what makes the severities below correct — a 60 Hz allocation is ~6x
hotter than the "same-shaped" 10 Hz one. `doc`/`compiled` are frozen for the lifetime of a run
(edit-locked while running, per `start()`), so anything derivable from them alone — index maps,
loop-invariant filters — is safe to hoist to `start()`-time once and reused for the run's entire
frame count, at zero staleness risk. The wave is gated on ISSUE-013's step 5: today
`bench/enginePerf.bench.test.ts` measures only `runStep` (the 10 Hz path) via `__test_step`; none
of the render-path fixes below (013, 015, 014's render call sites, 017) have a regression guard
until a companion benchmark drives `__test_render` directly. Land that benchmark FIRST, capture a
baseline number, then land 013/015/007/014/016 against it, then re-run it before deciding whether
017 is still needed.

### ISSUE-013: Precompute per-mix cumulative weight tables instead of filtering/reducing every particle

- **Category:** Performance
- **Severity:** Critical
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/packetResolve.ts:148-159` (`pickPacketByIndex`) — called from
  `src/lib/worldEngine/index.ts:1264` (`buildAzParticles`) and `:1307` (`buildServerParticles`)
- **Loop:** 60 Hz render

**Problem Description**

`pickPacketByIndex` (`packetResolve.ts:148-159`) does `(mix ?? []).filter(...)` to drop
zero/invalid-weight entries, then `.reduce(...)` to sum the survivors' weight, on every call. It
is called once per particle, inside the innermost `for (let k = 0; k < n ...)` loop of both
`buildAzParticles` (`index.ts:1264`, inside the `for (const row of f.downstream)` loop at
`:1261-1265`) and `buildServerParticles` (`index.ts:1307`, same shape at `:1304-1309`) — i.e. once
per particle per frame, at up to `MAX_AZ_PARTICLES = 400` (`index.ts:57`) or
`MAX_SERVER_PARTICLES = 50` (`index.ts:61`) particles per attached renderer. `mix` is a
`BlueprintDependency.packetMix`, resolved from the frozen `doc` — it cannot change while the
engine is running (topology is edit-locked at `start()`), so every filter+reduce after the first
call for a given `dep` is recomputing an answer that was already known. At 400 particles x 60
fps that is ~24,000 `.filter()` allocations (one throwaway array each) plus ~24,000 `.reduce()`
scans per second, purely to re-derive a static per-mix cumulative-weight table that has at most a
handful of entries and never changes for the run's duration.

**Proposed Real-World Model / Fix**

Split `pickPacketByIndex` into a `start()`-time precompute step and a per-particle lookup, exactly
like the existing `depBytesById`/`depConnById`/`routeBytesById`/`routeConnById` maps built once in
`start()` (`index.ts:1345-1348`) and read per-row thereafter. Add a pure function in
`packetResolve.ts`, e.g. `buildPickTable(mix: PacketMixEntry[] | undefined): PickTable`, that does
today's filter+reduce exactly once and returns `{ entries: {packetId, weight}[], total: number }`
(or `null` for an empty/invalid mix). Rewrite `pickPacketByIndex` to accept that precomputed table
instead of the raw `mix` array, keeping the same radical-inverse sampling math (`radicalInverse2`,
`PATTERN_SLOTS`) — this preserves the rng-free determinism property exactly, since no rng is
touched in either the old or new code path. Cache one `PickTable` per `dependencyId` in engine
state (a new `depPickTableById: Record<string, PickTable>` populated in `start()` alongside the
other `depXById` maps at `index.ts:1345-1348`), and have `buildAzParticles`/`buildServerParticles`
look up `s.depPickTableById[row.dependencyId]` instead of passing `dep?.packetMix` straight into
`pickPacketByIndex`.

**Execution Steps**

1. In `src/lib/packetResolve.ts`, add an exported `PickTable` type (`{ entries: { packetId: number; weight: number }[]; total: number } | null`) and an exported `buildPickTable(mix: PacketMixEntry[] | undefined): PickTable` function containing exactly the `filter`/`reduce` logic currently inline in `pickPacketByIndex` (lines 149-151).
2. Change `pickPacketByIndex`'s signature to `pickPacketByIndex(table: PickTable, k: number): number | null`, replacing its body's use of `entries`/`total` with the precomputed table's fields; return `null` immediately when `table` is `null`.
3. In `src/lib/worldEngine/index.ts`, add `depPickTableById: Record<string, PickTable>` to the engine's internal state type (co-located with `depBytesById`/`depConnById` around `:274` / `:269`).
4. In `start()` (`index.ts:1333-1352` block), populate `depPickTableById` by iterating every `BlueprintDependency` across `doc.blueprints` once and calling `buildPickTable(dep.packetMix)`, keyed by `dep.id` — same enumeration pattern as `buildDepWireBytes`/`buildDepConnProfiles` (find and reuse their existing blueprint/dependency traversal helper rather than writing a new one).
5. Update the two call sites: `index.ts:1264` becomes `pickPacketByIndex(s.depPickTableById[row.dependencyId] ?? null, k)`, and `index.ts:1307` likewise.
6. Add a new bench file `bench/renderPerf.bench.test.ts` (mirroring `bench/enginePerf.bench.test.ts`'s isolation header and median-of-100 pattern) that builds a fixture with packet-bound dependencies (mix of 3+ packets per edge), calls `engine.start(...)`, steps to steady flow, `attachRenderer` at `az` scope, then times 100 calls to `engine.__test_render(wallMs)` (incrementing `wallMs` each call so `phase` varies) — asserting median render time stays under a stated budget (pick a number ≥2x the measured baseline from step 7, to avoid CI flake, matching the existing bench's 2x-budget CI-fail-only pattern).
7. Run the new bench once BEFORE this fix (stash the change or check out a clean copy) to record a baseline median ms/render at 400 particles; note it in the bench file's header comment the same way `enginePerf.bench.test.ts` documents its own baseline.

**Verification Test**

- **File:** `bench/renderPerf.bench.test.ts` (new) + `src/lib/packetResolve.test.ts` (existing file — add cases)
- **Before:** `bench/renderPerf.bench.test.ts` (added in step 6, run against the unfixed code) records today's median ms/frame at 400 particles with a bound 3-packet mix; `packetResolve.test.ts` gets a new case asserting `pickPacketByIndex(buildPickTable(mix), k)` returns byte-identical `packetId` sequences (same `k` values 0..63) to the OLD `pickPacketByIndex(mix, k)` signature's output, captured as a literal array via `toBe`/`toEqual` per index — this is the bit-identical-output contract.
- **After:** the same bit-identical sequence assertion still passes (proves the precompute changed nothing observable), and the render bench's median ms/frame drops measurably below the step-7 baseline while the existing `bench/enginePerf.bench.test.ts` step-time median is unaffected (`runStep` never called `pickPacketByIndex`, so it's a no-op check, but re-run it to confirm no accidental regression).

---

### ISSUE-015: Enforce the particle cap in the outer flow/row loops, not just the innermost one

- **Category:** Performance
- **Severity:** Minor
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/worldEngine/index.ts:1241-1269` (`buildAzParticles`), `:1283-1313` (`buildServerParticles`)
- **Loop:** 60 Hz render

**Problem Description**

Both particle builders iterate `for (const f of Object.values(s.prevFlows))` (`index.ts:1247`,
`:1289`) — a fresh ~2,000-element array allocated by `Object.values` every call, once per
attached renderer per frame — then for each flow's `f.downstream` rows do a `bp?.dependencies.find(...)`
(`:1262`, `:1305`) and compute a target `n` before the innermost `for (let k = 0; k < n &&
particles.length < MAX_AZ_PARTICLES; k++)` loop, which is the ONLY place the cap
(`MAX_AZ_PARTICLES = 400` at `:57`, `MAX_SERVER_PARTICLES = 50` at `:61`) is actually checked. Once
`particles.length` hits the cap, every subsequent flow and every subsequent row within it still
runs: `Object.values(s.prevFlows)` still iterates all ~2,000 flows, `s.compiled.instances[...]`
lookups still happen, `bp?.dependencies.find(...)` still linear-scans, and the `n`-computing
`Math.min`/`Math.round` still executes — for zero rendered particles. In a busy world the true
flow count comfortably exceeds the 400-particle cap, so a meaningful fraction of every frame's
work is provably wasted once the cap is hit early in iteration order.

**Proposed Real-World Model / Fix**

Add an early-exit check at the top of each loop body (the `for (const f of ...)` in both
`buildAzParticles` and `buildServerParticles`): `if (particles.length >= MAX_AZ_PARTICLES) break`
(and the `MAX_SERVER_PARTICLES` equivalent), placed before the per-flow `azId`/`serverId` filter
so it short-circuits before any lookup work for that flow. This doesn't change WHICH particles are
emitted (iteration order is unchanged, so the first `MAX_AZ_PARTICLES` particles in today's
existing order are exactly the ones kept) — it only stops iterating once no more will be added,
which is bit-identical output by construction.

**Execution Steps**

1. In `buildAzParticles` (`index.ts:1247`), change the loop to `for (const f of Object.values(s.prevFlows)) { if (particles.length >= MAX_AZ_PARTICLES) break; ... }`.
2. In `buildServerParticles` (`index.ts:1289`), apply the same `if (particles.length >= MAX_SERVER_PARTICLES) break` guard.
3. Additionally guard the inner `for (const row of f.downstream)` loops (`:1261`, `:1304`) with the same cap check at their top, since a single flow with many downstream rows can also blow past the cap mid-flow without the outer break firing again until the next flow.
4. Do NOT attempt to cap `Object.values(s.prevFlows)` itself (e.g. via early array slicing) — the flows must be visited in their existing Map/Record insertion order for the cap-hit point to match today's behavior exactly; only add `break`/early-`continue`, no reordering.

**Verification Test**

- **File:** `src/lib/worldEngine/serverParticles.test.ts` and a new equivalent AZ-scope test (or extend an existing AZ particle test if one exists in `index.test.ts`)
- **Before:** construct a fixture whose steady-state flow set produces more than `MAX_AZ_PARTICLES` (400) candidate particles; call `__test_render` and assert `frame.particles.length === MAX_AZ_PARTICLES` and record the exact ordered `particles` array (fromId/toId/progress/packetId) as a golden snapshot.
- **After:** same fixture, same assertion `frame.particles.length === MAX_AZ_PARTICLES`, and the golden snapshot from Before matches EXACTLY (`toEqual`) post-fix — proving the early-exit changes nothing about which particles are emitted, only how much dead work runs after the cap is hit. Optionally add a call-count spy on `s.compiled.instances` lookups (or a cheap counter injected via a `__test_` hook) to demonstrate fewer object accesses occur post-cap, though the primary contract is the identical-output assertion.

---

### ISSUE-007: Validate `dep.protocol` against the bound packet mix's protocol at compile time

- **Category:** Fidelity
- **Severity:** Minor
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/world/types.ts:172` (`BlueprintDependency.protocol` field), `src/lib/worldEngine/index.ts:1264` (`buildAzParticles`'s `protocol: dep?.protocol ?? 'http'`), `:1309` (`buildServerParticles`, same)
- **Loop:** `start()`-time (validation) / 60 Hz render (the symptom)

**Problem Description**

`BlueprintDependency.protocol` (`types.ts:172`, `'http' | 'db' | 'event' | 'stream'`) is a
free-standing author-set field used ONLY for particle render tint at `index.ts:1264` and `:1309`
(`protocol: dep?.protocol ?? 'http'` — this value flows straight into `VisualParticle.protocol`,
which `PacketLayer.tsx`'s `PROTOCOL_COLOR` map keys off). The bound `dep.packetMix` independently
resolves to whatever protocol the referenced library packets actually are (via
`resolveWireSize`/`pickPacketByIndex` in `packetResolve.ts`), and THAT resolved protocol is what
drives every semantic consequence — wire bytes, connection-hold modeling
(`connectionModel.ts`'s protocol-wins rule), WAL write amplification. Nothing reconciles the two:
an author can set `dep.protocol = 'event'` on a dependency whose `packetMix` is entirely bound to
`http` packets, and the AZ/server views will render violet "event" particles for what the engine
is actually simulating, costing, and connection-modeling as a keep-alive HTTP call. This is purely
cosmetically wrong today, but `connectionModel.ts`'s documented protocol-wins rule already treats
`dep.protocol`/packet-protocol divergence as meaningful for non-http kinds (`stream`→streaming,
`db`/`event`→keep-alive) — the two-declaration gap will materially mislead a user reading the
board once real async `event`/`stream` delivery semantics (parked, see ISSUE-002) land, since the
render tint is the ONLY signal a user currently has for "this edge is event/stream," and it can
already lie.

**Proposed Real-World Model / Fix**

Add a `compileWorld`-time `CompileFinding` (structural/informational severity — reuse the existing
`compileWorld.ts` findings mechanism, don't invent a new one) that flags any `BlueprintDependency`
whose `packetMix` is non-empty and whose bound packets' protocols (majority-by-weight, or "mixed"
if genuinely split) disagree with `dep.protocol`. This surfaces the mismatch where every other
structural issue already surfaces (the Analysis tab, per CLAUDE.md's compile-findings merge rule),
without touching the render hot path at all — the fix is a `start()`-adjacent one-time compile
check, not a per-frame reconciliation. Do NOT auto-correct `dep.protocol` from the mix (that would
silently override an explicit author choice); the finding is advisory, matching how other
compile-time findings work today (i.e. surfaced, never auto-fixed).

**Execution Steps**

1. In `src/lib/world/compileWorld.ts`, locate where `CompileFinding`s are currently pushed for other dependency-level structural checks (existing findings like blocked-dependency-path) and add a new check: for every `BlueprintDependency` with a non-empty `packetMix`, resolve the majority-weight packet's `protocol` from `WorldDoc.packets.templates`, and if it differs from `dep.protocol`, push a new finding (new `CompileFinding` kind, e.g. `'protocol-mismatch'`) referencing the blueprint id and dependency id.
2. Add the new finding kind's id/severity/message shape to whatever finding-kind union/type lives alongside `CompileFinding` in `src/lib/world/types.ts` (additive — do not touch existing finding kinds).
3. Confirm the Analysis tab (`src/app/world/panels/AnalysisPanel` or wherever compile findings are merged — check `docs/module-boundaries.md`'s current pointer) renders unrecognized/new finding kinds gracefully by default (most finding-rendering code keys off a generic `{kind, severity, message, affectedEntities}` shape); if it hard-codes a switch over specific kinds, add the new kind there too.
4. No changes to `index.ts:1264`/`:1309` or `packetResolve.ts` — this issue is compile-time-only and must not touch the render loop.

**Verification Test**

- **File:** `src/lib/world/compileWorld.test.ts` (existing file — add cases)
- **Before:** a fixture with `dep.protocol = 'event'` and a `packetMix` bound entirely to an `http`-protocol packet template compiles with NO finding of the new kind present in `compiled.findings` (documents today's silent gap).
- **After:** the same fixture now produces exactly one `protocol-mismatch` finding referencing the dependency's id; a control fixture where `dep.protocol` matches the mix's majority protocol produces NO such finding (no false positives); a fixture with an EMPTY `packetMix` produces NO such finding regardless of `dep.protocol` (the check only fires when a mix actually exists to disagree with). All other existing `compileWorld.test.ts` assertions continue to pass unchanged (`toBe`, not `toBeCloseTo`, on finding counts).

---

### ISSUE-014: Replace per-row `dependencies.find` with a `start()`-time dependency index (fifth recurrence of this class)

- **Category:** Performance
- **Severity:** Major
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/worldEngine/index.ts:1262` (`buildAzParticles`, 60 Hz), `:1305` (`buildServerParticles`, 60 Hz), `src/lib/managedDbRuntime.ts:169` (`aggregateManagedDbLoad`, 10 Hz — file correction: this function lives in `src/lib/managedDbRuntime.ts`, NOT `src/lib/worldEngine/managedDbRuntime.ts`; it's called from `index.ts:829` once per `runStep`)
- **Loop:** 60 Hz render (`index.ts:1262`/`:1305`) + 10 Hz sim (`managedDbRuntime.ts:169`)

**Problem Description**

Three call sites resolve "the `BlueprintDependency` this flow row belongs to" via a linear
`bp?.dependencies.find(d => d.id === row.dependencyId)` scan: `buildAzParticles` (`index.ts:1262`,
inside the per-row loop, 60 Hz), `buildServerParticles` (`index.ts:1305`, same, 60 Hz), and
`aggregateManagedDbLoad` (`managedDbRuntime.ts:169`, inside its own per-flow/per-row double loop,
called once per `runStep` at 10 Hz). At the render sites this runs once per downstream row per
frame — with ~2,000 flows each carrying several downstream rows, this is on the order of 10^4-10^5
linear scans/sec at the render layer alone, each scanning a blueprint's full dependency list
(typically small, but non-constant — the cost scales with how dependency-heavy an authored
blueprint is, and the scan itself, not just its result, is loop-invariant work since `dep.id →
BlueprintDependency` never changes once `doc` is frozen at `start()`). This is explicitly the
FIFTH recurrence of this exact unindexed-lookup class in this repo, following ISSUE-032/073/075/076
— the standing fix pattern already exists in this file for four other loop-invariant lookups
(`routeBytesById`, `routeConnById`, `depBytesById`, `depConnById`, all built once in `start()` at
`index.ts:1345-1348` and read via `Record`/`Map` index thereafter) and simply hasn't been applied
to dependency-id→dependency-object resolution yet.

**Proposed Real-World Model / Fix**

Add one more `start()`-time index, `depById: Record<string, BlueprintDependency>`, built once by
iterating every blueprint's `dependencies` array and keying by `dep.id` — same enumeration and
storage pattern as the four existing `depXById`/`routeXById` maps at `index.ts:1345-1348`. Replace
all three `.find(...)` call sites with `s.depById[row.dependencyId]` (the two render sites) and the
equivalent parameter threaded into `aggregateManagedDbLoad`/`managedDbRuntime` (which currently
takes `prevFlows, doc, compiled` and re-derives `bp` from `compiled.instances`/`doc.blueprints`
internally at `managedDbRuntime.ts:165-169` — thread `depById` through as a new parameter rather
than re-deriving it inside that file, since `doc`/`compiled` are already frozen and available at
the `index.ts:829` call site).

**Execution Steps**

1. In `src/lib/worldEngine/index.ts`'s engine state type (near `depBytesById`/`depConnById`, `:269-274`), add `depById: Record<string, BlueprintDependency>`.
2. In `start()` (`index.ts:1333-1352`), populate `depById` by iterating `Object.values(doc.blueprints)` and each blueprint's `dependencies`, keying by `dep.id` — reuse whatever existing helper `buildDepWireBytes`/`buildDepConnProfiles` already uses to enumerate blueprint dependencies (check their implementations for a shared traversal to avoid writing a third copy).
3. Replace `index.ts:1262`'s `bp?.dependencies.find(d => d.id === row.dependencyId)` with `s.depById[row.dependencyId]` (note: this drops the `bp?.` optional-chain guard since `depById` is keyed globally, not per-blueprint — confirm a missing key still resolves to `undefined`, matching today's `bp?.dependencies.find(...)` returning `undefined` when `bp` itself is missing).
4. Replace `index.ts:1305`'s identical pattern the same way.
5. In `src/lib/managedDbRuntime.ts`, change `aggregateManagedDbLoad`'s signature to accept a fourth parameter `depById: Record<string, BlueprintDependency>`, and replace line 169's `bp?.dependencies.find(d => d.id === row.dependencyId)?.writeFraction` with `depById[row.dependencyId]?.writeFraction`. Drop the now-unused `bp` lookup at line ~167 if nothing else in that function body uses it (check `managedDbRuntime.ts:165-168` for other `bp` consumers before removing).
6. Update `managedDbRuntime`'s own signature (the wrapper calling `aggregateManagedDbLoad`, `managedDbRuntime.ts:185+`) to accept and forward `depById`.
7. Update the single call site at `index.ts:829` (`managedDbRuntime(s.prevFlows, doc, compiled)`) to `managedDbRuntime(s.prevFlows, doc, compiled, s.depById)`.

**Verification Test**

- **File:** `src/lib/managedDbRuntime.test.ts` (existing — add case) and `src/lib/worldEngine/serverParticles.test.ts` / AZ-particle test (existing — add case)
- **Before:** a fixture with multiple blueprints sharing dependency ids across different blueprints (to catch an indexing bug where `depById` collides ids that were previously correctly scoped per-blueprint via `bp?.dependencies.find`) is NOT possible today since dependency ids are per-blueprint-scoped in the schema — confirm this via `src/lib/world/types.ts`'s id-generation/factories before assuming global uniqueness; if ids are only unique per-blueprint (not globally), `depById` as a flat `Record<string, ...>` is UNSAFE and step 2 must key by a composite `${blueprintId}:${dep.id}` instead — resolve this ambiguity by reading `src/lib/world/factories.ts`'s dependency-id generator before implementing, and adjust the composite key at every one of steps 2-7 if ids are not globally unique.
- **After:** with the correct keying scheme confirmed, run the existing `managedDbRuntime.test.ts` and particle-builder test suites unchanged and assert `toBe`/`toEqual` byte-identical output (same `writeFraction`, same rendered `particles` arrays) against a pre-fix golden snapshot, plus a new assertion that the fix note in this issue (`ISSUE-014 largely closes as a consequence of fixing 007+013`) is re-evaluated after 013/015 land: re-run `bench/renderPerf.bench.test.ts` (added in ISSUE-013) after 014's fix and confirm it still meets budget, then decide whether the `depById` indexing measurably moved the needle over 013+015 alone before closing this issue as done (its severity was set assuming it's independently measurable — if 013+015 already absorb its cost, downgrade this note in `docs/module-boundaries.md`'s wave-3 summary rather than re-opening it).

---

### ISSUE-016: Cache path length alongside the cached SVGPathElement; source `PROTOCOL_COLOR` from `CATEGORY_COLORS`

- **Category:** Performance / Fidelity (two independent defects, same file)
- **Severity:** Minor
- **Protocol Affected:** all protocols
- **File(s):** `src/app/world/server/PacketLayer.tsx:34-58` (`pathCache`/`pointAt`), `:14-16` (`PROTOCOL_COLOR`)
- **Loop:** 60 Hz render (browser-side, downstream of the engine's `attachRenderer` payload)

**Problem Description**

Defect 1 (perf): `pathCache` (`PacketLayer.tsx:34`) memoizes the `SVGPathElement` itself per
`fromId→toId` key, but `pointAt` (`:41-58`) still calls `path.getTotalLength?.()` (`:52`) on
every invocation — i.e. once per particle per frame. `layout.tracePath(fromId, toId)`'s geometry
is immutable for the lifetime of the effect (it's rebuilt only when `layout` changes, which is
already the effect's own dependency-driven re-attach point per the file's header comment), so the
path's total length is exactly as loop-invariant as the path element itself, yet only the element
is cached. At up to `MAX_SERVER_PARTICLES = 50` particles/frame x 60 fps that's up to 3,000
redundant `getTotalLength()` calls/sec — an SVG geometry computation, not a cheap property read —
for a value that provably never changes once the path is cached. Defect 2 (fidelity/design-law):
`PROTOCOL_COLOR` (`:14-16`) hardcodes four hex literals (`#4A9EFF`, `#F5A623`, `#A78BFA`,
`#2DD4BF`) directly in TSX, which violates CLAUDE.md's absolute "no hardcoded hexes, `var(--color-
*)` only" design-system law — these are dark-mode-tuned values with no light-mode counterpart, so
particles render with the wrong (dark-tuned) hue when the app is in light mode, since nothing here
reads `ui.store`'s `themeMode`.

**Proposed Real-World Model / Fix**

Perf: extend the `pathCache` entry to store `{ path: SVGPathElement; len: number }`, computing
`len` once at cache-population time (right after `path.setAttribute('d', d)` at `:48`) instead of
on every `pointAt` call. Fidelity: since this is a `<canvas>` 2D context (not CSS/SVG), `ctx.
fillStyle` needs a literal resolved color string, not a `var(--color-*)` reference directly — the
codebase's existing idiom for this exact situation (JS/canvas code that needs a resolved,
theme-aware color) is `CATEGORY_COLORS` from `src/lib/theme.ts` branched on `ui.store`'s
`themeMode`, the same pattern `src/app/world/az/azFloorStyles.ts` and `ServerFaceplate.tsx` already
use. Map protocol → category the same way the design system already groups them (`http`→`compute`,
`db`→`storage`, `event`→`messaging`, `stream`→`network`, matching `CATEGORY_COLORS`' existing
accent/foreground split), picking `.accent` in dark mode and `.foreground.light` in light mode —
and subscribe to `themeMode` via `useUiStore` (already imported/used elsewhere in `app/world/`) so
a live theme toggle mid-run repaints correctly rather than freezing the color chosen at mount.

**Execution Steps**

1. In `PacketLayer.tsx`, change `pathCache`'s type from `Map<string, SVGPathElement>` to `Map<string, { path: SVGPathElement; len: number }>` (`:34`).
2. In `pointAt` (`:41-58`), where a new path is created (`:44-49`), compute `const len = path.getTotalLength?.() ?? 0` once and store `{ path, len }` in the cache; remove the `path.getTotalLength?.()` call from inside the `try` block (`:52`) and read the cached `len` instead. Keep the existing `try/catch` fallback-to-lerp behavior for `getPointAtLength` itself (that call still legitimately runs per-particle — only `getTotalLength` is loop-invariant).
3. Replace `PROTOCOL_COLOR`'s hardcoded hex map (`:14-16`) with a function `protocolColor(protocol: VisualParticle['protocol'], themeMode: 'dark' | 'light'): string` in the same file, built from `CATEGORY_COLORS` (imported from `../../../lib/theme`) via the mapping `http→compute, db→storage, event→messaging, stream→network`, returning `.accent` for dark and `.foreground.light` for light.
4. In the `PacketLayer` component body, add `const themeMode = useUiStore(s => s.themeMode)` (import `useUiStore` from `../../store/ui.store`, matching the existing import style already used for `useSimulationStore` at the top of the file) and thread it into the draw closure so `ctx.fillStyle = p.colorHint ?? protocolColor(p.protocol, themeMode)` (`:82`) re-resolves correctly whenever the effect re-attaches (the effect's dependency array already includes `layout`; add `themeMode` to it so a live toggle repaints without requiring `running` to cycle).

**Verification Test**

- **File:** a new `src/app/world/server/PacketLayer.test.tsx` (if none exists — check first) or extend the nearest existing render test for this component
- **Before:** a test spies on `SVGPathElement.prototype.getTotalLength` (jsdom stub or a manual mock), drives ≥2 render frames through the attached renderer with the SAME `fromId→toId` pair across both frames, and asserts `getTotalLength` was called MORE than once for that pair (documents today's per-frame recomputation) — a separate assertion renders in light mode (`ui.store`'s `themeMode = 'light'`) and confirms the drawn `fillStyle` for an `http` particle is NOT `#4A9EFF` (today's hardcoded dark value, wrong in light mode).
- **After:** the same two-frame test asserts `getTotalLength` was called EXACTLY once for that `fromId→toId` pair across both frames (cached); the light-mode test asserts `fillStyle` equals `CATEGORY_COLORS.compute.foreground.light`'s literal value, and a companion dark-mode assertion equals `CATEGORY_COLORS.compute.accent`'s literal value — both via `toBe`, not a substring/contains check. A regression check confirms particle x/y positions drawn are bit-identical (`toBe` on numeric pixel coordinates) between the pre- and post-fix code for an unchanged layout, proving the length-caching change altered no visible geometry.

---

### ISSUE-017: Re-benchmark before pooling particle objects — likely not needed if 013+015 already meet budget

- **Category:** Performance
- **Severity:** Major (conditional — see re-benchmark gate below)
- **Protocol Affected:** all protocols
- **File(s):** `src/lib/worldEngine/index.ts:1241-1316` (`buildAzParticles`/`buildServerParticles`), `:1128-1136` (`buildPayload`)
- **Loop:** 60 Hz render

**Problem Description**

Every frame, `buildAzParticles`/`buildServerParticles` allocate a fresh `VisualParticle` object
literal per particle (up to `MAX_AZ_PARTICLES = 400` or `MAX_SERVER_PARTICLES = 50`) with no
pooling — at 400 particles x 60 fps that's ~24,000 short-lived object allocations/sec, each with
6+ fields. Separately, `buildPayload` (`index.ts:1128-1136`) returns `{ simMs, particles: [], arcs:
[] }` for every non-matching scope level (e.g. an empty `particles: []` for a `globe`-scope
renderer, an empty `arcs: []` for `az`/`server`-scope renderers) — a fresh empty array allocated
per call per attached renderer, even though an empty array is semantically fungible and a single
shared frozen `EMPTY_ARR` constant would serve every such case identically. NOTE per CLAUDE.md's
particle-cannot-leak architectural fact: this is NOT a memory leak — `buildAzParticles`/
`buildServerParticles` correctly re-derive from `prevFlows` every frame and nothing survives
between frames — the finding is allocation CHURN (GC pressure), not unbounded growth.

**Proposed Real-World Model / Fix**

For the `buildPayload` empty-array case: replace both `particles: []` and `arcs: []` literals with
references to one module-level `const EMPTY_PARTICLES: VisualParticle[] = []` /
`const EMPTY_ARCS: VisualArc[] = []` (frozen via `Object.freeze` defensively, since a consumer
mutating a shared empty array would be a much worse bug than the allocation it replaces) — this is
safe with no ownership caveat, since an empty array carries no state to alias-corrupt.

For the particle-object pooling itself: **do not implement without first re-running
`bench/renderPerf.bench.test.ts` (landed in ISSUE-013 step 6) after ISSUE-013 and ISSUE-015 are
both in place.** State explicitly in the tracking issue: pooling changes an OWNERSHIP GUARANTEE,
not just an allocation shape — today's contract (implicit, but real: `renderAll` calls `onFrame`
with a payload the renderer is free to hold a reference to, e.g. for a diffing re-render or an
async draw) would become "the array/objects are borrowed and will be mutated in place next frame"
under pooling. Every `attachRenderer` consumer (`PacketLayer.tsx`'s canvas draw callback at
minimum — trace all others via `codegraph explore "attachRenderer"` or a repo-wide grep for
`.attachRenderer(`) must be confirmed to consume the payload synchronously within `onFrame` and
never retain a reference past that call, or pooling introduces a genuine, hard-to-diagnose
rendering-corruption bug. If the post-013+015 bench already lands within the `DEGRADE_THRESHOLD_MS
= 4` ms/step budget (note: that threshold is defined for `runStep`, the 10 Hz sim loop — the
render bench needs its own stated budget line, set in ISSUE-013 step 6, e.g. targeting sub-1ms/
frame at 400 particles as a reasonable render-loop analog), close this issue as not-needed and
record the final measured numbers in `docs/module-boundaries.md`'s wave-3 summary instead of
implementing pooling.

**Execution Steps**

1. Implement the `EMPTY_PARTICLES`/`EMPTY_ARCS` constant-sharing fix in `buildPayload` (`index.ts:1128-1136`) — this part is unconditional, low-risk, and independent of the pooling decision.
2. After ISSUE-013 and ISSUE-015 land, re-run `bench/renderPerf.bench.test.ts` and compare its median ms/frame against the budget line set in ISSUE-013 step 6.
3. IF within budget: close this issue, do not implement pooling, write the final before/013+015-after/would-be-pooling-delta numbers into `docs/module-boundaries.md`'s wave-3 section as the record of the decision.
4. IF NOT within budget: before writing any pooling code, grep the whole repo for every `.attachRenderer(` call site (`PacketLayer.tsx` is the confirmed one found this pass; there may be others in `GlobeView`/`region/` arc consumers) and confirm each one's `onFrame` callback does not retain the `FramePayload` or its `.particles`/`.arcs` array past the synchronous call — only then implement a fixed-size object pool (index-recycled, sized to `MAX_AZ_PARTICLES`/`MAX_SERVER_PARTICLES`) inside `buildAzParticles`/`buildServerParticles`, mutating pooled objects' fields in place instead of allocating new literals.

**Verification Test**

- **File:** `bench/renderPerf.bench.test.ts` (from ISSUE-013) + `src/lib/worldEngine/index.test.ts` (existing — add case for the `EMPTY_PARTICLES` sharing)
- **Before:** a test asserts `buildPayload`-produced empty `particles`/`arcs` arrays for two different scope calls are two DIFFERENT array instances (`expect(a).not.toBe(b)`, documenting today's per-call allocation); the render bench's post-013+015 median is recorded as the gating number.
- **After:** the same test asserts the two empty arrays ARE the same instance (`expect(a).toBe(b)`) after the `EMPTY_PARTICLES`/`EMPTY_ARCS` fix, AND that mutating one path's returned array is impossible (`Object.isFrozen(a)` true, or an attempted push throws in strict mode) as a safety-net regression guard. If pooling was implemented per step 4 above, add a dedicated ownership test: attach two renderers to the same scope, hold a reference to frame N's `particles` array in a test-side variable, request frame N+1, and assert the held reference's contents at frame N's values are NO LONGER what they were (documents the new borrowed-array contract explicitly, so a future consumer relying on retained references gets a named, findable test rather than a mystery bug) — this test's presence is itself part of the fix, since it makes the ownership change discoverable.
## Wave 4 — Capacity Truth

Both issues here are about the engine silently under- or over-reporting capacity/throughput after Wave 2 has made latency trustworthy — they are independent of each other and can land together or separately, but both benefit from Wave 2 already being in `main` since ISSUE-009's NIC ceiling interacts with the same per-instance service-rate path that ISSUE-003's composed latency now feeds queueing delay into (`flows.ts:509`'s `q0/capacity` queue-delay term reads `capacityOf`, which is fed by `serviceRateByInstance`, the exact map ISSUE-009 fixes).

### ISSUE-009: Size the NIC service-rate ceiling off the resolved wire bytes, not module constants

- **Category:** Backpressure / Fidelity
- **Severity:** Major
- **Protocol Affected:** all protocols (http, db, event, stream — anywhere a route or dependency edge authors a payload size larger than the 2 KB default)
- **File(s):** `src/lib/worldEngine/index.ts:757-767` — the `nicCeilingRps` computation and its per-instance share allocation; `src/lib/worldEngine/index.ts:1345,1347` — `routeBytesById`/`depBytesById`, the already-built resolved-size index maps this fix must read from; `src/lib/worldEngine/networkRuntime.ts` — source of the `NIC_REQUEST_BYTES`/`NIC_RESPONSE_BYTES` module constants being misused as the divisor.

**Problem Description**

`index.ts:760-761`:
```ts
const nicCeilingRps =
  ((server.specs.nicMbps * 1e6) / 8) / Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)
```
`NIC_REQUEST_BYTES`/`NIC_RESPONSE_BYTES` are fixed MODULE constants (the 2 KB-class default used only as a fallback elsewhere, e.g. `index.ts:129-130,201,892-893` where they gate `route.sizeKb != null ? ... : NIC_REQUEST_BYTES`). This ceiling is computed ONCE per server, per step, shared across every instance on that server via `cpuShares` weighting (lines 762-767) — it never looks at what any instance's actual traffic is sized as, even though the exact resolved-size maps it needs (`s.routeBytesById`, `s.depBytesById`) are already built at `start()` (lines 1345, 1347) and already consumed correctly elsewhere for NIC byte BOOKING (the actual bytes-transferred accounting, e.g. lines 640, 891 read `s.depBytesById[row.dependencyId]`). The comment immediately above this code, `index.ts:757` ("the worst byte direction governs (mirrors evaluateNic)"), documents an intent — track the real per-edge worst-case byte size — that the constant-divisor code directly contradicts: it mirrors nothing; it uses a flat 2 KB regardless of what `evaluateNic`/the booking path actually charges.

Worked example: a 1 Gbps NIC (`nicMbps = 1000`), an edge whose resolved wire size (`routeBytesById`/`depBytesById`) is 5 MB (5,242,880 bytes) each way — a bulk file/export endpoint, or a `db` packet with a large result set.
- Current ceiling: `(1000e6/8) / 2048 = 125,000,000 / 2048 ≈ 61,035 rps`.
- Correct ceiling: `125,000,000 / 5,242,880 ≈ 23.8 rps`.
- That's a **~2,565x overstatement** (spec's "~2,400x" is the right order of magnitude; exact ratio depends on the specific KB values authored — both figures are illustrative, not a fixed constant, since it scales with `actualBytes / 2048`).

Net effect: any server hosting a large-payload edge (bulk export, media, big DB result sets) is modeled as having orders-of-magnitude more NIC throughput than physically possible — the NIC never becomes the bottleneck in the simulation for such edges, when in reality it should saturate almost immediately. This directly undermines the fidelity guarantee for exactly the workloads (large payloads) where NIC modeling matters most.

**Proposed Real-World Model / Fix**

Real NIC service-rate ceilings are `line_rate_bytes_per_sec / bytes_per_request`, where `bytes_per_request` is whatever THIS traffic's actual average frame/payload size is — not a fixed MTU-ish constant. Since this ceiling is computed per-SERVER (shared across possibly-heterogeneous instances/edges resident on it) rather than per-edge, the fix must produce a PER-INSTANCE (or per-instance-aggregate) effective byte size, not a single server-wide one — mirroring how `serviceRateByInstance` is already computed per-instance in the loop at lines 762-767.

```
effectiveWireBytes(instanceId) =
  rps-weighted mean, over this instance's entry-route AND outbound-dependency wire sizes
  resolved via the SAME resolveWireSize four-tier fallback packetResolve.ts already defines
  (bound mix → inline KB → registry default → 2 KB), i.e.:
    Σ (edgeBytes_e × edgeRps_e) / Σ edgeRps_e
  falling back to max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES) when the instance has no
  resolvable traffic yet this step (cold start / zero rps) — this IS the current behavior,
  so it becomes the fallback branch rather than the only branch.

nicShare(instanceId) = nicCeilingBytesPerSec(server) / effectiveWireBytes(instanceId)
  where nicCeilingBytesPerSec(server) = server.specs.nicMbps * 1e6 / 8   (unchanged)
```

Concretely: move the `Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)` divisor OUT of the single server-wide `nicCeilingRps` and into the per-instance loop (lines 763-766), replacing the flat divisor with each instance's resolved effective wire size for this step — read from `s.routeBytesById`/`s.depBytesById` (or the per-instance flow rows if a per-instance byte accumulator already exists from the booking path at lines 640/891 — reuse THAT if it already aggregates per-instance-per-step bytes, since duplicating the resolution logic risks a second divergence-class bug; check whether `flows.ts`'s `bucketBytes` or an equivalent per-instance accumulator already exists before writing a new one).

**Execution Steps**

1. In `src/lib/worldEngine/index.ts`, inspect the loop at lines 762-767 (`for (const l of loads) { ... }`) and identify what per-instance data is available there (`loads` array — check its element shape) — determine whether a per-instance resolved byte size is already computed earlier in the same step (e.g. from the flow-solving pass that already ran, producing `flows`) or must be looked up fresh from `s.routeBytesById`/`s.depBytesById` keyed by the instance's entry route / outbound dependency ids.
2. Change line 760-761's `nicCeilingRps` from a single server-wide rps figure into a server-wide BYTES-PER-SEC figure only (`const nicCeilingBytesPerSec = (server.specs.nicMbps * 1e6) / 8`), dropping the `/ Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)` division entirely from this line.
3. Inside the per-instance loop (lines 763-766), compute `effectiveWireBytes` for instance `l` per the formula above (rps-weighted mean of resolved edge sizes for that instance this step; fall back to `Math.max(NIC_REQUEST_BYTES, NIC_RESPONSE_BYTES)` when the instance has zero resolvable traffic), then compute `nicShare = (nicCeilingBytesPerSec * (Math.max(0, l.cpuShares ?? 1) / totalShares))` — wait: check carefully whether the cpu-share-weighted split should apply to the BYTES-PER-SEC ceiling (split bandwidth by share, then each instance's own rps ceiling = its bandwidth share / its own wire size) rather than to an rps figure — this is the more physically correct order (split bytes/sec first, since that's the physically shared resource, then convert to rps per instance using THAT instance's own size) — implement it as: `const instanceBandwidthShare = nicCeilingBytesPerSec * (Math.max(0, l.cpuShares ?? 1) / totalShares); const nicShare = instanceBandwidthShare / effectiveWireBytes;`.
4. Verify `NIC_REQUEST_BYTES`/`NIC_RESPONSE_BYTES` imports at the top of `index.ts` (line 33) are still used elsewhere in the file (lines 129-130, 201, 892-893) — do not remove the import, only stop using it as the ceiling's divisor.
5. Confirm this reuses, rather than reimplements, `packetResolve.ts`'s `resolveWireSize` — if the byte lookup needed here differs from what `routeBytesById`/`depBytesById` already store (e.g. if those maps store STATIC per-route/per-dependency sizes rather than a live rps-weighted blend), either read the static per-edge size directly (simpler, and consistent with how NIC booking elsewhere already reads these exact maps at lines 640/891) rather than inventing a new rps-weighted-blend computation — prefer the simplest fix that reuses an existing map without introducing a second, subtly different resolution path (the divergence-class risk called out in the audit background).

**Verification Test**

- **File:** `src/lib/worldEngine/index.test.ts` (or a new/existing `networkRuntime.test.ts` if NIC-ceiling logic is more narrowly unit-testable there — check for an existing NIC test fixture first).
- **Before:** construct a fixture with a single server (`nicMbps: 1000`), one instance, one route/dependency authored with a large `sizeKb`/`responseSizeKb` (e.g. 5000 KB), and enough offered demand to exceed the true NIC ceiling; assert (documenting today's bug) that the engine currently admits far more than ~24 rps at that server — e.g. `expect(b.instances[inst].rps).toBeGreaterThan(1000)` — passes today because the ceiling is ~61,035 rps rather than ~24.
- **After:** same fixture; assert the admitted/serviceable rps is capped near the physically correct ceiling: `expect(b.instances[inst].rps).toBeLessThan(30)` (loose upper bound around the ~23.8 rps true ceiling, allowing for queueing/CPU also playing a role) and, ideally, a second small-payload control fixture (2 KB, well within old and new behavior) asserting `expect(b.instances[inst].rps).toBeCloseTo(<offered demand>, -1)` to confirm the fix does NOT regress the common case where wire size is at/below the old flat default.
- Add a regression-floor test with the EXACT default 2 KB size (no authored `sizeKb`) confirming the ceiling computation reduces to today's `nicCeilingRps` formula bit-for-bit (`toBe`, not `toBeCloseTo`) — this is the "every new optional/derived path defaults to current behavior" guarantee for the case where no route/dependency author ever set a custom size.

### ISSUE-010: Surface silently-dropped fan-out at depth cap, cycle cut, and dangling dependencies

- **Category:** Fidelity
- **Severity:** Major
- **Protocol Affected:** all protocols (http, db, event, stream)
- **File(s):** `src/lib/worldEngine/flows.ts:539` (`MAX_DEPTH` cap — confirmed, `MAX_DEPTH = 8` defined at line 37), `src/lib/worldEngine/flows.ts:552` (dangling-dependency `continue` — confirmed, comment reads "dangling dep: compile emitted nothing"), `src/lib/worldEngine/flows.ts:635` (cycle-guard `continue` via `chainHas` — confirmed).

**Problem Description**

Three separate `continue`/early-exit points in `solveFlows`'s BFS silently discard fan-out with no event, no metric, no finding:

1. `flows.ts:539`: `if (item.depth >= MAX_DEPTH) continue` — once a request chain reaches 8 hops, it simply stops fanning out further. The instance at hop 8 is processed (it gets `admittedRps`, its own metrics), but whatever it WOULD have called at hop 9 never appears anywhere — no `refusedRps`, no `downstream` row, nothing. A 9-hop authored chain silently models only 8 hops; the 9th-hop service reports zero traffic, zero cost, and (having no load at all) status `healthy`.
2. `flows.ts:552`: `if (!candidates || candidates.length === 0) continue` — a dependency the compiler resolved to zero compiled paths (misconfigured target, blocked-and-filtered-out routing, or a genuinely dangling reference) is dropped with a code comment but no runtime signal. This is distinct from a BLOCKED path (which at least produces a `blocked: true` downstream row visible in the UI/analysis) — a dangling dependency produces nothing at all.
3. `flows.ts:635`: `if (chainHas(item, toId)) continue` — a cycle is cut (correctly, to prevent infinite BFS), and the comment says "row recorded, no re-entry," but the row recorded is the row INTO the cyclic target (via `addDownstream` two lines above), not a marker that the cycle was cut there — a viewer of `downstream` sees a normal-looking row with no indication that this specific call would have recursed and was truncated instead.

In all three cases the failure mode is silent under-reporting: the instance/edge in question looks exactly like a `healthy`, zero-traffic, correctly-provisioned part of the system. For an analysis tool whose entire purpose is surfacing architecture problems, "the tool didn't flag hop 9 because it never modeled hop 9" is worse than not modeling it at all, because the user reasonably reads "no findings past this depth" as "verified fine past this depth."

**Proposed Real-World Model / Fix**

Real distributed tracing systems (and API gateways with configured max-hop/max-redirect limits) emit an explicit signal when a call chain is truncated — a trace span marked "truncated," a `Via`/hop-count-exceeded response, or a linter warning for unreachable/cyclic config. The fix here is NOT to change simulation behavior (uncapping `MAX_DEPTH` or resolving dangling deps is out of scope and could blow up BFS cost or hide a genuine authoring bug) — it's to make each of the three truncation points EMIT something so it's visible, per the existing event/analysis-rule infrastructure rather than a new channel.

```
depth-cap truncation:
  emit EngineEvent { kind: 'chain_depth_exceeded' (NEW, additive to EngineEventKind),
                     severity: 'warning',
                     message: `dependency chain exceeded MAX_DEPTH (${MAX_DEPTH}) hops`,
                     affected: [item.instanceId] }
  — rate-limited/deduped per (instanceId) per batch window, same pattern other high-frequency
    events use (check how e.g. 'connection_refused' avoids per-request event spam — likely
    aggregated at the metrics-sampling layer, not emitted once per BFS item)

dangling dependency:
  surface via a NEW analysis rule in ANALYSIS_RULES (structural family, alongside existing
  compile-time findings), e.g. 'dangling-dependency-no-targets': for each
  (instance, dependency) pair where the compiler produced zero CompiledPaths for a NON-blocked
  reason, emit an AnalysisFinding pointing at the instance + dependency. Prefer this over an
  engine event since it's a static/structural property of the compiled world, not a
  per-step runtime event — it doesn't need `compiled.findings`/analysis to wait for a
  simulation run to detect it, and matches how compile-time structural issues are already
  surfaced (blocked-dependency-path, etc.)

cycle cut:
  extend the DownstreamFlow row (or add a sibling event) that records the cut: either add an
  optional `truncatedCycle?: boolean` field to the DownstreamFlow row shape (additive,
  frozen-contract-safe if DownstreamFlow lives in the same types.ts contract — verify), or
  emit an EngineEvent similar to the depth-cap case: kind 'chain_cycle_cut', affected:
  [item.instanceId, toId].
```

**Execution Steps**

1. In `src/lib/worldEngine/types.ts`, add `'chain_depth_exceeded'` and `'chain_cycle_cut'` to the `EngineEventKind` union (near line 139-153), each with a one-line comment matching the style of neighboring entries (e.g. `// dependency chain hit MAX_DEPTH and stopped fanning out further`).
2. In `src/lib/worldEngine/flows.ts` at line 539, before/instead of the bare `continue`, push an event descriptor into whatever event-collection mechanism `solveFlows` already has access to (check `FlowInput`/`solveFlows`'s signature for an existing events sink — if none exists, this may need to be threaded through from the caller in `index.ts`, OR handled by returning a `depthExceededInstanceIds: Set<InstanceId>` alongside `flows`/`totals` in `solveFlows`'s return value, additive to its return type, which `index.ts` then turns into ONE deduped `EngineEvent` per server-step rather than per BFS item — prefer this pattered-return approach over threading a live event emitter into the pure `solveFlows` function, to keep it pure/testable).
3. Similarly at line 635 (cycle cut), collect cut edges into a returned set/array (e.g. `cycleCutEdges: { fromId: InstanceId; toId: InstanceId }[]`) rather than emitting events from inside the pure solver.
4. In `src/lib/worldEngine/index.ts`, at the call site of `solveFlows` (search for where it's invoked per step), read the new `depthExceededInstanceIds`/`cycleCutEdges` return fields and emit the corresponding `EngineEvent`s via the existing event-emission path (`callbacks.onEvent`, mirroring how other per-step events like `oom_kill` are raised) — dedupe so a chain that's ALREADY over-depth every step doesn't spam one event per second per instance (check the existing dedup pattern for steady-state conditions, e.g. how `breaker_open` avoids re-firing every step while a breaker stays open — likely a "only emit on state transition" check against previous-step state, which will need a small piece of persisted per-instance state, e.g. a `Set<InstanceId>` of "already reported this run" carried in engine state `s`).
5. For the dangling-dependency case (line 552), do NOT add a per-step event (it's not a per-step condition, it's structural/compile-time) — instead add a new rule to `src/lib/analysis/rules/structural.ts` (or wherever compile-time dependency-resolution findings currently live — check `blocked-dependency-path`'s home file first, per CLAUDE.md's note that findings must go only in `ANALYSIS_RULES`), that inspects `compiled` for any `(instance, dependency)` pair with zero resolved `CompiledPath`s for a reason other than an intentional block, and emits an `AnalysisFinding`. Register it in `ANALYSIS_RULES` in `src/lib/analysis/runAnalysis.ts` per the existing registry pattern — do not special-case its execution.
6. Update `docs/module-boundaries.md` to note the new event kinds and analysis rule, and log the `EngineEventKind`/any `DownstreamFlow`/`solveFlows` return-shape additions in `.superpowers/sdd/contract-drift.md`.

**Verification Test**

- **File:** `src/lib/worldEngine/flows.test.ts` (pure-solver unit tests, if it exists — check first; `flows.ts` is a pure function so it's the natural home) and `src/lib/analysis/rules/structural.test.ts` for the dangling-dependency rule.
- **Before:** construct a 9-hop authored dependency chain (blueprints A→B→C→...→I, each with one dependency to the next), run `solveFlows`, and assert today's silent-drop behavior: `expect(flows[hop9Instance]).toBeUndefined()` or `expect(flows[hop9Instance]?.offeredRps ?? 0).toBe(0)` with NO corresponding event/finding anywhere — documents the bug.
- **After:** same fixture; assert `result.depthExceededInstanceIds.has(hop8InstanceId)).toBe(true)` (or equivalent per the chosen return shape), and at the `index.ts` integration level (`index.test.ts`), assert `sim.events.some(e => e.kind === 'chain_depth_exceeded' && e.affected.includes(hop8InstanceId))` is `true` after running the engine a few steps with this world.
- For the dangling-dependency rule: construct a `WorldDoc` with a blueprint dependency whose target resolves to zero `CompiledPath`s (e.g. target blueprint has no placements), run `runAnalysis`, and assert `findings.some(f => f.ruleId === 'dangling-dependency-no-targets' && f.affected.includes(instanceId))` is `true`; assert it does NOT fire for a dependency that resolves normally (negative control, same fixture minus the misconfiguration).
- For the cycle-cut case: construct a fixture with a genuine A→B→A dependency cycle, run `solveFlows`, and assert the returned cut-edge list contains the `(B, A)` edge that `chainHas` intercepted, using `toBe`/`toEqual` on the exact edge tuple (deterministic, no rng involved in which edge gets cut — BFS order is deterministic under a seeded rng per the engine's existing determinism guarantees, so this should be an exact-equality assertion, not `toBeCloseTo`).
- Regression floor: re-run the full existing `flows.ts`/`index.ts` test suite and confirm no existing `downstream`/`flows` golden assertion changes value — these three fixes are additive (new returned event/finding data), not a change to any existing rps/latency/byte number, so every pre-existing `toBe` assertion in `index.test.ts` must still pass unmodified.
## Wave 5 — Asynchronous Delivery

This wave is the largest single change in the audit because it is the one place the audit's
thesis is not just descriptive but actionable: `connectionClassOf` (`src/lib/connectionModel.ts:66-71`)
collapses `event` to `keep-alive` and `packetResolve.resolveWireSize` turns an `event` packet into
plain request/response bytes — nothing downstream ever asks "is this protocol asynchronous", so an
`event` dependency is simulated as a synchronous RPC wearing a different label. ISSUE-002 is not a
tuning fix; it is the one issue in this audit that adds a genuinely new subsystem (a broker model)
because there is no existing "backlog that decouples caller from callee" concept anywhere in the
engine to extend. It must land after Wave 2 (`totalLatencyMs`) because a decoupled producer no
longer waits on `serviceLatencyMs` the way a synchronous caller does — the producer's own latency
must stop including the consumer's processing time, which only makes sense once composed latency
exists to show what's Now excluded.

### ISSUE-002: Model `event` as an asynchronous queue, not a synchronous RPC

> ⚠️ **Parked in CLAUDE.md** — async `event` delivery semantics are explicitly listed under Known Issues / Roadmap as "authored, sized, and (for `stream`) connection-modelled today, but not yet simulated as asynchronous"; implementing this issue is a deliberate scope decision, and CLAUDE.md's Known Issues / Roadmap section (and the "Packet system" Key Architecture Decision paragraph) must be edited in the same change to remove `event` from the parked list.

- **Category:** Fidelity / Backpressure
- **Severity:** Critical
- **Protocol Affected:** event
- **Depends on:** Wave 2 ISSUE-003 (`totalLatencyMs`) — a decoupled producer's latency must stop including consumer processing time
- **File(s):**
  - `src/lib/connectionModel.ts:66-71` — `connectionClassOf` forces `event` → `keep-alive` (verified: `return 'keep-alive'` is the fallthrough for `db`/`event`, no branch on `event` specifically)
  - `src/lib/worldEngine/flows.ts:545-637` — the dependency fan-out loop (verified at this range): `for (const dep of bp.dependencies)` treats every dependency, `event` included, as a synchronous call whose full `admitted` rps is split across `candidates` in the SAME BFS pass (line 636 pushes the callee onto the same-step `queue`), and a callee's errors roll into the SAME breaker keyed by `pathKey(item.instanceId, dep.id)` (line 547) that gates the producer's own admission next step
  - `src/lib/nodeConfig.ts:64-69` — `EventTemplate`'s `topic`/`eventType`/`deliveryMode` fields, confirmed to have zero engine readers (only `protocol`, `sizeKb`, `responseSizeKb`, `sizeVariance` from `BasePacketTemplate` are read, via `packetResolve.ts`)

**Problem Description**

Trace one `event` dependency today: caller emits at `admitted` rps (say 500 rps), `flows.ts`'s
dependency loop treats it exactly like an `http` or `db` row — `splitDependencyShares` divides it
across the compiled targets, `addDownstream` records the row, and if the target isn't `managed` the
callee instance is pushed onto the SAME breadth-first queue processed in the SAME step (`flows.ts:636`).
The callee's own downstream errors (say the consumer overloads and its own dependency starts
refusing) accumulate into `flow.errorRps` on the callee, and because `breakerOpen(pathKey(caller,
dep.id))` is evaluated from breaker state fed by exactly this error signal, a struggling CONSUMER
opens the PRODUCER's breaker — the producer stops emitting events because the consumer is slow.
That is the literal opposite of what a message broker is for: a broker exists so the producer can
keep publishing at its own rate while the consumer drains at its own, different, rate, with the gap
absorbed by a backlog instead of transmitted upstream as pressure.

Concretely: an `order-events` topic with `deliveryMode: 'exactly-once'` authored in the UI is
simulated with `deliveryMode` never read — a burst of 1,000 events/sec against a consumer capable
of only 200/sec today just overflows `MAX_QUEUE_SEC = 2` of `flows.ts`'s http-style queue path (or,
on the legacy proportional path, sheds 800 rps to `errorRps` in the SAME 100 ms step) instead of
accumulating in a topic and draining over the following several seconds — no ACK, no NACK, no DLQ,
no retention window, no lag metric a user could look at.

**Proposed Real-World Model / Fix**

Real message brokers (Kafka, SQS, RabbitMQ) decouple producer and consumer with a persistent
backlog:

```
backlog[t] = clamp(backlog[t-1] + (arrivalRps - drainRps) * stepSec, 0, retentionCap)
drainRps   = min(consumerServiceRateRps, backlog[t-1]/stepSec + arrivalRps)   // can't drain more than exists
lagSec     = backlog[t] / drainRps                                            // consumer lag, the user-visible number
dropRps    = max(0, arrivalRps - (retentionCap - backlog[t-1])/stepSec)       // retention-cap overflow, at-most-once loses these
redeliverRps = NACKed fraction of drainRps, fed back into next step's arrivalRps  // at-least-once
dlqRps     = redeliverRps that has exceeded maxRedeliveries                    // terminal, does not re-enter backlog
```

Build a new `src/lib/worldEngine/broker.ts` module, modelled directly on
`src/lib/managedDbRuntime.ts`'s shape — pure, no engine imports, one aggregate entry per
topic-carrying dependency computed from the PREVIOUS step's flows (the same one-step lag
`hostScheduler → flows` already uses for `admittedScale`, and that `managedDbRuntime` itself uses
for `refusalFraction`). For the bounded-backlog carry-over math specifically, reuse
`src/lib/worldEngine/networkRuntime.ts:118-128`'s `settleNic` → `deliveredFraction` pattern: it
already computes exactly "how much of what arrived this step got serviced, with the remainder
carried as `state.backlogBytes` into next step, capped at one step's worth" — the same shape as a
bounded topic backlog, just re-parameterized in rps/backlogCount instead of bytes.

`deliveryMode` becomes live:
- `at-most-once` — retention-cap overflow becomes `dropRps` (never redelivered, never errors the producer)
- `at-least-once` — consumer NACKs redeliver via `redeliverRps` feeding back into next step's `arrivalRps`, capped by an authored `maxRedeliveries` before going to `dlqRps`
- `exactly-once` — same backlog math as `at-least-once` but a dedup window suppresses double-delivery of a redelivered event (model as `redeliverRps` not double-counted against consumer capacity, since real brokers achieve this via idempotency keys/transactions, not by resending more copies)

Critically: **the producer's emit is decoupled from the consumer's drain.** `flows.ts`'s dependency
loop must NOT push the event's callee onto the SAME BFS step for an `event`-protocol dependency —
instead, the arrival feeds `broker.ts`'s aggregate topic state, and the callee's consumption is
driven off `drainRps` computed from the PREVIOUS step, exactly mirroring how `managedDbRuntime`
already separates "what was offered this step" (`aggregateManagedDbLoad`) from "what actually
lands" (the lagged `refusalFraction`). The producer's breaker (`pathKey(producer, dep.id)`) must
now trip only on retention-cap drop rate / DLQ rate — never on the consumer's own downstream
errors, since those no longer propagate synchronously.

**Execution Steps**

1. Add `TopicRuntimeEntry { totalArrivalRps, backlogCount, drainRps, lagSec, dropRps, redeliverRps, dlqRps }` and `aggregateTopicLoad(prevFlows, doc, compiled)` + `topicRuntime(prevFlows, doc, compiled)` to a new `src/lib/worldEngine/broker.ts`, mirroring `managedDbRuntime.ts`'s three-function shape (`aggregateManagedDbLoad` → `managedDbRuntimeFor` → `managedDbRuntime`).
2. Add optional `WorldDoc`-level or `BlueprintDependency`-level authored fields for `retentionCapCount` (default derived from a fixed retention window × observed rps, e.g. absent ⇒ effectively unbounded like today) and `maxRedeliveries` (absent ⇒ 1, i.e. at-least-once retries once before DLQ) — additive, so an existing `.scalemap` with `event` packets keeps simulating as a synchronous call until these are authored. Actually: since ISSUE-002 changes DEFAULT behavior for every existing `event` packet (not just newly authored ones), gate the new path behind `protocolOf(tpl) === 'event'` (Wave 6 ISSUE-002's dependency: this issue introduces `protocolOf`, not Wave 6 — correct the note below) and document in the changelog that this is a deliberate, acknowledged behavior change for `event` dependencies, not a byte-identical-by-default change like the other issues in this audit.
3. In `src/lib/worldEngine/index.ts`'s per-step sequencing (near where `managedDbRuntime` is called, `flows.ts` line ~594's `input.managedDbRuntime`), compute `topicRuntime(s.prevFlows, doc, compiled)` from last step's flows and pass it into `solveFlows` as a new `input.topicRuntime` field, symmetric with `input.managedDbRuntime`.
4. In `flows.ts`'s dependency loop (`545-637`), branch on the dependency's resolved protocol (via Wave 6's `protocolOf` helper once it exists, or inline `dep.target`'s bound packet mix in the interim): for `event` dependencies, do NOT push the callee onto `queue` in this step. Instead route the row into `topicRuntime`'s aggregate arrival accumulator (a parallel to `aggregateManagedDbLoad`'s per-service accumulation) and record the downstream row's `rps` as `admitted` (never `refusedRps`) unless `topicRuntime` reports `dropRps`/`dlqRps` for this dependency this step.
5. Add `lagSec` and `backlogCount` to `MetricsBatch` additively (frozen-contract rule: append-only, log the change in `.superpowers/sdd/contract-drift.md`) so the Events/Analysis tabs can surface consumer lag.
6. Add a new analysis rule (`src/lib/analysis/rules/capacity.ts` or a new `async.ts` spread into `ANALYSIS_RULES`) that fires when `lagSec` exceeds an authored/default threshold — "consumer falling behind producer."
7. Author `topic`/`eventType`/`deliveryMode` UI (`PacketModal.tsx`) to also surface `retentionCapCount`/`maxRedeliveries`, wired through `packetDraft.ts`.
8. Edit CLAUDE.md: remove `event` from the "Known Issues / Roadmap" parked list and update the "Packet system" Key Architecture Decision paragraph's final sentence to reflect that `event` delivery is now simulated asynchronously (leave `stream` framing parked unless Wave 6 ISSUE-004 also lands).

**Verification Test**

- **File:** `src/lib/worldEngine/broker.test.ts` (new, mirrors `src/lib/managedDbRuntime.test.ts`'s structure)
- **Before:** a would-be regression-floor test does not exist yet (there is no broker module) — document that the CURRENT behavior (to be preserved as `deliveryMode`-agnostic bypass, NOT as the golden path) is captured by `flows.test.ts`'s existing same-step propagation assertions for a generic dependency.
- **After:** `topicRuntime` returns `backlogCount > 0` and `drainRps < arrivalRps` when consumer capacity is fixed below a burst arrival rate, and `lagSec` grows monotonically while the burst holds, then drains to 0 within `retentionCapCount / consumerCapacityRps` steps of the burst ending. A companion `flows.test.ts` case: a slow/failing consumer downstream of an `event` dependency must NOT open the producer's breaker within one step (assert `getBreaker(pathKey(producerId, depId)).state !== 'open'` immediately after the consumer fails, where it WOULD have opened under the pre-fix same-step propagation).
- Guard: add a test asserting an `event` packet with NO authored `retentionCapCount`/`deliveryMode` override still round-trips through `broker.ts` deterministically for a fixed seed (determinism guard, not a byte-identical-to-pre-fix guard, since this issue is explicitly a behavior change for `event` — call this out in the test file header so a future reader doesn't mistake it for a regression-floor test).

## Wave 6 — Protocol-Specific Semantics

Where Wave 5 gave `event` a delivery mechanism it never had, this wave fixes protocols that already
have SOME modeling but collapse distinct physical quantities into one scalar, or omit a failure mode
so canonical it's the first thing anyone testing a real system reaches for. All three issues need
Wave 2's `totalLatencyMs` (a caller's timeout/backpressure decision has to see the callee's real
latency, not just its own) and this wave's own ISSUE-002 introduces the `protocolOf` resolution
helper that ISSUE-004/005/006 (and Wave 5/7's issues) can share instead of each re-deriving "what
protocol does this dependency actually speak" from a packet mix by hand.

### ISSUE-004: Stop conflating stream connection rate, frame rate, and compute rate

- **Category:** Fidelity
- **Severity:** Major
- **Protocol Affected:** stream
- **Depends on:** Wave 2 ISSUE-003 (`totalLatencyMs`); this issue introduces `protocolOf` (`src/lib/connectionModel.ts`, new export) that Wave 6's other two issues and Wave 5/7 should reuse rather than re-deriving protocol from a mix by hand
- **File(s):**
  - `src/lib/connectionModel.ts:68,83-88` — `connectionClassOf` maps `stream` → `'streaming'` unconditionally (line 68); `profileFor`'s `'streaming'` case (83-88) derives only `fixedHoldSec` from `holdSeconds`, nothing else
  - `src/lib/nodeConfig.ts:71-78` — `StreamTemplate`'s `compressionType` and `streamId` fields, confirmed unread by any engine module (only `BasePacketTemplate`'s `sizeKb`/`sizeVariance` reach `packetResolve.ts`)

**Problem Description**

A `stream` dependency is authored with one `rps` on `BlueprintDependency`/`ClientPopulation` demand
plumbing (the same `rps` every other protocol uses), and that single number is asked to answer three
physically distinct questions at once:
1. How many NEW connections open per second (drives `HANDSHAKE_MS`-style setup cost — except streaming's `profileFor` charges zero handshake CPU, at line 87: `handshakeCpuMs: 0`)
2. How many FRAMES are pushed per second on each open connection (drives NIC bytes and per-frame CPU)
3. How much steady-state compute the stream consumes while held open

Concretely: 100 concurrent video-call clients, each pushing 10 frames/sec, is TODAY authored as
either `rps: 100` (reading as 100 new connections/sec — wrong, connections should be ~100 total,
roughly constant, not opening 100/sec) or `rps: 1000` (reading as 1,000 frames/sec — right for NIC
bytes via `packetResolve`, but `activeConnections(rps, latencyMs, profile)` in
`connectionModel.ts:140-150` would then compute `rps × fixedHoldSec` = 1000 × 30 = 30,000 "active
connections" for what is actually 100 physical sockets, a 300x overcount that blows out
`ramPerConnMb`-driven RAM and can OOM-kill an instance that is nowhere near its real limit). There
is no authoring input in the current model that produces BOTH a correct connection count AND a
correct frame/byte rate simultaneously — one is always wrong by whatever the frames-per-connection
ratio is.

Separately, `compressionType` is authored (`none`/`gzip`/`snappy`) but never adjusts `sizeKb` before
it reaches `packetResolve.resolveWireSize` — a `snappy`-compressed stream and an uncompressed one
book identical NIC bytes and cost. And because `profileFor`'s streaming case has no per-tick baseline
cost, an idle stream (`holdSeconds` elapsed, no frames) costs the connection's RAM but zero CPU/NIC —
there's no heartbeat/keepalive tax, understating cost for connection-heavy but frame-sparse
protocols (e.g. WebSocket presence channels).

**Proposed Real-World Model / Fix**

Separate the three quantities explicitly instead of overloading `rps`:

```
connectionOpenRps   = authored (or derived: totalRps / framesPerConnection, if framesPerConnection authored)
activeConnections   = connectionOpenRps × holdSeconds                    // Little's law, unchanged shape
frameRps            = connectionOpenRps × framesPerSecondPerConnection   // NEW: drives NIC/CPU, decoupled from conn count
compressedSizeKb    = rawSizeKb × compressionRatio(compressionType)      // gzip ~0.3, snappy ~0.5, none 1.0
heartbeatBytesPerSec = idleConnections × heartbeatSizeBytes / heartbeatIntervalSec   // NEW: idle-stream tax
```

Add a `frameMultiplier` field to `ConnectionProfile` (documented in the module header as "closed
under weighted blending" — every field is a plain weighted mean, so a new field slots in the same
way `latencyShare`/`fixedHoldSec`/etc. already do): `frameMultiplier` defaults to `1` for
`keep-alive`/`short-lived` (rps already means "requests", i.e. 1 frame per unit) and is
authored-per-stream-template for `streaming` (defaulting to 1 if unauthored, so an existing
`.scalemap`'s stream dependencies keep today's 1:1 rps:frame reading exactly — this field is
additive and opt-in). `activeConnections()`'s formula stays `rps × (...)` unchanged; the NEW
`frameRps = rps × frameMultiplier` is computed at the SAME call sites and fed to `packetResolve`
(NIC bytes, `cpuMsPerKb`) instead of raw `rps`, while `rps` itself keeps meaning "connection-relevant
rate" for `activeConnections`. This preserves the two-call-site invariant: `activeConnections()`'s
signature and formula are untouched, only its caller's `rps` input for the FRAME side of things is
now `rps × frameMultiplier` at the point bytes/CPU are computed, not at the point connections are
counted.

Put the compression ratio directly in `packetResolve.resolveWireSize`: a small
`COMPRESSION_RATIO: Record<StreamTemplate['compressionType'], number>` constant, applied to a
stream packet's `sizeKb`/`respKb` contribution in the same per-entry loop that already special-cases
`isDb(tpl)` (lines 102-108) — add an `isStream(tpl)` branch there so cost, NIC, and `cpuMsPerKb` all
inherit the compressed size for free, with zero new call sites (this is exactly the "ONE
mix→wire-bytes resolution point" rule from CLAUDE.md).

Blend `frameMultiplier` through the EXISTING `addProfile`/`meanProfile` helpers
(`src/lib/worldEngine/index.ts:222-233`, confirmed present) — one weighted-mean helper serving both
the entry tier and internal-hop tier, never special-cased per protocol, matching how every other
`ConnectionProfile` field already blends.

**Execution Steps**

1. Add `frameMultiplier: number` to `ConnectionProfile` (`connectionModel.ts:37-42`); set it to `1` in `KEEP_ALIVE_PROFILE` and in `profileFor`'s `'short-lived'` case; add an optional `frameMultiplier` parameter to `profileFor`'s `'streaming'` case sourced from a new `StreamTemplate.framesPerSecond` field (absent ⇒ 1).
2. Add `framesPerSecond?: number` to `StreamTemplate` (`src/lib/nodeConfig.ts:71-78`), additive/optional.
3. Add `COMPRESSION_RATIO` constant and an `isStream` branch to `resolveWireSize`'s per-entry loop (`packetResolve.ts:96-109`), mirroring the existing `isDb` branch's shape exactly.
4. At every call site that currently feeds raw `rps` into NIC/CPU-per-KB computation for a stream-protocol hop (`worldEngine/index.ts`'s flow-to-metrics wiring, wherever `depBytesById`/`routeBytesById` combine with per-hop `rps`), multiply by the resolved `frameMultiplier` before the bytes calculation — leave the `activeConnections()` call sites (host scheduler, `metrics.ts`) untouched, passing raw `rps` as today.
5. Add a heartbeat cost: idle-connection RAM already exists via `ramPerConnMb`; add heartbeat NIC bytes as `activeConnections × heartbeatBytesPerSec` folded into the same per-instance NIC booking pass in `networkRuntime.ts`, gated on an optional authored `heartbeatIntervalSec` (absent ⇒ 0, no new bytes — byte-identical default).
6. Update `docs/module-boundaries.md`'s packet-system section to note `frameMultiplier`'s existence and that it is blended via the same `addProfile`/`meanProfile` helpers as every other `ConnectionProfile` field.

**Verification Test**

- **File:** `src/lib/connectionModel.test.ts`
- **Before:** `activeConnections(1000, 0, profileFor('streaming', 30))` with no `frameMultiplier` concept today conflates 1000 "streams" into `fixedHoldSec`-driven connection count with no way to separately assert a frame rate.
- **After:** with `frameMultiplier` authored via `profileFor('streaming', 30, /* framesPerSecond */ 10)`, assert `activeConnections(connectionOpenRps, ...) === connectionOpenRps × 30` (unchanged formula, `toBe` exact) while a new `resolvedFrameRps(connectionOpenRps, profile) === connectionOpenRps × 10` is asserted separately — the two numbers must diverge by exactly the authored `framesPerSecond` factor, proving they're no longer the same scalar.
- Guard: assert `frameMultiplier` defaults to `1` for an unauthored `StreamTemplate` (`toBe(1)`, not `toBeCloseTo`) so every pre-existing `.scalemap` with `stream` packets keeps today's byte totals exactly.

### ISSUE-005: Give self-hosted DB blueprints a connection ceiling and checkout wait

> ⚠️ **Parked in CLAUDE.md** — connection pool modeling (checkout wait, pool exhaustion queueing) and a connection ceiling/refusal path for self-hosted services are explicitly parked under Known Issues / Roadmap, which even names this issue's natural shape ("a `WorkloadProfile.maxConnections` mirroring `managedDbRuntimeFor`'s `connectionRefusedRps`"); implementing it is a deliberate scope decision and the Known Issues / Roadmap section must be edited in the same change to remove this bullet.

- **Category:** Backpressure
- **Severity:** Major
- **Protocol Affected:** db (pool)
- **Depends on:** Wave 2 ISSUE-003 (`totalLatencyMs`) — checkout wait must feed the CALLER's composed latency, not just the DB instance's own `serviceLatencyMs`; Wave 6 ISSUE-002's `protocolOf` helper for identifying db-protocol dependencies cleanly
- **File(s):**
  - `src/lib/world/types.ts:149-162` — `WorkloadProfile` (verified: `cpuMsPerRequest`, `ramBaseMb`, `ramPerConnMb`, `diskIoPerRequest`, optional `cpuShares`/`cpuMsPerKb`) has NO `maxConnections` field
  - `src/lib/managedDbRuntime.ts:123-129` — `managedDbRuntimeFor`'s connection-ceiling math for MANAGED DBs only (verified at this range: `connections = admittedRps * (p50Ms/1000)`, `maxConnections = ms.maxConnections ?? cls.maxConnections`, `connectionRefusedRps` when `connections > maxConnections`) — this logic exists ONLY for `ManagedService`, never for a self-hosted `ServiceBlueprint` instance running a db-protocol workload

**Problem Description**

`ManagedService` (a managed/cloud DB) gets the full three-axis failure model in
`managedDbRuntime.ts` — rps ceiling, queueing latency, AND a connection ceiling with
`connectionRefusedRps`. A self-hosted Postgres/MySQL blueprint placed on a VPS gets none of that:
its `WorkloadProfile` carries `ramPerConnMb` (so `activeConnections()`'s output does at least drive
RAM growth via the host scheduler) but has no `maxConnections` field at all, so the ONLY way a
self-hosted DB can ever fail under connection pressure is by exhausting host RAM and getting
OOM-killed. Real connection pools (PgBouncer, HikariCP, a database's own `max_connections`) refuse
or QUEUE new checkouts well before the underlying process runs out of memory — pool exhaustion is a
distinctly earlier, and far more common, failure than OOM, and it presents as REQUEST LATENCY
(callers blocked waiting for a free connection) rather than as an instance restart.

Concretely: a self-hosted Postgres blueprint with `ramPerConnMb: 10` on a server with 8 GB free
would need roughly 800 concurrent connections before OOM becomes a factor — but a real Postgres
installation with `max_connections: 100` (the common default) would already be queueing or refusing
checkouts at 1/8th that load, and every one of those blocked callers would see elevated latency
building up in the connection-acquisition step, a step this simulator does not model at all.

**Proposed Real-World Model / Fix**

Model this as a bounded queue at the connection layer, ahead of compute — an M/M/c/K queue
(`c` = pool size, `K` = queue capacity):

```
utilization ρ = activeConnections / maxConnections
```
When `ρ < 1`: no wait, connections check out immediately (today's behavior, unchanged — this is the
regression floor for an authored-but-unsaturated pool).

When `ρ >= 1` (pool saturated), each new request queues for a free connection. Approximate mean
checkout wait with the same queueing-latency shape `managedDbRuntimeFor` already uses for DB service
latency (`p50Ms / (1 - saturation)`, clamped), reused here for the CHECKOUT step specifically:

```
checkoutWaitMs = baseCheckoutMs / (1 - min(ρ - 1, MAX_SATURATION_FOR_LATENCY))   // when ρ > 1
checkoutWaitMs = 0                                                                // when ρ <= 1
```

Past a `checkoutTimeoutMs` (mirrors `queryTimeoutMs`'s shape), a growing fraction of waiters give up
and error instead of eventually connecting — same linear-overshoot shape as
`managedDbRuntimeFor`'s `timeoutErrorFraction` (lines 133-136):

```
checkoutTimeoutErrorFraction = min(1, (checkoutWaitMs - checkoutTimeoutMs) / checkoutTimeoutMs)   // when checkoutWaitMs > checkoutTimeoutMs
```

`checkoutWaitMs` feeds INTO the caller's composed latency (Wave 2's `totalLatencyMs`) as an
additional term on the hop to this instance — a caller blocked on pool checkout sees its own
end-to-end latency grow, which is the entire point: the failure is visible upstream, not just as an
OOM event on the DB's own host.

**Execution Steps**

1. Add `maxConnections?: number` to `WorkloadProfile` (`src/lib/world/types.ts:149-162`), additive/optional — absent ⇒ unbounded (today's exact behavior, the regression floor).
2. Add `checkoutTimeoutMs?: number`, absent ⇒ no timeout (mirrors `ManagedService.queryTimeoutMs`'s own "absent ⇒ no timeout" convention at `world/types.ts:286`).
3. Create `poolCheckoutFor(profile: WorkloadProfile, activeConnections: number): { checkoutWaitMs: number; checkoutTimeoutErrorFraction: number } | null` in a NEW small module or alongside `hostScheduler.ts` (not inside `connectionModel.ts` itself — this is host/instance capacity math, not connection-CLASS math; keep the "ONE connection-semantics point" rule intact by having this function call `connectionModel`'s `activeConnections()` for its input rather than recomputing Little's law itself). Return `null` when `maxConnections` is absent (fast-path skip, matches `managedDbRuntimeFor`'s null-return convention for "not capacity-modelled").
4. Wire `poolCheckoutFor`'s output into BOTH of the two-call-site invariant's sites: `hostScheduler.ts`'s `InstanceLoad.activeConnections` computation must consult `checkoutTimeoutErrorFraction` to shed the timed-out slice of connections/rps from what actually lands on the instance, and `metrics.ts`'s published `InstanceMetrics` must surface the SAME `checkoutWaitMs` figure (as e.g. a new additive `InstanceMetrics.checkoutWaitMs` field) so the UI and the enforced RAM math never diverge — this is exactly the class of bug `index.test.ts`'s `DIVERGENCE GUARD` test exists to catch, so add a parallel guard for this new field.
5. Feed `checkoutWaitMs` into the caller's hop latency in `flows.ts`'s dependency loop, additively, ahead of Wave 2's `totalLatencyMs` composition.
6. Author `maxConnections`/`checkoutTimeoutMs` UI in the relevant service-config drawer (`src/app/world/server/drawers/`), defaulting both to absent/unbounded so no existing blueprint changes behavior until explicitly authored.
7. Edit CLAUDE.md: remove the "Connection POOL modeling... connection CEILING / refusal path" bullet from Known Issues / Roadmap; update the two-call-site invariant paragraph to note the new `checkoutWaitMs` field traveling through both sites.

**Verification Test**

- **File:** `src/lib/worldEngine/hostScheduler.test.ts` (or a new `poolCheckout.test.ts` alongside it)
- **Before:** an instance with `WorkloadProfile.ramPerConnMb` set and no `maxConnections` never sheds connections until host RAM is exhausted — assert today's `stepHost` output shows `activeConnections` growing unbounded (up to the RAM ceiling) with zero latency penalty as offered rps increases, documenting the gap.
- **After:** with `maxConnections` authored below the RAM-implied ceiling, assert `checkoutWaitMs > 0` once `activeConnections` crosses `maxConnections`, and `checkoutTimeoutErrorFraction` rises past `checkoutTimeoutMs`, `toBe` exact against the same overshoot formula `managedDbRuntimeFor` uses (same shape, different constants).
- Guard: a `DIVERGENCE GUARD`-style test asserting `hostScheduler`'s enforced `activeConnections` and `metrics.ts`'s published `InstanceMetrics.activeConnections`/`checkoutWaitMs` never diverge for the same instance/step, mirroring `index.test.ts`'s existing guard.
- Guard: assert an instance with `maxConnections` absent produces bit-identical `stepHost` output to today (`toBe`, not `toBeCloseTo`) — the regression floor.

### ISSUE-006: Add client-side timeouts so breakers can trip on latency, not just capacity

- **Category:** Fidelity
- **Severity:** Major
- **Protocol Affected:** http
- **Depends on:** Wave 2 ISSUE-003 (`totalLatencyMs`) — a timeout has to compare against the FULL composed hop latency, not just the callee's own `serviceLatencyMs`, or a fast-but-deep call chain would never trip; Wave 6 ISSUE-002's `protocolOf` helper
- **File(s):**
  - `src/lib/nodeConfig.ts:53` — `HttpTemplate.statusCode: number` (verified), documented "2xx/3xx ok · 4xx error-but-completes · 5xx drop" but hardcoded to `200` at every construction site (`addRoute`, line 160: `statusCode: 200`) with zero engine readers — grep confirms no engine module branches on `statusCode`
  - `src/lib/worldEngine/flows.ts:488-536` — the admission/queueing block (verified at this range): the ONLY ways `flow.errorRps` grows are capacity overflow (`excess` past `maxQueue`, line 527) or the legacy proportional shed (line 535); there is no latency-driven error path anywhere in this function
  - `src/lib/worldEngine/breakers.ts:33` — `errorThreshold: 0.5` confirmed; the breaker only ever sees the capacity-driven `errorRps`/`refusedRps` signal fed into `recordWeighted`, never a latency signal

**Problem Description**

Today the ONLY authored timeout in the whole engine is `ManagedService.queryTimeoutMs`
(`world/types.ts:286`), and it only fires inside `managedDbRuntimeFor`'s DB-specific model. A
regular service-to-service `http` dependency has no client-side timeout concept at all: no matter
how slow a downstream instance's `serviceLatencyMs` gets, the caller in `flows.ts`'s dependency loop
(`545-637`) keeps counting the call as `admitted` unless it hits an unrelated capacity wall
(`488-536`). This means the single most canonical distributed-systems failure — "dependency got
slow, caller's requests started timing out, breaker tripped from timeouts, not from 5xx or capacity
refusal" — is structurally unreachable in this simulator. A dependency that degrades to 5-second
response times but never actually errors or overflows its queue will show as perfectly healthy
downstream, forever, which is not how any real HTTP client behaves (every serious HTTP client
library defaults to SOME timeout, typically single-digit seconds).

Separately, `statusCode`'s documented three-way semantics (2xx ok / 4xx error-but-completes / 5xx
drop) is entirely decorative — it's hardcoded to `200` and never read, so authoring an `httpTemplate`
with a different intended status has zero simulated effect. This is a smaller defect than the
missing timeout but belongs in the same issue because both are "the http protocol's documented
semantics don't reach the engine."

**Proposed Real-World Model / Fix**

Reuse `src/lib/worldEngine/latency.ts`'s `sampleLatencyMs`'s mu/sigma derivation (`13-16`,
confirmed: `mu = ln(max(p50, 0.001))`, `sigma = (ln(max(p99, p50+0.001)) - mu) / 2.326`) rather than
re-deriving a latency distribution for the timeout calculation — the log-normal CDF gives an
ANALYTIC `P(latency > timeout)` instead of a Monte-Carlo estimate, which is both cheaper (no extra
rng draws — the audit's own perf gate is 4 ms/step) and deterministic given the SAME p50/p99 already
computed for a hop:

```
P(latency > timeoutMs) = 1 - Φ((ln(timeoutMs) - mu) / sigma)     // Φ = standard normal CDF
```

Use a standard rational/erf approximation for Φ (no existing helper in the repo — add one small,
pure function alongside `sampleLatencyMs`, NOT a new distribution module, since it shares the exact
mu/sigma derivation).

This `P(latency > timeout)` becomes the error fraction fed into `flow.errorRps` for a timed-out hop
— feed it through the SAME accumulation `flows.ts` already uses for capacity errors (line 527's
`flow.errorRps += ...`), so the breaker's existing `errorThreshold: 0.5` machinery (`breakers.ts:33`)
sees a latency-caused error exactly like a capacity-caused one, without any breaker-side code
change. This is what finally makes the breaker latency-sensitive: today it can only open from
`refusedRps`/`errorRps` sourced from capacity overflow; after this fix, a slow-but-not-overloaded
dependency can ALSO trip it, because its timeout-derived error fraction feeds the identical counter.

Add `clientTimeoutMs?: number` to `HttpTemplate` (mirrors `ManagedService.queryTimeoutMs`'s "absent
⇒ no timeout" convention). Wire `statusCode`: when authored non-2xx, treat 4xx as "completes but
counts as an error" (adds to `errorRps` without consuming capacity/refusing) and 5xx as "drop" (adds
to `errorRps` AND never reaches the downstream — same accounting shape as a blocked path,
`refusedRps`).

**Execution Steps**

1. Add a small `normalCdf(z: number): number` helper next to `sampleLatencyMs` in `latency.ts`, using a standard Abramowitz-Stegun or erf rational approximation (accurate to ~1e-7, sufficient for a simulator).
2. Add `timeoutErrorFraction(p50: number, p99: number, timeoutMs: number): number` to `latency.ts`, using the SAME `mu`/`sigma` derivation as `sampleLatencyMs` (extract the mu/sigma computation into a shared internal helper so the two functions cannot drift).
3. Add `clientTimeoutMs?: number` to `HttpTemplate` (`nodeConfig.ts`, near `statusCode` at line 53), additive/optional.
4. In `flows.ts`'s dependency loop, for each http-protocol hop with a resolved `clientTimeoutMs` (via Wave 6 ISSUE-002's `protocolOf` + the bound route/packet's fields), compute `timeoutErrorFraction` from the hop's OWN p50/p99 (already computed for latency sampling) and add `share * timeoutErrorFraction` to `flow.errorRps`, symmetric with the existing capacity-overflow accumulation at line 527 — reduce the admitted share reaching the downstream by the same fraction so bytes/CPU aren't double-booked for calls that never completed.
5. Wire `statusCode`: read the resolved route/packet's `statusCode` at the SAME hop-processing point; a 4xx value adds to `errorRps` without touching `refusedRps`/downstream propagation; a 5xx value adds to BOTH `errorRps` and short-circuits downstream propagation for that share (reuse the existing `path.verdict === 'blocked'` branch's accounting shape at lines 568-572 as the template).
6. Confirm the breaker requires zero code changes — `recordWeighted`'s existing `errorThreshold: 0.5` reads whatever `errorRps`/`total` ratio it's given, so a latency-timeout-sourced error and a capacity-sourced error are indistinguishable to it by design; add a comment in `breakers.ts` noting this is now intentional (breaker is latency-AND-capacity sensitive).
7. Author `clientTimeoutMs` in the route/packet UI (`RoutesPanel.tsx`/`PacketModal.tsx`), and make `statusCode` actually editable (currently hardcoded at creation) with the three-band semantics visible in the form.

**Verification Test**

- **File:** `src/lib/worldEngine/latency.test.ts`
- **Before:** no test exists asserting a breaker opens purely from elevated latency with zero capacity overflow — document this gap by asserting today's `flows.ts` output shows `errorRps === 0` for a hop whose `serviceLatencyMs` is artificially set far above any reasonable timeout but whose capacity is never exceeded.
- **After:** `timeoutErrorFraction(50, 150, 500)` (p50=50ms, p99=150ms, timeout=500ms — timeout well above p99) is `toBeCloseTo(0, 3)` (negligible), while `timeoutErrorFraction(50, 150, 60)` (timeout BELOW p50) is `toBeGreaterThan(0.5)`. A `flows.test.ts` case: a dependency with `clientTimeoutMs` set below its callee's simulated p50 latency must, over enough steps, open the caller's breaker (`getBreaker(pathKey(...)).state === 'open'`) with ZERO capacity overflow anywhere in the chain — the test that was structurally impossible to write before this fix.
- Guard: assert a hop with `clientTimeoutMs` absent produces bit-identical `flow.errorRps`/`admittedRps` to today (`toBe`), and a route with default `statusCode: 200` also produces bit-identical output — both regression floors.

## Wave 7 — Closing the Loop

This wave asks the demand-generation question the rest of the audit assumes an answer to: when a
callee saturates, does load upstream drop, queue, or propagate as backpressure? Today it's none of
the three in any principled sense — it's deleted at a fixed 2-second horizon
(`MAX_QUEUE_SEC`). ISSUE-008 is deliberately staged as two mechanisms so the team doesn't
over-build: Mechanism A is "make the signals that already exist (Wave 2's composed latency) actually
close the loop", which may turn out to be sufficient on its own once measured, and only if it isn't
should Mechanism B's explicit admission control be attempted. ISSUE-019 is the wave's minor
companion — not an engine defect but a UI-truthfulness gap in how the SAME kind of state (slow-
converging, correctly wiped on edit) is currently presented as if a fresh run were comparable to a
settled one.

### ISSUE-008: Close the open loop between callee saturation and caller demand

- **Category:** Backpressure
- **Severity:** Critical
- **Protocol Affected:** all protocols
- **Depends on:** Wave 2 ISSUE-003 (`totalLatencyMs`) — Mechanism A specifically requires composed latency to exist before a caller's connection-hold time can reflect a slow callee; Wave 6 ISSUE-005's pool checkout wait is a second, related latency-holds-connections-longer contributor worth measuring alongside Mechanism A
- **File(s):**
  - `src/lib/worldEngine/demand.ts` — `populationDemandRps` (verified, full file read): takes `pop`, `simMs`, `rng`, `stepMs`, `burst` — no system-state input of any kind; demand is a pure function of the diurnal curve + Poisson/burst randomness, structurally incapable of reacting to downstream saturation
  - `src/lib/worldEngine/index.ts:500-509` — the demand step (verified: `// ── 1. demand ──`, loops populations calling `populationDemandRps` with no metrics/health/queue-depth input) runs FIRST in the step sequence, before routing/health/flows — architecturally it cannot see this step's own downstream state, only what's baked into per-population authoring
  - `src/lib/worldEngine/flows.ts:488-536` — `MAX_QUEUE_SEC` bounded queue (confirmed: `queueDepth`/`maxQueue = capacity * MAX_QUEUE_SEC`, overflow becomes `flow.errorRps` at line 527) — this IS a real bounded-backlog mechanism already, but it only exists downstream of demand, never informs demand generation upstream

**Problem Description**

Demand generation is fully open-loop: `populationDemandRps` computes a diurnal-curve mean, applies
Poisson variance and occasional burst multipliers, and returns an rps figure with zero knowledge of
whether last step's traffic was served, queued, or dropped. The ONLY channel by which downstream
saturation can ever influence a caller's behavior is the circuit breaker — a binary, coarse-grained
signal that requires ≥50% errors over a 10-second window (`breakers.ts:33`'s `errorThreshold: 0.5`)
before it does anything, and even then it just stops sending entirely rather than slowing down
proportionally.

So: does load drop or grow unbounded when a callee saturates? Neither, precisely — it grows exactly
as fast as the population's diurnal/burst authoring says it should, completely indifferent to
whether the system underneath can absorb it, until `flows.ts`'s `MAX_QUEUE_SEC = 2` bounded queue
fills (2 seconds of capacity at the callee's current admit rate) and the excess is DELETED as
`errorRps` — not queued longer, not fed back to slow the caller, just gone. A population authored at
a flat 10,000 rps against a callee capable of 100 rps will, forever, offer 10,000 rps and have 9,900
of it vanish into `errorRps` every single step, with no mechanism by which the caller ever "learns"
to back off — because there is no caller in the demand-generation sense, only an authored curve.

**Proposed Real-World Model / Fix**

Structure the fix in two mechanisms, staged strictly in order — A must be implemented and its effect
MEASURED (via `bench/enginePerf.bench.test.ts`-adjacent scenario runs, or ad hoc golden-world
comparisons) before B is attempted, because A may already produce enough of a closed loop that B's
added complexity (and its own new failure modes — an admission controller is itself state that has
to be gotten right) proves unnecessary.

**Mechanism A — natural propagation via existing signals (build first).** Once Wave 2's
`totalLatencyMs` exists, a caller's `activeConnections()` (`connectionModel.ts:140-150`) already
holds connections proportional to `latencyMs` for `keep-alive`/`short-lived` classes
(`latencyShare × latencyMs/1000`). If a callee's composed latency correctly reflects downstream
slowness (Wave 2's whole point), then a caller sending traffic to a slow callee holds MORE
connections for longer — which grows `ramPerConnMb`-driven RAM pressure on the CALLER's own host,
which can trip the caller's OWN capacity limits, which throttles the caller's OWN admitted rps via
the EXISTING `admittedScale` fair-share mechanism (`flows.ts:486`, `499`) — a natural closed loop
requiring ZERO new demand-generation code, just correct latency composition. This is "backpressure
via RAM," the same mechanism that already exists for OOM, now correctly fed by realistic latency
instead of only by payload/CPU. Measure whether this alone bounds runaway demand in a saturated
scenario before building anything else.

**Mechanism B — explicit admission control (build only if A proves insufficient).** If measurement
shows Mechanism A's RAM-pressure feedback is too slow, too indirect, or fires at the wrong layer
(e.g. it OOMs the caller rather than gracefully shedding), add explicit admission control: bound the
`MAX_QUEUE_SEC` deletion with a carry-over instead of a delete, reusing
`networkRuntime.ts:118-128`'s `settleNic` → `deliveredFraction` pattern — the CORRECT existing
template for "excess this step becomes backlog next step, capped, with the truly-excess remainder
shed" — as opposed to `flows.ts`'s current queue, which DOES cap and carry (`queueDepth`) but only
ever times out the overflow, never signals the population layer to reduce its OWN offered rate. The
new piece Mechanism B would add is a feedback scalar computed from sustained queue depth /
saturation, fed back into `populationDemandRps` as a demand-shed multiplier — explicit admission
control at the EDGE rather than only at internal hops.

```
// Mechanism B sketch, only if needed:
demandSharedFraction[pop] = f(sustainedQueueDepthRatio)   // e.g. sigmoid past some backlog threshold
effectiveDemandRps = rawDemandRps × (1 - demandSharedFraction[pop])
```

**Execution Steps (Mechanism A only — B is explicitly NOT scoped here pending measurement)**

1. Confirm Wave 2's `totalLatencyMs` is composed correctly end-to-end before starting this issue — Mechanism A has nothing to measure otherwise.
2. Instrument a scenario test: one population, one saturated multi-hop chain, run for enough simulated seconds to reach steady state; record caller-instance RAM/`activeConnections`/`admittedScale` over time with Wave 2 landed but Mechanism A otherwise unmodified (it requires no NEW code — just measure whether the EXISTING `admittedScale`/OOM machinery, now correctly fed by composed latency, already bounds the caller's effective throughput).
3. Compare against the SAME scenario today (pre-Wave-2): document whether offered rps at the population layer stays constant (today, provably yes — `populationDemandRps` cannot see any of this) while admitted/served rps differs.
4. Write up the measurement (a scenario doc or test-suite comment, not necessarily new production code) with a clear go/no-go recommendation on Mechanism B.
5. Only if Mechanism A is measured insufficient: implement Mechanism B per the sketch above, adding an optional per-population `demandSharedFraction` computed from queue-depth state already tracked in `flows.ts`'s `queueDepth` map, fed back into `index.ts`'s step-1 demand computation (`500-509`) as a new input to `populationDemandRps` — additive parameter, defaulting to 0 (no shed) so existing worlds without sustained saturation see no behavior change.

**Verification Test**

- **File:** `src/lib/worldEngine/index.test.ts` (scenario-level, alongside existing engine integration tests)
- **Before:** a saturated multi-hop scenario shows `errorRps` at the bottleneck instance staying constant step-over-step (proportional to the fixed gap between offered and `MAX_QUEUE_SEC`-bounded capacity) with the POPULATION's offered rps never changing — assert this today via a fixed-seed scenario asserting `demandByPop[popId]` is identical across steps regardless of downstream state (`toBe`, since `populationDemandRps` is provably state-blind).
- **After (Mechanism A):** the SAME scenario, with Wave 2 landed, shows the CALLER instance's `admittedScale` (its own fair-share admission, driven by its own RAM pressure from held connections) dropping below 1 as the callee's latency grows — assert `admittedScale < 1` at the caller once the callee's composed latency crosses a threshold that pushes the caller's RAM over its host's ceiling. This does NOT require `populationDemandRps` itself to change (Mechanism A is deliberately caller-side, not demand-side).
- **After (Mechanism B, only if built):** assert `demandSharedFraction > 0` once `queueDepth` at the bottleneck sustains above a threshold for N consecutive steps, and that shed demand recovers to `0` within a bounded number of steps after the bottleneck clears (no permanent shed / no oscillating on-off — a hysteresis band test, mirroring `breakers.ts`'s existing hysteresis-band test idiom).
- Guard: assert a NON-saturated scenario (offered rps always well under capacity) produces bit-identical `demandByPop` output before and after Mechanism A/B land (`toBe`) — both mechanisms must be true no-ops when nothing is actually saturated.

### ISSUE-019: Surface engine warm-up state after a stop→edit→start cycle

- **Category:** State lifecycle
- **Severity:** Minor
- **Protocol Affected:** all protocols
- **Depends on:** none
- **File(s):**
  - `src/lib/worldEngine/index.ts:1334-1370` — `start()` (verified at this range): every slow-converging piece of state — `vpsStates` (burst credits), `demandStates` (burst on/off), `breakers`, `queueDepth`, `nics`, `failover` (health-check hysteresis), `metrics` (EMAs/latency reservoir) — is freshly constructed here (`new Map(...)`, `createVpsState`, `createFailoverState`, `createMetricsState`, etc.), unconditionally, on every `start()` call
  - `src/app/store/simulation.store.ts:170-224` — `start()`/`stop()` (verified at this range): `stop()` (209-224) clears `latestBatch`/`events`/`scrubIndex`/`scrubBatch`/`healthOverrides` and the comment at 214-219 explicitly documents the intended behavior ("End ERASES the finished run's visuals... persist on pause, erase on end") — confirming this is a DELIBERATE design decision, not an oversight

**Problem Description**

This is not an engine bug — the CLAUDE.md-documented "topology mutability" model (edit-locked while
running, `doc`/`compiled` frozen at `start()`) means a stop→edit→start cycle genuinely SHOULD reset
simulation state, because the topology the state was computed against no longer exists. VPS burst
credits, health-check hysteresis counters, metric EMAs, and the latency reservoir are all
correct-to-reset when the topology changes underneath them.

The gap is entirely in the UI: nothing distinguishes a freshly-started run (all counters at their
cold-start defaults) from a run that has been going for minutes and has settled into steady state.
A user who stops, tweaks one server's spec, and restarts sees metrics that look meaningfully
different from the pre-edit run — not because the edit mattered, but because burst credits
haven't refilled, the health-check hysteresis band hasn't accumulated enough samples to reflect
true state, and EMA-smoothed metrics are still converging from their initial seed. A user with no
reason to know any of this reads the difference as caused by their edit, when it's an artifact of
the engine being cold.

**Proposed Real-World Model / Fix**

No engine change — this is a UI affordance. Real APM/observability tools (Datadog, Grafana) commonly
show a "collecting data..." or reduced-confidence state for the first N seconds after a
process/deploy restart; the same idea applies here. Add a warm-up indicator to the sim UI (likely
`SimControls.tsx` or a small badge near the metrics display) that is active for a fixed window after
`start()` (e.g. proportional to the slowest-converging piece of state — VPS burst-credit refill and
the health-check hysteresis window are the natural anchors) and clears automatically once elapsed,
using `var(--color-*)` tokens per the theme rules and respecting `prefers-reduced-motion` for any
transition.

**Execution Steps**

1. Determine the warm-up window: inspect `vpsModel.ts`'s burst-credit refill time constant and `failover.ts`'s `DEFAULT_HYSTERESIS` window (both already confirmed to exist in `index.ts`'s imports) and take the max as the default warm-up duration, exposed as a named constant (e.g. `WARMUP_MS`) rather than hardcoded inline.
2. Add a `warmupUntilMs` (or equivalent elapsed-since-start) field to `simulation.store.ts`'s state, set on `start()` (`170-208`) to `Date.now() + WARMUP_MS` (or the sim-time equivalent, consistent with how the store already tracks `scrubIndex`/`latestBatch` timing) and cleared/ignored once elapsed — additive to the store, no engine contract change needed since `worldEngine/types.ts` isn't touched.
3. Render a small, dismissible-or-auto-clearing badge/indicator in `SimControls.tsx` (or wherever the run status already renders) while `warmupUntilMs` is in the future — text along the lines of "warming up" — styled with `var(--color-*)` tokens, correct in both themes, with any animation gated on `useReducedMotion()`.
4. Do NOT gate any metrics/analysis rule behind this flag — it's purely advisory UI, not a data-quality filter (a metrics-hiding approach would just move the confusion elsewhere).
5. Update `docs/module-boundaries.md`'s `simulation.store.ts`/`SimControls.tsx` entries to note the new warm-up field.

**Verification Test**

- **File:** `src/app/store/simulation.store.test.ts`
- **Before:** `start()` sets no warm-up-related field — assert `useSimulationStore.getState().warmupUntilMs` is `undefined` today (documenting the gap; this line will need updating once the field is added, so phrase it as "field does not exist yet" in the PR description rather than a literal pre-fix assertion).
- **After:** immediately following `start()`, `warmupUntilMs` is set to a value `WARMUP_MS` ahead of the start time (`toBe` exact against the named constant, not a range); after advancing time past `WARMUP_MS` (via the store's existing test-clock/step helpers), a `isWarmingUp()`-style selector (or direct field comparison) returns `false`.
- Guard: assert `stop()` clears `warmupUntilMs` alongside the other session fields it already clears (`209-224`), and that a `pause()`/`resume()` cycle (which explicitly PRESERVES state per the existing `pause()` comment) does NOT reset or extend the warm-up window — pausing mid-warm-up should not restart the clock.
