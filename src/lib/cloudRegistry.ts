// Cloud-provider service registry — maps managed-service node types to concrete AWS / GCP /
// Azure services and a typed pricing model.
//
// Two things live here and nowhere else:
//   1. CLOUD_REGISTRY      — per nodeType × provider: serviceName, pricing[]
//   2. PROVIDER_EGRESS     — tiered internet-egress $/GB + free allowances per provider
//
// Consumed by costModelV2.ts (managed-service pricing + egress) and PlacementPanel.tsx.
// Rates below are representative public list prices (us-east-1 / East US / us-central1,
// 2026) and are meant to be user-overridable.

export type CloudProvider = 'generic' | 'aws' | 'gcp' | 'azure'
export type RealProvider = Exclude<CloudProvider, 'generic'>

export interface StorageTier {
  id: string
  label: string
  storageGbMonth: number   // $/GB-month
  retrievalFeeGb: number   // $/GB retrieved (informational; not yet billed in v1)
  minDurationDays: number  // informational
}

// How each cost kind behaves when projecting a (short) sim run to a monthly bill:
//   instanceHourly     — user count × $/hr      → scales by TIME      (× 730 hr/mo)
//   requestsPerMillion — $/million requests     → scales by request VOLUME
//   egress             — provider tiered $/GB    → scales by egress VOLUME
//   storageGbMonth     — tiered $/GB-month       → FLAT from configured GB (not run-scaled)
//   fixedMonthly       — hosted-zone / policy base → FLAT, never multiplied
export type CostComponentSpec =
  | { kind: 'instanceHourly'; label: string; defaultRateUsdHr: number; defaultCount: number }
  | { kind: 'requestsPerMillion'; label: string; usdPerMillion: number }
  | { kind: 'egress'; label: string }                                  // uses PROVIDER_EGRESS + node avgResponseKb
  | { kind: 'storageGbMonth'; label: string; tiers: StorageTier[] }    // user picks tier + capacity GB
  | { kind: 'fixedMonthly'; label: string; usd: number }
  | { kind: 'computeResource'; label: string; vCpuUsdHr: number; ramGiBUsdHr: number; vCpuUsdHrArm: number; ramGiBUsdHrArm: number }

export interface CloudServiceSpec {
  serviceName: string
  pricing: CostComponentSpec[]
}

// ─── Provider-level internet egress (tiered + free allowance) ────────────────────
// Tiers are cumulative ceilings; the last tier's rate applies to anything beyond it.
export const PROVIDER_EGRESS: Record<RealProvider, {
  freeGbMonth: number
  tiers: { uptoGb: number; usdPerGb: number }[]
}> = {
  aws:   { freeGbMonth: 100, tiers: [{ uptoGb: 10_240, usdPerGb: 0.09 }] },
  azure: { freeGbMonth: 5,   tiers: [{ uptoGb: 5_120,  usdPerGb: 0.087 }] },
  gcp:   { freeGbMonth: 0,   tiers: [
    { uptoGb: 1_024,           usdPerGb: 0.12 },
    { uptoGb: 10_240,          usdPerGb: 0.11 },
    { uptoGb: Number.POSITIVE_INFINITY, usdPerGb: 0.08 },
  ] },
}

// Cost of egressing `gbMonth` GB through a provider's tiered schedule, after the free tier.
export function egressMonthlyCost(provider: RealProvider, gbMonth: number): number {
  const schedule = PROVIDER_EGRESS[provider]
  let remaining = Math.max(0, gbMonth - schedule.freeGbMonth)
  if (remaining <= 0) return 0
  let cost = 0
  let lowerBound = schedule.freeGbMonth
  for (const tier of schedule.tiers) {
    const tierCapacity = tier.uptoGb - lowerBound
    const take = Math.min(remaining, Math.max(0, tierCapacity))
    cost += take * tier.usdPerGb
    remaining -= take
    lowerBound = tier.uptoGb
    if (remaining <= 0) break
  }
  // Anything left over (shouldn't happen given Infinity ceiling) bills at last tier rate.
  if (remaining > 0) cost += remaining * schedule.tiers[schedule.tiers.length - 1].usdPerGb
  return cost
}

// ─── Storage tier tables (objectStorage) ────────────────────────────────────────
const S3_TIERS: StorageTier[] = [
  { id: 'standard',       label: 'Standard',            storageGbMonth: 0.023,  retrievalFeeGb: 0,    minDurationDays: 0  },
  { id: 'intelligent',    label: 'Intelligent-Tiering', storageGbMonth: 0.023,  retrievalFeeGb: 0,    minDurationDays: 0  },
  { id: 'standardIa',     label: 'Standard-IA',         storageGbMonth: 0.0125, retrievalFeeGb: 0.01, minDurationDays: 30 },
  { id: 'oneZoneIa',      label: 'One Zone-IA',         storageGbMonth: 0.010,  retrievalFeeGb: 0.01, minDurationDays: 30 },
  { id: 'glacierInstant', label: 'Glacier Instant',     storageGbMonth: 0.004,  retrievalFeeGb: 0.03, minDurationDays: 90 },
  { id: 'expressOneZone', label: 'Express One Zone',    storageGbMonth: 0.11,   retrievalFeeGb: 0,    minDurationDays: 0  },
]
const BLOB_TIERS: StorageTier[] = [
  { id: 'hot',  label: 'Hot',  storageGbMonth: 0.018,  retrievalFeeGb: 0,     minDurationDays: 0  },
  { id: 'cool', label: 'Cool', storageGbMonth: 0.010,  retrievalFeeGb: 0.01,  minDurationDays: 30 },
  { id: 'cold', label: 'Cold', storageGbMonth: 0.0045, retrievalFeeGb: 0.037, minDurationDays: 90 },
]
const GCS_TIERS: StorageTier[] = [
  { id: 'standard', label: 'Standard', storageGbMonth: 0.020,  retrievalFeeGb: 0,    minDurationDays: 0   },
  { id: 'nearline', label: 'Nearline', storageGbMonth: 0.010,  retrievalFeeGb: 0.01, minDurationDays: 30  },
  { id: 'coldline', label: 'Coldline', storageGbMonth: 0.004,  retrievalFeeGb: 0.02, minDurationDays: 90  },
  { id: 'archive',  label: 'Archive',  storageGbMonth: 0.0012, retrievalFeeGb: 0.05, minDurationDays: 365 },
]

// Single-tier helper for capacity-priced services (file storage, DB volumes).
const flatTier = (gbMonth: number, label = 'Provisioned'): StorageTier[] =>
  [{ id: 'standard', label, storageGbMonth: gbMonth, retrievalFeeGb: 0, minDurationDays: 0 }]

// ─── The registry ───────────────────────────────────────────────────────────────
// Mapping: nodeType → provider → service spec. Only types with a meaningful cloud
// mapping are listed; grouping/orchestration containers are intentionally omitted.
export const CLOUD_REGISTRY: Record<string, Record<RealProvider, CloudServiceSpec>> = {
  // ─── Compute ───────────────────────────────────────────────────────────────
  ec2: {
    aws:   { serviceName: 'Amazon EC2',        pricing: [{ kind: 'computeResource', label: 'Compute (vCPU+RAM)', vCpuUsdHr: 0.010, ramGiBUsdHr: 0.0012, vCpuUsdHrArm: 0.008, ramGiBUsdHrArm: 0.0010 }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Compute Engine',     pricing: [{ kind: 'computeResource', label: 'Compute (vCPU+RAM)', vCpuUsdHr: 0.0095, ramGiBUsdHr: 0.0013, vCpuUsdHrArm: 0.0076, ramGiBUsdHrArm: 0.0010 }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Virtual Machines',   pricing: [{ kind: 'computeResource', label: 'Compute (vCPU+RAM)', vCpuUsdHr: 0.010, ramGiBUsdHr: 0.0012, vCpuUsdHrArm: 0.008, ramGiBUsdHrArm: 0.0010 }, { kind: 'egress', label: 'Egress' }] },
  },
  lambda: {
    aws:   { serviceName: 'AWS Lambda',         pricing: [{ kind: 'requestsPerMillion', label: 'Invocations', usdPerMillion: 0.20 }] },
    gcp:   { serviceName: 'Cloud Functions',    pricing: [{ kind: 'requestsPerMillion', label: 'Invocations', usdPerMillion: 0.40 }] },
    azure: { serviceName: 'Azure Functions',    pricing: [{ kind: 'requestsPerMillion', label: 'Invocations', usdPerMillion: 0.20 }] },
  },
  container: {
    aws:   { serviceName: 'App Runner / ECS',   pricing: [{ kind: 'instanceHourly', label: 'Instance', defaultRateUsdHr: 0.040, defaultCount: 1 }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Cloud Run',          pricing: [{ kind: 'instanceHourly', label: 'Instance', defaultRateUsdHr: 0.038, defaultCount: 1 }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Container Apps',     pricing: [{ kind: 'instanceHourly', label: 'Instance', defaultRateUsdHr: 0.040, defaultCount: 1 }, { kind: 'egress', label: 'Egress' }] },
  },
  pod: {
    aws:   { serviceName: 'EKS Pod',            pricing: [{ kind: 'instanceHourly', label: 'Pod (node share)', defaultRateUsdHr: 0.020, defaultCount: 1 }] },
    gcp:   { serviceName: 'GKE Pod',            pricing: [{ kind: 'instanceHourly', label: 'Pod (node share)', defaultRateUsdHr: 0.018, defaultCount: 1 }] },
    azure: { serviceName: 'AKS Pod',            pricing: [{ kind: 'instanceHourly', label: 'Pod (node share)', defaultRateUsdHr: 0.020, defaultCount: 1 }] },
  },

  // ─── Network ───────────────────────────────────────────────────────────────
  loadBalancer: {
    aws:   { serviceName: 'ALB / NLB',          pricing: [{ kind: 'instanceHourly', label: 'LB hours', defaultRateUsdHr: 0.0225, defaultCount: 1 }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Cloud Load Balancing', pricing: [{ kind: 'instanceHourly', label: 'LB hours', defaultRateUsdHr: 0.025, defaultCount: 1 }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Azure Load Balancer', pricing: [{ kind: 'instanceHourly', label: 'LB hours', defaultRateUsdHr: 0.025, defaultCount: 1 }, { kind: 'egress', label: 'Egress' }] },
  },
  apiGateway: {
    aws:   { serviceName: 'API Gateway',        pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 3.50 }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'API Gateway',        pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 3.00 }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'API Management',     pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 3.50 }, { kind: 'egress', label: 'Egress' }] },
  },
  cdn: {
    aws:   { serviceName: 'CloudFront',         pricing: [{ kind: 'egress', label: 'Egress' }, { kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 1.00 }] },
    gcp:   { serviceName: 'Cloud CDN',          pricing: [{ kind: 'egress', label: 'Egress' }, { kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 0.75 }] },
    azure: { serviceName: 'Front Door',         pricing: [{ kind: 'egress', label: 'Egress' }, { kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 1.00 }] },
  },
  dns: {
    aws:   { serviceName: 'Route 53',           pricing: [{ kind: 'fixedMonthly', label: 'Hosted zone', usd: 0.50 }, { kind: 'requestsPerMillion', label: 'Queries', usdPerMillion: 0.40 }] },
    gcp:   { serviceName: 'Cloud DNS',          pricing: [{ kind: 'fixedMonthly', label: 'Managed zone', usd: 0.20 }, { kind: 'requestsPerMillion', label: 'Queries', usdPerMillion: 0.40 }] },
    azure: { serviceName: 'Azure DNS',          pricing: [{ kind: 'fixedMonthly', label: 'Hosted zone', usd: 0.50 }, { kind: 'requestsPerMillion', label: 'Queries', usdPerMillion: 0.40 }] },
  },
  firewall: {
    aws:   { serviceName: 'AWS WAF',            pricing: [{ kind: 'fixedMonthly', label: 'Web ACL', usd: 5.00 }, { kind: 'requestsPerMillion', label: 'Inspected requests', usdPerMillion: 0.60 }] },
    gcp:   { serviceName: 'Cloud Armor',        pricing: [{ kind: 'fixedMonthly', label: 'Policy', usd: 5.00 }, { kind: 'requestsPerMillion', label: 'Inspected requests', usdPerMillion: 0.75 }] },
    azure: { serviceName: 'Azure WAF',          pricing: [{ kind: 'fixedMonthly', label: 'Policy', usd: 5.00 }, { kind: 'requestsPerMillion', label: 'Inspected requests', usdPerMillion: 0.60 }] },
  },
  vpn: {
    aws:   { serviceName: 'Site-to-Site VPN',   pricing: [{ kind: 'instanceHourly', label: 'Tunnel', defaultRateUsdHr: 0.05, defaultCount: 1 }] },
    gcp:   { serviceName: 'Cloud VPN',          pricing: [{ kind: 'instanceHourly', label: 'Tunnel', defaultRateUsdHr: 0.05, defaultCount: 1 }] },
    azure: { serviceName: 'VPN Gateway',        pricing: [{ kind: 'instanceHourly', label: 'Gateway', defaultRateUsdHr: 0.04, defaultCount: 1 }] },
  },

  // ─── Storage ───────────────────────────────────────────────────────────────
  dbSql: {
    aws:   { serviceName: 'RDS / Aurora',       pricing: [{ kind: 'instanceHourly', label: 'DB instance', defaultRateUsdHr: 0.068, defaultCount: 1 }, { kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.115, 'gp3') }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Cloud SQL / Spanner', pricing: [{ kind: 'instanceHourly', label: 'DB instance', defaultRateUsdHr: 0.070, defaultCount: 1 }, { kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.17, 'SSD') }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Azure SQL Database',  pricing: [{ kind: 'instanceHourly', label: 'DB instance', defaultRateUsdHr: 0.072, defaultCount: 1 }, { kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.115, 'Standard') }, { kind: 'egress', label: 'Egress' }] },
  },
  dbNoSql: {
    aws:   { serviceName: 'DynamoDB',           pricing: [{ kind: 'requestsPerMillion', label: 'Read requests', usdPerMillion: 0.25 }, { kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.25) }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Bigtable / Firestore', pricing: [{ kind: 'requestsPerMillion', label: 'Read requests', usdPerMillion: 0.30 }, { kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.18) }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Cosmos DB',          pricing: [{ kind: 'requestsPerMillion', label: 'Read requests', usdPerMillion: 0.28 }, { kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.25) }, { kind: 'egress', label: 'Egress' }] },
  },
  objectStorage: {
    aws:   { serviceName: 'Amazon S3',          pricing: [{ kind: 'storageGbMonth', label: 'Storage', tiers: S3_TIERS },  { kind: 'requestsPerMillion', label: 'GET requests', usdPerMillion: 0.40 }, { kind: 'egress', label: 'Egress' }] },
    gcp:   { serviceName: 'Cloud Storage',      pricing: [{ kind: 'storageGbMonth', label: 'Storage', tiers: GCS_TIERS }, { kind: 'requestsPerMillion', label: 'GET requests', usdPerMillion: 0.40 }, { kind: 'egress', label: 'Egress' }] },
    azure: { serviceName: 'Blob Storage',       pricing: [{ kind: 'storageGbMonth', label: 'Storage', tiers: BLOB_TIERS }, { kind: 'requestsPerMillion', label: 'GET requests', usdPerMillion: 0.55 }, { kind: 'egress', label: 'Egress' }] },
  },
  fileStorage: {
    aws:   { serviceName: 'Amazon EFS',         pricing: [{ kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.30) }] },
    gcp:   { serviceName: 'Filestore',          pricing: [{ kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.20) }] },
    azure: { serviceName: 'Azure Files',        pricing: [{ kind: 'storageGbMonth', label: 'Storage', tiers: flatTier(0.058) }] },
  },

  // ─── Messaging ─────────────────────────────────────────────────────────────
  queue: {
    aws:   { serviceName: 'Amazon SQS',         pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 0.40 }] },
    gcp:   { serviceName: 'Cloud Tasks',        pricing: [{ kind: 'requestsPerMillion', label: 'Operations', usdPerMillion: 0.40 }] },
    azure: { serviceName: 'Queue Storage',      pricing: [{ kind: 'requestsPerMillion', label: 'Operations', usdPerMillion: 0.40 }] },
  },
  eventBus: {
    aws:   { serviceName: 'EventBridge',        pricing: [{ kind: 'requestsPerMillion', label: 'Events', usdPerMillion: 1.00 }] },
    gcp:   { serviceName: 'Eventarc',           pricing: [{ kind: 'requestsPerMillion', label: 'Events', usdPerMillion: 0.90 }] },
    azure: { serviceName: 'Event Grid',         pricing: [{ kind: 'requestsPerMillion', label: 'Operations', usdPerMillion: 0.60 }] },
  },
  pubsub: {
    aws:   { serviceName: 'Amazon SNS',         pricing: [{ kind: 'requestsPerMillion', label: 'Publishes', usdPerMillion: 0.50 }] },
    gcp:   { serviceName: 'Pub/Sub',            pricing: [{ kind: 'requestsPerMillion', label: 'Messages', usdPerMillion: 0.40 }] },
    azure: { serviceName: 'Service Bus Topic',  pricing: [{ kind: 'requestsPerMillion', label: 'Operations', usdPerMillion: 0.80 }] },
  },
  stream: {
    aws:   { serviceName: 'Kinesis / MSK',      pricing: [{ kind: 'instanceHourly', label: 'Shard', defaultRateUsdHr: 0.015, defaultCount: 1 }] },
    gcp:   { serviceName: 'Pub/Sub Lite',       pricing: [{ kind: 'instanceHourly', label: 'Partition', defaultRateUsdHr: 0.013, defaultCount: 1 }] },
    azure: { serviceName: 'Event Hubs',         pricing: [{ kind: 'instanceHourly', label: 'Throughput unit', defaultRateUsdHr: 0.030, defaultCount: 1 }] },
  },

  // ─── Caching ───────────────────────────────────────────────────────────────
  redis: {
    aws:   { serviceName: 'ElastiCache (Redis)',  pricing: [{ kind: 'instanceHourly', label: 'Cache node', defaultRateUsdHr: 0.068, defaultCount: 1 }] },
    gcp:   { serviceName: 'Memorystore (Redis)',  pricing: [{ kind: 'instanceHourly', label: 'Cache node', defaultRateUsdHr: 0.070, defaultCount: 1 }] },
    azure: { serviceName: 'Cache for Redis',      pricing: [{ kind: 'instanceHourly', label: 'Cache node', defaultRateUsdHr: 0.072, defaultCount: 1 }] },
  },
  memcached: {
    aws:   { serviceName: 'ElastiCache (Memcached)', pricing: [{ kind: 'instanceHourly', label: 'Cache node', defaultRateUsdHr: 0.068, defaultCount: 1 }] },
    gcp:   { serviceName: 'Memorystore (Memcached)', pricing: [{ kind: 'instanceHourly', label: 'Cache node', defaultRateUsdHr: 0.070, defaultCount: 1 }] },
    azure: { serviceName: 'Cache for Redis',         pricing: [{ kind: 'instanceHourly', label: 'Cache node', defaultRateUsdHr: 0.072, defaultCount: 1 }] },
  },
  cdnCache: {
    aws:   { serviceName: 'CloudFront Cache',   pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 1.00 }] },
    gcp:   { serviceName: 'Cloud CDN Edge',     pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 0.75 }] },
    azure: { serviceName: 'Front Door Cache',   pricing: [{ kind: 'requestsPerMillion', label: 'Requests', usdPerMillion: 1.00 }] },
  },
}

// Convenience accessor — returns undefined for 'generic' or unmapped types.
export function getServiceSpec(nodeType: string, provider: CloudProvider): CloudServiceSpec | undefined {
  if (provider === 'generic') return undefined
  return CLOUD_REGISTRY[nodeType]?.[provider]
}
