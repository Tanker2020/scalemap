// Hybrid panel UI kit (Polish 1 D1/D2) — the shared instrument-skin components every authoring
// panel migrates onto in T2–T4. Small, always-used-together components; kept as ONE file by
// design (see task brief). Token-only styling — the only sanctioned raw hexes in the app are
// the glow constants below, exposed to CSS as --kit-* vars so consumers stay theme-correct.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// ─── sanctioned hexes (ONLY here, no other file — consumers use the --kit-* CSS vars below,
// never these constants directly) ────────────────────────────────────────────────
// Exported (unlike its siblings below) as the one scene-surface accent for always-dark mounts
// that can't ride the --kit-accent CSS var (e.g. server/InspectorRail.tsx, which keeps a
// hardcoded dark background regardless of theme — see Item 3 of the final-review fix wave).
export const KIT_GLOW_TEXT = '#7CFFE9'
const KIT_GLOW_DIM = '#2DD4BF44'
const KIT_TEAL = '#2DD4BF'
const KIT_GLOW_TEXT_LIGHT = '#0F766E'
const KIT_GLOW_DIM_LIGHT = '#0F766E33'
const KIT_TEAL_LIGHT = '#288177'

// ─── injected stylesheet (once) ─────────────────────────────────────────────────
const KIT_STYLE_ID = 'scalemap-kit-styles'
if (typeof document !== 'undefined' && !document.getElementById(KIT_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = KIT_STYLE_ID
  style.textContent = `
:root {
  --kit-accent: ${KIT_GLOW_TEXT};
  --kit-accent-dim: ${KIT_GLOW_DIM};
  --kit-teal: ${KIT_TEAL};
}
:root[data-theme="light"] {
  --kit-accent: ${KIT_GLOW_TEXT_LIGHT};
  --kit-accent-dim: ${KIT_GLOW_DIM_LIGHT};
  --kit-teal: ${KIT_TEAL_LIGHT};
}
.kit-row { border: 1px solid transparent; }
.kit-row:hover {
  background: var(--color-surface-hover); border-color: var(--color-node-border);
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0,0,0,0.4), 0 0 0 1px color-mix(in srgb, var(--color-accent) 13%, transparent);
}
.kit-pcard:hover {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 27%, transparent), 0 6px 18px rgba(0,0,0,0.31);
}
.kit-t { transition: all 0.15s ease; }
.kit-press { transition: border-color 0.12s ease, transform 0.08s ease, box-shadow 0.12s ease; }
.kit-press:hover {
  border-color: var(--kit-accent) !important;
  box-shadow: 0 0 10px color-mix(in srgb, var(--kit-accent) 13%, transparent);
}
.kit-press:active { transform: scale(0.96); }
.kit-ripple { position: relative; }
.kit-ripple::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  background: currentColor; animation: kit-ripple 1.6s ease-out infinite; pointer-events: none;
}
@keyframes kit-ripple {
  from { transform: scale(1); opacity: 0.5; }
  to { transform: scale(3.2); opacity: 0; }
}
.kit-ink {
  position: absolute; bottom: 0; height: 2px; background: var(--kit-accent);
  border-radius: 1px; box-shadow: 0 0 6px var(--kit-accent-dim);
  transition: left 0.2s cubic-bezier(0.3, 0.8, 0.3, 1), width 0.2s cubic-bezier(0.3, 0.8, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .kit-t, .kit-press, .kit-ink { transition: none; }
  .kit-ripple::after { animation: none; opacity: 0; }
  .kit-row:hover { transform: none; box-shadow: none; }
  .react-flow__edge.animated .react-flow__edge-path { animation: none; }
}
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
`
  document.head.appendChild(style)
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

// ─── SectionHeader ───────────────────────────────────────────────────────────────
export interface SectionHeaderProps {
  label: string
  trailing?: ReactNode
  accent?: string   // 6-digit hex — dim variant derived as `${accent}44`
}

export function SectionHeader({ label, trailing, accent }: SectionHeaderProps) {
  const color = accent ?? 'var(--kit-accent)'
  const glow = accent ? `${accent}44` : 'var(--kit-accent-dim)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 8px', minWidth: 0 }}>
      <span style={{
        fontSize: 9.5, letterSpacing: '0.15em', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0,
        color, textShadow: `0 0 8px ${glow}`,
      }}>
        {label}
      </span>
      <div style={{ height: 1, flex: 1, minWidth: 8, background: `linear-gradient(90deg, ${glow}, transparent)` }} />
      {trailing != null && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>{trailing}</div>}
    </div>
  )
}

// ─── EdgeRow ─────────────────────────────────────────────────────────────────────
export type EdgeRowStatus = 'healthy' | 'degraded' | 'down' | null

export interface EdgeRowProps {
  children: ReactNode
  status?: EdgeRowStatus
  edgeColor?: string
  trailing?: ReactNode
  onClick?: () => void
}

const STATUS_COLOR: Record<'healthy' | 'degraded' | 'down', string> = {
  healthy: 'var(--color-success)',
  degraded: 'var(--color-warning)',
  down: 'var(--color-danger)',
}

export function EdgeRow({ children, status, edgeColor, trailing, onClick }: EdgeRowProps) {
  const style: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5,
    marginBottom: 3,
  }
  if (edgeColor) {
    style.borderLeft = `2px solid ${edgeColor}`
    style.background = 'var(--color-node-base)'
  }
  if (onClick) style.cursor = 'pointer'
  return (
    <div className="kit-row kit-t" style={style} onClick={onClick}>
      {status !== undefined && (
        <span
          data-testid="kit-dot"
          style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: status === null ? 'var(--color-text-muted)' : STATUS_COLOR[status],
            boxShadow: status === null ? 'none' : `0 0 5px ${STATUS_COLOR[status]}`,
          }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {trailing}
    </div>
  )
}

// ─── ChipValue ───────────────────────────────────────────────────────────────────
export interface ChipValueProps {
  children: ReactNode
  title?: string
}

export function ChipValue({ children, title }: ChipValueProps) {
  return (
    <span
      title={title}
      style={{
        border: '1px solid var(--color-node-border)', borderRadius: 3, padding: '0 7px',
        fontSize: 11, background: 'var(--color-canvas)', color: 'var(--color-text-primary)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </span>
  )
}

// ─── SpecBar ─────────────────────────────────────────────────────────────────────
export interface SpecBarProps {
  label: string
  fraction: number
  color: string
  value: string
}

export function SpecBar({ label, fraction, color, value }: SpecBarProps) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '42px 1fr 58px', gap: 8, fontSize: 10,
      color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums', marginBottom: 4,
      alignItems: 'center',
    }}>
      <span>{label}</span>
      <div style={{ height: 5, background: 'var(--color-canvas)', borderRadius: 3, overflow: 'hidden' }}>
        <div
          data-testid="kit-specbar-fill"
          style={{ height: '100%', width: `${clamp01(fraction) * 100}%`, background: color }}
        />
      </div>
      <span>{value}</span>
    </div>
  )
}

// ─── MicroBars ───────────────────────────────────────────────────────────────────
export interface MicroBarsProps {
  cpu: number
  ram: number
  io: number
}

export function MicroBars({ cpu, ram, io }: MicroBarsProps) {
  const bars: Array<{ v: number; color: string }> = [
    { v: cpu, color: 'var(--color-accent)' },
    { v: ram, color: 'var(--color-warning)' },
    { v: io, color: 'var(--kit-teal)' },
  ]
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 14 }}>
      {bars.map((b, i) => (
        <span
          key={i}
          data-testid="kit-microbar"
          style={{
            width: 3, borderRadius: 1, background: b.color,
            height: `${Math.round(clamp01(b.v) * 100)}%`,
          }}
        />
      ))}
    </div>
  )
}

// ─── DerivedField ────────────────────────────────────────────────────────────────
export interface DerivedFieldProps {
  label: string
  value: number
  min?: number
  max?: number
  onCommit: (n: number) => void
  mode?: 'input' | 'slider'
  unit?: string
  derive?: (liveValue: number) => string
  deriveTone?: 'accent' | 'warning'
  disabled?: boolean
}

const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
  fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-text-primary)',
}

export function DerivedField({
  label, value, min, max, onCommit, mode = 'input', unit, derive, deriveTone = 'accent', disabled,
}: DerivedFieldProps) {
  const lo = min ?? -Infinity
  const hi = max ?? Infinity

  // ─ input mode local state ─
  const [text, setText] = useState(String(value))
  useEffect(() => { setText(String(value)) }, [value])

  // ─ slider mode local state (live, uncommitted) ─
  const [local, setLocal] = useState(value)
  // Tracks whether the user has actually moved the slider since the last commit/resync — guards
  // against a keyUp/blur firing commitSlider from mere focus traversal (tabbing in/through) when
  // the stored `value` sits outside [min,max] (settable elsewhere without full clamping, e.g.
  // inspectorForms' WorkloadForm) and `local`'s clamp would otherwise dispatch an unsolicited
  // commit. Only mouse/touch drags and actual range keystrokes fire onChange.
  const interacted = useRef(false)
  useEffect(() => { setLocal(value); interacted.current = false }, [value])

  const commitInput = () => {
    const n = Number(text)
    if (!Number.isFinite(n)) { setText(String(value)); return }
    const c = clamp(n, lo, hi)
    setText(String(c))
    if (c !== value) onCommit(c)
  }

  const commitSlider = () => {
    if (!interacted.current) return
    const c = clamp(local, lo, hi)
    interacted.current = false
    if (c !== value) onCommit(c)
  }

  const deriveColor = deriveTone === 'warning' ? 'var(--color-warning)' : 'var(--kit-teal)'
  const deriveLine = (liveValue: number) => {
    if (!derive) return null
    const derivedText = derive(liveValue)
    if (!derivedText) return null
    return (
      <div style={{ fontSize: 10.5, marginTop: 4, fontVariantNumeric: 'tabular-nums', color: deriveColor }}>
        {derivedText}
      </div>
    )
  }

  return (
    <div>
      <label style={{ display: 'block', fontSize: 10.5, color: 'var(--color-text-secondary)', marginBottom: 5 }}>
        {label}
      </label>
      {mode === 'slider' ? (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="range"
              aria-label={label}
              style={{ flex: 1, accentColor: 'var(--color-accent)' }}
              min={min}
              max={max}
              value={local}
              disabled={disabled}
              onChange={e => { interacted.current = true; setLocal(Number(e.target.value)) }}
              onMouseUp={commitSlider}
              onTouchEnd={commitSlider}
              onKeyUp={commitSlider}
              onBlur={commitSlider}
            />
            <span style={{ width: 64, textAlign: 'right', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
              {local}{unit ? ` ${unit}` : ''}
            </span>
          </div>
          {deriveLine(local)}
        </>
      ) : (
        <>
          <input
            aria-label={label}
            style={fieldStyle}
            value={text}
            disabled={disabled}
            onChange={e => setText(e.target.value)}
            onBlur={commitInput}
            onKeyDown={e => { if (e.key === 'Enter') commitInput() }}
          />
          {deriveLine(Number(text))}
        </>
      )}
    </div>
  )
}

// ─── Segmented ───────────────────────────────────────────────────────────────────
export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export interface SegmentedProps<T extends string> {
  ariaLabel: string
  value: T
  onChange: (v: T) => void
  options: Array<SegmentedOption<T>>
}

export function Segmented<T extends string>({ ariaLabel, value, onChange, options }: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex', border: '1px solid var(--color-node-border)', borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            style={{
              padding: '5px 12px', fontSize: 11, background: selected
                ? 'color-mix(in srgb, var(--color-accent) 13%, transparent)' : 'transparent',
              color: selected ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              border: 'none',
              borderRight: i < options.length - 1 ? '1px solid var(--color-node-border)' : 'none',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── PresetCardGrid ──────────────────────────────────────────────────────────────
export interface PresetCardOption {
  value: string
  name: string
  detail: string
  price: string
}

export interface PresetCardGridProps {
  value: string
  onChange: (v: string) => void
  options: PresetCardOption[]
}

export function PresetCardGrid({ value, onChange, options }: PresetCardGridProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {options.map(opt => {
        const selected = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            className="kit-pcard kit-t"
            aria-pressed={selected}
            onClick={() => onChange(opt.value)}
            style={{
              textAlign: 'left',
              border: selected ? '1px solid var(--color-accent)' : '1px solid var(--color-node-border)',
              borderRadius: 8, padding: 10,
              background: selected
                ? 'color-mix(in srgb, var(--color-accent) 5%, transparent)' : 'var(--color-node-base)',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {opt.name}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--color-text-muted)', margin: '2px 0 6px' }}>
              {opt.detail}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--color-warning)' }}>
              {opt.price}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ─── Explainer ───────────────────────────────────────────────────────────────────
export interface ExplainerProps {
  children: ReactNode
}

export function Explainer({ children }: ExplainerProps) {
  return (
    <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)', lineHeight: 1.5, marginTop: 4 }}>
      {children}
    </div>
  )
}
