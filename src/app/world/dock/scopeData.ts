// src/app/world/dock/scopeData.ts
// Polish 4 T1 (spec D2): the four pure scoping helpers that filter the dock's Analysis/Events/
// Cost tabs (and the entity closure they share) down to the current DockScope. Pure — no React,
// no store imports; everything the caller needs (nav-derived scope, doc, compiled, events,
// batch, findings, world metrics) comes in as an argument, matching scope.ts's contract so both
// stay node-env testable without jsdom/Zustand.
import type { WorldDoc, CompiledWorld, CompileFinding } from '../../../lib/world/types'
import type { EngineEvent, MetricsBatch, WorldMetrics } from '../../../lib/worldEngine/types'
import type { AnalysisFinding } from '../../../lib/analysis/types'
import { computeWorldCost, HOURS_PER_MONTH } from '../../../lib/costModelV2'
import { regionEvents } from '../region/regionData'
import type { DockScope } from './scope'

// Entity closure per D2's literal definition — "region -> its AZs/servers/instances" / "server
// -> itself + its instances" — extended symmetrically for az ("itself + its servers + their
// instances"). World scope returns `null`: the sentinel every helper below treats as "no
// filter, show everything," never as an empty result. Deliberately does NOT walk managed
// services, blueprints, or populations into the closure even though a handful of
// AnalysisFinding/CompileFinding `affected` arrays carry those ids bare — D2 names only
// region/az/server/instance descendants, so a finding whose ONLY affected id is e.g. a
// managed-service id doesn't surface at any narrower scope yet (documented gap, not a bug;
// matches the brief's literal closure wording rather than inventing broader scope).
export function scopeEntityIds(scope: DockScope, doc: WorldDoc, compiled: CompiledWorld): Set<string> | null {
  if (scope.kind === 'world') return null

  if (scope.kind === 'region') {
    const azIds = Object.values(doc.azs).filter(a => a.regionId === scope.regionId).map(a => a.id)
    const azIdSet = new Set(azIds)
    const serverIds = Object.values(doc.servers).filter(s => azIdSet.has(s.azId)).map(s => s.id)
    const instanceIds = Object.values(compiled.instances).filter(i => i.regionId === scope.regionId).map(i => i.id)
    return new Set([scope.regionId, ...azIds, ...serverIds, ...instanceIds])
  }

  if (scope.kind === 'az') {
    const serverIds = Object.values(doc.servers).filter(s => s.azId === scope.azId).map(s => s.id)
    const instanceIds = Object.values(compiled.instances).filter(i => i.azId === scope.azId).map(i => i.id)
    return new Set([scope.azId, ...serverIds, ...instanceIds])
  }

  // server
  const instanceIds = Object.values(compiled.instances).filter(i => i.serverId === scope.serverId).map(i => i.id)
  return new Set([scope.serverId, ...instanceIds])
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

// Cost rollup per scope (D2): region/AZ read computeWorldCost().byRegion/byAz (compute cost
// only — that function has no per-region/per-az egress breakdown, only a world total, so
// egressNote is null there, same as today's world Cost tab already implicitly assumes).
// Server scope reads the server's own hourlyUsd directly and carries the documented deviation
// note: the cost model attributes egress at AZ/region/world level only, never per-server.
export function scopedCost(
  scope: DockScope, doc: WorldDoc, world: WorldMetrics | null,
): { hourlyUsd: number; monthlyUsd: number; egressNote: string | null } {
  if (scope.kind === 'server') {
    const hourlyUsd = doc.servers[scope.serverId]?.hourlyUsd ?? 0
    return { hourlyUsd, monthlyUsd: hourlyUsd * HOURS_PER_MONTH, egressNote: 'egress is attributed at the AZ level' }
  }

  const cost = computeWorldCost(doc, world)
  if (scope.kind === 'world') {
    return { hourlyUsd: cost.monthlyUsd / HOURS_PER_MONTH, monthlyUsd: cost.monthlyUsd, egressNote: null }
  }
  if (scope.kind === 'region') {
    const monthlyUsd = cost.byRegion.find(r => r.regionId === scope.regionId)?.monthlyUsd ?? 0
    return { hourlyUsd: monthlyUsd / HOURS_PER_MONTH, monthlyUsd, egressNote: null }
  }
  // az
  const monthlyUsd = cost.byAz.find(a => a.azId === scope.azId)?.monthlyUsd ?? 0
  return { hourlyUsd: monthlyUsd / HOURS_PER_MONTH, monthlyUsd, egressNote: null }
}
