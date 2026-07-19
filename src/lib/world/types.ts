// World document entities (normalized, id-keyed) + compiled output types.
// Spec: docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md §3
import type { PacketRegistry } from '../nodeConfig'

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
  dnsTtlSec: number
}

export type DiurnalPattern = 'flat' | 'day-night'

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
}

export type DependencyTarget =
  | { kind: 'blueprint'; blueprintId: BlueprintId }
  | { kind: 'managed'; managedServiceId: ManagedServiceId }

export interface BlueprintDependency {
  id: string
  target: DependencyTarget
  port: number
  protocol: 'http' | 'db' | 'event' | 'stream'
  packetTemplateId: number | null
  // Fraction of this dependency's call volume that MUTATES the target, 0..1 (node-model Phase 3).
  // Only meaningful when the target is a DB blueprint: writes route to the primary (SQL) / all
  // nodes (NoSQL), reads to the replicas. Absent ⇒ 0 (pure reads), which for a non-DB target is
  // the only sensible value and preserves the pre-Phase-3 even fan-out exactly. Optional +
  // normalized-on-load, like the other additive fields, until Phase 5's format cutover.
  writeFraction?: number
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
}

export interface CompiledRouting {
  populationRegionOrder: Record<PopulationId, RegionId[]>
  regionAzSpread: Record<RegionId, AzId[]>
  azBlueprintTargets: Record<AzId, Record<BlueprintId, InstanceId[]>>
  lbRouting: Record<RegionId, CompiledLbRouting>
}

export interface CompileFinding {
  id: string
  severity: 'error' | 'warning'
  kind: 'blocked-path' | 'stateful-without-volume' | 'missing-volume'
  message: string
  affected: string[]   // entity ids (instance/server/blueprint/placement ids)
}

export interface CompiledWorld {
  instances: Record<InstanceId, ServiceInstance>
  paths: CompiledPath[]
  routing: CompiledRouting
  findings: CompileFinding[]
}
