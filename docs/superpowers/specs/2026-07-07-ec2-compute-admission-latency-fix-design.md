# EC2 Compute Model — Admission, Latency & Thread-Pool Fix — Design

Addresses GitHub issues **#19** (latency doesn't scale with CPU saturation),
**#21** (dual isolated thread pools, critical), and **#22** (event-loop and
threaded models share the same admission gate) as one combined design, since
all three touch the same admission/hold-time code path in `compute.ts` and
`particleEngine.ts` and would conflict if patched independently. **#20**
(RAM limit behaves as a load shedder instead of causing dynamic OOMs) is
folded in rather than given its own work item — see Decisions below.

`docs/superpowers/plans/2026-07-07-ec2-compute-resource-model.md` (the
original compute-model plan) and the shipped code it produced are the
starting point; this spec is a follow-up fix, not a rewrite.

## Problem

### #19 — Latency is static, never reflects real-time CPU pressure

`trackRequest` (`particleEngine.ts:725-739`) holds an EC2 node's thread-pool
slot for `wallTimeMs(baseLatencyMs, workload, profile)`
(`particleEngine/compute.ts:64-66`), which is `baseLatencyMs +
cpuTimeSec(w,p)*1000` — a pure function of the node's static hardware/workload
config, with **no dependence on how loaded the node currently is**. A request
processed at 20% CPU utilization is held for exactly as long as one processed
at 95%.

Separately, `updateAllNodeMetrics` (`particleEngine.ts:2122-2134`) already
computes a real queueing-theoretic multiplier —
`saturationLatencyMultiplier(rho) = 1/(1-rho)` — but applies it **only to the
reported p50/p75/p90/p99 percentiles shown in the UI**, never to the actual
scheduled hold time. So today's "hockey-stick" latency graph is a display
artifact: it never slows down real thread occupancy, never causes the
pool to drain slower, never cascades into `_lbActiveRequests` pressure. The
only thing that currently amplifies *real* hold time is the coarse,
discrete `effectiveProcessingMs` degraded-health step (1×–2×, only once
health has already crossed into `'degraded'`) — exactly what the issue
calls "a coarse, discrete health state step function."

### #21 — Two independent, unrelated thread pools for the same physical node (critical)

An ec2/container node participates in **two disconnected concurrency
models** today:

- **Server-side** (as a request *target*): `_lbActiveRequests`
  (`particleEngine.ts:423`), incremented by `trackRequest` on arrival,
  gated by `hardThreadCap`/`computeMaxThreads` — the RAM-derived physical
  thread cap.
- **Caller-side** (as a request *source*, when it's the source of a
  `THREAD_POOL_TYPES` request edge — `particleEngine.ts:723`,
  `{ec2, container, pod, k8sCluster, ecsCluster}`): `_activeWorkers`
  (`particleEngine/backpressure.ts:19`), acquired via `acquireWorkers`
  (`particleEngine.ts:966-969, 1002-1009`), capped at
  `effectiveConfig(sourceNodeId,...).maxConcurrency ?? 200` — an arbitrary
  default totally unrelated to the node's actual RAM-derived capacity.

For ec2/container these are **the same physical threads**, modeled as two
separate pools with two unrelated caps. A node making 150 concurrent
downstream calls (well under its caller-side 200 default) shows zero effect
on its own server-side `_lbActiveRequests`/`hardThreadCap` gate, even though
in reality those 150 blocked threads are *not available* to accept new
inbound work — the two pools' caps were "decoupled" (the issue's word)
instead of describing one resource.

### #22 — Non-blocking (event-loop) servers gated identically to blocking (thread-per-request) servers

`ComputeProfile.blockingIoModel` (`nodeConfig.ts:175-176`) already
distinguishes thread-per-request (`true`) from async/event-loop (`false`)
servers, and `perRequestMemMb` already drops the thread-stack term for
non-blocking (`compute.ts:14-17`) — but `ec2AdmissionDecision`
(`compute.ts:78-84`) applies the exact same binary
`activeRequests >= hardThreadCap → drop-503` gate to both. A real
event-loop server (Node.js/nginx-style) has no OS-thread-per-connection
limit; it queues connections (socket backlog / event-loop lag) and
degrades progressively, only failing once it genuinely runs out of memory
or file descriptors — a fundamentally different failure shape than a
blocking server hitting a hard pool ceiling.

### #20 — RAM limit only sheds load, never crashes (folded into #22's fix, see Decisions)

`ec2AdmissionDecision` only returns `'oom-crash'` when
`maxThreadsMem(w,p) <= 0` — a static, config-only condition (the box
can't fit even one request's footprint) that load never triggers, since
`hardThreadCap` is defined as `Math.min(maxThreadsOverride, maxThreadsMem)`
— structurally always ≤ the memory-safe ceiling. This was a **deliberate**
change (commit `3257dae`, "graceful EC2 overload (503 not crash)") made
after the original compute-model plan shipped, to avoid disruptive crashes
during normal exploration. Issue #20 asks to reverse this; see Decisions
for why this spec doesn't do that wholesale.

## Decisions (confirmed with user)

1. **Keep graceful 503-shedding as the default behavior for blocking
   (thread-per-request) servers.** Do not revert the deliberate `3257dae`
   change. A default-configured blocking EC2 node still never crashes from
   load alone — `hardThreadCap` stays structurally ≤ `maxThreadsMem`.
2. **Add genuine dynamic OOM as a secondary, narrower failure mode**,
   scoped to exactly two well-justified cases rather than replacing
   shedding outright:
   - **Non-blocking (event-loop) servers always** (#22's fix, below) — an
     event-loop server has no thread-count gate to shed load at in the
     first place, so unbounded backlog growth genuinely is its primary
     overload failure mode; OOM is the *correct* default here, not an
     edge case.
   - **Blocking servers only when the user explicitly opts in** via a new
     `ComputeProfile.allowMemoryOvercommit?: boolean` flag (default
     `false`/absent = today's safe behavior unchanged). When `true`, an
     explicit `maxThreadsOverride` is allowed to exceed the memory-safe
     ceiling instead of being clamped to it — deliberately modeling a
     misconfigured pool size (e.g. a Tomcat `maxThreads` set too high for
     the box's RAM), which can then genuinely OOM under sustained load.
     This is opt-in, rare-by-construction, and directly matches the
     "config flag" option raised when this decision was discussed.
3. **#21's unification is a deliberate, conservative simplification, not
   full request-causal tracking.** This is a flow-rate simulation (not a
   per-request causal graph — an explicit standing constraint from the
   codebase's own engineering philosophy, reaffirmed in
   `2026-07-03-circuit-breaker-metrics-semantic-fix-design.md`'s Decision
   1). A fully causally-accurate fix — "this specific outbound call is
   nested inside this specific inbound request's already-held slot" —
   would require tracking per-request call chains, which this spec does
   not add. Instead: for ec2/container specifically, an outbound call
   acquires a slot in the *same* `_lbActiveRequests` counter against the
   *same* `hardThreadCap`/`computeMaxThreads` cap that inbound admission
   already uses (via the existing `trackRequest` machinery), rather than
   a second, independent, arbitrarily-capped pool. In the sub-case where
   an outbound call is causally nested inside an already-counted inbound
   request, this slightly **over-counts** occupancy (a request already
   holding 1 slot that also makes 1 outbound call reads as 2 slots
   instead of the "true" 1) — a deliberate, conservative bias: it makes a
   node appear to run out of capacity *sooner* under fan-out load, never
   later, which is the safer direction for a capacity-planning tool to
   err in. `pod`/`k8sCluster`/`ecsCluster` (which have no server-side
   compute model to unify against) keep today's independent
   `_activeWorkers`/`maxConcurrency ?? 200` caller-side pool unchanged.

## Work Items

### WI-A — Real, live CPU-saturation-driven hold time (#19)

**Files:** `particleEngine/compute.ts`, `particleEngine.ts`

- Move `saturationLatencyMultiplier(rawUtilization): number` (currently
  `particleEngine.ts:341-350`, formula `1/(1-min(rho,0.99))`) into
  `compute.ts`, exported from there. Update `particleEngine.ts`'s existing
  display-percentile call site (`:2125`, `cpuFactor = ...`) to import it
  from `compute.ts` instead of defining it locally — pure code motion, this
  call site's behavior is unchanged. Rationale: `compute.ts` is this
  codebase's designated home for pure queueing/resource math (see its own
  file-header comment); `wallTimeMs` needs the same formula and must stay a
  pure function, so the formula belongs in the pure module, not the engine.
- Change `wallTimeMs`'s signature to accept live utilization:
  ```ts
  export function wallTimeMs(baseLatencyMs: number, w: WorkloadDemand, p: ComputeProfile, rho: number): number {
    return Math.max(1, baseLatencyMs + cpuTimeSec(w, p) * 1000 * saturationLatencyMultiplier(rho))
  }
  ```
  Only the CPU-compute component is amplified — `baseLatencyMs` (the
  IO/base latency term) is left untouched, consistent with this file's
  existing documented convention that `ioBoundFraction` never reconstructs
  absolute IO time (`compute.ts:60-63`'s existing comment): CPU-scheduler
  contention slows CPU-bound work, not IO waiting.
- Update `trackRequest` (`particleEngine.ts:725-739`) to pass the node's
  current `rho` (via `cpuUtilization(inRps, workload, profile)`, already
  exported from `compute.ts`) using `_smoothedMetrics.get(nodeId)?.inRps ??
  0` — the same live-rate signal the idle-RPS gate and other call sites
  already treat as "current load."
- **No runaway-feedback risk**: `cpuUtilization` is a pure function of
  `inRps` (arrival rate), not of `_lbActiveRequests` (occupancy) — so
  making hold-time read `rho` does not feed back into `rho`'s own
  computation. It *does* legitimately raise `_lbActiveRequests` under
  sustained saturation (Little's Law: longer hold time at the same
  arrival rate ⇒ more concurrently-occupied slots), which can in turn
  push the RAM-derived `hardThreadCap` gate — an intended, realistic
  cascade (CPU saturation → slower processing → backlog → memory
  pressure → shedding), not a bug. Document this explicitly at the call
  site so a future reader doesn't "fix" it away.

### WI-B — Unify caller-side and server-side thread pools for ec2/container (#21)

**Files:** `particleEngine.ts` (spawn-side acquisition `:966-969, 1002-1009`)

- No new helper needed — `isTargetThreadPoolCompute` (`:709-711`) already
  identifies exactly the overlap set (ec2/container) that has both a
  server-side model to unify against and caller-side thread pooling via
  `THREAD_POOL_TYPES`; reuse it directly.
- In the per-particle acquisition currently calling `acquireWorkers`
  (`:1002-1009`), branch:
  ```ts
  if (isThreadPoolEdge) {
    let admitted: number
    if (isTargetThreadPoolCompute(ep.sourceNodeType!)) {
      // Unified pool: an outbound blocking call from an ec2/container node holds a slot in
      // that SAME node's own server-side thread pool (_lbActiveRequests/hardThreadCap),
      // reusing the existing trackRequest machinery -- not an independent, arbitrarily-capped
      // caller-side queue. See WI-B in the design spec for why this deliberately over-counts
      // (conservatively) rather than attempting full per-request causal tracking.
      const srcConfig = effectiveConfig(sourceNodeId!, ep.sourceNodeType as NodeType)
      const ec2res = ep.sourceNodeType === 'ec2' ? resolveEc2Resources(srcConfig) : null
      const cap = ec2res ? hardThreadCap(ec2res.workload, ec2res.profile) : computeMaxThreads(srcConfig)
      const active = _lbActiveRequests.get(sourceNodeId!) ?? 0
      if (active < cap) {
        trackRequest(sourceNodeId!, ep.sourceNodeType as NodeType, srcConfig)
        admitted = 1
      } else {
        admitted = 0
      }
    } else {
      admitted = acquireWorkers(sourceNodeId!, 1, maxThreads)
    }
    if (admitted === 0) {
      spawnErrorFlash(sourceNodeId!)
      _droppedCounts.set(sourceNodeId!, (_droppedCounts.get(sourceNodeId!) ?? 0) + 1)
      continue
    }
  }
  ```
  `maxThreads`/the existing `acquireWorkers` path is unchanged for
  `pod`/`k8sCluster`/`ecsCluster` (no server-side model to unify with —
  `isTargetThreadPoolCompute` is false for these).
- `trackRequest` already handles its own release scheduling (existing
  `scheduleGenericRelease` call at `:736-738`) using the *caller's own*
  `wallTimeMs` (post-WI-A, now rho-aware) — no separate release path
  needed for the unified case; the existing per-particle drop/reject path
  (`admitted === 0`) needs no release since nothing was acquired.
- **Expected, intended behavior change**: ec2/container nodes with heavy
  downstream fan-out will show measurably lower effective capacity than
  before, since outbound calls now count against the same pool inbound
  admission uses. This is the bug's actual fix, not a regression — the old
  independent 200-default pool let a node accept unlimited-up-to-200
  outbound calls with zero effect on its own admission gate, understating
  real contention. Call this out in the PR/task report so it isn't mistaken
  for a capacity regression during review.

### WI-C — IO-model-aware admission: non-blocking queues instead of dropping (#22, folds in #20's opt-in flag)

**Files:** `nodeConfig.ts` (`ComputeProfile`), `particleEngine/compute.ts`
(`ec2AdmissionDecision`)

- Add `allowMemoryOvercommit?: boolean` to `ComputeProfile`
  (`nodeConfig.ts:169-180`), documented as: "When true, `maxThreadsOverride`
  may exceed the memory-safe ceiling instead of being clamped to it —
  deliberately models an overcommitted pool that can genuinely OOM under
  load. Default/absent: today's safe behavior (cap always ≤ memory-safe)."
- Change `hardThreadCap` (`compute.ts:33-36`):
  ```ts
  export function hardThreadCap(w: WorkloadDemand, p: ComputeProfile): number {
    const mem = maxThreadsMem(w, p)
    if (p.maxThreadsOverride === undefined) return mem
    return p.allowMemoryOvercommit ? p.maxThreadsOverride : Math.min(p.maxThreadsOverride, mem)
  }
  ```
- Rewrite `ec2AdmissionDecision` to branch on `blockingIoModel`:
  ```ts
  export function ec2AdmissionDecision(
    activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
  ): Ec2Admission {
    if (p.blockingIoModel) {
      // Thread-per-request: memory-derived hard cap, graceful shedding by default (Decision 1).
      // Only reachable if the box can't hold even one footprint, OR the user explicitly opted
      // into overcommit (allowMemoryOvercommit) and load has genuinely exceeded physical RAM.
      if (currentRamMb(activeRequests, w, p) > p.ramGiB * 1024) return 'oom-crash'
      if (activeRequests >= hardThreadCap(w, p)) return 'drop-503'
      return 'admit'
    }
    // Non-blocking (event-loop): no thread-count gate -- admit and let the request queue
    // (socket backlog / event-loop lag), degrading via WI-A's real latency scaling as rho
    // climbs, same as a blocking server would show rising latency. The only hard failure is
    // genuinely running out of memory from the accumulated backlog -- this IS the primary
    // overload mode for an event-loop server, not a rare edge case (Decision 2).
    if (currentRamMb(activeRequests, w, p) > p.ramGiB * 1024) return 'oom-crash'
    return 'admit'
  }
  ```
  Note `currentRamMb(activeRequests, w, p) > p.ramGiB * 1024` (the original
  compute-model plan's dynamic-OOM formula, before `3257dae` narrowed it) is
  reintroduced, but now scoped exactly per Decision 2 — always live for
  non-blocking, only reachable for blocking via the new opt-in flag (since
  `hardThreadCap` stays ≤ `maxThreadsMem` unless `allowMemoryOvercommit` is
  set, which is the only way `activeRequests` can climb past the point
  where `currentRamMb` exceeds `ramGiB*1024` before `drop-503` would have
  already fired).
- Non-blocking nodes' `activeRequests` still needs *some* practical ceiling
  for the simulation loop to admit finitely-many particles per frame
  rather than an unbounded per-frame batch — reuse the existing global
  `MAX_PARTICLES` visual cap (`particleEngine.ts`) for this; no new
  per-node cap is needed since nothing in this WI removes that outer
  safety valve.

## Non-goals

- No per-request causal tracking / queueing network rewrite (Decision 3;
  reaffirms the flow-rate model constraint from the prior circuit-breaker
  metrics spec).
- No changes to `container`, `pod`, `lambda`, DB, queue, or network node
  types' capacity semantics — EC2-only, same scope boundary as the
  original compute-model plan.
- No changes to cost modeling (`computeResource` CostKind) — orthogonal to
  admission/latency/thread-pool behavior.
- Issue **#18** (move `WorkloadDemand` from node config to packet config)
  is explicitly out of scope for this spec — a separate, lower-priority
  follow-up per the sequencing decision made alongside this spec.

## Testing / verification

- `compute.ts` stays a pure module — extend `compute.test.ts` with unit
  tests for: `wallTimeMs` at rho=0/0.5/0.9 (verify amplification only
  hits the CPU term, base latency unchanged); `hardThreadCap` with/without
  `allowMemoryOvercommit`; `ec2AdmissionDecision` for both `blockingIoModel`
  values across admit/drop/oom transitions.
- Engine-level integration test (mirroring this session's established
  `@vitest-environment jsdom` + mocked-rAF pattern from
  `effectiveRps.test.ts`/`outboundBacklogDrain.test.ts`): confirm an
  ec2 source node's outbound-call admission is bounded by its own
  `hardThreadCap` once WI-B lands (previously it would freely exceed that
  bound up to the independent 200 default).
- Manual verification via `npm run dev` + Playwright: load-test a
  blocking EC2 node past saturation and confirm reported latency climbs in
  step with the same curve now driving real thread-hold time (not just the
  displayed percentile); configure a non-blocking EC2 node and confirm it
  degrades via latency/backlog rather than 503s, eventually OOM-crashing
  under sustained extreme load; confirm a default blocking EC2 node still
  never crashes from load alone.
