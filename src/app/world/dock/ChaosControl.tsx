// src/app/world/dock/ChaosControl.tsx
// FEAT-001 Task 8: the ONE shared chaos split-button — replaces the six forked bare kill/restore
// buttons (ServerFaceplate, AzConfigTab, AzRow's az + managed rows, RegionView's region + managed
// rows, RegionOverlay, DatacenterFloor's managed row) that used to call
// `setOutage(scope, id, !isManuallyDown)` directly. Primary click is byte-identical to that old
// behavior (toggles a `down` fault) so nobody who never discovers the `▾` menu sees any change;
// the menu adds the other four `FaultKind`s from Task 1/6, each with its one numeric parameter via
// the shared `NumberField` (panels/NumberField.tsx).
//
// Two small, non-forking knobs accommodate the real variance already present across the six call
// sites (verified by reading each one before writing this file) instead of hand-rolling six
// near-duplicate components:
//   - `escapeFieldset` — ServerFaceplate/AzConfigTab live inside WorldPanel.tsx's ambient
//     `<fieldset disabled={running}>` (the edit-lock) and their kill control is RUN-ONLY, so it
//     must stay clickable at the exact moment a real `<button disabled>` would be fieldset-
//     disabled. Those two sites render `role="button"` divs (the pre-existing escape both already
//     used); every other site renders a native `<button disabled>` (matches their pre-existing
//     markup/tests, e.g. reading `.disabled` as a real boolean).
//   - `killLabel` — the not-yet-faulted primary label text. Defaults to 'kill'; AzConfigTab keeps
//     its distinct 'kill AZ' copy since "AZ" vs a bare server/service is a meaningful distinction
//     worth preserving verbatim.
// The restore/clear labels, the `▾` menu, the menu's four fault rows, and every color are the
// SAME across every call site — that's the actual standardization this task delivers.
import { useState, type CSSProperties, type ReactElement } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import { NumberField } from '../panels/NumberField'
import type { FaultKind, FaultScope, FaultSpec } from '../../../lib/worldEngine/types'

export const CHAOS_LOCKED_TITLE = 'start the simulation to break things'

// Shared amber "non-fatal fault" entity accent (plan FEAT-001 design section: "A faulted entity
// renders with a distinct non-fatal affordance (amber hatch) versus a killed one (existing
// dark/struck treatment)"). `ChaosControl`'s own button already carries this tone on its border/
// text; the six call sites additionally apply this SAME accent to the entity element they already
// render (rack row/card/chip/faceplate) so the distinction reads without hovering the control.
// One shared constant/predicate instead of six inline literals — not a new component/hook, just
// avoids the exact CSS drifting six ways.
export function isNonFatalFault(spec: FaultSpec | null | undefined): boolean {
  return spec != null && spec.kind !== 'down'
}

export const NON_FATAL_FAULT_ACCENT: CSSProperties = {
  boxShadow: 'inset 0 0 0 1px var(--color-warning), inset 0 0 20px color-mix(in srgb, var(--color-warning) 16%, transparent)',
}

type NonDownKind = Exclude<FaultKind, 'down'>

const FAULT_LABELS: Record<NonDownKind, string> = {
  'latency-add': 'add latency',
  'cpu-brownout': 'CPU brownout',
  'memory-leak': 'memory leak',
  'error-inject': 'inject errors',
}

const FAULT_PARAM: Record<NonDownKind, { unit: string; min: number; max: number; default: number }> = {
  'latency-add': { unit: 'ms', min: 0, max: 5000, default: 200 },
  'cpu-brownout': { unit: 'capacity frac', min: 0, max: 1, default: 0.5 },
  'memory-leak': { unit: 'MB/min', min: 0, max: 2000, default: 60 },
  'error-inject': { unit: 'error frac', min: 0, max: 1, default: 0.1 },
}

function specFor(kind: NonDownKind, value: number): FaultSpec {
  switch (kind) {
    case 'latency-add': return { kind, ms: value }
    case 'cpu-brownout': return { kind, capacityFraction: value }
    case 'memory-leak': return { kind, mbPerMinute: value }
    case 'error-inject': return { kind, errorFraction: value }
  }
}

const wrapStyle: CSSProperties = { position: 'relative', display: 'inline-flex', gap: 2 }
const baseBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 8px',
  color: 'var(--color-text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap',
}
const dangerTone: CSSProperties = {
  color: 'var(--color-danger)', borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
}
const successTone: CSSProperties = {
  color: 'var(--color-success)', borderColor: 'color-mix(in srgb, var(--color-success) 25%, transparent)',
}
const warningTone: CSSProperties = {
  color: 'var(--color-warning)', borderColor: 'color-mix(in srgb, var(--color-warning) 25%, transparent)',
}
const lockedTone: CSSProperties = { opacity: 0.35, cursor: 'default' }
const menuBtn: CSSProperties = { ...baseBtn, padding: '4px 6px' }
const menuStyle: CSSProperties = {
  position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20,
  display: 'flex', flexDirection: 'column', gap: 6, padding: 8, minWidth: 200,
  background: 'var(--color-surface)', border: '1px solid var(--color-node-border)',
  borderRadius: 6, boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
}
const menuRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, font: '10px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const menuRowLabel: CSSProperties = { flex: 1 }
const applyBtn: CSSProperties = {
  font: '9px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 8px',
  color: 'var(--color-warning)', cursor: 'pointer',
}
const clearRow: CSSProperties = {
  font: '10px var(--font-mono)', color: 'var(--color-text-muted)', cursor: 'pointer',
  padding: '4px 2px', textAlign: 'center', borderTop: '1px solid var(--color-node-border)', marginTop: 2,
}

export interface ChaosControlProps {
  scope: FaultScope
  id: string
  running: boolean
  // Entity label for the aria-label text (mirrors each call site's old `${label}`
  // interpolation, e.g. az?.label / m.label) — falls back to the raw id.
  label?: string
  // Not-yet-faulted primary label text. Defaults to 'kill'.
  killLabel?: string
  // Renders the primary/▾ controls as `role="button"` divs (fieldset-escape) instead of native
  // `<button>`s — see the file banner. Only ServerFaceplate/AzConfigTab need this.
  escapeFieldset?: boolean
  // Pass-through data-testid for the primary control (backward-compat for call sites with an
  // existing testid-based test).
  testId?: string
}

export function ChaosControl({
  scope, id, running, label, killLabel = 'kill', escapeFieldset = false, testId,
}: ChaosControlProps): ReactElement {
  const setFault = useSimulationStore(s => s.setFault)
  const activeFault = useSimulationStore(s => s.activeFaults[id] ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const isFaulted = activeFault !== null
  const isDown = activeFault?.kind === 'down'
  const entityLabel = label ?? id

  const closeMenu = () => setMenuOpen(false)

  // Primary click: today's exact toggle — clear whatever fault is active (down or not), or start
  // a `down` fault if none is active. Byte-identical to the old `setOutage(scope, id, !down)` when
  // the only fault kind in play is `down`.
  const primaryClick = () => {
    if (!running) return
    setFault(scope, id, isFaulted ? null : { kind: 'down' })
    closeMenu()
  }
  const toggleMenu = () => { if (running) setMenuOpen(v => !v) }
  const applyKind = (spec: FaultSpec) => {
    setFault(scope, id, spec)
    closeMenu()
  }
  const clearFault = () => {
    setFault(scope, id, null)
    closeMenu()
  }

  const primaryTone = !running ? lockedTone : isFaulted ? (isDown ? successTone : warningTone) : dangerTone
  const primaryText = !isFaulted ? killLabel : isDown ? '↺ restore' : '✕ clear'
  // Only set an explicit aria-label when a caller supplies a friendlier entity `label` (mirrors
  // each call site's old convention — some sites named the entity in the accessible name, others
  // left the button's own text as its accessible name). Without one, the primary control's
  // visible text (`kill`/`↺ restore`/`✕ clear`) IS its accessible name — setting an aria-label
  // unconditionally here would silently override that text for every `getByRole(..., { name })`
  // query in the app, whether or not a friendlier label was ever asked for.
  const primaryAriaLabel = label ? `${isFaulted ? 'Clear fault on' : 'Simulate outage for'} ${entityLabel}` : undefined
  const menuAriaLabel = `More fault options for ${entityLabel}`

  return (
    <div style={wrapStyle}>
      {escapeFieldset ? (
        <div
          role="button" tabIndex={running ? 0 : -1} className="kit-press" data-testid={testId}
          style={{ ...baseBtn, ...primaryTone }} aria-disabled={!running} aria-label={primaryAriaLabel}
          title={running ? undefined : CHAOS_LOCKED_TITLE}
          onClick={primaryClick}
          onKeyDown={e => { if (running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); primaryClick() } }}
        >
          {primaryText}
        </div>
      ) : (
        <button
          type="button" className="kit-press" data-testid={testId}
          style={{ ...baseBtn, ...primaryTone }} disabled={!running} aria-label={primaryAriaLabel}
          title={running ? undefined : CHAOS_LOCKED_TITLE}
          onClick={primaryClick}
        >
          {primaryText}
        </button>
      )}
      {escapeFieldset ? (
        <div
          role="button" tabIndex={running ? 0 : -1} className="kit-press"
          style={{ ...menuBtn, ...(!running ? lockedTone : {}) }} aria-disabled={!running}
          aria-haspopup="true" aria-expanded={menuOpen} aria-label={menuAriaLabel}
          title={running ? undefined : CHAOS_LOCKED_TITLE}
          onClick={toggleMenu}
          onKeyDown={e => { if (running && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleMenu() } }}
        >
          {'▾'}
        </div>
      ) : (
        <button
          type="button" className="kit-press"
          style={{ ...menuBtn, ...(!running ? lockedTone : {}) }} disabled={!running}
          aria-haspopup="true" aria-expanded={menuOpen} aria-label={menuAriaLabel}
          title={running ? undefined : CHAOS_LOCKED_TITLE}
          onClick={toggleMenu}
        >
          {'▾'}
        </button>
      )}
      {running && menuOpen && (
        <div style={menuStyle} data-testid="chaos-menu">
          {(Object.keys(FAULT_LABELS) as NonDownKind[]).map(kind => (
            <ChaosMenuRow key={kind} kind={kind} onApply={applyKind} />
          ))}
          {isFaulted && (
            <div
              role="button" tabIndex={0} className="kit-press" style={clearRow}
              onClick={clearFault}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clearFault() } }}
            >
              clear fault
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChaosMenuRow({ kind, onApply }: { kind: NonDownKind; onApply: (spec: FaultSpec) => void }): ReactElement {
  const param = FAULT_PARAM[kind]
  const [value, setValue] = useState(param.default)
  return (
    <div style={menuRow} data-testid={`chaos-menu-row-${kind}`}>
      <span style={menuRowLabel}>{FAULT_LABELS[kind]} <span style={{ color: 'var(--color-text-muted)' }}>({param.unit})</span></span>
      <NumberField label={`${FAULT_LABELS[kind]} ${param.unit}`} value={value} min={param.min} max={param.max} onCommit={setValue} />
      <button type="button" className="kit-press" style={applyBtn} onClick={() => onApply(specFor(kind, value))}>
        apply
      </button>
    </div>
  )
}
