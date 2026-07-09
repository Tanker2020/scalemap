import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X, Plus, Trash2, Package, Sparkles } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulationLegacy.store'
import { useUiStore } from '../store/ui.store'
import type {
  PacketProtocol, PacketTemplate, NewPacketTemplate, HttpTemplate, EventTemplate, StreamTemplate, DbTemplate,
} from '../../lib/nodeConfig'
import { WORKLOAD_TIER_RANGES, resolveWorkloadInstructions, type WorkloadDemand } from '../../lib/nodeConfig'
import { DEFAULT_PACKET_WORKLOAD } from './defaults'
import styles from './PacketEditor.module.css'

// Harmonized with theme.ts's CATEGORY_COLORS hue families (compute=blue, network=teal,
// messaging=purple, storage=amber) with a light-mode variant each. Fixes a staleness bug in the
// prior implementation: PROTOCOL_COLOR hardcoded the pre-harmonization palette (#4A9EFF/#2DD4BF/
// #A78BFA/#F5A623) with no light-mode counterpart at all, so protocol badges/dots never adapted
// to the theme toggle and drifted from the rest of the app's harmonized hues.
const PROTOCOL_COLOR: Record<PacketProtocol, { dark: string; light: string }> = {
  http:   { dark: '#5B9CF6', light: '#3F6DAC' },
  event:  { dark: '#3FC7B8', light: '#288177' },
  stream: { dark: '#9C8CE0', light: '#6D629C' },
  db:     { dark: '#E0A552', light: '#916B35' },
}

const PROTOCOLS: { key: PacketProtocol; label: string; blurb: string }[] = [
  { key: 'http',   label: 'HTTP',   blurb: 'Request / response' },
  { key: 'event',  label: 'Event',  blurb: 'Fire and forget' },
  { key: 'stream', label: 'Stream', blurb: 'Continuous record' },
  { key: 'db',     label: 'DB',     blurb: 'Query / result' },
]

function protocolColor(protocol: PacketProtocol, mode: 'dark' | 'light'): string {
  return PROTOCOL_COLOR[protocol][mode]
}

// Sensible starting values per protocol so a new template is immediately valid.
function defaultTemplate(protocol: PacketProtocol): NewPacketTemplate {
  const workload = DEFAULT_PACKET_WORKLOAD
  switch (protocol) {
    case 'http':   return { name: 'New HTTP request', protocol, sizeKb: 2, method: 'GET', path: '/api/v1/resource', statusCode: 200, workload }
    case 'event':  return { name: 'New event', protocol, sizeKb: 1, topic: 'domain.events', eventType: 'created', deliveryMode: 'at-least-once', workload }
    case 'stream': return { name: 'New stream record', protocol, sizeKb: 4, streamId: 'stream-1', compressionType: 'none', workload }
    case 'db':     return { name: 'New query', protocol, sizeKb: 1, queryType: 'read', isWAL: false, resultSizeKb: 8, workload }
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
  const themeMode = useUiStore(s => s.themeMode)
  const running = useSimulationStore(s => s.running)
  const reduceMotion = useReducedMotion()

  const list = Object.values(templates).sort((a, b) => a.id - b.id)
  const [selectedId, setSelectedId] = useState<number | null>(list[0]?.id ?? null)
  const [addOpen, setAddOpen] = useState(false)

  const selected = selectedId !== null ? templates[selectedId] : undefined
  const mode: 'dark' | 'light' = themeMode === 'light' ? 'light' : 'dark'

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
          <fieldset disabled={running} className={styles.bareFieldset}>
            <div className={styles.modeToggle}>
              <button
                className={styles.modeBtn}
                data-active={packetMode === 'generic'}
                onClick={() => setPacketMode('generic')}
                title="Uniform particles sized by each node's avg response — templates ignored"
              >
                Generic
              </button>
              <button
                className={styles.modeBtn}
                data-active={packetMode === 'custom'}
                onClick={() => setPacketMode('custom')}
                title="Templates + per-node distribution drive the simulation"
              >
                Custom
              </button>
              <motion.div
                className={styles.modeSlider}
                layout
                data-slot={packetMode}
                transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 35 }}
              />
            </div>
          </fieldset>
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
          {/* Left: template manifest */}
          <div className={styles.listCol}>
            <div className={styles.listScroll}>
              {list.length === 0 && (
                <div className={styles.empty}>No templates yet. Add one to get started.</div>
              )}
              {list.map(t => {
                const c = t.colorOverride ?? protocolColor(t.protocol, mode)
                return (
                  <button
                    key={t.id}
                    className={styles.listItem}
                    data-active={selectedId === t.id}
                    style={{ '--proto-color': c } as React.CSSProperties}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <span className={styles.listDot} data-pulse={selectedId === t.id && !reduceMotion} />
                    <span className={styles.listName}>{t.name}</span>
                    <span className={styles.listId}>#{t.id}</span>
                  </button>
                )
              })}
            </div>
            <fieldset disabled={running} className={styles.bareFieldset}>
              <div className={styles.addWrap}>
                <button className={styles.addBtn} onClick={() => setAddOpen(o => !o)}>
                  <Plus size={12} /> Add Packet
                </button>
                <AnimatePresence>
                  {addOpen && (
                    <motion.div
                      className={styles.addMenu}
                      initial={{ opacity: 0, y: 6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.98 }}
                      transition={{ duration: reduceMotion ? 0 : 0.14, ease: 'easeOut' }}
                    >
                      {PROTOCOLS.map(p => {
                        const c = protocolColor(p.key, mode)
                        return (
                          <button
                            key={p.key}
                            className={styles.addMenuItem}
                            style={{ '--proto-color': c } as React.CSSProperties}
                            onClick={() => handleAdd(p.key)}
                          >
                            <span className={styles.addMenuBadge}>{p.label}</span>
                            <span className={styles.addMenuBlurb}>{p.blurb}</span>
                          </button>
                        )
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </fieldset>
          </div>

          {/* Right: packet anatomy card */}
          <fieldset disabled={running} className={styles.bareFieldset}>
            <div className={styles.formCol}>
              <AnimatePresence mode="wait">
                {!selected ? (
                  <motion.div
                    key="empty"
                    className={styles.empty}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    Select or add a template to inspect it.
                  </motion.div>
                ) : (
                  <PacketCard
                    key={selected.id}
                    template={selected}
                    color={selected.colorOverride ?? protocolColor(selected.protocol, mode)}
                    reduceMotion={!!reduceMotion}
                    patch={patch}
                    onDelete={() => {
                      removePacketTemplate(selected.id)
                      const rest = list.filter(t => t.id !== selected.id)
                      setSelectedId(rest[0]?.id ?? null)
                    }}
                  />
                )}
              </AnimatePresence>
            </div>
          </fieldset>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ─── Packet anatomy card ───────────────────────────────────────────────────────
// The core redesign: a packet renders as a physical, layered object rather than a plain form.
// Header strip (identity) -> payload body (size, draggable to resize) -> protocol "pins"
// (click-to-flip fields, like inspecting connectors on a chip) rather than plain labeled inputs.

function PacketCard({ template, color, reduceMotion, patch, onDelete }: {
  template: PacketTemplate
  color: string
  reduceMotion: boolean
  patch: (p: Partial<PacketTemplate>) => void
  onDelete: () => void
}) {
  const [shredding, setShredding] = useState(false)

  const handleDelete = () => {
    if (reduceMotion) { onDelete(); return }
    setShredding(true)
    window.setTimeout(onDelete, 260)
  }

  return (
    <motion.div
      className={styles.card}
      style={{ '--proto-color': color } as React.CSSProperties}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
      animate={shredding
        ? { opacity: 0, scaleY: 0.2, filter: 'blur(2px)' }
        : (reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 })}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
    >
      {/* Header strip */}
      <div className={styles.cardHeader}>
        <span className={styles.protoBadge}>{template.protocol.toUpperCase()}</span>
        <input
          className={styles.nameInput}
          value={template.name}
          onChange={e => patch({ name: e.target.value })}
          aria-label="Template name"
        />
        <span className={styles.formId}>#{template.id}</span>
        <button className={styles.deleteBtn} onClick={handleDelete} title="Delete template">
          <Trash2 size={12} />
        </button>
      </div>

      {/* Payload body — width reflects sizeKb, draggable to resize */}
      <PayloadBody sizeKb={template.sizeKb} color={template.colorOverride ?? color} reduceMotion={reduceMotion}
        onSizeChange={kb => patch({ sizeKb: kb })}
        onColorChange={hex => patch({ colorOverride: hex })} />

      {/* Protocol-specific connector pins */}
      <div className={styles.pinRow}>
        {template.protocol === 'http' && <HttpPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'event' && <EventPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'stream' && <StreamPins t={template} patch={patch} reduceMotion={reduceMotion} />}
        {template.protocol === 'db' && <DbPins t={template} patch={patch} reduceMotion={reduceMotion} />}
      </div>

      {/* Compute workload — shared across every protocol (BasePacketTemplate.workload) */}
      <div className={styles.pinRow}>
        <WorkloadPins t={template} patch={patch} reduceMotion={reduceMotion} />
      </div>

      {template.protocol === 'http' && (
        <div className={styles.note}>5xx → request dropped at target (retries + error pressure). 4xx → completes but counts as an error.</div>
      )}
      {template.protocol === 'db' && (
        <div className={styles.note}>Writes &amp; transactions consume the DB's write lane; result size drives the DB node's egress.</div>
      )}
    </motion.div>
  )
}

// Payload block: visual width communicates sizeKb (log-scaled, clamped for legibility), draggable
// left/right to resize, click to reveal exact KB + color swatches. This is the "gamified"
// centerpiece — dragging the body to stretch/shrink the payload feels tactile rather than typing
// into a number field, while a numeric input stays available for precision entry.
function PayloadBody({ sizeKb, color, reduceMotion, onSizeChange, onColorChange }: {
  sizeKb: number
  color: string
  reduceMotion: boolean
  onSizeChange: (kb: number) => void
  onColorChange: (hex: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Log scale so 0.1KB..~500KB all produce a legible bar width between ~8% and 100%.
  const pct = Math.min(100, Math.max(8, 8 + Math.log2(Math.max(sizeKb, 0.1) + 1) * 14))

  const handleDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = e.currentTarget
    track.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      // Inverse of the log-scale pct mapping above, clamped to a sane packet-size range.
      const kb = Math.max(0.1, Math.round((Math.pow(2, (ratio * 92) / 14) - 1) * 10) / 10)
      onSizeChange(kb)
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const swatches = ['#5B9CF6', '#3FC7B8', '#9C8CE0', '#E0A552', '#EF4444', '#22C55E']

  return (
    <div className={styles.payloadWrap}>
      <div className={styles.payloadLabelRow}>
        <span className={styles.fieldLabel}>Payload</span>
        <span className={styles.payloadKb}>{sizeKb} KB</span>
      </div>
      <div
        className={styles.payloadTrack}
        onPointerDown={handleDrag}
        onClick={() => setOpen(o => !o)}
        role="slider"
        aria-label="Payload size"
        aria-valuenow={sizeKb}
        title="Drag to resize, click to fine-tune"
      >
        <motion.div
          className={styles.payloadFill}
          style={{ background: color }}
          animate={{ width: `${pct}%` }}
          transition={dragging || reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 30 }}
          data-dragging={dragging}
        >
          <span className={styles.payloadTexture} data-static={reduceMotion} />
        </motion.div>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            className={styles.payloadDetail}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15 }}
          >
            <input
              className={styles.input}
              type="number"
              min={0.1}
              step={0.1}
              value={sizeKb}
              onChange={e => onSizeChange(Math.max(0.1, Number(e.target.value)))}
            />
            <div className={styles.swatchRow}>
              {swatches.map(sw => (
                <button
                  key={sw}
                  className={styles.swatch}
                  data-active={color.toLowerCase() === sw.toLowerCase()}
                  style={{ background: sw }}
                  onClick={() => onColorChange(sw)}
                  title={sw}
                />
              ))}
              <input
                className={styles.swatchCustom}
                type="color"
                value={color}
                onChange={e => onColorChange(e.target.value)}
                title="Custom color"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// A single click-to-flip connector pin. Front shows the current value as a compact chip; clicking
// flips it (3D rotateY via framer-motion, cross-fade under reduced motion) to reveal the editable
// control. Deliberately generic over the control it hosts (select/input/checkbox).
function Pin({ label, valueLabel, editing, onToggle, reduceMotion, children }: {
  label: string
  valueLabel: string
  editing: boolean
  onToggle: () => void
  reduceMotion: boolean
  children: React.ReactNode
}) {
  return (
    <div className={styles.pin}>
      <span className={styles.pinLabel}>{label}</span>
      <div className={styles.pinFlip} data-editing={editing}>
        <AnimatePresence mode="wait" initial={false}>
          {!editing ? (
            <motion.button
              key="face"
              type="button"
              className={styles.pinFace}
              onClick={onToggle}
              initial={reduceMotion ? { opacity: 0 } : { rotateY: -90, opacity: 0 }}
              animate={reduceMotion ? { opacity: 1 } : { rotateY: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { rotateY: 90, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.16 }}
            >
              {valueLabel}
            </motion.button>
          ) : (
            <motion.div
              key="edit"
              className={styles.pinEdit}
              initial={reduceMotion ? { opacity: 0 } : { rotateY: 90, opacity: 0 }}
              animate={reduceMotion ? { opacity: 1 } : { rotateY: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { rotateY: -90, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.16 }}
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) onToggle()
              }}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function usePinState() {
  const [openPin, setOpenPin] = useState<string | null>(null)
  return {
    isOpen: (key: string) => openPin === key,
    toggle: (key: string) => setOpenPin(p => (p === key ? null : key)),
  }
}

function HttpPins({ t, patch, reduceMotion }: { t: HttpTemplate; patch: (p: Partial<PacketTemplate>) => void; reduceMotion: boolean }) {
  const pin = usePinState()
  return (
    <>
      <Pin label="Method" valueLabel={t.method} editing={pin.isOpen('method')} onToggle={() => pin.toggle('method')} reduceMotion={reduceMotion}>
        <select className={styles.input} autoFocus value={t.method} onChange={e => { patch({ method: e.target.value as HttpTemplate['method'] }); pin.toggle('method') }}>
          <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option>
        </select>
      </Pin>
      <Pin label="Status" valueLabel={String(t.statusCode)} editing={pin.isOpen('status')} onToggle={() => pin.toggle('status')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={100} max={599} value={t.statusCode}
          onChange={e => patch({ statusCode: Math.min(599, Math.max(100, Number(e.target.value) || 100)) })} />
      </Pin>
      <Pin label="Path" valueLabel={t.path} editing={pin.isOpen('path')} onToggle={() => pin.toggle('path')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus value={t.path} onChange={e => patch({ path: e.target.value })} />
      </Pin>
    </>
  )
}

function EventPins({ t, patch, reduceMotion }: { t: EventTemplate; patch: (p: Partial<PacketTemplate>) => void; reduceMotion: boolean }) {
  const pin = usePinState()
  return (
    <>
      <Pin label="Topic" valueLabel={t.topic} editing={pin.isOpen('topic')} onToggle={() => pin.toggle('topic')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus value={t.topic} onChange={e => patch({ topic: e.target.value })} />
      </Pin>
      <Pin label="Type" valueLabel={t.eventType} editing={pin.isOpen('type')} onToggle={() => pin.toggle('type')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus value={t.eventType} onChange={e => patch({ eventType: e.target.value })} />
      </Pin>
      <Pin label="Delivery" valueLabel={t.deliveryMode} editing={pin.isOpen('delivery')} onToggle={() => pin.toggle('delivery')} reduceMotion={reduceMotion}>
        <select className={styles.input} autoFocus value={t.deliveryMode} onChange={e => { patch({ deliveryMode: e.target.value as EventTemplate['deliveryMode'] }); pin.toggle('delivery') }}>
          <option value="at-most-once">at-most-once</option>
          <option value="at-least-once">at-least-once</option>
          <option value="exactly-once">exactly-once</option>
        </select>
      </Pin>
    </>
  )
}

function StreamPins({ t, patch, reduceMotion }: { t: StreamTemplate; patch: (p: Partial<PacketTemplate>) => void; reduceMotion: boolean }) {
  const pin = usePinState()
  return (
    <>
      <Pin label="Stream ID" valueLabel={t.streamId} editing={pin.isOpen('stream')} onToggle={() => pin.toggle('stream')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus value={t.streamId} onChange={e => patch({ streamId: e.target.value })} />
      </Pin>
      <Pin label="Compression" valueLabel={t.compressionType} editing={pin.isOpen('compression')} onToggle={() => pin.toggle('compression')} reduceMotion={reduceMotion}>
        <select className={styles.input} autoFocus value={t.compressionType} onChange={e => { patch({ compressionType: e.target.value as StreamTemplate['compressionType'] }); pin.toggle('compression') }}>
          <option value="none">none</option>
          <option value="gzip">gzip</option>
          <option value="snappy">snappy</option>
        </select>
      </Pin>
    </>
  )
}

function DbPins({ t, patch, reduceMotion }: { t: DbTemplate; patch: (p: Partial<PacketTemplate>) => void; reduceMotion: boolean }) {
  const pin = usePinState()
  return (
    <>
      <Pin label="Query" valueLabel={t.queryType} editing={pin.isOpen('query')} onToggle={() => pin.toggle('query')} reduceMotion={reduceMotion}>
        <select className={styles.input} autoFocus value={t.queryType} onChange={e => { patch({ queryType: e.target.value as DbTemplate['queryType'] }); pin.toggle('query') }}>
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="transaction">transaction</option>
        </select>
      </Pin>
      <Pin label="Result" valueLabel={`${t.resultSizeKb} KB`} editing={pin.isOpen('result')} onToggle={() => pin.toggle('result')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={0} step={0.5} value={t.resultSizeKb}
          onChange={e => patch({ resultSizeKb: Math.max(0, Number(e.target.value)) })} />
      </Pin>
      <button
        className={styles.walToggle}
        data-active={t.isWAL}
        onClick={() => patch({ isWAL: !t.isWAL })}
        title="Write-Ahead Logging — adds write latency"
      >
        <Sparkles size={11} /> WAL {t.isWAL ? 'on' : 'off'}
      </button>
    </>
  )
}

function WorkloadPins({ t, patch, reduceMotion }: { t: PacketTemplate; patch: (p: Partial<PacketTemplate>) => void; reduceMotion: boolean }) {
  const pin = usePinState()
  const workload = t.workload ?? DEFAULT_PACKET_WORKLOAD
  const setWorkload = (w: Partial<WorkloadDemand>) => patch({ workload: { ...workload, ...w } })
  return (
    <>
      <Pin label="Tier" valueLabel={workload.tier} editing={pin.isOpen('tier')} onToggle={() => pin.toggle('tier')} reduceMotion={reduceMotion}>
        <select className={styles.input} autoFocus value={workload.tier} onChange={e => {
          const tier = e.target.value as WorkloadDemand['tier']
          const next = tier === 'custom' ? workload.cpuInstructionsBillions : WORKLOAD_TIER_RANGES[tier].default
          setWorkload({ tier, cpuInstructionsBillions: resolveWorkloadInstructions(tier, next) })
          pin.toggle('tier')
        }}>
          <option value="simple_crud">simple_crud</option>
          <option value="moderate_logic">moderate_logic</option>
          <option value="heavy_compute">heavy_compute</option>
          <option value="custom">custom</option>
        </select>
      </Pin>
      <Pin label="Instr (B)" valueLabel={String(workload.cpuInstructionsBillions)} editing={pin.isOpen('instr')} onToggle={() => pin.toggle('instr')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={0} step={workload.tier === 'heavy_compute' || workload.tier === 'custom' ? 0.1 : 0.001}
          value={workload.cpuInstructionsBillions}
          onChange={e => setWorkload({ cpuInstructionsBillions: resolveWorkloadInstructions(workload.tier, Number(e.target.value) || 0) })} />
      </Pin>
      <Pin label="Mem/req (MB)" valueLabel={String(workload.memoryFootprintMb)} editing={pin.isOpen('mem')} onToggle={() => pin.toggle('mem')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={1} step={4}
          value={workload.memoryFootprintMb}
          onChange={e => setWorkload({ memoryFootprintMb: Math.max(1, Number(e.target.value) || 1) })} />
      </Pin>
      <Pin label="IO-bound (%)" valueLabel={String(Math.round(workload.ioBoundFraction * 100))} editing={pin.isOpen('io')} onToggle={() => pin.toggle('io')} reduceMotion={reduceMotion}>
        <input className={styles.input} autoFocus type="number" min={0} max={99} step={5}
          value={Math.round(workload.ioBoundFraction * 100)}
          onChange={e => setWorkload({ ioBoundFraction: Math.min(0.99, Math.max(0, (Number(e.target.value) || 0) / 100)) })} />
      </Pin>
    </>
  )
}
