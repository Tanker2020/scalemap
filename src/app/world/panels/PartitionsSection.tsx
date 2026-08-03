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
//
// FIX ROUND (post-review, live Playwright smoke against `npm run dev` caught this): this section
// renders inside `RegionConfigTab.tsx`, which `WorldPanel.tsx` wraps in an AMBIENT
// `<fieldset disabled={running && tab !== 'events'}>` — the ORDINARY (non-inverse) edit-lock for
// the rest of the Config tab. Per the HTML spec (concept-fe-disabled), a native form control
// (`<button>`/`<select>`/`<input>`/`<textarea>`) that is a descendant of ANY disabled ancestor
// `<fieldset>` is force-disabled, REGARDLESS of its own `disabled` attribute's value or any
// nested `<fieldset disabled={false}>` in between — there is no way to "re-enable" one from
// inside. This is the exact lesson `ChaosControl.tsx`'s `escapeFieldset` prop already encodes
// for its own primary/▾ buttons (see that file's banner + `AzConfigTab.tsx`'s live-verified
// comment on the same escape). The first version of this file used a native `<select>`/
// `<input type="checkbox">`/`<button disabled={!running}>` nested in its OWN
// `<fieldset disabled={!running}>` — which does NOT help, since the ambient fieldset several
// levels up still wins. Every interactive control below is therefore a plain ARIA-annotated
// `role="button"`/`"checkbox"`/`"option"` element (never a native form control), mirroring
// ChaosControl's escape shape exactly — confirmed clickable live (Playwright against
// `npm run dev`, sim running) after this rewrite.
import { useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { SectionHeader, Explainer } from '../ui/kit'
import { row } from './panelStyles'
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

// ─── Fieldset-escape primitives (see the file banner above) ────────────────────────────────
const btnBase: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 8px',
  color: 'var(--color-text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none',
}
// NOTE: override the full `border` shorthand here, not just `borderColor` — React warns (and can
// misapply styles) when an element's inline style toggles between a shorthand (`btnBase`'s
// `border`) and a longhand override of the same shorthand's sub-property across rerenders. Found
// live during Task 21's smoke pass: toggling any Pressable's `active` state (e.g. the partition
// scope buttons) spammed "Removing borderColor border" console errors.
const btnActive: CSSProperties = {
  background: 'color-mix(in srgb, var(--color-accent) 13%, transparent)',
  color: 'var(--color-accent)', border: '1px solid var(--color-accent)',
}
const btnLocked: CSSProperties = { opacity: 0.35, cursor: 'default' }
const btnDanger: CSSProperties = { color: 'var(--color-danger)', border: '1px solid color-mix(in srgb, var(--color-danger) 25%, transparent)' }

// A `role="button"` div, never a native `<button>` — immune to ancestor-fieldset disabling.
// `locked` mirrors ChaosControl's `!running` gate exactly (tabIndex -1, aria-disabled,
// CHAOS_LOCKED_TITLE tooltip, onClick/onKeyDown both no-op).
function Pressable({
  locked, active, onClick, children, ariaLabel, role = 'button', ariaChecked, testId, style,
}: {
  locked: boolean
  active?: boolean
  onClick: () => void
  children: ReactNode
  ariaLabel?: string
  role?: 'button' | 'checkbox' | 'option'
  ariaChecked?: boolean
  testId?: string
  style?: CSSProperties
}): ReactElement {
  return (
    <div
      role={role} tabIndex={locked ? -1 : 0} className="kit-press" data-testid={testId}
      aria-disabled={locked} aria-label={ariaLabel}
      aria-checked={role === 'checkbox' ? ariaChecked : undefined}
      aria-pressed={role === 'button' && active !== undefined ? active : undefined}
      title={locked ? CHAOS_LOCKED_TITLE : undefined}
      onClick={() => { if (!locked) onClick() }}
      onKeyDown={e => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick() } }}
      style={{ ...btnBase, ...(active ? btnActive : {}), ...(locked ? btnLocked : {}), ...style }}
    >
      {children}
    </div>
  )
}

// A row of Pressables standing in for kit.tsx's `Segmented` (which renders native `<button>`s —
// fine everywhere else in the dock, but NOT escape-safe here).
function PressableSegmented<T extends string>({ locked, value, onChange, options, ariaPrefix }: {
  locked: boolean
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
  ariaPrefix: string
}): ReactElement {
  return (
    <div role="group" style={{ display: 'inline-flex', gap: 2 }}>
      {options.map(opt => (
        <Pressable
          key={opt.value} locked={locked} active={value === opt.value}
          ariaLabel={`${ariaPrefix}-${opt.value}`} testId={`${ariaPrefix}-${opt.value}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Pressable>
      ))}
    </div>
  )
}

// A bounded +/- stepper standing in for a native numeric `<input>` (also a listed form control,
// also force-disabled by the ambient fieldset regardless of its own `disabled` prop).
function Stepper({ locked, value, min, max, step, onChange, ariaLabel, format }: {
  locked: boolean
  value: number
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  ariaLabel: string
  format?: (n: number) => string
}): ReactElement {
  const round = (n: number) => Math.round(n * 1000) / 1000
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Pressable locked={locked} ariaLabel={`${ariaLabel} decrease`} onClick={() => onChange(round(Math.max(min, value - step)))}>−</Pressable>
      <span data-testid={`${ariaLabel}-value`} style={{ minWidth: 46, textAlign: 'center', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-primary)' }}>
        {format ? format(value) : value}
      </span>
      <Pressable locked={locked} ariaLabel={`${ariaLabel} increase`} onClick={() => onChange(round(Math.min(max, value + step)))}>+</Pressable>
    </div>
  )
}

// Picker for one endpoint's id, scoped to whichever collection its scope names — empty when the
// world has no entities of that kind yet (internet has no id to pick). Replaces a native
// `<select>` with a Pressable "current value" toggle + a Pressable-option popup list (same shape
// as ChaosControl's own `▾` menu).
function EndpointPicker({ draft, onChange, ariaPrefix, locked }: {
  draft: EndpointDraft
  onChange: (d: EndpointDraft) => void
  ariaPrefix: string
  locked: boolean
}): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const [open, setOpen] = useState(false)
  const options: Array<{ id: string; label: string }> =
    draft.scope === 'region' ? Object.values(doc.regions).map(r => ({ id: r.id, label: r.catalogId }))
    : draft.scope === 'az' ? Object.values(doc.azs).map(a => ({ id: a.id, label: a.label }))
    : draft.scope === 'server' ? Object.values(doc.servers).map(s => ({ id: s.id, label: s.label }))
    : []
  const selectedLabel = options.find(o => o.id === draft.id)?.label ?? `choose ${draft.scope}`

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <PressableSegmented
        ariaPrefix={`${ariaPrefix}-scope`} locked={locked} value={draft.scope}
        onChange={scope => { onChange({ scope, id: '' }); setOpen(false) }}
        options={SCOPE_OPTIONS}
      />
      {draft.scope !== 'internet' && (
        <div style={{ position: 'relative' }}>
          <Pressable
            locked={locked} ariaLabel={`${ariaPrefix}-id`} testId={`${ariaPrefix}-id`}
            style={{ width: '100%', boxSizing: 'border-box', textAlign: 'left' }}
            onClick={() => setOpen(v => !v)}
          >
            {selectedLabel} ▾
          </Pressable>
          {open && !locked && (
            <div
              role="listbox" data-testid={`${ariaPrefix}-id-menu`} aria-label={`${ariaPrefix}-id-options`}
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 20,
                display: 'flex', flexDirection: 'column', gap: 2, padding: 4, maxHeight: 160, overflowY: 'auto',
                background: 'var(--color-surface)', border: '1px solid var(--color-node-border)', borderRadius: 6,
                boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
              }}
            >
              {options.length === 0 && (
                <div style={{ color: 'var(--color-text-muted)', padding: '4px 6px', font: '10px var(--font-mono)' }}>
                  no {draft.scope}s in this world yet
                </div>
              )}
              {options.map(o => (
                <Pressable
                  key={o.id} role="option" locked={locked} ariaLabel={o.label}
                  testId={`${ariaPrefix}-option-${o.id}`}
                  style={{ textAlign: 'left' }}
                  onClick={() => { onChange({ ...draft, id: o.id }); setOpen(false) }}
                >
                  {o.label}
                </Pressable>
              ))}
            </div>
          )}
        </div>
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
  const locked = !running

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
      {/* No wrapping native `<fieldset>` here (see file banner) — `locked` gates every Pressable
          individually, each immune to the ambient WorldPanel fieldset several levels up. */}
      <div style={{ display: 'grid', gap: 8, marginTop: 8, opacity: locked ? 0.5 : 1 }}>
        <div style={row}>
          <div style={{ flex: 1 }}>
            <EndpointPicker draft={from} onChange={setFrom} ariaPrefix="partition-from" locked={locked} />
          </div>
          <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>→</span>
          <div style={{ flex: 1 }}>
            <EndpointPicker draft={to} onChange={setTo} ariaPrefix="partition-to" locked={locked} />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
          <span>mode</span>
          <PressableSegmented ariaPrefix="partition-mode" locked={locked} value={mode} onChange={setMode} options={MODE_OPTIONS} />
        </label>
        {mode === 'loss' && (
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
            <span>loss fraction</span>
            <Stepper
              locked={locked} value={lossFraction} min={0} max={1} step={0.05} onChange={setLossFraction}
              ariaLabel="loss-fraction" format={n => n.toFixed(2)}
            />
          </label>
        )}
        {mode === 'delay' && (
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 }}>
            <span>delay ms</span>
            <Stepper locked={locked} value={delayMs} min={0} max={5000} step={50} onChange={setDelayMs} ariaLabel="delay-ms" />
          </label>
        )}
        <Pressable
          locked={locked} role="checkbox" ariaChecked={symmetric} ariaLabel="partition-symmetric" testId="partition-symmetric"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: 'fit-content' }}
          onClick={() => setSymmetric(v => !v)}
        >
          <span aria-hidden>{symmetric ? '☑' : '☐'}</span> symmetric
        </Pressable>
        <Pressable
          locked={locked || !fromValid || !toValid} testId="partition-add"
          onClick={addPartition}
        >
          + add partition
        </Pressable>
      </div>

      {partitions.length > 0 && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {partitions.map((p, i) => (
            // Audit final-review I3: keyed/addressed by p.id (stable identity), not array index —
            // healing mid-run must never target a DIFFERENT partition just because an earlier one
            // in the list was healed first and shifted everything after it. worldEngine.setPartition
            // always assigns a real id (author-supplied or auto-assigned) before this list is ever
            // populated, so `p.id` is guaranteed set here.
            <div key={p.id ?? i} data-testid="partition-row" style={{ ...row, justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {endpointLabel(p.from, doc)} {p.symmetric ? '⇄' : '→'} {endpointLabel(p.to, doc)} · {p.mode}
              </span>
              <Pressable
                locked={locked} ariaLabel={`heal-partition-${i}`} testId={`heal-partition-${i}`}
                style={btnDanger}
                onClick={() => p.id && healPartition(p.id)}
              >
                heal
              </Pressable>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
