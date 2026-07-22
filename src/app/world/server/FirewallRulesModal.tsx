// src/app/world/server/FirewallRulesModal.tsx
// Replacement for the cramped inline firewall-rule editor (inspectorForms.tsx's FirewallEditor,
// mounted in InspectorRail.tsx's 280px HUD panel) with a spacious modal — same "cramped dock
// form -> modal" story as ManagedServiceModal.tsx (panels/), whose shell (portal, backdrop,
// capture-phase Escape) this file copies closely. NOT mounted anywhere yet (a later task wires
// it into InspectorRail.tsx in place of FirewallEditor) — this file is standalone and unmounted.
//
// Deliberate deviation from ManagedServiceModal: NO draft/Save/Cancel staging. Every field
// change writes immediately via updateServer(serverId, { firewall: next }) — exactly like
// FirewallEditor does today. Every possible FirewallRule value combination is valid by
// construction, so there is no "invalid intermediate state" for a Cancel button to protect
// against (unlike a managed service's many interdependent fields).
//
// Edit-lock: createPortal renders this modal's DOM under document.body, OUTSIDE the React tree
// that holds WorldPanel.tsx's dock-wide `<fieldset disabled={running}>` (and outside
// InspectorRail's tree too) — that fieldset never reaches here, so the rule table + "+ add rule"
// get their own `<fieldset disabled={running}>` wrapper. The header's `close` button stays
// OUTSIDE that fieldset — it is this modal's only exit control, so there is always an escape
// hatch even mid-run.
import { Fragment, useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { nextWorldId } from '../../../lib/world/factories'
import type { FirewallRule } from '../../../lib/world/types'
import { SectionHeader, Segmented } from '../ui/kit'

export interface FirewallRulesModalProps {
  open: boolean
  serverId: string | null
  onClose: () => void
}

const backdropStyle: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
// Wider than ManagedServiceModal's 520 — this needs room for a multi-column rule table.
const surfaceStyle: CSSProperties = {
  width: 640, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto',
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
// NOTE: ManagedServiceModal.tsx's style dialect also carries btnLocked/rowLabel/rowGap, used
// there for its label-above-input rows and a disableable submit button. This modal's flatter
// grid-table layout (column headers instead of per-field <label>s, no submit button — every
// change writes immediately, see the file header comment) has no consumer for those three, so
// they're intentionally not copied here rather than left as unused dead code (noUnusedLocals).
const smallBtnStyle: CSSProperties = {
  background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '4px 10px', cursor: 'pointer',
  font: '11px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const iconBtnStyle: CSSProperties = { ...smallBtnStyle, padding: '2px 6px', fontSize: 10.5 }

// Reused verbatim from InspectorRail.tsx's kind==='firewall' branch — same copy/tone/styling.
const ruleBox: CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)',
  borderRadius: 6, padding: 8,
  background: 'color-mix(in srgb, var(--color-warning) 4%, transparent)',
  marginTop: 6,
}
const flowCaption: CSSProperties = {
  textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 9, letterSpacing: '0.1em', margin: '4px 0',
}

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '22px 84px 60px 70px minmax(190px, 1fr) 52px 26px',
  columnGap: 8, rowGap: 6, alignItems: 'center', marginTop: 6,
}
const gridHeaderCell: CSSProperties = { color: 'var(--color-text-muted)', fontSize: 9.5, letterSpacing: '0.05em' }

function sourceOptionOf(source: FirewallRule['source']): 'any' | 'internal' {
  return source === 'internal' ? 'internal' : 'any'
}

// Owns its own local "am I mid-typing a custom CIDR" state, keyed (via the parent's `key={r.id}`)
// per rule so switching rules never bleeds pending text across rows. `customText === null` means
// "not in custom mode"; a non-null string (possibly '') is the live custom-mode text, committed
// on every keystroke once non-empty — see the brief's "no empty-string source" rule below.
function SourceCell({ rule, index, onPatch }: {
  rule: FirewallRule
  index: number
  onPatch: (patch: Partial<FirewallRule>) => void
}): ReactElement {
  const initialCustom = rule.source !== 'any' && rule.source !== 'internal'
  const [customText, setCustomText] = useState<string | null>(initialCustom ? rule.source : null)
  const activeOption: 'any' | 'internal' | 'custom' = customText !== null ? 'custom' : sourceOptionOf(rule.source)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Segmented
        ariaLabel={`source for rule ${index + 1}`}
        value={activeOption}
        onChange={v => {
          if (v === 'custom') { setCustomText(''); return }
          setCustomText(null)
          onPatch({ source: v })
        }}
        options={[{ value: 'any', label: 'any' }, { value: 'internal', label: 'internal' }, { value: 'custom', label: 'custom' }]}
      />
      {activeOption === 'custom' && (
        <input
          aria-label={`source cidr for rule ${index + 1}`}
          style={field}
          placeholder="10.0.0.0/8"
          value={customText ?? rule.source}
          onChange={e => {
            const v = e.target.value
            setCustomText(v)
            // Do NOT commit an empty custom value — an empty string as `source` would silently
            // create a match-everything rule, worse than not committing yet.
            if (v !== '') onPatch({ source: v })
          }}
        />
      )}
    </div>
  )
}

export function FirewallRulesModal({ open, serverId, onClose }: FirewallRulesModalProps): ReactElement | null {
  const running = useSimulationStore(s => s.running)
  // Guard the lookup key, not the hook call — every hook below must run unconditionally on every
  // render, even when `open`/`serverId` are falsy, so hook order never changes across renders.
  const server = useWorldStore(s => s.doc.servers[serverId ?? ''])

  // Capture-phase Esc: fires BEFORE WorldShell's bubble-phase Escape-goes-up handler (same
  // mechanism ServerView.tsx/SettingsModal.tsx/ManagedServiceModal.tsx already use — capture
  // always precedes bubble for a `window` listener regardless of mount order). stopPropagation
  // halts the event's entire remaining traversal, including its own return trip through window's
  // bubble phase, so WorldShell's handler never runs for this keydown at all; preventDefault is
  // belt-and-suspenders in case that return trip somehow still occurs (WorldShell's handler also
  // bails on defaultPrevented).
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

  if (!open || !serverId) return null
  if (!server) return null

  const rules = server.firewall
  const commit = (next: FirewallRule[]) => useWorldStore.getState().updateServer(serverId, { firewall: next })
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rules.length) return
    const next = [...rules]; [next[i], next[j]] = [next[j], next[i]]; commit(next)
  }
  const patch = (i: number, p: Partial<FirewallRule>) => commit(rules.map((r, k) => (k === i ? { ...r, ...p } : r)))

  return createPortal(
    <div style={backdropStyle} onClick={onClose}>
      <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ font: '600 12px var(--font-mono)' }}>
            {server.label} · {rules.length} rule{rules.length === 1 ? '' : 's'}
          </span>
          <button style={smallBtnStyle} onClick={onClose}>close</button>
        </div>

        <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0, minInlineSize: 0 }}>
          <SectionHeader label="▸ RULES" />
          <div style={ruleBox}>
            <div style={flowCaption}>▼ evaluated top-down · first match wins ▼</div>

            <div style={grid}>
              <div style={gridHeaderCell}>#</div>
              <div style={gridHeaderCell}>action</div>
              <div style={gridHeaderCell}>port</div>
              <div style={gridHeaderCell}>protocol</div>
              <div style={gridHeaderCell}>source</div>
              <div style={gridHeaderCell} />
              <div style={gridHeaderCell} />
              {rules.map((r, i) => (
                <Fragment key={r.id}>
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</div>
                  <select
                    aria-label={`action for rule ${i + 1}`} style={field} value={r.action}
                    onChange={e => patch(i, { action: e.target.value as FirewallRule['action'] })}
                  >
                    <option value="allow">allow</option>
                    <option value="deny">deny</option>
                  </select>
                  <input
                    aria-label={`port for rule ${i + 1}`} style={field} value={String(r.port)}
                    onChange={e => {
                      const raw = e.target.value
                      if (raw === 'any' || raw === '') { patch(i, { port: 'any' }); return }
                      const n = Number(raw)
                      patch(i, { port: Number.isFinite(n) && n >= 0 ? n : 'any' })
                    }}
                  />
                  <select
                    aria-label={`protocol for rule ${i + 1}`} style={field} value={r.protocol}
                    onChange={e => patch(i, { protocol: e.target.value as FirewallRule['protocol'] })}
                  >
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                    <option value="any">any</option>
                  </select>
                  <SourceCell rule={r} index={i} onPatch={p => patch(i, p)} />
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" aria-label="move rule up" style={iconBtnStyle} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" aria-label="move rule down" style={iconBtnStyle} onClick={() => move(i, 1)}>↓</button>
                  </div>
                  <button
                    type="button" aria-label="remove rule" style={iconBtnStyle}
                    onClick={() => commit(rules.filter((_, k) => k !== i))}
                  >
                    ✕
                  </button>
                </Fragment>
              ))}
            </div>

            <button
              type="button" aria-label="add rule" style={{ ...btn, marginTop: 8 }}
              onClick={() => commit([...rules, { id: nextWorldId('fw'), action: 'allow', port: 'any', protocol: 'tcp', source: 'any' }])}
            >
              + add rule
            </button>

            <div style={{ ...flowCaption, color: 'var(--color-danger)' }}>▼ everything else: DENIED ▼</div>
          </div>
        </fieldset>
      </div>
    </div>,
    document.body,
  )
}
