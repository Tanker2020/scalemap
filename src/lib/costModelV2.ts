// World-level monthly cost projection (spec decision 8): Σ server hourlyUsd×730 + managed
// service pricing (reused from cloudRegistry) + egress from live WorldMetrics byte rates.
import type { WorldDoc, RegionId, AzId, ManagedService } from './world/types'
import type { WorldMetrics } from './worldEngine/types'
import { getServiceSpec, egressMonthlyCost, type CloudProvider } from './cloudRegistry'
import { getDbInstanceClass } from './dbInstanceClasses'

// Provisioned-storage rate for a cloud-managed DB ($/GB-month) — the gp3-class rate the dbSql
// registry entry already uses. A single rate (not a tier ladder) matches how DB storage is priced.
const DB_STORAGE_USD_PER_GB_MONTH = 0.115

export const HOURS_PER_MONTH = 730
const CROSS_AZ_USD_PER_GB = 0.01
const CROSS_REGION_USD_PER_GB = 0.02
const BYTES_PER_GB = 1024 ** 3
const SECONDS_PER_MONTH = 2_630_000   // spec decision 8's documented ~30.4-day constant

// PlacementPanel.tsx's managed-service picker now authors new services with CLOUD_REGISTRY keys
// directly (D12). This alias table bridges LEGACY `.scalemap` documents saved with old nodeType
// values ('rds', 's3', 'sqs') so they still price correctly when loaded; new documents never use
// aliases. Every alias below will eventually become a no-op as legacy documents age out.
const MANAGED_TYPE_ALIASES: Record<string, string> = {
  rds: 'dbSql', s3: 'objectStorage', sqs: 'queue',
  redis: 'redis', cdn: 'cdn', apiGateway: 'apiGateway', lambda: 'lambda',
}

export interface WorldCostResult {
  monthlyUsd: number
  byRegion: { regionId: RegionId; monthlyUsd: number }[]
  byAz: { azId: AzId; monthlyUsd: number }[]
  egress: { crossAzUsd: number; crossRegionUsd: number; internetUsd: number }
  // Total LB-hours cost of every AUTHORED regional load balancer (Phase 3). Already folded into
  // byRegion (each LB is region-scoped) and therefore into monthlyUsd — exposed separately only
  // as an itemization line for the Cost tab, NOT a second addend.
  loadBalancerUsd: number
  loadBalancerCount: number
}

// LBs carry no provider field, so their LB-hours price at the aws default — the same
// single-provider simplification the internet-egress line already makes. Cross-zone LB traffic is
// NOT billed here: it rides the cross-AZ egress bytes the engine already meters and costs above.
const LB_PROVIDER: CloudProvider = 'aws'

function loadBalancerMonthlyUsd(): number {
  const spec = getServiceSpec('loadBalancer', LB_PROVIDER)
  if (!spec) return 0
  let usd = 0
  for (const c of spec.pricing) {
    if (c.kind === 'instanceHourly') usd += c.defaultRateUsdHr * c.defaultCount * HOURS_PER_MONTH
    // egress component: intentionally skipped — cross-zone bytes are already in cross-AZ egress.
  }
  return usd
}

function managedServiceMonthlyUsd(ms: ManagedService): number {
  // Cloud-managed DB with a chosen instance class (node-model Phase 3): the class fixes the base
  // hourly, replicas add proportional cost, and provisioned storage is billed per GB. This wins
  // over the registry's flat rate because the class IS the sizing decision.
  const dbClass = getDbInstanceClass(ms.instanceClassId)
  if (dbClass) {
    const instances = 1 + (ms.replicaCount ?? 0) + (ms.multiAz ? 1 : 0)   // primary + replicas + standby
    const compute = dbClass.hourlyUsd * instances * HOURS_PER_MONTH
    const storage = (ms.storageGb ?? 0) * DB_STORAGE_USD_PER_GB_MONTH
    return compute + storage
  }

  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[ms.nodeType] ?? ms.nodeType, ms.provider)
  if (!spec) return 0   // 'generic' provider or unmapped nodeType — documented Phase-2 $0
  let usd = 0
  for (const c of spec.pricing) {
    if (c.kind === 'instanceHourly') usd += c.defaultRateUsdHr * c.defaultCount * HOURS_PER_MONTH
    else if (c.kind === 'fixedMonthly') usd += c.usd
    // requestsPerMillion / storageGbMonth / computeResource / egress: skipped in Phase 2 — no
    // per-service traffic volume or provisioned capacity is modeled on ManagedService yet.
  }
  return usd
}

export function computeWorldCost(doc: WorldDoc, world: WorldMetrics | null): WorldCostResult {
  const byRegionMap = new Map<RegionId, number>()
  const byAzMap = new Map<AzId, number>()
  const bump = (map: Map<string, number>, key: string, usd: number) => map.set(key, (map.get(key) ?? 0) + usd)

  for (const server of Object.values(doc.servers)) {
    const usd = server.hourlyUsd * HOURS_PER_MONTH
    bump(byAzMap, server.azId, usd)
    const az = doc.azs[server.azId]
    if (az) bump(byRegionMap, az.regionId, usd)
  }

  for (const ms of Object.values(doc.managedServices)) {
    const usd = managedServiceMonthlyUsd(ms)
    if (usd === 0) continue
    if (ms.scope.kind === 'az') {
      bump(byAzMap, ms.scope.azId, usd)
      const az = doc.azs[ms.scope.azId]
      if (az) bump(byRegionMap, az.regionId, usd)
    } else {
      bump(byRegionMap, ms.scope.regionId, usd)
    }
  }

  // Regional load balancers (Phase 3): each AUTHORED LB adds LB-hours to its region (region-scoped
  // like a region-level managed service — bumped into byRegion so region-scoped cost picks it up).
  let loadBalancerUsd = 0
  let loadBalancerCount = 0
  for (const lb of Object.values(doc.loadBalancers)) {
    if (!doc.regions[lb.regionId]) continue
    const usd = loadBalancerMonthlyUsd()
    bump(byRegionMap, lb.regionId, usd)
    loadBalancerUsd += usd
    loadBalancerCount += 1
  }

  const crossAzUsd = world ? (world.crossAzBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_AZ_USD_PER_GB : 0
  const crossRegionUsd = world ? (world.crossRegionBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_REGION_USD_PER_GB : 0
  // Internet egress bills at PROVIDER_EGRESS.aws's tiered schedule regardless of the world's
  // actual provider mix — Phase 2 doesn't yet attribute egress cost per-provider (that requires
  // tracking which provider's traffic produced which bytes, not modeled yet). Documented
  // simplification; a future phase can split this once egress is attributed per-provider.
  const internetGbMonth = world ? (world.internetEgressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB : 0
  const internetUsd = world ? egressMonthlyCost('aws', internetGbMonth) : 0

  // byRegionMap already sums every server + every managed service + every load balancer exactly
  // once (each contributes to exactly one region, directly or via its AZ's region) — safe to use
  // directly as the compute total, no need to re-walk the doc again. loadBalancerUsd is a SUBSET
  // of this (already bumped in above), so it is NOT added to monthlyUsd a second time.
  const computeTotal = [...byRegionMap.values()].reduce((a, b) => a + b, 0)
  const monthlyUsd = computeTotal + crossAzUsd + crossRegionUsd + internetUsd

  return {
    monthlyUsd,
    byRegion: [...byRegionMap.entries()].map(([regionId, monthlyUsd]) => ({ regionId, monthlyUsd })),
    byAz: [...byAzMap.entries()].map(([azId, monthlyUsd]) => ({ azId, monthlyUsd })),
    egress: { crossAzUsd, crossRegionUsd, internetUsd },
    loadBalancerUsd,
    loadBalancerCount,
  }
}
