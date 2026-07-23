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

  // node-model Phase 3: a cloud DB's instance class drives its price. A store-authored dbSql is
  // born on sql.small ($0.10/hr → ~$73/mo) + 100GB storage — the class-based path, not the
  // registry's flat instanceHourly rate.
  it('prices a cloud DB from its instance class, and replicas raise it', () => {
    useWorldStore.getState().newWorld()
    const regionId = useWorldStore.getState().addRegion('us-east-1')
    const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
    const msId = useWorldStore.getState().addManagedService('dbSql', 'SQL DB', { kind: 'az', azId }, 5432, 'aws')

    const base = computeWorldCost(useWorldStore.getState().doc, null).monthlyUsd
    // sql.small $0.10/hr × 730 + 100GB × $0.115 = 73 + 11.5 = 84.5.
    expect(base).toBeCloseTo(0.10 * 730 + 100 * 0.115, 1)

    useWorldStore.getState().updateManagedService(msId, { replicaCount: 2 })
    const withReplicas = computeWorldCost(useWorldStore.getState().doc, null).monthlyUsd
    // 3 instances now (primary + 2 replicas): compute triples, storage unchanged.
    expect(withReplicas).toBeCloseTo(0.10 * 730 * 3 + 100 * 0.115, 1)
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

  // node-model Phase 5.2: object-storage provisioned storage + per-service egress.
  it('prices object-storage provisioned storage by its tier', () => {
    const { doc, azId } = twoServerWorld()
    doc.managedServices['s3'] = {
      id: 's3', label: 'assets', nodeType: 'objectStorage', provider: 'aws',
      scope: { kind: 'az', azId }, port: 443, storageGb: 1000, storageTierId: 'standard',
    }
    const withStore = computeWorldCost(doc, null)
    const without = computeWorldCost({ ...doc, managedServices: {} }, null)
    // aws S3 Standard = $0.023/GB-month × 1000 GB = $23/mo (request + egress lines are $0 here).
    expect(withStore.monthlyUsd - without.monthlyUsd).toBeCloseTo(23, 1)
  })

  it('prices per-service storage egress from live metrics at the provider schedule', () => {
    const { doc, azId } = twoServerWorld()
    doc.managedServices['s3'] = {
      id: 's3', label: 'assets', nodeType: 'objectStorage', provider: 'aws',
      scope: { kind: 'az', azId }, port: 443, storageGb: 0,
    }
    const BYTES_PER_GB = 1024 ** 3
    const SECONDS_PER_MONTH = 730 * 3600   // audit ISSUE-036: one month basis, 730 h
    const gbMonth = 500
    const egressBytesPerSec = (gbMonth * BYTES_PER_GB) / SECONDS_PER_MONTH
    const managed = { s3: { managedServiceId: 's3', rps: 0, refusedRps: 0, utilization: 0, health: 'healthy' as const, egressBytesPerSec } }
    const result = computeWorldCost(doc, null, managed)
    // (500 GB − 100 GB aws free) × $0.09/GB = $36
    expect(result.managedEgressUsd).toBeCloseTo((500 - 100) * 0.09, 1)
    expect(result.byAz.find(a => a.azId === azId)!.monthlyUsd).toBeGreaterThan(0)
  })
})

// node-model Phase 5.4: a managed DB's price now responds to its commitment term and capacity mode
// — the two knobs that change what a given class actually costs.
// Audit ISSUE-003: services whose cost model IS request volume (Lambda, SQS, EventBridge, SNS,
// API Gateway, CDN requests) billed $0/month regardless of traffic because the registry loop
// skipped requestsPerMillion/computeResource. A serverless architecture projected ~$0.
describe('computeWorldCost — request-priced managed services (audit ISSUE-003)', () => {
  const SECONDS_PER_MONTH = 730 * 3600   // audit ISSUE-036: one month basis, 730 h
  const mkManaged = (id: string, rps: number) => ({
    [id]: {
      managedServiceId: id, rps, refusedRps: 0, utilization: 0.2,
      health: 'healthy' as const, egressBytesPerSec: 0,
    },
  })
  function withService(nodeType: string, id = 'ms-req') {
    const { doc, regionId } = twoServerWorld()
    doc.managedServices[id] = {
      id, label: nodeType, nodeType, provider: 'aws',
      scope: { kind: 'region', regionId }, port: 443,
    } as WorldDoc['managedServices'][string]
    return doc
  }
  const baseline = computeWorldCost(twoServerWorld().doc, null).monthlyUsd

  it('bills a Lambda per-invocation from live rps (aws $0.20/M)', () => {
    const doc = withService('lambda')
    const usd = computeWorldCost(doc, null, mkManaged('ms-req', 100)).monthlyUsd - baseline
    expect(usd).toBeCloseTo((100 * SECONDS_PER_MONTH / 1e6) * 0.20, 5)
  })

  it('request-priced cost scales with rps, and SQS/API Gateway bill > $0 under traffic', () => {
    for (const nodeType of ['queue', 'apiGateway', 'eventBus', 'pubsub']) {
      const doc = withService(nodeType)
      const at100 = computeWorldCost(doc, null, mkManaged('ms-req', 100)).monthlyUsd - baseline
      const at200 = computeWorldCost(doc, null, mkManaged('ms-req', 200)).monthlyUsd - baseline
      expect(at100).toBeGreaterThan(0)
      expect(at200).toBeCloseTo(at100 * 2, 5)
    }
  })

  it('a zero-traffic Lambda bills $0 (no fixed component), without dropping other services', () => {
    const doc = withService('lambda')
    const usd = computeWorldCost(doc, null, mkManaged('ms-req', 0)).monthlyUsd - baseline
    expect(usd).toBe(0)
  })

  it('a zero-traffic DNS service still bills its fixedMonthly component', () => {
    const doc = withService('dns')
    const usd = computeWorldCost(doc, null, mkManaged('ms-req', 0)).monthlyUsd - baseline
    expect(usd).toBeCloseTo(0.50, 5)   // Route 53 hosted zone
  })

  it('a managed ec2 bills provisioned computeResource even with no traffic', () => {
    const doc = withService('ec2')
    const usd = computeWorldCost(doc, null, null).monthlyUsd - baseline
    // Default sizing 2 vCPU / 4 GiB at aws x86 rates: (2×0.010 + 4×0.0012) × 730.
    expect(usd).toBeCloseTo((2 * 0.010 + 4 * 0.0012) * 730, 5)
  })
})

describe('computeWorldCost — managed-DB pricing commitment + capacity mode (Phase 5.4)', () => {
  function withDb(over: Record<string, unknown>) {
    const { doc, regionId } = twoServerWorld()
    doc.managedServices['ms-db'] = {
      id: 'ms-db', label: 'orders-db', nodeType: 'dbSql', provider: 'aws',
      scope: { kind: 'region', regionId }, port: 5432,
      instanceClassId: 'sql.small', storageGb: 0, ...over,
    } as WorldDoc['managedServices'][string]
    return doc
  }
  const baseline = computeWorldCost(twoServerWorld().doc, null).monthlyUsd
  const dbCost = (over: Record<string, unknown>, managed: Parameters<typeof computeWorldCost>[2] = null) =>
    computeWorldCost(withDb(over), null, managed).monthlyUsd - baseline

  it('discounts a 1-year reserved commitment below on-demand', () => {
    const onDemand = dbCost({ pricing: 'onDemand' })
    const reserved = dbCost({ pricing: 'reserved1yr' })
    expect(onDemand).toBeGreaterThan(0)
    expect(reserved).toBeLessThan(onDemand)
    expect(reserved).toBeCloseTo(onDemand * 0.6, 5)   // 40% off
  })

  it('discounts a 3-year commitment more than a 1-year one', () => {
    expect(dbCost({ pricing: 'reserved3yr' })).toBeLessThan(dbCost({ pricing: 'reserved1yr' }))
  })

  it('defaults to on-demand pricing when no commitment is set', () => {
    expect(dbCost({})).toBeCloseTo(dbCost({ pricing: 'onDemand' }), 5)
  })

  it('prices a serverless DB per-request from live rps instead of a flat hourly', () => {
    const managed = {
      'ms-db': {
        managedServiceId: 'ms-db', rps: 500, refusedRps: 0, utilization: 0.2,
        health: 'healthy' as const, egressBytesPerSec: 0,
      },
    }
    const idle = dbCost({ capacityMode: 'serverless' }, {
      ...managed, 'ms-db': { ...managed['ms-db'], rps: 0 },
    })
    const busy = dbCost({ capacityMode: 'serverless' }, managed)
    expect(busy).toBeGreaterThan(idle)     // usage-priced: traffic costs money
    expect(idle).toBeLessThan(dbCost({ capacityMode: 'provisioned' }))   // idle serverless is cheaper
  })

  it('does not apply a reserved discount to a serverless DB (no commitment to make)', () => {
    expect(dbCost({ capacityMode: 'serverless', pricing: 'reserved3yr' }))
      .toBeCloseTo(dbCost({ capacityMode: 'serverless', pricing: 'onDemand' }), 5)
  })

  // Defense-in-depth regression (final whole-branch review, Critical fix part (b)): a service
  // whose nodeType has been switched away from a DB type must never be billed as a provisioned
  // DB, even if it still happens to carry a stale instanceClassId left over from before the
  // switch (the scenario draftToConfig's fix in managedDraft.ts now prevents at the source —
  // this test guards costModelV2.ts's own independent check of managedDbEngine(nodeType) before
  // trusting ms.instanceClassId, in case a stale value reaches here through any other path).
  it('does not price a non-DB nodeType as a provisioned DB even with a stale instanceClassId present', () => {
    const { doc, regionId } = twoServerWorld()
    doc.managedServices['ms-queue'] = {
      id: 'ms-queue', label: 'orders-queue', nodeType: 'queue', provider: 'aws',
      scope: { kind: 'region', regionId }, port: 5672,
      instanceClassId: 'sql.small', capacityMode: 'provisioned', // stale DB fields
    } as WorldDoc['managedServices'][string]
    const withStaleQueue = computeWorldCost(doc, null).monthlyUsd

    const cleanDoc = twoServerWorld().doc
    cleanDoc.managedServices['ms-queue'] = {
      id: 'ms-queue', label: 'orders-queue', nodeType: 'queue', provider: 'aws',
      scope: { kind: 'region', regionId }, port: 5672,
    } as WorldDoc['managedServices'][string]
    const withCleanQueue = computeWorldCost(cleanDoc, null).monthlyUsd

    // A 'generic'/aws queue with no registry pricing component prices at $0 — identical to the
    // clean version. If the stale instanceClassId were wrongly trusted, this would instead price
    // as a provisioned sql.small instance (tens of dollars/month) and the two would diverge.
    expect(withStaleQueue).toBeCloseTo(withCleanQueue, 5)
  })
})

// Audit ISSUE-024: the total accumulates alongside every bump — a server whose AZ was deleted
// (a normal transient while editing) must still be in monthlyUsd, and sum(byAz) must cover it.
describe('computeWorldCost — orphaned-AZ completeness (ISSUE-024)', () => {
  it('a server pointing at a deleted AZ still contributes to monthlyUsd', () => {
    const { doc } = twoServerWorld()
    const orphan = createServer('az-deleted', getPreset('dedicated-8')!)   // 0.34 usd/hr
    doc.servers[orphan.id] = orphan
    const result = computeWorldCost(doc, null)
    const expected = (0.036 + 0.34 + 0.34) * 730
    expect(result.monthlyUsd).toBeCloseTo(expected, 5)
    // The orphan appears in byAz (under its dangling AZ id) and byAz sums to the compute total.
    const byAzSum = result.byAz.reduce((s, e) => s + e.monthlyUsd, 0)
    expect(byAzSum).toBeCloseTo(expected, 5)
  })

  it('an az-scoped managed service on a deleted AZ still contributes to monthlyUsd', () => {
    const { doc } = twoServerWorld()
    doc.managedServices['ms-orphan'] = {
      id: 'ms-orphan', label: 'db', nodeType: 'dbSql', provider: 'aws',
      scope: { kind: 'az', azId: 'az-deleted' }, port: 5432,
    }
    const withMs = computeWorldCost(doc, null)
    const withoutMs = computeWorldCost({ ...doc, managedServices: {} }, null)
    expect(withMs.monthlyUsd).toBeGreaterThan(withoutMs.monthlyUsd)
  })
})

// Audit ISSUE-022: DB provisioned storage bills the PROVIDER's registry rate, not a hardcoded
// AWS constant (GCP Cloud SQL storage is $0.17/GB-month vs AWS/Azure $0.115).
describe('computeWorldCost — provider-correct DB storage rate (ISSUE-022)', () => {
  function dbWithStorage(provider: 'aws' | 'gcp' | 'azure') {
    const { doc, regionId } = twoServerWorld()
    doc.managedServices['ms-db'] = {
      id: 'ms-db', label: 'orders-db', nodeType: 'dbSql', provider,
      scope: { kind: 'region', regionId }, port: 5432,
      instanceClassId: 'sql.small', storageGb: 100,
    } as WorldDoc['managedServices'][string]
    return computeWorldCost(doc, null).monthlyUsd
  }
  function dbNoStorage(provider: 'aws' | 'gcp' | 'azure') {
    const { doc, regionId } = twoServerWorld()
    doc.managedServices['ms-db'] = {
      id: 'ms-db', label: 'orders-db', nodeType: 'dbSql', provider,
      scope: { kind: 'region', regionId }, port: 5432,
      instanceClassId: 'sql.small', storageGb: 0,
    } as WorldDoc['managedServices'][string]
    return computeWorldCost(doc, null).monthlyUsd
  }

  it('bills 100 GB at 0.115 on aws and 0.17 on gcp', () => {
    expect(dbWithStorage('aws') - dbNoStorage('aws')).toBeCloseTo(100 * 0.115, 5)
    expect(dbWithStorage('gcp') - dbNoStorage('gcp')).toBeCloseTo(100 * 0.17, 5)
    expect(dbWithStorage('azure') - dbNoStorage('azure')).toBeCloseTo(100 * 0.115, 5)
  })
})

// Audit ISSUE-023: inter-zone transfer is provider-aware; AWS folds per-direction billing into
// its wire-GB rate (2× the old flat 0.01), Azure's cross-AZ is free.
describe('cross-AZ / cross-region egress rates (ISSUE-023)', () => {
  const GB = 1024 ** 3
  const world = (crossAz: number, crossRegion: number) => ({
    totalRps: 0, errorRate: 0, populationRoutes: [],
    crossAzBytesPerSec: crossAz, crossRegionBytesPerSec: crossRegion, internetEgressBytesPerSec: 0,
  })

  it('bills world cross-AZ at the aws per-direction rate ($0.02/wire-GB)', () => {
    const { doc } = twoServerWorld()
    const result = computeWorldCost(doc, world(GB / 2_628_000 * 1, 0))   // exactly 1 GB/month
    // Exact: crossAzUsd = bytesPerSec × SECONDS_PER_MONTH / GB × 0.02 (SECONDS_PER_MONTH is
    // now derived 730 h × 3600 = 2_628_000, audit ISSUE-036)
    const bytesPerSec = GB / 2_628_000
    const expected = (bytesPerSec * 2_628_000 / GB) * 0.02
    expect(result.egress.crossAzUsd).toBeCloseTo(expected, 6)
  })

  it('per-provider table differs: same bytes cost differently across providers', async () => {
    const { PROVIDER_INTERZONE } = await import('./cloudRegistry')
    expect(PROVIDER_INTERZONE.aws.crossAzUsdPerGb).toBeCloseTo(0.02, 6)     // 2× old flat 0.01
    expect(PROVIDER_INTERZONE.gcp.crossAzUsdPerGb).toBeCloseTo(0.01, 6)
    expect(PROVIDER_INTERZONE.azure.crossAzUsdPerGb).toBe(0)                // Azure AZ transfer free
    expect(PROVIDER_INTERZONE.gcp.crossRegionUsdPerGb)
      .toBeGreaterThan(PROVIDER_INTERZONE.aws.crossRegionUsdPerGb)
  })
})
