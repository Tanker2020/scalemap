// The metrics pyramid: per-step accumulation into 1s windows, published as a MetricsBatch
// at 1 Hz with EMA smoothing (α = 0.3, ported legacy constant). Every contract field is
// populated — no field is ever left undefined.
import type {
  MetricsBatch, InstanceMetrics, ServerMetrics, AzMetrics, RegionMetrics, WorldMetrics,
  ManagedServiceMetrics, HealthState,
} from './types'
import type { InstanceFlow } from './flows'
import { managedDbCeilings } from './flows'
import { managedCapacityRps } from '../managedCapacity'
import type { ManagedDbRuntime } from '../managedDbRuntime'
import type { HostStepResult } from './hostScheduler'
import type { NicState } from './networkRuntime'
import type {
  WorldDoc, CompiledWorld, InstanceId, ServerId, AzId, RegionId, PopulationId, ManagedServiceId,
  ServiceInstance,
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
  latencies: number[]   // per-step sampled service latencies (window-local, sorted at batch)
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

export interface MetricsState {
  window: Map<InstanceId, InstanceWindow>
  serverWindow: Map<ServerId, ServerWindow>
  managedWindow: Map<ManagedServiceId, ManagedWindow>
  // EMA-published values, keyed per entity. Missing key = first window seeds directly.
  published: Map<string, number>
  // Latest step's side-channel values, retained for buildBatch (its skeleton signature
  // does not receive them — see plan Semantics).
  lastHost: Record<ServerId, HostStepResult>
  lastVps: Record<ServerId, VpsPublish>
  lastHealth: (id: string) => HealthState
}

export function createMetricsState(): MetricsState {
  return {
    window: new Map(),
    serverWindow: new Map(),
    managedWindow: new Map(),
    published: new Map(),
    lastHost: {},
    lastVps: {},
    lastHealth: () => 'healthy',
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
): void {
  // Managed-service received traffic THIS step, summed across every caller's downstream rows
  // (a managed service can be a dependency of several instances). Folded into the window below.
  const msAdmitted = new Map<ManagedServiceId, number>()
  const msRefused = new Map<ManagedServiceId, number>()
  const msErrored = new Map<ManagedServiceId, number>()
  for (const f of Object.values(flows)) {
    let w = state.window.get(f.instanceId)
    if (!w) {
      w = { steps: 0, admittedSum: 0, errorSum: 0, latencies: [] }
      state.window.set(f.instanceId, w)
    }
    w.steps++
    w.admittedSum += f.admittedRps
    w.errorSum += f.errorRps + f.refusedRps
    w.latencies.push(f.serviceLatencyMs)
    for (const row of f.downstream) {
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
    mw.steps++
    mw.admittedSum += msAdmitted.get(id) ?? 0
    mw.refusedSum += msRefused.get(id) ?? 0
    mw.errorSum += msErrored.get(id) ?? 0
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

export function buildBatch(
  state: MetricsState,
  doc: WorldDoc,
  compiled: CompiledWorld,
  routingSnapshot: RoutingSnapshot,
  totals: { crossAzBytes: number; crossRegionBytes: number; internetBytes: number; managedEgressBytes?: Record<string, number> },
  simMs: number,
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
    const bp = doc.blueprints[inst.blueprintId]
    const w = state.window.get(inst.id) ?? { steps: 1, admittedSum: 0, errorSum: 0, latencies: [0] }
    const windowRps = w.admittedSum / Math.max(1, w.steps)
    // Error rate = fraction of offered traffic (admitted + errored/refused) that failed —
    // always in [0,1]; a fully-down instance (admitted 0, errors>0) reports 1.0.
    const windowErrRate = w.admittedSum + w.errorSum > 0 ? w.errorSum / (w.admittedSum + w.errorSum) : 0
    const sorted = [...w.latencies].sort((a, b) => a - b)
    const rps = ema(state, `i:${inst.id}:rps`, windowRps)
    const errorRate = ema(state, `i:${inst.id}:err`, windowErrRate)
    const p50Ms = ema(state, `i:${inst.id}:p50`, percentile(sorted, 0.5))
    const p99Ms = ema(state, `i:${inst.id}:p99`, percentile(sorted, 0.99))
    const activeConnections = rps * (p50Ms / 1000)          // Little's law
    const workload = bp?.workload ?? { cpuMsPerRequest: 0, ramBaseMb: 0, ramPerConnMb: 0, diskIoPerRequest: 0 }
    instances[inst.id] = {
      instanceId: inst.id,
      rps,
      errorRate,
      p50Ms,
      p99Ms,
      activeConnections,
      cpuCoresUsed: rps * workload.cpuMsPerRequest / 1000,
      ramMb: workload.ramBaseMb + workload.ramPerConnMb * activeConnections,
      health: state.lastHealth(inst.id),
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
      diskIoFraction: Math.min(1, diskIo / 100),   // documented norm: 100 io-units/sec = saturated
      health: state.lastHealth(server.id),
    }
  }

  // ── AZs ──
  for (const az of Object.values(doc.azs)) {
    const inAz = instancesByAz.get(az.id) ?? []
    const rps = inAz.reduce((s, i) => s + instances[i.id].rps, 0)
    const errWeighted = inAz.reduce((s, i) => s + instances[i.id].errorRate * instances[i.id].rps, 0)
    const errorRate = rps > 0 ? errWeighted / rps : 0
    const p50 = inAz.length > 0
      ? inAz.reduce((s, i) => s + instances[i.id].p50Ms * (instances[i.id].rps || 1), 0) /
        Math.max(1, inAz.reduce((s, i) => s + (instances[i.id].rps || 1), 0))
      : 0
    const health = state.lastHealth(az.id)
    azs[az.id] = {
      azId: az.id,
      rps,
      errorRate,
      p50Ms: p50,
      healthScore: 100 * (1 - errorRate) * HEALTH_FACTOR[health],
      health,
      serverCount: Object.values(doc.servers).filter(s => s.azId === az.id).length,
      instanceCount: inAz.length,
    }
  }

  // ── Regions ──
  for (const region of Object.values(doc.regions)) {
    const inRegion = Object.values(doc.azs).filter(a => a.regionId === region.id).map(a => azs[a.id])
    const rps = inRegion.reduce((s, a) => s + a.rps, 0)
    const errWeighted = inRegion.reduce((s, a) => s + a.errorRate * a.rps, 0)
    const errorRate = rps > 0 ? errWeighted / rps : 0
    const p50 = inRegion.length > 0
      ? inRegion.reduce((s, a) => s + a.p50Ms * (a.rps || 1), 0) / Math.max(1, inRegion.reduce((s, a) => s + (a.rps || 1), 0))
      : 0
    const health = state.lastHealth(region.id)
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
    // Phase 5.4 failure-model gauges, averaged over the steps that actually carried a runtime entry
    // (a non-DB service never does, and stays 0 across the board).
    const rtSteps = Math.max(1, mw.runtimeSteps)
    const had = mw.runtimeSteps > 0
    managedServices[ms.id] = {
      managedServiceId: ms.id, rps, refusedRps, utilization, health, egressBytesPerSec,
      errorRps,
      saturation: had ? mw.saturationSum / rtSteps : 0,
      p50Ms: had ? mw.latencySum / rtSteps : 0,
      p99Ms: had ? mw.p99Sum / rtSteps : 0,
      connections: had ? mw.connectionsSum / rtSteps : 0,
    }
  }

  // ── World ──
  const totalRps = Object.values(regions).reduce((s, r) => s + r.rps, 0)
  const errWeighted = Object.values(regions).reduce((s, r) => s + r.errorRate * r.rps, 0)
  const world: WorldMetrics = {
    totalRps,
    errorRate: totalRps > 0 ? errWeighted / totalRps : 0,
    populationRoutes: routingSnapshot.populationRoutes,
    crossAzBytesPerSec: ema(state, 'w:xaz', totals.crossAzBytes),
    crossRegionBytesPerSec: ema(state, 'w:xregion', totals.crossRegionBytes),
    internetEgressBytesPerSec: ema(state, 'w:inet', totals.internetBytes),
  }

  // Reset windows for the next second.
  state.window.clear()
  state.serverWindow.clear()
  state.managedWindow.clear()

  return { simMs, instances, servers, azs, regions, world, managedServices }
}
