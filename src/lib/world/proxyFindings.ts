// src/lib/world/proxyFindings.ts
// Compile-time validation for self-hosted reverse proxies (BlueprintKind 'proxy'), plus the ONE
// definition of which of a proxy's dependencies are routable upstreams — shared by these findings
// and the engine (flows.ts → worldEngine/proxyRouting.ts) so the two can never disagree.
// PURE: reads the doc only. A doc with no proxy blueprint yields [] (compile output unchanged).
import type { BlueprintDependency, CompileFinding, ServiceBlueprint, WorldDoc } from './types'
import type { PacketRegistry } from '../nodeConfig'
import { resolveMixProtocol } from '../packetResolve'

// An event edge is asynchronous (topic/broker semantics, worldEngine/broker.ts) — a proxy can't
// forward it. The protocol is resolved exactly as the broker resolves it: the bound packet mix
// wins, the authored protocol is the fallback.
export function isEventDependency(packets: PacketRegistry, dep: BlueprintDependency): boolean {
  return (resolveMixProtocol(packets, dep.packetMix) ?? dep.protocol) === 'event'
}

export function proxyUpstreamIds(packets: PacketRegistry, bp: ServiceBlueprint): string[] {
  return bp.dependencies.filter(d => !isEventDependency(packets, d)).map(d => d.id)
}

export function proxyFindings(doc: WorldDoc): CompileFinding[] {
  const findings: CompileFinding[] = []
  for (const bp of Object.values(doc.blueprints)) {
    if (bp.kind !== 'proxy') continue
    const cfg = bp.proxyConfig
    const depIds = new Set(bp.dependencies.map(d => d.id))
    const upstreams = proxyUpstreamIds(doc.packets, bp)

    for (const dep of bp.dependencies) {
      if (!isEventDependency(doc.packets, dep)) continue
      findings.push({
        id: `finding-proxy-event-${dep.id}`, severity: 'error', kind: 'proxy-event-upstream',
        message: `${bp.name} is a reverse proxy but has an async event dependency — a proxy forwards requests, not events; it will never route to this edge`,
        affected: [bp.id],
      })
    }
    if (upstreams.length === 0) {
      findings.push({
        id: `finding-proxy-none-${bp.id}`, severity: 'warning', kind: 'proxy-no-upstreams',
        message: `${bp.name} is a reverse proxy with no upstreams — every request it receives is refused. Connect it to the services it fronts`,
        affected: [bp.id],
      })
    }
    if (!cfg) continue

    const unknown = new Set<string>()
    if (cfg.mode === 'l7') {
      for (const r of cfg.listenerRules) if (!depIds.has(r.dependencyId)) unknown.add(r.dependencyId)
      if (cfg.defaultDependencyId != null && !depIds.has(cfg.defaultDependencyId)) unknown.add(cfg.defaultDependencyId)
    } else {
      for (const id of Object.keys(cfg.upstreamWeights ?? {})) if (!depIds.has(id)) unknown.add(id)
    }
    if (unknown.size > 0) {
      findings.push({
        id: `finding-proxy-unknown-${bp.id}`, severity: 'error', kind: 'proxy-unknown-upstream',
        message: `${bp.name}'s routing config names ${unknown.size} upstream${unknown.size === 1 ? '' : 's'} that ${unknown.size === 1 ? 'is' : 'are'} no longer connected — those rules/weights are ignored`,
        affected: [bp.id],
      })
    }
    if (cfg.mode === 'l7' && cfg.defaultDependencyId == null && upstreams.length > 0) {
      findings.push({
        id: `finding-proxy-nodefault-${bp.id}`, severity: 'warning', kind: 'proxy-l7-no-default',
        message: `${bp.name} is an L7 proxy with no default upstream — unmatched paths and all traffic arriving from other services will be dropped (503)`,
        affected: [bp.id],
      })
    }
  }
  return findings
}
