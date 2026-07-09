// src/app/world/server/InspectorRail.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InspectorRail } from './InspectorRail'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { instanceId, compileWorld } from '../../../lib/world/compileWorld'
import type { WorldDoc } from '../../../lib/world/types'
import { WorkloadForm, FirewallEditor } from './inspectorForms'

function seed(configure: (doc: WorldDoc, serverId: string) => void) {
  const doc = createWorld()
  const r = createRegion('us-east-1'); const az = createAz(r.id, 'us-east-1a')
  const s = createServer(az.id, getPreset('vps-medium')!)
  doc.regions[r.id] = r; doc.azs[az.id] = az; doc.servers[s.id] = s
  configure(doc, s.id)
  useWorldStore.setState({ doc, history: [], future: [] })
  useSimulationStore.setState({ running: false, latestBatch: null, scrubBatch: null })
  return { doc, serverId: s.id }
}

describe('InspectorRail (read panels)', () => {
  beforeEach(() => useWorldStore.getState().newWorld())

  it('instance selection shows runtime, limits, and host resources', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [{ name: 'n', cidr: '172.18.0.0/16' }], volumes: [] }]
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      const pl = createPlacement(bp.id, sid)
      pl.runtime = { type: 'container', stackName: 'app', networkNames: ['n'], portMappings: [{ host: 3000, container: 8080 }], cpuLimit: 2, memLimitMb: 640 }
      // Keyed by the placement's own generated id (not an arbitrary literal): compileWorld builds
      // instance ids from `pl.id` (the object's field), not the doc.placements record key, so a
      // mismatched dict key here would leave `compiled.instances` without the id this test expects
      // to select (see ServerBoard.test.tsx:89-93 for the same pitfall documented previously).
      d.placements[pl.id] = pl
    })
    const doc = useWorldStore.getState().doc
    const pl = Object.values(doc.placements)[0]
    const iid = instanceId(pl.id, 0)
    render(<InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iid }} onSelect={() => {}} />)
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText(/stack: app/)).toBeInTheDocument()
    expect(screen.getByText(/640/)).toBeInTheDocument()          // mem limit
  })

  it('firewall selection lists rules in order and drills into a rule', () => {
    const onSelect = vi.fn()
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={onSelect} />)
    expect(screen.getByText(/first match wins/i)).toBeInTheDocument()
    const rows = screen.getAllByTestId('fw-rule-row')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[1])
    expect(onSelect).toHaveBeenCalledWith({ kind: 'rule', ruleId: 'r2' })
  })

  it('volume panel lists consumers by volumeName', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{ name: 'app', networks: [], volumes: [{ name: 'pgdata', sizeGb: 12 }] }]
      const pg = createBlueprint('postgres', 2); pg.stateful = true; pg.volumeName = 'pgdata'
      d.blueprints[pg.id] = pg
      const pl = createPlacement(pg.id, sid)
      d.placements[pl.id] = pl
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'volume', stackName: 'app', volumeName: 'pgdata' }} onSelect={() => {}} />)
    expect(screen.getByText(/postgres/)).toBeInTheDocument()
  })

  it('empty selection shows a hint', () => {
    const { serverId } = seed(() => {})
    render(<InspectorRail serverId={serverId} selection={null} onSelect={() => {}} />)
    expect(screen.getByText(/click any element/i)).toBeInTheDocument()
  })
})

describe('inspector editing forms', () => {
  // vi.spyOn on an already-spied store method returns the SAME mock (Vitest doesn't re-wrap), so
  // without clearing, each test's spy would inherit the previous test's call history — e.g. the
  // "invalid numeric input" test would see the prior test's committed patch and wrongly fail.
  // vi.restoreAllMocks() doesn't help here: it un-spies the *object reference captured at spy
  // creation time*, but Zustand's `set()` copies the (already-spied) action reference forward
  // into every new merged state object on each `mutate()`/`setState()` call, so the live store's
  // action reference is never the stale object restoreAllMocks() patches. vi.clearAllMocks()
  // clears the mock's call history directly (by mock instance, not by object path), which works
  // regardless of which object currently holds the reference.
  afterEach(() => vi.clearAllMocks())

  it('workload form patches blueprint via updateBlueprint', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateBlueprint')
    const { doc } = seed((d, sid) => {
      const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp
      d.placements['p'] = createPlacement(bp.id, sid)
    })
    const bpId = Object.keys(doc.blueprints)[0]
    render(<WorkloadForm blueprintId={bpId} />)
    const input = screen.getByLabelText('cpuMsPerRequest')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.blur(input)
    expect(spy).toHaveBeenCalledWith(bpId, expect.objectContaining({ workload: expect.objectContaining({ cpuMsPerRequest: 12 }) }))
  })

  it('firewall reorder swaps array order', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateServer')
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<FirewallEditor serverId={serverId} />)
    fireEvent.click(screen.getAllByLabelText('move rule down')[0])
    expect(spy).toHaveBeenCalledWith(serverId, { firewall: [
      expect.objectContaining({ id: 'r2' }), expect.objectContaining({ id: 'r1' }),
    ] })
  })

  it('adding an allow rule above the deny unblocks the compiled path', () => {
    // recompiled-fixture assertion (not DOM): allow :5432 above deny → path permitted
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      // db must actually bind :5432 — createBlueprint()'s default port is :8080, and
      // evaluateInstancePath checks port-binding before it ever consults the firewall, so
      // leaving the default would leave the path permanently 'no-port-binding'-blocked
      // regardless of any firewall rule, defeating the story this test is asserting.
      const db = createBlueprint('db', 2); db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      // db sits on the seeded server (sid) — its firewall is what this test edits via
      // updateServer(serverId, ...) below. web sits on a second server in the same AZ so the
      // hop between them isn't 'localhost': evaluateInstancePath returns `permitted` for a
      // same-server process hop unconditionally, bypassing the firewall entirely by design
      // (loopback traffic isn't network-filtered) — same-server placement here would make the
      // firewall rule inert and this test couldn't exercise the unblock story at all.
      const webServer = createServer(d.servers[sid].azId, getPreset('vps-medium')!)
      d.servers[webServer.id] = webServer
      // Keyed by the placement's own generated id, not an arbitrary literal — compileWorld's
      // path loop looks up `doc.placements[instance.placementId]` by that id (see the identical
      // pitfall documented above in this file and in ServerBoard.test.tsx); a literal key like
      // 'p1'/'p2' would make that lookup miss, silently dropping every path for this instance.
      const webPl = createPlacement(web.id, webServer.id); d.placements[webPl.id] = webPl
      const dbPl = createPlacement(db.id, sid); d.placements[dbPl.id] = dbPl
      d.servers[sid].firewall = [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    })
    expect(compileWorld(doc).paths.some(p => p.verdict === 'blocked')).toBe(true)
    useWorldStore.getState().updateServer(serverId, { firewall: [
      { id: 'allow', action: 'allow', port: 5432, protocol: 'tcp', source: 'any' },
      { id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
    ] })
    expect(compileWorld(useWorldStore.getState().doc).paths.some(p => p.verdict === 'blocked')).toBe(false)
  })

  it('invalid numeric input does not fire an update', () => {
    const spy = vi.spyOn(useWorldStore.getState(), 'updateBlueprint')
    const { doc } = seed((d, sid) => { const bp = createBlueprint('api', 1); d.blueprints[bp.id] = bp; d.placements['p'] = createPlacement(bp.id, sid) })
    render(<WorkloadForm blueprintId={Object.keys(doc.blueprints)[0]} />)
    const input = screen.getByLabelText('ramBaseMb')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect(spy).not.toHaveBeenCalled()
  })

  it('all forms disabled while running', () => {
    // seed() itself resets `running: false` as part of its simulation.store setup, so it must
    // run before this test flips `running: true` — otherwise seed() clobbers it back to false.
    const { serverId } = seed(() => {})
    useSimulationStore.setState({ running: true })
    render(<FirewallEditor serverId={serverId} />)
    expect(screen.getByLabelText('add rule')).toBeDisabled()
  })
})
