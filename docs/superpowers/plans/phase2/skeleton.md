# Phase 2 Plan Skeleton (controller-authored; fragment writers expand tasks into full plan sections)

Binding docs every fragment writer must read FIRST:
- Contracts (FROZEN, types verbatim): docs/superpowers/specs/2026-07-08-world-engine-contracts.md
- Phase 2 spec (decisions 1–11): docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md
- Phase 1 plan for format precedent: docs/superpowers/plans/2026-07-08-phase1-world-model-shell.md (match its task structure exactly: Files / Interfaces / checkbox TDD steps with COMPLETE code / exact run commands with expected output / commit step)

## Global Constraints (copy into final plan header verbatim)

- Branch: `world-rebuild`, continuing from Phase-1 head `df21aab`.
- No new dependencies.
- FROZEN contracts: `src/lib/worldEngine/types.ts` is transcribed verbatim from the contracts doc in Task 1; later tasks import from it and NEVER redefine/reshape contract types. Additive-optional extension only, escalate otherwise.
- `src/lib/worldEngine/` never imports from `src/app/` (same layering rule as `lib/world/`). The facade is consumed via `src/app/store/simulation.store.ts` (rewritten, Task 12).
- Determinism: no `Math.random` inside `src/lib/worldEngine/` — all randomness through the seeded `rng.ts` (Task 1). Tests reseed per case.
- Fixed-step clock: 100ms steps, rAF+accumulator, `timeScale` multiplier (spec decision 1).
- Theme via `var(--color-*)`; JetBrains Mono via `--font-mono`; `prefers-reduced-motion` respected in all new animation.
- Strict `noUnusedLocals`/`noUnusedParameters`; never spread bare `borderColor`/`borderWidth` over shorthand `border`.
- Component tests: `// @vitest-environment jsdom` pragma; jest-dom via vitest.setup.ts (already wired).
- Commit per task: `feat(engine): …` (deletion task: `refactor(engine)!: …`).
- UI tasks (13–15) REQUIRE a live Playwright smoke step (dev server on strict port 1420, stop after, zero console errors, screenshots).
- Perf budget: ≤4ms/step at 2,000 instances; over budget → step-rate degradation + UI notice (Task 18 verifies).

## File structure (copy into final plan)

```
src/lib/worldEngine/
  types.ts           # contracts, verbatim (T1)
  rng.ts             # mulberry32 + helpers (T1)
  engineClock.ts     # fixed-step accumulator (T1)
  demand.ts          # population diurnal + baseline demand (T2)
  routingRuntime.ts  # DNS/TTL cache, health checks, region/AZ/instance targeting (T3)
  hostScheduler.ts   # CPU/RAM/OOM per-server per-step math (T4)
  vpsModel.ts        # steal walk + burst credits (T5)
  networkRuntime.ts  # hop latency, refused paths, NIC caps (T6)
  breakers.ts        # per-dependency circuit breakers (port) (T7)
  flows.ts           # per-step flow solver across instances (T8)
  failover.ts        # outages, health propagation, drain, promotion (T9)
  metrics.ts         # MetricsBatch pyramid + EMA (T10)
  events.ts          # EngineEvent emission ring (T10)
  replay.ts          # ReplayFrame ring + traced requests (T11)
  index.ts           # WorldEngineApi facade (T12)
  latency.ts         # log-normal sampling port (T4 helper, shared)
  *.test.ts          # colocated suites
src/app/store/simulation.store.ts   # REWRITTEN v2 (T12)
src/app/world/
  SimControls.tsx    # Simulate/Stop/timeScale in WorldShell header (T13)
  EventsTab.tsx      # events feed tab in WorldPanel (T13)
  AzSimOverlay.tsx   # particle canvas overlay + health tint plumbing (T14)
  ScrubberV2.tsx     # playback scrubber (T15)
  InspectorV2.tsx    # traced-request inspector (T15)
  CostTab.tsx        # cost tracker v2 tab (T16)
src/lib/costModelV2.ts               # (T16)
bench/enginePerf.bench.ts            # (T18)
DELETED (T17): src/app/canvas/** , src/app/simulation/** , src/app/sidebar/** ,
  src/app/toolbar/** , src/app/dock/** , src/app/analytics/** , src/app/reports/** ,
  src/app/StatusBar.tsx, src/app/store/{simulation-legacy remnants, replay.store.ts,
  metricsHistory.store.ts, costHistory.store.ts, canvas.store.ts, ui.store legacy fields},
  src/lib/costModel.ts, src/lib/scalescript.ts, src/lib/terraform/**, src/lib/vault/**
  (exact list re-derived by grep in the task; keep nodeConfig/theme/cloudRegistry/
  regionConfig/packets/tauri)
```

## Task specs

### T1 — Engine types (contracts verbatim), seeded RNG, fixed-step clock  [impl model: haiku]
Files: types.ts (verbatim from contracts doc code block), rng.ts, engineClock.ts, tests for rng determinism + clock accumulation.
Interfaces produced: `createRng(seed?: number): { next(): number; range(a,b): number; pick<T>(arr): T }`; `createClock(stepMs=100): { advance(frameMs, timeScale): number /* steps to run */; simMs: number }`.
Tests: same seed → same sequence; clock accumulates fractional frames (16.7ms × 6 → 1 step; remainder carries); timeScale 2 doubles steps.

### T2 — Traffic demand  [haiku]
Files: demand.ts + test.
Interfaces: `populationDemandRps(pop: ClientPopulation, simMs: number, rng): number` (flat = peakRps; day-night = peakRps × (0.55 + 0.45·sin(2π·simMs/DAY_MS − π/2)) with DAY_MS = 120_000 — a compressed 2-minute "day" so demos show the curve; ±3% jitter); `baselineDemands(traffic: TrafficConfig, populations, regions): Record<PopulationId, number>` — when autoBaseline, a synthetic population per region at `baselineTotalRps/regionCount` located at the region's geo. Baseline synthetic populations get ids `baseline:<regionId>` (documented; views may filter by prefix).
Tests: flat exact; day-night min/max envelope; baseline splits evenly; jitter bounded.

### T3 — Routing runtime: DNS/TTL, health checks, targeting  [sonnet]
Files: routingRuntime.ts + test.
Interfaces:
```ts
interface RoutingState { /* per-population cache: { regionId, expiresAtMs } ; health-check counters */ }
createRoutingState(): RoutingState
resolveRegion(state, popId, orderedRegions: RegionId[], healthOf: (id: RegionId) => HealthState, policy: RoutingConfig, simMs, rng): RegionId | null   // honors TTL: returns cached until expiry even if unhealthy (that IS the lag)
runHealthChecks(state, config: RoutingConfig, simMs, scopes: { id: string; health: HealthState }[]): { id: string; checkFailed: boolean }[]   // interval + consecutive-threshold
azSplit(azIds: AzId[], healthOf): AzId[]            // healthy only; [] if none
pickInstance(state, azId, blueprintId, targets: InstanceId[], healthyOf): InstanceId | null  // round-robin cursor per (az,blueprint)
```
Semantics per spec decision 5+7: weighted policy re-draws on each resolution among HEALTHY regions by weight; priority/latency/geo take first healthy in order; passive regions only when all active down; TTL cache returns the cached region until `expiresAtMs` even if it went down (failover lag observable), then re-resolves and emits nothing itself (facade emits `ttl_lag_expired`).
Tests: TTL lag (down region still targeted until expiry); consecutive-threshold health checks (2 fails below threshold 3 → not failed); passive-last activation; round-robin cycles; weighted draw distribution (seeded, ~proportional over 1000 draws).

### T4 — Host scheduler: CPU/RAM/OOM  [sonnet]
Files: hostScheduler.ts, latency.ts (port sampleLatencyMs log-normal Box-Muller from legacy compute — reimplement cleanly with rng injection) + tests.
Interfaces:
```ts
interface InstanceLoad { instanceId; cpuMsPerRequest: number; admittedRps: number; activeConnections: number; ramBaseMb: number; ramPerConnMb: number; memLimitMb: number | null }
interface HostStepResult {
  cpuPressure: number            // demand/capacity, ≥0; >1 = saturated
  coreUtilization: number[]      // per-vCPU 0..1 (fill cores in order for readability)
  latencyMultiplier: number      // max(1, cpuPressure)
  admittedScale: number          // min(1, 1/cpuPressure)
  ramUsedMb: number
  oomVictim: InstanceId | null   // largest over-base consumer when ramUsed > ramTotal; container memLimit kills individually first (victim = that instance)
}
stepHost(server: Server, loads: InstanceLoad[], effectiveVcpu: number, rng): HostStepResult
sampleLatencyMs(p50: number, p99: number, rng): number
```
Semantics per spec decision 3. Tests: under-capacity → multiplier 1, cores partially filled; 2× overload → multiplier 2, admittedScale 0.5; RAM: per-conn growth; container limit kill before host OOM; host OOM picks largest over-base; log-normal p50 median ±10% over 2000 seeded samples.

### T5 — VPS model: steal walk + burst credits  [haiku]
Files: vpsModel.ts + test.
Interfaces:
```ts
interface VpsState { steal: number; credits: number }
createVpsState(server: Server): VpsState | null      // null for dedicated
stepVps(state, server, hostUtilization: number, stepMs, rng): { steal: number; effectiveVcpuFactor: number; creditsFraction: number | null; noisySpikeStarted: boolean; creditsJustExhausted: boolean }
```
Semantics per spec decision 4: steal random-walks toward mean `(ratio−1)×0.02`, clamped [0, 0.4], spike = crossing 0.15 upward; burstable: credits (0..100) accrue `+stepMs/1000 × 2` below 40% util, drain `−stepMs/1000 × 5 × (util−0.4)/0.6` above; exhausted → effectiveVcpuFactor = 0.4 (base share) until credits > 10.
Tests: dedicated → null; steal mean over 5k seeded steps ≈ target ±30%; clamp; credit drain to exhaustion then clamp factor; recovery above 10.

### T6 — Network runtime: hop latency, refused paths, NIC caps  [sonnet]
Files: networkRuntime.ts + test.
Interfaces:
```ts
hopLatencyMs(hopClass: HopClass | 'internet', fromRegionCatalogId: string | null, toRegionCatalogId: string | null, popLatLon: [number,number] | null, regionGeo, rng): number
  // localhost .1 / same-az .5 / cross-az 1.5 (each ±10% jitter) / cross-region via sampleInterRegionLatencyMs / internet = greatCircleKm/100 ±10%
interface NicState { inBytesThisStep: number; outBytesThisStep: number }
applyNicCap(state, server, addInBytes, addOutBytes, stepMs): { deliveredFraction: number; queuedLatencyMs: number }
  // ≤cap: 1,0 ; cap..2×cap: 1, +ms proportional ; >2×cap: shed to 2×cap
refusedAttemptRate(dep: BlueprintDependency, blockedPaths: CompiledPath[], demandRps: number): number
  // demand attempted down blocked paths still fires (spec decision 6): full share refused
```
Tests: each hop class value + jitter bounds; NIC under/over/shed regimes; refused = demand share.

### T7 — Circuit breakers (port)  [haiku]
Files: breakers.ts + test.
Interfaces: port `particleEngine/circuitBreakers.ts` semantics keyed by `pathKey = ${fromInstanceId}->${dependencyId}` : `getBreaker(map, key, config)`, `recordResult(breaker, failed, simMs)`, `transition(breaker, simMs)` (closed→open at errorThreshold over window; open→half-open after resetMs; half-open admits ONE trial: success→closed, fail→open), `clearBreakers`. Defaults: errorThreshold 0.5 over 20 samples, resetMs 10_000.
Tests: full state cycle; single-trial half-open; window behavior.

### T8 — Flow solver  [sonnet — the heart]
Files: flows.ts + test.
Interfaces:
```ts
interface FlowInput {
  compiled: CompiledWorld; doc: WorldDoc
  entryDemand: Record<InstanceId, number>          // rps landed on entry instances this step (from routing)
  admittedScaleByServer: Record<ServerId, number>  // from host scheduler (previous sub-step)
  latencyMultiplierByServer: Record<ServerId, number>
  breakerOpen: (pathKey: string) => boolean
  healthOf: (instanceId: InstanceId) => HealthState
  rng: Rng
}
interface InstanceFlow {
  instanceId: InstanceId
  offeredRps: number; admittedRps: number; errorRps: number; refusedRps: number
  serviceLatencyMs: number                          // sampled, multiplied
  downstream: { dependencyId: string; toInstanceId?: InstanceId; toManagedServiceId?: string; rps: number; hopClass: HopClass; blocked: boolean }[]
}
solveFlows(input): { flows: Record<InstanceId, InstanceFlow>; totals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number } }
```
Semantics: BFS from entry instances along permitted paths, depth-capped at 8 (cycles guarded by visited-per-request-class); each instance's admitted = offered × admittedScale × (health down→0, degraded→0.7); every dependency fans out FULL admitted rps (call-per-request model, like legacy); blocked-path demand → refusedRps on the CALLER + `blocked: true` downstream rows (for events/particles); per-dependency breakerOpen short-circuits (refused, no downstream). Managed targets: fixed latency 3ms, no capacity model in Phase 2. Bytes: 2KB per request both directions default (packet templates refine later; constant documented).
Tests (fixture worlds via lib/world factories): linear chain propagates rps; fan-out duplicates; blocked path refuses at caller and never reaches target; breaker short-circuit; down instance zeroes subtree; totals bucket by hopClass correctly.

### T9 — Failover machinery  [sonnet]
Files: failover.ts + test.
Interfaces:
```ts
interface FailoverState { manualOutages: Set<string>; healthByScope: Map<string, HealthState>; drainUntil: Map<AzId, number>; promotedAt: Map<PlacementId, number> }
setOutage(state, scope, id, down): EngineEvent[]           // outage_triggered/cleared
computeHealth(state, scopeId, inputs: { errorRate, cpuPressure, checkFailed, manualDown }, simMs, hysteresis): HealthState
  // port legacy onset debounce 3000ms / recovery lock 5000ms; manualDown forces 'down'
promoteReplicas(state, compiled, doc, downInstanceIds, simMs): EngineEvent[]  // replica_promoted per spec decision 7
drainFactor(state, azId, simMs): number                    // 1 → 0 over 2000ms after AZ goes down
```
Tests: manual outage forces down + event; onset debounce (2 bad ticks < 3s → still healthy); recovery lock; drain ramps 1→0; promotion picks oldest replica same blueprint+scope, emits once.

### T10 — Metrics pyramid + events ring  [sonnet]
Files: metrics.ts, events.ts + tests.
Interfaces:
```ts
createMetricsState(): MetricsState                        // EMA accumulators keyed per entity
accumulateStep(state, flows, hostResults, vps, nic, health, simMs): void   // every step
buildBatch(state, doc, compiled, routingSnapshot, totals, simMs): MetricsBatch  // 1 Hz, EMA α=0.3
createEventRing(cap=500): { push(e: EngineEvent): void; drain(): EngineEvent[]; all(): EngineEvent[] }
mkEvent(kind, severity, message, affected, simMs, idSeq): EngineEvent
```
Batch must populate EVERY contracts field (coreUtilization from host results, ramByInstance ordered by ramMb desc, healthScore = 100×(1−errorRate)×healthFactor with healthFactor 1/.6/.15, inboundByPopulation + populationRoutes from routing snapshot, byte rates from totals EMA).
Tests: EMA smoothing; pyramid sums (az rps = Σ instances in az); healthScore formula; ring cap.

### T11 — Replay + traced requests  [haiku]
Files: replay.ts + test.
Interfaces: `createReplayBuffer(cap=300)` push/getFrames per contracts `ReplayFrame`; `createTracer(rng)` — each 1s window, sample ≤1 synthetic `TracedRequest` per scope from that step's flows (walk one path from an entry instance, recording hops/outcomes/latencies), `getTraced(scope)` returns last 10 for scope.
Tests: ring wraps at 300; frames carry events of their window only; trace hops match a real permitted path; refused trace has outcome 'refused'.

### T12 — Engine facade + simulation.store v2 + integration test  [sonnet]
Files: index.ts (implements `WorldEngineApi` exactly), simulation.store.ts REWRITE, integration test.
Facade step order (document in code): clock → demand → routing (TTL/health checks) → per-server host scheduling (using PREVIOUS step's flows for load, documented one-step lag) → vps → flows → NIC → breakers record → failover/health → metrics accumulate → (1Hz) batch+replay+trace → render payload build (respecting caps: az particles from flows on visible pairs sampled by PARTICLE_RATIO=10 rps/particle; server ≤50; globe arcs from populationRoutes intensity-scaled ≤200).
Store v2 per contracts §Store publication. Facade emits `ttl_lag_expired`, `failover_started/completed` (derived from populationRoutes deltas), `connection_refused` (rate-limited: ≤1 event/sec per pathKey), etc.
Integration test (headless, fixture world 2 regions/3 AZ/4 servers/3 blueprints): run 30 simulated seconds by calling the internal step loop directly (export a `__test_step` hook), assert: rps flows end-to-end; killing an AZ redistributes within 3s; killing a region shifts populationRoutes only after dnsTtlSec; OOM under RAM-starved fixture emits oom_kill + restart.

### T13 — UI: sim controls, live cards, events tab  [sonnet + live smoke]
Files: SimControls.tsx (WorldShell header: Simulate/Stop button, timeScale 1x/2x/4x select, running dot; disables authoring panel edits while running via a `running` gate passed to WorldPanel — same editing-lock pattern Phase 1's plan noted for legacy), EventsTab.tsx (WorldPanel 5th tab `Events`, severity-colored rows, newest first, kind + message + simMs), live metrics on GlobeView/RegionView cards (rps/err/health from latestBatch — additive edits to existing card components).
Live smoke: run sim on an authored world; cards update; events appear; stop halts.

### T14 — AZ canvas sim overlay  [sonnet + live smoke]
Files: AzSimOverlay.tsx — absolutely-positioned `<canvas>` over AzCanvas's ReactFlow viewport using `attachRenderer({level:'az'})`; particles drawn along the same server-pair edges (straight lines between node centers via ReactFlow's `useReactFlow().getNode` positions; refused particles burst red at target), server node health tint (pass health via node data — extend WorldServerNodeData additively with `health?: HealthState`, danger/warning border tint) and a live `cpu%` line on chips from ServerMetrics.
Live smoke: particles visibly flow on a running world; breaking a path shows red bursts; screenshots.

### T15 — Scrubber v2 + inspector v2  [sonnet + live smoke]
Files: ScrubberV2.tsx (bottom bar when replay frames exist and sim stopped: timeline of healthScore minima, drag to scrub → views read `scrubBatch` from store — store gains `scrubIndex: number | null`, views prefer `scrubBatch ?? latestBatch`), InspectorV2.tsx (AZ-view overlay listing `getTracedRequests` for current scope; click → hop table with latencies/outcomes).
Live smoke: run 60s, stop, scrub back to an outage moment, see red state; open a trace.

### T16 — Cost model v2 + Cost tab  [sonnet]
Files: src/lib/costModelV2.ts + test, CostTab.tsx (WorldPanel tab: monthly total; per-region and per-AZ rows; egress line-items from live byte rates).
Interfaces: `computeWorldCost(doc: WorldDoc, world: WorldMetrics | null): { monthlyUsd: number; byRegion: { regionId, monthlyUsd }[]; byAz: { azId, monthlyUsd }[]; egress: { crossAzUsd, crossRegionUsd, internetUsd } }` — servers×hourlyUsd×730 + managed via existing `cloudRegistry` specs (instanceHourly defaults; skip request-based components in Phase 2, documented) + egress GB/mo from bytes/sec×2.63M sec (spec decision 8 rates).
Tests: fixture math exact; null metrics → egress 0; managed pricing pulled from registry.

### T17 — Legacy engine + UI deletion  [sonnet]
Same discipline as Phase 1 Task 9: grep-enumerate importers of the deletion list (skeleton file-structure block), `git rm` the legacy trees (canvas/, simulation/, sidebar/, toolbar/, dock/, analytics/, reports/, StatusBar, legacy stores incl. replay/metricsHistory/costHistory/canvas.store, costModel v1, scalescript, terraform, vault, old engine tests), fix stragglers (App.module.css references, ui.store legacy fields — keep themeMode + highlight fields used by world UI... verify by grep), keep the survivors list from spec decision 10. Verify: reference grep prints nothing, `npm run build` + `npx vitest run` green, live smoke still works. This task runs AFTER T13–T16 so nothing mounted references legacy code.

### T18 — Perf benchmark + degradation + final verify  [sonnet]
Files: bench script (plain vitest test with generous timeout, tagged `bench.test.ts`): build synthetic world (6 regions × 3 AZ × 12 servers × ~9 instances ≈ 2000 instances via factories), run 100 facade steps headless, assert mean step ≤4ms (CI-tolerant: fail only >8ms, warn 4–8 via console — documented); degradation: facade watches rolling mean step cost, >4ms for 3s → stepMs 100→200 + `engine_degraded` info event + store flag; SimControls shows amber "degraded tick" chip. Boundaries doc final update (§J engine section). Full suite + build + complete live smoke checklist (author→simulate→failover with TTL lag visible→scrub→trace→cost tab→save/reload).

## Fragment writer instructions (controller will include per dispatch)

Write COMPLETE plan sections in Phase-1-plan format: every step has real code (full file bodies for new files; exact before/after for edits), failing-test-first ordering, exact `npx vitest run` commands with expected counts, and a commit step with exact message. No placeholders, no "similar to task N" — repeat code. Signatures/types MUST match this skeleton and the contracts doc exactly — if a signature seems wrong while writing, note it in a "SKELETON CONCERNS" comment at the top of your fragment instead of changing it.
