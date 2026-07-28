# Infrastructure Simulator System Audit & Refactoring Spec

> **Framing note (read first).** This audit targets scalemap's **current** shipping engine, not
> the deleted first-architecture React-Flow canvas. The engine is a **fixed-step discrete
> simulation** — 100 ms steps (10 Hz), rAF-driven through an accumulator clock
> (`engineClock.ts`), with a **1 Hz metrics pyramid** (instance→server→AZ→region→world) and a
> degraded 200 ms fallback. There is no 60 FPS particle physics loop; the only 60 FPS surfaces
> are the r3f globe `useFrame` (arcs) and the DOM/SVG server/AZ render paths. Where this spec
> says "per tick" it means one 100 ms sim step; "per frame" means one rAF (~60 Hz) render.
> All proposed fidelity fixes are pitched at **pragmatic realism**: add real backpressure /
> hysteresis / egress cost while staying deterministic (all randomness through the seeded
> `rng`) and within the ~4 ms/step and 60 FPS render budgets.

## Summary of Findings

- **Total Issues Identified:** 79
- **Critical (all categories):** 12
- **Critical Fidelity Faults:** 6 (ISSUE-001, -002, -003, -006, -007, -009)
- **Performance Bottlenecks:** 18 (ISSUE-027 through -032 plus the localized engine/render perf items in Tier 3)
- **Severity split:** Critical 12 · Major 20 · Minor 47
- **Category split:** Real-World Fidelity 31 · Architecture/State 14 · Bug/Type-safety 16 · Performance 18

Issues are ordered by severity then blast radius. An execution agent should work top-down;
several Tier-1/2 items are noted as **compounding** (e.g. ISSUE-001 + ISSUE-006, and the
ISSUE-013 queue model that subsumes ISSUE-014/-016).

---

## Issue List

### [ISSUE-001]: Circuit breakers never trip on a down / erroring / CPU-shedding downstream
- **Category:** Real-World Fidelity
- **Severity:** Critical
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (391–401), `src/lib/worldEngine/flows.ts` (315–321, 405–423), `src/lib/worldEngine/breakers.ts` (56–80)
- **Problem Description:** Step 8 of the tick records breaker outcome as `recordResult(b, row.blocked, simMs)`. `row.blocked` is `true` only for hard cases — firewall/misconfig `verdict==='blocked'`, an already-open breaker, managed-service down, or managed throttle. When a downstream **instance** is `down` or CPU-shedding, `flows.ts` emits a **non-blocked** caller row and zeroes the target's subtree via `healthFactor`. The caller's breaker therefore records a **success** even though 100% of its calls to that dependency are failing, so it never opens. This defeats the entire purpose of a circuit breaker and compounds ISSUE-006 (fan-out still routes into the dead node).
- **Proposed Real-World Model / Fix:** Feed the breaker an **error fraction** derived from the target's health, not a boolean. For each downstream row, compute `targetErrorFraction = errorRps / max(offeredRps, ε)` for the target instance (or `1` for the existing `blocked` cases). Record `errored = round(row.rps * targetErrorFraction)` failures and the remainder as successes over the tick. This makes an open decision reflect the real observed failure rate (Hystrix/resilience4j semantics).
- **Execution Steps for Developer Agent:**
  1. In `solveFlows` expose per-instance `{ offeredRps, admittedRps, errorRps }` (it already tracks these internally) on the returned flow record or a sibling map.
  2. In `index.ts` step 8, for each `row` look up the target instance's error fraction; keep `row.blocked` ⇒ fraction `1`.
  3. Change `recordResult(b, errored: boolean, …)` to `recordResult(b, failures: number, samples: number, …)` (weighted), or add a `recordWeighted(b, errored, total)` overload; update the window math (see ISSUE-015).
  4. Preserve the `row.rps <= 0` skip.
- **Verification Test:** Force one replica of a single-replica DB `down` under steady load; assert the caller breaker transitions `closed→open` within `windowSize` ticks, emits `breaker_open`, and admitted traffic to the dead dependency drops to ~0.

---

### [ISSUE-002]: NIC bandwidth cap is computed then discarded — network is effectively infinite
- **Category:** Real-World Fidelity
- **Severity:** Critical
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (381–388), `src/lib/worldEngine/networkRuntime.ts` (66–84)
- **Problem Description:** Step 7 calls `applyNicCap(nic, server, bytes, bytes, stepMs)` but **throws away the return value** `{ deliveredFraction, queuedLatencyMs }`. Byte counters accumulate for cost/metrics, but NIC saturation never sheds traffic or adds latency — the entire backpressure model is dead in the pipeline. Additionally, per-call bytes are booked as `admittedRps * BYTES_PER_REQUEST_EACH_WAY * stepSec` **symmetrically** for both in and out (line 386–387 pass `bytes` twice), ignoring request/response size asymmetry and payload templates; and `NicState` is rebuilt per server per step, so there is no send-buffer carryover.
- **Proposed Real-World Model / Fix:** Apply `deliveredFraction` as a per-server throughput multiplier (like `admittedScale`) the next step, and add `queuedLatencyMs` to that server's instances' latency. Carry a persistent send buffer across ticks so a saturated NIC drains rather than resetting. Split ingress vs egress bytes (use route payload sizes where available; otherwise distinct request/response constants).
- **Execution Steps for Developer Agent:**
  1. Persist `nicByServer` in engine `state` (created at `start()`, keyed by serverId) instead of per-step.
  2. Capture `applyNicCap`'s result into `s.nicDeliveredFraction[serverId]` and `s.nicQueuedLatencyMs[serverId]`.
  3. In the next step's `solveFlows`/host stage, multiply that server's admits by `deliveredFraction` and add `queuedLatencyMs` to latency (mirror how `admittedScale`/`latencyMultiplier` flow through).
  4. Replace the symmetric `bytes` call with `(reqBytes, respBytes)`.
- **Verification Test:** Place a service whose `admittedRps × payload` exceeds `specs.nicMbps`; assert reported throughput saturates at the NIC cap, `queuedLatencyMs` raises p50, and dropping load lets the send buffer drain over several ticks rather than instantly.

---

### [ISSUE-003]: Request-priced managed services bill $0/month
- **Category:** Real-World Fidelity / Bug
- **Severity:** Critical
- **File(s) Affected:** `src/lib/costModelV2.ts` (96–111, 149–151)
- **Problem Description:** `managedServiceMonthlyUsd`'s registry loop only sums `instanceHourly`, `fixedMonthly`, and `storageGbMonth`. The comment at 108–109 explicitly skips `requestsPerMillion`, `computeResource`, and `egress`. Every service whose cost model is request volume therefore returns `usd === 0` and is dropped at line 151 (`if (usd === 0) continue`): **Lambda, SQS (`queue`), EventBridge (`eventBus`), SNS (`pubsub`), API Gateway, CDN request cost, and managed `ec2`** all bill $0/month regardless of traffic. A serverless architecture projects ~$0.
- **Proposed Real-World Model / Fix:** Bill `requestsPerMillion` from live rps: `usd += (rps * SECONDS_PER_MONTH / 1e6) * c.usdPerMillion`. Bill `computeResource` from the service's provisioned vCPU/RAM × hours. `computeWorldCost` already threads `managed?.[ms.id]?.rps` into `managedServiceMonthlyUsd` (line 150) — consume it in the registry path, not only the serverless-DB path.
- **Execution Steps for Developer Agent:**
  1. Add `rps: number` handling inside the registry `for (const c of spec.pricing)` loop: handle `c.kind === 'requestsPerMillion'` and `c.kind === 'computeResource'`.
  2. Use `SECONDS_PER_MONTH` (pick one month basis — see ISSUE-036).
  3. Remove/relax the `if (usd === 0) continue` early-drop for request-priced services (or drop only when both provisioned and request cost are 0).
- **Verification Test:** Add a Lambda + SQS + API Gateway world under steady rps; assert monthly cost scales with rps and is > 0; assert a zero-traffic Lambda still shows only its fixed/provisioned cost.

---

### [ISSUE-004]: Undo/redo is not gated on `running` — engine ticks the old doc while views render the new topology
- **Category:** Architecture / State
- **Severity:** Critical
- **File(s) Affected:** `src/app/world/WorldShell.tsx` (94–103), `src/app/store/world.store.ts` (506–525), `src/lib/worldEngine/index.ts` (729–746)
- **Problem Description:** Authoring is edit-locked in the UI during a run, but the global Ctrl+Z / Ctrl+Shift+Z handler has no `running` check. Pressing undo mid-run replaces `world.store.doc`; `useCompiledWorld` recompiles and every view renders the **new** graph, while the engine keeps ticking the **old** `doc`/`compiled` snapshotted at `start()`. `batch.instances` are keyed by old ids, so the new graph reads `undefined → 0/idle` until Stop. It also burns a full deep clone per keystroke (ISSUE-031) and can leave `healthOverrides` keyed to now-absent ids.
- **Proposed Real-World Model / Fix:** Gate undo/redo on `!running`, mirroring the existing edit-lock.
- **Execution Steps for Developer Agent:**
  1. In the `WorldShell` key handler, early-return from undo/redo when `useSimulationStore.getState().running`.
  2. Optionally surface a toast ("Stop the simulation to edit") for parity with the edit-lock UI.
- **Verification Test:** Start a sim, press Ctrl+Z; assert the doc is unchanged and the views stay in sync with the engine; stop, press Ctrl+Z; assert undo now works.

---

### [ISSUE-005]: `pendingEvents` grows unbounded after a single spill failure (memory leak)
- **Category:** Architecture / State
- **Severity:** Critical
- **File(s) Affected:** `src/app/store/simulation.store.ts` (29–42, 126–129)
- **Problem Description:** `onEvent` unconditionally `pendingEvents.push(event)`. Once a disk-spill fails, `spillBroken = true` and `flushEventLog` returns immediately without draining `pendingEvents`. So after one failed flush, events accumulate forever with no drain and no cap — exactly the failure the "in-memory window only" design claims to survive.
- **Proposed Real-World Model / Fix:** Stop feeding a queue that can never drain. Guard the push: `if (!spillBroken) pendingEvents.push(event)`, and clear `pendingEvents` when `spillBroken` first flips.
- **Execution Steps for Developer Agent:**
  1. Wrap the push in `onEvent` with `if (!spillBroken)`.
  2. On the transition to `spillBroken = true`, set `pendingEvents.length = 0`.
- **Verification Test:** Simulate a spill failure (mock the log command to reject), run for many ticks, assert `pendingEvents` length stays bounded (0) and memory does not grow.

---

### [ISSUE-006]: Internal dependency fan-out is not health-aware — routes traffic into `down` replicas
- **Category:** Real-World Fidelity
- **Severity:** Critical
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (59–105, 342–345)
- **Problem Description:** `splitDependencyShares` splits calls evenly across all compiled candidate paths **including down/degraded targets**. A 3-replica DB group with one `down` replica still sends 1/3 of calls into the dead node, all errored at the target (33% group error). The **entry** tier (`routingRuntime.distributeToTargets`/`pickInstance`) correctly excludes down instances — internal service-to-service traffic does not, so it never routes around internal failures. Combined with ISSUE-001, the caller does not even trip a breaker.
- **Proposed Real-World Model / Fix:** Weight shares by target health: drop `down` targets entirely, down-weight `degraded` (e.g. × `healthFactor`), renormalize the remaining shares. Mirror the entry tier's exclusion logic.
- **Execution Steps for Developer Agent:**
  1. In `splitDependencyShares`, look up each candidate target's health (via the same health map the entry tier uses).
  2. Set share = 0 for `down`; scale by `healthFactor` for `degraded`; renormalize so shares sum to 1 across surviving targets.
  3. If all targets are down, mark the row `blocked`/errored (so ISSUE-001 trips the breaker).
- **Verification Test:** 3-replica DB, force 1 replica down; assert the 2 healthy replicas absorb 100% of the group's traffic and the group error rate returns to ~0 (not 33%).

---

### [ISSUE-007]: Replica promotion has no failback, blocks a second failover, and picks lexically
- **Category:** Real-World Fidelity
- **Severity:** Critical
- **File(s) Affected:** `src/lib/worldEngine/failover.ts` (255–293, 229–250)
- **Problem Description:** `promoteReplicas` chooses `sort(a.id.localeCompare(b.id))[0]` — not the lowest-replication-lag replica. `promotedAt` is **never cleared**, so `effectiveRoleResolver` keeps the promoted node primary forever and demotes the recovered original permanently (no failback). The emit-once guard skips promotion if any sibling already has `promotedAt`, so if the **promoted** primary later fails, no new promotion occurs — a second failure in the same (blueprint, region) cluster has no failover.
- **Proposed Real-World Model / Fix:** Pick the replica with the least replication lag (or highest health). Clear `promotedAt` for a cluster once the original primary recovers (failback), or at minimum allow **re-promotion** when the current effective primary is itself down.
- **Execution Steps for Developer Agent:**
  1. Replace the lexical sort with a lag/health-based selector (add a `replicationLag` proxy or use current health/rps).
  2. In `recoverMultiAzManagedDbs`/the promotion recovery path, clear `promotedAt` for a cluster when its authored primary is healthy again.
  3. Change the emit-once guard to allow re-promotion when the current effective primary is `down`.
- **Verification Test:** Fail primary → assert a replica promotes and emits `replica_promoted`; recover primary → assert failback (or, minimally) fail the promoted node → assert a second promotion fires.

---

### [ISSUE-008]: Multi-AZ managed-DB auto-recovery cancels manual operator outages
- **Category:** Bug
- **Severity:** Critical
- **File(s) Affected:** `src/lib/worldEngine/failover.ts` (85–108, 121–146)
- **Problem Description:** `recoverMultiAzManagedDbs` deletes the id from `managedDownSince`/`manualOutages` after the failover window. But a user-triggered `setOutage('managed', id, true)` populates the same `managedDownSince`, so a manually "taken down" multi-AZ DB spontaneously restores itself ~15 s later, ignoring the operator. Manual outage and simulated AZ-failure are conflated.
- **Proposed Real-World Model / Fix:** Tag the outage source (`'manual' | 'simulated'`) and only auto-recover `'simulated'` failures.
- **Execution Steps for Developer Agent:**
  1. Change `managedDownSince` to store `{ sinceMs, source }` (or maintain a parallel `manualManagedOutages` set).
  2. In `recoverMultiAzManagedDbs`, skip ids whose source is `'manual'`.
  3. Confirm `setOutage` clears manual outages only on explicit operator resume.
- **Verification Test:** Manually take down a multi-AZ managed DB; run past the failover window; assert it stays down until the operator resumes; separately, a simulated AZ failure of the same DB auto-recovers.

---

### [ISSUE-009]: `latency` routing adds a US-East (Virginia) reference constant, mis-ranking near-equal regions
- **Category:** Real-World Fidelity / Bug
- **Severity:** Critical
- **File(s) Affected:** `src/lib/world/routing.ts` (30), `src/lib/regionConfig.ts` (5)
- **Problem Description:** `case 'latency': score = km + baseLatency * 10`. `baseLatencyMs` is documented as latency "from a US East reference client" — a per-region constant, not a function of the population's location. Adding it biases **every** population toward low-`baseLatency` regions (us-east-1=15, us-east-2=20). A London population ranks Ireland (75) ahead of London (80) and Frankfurt (85) because Ireland is closer to Virginia, not to London. The `km` term already captures true geographic distance; `baseLatency` corrupts the ordering.
- **Proposed Real-World Model / Fix:** Model latency from the population→region great-circle distance (propagation ≈ `km / c_fiber` RTT) plus a small fixed per-region processing constant. Simplest correct fix: `score = km` (drop `baseLatency`) or `score = km * PROPAGATION_MS_PER_KM + regionProcessingMs`.
- **Execution Steps for Developer Agent:**
  1. Replace line 30 with a distance-derived latency (reuse `greatCircleKm`).
  2. If a per-region processing constant is desired, add a genuinely location-independent small constant (not the US-East reference).
  3. Update `routing.test.ts` golden orderings intentionally (document the corrected expectations).
- **Verification Test:** A London population under `latency` policy ranks Frankfurt/London ahead of Ireland by true distance; a Tokyo population ranks ap-northeast regions first.

---

### [ISSUE-010]: `ttl-outlives-detection` rule logic is inverted
- **Category:** Bug
- **Severity:** Critical
- **File(s) Affected:** `src/lib/analysis/rules/capacity.ts` (101–116)
- **Problem Description:** The rule fires when `ttlMs < detectMs` and claims failover lags because "clients re-resolve faster than a failed region is detected." This is backwards. Total failover time ≈ detection window + up to one TTL; a **short** TTL minimizes the added lag and is good. The real anti-pattern is TTL ≫ detection (clients keep a stale cached record long after the failure is detected). The rule flags the healthy config, stays silent on the dangerous one, and its "fix" ("raise dnsTtlSec") actively worsens real failover.
- **Proposed Real-World Model / Fix:** Invert: fire when `ttlMs > detectMs` (TTL dominates the failover budget); change the fix text to "lower dnsTtlSec below the detection window."
- **Execution Steps for Developer Agent:**
  1. Change the guard to `if (ttlMs <= detectMs) return []`.
  2. Rewrite `why`/`fix` strings to describe stale-cache lag and recommend lowering `dnsTtlSec`.
  3. Update the rule's test expectations.
- **Verification Test:** `dnsTtlSec=300, detect=30s` fires; `dnsTtlSec=5, detect=30s` does not.

---

### [ISSUE-011]: Security rules miss `0.0.0.0/0` CIDR — exposed-DB / open-front-door false negatives
- **Category:** Bug / Security
- **Severity:** Critical
- **File(s) Affected:** `src/lib/analysis/rules/network.ts` (17–20, 70–113)
- **Problem Description:** `openToAny` treats a rule as internet-open only when `m.source === 'any'` (literal). A rule `{action:'allow', port:5432, source:'0.0.0.0/0'}` — a valid CIDR `FirewallSource` that is the entire internet — is **not** flagged by `db-port-exposed` → false negative on a genuinely exposed database. Conversely `entry-unreachable` calls a public port reachable only via `0.0.0.0/0` "unreachable" → false positive.
- **Proposed Real-World Model / Fix:** Treat `source === 'any'` **or** a CIDR that covers `0.0.0.0/0` (and `::/0`) as internet-open. Add a helper `isInternetSource(source)` that returns true for `'any'`, `'0.0.0.0/0'`, `'::/0'`, and any prefix length 0.
- **Execution Steps for Developer Agent:**
  1. Add `isInternetSource` (parse CIDR prefix; `/0` ⇒ internet) in a shared network helper.
  2. Replace `m.source === 'any'` checks in `openToAny`, `db-port-exposed`, and `entry-unreachable`.
- **Verification Test:** A DB firewall `allow 5432 from 0.0.0.0/0` fires `db-port-exposed` (critical); a public entry reachable only via `0.0.0.0/0` is **not** flagged unreachable.

---

### [ISSUE-012]: Deserializer does shape-only validation + unsafe cast — bad numbers/enums poison the pure model
- **Category:** Bug / Type-safety
- **Severity:** Critical
- **File(s) Affected:** `src/lib/serializer.ts` (47–101)
- **Problem Description:** `deserializeWorld` checks only that 8 named collections are non-null objects, then `const result = data as ScalemapFileV3` and returns. It never validates that `server.hourlyUsd`/`specs.ramMb` are finite (a string or `NaN` propagates into `computeWorldCost` ⇒ `monthlyUsd = NaN`), that `routing.policy` is a valid enum (an unknown value falls through the `switch` in `routing.ts` leaving `score` **uninitialized/undefined**, poisoning the sort), or that `dnsTtlSec`/`healthCheckIntervalMs` exist. A corrupt or hostile `.scalemap` passes the gate.
- **Proposed Real-World Model / Fix:** Validate at the boundary with a schema (zod/valibot) or hand-rolled guards: coerce/reject non-finite numbers, validate `policy` against the enum, default missing routing fields, and reject dangling required references.
- **Execution Steps for Developer Agent:**
  1. Add a schema/guard layer validating entity numeric fields (`Number.isFinite`), enums, and required routing fields.
  2. Reject with a specific error message (consistent with the existing "missing or malformed world document" style) or coerce safe defaults.
  3. Add a `default` case in `routing.ts`'s policy `switch` that falls back to `geo` so an unexpected value can never leave `score` undefined (defense in depth).
- **Verification Test:** Load a file with `hourlyUsd: "abc"` ⇒ rejected (not `NaN` cost); load `policy: "nonsense"` ⇒ rejected or falls back to `geo` with a defined ordering.

---

### [ISSUE-013]: Flow solver is stateless steady-state — no TCP backpressure, no queue draining, instant recovery
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (220–423)
- **Problem Description:** `solveFlows` recomputes rps from scratch each tick via one BFS pass; there is no persistent per-instance queue/inflight state. `admitted = offered × admittedScale × healthFactor`; excess demand becomes **instantaneous** `errorRps`. Consequences: no connection backpressure (an overloaded downstream cannot slow its caller), no queue draining (throughput returns to steady-state the next tick — outage recovery is instantaneous, not a drain curve), and no latency-then-timeout behavior. This is the root cause behind ISSUE-014 (snap-to-zero) and ISSUE-016 (oscillation).
- **Proposed Real-World Model / Fix:** Give each instance a queue depth `Q` carried across ticks. `arrivals` = offered this step; `served = min(serviceRate·stepSec, Q + arrivals)`; `Q_next = max(0, Q + arrivals − served)`; latency from `Q` via Little's law (`L = λW`); error only requests exceeding a max-queue / timeout bound. This single change is inherently damped (fixes oscillation) and drains naturally (fixes snap-to-zero).
- **Execution Steps for Developer Agent:**
  1. Add `queueDepth: Map<InstanceId, number>` to engine `state`, initialized at `start()`.
  2. In `solveFlows`, compute `served`/`Q_next` per instance; derive latency from queue length; carry `Q_next` forward.
  3. Bound the queue (`maxQueue` from workload profile) and only convert overflow/timeouts to `errorRps`.
  4. Coordinate with ISSUE-001 (breaker error fraction) and ISSUE-016 (drop the separate smoothing once queues damp naturally).
- **Verification Test:** Apply a load spike then remove it; assert throughput ramps up bounded by service rate, queue builds then **drains** over several ticks, latency rises with queue depth, and errors appear only past the max-queue bound.

---

### [ISSUE-014]: Metrics snap to healthy-zero during an upstream outage instead of erroring/draining
- **Category:** Architecture / State
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/metrics.ts` (190–215)
- **Problem Description:** `buildBatch` gives an instance that received no flow record this step the default window `{steps:1, admittedSum:0, latencies:[0]}` ⇒ EMA rps decays to 0 with **errorRate 0**, reported `healthy`. A service starved by an upstream outage looks idle-and-fine rather than failing/draining. `activeConnections = rps × p50/1000` also collapses to ~0 immediately (no keep-alive/timeout drain).
- **Proposed Real-World Model / Fix:** Distinguish "idle (no demand)" from "starved (upstream down)". If an instance has a healthy upstream demand but received zero admitted flow because an upstream is down, report it as erroring/draining, and drain `activeConnections` over a keep-alive timeout rather than instantly. Largely subsumed by ISSUE-013's queue model (a starved instance keeps a nonzero draining queue).
- **Execution Steps for Developer Agent:**
  1. Pass upstream-health context into `buildBatch` (or derive from the queue model).
  2. When an instance is starved (upstream down) rather than genuinely idle, set a nonzero error/health signal.
  3. Drain `activeConnections` with an exponential toward 0 over a configurable keep-alive window.
- **Verification Test:** Take down a front-tier dependency; assert the starved backend reports draining/erroring (not `healthy` at 0 rps) and its connection count decays over several ticks.

---

### [ISSUE-015]: Breaker window is an unweighted sample counter with no hysteresis (flapping)
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/breakers.ts` (19–23, 56–80)
- **Problem Description:** `recordResult` pushes one 0/1 per call per tick into a `windowSize=20` array — **unweighted by rps** (a 1-rps and a 10 000-rps dependency each contribute one sample) — and the rate is `sum/length` over samples, not over a wall-clock window (real Hystrix/resilience4j use time-bucketed windows). The close path treats a **single** half-open success as fully closed + window cleared, and uses one `errorThreshold=0.5` for both open and stay-open. A service hovering at ~50% errors flaps open→half-open→one-success→closed→re-open.
- **Proposed Real-World Model / Fix:** Rolling time-bucketed, rps-weighted error rate; require `k` consecutive half-open probe successes to close; add a **close threshold below the open threshold** (hysteresis band, e.g. open at 50%, close only below 20%).
- **Execution Steps for Developer Agent:**
  1. Replace the flat sample array with time buckets (e.g. 10 × 1 s) storing weighted `{failures, total}`.
  2. Compute error rate over the bucketed window; open at `openThreshold`, require rate `< closeThreshold` **and** `k` consecutive half-open successes to close.
  3. Integrate the weighted `recordResult` signature from ISSUE-001.
- **Verification Test:** A dependency at a steady 50% error rate opens and **stays** open (no flapping); a dependency recovering to <20% closes only after `k` successful probes.

---

### [ISSUE-016]: Delayed-feedback throughput oscillation — no smoothing on `admittedScale`
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (313–329), `src/lib/worldEngine/flows.ts` (316)
- **Problem Description:** Host scheduling reads `s.prevFlows` (one-step lag) to compute `admittedScale`, applied to this step's admits with no smoothing. Classic delayed-feedback oscillator: pressure 2 → scale 0.5 next tick → admitted halves → pressure 1 → scale 1 → admitted doubles → pressure 2 … a two-step limit cycle in throughput/latency/error.
- **Proposed Real-World Model / Fix:** EMA-smooth `admittedScale` (`scale_t = α·target + (1−α)·scale_{t−1}`), or — preferred — adopt the ISSUE-013 queue model, which is inherently damped and makes the separate scale unnecessary.
- **Execution Steps for Developer Agent:**
  1. If keeping the proportional model: store `admittedScale` per server in `state`, EMA-smooth with small α.
  2. If adopting queues (ISSUE-013): remove the proportional shed and derive throughput from `served = min(serviceRate, Q+arrivals)`.
- **Verification Test:** Apply a constant overload; assert throughput converges to a stable value instead of oscillating between ~0.5× and ~1× each tick.

---

### [ISSUE-017]: Demand is a smooth sinusoid ±3% — no burstiness
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/demand.ts` (11–18)
- **Problem Description:** `populationDemandRps` = diurnal sine × `(1 ± 0.03)` uniform jitter. Real arrivals are Poisson (variance ≈ mean) with heavy-tailed bursts / flash crowds and autocorrelation. ±3% uniform never stresses queues, breakers, or capacity thresholds — the system always looks adequately provisioned.
- **Proposed Real-World Model / Fix:** Sample arrivals from a Poisson/negative-binomial around the diurnal mean (via seeded `rng`); inject occasional burst multipliers (MMPP / on-off bursts) with tunable intensity. Keep it deterministic through the seeded stream.
- **Execution Steps for Developer Agent:**
  1. Replace the uniform jitter with a seeded Poisson sampler around the diurnal mean.
  2. Add an optional burst process (low-probability multiplier bursts) with a config knob.
  3. Ensure all draws use the engine `rng` for determinism.
- **Verification Test:** Over a run, arrival variance ≈ mean (Poisson) and occasional bursts push queues/breakers; two runs with the same seed produce identical demand.

---

### [ISSUE-018]: Host CPU is a memoryless host-wide proportional shredder — no per-instance fairness or run-queue
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/hostScheduler.ts` (25–41)
- **Problem Description:** One host-wide scalar `admittedScale = min(1, 1/cpuPressure)` is applied identically to every instance on the server. No cgroup/CPU-shares/nice weighting (a batch job and a latency-critical service are throttled equally; you cannot model an in-host noisy neighbor). Saturation sheds throughput immediately (proportional drop → instant errors) instead of growing a run queue and raising latency to timeout. `latencyMultiplier` raises latency but throughput is also cut, so the shed slice becomes errors with no queue.
- **Proposed Real-World Model / Fix:** Per-instance weighted fair share of `effectiveVcpu` by CPU-shares/limits; model a run queue → latency → timeout rather than proportional shed (dovetails with ISSUE-013's queue model at instance granularity).
- **Execution Steps for Developer Agent:**
  1. Add per-instance CPU weight (shares/limits) to the workload profile.
  2. Distribute `effectiveVcpu` proportionally to weights among contending instances.
  3. Convert overflow to queue growth (latency) rather than immediate throughput cut.
- **Verification Test:** Co-locate a high-share and a low-share instance on a saturated host; assert the high-share instance retains more CPU (throughput) and the low-share one degrades first.

---

### [ISSUE-019]: Burstable credits lock at 0.4× forever (accrual gated by the utilization the throttle causes)
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/vpsModel.ts` (57–71)
- **Problem Description:** Credits accrue only when `hostUtilization < CREDIT_LOW_UTIL (0.4)`; once throttled, `effectiveVcpuFactor = 0.4` reduces capacity, which keeps utilization high, which blocks accrual → permanent 0.4× lockout. Real AWS T-series accrue at a fixed baseline rate continuously (you earn whenever usage is below baseline), independent of the throttle. The throttle threshold (`credits ≤ 10`) also has no distinct recovery threshold, so it flutters around 10.
- **Proposed Real-World Model / Fix:** Accrue at a fixed baseline rate continuously; drain only for utilization **above** baseline. Add a hysteresis band: throttle at `credits ≤ 10`, recover only at `credits ≥ 25`.
- **Execution Steps for Developer Agent:**
  1. Change accrual to a continuous baseline rate (not gated by `< CREDIT_LOW_UTIL`).
  2. Drain proportional to `max(0, utilization − baseline)`.
  3. Split the throttle/recover thresholds (10 / 25).
- **Verification Test:** A burstable VM under sustained load throttles, then — with load removed below baseline — its credits recover and `effectiveVcpuFactor` returns to 1.0 (no permanent lockout, no flutter at 10).

---

### [ISSUE-020]: Health check has no rise threshold — recovery on a single probe (flapping)
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/routingRuntime.ts` (71–90)
- **Problem Description:** `runHealthChecks` resets `consecutiveFailures` to 0 on the **first** healthy probe. There is a fall threshold (`healthCheckFailureThreshold`) but no symmetric rise threshold (N consecutive successes) before a scope passes again. A scope flapping healthy/unhealthy resets its failure count every healthy probe and never trips the threshold even when failing most checks.
- **Proposed Real-World Model / Fix:** Track separate `consecutiveFailures` and `consecutiveSuccesses`; require `healthCheckHealthyThreshold` consecutive successes before marking healthy (ALB/NLB semantics).
- **Execution Steps for Developer Agent:**
  1. Add a `consecutiveSuccesses` counter and a `healthyThreshold` config (default e.g. 2).
  2. Only transition unhealthy→healthy after `healthyThreshold` consecutive successes; don't reset failures on a single success.
- **Verification Test:** A scope alternating pass/fail stays unhealthy; a scope with `healthyThreshold` consecutive passes recovers.

---

### [ISSUE-021]: `weighted` routing is strict-priority, not proportional traffic split
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/world/routing.ts` (31), plus `CompiledWorld` routing output shape
- **Problem Description:** `score = -(weight) * 1e9 + km` makes any positive weight strictly dominate distance, so `regionOrderFor` returns the single highest-weight region and 100% of traffic lands there (the engine consumes an **order**, not a distribution). Real weighted DNS (Route 53 weighted records) splits proportionally (e.g. 70/30). All-zero weights (the `createWorld` default) collapse `weighted` to pure `geo`.
- **Proposed Real-World Model / Fix:** Emit a per-region **proportion** for the `weighted` policy, not just an order. This requires an additive extension to the compiled routing output (a `weights`/`proportions` field) and engine consumption of it.
- **Execution Steps for Developer Agent:**
  1. Extend `CompiledWorld` routing output additively with an optional `regionProportions: Record<RegionId, number>` (per population).
  2. Populate it for `weighted` (normalize weights to sum 1); leave undefined for order-based policies.
  3. Update the engine's entry distribution to honor proportions when present (log the contract-drift addition per `contract-drift.md`).
- **Verification Test:** Weights `{A:70, B:30}` route ~70/30 of a population's traffic to A/B (not 100% to A).

---

### [ISSUE-022]: Managed-DB storage priced at hardcoded AWS $0.115 for all providers
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/costModelV2.ts` (11, 80–93), `src/lib/cloudRegistry.ts` (178–180)
- **Problem Description:** `DB_STORAGE_USD_PER_GB_MONTH = 0.115` is used for every provider in the DB path, even though `cloudRegistry.ts` carries provider-correct rates (GCP `0.17`, AWS `0.115`, Azure `0.115`). A GCP Cloud SQL DB's storage is under-priced ~32%.
- **Proposed Real-World Model / Fix:** Read the storage rate from `getServiceSpec(ms.nodeType, ms.provider)`'s `storageGbMonth` tier instead of the constant.
- **Execution Steps for Developer Agent:**
  1. In the DB storage branch, look up the provider/tier storage rate from the registry.
  2. Remove or deprecate the `DB_STORAGE_USD_PER_GB_MONTH` constant.
- **Verification Test:** A GCP managed DB with N GB costs `N × 0.17`, an AWS one `N × 0.115`.

---

### [ISSUE-023]: Cross-AZ / cross-region egress is flat and provider-blind
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/costModelV2.ts` (14–15, 173–174)
- **Problem Description:** `CROSS_AZ_USD_PER_GB = 0.01` and `CROSS_REGION_USD_PER_GB = 0.02` are applied regardless of provider, while internet egress **is** tiered/provider-aware via `PROVIDER_EGRESS`. AWS cross-AZ is charged per direction (~$0.02/GB round-trip), cross-region varies widely by region pair ($0.02–$0.147/GB), and GCP/Azure differ.
- **Proposed Real-World Model / Fix:** Make cross-AZ/cross-region rates provider-aware (and, for cross-region, ideally region-pair-aware). At minimum, add per-provider constants and account for AWS's per-direction billing (~2× one-way byte count) if bytes are metered one-way.
- **Execution Steps for Developer Agent:**
  1. Add per-provider cross-AZ/cross-region rate tables (extend `PROVIDER_EGRESS` or a sibling).
  2. Select the rate by the source server/service provider; document one-way vs round-trip byte convention and apply the per-direction factor.
- **Verification Test:** The same byte volume costs differently across providers; AWS cross-AZ ≈ 2× the previous flat value if bytes were metered one-way.

---

### [ISSUE-024]: `sum(byAz) ≠ monthlyUsd` — orphaned-AZ servers/services dropped from the total
- **Category:** Bug
- **Severity:** Major
- **File(s) Affected:** `src/lib/costModelV2.ts` (139–158, 186–187)
- **Problem Description:** A server always bumps `byAzMap` but only bumps `byRegionMap` when `doc.azs[server.azId]` exists; `computeTotal` sums `byRegionMap` only, so a server referencing a deleted AZ contributes to `byAz` but is **excluded from `monthlyUsd`**. Same for AZ-scoped managed services. During editing (a common transient orphan state), the total understates cost and `sum(byAz) ≠ monthlyUsd`.
- **Proposed Real-World Model / Fix:** Derive the total from a provably-complete accumulator: sum a single scalar as you bump, or route orphans into a region-less bucket that is included in the total.
- **Execution Steps for Developer Agent:**
  1. Accumulate `computeTotal` alongside every `bump` (independent of region resolution).
  2. Or add an `unassigned` region bucket for orphaned AZ references and include it in the total.
- **Verification Test:** Create a server pointing at a deleted AZ; assert `sum(byAz) === monthlyUsd` and the total includes the orphan's cost.

---

### [ISSUE-025]: `no-failover-region` only fires in a single-region world
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/analysis/rules/structural.ts` (46–67), `src/lib/world/routing.ts` (22–45)
- **Problem Description:** The rule fires when `populationRegionOrder[pop.id].length === 1`, but `regionOrderFor` returns **every** region in `doc.regions` regardless of whether it hosts the population's entry blueprint. With ≥2 regions the order length is ≥2 and the rule never fires — even if the second region has zero placed instances and cannot serve failover. It conflates region count with failover capability.
- **Proposed Real-World Model / Fix:** Base the check on **servable** regions (those with a placed entry-blueprint instance), and fire when that set has size 1.
- **Execution Steps for Developer Agent:**
  1. Compute a `servableRegions(pop)` set from `compiled.instances` (entry blueprint present).
  2. Fire the rule when `servableRegions.size === 1`.
- **Verification Test:** A two-region world with all entry capacity in region A fires `no-failover-region`; adding a real entry instance in region B clears it.

---

### [ISSUE-026]: `replicas-colocated` misses partial colocation and only checks the first primary
- **Category:** Real-World Fidelity
- **Severity:** Major
- **File(s) Affected:** `src/lib/analysis/rules/structural.ts` (82–86)
- **Problem Description:** `if (!replicas.every(r => r.azId === primaryAz)) continue` with `primaryAz = primaries[0].azId` — so 3 replicas with 2 in the primary AZ + 1 elsewhere are **not** flagged, though the colocated copies remain a SPOF; and with multiple primaries in different AZs only `primaries[0]` is considered.
- **Proposed Real-World Model / Fix:** Flag when **any** subset of replicas (≥2, or ≥ some threshold) share an AZ, rather than requiring all; evaluate per primary AZ.
- **Execution Steps for Developer Agent:**
  1. Group replicas by AZ; flag AZs containing ≥2 replicas (or replica+primary colocation).
  2. Iterate all primaries, not just `primaries[0]`.
- **Verification Test:** 3 replicas, 2 colocated with the primary AZ ⇒ finding fires; fully spread replicas ⇒ no finding.

---

### [ISSUE-027]: `compileWorld` path resolution is O(instances² × deps)
- **Category:** Performance
- **Severity:** Major
- **File(s) Affected:** `src/lib/world/compileWorld.ts` (38–92)
- **Problem Description:** For each `from` instance and each dependency, the code scans **all** instances (`for (const to of Object.values(instances))`, rebuilding the array each iteration) to find blueprint matches, discarding most via `to.blueprintId !== targetBpId`. For 500 instances × 3 deps that's ~750k `evaluateInstancePath` calls. Complexity O(I × D × I).
- **Proposed Real-World Model / Fix:** Build a `Map<BlueprintId, ServiceInstance[]>` once (as `routing.ts` already does for `azBlueprintTargets`) and index dependencies into it ⇒ O(I × D × matches). Hoist `Object.values(instances)` out of the loops.
- **Execution Steps for Developer Agent:**
  1. Precompute `instancesByBlueprint` once at the top of `compileWorld`.
  2. Replace the inner full scan with a map lookup by target blueprint id.
- **Verification Test:** Compile a 500-instance world; assert output paths are identical to before and compile time drops materially (benchmark before/after).

---

### [ISSUE-028]: `compileWorld()` recompiled per-component and per-AzRow on every doc change
- **Category:** Performance
- **Severity:** Major
- **File(s) Affected:** `src/app/world/useCompiledWorld.ts` (6–9); call sites `RegionView.tsx:41`, `ServerView.tsx:26`, `az/DatacenterFloor.tsx:65`, `region/AzRow.tsx:62`, `region/TimelineV2.tsx:96`
- **Problem Description:** `useCompiledWorld()` memoizes per **hook instance**. `RegionView` renders one `<AzRow>` per AZ, each calling `useCompiledWorld()` independently, so a region with N AZs runs `compileWorld(doc)` N+2 times (RegionView + TimelineV2 + every AzRow) on every doc mutation — each an O(instances) compile.
- **Proposed Real-World Model / Fix:** Compile once at the top (a context provider or a `world.store`-derived selector memoized on `doc` identity) and thread `compiled` down as a prop, as `RegionView` already threads `railPairs`/`costs`.
- **Execution Steps for Developer Agent:**
  1. Add a `CompiledWorldProvider` (or a memoized store selector) computing `compileWorld(doc)` once per doc identity.
  2. Consume it via context/prop in `RegionView`, `AzRow`, `TimelineV2`, `DatacenterFloor`, `ServerView`; pass `compiled` into `AzRow` as a prop.
- **Verification Test:** Instrument `compileWorld` with a call counter; on a single doc mutation in a 5-AZ region, assert it runs **once**, not 7×.

---

### [ISSUE-029]: O(servers × instances) rps/dominant-color derivations in the AZ floor and every AzRow, unmemoized, per 1 Hz batch
- **Category:** Performance
- **Severity:** Major
- **File(s) Affected:** `src/app/world/az/DatacenterFloor.tsx` (157–166), `src/app/world/region/AzRow.tsx` (75–80, 159–162), `src/app/world/region/regionData.ts` (250–262)
- **Problem Description:** `DatacenterFloor.rpsByServer` re-scans the entire instance map for every AZ server every time `batch` changes; `AzRow` has **zero `useMemo`** and recomputes `instanceCount`, `residentInstanceIds` (full filters), per-server `dominantBlueprintColor` (itself iterates all instances), and a per-server rps reduce every batch. With N AzRows this is ~O(N × servers × instances) per second.
- **Proposed Real-World Model / Fix:** Build a `Map<serverId, instances[]>` once (the engine already has `groupInstancesByServer`) and index into it; precompute the per-server dominant-color map once in `RegionView` and thread it down; memoize.
- **Execution Steps for Developer Agent:**
  1. Compute `instancesByServer` and `dominantColorByServer` once (in the compiled provider from ISSUE-028 or in `RegionView`).
  2. Pass them into `AzRow`/`DatacenterFloor`; wrap the derived values in `useMemo`.
- **Verification Test:** Profile a region with many AZs/servers under a running sim; assert per-batch render work is roughly O(servers), not O(servers × instances).

---

### [ISSUE-030]: Whole-`MetricsBatch` subscription re-renders the full region subtree every tick; derived values unmemoized
- **Category:** Performance
- **Severity:** Major
- **File(s) Affected:** `src/app/world/RegionView.tsx` (43, 65–93)
- **Problem Description:** `useSimulationStore(s => s.scrubBatch ?? s.latestBatch)` changes identity every 1 Hz `onMetrics`, re-rendering `RegionView` and every child. None of `azShares`, `ribbonAlert` (filters the full events array), `computeWorldCost(doc, …)` (over the whole doc), `regionManagedServices`, `replicaRailPairs`, or the `railEntries`/`dbEndpointsByAz` maps are memoized — all recompute each second.
- **Proposed Real-World Model / Fix:** Memoize derived values on `[batch, doc, compiled, events]`; subscribe to narrower slices (e.g. `batch.regions[regionId]`) with a custom equality where only part of the batch is needed.
- **Execution Steps for Developer Agent:**
  1. Wrap each derived computation in `useMemo` with precise deps.
  2. Where a child needs only a region's slice, select `batch.regions[regionId]` with `shallow` equality.
  3. Move `computeWorldCost` behind a memo keyed on `[doc, worldMetrics]`.
- **Verification Test:** Under a running sim, assert `computeWorldCost` and the map-builders run once per relevant-input change, and unaffected children don't re-render each tick (React Profiler).

---

### [ISSUE-031]: History pushes full `JSON.parse(JSON.stringify(doc))` deep clones despite immutable updates
- **Category:** Performance
- **Severity:** Major
- **File(s) Affected:** `src/app/store/world.store.ts` (30, 501–525)
- **Problem Description:** Every mutation goes through `mutate → pushHistory`, which deep-clones the entire `WorldDoc` via JSON round-trip. But every mutation already produces a new, structurally-shared immutable doc and nothing mutates in place — the clone is pure waste. With up to 100 history entries each a full deep copy, this is a per-edit CPU cost (serialize+parse of the whole world) and ~100× full-world memory.
- **Proposed Real-World Model / Fix:** Push the immutable `doc` **reference** directly (`history: [...trimmed, doc]`); drop `deepCopy` in undo/redo. If defensiveness is desired, `Object.freeze` in dev instead of cloning.
- **Execution Steps for Developer Agent:**
  1. Replace `deepCopy(doc)` with `doc` in `pushHistory`, `undo`, `redo`.
  2. (Optional) freeze docs in dev builds to catch accidental in-place mutation.
- **Verification Test:** Make 100 edits; assert undo/redo restores exact prior docs and heap/history memory is a small multiple of one doc, not ~100×.

---

### [ISSUE-032]: Health propagation is O(regions × azs × servers) every step
- **Category:** Performance
- **Severity:** Major
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (434–448)
- **Problem Description:** Per AZ it runs `Object.values(doc.servers).filter(v => v.azId === az.id)`, and per region it filters AZs then `servers.filter(v => azsIn.some(...))`. That's O(regions × azs × servers) **every step** — precisely the unindexed-lookup regression the file's own comment (57–62) warns against, reintroduced here.
- **Proposed Real-World Model / Fix:** Prebuild `serversByAz` and `azsByRegion` once at `start()` and index into them.
- **Execution Steps for Developer Agent:**
  1. Build `serversByAz: Map<AzId, Server[]>` and `azsByRegion: Map<RegionId, Az[]>` at `start()`.
  2. Replace the per-step filters with map lookups.
- **Verification Test:** Profile a large world's step cost; assert the health-propagation stage no longer scales with `regions × azs × servers`.

---

### [ISSUE-033]: Half-open breaker trial can wedge permanently
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/breakers.ts` (85–86, 94–101), `src/lib/worldEngine/index.ts` (391–393)
- **Problem Description:** A half-open probe sets `trialPending=true`, cleared only in `recordResult` or on `transition` into half-open. But step 8 skips rows with `row.rps <= 0`, so a probe that produces no downstream row never reaches `recordResult`; `trialPending` stays true and `admitRequest` refuses everyone — the breaker is wedged half-open (behaves as open) until the next `resetMs` re-transition.
- **Proposed Real-World Model / Fix:** Expire an unresolved trial after a timeout, or resolve it defensively each tick.
- **Execution Steps for Developer Agent:**
  1. Track `trialStartedMs`; if a trial is unresolved after `trialTimeoutMs`, clear `trialPending` (treat as failure or retry).
- **Verification Test:** Put a breaker half-open with a dependency that yields no rows; assert it doesn't wedge and re-probes within `trialTimeoutMs`.

---

### [ISSUE-034]: `cpuPressure` clamped to 1 before credit drain — credits under-drain under heavy load
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (343), `src/lib/worldEngine/vpsModel.ts` (63)
- **Problem Description:** `stepVps(..., Math.min(1, host.cpuPressure), ...)`. Since drain scales with `(hostUtilization − 0.4)/0.6`, at true pressure 5 the clamp caps drain at the pressure-1 rate — a hammered burstable VM burns credits far too slowly.
- **Proposed Real-World Model / Fix:** Pass the unclamped (or higher-ceiling) pressure into the credit-drain term so drain reflects real overload.
- **Execution Steps for Developer Agent:**
  1. Feed `host.cpuPressure` (not `min(1, …)`) into the drain calculation, or raise the clamp ceiling.
- **Verification Test:** A burstable VM at pressure 5 drains credits faster than one at pressure 1.

---

### [ISSUE-035]: `coreUtilization` fills cores sequentially and mixes raw vs. effective vCPU
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/hostScheduler.ts` (33–41)
- **Problem Description:** Cores fill core 0 → 1.0 then core 1, etc., so a 4-core host at 50% shows two pinned + two idle instead of ~50% across four; and `usedCores` is capped at steal/credit-reduced `safeEffectiveVcpu` but distributed across raw `specs.vcpu`, so under throttle utilization can never read full even at saturation. Cosmetic but misleading for the CPU-die viz.
- **Proposed Real-World Model / Fix:** Spread utilization evenly across cores; distribute over `effectiveVcpu` consistently.
- **Execution Steps for Developer Agent:**
  1. Compute per-core utilization as `totalUtil / coreCount` (even spread) or model a scheduler distribution.
  2. Use one consistent vCPU basis for cap and distribution.
- **Verification Test:** A 4-core host at 50% shows ~50% on all four cores.

---

### [ISSUE-036]: Month-length constant inconsistency (730 h vs 2.63e6 s)
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/costModelV2.ts` (13, 17)
- **Problem Description:** `HOURS_PER_MONTH = 730` ⇒ 2,628,000 s, but `SECONDS_PER_MONTH = 2_630_000`. Instance-hour costs and egress/serverless costs use slightly different month lengths (0.076% drift).
- **Proposed Real-World Model / Fix:** Derive one from the other: `SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600`.
- **Execution Steps for Developer Agent:** Replace the literal `2_630_000` with `HOURS_PER_MONTH * 3600`.
- **Verification Test:** `SECONDS_PER_MONTH === 2_628_000`; cost tests updated accordingly.

---

### [ISSUE-037]: Managed hop latency is a flat 3 ms except for DBs; metrics EMA hides transients
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (34), `src/lib/worldEngine/metrics.ts` (19)
- **Problem Description:** `MANAGED_SERVICE_LATENCY_MS = 3` books a constant 3 ms for every non-DB managed service (cache, queue, object store, CDN) regardless of load; and `EMA_ALPHA = 0.3` at 1 Hz attenuates a 1 s spike to ~30%, lagging any breaker/health cross-check that reads published metrics.
- **Proposed Real-World Model / Fix:** Make managed latency load-dependent (base + queueing under saturation, per service class); consider reporting an un-smoothed p99 alongside the EMA for transient visibility.
- **Execution Steps for Developer Agent:**
  1. Add per-class base latency + a saturation term for managed services.
  2. Publish a non-EMA tail metric or lower α for latency where transient fidelity matters.
- **Verification Test:** A saturated managed cache shows rising latency; a 1 s error spike is visible in the tail metric.

---

### [ISSUE-038]: `rng.pick` on an empty array returns `undefined` with no guard
- **Category:** Bug / Type-safety
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/rng.ts` (31–35)
- **Problem Description:** `arr[Math.min(idx, arr.length-1)]` ⇒ `arr[-1]` = `undefined` for an empty array. Callers mostly pre-check, but the primitive is unsafe and any future caller inherits a silent `undefined`.
- **Proposed Real-World Model / Fix:** Return a typed `T | undefined` and/or throw on empty; add an explicit length guard.
- **Execution Steps for Developer Agent:** Add `if (arr.length === 0) return undefined` (and update the signature) or assert non-empty.
- **Verification Test:** `rng.pick([])` returns `undefined` (or throws) rather than reading index −1.

---

### [ISSUE-039]: Traced-request population attribution matches on region only
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (490–495)
- **Problem Description:** `populationForEntry` returns the **first** population routed to the instance's region, mis-attributing `TracedRequest.populationId` whenever several populations converge on one region.
- **Proposed Real-World Model / Fix:** Attribute by the actual routed population for the entry (weight by each population's contribution), not the first region match.
- **Execution Steps for Developer Agent:** Thread the originating population id through the flow/entry distribution, or attribute proportionally to per-population rps into that region.
- **Verification Test:** Two populations into one region ⇒ traced requests are attributed to both in proportion to their rps.

---

### [ISSUE-040]: Tracer samples entries and hops uniformly, not weighted by rps
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/replay.ts` (83, 91)
- **Problem Description:** `rng.pick(entries)` and `rng.pick(f.downstream)` give a 1-rps blocked edge the same probability as a 1000-rps main path, so sampled traces are unrepresentative.
- **Proposed Real-World Model / Fix:** Weight sampling by `offeredRps` / `row.rps` (roulette-wheel selection via the seeded rng).
- **Execution Steps for Developer Agent:** Replace uniform picks with cumulative-weight selection keyed on rps.
- **Verification Test:** Over many samples, trace frequency per path ≈ its share of total rps.

---

### [ISSUE-041]: `percentile` is coarse nearest-rank over a ≤10-sample window
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/metrics.ts` (156–160)
- **Problem Description:** `idx = floor(p·len)` with ~10 samples per instance per 1 s window makes p99 just the max of 10 samples and p50 the 5th — statistically weak for tail latency.
- **Proposed Real-World Model / Fix:** Use linear interpolation between ranks and a larger reservoir (e.g. keep a rolling reservoir across a few seconds, or accumulate a small histogram).
- **Execution Steps for Developer Agent:**
  1. Switch to interpolated percentile.
  2. Widen the latency reservoir (rolling multi-second buffer or bucketed histogram).
- **Verification Test:** p99 over a known latency distribution matches the analytic value within tolerance.

---

### [ISSUE-042]: `errorRps` conflates load-shed, degraded-serving, and hard-down
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (315–321), `src/lib/worldEngine/index.ts` (424–447)
- **Problem Description:** `errorRps += offered − admitted`, where `admitted` folds `admittedScale` (CPU shed) and `healthFactor` (0.7 degraded, 0 down). A degraded-but-serving instance reports 30% "errors" that then feed health error-rate inputs — a soft feedback that can push a merely-degraded scope toward `down`.
- **Proposed Real-World Model / Fix:** Separate shed (retryable/queued), degraded-serving, and hard failure into distinct counters; feed only genuine failures into the health error-rate signal.
- **Execution Steps for Developer Agent:**
  1. Split `errorRps` into `sheddedRps`, `degradedRps`, `failedRps`.
  2. Feed only `failedRps` into the health signal; report shed as queue/latency (dovetails with ISSUE-013).
- **Verification Test:** A degraded (0.7) instance under light load does not drift to `down` purely from reported "errors."

---

### [ISSUE-043]: Cold-start over-admit transient on step 1
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (313–316)
- **Problem Description:** On the first step `prevFlows = {}`, so every `admittedScale` defaults to 1 (no throttle) and every instance over-admits before correcting — a step-1 error/latency spike that also seeds ISSUE-016's oscillation.
- **Proposed Real-World Model / Fix:** Initialize `admittedScale` conservatively or run a warm-up step; the ISSUE-013 queue model removes the transient (queues start empty and fill naturally).
- **Execution Steps for Developer Agent:** Seed `prevFlows`/scale from a zero-load equilibrium at `start()`, or adopt queues.
- **Verification Test:** No error/latency spike on the first published batch of a fresh run.

---

### [ISSUE-044]: Manual outage set is keyed by bare id, scope-agnostic
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/failover.ts` (28, 85–108)
- **Problem Description:** `manualOutages: Set<string>` ignores `scope`; `managedDown` and health `manualDown` inputs all test `manualOutages.has(id)`, so any id collision across scopes cross-triggers. Low risk given current id namespacing, but the `scope` argument is effectively ignored.
- **Proposed Real-World Model / Fix:** Key by `${scope}:${id}` (or nested maps per scope).
- **Execution Steps for Developer Agent:** Change the set key to include scope; update all `.has`/`.add`/`.delete` sites.
- **Verification Test:** Taking down `az:X` does not affect `managed:X`.

---

### [ISSUE-045]: Two divergent event-id schemes; facade `idSeq` only covers `emit()`
- **Category:** Architecture
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/events.ts` (39), `src/lib/worldEngine/failover.ts` (61, 137, 287), `src/lib/worldEngine/index.ts` (155–159)
- **Problem Description:** `mkEvent` uses `evt-${idSeq}`, but `failover.ts` emits hand-built ids (`outage-…`, `promote-…`, `managed-promote-…`) via `emitEvent`, which doesn't touch `idSeq`. Ordering/monotonicity across subsystems isn't guaranteed and the contract's id-sequence intent is half-honored.
- **Proposed Real-World Model / Fix:** Route all emissions through one id allocator (`mkEvent`/`idSeq`); keep the semantic prefix as a separate `kind` field, not the id.
- **Execution Steps for Developer Agent:** Funnel failover emits through the same `mkEvent` allocator; move the descriptive prefix into a field.
- **Verification Test:** All emitted event ids are globally monotonic within a run.

---

### [ISSUE-046]: `managedWindow.steps` increments for idle DBs, averaging them toward zero
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/metrics.ts` (46, 115–133)
- **Problem Description:** The accumulation union includes `Object.keys(managedRuntime)`, so `mw.steps++` fires for a DB with a runtime entry but no traffic this step — contradicting the "steps counts only steps with ≥1 row" comment and averaging its rps/utilization down.
- **Proposed Real-World Model / Fix:** Only increment `steps` when the service actually received a row this step.
- **Execution Steps for Developer Agent:** Gate `mw.steps++` on `receivedRow` for managed services (mirror the instance path).
- **Verification Test:** An idle managed DB's averaged rps/utilization is not diluted by zero-traffic steps.

---

### [ISSUE-047]: Failover maps not reconciled on entity deletion mid-run
- **Category:** Architecture / State
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/failover.ts` (27–37), `src/lib/worldEngine/index.ts` (whole-run `doc`/`compiled` hold)
- **Problem Description:** The engine holds `compiled`/`doc` for the whole run; `drainUntil`/`promotedAt`/`managedDownSince` are never reconciled if an AZ/instance/managed service is removed mid-run. Stale keys linger (e.g. `promotedAt` for a deleted placement keeps `effectiveRoleResolver` on the slow path). Mostly masked by the edit-lock, but interacts with ISSUE-004.
- **Proposed Real-World Model / Fix:** On a mid-run recompile/edit, prune failover-map keys not present in the current `compiled`. (Simplest: keep the edit-lock strict so mid-run topology can't change, and clear maps on stop/reset — already partly done.)
- **Execution Steps for Developer Agent:** Add a reconcile step that drops keys absent from `compiled`, invoked wherever the running doc could change.
- **Verification Test:** After a (guarded) mid-run change, failover maps contain no keys for deleted entities.

---

### [ISSUE-048]: Double `start()` transiently double-drives the engine loop
- **Category:** Architecture / State
- **Severity:** Minor
- **File(s) Affected:** `src/app/store/simulation.store.ts` (105–152), `src/lib/worldEngine/index.ts` (718–726, 729–750)
- **Problem Description:** `store.start()` doesn't check `running`. `worldEngine.start()` overwrites `state` and schedules a new rAF, but the previous run's in-flight rAF callback reads module-level `state`, so a second `start()` yields two rAF chains both advancing the same new state and both calling `renderAll` — doubling sim speed/render — until a `stop()` collapses them (only one `rafId` is tracked, so the other leaks until it observes `running=false`).
- **Proposed Real-World Model / Fix:** Early-return in `store.start` if `get().running`; cancel any existing `rafId` at the top of engine `start()`.
- **Execution Steps for Developer Agent:**
  1. Guard `store.start` with `if (get().running) return`.
  2. `cancelAnimationFrame(state?.rafId)` at the top of engine `start()`.
- **Verification Test:** Call `start()` twice; assert one rAF chain, normal sim speed, no leaked loop.

---

### [ISSUE-049]: `healthOverrides` never reconciled against the doc
- **Category:** Architecture / State
- **Severity:** Minor
- **File(s) Affected:** `src/app/store/simulation.store.ts` (135–141, 178–193)
- **Problem Description:** `healthOverrides` is keyed by entity id and only cleared wholesale on `stop`/`resetSession`; nothing prunes an override whose entity was removed. Masked by the edit-lock + stop clearing, but combined with ISSUE-004 an override can reference a deleted az/region/managed id.
- **Proposed Real-World Model / Fix:** On `setOutage`/resume, prune `healthOverrides` keys not present in the current `doc`; or key outages to the engine's failover set (the source of truth).
- **Execution Steps for Developer Agent:** Add a prune pass filtering `healthOverrides` by current doc entity ids.
- **Verification Test:** After an entity is removed, its override key no longer lingers.

---

### [ISSUE-050]: `MAX_GLOBE_ARCS` value-import couples the engine module into the globe view
- **Category:** Architecture
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/globe/ArcsLayer.tsx` (18), `src/lib/worldEngine/index.ts` (796)
- **Problem Description:** Importing the value `MAX_GLOBE_ARCS` from `lib/worldEngine` pulls `index.ts` (which constructs the `worldEngine` singleton at module load) into the globe view's import graph — a coupling/bundling smell for a shared render-cap constant.
- **Proposed Real-World Model / Fix:** Move `MAX_GLOBE_ARCS` (and peers) into `worldEngine/types.ts` or a small neutral constants module both sides import.
- **Execution Steps for Developer Agent:** Relocate the constant; update both imports.
- **Verification Test:** The globe view's import graph no longer includes the engine singleton module (build/bundle check).

---

### [ISSUE-051]: `RegionPin` health selector reads a different store inside a Zustand selector (staleness + repeated O(azs))
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/globe/RegionPins.tsx` (77–88)
- **Problem Description:** The `useSimulationStore` selector calls `useWorldStore.getState().doc` and runs `Object.values(doc.azs).filter(...).every(...)` inside the selector. Zustand only re-evaluates on **simulation-store** changes, so AZ add/remove (world store) without a sim update leaves the pin's derived health stale; and the O(azs) scan runs on every sim update, per pin.
- **Proposed Real-World Model / Fix:** Subscribe to `doc.azs` via `useWorldStore` separately and combine in render; keep the selector pure over its own store.
- **Execution Steps for Developer Agent:** Split the two subscriptions; memoize the all-down computation.
- **Verification Test:** Adding/removing an AZ updates the pin health without a sim tick; selector no longer scans all AZs per sim update.

---

### [ISSUE-052]: `ScrubberV2` indexes a locally-captured frames array with an index resolved against a possibly-different array
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/ScrubberV2.tsx` (35–48, 81), `src/app/store/simulation.store.ts` (195)
- **Problem Description:** `frames` is snapshotted locally when `halted` flips; `pick()` computes the index from `frames.length`, but `setScrubIndex` re-reads `worldEngine.getReplayFrames()` to resolve the batch, and render reads `frames[scrubIndex].simMs`. If the ring and the local snapshot differ in length (late final frame, or a halt/last-push race), `scrubBatch` and the tick label disagree and `frames[scrubIndex]` can be `undefined`.
- **Proposed Real-World Model / Fix:** Derive the batch from the **same** array used for display (pass the local `frames` through, or read `scrubBatch` for the label instead of `frames[scrubIndex]`).
- **Execution Steps for Developer Agent:**
  1. Resolve `setScrubIndex` from the captured `frames`, or clamp/guard `frames[scrubIndex]`.
  2. Use `scrubBatch.simMs` for the label.
- **Verification Test:** Scrub at the boundary while a final frame arrives; assert no `undefined` deref and label/batch agree.

---

### [ISSUE-053]: `onEvent` does an O(n) array copy per event → O(n²) during bursts
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/app/store/simulation.store.ts` (128–129)
- **Problem Description:** Each event triggers `set((s) => [...s.events.slice(...), event])` — a full copy of up to 500 elements. During a failover burst (many events per step) this is O(events × window) plus a re-render per event.
- **Proposed Real-World Model / Fix:** Batch event application per tick — the engine already drains events at 1 Hz into replay; append the whole tick's events in a single `set`.
- **Execution Steps for Developer Agent:** Accumulate per-tick events and apply once per tick; or use a ring buffer with an index instead of slice+spread.
- **Verification Test:** A burst of N events in one step performs one `set` and one re-render, not N.

---

### [ISSUE-054]: Unsafe THREE attribute casts in the frame loop
- **Category:** Type-safety
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/globe/ArcsLayer.tsx` (125–126, 142–143)
- **Problem Description:** `getAttribute('lineDistance') as THREE.BufferAttribute` can actually be an `InterleavedBufferAttribute`; the `.array as Float32Array` cast assumes non-interleaved. Safe for this file's geometry today, but would silently misbehave if geometry construction changed.
- **Proposed Real-World Model / Fix:** Narrow with a runtime check or store a typed reference to the attribute at creation.
- **Execution Steps for Developer Agent:** Keep the created `BufferAttribute` in a ref and write through it instead of `getAttribute` + cast.
- **Verification Test:** Type-checks without the cast; arcs still animate.

---

### [ISSUE-055]: `InspectorV2` re-creates a new traces array every second regardless of change
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/InspectorV2.tsx` (31–36), `src/lib/worldEngine/replay.ts` (141)
- **Problem Description:** `getTracedRequests` returns a fresh array each call, so `setTraces` always gets a new reference ⇒ a steady 1 Hz re-render of the overlay even when traces are unchanged.
- **Proposed Real-World Model / Fix:** Short-circuit if the returned list is shallow-equal to the current one (or version the tracer output).
- **Execution Steps for Developer Agent:** Compare lengths + ids before `setTraces`; or expose a monotonically increasing tracer version and skip when unchanged.
- **Verification Test:** With no new traces, the overlay does not re-render each second.

---

### [ISSUE-056]: `ArcsLayer` allocates a signature string and rewrites full dash arrays every frame
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/globe/ArcsLayer.tsx` (106–109, 135–148)
- **Problem Description:** `arcsSignature(arcs)` allocates a joined string every frame (~60 Hz) even when nothing changed; the dash-flow loop rewrites each arc's `lineDistance` typed array element-by-element every frame (up to 200 × 48 ≈ 9,600 writes/frame plus a `needsUpdate` GPU re-upload per arc).
- **Proposed Real-World Model / Fix:** Cache the last signature by comparing arc count + a cheap hash and skip the string unless the ref changed; gate dash-flow to only visible arcs; consider a shader-driven dash offset (uniform) instead of CPU rewrites.
- **Execution Steps for Developer Agent:**
  1. Skip signature computation when the arcs ref is unchanged.
  2. Animate dash via a single time uniform rather than per-element array writes where feasible.
- **Verification Test:** Steady-state globe (unchanged arcs) shows no per-frame string allocation and reduced GPU uploads (profiler).

---

### [ISSUE-057]: `TimelineV2` reprocesses the full replay ring every render
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/region/TimelineV2.tsx` (106, 118, 134–142), `src/lib/worldEngine/replay.ts` (26)
- **Problem Description:** `getReplayFrames()` (fresh copy of up to 300 frames) is called at render time and again in `onMarkerClick`, and `buildLanes(...)` reprocesses all frames on every `RegionView` batch re-render (1 Hz), unmemoized.
- **Proposed Real-World Model / Fix:** Memoize `frames`/`lanes` on `[batch.simMs, events, regionId]` (the ring only grows at 1 Hz).
- **Execution Steps for Developer Agent:** Wrap `getReplayFrames`/`buildLanes` in `useMemo` keyed on `simMs`; reuse the memoized frames in `onMarkerClick`.
- **Verification Test:** Lanes recompute once per second, not per render.

---

### [ISSUE-058]: Components subscribe to the entire `events` array
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/app/world/RegionView.tsx` (46), `region/AzRow.tsx` (65), `globe/RegionPins.tsx` (89), `region/TimelineV2.tsx` (99)
- **Problem Description:** `onEvent` builds a new `events` array on every event; components subscribing to `s.events` re-render on **every** event, though `AzRow`/`RegionPin` only need "is there a recent event affecting me."
- **Proposed Real-World Model / Fix:** Derive a narrower subscription (e.g. a memoized "last relevant event simMs" selector), or detect pulses imperatively inside the existing batch-driven render.
- **Execution Steps for Developer Agent:** Replace whole-array subscriptions with targeted selectors keyed to the component's entity.
- **Verification Test:** An event unrelated to a given AzRow does not re-render it.

---

### [ISSUE-059]: DB IOPS and self-hosted storage never separately costed
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/costModelV2.ts` (80–93, 140), `src/lib/world/types.ts` (70, 139)
- **Problem Description:** Servers bill purely `hourlyUsd × 730`; `ServerSpecs.diskGb` and `WorkloadProfile.diskIoPerRequest` never enter cost, and managed-DB pricing has no provisioned-IOPS term. Real RDS/Aurora bill gp3 IOPS/throughput above baseline and Aurora bills per-I/O.
- **Proposed Real-World Model / Fix:** Add a storage-GB and provisioned-IOPS cost term for managed DBs (and optionally self-hosted disk), derived from specs and, for per-I/O models, live rps × `diskIoPerRequest`.
- **Execution Steps for Developer Agent:**
  1. Add IOPS/throughput pricing tiers to the DB registry entries.
  2. Cost them from provisioned specs (and rps for per-I/O models).
- **Verification Test:** A high-IOPS managed DB costs more than a low-IOPS one at the same instance size.

---

### [ISSUE-060]: Load balancers price L4 and L7 identically, AWS-only, no LCU/egress
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/costModelV2.ts` (48, 50–59)
- **Problem Description:** Every authored LB bills `0.0225 × 730 ≈ $16.43/mo` flat whether NLB or ALB, regardless of provider, ignoring LCU/traffic-unit charges (real ALB is base + LCU). The mode/provider are available on the `LoadBalancer` and ignored.
- **Proposed Real-World Model / Fix:** Price by `mode` (L4 vs L7) and provider; add a traffic-unit (LCU) term from live throughput/connections.
- **Execution Steps for Developer Agent:**
  1. Add per-provider, per-mode LB base rates.
  2. Add an LCU term from live metrics.
- **Verification Test:** An ALB under heavy traffic costs more than an idle one and differs from an NLB.

---

### [ISSUE-061]: Health-check timeout/jitter and rise threshold unmodeled
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/world/types.ts` (18–25), `src/lib/world/factories.ts` (22–24), `src/lib/analysis/rules/capacity.ts` (106)
- **Problem Description:** `RoutingConfig` has no health-check **timeout** (vs interval), jitter, or unhealthy→healthy recovery threshold (only a failure threshold). The `ttl-outlives-detection` detection window is `interval × threshold`, omitting request timeout and propagation, so the real detection window is longer.
- **Proposed Real-World Model / Fix:** Add `healthCheckTimeoutMs` and `healthyThreshold` (pairs with ISSUE-020); include timeout in the detection-window estimate.
- **Execution Steps for Developer Agent:** Extend `RoutingConfig` + defaults; use `interval × threshold + timeout` for detection.
- **Verification Test:** Detection window reflects timeout; recovery honors a rise threshold.

---

### [ISSUE-062]: `ocean-crossing-population` measures km but the routing order was chosen on another metric
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/analysis/rules/capacity.ts` (67–98)
- **Problem Description:** The rule compares the routed first region's `km` against the nearest region's `km` with a hardcoded 1.5× threshold, but the order may have been produced by `latency`/`weighted`/`priority`, which can legitimately not pick the km-nearest region — yielding false positives for deliberate routing.
- **Proposed Real-World Model / Fix:** Only apply the km-based check under `geo` policy, or compare against the policy's own objective (e.g. proportion under `weighted`).
- **Execution Steps for Developer Agent:** Guard the rule on `policy === 'geo'`, or make it policy-aware.
- **Verification Test:** A deliberate `priority` route to a far region under an explicit priority order does not fire "ocean-crossing."

---

### [ISSUE-063]: Two divergent firewall evaluators (source-blind vs source-aware)
- **Category:** Architecture / Security
- **Severity:** Minor
- **File(s) Affected:** `src/lib/world/network.ts` (10–22), `src/lib/analysis/rules/network.ts` (9–16)
- **Problem Description:** `evaluateFirewall` ignores `rule.source` entirely (first port/proto match wins), while callers of the analysis-side `firewallFirstMatch` read `.source`. The compiled permitted/blocked verdict never considers source, but the analysis layer does — two implementations of "which rule matches," easy to drift, a latent security-logic split.
- **Proposed Real-World Model / Fix:** Consolidate into one shared **source-aware** evaluator used by both compile and analysis.
- **Execution Steps for Developer Agent:**
  1. Extract a single `evaluateFirewall(source, port, proto, rules)` in `world/network.ts`.
  2. Have the analysis layer import it; delete the duplicate.
- **Verification Test:** A source-restricted allow rule is honored identically by compile verdicts and analysis findings.

---

### [ISSUE-064]: Firewall model is iptables/NACL first-match-with-default-deny but mislabeled vs AWS Security Groups
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/world/network.ts` (14–22), `src/lib/world/types.ts` (77–83)
- **Problem Description:** `FirewallRule.action: 'allow' | 'deny'` with first-match ordering is correct for iptables/NACLs but wrong for AWS Security Groups (a permissive union, no deny rules, no ordering). Users reasoning in SG terms get first-match semantics.
- **Proposed Real-World Model / Fix:** Document the model explicitly, or split into a SG-style (union-allow) mode vs NACL/iptables mode.
- **Execution Steps for Developer Agent:** Add a model-type flag or clear docs; optionally implement SG union semantics as an alternate evaluator.
- **Verification Test:** SG-mode rules behave as a permissive union; NACL-mode as ordered first-match.

---

### [ISSUE-065]: Cross-host container networking cannot be permitted except via host port publish
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/world/network.ts` (75–118)
- **Problem Description:** `sharedNetwork` requires `sameServer`; containers on different servers sharing an overlay/CNI network (Swarm, K8s) always fall through to host-port-mapping + firewall — blocking any multi-host orchestrator model.
- **Proposed Real-World Model / Fix:** Add an explicit overlay/CNI network concept spanning servers so co-networked containers on different hosts can communicate without host publishing.
- **Execution Steps for Developer Agent:** Extend the network model with a cross-host virtual network id; permit intra-network paths regardless of `sameServer`.
- **Verification Test:** Two containers on different servers in the same overlay network get a permitted path without host port mapping.

---

### [ISSUE-066]: `ram-oversubscribed` ignores per-connection RAM growth
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/analysis/rules/capacity.ts` (9–42), `src/lib/world/types.ts` (138)
- **Problem Description:** `reservedRamMb` sums `memLimitMb ?? ramBaseMb`; `WorkloadProfile.ramPerConnMb` (load-dependent RAM) is never counted, so the rule under-reports RAM pressure under load → OOM false negatives.
- **Proposed Real-World Model / Fix:** Include `ramPerConnMb × activeConnections` (from live metrics) in the reservation/usage estimate.
- **Execution Steps for Developer Agent:** Add the per-connection term using the latest batch's connection counts.
- **Verification Test:** A service with high `ramPerConnMb` under load trips `ram-oversubscribed`.

---

### [ISSUE-067]: `burstable-sustained-load` threshold hardcoded at 40%, ignoring per-instance baseline
- **Category:** Real-World Fidelity
- **Severity:** Minor
- **File(s) Affected:** `src/lib/analysis/rules/capacity.ts` (54), `src/lib/world/instanceCatalog.ts`
- **Problem Description:** `if (mean <= 0.4) continue` uses one constant; burstable baselines vary (t3.micro ~10%, t3.medium ~20%/vCPU). The catalog distinguishes burstable presets but the baseline isn't read, so the rule both over- and under-fires by instance size.
- **Proposed Real-World Model / Fix:** Read the per-instance baseline from the catalog and compare `mean` against it.
- **Execution Steps for Developer Agent:** Add a `baselineUtilization` to burstable catalog entries; use it in the rule.
- **Verification Test:** A t3.micro at 15% sustained trips the rule; a t3.large at 15% may not (different baseline).

---

### [ISSUE-068]: `db-port-exposed` (b) flags any db-target blueprint with a public port, even unplaced
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/analysis/rules/network.ts` (84–98)
- **Problem Description:** Sub-rule (b) iterates `dbTargets` from blueprint dependencies and flags a public port regardless of whether the blueprint is placed anywhere; a never-deployed blueprint yields a "critical" exposure finding, unlike sub-rule (a) which walks placed instances.
- **Proposed Real-World Model / Fix:** Only flag blueprints that are actually placed (have ≥1 compiled instance).
- **Execution Steps for Developer Agent:** Gate sub-rule (b) on placement (`instancesByBlueprint[bp].length > 0`).
- **Verification Test:** An unplaced DB blueprint with a public port produces no finding; placing it produces one.

---

### [ISSUE-069]: `deserializeWorld` mutates the parsed input object in place
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/serializer.ts` (78–100)
- **Problem Description:** `result === data`, and it writes `result.world.racks ??= {}`, `server.rack = null`, etc. onto the just-parsed JSON — harmless today but a purity violation for a boundary and surprising if the caller retains `data`.
- **Proposed Real-World Model / Fix:** Build a new normalized object rather than mutating the input (spread + fill defaults).
- **Execution Steps for Developer Agent:** Clone/spread before normalizing; never write onto `data`.
- **Verification Test:** After deserialization the original parsed `data` is unmodified.

---

### [ISSUE-070]: Numeric `version` field is rejected
- **Category:** Bug
- **Severity:** Minor
- **File(s) Affected:** `src/lib/serializer.ts` (49–59)
- **Problem Description:** The gate compares against string `'1'`/`'2'`/`'3'`; a file with `"version": 3` (number) fails all and throws "Unsupported scalemap version: 3." Own files round-trip (strings), but externally-authored files are brittle.
- **Proposed Real-World Model / Fix:** Coerce `String(data.version)` before comparison.
- **Execution Steps for Developer Agent:** Normalize `version` to a string at the top of the gate.
- **Verification Test:** A file with numeric `version: 3` loads; `version: 2` (number or string) is still rejected with the v2 message.

---

### [ISSUE-071]: Cost model reads raw `WorldDoc`, bypassing the compiled gate
- **Category:** Architecture
- **Severity:** Minor
- **File(s) Affected:** `src/lib/costModelV2.ts` (129–158)
- **Problem Description:** `computeWorldCost` iterates `doc.servers`/`doc.managedServices`/`doc.loadBalancers` directly rather than `CompiledWorld`. Billing off the raw doc is mostly defensible (you pay for a running box even if unused), but it's why ISSUE-024's orphaned-AZ inconsistency exists here — it re-walks the doc instead of consuming compiled instances/paths.
- **Proposed Real-World Model / Fix:** Where cost depends on placement/routing (egress, orphan handling), consume `CompiledWorld`; keep flat provisioned costs off the doc but reconcile totals (ISSUE-024).
- **Execution Steps for Developer Agent:** Pass `compiled` into `computeWorldCost` and use it for placement-derived costs and orphan detection.
- **Verification Test:** Cost totals reconcile with compiled instances; orphan case handled per ISSUE-024.

---

### [ISSUE-072]: Duplicated "blocked path" findings across compile and analysis
- **Category:** Architecture
- **Severity:** Minor
- **File(s) Affected:** `src/lib/world/compileWorld.ts` (83–91), `src/lib/analysis/rules/network.ts` (22–52)
- **Problem Description:** The compile pass emits `blocked-path` and the analysis pass emits `blocked-dependency-path` for the same blocked `CompiledPath`; dedup is handled in "some other layer" (the Analysis tab suppressor), a cross-layer coupling that can surface duplicates if the suppressor isn't applied. The firewall logic is also duplicated (ISSUE-063).
- **Proposed Real-World Model / Fix:** Make the analysis rule the single owner, or make the suppression explicit/tested so the two can't drift.
- **Execution Steps for Developer Agent:** Centralize the blocked-path finding (one emitter) or add a test asserting the suppressor removes the compile-side duplicate.
- **Verification Test:** A blocked path yields exactly one finding in the merged Analysis view.

---

### [ISSUE-073]: `addDownstream` is O(rows) linear scan → O(rows²) aggregation per instance
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (271–288)
- **Problem Description:** Every downstream contribution does `f.downstream.find(...)` over the growing array; for fan-heavy instances this is quadratic per tick.
- **Proposed Real-World Model / Fix:** Key rows in a `Map<string, DownstreamFlow>` by `(dependencyId|target|blocked|failure)`; materialize to an array once.
- **Execution Steps for Developer Agent:** Replace the `find`-based aggregation with a map keyed by the composite; convert to array at the end.
- **Verification Test:** Output rows identical; per-tick cost for high-fan instances drops from quadratic to linear.

---

### [ISSUE-074]: `new Set(item.visited)` cloned on every edge traversal
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (415–417)
- **Problem Description:** A fresh visited-Set is allocated for each pushed BFS queue item; at ~2000 instances with fan-out this is heavy per-tick GC pressure against the ~4 ms budget.
- **Proposed Real-World Model / Fix:** Carry a path-depth + parent-pointer chain, or a reusable visited encoding (e.g. a generation-stamped array), instead of cloning a Set per edge.
- **Execution Steps for Developer Agent:** Replace per-item Set clones with a shared visited structure reset per BFS root.
- **Verification Test:** Traversal results identical; allocation/GC per tick materially reduced (profiler).

---

### [ISSUE-075]: `pathsByFromDep` index rebuilt every tick from static `compiled.paths`
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (231–241)
- **Problem Description:** The `Map<from, Map<dep, paths[]>>` is reconstructed each `solveFlows` call even though `compiled.paths` never changes during a run.
- **Proposed Real-World Model / Fix:** Memoize on `compiled` identity (build once at `start()`).
- **Execution Steps for Developer Agent:** Cache the index in engine `state`, keyed by `compiled`; rebuild only if `compiled` changes.
- **Verification Test:** The index builds once per run, not once per tick.

---

### [ISSUE-076]: `groupInstancesByServer` rebuilt every tick
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (309)
- **Problem Description:** A full O(instances) Map rebuild each step for the static `compiled`.
- **Proposed Real-World Model / Fix:** Build once at `start()` and reuse.
- **Execution Steps for Developer Agent:** Cache `instancesByServer` in `state` at `start()`.
- **Verification Test:** The grouping builds once per run.

---

### [ISSUE-077]: `splitDependencyShares` allocates several arrays per dependency per instance per tick
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/flows.ts` (85–104)
- **Problem Description:** `isPrimary`, a `filter`, and multiple `map` closures allocate for every DB dependency of every active instance every tick.
- **Proposed Real-World Model / Fix:** Precompute role classification per candidate group once (roles are static under a run) and compute shares without intermediate arrays.
- **Execution Steps for Developer Agent:** Hoist role/primary classification to `start()`-time; compute shares in a single pass.
- **Verification Test:** Shares identical; per-tick allocation reduced.

---

### [ISSUE-078]: `entryBlueprintIds.includes(...)` inside 60 FPS render loops
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (656, 689)
- **Problem Description:** `Array.includes` (O(k)) inside the per-flow loop in `buildAzParticles` and `buildServerParticles`, which run every animation frame (~60 FPS).
- **Proposed Real-World Model / Fix:** Use a `Set<BlueprintId>` built once.
- **Execution Steps for Developer Agent:** Precompute `entryBlueprintIdSet` at `start()`; replace `.includes` with `.has`.
- **Verification Test:** Particle output identical; render-loop lookup is O(1).

---

### [ISSUE-079]: `effectiveRoleResolver` and `managedDbRuntime` recomputed every step
- **Category:** Performance
- **Severity:** Minor
- **File(s) Affected:** `src/lib/worldEngine/index.ts` (364, 370), `src/lib/worldEngine/failover.ts` (233, 239–241)
- **Problem Description:** Both are rebuilt per tick. `effectiveRoleResolver` has a fast path when `promotedAt` is empty, but after any promotion it rescans all instances every step; `managedDbRuntime(prevFlows, …)` scans prevFlows each tick.
- **Proposed Real-World Model / Fix:** Cache where inputs are unchanged — recompute `effectiveRoleResolver` only when `promotedAt` changes; incrementally update managed runtime.
- **Execution Steps for Developer Agent:**
  1. Memoize `effectiveRoleResolver` keyed on the `promotedAt` version.
  2. Update `managedDbRuntime` incrementally from the delta rather than a full rescan.
- **Verification Test:** With no promotion, the resolver isn't recomputed; results identical.

---

## Cross-cutting notes for the execution agent

- **Compounding fixes:** ISSUE-013 (queue model) is the highest-leverage change — it naturally
  subsumes ISSUE-014 (snap-to-zero), ISSUE-016 (oscillation), and part of ISSUE-018/-043.
  ISSUE-001 and ISSUE-006 must be fixed together (a breaker is only useful once fan-out stops
  feeding dead nodes). Sequence: 006 → 001 → 015, then 013.
- **Determinism guardrail:** every stochastic change (ISSUE-017 Poisson demand, ISSUE-040
  weighted tracing) MUST draw from the seeded `rng` so replays stay reproducible.
- **Contract discipline:** ISSUE-021 requires an **additive** extension to `CompiledWorld` /
  the engine render contract — log it in `.superpowers/sdd/contract-drift.md` per the
  frozen-contract rule; never reshape existing fields.
- **Performance budget:** the sim step budget is ~4 ms/step at 10 Hz and 60 FPS render; verify
  ISSUE-027/-032/-073/-074 against a large world (the code cites ~2,000 instances / 216
  servers) before and after.
- **Things already correct (do not "fix"):** div-by-zero guards (`safeEffectiveVcpu`,
  `Math.max(1, steps)`, `EPSILON_RPS`), seeded-RNG determinism discipline, the recovery-
  deadlock handling (`probeInstant`/`probePrev`/down-instance skip), `egressMonthlyCost`
  tiering, `managedDbRuntimeFor` guards, `rackModel` capacity math, and `greatCircleKm`.
- **Docs:** after implementing, update `docs/module-boundaries.md` per the project rule.
