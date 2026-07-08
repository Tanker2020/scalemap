# World Model & Multi-Scale Geolocational Simulation — Design

**Date:** 2026-07-08
**Status:** Approved by user (brainstorming session, all sections individually approved)
**Scope:** Umbrella design for the ground-up rebuild of Scalemap around a unified world
model — globe → region → AZ → server — with servers/services as the simulation substrate.
Each phase below gets its own follow-up spec + implementation plan; this document is the
source of truth they must not contradict.

Visual direction was locked interactively via mockups; they persist in
`.superpowers/brainstorm/67932-1783491623/content/` (`views-overview-v2.html`,
`serverview-hybrid-v3.html` are the approved versions).

---

## 1. Summary & goals

Scalemap today simulates one abstract system diagram on a single canvas. This rebuild makes
the unit of simulation a **world**: client populations on a 3D globe send traffic to
**regions**, each region contains **availability zones**, each AZ contains **servers**
(dedicated or VPS) and managed services, and each server runs **service instances** (bare
processes or docker-compose containers) that consume real host resources behind enforced
firewalls and docker networks. The user zooms through four levels; the simulation is the
same one everywhere, viewed at different scales.

Goals, in the user's terms:

- Zoom from a semi-realistic globe into a region, into an AZ, into a single server's
  interior, with each level visually rich (realistic rack chassis, "living circuit board"
  server view).
- Everything reasonable is configurable and realistically simulated: server types,
  cores/threads, RAM, ports, firewalls, docker networks/volumes, routing policies, health
  checks, failover, cross-AZ latency, geo-routed client traffic.
- Misconfiguration is a first-class failure mode (blocked paths refuse connections).
- A rebuilt analysis system (deterministic rules + optional LLM reviewer) replaces the
  linter.

Non-goals for this project (parked, revisit after Phase 6): k8s/ECS schedulers, ScaleScript
v2, Terraform export v2, AI watch-mode/agentic loop, spot/preemptible instances,
pseudo-internals for managed services.

## 2. Decisions of record

Each of these was an explicit user choice during brainstorming:

| # | Decision |
|---|---|
| D1 | **Rebuild around a new world model.** The existing canvas becomes one renderer of it; no wrapper/legacy mode. |
| D2 | **Clean break on files.** `.scalemap` v2 (`{ "version": "2", "world": … }`); v1 files are rejected with a clear error. Vault templates rebuilt as worlds. |
| D3 | **Blueprint + placements authoring.** Design a service blueprint once; place instances into AZs/servers with count and role. No per-AZ hand-drawing, no copy-link stamps. |
| D4 | **Bottom-up simulation substrate.** Service instances on servers are what the engine ticks; AZ/region/globe metrics are aggregations. Not generated detail, not a two-tier sim. |
| D5 | **3D globe only; all other levels 2D.** react-three-fiber globe with real NASA Blue Marble / Black Marble textures + atmosphere shader (semi-realistic, asset-swappable). Region/AZ/server views are DOM/SVG/React Flow. |
| D6 | **Four levels:** globe → region page → AZ canvas → server interior. Racks are a *node style* in the AZ canvas (rack frame group + chassis nodes), not a separate level. |
| D7 | **Traffic = auto baseline + custom markers.** Built-in world-population ambient traffic (toggleable) plus user-placed client populations (lat/lon, RPS, diurnal curve). |
| D8 | **Full routing/failover policy control.** Per-world policy: latency-based / geo / weighted / priority-failover; health checks with configurable interval + threshold; DNS TTL lag simulated per client population; active-active or active-passive per region; manual AZ/region outage triggers. |
| D9 | **Full host-model realism.** Dedicated = exclusive, predictable. VPS = slice of an oversubscribed host: noisy-neighbor CPU steal (configurable oversubscription ratio), burstable credits (t3-style), rare host-level failure events. Cloud instances = managed-VPS presets from a per-provider catalog. No spot instances (parked). |
| D10 | **Fully enforced networking.** Firewall rules (allow/deny by port/protocol/source), service port bindings, docker networks, and volumes gate simulated traffic. A blueprint edge only carries traffic if the whole compiled path permits it; otherwise requests fail with `connection_refused` events and the analysis engine flags the mismatch statically. |
| D11 | **Runtimes phase 1:** bare processes + docker-compose stacks (networks/volumes/port mappings enforced). k8s/ECS return later as schedulers that place pods onto servers. |
| D12 | **Managed services stay abstract** (RDS, S3, SQS, Lambda, CDN, API GW…): placeable at region or AZ scope, current-fidelity simulation (capacity/latency/breaker/cost), endpoints participate in firewall rules. No fake internals. |
| D13 | **Must survive from first usable rebuild:** particle visuals, replay/scrubbing, request inspector, metrics history, cost model. **Temporarily regress:** ScaleScript, Terraform export. **Deleted and replaced:** structural linter → Analysis system (§7). |
| D14 | **LLM reviewer:** BYO OpenAI-compatible endpoint (base URL + API key + model name), on-demand button, structured JSON findings, key stored locally via Tauri, never in diagram files. |
| D15 | **Build order: depth-first.** Model+shell → substrate engine → server view → region/AZ views → globe → analysis+AI. |
| D16 | **Engine architecture: compiled world graph + single headless engine** (see §4). Rejected: federated per-AZ engines (consistency/replay complexity without needed scale), extending the current node engine (can't meet D4). |

## 3. World data model

New `world.store.ts` (Zustand) replaces `canvas.store.ts` as the document's source of
truth. Normalized maps keyed by id — like a small database; renderers select slices.

Entities (fields indicative, exact TS types defined in the Phase-1 spec):

- **World** — routing policy (D8 fields), traffic settings (auto-baseline on/off + scale,
  client populations), provider default, settings.
- **ClientPopulation** — id, label, lat/lon, peak RPS, diurnal curve, packet-mix reference.
- **Region** — catalog id from `WORLD_REGIONS` (extended with lat/lon per region for globe
  pins), active-active/active-passive role, contains AZ ids.
- **AvailabilityZone** — id, label (e.g. `us-east-1a`), parent region.
- **Server** — parent AZ; kind `dedicated | vps`; specs (vCPU count, threads/core, RAM,
  disk GB, NIC Mbps) from an **instance catalog** (per-provider presets incl. cloud
  instance types-as-managed-VPS) or custom; VPS-only: oversubscription ratio, burst-credit
  config; firewall rule list; compose stacks (name, networks with CIDRs, volumes with
  sizes); rack position (rack id + U slot, for AZ-canvas rendering); hourly price.
- **ServiceBlueprint** — logical service ("api", "postgres-primary"): workload profile
  (extends the existing `computeProfile`/`workload` model — CPU-ms/request, RAM base +
  per-connection, disk IO profile), ports it binds (port, protocol, public/internal),
  **dependency edges to other blueprints / managed services** (protocol, packet template
  id — the packet Flyweight registry survives unchanged), stateful flag + volume
  requirement.
- **Placement** — blueprint → server; count; role (`primary | replica | canary`); runtime
  (`process` | `container` + stack/network membership + port mappings + cpu/mem limits).
- **ManagedService** — node type from today's catalog, placed at region or AZ scope,
  provider mapping, sim config (current fidelity), endpoint port for firewall purposes.

**`compileWorld(world) → CompiledWorld`** — pure function, the heart of the design:

- Expands blueprints × placements into concrete **service instances** with ids, host
  bindings, resolved endpoints.
- Resolves every blueprint dependency edge into instance-level **paths** and verdicts:
  permitted (with hop latency class: localhost / same-AZ / cross-AZ / cross-region /
  internet) or **blocked** (which firewall rule / missing port binding / docker network
  isolation caused it).
- Produces routing tables: per-population region choices under each policy, region→AZ LB
  spread, AZ→instance targets, failover successor lists.
- Emits **static findings** consumed by both the engine (refuse connections at runtime)
  and the Analysis system (warn before running).

Golden-tested: world fixture in → compiled graph + findings out. Every enforcement rule
gets a fixture pair (permitted/blocked).

**File format v2:** `{ version: "2", meta, world: { …entities }, packets, viewState }`.
`serializer.ts` rewritten; loading v1 shows "This file predates the world model" with no
migration path (D2). Undo/redo: same immutable snapshot pattern as today, snapshotting the
world store.

## 4. Simulation engine (`worldEngine/`)

Single headless engine ticking the whole compiled world, always, at every level (D16).
Rendering is detached: each view *attaches* and draws only its scope. Replaces
`particleEngine.ts`; **ports, not rewrites**: `compute.ts` pure math, circuit breakers,
backpressure, chaos, deterministic-RNG test setup all carry over generalized from per-node
to per-service-instance.

Subsystems:

- **Host scheduler.** Per server: instances demand CPU-time (workload model) and RAM.
  CPU over-demand ⇒ queuing latency inflation per instance; RAM exhaustion ⇒ OOM-kill of
  the worst offender (respecting container mem limits first), crash + restart cycle
  (extends the existing `_forcedDownUntil` OOM-lock mechanism). VPS adds noisy-neighbor
  steal (stochastic co-tenant load scaled by oversubscription ratio) and burst credits
  (sustained load above baseline drains credits, then throttles). Dedicated hosts have
  neither.
- **Network path model.** Hops only along compiled permitted paths; blocked path ⇒
  `connection_refused` event + caller error. Latency per hop class: localhost ≈0.1ms,
  same-AZ ≈0.5ms, cross-AZ 1–2ms, cross-region from `regionConfig.ts` tables (jittered),
  client→region from great-circle distance. NIC Mbps caps effective throughput for
  payload-heavy/stream traffic.
- **Traffic + global routing.** Client populations (D7) generate demand on diurnal curves;
  a simulated DNS/global-LB layer resolves each population's target region per policy (D8)
  with health-check state and a per-population TTL cache — failover exhibits real TTL lag.
  Region LB spreads across healthy AZs; AZ LB across instances (ports the existing
  `lbRouting.ts` semantics).
- **Failure machinery.** Health checks on configured intervals/thresholds; manual outage
  switches at server/AZ/region granularity; failover + recovery cascades per policy;
  replica promotion for stateful placements (role from D3).
- **Metrics pyramid.** Instance → server (per-core, RAM strata by service, NIC, disk) →
  AZ → region → world aggregations, EMA-smoothed, batched to `simulation.store` at the
  same cadence as today. Replay ring buffer becomes scope-aware (world-level snapshot with
  per-scope drill-down). Request inspector follows a request across all hops incl.
  cross-region.

**Perf budget (hard constraints):** tick ≤4ms at ~2,000 service instances on a mid-tier
Mac; rendered particles capped per view (globe arcs ≤200, AZ same cap as today, server
traces ≤50); metrics at 1Hz. Over budget ⇒ degrade tick rate first, announce in UI, never
silently drop fidelity.

## 5. Views & navigation

Approved mockups: `views-overview-v2.html` (globe, region, rack), `serverview-hybrid-v3.html`
(server interior). These are binding for visual direction.

- **Navigation shell.** Persistent breadcrumb (`🌍 World › us-east-1 › us-east-1a › web-03`),
  click any ancestor to jump; Esc = up one level; framer-motion zoom transitions;
  `prefers-reduced-motion` = crossfades. View state (current level + focus id) lives in
  `ui.store` and serializes into `viewState`.
- **Globe (Level 1).** react-three-fiber sphere, NASA Blue Marble/Black Marble textures
  (public domain, bundled), atmosphere shader, slow idle rotation. Region pins glow by
  health (pulse on failover); client populations as teal markers; live traffic as animated
  great-circle arcs (red drain arcs during failover). Click pin → region.
- **Region page (Level 2).** A left-to-right flow story: global-edge inbound (rps +
  sparkline) → animated split lines with per-AZ percentages → AZ rows (composite health
  ring, per-server clickable strips, rps/p50/err/$) → cross-AZ column (inter-AZ latency,
  replication links + lag, dead links). One alert ribbon at top; no scattered badges.
  Manual AZ outage switch lives here.
- **AZ canvas (Level 3).** React Flow, current interaction model preserved (selection,
  properties, particles on edges, simulation edit-lock). Physical servers render as
  **realistic rack chassis** stacked in per-rack frame groups: side rails with mounting
  holes, U-height from instance size, drive-bay LEDs, vent grills, pwr/act/net status
  LEDs, live cpu/ram/io micro-bars, blank-U fillers and a PDU strip. Managed services keep
  a distinct dashed style. Click chassis → server interior.
- **Server interior (Level 4).** "Living circuit board" + HUD inspector rail:
  - Dark PCB stage: NIC edge connector → **firewall gate arch** (packets visibly pass
    through; blocked packets burst red with the refusing rule) → service chips → docker
    stacks as raised platform plates (network label, contained container chips, volume
    cylinders wired to disk).
  - Packets on traces ARE the engine's particles rendered at server scope.
  - **Unified hardware platform** (one raised plate): CPU die inside a live utilization
    ring (hatched amber segment = VPS steal), per-core cells with heat bloom; RAM as a
    stratified reservoir — one colored stratum per service; disk as a sliced platter
    (volume slices, sweeping io scanner).
  - **Service signature colors** bind the scene: a service's chip tab, RAM stratum, core
    share, and disk slice share one hue; hovering any element highlights its counterparts.
  - Inspector rail (HUD-styled): click any chip/trace/port/rule/core/volume to inspect and
    edit (limits, runtime, firewall rules, workload profile).

## 6. Cost model

Kept live from Phase 2 (D13). Server-aware: hourly pricing per instance-catalog entry
(dedicated/VPS/cloud presets per provider) + existing managed-service pricing. Egress
computed from actually-simulated flows, now including **billable cross-AZ transfer** and
tiered internet egress. `CostTracker` gains region × AZ breakdown; region page shows
per-AZ $/mo.

## 7. Analysis system (replaces linter) + LLM review

Old `src/lib/lint/*` and `DiagnosticsPanel` deleted in Phase 1 (D13).

**Layer 1 — deterministic rules** over the *compiled* graph (see what the engine sees).
One pure function per rule in a registry array (same contribution pattern as today). Three
families:

1. *Structural:* world-aware SPOFs (single AZ in region, no failover region, primary+all
   replicas in one AZ), cycles, deep sync chains, orphan queues.
2. *Network/security:* blueprint edge over a blocked path, bound-but-firewalled port, DB
   port exposed to internet, wrong docker network, stateful container without a volume.
3. *Capacity/geo:* host RAM oversubscribed by limits, sustained load on burstable VPS,
   population routed across an ocean when a nearer healthy region exists, health-check
   interval incompatible with failover expectations.

Findings: severity, affected entity ids (clickable at every level), why + fix body.

**Layer 2 — LLM reviewer** (D14). Settings: base URL, API key, model (OpenAI-compatible —
OpenAI, Anthropic, OpenRouter, Ollama, LM Studio…). Key stored via Tauri local store; never
serialized into `.scalemap`. On-demand "Review architecture": sends serialized world +
aggregated last-run metrics + Layer-1 findings (dedup context). Response forced to JSON
schema `{ issues: [{ title, severity, confidence, affected, reasoning, recommendation,
estimated_effort }] }`; malformed ⇒ one retry then graceful error. Rendered as `AI`-tagged
cards beside deterministic findings. Offline/unconfigured ⇒ Layer 1 only.

## 8. Testing strategy

- `compileWorld`: golden tests (fixtures in `src/lib/world/__fixtures__/`), one pair per
  enforcement rule.
- Engine subsystems: seeded-RNG vitest suites per subsystem (host scheduler, routing/TTL,
  failover, NIC caps), continuing the existing `vitest.setup.ts` mulberry32 pattern.
- Analysis: one test file per rule family.
- Views: Playwright smoke pass per level per phase; visual budget checks (fps probe) for
  globe and server view.

## 9. Phasing

Each phase = its own spec → plan → implementation cycle referencing this document.

| Phase | Delivers | Notes |
|---|---|---|
| 1 | World model, `compileWorld` + golden tests, `.scalemap` v2, navigation shell, authoring panels, static AZ canvas | Linter + old data model deleted here. App not usable for simulation until Phase 2 — accepted consequence of the clean break. |
| 2 | `worldEngine/` complete (host scheduler, network paths, traffic/routing/failover, metrics, replay), AZ-scope particles, cost model v2 | Sim visuals + cost return here and must not regress afterward (D13). |
| 3 | Server interior view (circuit board + HUD inspector + hardware platform + service colors), server/service config editing | |
| 4 | Region flow page, rack frames + chassis nodes, inter-AZ links, outage switches, failover timeline | |
| 5 | r3f globe (textures, atmosphere, pins, arcs, populations), auto-baseline traffic, world-level controls | Adds `three`/`@react-three/fiber`/`@react-three/drei` deps. |
| 6 | Analysis rule engine (3 families) + panel, LLM reviewer + settings | |

Parked after Phase 6: k8s/ECS schedulers, ScaleScript v2, Terraform v2, AI watch-mode,
spot instances, managed-service pseudo-internals.

Every phase updates `docs/module-boundaries.md` (repo convention).

## 10. Risks & mitigations

- **Engine perf at instance granularity** — mitigated by the ≤4ms/2k-instance budget as an
  explicit Phase-2 acceptance test, headless-metrics-only default, and render caps.
- **Clean break leaves a long dark window** — mitigated by depth-first ordering (engine is
  Phase 2, not Phase 5) and by keeping Phases 1–2 on a branch until the sim-visuals bar
  (D13) is met.
- **Compile-step correctness is load-bearing** (engine routing AND analysis depend on it) —
  mitigated by golden tests as a Phase-1 gate and pure-function isolation.
- **LLM output variability** — schema-forced JSON, validation + single retry, provenance
  tags, graceful degradation.
- **Scope gravity** (every subsystem invites detail) — the parked list is normative; new
  ideas go to it, not into active phases.
