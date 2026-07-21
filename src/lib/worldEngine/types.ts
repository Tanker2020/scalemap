// World engine contracts (FROZEN) — transcribed verbatim from
// docs/superpowers/specs/2026-07-08-world-engine-contracts.md. Do not redefine/reshape;
// additive-optional extension only. Governs every module in src/lib/worldEngine/.
import type {
  InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId, ManagedServiceId,
  CompiledWorld, WorldDoc,
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
  p50Ms: number
  p99Ms: number
  activeConnections: number
  cpuCoresUsed: number           // e.g. 1.2 = 1.2 cores of demand
  ramMb: number                  // base + per-connection
  health: HealthState
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
  | 'outage_triggered' | 'outage_cleared'   // manual switches
  | 'engine_degraded'            // perf watch halved the step rate (spec decision 9); info severity

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
  colorHint: string | null       // blueprint signature color when known
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

export type DetachFn = () => void

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
  // Manual failure switches (spec D8). Idempotent; emit outage_triggered/cleared.
  setOutage: (scope: 'server' | 'az' | 'region' | 'managed', id: string, down: boolean) => void
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
