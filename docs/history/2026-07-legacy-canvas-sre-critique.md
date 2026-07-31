> **Historical document — does not describe the current codebase.**
> This critique audits the legacy React-Flow canvas app (`particleEngine.ts` and siblings),
> deleted wholesale in the Phase 2 rebuild (2026-07-08). None of the files or symbols it
> references exist today. Retained for design-rationale history only.
> For the current engine, see `docs/agent-onboarding.md` and `audit-spec.md`.

# SRE Critique — Scalemap Simulation Engine

**Reviewer role:** Senior Site Reliability Engineer
**Scope:** Client-side traffic/simulation engine and its supporting models
**Primary artifacts audited:**
- `src/app/canvas/simulation/particleEngine.ts` (the rAF simulation core, ~2600 LOC)
- `src/app/simulation/defaults.ts` (`NODE_SIM_DEFAULTS`)
- `src/lib/costModel.ts`
- `src/lib/lint/rules.ts`
- `src/app/store/simulation.store.ts` (RPS resolution)

**Framing:** Scalemap is a *teaching/estimation* simulator, not a discrete-event or queueing-theoretic engine. Several findings below are inherent modeling simplifications — I've kept those in "Optimization Opportunity" rather than pretending they're production defects. The Critical/Warning items are places where the code either contradicts its own stated intent, produces a wrong-direction result, or can wedge the simulation into a stuck state.

Legend: 🔴 Critical · 🟠 Warning · 🔵 Optimization Opportunity

---

## 🔴 Critical

### C1. Circuit breakers on nodes *without* a `circuitBreaker` config can latch open forever
**Where:** `particleEngine.ts` — force-open on health `down` (`updateAllNodeMetrics`, ~L1934–1947); reset guards in `checkBreakerTransition` (`if (!cb) return 'closed'`, ~L683) and the periodic recovery scan (`if (!cb || …) continue`, ~L2072).

When a node's health goes `down`, the engine force-opens the breaker on every inbound **request** edge — unconditionally, regardless of whether that node type actually has a `circuitBreaker` config:

```ts
if (healthState === 'down') {
  for (const e of _edgesData.filter(ed => ed.target === nodeId)) {
    …
    const breaker = getBreaker(e.id)
    if (breaker.state !== 'open') { breaker.state = 'open'; breaker.openedAt = now; … }
  }
}
```

But **both** reset paths bail out when the *target's* `circuitBreaker` config is undefined. Per `defaults.ts`, many node types ship with **no** `circuitBreaker`: `loadBalancer`, `apiGateway`, `cdn`, `dns`, `firewall`, `vpn`, `objectStorage`, `fileStorage`, `redis`, `memcached`, `cdnCache`, and all queue types. For any of those, once it hits `down` (via `forcedHealthState`, genuine saturation, or a cascade), its inbound request edges open and can **never** transition back to half-open/closed. Because `spawnParticles` sets `downstreamFactor = 0` on open request circuits, traffic to that node is permanently suppressed even after it fully recovers.

**Repro:** Force a Redis/object-storage node to `down` (or saturate it), then let it recover. Upstream callers never resume calling it — the edge stays dark for the rest of the run.

**Recommendation:** Force-open should only apply where a breaker semantically exists, *or* the reset paths must be able to close a breaker that was force-opened. Simplest fix: in both reset locations, if `cb` is undefined but `breaker.state === 'open'`, close it (or transition to half-open) once the target is no longer `down`. Better: never force-open a breaker for a node type that has no breaker config — drop such particles on arrival instead (that path already exists via the `down` hard-gate at ~L1120).

---

### C2. Resource-release timers (`setTimeout`) are wall-clock based and are never cancelled — they leak across pause, speed changes, *and simulation restarts*
**Where:** `trackRequest` (~L732), connection-pool release (~L1190), lambda concurrency release (~L1285), thread-pool worker release (~L1293, L1348, L1384).

Every concurrency/pool counter is decremented by a `setTimeout` scheduled off `performance.now()` and divided by `_speed`:

```ts
setTimeout(() => {
  _activeWorkers.set(sourceNodeId, Math.max(0, (_activeWorkers.get(sourceNodeId) ?? 1) - 1))
}, (sampledLatency + ep.geoLatencyMs) / _speed)
```

Three distinct stability problems fall out of this:

1. **Pause is ignored.** The rAF loop stops advancing simulation state when `paused`, but these timers keep firing on the wall clock. Pause the sim mid-load and every `_activeWorkers` / `_activeConnections` / `nodeConcurrency` / `_lbActiveRequests` counter drains to zero while no new work is admitted. On resume, occupancy is understated and thread-pool/pool-exhaustion behavior is wrong.
2. **Mid-flight speed changes don't rescale.** A worker acquired at 1× and scheduled to release in 5 s stays on that schedule even if the user jumps to 8×; the release is now 8× too late in simulation time.
3. **Cross-run contamination (the dangerous one).** `startSimulation`/`stopSimulation` clear all the maps but **do not cancel pending timeouts**. A release scheduled during run A fires during run B and decrements run B's counters for any node id that exists in both diagrams — silently corrupting concurrency accounting in a fresh simulation.

**Recommendation:** Model these releases in *simulation time*, not wall-clock. Maintain a small "scheduled release" min-heap keyed on `_simulatedTimeMs` and drain it inside the frame loop (like `_retryQueue` already does). That automatically makes releases pause-proof, speed-correct, and wiped on restart. If you must keep `setTimeout`, at minimum track the timer ids and `clearTimeout` them in `stopSimulation`/`startSimulation`.

---

### C3. Particle sampler saturates at 500, freezing analytical metrics under high load
**Where:** `spawnParticles` early-return (~L742–745) and per-edge `effectiveRps` assignment (~L850–851); `MAX_PARTICLES = 500` (~L740).

`spawnParticles` bails at the very top when the global particle count hits the cap:

```ts
let total = 0
for (const arr of state.particles.values()) total += arr.length
if (total >= MAX_PARTICLES) return
```

The problem is that `ep.effectiveRps` — the number the entire metrics layer reads for `inRps`/`outRps`/`utilization`/queue-depth integration — is only written *inside* this function (L851). When the cap is hit, the function returns before touching any edge, so **`effectiveRps` freezes at its last pre-saturation value**. Under sustained high concurrency (exactly the "does it hold up under high-demand loads" question), the simulation flatlines: utilization stops climbing, saturation events stop firing, and the queue-depth integrator keeps integrating on a stale rate. The system looks *healthier* the more you overload it.

There's a second, structural half to this: metrics are driven by the **analytical** `effectiveRps`, while saturation drops, DB read/write util, and latency are driven by **actual particle arrivals** (downsampled 10:1 and capped at 500). These two sources of truth diverge sharply once the cap engages, so the numbers on the nodes and the behavior of the nodes stop agreeing.

**Recommendation:** Decouple rate bookkeeping from particle minting. Compute and store `ep.effectiveRps` for every edge *before* the cap check (it's cheap and purely numeric), and only gate the visual particle *spawn* on `MAX_PARTICLES`. That keeps metrics correct at any load while bounding render cost. Consider scaling `PARTICLE_REQUEST_RATIO` dynamically with total offered load so the visual layer degrades gracefully instead of clipping.

---

## 🟠 Warning

### W1. Thread-pool worker accounting over-releases (acquire is clamped, release is not)
**Where:** acquire (~L860–868), release sites (~L935, L982, L1294, L1350, L1386).

Acquisition clamps to the pool ceiling but adds the full spawn batch:

```ts
_activeWorkers.set(sourceNodeId, Math.min(maxThreads, active + n))   // clamped
```

Each spawned particle later releases exactly one worker (`Math.max(0, … - 1)`). When `active + n` exceeds `maxThreads`, fewer than `n` slots are actually acquired, but all `n` particles still release — driving `_activeWorkers` below the true occupancy and defeating the pool cap. Compounding this: if the per-particle mint loop hits `MAX_PARTICLES` mid-batch (`for (let i = 0; i < n && total < MAX_PARTICLES; i++)`, ~L885), workers were acquired for particles that were never minted and thus never release — a slow **leak in the opposite direction** that only clears on restart. The two bugs partially mask each other, which makes thread-pool exhaustion behavior unpredictable.

**Recommendation:** Acquire exactly what you mint. Move the `_activeWorkers` increment inside the mint loop (increment by 1 per actually-created particle, after the cap check), and reject the overflow explicitly (the 503/`spawnErrorFlash` path already exists).

### W2. `effectiveMultiplier(now)` has side effects but is called many times per frame
**Where:** definition mutates chaos/spike state (~L582–630); called in `spawnParticles` (L747), **per particle arrival** in `handleParticleArrival` (L1111), and in `updateAllNodeMetrics` (L1534).

`effectiveMultiplier` isn't a pure getter — in `chaos`/`spike` modes it advances `_spikeEndAt`/`_spikeNextAt`, rolls new chaos victims, and emits `chaos_failure`/`chaos_recovery` events. It's then invoked once **per particle arrival** (to compute glow RPS), i.e. potentially hundreds of times per frame with the same `now`. The internal "next-fire" gates mostly make this idempotent within a frame, but the design is fragile: any future change to the gating, or a mode whose schedule isn't self-advancing, will double-fire failures/events. Chaos scheduling should not be a side effect of drawing a glow.

**Recommendation:** Split into a pure `trafficMultiplier(now)` (no state writes) used everywhere, and a `advanceChaosSchedule(now)` called exactly once per frame from `loop()`.

### W3. Queues are numeric integrators fully decoupled from the particles that "fill" them
**Where:** arrival handler for queue targets does nothing after the overflow check (~L1207–1223, no `forwardToOutbound`); consumer edges spawn independently in `spawnParticles`; depth integrated in `updateAllNodeMetrics` (~L1582–1595).

A producer→queue particle is consumed on arrival and disappears. The queue→consumer edge spawns its *own* particles at its configured RPS, and the queue's depth is a separate `(inRps − outRps)·dt` integrator. Consequences:
- A queue with **no producers** still emits consumer-side traffic at its configured RPS (queue source types are inbound-gate-exempt), i.e. "messages from nothing."
- Delivery guarantees are cosmetic: `deliveryMode` (`at-least-once`/`exactly-once`) exists on templates but only surfaces in the inspector (`buildSnapshot`, ~L2338) — the engine never dedups, never redelivers differently, and never ties consumer output to actual enqueued depth.

**Recommendation:** At minimum, gate consumer-edge spawn on `queueDepth > 0` so an empty queue produces no downstream traffic. For a fuller model, drive consumer emission from drained depth rather than a free-running configured RPS.

### W4. Stall pressure is folded into utilization, which then feeds the health score — a partial double-count
**Where:** `utilization = min(1, utilization + stallPressure*0.3)` (~L1810); health score consumes utilization (~L1907–1911); error rate separately consumes `cascadePressure` (~L1866).

Downstream stall raises a node's utilization, and utilization drives the health `utilPenalty`. Meanwhile upstream/cascade pressure independently raises the error rate, which drives `errorContrib`. A single downstream failure therefore pushes both terms, and the "cause" is attributed twice through two different channels. The engine is careful to use `rawUtilization` (pre-stall) for the *bottleneck* threshold (good, L1809/L1986), but the *health* path uses the stall-inflated value. Cascades will read as more severe than the underlying signal warrants.

**Recommendation:** Decide whether stall manifests as latency/error or as utilization, and use one channel for health scoring. If you keep both, subtract the overlap or use `rawUtilization` for the health `utilPenalty` too.

### W5. Retries bypass all spawn-time gating
**Where:** `processRetryQueue` mints directly into `state.particles` (~L2110–2120); `dropParticle` enqueues (~L1035).

Retry re-spawns push particles straight onto their edge, skipping every guard `spawnParticles` applies: circuit-open suppression, thread-pool acquisition, queue/stream backpressure, and the down/chaos `downstreamFactor`. A retry can therefore be launched onto an edge whose circuit has since opened, or into a node whose thread pool is exhausted, without accounting for it. This under-models the very "retry storm amplifies an outage" dynamic the retry-storm detector (L2082) is trying to showcase — the retries don't feel backpressure on the way in.

**Recommendation:** Route retry re-spawns through the same admission checks as fresh spawns (or at least the circuit-open and thread-pool gates).

### W6. `deepSyncChain` measures the *shortest* path, not the longest — under-reports deep chains
**Where:** `rules.ts` (~L261–271), BFS with `if ((seen.get(target) ?? Infinity) <= newDepth) continue`.

A FIFO BFS records the *minimum* hop count to reach each node. The rule's intent is to flag long synchronous critical paths (latency ceilings), which is a **longest-path** property. In any diamond/mesh where a node is reachable both by a short and a long sync path, the rule reports the short one — and if that's `< 5`, the deep chain is never flagged at all. This is a false-negative in a correctness linter.

**Recommendation:** Compute longest sync path via DFS over the DAG (or topological longest-path). Guard against cycles (which `circularDependency` already detects) so the longest-path pass terminates.

### W7. `circularDependency` counts async edges, contradicting its own remediation advice
**Where:** `rules.ts` `detectCycles` traverses `ctx.outEdges` with no edge-type filter (~L160); recommendation text says "introduce an event/queue edge" (L185).

The cycle detector walks *all* edges, including `event`/`stream` edges that are precisely the asynchronous decoupling the fix recommends. A service graph already broken by an event bus will still be flagged as a circular dependency, telling the user to add the thing they already have.

**Recommendation:** Restrict cycle traversal to synchronous edge types (`request`/`dependency`), matching `deepSyncChain`'s adjacency construction.

---

## 🔵 Optimization Opportunity

### O1. No network partition or packet-loss model
Chaos fails **nodes**, never **links**. There is no way to sever an edge (or a region-to-region path) while leaving both endpoints healthy — i.e. no partition. Drops are always deterministic consequences of capacity/health/circuit state; there is no stochastic per-hop loss. For an infra simulator that advertises "network partitions" as a concern, this is the biggest realism gap.
**Recommendation:** Add an edge-level chaos mode (link down / probabilistic loss) and a "partition" primitive that classifies edges by region and can isolate a region set. This also unlocks meaningful CAP demonstrations (see O2).

### O2. No consensus / replication / quorum — CAP trade-offs are unmodeled
Databases are single capacity buckets. There is no replication lag, no leader election, no quorum read/write, no split-brain, and no consistency-vs-availability choice under partition. `isWAL` adds a fixed latency but carries no durability/consistency semantics; multi-region DBs don't replicate. As-is, the simulator cannot express any CAP-theorem behavior.
**Recommendation:** If state-consistency fidelity matters, model DB nodes as replica sets with a configurable consistency level (e.g. `ONE`/`QUORUM`/`ALL`), a replication-lag parameter, and partition-aware read/write availability. This pairs directly with O1's partition primitive.

### O3. Saturation latency is capped at ~4×; real queueing tail is unbounded near ρ→1
**Where:** `cpuFactor` (~L1817–1819), `utilization = inRps/maxRps` linear.
Latency amplification is `1 + ((util−0.7)/0.3)²·3`, i.e. at most 4× at 100% utilization, and only for compute types. Real systems follow ~`1/(1−ρ)` (M/M/1) — latency should blow up hyperbolically as utilization approaches 1, not plateau at 4×. Nodes near saturation therefore look far calmer than they'd be in production, and DBs/queues get no amplification at all.
**Recommendation:** Replace the capped polynomial with a queueing-theoretic multiplier (clamped for numerical safety, e.g. `1/(1 − min(util, 0.99))`) and apply it to storage/messaging nodes too. This is also what makes the "high-concurrency" story convincing.

### O4. Geographic latency is a fixed constant per region pair — no jitter or variance
`interRegionLatencyMs` and `origin.baseLatencyMs` are deterministic per pair. Server *processing* latency is nicely modeled as log-normal (`sampleLatencyMs`), but the *network* component has zero variance, so tail latency is entirely processing-driven. Real WAN links have meaningful jitter and occasional spikes.
**Recommendation:** Sample the geo component with a small jitter distribution; optionally couple jitter magnitude to the (future) link-congestion state.

### O5. Egress bytes are billed at spawn regardless of delivery
**Where:** `spawnParticles` (~L909) attributes `payloadBytes` to the target at mint time; the particle may later be dropped, time out, or hit an open circuit.
Cost is charged for responses that never complete, so `costModel` over-bills failing systems. Combined with C3's cap, egress is simultaneously over-counted (failed requests) and under-counted (clipped particles under load) — the net error is unpredictable under stress.
**Recommendation:** Attribute egress bytes on successful *arrival/response*, not on spawn.

### O6. Minor consistency nit: read/write particle classification uses two different moduli
**Where:** `isReadParticle` uses `id % 100` (~L461); `buildSnapshot` comments that it "mirrors the `seed = p.id % 97` pattern" and uses `% 97` (~L2325).
These don't actually mirror each other, so the read/write lane a particle is charged to can disagree with the method the inspector displays for the same particle. Cosmetic, but confusing when debugging DB read/write splits.
**Recommendation:** Share one helper/modulus for both the latency-lane decision and the inspector label.

---

## Summary Table

| ID | Severity | Area | One-line |
|----|----------|------|----------|
| C1 | 🔴 | Circuit breaking | Force-opened breakers on config-less node types never reset → traffic permanently suppressed |
| C2 | 🔴 | Resource contention / stability | `setTimeout` releases ignore pause/speed and leak across runs, corrupting concurrency counters |
| C3 | 🔴 | Resource contention | 500-particle cap freezes `effectiveRps`, flatlining metrics under high load |
| W1 | 🟠 | Resource contention | Thread-pool acquire clamped but release unclamped → over-release + leak on cap |
| W2 | 🟠 | Determinism | Side-effectful `effectiveMultiplier` called per-arrival |
| W3 | 🟠 | State consistency | Queues decoupled from particles; delivery guarantees cosmetic |
| W4 | 🟠 | Health scoring | Stall pressure double-counted through utilization + error rate |
| W5 | 🟠 | Circuit breaking / backpressure | Retries bypass circuit/thread/backpressure gating |
| W6 | 🟠 | Linter correctness | `deepSyncChain` reports shortest, not longest, sync path |
| W7 | 🟠 | Linter correctness | `circularDependency` flags async-decoupled cycles |
| O1 | 🔵 | Network realism | No link partition or packet-loss model |
| O2 | 🔵 | State consistency | No consensus/replication/quorum (no CAP behavior) |
| O3 | 🔵 | Resource contention | Saturation latency capped at 4× vs unbounded queueing tail |
| O4 | 🔵 | Network realism | Geo latency deterministic; no jitter |
| O5 | 🔵 | Cost fidelity | Egress billed at spawn regardless of delivery |
| O6 | 🔵 | Consistency nit | Read/write modulus mismatch (`%100` vs `%97`) |

**Top three to fix first:** C1 (silent permanent outage of recovered nodes), C2 (cross-run counter corruption + pause incorrectness), C3 (the engine gets *less* alarming as load increases — the single most misleading behavior for the tool's core purpose).
