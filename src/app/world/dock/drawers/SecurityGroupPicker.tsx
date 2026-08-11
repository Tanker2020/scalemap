// src/app/world/dock/drawers/SecurityGroupPicker.tsx
// Task 13 (network-topology): replaces FirewallDrawer's per-server rule list for a NETWORKED
// server (server.subnetId set) — instead of per-rule sentences, a networked server's inbound
// posture is governed by the security groups attached to it, scoped to its subnet's VPC. An
// un-networked server (subnetId absent) keeps the legacy flat-firewall FirewallDrawer untouched
// (see FirewallDrawer.tsx's branch).
//
// Toggling a group patches `server.securityGroupIds` via the real per-server patch action,
// `updateServer(id, patch)` (world.store.ts) — confirmed by reading FirewallDrawer.tsx/
// ServerFaceplate.tsx's existing usage, NOT the brief's placeholder name (which happened to be
// correct here, but was verified rather than assumed).
//
// Cascade-delete note (Task 4): removeSecurityGroup already strips a removed group's id out of
// every server's securityGroupIds, so doc.securityGroups and server.securityGroupIds are always
// consistent by the time this renders — no dangling-reference handling needed here.
import { type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import type { Server } from '../../../../lib/world/types'

export interface SecurityGroupPickerProps {
  server: Server
}

export function SecurityGroupPicker({ server }: SecurityGroupPickerProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const updateServer = useWorldStore(s => s.updateServer)

  const subnet = server.subnetId ? doc.subnets[server.subnetId] : null
  if (!subnet) return null

  const groups = Object.values(doc.securityGroups).filter(g => g.vpcId === subnet.vpcId)
  const selected = new Set(server.securityGroupIds ?? [])

  const toggle = (groupId: string) => {
    const next = new Set(selected)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    updateServer(server.id, { securityGroupIds: Array.from(next) })
  }

  return (
    <div data-testid="security-group-picker">
      {groups.length === 0 && (
        <p style={{ color: 'var(--color-text-muted)', fontSize: 10, margin: '4px 0' }}>
          No security groups in this VPC.
        </p>
      )}
      {groups.map(g => (
        <label
          key={g.id}
          data-testid={`sg-picker-row-${g.id}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            color: 'var(--color-text-secondary)', background: 'var(--color-canvas)',
            borderLeft: '2px solid var(--kit-accent-dim)', borderRadius: 5, padding: '6px 9px',
            margin: '4px 0', lineHeight: 1.6, fontSize: 10, cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={selected.has(g.id)}
            onChange={() => toggle(g.id)}
          />
          <b style={{ color: 'var(--kit-accent)' }}>{g.label}</b>
          <span style={{ color: 'var(--color-text-muted)' }}>
            ({g.rules.length} rule{g.rules.length === 1 ? '' : 's'})
          </span>
        </label>
      ))}
    </div>
  )
}
