// Pure resource math for the EC2 compute model. No engine state, no side effects — every function
// is a deterministic transform of (workload, profile), so the whole model is unit-testable here
// and the rAF loop just calls in. See docs/superpowers/plans/2026-07-07-ec2-compute-resource-model.md.
import { COMPUTE_IPC, type ComputeProfile, type WorkloadDemand, type NodeSimConfig } from '../../../../lib/nodeConfig'

// Seconds of pure CPU time one request costs: (billion instr) / (billion instr/sec).
// baseClockGhz * IPC = billions of instructions retired per second.
export function cpuTimeSec(w: WorkloadDemand, p: ComputeProfile): number {
  const rate = Math.max(0.001, p.baseClockGhz * COMPUTE_IPC)
  return Math.max(0, w.cpuInstructionsBillions) / rate
}

// RAM held per in-flight request. Blocking model additionally pins a thread stack.
export function perRequestMemMb(w: WorkloadDemand, p: ComputeProfile): number {
  const stack = p.blockingIoModel ? (p.threadStackMb ?? 1) : 0
  return Math.max(0.001, w.memoryFootprintMb + stack)
}

// Soft saturation threshold: useful-concurrency per core given IO wait. NOT a hard cap — it maps
// to rho≈1 in the latency multiplier, where the hockey-stick begins. clamp io<0.99 for safety.
export function maxThreadsCPU(p: ComputeProfile, ioBoundFraction: number): number {
  const io = Math.min(0.99, Math.max(0, ioBoundFraction))
  return p.vCpu / (1 - io)
}

// Hard ceiling: how many concurrent request footprints fit before OOM.
export function maxThreadsMem(w: WorkloadDemand, p: ComputeProfile): number {
  const usableMb = p.ramGiB * 1024 - (p.osBaseMemoryMb ?? 512)
  return Math.max(0, Math.floor(usableMb / perRequestMemMb(w, p)))
}

// The real hard admission cap: memory-bound, optionally clamped by an explicit pool size.
export function hardThreadCap(w: WorkloadDemand, p: ComputeProfile): number {
  const mem = maxThreadsMem(w, p)
  return p.maxThreadsOverride !== undefined ? Math.min(p.maxThreadsOverride, mem) : mem
}

// CPU utilization rho: offered core-seconds per second / available cores.
export function cpuUtilization(inRps: number, w: WorkloadDemand, p: ComputeProfile): number {
  return (Math.max(0, inRps) * cpuTimeSec(w, p)) / Math.max(0.001, p.vCpu)
}

// Current resident memory given a logical in-flight request count.
export function currentRamMb(activeRequests: number, w: WorkloadDemand, p: ComputeProfile): number {
  return (p.osBaseMemoryMb ?? 512) + Math.max(0, activeRequests) * perRequestMemMb(w, p)
}

// Reported node utilization = the binding constraint (whichever is higher), plus which one it is.
// CPU util (rho) drives latency amplification; memory util drives hard drops/OOM.
export function nodeUtilization(
  inRps: number, activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
): { utilization: number; bottleneck: 'cpu' | 'memory' } {
  const rho = cpuUtilization(inRps, w, p)
  const cap = hardThreadCap(w, p)
  const memUtil = cap > 0 ? activeRequests / cap : 1
  const bottleneck = rho >= memUtil ? 'cpu' : 'memory'
  return { utilization: Math.min(1, Math.max(rho, memUtil)), bottleneck }
}

// Queueing-theoretic (M/M/1-style) saturation latency multiplier: latency should blow up
// hyperbolically as utilization (rho) approaches 1, not plateau at a fixed ceiling. `1 / (1 - rho)`,
// clamped at rho=0.99 purely for numerical safety (never divide by zero/near-zero). Moved here from
// particleEngine.ts so wallTimeMs below can share it -- particleEngine.ts re-exports this symbol
// unchanged so existing imports (e.g. saturationLatency.test.ts) keep working without modification.
export function saturationLatencyMultiplier(rawUtilization: number): number {
  const clamped = Math.min(rawUtilization, 0.99)
  return 1 / (1 - clamped)
}

// Wall-clock hold time for a request: the IO/base latency (from latencyModel, passed in) is the
// dominant term; CPU compute time adds on top, amplified by the node's CURRENT CPU saturation
// (rho) via saturationLatencyMultiplier -- a request processed while the CPU is 90% saturated
// really does take longer than one processed idle, and this now feeds the REAL scheduled hold
// time (not just a displayed percentile), so thread-pool occupancy reflects real compute
// pressure. Only the CPU term is amplified -- baseLatencyMs (IO/base latency) is untouched, since
// CPU-scheduler contention slows CPU-bound work, not IO waiting. ioBoundFraction is intentionally
// NOT used to rebuild latency here (a fraction can't regenerate absolute IO time from near-zero
// CPU time) — it lives in maxThreadsCPU only.
export function wallTimeMs(baseLatencyMs: number, w: WorkloadDemand, p: ComputeProfile, rho: number): number {
  return Math.max(1, baseLatencyMs + cpuTimeSec(w, p) * 1000 * saturationLatencyMultiplier(rho))
}

export type Ec2Admission = 'admit' | 'drop-503' | 'oom-crash'

// Admission decision for one arriving request, given current in-flight count.
//
// Overload degrades GRACEFULLY: because the admission cap (hardThreadCap) is memory-derived, a
// correctly-provisioned node reaches its cap and sheds 503s while RAM is still (just) within
// bounds — so sustained overload manifests as rejections + rising latency, never a crash. OOM is
// reserved for a genuine, unrecoverable breach: the box cannot hold even ONE request's footprint
// (`maxThreadsMem <= 0` — e.g. osBase alone already exceeds RAM, or a single footprint overflows).
// CPU pressure never appears here — it is a latency effect, not a rejection.
export function ec2AdmissionDecision(
  activeRequests: number, w: WorkloadDemand, p: ComputeProfile,
): Ec2Admission {
  if (maxThreadsMem(w, p) <= 0) return 'oom-crash'
  if (activeRequests >= hardThreadCap(w, p)) return 'drop-503'
  return 'admit'
}

// Gate helper: an EC2 node participates in the compute model only when it carries both a hardware
// profile and a workload. Legacy files / non-EC2 configs return null and keep legacy behavior.
export function resolveEc2Resources(
  config: NodeSimConfig,
): { profile: ComputeProfile; workload: WorkloadDemand } | null {
  if (!config.computeProfile || !config.workload) return null
  return { profile: config.computeProfile, workload: config.workload }
}
