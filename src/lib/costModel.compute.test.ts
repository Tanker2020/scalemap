import { describe, it, expect } from 'vitest'
import type { Node } from '@xyflow/react'
import type { NodeData } from './nodeConfig'
import { computeCost } from './costModel'
import { DEFAULT_EC2_COMPUTE_PROFILE } from '../app/simulation/defaults'

function ec2(provider: 'aws', arch: 'x86_64' | 'arm64'): Node<NodeData> {
  return {
    id: 'n1', type: 'ec2', position: { x: 0, y: 0 },
    data: {
      label: 'web', subtitle: '', status: 'healthy', notes: '', warnings: [],
      provider,
      simConfig: {
        computeProfile: {
          vCpu: 4, ramGiB: 8, architecture: arch, cpuFamily: 'x', baseClockGhz: 3, blockingIoModel: true,
        },
      },
    },
  } as Node<NodeData>
}

describe('compute-resource cost', () => {
  it('bills vCPU + RAM hourly for an EC2 with a compute profile', () => {
    const summary = computeCost([ec2('aws', 'x86_64')], new Map())
    const node = summary.perNode.find(n => n.nodeId === 'n1')!
    expect(node.components.some(c => c.kind === 'computeResource')).toBe(true)
    // 4 vCPU * 0.010 + 8 GiB * 0.0012 = 0.0496 /hr * 730 = 36.208 /mo
    expect(node.monthlyUsd).toBeCloseTo((4 * 0.010 + 8 * 0.0012) * 730, 2)
  })

  it('arm64 is cheaper than x86 for the same shape', () => {
    const x86 = computeCost([ec2('aws', 'x86_64')], new Map()).totalMonthlyUsd
    const arm = computeCost([ec2('aws', 'arm64')], new Map()).totalMonthlyUsd
    expect(arm).toBeLessThan(x86)
  })

  it('bills the default compute profile when the node has no simConfig (real-app data flow)', () => {
    // New nodes ship with no simConfig, and SimConfigPanel writes hardware edits to the transient
    // simulation store, not node.data — so cost must fall back to NODE_SIM_DEFAULTS.ec2's profile,
    // else every real EC2 node bills $0 for compute. Regression guard for that data-flow gap.
    const bare: Node<NodeData> = {
      id: 'n2', type: 'ec2', position: { x: 0, y: 0 },
      data: { label: 'web', subtitle: '', status: 'healthy', notes: '', warnings: [], provider: 'aws' },
    } as Node<NodeData>
    const node = computeCost([bare], new Map()).perNode.find(n => n.nodeId === 'n2')!
    expect(node.components.some(c => c.kind === 'computeResource')).toBe(true)
    const p = DEFAULT_EC2_COMPUTE_PROFILE // aws x86 rates: 0.010 vCPU-hr, 0.0012 GiB-hr
    expect(node.monthlyUsd).toBeCloseTo((p.vCpu * 0.010 + p.ramGiB * 0.0012) * 730, 2)
  })
})
