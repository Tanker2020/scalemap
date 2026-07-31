// src/app/world/dock/scopeData.ts
// Polish 4 T1 (spec D2): the four pure scoping helpers that filter the dock's Analysis/Events/
// Cost tabs (and the entity closure they share) down to the current DockScope. Pure — no React,
// no store imports; everything the caller needs (nav-derived scope, doc, compiled, events,
// batch, findings, world metrics) comes in as an argument, matching scope.ts's contract so both
// stay node-env testable without jsdom/Zustand.
import type { WorldDoc } from '../../../lib/world/types'
import type { WorldMetrics, ManagedServiceMetrics } from '../../../lib/worldEngine/types'
import { computeWorldCost, HOURS_PER_MONTH } from '../../../lib/costModelV2'
import type { DockScope } from './scope'

// scopeEntityIds/scopedEvents/scopedFindings moved verbatim to src/lib/world/scopeFilters.ts
// (ai-chat-assistant Task 3, mechanical move) so lib/-side consumers (the chat context builder)
// can reuse them without importing app/. Re-exported here so every existing call site into
// scopeData.ts keeps working unchanged.
export { scopeEntityIds, scopedEvents, scopedFindings } from '../../../lib/world/scopeFilters'

// Cost rollup per scope (D2): region/AZ read computeWorldCost().byRegion/byAz (compute cost
// only — that function has no per-region/per-az egress breakdown, only a world total, so
// egressNote is null there, same as today's world Cost tab already implicitly assumes).
// Server scope reads the server's own hourlyUsd directly and carries the documented deviation
// note: the cost model attributes egress at AZ/region/world level only, never per-server.
export function scopedCost(
  scope: DockScope, doc: WorldDoc, world: WorldMetrics | null,
  managed: Record<string, ManagedServiceMetrics> | null = null,
): { hourlyUsd: number; monthlyUsd: number; egressNote: string | null } {
  if (scope.kind === 'server') {
    const hourlyUsd = doc.servers[scope.serverId]?.hourlyUsd ?? 0
    return { hourlyUsd, monthlyUsd: hourlyUsd * HOURS_PER_MONTH, egressNote: 'egress is attributed at the AZ level' }
  }

  const cost = computeWorldCost(doc, world, managed)
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
