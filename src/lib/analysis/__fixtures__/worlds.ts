import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement, createPopulation,
} from '../../world/factories'
import { getPreset } from '../../world/instanceCatalog'
import { compileWorld } from '../../world/compileWorld'
import type {
  WorldDoc, Region, AvailabilityZone, Server, ServiceBlueprint, Placement, ClientPopulation,
} from '../../world/types'

export interface Scenario {
  doc: WorldDoc
  region(catalogId: string): Region
  az(regionId: string, label: string): AvailabilityZone
  server(azId: string, presetId?: string): Server
  blueprint(name: string, colorIndex?: number): ServiceBlueprint
  placement(blueprintId: string, serverId: string): Placement
  population(label: string, lat: number, lon: number): ClientPopulation
  compile(): ReturnType<typeof compileWorld>
}

// autoBaseline is disabled so tests exercise only what they author.
export function scenario(): Scenario {
  const doc = createWorld()
  doc.traffic.autoBaseline = false
  return {
    doc,
    region(catalogId) { const r = createRegion(catalogId); doc.regions[r.id] = r; return r },
    az(regionId, label) { const a = createAz(regionId, label); doc.azs[a.id] = a; return a },
    server(azId, presetId = 'dedicated-8') { const s = createServer(azId, getPreset(presetId)!); doc.servers[s.id] = s; return s },
    blueprint(name, colorIndex = 0) { const b = createBlueprint(name, colorIndex); doc.blueprints[b.id] = b; return b },
    placement(blueprintId, serverId) { const p = createPlacement(blueprintId, serverId); doc.placements[p.id] = p; return p },
    population(label, lat, lon) { const p = createPopulation(label, lat, lon); doc.populations[p.id] = p; return p },
    compile() { return compileWorld(doc) },
  }
}

// Helper: a blueprint dependency object (blueprint→blueprint).
export function dep(id: string, blueprintId: string, protocol: 'http' | 'db' | 'event' | 'stream', port = 8080) {
  return { id, target: { kind: 'blueprint' as const, blueprintId }, port, protocol, packetTemplateId: null }
}
