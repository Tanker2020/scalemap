import type { WorldDoc, CompiledWorld } from './types'

export interface DependencyIndex {
  dependentsOfBlueprint: Map<string, string[]>
  dependenciesOfBlueprint: Map<string, string[]>
  dependentInstances: Map<string, string[]>
  dependencyTargets: Map<string, string[]>
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list) { if (!list.includes(value)) list.push(value) }
  else map.set(key, [value])
}

function buildIndex(doc: WorldDoc, compiled: CompiledWorld): DependencyIndex {
  const dependentsOfBlueprint = new Map<string, string[]>()
  const dependenciesOfBlueprint = new Map<string, string[]>()
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      const targetId = dep.target.kind === 'blueprint' ? dep.target.blueprintId : dep.target.managedServiceId
      push(dependenciesOfBlueprint, bp.id, targetId)
      push(dependentsOfBlueprint, targetId, bp.id)
    }
  }

  const dependentInstances = new Map<string, string[]>()
  const dependencyTargets = new Map<string, string[]>()
  for (const path of compiled.paths) {
    const targetId = path.to.kind === 'instance' ? path.to.instanceId : path.to.managedServiceId
    push(dependencyTargets, path.fromInstanceId, targetId)
    push(dependentInstances, targetId, path.fromInstanceId)
  }

  return { dependentsOfBlueprint, dependenciesOfBlueprint, dependentInstances, dependencyTargets }
}

const cache = new WeakMap<CompiledWorld, DependencyIndex>()

export function dependencyIndexFor(doc: WorldDoc, compiled: CompiledWorld): DependencyIndex {
  const cached = cache.get(compiled)
  if (cached) return cached
  const index = buildIndex(doc, compiled)
  cache.set(compiled, index)
  return index
}

function instancesHostedBy(rootId: string, compiled: CompiledWorld): string[] {
  if (compiled.instances[rootId]) return [rootId]

  // Search for instances hosted on this server/az/region
  const byServerId = Object.values(compiled.instances).filter(i => i.serverId === rootId).map(i => i.id)
  if (byServerId.length > 0) return byServerId

  const byAzId = Object.values(compiled.instances).filter(i => i.azId === rootId).map(i => i.id)
  if (byAzId.length > 0) return byAzId

  const byRegionId = Object.values(compiled.instances).filter(i => i.regionId === rootId).map(i => i.id)
  if (byRegionId.length > 0) return byRegionId

  return []
}

export function blastRadius(
  rootId: string, doc: WorldDoc, compiled: CompiledWorld, opts?: { maxDepth?: number },
): { direct: string[]; transitive: string[]; depthOf: Record<string, number> } {
  const idx = dependencyIndexFor(doc, compiled)
  const maxDepth = opts?.maxDepth ?? 8
  const roots = instancesHostedBy(rootId, compiled)
  const depthOf: Record<string, number> = {}
  const direct = new Set<string>()
  const transitive: string[] = []
  const visited = new Set<string>(roots)
  let frontier = roots
  let depth = 0
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = []
    for (const id of frontier) {
      for (const dep of idx.dependentInstances.get(id) ?? []) {
        if (visited.has(dep)) continue
        visited.add(dep)
        if (depth === 0) direct.add(dep)
        depthOf[dep] = depth + 1
        transitive.push(dep)
        next.push(dep)
      }
    }
    frontier = next
    depth += 1
  }
  return { direct: [...direct], transitive, depthOf }
}
