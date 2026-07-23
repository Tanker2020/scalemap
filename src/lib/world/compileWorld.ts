// Pure resolver: WorldDoc → CompiledWorld. The single gate between authored data and
// everything that renders or simulates. No store access, no side effects, no randomness.
import type {
  WorldDoc, CompiledWorld, ServiceInstance, InstanceId, CompiledPath, CompileFinding,
  HopClass,
} from './types'
import { evaluateInstancePath } from './network'
import { computeRouting, volumeFindings } from './routing'

export function instanceId(placementId: string, index: number): InstanceId {
  return `${placementId}#${index}`
}

export function compileWorld(doc: WorldDoc): CompiledWorld {
  const instances: Record<InstanceId, ServiceInstance> = {}

  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server) continue
    const az = doc.azs[server.azId]
    if (!az) continue
    const region = doc.regions[az.regionId]
    if (!region) continue

    for (let i = 0; i < pl.count; i++) {
      const id = instanceId(pl.id, i)
      instances[id] = {
        id, blueprintId: bp.id, placementId: pl.id, serverId: server.id,
        azId: az.id, regionId: region.id, role: pl.role, indexInPlacement: i,
      }
    }
  }

  const paths: CompiledPath[] = []
  const findings: CompileFinding[] = []

  // Audit ISSUE-027: index instances by blueprint ONCE so each dependency resolves against only
  // its target blueprint's instances (O(I × D × matches)) instead of re-scanning — and
  // re-materializing — the whole instance map per (from, dep) pair (O(I × D × I), ~750k
  // evaluateInstancePath calls at 500 instances × 3 deps). Built in Object.values order, so
  // per-blueprint candidate order — and the emitted paths order every even-split consumer
  // depends on — is unchanged.
  const instancesByBlueprint = new Map<string, ServiceInstance[]>()
  for (const inst of Object.values(instances)) {
    const list = instancesByBlueprint.get(inst.blueprintId)
    if (list) list.push(inst)
    else instancesByBlueprint.set(inst.blueprintId, [inst])
  }

  for (const from of Object.values(instances)) {
    const fromBp = doc.blueprints[from.blueprintId]
    const fromPl = doc.placements[from.placementId]
    const fromServer = doc.servers[from.serverId]
    if (!fromBp || !fromPl || !fromServer) continue

    for (const dep of fromBp.dependencies) {
      if (dep.target.kind === 'managed') {
        const ms = doc.managedServices[dep.target.managedServiceId]
        if (!ms) continue // dangling dependency
        paths.push({
          id: `${from.id}->${dep.id}->${ms.id}`,
          dependencyId: dep.id,
          fromInstanceId: from.id,
          to: { kind: 'managed', managedServiceId: ms.id },
          hopClass: managedHopClass(doc, from.azId, from.regionId, ms.id),
          verdict: 'permitted', // provider side — always reachable (spec D12)
          blockReason: null,
        })
        continue
      }

      const targetBpId = dep.target.blueprintId
      for (const to of instancesByBlueprint.get(targetBpId) ?? []) {
        const toPl = doc.placements[to.placementId]
        const toServer = doc.servers[to.serverId]
        const toBp = doc.blueprints[to.blueprintId]
        if (!toPl || !toServer || !toBp) continue

        const evaluation = evaluateInstancePath({
          fromServer, toServer,
          fromRuntime: fromPl.runtime, toRuntime: toPl.runtime,
          toBlueprint: toBp, port: dep.port, azs: doc.azs,
        })
        const path: CompiledPath = {
          id: `${from.id}->${dep.id}->${to.id}`,
          dependencyId: dep.id,
          fromInstanceId: from.id,
          to: { kind: 'instance', instanceId: to.id },
          hopClass: evaluation.hopClass,
          verdict: evaluation.verdict,
          blockReason: evaluation.blockReason,
        }
        paths.push(path)
        if (path.verdict === 'blocked' && path.blockReason) {
          findings.push({
            id: `finding-${path.id}`,
            severity: 'error',
            kind: 'blocked-path',
            message: `${fromBp.name} → ${toBp.name}:${dep.port} is blocked: ${path.blockReason.detail}`,
            affected: [from.id, to.id, toServer.id],
          })
        }
      }
    }
  }

  return {
    instances,
    paths,
    findings: [...findings, ...volumeFindings(doc)],
    routing: computeRouting(doc, instances),
  }
}

function managedHopClass(doc: WorldDoc, fromAzId: string, fromRegionId: string, msId: string): HopClass {
  const ms = doc.managedServices[msId]
  if (!ms) return 'cross-region'
  if (ms.scope.kind === 'az') {
    if (ms.scope.azId === fromAzId) return 'same-az'
    return doc.azs[ms.scope.azId]?.regionId === fromRegionId ? 'cross-az' : 'cross-region'
  }
  return ms.scope.regionId === fromRegionId ? 'cross-az' : 'cross-region'
}
