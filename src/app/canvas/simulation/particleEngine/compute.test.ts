import { describe, it, expect } from 'vitest'
import type { ComputeProfile, WorkloadDemand } from '../../../../lib/nodeConfig'
import {
  cpuTimeSec, maxThreadsCPU, maxThreadsMem, hardThreadCap,
  cpuUtilization, currentRamMb, nodeUtilization, ec2AdmissionDecision,
  resolveEc2Resources,
} from './compute'
import { DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_EC2_WORKLOAD } from '../../../simulation/defaults'

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

  it('admission: admit under cap, drop at cap, crash on OOM', () => {
    expect(ec2AdmissionDecision(107, W, P)).toBe('admit')
    expect(ec2AdmissionDecision(108, W, P)).toBe('drop-503')  // at hard cap
    // Force OOM independent of cap via a tiny override that still leaves RAM exceedable:
    const oomP = { ...P, maxThreadsOverride: 100000 }
    // 200 active * 33MB + 512 = 7112MB > 4096MB -> OOM
    expect(ec2AdmissionDecision(200, W, oomP)).toBe('oom-crash')
  })
})

describe('resolveEc2Resources', () => {
  it('returns profile+workload for a config that has them', () => {
    const r = resolveEc2Resources({ maxRps: 1000, processingMs: 10, errorRate: 0, computeProfile: DEFAULT_EC2_COMPUTE_PROFILE, workload: DEFAULT_EC2_WORKLOAD })
    expect(r).not.toBeNull()
    expect(r!.profile.vCpu).toBe(2)
  })

  it('returns null when no compute profile is present (legacy nodes)', () => {
    expect(resolveEc2Resources({ maxRps: 1000, processingMs: 10, errorRate: 0 })).toBeNull()
  })
})
