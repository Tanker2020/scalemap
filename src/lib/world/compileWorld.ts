// Pure resolver: WorldDoc → CompiledWorld. The single gate between authored data and
// everything that renders or simulates. No store access, no side effects, no randomness.
import type {
  WorldDoc, CompiledWorld, ServiceInstance, InstanceId, CompiledPath, CompileFinding,
  HopClass,
} from './types'
import { evaluateInstancePath } from './network'
import { computeRouting, volumeFindings } from './routing'
import { resolveMixProtocol } from '../packetResolve'

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
    findings: [...findings, ...volumeFindings(doc), ...protocolMismatchFindings(doc)],
    routing: computeRouting(doc, instances),
  }
}

// Audit ISSUE-007: `BlueprintDependency.protocol` drives ONLY the particle render tint
// (`index.ts`'s `buildAzParticles`/`buildServerParticles`); every simulated consequence — wire
// bytes, connection hold duration, WAL write amplification — comes from the bound packet mix's
// OWN resolved protocol instead. Nothing reconciles the two, so an author can set
// `dep.protocol = 'event'` on a dependency whose mix is entirely `http` packets and the board
// renders violet "event" particles for what the engine is actually costing/holding as a
// keep-alive HTTP call. This is a static, structural property of the authored world (a dependency
// + its bound mix), so it is computed ONCE per unique dependency here — not per compiled path/
// instance, which would multiply the same finding by however many instances the source blueprint
// has. Advisory only: never auto-corrects `dep.protocol`, matching how every other compile finding
// surfaces without silently overriding an explicit author choice.
function protocolMismatchFindings(doc: WorldDoc): CompileFinding[] {
  const findings: CompileFinding[] = []
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      if (!dep.packetMix || dep.packetMix.length === 0) continue
      const majority = resolveMixProtocol(doc.packets, dep.packetMix)
      if (majority == null || majority === dep.protocol) continue
      findings.push({
        id: `finding-protocol-mismatch-${dep.id}`,
        severity: 'warning',
        kind: 'protocol-mismatch',
        message: `${bp.name}'s dependency "${dep.id}" is authored as ${dep.protocol}, but its bound packet mix is mostly ${majority} — particles render as ${dep.protocol} while the engine simulates ${majority}`,
        affected: [bp.id, dep.id],
      })
    }
  }
  return findings
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
