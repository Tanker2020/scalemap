// Region → AZ → server authoring, including per-server firewall + compose-stack editing.
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { WORLD_REGIONS } from '../../../lib/regionConfig'
import { INSTANCE_CATALOG, getPreset } from '../../../lib/world/instanceCatalog'
import { nextWorldId } from '../../../lib/world/factories'
import type { Server } from '../../../lib/world/types'
import { sectionLabel, field, smallBtn, dangerBtn, row } from './panelStyles'

export function TopologyPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const [newRegion, setNewRegion] = useState(WORLD_REGIONS[0].id)
  const [presetByAz, setPresetByAz] = useState<Record<string, string>>({})
  const [expandedServer, setExpandedServer] = useState<string | null>(null)

  const available = WORLD_REGIONS.filter(w => !Object.values(doc.regions).some(r => r.catalogId === w.id))

  const nextAzLabel = (catalogId: string, regionId: string) => {
    const count = Object.values(doc.azs).filter(a => a.regionId === regionId).length
    return `${catalogId}${String.fromCharCode(97 + count)}`   // a, b, c…
  }

  return (
    <div>
      <div style={sectionLabel}>Regions</div>
      <div style={row}>
        <select aria-label="add-region-select" style={{ ...field, marginBottom: 0, flex: 1 }}
          value={newRegion} onChange={e => setNewRegion(e.target.value)}>
          {available.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}
        </select>
        <button style={smallBtn} disabled={available.length === 0}
          onClick={() => store.addRegion(newRegion)}>+ Region</button>
      </div>

      {Object.values(doc.regions).map(region => (
        <div key={region.id} style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
          <div style={row}>
            <strong style={{ flex: 1 }}>{region.catalogId}</strong>
            <select style={{ ...field, width: 76, marginBottom: 0 }} value={region.role}
              onChange={e => useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: { ...region, role: e.target.value as 'active' | 'passive' } } } }))}>
              <option value="active">active</option>
              <option value="passive">passive</option>
            </select>
            <button style={dangerBtn} onClick={() => store.removeRegion(region.id)}>×</button>
          </div>
          <button style={smallBtn} onClick={() => store.addAz(region.id, nextAzLabel(region.catalogId, region.id))}>+ AZ</button>

          {Object.values(doc.azs).filter(a => a.regionId === region.id).map(az => (
            <div key={az.id} style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
              <div style={row}>
                <span style={{ flex: 1 }}>{az.label}</span>
                <button style={dangerBtn} onClick={() => store.removeAz(az.id)}>×</button>
              </div>
              <div style={row}>
                <select style={{ ...field, marginBottom: 0, flex: 1 }}
                  value={presetByAz[az.id] ?? 'vps-medium'}
                  onChange={e => setPresetByAz(p => ({ ...p, [az.id]: e.target.value }))}>
                  {INSTANCE_CATALOG.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <button style={smallBtn}
                  onClick={() => store.addServer(az.id, getPreset(presetByAz[az.id] ?? 'vps-medium')!)}>+ Server</button>
              </div>

              {Object.values(doc.servers).filter(sv => sv.azId === az.id).map(server => (
                <ServerRow key={server.id} server={server}
                  expanded={expandedServer === server.id}
                  onToggle={() => setExpandedServer(e => e === server.id ? null : server.id)} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function ServerRow({ server, expanded, onToggle }: { server: Server; expanded: boolean; onToggle: () => void }) {
  const store = useWorldStore.getState()
  const nav = useNavStore.getState()
  const doc = useWorldStore(s => s.doc)
  const az = doc.azs[server.azId]

  const upd = (patch: Partial<Server>) => store.updateServer(server.id, patch)

  return (
    <div style={{ marginTop: 4, background: 'var(--color-node-base)', borderRadius: 4, padding: 6 }}>
      <div style={row}>
        <button style={{ ...smallBtn, border: 'none', padding: 0, flex: 1, textAlign: 'left' }} onClick={onToggle}>
          {expanded ? '▾' : '▸'} {server.label} <span style={{ color: 'var(--color-text-muted)' }}>({server.kind})</span>
        </button>
        {az && <button style={smallBtn} title="Open server view"
          onClick={() => nav.goServer(az.regionId, az.id, server.id)}>→</button>}
        <button style={dangerBtn} onClick={() => store.removeServer(server.id)}>×</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 6 }}>
          <input style={field} value={server.label} aria-label="server-label"
            onChange={e => upd({ label: e.target.value })} />

          <div style={sectionLabel}>Firewall (top-down, default deny)</div>
          {server.firewall.map((r, i) => (
            <div key={r.id} style={row}>
              <select style={{ ...field, width: 60, marginBottom: 0 }} value={r.action}
                onChange={e => upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, action: e.target.value as 'allow' | 'deny' } : x) })}>
                <option value="allow">allow</option><option value="deny">deny</option>
              </select>
              <input style={{ ...field, width: 56, marginBottom: 0 }} value={String(r.port)} aria-label={`fw-port-${i}`}
                onChange={e => {
                  const v = e.target.value.trim()
                  upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, port: v === 'any' ? 'any' : Number(v) || 0 } : x) })
                }} />
              <select style={{ ...field, width: 56, marginBottom: 0 }} value={r.protocol}
                onChange={e => upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, protocol: e.target.value as 'tcp' | 'udp' | 'any' } : x) })}>
                <option value="tcp">tcp</option><option value="udp">udp</option><option value="any">any</option>
              </select>
              <select style={{ ...field, width: 78, marginBottom: 0 }} value={r.source === 'any' || r.source === 'internal' ? r.source : 'cidr'}
                onChange={e => upd({ firewall: server.firewall.map((x, j) => j === i ? { ...x, source: e.target.value === 'cidr' ? '10.0.0.0/8' : e.target.value } : x) })}>
                <option value="internal">internal</option><option value="any">any</option><option value="cidr">cidr…</option>
              </select>
              <button style={dangerBtn} onClick={() => upd({ firewall: server.firewall.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button style={smallBtn}
            onClick={() => upd({ firewall: [...server.firewall, { id: nextWorldId('fw'), action: 'allow', port: 443, protocol: 'tcp', source: 'any' }] })}>
            + Rule
          </button>

          <div style={sectionLabel}>Compose stacks</div>
          {server.stacks.map((st, i) => (
            <div key={st.name + i} style={{ marginBottom: 6 }}>
              <div style={row}>
                <input style={{ ...field, marginBottom: 0, flex: 1 }} value={st.name} aria-label={`stack-name-${i}`}
                  onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                <button style={dangerBtn} onClick={() => upd({ stacks: server.stacks.filter((_, j) => j !== i) })}>×</button>
              </div>
              <input style={field} placeholder="networks: name@cidr, name@cidr" aria-label={`stack-nets-${i}`}
                value={st.networks.map(n => `${n.name}@${n.cidr}`).join(', ')}
                onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? {
                  ...x,
                  networks: e.target.value.split(',').map(t => t.trim()).filter(Boolean).map(t => {
                    const [name, cidr] = t.split('@')
                    return { name: name?.trim() ?? '', cidr: cidr?.trim() ?? '172.18.0.0/16' }
                  }),
                } : x) })} />
              <input style={field} placeholder="volumes: name@sizeGb, name@sizeGb" aria-label={`stack-vols-${i}`}
                value={st.volumes.map(v => `${v.name}@${v.sizeGb}`).join(', ')}
                onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? {
                  ...x,
                  volumes: e.target.value.split(',').map(t => t.trim()).filter(Boolean).map(t => {
                    const [name, size] = t.split('@')
                    return { name: name?.trim() ?? '', sizeGb: Number(size) || 10 }
                  }),
                } : x) })} />
            </div>
          ))}
          <button style={smallBtn}
            onClick={() => upd({ stacks: [...server.stacks, { name: `stack-${server.stacks.length + 1}`, networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }] })}>
            + Stack
          </button>
        </div>
      )}
    </div>
  )
}
