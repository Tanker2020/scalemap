// Neutral entity-navigation helpers shared by AnalysisTab.tsx and AiReviewSection.tsx (Task 8).
// Extracted out of AnalysisTab.tsx to remove the deliberate ESM import cycle that previously
// existed between the two files (AnalysisTab imported the AiReviewSection component while
// AiReviewSection imported AnalysisTab's navigateToEntity helper). Both files now import from
// here instead of from each other.
import type { WorldDoc, CompiledWorld } from '../../lib/world/types'

export interface NavApi {
  goRegion(id: string): void
  goAz(regionId: string, azId: string): void
  goServer(regionId: string, azId: string, serverId: string): void
}

// Resolve an entity id against doc → compiled maps and navigate; returns whether nav happened.
export function navigateToEntity(id: string, doc: WorldDoc, compiled: CompiledWorld, nav: NavApi): boolean {
  if (doc.regions[id]) { nav.goRegion(id); return true }
  const az = doc.azs[id]
  if (az) { nav.goAz(az.regionId, id); return true }
  const server = doc.servers[id]
  if (server) {
    const a = doc.azs[server.azId]
    if (a) { nav.goServer(a.regionId, a.id, id); return true }
  }
  const inst = compiled.instances[id]
  if (inst) { nav.goServer(inst.regionId, inst.azId, inst.serverId); return true }
  return false // blueprint/placement/population/managed → no nav (shown in panels)
}

export function entityLabel(id: string, doc: WorldDoc, compiled: CompiledWorld): string {
  if (doc.regions[id]) return doc.regions[id].catalogId
  if (doc.azs[id]) return doc.azs[id].label
  if (doc.servers[id]) return doc.servers[id].label
  if (doc.blueprints[id]) return doc.blueprints[id].name
  if (doc.managedServices[id]) return doc.managedServices[id].label
  if (doc.populations[id]) return doc.populations[id].label
  const inst = compiled.instances[id]
  if (inst) return `${doc.servers[inst.serverId]?.label ?? inst.serverId}·${doc.blueprints[inst.blueprintId]?.name ?? ''}`
  return id
}
