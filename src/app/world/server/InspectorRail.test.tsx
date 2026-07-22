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
import { WorkloadForm, VolumesEditor } from './inspectorForms'

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
    render(<InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iid }} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
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
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={onSelect} onOpenFirewallRules={() => {}} />)
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
    render(<InspectorRail serverId={serverId} selection={{ kind: 'volume', stackName: 'app', volumeName: 'pgdata' }} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
    expect(screen.getByText(/postgres/)).toBeInTheDocument()
  })

  it('empty selection shows a hint', () => {
    const { serverId } = seed(() => {})
    render(<InspectorRail serverId={serverId} selection={null} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
    expect(screen.getByText(/click any element/i)).toBeInTheDocument()
  })

  it('firewall stack renders order numbers and flow captions', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
    expect(screen.getByText(/evaluated top-down · first match wins/)).toBeInTheDocument()
    expect(screen.getByText(/everything else: DENIED/)).toBeInTheDocument()
    const rows = screen.getAllByTestId('fw-rule-row')
    expect(rows[0]).toHaveTextContent('1')
    expect(rows[0]).toHaveTextContent('Let')
    expect(rows[1]).toHaveTextContent('2')
    expect(rows[1]).toHaveTextContent('Block')
    expect(rows[1]).toHaveTextContent('anyone')
  })

  it('a server with zero firewall rules still offers the "edit rules…" opener', () => {
    // firewall-rules-modal Task 2: rule-adding no longer needs an empty-list special case —
    // the opener button is unconditional, so it's reachable from zero rules exactly like from
    // any other rule count.
    const { serverId } = seed((d, sid) => { d.servers[sid].firewall = [] })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
    expect(screen.getByTestId('firewall-open-rules-modal')).toBeInTheDocument()
  })

  it('the "edit rules…" button calls onOpenFirewallRules and never touches the store directly', () => {
    const onOpenFirewallRules = vi.fn()
    const spy = vi.spyOn(useWorldStore.getState(), 'updateServer')
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<InspectorRail serverId={serverId} selection={{ kind: 'firewall' }} onSelect={() => {}} onOpenFirewallRules={onOpenFirewallRules} />)
    fireEvent.click(screen.getByTestId('firewall-open-rules-modal'))
    expect(onOpenFirewallRules).toHaveBeenCalledTimes(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('inspector strip expands when a rule is selected (outer shell only — no editing form mounts here anymore)', () => {
    // T6 (D8) re-housed ONLY the outer shell (position/sizing) — collapsed when nothing is
    // selected, `data-expanded` flips true and the SAME header()/body branches (byte-identical,
    // untouched above) render underneath once something is selected. The FirewallEditor-specific
    // dispatch assertion this test used to carry moved to FirewallRulesModal.test.tsx
    // (firewall-rules-modal Task 1/2) along with the editor itself.
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    const { rerender, container } = render(<InspectorRail serverId={serverId} selection={null} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
    const strip = container.querySelector('[data-inspector-rail]')!
    expect(strip).toHaveAttribute('data-expanded', 'false')
    expect(screen.getByText(/click any element/i)).toBeInTheDocument()

    rerender(<InspectorRail serverId={serverId} selection={{ kind: 'rule', ruleId: 'r1' }} onSelect={() => {}} onOpenFirewallRules={() => {}} />)
    expect(strip).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByText('Let')).toBeInTheDocument()               // sentence read view unchanged
    expect(screen.getByTestId('firewall-open-rules-modal')).toBeInTheDocument()
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

  // 'firewall reorder swaps array order' (formerly rendered the deleted inline FirewallEditor
  // directly) moved to FirewallRulesModal.test.tsx ("reorder swaps exact array order",
  // firewall-rules-modal Task 1) along with the editor component itself.

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

  // 'all forms disabled while running' (formerly rendered the deleted inline FirewallEditor
  // directly and asserted its "add rule" edit-lock) moved to FirewallRulesModal.test.tsx
  // ("edit lock: every table control is disabled while running, close stays enabled",
  // firewall-rules-modal Task 1).

  it('switching the inspected instance remounts WorkloadForm and reseeds the NumberField from stale text', () => {
    // Regression for the NumberField staleness bug: it seeds its text via useState(String(value))
    // only on mount and never resyncs when `value` changes on prop update. Without a key tied to
    // the entity id at the InspectorRail mount site, selecting instance A then instance B (both
    // selection.kind === 'instance', no intermediate null render) would reuse the same WorkloadForm
    // instance and keep showing A's stale value instead of B's.
    const { serverId } = seed((d, sid) => {
      const bpA = createBlueprint('svc-a', 0); bpA.workload.cpuMsPerRequest = 5
      const bpB = createBlueprint('svc-b', 1); bpB.workload.cpuMsPerRequest = 12
      d.blueprints[bpA.id] = bpA; d.blueprints[bpB.id] = bpB
      const plA = createPlacement(bpA.id, sid); d.placements[plA.id] = plA
      const plB = createPlacement(bpB.id, sid); d.placements[plB.id] = plB
    })
    const doc = useWorldStore.getState().doc
    const [plA, plB] = Object.values(doc.placements)
    const iidA = instanceId(plA.id, 0)
    const iidB = instanceId(plB.id, 0)

    const { rerender } = render(
      <InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iidA }} onSelect={() => {}} onOpenFirewallRules={() => {}} />
    )
    expect(screen.getByLabelText('cpuMsPerRequest')).toHaveValue('5')

    rerender(
      <InspectorRail serverId={serverId} selection={{ kind: 'instance', instanceId: iidB }} onSelect={() => {}} onOpenFirewallRules={() => {}} />
    )
    expect(screen.getByLabelText('cpuMsPerRequest')).toHaveValue('12')
  })

  it('adding a volume after removing one does not create a duplicate name', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].stacks = [{
        name: 'app',
        networks: [],
        volumes: [{ name: 'vol-1', sizeGb: 5 }, { name: 'vol-2', sizeGb: 5 }, { name: 'vol-3', sizeGb: 5 }],
      }]
    })
    render(<VolumesEditor serverId={serverId} stackName="app" />)

    fireEvent.click(screen.getByLabelText('remove volume vol-2'))
    fireEvent.click(screen.getByLabelText('add volume'))

    const stack = useWorldStore.getState().doc.servers[serverId].stacks.find(s => s.name === 'app')!
    const names = stack.volumes.map(v => v.name)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3) // no duplicates
    expect(names).toEqual(['vol-1', 'vol-3', 'vol-2']) // vol-2 is the smallest unused suffix
  })
})
