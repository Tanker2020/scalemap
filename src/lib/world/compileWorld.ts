// Pure resolver: WorldDoc → CompiledWorld. The single gate between authored data and
// everything that renders or simulates. No store access, no side effects, no randomness.
import type {
  WorldDoc, CompiledWorld, ServiceInstance, InstanceId,
} from './types'

export function instanceId(placementId: string, index: number): InstanceId {
  return `${placementId}#${index}`
}

export function compileWorld(doc: WorldDoc): CompiledWorld {
  const instances: Record<InstanceId, ServiceInstance> = {}

  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server) continue                    // dangling placement — authoring UI prevents, files may not
    const az = doc.azs[server.azId]
    if (!az) continue
    const region = doc.regions[az.regionId]
    if (!region) continue

    for (let i = 0; i < pl.count; i++) {
      const id = instanceId(pl.id, i)
      instances[id] = {
        id,
        blueprintId: bp.id,
        placementId: pl.id,
        serverId: server.id,
        azId: az.id,
        regionId: region.id,
        role: pl.role,
        indexInPlacement: i,
      }
    }
  }

  return {
    instances,
    paths: [],       // Task 5
    findings: [],    // Tasks 5–6
    routing: { populationRegionOrder: {}, regionAzSpread: {}, azBlueprintTargets: {} }, // Task 6
  }
}
