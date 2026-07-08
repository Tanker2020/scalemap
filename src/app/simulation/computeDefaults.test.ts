import { describe, it, expect } from 'vitest'
import { NODE_SIM_DEFAULTS, DEFAULT_EC2_COMPUTE_PROFILE, DEFAULT_PACKET_WORKLOAD } from './defaults'
import { hardThreadCap, cpuUtilization } from '../canvas/simulation/particleEngine/compute'

describe('ec2 compute defaults', () => {
  it('ec2 ships a compute profile + workload and no manual maxThreads', () => {
    const ec2 = NODE_SIM_DEFAULTS.ec2
    expect(ec2.computeProfile).toBeDefined()
    expect(ec2.maxThreads).toBeUndefined()
  })

  it('default profile yields a sane, CPU-bound envelope', () => {
    const p = DEFAULT_EC2_COMPUTE_PROFILE
    const w = DEFAULT_PACKET_WORKLOAD
    // memory allows far more concurrency than CPU saturates -> CPU-bound
    expect(hardThreadCap(w, p)).toBeGreaterThan(50)
    expect(cpuUtilization(240, w, p)).toBeCloseTo(1.0, 1)
  })
})
