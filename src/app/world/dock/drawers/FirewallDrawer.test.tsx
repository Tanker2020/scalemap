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
})
