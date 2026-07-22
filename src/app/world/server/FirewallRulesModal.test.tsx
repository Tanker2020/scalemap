// src/app/world/server/FirewallRulesModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { FirewallRulesModal } from './FirewallRulesModal'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useNavStore } from '../../store/nav.store'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
} from '../../../lib/world/factories'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { compileWorld } from '../../../lib/world/compileWorld'
import type { WorldDoc } from '../../../lib/world/types'

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

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.setState({ running: false })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

describe('FirewallRulesModal', () => {
  it('renders nothing when closed or serverId is null', () => {
    const { serverId } = seed(() => {})
    const { container: c1 } = render(<FirewallRulesModal open={false} serverId={serverId} onClose={() => {}} />)
    expect(c1).toBeEmptyDOMElement()
    const { container: c2 } = render(<FirewallRulesModal open={true} serverId={null} onClose={() => {}} />)
    expect(c2).toBeEmptyDOMElement()
  })

  // Mirrors WorldShell's real bubble-phase Escape handler verbatim (ManagedServiceModal.test.tsx's
  // own proof technique). Starts at 'region' (not 'globe' — up() is a no-op at the top level,
  // which would make "level unchanged" pass trivially regardless of which phase wins) so a real
  // regression (bubble instead of capture) is caught: up() from 'region' actually mutates to
  // 'globe' if the handler fires.
  it('capture-phase Escape closes without changing nav level, beating WorldShell-style bubble handler', () => {
    const { serverId } = seed(() => {})
    useNavStore.setState({ level: 'region', regionId: 'r1', azId: null, serverId: null })
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    let closed = false
    try {
      render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => { closed = true }} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(closed).toBe(true)
      expect(useNavStore.getState().level).toBe('region')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('backdrop click closes; a click on the surface itself does not', () => {
    const { serverId, doc } = seed((d, sid) => { d.servers[sid].firewall = [] })
    let closed = false
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => { closed = true }} />)
    const label = `${doc.servers[serverId].label} · 0 rules`
    fireEvent.click(screen.getByText(label))
    expect(closed).toBe(false)
    // The backdrop is the outer fixed-position div rendered by createPortal; the surface's parent.
    const surface = screen.getByText(label).closest('div')!.parentElement!
    const backdrop = surface.parentElement!
    fireEvent.click(backdrop)
    expect(closed).toBe(true)
  })

  it('edit lock: every table control is disabled while running, close stays enabled', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
      ]
    })
    useSimulationStore.setState({ running: true })
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)

    expect(screen.getByLabelText('action for rule 1')).toBeDisabled()
    expect(screen.getByLabelText('port for rule 1')).toBeDisabled()
    expect(screen.getByLabelText('protocol for rule 1')).toBeDisabled()
    // The source control is a Segmented (role="group" div) — a plain div can't itself carry the
    // `disabled` attribute, but native fieldset-disable cascades onto every real <button>/<input>
    // descendant regardless of intervening div nesting, so assert on those directly.
    for (const optionBtn of within(screen.getByLabelText('source for rule 1')).getAllByRole('button')) {
      expect(optionBtn).toBeDisabled()
    }
    expect(screen.getAllByLabelText('move rule up')[0]).toBeDisabled()
    expect(screen.getAllByLabelText('move rule down')[0]).toBeDisabled()
    expect(screen.getAllByLabelText('remove rule')[0]).toBeDisabled()
    expect(screen.getByLabelText('add rule')).toBeDisabled()

    expect(screen.getByText('close')).not.toBeDisabled()
  })

  it('add rule appends the exact default shape immediately, no Save step', () => {
    const { serverId } = seed((d, sid) => { d.servers[sid].firewall = [] })
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)
    expect(useWorldStore.getState().doc.servers[serverId].firewall).toHaveLength(0)

    fireEvent.click(screen.getByLabelText('add rule'))

    const rules = useWorldStore.getState().doc.servers[serverId].firewall
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ action: 'allow', port: 'any', protocol: 'tcp', source: 'any' })
    expect(typeof rules[0].id).toBe('string')
  })

  it('editing action/port/protocol commits immediately per field', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [{ id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' }]
    })
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)

    fireEvent.change(screen.getByLabelText('action for rule 1'), { target: { value: 'deny' } })
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].action).toBe('deny')

    fireEvent.change(screen.getByLabelText('port for rule 1'), { target: { value: '8080' } })
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].port).toBe(8080)

    fireEvent.change(screen.getByLabelText('port for rule 1'), { target: { value: 'any' } })
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].port).toBe('any')

    fireEvent.change(screen.getByLabelText('protocol for rule 1'), { target: { value: 'udp' } })
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].protocol).toBe('udp')
  })

  // Ported from InspectorRail.test.tsx's 'firewall reorder swaps array order'.
  it('reorder swaps exact array order', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)
    fireEvent.click(screen.getAllByLabelText('move rule down')[0])
    const rules = useWorldStore.getState().doc.servers[serverId].firewall
    expect(rules.map(r => r.id)).toEqual(['r2', 'r1'])
  })

  it('remove shrinks the array by exactly one, removing the correct rule', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' },
        { id: 'r3', action: 'allow', port: 80, protocol: 'tcp', source: 'any' },
      ]
    })
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)
    fireEvent.click(screen.getAllByLabelText('remove rule')[1])
    const rules = useWorldStore.getState().doc.servers[serverId].firewall
    expect(rules.map(r => r.id)).toEqual(['r1', 'r3'])
  })

  // Ported from InspectorRail.test.tsx's 'adding an allow rule above the deny unblocks the
  // compiled path' — proves the modal's writes are real compileWorld-visible mutations, not just
  // local component state.
  it('adding an allow rule above the deny unblocks the compiled path', () => {
    const { doc, serverId } = seed((d, sid) => {
      const web = createBlueprint('web', 0); web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'public' }]
      const db = createBlueprint('db', 2); db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
      web.dependencies = [{ id: 'd', target: { kind: 'blueprint', blueprintId: db.id }, port: 5432, protocol: 'db', packetTemplateId: null }]
      d.blueprints[web.id] = web; d.blueprints[db.id] = db
      const webServer = createServer(d.servers[sid].azId, getPreset('vps-medium')!)
      d.servers[webServer.id] = webServer
      const webPl = createPlacement(web.id, webServer.id); d.placements[webPl.id] = webPl
      const dbPl = createPlacement(db.id, sid); d.placements[dbPl.id] = dbPl
      d.servers[sid].firewall = [{ id: 'deny', action: 'deny', port: 5432, protocol: 'tcp', source: 'any' }]
    })
    expect(compileWorld(doc).paths.some(p => p.verdict === 'blocked')).toBe(true)

    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('add rule'))
    // Seed had exactly one rule (the deny), so after add the new rule lands at index 1 — one
    // "move up" swaps it above the deny to index 0.
    fireEvent.click(screen.getAllByLabelText('move rule up')[1])
    fireEvent.change(screen.getByLabelText('action for rule 1'), { target: { value: 'allow' } })
    fireEvent.change(screen.getByLabelText('port for rule 1'), { target: { value: '5432' } })

    expect(compileWorld(useWorldStore.getState().doc).paths.some(p => p.verdict === 'blocked')).toBe(false)
  })

  it('source field: any/internal commit immediately; custom reveals CIDR input without committing until non-empty; re-rendering an existing CIDR rule shows custom pre-selected with the value visible', () => {
    const { serverId } = seed((d, sid) => {
      d.servers[sid].firewall = [
        { id: 'r1', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
        { id: 'r2', action: 'allow', port: 80, protocol: 'tcp', source: '10.0.0.0/8' },
      ]
    })
    render(<FirewallRulesModal open={true} serverId={serverId} onClose={() => {}} />)

    // Rule 1: any -> internal commits immediately, no CIDR input appears.
    fireEvent.click(within(screen.getByLabelText('source for rule 1')).getByText('internal'))
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].source).toBe('internal')
    expect(screen.queryByLabelText('source cidr for rule 1')).toBeNull()

    // Rule 1: selecting custom reveals the CIDR input WITHOUT committing yet.
    fireEvent.click(within(screen.getByLabelText('source for rule 1')).getByText('custom'))
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].source).toBe('internal')
    const cidrInput = screen.getByLabelText('source cidr for rule 1')
    expect(cidrInput).toHaveValue('')

    // Typing commits on every keystroke.
    fireEvent.change(cidrInput, { target: { value: '1' } })
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].source).toBe('1')
    fireEvent.change(cidrInput, { target: { value: '192.168.0.0/16' } })
    expect(useWorldStore.getState().doc.servers[serverId].firewall[0].source).toBe('192.168.0.0/16')

    // Rule 2 already has a CIDR source — re-rendering shows custom pre-selected with the value visible.
    const source2 = screen.getByLabelText('source for rule 2')
    expect(within(source2).getByText('custom')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('source cidr for rule 2')).toHaveValue('10.0.0.0/8')
  })
})
