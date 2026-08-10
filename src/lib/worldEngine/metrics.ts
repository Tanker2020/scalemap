// The metrics pyramid: per-step accumulation into 1s windows, published as a MetricsBatch
// at 1 Hz with EMA smoothing (α = 0.3, ported legacy constant). Every contract field is
// populated — no field is ever left undefined.
import type {
  MetricsBatch, InstanceMetrics, ServerMetrics, AzMetrics, RegionMetrics, WorldMetrics,
  ManagedServiceMetrics, HealthState, TopicMetrics,
} from './types'
import type { InstanceFlow } from './flows'
// Aliased on import: the local `activeConnections` binding below is the computed VALUE per
// instance, and shadowing the function would make the one-formula invariant unreadable.
import { activeConnections as activeConnectionsOf, KEEP_ALIVE_PROFILE, type ConnectionProfile } from '../connectionModel'
import { managedDbCeilings } from './flows'
import { managedCapacityRps, managedLatencyMs, MANAGED_P99_OVER_P50 } from '../managedCapacity'
import { managedDbEngine } from '../world/types'
import { effectiveHitRatio } from './cache'
import type { ManagedDbRuntime } from '../managedDbRuntime'
import type { TopicRuntime } from './broker'
import type { HostStepResult, WarmingEntry } from './hostScheduler'
import { warmthOf } from './hostScheduler'
import type { NicState } from './networkRuntime'
import type { ReplicaRef } from './replication'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId, ManagedServiceId,
  ServiceInstance, PlacementRole,
} from '../world/types'

const EMA_ALPHA = 0.3
const HEALTH_FACTOR: Record<HealthState, number> = { healthy: 1, degraded: 0.6, down: 0.15 }

// What the facade publishes per server per step from T5's stepVps result (steady fields only).
export interface VpsPublish {
  steal: number
  effectiveVcpuFactor: number
  creditsFraction: number | null
}

// Routing attribution captured by the facade at batch time. Single source for BOTH
// WorldMetrics.populationRoutes and RegionMetrics.inboundByPopulation.
export interface RoutingSnapshot {
  populationRoutes: { populationId: PopulationId; regionId: RegionId; rps: number }[]
}

interface InstanceWindow {
  steps: number
  admittedSum: number
  errorSum: number
  latencies: number[]         // per-step COMPOSED (totalLatencyMs) samples (window-local, sorted at batch)
  // Sum of per-step SELF-only serviceLatencyMs samples (audit ISSUE-003) — a plain windowed mean,
  // EMA'd at buildBatch, mirroring rps/errorRate rather than the multi-second percentile reservoir
  // `latencies` gets: serviceP50Ms is a regression-floor readout (what p50Ms meant before this
  // issue), not a new tail statistic.
  selfLatencySum: number
}

interface ServerWindow { inBytes: number; outBytes: number }

// Received traffic reaching a managed service, summed across every caller's downstream rows and
// windowed like the instance metrics. `steps` counts only steps where it received ≥1 row (matching
// the instance-window convention: an idle-that-step service isn't averaged down toward zero).
// (Phase 5.4) errorSum splits query TIMEOUTS out of refusedSum — both are blocked rows, but a
// timeout means "too slow" and a refusal means "too much", and the UI must not conflate them. The
// runtime sums are the per-step failure-model gauges, averaged over the window like everything else.
interface ManagedWindow {
  steps: number; admittedSum: number; refusedSum: number; errorSum: number
  runtimeSteps: number; latencySum: number; p99Sum: number; connectionsSum: number; saturationSum: number
}

// Rolling latency reservoir width (audit ISSUE-041): percentiles are computed over the last N
// 1 s windows' samples (~10 samples each), not a single window — p99 over ~10 samples was just
// the max. Idle windows contribute their default sample too, so a gone-quiet instance's tail
// still decays over N seconds instead of pinning at its last-busy value.
const LATENCY_RESERVOIR_BATCHES = 3

export interface MetricsState {
  window: Map<InstanceId, InstanceWindow>
  serverWindow: Map<ServerId, ServerWindow>
  managedWindow: Map<ManagedServiceId, ManagedWindow>
  // Undeliverable rps per AZ (cross-zone-off forfeiture etc.): sum of per-step drop RATES over the
  // window ÷ droppedSteps = mean dropped rps, EMA'd into AzMetrics.droppedRps at buildBatch.
  droppedWindow: Map<AzId, number>
  droppedSteps: number
  // FEAT-005 (Task 12): rps-weighted accumulator for InstanceMetrics.staleReadFraction, keyed by
  // the TARGET (replica) instance id — built from the SAME per-row `staleReadFraction` `flows.ts`
  // attached to a DownstreamFlow row (never re-derived from raw lag/writeRps here). Every caller's
  // row landing on the same replica in the same step carries the identical per-instance scalar
  // (FlowInput.staleReadFractionByReplica is per-target, not per-caller), so the rps-weighted mean
  // over the window is just that scalar's own time-weighted average — a straightforward EMA input,
  // not a second computation of the fraction itself.
  staleReadWindow: Map<InstanceId, { fracRpsSum: number; rpsSum: number }>
  // Last few batches' latency samples per instance (audit ISSUE-041) — the percentile reservoir.
  latencyHistory: Map<InstanceId, number[][]>
  // EMA-published values, keyed per entity. Missing key = first window seeds directly.
  published: Map<string, number>
  // Latest step's side-channel values, retained for buildBatch (its skeleton signature
  // does not receive them — see plan Semantics).
  lastHost: Record<ServerId, HostStepResult>
  lastVps: Record<ServerId, VpsPublish>
  lastHealth: (id: string) => HealthState
  // Audit ISSUE-002: the latest step's event-broker runtime, same side-channel pattern as
  // lastHost/lastVps above — published as-is (unsmoothed), not window-averaged, since it's already
  // a one-step-lagged aggregate, not a per-step sample needing a mean.
  lastTopicRuntime: TopicRuntime
}

export function createMetricsState(): MetricsState {
  return {
    window: new Map(),
    serverWindow: new Map(),
    managedWindow: new Map(),
    latencyHistory: new Map(),
    droppedWindow: new Map(),
    droppedSteps: 0,
    staleReadWindow: new Map(),
    published: new Map(),
    lastHost: {},
    lastVps: {},
    lastHealth: () => 'healthy',
    lastTopicRuntime: {},
  }
}

export function accumulateStep(
  state: MetricsState,
  flows: Record<InstanceId, InstanceFlow>,
  hostResults: Record<ServerId, HostStepResult>,
  vps: Record<ServerId, VpsPublish>,
  nic: Record<ServerId, NicState>,
  health: (id: string) => HealthState,
  _simMs: number,
  // This step's managed-DB failure model (node-model Phase 5.4). Optional: absent ⇒ the new gauges
  // stay 0, so existing callers and tests are unchanged.
  managedRuntime?: ManagedDbRuntime,
  // This step's undeliverable rps per AZ (cross-zone-off forfeiture etc.). Optional: absent ⇒
  // droppedRps stays 0.
  droppedByAz?: Record<AzId, number>,
  // This step's event-broker runtime (audit ISSUE-002). Optional: absent ⇒ `topics` stays empty,
  // so existing callers/tests are unchanged.
  topicRt?: TopicRuntime,
): void {
  state.lastTopicRuntime = topicRt ?? {}
  // Per-step drop RATES accumulate into the window; droppedSteps is the divisor for the mean.
  state.droppedSteps++
  if (droppedByAz) {
    for (const [azId, rps] of Object.entries(droppedByAz)) {
      if (rps > 0) state.droppedWindow.set(azId, (state.droppedWindow.get(azId) ?? 0) + rps)
    }
  }
  // Managed-service received traffic THIS step, summed across every caller's downstream rows
  // (a managed service can be a dependency of several instances). Folded into the window below.
  const msAdmitted = new Map<ManagedServiceId, number>()
  const msRefused = new Map<ManagedServiceId, number>()
  const msErrored = new Map<ManagedServiceId, number>()
  for (const f of Object.values(flows)) {
    let w = state.window.get(f.instanceId)
    if (!w) {
      w = { steps: 0, admittedSum: 0, errorSum: 0, latencies: [], selfLatencySum: 0 }
      state.window.set(f.instanceId, w)
    }
    w.steps++
    w.admittedSum += f.admittedRps
    w.errorSum += f.errorRps + f.refusedRps
    // Composed end-to-end latency feeds the published p50/p99/activeConnections (audit ISSUE-003)
    // — self-only serviceLatencyMs is tracked separately below as serviceP50Ms. Fallback to
    // serviceLatencyMs covers hand-built InstanceFlow test fixtures that predate this field.
    w.latencies.push(f.totalLatencyMs ?? f.serviceLatencyMs)
    w.selfLatencySum += f.serviceLatencyMs
    for (const row of f.downstream) {
      // FEAT-005 (Task 12): rps-weighted stale-read accumulation, keyed by the TARGET replica
      // instance — see staleReadWindow's own doc comment. row.staleReadFraction is only ever
      // attached (truthy) when it landed on an effective-role 'replica' instance under nonzero
      // write load/lag (flows.ts's addDownstream), so its mere presence is the "is a replica read"
      // signal — no separate role lookup needed here.
      if (row.toInstanceId && row.staleReadFraction) {
        let sw = state.staleReadWindow.get(row.toInstanceId)
        if (!sw) {
          sw = { fracRpsSum: 0, rpsSum: 0 }
          state.staleReadWindow.set(row.toInstanceId, sw)
        }
        sw.fracRpsSum += row.staleReadFraction * row.rps
        sw.rpsSum += row.rps
      }
      if (!row.toManagedServiceId) continue
      // A blocked managed row is a refusal — EXCEPT a Phase 5.4 timeout row, which reached the
      // service and failed there. Untagged blocked rows stay refusals (pre-5.4 behavior).
      const map = !row.blocked ? msAdmitted : row.failure === 'timeout' ? msErrored : msRefused
      map.set(row.toManagedServiceId, (map.get(row.toManagedServiceId) ?? 0) + row.rps)
    }
  }
  for (const id of new Set([...msAdmitted.keys(), ...msRefused.keys(), ...msErrored.keys(), ...Object.keys(managedRuntime ?? {})])) {
    let mw = state.managedWindow.get(id)
    if (!mw) {
      mw = { steps: 0, admittedSum: 0, refusedSum: 0, errorSum: 0, runtimeSteps: 0, latencySum: 0, p99Sum: 0, connectionsSum: 0, saturationSum: 0 }
      state.managedWindow.set(id, mw)
    }
    // `steps` counts only steps that actually carried a row (audit ISSUE-046): a DB that has a
    // runtime entry but received no traffic this step must not have its windowed rps/refused
    // averaged toward zero — the runtime gauges below keep their own runtimeSteps divisor.
    const receivedRow = msAdmitted.has(id) || msRefused.has(id) || msErrored.has(id)
    if (receivedRow) {
      mw.steps++
      mw.admittedSum += msAdmitted.get(id) ?? 0
      mw.refusedSum += msRefused.get(id) ?? 0
      mw.errorSum += msErrored.get(id) ?? 0
    }
    const rt = managedRuntime?.[id]
    if (rt) {
      mw.runtimeSteps++
      mw.latencySum += rt.p50Ms
      mw.p99Sum += rt.p99Ms
      mw.connectionsSum += rt.connections
      mw.saturationSum += rt.saturation
    }
  }
  for (const [serverId, n] of Object.entries(nic)) {
    let sw = state.serverWindow.get(serverId)
    if (!sw) {
      sw = { inBytes: 0, outBytes: 0 }
      state.serverWindow.set(serverId, sw)
    }
    sw.inBytes += n.inBytesThisStep
    sw.outBytes += n.outBytesThisStep
  }
  state.lastHost = hostResults
  state.lastVps = vps
  state.lastHealth = health
}

// EMA blend; missing previous value seeds directly with the window value.
function ema(state: MetricsState, key: string, windowValue: number): number {
  const prev = state.published.get(key)
  const next = prev === undefined ? windowValue : EMA_ALPHA * windowValue + (1 - EMA_ALPHA) * prev
  state.published.set(key, next)
  return next
}

// Linear-interpolated percentile (audit ISSUE-041) — nearest-rank over a ≤10-sample window made
// p99 literally the max sample and p50 whichever sample sat at index 5. Interpolating between
// ranks is the standard estimator and behaves continuously as the reservoir grows.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = p * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  const frac = rank - lo
  return sorted[lo] * (1 - frac) + sorted[hi] * frac
}

export function buildBatch(
  state: MetricsState,
  doc: WorldDoc,
  compiled: CompiledWorld,
  routingSnapshot: RoutingSnapshot,
  totals: {
    crossAzBytes: number; crossRegionBytes: number; internetBytes: number
    managedEgressBytes?: Record<string, number>
    // FEAT-014 (Task 9): per-NAT-gateway step-window bytes (in+out), the SAME EngineState.
    // windowTotals.natGatewayBytes accumulator index.ts's settleNatGateway loop builds -- never
    // re-derived here. Optional + absent-when-empty, mirroring managedEgressBytes' own
    // convention, so a doc with no NAT gateways leaves this undefined and the published
    // `natGatewayBytesPerSec` field is omitted entirely (regression floor).
    natGatewayBytes?: Record<string, number>
  },
  simMs: number,
  // Instances silent because an UPSTREAM is down (audit ISSUE-014) — published 'degraded'
  // instead of a healthy zero. Optional: absent ⇒ no override (existing callers unchanged).
  // activeConnections need no special drain: the EMA'd rps already decays them exponentially
  // (~70%/s at α=0.3), the keep-alive-drain shape the audit asks for.
  starved?: Set<InstanceId>,
  // Per-instance connection profile for THIS batch (connection semantics). Optional and defaulting
  // to the keep-alive identity, so every existing direct-buildBatch caller/test is unchanged by
  // omission — the same additive-by-omission discipline `starved` and the byte maps already use.
  //
  // CRITICAL: this is one of exactly TWO sites computing active connections; the other is the host
  // scheduler's InstanceLoad in worldEngine/index.ts. Both call connectionModel's
  // activeConnections(). If only one were profile-aware, the RAM the scheduler enforces (and
  // OOM-kills on) would silently diverge from the RAM published here and read by the UI and the
  // `ram-oversubscribed` analysis rule.
  connProfiles?: Record<InstanceId, ConnectionProfile>,
  // Per-instance blended ms/request — cpuMsPerRequest + cpuMsPerKb x kb + handshakeCpuMs — as
  // built by the engine's effectiveCpuMs (worldEngine/index.ts) and fed to the host scheduler's
  // InstanceLoad.cpuMsPerRequest. Publishing cpuCoresUsed off the RAW workload value instead
  // understated a short-lived route's load by its whole handshake term, sitting beside a
  // correctly-sourced coreUtilization on the same server card (audit ISSUE-011). Optional:
  // absent ⇒ the raw workload value, so every existing direct-buildBatch caller is unchanged.
  effectiveCpuMsByInstance?: Record<InstanceId, number>,
  // FEAT-001: per-instance memory-leak accumulator, the SAME map worldEngine/index.ts's
  // InstanceLoad.ramBaseMb already folds in on the enforcement side (s.faults.leakAccumMb) — read
  // here, never re-derived, so the RAM the host scheduler enforces/OOM-kills on can never diverge
  // from the RAM published here and shown in the UI. Optional: absent ⇒ 0 for every instance, so
  // every existing direct-buildBatch caller/test is unchanged by omission.
  leakAccumMb?: Map<InstanceId, number>,
  // Task 7: count of currently-active operator-injected faults (FaultState.active.size), threaded
  // straight through to the published batch for the fault-injected analysis rule. Optional: absent
  // ⇒ defaults to 0 in the batch, so every existing direct-buildBatch caller/test is unchanged.
  activeFaultCount?: number,
  // FEAT-002/Wave-1 Task 13 fix: the SAME memoized effective-role resolver worldEngine/index.ts's
  // step loop already built for flow routing (`failover.ts`'s `effectiveRoleResolver(compiled,
  // promotedAt)`, index.ts's `s.roleResolver`) — never re-derived here, so the promoted-role
  // overlay published to InstanceMetrics.effectiveRole can never disagree with the role the flow
  // solver actually routed writes to this step. Optional: absent ⇒ InstanceMetrics.effectiveRole
  // stays undefined and every existing direct-buildBatch caller/test is unchanged by omission.
  roleOf?: (id: InstanceId) => PlacementRole,
  // FEAT-004: the SAME warm-tracking map the engine's runStep reads via `cacheAsideIndexByDepId`
  // to build `cacheMissFractionByInstance` for the flow solver (worldEngine/index.ts's
  // `EngineState.warmSinceMs`) — never re-derived here, so a cache's published hit ratio can
  // never disagree with the miss fraction the solver actually applied this step. Optional:
  // absent ⇒ cacheHitRatio stays unpublished for every instance, so every existing direct-
  // buildBatch caller/test is unchanged by omission.
  warmSinceMs?: Map<string, number>,
  // FEAT-005 (Task 12): the SAME static replica topology `index.ts`'s step loop already built at
  // start() (`buildReplicationIndexes`'s `replicasByCluster`) — read here only to GROUP
  // `replicationLagByInstance` by cluster id for MetricsBatch.clusters, never to recompute lag.
  // Optional: absent ⇒ `clusters` stays `{}`, so every existing direct-buildBatch caller/test is
  // unchanged by omission.
  replicasByCluster?: Record<string, ReplicaRef[]>,
  // FEAT-005 (Task 12): the SAME `state.replication.lagSecByInstance` map `index.ts`'s step loop
  // reads to build `staleReadFractionByReplica` for THIS step's solveFlows call — never re-derived
  // here, so a cluster's published lagSec can never disagree with the lag the engine actually used
  // to compute this step's stale-read fractions. Optional: absent ⇒ clusters stays `{}`.
  replicationLagByInstance?: Map<InstanceId, number>,
  // FEAT-007 (Task 6): the SAME `EngineState.warmingUntil` map the capacity throttle (Task 4's
  // stepHost water-fill weight) and the latency throttle (Task 5's effectiveCpuMsByInstance)
  // already read via `hostScheduler.ts`'s `warmthOf` — read here, never re-derived, so the
  // published warmth/degraded-health can never disagree with the throttle actually applied this
  // step. Optional: absent ⇒ warmth stays unpublished and health is never lifted for warm-up, so
  // every existing direct-buildBatch caller/test is unchanged by omission.
  warmingUntil?: Map<InstanceId, WarmingEntry>,
  // FEAT-008 (Task 16): the SAME memoized running-set predicate index.ts's step loop already built
  // via `runningSetResolver` (`EngineState.runningSet`) to filter stepHost's `loads` array -- never
  // re-derived here, so a parked instance can never appear in the published `instances` map while
  // simultaneously being excluded from the host scheduler's CPU/RAM accounting (or vice versa).
  // Optional: absent ⇒ every compiled instance is treated as running (the `() => true` identity
  // index.ts itself seeds at start() for a world with no autoscaling authored), so every existing
  // direct-buildBatch caller/test is unchanged by omission.
  runningSet?: (instanceId: InstanceId) => boolean,
  // FEAT-008 (Task 16): the SAME `state.autoscale.desiredCount` map `runningSet` above was resolved
  // from, published verbatim as `MetricsBatch.runningByPlacement` -- never a re-derived count.
  // This matches the actual number of published `instances` entries for that placement in the
  // COMMON case, but NOT during Task 15's ~2s scale-in drain window: `runningSet` (and therefore
  // published `instances`) still counts a draining instance as running, while this desiredCount
  // snapshot already reflects the NEW, lower target -- so a draining placement legitimately shows
  // more published instances than `runningByPlacement` for that window (the UI's "draining"
  // suffix is the intended way to surface exactly that gap, not a bug). Optional: absent ⇒
  // `runningByPlacement` stays undefined (no placement in the world authors `autoscale`), matching
  // the additive-optional-field convention.
  runningByPlacement?: Record<string, number>,
  // FEAT-008 (Task 20): the SAME `state.scaleEventHistory` trimmed-length record `index.ts`'s step
  // loop already built, published verbatim as `MetricsBatch.recentScaleEventCount` -- never a
  // re-derived count, matching runningByPlacement's own divergence-guard discipline above.
  // Optional: absent ⇒ `recentScaleEventCount` stays undefined, so every existing direct-buildBatch
  // caller/test is unchanged by omission.
  recentScaleEventCount?: Record<string, number>,
): MetricsBatch {
  const instances: Record<InstanceId, InstanceMetrics> = {}
  const servers: Record<ServerId, ServerMetrics> = {}
  const azs: Record<AzId, AzMetrics> = {}
  const regions: Record<RegionId, RegionMetrics> = {}

  // Group instances by server/az once (O(instances)) instead of re-filtering the full instance
  // set per server/az inside their loops below (O(servers x instances) / O(azs x instances)) —
  // the same unindexed-lookup regression found and fixed in worldEngine/index.ts's per-step host
  // loop (Task 18 bench). buildBatch runs at 1 Hz, not every step, but at ~2,000-instance scale
  // it was still the largest single contributor to the bench's per-step mean. Order-preserving.
  const instancesByServer = new Map<ServerId, ServiceInstance[]>()
  const instancesByAz = new Map<AzId, ServiceInstance[]>()
  for (const inst of Object.values(compiled.instances)) {
    const bySrv = instancesByServer.get(inst.serverId)
    if (bySrv) bySrv.push(inst); else instancesByServer.set(inst.serverId, [inst])
    const byAz = instancesByAz.get(inst.azId)
    if (byAz) byAz.push(inst); else instancesByAz.set(inst.azId, [inst])
  }

  // ── Instances ──
  for (const inst of Object.values(compiled.instances)) {
    // FEAT-008 (Task 16): a genuinely parked (non-draining) instance is omitted from the published
    // batch entirely -- not just zeroed -- so the UI/analysis rules can't mistake "envelope slot
    // not yet scaled to" for "running but idle". A draining instance still reads running=true here
    // (Task 15's runningSetResolver widens on drainUntilByInstance), so it keeps its entry until the
    // drain window elapses and it actually parks.
    if (runningSet && !runningSet(inst.id)) continue
    const bp = doc.blueprints[inst.blueprintId]
    const w = state.window.get(inst.id) ?? { steps: 1, admittedSum: 0, errorSum: 0, latencies: [0], selfLatencySum: 0 }
    const windowRps = w.admittedSum / Math.max(1, w.steps)
    // Error rate = fraction of offered traffic (admitted + errored/refused) that failed —
    // always in [0,1]; a fully-down instance (admitted 0, errors>0) reports 1.0.
    const windowErrRate = w.admittedSum + w.errorSum > 0 ? w.errorSum / (w.admittedSum + w.errorSum) : 0
    // Rolling multi-second latency reservoir (audit ISSUE-041): percentiles over the last few
    // windows' samples, not one window's ~10.
    let history = state.latencyHistory.get(inst.id)
    if (!history) {
      history = []
      state.latencyHistory.set(inst.id, history)
    }
    history.push(w.latencies)
    if (history.length > LATENCY_RESERVOIR_BATCHES) history.shift()
    const sorted = history.flat().sort((a, b) => a - b)
    const rps = ema(state, `i:${inst.id}:rps`, windowRps)
    const errorRate = ema(state, `i:${inst.id}:err`, windowErrRate)
    const p50Ms = ema(state, `i:${inst.id}:p50`, percentile(sorted, 0.5))
    // p99 is published UN-smoothed (audit ISSUE-037): EMA α=0.3 attenuated a 1 s latency spike
    // to ~30% of its size, hiding exactly the transients a tail metric exists to show. The
    // multi-second reservoir already steadies it; p50 keeps the EMA for stable display.
    const p99Ms = percentile(sorted, 0.99)
    // Self-only p50 (audit ISSUE-003): pre-composition semantics — own CPU/queue/NIC time, no
    // downstream hops folded in. A plain EMA'd window mean, not the multi-second tail reservoir
    // p50Ms/p99Ms use above, since this is a regression-floor readout, not a new tail statistic.
    const serviceP50Ms = ema(state, `i:${inst.id}:selfp50`, w.selfLatencySum / Math.max(1, w.steps))
    // Little's law, parameterized by the instance's connection profile (see connProfiles above).
    // keep-alive ⇒ exactly the historical `rps * (p50Ms / 1000)`.
    const activeConnections = activeConnectionsOf(rps, p50Ms, connProfiles?.[inst.id] ?? KEEP_ALIVE_PROFILE)
    const workload = bp?.workload ?? { cpuMsPerRequest: 0, ramBaseMb: 0, ramPerConnMb: 0, diskIoPerRequest: 0 }
    // Starved override (audit ISSUE-014): an instance silenced by a down upstream must not read
    // as healthy-and-idle. Only lifts 'healthy' to 'degraded' — real degraded/down states win.
    const baseHealth = state.lastHealth(inst.id)
    // Container memory limit, read the SAME way the host scheduler's caller reads it
    // (worldEngine/index.ts's InstanceLoad.memLimitMb) so the two can never disagree about the
    // limit for one instance. hostScheduler clamps its own accounting to this before OOM victim
    // selection; publishing the unclamped value showed a 512 MB-limited container using 900 MB —
    // an impossible reading, on the exact panel a user opens right after an oom_kill event, and
    // one that made the per-server sum of ramByInstance exceed the clamped ramUsedMb beside it
    // (audit ISSUE-012).
    const runtime = doc.placements[inst.placementId]?.runtime
    const memLimitMb = runtime && runtime.type === 'container' ? runtime.memLimitMb : null
    // Pool-checkout wait (audit ISSUE-005), read from the SAME per-instance result the host
    // scheduler already computed and enforced — never re-derived, so the two can never disagree
    // about which instances are pool-saturated. Absent for an instance with no authored
    // maxConnections. The RAM below must shed the SAME checkoutTimeoutErrorFraction the scheduler
    // already applied to its own accounting (hostScheduler.ts's stepHost) — a connection that
    // timed out waiting for the pool never actually landed, so it must not inflate published RAM
    // any more than it inflates the RAM the scheduler enforces/OOM-kills on.
    const checkout = state.lastHost[inst.serverId]?.checkoutByInstance?.[inst.id]
    const checkoutWaitMs = checkout?.checkoutWaitMs
    // FEAT-006 (Task 20): the SAME per-server diskWaitMsByInstance value Task 19 threaded into
    // this instance's composed latency/RAM via extraLatencyMsByServer — published as-is, never
    // re-derived, so this display readout can never disagree with what actually drove p50Ms.
    const diskWaitMs = state.lastHost[inst.serverId]?.diskWaitMsByInstance?.[inst.id]
    const effectiveConnections = checkout ? activeConnections * (1 - checkout.checkoutTimeoutErrorFraction) : activeConnections
    // FEAT-001: fold in the same leak accumulator the enforcement side (worldEngine/index.ts's
    // InstanceLoad.ramBaseMb) already reads — 0 when absent/no leak, byte-identical to pre-FEAT-001.
    const rawRamMb = workload.ramBaseMb + workload.ramPerConnMb * effectiveConnections + (leakAccumMb?.get(inst.id) ?? 0)
    // FEAT-004: published only for a cache instance (blueprint carries cacheConfig), from the
    // SAME warmSinceMs map + effectiveHitRatio the flow solver used to derive this step's miss
    // fraction — see the warmSinceMs param doc above for the divergence-guard rationale.
    const cacheHitRatio = bp?.cacheConfig
      ? effectiveHitRatio(bp.cacheConfig, warmSinceMs?.get(inst.id), simMs)
      : undefined
    // FEAT-005 (Task 12): rps-weighted mean of the SAME per-row staleReadFraction flows.ts attached
    // this window — see staleReadWindow's own doc comment for why this is aggregation, not
    // re-derivation. EMA'd like every other published gauge; absent when this instance received no
    // tagged stale row this window (not a replica, or zero write load/lag this whole window).
    const staleWin = state.staleReadWindow.get(inst.id)
    const staleReadFraction = staleWin && staleWin.rpsSum > 0
      ? ema(state, `i:${inst.id}:stale`, staleWin.fracRpsSum / staleWin.rpsSum)
      : undefined
    // FEAT-007 (Task 6): the SAME warmingUntil map + warmthOf call the capacity (Task 4) and
    // latency (Task 5) throttles used this step — read here, never re-derived, so the published
    // warmth/degraded-health can never disagree with the throttle actually applied. Guarded on
    // `.size > 0` (the fast path every other warmingUntil consumer in index.ts already uses) so a
    // world with no cold-starting instance at all pays zero per-instance cost, byte-identical to
    // pre-FEAT-007 output.
    const warmth01 = warmingUntil && warmingUntil.size > 0 ? warmthOf(inst.id, warmingUntil, simMs) : 1
    instances[inst.id] = {
      instanceId: inst.id,
      rps,
      errorRate,
      p50Ms,
      p99Ms,
      serviceP50Ms,
      activeConnections,
      cpuCoresUsed: rps * (effectiveCpuMsByInstance?.[inst.id] ?? workload.cpuMsPerRequest) / 1000,
      ramMb: memLimitMb != null ? Math.min(rawRamMb, memLimitMb) : rawRamMb,
      health: (starved?.has(inst.id) || warmth01 < 1) && baseHealth === 'healthy' ? 'degraded' : baseHealth,
      ...(checkoutWaitMs != null ? { checkoutWaitMs } : {}),
      ...(roleOf ? { effectiveRole: roleOf(inst.id) } : {}),
      ...(cacheHitRatio !== undefined ? { cacheHitRatio } : {}),
      ...(staleReadFraction !== undefined ? { staleReadFraction } : {}),
      ...(diskWaitMs != null ? { diskWaitMs } : {}),
      ...(warmth01 < 1 ? { warmth: warmth01 } : {}),
    }
  }

  // ── Servers ──
  for (const server of Object.values(doc.servers)) {
    const resident = instancesByServer.get(server.id) ?? []
    const host = state.lastHost[server.id]
    const vps = state.lastVps[server.id]
    const sw = state.serverWindow.get(server.id) ?? { inBytes: 0, outBytes: 0 }
    const ramByInstance = resident
      .map(i => ({ instanceId: i.id, blueprintId: i.blueprintId, ramMb: instances[i.id]?.ramMb ?? 0 }))
      .sort((a, b) => b.ramMb - a.ramMb)
    const diskIo = resident.reduce((sum, i) => {
      const w = doc.blueprints[i.blueprintId]?.workload
      return sum + (instances[i.id]?.rps ?? 0) * (w?.diskIoPerRequest ?? 0)
    }, 0)
    // FEAT-006 (Task 20): dual behavior. A server with neither diskIops nor diskType authored has
    // no resolvable ceiling — host?.diskIoRatio is undefined — and stays on the EXACT legacy
    // diskIo/100 norm (the regression floor: byte-identical to pre-FEAT-006 for every existing
    // world). A server WITH a resolvable ceiling instead publishes min(1, demandIops/ceiling),
    // sourced from the SAME ratio index.ts computed to drive this step's diskWaitFor call
    // (HostStepResult.diskIoRatio, Task 19/20's threading) — never re-derived here, so this
    // gauge can never disagree with the wait that actually fed p50Ms/activeConnections.
    const diskIoFraction = host?.diskIoRatio != null
      ? Math.min(1, host.diskIoRatio)
      : Math.min(1, diskIo / 100)   // documented norm: 100 io-units/sec = saturated
    servers[server.id] = {
      serverId: server.id,
      coreUtilization: host?.coreUtilization ?? Array.from({ length: server.specs.vcpu }, () => 0),
      stealFraction: vps?.steal ?? 0,
      // Burstable VPS: pass the credits fraction through as-is (it is itself nullable —
      // do not coerce a missing/null reading to 0, which would misreport "exhausted").
      burstCredits: server.kind === 'vps' && server.burstable ? (vps ? vps.creditsFraction : null) : null,
      ramByInstance,
      ramUsedMb: host?.ramUsedMb ?? ramByInstance.reduce((s, r) => s + r.ramMb, 0),
      ramTotalMb: server.specs.ramMb,
      nicInMbps: ema(state, `s:${server.id}:nicIn`, (sw.inBytes * 8) / 1e6),
      nicOutMbps: ema(state, `s:${server.id}:nicOut`, (sw.outBytes * 8) / 1e6),
      diskIoFraction,
      health: state.lastHealth(server.id),
    }
  }

  // ── AZs ──
  for (const az of Object.values(doc.azs)) {
    // FEAT-008 (Task 16): instancesByAz is grouped from ALL of compiled.instances (built above,
    // before the running-set skip in the loop that populated `instances`), so a parked instance's
    // id can still appear here even though it has no `instances[id]` entry. Filter to the ones
    // that actually published -- the running set -- so this AZ's rps/errorRate/p50/instanceCount
    // reflect only running instances, matching the omission semantics `instances` itself now has.
    const inAz = (instancesByAz.get(az.id) ?? []).filter(i => instances[i.id])
    const rps = inAz.reduce((s, i) => s + instances[i.id].rps, 0)
    const errWeighted = inAz.reduce((s, i) => s + instances[i.id].errorRate * instances[i.id].rps, 0)
    const errorRate = rps > 0 ? errWeighted / rps : 0
    const p50 = inAz.length > 0
      ? inAz.reduce((s, i) => s + instances[i.id].p50Ms * (instances[i.id].rps || 1), 0) /
        Math.max(1, inAz.reduce((s, i) => s + (instances[i.id].rps || 1), 0))
      : 0
    const health = state.lastHealth(az.id)
    // Mean undeliverable rps for this AZ (cross-zone-off forfeiture etc.), EMA'd like rps.
    const droppedRps = ema(state, `az:${az.id}:dropped`,
      (state.droppedWindow.get(az.id) ?? 0) / Math.max(1, state.droppedSteps))
    azs[az.id] = {
      azId: az.id,
      rps,
      errorRate,
      p50Ms: p50,
      healthScore: 100 * (1 - errorRate) * HEALTH_FACTOR[health],
      health,
      serverCount: Object.values(doc.servers).filter(s => s.azId === az.id).length,
      instanceCount: inAz.length,
      droppedRps,
    }
  }

  // ── Regions ──
  for (const region of Object.values(doc.regions)) {
    const inRegion = Object.values(doc.azs).filter(a => a.regionId === region.id).map(a => azs[a.id])
    const rps = inRegion.reduce((s, a) => s + a.rps, 0)
    const errWeighted = inRegion.reduce((s, a) => s + a.errorRate * a.rps, 0)
    const servedErrorRate = rps > 0 ? errWeighted / rps : 0
    const p50 = inRegion.length > 0
      ? inRegion.reduce((s, a) => s + a.p50Ms * (a.rps || 1), 0) / Math.max(1, inRegion.reduce((s, a) => s + (a.rps || 1), 0))
      : 0
    // Undeliverable inbound (cross-zone-off forfeiture etc.) impairs the region on DISPLAY only.
    // errorRate reflects the true failing fraction of inbound (served failures + dropped over
    // served + dropped); healthScore/health downgrade with it — but this NEVER feeds the failover
    // state machine (index.ts step 9) or routing, so it can't cascade onto or throttle healthy
    // instances. The failover health is the floor: display only ever downgrades from it.
    const droppedRps = inRegion.reduce((s, a) => s + (a.droppedRps ?? 0), 0)
    const inbound = rps + droppedRps
    const errorRate = inbound > 0 ? (servedErrorRate * rps + droppedRps) / inbound : 0
    const failoverHealth = state.lastHealth(region.id)
    const banded: HealthState = errorRate >= 0.5 ? 'down' : errorRate >= 0.1 ? 'degraded' : 'healthy'
    const health: HealthState =
      HEALTH_FACTOR[banded] < HEALTH_FACTOR[failoverHealth] ? banded : failoverHealth
    regions[region.id] = {
      regionId: region.id,
      rps,
      errorRate,
      p50Ms: p50,
      healthScore: 100 * (1 - errorRate) * HEALTH_FACTOR[health],
      health,
      inboundByPopulation: routingSnapshot.populationRoutes
        .filter(r => r.regionId === region.id)
        .map(r => ({ populationId: r.populationId, rps: r.rps })),
      droppedRps,
    }
  }

  // ── Managed services (node-model Phase 5.1) ──
  // Load REACHING each managed service. utilization gauges offered ÷ total class capacity (a
  // documented reads+writes sum — writes/reads overflow independently, so refusedRps is the exact
  // over-capacity signal while utilization is the pre-refusal "how full" gauge). health bands off
  // both, reusing the healthy/degraded/down LED language.
  const managedServices: Record<ManagedServiceId, ManagedServiceMetrics> = {}
  for (const ms of Object.values(doc.managedServices)) {
    const mw = state.managedWindow.get(ms.id)
      ?? { steps: 1, admittedSum: 0, refusedSum: 0, errorSum: 0, runtimeSteps: 0, latencySum: 0, p99Sum: 0, connectionsSum: 0, saturationSum: 0 }
    const rps = ema(state, `m:${ms.id}:rps`, mw.admittedSum / Math.max(1, mw.steps))
    const refusedRps = ema(state, `m:${ms.id}:ref`, mw.refusedSum / Math.max(1, mw.steps))
    const errorRps = ema(state, `m:${ms.id}:err`, mw.errorSum / Math.max(1, mw.steps))
    // Capacity for the utilization gauge: a DB's write+read ceiling, else the flat per-type ceiling
    // (node-model Phase 5.2 — non-DB types are no longer uncapped). 0 ⇒ genuinely uncapped.
    const ceilings = managedDbCeilings(ms)
    const flatCap = managedCapacityRps(ms)
    const capacity = ceilings
      ? ceilings.writeCeiling + ceilings.readCeiling
      : (flatCap != null && Number.isFinite(flatCap) ? flatCap : 0)
    const offered = rps + refusedRps + errorRps
    const utilization = capacity > 0 ? Math.min(1, offered / capacity) : 0
    // Phase 5.4: timeouts are failures too — a DB erroring half its calls is down even if it
    // refused nothing, which is exactly the soft-failure case the query timeout models.
    const failed = refusedRps + errorRps
    const refusalFraction = offered > 0 ? failed / offered : 0
    const health: HealthState =
      refusalFraction >= 0.5 ? 'down'
        : (failed > 1e-6 || utilization >= 0.9) ? 'degraded'
          : 'healthy'
    // Served bytes/sec for a storage/CDN service (node-model Phase 5.2) — the window holds ~1s of
    // accumulated served bytes, EMA-smoothed to a rate like the world byte totals below.
    const egressBytesPerSec = ema(state, `m:${ms.id}:egr`, totals.managedEgressBytes?.[ms.id] ?? 0)
    // Phase 5.4 failure-model gauges, averaged over the steps that actually carried a runtime
    // entry. A DB without a runtime stays 0 across the board (back-compat); a NON-DB service
    // now publishes its per-class base latency with an M/M/1 queueing multiplier under load
    // (audit ISSUE-037) instead of a flat 0 — a saturated cache visibly slows down.
    const rtSteps = Math.max(1, mw.runtimeSteps)
    const had = mw.runtimeSteps > 0
    const isDb = !!managedDbEngine(ms.nodeType)
    const classP50 = !had && !isDb ? managedLatencyMs(ms.nodeType, utilization) : 0
    managedServices[ms.id] = {
      managedServiceId: ms.id, rps, refusedRps, utilization, health, egressBytesPerSec,
      errorRps,
      saturation: had ? mw.saturationSum / rtSteps : (isDb ? 0 : utilization),
      p50Ms: had ? mw.latencySum / rtSteps : classP50,
      p99Ms: had ? mw.p99Sum / rtSteps : classP50 * MANAGED_P99_OVER_P50,
      connections: had ? mw.connectionsSum / rtSteps : (isDb ? 0 : rps * classP50 / 1000),
    }
  }

  // ── World ──
  const totalRps = Object.values(regions).reduce((s, r) => s + r.rps, 0)
  const errWeighted = Object.values(regions).reduce((s, r) => s + r.errorRate * r.rps, 0)
  // FEAT-014 (Task 9): per-gateway EMA, the same `ema(...)` blend crossAzBytesPerSec/
  // crossRegionBytesPerSec use above, keyed per gateway (mirrors the per-managed-service
  // `egressBytesPerSec` loop). Built only from keys actually present in `totals.natGatewayBytes`
  // -- a doc with no NAT gateways never enters the loop, so `natGatewayBytesPerSec` stays an
  // empty object and is omitted from `world` below (regression floor: `toBe`-identical batch).
  const natGatewayBytesPerSec: Record<string, number> = {}
  for (const [natId, bytes] of Object.entries(totals.natGatewayBytes ?? {})) {
    natGatewayBytesPerSec[natId] = ema(state, `nat:${natId}`, bytes)
  }
  const world: WorldMetrics = {
    totalRps,
    errorRate: totalRps > 0 ? errWeighted / totalRps : 0,
    populationRoutes: routingSnapshot.populationRoutes,
    crossAzBytesPerSec: ema(state, 'w:xaz', totals.crossAzBytes),
    crossRegionBytesPerSec: ema(state, 'w:xregion', totals.crossRegionBytes),
    internetEgressBytesPerSec: ema(state, 'w:inet', totals.internetBytes),
    ...(Object.keys(natGatewayBytesPerSec).length > 0 ? { natGatewayBytesPerSec } : {}),
  }

  // ── Topics (audit ISSUE-002) ──
  const topics: Record<string, TopicMetrics> = {}
  for (const [depId, rt] of Object.entries(state.lastTopicRuntime)) {
    topics[depId] = {
      totalArrivalRps: rt.totalArrivalRps, backlogCount: rt.backlogCount, drainRps: rt.drainRps,
      lagSec: rt.lagSec, dropRps: rt.dropRps, redeliverRps: rt.redeliverRps, dlqRps: rt.dlqRps,
    }
  }

  // ── Clusters (FEAT-005) ──
  // Grouped from replicasByCluster's keys (the SAME static topology index.ts's step loop built at
  // start()), reading lag off replicationLagByInstance — never recomputed. A cluster with several
  // replicas publishes the MAX lag across them, the RPO-relevant worst case (see MetricsBatch.
  // clusters' own doc comment in types.ts for why max, not mean).
  const clusters: Record<string, { lagSec: number }> = {}
  if (replicasByCluster && replicationLagByInstance) {
    for (const [clusterId, replicas] of Object.entries(replicasByCluster)) {
      let maxLag = 0
      for (const r of replicas) {
        const lag = replicationLagByInstance.get(r.id) ?? 0
        if (lag > maxLag) maxLag = lag
      }
      clusters[clusterId] = { lagSec: maxLag }
    }
  }

  // Reset windows for the next second.
  state.window.clear()
  state.serverWindow.clear()
  state.managedWindow.clear()
  state.droppedWindow.clear()
  state.droppedSteps = 0
  state.staleReadWindow.clear()

  return {
    simMs, instances, servers, azs, regions, world, managedServices, topics,
    activeFaultCount: activeFaultCount ?? 0, clusters,
    ...(runningByPlacement !== undefined ? { runningByPlacement } : {}),
    ...(recentScaleEventCount !== undefined ? { recentScaleEventCount } : {}),
  }
}
