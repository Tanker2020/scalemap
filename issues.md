# Spec Sheet — Circuit-Breaker Metrics Collapse Fix

## Context

In the load-balanced cluster config, when servers overload and their inbound circuit
breakers trip **open**, every published metric for the affected server collapses to `0`
(inRps, outRps, utilization, errorRate, activeRequests) and **all SLOs pass** — even though
the system is in an actively-failing, traffic-rejecting state. When a breaker is **half-open**
the node reads a misleadingly-healthy ~10% utilization, errorRate stays 0, SLOs pass, and
concurrent connections are never surfaced. When a breaker is **fully open** there is zero
outgoing traffic, even though a real server should keep draining (and emitting downstream calls
from) the in-flight requests it accepted before the trip.

The intended outcome: an open/half-open breaker should produce a **visibly degraded** picture —
the caller shows fail-fast rejections as errors (breaching its SLO), the protected node keeps
draining its accepted backlog (trickling outbound + decaying concurrency), half-open behaves
like a real breaker (a few trial requests, not a steady 10% throttle), and concurrent
connections are tracked and shown.
Also the breakers should be visually shown in the simulation overlay, so users can see which nodes are rejecting traffic, perhaps with a vpn like tunnel on top of the edge to show that the traffic is being rejected. or something like that.

### Root cause (confirmed, with file:line)

The simulation is a **pure flow-rate model with no reservoir of accepted-but-unfinished work.**
Every node metric is derived from the *instantaneous* per-edge rate `ep.effectiveRps`, which is
written in the same expression that gates spawning:

- `spawnParticles` — `particleEngine.ts:808-809`: `rps = ep.rps * mult * downstreamFactor;
  ep.effectiveRps = rps`. When the breaker is **open**, `downstreamFactor = 0`
  (`:715-716`); half-open → `0.1` (`:717-718`). So the edge's `effectiveRps` is zeroed/throttled
  at the source, **not just the visual particle minting.** (The "bookkeeping always runs" comment
  at `:682-685` only holds for the `atCap` visual cap, not the breaker branch.)
- `updateAllNodeMetrics` — `particleEngine.ts:1598-1599`: `inRps`/`outRps` are just the sum of
  inbound/outbound `effectiveRps`. `utilization = inRps / effectiveMaxRps` (`:1827`). So the
  instant the LB→server breaker opens, the server's inRps→0 ⇒ util→0.
- **Outbound cascade**: with inRps→0, the server's outbound edges are killed by the idle-RPS gate
  (`:732-743`): `inRps < 5 ⇒ downstreamFactor *= inRps/5 ⇒ 0`. Hence "no outgoing traffic."
- **errorRate** — `particleEngine.ts:1885-1897`: composed only of `baseErrorRate` (needs
  util > 0.85), `cascadePressure` (raised on the *source* of a drop, not this node — `:951-954`),
  and 4xx `clientErrorRate` (gated `inRps > 0`). A circuit-open rejection feeds **none** of these.
- **Rejections are mostly dead code under sustained-open**: because spawn is suppressed at the
  source, almost nothing arrives to hit the arrival-time reject at `:1182-1186`; and what does hit
  it increments `_droppedCounts[target]` (surfaced only as `droppedRequests`) and raises
  `_upstreamPressure` on the **source**, never the target's own errorRate.
- **SLO** — `SimulationOverlay.tsx:219-231`: evaluates only `p90LatencyMs`, `errorRate`,
  `utilization`. All ≈0 ⇒ `violations` empty ⇒ `passing = true`. `circuitState` and
  `droppedRequests` exist on `NodeMetrics` but are never read here.
- **In-flight reservoir exists but is decorative**: `_lbActiveRequests` (`:417`, incremented by
  `trackRequest` `:666-672`) tracks in-flight requests and drains over `processingMs`, but is
  read by **nothing** except display — it does not feed utilization or error. It only increments
  on the successful-arrival path (`:1279, :1361, :1394`), so once inbound stops it drains to 0 in
  ~`processingMs` and looks instant.
- **Half-open double-throttle**: `0.1` is applied *twice* independently — once as a spawn factor
  (`:718`) and again as an arrival admission probability `Math.random() > 0.1` (`:1187-1190`) —
  so util sticks near 10% and effective probe traffic is ~1%.

### How a real-world circuit breaker behaves (for reference)

- The breaker is a **caller-side** construct. **Open** = *fail-fast*: the caller immediately
  returns an error (typically 503) without calling downstream. Those rejections **are errors/
  traffic** — they must raise the caller's error rate and breach its SLO. Open state does **not**
  make load vanish; it converts offered load into fast failures.
- The **protected (downstream) service**, once the caller stops, keeps **draining its accepted
  in-flight work** — continuing to process and emit responses/downstream calls until the backlog
  clears, then goes idle. Outbound **trickles down**, it does not snap to zero.
- **Half-open** admits a **small fixed number of trial requests** (Hystrix/resilience4j/Polly:
  often 1, sometimes a handful) — *not* a steady percentage of full RPS. First success → close;
  any failure → re-open immediately.
- **Concurrency / in-flight** (Little's Law, `L = λ × W`) is the real saturation signal and
  decays smoothly as a backlog drains — it does not instantaneously track the inbound rate.

---

## Decisions (confirmed with user)

1. **Fix depth: Semantic fix + concurrency metric.** Keep the flow-rate model; add semantic
   correctness (rejections=errors, offered load stays visible, outbound drains from the in-flight
   backlog) **and** promote `_lbActiveRequests` into a first-class "concurrent connections"
   metric for compute nodes. (Not the full queue/Little's-Law rewrite.)
2. **Half-open: fixed trial requests.** Replace the steady 10% throttle + double-drop with a
   bounded probe (admit N trial requests, close-on-success / re-open-on-failure).
3. **SLO on open: rejections = errors.** Circuit-open rejections count toward the **caller's**
   errorRate (fail-fast 503s) so its error SLO breaches; the protected node's `circuitState`
   surfaces as a distinct breach reason. No new SLO config field.

---

## Work Items

### WI-1 — Offered vs. admitted load bookkeeping
**File:** `particleEngine.ts` (`EdgePath` type ~`:385`, `spawnParticles` `:679-900`)

- Add `ep.offeredRps` alongside `ep.effectiveRps`. `offeredRps = ep.rps * mult` (ungated);
  `effectiveRps = offeredRps * downstreamFactor` (gated, as today).
- The **rejected rate** on an edge = `offeredRps − effectiveRps`. This is the quantity the
  breaker (and capacity gates) are shedding, and is the basis for WI-2.
- Keep `effectiveRps` semantics unchanged for existing consumers (queue integration, DB util,
  etc.) so no behavior regresses on the happy path.

### WI-2 — Caller-side rejection accounting (fixes "errorRate 0 / SLO passes")
**File:** `particleEngine.ts` (`spawnParticles` breaker branch `:713-724`; `updateAllNodeMetrics`
errorRate block `:1885-1897`)
... (107 lines left)