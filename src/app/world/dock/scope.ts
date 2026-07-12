// src/app/world/dock/scope.ts
// Polish 4 T1 (spec D1): the dock's scope is DERIVED, never stored — "scope = where you are +
// what you selected." Navigating (nav.store) sets the scope; a floor selection (ui.store's
// selectedServerId) narrows it one level further; any scope-rail pill widens back. Pure — no
// React, no store imports (only TYPE-ONLY imports of WorldLevel/PanelTab below, which erase at
// build time and add zero runtime coupling) — so this stays node-env testable with plain
// `nav`/`selectedServerId`/`doc` arguments, per the brief's contract.
import type { WorldDoc } from '../../../lib/world/types'
import type { WorldLevel } from '../../store/nav.store'
import type { PanelTab } from '../../store/ui.store'

export type DockScope =
  | { kind: 'world' }
  | { kind: 'region'; regionId: string }
  | { kind: 'az'; regionId: string; azId: string }
  | { kind: 'server'; regionId: string; azId: string; serverId: string }

export interface NavSnapshot {
  level: WorldLevel
  regionId: string | null
  azId: string | null
  serverId: string | null
}

// D1's derivation ladder, most-specific first:
//  - nav.level 'server'          -> server scope, straight from nav.serverId
//  - nav.level 'az' + a selected server that still exists AND belongs to this AZ -> server scope
//    (the stale/foreign guard: a deleted server, or one that lived in a DIFFERENT az before the
//    user navigated here, must never silently narrow the dock into someone else's server)
//  - nav.level 'az'              -> az scope
//  - nav.level 'region'          -> region scope
//  - else (globe, or malformed nav missing the ids its own level implies) -> world scope
export function deriveScope(nav: NavSnapshot, selectedServerId: string | null, doc: WorldDoc): DockScope {
  if (nav.level === 'server' && nav.regionId && nav.azId && nav.serverId) {
    return { kind: 'server', regionId: nav.regionId, azId: nav.azId, serverId: nav.serverId }
  }

  if (nav.level === 'az' && nav.regionId && nav.azId) {
    if (selectedServerId && doc.servers[selectedServerId]?.azId === nav.azId) {
      return { kind: 'server', regionId: nav.regionId, azId: nav.azId, serverId: selectedServerId }
    }
    return { kind: 'az', regionId: nav.regionId, azId: nav.azId }
  }

  if (nav.level === 'region' && nav.regionId) {
    return { kind: 'region', regionId: nav.regionId }
  }

  return { kind: 'world' }
}

// D2: world scope keeps today's full seven-tab dock; every narrower scope collapses to the
// same four-tab set (Config/Analysis/Events/Cost) — Blueprints/Traffic/Placements are
// inherently world-only and fold into the world pill instead of showing global data in a local
// frame. Returns a fresh array each call so a caller can't mutate a shared constant out from
// under future callers.
const WORLD_TABS: PanelTab[] = ['topology', 'blueprints', 'placements', 'traffic', 'analysis', 'events', 'cost']
const SCOPED_TABS: PanelTab[] = ['config', 'analysis', 'events', 'cost']

export function scopeTabs(scope: DockScope): PanelTab[] {
  return scope.kind === 'world' ? [...WORLD_TABS] : [...SCOPED_TABS]
}
