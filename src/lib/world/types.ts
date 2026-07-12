// World document entities (normalized, id-keyed) + compiled output types.
// Spec: docs/superpowers/specs/2026-07-08-world-model-multiscale-simulation-design.md §3

export type RegionId = string
export type AzId = string
export type ServerId = string
export type RackId = string
export type BlueprintId = string
export type PlacementId = string
export type ManagedServiceId = string
export type PopulationId = string
export type InstanceId = string

export type RoutingPolicyKind = 'latency' | 'geo' | 'weighted' | 'priority'

export interface RoutingConfig {
  policy: RoutingPolicyKind
  weights: Record<RegionId, number>   // policy === 'weighted'
  priorityOrder: RegionId[]           // policy === 'priority'
  healthCheckIntervalMs: number
  healthCheckFailureThreshold: number
  dnsTtlSec: number
}

export interface TrafficConfig {
  autoBaseline: boolean
  baselineTotalRps: number
}

export type DiurnalPattern = 'flat' | 'day-night'

export interface ClientPopulation {
  id: PopulationId
  label: string
  lat: number
  lon: number
  peakRps: number
  diurnal: DiurnalPattern
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

export type ServerKind = 'dedicated' | 'vps'

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
}

export interface ServiceBlueprint {
  id: BlueprintId
  name: string
  color: string   // signature color (hex) — binds chip/RAM stratum/core share across views
  workload: WorkloadProfile
  ports: ServicePort[]
  dependencies: BlueprintDependency[]
  stateful: boolean
  volumeName: string | null   // required when stateful
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

export interface WorldDoc {
  routing: RoutingConfig
  traffic: TrafficConfig
  populations: Record<PopulationId, ClientPopulation>
  regions: Record<RegionId, Region>
  azs: Record<AzId, AvailabilityZone>
  servers: Record<ServerId, Server>
  blueprints: Record<BlueprintId, ServiceBlueprint>
  placements: Record<PlacementId, Placement>
  managedServices: Record<ManagedServiceId, ManagedService>
  racks: Record<RackId, Rack>
}

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

export interface CompiledRouting {
  populationRegionOrder: Record<PopulationId, RegionId[]>
  regionAzSpread: Record<RegionId, AzId[]>
  azBlueprintTargets: Record<AzId, Record<BlueprintId, InstanceId[]>>
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
