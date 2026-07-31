// Per-server CPU/RAM scheduling: demand vs effective capacity, per-instance weighted fair-share
// service rates (audit ISSUE-018), OOM victim selection.
// Spec decision 3, docs/superpowers/specs/2026-07-08-phase2-substrate-engine-design.md.
import type { Server, InstanceId } from '../world/types'
import type { Rng } from './rng'

export interface InstanceLoad {
  instanceId: InstanceId
  cpuMsPerRequest: number
  admittedRps: number
  activeConnections: number
  ramBaseMb: number
  ramPerConnMb: number
  memLimitMb: number | null
  // CPU weight for the fair-share split (audit ISSUE-018) — cgroup-shares-like. Optional:
  // absent ⇒ 1 (every instance equal), the pre-fix behavior.
  cpuShares?: number
  // Queue backlog carried from the previous tick, expressed as the rps needed to drain it in
  // one step (audit ISSUE-013). Lets the water-fill grant a draining instance capacity beyond
  // its instantaneous demand. Optional: absent ⇒ 0.
  backlogRps?: number
  // Self-hosted connection pool (audit ISSUE-005). Optional: absent ⇒ unbounded (no pool
  // modeling at all, the pre-issue behavior — poolCheckoutFor returns null).
  maxConnections?: number
  checkoutTimeoutMs?: number
}

// The failure model for ONE instance's connection pool at ρ = activeConnections/maxConnections
// (audit ISSUE-005) — an M/M/c/K-shaped queue at the connection layer, ahead of compute. Below
// saturation (ρ <= 1) checkout is immediate — the exact pre-issue behavior, since this is the
// regression floor for an authored-but-unsaturated pool. Past it, checkout wait grows with the
// SAME queueing shape managedDbRuntime.ts already uses for DB service latency (`base /
// (1 - saturation)`, clamped so a badly-oversubscribed pool stays finite rather than exploding),
// reused here for the CHECKOUT step specifically rather than re-derived. Returns null when no
// maxConnections is authored — "not capacity-modelled", the same convention
// managedDbRuntimeFor uses for an unclassed DB.
const BASE_CHECKOUT_MS = 5
const MAX_SATURATION_FOR_CHECKOUT_LATENCY = 0.98
export function poolCheckoutFor(
  activeConnections: number,
  maxConnections: number | undefined,
  checkoutTimeoutMs: number | undefined,
): { checkoutWaitMs: number; checkoutTimeoutErrorFraction: number } | null {
  if (maxConnections == null || !(maxConnections > 0)) return null
  const rho = activeConnections / maxConnections
  if (rho <= 1) return { checkoutWaitMs: 0, checkoutTimeoutErrorFraction: 0 }
  const overshoot = Math.min(rho - 1, MAX_SATURATION_FOR_CHECKOUT_LATENCY)
  const checkoutWaitMs = BASE_CHECKOUT_MS / (1 - overshoot)
  const checkoutTimeoutErrorFraction =
    checkoutTimeoutMs != null && checkoutTimeoutMs > 0 && checkoutWaitMs > checkoutTimeoutMs
      ? Math.min(1, (checkoutWaitMs - checkoutTimeoutMs) / checkoutTimeoutMs)
      : 0
  return { checkoutWaitMs, checkoutTimeoutErrorFraction }
}

export interface HostStepResult {
  cpuPressure: number
  coreUtilization: number[]
  latencyMultiplier: number
  admittedScale: number
  // Per-instance service capacity in rps for THIS step (audit ISSUE-018): a weighted fair share
  // of effectiveVcpu, work-conserving (unused demand is redistributed) with a fair-share FLOOR —
  // an instance that was idle last tick still gets its share, so recovery never deadlocks at
  // zero capacity. The queue model (flows.ts, ISSUE-013) serves min(capacity, arrivals+backlog).
  serviceRateByInstance: Record<InstanceId, number>
  ramUsedMb: number
  oomVictim: InstanceId | null
  // Per-instance pool-checkout result (audit ISSUE-005) — only present for instances with an
  // authored maxConnections. Additive-optional: absent entirely on a hand-built HostStepResult
  // (existing test fixtures), and an absent per-instance key ⇒ no pool modeling for that instance.
  checkoutByInstance?: Record<InstanceId, { checkoutWaitMs: number; checkoutTimeoutErrorFraction: number }>
}

// Weighted water-fill of `totalCores` across instances, capped per instance at its wanted cores
// (demand + backlog). Iterative: instances that hit their cap release the surplus to the rest by
// weight. Returns the demand-driven allocation (may under-use totalCores when demand is low).
function waterfill(
  wants: { instanceId: InstanceId; weight: number; capCores: number }[],
  totalCores: number,
): Map<InstanceId, number> {
  const alloc = new Map<InstanceId, number>()
  let remaining = totalCores
  let active = wants.filter(w => w.capCores > 0)
  for (const w of wants) alloc.set(w.instanceId, 0)
  while (active.length > 0 && remaining > 1e-9) {
    const totalW = active.reduce((s, w) => s + w.weight, 0)
    if (totalW <= 0) break
    const capped: typeof active = []
    const surviving: typeof active = []
    let used = 0
    for (const w of active) {
      const grant = (remaining * w.weight) / totalW
      const already = alloc.get(w.instanceId) ?? 0
      const need = w.capCores - already
      if (grant >= need) {
        alloc.set(w.instanceId, w.capCores)
        used += need
        capped.push(w)
      } else {
        surviving.push(w)
      }
    }
    if (capped.length === 0) {
      // Nobody capped: hand out the full remaining by weight and stop.
      for (const w of surviving) {
        alloc.set(w.instanceId, (alloc.get(w.instanceId) ?? 0) + (remaining * w.weight) / totalW)
      }
      remaining = 0
      break
    }
    remaining -= used
    active = surviving
  }
  return alloc
}

export function stepHost(server: Server, loads: InstanceLoad[], effectiveVcpu: number, rng: Rng): HostStepResult {
  const demandCores = loads.reduce((sum, l) => sum + (l.admittedRps * l.cpuMsPerRequest) / 1000, 0)
  const safeEffectiveVcpu = Math.max(effectiveVcpu, 0.0001)
  const cpuPressure = demandCores / safeEffectiveVcpu
  const latencyMultiplier = Math.max(1, cpuPressure)
  const admittedScale = Math.min(1, 1 / Math.max(cpuPressure, 0.0001))

  // ── Per-instance service rates (audit ISSUE-018) ──
  // allocation_i = max(fair-share floor, demand-capped water-fill). The floor guarantees every
  // resident instance can serve up to its weighted share even from cold (previous demand 0 —
  // otherwise a recovered instance's capacity would be pinned at 0 forever); the water-fill
  // makes the split work-conserving when demand is skewed. The max() can transiently grant more
  // than effectiveVcpu in sum — a deliberate, bounded overcommit that models a real scheduler's
  // instant reallocation, chosen over strict conservation to keep both properties.
  const serviceRateByInstance: Record<InstanceId, number> = {}
  if (loads.length > 0) {
    const totalWeight = loads.reduce((s, l) => s + Math.max(0, l.cpuShares ?? 1), 0) || loads.length
    const wants = loads.map(l => ({
      instanceId: l.instanceId,
      weight: Math.max(0, l.cpuShares ?? 1),
      capCores: ((l.admittedRps + (l.backlogRps ?? 0)) * l.cpuMsPerRequest) / 1000,
    }))
    const filled = waterfill(wants, safeEffectiveVcpu)
    for (const l of loads) {
      const weight = Math.max(0, l.cpuShares ?? 1)
      const floorCores = (safeEffectiveVcpu * weight) / totalWeight
      const cores = Math.max(floorCores, filled.get(l.instanceId) ?? 0)
      serviceRateByInstance[l.instanceId] = (cores * 1000) / Math.max(0.0001, l.cpuMsPerRequest)
    }
  }

  // Even spread on the EFFECTIVE-vCPU basis (audit ISSUE-035). The old sequential fill pinned
  // core 0 → 1.0 before touching core 1 (a 4-core host at 50% drew two pegged + two idle dies),
  // and capped total fill at steal/credit-reduced capacity while distributing across RAW
  // specs.vcpu — so a throttled host could never read full even at saturation. One basis now:
  // every core shows the saturation of the capacity that actually exists this step
  // (min(1, cpuPressure)), which a real scheduler's load balancing approximates.
  const coreCount = Math.max(1, Math.round(server.specs.vcpu))
  const coreFill = Math.max(0, Math.min(1, demandCores / safeEffectiveVcpu))
  const coreUtilization: number[] = new Array<number>(coreCount).fill(coreFill)

  // RAM: base + per-connection growth; a container's own memLimitMb caps (and kills) it
  // individually before any host-level accounting — the host never sees more than the cap.
  let ramUsedMb = 0
  let oomVictim: InstanceId | null = null
  const ramRows: { instanceId: InstanceId; overBase: number }[] = []
  const checkoutByInstance: HostStepResult['checkoutByInstance'] = {}
  for (const l of loads) {
    // Pool checkout (audit ISSUE-005): a checkout that times out never actually occupies a
    // connection — the caller gave up waiting — so it must not also inflate RAM as if it held
    // one. Applied BEFORE the container memLimitMb clamp below, which is a separate, independent
    // cap on whatever connections genuinely landed.
    const checkout = poolCheckoutFor(l.activeConnections, l.maxConnections, l.checkoutTimeoutMs)
    if (checkout) checkoutByInstance[l.instanceId] = checkout
    const effectiveConnections = checkout
      ? l.activeConnections * (1 - checkout.checkoutTimeoutErrorFraction)
      : l.activeConnections
    let instanceRam = l.ramBaseMb + l.ramPerConnMb * effectiveConnections
    if (l.memLimitMb !== null && instanceRam > l.memLimitMb) {
      instanceRam = l.memLimitMb
      if (oomVictim === null) oomVictim = l.instanceId
    }
    ramUsedMb += instanceRam
    ramRows.push({ instanceId: l.instanceId, overBase: instanceRam - l.ramBaseMb })
  }
  // Host-level OOM only fires when no container limit already claimed a victim this step:
  // kill the largest over-base consumer (rng breaks exact ties, never biased to array order).
  if (oomVictim === null && ramUsedMb > server.specs.ramMb && ramRows.length > 0) {
    const maxOverBase = Math.max(...ramRows.map(r => r.overBase))
    const tied = ramRows.filter(r => r.overBase === maxOverBase)
    oomVictim = rng.pick(tied).instanceId
  }

  return {
    cpuPressure, coreUtilization, latencyMultiplier, admittedScale, serviceRateByInstance,
    ramUsedMb, oomVictim, checkoutByInstance,
  }
}
