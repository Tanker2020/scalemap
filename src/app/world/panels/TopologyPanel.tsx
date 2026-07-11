// Region → AZ → server authoring, including per-server firewall + compose-stack editing.
// Hybrid instrument restyle (Polish 1 T2) — presentation only; every dispatch below is
// byte-for-byte identical to the pre-restyle panel (see docs/superpowers/sdd/task-2-brief.md).
import { useState } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useFileStore } from '../../store/file.store'
import { useSimulationStore } from '../../store/simulation.store'
import { WORLD_REGIONS } from '../../../lib/regionConfig'
import { INSTANCE_CATALOG, getPreset, type InstancePreset } from '../../../lib/world/instanceCatalog'
import { nextWorldId } from '../../../lib/world/factories'
import type { Region, Server } from '../../../lib/world/types'
import { SectionHeader, EdgeRow, ChipValue, MicroBars, PresetCardGrid, type EdgeRowStatus } from '../ui/kit'
import { field, smallBtn, dangerBtn, row } from './panelStyles'
import { healthWord } from '../ui/derived'

const HEALTH_COLOR: Record<'healthy' | 'degraded' | 'down', string> = {
  healthy: 'var(--color-success)',
  degraded: 'var(--color-warning)',
  down: 'var(--color-danger)',
}

// '▸ US-EAST-1 · N. VIRGINIA' — catalogId uppercased + the parenthesized metro from the
// WORLD_REGIONS label uppercased (fallback to the raw label, uppercased, when no parens).
function regionSectLabel(region: Region): string {
  const catalog = WORLD_REGIONS.find(w => w.id === region.catalogId)
  const rawLabel = catalog?.label ?? region.catalogId
  const metroMatch = rawLabel.match(/\(([^)]+)\)/)
  const metro = metroMatch ? metroMatch[1].toUpperCase() : rawLabel.toUpperCase()
  return `▸ ${region.catalogId.toUpperCase()} · ${metro}`
}

function presetDetail(p: InstancePreset): string {
  return `${p.specs.vcpu} vCPU · ${p.specs.ramMb / 1024} GB · ${p.kind === 'vps' ? 'shared tenancy' : 'yours alone'}`
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

// Unstyled wrapper so a real <button> (aria-label, onClick) can carry a ChipValue's look
// without doubling up borders/padding.
const unstyledButton = { all: 'unset' as const, cursor: 'pointer' }

export function TopologyPanel() {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const [newRegion, setNewRegion] = useState(WORLD_REGIONS[0].id)
  const [presetByAz, setPresetByAz] = useState<Record<string, string>>({})
  const [presetGridOpenAz, setPresetGridOpenAz] = useState<string | null>(null)
  const [expandedServer, setExpandedServer] = useState<string | null>(null)

  const available = WORLD_REGIONS.filter(w => !Object.values(doc.regions).some(r => r.catalogId === w.id))

  const nextAzLabel = (catalogId: string, regionId: string) => {
    const count = Object.values(doc.azs).filter(a => a.regionId === regionId).length
    return `${catalogId}${String.fromCharCode(97 + count)}`   // a, b, c…
  }

  return (
    <div>
      <SectionHeader label="▸ REGIONS" />
      <div style={row}>
        <select aria-label="add-region-select" style={{ ...field, marginBottom: 0, flex: 1 }}
          value={newRegion} onChange={e => setNewRegion(e.target.value)}>
          {available.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}
        </select>
        <button className="kit-press" style={smallBtn} disabled={available.length === 0}
          onClick={() => store.addRegion(newRegion)}>+ Region</button>
      </div>

      {Object.values(doc.regions).map(region => {
        const regionHealth = displayBatch?.regions[region.id]?.health ?? null
        return (
          <div key={region.id} style={{ border: '1px solid var(--color-node-border)', borderRadius: 6, padding: 8, marginTop: 8 }}>
            <SectionHeader
              label={regionSectLabel(region)}
              trailing={
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: 9, fontVariantNumeric: 'tabular-nums',
                    color: regionHealth ? HEALTH_COLOR[regionHealth] : 'var(--color-text-muted)',
                  }}>
                    {regionHealth ? `● ${regionHealth}` : '● —'}
                  </span>
                  {/* Role toggle writes via setState directly — deliberately no history push for a two-value toggle (see plan Task 11 note). History bypass is deliberate; dirty-marking is still required. */}
                  <select style={{ ...field, width: 76, marginBottom: 0 }} value={region.role}
                    onChange={e => {
                      useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: { ...region, role: e.target.value as 'active' | 'passive' } } } }))
                      useFileStore.getState().setDirty(true)
                    }}>
                    <option value="active">active</option>
                    <option value="passive">passive</option>
                  </select>
                  <button className="kit-press" style={dangerBtn} onClick={() => store.removeRegion(region.id)}>×</button>
                </div>
              }
            />
            <button className="kit-press" style={smallBtn} onClick={() => store.addAz(region.id, nextAzLabel(region.catalogId, region.id))}>+ AZ</button>

            {Object.values(doc.azs).filter(a => a.regionId === region.id).map(az => {
              const selectedPreset = presetByAz[az.id] ?? 'vps-medium'
              const gridOpen = presetGridOpenAz === az.id
              return (
                <div key={az.id} style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--color-node-border)' }}>
                  <div style={row}>
                    <span style={{ flex: 1 }}>{az.label}</span>
                    <button className="kit-press" style={dangerBtn} onClick={() => store.removeAz(az.id)}>×</button>
                  </div>
                  <div style={row}>
                    <button type="button" aria-label="choose server preset" style={unstyledButton}
                      onClick={() => setPresetGridOpenAz(cur => cur === az.id ? null : az.id)}>
                      <ChipValue title="server preset">{selectedPreset}</ChipValue>
                    </button>
                    <button className="kit-press" style={smallBtn}
                      onClick={() => store.addServer(az.id, getPreset(selectedPreset)!)}>+ Server</button>
                  </div>
                  {gridOpen && (
                    <div style={{ marginBottom: 6 }}>
                      <PresetCardGrid
                        value={selectedPreset}
                        onChange={v => setPresetByAz(p => ({ ...p, [az.id]: v }))}
                        options={INSTANCE_CATALOG.map(p => ({ value: p.id, name: p.id, detail: presetDetail(p), price: '$' + p.hourlyUsd + '/hr' }))}
                      />
                    </div>
                  )}

                  {Object.values(doc.servers).filter(sv => sv.azId === az.id).map(server => (
                    <ServerRow key={server.id} server={server}
                      expanded={expandedServer === server.id}
                      onToggle={() => setExpandedServer(e => e === server.id ? null : server.id)} />
                  ))}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function ServerRow({ server, expanded, onToggle }: { server: Server; expanded: boolean; onToggle: () => void }) {
  const store = useWorldStore.getState()
  const nav = useNavStore.getState()
  const doc = useWorldStore(s => s.doc)
  const az = doc.azs[server.azId]
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const metrics = displayBatch?.servers[server.id]

  const upd = (patch: Partial<Server>) => store.updateServer(server.id, patch)

  const health: EdgeRowStatus = metrics?.health ?? null
  const edgeColor = health === 'degraded' ? 'var(--color-warning)'
    : health === 'down' ? 'var(--color-danger)'
    : 'var(--color-accent)'
  const azSuffix = az ? az.label.slice(-1) : ''
  const cpuMean = metrics ? mean(metrics.coreUtilization) : 0
  const ramFrac = metrics && metrics.ramTotalMb ? metrics.ramUsedMb / metrics.ramTotalMb : 0

  return (
    <div style={{ marginTop: 4 }}>
      <EdgeRow
        status={health}
        edgeColor={edgeColor}
        ripple={running}
        trailing={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {metrics && <MicroBars cpu={cpuMean} ram={ramFrac} io={metrics.diskIoFraction} />}
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
              ${server.hourlyUsd}/hr
            </span>
            {az && <button className="kit-press" style={smallBtn} title="Open server view"
              onClick={() => nav.goServer(az.regionId, az.id, server.id)}>→</button>}
            <button className="kit-press" style={dangerBtn} onClick={() => store.removeServer(server.id)}>×</button>
          </div>
        }
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <button className="kit-press" style={{ ...smallBtn, border: 'none', padding: 0, background: 'transparent', textAlign: 'left', whiteSpace: 'nowrap' }} onClick={onToggle}>
            {expanded ? '▾' : '▸'} {server.label} <span style={{ color: 'var(--color-text-muted)' }}>({server.kind})</span>
          </button>
          <span style={{ fontSize: 9.5, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {server.kind} · {server.specs.vcpu}c/{server.specs.ramMb / 1024}G · {azSuffix}
            {/* The health word lives on the meta line, not in the trailing — with it there the
                trailing grew to ~195px and squeezed server names into a three-line wrap. */}
            {metrics && (() => {
              const word = healthWord(cpuMean, ramFrac)
              const color = word === 'comfortable' ? 'var(--color-success)'
                : word === 'tight' ? 'var(--color-warning)' : 'var(--color-danger)'
              return <> · <span style={{ fontSize: 10, color }}>{word}</span></>
            })()}
          </span>
        </div>
        {metrics && (
          <div style={{ marginTop: 4, height: 4, background: 'var(--color-canvas)', borderRadius: 2, overflow: 'hidden' }}>
            <div data-testid="topo-util-fill" style={{
              height: '100%', width: `${Math.round(cpuMean * 100)}%`,
              background: cpuMean > 0.75 ? 'var(--color-warning)' : 'var(--color-accent)',
            }} />
          </div>
        )}
      </EdgeRow>

      {expanded && (
        <div style={{ marginLeft: 10, marginTop: 2, background: 'var(--color-node-base)', borderRadius: 4, padding: 6 }}>
          <input style={field} value={server.label} aria-label="server-label"
            onChange={e => upd({ label: e.target.value })} />

          <SectionHeader label="▸ FIREWALL — TOP-DOWN, DEFAULT DENY" />
          {server.firewall.map((r, i) => (
            <div key={r.id} style={{ ...row, flexWrap: 'wrap' }}>
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
              <button className="kit-press" style={smallBtn} disabled={i === 0}
                onClick={() => {
                  const swapped = [...server.firewall]
                  ;[swapped[i - 1], swapped[i]] = [swapped[i], swapped[i - 1]]
                  upd({ firewall: swapped })
                }}>↑</button>
              <button className="kit-press" style={smallBtn} disabled={i === server.firewall.length - 1}
                onClick={() => {
                  const swapped = [...server.firewall]
                  ;[swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]]
                  upd({ firewall: swapped })
                }}>↓</button>
              <button className="kit-press" style={dangerBtn} onClick={() => upd({ firewall: server.firewall.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button className="kit-press" style={smallBtn}
            onClick={() => upd({ firewall: [...server.firewall, { id: nextWorldId('fw'), action: 'allow', port: 443, protocol: 'tcp', source: 'any' }] })}>
            + Rule
          </button>

          <SectionHeader label="▸ COMPOSE STACKS" />
          {server.stacks.map((st, i) => (
            <div key={st.name + i} style={{ marginBottom: 6 }}>
              <div style={row}>
                <input style={{ ...field, marginBottom: 0, flex: 1 }} value={st.name} aria-label={`stack-name-${i}`}
                  onChange={e => upd({ stacks: server.stacks.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
                <button className="kit-press" style={dangerBtn} onClick={() => upd({ stacks: server.stacks.filter((_, j) => j !== i) })}>×</button>
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
          <button className="kit-press" style={smallBtn}
            onClick={() => upd({ stacks: [...server.stacks, { name: `stack-${server.stacks.length + 1}`, networks: [{ name: 'default', cidr: '172.18.0.0/16' }], volumes: [] }] })}>
            + Stack
          </button>
        </div>
      )}
    </div>
  )
}
