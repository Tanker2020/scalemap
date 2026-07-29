// src/app/world/panels/PacketsPanel.tsx
// The global packet library — world scope. A packet is a reusable payload definition (name,
// protocol, request/response size, burst variance, color) that service→service dependency edges
// bind via a weighted mix, so an internal hop shipping 5 MB blobs stops looking identical to one
// sending 200-byte health checks.
//
// Sibling of RoutesPanel (client→entry request classes) over the SAME registry — a route is a
// template WITH a path, a packet is one without (see nodeConfig's module header). Unlike
// RoutesPanel's inline-edit rows, all configuration happens in PacketModal; each row here is a
// read-only summary plus edit / dup / × — the ManagedPanel shape, because a packet has
// protocol-specific fields that don't fit a row.
import { useState, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { listPackets } from '../../../lib/nodeConfig'
import type { PacketTemplate } from '../../../lib/nodeConfig'
import { connectionClassOf, DEFAULT_HOLD_SEC } from '../../../lib/connectionModel'
import type { WorldDoc } from '../../../lib/world/types'
import { DEFAULT_PACKET_BYTES_EACH_WAY } from '../../../lib/packetResolve'
import { SectionHeader, Explainer } from '../ui/kit'
import { field, smallBtn, dangerBtn, row } from './panelStyles'
import { PacketModal } from './PacketModal'

const actionBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const chip: CSSProperties = {
  fontSize: 9, padding: '1px 5px', borderRadius: 3, flexShrink: 0,
  border: '1px solid var(--color-node-border)', color: 'var(--color-text-muted)',
}
const muted: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)' }
const sizeField: CSSProperties = { ...field, width: 64, marginBottom: 0 }

const DEFAULT_KB = DEFAULT_PACKET_BYTES_EACH_WAY / 1024

// How many places bind this packet — the answer to "is it safe to delete?".
function usageOf(doc: WorldDoc, packetId: number): { edges: number; routes: number } {
  let edges = 0
  for (const bp of Object.values(doc.blueprints)) {
    for (const dep of bp.dependencies) {
      if (dep.packetMix?.some(e => e.packetId === packetId)) edges++
    }
  }
  const routes = Object.values(doc.packets.templates).filter(
    t => t.protocol === 'http' && !!t.path && t.packetMix?.some(e => e.packetId === packetId)).length
  return { edges, routes }
}

function sizeSummary(p: PacketTemplate): string {
  const resp = p.protocol === 'db' ? p.resultSizeKb : p.responseSizeKb
  const parts = [`${p.sizeKb ?? 0} KB ↑`, `${resp ?? '—'} KB ↓`]
  if (p.sizeVariance) parts.push(`σ ${p.sizeVariance}`)
  if (p.protocol === 'db') parts.push(p.queryType + (p.isWAL ? ' · WAL' : ''))
  if (p.protocol === 'event' && p.topic) parts.push(p.topic)
  if (p.protocol === 'stream' && p.streamId) parts.push(p.streamId)
  return parts.join(' · ')
}

// The packet's connection behavior, shown ONLY when it differs from keep-alive — the default is
// both the common case and the no-op, so chipping it on every row would be pure noise. A stream is
// streaming by protocol even though it carries no connectionType (connectionModel's protocol-wins
// rule), which is exactly why this reads the resolved class rather than the raw field.
function connSummary(p: PacketTemplate): string | null {
  const cls = connectionClassOf(p)
  if (cls === 'keep-alive') return null
  if (cls === 'short-lived') return 'short-lived'
  return `streaming · ${p.protocol === 'http' || p.protocol === 'stream' ? (p.holdSeconds ?? DEFAULT_HOLD_SEC) : DEFAULT_HOLD_SEC}s`
}

export function PacketsPanel() {
  const doc = useWorldStore(s => s.doc)
  const removePacket = useWorldStore(s => s.removePacket)
  const duplicatePacket = useWorldStore(s => s.duplicatePacket)
  const setDefaultPacket = useWorldStore(s => s.setDefaultPacket)
  const packets = listPackets(doc.packets)
  const [modalState, setModalState] = useState<{ id: number | null } | null>(null)

  const def = doc.packets.defaultPacket
  const setDef = (patch: { reqKb?: number; respKb?: number }) => setDefaultPacket({
    reqKb: patch.reqKb ?? def?.reqKb ?? DEFAULT_KB,
    respKb: patch.respKb ?? def?.respKb ?? DEFAULT_KB,
  })

  return (
    <div>
      <SectionHeader label="▸ DEFAULT PACKET" />
      <Explainer>
        What an internal hop costs when no packet is bound to it and no inline size is set — the
        world-wide floor. Leave it alone and every unauthored hop keeps the historical {DEFAULT_KB} KB
        each way.
      </Explainer>
      <div style={row}>
        <span style={muted}>req</span>
        <input style={sizeField} type="number" min={0} aria-label="default-req-size" title="default request size (KB)"
          value={def?.reqKb ?? DEFAULT_KB} onChange={e => setDef({ reqKb: Number(e.target.value) })} />
        <span style={muted}>resp KB</span>
        <input style={sizeField} type="number" min={0} aria-label="default-resp-size" title="default response size (KB)"
          value={def?.respKb ?? DEFAULT_KB} onChange={e => setDef({ respKb: Number(e.target.value) })} />
        {def && (
          <button className="kit-press" style={smallBtn} aria-label="reset-default-packet"
            title={`back to the ${DEFAULT_KB} KB convention`} onClick={() => setDefaultPacket(null)}>reset</button>
        )}
      </div>

      <SectionHeader
        label="▸ PACKETS"
        trailing={
          <button className="kit-press" style={actionBtn} aria-label="add-packet"
            onClick={() => setModalState({ id: null })}>+ Packet</button>
        }
      />
      <Explainer>
        Bind these to a connection in the Connections tab (or, for a client-facing request class,
        to a route) to give that hop real payload sizes — they drive egress cost, NIC saturation,
        and per-KB CPU.
      </Explainer>
      {packets.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', margin: '6px 0' }}>no packets yet</div>
      )}
      {packets.map(p => {
        const usage = usageOf(doc, p.id)
        const bound = usage.edges + usage.routes
        return (
          <div key={p.id} style={{
            background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
            borderRadius: 8, padding: 10, marginTop: 8,
          }}>
            <div style={row}>
              <span aria-hidden style={{
                width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                background: p.colorOverride ?? 'transparent',
                border: `1px solid ${p.colorOverride ?? 'var(--color-node-border)'}`,
              }} />
              <span style={{ ...muted, flexShrink: 0 }}>#{p.id}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              {connSummary(p) && (
                <span style={chip} title="connection behavior — drives connection count, per-connection RAM and handshake CPU">
                  {connSummary(p)}
                </span>
              )}
              <span style={chip}>{p.protocol}</span>
            </div>
            <div style={{ ...row, marginTop: 4 }}>
              <span style={{ ...muted, flex: 1, minWidth: 0 }}>{sizeSummary(p)}</span>
              <span style={muted} title="bindings using this packet">
                {bound === 0 ? 'unused'
                  : [usage.edges > 0 ? `${usage.edges} edge${usage.edges === 1 ? '' : 's'}` : null,
                     usage.routes > 0 ? `${usage.routes} route${usage.routes === 1 ? '' : 's'}` : null]
                    .filter(Boolean).join(' · ')}
              </span>
            </div>
            <div style={{ ...row, marginTop: 4, marginBottom: 0 }}>
              <button className="kit-press" style={smallBtn} aria-label={`edit-packet-${p.id}`}
                onClick={() => setModalState({ id: p.id })}>edit</button>
              <button className="kit-press" style={smallBtn} aria-label={`duplicate-packet-${p.id}`}
                onClick={() => duplicatePacket(p.id)}>dup</button>
              <span style={{ flex: 1 }} />
              <button className="kit-press" style={dangerBtn} aria-label={`remove-packet-${p.id}`}
                title={bound > 0 ? 'still bound — deleting unbinds it everywhere' : undefined}
                onClick={() => removePacket(p.id)}>×</button>
            </div>
          </div>
        )
      })}

      <PacketModal
        open={modalState !== null}
        editingId={modalState?.id ?? null}
        onClose={() => setModalState(null)}
      />
    </div>
  )
}
