// src/app/world/dock/drawers/AddServiceForm.tsx
// The "VPS door": author a NEW service from the host you want it to run on.
//
// Standing up a service used to take three surfaces — create an abstract blueprint in the
// world-scope Blueprints tab, fill in four raw physics numbers, then attach it to a host from
// Placements. There was no path that began at "I want a service on this box". This form is that
// path: one dialog that creates the global service record AND places it here.
//
// The host is a DOOR, not an owner. The record it writes is a normal global ServiceBlueprint with
// `ownerServerKind: null`, so the service can afterwards be spread across AZs, mounted on other
// hosts, or edited from any surface. (Only appliance boxes stamp ownerServerKind, which is what
// locks a database to its own box.)
import { useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import {
  defaultDraft, draftWorkload, HOSTABLE_KINDS, COST_MS, MEMORY_MB,
  type CostPreset, type HostableKind, type MemoryPreset, type ServiceDraft,
} from '../../../../lib/world/serviceDraft'
import type { WorkloadProfile } from '../../../../lib/world/types'

const KIND_LABEL: Record<HostableKind, string> = {
  api: 'API — serves requests',
  worker: 'Worker — pulls work from a queue',
  cache: 'Cache — in-memory, cheap per hit',
}

const COST_LABEL: Record<CostPreset, string> = { light: 'Light', medium: 'Medium', heavy: 'Heavy' }

// Memory options are labelled by their actual size rather than small/medium/large: it is more
// informative, and it keeps their accessible names from colliding with the cost presets (both
// sets would otherwise contain a control called "medium").
const MEMORY_LABEL: Record<MemoryPreset, string> = { small: '512 MB', medium: '2 GB', large: '8 GB' }

const field: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '3px 6px', color: 'var(--color-text-primary)', width: '100%',
}

const btn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 10px',
  color: 'var(--color-text-secondary)', cursor: 'pointer',
}

const btnLocked: CSSProperties = { ...btn, opacity: 0.35, cursor: 'default' }
const rowLabel: CSSProperties = { color: 'var(--color-text-muted)', display: 'block', marginBottom: 2 }
const rowGap: CSSProperties = { marginBottom: 7 }

export interface AddServiceFormProps {
  serverId: string
  running: boolean
  onDone: () => void
}

export function AddServiceForm({ serverId, running, onDone }: AddServiceFormProps): ReactElement {
  const [draft, setDraft] = useState<ServiceDraft>(() => defaultDraft('api'))
  const [advanced, setAdvanced] = useState(false)
  // null ⇒ "follow the presets". Set by editing an Advanced field; CLEARED by picking a preset,
  // so whichever the user touched last is what gets written. Without that reset, choosing a preset
  // after hand-tuning would silently do nothing and the preset buttons would look broken.
  const [override, setOverride] = useState<WorkloadProfile | null>(null)

  const effectiveWorkload = override ?? draftWorkload(draft.kind, draft.cost, draft.memory)

  // Switching kind re-bases the whole draft (a worker has no port, a cache is memory-heavy), and
  // drops any override: the numbers you tuned were for a different shape of service.
  const pickKind = (kind: HostableKind): void => {
    setDraft(d => ({ ...defaultDraft(kind), name: d.name }))
    setOverride(null)
  }

  const pickCost = (cost: CostPreset): void => {
    setDraft(d => ({ ...d, cost }))
    setOverride(null)
  }

  const pickMemory = (memory: MemoryPreset): void => {
    setDraft(d => ({ ...d, memory }))
    setOverride(null)
  }

  const tune = (patch: Partial<WorkloadProfile>): void =>
    setOverride({ ...effectiveWorkload, ...patch })

  const submit = (): void => {
    if (running || draft.name.trim() === '') return
    useWorldStore.getState().addServiceToServer(serverId, {
      ...draft, name: draft.name.trim(), workload: effectiveWorkload,
    })
    onDone()
  }

  const canSubmit = !running && draft.name.trim() !== ''

  return (
    <div style={{ font: '10px var(--font-mono)', padding: '6px 2px' }}>
      <div style={rowGap}>
        <label htmlFor="svc-name" style={rowLabel}>service name</label>
        <input
          id="svc-name" aria-label="service name" style={field} value={draft.name}
          placeholder="orders-api" disabled={running}
          onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
        />
      </div>

      <div style={rowGap}>
        <label htmlFor="svc-kind" style={rowLabel}>service kind</label>
        <select
          id="svc-kind" aria-label="service kind" style={field} value={draft.kind} disabled={running}
          onChange={e => pickKind(e.target.value as HostableKind)}
        >
          {HOSTABLE_KINDS.map(kind => (
            <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>
          ))}
        </select>
      </div>

      <fieldset style={{ border: 'none', margin: 0, padding: 0, ...rowGap }}>
        <legend style={rowLabel}>request cost</legend>
        <div style={{ display: 'flex', gap: 8 }}>
          {(Object.keys(COST_LABEL) as CostPreset[]).map(cost => (
            <label key={cost} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="radio" name="svc-cost" aria-label={COST_LABEL[cost]}
                checked={draft.cost === cost} disabled={running}
                onChange={() => pickCost(cost)}
              />
              <span style={{ color: 'var(--color-text-primary)' }}>{COST_LABEL[cost]}</span>
            </label>
          ))}
        </div>
        <span style={{ color: 'var(--color-text-muted)' }}>~{COST_MS[draft.cost]} ms CPU per request</span>
      </fieldset>

      <fieldset style={{ border: 'none', margin: 0, padding: 0, ...rowGap }}>
        <legend style={rowLabel}>memory</legend>
        <div style={{ display: 'flex', gap: 8 }}>
          {(Object.keys(MEMORY_LABEL) as MemoryPreset[]).map(memory => (
            <label key={memory} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="radio" name="svc-memory" aria-label={MEMORY_LABEL[memory]}
                checked={draft.memory === memory} disabled={running}
                onChange={() => pickMemory(memory)}
              />
              <span style={{ color: 'var(--color-text-primary)' }}>{MEMORY_LABEL[memory]}</span>
            </label>
          ))}
        </div>
        <span style={{ color: 'var(--color-text-muted)' }}>
          + {MEMORY_MB[draft.memory].perConn} MB per connection
        </span>
      </fieldset>

      {/* A worker binds nothing inbound, so it is asked nothing about ports. */}
      {draft.port !== null && (
        <div style={{ display: 'flex', gap: 6, ...rowGap }}>
          <div style={{ flex: '0 0 70px' }}>
            <label htmlFor="svc-port" style={rowLabel}>port</label>
            <input
              id="svc-port" aria-label="port" type="number" style={field} value={draft.port} disabled={running}
              onChange={e => setDraft(d => ({ ...d, port: Number(e.target.value) }))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="svc-vis" style={rowLabel}>reachable from</label>
            <select
              id="svc-vis" aria-label="visibility" style={field} value={draft.visibility} disabled={running}
              onChange={e => setDraft(d => ({ ...d, visibility: e.target.value as 'public' | 'internal' }))}
            >
              <option value="internal">internal only</option>
              <option value="public">the internet</option>
            </select>
          </div>
        </div>
      )}

      <button
        type="button" className="kit-press" style={{ ...btn, marginBottom: 6 }}
        aria-expanded={advanced} onClick={() => setAdvanced(a => !a)}
      >
        {advanced ? '▾' : '▸'} advanced
      </button>

      {advanced && (
        <div style={{ ...rowGap, paddingLeft: 8, borderLeft: '1px solid var(--color-node-border)' }}>
          <div style={rowGap}>
            <label htmlFor="adv-cpu" style={rowLabel}>cpu / request (ms)</label>
            <input
              id="adv-cpu" aria-label="cpu / request" type="number" style={field} disabled={running}
              value={effectiveWorkload.cpuMsPerRequest}
              onChange={e => tune({ cpuMsPerRequest: Number(e.target.value) })}
            />
          </div>
          <div style={rowGap}>
            <label htmlFor="adv-cpukb" style={rowLabel}>cpu / KB (ms)</label>
            <input
              id="adv-cpukb" aria-label="cpu / KB" type="number" style={field} disabled={running}
              value={effectiveWorkload.cpuMsPerKb ?? 0}
              onChange={e => tune({ cpuMsPerKb: Number(e.target.value) })}
            />
          </div>
          <div style={rowGap}>
            <label htmlFor="adv-rambase" style={rowLabel}>ram base (MB)</label>
            <input
              id="adv-rambase" aria-label="ram base" type="number" style={field} disabled={running}
              value={effectiveWorkload.ramBaseMb}
              onChange={e => tune({ ramBaseMb: Number(e.target.value) })}
            />
          </div>
          <div style={rowGap}>
            <label htmlFor="adv-ramconn" style={rowLabel}>ram / connection (MB)</label>
            <input
              id="adv-ramconn" aria-label="ram per connection" type="number" style={field} disabled={running}
              value={effectiveWorkload.ramPerConnMb}
              onChange={e => tune({ ramPerConnMb: Number(e.target.value) })}
            />
          </div>
          <div>
            <label htmlFor="adv-disk" style={rowLabel}>disk io / request</label>
            <input
              id="adv-disk" aria-label="disk io per request" type="number" style={field} disabled={running}
              value={effectiveWorkload.diskIoPerRequest}
              onChange={e => tune({ diskIoPerRequest: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button
          type="button" className="kit-press" style={canSubmit ? btn : btnLocked}
          disabled={!canSubmit}
          title={running ? 'stop the simulation to edit' : undefined}
          onClick={submit}
        >
          add service
        </button>
        <button type="button" className="kit-press" style={btn} onClick={onDone}>cancel</button>
      </div>
    </div>
  )
}
