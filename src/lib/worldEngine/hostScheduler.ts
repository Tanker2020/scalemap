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

  // Fill cores in order for readability (Phase 3's CPU die renders index 0 first).
  const usedCores = Math.min(demandCores, safeEffectiveVcpu)
  const coreCount = Math.max(1, Math.round(server.specs.vcpu))
  const coreUtilization: number[] = []
  let remaining = usedCores
  for (let i = 0; i < coreCount; i++) {
    const fill = Math.max(0, Math.min(1, remaining))
    coreUtilization.push(fill)
    remaining -= fill
  }

  // RAM: base + per-connection growth; a container's own memLimitMb caps (and kills) it
  // individually before any host-level accounting — the host never sees more than the cap.
  let ramUsedMb = 0
  let oomVictim: InstanceId | null = null
  const ramRows: { instanceId: InstanceId; overBase: number }[] = []
  for (const l of loads) {
    let instanceRam = l.ramBaseMb + l.ramPerConnMb * l.activeConnections
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

  return { cpuPressure, coreUtilization, latencyMultiplier, admittedScale, serviceRateByInstance, ramUsedMb, oomVictim }
}
