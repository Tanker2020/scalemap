// src/app/world/panels/PartitionsSection.tsx
// FEAT-002 Task 14: the partition-authoring surface — mounted inside RegionConfigTab.tsx as a
// sibling section (spec: "lives alongside the region-scope config, not as a new top-level tab"),
// not gated behind the AZ-count conditional that only applies to the LB section above it.
//
// Endpoints are authored as a scope (region/az/server/internet) + an id picker scoped to the
// world's actual entities — mirrors LinkEndpoint's shape (worldEngine/types.ts) exactly, so
// `toEndpoint` below is a pure 1:1 mapping, no re-interpretation. Partitions are a CHAOS action
// (not a topology edit), so this form follows ChaosControl's edit-lock INVERSE: enabled only
// while running, `CHAOS_LOCKED_TITLE` when not — reusing that exact constant rather than a new
// string (see ChaosControl.tsx's file banner for why the direction is inverted here).
import { useState, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { SectionHeader, Explainer, Segmented } from '../ui/kit'
import { smallBtn, dangerBtn, field, row } from './panelStyles'
import { NumberField } from './NumberField'
import { CHAOS_LOCKED_TITLE } from '../dock/ChaosControl'
import type { LinkEndpoint, PartitionFault } from '../../../lib/worldEngine/types'

type EndpointScope = LinkEndpoint['kind']

interface EndpointDraft {
  scope: EndpointScope
  id: string
}

const SCOPE_OPTIONS: Array<{ value: EndpointScope; label: string }> = [
  { value: 'region', label: 'region' },
  { value: 'az', label: 'az' },
  { value: 'server', label: 'server' },
  { value: 'internet', label: 'internet' },
]

const MODE_OPTIONS: Array<{ value: PartitionFault['mode']; label: string }> = [
  { value: 'drop', label: 'drop' },
  { value: 'loss', label: 'loss' },
  { value: 'delay', label: 'delay' },
]

function toEndpoint(draft: EndpointDraft): LinkEndpoint {
  if (draft.scope === 'internet') return { kind: 'internet' }
  return { kind: draft.scope, id: draft.id }
}

function endpointLabel(endpoint: LinkEndpoint, doc: ReturnType<typeof useWorldStore.getState>['doc']): string {
  if (endpoint.kind === 'internet') return 'internet'
  if (endpoint.kind === 'region') return doc.regions[endpoint.id]?.catalogId ?? endpoint.id
  if (endpoint.kind === 'az') return doc.azs[endpoint.id]?.label ?? endpoint.id
  return doc.servers[endpoint.id]?.label ?? endpoint.id
}

// Picker for one endpoint's id, scoped to whichever collection its scope names — empty when the
// world has no entities of that kind yet (internet has no id to pick).
function EndpointPicker({ draft, onChange, ariaPrefix, disabled }: {
  draft: EndpointDraft
  onChange: (d: EndpointDraft) => void
  ariaPrefix: string
  disabled: boolean
}): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const options: Array<{ id: string; label: string }> =
    draft.scope === 'region' ? Object.values(doc.regions).map(r => ({ id: r.id, label: r.catalogId }))
    : draft.scope === 'az' ? Object.values(doc.azs).map(a => ({ id: a.id, label: a.label }))
    : draft.scope === 'server' ? Object.values(doc.servers).map(s => ({ id: s.id, label: s.label }))
    : []

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <Segmented<EndpointScope>
        ariaLabel={`${ariaPrefix}-scope`}
        value={draft.scope}
        onChange={scope => onChange({ scope, id: '' })}
        options={SCOPE_OPTIONS}
      />
      {draft.scope !== 'internet' && (
        <select
          style={{ ...field, marginBottom: 0 }}
          aria-label={`${ariaPrefix}-id`}
          disabled={disabled}
          value={draft.id}
          onChange={e => onChange({ ...draft, id: e.target.value })}
        >
          <option value="">(choose {draft.scope})</option>
          {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      )}
    </div>
  )
}

export function PartitionsSection(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const running = useSimulationStore(s => s.running)
  const partitions = useSimulationStore(s => s.partitions)
  const setPartition = useSimulationStore(s => s.setPartition)
  const healPartition = useSimulationStore(s => s.healPartition)

  const [from, setFrom] = useState<EndpointDraft>({ scope: 'region', id: '' })
  const [to, setTo] = useState<EndpointDraft>({ scope: 'region', id: '' })
  const [mode, setMode] = useState<PartitionFault['mode']>('drop')
  const [lossFraction, setLossFraction] = useState(0.5)
  const [delayMs, setDelayMs] = useState(200)
  const [symmetric, setSymmetric] = useState(true)

  const fromValid = from.scope === 'internet' || from.id !== ''
  const toValid = to.scope === 'internet' || to.id !== ''
  const canAdd = running && fromValid && toValid

  const addPartition = () => {
    if (!canAdd) return
    const fault: PartitionFault = {
      from: toEndpoint(from),
      to: toEndpoint(to),
      mode,
      symmetric,
      ...(mode === 'loss' ? { lossFraction } : {}),
      ...(mode === 'delay' ? { delayMs } : {}),
    }
    setPartition(fault)
  }

  return (
    <div>
      <SectionHeader label="▸ NETWORK PARTITIONS" />
      <Explainer>
        Sever or impair a link between two entities — drop blocks traffic entirely, loss drops a
        fraction of it, delay adds latency. Symmetric applies the impairment in both directions.
      </Explainer>
      <fieldset
        disabled={!running}
        title={running ? undefined : CHAOS_LOCKED_TITLE}
        style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 8, marginTop: 8, opacity: running ? 1 : 0.5 }}
      >
        <div style={row}>
          <div style={{ flex: 1 }}>
            <EndpointPicker draft={from} onChange={setFrom} ariaPrefix="partition-from" disabled={!running} />
          </div>
          <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>→</span>
          <div style={{ flex: 1 }}>
            <EndpointPicker draft={to} onChange={setTo} ariaPrefix="partition-to" disabled={!running} />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
          <span>mode</span>
          <Segmented<PartitionFault['mode']> ariaLabel="partition-mode" value={mode} onChange={setMode} options={MODE_OPTIONS} />
        </label>
        {mode === 'loss' && (
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
            <span>loss fraction</span>
            <NumberField label="loss fraction" value={lossFraction} min={0} max={1} onCommit={setLossFraction} />
          </label>
        )}
        {mode === 'delay' && (
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
            <span>delay ms</span>
            <NumberField label="delay ms" value={delayMs} min={0} max={5000} onCommit={setDelayMs} />
          </label>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <input
            type="checkbox" aria-label="partition-symmetric"
            checked={symmetric} onChange={e => setSymmetric(e.target.checked)}
          />
          <span>symmetric</span>
        </label>
        <button
          type="button" className="kit-press" style={smallBtn}
          disabled={!canAdd}
          title={running ? undefined : CHAOS_LOCKED_TITLE}
          onClick={addPartition}
        >
          + add partition
        </button>
      </fieldset>

      {partitions.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {partitions.map((p, i) => (
            <div key={i} data-testid="partition-row" style={{ ...row, justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {endpointLabel(p.from, doc)} {p.symmetric ? '⇄' : '→'} {endpointLabel(p.to, doc)} · {p.mode}
              </span>
              <button
                type="button" className="kit-press" style={dangerBtn}
                aria-label={`heal-partition-${i}`}
                onClick={() => healPartition(i)}
              >
                heal
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
