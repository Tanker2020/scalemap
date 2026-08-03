// World engine contracts (FROZEN) — transcribed verbatim from
// docs/superpowers/specs/2026-07-08-world-engine-contracts.md. Do not redefine/reshape;
// additive-optional extension only. Governs every module in src/lib/worldEngine/.
import type {
  InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId, ManagedServiceId,
  CompiledWorld, WorldDoc, PlacementRole,
} from '../world/types'

// ─── Time ────────────────────────────────────────────────────────────────────
// The engine runs a fixed-step simulation clock (default 100ms steps) driven by
// requestAnimationFrame with an accumulator; rendering interpolates between steps.
// All engine timestamps are simMs (milliseconds since engine start), never wall time.

export interface EngineClock {
  simMs: number
  stepMs: number          // fixed step, default 100
  timeScale: number       // 1 = realtime; UI may offer 2x/4x later (engine supports it now)
}

// ─── Health ──────────────────────────────────────────────────────────────────

export type HealthState = 'healthy' | 'degraded' | 'down'

// ─── Per-scope metrics (published at 1 Hz, EMA-smoothed) ─────────────────────

export interface InstanceMetrics {
  instanceId: InstanceId
  rps: number                    // admitted requests/sec
  errorRate: number              // 0..1
  p50Ms: number                  // COMPOSED end-to-end (self + downstream), audit ISSUE-003
  p99Ms: number                  // COMPOSED end-to-end, same basis as p50Ms
  // Additive-optional (contract-drift, audit ISSUE-003), same convention as ManagedServiceMetrics'
  // p50Ms/saturation below: self-only latency (own CPU/queue/NIC time, no downstream hops) —
  // pre-ISSUE-003 semantics, what p50Ms meant before composition. p50Ms/p99Ms above now fold in
  // downstream dependency time, since a caller's Little's-law activeConnections/RAM must grow when
  // a dependency slows down, not just when its own compute does. buildBatch always populates it;
  // a hand-built test fixture or a batch built before this issue landed may omit it — read as
  // `m.serviceP50Ms ?? m.p50Ms`.
  serviceP50Ms?: number
  activeConnections: number
  cpuCoresUsed: number           // e.g. 1.2 = 1.2 cores of demand
  ramMb: number                  // base + per-connection
  health: HealthState
  // Additive-optional (contract-drift, audit ISSUE-005): mean connection-pool checkout wait, ms —
  // populated only for an instance with an authored `WorkloadProfile.maxConnections`; read the
  // same result the host scheduler's RAM/OOM accounting already enforces (hostScheduler.ts's
  // `poolCheckoutFor`), never re-derived, so the two can never disagree about which instances are
  // pool-saturated.
  checkoutWaitMs?: number
  // Additive-optional (contract-drift, FEAT-002/Wave-1 Task 13 fix): the LIVE promotion-aware
  // role — `failover.ts`'s `effectiveRoleResolver(compiled, promotedAt)`, memoized per-step as
  // `index.ts`'s `s.roleResolver` — as opposed to the STATIC authored `ServiceInstance.role` on
  // the compiled world, which never changes at runtime. A partition-induced promotion only
  // mutates `state.failover.promotedAt`; without this field, nothing published to the metrics
  // batch could ever see a live promotion, so `analysis/rules/structural.ts`'s `split-brain-risk`
  // rule (which reads `lastBatch.instances[id].effectiveRole ?? compiled.instances[id].role`)
  // could only ever fire on a hand-authored double-primary, never a genuine live split-brain.
  // Absent ⇒ callers fall back to the compiled role, so every existing direct-`buildBatch`
  // caller/test is unchanged by omission.
  effectiveRole?: PlacementRole
}

export interface ServerMetrics {
  serverId: ServerId
  // One entry per vCPU, 0..1 utilization. Phase 3's CPU die reads this directly.
  coreUtilization: number[]
  // VPS only: fraction of CPU stolen by co-tenants this second (0 on dedicated).
  stealFraction: number
  // Burstable VPS only: 0..1 credit balance; null when not burstable.
  burstCredits: number | null
  // RAM strata by instance — Phase 3's reservoir renders these slices in order.
  ramByInstance: { instanceId: InstanceId; blueprintId: BlueprintId; ramMb: number }[]
  ramUsedMb: number
  ramTotalMb: number
  nicInMbps: number
  nicOutMbps: number
  diskIoFraction: number         // 0..1
  health: HealthState
}

export interface AzMetrics {
  azId: AzId
  rps: number
  errorRate: number
  p50Ms: number
  healthScore: number            // 0..100 composite — Phase 4's health ring reads this
  health: HealthState
  serverCount: number
  instanceCount: number
  // Additive (contract-drift): undeliverable inbound rps the LB routed to this AZ but couldn't
  // serve — cross-zone-off forfeiture (no target instance in this AZ), an empty target group, or
  // all instances down. A real cross-zone-off NLB fails these connections; surfaced here instead
  // of vanishing. Absent on pre-existing serialized batches (there is no batch persistence) —
  // consumers default to 0.
  droppedRps?: number
}

export interface RegionMetrics {
  regionId: RegionId
  rps: number
  errorRate: number
  p50Ms: number
  healthScore: number
  health: HealthState
  // Live inbound share per population routed here (Phase 4 split-lines, Phase 5 arcs).
  inboundByPopulation: { populationId: PopulationId; rps: number }[]
  // Additive (contract-drift): Σ of this region's AZ droppedRps — undeliverable inbound folded
  // into the region's health error rate too, so a region dropping traffic degrades. Default 0.
  droppedRps?: number
}

export interface WorldMetrics {
  totalRps: number
  errorRate: number
  // Per-population → current target region + rps (Phase 5 arc rendering).
  populationRoutes: { populationId: PopulationId; regionId: RegionId; rps: number }[]
  // Cross-scope transfer accounting for cost v2 (bytes/sec, EMA).
  crossAzBytesPerSec: number
  crossRegionBytesPerSec: number
  internetEgressBytesPerSec: number
}

// Live traffic REACHING a cloud-managed service (node-model Phase 5.1). Managed services have no
// instance/server, so they never appeared in the pyramid above — yet the flow solver routes real
// rps to them (InstanceFlow.downstream[].toManagedServiceId). This surfaces that received load so
// the AZ floor / region view can show it. Managed services stay black boxes: this is traffic
// INTO them, not a simulated internal engine.
export interface ManagedServiceMetrics {
  managedServiceId: ManagedServiceId
  rps: number          // admitted requests/sec reaching it (EMA-smoothed, summed across callers)
  refusedRps: number   // over-ceiling requests/sec throttled away (EMA)
  utilization: number  // 0..1 offered ÷ ceiling (DB class or the flat per-type ceiling); 0 if uncapped
  health: HealthState  // banded off refusal + utilization; reuses the LED colour language
  // Served bytes/sec for a storage/CDN service (node-model Phase 5.2) — its egress, priced
  // per-service in the cost model against its provider schedule + storage free allowance. 0 for
  // non-storage types (their transfer stays in the world cross-zone buckets).
  egressBytesPerSec: number
  // ── Managed-DB failure-model gauges (node-model Phase 5.4) ────────────────
  // Additive-optional (frozen-contract rule): buildBatch always populates them, but older/test-built
  // batches may omit them — read as `m.p50Ms ?? 0`. Populated only for capacity-modelled DBs
  // (managedDbRuntime.ts); 0 for every other managed type. See contract-drift.md §PHASE 5.4.
  saturation?: number   // 0..1+ on the BINDING axis (max of write/read utilization), pre-refusal
  p50Ms?: number        // effective service latency under load — base / (1 − saturation)
  p99Ms?: number
  connections?: number  // live connections ≈ admitted rps × latency (Little's law) vs maxConnections
  errorRps?: number     // requests/sec failing on queryTimeoutMs — the SOFT failure, distinct from
                        // refusedRps (throughput/connection throttling)
}

// Live event-broker state for one topic (audit ISSUE-002) — a topic is identified by its
// dependency id (this schema has no separate "Topic" entity). Surfaces the async decoupling
// worldEngine/broker.ts models: how far behind the consumer is (lagSec), how deep the backlog is,
// and the two failure modes (dropRps — retention-cap overflow, DLQ-rate — exhausted redeliveries).
export interface TopicMetrics {
  totalArrivalRps: number
  backlogCount: number
  drainRps: number
  lagSec: number
  dropRps: number
  redeliverRps: number
  dlqRps: number
}

export interface MetricsBatch {
  simMs: number
  instances: Record<InstanceId, InstanceMetrics>
  servers: Record<ServerId, ServerMetrics>
  azs: Record<AzId, AzMetrics>
  regions: Record<RegionId, RegionMetrics>
  world: WorldMetrics
  // Additive-optional (frozen-contract rule): buildBatch always populates it, but older/test-built
  // batches may omit it — read as `batch.managedServices?.[id]`. See contract-drift.md §PHASE 5.1.
  managedServices?: Record<ManagedServiceId, ManagedServiceMetrics>
  // Additive-optional (frozen-contract rule), keyed by dependency id. buildBatch always populates
  // it when the world has event dependencies; older/test-built batches may omit it — read as
  // `batch.topics?.[dependencyId]`. See contract-drift.md §ISSUE-002.
  topics?: Record<string, TopicMetrics>
  // Additive-optional (frozen-contract rule): count of operator-injected faults (`FaultState.active.
  // size`) active when this batch was built — lets the analysis engine explain observed degradation
  // as intentional rather than architectural. See contract-drift.md §Task 7.
  activeFaultCount?: number
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type EngineEventKind =
  | 'connection_refused'         // blocked path attempted (carries blockReason kind in message)
  | 'oom_kill'                   // instance killed by host RAM pressure
  | 'instance_restarted'
  | 'noisy_neighbor'             // VPS steal spike started
  | 'burst_credits_exhausted'
  | 'breaker_open' | 'breaker_half_open' | 'breaker_closed'
  | 'health_check_failed'
  | 'failover_started'           // population/AZ traffic moving (carries from/to in affected)
  | 'failover_completed'
  | 'ttl_lag_expired'            // a population's DNS cache expired and re-resolved
  | 'replica_promoted'
  | 'primary_failback'           // recovered authored primary reclaimed the role (audit ISSUE-007)
  | 'outage_triggered' | 'outage_cleared'   // manual switches
  | 'fault_injected' | 'fault_cleared'   // FEAT-001 fault-kind spec (down/latency-add/cpu-brownout/memory-leak/error-inject)
  | 'engine_degraded'            // perf watch halved the step rate (spec decision 9); info severity
  // Audit ISSUE-010: silent fan-out truncation, surfaced. Both were previously invisible — an
  // instance past MAX_DEPTH reports zero traffic/cost/findings for whatever it would have called,
  // reading as "healthy" rather than "unmodeled"; a cyclic dependency's row into the target IS
  // recorded (unchanged) but nothing marked that the re-entry was cut instead of followed.
  | 'chain_depth_exceeded'       // dependency chain hit MAX_DEPTH and stopped fanning out further
  | 'chain_cycle_cut'            // BFS cycle guard stopped re-queueing into an ancestor instance
  | 'partition_started' | 'partition_healed'   // FEAT-002 network partition added/removed
  | 'scenario_step_applied'      // FEAT-003 scenario timeline: a step's action fired at its atMs

export interface EngineEvent {
  id: string
  simMs: number
  kind: EngineEventKind
  severity: 'info' | 'warning' | 'critical'
  message: string
  // Entity ids at any scope (instanceId/serverId/azId/regionId/populationId).
  affected: string[]
}

// ─── Render attachment (headless engine; views subscribe per scope) ─────────
// A view calls attachRenderer for its scope; the engine invokes onFrame every
// animation frame with ONLY that scope's visual payload. Detach on unmount.
// Budgets (plan Global Constraints): az ≤ current particle cap, server ≤ 50 traces,
// globe ≤ 200 arcs. The engine enforces the caps, not the view.

export type RenderScope =
  | { level: 'globe' }
  | { level: 'region'; regionId: RegionId }
  | { level: 'az'; azId: AzId }
  | { level: 'server'; serverId: ServerId }

export interface VisualParticle {
  id: number
  // Path endpoints as entity ids; the VIEW owns geometry (screen positions).
  // Id vocabulary is scope-specific (additive clarification 2026-07-09, for Phase 3):
  //   az scope:     serverId | managedServiceId | 'edge:<populationId>'
  //   server scope: resident instanceId | 'nic:<serverId>' (every off-server endpoint —
  //                 inbound clients, remote servers, managed services — collapses to the
  //                 NIC; the view routes nic-originated traffic through the firewall gate)
  fromId: string
  toId: string
  progress: number               // 0..1 along the view's path for this pair
  protocol: 'http' | 'db' | 'event' | 'stream'
  blocked: boolean               // render as refused burst at gate/target
  colorHint: string | null       // blueprint signature color, or the bound packet's colorOverride
  // Which library packet this particle represents, when the hop has a packet mix bound
  // (null on entry particles, unbound hops, and every pre-packet-library frame). Additive —
  // logged in .superpowers/sdd/contract-drift.md. Chosen by an index-based weighted round-robin
  // (packetResolve's pickPacketByIndex), NEVER by rng: particles are rebuilt at wall-clock frame
  // rate, so drawing here would make the seeded stream depend on frame rate and break replay.
  packetId?: number | null
}

export interface VisualArc {                 // globe scope
  fromLatLon: [number, number]
  toLatLon: [number, number]
  intensity: number              // 0..1, scaled by rps share
  kind: 'client' | 'inter-region' | 'drain'
}

export interface FramePayload {
  simMs: number
  particles: VisualParticle[]    // az/server/region scopes
  arcs: VisualArc[]              // globe scope only, else []
}

// Render cap on globe arcs — part of the render-payload contract (additive, audit ISSUE-050:
// it lives HERE, not in index.ts, so view code sizing its arc pool doesn't pull the engine
// singleton module into its import graph just for a shared constant).
export const MAX_GLOBE_ARCS = 200

export type DetachFn = () => void

// ─── Fault injection (FEAT-001) ──────────────────────────────────────────────

export type FaultKind = 'down' | 'latency-add' | 'cpu-brownout' | 'memory-leak' | 'error-inject'

export type FaultSpec =
  | { kind: 'down' }
  | { kind: 'latency-add'; ms: number }
  | { kind: 'cpu-brownout'; capacityFraction: number }
  | { kind: 'memory-leak'; mbPerMinute: number }
  | { kind: 'error-inject'; errorFraction: number }

export type FaultScope = 'server' | 'az' | 'region' | 'managed'

// ─── Network partitions (FEAT-002) ───────────────────────────────────────────
// A LinkEndpoint names one side of a partitioned link at region/az/server granularity
// (or 'internet' for a population-facing edge). PartitionFault pairs two endpoints with
// an impairment mode; `impairmentFor` (faults.ts) is the pure predicate that resolves a
// concrete from/to identity pair against the active partition list.

export type LinkEndpoint =
  | { kind: 'region'; id: string }
  | { kind: 'az'; id: string }
  | { kind: 'server'; id: string }
  | { kind: 'internet' }

export interface PartitionFault {
  // Stable identity (audit final-review I3, contract-drift.md 2026-08-02): addressing a partition
  // by its array position in FaultState.partitions broke as soon as PartitionsSection's
  // usable-while-running UI could add/heal partitions mid-scenario-run, shifting every later
  // index. Optional at authoring time — an author (UI or ScenarioPanel) may set it explicitly to
  // get a stable handle for a later heal-partition step; faults.ts's addPartition auto-assigns one
  // from its run-scoped counter when absent, so every partition that ever lands in
  // FaultState.partitions carries a real id.
  id?: string
  from: LinkEndpoint
  to: LinkEndpoint
  mode: 'drop' | 'loss' | 'delay'
  lossFraction?: number
  delayMs?: number
  symmetric: boolean
}

// ─── Control API (the engine facade's exported surface) ─────────────────────

export interface EngineCallbacks {
  onMetrics: (batch: MetricsBatch) => void        // 1 Hz
  onEvent: (event: EngineEvent) => void
  onHealthChange: (scope: 'server' | 'az' | 'region', id: string, health: HealthState) => void
}

export interface WorldEngineApi {
  start: (doc: WorldDoc, compiled: CompiledWorld, callbacks: EngineCallbacks) => void
  stop: () => void
  // Resume ticking a run that was halted by stop() WITHOUT rebuilding state — the clock, metrics,
  // and every subsystem continue from where they froze. No-op if never started or already running.
  // (stop() only halts the loop; it preserves state, so a stop→resume pair is a pause/resume.)
  resume: () => void
  isRunning: () => boolean
  setTimeScale: (scale: number) => void
  // Fault injection (spec FEAT-001). setFault(scope, id, null) clears any active fault on that
  // scope/id. Idempotent; emits fault_injected/fault_cleared (or outage_triggered/cleared for
  // the 'down' kind, unchanged from today).
  setFault: (scope: FaultScope, id: string, spec: FaultSpec | null) => void
  // Alias for setFault(scope, id, down ? { kind: 'down' } : null) — kept so no existing caller
  // breaks. New code should prefer setFault.
  setOutage: (scope: FaultScope, id: string, down: boolean) => void
  // Network partitions (FEAT-002). Minimal facade surface added ahead of Task 13 (which owns the
  // full partition-authoring UI wiring) so Task 12's directional-health test can drive a real
  // partition through the engine instead of poking at internal state. Task 13 should extend this
  // surface (e.g. list/inspect active partitions), not duplicate it.
  setPartition: (fault: PartitionFault) => void
  // Removes the partition matching `id` (audit final-review I3 — was index-based; a no-op if the
  // id is unknown/already healed, rather than throwing). Every partition that reaches
  // FaultState.partitions carries an id (author-supplied or auto-assigned by addPartition), so
  // this always has a real identity to match against, immune to any authored/healed partition
  // shifting another's array position.
  healPartition: (id: string) => void
  attachRenderer: (scope: RenderScope, onFrame: (p: FramePayload) => void) => DetachFn
  // Replay: scope-aware 1 Hz snapshots, ring buffer of 300 (5 min).
  getReplayFrames: () => ReplayFrame[]
  // Request inspector: engine samples ≤1 traced request per second per scope.
  getTracedRequests: (scope: RenderScope) => TracedRequest[]
}

export interface ReplayFrame {
  simMs: number
  batch: MetricsBatch            // full pyramid — scrubbing any level reads one frame
  events: EngineEvent[]          // events that occurred within this 1s window
}

export interface TracedRequest {
  id: string
  populationId: PopulationId | null
  hops: {
    fromId: string; toId: string
    hopClass: 'localhost' | 'same-az' | 'cross-az' | 'cross-region' | 'internet'
    latencyMs: number
    outcome: 'ok' | 'refused' | 'error' | 'timeout'
  }[]
  totalMs: number
  outcome: 'ok' | 'refused' | 'error' | 'timeout'
}
