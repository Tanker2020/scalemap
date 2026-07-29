// src/app/world/panels/PacketModal.tsx
// Add/edit modal for library packets (packet-library phase) — the payload definitions bound to
// service→service dependency edges, as opposed to the client-facing routes in RoutesPanel.
//
// Shell is ManagedServiceModal.tsx's pattern copied deliberately: portal to document.body,
// backdrop click closes, capture-phase Escape (so WorldShell's "Escape goes up a nav level"
// doesn't ALSO fire), a one-time store snapshot per open rather than a live subscription (so a
// mid-edit change elsewhere can't clobber the draft — and so one Save is one undo entry), and its
// OWN `<fieldset disabled={running}>` because createPortal escapes WorldPanel's dock-wide one.
// Close/Cancel stay outside that fieldset so there is always a way out while running.
//
// All draft logic lives in src/lib/world/packetDraft.ts (pure, node-tested); this file is layout
// plus one dispatch.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPacket, type ConnectionType, type HttpTemplate } from '../../../lib/nodeConfig'
import { DEFAULT_HOLD_SEC, HANDSHAKE_CPU_MS, HANDSHAKE_MS, LINGER_MS } from '../../../lib/connectionModel'
import {
  PACKET_PROTOCOLS, defaultPacketDraft, draftFromPacket, draftToTemplate,
  applyProtocolChange, packetDraftValid, parseKb, type PacketDraft,
} from '../../../lib/world/packetDraft'
import { SectionHeader, Segmented, Explainer } from '../ui/kit'

export interface PacketModalProps {
  open: boolean
  editingId: number | null
  onClose: () => void
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const surfaceStyle: CSSProperties = {
  width: 520, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 8, padding: 16,
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
}
const field: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '3px 6px', color: 'var(--color-text-primary)', width: '100%', boxSizing: 'border-box',
}
const btn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 10px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}
const btnLocked: CSSProperties = { ...btn, opacity: 0.35, cursor: 'default' }
const rowLabel: CSSProperties = { color: 'var(--color-text-muted)', display: 'block', marginBottom: 2 }
const rowGap: CSSProperties = { marginBottom: 7 }
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}

const METHODS: HttpTemplate['method'][] = ['GET', 'POST', 'PUT', 'DELETE']
const CONNECTIONS: ConnectionType[] = ['keep-alive', 'short-lived', 'streaming']

// One line per class naming the FAILURE MODE it creates, not the mechanism — the point of the
// setting is that the three fail differently, and the numbers now move to match.
const CONNECTION_HINT: Record<ConnectionType, string> = {
  'keep-alive': 'pooled — connections track request latency; the cheapest option and the baseline',
  'short-lived': `a fresh connection per request: +${HANDSHAKE_CPU_MS} ms handshake CPU and a ${HANDSHAKE_MS + LINGER_MS} ms hold tail, so this hits the CPU ceiling first`,
  'streaming': 'connections decouple from latency and pile up at low rps — this hits the RAM ceiling first (ramPerConnMb)',
}

// The color input needs a concrete hex to show a swatch; '' (no override) shows the neutral
// node-border tone until the user actually picks one.
const NO_COLOR = '#5B9CF6'

export function PacketModal({ open, editingId, onClose }: PacketModalProps): ReactElement | null {
  const running = useSimulationStore(s => s.running)
  const [draft, setDraft] = useState<PacketDraft>(() => defaultPacketDraft())

  useEffect(() => {
    if (!open) return
    const snapshot = useWorldStore.getState()
    const existing = editingId != null ? getPacket(snapshot.doc.packets, editingId) : undefined
    setDraft(existing ? draftFromPacket(existing) : defaultPacketDraft())
  }, [open, editingId])

  // Capture-phase Escape — see ManagedServiceModal.tsx's note: capture always precedes bubble for
  // a window listener, so stopPropagation here means WorldShell's nav-level handler never runs.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true) // CAPTURE
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  if (!open) return null

  const canSubmit = !running && packetDraftValid(draft)
  const set = (patch: Partial<PacketDraft>) => setDraft(d => ({ ...d, ...patch }))

  const submit = (): void => {
    if (!canSubmit) return
    const fields = draftToTemplate(draft)
    if (editingId != null) useWorldStore.getState().updatePacket(editingId, fields)
    else useWorldStore.getState().addPacket(fields)
    onClose()
  }

  const reqKb = parseKb(draft.sizeKb) ?? 0
  const respKb = draft.protocol === 'db'
    ? (parseKb(draft.resultSizeKb) ?? parseKb(draft.responseSizeKb) ?? 0)
    : (parseKb(draft.responseSizeKb) ?? 0)

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>
            {editingId != null ? 'Edit packet' : 'Add packet'}
          </span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
          <SectionHeader label="▸ IDENTITY" />
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="pk-name" style={rowLabel}>name</label>
              <input
                id="pk-name" aria-label="name" style={field} value={draft.name}
                placeholder="e.g. thumbnail-upload"
                onChange={e => set({ name: e.target.value })}
              />
            </div>
            <div style={{ flex: '0 0 76px' }}>
              <label htmlFor="pk-color" style={rowLabel}>color</label>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  id="pk-color" aria-label="color" type="color" style={{ ...field, padding: 0, height: 22, width: 34 }}
                  value={draft.colorOverride || NO_COLOR}
                  onChange={e => set({ colorOverride: e.target.value })}
                />
                <button
                  type="button" style={{ ...smallBtnStyle, padding: '2px 5px', fontSize: 9.5 }}
                  aria-label="clear color" title="inherit the service's color"
                  onClick={() => set({ colorOverride: '' })}
                >
                  auto
                </button>
              </div>
            </div>
          </div>
          <div style={rowGap}>
            <label style={rowLabel}>protocol</label>
            <Segmented
              ariaLabel="protocol" value={draft.protocol}
              onChange={p => setDraft(d => applyProtocolChange(d, p))}
              options={PACKET_PROTOCOLS.map(p => ({ value: p.key, label: p.label }))}
            />
            <Explainer>{PACKET_PROTOCOLS.find(p => p.key === draft.protocol)?.hint}</Explainer>
          </div>

          <SectionHeader label="▸ SIZING" />
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="pk-req" style={rowLabel}>request KB</label>
              <input
                id="pk-req" aria-label="request size" type="number" min={0} style={field}
                value={draft.sizeKb} onChange={e => set({ sizeKb: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="pk-resp" style={rowLabel}>response KB</label>
              <input
                id="pk-resp" aria-label="response size" type="number" min={0} style={field}
                value={draft.responseSizeKb} onChange={e => set({ responseSizeKb: e.target.value })}
              />
            </div>
            <div style={{ flex: '0 0 80px' }}>
              <label htmlFor="pk-sigma" style={rowLabel}>burst σ</label>
              <input
                id="pk-sigma" aria-label="size variance" type="number" min={0} step={0.1} style={field}
                value={draft.sizeVariance} onChange={e => set({ sizeVariance: e.target.value })}
              />
            </div>
          </div>
          <Explainer>
            these sizes drive NIC saturation, per-KB CPU, and the cross-AZ / cross-region egress bill
            on every hop this packet is bound to — {reqKb} KB up, {respKb} KB back
          </Explainer>
          <Explainer>burst σ adds mean-preserving log-normal jitter — it moves p99, not the average</Explainer>

          {draft.protocol === 'http' && (
            <>
              <SectionHeader label="▸ HTTP" />
              <div style={{ display: 'flex', gap: 6, ...rowGap }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-method" style={rowLabel}>method</label>
                  <select
                    id="pk-method" aria-label="method" style={field} value={draft.method ?? 'POST'}
                    onChange={e => set({ method: e.target.value as HttpTemplate['method'] })}
                  >
                    {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-connection" style={rowLabel}>connection</label>
                  <select
                    id="pk-connection" aria-label="connection type" style={field}
                    value={draft.connectionType ?? 'keep-alive'}
                    onChange={e => set({ connectionType: e.target.value as ConnectionType })}
                  >
                    {CONNECTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                {draft.connectionType === 'streaming' && (
                  <div style={{ flex: '0 0 90px' }}>
                    <label htmlFor="pk-hold" style={rowLabel}>hold sec</label>
                    <input
                      id="pk-hold" aria-label="hold seconds" type="number" min={0} style={field}
                      placeholder={String(DEFAULT_HOLD_SEC)}
                      value={draft.holdSeconds ?? ''} onChange={e => set({ holdSeconds: e.target.value })}
                    />
                  </div>
                )}
              </div>
              <Explainer>{CONNECTION_HINT[draft.connectionType ?? 'keep-alive']}</Explainer>
            </>
          )}

          {draft.protocol === 'db' && (
            <>
              <SectionHeader label="▸ DATABASE" />
              <div style={{ display: 'flex', gap: 6, ...rowGap }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-query-type" style={rowLabel}>query type</label>
                  <select
                    id="pk-query-type" aria-label="query type" style={field} value={draft.queryType ?? 'read'}
                    onChange={e => set({ queryType: e.target.value as PacketDraft['queryType'] })}
                  >
                    <option value="read">read</option>
                    <option value="write">write</option>
                    <option value="transaction">transaction</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-result" style={rowLabel}>result KB</label>
                  <input
                    id="pk-result" aria-label="result size" type="number" min={0} style={field}
                    value={draft.resultSizeKb ?? ''} onChange={e => set({ resultSizeKb: e.target.value })}
                  />
                </div>
              </div>
              <Explainer>
                writes and transactions route to the primary and set the edge's write fraction; reads
                fan out to replicas
              </Explainer>
              <div style={rowGap}>
                <label htmlFor="pk-wal" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}>
                  <input
                    id="pk-wal" type="checkbox" aria-label="write-ahead logging"
                    checked={draft.isWAL ?? false} onChange={e => set({ isWAL: e.target.checked })}
                  />
                  write-ahead logging
                </label>
                <Explainer>WAL writes the payload twice — log then data pages — doubling booked write bytes</Explainer>
              </div>
            </>
          )}

          {draft.protocol === 'event' && (
            <>
              <SectionHeader label="▸ EVENT" />
              <div style={{ display: 'flex', gap: 6, ...rowGap }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-topic" style={rowLabel}>topic</label>
                  <input
                    id="pk-topic" aria-label="topic" style={field} placeholder="orders"
                    value={draft.topic ?? ''} onChange={e => set({ topic: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-event-type" style={rowLabel}>event type</label>
                  <input
                    id="pk-event-type" aria-label="event type" style={field} placeholder="order.placed"
                    value={draft.eventType ?? ''} onChange={e => set({ eventType: e.target.value })}
                  />
                </div>
              </div>
              <div style={rowGap}>
                <label htmlFor="pk-delivery" style={rowLabel}>delivery mode</label>
                <select
                  id="pk-delivery" aria-label="delivery mode" style={field}
                  value={draft.deliveryMode ?? 'at-least-once'}
                  onChange={e => set({ deliveryMode: e.target.value as PacketDraft['deliveryMode'] })}
                >
                  <option value="at-most-once">at-most-once</option>
                  <option value="at-least-once">at-least-once</option>
                  <option value="exactly-once">exactly-once</option>
                </select>
              </div>
              <Explainer>sizing is live now; asynchronous delivery semantics are a later phase</Explainer>
            </>
          )}

          {draft.protocol === 'stream' && (
            <>
              <SectionHeader label="▸ STREAM" />
              <div style={{ display: 'flex', gap: 6, ...rowGap }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-stream-id" style={rowLabel}>stream id</label>
                  <input
                    id="pk-stream-id" aria-label="stream id" style={field} placeholder="telemetry"
                    value={draft.streamId ?? ''} onChange={e => set({ streamId: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="pk-compression" style={rowLabel}>compression</label>
                  <select
                    id="pk-compression" aria-label="compression" style={field}
                    value={draft.compressionType ?? 'none'}
                    onChange={e => set({ compressionType: e.target.value as PacketDraft['compressionType'] })}
                  >
                    <option value="none">none</option>
                    <option value="gzip">gzip</option>
                    <option value="snappy">snappy</option>
                  </select>
                </div>
                <div style={{ flex: '0 0 90px' }}>
                  <label htmlFor="pk-stream-hold" style={rowLabel}>hold sec</label>
                  <input
                    id="pk-stream-hold" aria-label="hold seconds" type="number" min={0} style={field}
                    placeholder={String(DEFAULT_HOLD_SEC)}
                    value={draft.holdSeconds ?? ''} onChange={e => set({ holdSeconds: e.target.value })}
                  />
                </div>
              </div>
              <Explainer>{CONNECTION_HINT.streaming}</Explainer>
              <Explainer>a stream is always a persistent connection, whatever its size — asynchronous delivery semantics are still a later phase</Explainer>
            </>
          )}
        </fieldset>

        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button
            type="button" className="kit-press" style={canSubmit ? btn : btnLocked}
            disabled={!canSubmit}
            title={running ? 'stop the simulation to edit' : undefined}
            onClick={submit}
          >
            {editingId != null ? 'Save' : 'Create'}
          </button>
          <button type="button" className="kit-press" style={btn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
