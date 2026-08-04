// World document entities (normalized, id-keyed) + compiled output types.
// Spec: docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md §3
import type { PacketMixEntry, PacketRegistry } from '../nodeConfig'
import type { FaultScope, FaultSpec, PartitionFault } from '../worldEngine/types'

export type RegionId = string
export type AzId = string
export type ServerId = string
export type RackId = string
export type BlueprintId = string
export type PlacementId = string
export type ManagedServiceId = string
export type PopulationId = string
export type InstanceId = string
export type LbId = string

export type RoutingPolicyKind = 'latency' | 'geo' | 'weighted' | 'priority'

export interface RoutingConfig {
  policy: RoutingPolicyKind
  weights: Record<RegionId, number>   // policy === 'weighted'
  priorityOrder: RegionId[]           // policy === 'priority'
  healthCheckIntervalMs: number
  healthCheckFailureThreshold: number
  // Consecutive healthy probes required before a failed scope passes again (audit ISSUE-020 —
  // ALB/NLB "healthy threshold" semantics). Optional + additive: absent ⇒ engine default 2.
  healthCheckHealthyThreshold?: number
  // Per-probe response timeout (audit ISSUE-061). Optional + additive: absent ⇒ default 5000
  // (DEFAULT_HEALTH_CHECK_TIMEOUT_MS). Consumed by the analysis detection-window estimate —
  // real detection ≈ interval × failure threshold + one probe timeout.
  healthCheckTimeoutMs?: number
  dnsTtlSec: number
}

// Default per-probe timeout (audit ISSUE-061) — ALB-shaped 5 s. Lives here (not the engine) so
// the analysis rules and any future engine consumption share one value.
export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000

export type DiurnalPattern = 'flat' | 'day-night' | 'custom'

// A single entry of a population's request mix (Phase 2 route system): the fraction (relative
// weight) of this population's rps that belongs to a given route. `routeId` is a route's id (an
// HttpTemplate id, stringified) in WorldDoc.packets. Weights are relative — the engine normalizes
// them per population, so [{a:1},{b:3}] means 25%/75%.
export interface RequestMixEntry {
  routeId: string
  weight: number
}

export interface ClientPopulation {
  id: PopulationId
  label: string
  lat: number
  lon: number
  peakRps: number
  diurnal: DiurnalPattern
  // Optional L7 route mix (Phase 2). Absent ⇒ a single implicit "default" route carries 100% of
  // the population's rps — byte-equivalent to the pre-route scalar behavior, so old worlds and the
  // engine's golden tests are unchanged. Entries referencing a deleted route are scrubbed by the
  // store's removeRoute; the engine/analysis treat an unknown routeId as an unmatched route.
  requestMix?: RequestMixEntry[]
  // Burst intensity knob (audit ISSUE-017): scales the engine's flash-crowd burst probability
  // for this population. Optional + additive: absent ⇒ 1 (default bursts); 0 disables bursts.
  burstiness?: number
  // Custom diurnal curve (FEAT-003). Defined only when diurnal === 'custom'. Array of
  // (atFraction, multiplier) pairs linearly interpolated. Optional + additive.
  curve?: { atFraction: number; multiplier: number }[]
}

export type RegionRole = 'active' | 'passive'

export interface Region {
  id: RegionId
  catalogId: string   // WORLD_REGIONS id, e.g. 'us-east-1'
  role: RegionRole
}

export interface AvailabilityZone {
  id: AzId
  label: string       // e.g. 'us-east-1a'
  regionId: RegionId
}

export interface ServerSpecs {
  vcpu: number
  threadsPerCore: number
  ramMb: number
  diskGb: number
  nicMbps: number
}

export type FirewallSource = 'any' | 'internal' | string  // string = CIDR, e.g. '10.0.0.0/8'
export type FirewallProtocol = 'tcp' | 'udp' | 'any'

export interface FirewallRule {
  id: string
  action: 'allow' | 'deny'
  port: number | 'any'
  protocol: FirewallProtocol
  source: FirewallSource
}

export interface ComposeNetwork { name: string; cidr: string }
export interface ComposeVolume { name: string; sizeGb: number }

export interface ComposeStack {
  name: string
  networks: ComposeNetwork[]
  volumes: ComposeVolume[]
}

// Compute kinds host arbitrary placements; appliance kinds ('db-*') are boxes born owning
// exactly one blueprint+placement, which the authoring UI refuses to add other services to.
// NOTE for anyone widening this further: branches on ServerKind must be written as POSITIVE
// tests ('=== vps'), never negative ones ('!== dedicated') — a negative test silently sweeps
// every new kind into the wrong side (see vpsModel.createVpsState / rackModel.serverHeightU).
export type ServerKind = 'dedicated' | 'vps' | 'db-sql' | 'db-nosql'

export const DB_SERVER_KINDS = ['db-sql', 'db-nosql'] as const satisfies readonly ServerKind[]

export function isDbServerKind(kind: ServerKind): boolean {
  return kind === 'db-sql' || kind === 'db-nosql'
}

export interface RackPosition { rackId: string; unit: number; heightU: number }

// Optional authored container (Polish 3 Task 2, spec D4) — purely a doc-model/UI concept;
// racks carry ZERO engine/compile/analysis/cost semantics. A server born via createServer
// starts in the free pool (Server.rack === null) until explicitly assigned or auto-arranged.
export interface Rack { id: RackId; azId: AzId; label: string; capacityU: number }

export interface Server {
  id: ServerId
  label: string
  azId: AzId
  kind: ServerKind
  catalogId: string | null            // instanceCatalog preset id; null = custom specs
  specs: ServerSpecs
  hourlyUsd: number
  oversubscriptionRatio: number | null // vps only
  burstable: boolean                   // vps only
  firewall: FirewallRule[]             // evaluated in array order, first match wins, default deny
  stacks: ComposeStack[]
  rack: RackPosition | null            // null = free pool (unracked)
}

export interface ServicePort {
  port: number
  protocol: 'tcp' | 'udp'
  visibility: 'public' | 'internal'
}

export interface WorkloadProfile {
  cpuMsPerRequest: number
  ramBaseMb: number
  ramPerConnMb: number
  diskIoPerRequest: number
  // CPU weight for the host scheduler's fair-share split (audit ISSUE-018) — cgroup-shares-like:
  // a share-2 instance gets twice a share-1 sibling's capacity on a saturated host. Optional +
  // additive: absent ⇒ 1 (all instances equal, the pre-fix behavior).
  cpuShares?: number
  // Additional CPU ms per KB of request payload (packet-driven CPU, slice 2) — blended into
  // cpuMsPerRequest at the entry tier as cpuMs = cpuMsPerRequest + cpuMsPerKb × sizeKb. Optional +
  // additive: absent ⇒ 0 (flat per-request cost, the pre-slice-2 behavior).
  cpuMsPerKb?: number
  // Self-hosted connection pool (audit ISSUE-005) — a managed DB already gets a connection
  // ceiling + refusal path (managedDbRuntime.ts); a self-hosted DB (or any workload) previously
  // had none, so the ONLY way it could ever fail under connection pressure was host RAM exhaustion
  // and an OOM-kill — a materially later, less common failure than real pool exhaustion. Optional:
  // absent ⇒ unbounded (today's exact behavior, the regression floor). See hostScheduler.ts's
  // `poolCheckoutFor`.
  maxConnections?: number
  // Absent ⇒ no timeout — a saturated pool queues checkouts forever rather than erroring them,
  // mirroring ManagedService.queryTimeoutMs's own "absent ⇒ no timeout" convention.
  checkoutTimeoutMs?: number
}

export type DependencyTarget =
  | { kind: 'blueprint'; blueprintId: BlueprintId }
  | { kind: 'managed'; managedServiceId: ManagedServiceId }

export interface BlueprintDependency {
  id: string
  target: DependencyTarget
  port: number
  protocol: 'http' | 'db' | 'event' | 'stream'
  // DEPRECATED single-template slot (always written null since the node model landed). A non-null
  // value in an older file is migrated to a 1-entry `packetMix` on load; nothing reads it.
  packetTemplateId: number | null
  // What this edge puts on the wire per call (packet library). When present and non-empty the mix
  // supersedes reqKb/respKb below; both are optional, and their absence is what makes an existing
  // world resolve to the historical flat 2 KB each way. See src/lib/packetResolve.ts.
  packetMix?: PacketMixEntry[]
  reqKb?: number      // inline tier-2 request size, ignored while a mix is bound
  respKb?: number     // inline tier-2 response size, ignored while a mix is bound
  // Fraction of this dependency's call volume that MUTATES the target, 0..1 (node-model Phase 3).
  // Only meaningful when the target is a DB blueprint: writes route to the primary (SQL) / all
  // nodes (NoSQL), reads to the replicas. Absent ⇒ 0 (pure reads), which for a non-DB target is
  // the only sensible value and preserves the pre-Phase-3 even fan-out exactly. Optional +
  // normalized-on-load, like the other additive fields, until Phase 5's format cutover.
  writeFraction?: number
  // dependency id of the sibling cache edge on the same blueprint; when set, this edge's share is reduced by that cache's miss fraction
  cacheAsideVia?: string
}

// What a service IS, as opposed to what it costs to run. Drives which authoring form the user
// sees and — for the db-* kinds only — which routing semantics apply downstream.
export type BlueprintKind = 'api' | 'worker' | 'db-sql' | 'db-nosql' | 'cache'

export type DbEngine = 'sql' | 'nosql'

// The one behavioral fork: SQL is single-writer (writes bottleneck on the primary's host, so
// replicas scale reads only), NoSQL is write-scalable (writes fan out across every node). The
// write CEILING itself is not stored here — for a self-hosted DB it is emergent from the host
// CPU model (hostScheduler's admittedScale); only cloud-managed DBs carry an explicit cap,
// which lives on ManagedService instead.
export interface DbConfig {
  engine: DbEngine
  storageGb: number
}

export interface CacheConfig {
  hitRatio: number       // 0..1 steady-state hit ratio
  warmupSec: number      // seconds from cold (0%) to steady-state hitRatio
  ttlSec: number         // entry lifetime; drives the ambient miss floor
}

export interface ServiceBlueprint {
  id: BlueprintId
  name: string
  color: string   // signature color (hex) — binds chip/RAM stratum/core share across views
  kind: BlueprintKind
  workload: WorkloadProfile
  ports: ServicePort[]
  dependencies: BlueprintDependency[]
  stateful: boolean
  volumeName: string | null   // required when stateful
  dbConfig: DbConfig | null   // non-null iff kind is db-*
  cacheConfig?: CacheConfig   // cache configuration for this service
  // Non-null ⇒ this blueprint is OWNED by an appliance box of that kind and was created with it;
  // the authoring UI refuses to place other services on such a box, and refuses to place this
  // blueprint on a general-purpose host. null ⇒ a free-standing service.
  ownerServerKind: ServerKind | null
}

export type PlacementRole = 'primary' | 'replica' | 'canary'

export interface PortMapping { host: number; container: number }

export type PlacementRuntime =
  | { type: 'process' }
  | {
      type: 'container'
      stackName: string
      networkNames: string[]
      // Cross-host virtual networks (audit ISSUE-065): names listed here span SERVERS — Swarm/
      // CNI-overlay semantics — so two containers on different hosts sharing an overlay name get
      // a permitted path WITHOUT publishing host ports. `networkNames` above stays per-host
      // (compose bridge semantics: same server only). Additive/optional: absent ⇒ no overlays,
      // the pre-fix behavior.
      overlayNetworkNames?: string[]
      portMappings: PortMapping[]
      cpuLimit: number | null
      memLimitMb: number | null
    }

export interface Placement {
  id: PlacementId
  blueprintId: BlueprintId
  serverId: ServerId
  count: number
  role: PlacementRole
  runtime: PlacementRuntime
}

export type ManagedScope =
  | { kind: 'region'; regionId: RegionId }
  | { kind: 'az'; azId: AzId }

export interface ManagedService {
  id: ManagedServiceId
  label: string
  nodeType: string   // CLOUD_REGISTRY key from src/lib/cloudRegistry.ts, e.g. 'dbSql', 'objectStorage', 'queue'
  scope: ManagedScope
  provider: 'generic' | 'aws' | 'gcp' | 'azure'
  port: number       // endpoint port, participates in path semantics
  // Cloud-managed DB config (node-model Phase 3), meaningful only when nodeType is a DB. The
  // instance class (dbInstanceClasses.ts) fixes both the write/read ceiling AND the base hourly
  // price; replicas add read capacity + cost; multiAz adds a failover standby (cost, no capacity);
  // storageGb is provisioned storage (cost). All optional + additive — absent ⇒ the pre-Phase-3
  // black-box behavior (always admits, flat priced).
  instanceClassId?: string | null
  replicaCount?: number
  multiAz?: boolean
  storageGb?: number
  // Provisioned-storage tier id (node-model Phase 5.2) — a StorageTier from cloudRegistry.ts
  // (S3_TIERS/GCS_TIERS/BLOB_TIERS), meaningful for objectStorage; absent ⇒ the type's first/default
  // tier. Drives the $/GB-month rate.
  storageTierId?: string | null
  // Throughput ceiling override in rps (node-model Phase 5.2), for NON-DB managed services (a DB's
  // ceiling comes from its instance class). Absent ⇒ the per-type default in managedCapacity.ts.
  capacityRps?: number
  // ── Managed-DB stress-test config (node-model Phase 5.4) ───────────────────
  // All optional + additive: absent ⇒ the class default (maxConnections), "never" (queryTimeoutMs),
  // or the pre-5.4 behavior. Each knob exists only because the sim can SHOW its effect — a second
  // saturation axis, a soft failure below the rps ceiling, a lifted ceiling, or a price change.
  // Interpreted by managedDbRuntime.ts; meaningful only when nodeType is a DB.
  maxConnections?: number          // live-connection cap (Little's law); absent ⇒ the class's default
  queryTimeoutMs?: number          // queries slower than this error out; absent ⇒ no timeout
  // Provisioned storage IOPS (audit ISSUE-059), meaningful for DB nodes. Additive/optional:
  // absent ⇒ the baseline allowance (costModelV2's DB_IOPS_FREE) and no extra charge — gp3-style
  // pricing bills only IOPS provisioned ABOVE the baseline. Cost-model input only (the sim's
  // capacity model stays instance-class-driven).
  provisionedIops?: number
  capacityMode?: ManagedCapacityMode  // provisioned (fixed class ceiling) vs serverless (bursts, per-request price)
  pricing?: ManagedPricingCommitment  // reserved commitments discount the provisioned hourly
  replicaLocality?: ReplicaLocality   // read-replica placement ⇒ read-latency + egress tier
  promotionTier?: number           // failover promotion order across replicas (lower promotes first)
  cacheConfig?: CacheConfig        // cache configuration for this managed service
}

// Fixed class ceiling that throttles over, vs an on-demand ceiling that bursts and prices
// per-request (node-model Phase 5.4). Absent ⇒ 'provisioned'.
export type ManagedCapacityMode = 'provisioned' | 'serverless'

// Commitment term on a PROVISIONED managed DB (node-model Phase 5.4) — discounts the hourly only;
// orthogonal to capacityMode. Absent ⇒ 'onDemand'.
export type ManagedPricingCommitment = 'onDemand' | 'reserved1yr' | 'reserved3yr'

// Where a managed DB's read replicas live (node-model Phase 5.4) — the lightweight locality model:
// a read-latency + egress TIER, not explicit per-AZ pins. Absent ⇒ 'sameAz'.
export type ReplicaLocality = 'sameAz' | 'multiAz' | 'crossRegion'

// The CLOUD_REGISTRY nodeType keys that ARE databases — the ones the instance-class ceiling and
// pricing apply to. Kept beside ManagedService so every consumer agrees on what "a managed DB" is.
export const MANAGED_DB_NODE_TYPES = ['dbSql', 'dbNoSql'] as const

export function managedDbEngine(nodeType: string): DbEngine | null {
  if (nodeType === 'dbSql') return 'sql'
  if (nodeType === 'dbNoSql') return 'nosql'
  return null
}

// ─── Regional load balancer (accurate ALB/NLB) ───────────────────────────────
// One regional LB per region whose nodes conceptually live in each AZ. `mode` picks the
// device: 'l4' (NLB — connection routing, cross-zone off by default) or 'l7' (ALB — path
// routing via listenerRules, cross-zone on by default). `crossZone` decouples the entry AZ
// (ingress node) from the serving AZ. A target group is modeled implicitly as all healthy
// instances of a `targetBlueprintId` in the region.
export type LbMode = 'l4' | 'l7'
export type LbAlgorithm = 'round-robin' | 'weighted'

export interface ListenerRule {
  id: string
  pathPattern: string          // e.g. '/api/*' — glob prefix, first-match-wins (L7 only)
  targetBlueprintId: BlueprintId
}

export interface LoadBalancer {
  id: LbId
  regionId: RegionId
  label: string
  mode: LbMode
  crossZone: boolean
  algorithm: LbAlgorithm
  listenerRules: ListenerRule[]                 // L7 only; [] in L4
  defaultTargetBlueprintId: BlueprintId | null  // ALB "default action"; null = all entry blueprints
  // Relative per-AZ weight, read only when algorithm === 'weighted' (ignored under
  // 'round-robin', so switching back is loss-free). Missing/absent AZ ⇒ default weight 1.
  // Optional so older-authored/serialized LBs need no migration.
  azWeights?: Record<AzId, number>
}

// ─── Scenario Timeline (FEAT-003) ────────────────────────────────────────────

export type ScenarioAction =
  | { type: 'inject-fault'; scope: FaultScope; id: string; spec: FaultSpec }
  | { type: 'clear-fault'; scope: FaultScope; id: string }
  | { type: 'partition'; fault: PartitionFault }
  // Audit final-review I3: was array-index addressed; a partition authored/healed by hand via
  // PartitionsSection mid-run shifted every later index. Now addresses by PartitionFault.id — the
  // matched `partition` action's `fault.id` (author-supplied so this step can reference it ahead
  // of runtime, since ids aren't assigned until addPartition applies the fault).
  | { type: 'heal-partition'; partitionId: string }
  | { type: 'demand-multiplier'; factor: number; rampSec: number }
  | { type: 'set-population-rps'; populationId: string; peakRps: number; rampSec: number }

export interface ScenarioStep {
  atMs: number
  action: ScenarioAction
  note?: string
}

export interface Scenario {
  id: string
  label: string
  seed: number
  durationMs: number
  steps: ScenarioStep[]
}

export interface WorldDoc {
  routing: RoutingConfig
  populations: Record<PopulationId, ClientPopulation>
  regions: Record<RegionId, Region>
  azs: Record<AzId, AvailabilityZone>
  servers: Record<ServerId, Server>
  blueprints: Record<BlueprintId, ServiceBlueprint>
  placements: Record<PlacementId, Placement>
  managedServices: Record<ManagedServiceId, ManagedService>
  loadBalancers: Record<LbId, LoadBalancer>
  racks: Record<RackId, Rack>
  // Route catalog (Phase 2 L7 route system) — the revived packet registry. Its HTTP-protocol
  // templates ARE the routes populations emit (via requestMix) and listener rules match. Lives
  // inside WorldDoc so every route edit rides world.store's mutate() (undo/dirty) and serializes
  // with the world. Persisted in .scalemap's `packets` slot (serializer lifts/folds it).
  packets: PacketRegistry
  // Manual node positions for the visual Connections editor (app/world/connections/), keyed by
  // node id (blueprint id, managed-service id, or the synthetic '__internet__'). Holds ONLY
  // user-dragged OVERRIDES — a node absent here falls back to the auto tree-layout. Additive/
  // normalized-on-load (defaulted to {}); "auto-arrange" clears it back to pure auto-layout.
  connectionLayout: Record<string, NodeLayout>
  // Scenario timeline (FEAT-003). Optional; absent ⇒ no scenario defined. Drives the scenario
  // timeline UI and deterministic action replay during simulation.
  scenario?: Scenario
}

export interface NodeLayout { x: number; y: number }

// ─── Compiled output (produced by compileWorld, consumed by views/engine) ────

export type HopClass = 'localhost' | 'same-az' | 'cross-az' | 'cross-region'

export interface ServiceInstance {
  id: InstanceId            // `${placementId}#${index}`
  blueprintId: BlueprintId
  placementId: PlacementId
  serverId: ServerId
  azId: AzId
  regionId: RegionId
  role: PlacementRole
  indexInPlacement: number
}

export type BlockReasonKind = 'no-port-binding' | 'firewall-deny' | 'network-isolation'

export interface BlockReason {
  kind: BlockReasonKind
  detail: string
  firewallRuleId: string | null
}

export type PathTarget =
  | { kind: 'instance'; instanceId: InstanceId }
  | { kind: 'managed'; managedServiceId: ManagedServiceId }

export interface CompiledPath {
  id: string
  dependencyId: string
  fromInstanceId: InstanceId
  to: PathTarget
  hopClass: HopClass
  verdict: 'permitted' | 'blocked'
  blockReason: BlockReason | null
}

// Resolved regional LB config the engine consumes (additive to CompiledRouting). Target
// blueprint ids only — the engine resolves them to instances via azBlueprintTargets + the
// round-robin cursors at runtime. `rules` is [] in L4; `defaultTargetBlueprintIds` holds the
// default action's targets (entry blueprints when the LB was synthesized).
export interface CompiledLbRouting {
  mode: LbMode
  crossZone: boolean
  algorithm: LbAlgorithm
  rules: { pathPattern: string; targetBlueprintId: BlueprintId }[]
  defaultTargetBlueprintIds: BlueprintId[]
  // Resolved per-AZ weights (defaulted from the authored LB; {} when absent or algorithm is
  // 'round-robin' — distributeToTargets only consults this when algorithm === 'weighted').
  azWeights: Record<AzId, number>
}

export interface CompiledRouting {
  populationRegionOrder: Record<PopulationId, RegionId[]>
  regionAzSpread: Record<RegionId, AzId[]>
  azBlueprintTargets: Record<AzId, Record<BlueprintId, InstanceId[]>>
  lbRouting: Record<RegionId, CompiledLbRouting>
  // Audit ISSUE-021 (additive): normalized per-region traffic PROPORTIONS for the 'weighted'
  // policy — Route 53 weighted records split a population's clients ~70/30, they don't send
  // 100% to the top weight. Present only when policy === 'weighted' with ≥1 positive weight
  // (proportions sum to 1 over the positively-weighted regions); undefined for order-based
  // policies and for the all-zero-weights default, which falls back to the geo order.
  regionProportions?: Record<RegionId, number>
}

export interface CompileFinding {
  id: string
  severity: 'error' | 'warning'
  // 'protocol-mismatch' (audit ISSUE-007): a dependency's authored `protocol` field disagrees with
  // the majority-weight protocol of its bound packet mix — the render tint (`dep.protocol`, the
  // ONLY place this field has semantics) and the actual simulated behavior (bytes, connection
  // hold, WAL amplification — all derived from the mix) can silently show two different stories.
  kind: 'blocked-path' | 'stateful-without-volume' | 'missing-volume' | 'protocol-mismatch'
  message: string
  affected: string[]   // entity ids (instance/server/blueprint/placement ids)
}

export interface CompiledWorld {
  instances: Record<InstanceId, ServiceInstance>
  paths: CompiledPath[]
  routing: CompiledRouting
  findings: CompileFinding[]
}
