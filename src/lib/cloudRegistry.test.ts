import { describe, it, expect } from 'vitest'
import { resolveProviderLabel } from './cloudRegistry'

describe('resolveProviderLabel', () => {
  it('rewrites the generic default label to the provider service name', () => {
    expect(resolveProviderLabel('ec2', 'aws', 'EC2 / VM', 'EC2 / VM')).toBe('Amazon EC2')
  })

  it('rewrites when hopping between two real providers (still an unedited default)', () => {
    // Node was 'aws' (label = "Amazon EC2"), user now switches to 'gcp'.
    expect(resolveProviderLabel('ec2', 'gcp', 'Amazon EC2', 'EC2 / VM')).toBe('Compute Engine')
  })

  it('reverts to the generic label when switching back to generic', () => {
    expect(resolveProviderLabel('ec2', 'generic', 'Amazon EC2', 'EC2 / VM')).toBe('EC2 / VM')
  })

  it('never overwrites a user-customized label', () => {
    expect(resolveProviderLabel('ec2', 'aws', 'my-checkout-service', 'EC2 / VM')).toBe('my-checkout-service')
  })

  it('leaves a customized label alone even across further provider switches', () => {
    const custom = resolveProviderLabel('ec2', 'aws', 'my-checkout-service', 'EC2 / VM')
    expect(resolveProviderLabel('ec2', 'gcp', custom, 'EC2 / VM')).toBe('my-checkout-service')
  })

  it('falls back to the generic label for a node type with no cloud mapping', () => {
    expect(resolveProviderLabel('vpc', 'aws', 'VPC', 'VPC')).toBe('VPC')
  })

  it('falls back to the generic label if selecting generic on an unmapped type', () => {
    expect(resolveProviderLabel('vpc', 'generic', 'VPC', 'VPC')).toBe('VPC')
  })

  it('maps loadBalancer -> aws to the ALB/NLB branded name', () => {
    expect(resolveProviderLabel('loadBalancer', 'aws', 'Load Balancer', 'Load Balancer')).toBe('ALB / NLB')
  })

  it('maps dbSql -> gcp to Cloud SQL / Spanner', () => {
    expect(resolveProviderLabel('dbSql', 'gcp', 'Database (SQL)', 'Database (SQL)')).toBe('Cloud SQL / Spanner')
  })

  it('maps queue -> azure to Queue Storage', () => {
    expect(resolveProviderLabel('queue', 'azure', 'Message Queue', 'Message Queue')).toBe('Queue Storage')
  })
})
