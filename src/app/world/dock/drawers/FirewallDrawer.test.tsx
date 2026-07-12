// @vitest-environment jsdom
// Polish 4 T4 (spec D6): FIREWALL drawer — sentence grammar reuse, + rule append, edit-lock.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FirewallDrawer, firewallPv } from './FirewallDrawer'
import { useWorldStore } from '../../../store/world.store'
import { getPreset } from '../../../../lib/world/instanceCatalog'
import type { Server } from '../../../../lib/world/types'

beforeEach(() => { useWorldStore.getState().newWorld() })

function seedServer(): string {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return useWorldStore.getState().addServer(azId, getPreset('vps-medium')!)
}
function currentServer(id: string): Server { return useWorldStore.getState().doc.servers[id] }

describe('firewallPv', () => {
  it('formats "<allow> allow · <deny> deny"', () => {
    const s = {
      firewall: [
        { id: '1', action: 'allow', port: 'any', protocol: 'any', source: 'internal' },
        { id: '2', action: 'deny', port: 'any', protocol: 'any', source: 'any' },
        { id: '3', action: 'allow', port: 443, protocol: 'tcp', source: 'any' },
      ],
    } as Server
    expect(firewallPv(s)).toBe('2 allow · 1 deny')
  })

  it('a fresh server (one default allow rule) reads "1 allow · 0 deny"', () => {
    const serverId = seedServer()
    expect(firewallPv(currentServer(serverId))).toBe('1 allow · 0 deny')
  })

  // Polish 4 T5 (spec D7): watching posture re-voices the pv to "≈N req/s allowed" — a RATIFIED
  // documented deviation from the mock's "418 allowed/s · 0 blocked" (no per-rule/blocked
  // counter exists in the frozen metrics contract; task-5-brief.md).
  it('re-voices to "≈N req/s allowed" when a live rps reading is supplied, even at 0', () => {
    const serverId = seedServer()
    expect(firewallPv(currentServer(serverId), 418)).toBe('≈418 req/s allowed')
    expect(firewallPv(currentServer(serverId), 0)).toBe('≈0 req/s allowed')
    expect(firewallPv(currentServer(serverId), 1)).toBe('≈1 req/s allowed')
  })
})

describe('FirewallDrawer', () => {
  it('renders one numbered sentence per rule, using the shared grammar (Let/Block colored)', () => {
    const serverId = seedServer()
    render(<FirewallDrawer server={currentServer(serverId)} running={false} />)
    const rows = screen.getAllByTestId('firewall-drawer-sentence')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('1 ·')
    expect(rows[0]).toHaveTextContent('Let')
    expect(rows[0]).toHaveTextContent('internal traffic')
  })

  it('"+ rule" appends createServer\'s default rule shape via updateServer', () => {
    const serverId = seedServer()
    render(<FirewallDrawer server={currentServer(serverId)} running={false} />)
    fireEvent.click(screen.getByTestId('firewall-add-rule'))
    const rules = currentServer(serverId).firewall
    expect(rules).toHaveLength(2)
    expect(rules[1]).toMatchObject({ action: 'allow', port: 'any', protocol: 'any', source: 'internal' })
  })

  it('"+ rule" is edit-locked while running', () => {
    const serverId = seedServer()
    render(<FirewallDrawer server={currentServer(serverId)} running />)
    const btn = screen.getByTestId('firewall-add-rule')
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'stop the simulation to edit')
  })

  it('shows the muted "edit rules on the board" hint', () => {
    const serverId = seedServer()
    render(<FirewallDrawer server={currentServer(serverId)} running={false} />)
    expect(screen.getByText('edit rules on the board')).toBeTruthy()
  })

  // T8 light-theme audit fix: the source/port id spans previously hardcoded InspectorRail's
  // dark-scene-only `#DBEAFE`, which reads as near-invisible light-on-light text once this
  // drawer's own `var(--color-canvas)` background flips to near-white in light theme. Locks the
  // token swap so it can't regress back to a literal hex.
  it('sentence id spans (source/port phrases) use the theme-aware --kit-accent token, not a hardcoded hex', () => {
    const serverId = seedServer()
    render(<FirewallDrawer server={currentServer(serverId)} running={false} />)
    const row = screen.getByTestId('firewall-drawer-sentence')
    const idSpans = Array.from(row.querySelectorAll('b')).filter(b => b.textContent !== 'Let' && b.textContent !== 'Block')
    expect(idSpans.length).toBeGreaterThan(0)
    for (const span of idSpans) {
      expect((span as HTMLElement).style.color).toBe('var(--kit-accent)')
    }
  })
})
