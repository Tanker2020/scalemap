# Circuit-Breaker Metrics/SLO Semantic Fix — Design

Supersedes `issues.md` (repo root, untracked spec sheet) — completes its truncated
WI-2 and adds WI-3/WI-4, which its "Decisions (confirmed with user)" section
committed to but never wrote up as work items.

## Problem

In the load-balanced cluster config, when a server overloads and its inbound
circuit breaker trips **open**, every published metric for that server collapses
to `0` (`inRps`, `outRps`, `utilization`, `errorRate`, `activeRequests`) and **all
SLOs pass** — even though the system is actively failing and rejecting traffic.
When a breaker is **half-open**, the node reads a misleadingly-healthy ~10%
utilization, `errorRate` stays 0, SLOs pass, and concurrent connections are never
surfaced. When fully open there is zero outgoing traffic, even though a real
protected server should keep draining in-flight work it already accepted.

### Root cause (confirmed against current code)

The simulation is a **pure flow-rate model with no reservoir of accepted-but-
unfinished work.** Every node metric derives from the instantaneous per-edge
rate `ep.effectiveRps`, written in the same expression that gates particle
spawning:

- `spawnParticles` (`particleEngine.ts:809-810`): `rps = ep.rps * mult *
  downstreamFactor; ep.effectiveRps = rps`. Breaker **open** →
  `downstreamFactor = 0` (`:716-717`); **half-open** → `0.1` (`:718-719`). The
  edge's `effectiveRps` is zeroed/throttled at the source, not just the visual
  particle mint.
- `updateAllNodeMetrics` (`particleEngine.ts:1615-1616`): `inRps`/`outRps` are
  the sum of inbound/outbound `effectiveRps`. `utilization = inRps /
  effectiveMaxRps` (`:1844`). The instant the breaker opens, the server's
  `inRps → 0 ⇒ util → 0`.
- **Outbound cascade**: with `inRps → 0`, the server's own outbound edges are
  killed by the idle-RPS gate (`:733-747`): `inRps < 5 ⇒ downstreamFactor *=
  inRps/5 ⇒ 0`.
- **`errorRate`** (`particleEngine.ts:1904-1914`): composed only of
  `baseErrorRate` (needs `util > 0.85`), `cascadePressure * 0.15`
  (`_upstreamPressure`, raised on the edge's *source* by `dropParticle`), and
  `clientErrorRate` (gated `inRps > 0`). None of these fire from a
  sustained-open breaker.
- **Rejections are dead code under sustained-open**: because spawning is
  suppressed at the source (`downstreamFactor = 0`), almost nothing ever
  arrives at `handleParticleArrival` to hit the breaker-open reject
  (`:1183-1187`) that would otherwise call `dropParticle` →
  `_upstreamPressure.set(sourceNodeId, …)`. The caller-side error-pressure
  mechanism already exists; it just never fires because there's no traffic
  left to trigger it.
- **SLO** (`SimulationOverlay.tsx:219-231`): evaluates only `p90LatencyMs`,
  `errorRate`, `utilization`. All ≈0 while a breaker is open ⇒ `violations`
  empty ⇒ `passing = true`. `circuitState` and `droppedRequests` exist on
  `NodeMetrics` but are never read here.
- **In-flight reservoir exists but is decorative**: `_lbActiveRequests`
  (`particleEngine.ts:418`, incremented by `trackRequest` on successful
  arrival at `:1280/:1362/:1395`, released after `effectiveProcessingMs` via
  `scheduleGenericRelease`) already reaches the UI as `NodeMetrics
  .activeRequests` (`:1916`) and already drives LAC load-balancer routing
  (`:1427-1429`) — but nothing uses it to shape outbound RPS. Once inbound
  stops, `outRps` is computed independently from live `effectiveRps` and
  snaps to 0 immediately; the reservoir just isn't wired to anything that
  would make outbound trickle instead.
- **Half-open double-throttle**: `0.1` is applied twice independently — once
  as the spawn factor (`:719`) and again as an arrival admission probability
  `Math.random() > 0.1` (`:1188-1191`) — so effective probe traffic is ~1%,
  and there's no bounded trial: it throttles forever instead of admitting a
  small number of probes and deciding closed/open.

### How a real circuit breaker behaves (reference)

- **Open** = caller-side fail-fast: the caller immediately errors out without
  calling downstream. Those rejections **are errors** — they raise the
  caller's error rate and breach its SLO. Load doesn't vanish; open converts
  it into fast failures.
- The **protected (downstream) service** keeps **draining accepted in-flight
  work** after the caller stops sending — outbound trickles down as the
  backlog clears, it doesn't snap to zero.
- **Half-open** admits a **small fixed number of trial requests** (Hystrix/
  resilience4j/Polly: often 1) — not a steady percentage of full RPS. First
  success → close; any failure → reopen immediately.
- **Concurrency / in-flight** (Little's Law, `L = λ × W`) is the real
  saturation signal and decays smoothly as backlog drains.

## Decisions (confirmed)

1. **Fix depth: semantic fix, not a queue/Little's-Law rewrite.** Keep the
   flow-rate model. Add correctness (rejections = errors, offered load stays
   visible, outbound drains from backlog) and finish promoting
   `_lbActiveRequests` from decorative to something outbound math actually
   reads. No new Zustand store fields — `CircuitBreakerEntry` and
   `NodeMetrics` already carry what's needed.
2. **Half-open: exactly 1 trial request**, not a steady throttle.
3. **SLO on open: rejections = errors**, read through the caller's existing
   `errorRate` field. No new SLO config field — `SimulationOverlay.tsx`'s SLO
   check already reads `errorRate`; WI-2 makes that value correct.

## Work Items

### WI-1 — Offered vs. admitted load bookkeeping

**File:** `particleEngine.ts` (`EdgePath` interface `:379-387`, `spawnParticles`
`:680-921`)

- Add two optional fields to `EdgePath`: `offeredRps?: number` (ungated: `ep.rps
  * mult`) and `breakerRejectedRps?: number` (the load specifically shed by
  *this edge's breaker*, captured before queue-backpressure/idle-RPS/stall
  gates apply on top).
- In the breaker branch (currently `:715-725`), capture `const breakerFactor =
  downstreamFactor` in a local variable immediately after the breaker if/else
  resolves (defaults to `1` — the value `downstreamFactor` already holds
  before the breaker branch runs — when no breaker config applies to this
  edge's target, i.e. the `else` arm at `:714` didn't touch it). This is a
  plain local variable, not a new `EdgePath` field — only `offeredRps` and
  `breakerRejectedRps` (below) need to persist on `EdgePath` for WI-2 to read.
- After `downstreamFactor` is fully resolved and `mult` computed (`:809`), set:
  ```ts
  ep.offeredRps = ep.rps * mult
  ep.breakerRejectedRps = breakerFactor < 1 ? ep.offeredRps * (1 - breakerFactor) : 0
  ```
  before `ep.effectiveRps = rps` is assigned.
- `effectiveRps` semantics are unchanged for every existing consumer (queue
  integration, DB util, etc.) — this is additive bookkeeping only.

### WI-2 — Caller-side rejection accounting

**File:** `particleEngine.ts` (`updateAllNodeMetrics`, error-rate block
`:1902-1914`)

- In the per-node loop, alongside the existing `outEdges` computation
  (`:1614`), sum `breakerRejectedRps` and `offeredRps` over `outEdges`:
  ```ts
  const outOfferedRps   = outEdges.reduce((s, e) => s + (e.offeredRps ?? e.effectiveRps ?? 0), 0)
  const outRejectedRps  = outEdges.reduce((s, e) => s + (e.breakerRejectedRps ?? 0), 0)
  const breakerRejectionRate = outOfferedRps > 0 ? Math.min(1, outRejectedRps / outOfferedRps) : 0
  ```
- Fold into the existing composition at `:1914`:
  ```ts
  const rawErrorRate = Math.min(1, baseErrorRate + cascadePressure * 0.15 + clientErrorRate + breakerRejectionRate)
  ```
- No change to `_upstreamPressure`/`dropParticle` — that mechanism stays as a
  secondary signal for the (now rarer, since WI-3 admits real trial traffic)
  discrete-drop case. `breakerRejectionRate` is the primary, always-on signal
  since it doesn't depend on any particle actually spawning.
- Net effect: the instant an outbound breaker trips open, the caller's
  `errorRate` rises proportionally to how much of its offered load that edge
  represents — immediately visible, and immediately breaches the caller's SLO
  through the existing, unmodified `SimulationOverlay.tsx:219-231` check.

### WI-3 — Half-open: fixed trial request, not steady throttle

**Files:** `particleEngine/circuitBreakers.ts` (`CircuitBreakerEntry`
`:9-13`, `checkBreakerTransition` `:89-117`, `recordBreakerResult`
`:44-87`); `particleEngine.ts` (spawn breaker branch `:715-725`, arrival
breaker check `:1182-1191`)

- Add `trialPending: boolean` to `CircuitBreakerEntry`, defaulted `false` in
  `getBreaker`'s fresh-entry branch (`:19-21`).
- `checkBreakerTransition`: when transitioning `open → half-open`
  (`:110-115`), also set `b.trialPending = false` (no trial issued yet for
  this half-open window).
- `recordBreakerResult`: in the `half-open` branch (`:77-86`), after
  resolving to `closed` or back to `open`, always reset `b.trialPending =
  false` — the flag only has meaning while `state === 'half-open'`.
- `spawnParticles` breaker branch: replace the `half-open → downstreamFactor =
  0.1` line (`:719`) with:
  ```ts
  } else if (breaker?.state === 'half-open' && ep.edgeType !== 'event' && ep.edgeType !== 'stream') {
    if (breaker.trialPending) {
      downstreamFactor = 0        // trial already in flight — hold everything else back
    } else {
      breaker.trialPending = true // this frame mints the one allowed trial
      downstreamFactor = 1        // let the spawn-rate math size exactly one particle below
    }
  }
  ```
  Immediately below, where `n` (particle count for this edge this frame) is
  computed (`:813-814`), clamp: when this edge's breaker is half-open and a
  trial was just authorized this frame, force `n = Math.min(n, 1)` so exactly
  one particle mints regardless of the batch-rate math — the throttle down to
  "one trial" is enforced at the count, not the rate.
- `handleParticleArrival` breaker check (`:1182-1191`): remove the
  `Math.random() > 0.1` admission drop entirely — a particle reaching this
  point on a half-open edge IS the one authorized trial, so it always
  proceeds to the normal downstream checks (connection pool, queue overflow,
  etc.) exactly like a closed-breaker particle would. `recordBreakerResult`
  on its eventual success/drop resolves `half-open → closed`/`open` as today.
- Net effect: while half-open, exactly one particle is in flight probing the
  edge at a time; success closes the breaker, failure reopens it — matching
  Hystrix/resilience4j/Polly semantics instead of a permanent ~1% trickle.

### WI-4 — Outbound keeps draining the accepted backlog

**File:** `particleEngine.ts` (idle-RPS gate `:733-747`, `spawnParticles`)

- `_lbActiveRequests` (`:418`) already IS the accepted in-flight backlog and
  already reaches the UI as `NodeMetrics.activeRequests` (`:1916`) — this work
  item does not add a new metric, it makes the idle-RPS gate aware of it.
- In the idle-RPS gate (`:733-747`), when `inRps < IDLE_RPS_THRESHOLD` would
  otherwise scale `downstreamFactor` toward 0, check the source node's live
  backlog first. This snippet replaces the body of the existing `if (inRps <
  IDLE_RPS_THRESHOLD)` block only — it stays nested inside the gate's current
  outer guard (`sourceNodeId && ep.sourceNodeType && !_INBOUND_GATE_EXEMPT_TYPES
  .has(ep.sourceNodeType)`, `:734-735`), so `sourceNodeId`/`ep.sourceNodeType`
  are already known non-undefined at this point — no new guard needed:
  ```ts
  const backlog = _lbActiveRequests.get(sourceNodeId) ?? 0
  if (inRps < IDLE_RPS_THRESHOLD) {
    if (backlog > 0) {
      // Still draining accepted work — trickle outbound proportional to the
      // decaying backlog instead of snapping to 0 alongside inbound.
      const maxBacklogRef = Math.max(1, effectiveConfig(sourceNodeId, ep.sourceNodeType).maxConcurrency ?? 20)
      downstreamFactor *= Math.max(inRps / IDLE_RPS_THRESHOLD, Math.min(1, backlog / maxBacklogRef))
    } else {
      downstreamFactor *= inRps / IDLE_RPS_THRESHOLD
    }
  }
  ```
- Net effect: a node whose inbound breaker just tripped doesn't zero its
  outbound edges in the same frame — outbound fades out over the same window
  `_lbActiveRequests` takes to drain (`effectiveProcessingMs`), matching a
  real server finishing in-flight work before going quiet.

## Non-goals

- No full queueing/Little's-Law rewrite of the simulation engine.
- No new Zustand store fields, no new SLO config fields.
- No change to `_upstreamPressure`/`dropParticle`'s existing discrete-drop
  accounting — WI-2 adds a parallel, always-on signal rather than replacing
  it.
- No change to the circuit-breaker edge visualization (separate, already
  shipped — see `2026-07-03-circuit-breaker-edge-visualization-design.md`).
  `getAllBreakers()`/`CircuitBreakerEntry.state` stay the only fields that
  overlay reads; adding `trialPending` does not affect it.

## Testing / verification

This project has no automated tests for `particleEngine.ts`'s numeric model
today beyond a few targeted unit tests (e.g. `retryGating.test.ts`). Each work
item should ship with a focused unit test where the underlying function is
pure/isolable (e.g. the idle-RPS-with-backlog formula in WI-4, the trial-gate
state machine in WI-3), plus manual verification via `npm run dev` +
Playwright against the Load Balanced Cluster vault template:

- Saturate a server past its `circuitBreaker.errorThreshold` until its
  inbound breaker trips open; confirm the **caller's** (LB's) `errorRate` and
  SLO status visibly degrade within one metrics tick, while the protected
  server's `outRps` fades rather than snapping to 0.
- Confirm exactly one particle is in flight on a half-open edge at a time,
  and that a single success closes it / single failure reopens it.
- Confirm `droppedRequests` and the existing circuit-breaker edge
  visualization (sheath/scan/pulse) are unaffected by these changes.
