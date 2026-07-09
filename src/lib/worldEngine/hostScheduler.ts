// Per-server CPU/RAM scheduling: demand vs effective capacity, OOM victim selection.
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
}

export interface HostStepResult {
  cpuPressure: number
  coreUtilization: number[]
  latencyMultiplier: number
  admittedScale: number
  ramUsedMb: number
  oomVictim: InstanceId | null
}

export function stepHost(server: Server, loads: InstanceLoad[], effectiveVcpu: number, rng: Rng): HostStepResult {
  const demandCores = loads.reduce((sum, l) => sum + (l.admittedRps * l.cpuMsPerRequest) / 1000, 0)
  const safeEffectiveVcpu = Math.max(effectiveVcpu, 0.0001)
  const cpuPressure = demandCores / safeEffectiveVcpu
  const latencyMultiplier = Math.max(1, cpuPressure)
  const admittedScale = Math.min(1, 1 / Math.max(cpuPressure, 0.0001))

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

  return { cpuPressure, coreUtilization, latencyMultiplier, admittedScale, ramUsedMb, oomVictim }
}
