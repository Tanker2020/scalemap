// World-level monthly cost projection (spec decision 8): Σ server hourlyUsd×730 + managed
// service pricing (reused from cloudRegistry) + egress from live WorldMetrics byte rates.
import type { WorldDoc, RegionId, AzId, ServerId, Placement, PlacementId, ManagedServiceId, ManagedService } from './world/types'
import type { WorldMetrics, ManagedServiceMetrics } from './worldEngine/types'
import { getServiceSpec, egressMonthlyCost, PROVIDER_EGRESS, PROVIDER_INTERZONE, type CloudProvider, type RealProvider } from './cloudRegistry'
import { getDbInstanceClass } from './dbInstanceClasses'
import { managedDbEngine } from './world/types'

// Fallback provisioned-storage rate for a cloud-managed DB ($/GB-month) — the AWS gp3-class rate,
// used only when the provider's registry entry can't be resolved (e.g. 'generic'). Audit
// ISSUE-022: real pricing reads the provider's own storageGbMonth tier from cloudRegistry (GCP
// Cloud SQL storage is 0.17, ~48% above this), so this constant is no longer applied to every
// provider.
const DB_STORAGE_FALLBACK_USD_PER_GB_MONTH = 0.115

// Task 12 (wave 5, "price this world as…"): the ONE resolution point for "which provider prices
// this entity" — every call site below that used to read `ms.provider` directly now goes through
// this instead. A service's own explicit, non-generic provider pin ALWAYS wins; `providerOverride`
// only fills in when the service has no pin of its own (provider === 'generic'). Called with
// `providerOverride` undefined (every pre-existing call site), this is the exact identity
// `ms.provider` always was — byte-identical default behavior.
// I3 fix (final wave-5 review): `doc.cloudProfile` was authored, persisted, and read back by
// TopologyPanel.tsx's own dropdown — but nothing downstream ever CONSUMED it, so setting a
// world's cloud profile to 'aws' produced zero visible change anywhere. This is the ONE place a
// caller turns `doc.cloudProfile` into the `providerOverride` argument above: 'generic' (or
// absent) means "no default", matching `computeWorldCost`'s existing undefined-means-no-op
// contract exactly. Used by every call site computing the world's OWN current cost (CostTab's
// headline, scopeData's region/AZ/server rollups, TopologyPanel's per-region meta line,
// RegionView's headline, runSummary's captured cost) — deliberately NOT by CostTab's three-way
// "price this world as…" comparison row, which explicitly overrides per-provider on purpose and
// must keep showing all three regardless of what the world's own profile is set to.
export function defaultProviderFromDoc(doc: WorldDoc): RealProvider | undefined {
  return doc.cloudProfile && doc.cloudProfile !== 'generic' ? doc.cloudProfile : undefined
}

function resolveProvider(explicit: CloudProvider, override: RealProvider | undefined): CloudProvider {
  // Widened from `explicit !== 'generic'` (fix round 1): a hand-authored/malformed .scalemap
  // could carry `provider: undefined` even though ManagedService['provider'] is a required
  // CloudProvider field at the type level — without the `explicit &&` guard that value would
  // fall through to `return explicit` (undefined) and reach an unguarded
  // `PROVIDER_EGRESS[undefined]`/`getServiceSpec(..., undefined)` lookup downstream. Every
  // currently-valid CloudProvider value ('generic'/'aws'/'gcp'/'azure') is truthy, so this is a
  // no-op for any well-formed document.
  if (explicit && explicit !== 'generic') return explicit
  return override ?? explicit
}

// Provider-correct $/GB-month for a managed DB's provisioned storage (audit ISSUE-022): the
// registry entry for this nodeType+provider carries the rate (flat single-tier for DBs).
function dbStorageRate(ms: ManagedService, providerOverride?: RealProvider): number {
  const provider = resolveProvider(ms.provider, providerOverride)
  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[ms.nodeType] ?? ms.nodeType, provider)
  const storageComponent = spec?.pricing.find(c => c.kind === 'storageGbMonth')
  if (storageComponent?.kind !== 'storageGbMonth') return DB_STORAGE_FALLBACK_USD_PER_GB_MONTH
  const tier = storageComponent.tiers.find(t => t.id === ms.storageTierId) ?? storageComponent.tiers[0]
  return tier?.storageGbMonth ?? DB_STORAGE_FALLBACK_USD_PER_GB_MONTH
}

export const HOURS_PER_MONTH = 730
// Audit ISSUE-023: cross-AZ/cross-region rates come from cloudRegistry's per-provider
// PROVIDER_INTERZONE table, billed at the same aws default the internet-egress line uses
// (servers carry no provider field — one documented simplification, one seam). The old flat
// CROSS_AZ 0.01 ignored AWS's per-direction billing and priced every provider identically.
const WORLD_TRANSFER_PROVIDER: RealProvider = 'aws'
const BYTES_PER_GB = 1024 ** 3
// Derived from HOURS_PER_MONTH (audit ISSUE-036): the old literal 2_630_000 disagreed with
// 730 h × 3600 s = 2_628_000, so instance-hour and egress/serverless lines were billed on
// slightly different month lengths (0.076% drift). One basis now.
const SECONDS_PER_MONTH = HOURS_PER_MONTH * 3600

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

// Per-mode LB pricing (audit ISSUE-060): an L7 ALB and an L4 NLB no longer bill identically, and
// a traffic-unit (LCU-shaped) term now rides on live throughput — AWS shapes: ALB base + $/LCU-hr,
// NLB base + $/NLCU-hr, 1 unit ≈ 25 new connections/sec. Deliberately coarse (real LCUs take the
// max of four dimensions); egress bytes stay on the cross-AZ/internet lines, never billed here.
const LB_MODE_PRICING: Record<'l4' | 'l7', { capacityUnitUsdHr: number }> = {
  l7: { capacityUnitUsdHr: 0.008 },   // ALB LCU
  l4: { capacityUnitUsdHr: 0.006 },   // NLB NLCU
}
const LB_RPS_PER_CAPACITY_UNIT = 25

function loadBalancerMonthlyUsd(mode: 'l4' | 'l7', servedRps: number): number {
  const spec = getServiceSpec('loadBalancer', LB_PROVIDER)
  if (!spec) return 0
  let usd = 0
  for (const c of spec.pricing) {
    if (c.kind === 'instanceHourly') usd += c.defaultRateUsdHr * c.defaultCount * HOURS_PER_MONTH
    // egress component: intentionally skipped — cross-zone bytes are already in cross-AZ egress.
  }
  // Traffic-unit term (ISSUE-060): zero when idle or with no live metrics — the base-hours line
  // above keeps the pre-traffic behavior for a null-metrics projection.
  const units = Math.max(0, servedRps) / LB_RPS_PER_CAPACITY_UNIT
  usd += units * LB_MODE_PRICING[mode].capacityUnitUsdHr * HOURS_PER_MONTH
  return usd
}

// Commitment discounts on a PROVISIONED managed DB (node-model Phase 5.4). Committing to a term
// buys the same capacity cheaper — the classic reserved-instance trade, and the reason a stable
// workload is priced very differently from a spiky one.
const RESERVED_DISCOUNT: Record<string, number> = { onDemand: 0, reserved1yr: 0.4, reserved3yr: 0.6 }

// Provisioned-IOPS pricing for managed DBs (audit ISSUE-059), gp3-shaped: a baseline allowance
// rides free with the storage; IOPS provisioned above it bill per IOPS-month. Billed once per
// cluster (matching the storage-billed-once simplification above). Aurora-style per-I/O billing
// is not modeled — the engine has no per-request I/O meter for managed DBs.
export const DB_IOPS_FREE = 3000
const DB_IOPS_USD_PER_IOPS_MONTH = 0.005

// Serverless/on-demand request price (node-model Phase 5.4). A serverless DB bills per request
// instead of per instance-hour: idle costs (almost) nothing, saturation costs more than the box
// would have. Indicative-realistic, like the rest of this model.
const SERVERLESS_USD_PER_MILLION_REQUESTS = 0.25

// Default provisioned sizing for a computeResource-priced managed service (audit ISSUE-003):
// ManagedService has no vCPU/RAM config fields, so a managed ec2 bills this documented default
// until a sizing knob exists in the doc model.
const MANAGED_COMPUTE_DEFAULT_VCPU = 2
const MANAGED_COMPUTE_DEFAULT_RAM_GIB = 4

function managedServiceMonthlyUsd(ms: ManagedService, rps = 0, providerOverride?: RealProvider): number {
  // Cloud-managed DB with a chosen instance class (node-model Phase 3): the class fixes the base
  // hourly, replicas add proportional cost, and provisioned storage is billed per GB. This wins
  // over the registry's flat rate because the class IS the sizing decision.
  // Also require managedDbEngine(ms.nodeType) to be non-null (mirrors managedDbRuntimeFor /
  // managedCapacityRps's existing pattern) — a stale instanceClassId left over from a nodeType
  // switch away from a DB type must not be trusted just because it happens to resolve to a real
  // class; nodeType is the source of truth for whether this service IS a DB.
  const dbClass = managedDbEngine(ms.nodeType) ? getDbInstanceClass(ms.instanceClassId) : undefined
  if (dbClass) {
    const instances = 1 + (ms.replicaCount ?? 0) + (ms.multiAz ? 1 : 0)   // primary + replicas + standby
    const storage = (ms.storageGb ?? 0) * dbStorageRate(ms, providerOverride)   // provider-correct rate (ISSUE-022)
      // Provisioned IOPS above the free baseline (audit ISSUE-059) — 0 when the knob is unset.
      + Math.max(0, (ms.provisionedIops ?? 0) - DB_IOPS_FREE) * DB_IOPS_USD_PER_IOPS_MONTH
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

  const spec = getServiceSpec(MANAGED_TYPE_ALIASES[ms.nodeType] ?? ms.nodeType, resolveProvider(ms.provider, providerOverride))
  if (!spec) return 0   // 'generic' provider (no override) or unmapped nodeType — documented Phase-2 $0
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
    // Audit ISSUE-003: request-volume pricing was skipped here, so every service whose cost
    // model IS request volume (Lambda, SQS, EventBridge, SNS, API Gateway, CDN requests) billed
    // $0/month regardless of traffic. Billed from live rps, same projection the serverless-DB
    // path already uses.
    else if (c.kind === 'requestsPerMillion') {
      usd += (Math.max(0, rps) * SECONDS_PER_MONTH / 1_000_000) * c.usdPerMillion
    }
    // ManagedService carries no provisioned-size fields (there is no vCPU/RAM knob in the doc
    // model), so computeResource bills a documented default sizing at the x86 rates — the seam
    // a future sizing knob would replace. Without this, a managed ec2 billed $0 (ISSUE-003).
    else if (c.kind === 'computeResource') {
      usd += (MANAGED_COMPUTE_DEFAULT_VCPU * c.vCpuUsdHr + MANAGED_COMPUTE_DEFAULT_RAM_GIB * c.ramGiBUsdHr) * HOURS_PER_MONTH
    }
    // egress: priced per-service from live metrics (managedEgressUsd, below), not here.
  }
  return usd
}

// Per-service internet egress for a storage/CDN managed service (node-model Phase 5.2). Served
// bytes come from live metrics; the free allowance is the provider's base free tier PLUS its
// free-egress-per-stored-GB grant (the Backblaze model — 0 for aws/gcp/azure today) × provisioned
// storage. Priced at the service's OWN provider schedule (fixing the world line's aws-for-all
// simplification for these services). 0 for a generic-provider or zero-traffic service.
function managedEgressUsd(ms: ManagedService, egressBytesPerSec: number, providerOverride?: RealProvider): number {
  const resolved = resolveProvider(ms.provider, providerOverride)
  if (resolved === 'generic' || egressBytesPerSec <= 0) return 0
  const provider = resolved
  const gbMonth = (egressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB
  const storageFreeGb = PROVIDER_EGRESS[provider].freeEgressPerStoredGb * (ms.storageGb ?? 0)
  // egressMonthlyCost subtracts the provider's base freeGbMonth itself; pre-subtract the
  // storage-based allowance so the total free egress = base + storage grant.
  return egressMonthlyCost(provider, Math.max(0, gbMonth - storageFreeGb))
}

export function computeWorldCost(
  doc: WorldDoc,
  // Task 18 (FEAT-008): `runningByPlacement` actually lives on `MetricsBatch` (Task 16), one
  // level up from the `WorldMetrics` slice every existing caller passes here — widened via
  // intersection rather than moved onto `WorldMetrics` itself (a frozen, additive-only contract;
  // see contract-drift.md §FEAT-008) or onto this parameter's base type. Optional field, so every
  // existing `WorldMetrics`-shaped caller remains structurally assignable unchanged.
  world: (WorldMetrics & { runningByPlacement?: Record<PlacementId, number> }) | null,
  managed: Record<ManagedServiceId, ManagedServiceMetrics> | null = null,
  // Task 12 (wave 5): the "price this world as…" comparison row's fallback default provider —
  // fills in for any managed service that has NOT pinned its own provider (provider === 'generic').
  // A service with an explicit pin is unaffected; see `resolveProvider` above. Optional, defaults
  // to undefined, which resolveProvider treats as a no-op — every existing call site (CostTab,
  // scopeData, TopologyPanel, RegionView, runSummary) is byte-identical when omitted.
  providerOverride?: RealProvider,
): WorldCostResult {
  const byRegionMap = new Map<RegionId, number>()
  const byAzMap = new Map<AzId, number>()
  const bump = (map: Map<string, number>, key: string, usd: number) => map.set(key, (map.get(key) ?? 0) + usd)
  let managedEgressTotal = 0
  // Audit ISSUE-024: the compute total accumulates alongside EVERY bump, independent of whether
  // the entity's AZ→region reference still resolves. Deriving the total from byRegionMap silently
  // dropped any server/service pointing at a deleted AZ (a common transient while editing): it
  // appeared in byAz but not in monthlyUsd, so sum(byAz) ≠ monthlyUsd.
  let computeTotal = 0

  // Task 18 (FEAT-008): a server's hourly cost is a flat, per-box charge in this model — there is
  // no per-instance billing. Autoscaling only becomes a FinOps signal if a scaled-down placement's
  // presence on a server apportions that fixed charge by running-instance share. Bill in full
  // (today's behavior, unchanged) unless at least one resident placement authors `autoscale`.
  const placementsByServer = new Map<ServerId, Placement[]>()
  for (const pl of Object.values(doc.placements)) {
    const list = placementsByServer.get(pl.serverId) ?? []
    list.push(pl)
    placementsByServer.set(pl.serverId, list)
  }

  for (const server of Object.values(doc.servers)) {
    const residents = placementsByServer.get(server.id) ?? []
    const anyAutoscaled = residents.some(pl => pl.autoscale)
    let billedFraction = 1
    if (anyAutoscaled) {
      let runningWeight = 0
      let maxWeight = 0
      for (const pl of residents) {
        const maxW = pl.autoscale ? pl.autoscale.maxCount : pl.count
        // world?.runningByPlacement is only present once a run has started; pl.count is the
        // authored fallback both pre-run (world === null) and for a static resident placement.
        const runningW = pl.autoscale ? (world?.runningByPlacement?.[pl.id] ?? pl.count) : pl.count
        maxWeight += maxW
        runningWeight += runningW
      }
      billedFraction = maxWeight > 0 ? runningWeight / maxWeight : 1
    }
    const usd = server.hourlyUsd * HOURS_PER_MONTH * billedFraction
    computeTotal += usd
    bump(byAzMap, server.azId, usd)
    const az = doc.azs[server.azId]
    if (az) bump(byRegionMap, az.regionId, usd)
  }

  for (const ms of Object.values(doc.managedServices)) {
    const egr = managed ? managedEgressUsd(ms, managed[ms.id]?.egressBytesPerSec ?? 0, providerOverride) : 0
    managedEgressTotal += egr
    // Live rps feeds serverless per-request pricing (Phase 5.4); ignored for provisioned classes.
    const usd = managedServiceMonthlyUsd(ms, managed?.[ms.id]?.rps ?? 0, providerOverride) + egr
    // Now that request-volume pricing is billed (ISSUE-003), this skip only drops services that
    // genuinely cost $0 this month (generic provider, or zero-traffic pure-request services) —
    // bumping 0 into the maps would be a no-op anyway.
    if (usd === 0) continue
    computeTotal += usd
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
  // The LCU-shaped traffic term (ISSUE-060) bills the region's live inbound rps; several LBs in
  // one region split it evenly (which LB serves which share isn't modeled).
  let loadBalancerUsd = 0
  let loadBalancerCount = 0
  const lbsPerRegion = new Map<RegionId, number>()
  for (const lb of Object.values(doc.loadBalancers)) {
    if (!doc.regions[lb.regionId]) continue
    lbsPerRegion.set(lb.regionId, (lbsPerRegion.get(lb.regionId) ?? 0) + 1)
  }
  const regionInboundRps = (regionId: RegionId): number =>
    world?.populationRoutes.filter(r => r.regionId === regionId).reduce((s, r) => s + r.rps, 0) ?? 0
  for (const lb of Object.values(doc.loadBalancers)) {
    if (!doc.regions[lb.regionId]) continue
    const share = regionInboundRps(lb.regionId) / (lbsPerRegion.get(lb.regionId) ?? 1)
    const usd = loadBalancerMonthlyUsd(lb.mode, share)
    computeTotal += usd
    bump(byRegionMap, lb.regionId, usd)
    loadBalancerUsd += usd
    loadBalancerCount += 1
  }

  const interzone = PROVIDER_INTERZONE[WORLD_TRANSFER_PROVIDER]
  const crossAzUsd = world ? (world.crossAzBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * interzone.crossAzUsdPerGb : 0
  const crossRegionUsd = world ? (world.crossRegionBytesPerSec * SECONDS_PER_MONTH / BYTES_PER_GB) * interzone.crossRegionUsdPerGb : 0
  // Internet egress bills at PROVIDER_EGRESS.aws's tiered schedule regardless of the world's
  // actual provider mix — Phase 2 doesn't yet attribute egress cost per-provider (that requires
  // tracking which provider's traffic produced which bytes, not modeled yet). Documented
  // simplification; a future phase can split this once egress is attributed per-provider.
  const internetGbMonth = world ? (world.internetEgressBytesPerSec * SECONDS_PER_MONTH) / BYTES_PER_GB : 0
  const internetUsd = world ? egressMonthlyCost('aws', internetGbMonth) : 0

  // computeTotal accumulated alongside every bump above (ISSUE-024) — provably complete even
  // when an AZ→region reference dangles mid-edit. loadBalancerUsd is a SUBSET of it (already
  // accumulated in the loop), so it is NOT added to monthlyUsd a second time.
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
