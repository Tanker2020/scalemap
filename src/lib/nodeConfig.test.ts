import { describe, it, expect } from 'vitest'
import { FORWARD_ONLY_NODE_TYPES, canDefineOutboundThroughput } from './nodeConfig'
import type { NodeType } from './nodeConfig'

// Pure network-layer relays: they forward whatever arrives, they don't originate traffic.
// apiGateway is deliberately excluded — it's a legitimate internet-facing ingress origin.
const forwardOnly: NodeType[] = ['loadBalancer', 'dns', 'firewall', 'vpn']
const canOriginate: NodeType[] = ['ec2', 'lambda', 'apiGateway', 'cdn', 'container', 'pod']

describe('FORWARD_ONLY_NODE_TYPES', () => {
  it('contains exactly the four pure network-relay types', () => {
    expect([...FORWARD_ONLY_NODE_TYPES].sort()).toEqual([...forwardOnly].sort())
  })

  it('does not include apiGateway', () => {
    expect(FORWARD_ONLY_NODE_TYPES.has('apiGateway')).toBe(false)
  })
})

describe('canDefineOutboundThroughput', () => {
  it.each(forwardOnly)('returns false for %s', (type) => {
    expect(canDefineOutboundThroughput(type)).toBe(false)
  })

  it.each(canOriginate)('returns true for %s', (type) => {
    expect(canDefineOutboundThroughput(type)).toBe(true)
  })

  it('returns true when the source type is unresolved (undefined)', () => {
    expect(canDefineOutboundThroughput(undefined)).toBe(true)
  })
})
