# Phase 2: Substrate Engine — Design

**Date:** 2026-07-08 · **Status:** Approved direction (umbrella spec §4/§9 row 2; user
approved depth-first order and this phase's scope in the Phase-1 brainstorm).
**Binding companions:** umbrella `2026-07-08-world-model-multiscale-simulation-design.md`
(D7–D13, D16, §4) and the FROZEN `2026-07-08-world-engine-contracts.md`.

## Goal

`src/lib/worldEngine/` — a single headless engine ticking the whole compiled world:
host CPU/RAM scheduling (dedicated vs VPS), runtime traversal of permitted network paths,
geo traffic with routing policies and TTL-lagged failover, breakers, the metrics pyramid,
events, replay, request tracing — plus AZ-scope particle rendering re-attached and cost
model v2. After this phase the app simulates again (D13 features return) and the branch
becomes mergeable to main.

## Engineering decisions (within the umbrella's envelope)

1. **Fixed-step clock** (100ms steps, rAF + accumulator, `timeScale` multiplier).
   Rate-based simulation like the legacy engine — flows are RPS numbers integrated per
   step; *visual* particles are sampled representations (`PARTICLE_REQUEST_RATIO`-style),
   never the unit of simulation.
2. **Ports, not rewrites, where the old engine's math is good:** log-normal latency
   sampling (Box-Muller), circuit-breaker state machine (closed→open→half-open with
   single-trial admission), EMA smoothing constants, health onset/recovery hysteresis
   (3s onset debounce / recovery lock) — all lifted from `particleEngine.ts`/submodules
   with per-node state re-keyed to per-instance/per-dependency.
3. **Host scheduler:** per step, each server sums instance CPU demand
   (`rps × cpuMsPerRequest / 1000` cores) against `vcpu` (× steal factor on VPS).
   Demand/capacity ratio > 1 inflates every resident instance's service latency by the
   ratio (queuing approximation) and caps admitted rps proportionally. RAM =
   `ramBaseMb + ramPerConnMb × activeConnections` per instance (container `memLimitMb`
   caps individually first); host RAM exhaustion OOM-kills the largest over-base consumer
   (container limits respected), `instance_restarted` after `5000ms`.
4. **VPS realism:** steal factor sampled per host per step from an Ornstein-Uhlenbeck-ish
   random walk scaled by `oversubscriptionRatio` (mean steal ≈ `(ratio−1)×2%`, spikes to
   ~40%); burstable hosts accrue credits below 40% base utilization and drain above it —
   empty credits clamp effective vcpu to the base share. Dedicated: steal = 0, no credits.
5. **Traffic & routing:** population demand = `peakRps × diurnal(t)` (flat or day-night
   sine) + auto-baseline share. Each population holds a DNS cache entry (TTL from
   `routing.dnsTtlSec`); on expiry it re-resolves: first healthy region in its compiled
   `populationRegionOrder` (weighted policy: healthy-region weighted draw). Region LB
   splits across healthy AZs (equal shares) → AZ targets from `azBlueprintTargets` →
   round-robin instances. Health checks run per `healthCheckIntervalMs`; a scope is
   check-failed after `healthCheckFailureThreshold` consecutive failures.
6. **Network runtime:** requests traverse an instance's compiled permitted paths only;
   attempts on blocked paths emit `connection_refused` + caller error contribution
   (they DO happen at runtime — misconfig is a live failure mode, not just a compile
   finding). Hop latency: localhost 0.1ms / same-az 0.5ms / cross-az 1.5ms / cross-region
   `sampleInterRegionLatencyMs` / client→region from great-circle distance (≈ km/100 ms,
   jittered ±10%). NIC caps: per-server in/out bytes per step from packet sizes; over-cap
   flows queue latency and shed at 2× cap.
7. **Failover semantics:** manual `setOutage` at server/AZ/region + organic health
   propagation. Down AZ → region LB re-splits (existing traffic drains over ~2s); down
   region → populations re-resolve ONLY when their TTL expires (the observable lag, D8);
   active-passive: passive regions receive traffic only when every active region in the
   order is down. Stateful role play: primary down → oldest replica of the same blueprint
   in the same scope emits `replica_promoted` and takes primary's writes (visual/event
   semantics only in Phase 2 — no data modeling).
8. **Cost v2:** `costModelV2.ts` = Σ server `hourlyUsd` + managed-service pricing (reuse
   `cloudRegistry`) + egress from `WorldMetrics.crossAzBytesPerSec` (× $0.01/GB),
   `crossRegionBytesPerSec` (× $0.02/GB), `internetEgressBytesPerSec` (tiered, reuse
   existing egress tiers). CostTracker v2 renders world/region/AZ breakdown.
9. **Perf budget (hard):** ≤4ms/step at 2,000 instances (synthetic benchmark in-repo);
   over budget → engine halves step rate (100→200ms) and emits a UI-visible notice,
   never silently drops fidelity. Render caps enforced engine-side per contracts.
10. **Legacy retirement in this phase:** `particleEngine.ts` + submodules, old
    `simulation.store` shape, `SimulationOverlay`, old engine test files are DELETED once
    their ports land (the plan sequences deletion after the facade works). Old UI panels
    that read them (`MetricsDrawer`, `PropertiesPanel` analytics, `SimConfigPanel`,
    `EventLogPanel`, `RequestInspector`, `PlaybackScrubber`, `ReportsPanel`, `StatusBar`,
    `Toolbar`, `Canvas`, `NodePalette`, palette/edge legacy) are deleted with them —
    Phase 1 kept them compiling only as porting reference. What survives: `theme.ts`,
    `nodeConfig.ts` (types/icons), `cloudRegistry.ts`, `regionConfig.ts`, packet types,
    `tauri.ts`/mock, and everything under `world/`/`worldEngine/`/`app/world/`.
11. **UI this phase (minimal, contracts-shaped):** Simulate/Stop + timeScale in
    WorldShell's header; live health/rps on Globe/Region/AZ views' existing placeholder
    cards; AZ canvas particle overlay + health-tinted nodes; events feed as a WorldPanel
    tab; PlaybackScrubber v2 (reuse visual pattern); traced-request inspector overlay on
    AZ view; CostTracker v2 as a WorldPanel tab. Rich views stay Phases 3–5.

## Testing & verification

Deterministic seeded tests per subsystem (scheduler, VPS model, routing/TTL, network
runtime, failover, metrics, replay, cost) + one end-to-end fixture world integration test
(traffic flows, AZ kill → failover with TTL lag observable in `populationRoutes`) + the
perf benchmark + live Playwright smokes at each UI task. Suite stays green throughout;
the legacy-deletion task carries the same grep-verify discipline as Phase 1 Task 9.

## Out of scope (unchanged from umbrella)

k8s/ECS schedulers, ScaleScript v2, Terraform v2, spot instances, AI watch-mode, rich
Phase 3–5 visuals.
