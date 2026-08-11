// src/app/world/dock/scope.test.ts
// Pure logic — node env (default; no jsdom pragma needed, matches regionData.test.ts/
// rackModel.test.ts precedent).
import { describe, it, expect } from 'vitest'
import { createWorld, createRegion, createAz, createServer } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { deriveScope, scopeTabs, type NavSnapshot } from './scope'
import type { WorldDoc } from '../../../lib/world/types'

const NO_NAV: NavSnapshot = { level: 'globe', regionId: null, azId: null, serverId: null }

function seedWorld() {
  const doc: WorldDoc = createWorld()
  const region = createRegion('us-east-1')
  doc.regions[region.id] = region
  const az = createAz(region.id, 'us-east-1a')
  doc.azs[az.id] = az
  const otherAz = createAz(region.id, 'us-east-1b')
  doc.azs[otherAz.id] = otherAz
  const server = createServer(az.id, getPreset('vps-medium')!)
  doc.servers[server.id] = server
  return { doc, regionId: region.id, azId: az.id, otherAzId: otherAz.id, serverId: server.id }
}

describe('deriveScope', () => {
  it('defaults to world scope when nav is at globe', () => {
    const { doc } = seedWorld()
    expect(deriveScope(NO_NAV, null, doc)).toEqual({ kind: 'world' })
  })

  it('falls back to world scope when regionId is missing despite a region-ish level', () => {
    const { doc } = seedWorld()
    const nav: NavSnapshot = { level: 'region', regionId: null, azId: null, serverId: null }
    expect(deriveScope(nav, null, doc)).toEqual({ kind: 'world' })
  })

  it('derives region scope at nav.level "region"', () => {
    const { doc, regionId } = seedWorld()
    const nav: NavSnapshot = { level: 'region', regionId, azId: null, serverId: null }
    expect(deriveScope(nav, null, doc)).toEqual({ kind: 'region', regionId })
  })

  it('derives az scope at nav.level "az" with no selection', () => {
    const { doc, regionId, azId } = seedWorld()
    const nav: NavSnapshot = { level: 'az', regionId, azId, serverId: null }
    expect(deriveScope(nav, null, doc)).toEqual({ kind: 'az', regionId, azId })
  })

  it('narrows to server scope at nav.level "az" when a valid same-AZ server is selected', () => {
    const { doc, regionId, azId, serverId } = seedWorld()
    const nav: NavSnapshot = { level: 'az', regionId, azId, serverId: null }
    expect(deriveScope(nav, serverId, doc)).toEqual({ kind: 'server', regionId, azId, serverId })
  })

  it('ignores a STALE selection (server id no longer exists in doc.servers)', () => {
    const { doc, regionId, azId } = seedWorld()
    const nav: NavSnapshot = { level: 'az', regionId, azId, serverId: null }
    expect(deriveScope(nav, 'srv-deleted-long-ago', doc)).toEqual({ kind: 'az', regionId, azId })
  })

  it('ignores a FOREIGN selection (server exists but belongs to a different AZ)', () => {
    const { doc, regionId, azId, otherAzId } = seedWorld()
    // Selected server lives in otherAzId, but nav is focused on azId.
    const foreignServer = createServer(otherAzId, getPreset('vps-medium')!)
    doc.servers[foreignServer.id] = foreignServer
    const nav: NavSnapshot = { level: 'az', regionId, azId, serverId: null }
    expect(deriveScope(nav, foreignServer.id, doc)).toEqual({ kind: 'az', regionId, azId })
  })

  it('derives server scope at nav.level "server" straight from nav.serverId', () => {
    const { doc, regionId, azId, serverId } = seedWorld()
    const nav: NavSnapshot = { level: 'server', regionId, azId, serverId }
    expect(deriveScope(nav, null, doc)).toEqual({ kind: 'server', regionId, azId, serverId })
  })

  it('nav.level "server" wins regardless of a mismatched/stale selection value', () => {
    const { doc, regionId, azId, serverId } = seedWorld()
    const nav: NavSnapshot = { level: 'server', regionId, azId, serverId }
    expect(deriveScope(nav, 'some-other-selection', doc)).toEqual({ kind: 'server', regionId, azId, serverId })
  })
})

describe('scopeTabs', () => {
  it('returns the world tab ids, in the current dock order, for world scope', () => {
    expect(scopeTabs({ kind: 'world' })).toEqual([
      'topology', 'network', 'blueprints', 'packets', 'managed', 'connections', 'traffic', 'routes', 'scenario',
      'signals', 'analysis', 'events', 'cost', 'compare',
    ])
  })

  it('returns the 5-tab scoped set for region scope', () => {
    expect(scopeTabs({ kind: 'region', regionId: 'r1' })).toEqual(['config', 'signals', 'analysis', 'events', 'cost'])
  })

  it('returns the 5-tab scoped set for az scope', () => {
    expect(scopeTabs({ kind: 'az', regionId: 'r1', azId: 'az1' })).toEqual(['config', 'signals', 'analysis', 'events', 'cost'])
  })

  it('returns the 5-tab scoped set for server scope', () => {
    expect(scopeTabs({ kind: 'server', regionId: 'r1', azId: 'az1', serverId: 's1' }))
      .toEqual(['config', 'signals', 'analysis', 'events', 'cost'])
  })

  // FEAT-009 Task 5: 'signals' is reachable at EVERY scope (unlike world-only 'scenario'), so
  // it must appear in both WORLD_TABS and SCOPED_TABS.
  it('includes signals in both WORLD_TABS and SCOPED_TABS', () => {
    expect(scopeTabs({ kind: 'world' })).toContain('signals')
    expect(scopeTabs({ kind: 'region', regionId: 'r1' })).toContain('signals')
  })

  it('returns a fresh array each call (callers may not mutate the shared constant)', () => {
    const a = scopeTabs({ kind: 'world' })
    const b = scopeTabs({ kind: 'world' })
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })

  it("scopeTabs includes 'compare' at world scope only", () => {
    expect(scopeTabs({ kind: 'world' })).toContain('compare')
    expect(scopeTabs({ kind: 'region', regionId: 'r1' })).not.toContain('compare')
  })
})
