// src/app/world/panels/NetworkPanel.tsx
// VPC/subnet/route-table/NAT/IGW/security-group authoring — world scope.
//
// Mirrors BlueprintsPanel.tsx's card-list structure (SectionHeader + Explainer + bordered cards,
// not ManagedPanel's flat EdgeRow list) because this panel needs a real list -> detail drill-down
// (VPC -> its subnets/gateways/security groups), which BlueprintsPanel's card shape supports and
// ManagedPanel's single-level row list does not. A selected VPC's card expands in place to show
// its subnets, NAT/internet gateways, and security groups; deselecting collapses it back to a
// one-line summary, exactly like clicking a second time toggles selection off.
//
// Network entities are always region-scoped at the VPC root (Vpc.regionId) — every subnet/route
// table/gateway/security-group hangs off a vpcId, never directly off a region. "Add VPC" resolves
// a region the same way ManagedServiceModal's scope picker would: prefer nav.store's current
// region focus (so opening this tab while parked on a region authors into THAT region), else fall
// back to the world's first region (world-scope-with-nothing-selected case). If there is no region
// at all yet, the add affordance disables with an explanatory title, matching BlueprintsPanel's
// "no services yet — open a server and add one" / ManagedPanel's "add a region or AZ first"
// empty-state convention.
import { useState, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import type { RouteTable, Subnet, Vpc, WorldDoc } from '../../../lib/world/types'
import { SectionHeader, Explainer } from '../ui/kit'
import { sectionLabel, smallBtn, dangerBtn, row, field } from './panelStyles'

const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const card: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 8, padding: 10, marginTop: 8,
}
const badge = (kind: 'public' | 'private'): CSSProperties => ({
  fontSize: 9, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
  border: `1px solid ${kind === 'public' ? 'var(--color-accent)' : 'var(--color-node-border)'}`,
  color: kind === 'public' ? 'var(--color-accent)' : 'var(--color-text-muted)',
})
const muted: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)' }

function routeTableSummary(rt: RouteTable | undefined): string {
  if (!rt || rt.routes.length === 0) return '0 routes'
  const def = rt.routes.find(r => r.destinationCidr === '0.0.0.0/0') ?? rt.routes[0]
  const targetLabel = def.target.kind === 'local' ? 'local'
    : def.target.kind === 'internetGateway' ? 'internet gateway' : 'NAT gateway'
  return `${rt.routes.length} route${rt.routes.length === 1 ? '' : 's'}, default via ${targetLabel}`
}

export function NetworkPanel() {
  const doc = useWorldStore(s => s.doc)
  const addVpc = useWorldStore(s => s.addVpc)
  const removeVpc = useWorldStore(s => s.removeVpc)
  const navRegionId = useNavStore(s => s.regionId)
  const [selectedVpcId, setSelectedVpcId] = useState<string | null>(null)

  const regions = Object.values(doc.regions)
  const activeRegionId = (navRegionId && doc.regions[navRegionId] ? navRegionId : null) ?? regions[0]?.id ?? null
  const vpcs = Object.values(doc.vpcs)

  return (
    <div>
      <SectionHeader label="▸ VPCs" />
      <Explainer>
        Virtual networks — each VPC belongs to one region and holds its own subnets, route tables,
        and gateways. Select a VPC below to author its subnets and security groups.
      </Explainer>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          type="button" className="kit-press" style={activeRegionId ? actionBtn : { ...actionBtn, opacity: 0.35, cursor: 'default' }}
          disabled={!activeRegionId}
          title={activeRegionId ? undefined : 'add a region first'}
          onClick={() => activeRegionId && addVpc(activeRegionId)}
        >
          + add vpc
        </button>
      </div>
      {vpcs.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', marginTop: 10 }}>
          no VPCs yet{regions.length === 0 ? ' — add a region first' : ''}
        </div>
      )}
      {vpcs.map(vpc => (
        <VpcCard
          key={vpc.id}
          vpc={vpc}
          doc={doc}
          selected={selectedVpcId === vpc.id}
          onToggle={() => setSelectedVpcId(id => (id === vpc.id ? null : vpc.id))}
          onRemove={() => {
            if (selectedVpcId === vpc.id) setSelectedVpcId(null)
            removeVpc(vpc.id)
          }}
        />
      ))}
    </div>
  )
}

function VpcCard({ vpc, doc, selected, onToggle, onRemove }: {
  vpc: Vpc; doc: WorldDoc; selected: boolean; onToggle: () => void; onRemove: () => void
}) {
  const region = doc.regions[vpc.regionId]
  const subnetCount = Object.values(doc.subnets).filter(s => s.vpcId === vpc.id).length
  return (
    <div style={card}>
      <div style={row}>
        <span
          role="button" tabIndex={0} data-testid={`vpc-label-${vpc.id}`}
          style={{ flex: 1, minWidth: 0, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onClick={onToggle}
        >
          {vpc.label}
        </span>
        <span style={muted}>{vpc.cidrBlock}</span>
      </div>
      <div style={{ ...row, marginTop: 4 }}>
        <span style={{ ...muted, flex: 1, minWidth: 0 }}>
          {region ? `region ${region.catalogId}` : 'region'} · {subnetCount} subnet{subnetCount === 1 ? '' : 's'}
        </span>
        <button className="kit-press" style={smallBtn} aria-label={`toggle-vpc-${vpc.id}`} onClick={onToggle}>
          {selected ? 'close' : 'open'}
        </button>
        <button className="kit-press" style={dangerBtn} aria-label={`remove-vpc-${vpc.id}`} onClick={onRemove}>×</button>
      </div>
      {selected && <VpcDetail vpc={vpc} doc={doc} />}
    </div>
  )
}

function VpcDetail({ vpc, doc }: { vpc: Vpc; doc: WorldDoc }) {
  const addSubnet = useWorldStore(s => s.addSubnet)
  const addInternetGateway = useWorldStore(s => s.addInternetGateway)
  const removeInternetGateway = useWorldStore(s => s.removeInternetGateway)
  const addSecurityGroup = useWorldStore(s => s.addSecurityGroup)
  const updateSecurityGroup = useWorldStore(s => s.updateSecurityGroup)
  const removeSecurityGroup = useWorldStore(s => s.removeSecurityGroup)

  const azsInRegion = Object.values(doc.azs).filter(az => az.regionId === vpc.regionId)
  const [azId, setAzId] = useState(azsInRegion[0]?.id ?? '')
  const [kind, setKind] = useState<'public' | 'private'>('private')
  const subnets = Object.values(doc.subnets).filter(s => s.vpcId === vpc.id)
  const igws = Object.values(doc.internetGateways).filter(g => g.vpcId === vpc.id)
  const securityGroups = Object.values(doc.securityGroups).filter(g => g.vpcId === vpc.id)

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--color-node-border)' }}>
      <div style={sectionLabel}>Subnets</div>
      {subnets.length === 0 && <div style={muted}>no subnets yet</div>}
      {subnets.map(subnet => (
        <SubnetRow key={subnet.id} subnet={subnet} doc={doc} />
      ))}
      <div style={{ ...row, marginTop: 6 }}>
        <select
          aria-label="az" style={field} value={azId} disabled={azsInRegion.length === 0}
          onChange={e => setAzId(e.target.value)}
        >
          {azsInRegion.length === 0 && <option value="">no AZs in region</option>}
          {azsInRegion.map(az => <option key={az.id} value={az.id}>{az.label}</option>)}
        </select>
        <select aria-label="subnet kind" style={field} value={kind} onChange={e => setKind(e.target.value as 'public' | 'private')}>
          <option value="private">private</option>
          <option value="public">public</option>
        </select>
        <button
          type="button" className="kit-press" style={azId ? smallBtn : { ...smallBtn, opacity: 0.35, cursor: 'default' }}
          disabled={!azId}
          title={azId ? undefined : 'add an AZ to this region first'}
          onClick={() => azId && addSubnet(vpc.id, azId, kind)}
        >
          + add subnet
        </button>
      </div>

      <div style={sectionLabel}>Internet gateway</div>
      {igws.length === 0 ? (
        <button type="button" className="kit-press" style={actionBtn} onClick={() => addInternetGateway(vpc.id)}>
          + add internet gateway
        </button>
      ) : (
        igws.map(igw => (
          <div key={igw.id} style={row}>
            <span style={{ flex: 1 }}>internet gateway</span>
            <button className="kit-press" style={dangerBtn} aria-label={`remove-igw-${igw.id}`} onClick={() => removeInternetGateway(igw.id)}>×</button>
          </div>
        ))
      )}

      <div style={sectionLabel}>Security groups</div>
      {securityGroups.length === 0 && <div style={muted}>no security groups yet</div>}
      {securityGroups.map(sg => (
        <div key={sg.id} style={row}>
          <input
            aria-label={`sg-label-${sg.id}`} style={{ ...field, flex: 1, marginBottom: 0 }}
            value={sg.label} onChange={e => updateSecurityGroup(sg.id, { label: e.target.value })}
          />
          <span style={muted}>{sg.rules.length} rule{sg.rules.length === 1 ? '' : 's'}</span>
          <button className="kit-press" style={dangerBtn} aria-label={`remove-sg-${sg.id}`} onClick={() => removeSecurityGroup(sg.id)}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" className="kit-press" style={actionBtn} onClick={() => addSecurityGroup(vpc.id)}>
          + add security group
        </button>
      </div>
    </div>
  )
}

function SubnetRow({ subnet, doc }: { subnet: Subnet; doc: WorldDoc }) {
  const addNatGateway = useWorldStore(s => s.addNatGateway)
  const removeNatGateway = useWorldStore(s => s.removeNatGateway)
  const removeSubnet = useWorldStore(s => s.removeSubnet)
  const az = doc.azs[subnet.azId]
  const nat = Object.values(doc.natGateways).find(n => n.subnetId === subnet.id)

  return (
    <div data-testid={`subnet-${subnet.id}`} style={{ ...card, padding: 8, marginTop: 6 }}>
      <div style={row}>
        <span style={badge(subnet.kind)}>{subnet.kind}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {az ? az.label : 'subnet'}
        </span>
        <span style={muted}>{subnet.cidrBlock}</span>
        <button className="kit-press" style={dangerBtn} aria-label={`remove-subnet-${subnet.id}`} onClick={() => removeSubnet(subnet.id)}>×</button>
      </div>
      <div style={{ ...row, marginTop: 4 }}>
        <span style={{ ...muted, flex: 1, minWidth: 0 }}>{routeTableSummary(doc.routeTables[subnet.routeTableId])}</span>
      </div>
      {subnet.kind === 'public' && (
        <div style={{ ...row, marginTop: 4 }}>
          {nat ? (
            <>
              <span style={{ ...muted, flex: 1 }}>NAT gateway: {nat.label}</span>
              <button className="kit-press" style={dangerBtn} aria-label={`remove-nat-${nat.id}`} onClick={() => removeNatGateway(nat.id)}>×</button>
            </>
          ) : (
            <button type="button" className="kit-press" style={smallBtn} onClick={() => addNatGateway(subnet.id)}>
              + add NAT gateway
            </button>
          )}
        </div>
      )}
    </div>
  )
}
