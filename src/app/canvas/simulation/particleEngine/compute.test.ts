import { describe, it, expect } from 'vitest'
import type { ComputeProfile, WorkloadDemand } from '../../../../lib/nodeConfig'
import {
  cpuTimeSec, maxThreadsCPU, maxThreadsMem, hardThreadCap,
  cpuUtilization, currentRamMb, nodeUtilization, ec2AdmissionDecision,
  resolveEc2Profile, saturationLatencyMultiplier, wallTimeMs,
} from './compute'
import { DEFAULT_EC2_COMPUTE_PROFILE } from '../../../simulation/defaults'

const P: ComputeProfile = {
  vCpu: 2, ramGiB: 4, architecture: 'x86_64', cpuFamily: 'test',
  baseClockGhz: 3.0, blockingIoModel: true, osBaseMemoryMb: 512, threadStackMb: 1,
}
const W: WorkloadDemand = {
  tier: 'moderate_logic', cpuInstructionsBillions: 0.05, memoryFootprintMb: 32, ioBoundFraction: 0.8,
}

describe('compute math', () => {
  it('cpuTimeSec = instructions / (clock * IPC)', () => {
    // 0.05 / (3.0 * 2.0) = 0.008333.. s
    expect(cpuTimeSec(W, P)).toBeCloseTo(0.05 / 6, 6)
  })

  it('maxThreadsCPU = vCpu / (1 - ioBoundFraction)', () => {
    expect(maxThreadsCPU(P, 0.8)).toBeCloseTo(10, 6) // 2 / 0.2
  })

  it('maxThreadsMem accounts for OS base + thread stack (blocking)', () => {
    // (4096 - 512) / (32 + 1) = 3584 / 33 = 108.6 -> 108
    expect(maxThreadsMem(W, P)).toBe(108)
  })

  it('async model drops the thread-stack term from footprint', () => {
    const async = { ...P, blockingIoModel: false }
    // (4096 - 512) / 32 = 112
    expect(maxThreadsMem(W, async)).toBe(112)
  })

  it('hardThreadCap clamps to maxThreadsOverride when smaller', () => {
    expect(hardThreadCap(W, { ...P, maxThreadsOverride: 50 })).toBe(50)
    expect(hardThreadCap(W, P)).toBe(108) // no override -> memory-bound
  })

  it('cpuUtilization hits 1.0 at ~240 rps for this profile', () => {
    expect(cpuUtilization(240, W, P)).toBeCloseTo(1.0, 1)
    expect(cpuUtilization(120, W, P)).toBeCloseTo(0.5, 1)
  })

  it('nodeUtilization reports cpu-bound when rho exceeds mem util', () => {
    const r = nodeUtilization(240, 10, W, P) // 10 active threads of 108 cap = 0.09 mem util
    expect(r.bottleneck).toBe('cpu')
    expect(r.utilization).toBeCloseTo(1.0, 1)
  })

  it('currentRamMb grows with active requests', () => {
    expect(currentRamMb(0, W, P)).toBe(512)
    expect(currentRamMb(100, W, P)).toBe(512 + 100 * 33)
  })

  it('admission: overload degrades gracefully (503), OOM only when RAM cannot hold one request', () => {
    expect(ec2AdmissionDecision(107, W, P)).toBe('admit')
    expect(ec2AdmissionDecision(108, W, P)).toBe('drop-503')  // at hard cap -> graceful 503
    // Massive overload still sheds 503s, never a crash — the box has capacity, it's just full.
    expect(ec2AdmissionDecision(100000, W, P)).toBe('drop-503')
    // OOM only for a genuine unrecoverable breach: ramGiB below osBaseMemoryMb -> maxThreadsMem <= 0
    // (can't hold even one request), so the first arrival crashes regardless of active count.
    const brokenP = { ...P, ramGiB: 0.25 }  // 256MB RAM < 512MB osBase
    expect(ec2AdmissionDecision(0, W, brokenP)).toBe('oom-crash')
  })
})

describe('resolveEc2Profile', () => {
  it('returns the profile for a config that has one', () => {
    const r = resolveEc2Profile({ maxRps: 1000, processingMs: 10, errorRate: 0, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE })
    expect(r).not.toBeNull()
    expect(r!.vCpu).toBe(2)
  })

  it('returns null when no compute profile is present (legacy nodes)', () => {
    expect(resolveEc2Profile({ maxRps: 1000, processingMs: 10, errorRate: 0 })).toBeNull()
  })
})

describe('saturationLatencyMultiplier', () => {
  it('matches the queueing-theoretic 1/(1-rho) formula, clamped at 0.99', () => {
    expect(saturationLatencyMultiplier(0)).toBeCloseTo(1, 5)
    expect(saturationLatencyMultiplier(0.5)).toBeCloseTo(2, 5)
    expect(saturationLatencyMultiplier(0.9)).toBeCloseTo(10, 5)
    // Clamped at 0.99 for numerical safety near rho=1 — must never divide by (near-)zero.
    expect(saturationLatencyMultiplier(1)).toBeCloseTo(100, 5)
  })
})

describe('wallTimeMs scales the CPU term with live utilization', () => {
  it('amplifies only the CPU-time component as rho rises -- base latency is untouched', () => {
    // cpuTimeSec(W, P) = 0.05 / (3.0 * 2.0) = 0.0083333s = 8.3333ms
    const atIdle = wallTimeMs(20, W, P, 0)    // 20 + 8.3333 * 1  = 28.3333
    const atHalf = wallTimeMs(20, W, P, 0.5)  // 20 + 8.3333 * 2  = 36.6667
    const atHot  = wallTimeMs(20, W, P, 0.9)  // 20 + 8.3333 * 10 = 103.333
    expect(atIdle).toBeCloseTo(28.333, 2)
    expect(atHalf).toBeCloseTo(36.667, 2)
    expect(atHot).toBeCloseTo(103.333, 2)
    // The CPU-time component (total minus the untouched 20ms base) scales exactly with the
    // multiplier; the base latency term itself never changes.
    expect(atHot - 20).toBeCloseTo((atIdle - 20) * 10, 1)
  })
})

describe('IO-model-aware admission (#22) and opt-in memory overcommit (#20)', () => {
  it('non-blocking admits past what a blocking server would already be shedding at, since it has no thread-count gate', () => {
    const asyncP = { ...P, blockingIoModel: false }
    // A blocking equivalent would already be at drop-503 here (hardThreadCap = 108, the
    // stack-inclusive figure). Non-blocking has no thread-count gate at all.
    expect(ec2AdmissionDecision(108, W, asyncP)).toBe('admit')
    // maxThreadsMem(W, asyncP) = floor((4096-512)/32) = 112 (no thread-stack term for async) --
    // still admits exactly at that boundary (currentRamMb == ramGiB*1024 is not '>').
    expect(ec2AdmissionDecision(112, W, asyncP)).toBe('admit')
    // One past it: currentRamMb(113, W, asyncP) = 512 + 113*32 = 4128 > 4096 -- genuinely out of RAM.
    expect(ec2AdmissionDecision(113, W, asyncP)).toBe('oom-crash')
  })

  it('allowMemoryOvercommit lets maxThreadsOverride exceed the memory-safe ceiling, enabling genuine OOM under load', () => {
    const overcommitP = { ...P, maxThreadsOverride: 200, allowMemoryOvercommit: true }
    expect(hardThreadCap(W, overcommitP)).toBe(200) // uncapped by the 108 memory-safe ceiling
    // Below the override cap (200) but currentRamMb(150, W, P) = 512 + 150*33 = 5462 > 4096 --
    // already past physical RAM. Decision 2's opt-in OOM path.
    expect(ec2AdmissionDecision(150, W, overcommitP)).toBe('oom-crash')
  })

  it('without allowMemoryOvercommit, maxThreadsOverride still clamps to the memory-safe ceiling (default unchanged)', () => {
    const overrideOnlyP = { ...P, maxThreadsOverride: 200 }
    expect(hardThreadCap(W, overrideOnlyP)).toBe(108) // unaffected -- still clamped
  })
})
