// src/app/world/panels/ScenarioPanel.tsx
// FEAT-003 Task 20: scenario timeline authoring — world scope, `scenario` tab. A `Scenario` is a
// deterministic, seeded sequence of fault/demand actions applied by the engine at fixed sim-time
// offsets (worldEngine/index.ts's scenarioSteps/scenarioCursor, wired in Task 18/19). This panel
// is the ONLY authoring surface for it: `setScenario`/`addScenarioStep`/`removeScenarioStep`/
// `updateScenarioStep` (world.store.ts, Task 17) are the sole mutation path, so every edit here
// rides undo/dirty for free, same as every other panel in this directory.
//
// Edit-lock direction (important, see the task brief): authoring a scenario is CONFIGURATION, not
// a live chaos action — the OPPOSITE of ChaosControl/PartitionsSection's inverse escape-fieldset
// pattern. This component is mounted as a normal tab body inside WorldPanel.tsx's ambient
// `<fieldset disabled={running && tab !== 'events'}>`, so every native control below is
// force-disabled while running FOR FREE — no `Pressable`/escape-fieldset machinery needed or
// wanted here. The one non-native control (the draggable ruler marker) guards itself explicitly
// with `if (running) return` in its own pointer handlers, since a plain `<div>` is NOT a
// fieldset-disabled element and would otherwise stay draggable mid-run.
import { useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { SectionHeader, Explainer } from '../ui/kit'
import { field, smallBtn, dangerBtn, row, sectionLabel } from './panelStyles'
import type {
  Scenario, ScenarioAction, ScenarioStep, WorldDoc,
} from '../../../lib/world/types'
import type { FaultKind, FaultScope, FaultSpec, LinkEndpoint, PartitionFault } from '../../../lib/worldEngine/types'

const ACTION_TYPES: Array<{ value: ScenarioAction['type']; label: string }> = [
  { value: 'inject-fault', label: 'inject fault' },
  { value: 'clear-fault', label: 'clear fault' },
  { value: 'partition', label: 'partition link' },
  { value: 'heal-partition', label: 'heal partition' },
  { value: 'demand-multiplier', label: 'demand multiplier' },
  { value: 'set-population-rps', label: 'population rps' },
]
const FAULT_SCOPES: FaultScope[] = ['server', 'az', 'region', 'managed']
const FAULT_KINDS: FaultKind[] = ['down', 'latency-add', 'cpu-brownout', 'memory-leak', 'error-inject']
const ENDPOINT_SCOPES: LinkEndpoint['kind'][] = ['region', 'az', 'server', 'internet']
const PARTITION_MODES: PartitionFault['mode'][] = ['drop', 'loss', 'delay']

const RULER_LOCKED_TITLE = 'stop the simulation to edit the scenario'

function entityLabel(scope: FaultScope, id: string, doc: WorldDoc): string {
  if (scope === 'server') return doc.servers[id]?.label ?? id
  if (scope === 'az') return doc.azs[id]?.label ?? id
  if (scope === 'region') return doc.regions[id]?.catalogId ?? id
  return doc.managedServices[id]?.label ?? id
}

function entityOptions(scope: FaultScope, doc: WorldDoc): Array<{ id: string; label: string }> {
  if (scope === 'server') return Object.values(doc.servers).map(s => ({ id: s.id, label: s.label }))
  if (scope === 'az') return Object.values(doc.azs).map(a => ({ id: a.id, label: a.label }))
  if (scope === 'region') return Object.values(doc.regions).map(r => ({ id: r.id, label: r.catalogId }))
  return Object.values(doc.managedServices).map(m => ({ id: m.id, label: m.label }))
}

function endpointLabel(endpoint: LinkEndpoint, doc: WorldDoc): string {
  if (endpoint.kind === 'internet') return 'internet'
  if (endpoint.kind === 'region') return doc.regions[endpoint.id]?.catalogId ?? endpoint.id
  if (endpoint.kind === 'az') return doc.azs[endpoint.id]?.label ?? endpoint.id
  return doc.servers[endpoint.id]?.label ?? endpoint.id
}

function describeAction(action: ScenarioAction, doc: WorldDoc): string {
  switch (action.type) {
    case 'inject-fault':
      return `inject ${action.spec.kind} → ${entityLabel(action.scope, action.id, doc)}`
    case 'clear-fault':
      return `clear fault → ${entityLabel(action.scope, action.id, doc)}`
    case 'partition':
      return `partition ${endpointLabel(action.fault.from, doc)} ${action.fault.symmetric ? '⇄' : '→'} ${endpointLabel(action.fault.to, doc)} (${action.fault.mode})`
    case 'heal-partition':
      return `heal partition #${action.index}`
    case 'demand-multiplier':
      return `demand ×${action.factor} over ${action.rampSec}s`
    case 'set-population-rps':
      return `${doc.populations[action.populationId]?.label ?? action.populationId} → ${action.peakRps} rps over ${action.rampSec}s`
  }
}

function faultSpecFor(kind: FaultKind, latencyMs: number, capacityFraction: number, mbPerMinute: number, errorFraction: number): FaultSpec {
  switch (kind) {
    case 'down': return { kind: 'down' }
    case 'latency-add': return { kind: 'latency-add', ms: latencyMs }
    case 'cpu-brownout': return { kind: 'cpu-brownout', capacityFraction }
    case 'memory-leak': return { kind: 'memory-leak', mbPerMinute }
    case 'error-inject': return { kind: 'error-inject', errorFraction }
  }
}

// ─── Ruler (also read by SimControls, see its own progress chip) ────────────────────────────
// A static position update on the 1 Hz batch (prefers-reduced-motion is moot here — there is no
// animation, just a re-render when simMs advances).
export function ScenarioRuler({ durationMs, steps, progressMs, running, onDragStep }: {
  durationMs: number
  steps: ScenarioStep[]
  progressMs: number | null
  running: boolean
  onDragStep?: (index: number, atMs: number) => void
}): ReactElement {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)

  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / Math.max(1, durationMs)) * 100))}%`

  const atMsFromClientX = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return Math.round(frac * durationMs)
  }

  return (
    <div
      ref={trackRef}
      data-testid="scenario-ruler"
      style={{
        position: 'relative', height: 28, borderRadius: 4, marginTop: 6, marginBottom: 10,
        background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
      }}
      onMouseMove={e => {
        if (dragIndex === null || running || !onDragStep) return
        onDragStep(dragIndex, atMsFromClientX(e.clientX))
      }}
      onMouseUp={() => setDragIndex(null)}
      onMouseLeave={() => setDragIndex(null)}
    >
      {progressMs !== null && (
        <div
          data-testid="scenario-progress-fill"
          style={{
            position: 'absolute', left: 0, top: 0, bottom: 0, width: pct(progressMs),
            background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)',
            borderRight: '1px solid var(--color-accent)',
          }}
        />
      )}
      {steps.map((s, i) => (
        <div
          key={i}
          data-testid={`scenario-marker-${i}`}
          title={`${(s.atMs / 1000).toFixed(1)}s — ${s.note ?? s.action.type}${running ? '' : ` (${RULER_LOCKED_TITLE.replace('stop the simulation to edit', 'drag to move')})`}`}
          onMouseDown={() => {
            // Explicit guard (see file banner): a plain div is immune to the ambient fieldset, so
            // authoring-lock must be enforced here directly, not inherited.
            if (running || !onDragStep) return
            setDragIndex(i)
          }}
          style={{
            position: 'absolute', left: pct(s.atMs), top: 2, bottom: 2, width: 2,
            background: 'var(--color-warning)', cursor: running ? 'default' : 'ew-resize',
            opacity: running ? 0.7 : 1,
          }}
        />
      ))}
    </div>
  )
}

const stepRow: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 6, padding: 8, marginBottom: 6,
}
const miniLabel: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)', flexShrink: 0 }
const atMsField: CSSProperties = { ...field, width: 70, marginBottom: 0 }

export function ScenarioPanel(): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const setScenario = useWorldStore(s => s.setScenario)
  const addScenarioStep = useWorldStore(s => s.addScenarioStep)
  const removeScenarioStep = useWorldStore(s => s.removeScenarioStep)
  const updateScenarioStep = useWorldStore(s => s.updateScenarioStep)
  const running = useSimulationStore(s => s.running)
  const latestBatch = useSimulationStore(s => s.latestBatch)

  const scenario: Scenario | undefined = doc.scenario

  if (!scenario) {
    return (
      <div>
        <SectionHeader label="▸ SCENARIO" />
        <Explainer>
          A scenario is a deterministic, seeded timeline of fault/demand actions applied at fixed
          sim-time offsets — press Simulate once it's created and every action fires on schedule,
          replayable byte-identically run after run.
        </Explainer>
        <button
          className="kit-press" style={smallBtn} data-testid="create-scenario"
          onClick={() => setScenario({
            id: crypto.randomUUID(), label: 'New scenario', seed: 1, durationMs: 300000, steps: [],
          })}
        >
          + Create scenario
        </button>
      </div>
    )
  }

  return (
    <div>
      <SectionHeader label="▸ SCENARIO" trailing={running ? <span title={RULER_LOCKED_TITLE} style={{ fontSize: 9.5, color: 'var(--color-text-muted)' }}>locked while running</span> : undefined} />
      <Explainer>
        Steps apply once, in order, at their `atMs` offset — the engine seeds its RNG from this
        scenario's seed, so re-running produces the identical sequence of events at the identical
        timestamps.
      </Explainer>

      <div style={row}>
        <input
          style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="scenario-label" title={running ? RULER_LOCKED_TITLE : undefined}
          value={scenario.label} onChange={e => setScenario({ ...scenario, label: e.target.value })}
        />
        <button className="kit-press" style={dangerBtn} aria-label="delete-scenario" title={running ? RULER_LOCKED_TITLE : 'delete scenario'}
          onClick={() => setScenario(null)}>×</button>
      </div>
      <div style={row}>
        <span style={miniLabel}>duration s</span>
        <input
          style={atMsField} type="number" min={1} aria-label="scenario-duration" title={running ? RULER_LOCKED_TITLE : undefined}
          value={Math.round(scenario.durationMs / 1000)}
          onChange={e => setScenario({ ...scenario, durationMs: Math.max(1000, Number(e.target.value) * 1000) })}
        />
        <span style={miniLabel}>seed</span>
        <input
          style={atMsField} type="number" aria-label="scenario-seed" title={running ? RULER_LOCKED_TITLE : undefined}
          value={scenario.seed} onChange={e => setScenario({ ...scenario, seed: Number(e.target.value) })}
        />
      </div>

      <ScenarioRuler
        durationMs={scenario.durationMs}
        steps={scenario.steps}
        progressMs={running ? (latestBatch?.simMs ?? 0) : null}
        running={running}
        onDragStep={(index, atMs) => {
          const step = scenario.steps[index]
          if (step) updateScenarioStep(index, { ...step, atMs })
        }}
      />

      <div style={sectionLabel}>Steps ({scenario.steps.length})</div>
      {scenario.steps.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no steps yet</div>}
      {[...scenario.steps]
        .map((step, i) => ({ step, i }))
        .sort((a, b) => a.step.atMs - b.step.atMs)
        .map(({ step, i }) => (
          <div key={i} style={stepRow} data-testid="scenario-step-row">
            <div style={row}>
              <span style={miniLabel}>at</span>
              <input
                style={atMsField} type="number" min={0} aria-label={`step-atms-${i}`} title={running ? RULER_LOCKED_TITLE : undefined}
                value={Math.round(step.atMs / 1000)}
                onChange={e => updateScenarioStep(i, { ...step, atMs: Math.max(0, Number(e.target.value) * 1000) })}
              />
              <span style={miniLabel}>s</span>
              <span style={{ flex: 1, color: 'var(--color-text-primary)', fontSize: 10.5 }}>{describeAction(step.action, doc)}</span>
              <button className="kit-press" style={dangerBtn} aria-label={`remove-step-${i}`} title={running ? RULER_LOCKED_TITLE : 'delete step'}
                onClick={() => removeScenarioStep(i)}>×</button>
            </div>
            <input
              style={{ ...field, marginTop: 4, marginBottom: 0 }} placeholder="note (optional)" aria-label={`step-note-${i}`}
              title={running ? RULER_LOCKED_TITLE : undefined}
              value={step.note ?? ''} onChange={e => updateScenarioStep(i, { ...step, note: e.target.value || undefined })}
            />
          </div>
        ))}

      <AddStepForm doc={doc} onAdd={addScenarioStep} />
    </div>
  )
}

function AddStepForm({ doc, onAdd }: { doc: WorldDoc; onAdd: (step: ScenarioStep) => void }): ReactElement {
  const [atMsSec, setAtMsSec] = useState('0')
  const [type, setType] = useState<ScenarioAction['type']>('inject-fault')
  const [note, setNote] = useState('')

  // inject-fault / clear-fault
  const [faultScope, setFaultScope] = useState<FaultScope>('server')
  const [faultId, setFaultId] = useState('')
  const [faultKind, setFaultKind] = useState<FaultKind>('down')
  const [latencyMs, setLatencyMs] = useState('200')
  const [capacityFraction, setCapacityFraction] = useState('0.5')
  const [mbPerMinute, setMbPerMinute] = useState('50')
  const [errorFraction, setErrorFraction] = useState('0.2')

  // partition
  const [fromScope, setFromScope] = useState<LinkEndpoint['kind']>('region')
  const [fromId, setFromId] = useState('')
  const [toScope, setToScope] = useState<LinkEndpoint['kind']>('region')
  const [toId, setToId] = useState('')
  const [mode, setMode] = useState<PartitionFault['mode']>('drop')
  const [lossFraction, setLossFraction] = useState('0.5')
  const [delayMs, setDelayMs] = useState('200')
  const [symmetric, setSymmetric] = useState(true)

  // heal-partition
  const [healIndex, setHealIndex] = useState('0')

  // demand-multiplier
  const [factor, setFactor] = useState('1.5')
  const [rampSec, setRampSec] = useState('10')

  // set-population-rps
  const [populationId, setPopulationId] = useState('')
  const [peakRps, setPeakRps] = useState('100')
  const [popRampSec, setPopRampSec] = useState('10')

  const faultEntities = entityOptions(faultScope, doc)
  const fromEntities = fromScope === 'internet' ? [] : entityOptions(fromScope as FaultScope, doc)
  const toEntities = toScope === 'internet' ? [] : entityOptions(toScope as FaultScope, doc)
  const populations = Object.values(doc.populations)

  const canAdd = (() => {
    switch (type) {
      case 'inject-fault':
      case 'clear-fault':
        return faultId !== ''
      case 'partition':
        return (fromScope === 'internet' || fromId !== '') && (toScope === 'internet' || toId !== '')
      case 'heal-partition':
        return healIndex !== ''
      case 'demand-multiplier':
        return true
      case 'set-population-rps':
        return populationId !== ''
    }
  })()

  const buildAction = (): ScenarioAction => {
    switch (type) {
      case 'inject-fault':
        return { type: 'inject-fault', scope: faultScope, id: faultId, spec: faultSpecFor(faultKind, Number(latencyMs), Number(capacityFraction), Number(mbPerMinute), Number(errorFraction)) }
      case 'clear-fault':
        return { type: 'clear-fault', scope: faultScope, id: faultId }
      case 'partition': {
        const from: LinkEndpoint = fromScope === 'internet' ? { kind: 'internet' } : { kind: fromScope, id: fromId }
        const to: LinkEndpoint = toScope === 'internet' ? { kind: 'internet' } : { kind: toScope, id: toId }
        const fault: PartitionFault = {
          from, to, mode, symmetric,
          ...(mode === 'loss' ? { lossFraction: Number(lossFraction) } : {}),
          ...(mode === 'delay' ? { delayMs: Number(delayMs) } : {}),
        }
        return { type: 'partition', fault }
      }
      case 'heal-partition':
        return { type: 'heal-partition', index: Number(healIndex) }
      case 'demand-multiplier':
        return { type: 'demand-multiplier', factor: Number(factor), rampSec: Number(rampSec) }
      case 'set-population-rps':
        return { type: 'set-population-rps', populationId, peakRps: Number(peakRps), rampSec: Number(popRampSec) }
    }
  }

  const submit = () => {
    if (!canAdd) return
    onAdd({ atMs: Math.max(0, Number(atMsSec) * 1000), action: buildAction(), note: note.trim() || undefined })
    setNote('')
  }

  return (
    <div>
      <div style={sectionLabel}>Add step</div>
      <div style={row}>
        <span style={miniLabel}>at</span>
        <input style={atMsField} type="number" min={0} aria-label="new-step-atms" value={atMsSec} onChange={e => setAtMsSec(e.target.value)} />
        <span style={miniLabel}>s</span>
        <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-step-type" value={type}
          onChange={e => setType(e.target.value as ScenarioAction['type'])}>
          {ACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      {(type === 'inject-fault' || type === 'clear-fault') && (
        <div style={row}>
          <select style={{ ...field, width: 84, marginBottom: 0 }} aria-label="new-step-fault-scope" value={faultScope}
            onChange={e => { setFaultScope(e.target.value as FaultScope); setFaultId('') }}>
            {FAULT_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-step-fault-id" value={faultId}
            onChange={e => setFaultId(e.target.value)}>
            <option value="">choose {faultScope}…</option>
            {faultEntities.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      )}
      {type === 'inject-fault' && (
        <div style={row}>
          <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-step-fault-kind" value={faultKind}
            onChange={e => setFaultKind(e.target.value as FaultKind)}>
            {FAULT_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          {faultKind === 'latency-add' && (
            <input style={atMsField} type="number" min={0} aria-label="new-step-latency-ms" title="added latency (ms)"
              value={latencyMs} onChange={e => setLatencyMs(e.target.value)} />
          )}
          {faultKind === 'cpu-brownout' && (
            <input style={atMsField} type="number" min={0} max={1} step={0.05} aria-label="new-step-capacity-fraction" title="remaining CPU capacity fraction"
              value={capacityFraction} onChange={e => setCapacityFraction(e.target.value)} />
          )}
          {faultKind === 'memory-leak' && (
            <input style={atMsField} type="number" min={0} aria-label="new-step-mb-per-minute" title="MB leaked per minute"
              value={mbPerMinute} onChange={e => setMbPerMinute(e.target.value)} />
          )}
          {faultKind === 'error-inject' && (
            <input style={atMsField} type="number" min={0} max={1} step={0.05} aria-label="new-step-error-fraction" title="fraction of requests erroring"
              value={errorFraction} onChange={e => setErrorFraction(e.target.value)} />
          )}
        </div>
      )}

      {type === 'partition' && (
        <>
          <div style={row}>
            <select style={{ ...field, width: 76, marginBottom: 0 }} aria-label="new-step-from-scope" value={fromScope}
              onChange={e => { setFromScope(e.target.value as LinkEndpoint['kind']); setFromId('') }}>
              {ENDPOINT_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {fromScope !== 'internet' && (
              <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-step-from-id" value={fromId} onChange={e => setFromId(e.target.value)}>
                <option value="">choose…</option>
                {fromEntities.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            )}
            <span style={miniLabel}>→</span>
            <select style={{ ...field, width: 76, marginBottom: 0 }} aria-label="new-step-to-scope" value={toScope}
              onChange={e => { setToScope(e.target.value as LinkEndpoint['kind']); setToId('') }}>
              {ENDPOINT_SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {toScope !== 'internet' && (
              <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-step-to-id" value={toId} onChange={e => setToId(e.target.value)}>
                <option value="">choose…</option>
                {toEntities.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            )}
          </div>
          <div style={row}>
            <select style={{ ...field, width: 76, marginBottom: 0 }} aria-label="new-step-partition-mode" value={mode}
              onChange={e => setMode(e.target.value as PartitionFault['mode'])}>
              {PARTITION_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            {mode === 'loss' && (
              <input style={atMsField} type="number" min={0} max={1} step={0.05} aria-label="new-step-loss-fraction"
                value={lossFraction} onChange={e => setLossFraction(e.target.value)} />
            )}
            {mode === 'delay' && (
              <input style={atMsField} type="number" min={0} aria-label="new-step-delay-ms"
                value={delayMs} onChange={e => setDelayMs(e.target.value)} />
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5 }}>
              <input type="checkbox" aria-label="new-step-symmetric" checked={symmetric} onChange={e => setSymmetric(e.target.checked)} />
              symmetric
            </label>
          </div>
        </>
      )}

      {type === 'heal-partition' && (
        <div style={row}>
          <span style={miniLabel}>index</span>
          <input style={atMsField} type="number" min={0} aria-label="new-step-heal-index" value={healIndex} onChange={e => setHealIndex(e.target.value)} />
        </div>
      )}

      {type === 'demand-multiplier' && (
        <div style={row}>
          <span style={miniLabel}>factor</span>
          <input style={atMsField} type="number" min={0} step={0.1} aria-label="new-step-factor" value={factor} onChange={e => setFactor(e.target.value)} />
          <span style={miniLabel}>ramp s</span>
          <input style={atMsField} type="number" min={0} aria-label="new-step-ramp-sec" value={rampSec} onChange={e => setRampSec(e.target.value)} />
        </div>
      )}

      {type === 'set-population-rps' && (
        <div style={row}>
          <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-step-population" value={populationId}
            onChange={e => setPopulationId(e.target.value)}>
            <option value="">choose population…</option>
            {populations.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <span style={miniLabel}>peak rps</span>
          <input style={atMsField} type="number" min={0} aria-label="new-step-peak-rps" value={peakRps} onChange={e => setPeakRps(e.target.value)} />
          <span style={miniLabel}>ramp s</span>
          <input style={atMsField} type="number" min={0} aria-label="new-step-pop-ramp-sec" value={popRampSec} onChange={e => setPopRampSec(e.target.value)} />
        </div>
      )}

      <div style={row}>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} placeholder="note (optional)" aria-label="new-step-note" value={note} onChange={e => setNote(e.target.value)} />
        <button className="kit-press" style={smallBtn} disabled={!canAdd} data-testid="add-step" onClick={submit}>+ Step</button>
      </div>
    </div>
  )
}
