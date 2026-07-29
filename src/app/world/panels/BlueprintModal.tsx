// src/app/world/panels/BlueprintModal.tsx
// Add/edit modal for service blueprints — the global, reusable service DEFINITION (name, kind,
// color, workload, ports, state, db config), as distinct from where it runs (placements).
//
// Shell is ManagedServiceModal.tsx's pattern, for the same reasons: portal, backdrop close,
// capture-phase Escape (so WorldShell's nav-level Escape doesn't also fire), a one-time store
// snapshot per open so the draft can't be clobbered mid-edit and one Save is one undo entry, and
// its OWN `<fieldset disabled={running}>` since createPortal escapes WorldPanel's.
//
// Dependencies are deliberately READ-ONLY here: a dependency is a relationship between two
// blueprints, and the Connections graph is where relationships are authored. This modal shows the
// count and links there rather than growing a second, weaker edge editor.
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import type { BlueprintKind, DbEngine, ServiceBlueprint } from '../../../lib/world/types'
import { SectionHeader, Segmented, Explainer } from '../ui/kit'

export interface BlueprintModalProps {
  open: boolean
  editingId: string | null
  onClose: () => void
  /** Opens the full-screen connections canvas — where dependencies are actually authored. */
  onOpenConnections: () => void
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

const KINDS: { key: BlueprintKind; label: string }[] = [
  { key: 'api', label: 'API' },
  { key: 'worker', label: 'Worker' },
  { key: 'db-sql', label: 'SQL DB' },
  { key: 'db-nosql', label: 'NoSQL DB' },
  { key: 'cache', label: 'Cache' },
]

// Numeric workload fields live as STRINGS while editing so a half-typed or cleared box doesn't
// snap to 0 under the user's cursor — same idiom as packetDraft/managedDraft.
interface BlueprintDraft {
  name: string
  kind: BlueprintKind
  color: string
  cpuMsPerRequest: string
  cpuMsPerKb: string
  ramBaseMb: string
  ramPerConnMb: string
  diskIoPerRequest: string
  cpuShares: string
  port: string
  visibility: 'public' | 'internal'
  stateful: boolean
  volumeName: string
  storageGb: string
  dbEngine: DbEngine
}

const num = (v: string, fallback = 0): number => {
  const n = Number(v)
  return v.trim() === '' || !Number.isFinite(n) ? fallback : n
}

const isDbKind = (kind: BlueprintKind): boolean => kind === 'db-sql' || kind === 'db-nosql'

function draftFrom(bp: ServiceBlueprint): BlueprintDraft {
  const port = bp.ports[0]
  return {
    name: bp.name,
    kind: bp.kind,
    color: bp.color,
    cpuMsPerRequest: String(bp.workload.cpuMsPerRequest),
    cpuMsPerKb: bp.workload.cpuMsPerKb == null ? '' : String(bp.workload.cpuMsPerKb),
    ramBaseMb: String(bp.workload.ramBaseMb),
    ramPerConnMb: String(bp.workload.ramPerConnMb),
    diskIoPerRequest: String(bp.workload.diskIoPerRequest),
    cpuShares: bp.workload.cpuShares == null ? '' : String(bp.workload.cpuShares),
    port: port ? String(port.port) : '8080',
    visibility: port?.visibility ?? 'internal',
    stateful: bp.stateful,
    volumeName: bp.volumeName ?? '',
    storageGb: String(bp.dbConfig?.storageGb ?? 100),
    dbEngine: bp.dbConfig?.engine ?? 'sql',
  }
}

export function BlueprintModal({ open, editingId, onClose, onOpenConnections }: BlueprintModalProps): ReactElement | null {
  const running = useSimulationStore(s => s.running)
  const [draft, setDraft] = useState<BlueprintDraft | null>(null)
  const [depCount, setDepCount] = useState(0)

  useEffect(() => {
    if (!open || editingId == null) return
    // One-time snapshot, NOT a subscription — see the module header.
    const bp = useWorldStore.getState().doc.blueprints[editingId]
    if (!bp) { onClose(); return }
    setDraft(draftFrom(bp))
    setDepCount(bp.dependencies.length)
  }, [open, editingId, onClose])

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

  if (!open || draft == null || editingId == null) return null

  const set = (patch: Partial<BlueprintDraft>) => setDraft(d => (d ? { ...d, ...patch } : d))
  const canSubmit = !running && draft.name.trim() !== ''

  const submit = (): void => {
    if (!canSubmit) return
    const portNum = Math.max(1, Math.min(65535, Math.round(num(draft.port, 8080))))
    useWorldStore.getState().updateBlueprint(editingId, {
      name: draft.name.trim(),
      kind: draft.kind,
      color: draft.color,
      workload: {
        cpuMsPerRequest: Math.max(0, num(draft.cpuMsPerRequest)),
        ramBaseMb: Math.max(0, num(draft.ramBaseMb)),
        ramPerConnMb: Math.max(0, num(draft.ramPerConnMb)),
        diskIoPerRequest: Math.max(0, num(draft.diskIoPerRequest)),
        // Blank ⇒ undefined, not 0: these are additive fields whose ABSENCE is the documented
        // pre-feature default (cpuShares 1, cpuMsPerKb 0). Writing 0 for cpuShares would be a
        // different, and wrong, thing to say.
        ...(draft.cpuShares.trim() === '' ? {} : { cpuShares: Math.max(0, num(draft.cpuShares)) }),
        ...(draft.cpuMsPerKb.trim() === '' ? {} : { cpuMsPerKb: Math.max(0, num(draft.cpuMsPerKb)) }),
      },
      ports: [{ port: portNum, protocol: 'tcp', visibility: draft.visibility }],
      stateful: draft.stateful,
      volumeName: draft.stateful ? (draft.volumeName.trim() || `${draft.name.trim()}-data`) : null,
      dbConfig: isDbKind(draft.kind)
        ? { engine: draft.kind === 'db-sql' ? 'sql' : 'nosql', storageGb: Math.max(0, num(draft.storageGb, 100)) }
        : null,
    })
    onClose()
  }

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>Edit service blueprint</span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
          <SectionHeader label="▸ IDENTITY" />
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="bp-name" style={rowLabel}>name</label>
              <input id="bp-name" aria-label="name" style={field} value={draft.name}
                onChange={e => set({ name: e.target.value })} />
            </div>
            <div style={{ flex: '0 0 60px' }}>
              <label htmlFor="bp-color" style={rowLabel}>color</label>
              <input id="bp-color" aria-label="color" type="color" style={{ ...field, padding: 0, height: 22 }}
                value={draft.color} onChange={e => set({ color: e.target.value })} />
            </div>
          </div>
          <div style={rowGap}>
            <label htmlFor="bp-kind" style={rowLabel}>kind</label>
            <select id="bp-kind" aria-label="kind" style={field} value={draft.kind}
              onChange={e => set({ kind: e.target.value as BlueprintKind })}>
              {KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <Explainer>db kinds route writes to the primary and reads to replicas; others fan out evenly</Explainer>
          </div>

          <SectionHeader label="▸ WORKLOAD" />
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="bp-cpu-req" style={rowLabel}>cpu ms / request</label>
              <input id="bp-cpu-req" aria-label="cpu per request" type="number" min={0} style={field}
                value={draft.cpuMsPerRequest} onChange={e => set({ cpuMsPerRequest: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="bp-cpu-kb" style={rowLabel}>cpu ms / KB</label>
              <input id="bp-cpu-kb" aria-label="cpu per kb" type="number" min={0} step={0.1} style={field}
                placeholder="0" value={draft.cpuMsPerKb} onChange={e => set({ cpuMsPerKb: e.target.value })} />
            </div>
            <div style={{ flex: '0 0 76px' }}>
              <label htmlFor="bp-shares" style={rowLabel}>cpu shares</label>
              <input id="bp-shares" aria-label="cpu shares" type="number" min={0} style={field}
                placeholder="1" value={draft.cpuShares} onChange={e => set({ cpuShares: e.target.value })} />
            </div>
          </div>
          <Explainer>cpu/KB is what makes a fat packet cost more than a thin one on the same route</Explainer>
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="bp-ram-base" style={rowLabel}>ram base MB</label>
              <input id="bp-ram-base" aria-label="ram base" type="number" min={0} style={field}
                value={draft.ramBaseMb} onChange={e => set({ ramBaseMb: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="bp-ram-conn" style={rowLabel}>ram / conn MB</label>
              <input id="bp-ram-conn" aria-label="ram per connection" type="number" min={0} style={field}
                value={draft.ramPerConnMb} onChange={e => set({ ramPerConnMb: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="bp-disk" style={rowLabel}>disk io / req</label>
              <input id="bp-disk" aria-label="disk io per request" type="number" min={0} style={field}
                value={draft.diskIoPerRequest} onChange={e => set({ diskIoPerRequest: e.target.value })} />
            </div>
          </div>

          <SectionHeader label="▸ PORTS" />
          <div style={{ display: 'flex', gap: 6, ...rowGap }}>
            <div style={{ flex: '0 0 90px' }}>
              <label htmlFor="bp-port" style={rowLabel}>port</label>
              <input id="bp-port" aria-label="port" type="number" style={field}
                value={draft.port} onChange={e => set({ port: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={rowLabel}>visibility</label>
              <Segmented
                ariaLabel="visibility" value={draft.visibility}
                onChange={v => set({ visibility: v })}
                options={[{ value: 'internal', label: 'internal' }, { value: 'public', label: 'public' }]}
              />
            </div>
          </div>
          <Explainer>public makes this an ingress target — clients can reach it through the region LB</Explainer>

          <SectionHeader label="▸ STATE" />
          <div style={rowGap}>
            <label htmlFor="bp-stateful" style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}>
              <input id="bp-stateful" type="checkbox" aria-label="stateful"
                checked={draft.stateful} onChange={e => set({ stateful: e.target.checked })} />
              stateful
            </label>
          </div>
          {draft.stateful && (
            <div style={rowGap}>
              <label htmlFor="bp-volume" style={rowLabel}>volume name</label>
              <input id="bp-volume" aria-label="volume name" style={field} placeholder={`${draft.name.trim()}-data`}
                value={draft.volumeName} onChange={e => set({ volumeName: e.target.value })} />
            </div>
          )}

          {isDbKind(draft.kind) && (
            <>
              <SectionHeader label="▸ DATABASE" />
              <div style={rowGap}>
                <label htmlFor="bp-storage" style={rowLabel}>storage GB</label>
                <input id="bp-storage" aria-label="storage gb" type="number" min={0} style={field}
                  value={draft.storageGb} onChange={e => set({ storageGb: e.target.value })} />
              </div>
              <Explainer>engine follows the kind — SQL is single-writer, NoSQL fans writes out</Explainer>
            </>
          )}
        </fieldset>

        <SectionHeader label={`▸ CONNECTIONS (${depCount})`} />
        <Explainer>
          {depCount === 0
            ? 'this service calls nothing yet'
            : `this service calls ${depCount} other${depCount === 1 ? '' : 's'}`} — dependencies are
          authored in the connections graph, where you can also bind the packets each edge carries
        </Explainer>
        <button
          type="button" className="kit-press" style={smallBtnStyle} aria-label="open connections graph"
          onClick={() => { onClose(); onOpenConnections() }}
        >
          open connections graph ↗
        </button>

        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button
            type="button" className="kit-press" style={canSubmit ? btn : btnLocked}
            disabled={!canSubmit}
            title={running ? 'stop the simulation to edit' : undefined}
            onClick={submit}
          >
            Save
          </button>
          <button type="button" className="kit-press" style={btn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
