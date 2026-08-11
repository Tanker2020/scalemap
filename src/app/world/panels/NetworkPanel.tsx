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
import { useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import type {
  FirewallSource, RouteTable, RouteTarget, SecurityGroup, SecurityGroupRule, Subnet, Vpc, WorldDoc,
} from '../../../lib/world/types'
import { SectionHeader, Explainer, Segmented } from '../ui/kit'
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

// Gateways a subnet's route table can target — scoped to gateways that live in the SAME VPC
// (an internet gateway is vpcId-scoped directly; a NAT gateway is subnetId-scoped, so its VPC is
// resolved via its own subnet). Shared by the route-add control below.
function gatewayOptionsForVpc(doc: WorldDoc, vpcId: string): { kind: 'internetGateway' | 'natGateway'; id: string; label: string }[] {
  const igws = Object.values(doc.internetGateways)
    .filter(g => g.vpcId === vpcId)
    .map(g => ({ kind: 'internetGateway' as const, id: g.id, label: 'internet gateway' }))
  const nats = Object.values(doc.natGateways)
    .filter(n => doc.subnets[n.subnetId]?.vpcId === vpcId)
    .map(n => ({ kind: 'natGateway' as const, id: n.id, label: `NAT gateway (${n.label})` }))
  return [...igws, ...nats]
}

function routeTargetLabel(doc: WorldDoc, target: RouteTarget): string {
  if (target.kind === 'local') return 'local'
  if (target.kind === 'internetGateway') return 'internet gateway'
  return `NAT gateway (${doc.natGateways[target.id]?.label ?? target.id})`
}

// Route-entry editor for one subnet's route table (final review Critical #1): the model's
// resolveRoute (src/lib/world/network.ts) only asks "does ANY non-local route exist", never
// does real CIDR matching, so a single catch-all '0.0.0.0/0' entry per gateway is the realistic
// and sufficient authoring surface — not a full CIDR form.
function RouteTableEditor({ subnet, doc }: { subnet: Subnet; doc: WorldDoc }): ReactElement {
  const updateRouteTable = useWorldStore(s => s.updateRouteTable)
  const rt = doc.routeTables[subnet.routeTableId]
  const gateways = gatewayOptionsForVpc(doc, subnet.vpcId)
  const [selected, setSelected] = useState('')

  if (!rt) return <></>

  const addRoute = () => {
    const gw = gateways.find(g => `${g.kind}:${g.id}` === selected)
    if (!gw) return
    const entry = { destinationCidr: '0.0.0.0/0', target: { kind: gw.kind, id: gw.id } as RouteTarget }
    updateRouteTable(rt.id, { routes: [...rt.routes, entry] })
  }
  const removeRoute = (index: number) => {
    updateRouteTable(rt.id, { routes: rt.routes.filter((_, i) => i !== index) })
  }

  return (
    <div style={{ marginTop: 4 }}>
      {rt.routes.map((r, i) => (
        <div key={`${r.destinationCidr}-${i}`} style={{ ...row, marginTop: 2 }}>
          <span style={{ ...muted, flex: 1 }}>{r.destinationCidr} → {routeTargetLabel(doc, r.target)}</span>
          <button
            type="button" className="kit-press" style={dangerBtn}
            aria-label={`remove-route-${subnet.id}-${i}`}
            onClick={() => removeRoute(i)}
          >
            ×
          </button>
        </div>
      ))}
      <div style={{ ...row, marginTop: 4 }}>
        <select
          aria-label={`add route target for ${subnet.id}`} style={field} value={selected}
          disabled={gateways.length === 0}
          onChange={e => setSelected(e.target.value)}
        >
          <option value="">{gateways.length === 0 ? 'no gateways in this VPC' : 'select a gateway…'}</option>
          {gateways.map(g => (
            <option key={`${g.kind}:${g.id}`} value={`${g.kind}:${g.id}`}>{g.label}</option>
          ))}
        </select>
        <button
          type="button" className="kit-press"
          style={selected ? smallBtn : { ...smallBtn, opacity: 0.35, cursor: 'default' }}
          disabled={!selected}
          title={gateways.length === 0 ? 'add an internet gateway or NAT gateway to this VPC first' : undefined}
          onClick={addRoute}
        >
          + add route
        </button>
      </div>
    </div>
  )
}

// Rule editor for a SecurityGroup (final review Critical #1). SecurityGroupRule is allow-only
// (port + protocol + source, same FirewallSource type the legacy firewall editor uses) — mirrors
// FirewallRulesModal.tsx's SourceCell any/internal/custom segmented pattern, simplified (no
// action/order — a security group is an unordered allow-only union, per network.ts's
// evaluateSecurityGroups).
function SecurityGroupRuleEditor({ group }: { group: SecurityGroup }): ReactElement {
  const updateSecurityGroup = useWorldStore(s => s.updateSecurityGroup)
  const [port, setPort] = useState('443')
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp')
  const [sourceOption, setSourceOption] = useState<'any' | 'internal' | 'custom'>('any')
  const [customText, setCustomText] = useState<string | null>(null)
  const source: FirewallSource = sourceOption === 'custom' ? (customText ?? '') : sourceOption

  const commit = (rules: SecurityGroupRule[]) => updateSecurityGroup(group.id, { rules })
  const addRule = () => {
    const n = Number(port)
    if (!Number.isFinite(n) || n < 0 || source === '') return
    commit([...group.rules, { port: n, protocol, source }])
  }
  const removeRule = (index: number) => commit(group.rules.filter((_, i) => i !== index))

  return (
    <div style={{ marginTop: 4, paddingLeft: 4 }}>
      {group.rules.map((r, i) => (
        <div key={`${r.port}-${r.protocol}-${r.source}-${i}`} style={{ ...row, marginTop: 2 }}>
          <span style={{ ...muted, flex: 1 }}>
            allow {r.protocol} port {r.port} from {r.source}
          </span>
          <button
            type="button" className="kit-press" style={dangerBtn}
            aria-label={`remove-sg-rule-${group.id}-${i}`}
            onClick={() => removeRule(i)}
          >
            ×
          </button>
        </div>
      ))}
      <div style={{ ...row, marginTop: 4, flexWrap: 'wrap' }}>
        <input
          aria-label={`port for new rule on ${group.label}`} style={{ ...field, flex: '0 0 60px', marginBottom: 0 }}
          value={port} onChange={e => setPort(e.target.value)}
        />
        <select
          aria-label={`protocol for new rule on ${group.label}`} style={{ ...field, flex: '0 0 64px', marginBottom: 0 }}
          value={protocol} onChange={e => setProtocol(e.target.value as 'tcp' | 'udp')}
        >
          <option value="tcp">tcp</option>
          <option value="udp">udp</option>
        </select>
        <Segmented
          ariaLabel={`source for new rule on ${group.label}`}
          value={sourceOption}
          onChange={v => {
            setSourceOption(v as 'any' | 'internal' | 'custom')
            setCustomText(v === 'custom' ? '' : null)
          }}
          options={[{ value: 'any', label: 'any' }, { value: 'internal', label: 'internal' }, { value: 'custom', label: 'custom' }]}
        />
      </div>
      {sourceOption === 'custom' && (
        <input
          aria-label={`source cidr for new rule on ${group.label}`} style={{ ...field, marginTop: 4 }}
          placeholder="10.0.0.0/8" value={customText ?? ''}
          onChange={e => setCustomText(e.target.value)}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" className="kit-press" style={smallBtn} onClick={addRule}>+ add rule</button>
      </div>
    </div>
  )
}

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
        <div key={sg.id} style={{ ...card, padding: 8, marginTop: 6 }}>
          <div style={row}>
            <input
              aria-label={`sg-label-${sg.id}`} style={{ ...field, flex: 1, marginBottom: 0 }}
              value={sg.label} onChange={e => updateSecurityGroup(sg.id, { label: e.target.value })}
            />
            <span style={muted}>{sg.rules.length} rule{sg.rules.length === 1 ? '' : 's'}</span>
            <button className="kit-press" style={dangerBtn} aria-label={`remove-sg-${sg.id}`} onClick={() => removeSecurityGroup(sg.id)}>×</button>
          </div>
          <SecurityGroupRuleEditor group={sg} />
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
      <RouteTableEditor subnet={subnet} doc={doc} />
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
