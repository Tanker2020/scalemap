import type {
  WorldDoc, Region, AvailabilityZone, Server, ServiceBlueprint, Placement,
  ServerKind, ServerSpecs, ClientPopulation, AzId, Rack, LoadBalancer, DbEngine,
  Vpc, Subnet, RouteTable, InternetGateway, NatGateway, SecurityGroup, VpcId, SubnetId, RouteTableId, RegionId,
} from './types'
import { RACK_CAPACITY_DEFAULT } from './rackModel'
import { emptyPacketRegistry } from '../nodeConfig'

let worldCounter = 0
export function nextWorldId(prefix: string): string {
  return `${prefix}-${++worldCounter}-${Date.now().toString(36)}`
}

// Signature colors: teal, blue, purple, amber, pink, green (dark-canvas calibrated).
export const BLUEPRINT_COLORS = ['#2DD4BF', '#4A9EFF', '#A78BFA', '#F5A623', '#F472B6', '#22C55E']

export function createWorld(): WorldDoc {
  return {
    routing: {
      policy: 'latency',
      weights: {},
      priorityOrder: [],
      healthCheckIntervalMs: 10_000,
      healthCheckFailureThreshold: 3,
      healthCheckTimeoutMs: 5_000,   // audit ISSUE-061 — probe timeout, part of real detection time
      dnsTtlSec: 30,
    },
    populations: {},
    regions: {},
    azs: {},
    servers: {},
    blueprints: {},
    placements: {},
    managedServices: {},
    loadBalancers: {},
    racks: {},
    packets: emptyPacketRegistry(),
    connectionLayout: {},
    vpcs: {},
    subnets: {},
    routeTables: {},
    internetGateways: {},
    natGateways: {},
    securityGroups: {},
  }
}

export function createRegion(catalogId: string): Region {
  return { id: nextWorldId('region'), catalogId, role: 'active' }
}

export function createAz(regionId: string, label: string): AvailabilityZone {
  return { id: nextWorldId('az'), label, regionId }
}

// Anything with the preset's shape works (the full InstancePreset from Task 3 satisfies this).
export interface InstancePresetLike {
  id: string
  kind: ServerKind
  specs: ServerSpecs
  hourlyUsd: number
  oversubscriptionRatio: number | null
  burstable: boolean
}

export function createServer(azId: string, preset: InstancePresetLike): Server {
  return {
    id: nextWorldId('srv'),
    label: 'server',
    azId,
    kind: preset.kind,
    catalogId: preset.id,
    specs: { ...preset.specs },
    hourlyUsd: preset.hourlyUsd,
    oversubscriptionRatio: preset.oversubscriptionRatio,
    burstable: preset.burstable,
    // Default: allow all in-world traffic; internet exposure must be opted into explicitly.
    firewall: [{ id: nextWorldId('fw'), action: 'allow', port: 'any', protocol: 'any', source: 'internal' }],
    stacks: [],
    rack: null,   // free pool — racks are optional/authored (Polish 3 Task 2, spec D4)
  }
}

export function createRack(azId: AzId, label?: string): Rack {
  return { id: nextWorldId('rack'), azId, label: label ?? 'rack', capacityU: RACK_CAPACITY_DEFAULT }
}

export function createVpc(regionId: RegionId, label?: string): Vpc {
  return { id: nextWorldId('vpc'), regionId, label: label ?? 'vpc', cidrBlock: '10.0.0.0/16' }
}

export function createSubnet(
  vpcId: VpcId,
  azId: AzId,
  kind: 'public' | 'private',
  routeTableId: RouteTableId,
): Subnet {
  return {
    id: nextWorldId('subnet'),
    vpcId,
    azId,
    kind,
    cidrBlock: kind === 'public' ? '10.0.1.0/24' : '10.0.2.0/24',
    routeTableId,
  }
}

export function createRouteTable(vpcId: VpcId): RouteTable {
  return { id: nextWorldId('rtb'), vpcId, routes: [] }
}

export function createInternetGateway(vpcId: VpcId): InternetGateway {
  return { id: nextWorldId('igw'), vpcId }
}

export function createNatGateway(subnetId: SubnetId, label?: string): NatGateway {
  return { id: nextWorldId('nat'), subnetId, label: label ?? 'nat' }
}

export function createSecurityGroup(vpcId: VpcId, label?: string): SecurityGroup {
  return { id: nextWorldId('sg'), vpcId, label: label ?? 'sg', rules: [] }
}

export function createBlueprint(name: string, colorIndex: number): ServiceBlueprint {
  return {
    id: nextWorldId('bp'),
    name,
    color: BLUEPRINT_COLORS[colorIndex % BLUEPRINT_COLORS.length],
    kind: 'api',
    workload: { cpuMsPerRequest: 5, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
    ports: [{ port: 8080, protocol: 'tcp', visibility: 'internal' }],
    dependencies: [],
    stateful: false,
    volumeName: null,
    dbConfig: null,
    ownerServerKind: null,
  }
}

// A self-hosted database appliance, created as ONE unit: the box, the single blueprint it owns,
// and the placement binding them. Per the design decision "the blueprint IS the cluster", adding
// a replica later means placing THIS blueprint (role 'replica') on another db box — there is no
// separate cluster record to keep in sync.
//
// Callers must insert all three into the doc together; world.store does this inside one mutate()
// so the whole appliance is a single undo step.
export function createDbServer(
  azId: string,
  preset: InstancePresetLike,
  name: string,
): { server: Server; blueprint: ServiceBlueprint; placement: Placement } {
  const engine: DbEngine = preset.kind === 'db-nosql' ? 'nosql' : 'sql'
  const server = createServer(azId, preset)
  server.label = name

  const blueprint = createBlueprint(name, 0)
  blueprint.kind = preset.kind === 'db-nosql' ? 'db-nosql' : 'db-sql'
  blueprint.ownerServerKind = preset.kind
  blueprint.dbConfig = { engine, storageGb: Math.round(preset.specs.diskGb * 0.8) }
  // A database owns data by definition, so it is always stateful and always has a volume —
  // this is exactly the pairing compileWorld's 'stateful-without-volume' finding checks for.
  blueprint.stateful = true
  blueprint.volumeName = `${name}-data`
  // Ports: SQL and NoSQL engines both terminate on one endpoint; 5432 is the recognizable
  // default and the user can change it. Internal only — a database must be opted into exposure.
  blueprint.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  // A DB request is heavier than a stateless API call and does real disk IO.
  blueprint.workload = { cpuMsPerRequest: 12, ramBaseMb: 1024, ramPerConnMb: 2, diskIoPerRequest: 1 }

  const placement = createPlacement(blueprint.id, server.id)   // role defaults to 'primary'

  return { server, blueprint, placement }
}

export function createPlacement(blueprintId: string, serverId: string): Placement {
  return {
    id: nextWorldId('pl'),
    blueprintId,
    serverId,
    count: 1,
    role: 'primary',
    runtime: { type: 'process' },
  }
}

export function createPopulation(label: string, lat: number, lon: number): ClientPopulation {
  return { id: nextWorldId('pop'), label, lat, lon, peakRps: 500, diurnal: 'flat' }
}

// A regional load balancer. Defaults to an NLB (L4, cross-zone off) — the accurate NLB default,
// and byte-equivalent to the pre-LB equal-per-AZ distribution. `defaultTargetBlueprintId: null`
// means "all entry blueprints" (blueprints with a public port), matching the old entry rule.
export function createLoadBalancer(regionId: string): LoadBalancer {
  return {
    id: nextWorldId('lb'),
    regionId,
    label: 'lb',
    mode: 'l4',
    crossZone: false,
    algorithm: 'round-robin',
    listenerRules: [],
    defaultTargetBlueprintId: null,
  }
}
