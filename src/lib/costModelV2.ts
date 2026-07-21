// World-level monthly cost projection (spec decision 8): Σ server hourlyUsd×730 + managed
// service pricing (reused from cloudRegistry) + egress from live WorldMetrics byte rates.
import type { WorldDoc, RegionId, AzId, ManagedServiceId, ManagedService } from './world/types'
import type { WorldMetrics, ManagedServiceMetrics } from './worldEngine/types'
import { getServiceSpec, egressMonthlyCost, PROVIDER_EGRESS, type CloudProvider, type RealProvider } from './cloudRegistry'
import { getDbInstanceClass } from './dbInstanceClasses'

// Provisioned-storage rate for a cloud-managed DB ($/GB-month) — the gp3-class rate the dbSql
// registry entry already uses. A single rate (not a tier ladder) matches how DB storage is priced.
const DB_STORAGE_USD_PER_GB_MONTH = 0.115

export const HOURS_PER_MONTH = 730
const CROSS_AZ_USD_PER_GB = 0.01
const CROSS_REGION_USD_PER_GB = 0.02
const BYTES_PER_GB = 1024 ** 3
const SECONDS_PER_MONTH = 2_630_000   // spec decision 8's documented ~30.4-day constant

// ManagedPanel.tsx's managed-service picker authors new services with CLOUD_REGISTRY keys
// directly (D12). This alias table bridged LEGACY `.scalemap` documents saved with old nodeType
// values ('rds', 's3', 'sqs'). As of node-model Phase 5 those documents are v2 and rejected on
// load outright, so the aliases below are now effectively unreachable — kept only as a harmless
// identity/defensive mapping (removing them is a separate cleanup, not part of the cutover).
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
  // Per-service internet egress of storage/CDN managed services (node-model Phase 5.2) — already
  // folded into byRegion/byAz/monthlyUsd (each is region- or az-scoped); exposed as an itemization
  // line, not a second addend.
  managedEgressUsd: number
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

// Commitment discounts on a PROVISIONED managed DB (node-model Phase 5.4). Committing to a term
// buys the same capacity cheaper — the classic reserved-instance trade, and the reason a stable
// workload is priced very differently from a spiky one.
const RESERVED_DISCOUNT: Record<string, number> = { onDemand: 0, reserved1yr: 0.4, reserved3yr: 0.6 }

// Serverless/on-demand request price (node-model Phase 5.4). A serverless DB bills per request
// instead of per instance-hour: idle costs (almost) nothing, saturation costs more than the box
// would have. Indicative-realistic, like the rest of this model.
const SERVERLESS_USD_PER_MILLION_REQUESTS = 0.25

function managedServiceMonthlyUsd(ms: ManagedService, rps = 0): number {
  // Cloud-managed DB with a chosen instance class (node-model Phase 3): the class fixes the base
  // hourly, replicas add proportional cost, and provisioned storage is billed per GB. This wins
  // over the registry's flat rate because the class IS the sizing decision.
  const dbClass = getDbInstanceClass(ms.instanceClassId)
  if (dbClass) {
    const instances = 1 + (ms.replicaCount ?? 0) + (ms.multiAz ? 1 : 0)   // primary + replicas + standby
    const storage = (ms.storageGb ?? 0) * DB_STORAGE_USD_PER_GB_MONTH
    // Phase 5.4 — capacity mode decides the SHAPE of the compute bill:
    //   serverless  → no instance-hours at all; pay per request off live traffic. A commitment
    //                 discount cannot apply, because there is no provisioned capacity to commit to.
    //   provisioned → instance-hours as before, discounted by the commitment term.
    if (ms.capacityMode === 'serverless') {
      const requestsPerMonth = Math.max(0, rps) * SECONDS_PER_MONTH
      return (requestsPerMonth / 1_000_000) * SERVERLESS_USD_PER_MILLION_REQUESTS + storage
    }
    const discount = RESERVED_DISCOUNT[ms.pricing ?? 'onDemand'] ?? 0
    const compute = dbClass.hourlyUsd * instances * HOURS_PER_MONTH * (1 - discount)
    return compute + storage
  }

  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[ms.nodeType] ?? ms.nodeType, ms.provider)
  if (!spec) return 0   // 'generic' provider or unmapped nodeType — documented Phase-2 $0
  let usd = 0
  for (const c of spec.pricing) {
    if (c.kind === 'instanceHourly') usd += c.defaultRateUsdHr * c.defaultCount * HOURS_PER_MONTH
    else if (c.kind === 'fixedMonthly') usd += c.usd
    else if (c.kind === 'storageGbMonth') {
      // node-model Phase 5.2: provisioned storage for object/file storage is now billed — the
      // chosen tier's $/GB-month × configured GB (default = the first/standard tier).
      const tier = c.tiers.find(t => t.id === ms.storageTierId) ?? c.tiers[0]
      usd += (ms.storageGb ?? 0) * (tier?.storageGbMonth ?? 0)
    }
    // requestsPerMillion / computeResource / egress: still skipped here — request-volume pricing
    // isn't modeled; egress is priced per-service from live metrics (managedEgressUsd, below).
  }
  return usd
}

// Per-service internet egress for a storage/CDN managed service (node-model Phase 5.2). Served
// bytes come from live metrics; the free allowance is the provider's base free tier PLUS its
// free-egress-per-stored-GB grant (the Backblaze model — 0 for aws/gcp/azure today) × provisioned
// storage. Priced at the service's OWN provider schedule (fixing the world line's aws-for-all
// simplification for these services). 0 for a generic-provider or zero-traffic service.
function managedEgressUsd(ms: ManagedService, egressBytesPerSec: number): number {
  if (ms.provider === 'generic' || egressBytesPerSec <= 0) return 0
  const provider = ms.provider as RealProvider
  const gbMonth = (egressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB
  const storageFreeGb = PROVIDER_EGRESS[provider].freeEgressPerStoredGb * (ms.storageGb ?? 0)
  // egressMonthlyCost subtracts the provider's base freeGbMonth itself; pre-subtract the
  // storage-based allowance so the total free egress = base + storage grant.
  return egressMonthlyCost(provider, Math.max(0, gbMonth - storageFreeGb))
}

export function computeWorldCost(
  doc: WorldDoc,
  world: WorldMetrics | null,
  managed: Record<ManagedServiceId, ManagedServiceMetrics> | null = null,
): WorldCostResult {
  const byRegionMap = new Map<RegionId, number>()
  const byAzMap = new Map<AzId, number>()
  const bump = (map: Map<string, number>, key: string, usd: number) => map.set(key, (map.get(key) ?? 0) + usd)
  let managedEgressTotal = 0

  for (const server of Object.values(doc.servers)) {
    const usd = server.hourlyUsd * HOURS_PER_MONTH
    bump(byAzMap, server.azId, usd)
    const az = doc.azs[server.azId]
    if (az) bump(byRegionMap, az.regionId, usd)
  }

  for (const ms of Object.values(doc.managedServices)) {
    const egr = managed ? managedEgressUsd(ms, managed[ms.id]?.egressBytesPerSec ?? 0) : 0
    managedEgressTotal += egr
    // Live rps feeds serverless per-request pricing (Phase 5.4); ignored for provisioned classes.
    const usd = managedServiceMonthlyUsd(ms, managed?.[ms.id]?.rps ?? 0) + egr
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
    managedEgressUsd: managedEgressTotal,
  }
}
