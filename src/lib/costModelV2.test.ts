import { describe, it, expect } from 'vitest'
import { computeWorldCost } from './costModelV2'
import { createWorld, createRegion, createAz, createServer, createLoadBalancer } from './world/factories'
import { getPreset } from './world/instanceCatalog'
import { useWorldStore } from '../app/store/world.store'
import type { WorldDoc } from './world/types'

function twoServerWorld(): { doc: WorldDoc; regionId: string; azId: string } {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  doc.regions[region.id] = region
  doc.azs[az.id] = az
  const s1 = createServer(az.id, getPreset('vps-medium')!)   // 0.036 usd/hr
  const s2 = createServer(az.id, getPreset('dedicated-8')!)  // 0.34 usd/hr
  doc.servers[s1.id] = s1
  doc.servers[s2.id] = s2
  return { doc, regionId: region.id, azId: az.id }
}

describe('computeWorldCost', () => {
  it('sums server hourly costs exactly (× 730 hr/mo), same total in byRegion and byAz', () => {
    const { doc, regionId, azId } = twoServerWorld()
    const result = computeWorldCost(doc, null)
    const expected = (0.036 + 0.34) * 730
    expect(result.monthlyUsd).toBeCloseTo(expected, 5)
    expect(result.byRegion).toEqual([{ regionId, monthlyUsd: expect.closeTo(expected, 5) }])
    expect(result.byAz).toEqual([{ azId, monthlyUsd: expect.closeTo(expected, 5) }])
  })

  it('null world metrics → egress is all zero', () => {
    const { doc } = twoServerWorld()
    const result = computeWorldCost(doc, null)
    expect(result.egress).toEqual({ crossAzUsd: 0, crossRegionUsd: 0, internetUsd: 0 })
  })

  it('resolves managed-service pricing via the rds/s3/sqs alias map, ignores generic provider', () => {
    const { doc, regionId, azId } = twoServerWorld()
    doc.managedServices['ms-1'] = {
      id: 'ms-1', label: 'db', nodeType: 'rds', provider: 'aws',
      scope: { kind: 'az', azId }, port: 5432,
    }
    doc.managedServices['ms-2'] = {
      id: 'ms-2', label: 'generic-thing', nodeType: 'rds', provider: 'generic',
      scope: { kind: 'region', regionId }, port: 5432,
    }
    const withMs = computeWorldCost(doc, null)
    const withoutMs = computeWorldCost({ ...doc, managedServices: {} }, null)
    // ms-1 (aws/rds → dbSql) contributes a nonzero instanceHourly cost; ms-2 (generic) contributes $0.
    expect(withMs.monthlyUsd).toBeGreaterThan(withoutMs.monthlyUsd)
    const azDelta = withMs.byAz.find(a => a.azId === azId)!.monthlyUsd - withoutMs.byAz.find(a => a.azId === azId)!.monthlyUsd
    expect(azDelta).toBeGreaterThan(0)
  })

  it('prices new managed services authored with CLOUD_REGISTRY keys directly (dbSql)', () => {
    const { doc, azId } = twoServerWorld()
    // New authoring emits 'dbSql' directly (not 'rds')
    doc.managedServices['ms-new'] = {
      id: 'ms-new', label: 'SQL DB', nodeType: 'dbSql', provider: 'aws',
      scope: { kind: 'az', azId }, port: 5432,
    }
    const withMs = computeWorldCost(doc, null)
    const withoutMs = computeWorldCost({ ...doc, managedServices: {} }, null)
    // dbSql (aws) contributes a nonzero instanceHourly cost.
    expect(withMs.monthlyUsd).toBeGreaterThan(withoutMs.monthlyUsd)
  })

  it('authored aws managed service prices non-zero', () => {
    // R6 (grounding §0): unlike the hand-built-fixture case above, this drives the STORE-authored
    // path — proving addManagedService's new provider param actually reaches a priced document,
    // not just that computeWorldCost can price a manually-constructed ManagedService literal.
    useWorldStore.getState().newWorld()
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')
    const doc = useWorldStore.getState().doc
    expect(computeWorldCost(doc, null).monthlyUsd).toBeGreaterThan(0)
  })

  it('prices an authored regional load balancer at aws LB-hours, folded into its region', () => {
    const { doc, regionId } = twoServerWorld()
    const baseline = computeWorldCost(doc, null)
    expect(baseline.loadBalancerCount).toBe(0)
    expect(baseline.loadBalancerUsd).toBe(0)

    const lb = createLoadBalancer(regionId)
    doc.loadBalancers[lb.id] = lb
    const withLb = computeWorldCost(doc, null)

    const expectedLb = 0.0225 * 1 * 730   // aws loadBalancer instanceHourly × 730
    expect(withLb.loadBalancerCount).toBe(1)
    expect(withLb.loadBalancerUsd).toBeCloseTo(expectedLb, 5)
    // folded into the region total (scopedCost reads byRegion) and the world total, exactly once
    expect(withLb.byRegion.find(r => r.regionId === regionId)!.monthlyUsd)
      .toBeCloseTo(baseline.byRegion.find(r => r.regionId === regionId)!.monthlyUsd + expectedLb, 5)
    expect(withLb.monthlyUsd).toBeCloseTo(baseline.monthlyUsd + expectedLb, 5)
  })

  it('does not price a load balancer whose region was deleted', () => {
    const { doc } = twoServerWorld()
    const lb = createLoadBalancer('region-that-does-not-exist')
    doc.loadBalancers[lb.id] = lb
    expect(computeWorldCost(doc, null).loadBalancerCount).toBe(0)
  })

  it('still prices legacy managed services with old nodeType aliases (rds)', () => {
    const { doc, regionId } = twoServerWorld()
    // Legacy doc with the old 'rds' alias should still work via MANAGED_TYPE_ALIASES.
    doc.managedServices['ms-legacy'] = {
      id: 'ms-legacy', label: 'Legacy DB', nodeType: 'rds', provider: 'aws',
      scope: { kind: 'region', regionId }, port: 5432,
    }
    const withMs = computeWorldCost(doc, null)
    const withoutMs = computeWorldCost({ ...doc, managedServices: {} }, null)
    // rds alias → dbSql contributes a nonzero instanceHourly cost.
    expect(withMs.monthlyUsd).toBeGreaterThan(withoutMs.monthlyUsd)
  })
})
