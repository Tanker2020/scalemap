import type {
  WorldDoc, Region, AvailabilityZone, Server, ServiceBlueprint, Placement,
  ServerKind, ServerSpecs, ClientPopulation,
} from './types'

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
      dnsTtlSec: 30,
    },
    traffic: { autoBaseline: true, baselineTotalRps: 1000 },
    populations: {},
    regions: {},
    azs: {},
    servers: {},
    blueprints: {},
    placements: {},
    managedServices: {},
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
    rack: { rackId: 'rack-1', unit: 1, heightU: preset.kind === 'dedicated' ? 2 : 1 },
  }
}

export function createBlueprint(name: string, colorIndex: number): ServiceBlueprint {
  return {
    id: nextWorldId('bp'),
    name,
    color: BLUEPRINT_COLORS[colorIndex % BLUEPRINT_COLORS.length],
    workload: { cpuMsPerRequest: 5, ramBaseMb: 128, ramPerConnMb: 0.5, diskIoPerRequest: 0 },
    ports: [{ port: 8080, protocol: 'tcp', visibility: 'internal' }],
    dependencies: [],
    stateful: false,
    volumeName: null,
  }
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
