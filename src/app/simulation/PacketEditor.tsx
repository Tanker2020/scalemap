import { useState } from 'react'
import { motion } from 'framer-motion'
import { X, Plus, Trash2, Package } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import type {
  PacketProtocol, PacketTemplate, NewPacketTemplate, HttpTemplate, EventTemplate, StreamTemplate, DbTemplate,
} from '../../lib/nodeConfig'
import styles from './PacketEditor.module.css'

const PROTOCOLS: { key: PacketProtocol; label: string; color: string }[] = [
  { key: 'http',   label: 'HTTP',   color: '#4A9EFF' },
  { key: 'event',  label: 'Event',  color: '#2DD4BF' },
  { key: 'stream', label: 'Stream', color: '#A78BFA' },
  { key: 'db',     label: 'DB',     color: '#F5A623' },
]

const PROTOCOL_COLOR: Record<PacketProtocol, string> = {
  http: '#4A9EFF', event: '#2DD4BF', stream: '#A78BFA', db: '#F5A623',
}

// Sensible starting values per protocol so a new template is immediately valid.
function defaultTemplate(protocol: PacketProtocol): NewPacketTemplate {
  switch (protocol) {
    case 'http':   return { name: 'New HTTP request', protocol, sizeKb: 2, method: 'GET', path: '/api/v1/resource', statusCode: 200 }
    case 'event':  return { name: 'New event', protocol, sizeKb: 1, topic: 'domain.events', eventType: 'created', deliveryMode: 'at-least-once' }
    case 'stream': return { name: 'New stream record', protocol, sizeKb: 4, streamId: 'stream-1', compressionType: 'none' }
    case 'db':     return { name: 'New query', protocol, sizeKb: 1, queryType: 'read', isWAL: false, resultSizeKb: 8 }
  }
}

export function PacketEditor() {
  const packetMode = useCanvasStore(s => s.packetMode)
  const setPacketMode = useCanvasStore(s => s.setPacketMode)
  const templates = useCanvasStore(s => s.packetTemplates)
  const addPacketTemplate = useCanvasStore(s => s.addPacketTemplate)
  const updatePacketTemplate = useCanvasStore(s => s.updatePacketTemplate)
  const removePacketTemplate = useCanvasStore(s => s.removePacketTemplate)
  const setPacketEditorOpen = useUiStore(s => s.setPacketEditorOpen)

  const list = Object.values(templates).sort((a, b) => a.id - b.id)
  const [selectedId, setSelectedId] = useState<number | null>(list[0]?.id ?? null)
  const [addOpen, setAddOpen] = useState(false)

  const selected = selectedId !== null ? templates[selectedId] : undefined

  const handleAdd = (protocol: PacketProtocol) => {
    const id = addPacketTemplate(defaultTemplate(protocol))
    setSelectedId(id)
    setAddOpen(false)
  }

  const patch = (p: Partial<PacketTemplate>) => {
    if (selectedId !== null) updatePacketTemplate(selectedId, p)
  }

  return (
    <motion.div
      className={styles.backdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={() => setPacketEditorOpen(false)}
    >
      <motion.div
        className={styles.modal}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <Package size={14} /> Packet Templates
          </div>
          <div className={styles.modeToggle}>
            <button
              className={`${styles.modeBtn} ${packetMode === 'generic' ? styles.modeBtnActive : ''}`}
              onClick={() => setPacketMode('generic')}
              title="Uniform particles sized by each node's avg response — templates ignored"
            >
              Generic
            </button>
            <button
              className={`${styles.modeBtn} ${packetMode === 'custom' ? styles.modeBtnActive : ''}`}
              onClick={() => setPacketMode('custom')}
              title="Templates + per-node distribution drive the simulation"
            >
              Custom
            </button>
          </div>
          <button className={styles.closeBtn} onClick={() => setPacketEditorOpen(false)} title="Close">
            <X size={13} />
          </button>
        </div>

        {packetMode === 'generic' && (
          <div className={styles.modeHint}>
            Generic mode — all requests are uniform. Switch to <strong>Custom</strong> to use the templates below
            and assign traffic mixes per node.
          </div>
        )}

        <div className={styles.body}>
          {/* Left: template list */}
          <div className={styles.listCol}>
            <div className={styles.listScroll}>
              {list.length === 0 && (
                <div className={styles.empty}>No templates yet. Add one to get started.</div>
              )}
              {list.map(t => (
                <button
                  key={t.id}
                  className={`${styles.listItem} ${selectedId === t.id ? styles.listItemActive : ''}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className={styles.listDot} style={{ background: t.colorOverride ?? PROTOCOL_COLOR[t.protocol] }} />
                  <span className={styles.listName}>{t.name}</span>
                  <span className={styles.listId}>#{t.id}</span>
                </button>
              ))}
            </div>
            <div className={styles.addWrap}>
              <button className={styles.addBtn} onClick={() => setAddOpen(o => !o)}>
                <Plus size={12} /> Add Packet
              </button>
              {addOpen && (
                <div className={styles.addMenu}>
                  {PROTOCOLS.map(p => (
                    <button key={p.key} className={styles.addMenuItem} onClick={() => handleAdd(p.key)}>
                      <span className={styles.listDot} style={{ background: p.color }} />
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: editor form */}
          <div className={styles.formCol}>
            {!selected ? (
              <div className={styles.empty}>Select or add a template to edit it.</div>
            ) : (
              <TemplateForm template={selected} patch={patch} onDelete={() => {
                removePacketTemplate(selected.id)
                const rest = list.filter(t => t.id !== selected.id)
                setSelectedId(rest[0]?.id ?? null)
              }} />
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Template form ─────────────────────────────────────────────────────────────

function TemplateForm({ template, patch, onDelete }: {
  template: PacketTemplate
  patch: (p: Partial<PacketTemplate>) => void
  onDelete: () => void
}) {
  return (
    <div className={styles.form}>
      <div className={styles.formHead}>
        <span className={styles.protoBadge} style={{ color: PROTOCOL_COLOR[template.protocol], borderColor: `${PROTOCOL_COLOR[template.protocol]}44`, background: `${PROTOCOL_COLOR[template.protocol]}11` }}>
          {template.protocol.toUpperCase()}
        </span>
        <span className={styles.formId}>ID {template.id}</span>
        <button className={styles.deleteBtn} onClick={onDelete} title="Delete template">
          <Trash2 size={12} />
        </button>
      </div>

      <Field label="Name">
        <input className={styles.input} value={template.name} onChange={e => patch({ name: e.target.value })} />
      </Field>

      <div className={styles.row2}>
        <Field label="Size (KB)">
          <input className={styles.input} type="number" min={0} step={0.5} value={template.sizeKb}
            onChange={e => patch({ sizeKb: Math.max(0, Number(e.target.value)) })} />
        </Field>
        <Field label="Color">
          <input className={styles.colorInput} type="color" value={template.colorOverride ?? PROTOCOL_COLOR[template.protocol]}
            onChange={e => patch({ colorOverride: e.target.value })} />
        </Field>
      </div>

      {template.protocol === 'http' && <HttpFields t={template} patch={patch} />}
      {template.protocol === 'event' && <EventFields t={template} patch={patch} />}
      {template.protocol === 'stream' && <StreamFields t={template} patch={patch} />}
      {template.protocol === 'db' && <DbFields t={template} patch={patch} />}
    </div>
  )
}

function HttpFields({ t, patch }: { t: HttpTemplate; patch: (p: Partial<PacketTemplate>) => void }) {
  return (
    <>
      <div className={styles.row2}>
        <Field label="Method">
          <select className={styles.input} value={t.method} onChange={e => patch({ method: e.target.value as HttpTemplate['method'] })}>
            <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
          </select>
        </Field>
        <Field label="Status code">
          <input className={styles.input} type="number" value={t.statusCode}
            onChange={e => patch({ statusCode: Number(e.target.value) })} />
        </Field>
      </div>
      <Field label="Path">
        <input className={styles.input} value={t.path} onChange={e => patch({ path: e.target.value })} />
      </Field>
      <div className={styles.note}>
        5xx → request dropped at target (retries + error pressure). 4xx → completes but counts as an error.
      </div>
    </>
  )
}

function EventFields({ t, patch }: { t: EventTemplate; patch: (p: Partial<PacketTemplate>) => void }) {
  return (
    <>
      <Field label="Topic">
        <input className={styles.input} value={t.topic} onChange={e => patch({ topic: e.target.value })} />
      </Field>
      <div className={styles.row2}>
        <Field label="Event type">
          <input className={styles.input} value={t.eventType} onChange={e => patch({ eventType: e.target.value })} />
        </Field>
        <Field label="Delivery">
          <select className={styles.input} value={t.deliveryMode} onChange={e => patch({ deliveryMode: e.target.value as EventTemplate['deliveryMode'] })}>
            <option value="at-most-once">at-most-once</option>
            <option value="at-least-once">at-least-once</option>
            <option value="exactly-once">exactly-once</option>
          </select>
        </Field>
      </div>
    </>
  )
}

function StreamFields({ t, patch }: { t: StreamTemplate; patch: (p: Partial<PacketTemplate>) => void }) {
  return (
    <div className={styles.row2}>
      <Field label="Stream ID">
        <input className={styles.input} value={t.streamId} onChange={e => patch({ streamId: e.target.value })} />
      </Field>
      <Field label="Compression">
        <select className={styles.input} value={t.compressionType} onChange={e => patch({ compressionType: e.target.value as StreamTemplate['compressionType'] })}>
          <option value="none">none</option>
          <option value="gzip">gzip</option>
          <option value="snappy">snappy</option>
        </select>
      </Field>
    </div>
  )
}

function DbFields({ t, patch }: { t: DbTemplate; patch: (p: Partial<PacketTemplate>) => void }) {
  return (
    <>
      <div className={styles.row2}>
        <Field label="Query type">
          <select className={styles.input} value={t.queryType} onChange={e => patch({ queryType: e.target.value as DbTemplate['queryType'] })}>
            <option value="read">read</option>
            <option value="write">write</option>
            <option value="transaction">transaction</option>
          </select>
        </Field>
        <Field label="Result (KB)">
          <input className={styles.input} type="number" min={0} step={0.5} value={t.resultSizeKb}
            onChange={e => patch({ resultSizeKb: Math.max(0, Number(e.target.value)) })} />
        </Field>
      </div>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={t.isWAL} onChange={e => patch({ isWAL: e.target.checked })} />
        Write-Ahead Logging (adds write latency)
      </label>
      <div className={styles.note}>
        Writes &amp; transactions consume the DB's write lane; result size drives the DB node's egress.
      </div>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  )
}
