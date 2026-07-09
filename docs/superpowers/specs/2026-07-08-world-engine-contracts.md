# World Engine Contracts (FROZEN)

**Status:** Frozen 2026-07-08. These interfaces bind Phase 2's implementation AND Phases
3–5's plans. Phase 2 implementers: if implementation reveals a contract defect, STOP and
escalate — do not silently reshape. Additive extension (new optional fields) is allowed;
renames and semantic changes are not.

All types live in `src/lib/worldEngine/types.ts` (Phase 2 Task 1 transcribes this file
verbatim). Consumers: the engine itself, `simulation.store` v2, and the render layers of
Phases 3 (server interior), 4 (region view), 5 (globe).

```ts
import type {
  InstanceId, ServerId, AzId, RegionId, PopulationId, BlueprintId,
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

export interface MetricsBatch {
  simMs: number
  instances: Record<InstanceId, InstanceMetrics>
  servers: Record<ServerId, ServerMetrics>
  azs: Record<AzId, AzMetrics>
  regions: Record<RegionId, RegionMetrics>
  world: WorldMetrics
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
  fromId: string                 // serverId | managedServiceId | 'edge:<populationId>'
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
  isRunning: () => boolean
  setTimeScale: (scale: number) => void
  // Manual failure switches (spec D8). Idempotent; emit outage_triggered/cleared.
  setOutage: (scope: 'server' | 'az' | 'region', id: string, down: boolean) => void
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
```

## Store publication (simulation.store v2)

`src/app/store/simulation.store.ts` is REWRITTEN in Phase 2 (old shape retired with the
legacy engine) to hold at minimum: `running`, `timeScale`, `latestBatch: MetricsBatch | null`,
`events: EngineEvent[]` (ring, 500), `healthOverrides` (manual outages), and actions
mirroring `WorldEngineApi` control calls. Additive fields serving Phase-2 UI (e.g.
`scrubIndex`, `degraded`) are sanctioned; reshaping or renaming the listed fields is not. Views never import the engine directly for
state — they read this store; only control actions call the facade.

## Determinism

The engine uses one seeded PRNG (mulberry32, seed configurable, default fixed) for ALL
stochastic draws (latency sampling, noisy-neighbor onsets, diurnal jitter). Tests may
reseed per-case. `Math.random` is never called inside `src/lib/worldEngine/`.

## What Phases 3–5 may rely on

- Phase 3 (server interior): `ServerMetrics` (coreUtilization array order = vCPU index,
  ramByInstance slice order stable), `attachRenderer({level:'server'})` particles,
  `getTracedRequests`, events filtered by serverId in `affected`.
- Phase 4 (region view): `AzMetrics.healthScore`, `RegionMetrics.inboundByPopulation`,
  failover events, `attachRenderer({level:'region'})`.
- Phase 5 (globe): `WorldMetrics.populationRoutes`, `VisualArc` payloads, outage switches.
- Phase 6 (analysis): `ReplayFrame`s + latest `MetricsBatch` as LLM-review context.
