// World-level monthly cost projection (spec decision 8): Σ server hourlyUsd×730 + managed
// service pricing (reused from cloudRegistry) + egress from live WorldMetrics byte rates.
import type { WorldDoc, RegionId, AzId } from './world/types'
import type { WorldMetrics } from './worldEngine/types'
import { getServiceSpec, egressMonthlyCost, type CloudProvider } from './cloudRegistry'

const HOURS_PER_MONTH = 730
const CROSS_AZ_USD_PER_GB = 0.01
const CROSS_REGION_USD_PER_GB = 0.02
const BYTES_PER_GB = 1024 ** 3
const SECONDS_PER_MONTH = 2_630_000   // spec decision 8's documented ~30.4-day constant

// PlacementPanel.tsx's managed-service picker (Phase 1) stores a handful of short,
// human-friendly nodeType strings ('rds', 's3', 'sqs') that predate — and don't match —
// CLOUD_REGISTRY's actual keys ('dbSql', 'objectStorage', 'queue'). This alias table bridges
// the two so managed-service pricing actually resolves instead of silently pricing at $0. If
// PlacementPanel's MANAGED_TYPES ever changes to use canonical NodeTypes directly, every entry
// below becomes an identity no-op.
const MANAGED_TYPE_ALIASES: Record<string, string> = {
  rds: 'dbSql', s3: 'objectStorage', sqs: 'queue',
  redis: 'redis', cdn: 'cdn', apiGateway: 'apiGateway', lambda: 'lambda',
}

export interface WorldCostResult {
  monthlyUsd: number
  byRegion: { regionId: RegionId; monthlyUsd: number }[]
  byAz: { azId: AzId; monthlyUsd: number }[]
  egress: { crossAzUsd: number; crossRegionUsd: number; internetUsd: number }
}

function managedServiceMonthlyUsd(nodeType: string, provider: CloudProvider): number {
  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[nodeType] ?? nodeType, provider)
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
    const usd = managedServiceMonthlyUsd(ms.nodeType, ms.provider)
    if (usd === 0) continue
    if (ms.scope.kind === 'az') {
      bump(byAzMap, ms.scope.azId, usd)
      const az = doc.azs[ms.scope.azId]
      if (az) bump(byRegionMap, az.regionId, usd)
    } else {
      bump(byRegionMap, ms.scope.regionId, usd)
    }
  }

  const crossAzUsd = world ? (world.crossAzBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_AZ_USD_PER_GB : 0
  const crossRegionUsd = world ? (world.crossRegionBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * CROSS_REGION_USD_PER_GB : 0
  // Internet egress bills at PROVIDER_EGRESS.aws's tiered schedule regardless of the world's
  // actual provider mix — Phase 2 doesn't yet attribute egress cost per-provider (that requires
  // tracking which provider's traffic produced which bytes, not modeled yet). Documented
  // simplification; a future phase can split this once egress is attributed per-provider.
  const internetGbMonth = world ? (world.internetEgressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB : 0
  const internetUsd = world ? egressMonthlyCost('aws', internetGbMonth) : 0

  // byRegionMap already sums every server + every managed service exactly once (each managed
  // service contributes to exactly one region, directly or via its AZ's region) — safe to use
  // directly as the compute total, no need to re-walk doc.servers/managedServices again.
  const computeTotal = [...byRegionMap.values()].reduce((a, b) => a + b, 0)
  const monthlyUsd = computeTotal + crossAzUsd + crossRegionUsd + internetUsd

  return {
    monthlyUsd,
    byRegion: [...byRegionMap.entries()].map(([regionId, monthlyUsd]) => ({ regionId, monthlyUsd })),
    byAz: [...byAzMap.entries()].map(([azId, monthlyUsd]) => ({ azId, monthlyUsd })),
    egress: { crossAzUsd, crossRegionUsd, internetUsd },
  }
}
