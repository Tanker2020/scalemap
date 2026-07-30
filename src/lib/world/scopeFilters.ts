// src/lib/world/scopeFilters.ts
// Polish 4 T1 (spec D2): the four pure scoping helpers that filter the dock's Analysis/Events/
// Cost tabs (and the entity closure they share) down to the current DockScope. Pure — no React,
// no store imports; everything the caller needs (nav-derived scope, doc, compiled, events,
// batch, findings, world metrics) comes in as an argument, matching scope.ts's contract so both
// stay node-env testable without jsdom/Zustand.
//
// Moved verbatim from src/app/world/dock/scopeData.ts (mechanical move, ai-chat-assistant Task 3)
// so lib/-side consumers (e.g. the chat context builder) can reuse them without importing app/.
import type { WorldDoc, CompiledWorld, CompileFinding } from './types'
import type { EngineEvent, MetricsBatch } from '../worldEngine/types'
import type { AnalysisFinding } from '../analysis/types'
import { regionEvents } from '../../app/world/region/regionData'
import type { DockScope } from '../../app/world/dock/scope'

// Entity closure per D2's literal definition — "region -> its AZs/servers/instances" / "server
// -> itself + its instances" — extended symmetrically for az ("itself + its servers + their
// instances"). World scope returns `null`: the sentinel every helper below treats as "no
// filter, show everything," never as an empty result.
//
// T1 fix wave (review finding, 2026-07-11): ALSO resolves blueprint and managed-service ids into
// the closure — several AnalysisFinding/CompileFinding `affected` arrays carry ONLY a blueprint
// id (`db-port-exposed`'s public-port variant, `stateful-without-volume`) or ONLY a
// managed-service id (`unused-managed-service`), so those findings were invisible at every
// narrower scope even when physically placed there — spec D2 requires findings "physically
// located in the scope" to surface. A blueprint id counts as in-scope when it has a
// `compiled.instances` entry whose server/az/region falls within the current scope (the same
// "blueprint -> placed instances" walk `entryUnreachable` in analysis/rules/network.ts performs;
// reimplemented here, not imported, since that walk is a rule-local const, not exported). A
// managed-service id resolves via its own `ManagedScope` field instead (`managedServiceIdsInScope`
// below), since a managed service has no placed instances of its own. Population ids remain
// unwalked — no `DockScope` variant models a population, so there is no narrower scope for one to
// resolve into.
export function scopeEntityIds(scope: DockScope, doc: WorldDoc, compiled: CompiledWorld): Set<string> | null {
  if (scope.kind === 'world') return null

  if (scope.kind === 'region') {
    const azIds = Object.values(doc.azs).filter(a => a.regionId === scope.regionId).map(a => a.id)
    const azIdSet = new Set(azIds)
    const serverIds = Object.values(doc.servers).filter(s => azIdSet.has(s.azId)).map(s => s.id)
    const regionInstances = Object.values(compiled.instances).filter(i => i.regionId === scope.regionId)
    const instanceIds = regionInstances.map(i => i.id)
    const blueprintIds = new Set(regionInstances.map(i => i.blueprintId))
    const managedServiceIds = managedServiceIdsInScope(doc, scope)
    return new Set([scope.regionId, ...azIds, ...serverIds, ...instanceIds, ...blueprintIds, ...managedServiceIds])
  }

  if (scope.kind === 'az') {
    const serverIds = Object.values(doc.servers).filter(s => s.azId === scope.azId).map(s => s.id)
    const azInstances = Object.values(compiled.instances).filter(i => i.azId === scope.azId)
    const instanceIds = azInstances.map(i => i.id)
    const blueprintIds = new Set(azInstances.map(i => i.blueprintId))
    const managedServiceIds = managedServiceIdsInScope(doc, scope)
    return new Set([scope.azId, ...serverIds, ...instanceIds, ...blueprintIds, ...managedServiceIds])
  }

  // server — ManagedScope has no server-level variant, so a managed service never resolves here.
  const serverInstances = Object.values(compiled.instances).filter(i => i.serverId === scope.serverId)
  const instanceIds = serverInstances.map(i => i.id)
  const blueprintIds = new Set(serverInstances.map(i => i.blueprintId))
  return new Set([scope.serverId, ...instanceIds, ...blueprintIds])
}

// Managed-service ids "physically located" within scope (T1 fix wave) — resolved via the
// service's own `scope` field (region or az; `ManagedScope` has no server variant, so this is
// never called for server scope) rather than via placed instances, since a managed service has
// none. Region scope: matches services scoped directly to it PLUS services scoped to any AZ
// inside it — the same descendant roll-up region scope already gives az/server/instance ids
// above. Az scope: matches services scoped directly to it only — a region-scoped service does
// NOT roll back down into one specific AZ, the same asymmetry that already keeps `regionId`
// itself out of the az-scope closure above.
function managedServiceIdsInScope(doc: WorldDoc, scope: DockScope): string[] {
  if (scope.kind === 'world' || scope.kind === 'server') return []
  return Object.values(doc.managedServices)
    .filter(ms => scope.kind === 'region'
      ? (ms.scope.kind === 'region' ? ms.scope.regionId === scope.regionId : doc.azs[ms.scope.azId]?.regionId === scope.regionId)
      : (ms.scope.kind === 'az' && ms.scope.azId === scope.azId))
    .map(ms => ms.id)
}

// World scope: every event, unfiltered (same array reference — no defensive copy needed, callers
// already treat this as read-only). Region scope MUST delegate to the existing `regionEvents`
// (region/regionData.ts) rather than reimplement its id-closure logic (it additionally folds in
// population routing, which `scopeEntityIds` deliberately does not model). Az/server scope
// generalizes the same "events whose affected ids intersect this scope's entities" shape via
// `scopeEntityIds`.
export function scopedEvents(
  scope: DockScope, doc: WorldDoc, compiled: CompiledWorld, events: EngineEvent[], batch: MetricsBatch | null,
): EngineEvent[] {
  if (scope.kind === 'world') return events
  if (scope.kind === 'region') return regionEvents(scope.regionId, doc, compiled, events, batch)

  const ids = scopeEntityIds(scope, doc, compiled)
  if (!ids) return events // unreachable (only 'world' returns null, handled above) — defensive
  return events.filter(e => e.affected.some(id => ids.has(id)))
}

// World scope: both lists pass through unfiltered (same references). Narrower scopes: keep only
// findings whose `affected` intersects the scope's entity closure — the tab badge count (D2)
// is `analysis.length + compile.length` of this result.
export function scopedFindings(
  scope: DockScope, findings: AnalysisFinding[], compileFindings: CompileFinding[], doc: WorldDoc, compiled: CompiledWorld,
): { analysis: AnalysisFinding[]; compile: CompileFinding[] } {
  if (scope.kind === 'world') return { analysis: findings, compile: compileFindings }

  const ids = scopeEntityIds(scope, doc, compiled)
  if (!ids) return { analysis: findings, compile: compileFindings } // unreachable, defensive
  return {
    analysis: findings.filter(f => f.affected.some(id => ids.has(id))),
    compile: compileFindings.filter(f => f.affected.some(id => ids.has(id))),
  }
}
