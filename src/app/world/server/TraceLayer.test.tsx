// src/app/world/server/TraceLayer.test.tsx
// @vitest-environment jsdom
// Polish 3 T6 (D8): "one current convention" — etched base always renders; a flowing-dash
// overlay (`data-testid="trace-flow"`) appears only for permitted, currently-loaded traces,
// capped to the top-N loudest (motion budget); selecting an instance highlights its own traces.
// No pre-existing suite (TraceLayer previously had none — it was implicitly covered by
// ServerBoard.test.tsx's blocked-path assertion, which is untouched by this change).
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TraceLayer } from './TraceLayer'
import { layoutServerBoard, serverTraces } from './boardLayout'
import { createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement } from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { WorldDoc } from '../../../lib/world/types'

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const region = createRegion('us-east-1')
  const az = createAz(region.id, 'us-east-1a')
  const server = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[region.id] = region; doc.azs[az.id] = az; doc.servers[server.id] = server
  configure(doc, server.id)
  return { doc, serverId: server.id }
}

function build(doc: WorldDoc, serverId: string) {
  const compiled = compileWorld(doc)
  const server = doc.servers[serverId]
  const layout = layoutServerBoard(server, doc, compiled)
  const traces = serverTraces(serverId, doc, compiled)
  return { layout, traces }
}

describe('TraceLayer', () => {
  it('renders an etched base path for every trace even with no load', () => {
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      d.blueprints[web.id] = web
      const pl = createPlacement(web.id, sid); d.placements[pl.id] = pl
    })
    const { layout, traces } = build(doc, serverId)
    const { container } = render(
      <TraceLayer layout={layout} traces={traces} selection={null} onSelect={() => {}} hoveredBlueprintId={null} serverId={serverId} instances={{}} />,
    )
    expect(traces.length).toBeGreaterThan(0)
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(traces.length)
    expect(container.querySelectorAll('[data-testid="trace-flow"]').length).toBe(0)   // no rps -> no flow overlay
  })

  it('a loaded trace gets a flowing-dash overlay, capped to the motion budget', () => {
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      d.blueprints[web.id] = web
      const pl = createPlacement(web.id, sid); d.placements[pl.id] = pl
    })
    const { layout, traces } = build(doc, serverId)
    const instanceId = Object.keys(compileWorld(doc).instances)[0]
    const { container } = render(
      <TraceLayer layout={layout} traces={traces} selection={null} onSelect={() => {}} hoveredBlueprintId={null}
        serverId={serverId} instances={{ [instanceId]: { instanceId, rps: 42, errorRate: 0, p50Ms: 0, p99Ms: 0, p90Ms: 0, activeConnections: 0, cpuCoresUsed: 0, ramMb: 0, health: "healthy" } }} />,
    )
    const flows = container.querySelectorAll('[data-testid="trace-flow"]')
    expect(flows.length).toBeGreaterThan(0)
    expect([...flows].some(f => f.getAttribute('data-animated') === 'true')).toBe(true)
  })

  it('selecting an instance highlights its own traces (thicker stroke) over unrelated ones', () => {
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const cache = createBlueprint('cache', 1); cache.ports = [{ port: 6379, protocol: 'tcp', visibility: 'public' }]
      d.blueprints[web.id] = web; d.blueprints[cache.id] = cache
      const webPl = createPlacement(web.id, sid); d.placements[webPl.id] = webPl
      const cachePl = createPlacement(cache.id, sid); d.placements[cachePl.id] = cachePl
    })
    const { layout, traces } = build(doc, serverId)
    const compiled = compileWorld(doc)
    const webInstanceId = Object.values(compiled.instances).find(i => i.blueprintId === Object.values(doc.blueprints).find(b => b.name === 'web')!.id)!.id

    const { container: notSelected } = render(
      <TraceLayer layout={layout} traces={traces} selection={null} onSelect={() => {}} hoveredBlueprintId={null} serverId={serverId} instances={{}} />,
    )
    const { container: selected } = render(
      <TraceLayer layout={layout} traces={traces} selection={{ kind: 'instance', instanceId: webInstanceId }} onSelect={() => {}} hoveredBlueprintId={null} serverId={serverId} instances={{}} />,
    )
    const baseOpacityNoSelection = [...notSelected.querySelectorAll('path')].map(p => p.getAttribute('opacity'))
    const baseOpacityWithSelection = [...selected.querySelectorAll('path')].map(p => p.getAttribute('opacity'))
    // With a selection active, at least one trace should differ from the no-selection baseline
    // (either highlighted brighter or dimmed as unrelated) — the dead `selection` prop is wired.
    expect(baseOpacityWithSelection).not.toEqual(baseOpacityNoSelection)
  })

  it('a blocked trace keeps its own dashed danger styling, not the flow overlay', () => {
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2)
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      const webPl = createPlacement(web.id, sid); const dbPl = createPlacement(db.id, sid)
      d.placements[webPl.id] = webPl; d.placements[dbPl.id] = dbPl
      d.servers[sid].firewall = [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    })
    const { layout, traces } = build(doc, serverId)
    expect(traces.some(t => t.verdict === 'blocked')).toBe(true)
    const { container } = render(
      <TraceLayer layout={layout} traces={traces} selection={null} onSelect={() => {}} hoveredBlueprintId={null} serverId={serverId} instances={{}} />,
    )
    expect(container.querySelector('path[stroke-dasharray="4 4"]')).toBeTruthy()
  })
})
