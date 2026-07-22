// src/app/world/server/InspectorRail.tsx
// HUD inspector rail: a read panel per BoardSelection kind. Reads doc (useWorldStore) + live
// metrics (useServerDisplayMetrics); the instance/stack panels mount their matching edit form
// from `./inspectorForms.tsx` (WorkloadForm/RuntimeForm/VolumesEditor) — those forms own all
// world-store writes and self-lock via <fieldset disabled={running}> (D9). Rule rows drill into
// `{kind:'rule'}` for highlight only (no editing) — the firewall branch instead offers a single
// "edit rules…" opener that mounts FirewallRulesModal.tsx (firewall-rules-modal Task 2), which
// replaced the cramped inline FirewallEditor previously mounted here. Polish 3 T6 (D8, mockup
// `.b3insp`) re-housed the outer shell only — see the comment on the returned `<aside>` below;
// every other branch of `body` and `header()` above it is untouched from Phase 3/T4/T5.
import type { CSSProperties, ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useWorldStore } from '../../store/world.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { useServerDisplayMetrics } from './useServerDisplayMetrics'
import type { BoardSelection } from './selection'
import { WorkloadForm, RuntimeForm, VolumesEditor } from './inspectorForms'
import { SectionHeader, KIT_GLOW_TEXT } from '../ui/kit'
import { ruleSourceWords, rulePortPhrase } from './ruleSentence'
import './hwStyles'

const railText = { font: '7.5px var(--font-mono)', color: 'var(--color-text-secondary)', lineHeight: 1.9 } as const

const flowCaption: CSSProperties = {
  textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 9, letterSpacing: '0.1em', margin: '4px 0',
}

// Matches the rail's always-dark-scene dialect (KIT_GLOW_TEXT accent, not --kit-accent — same
// carve-out as the header() glyph above, since this button sits on the same hardcoded-dark
// background regardless of app theme).
const editRulesBtn: CSSProperties = {
  display: 'block', width: '100%', marginTop: 6, padding: '4px 8px', fontSize: 10,
  background: 'transparent', border: `1px solid ${KIT_GLOW_TEXT}55`, borderRadius: 4,
  color: KIT_GLOW_TEXT, cursor: 'pointer', textAlign: 'center',
}

export interface InspectorRailProps {
  serverId: string
  selection: BoardSelection | null
  onSelect: (s: BoardSelection | null) => void
  // Opens FirewallRulesModal (WorldShell-mounted) for this rail's server — the one way in from
  // the board's firewall/rule selection branch, kept separate from rule-row click-to-highlight.
  onOpenFirewallRules: () => void
}

export function InspectorRail({ serverId, selection, onSelect, onOpenFirewallRules }: InspectorRailProps): ReactElement {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const display = useServerDisplayMetrics(serverId)
  const server = doc.servers[serverId]
  const reduced = useReducedMotion()

  // The rail keeps a hardcoded dark scene background regardless of app theme (below), so it
  // can't ride SectionHeader's default --kit-accent, which flips to the light-theme teal under
  // data-theme="light" and would read at ~3.4:1 on this always-dark surface. KIT_GLOW_TEXT is
  // the one export from kit.tsx sanctioned for exactly this always-dark-mount case.
  const header = (title: string) => <SectionHeader label={`▸ INSPECTOR — ${title}`} accent={KIT_GLOW_TEXT} />

  let body: ReactElement
  if (!selection) {
    body = <div style={{ ...railText, color: 'var(--color-text-muted)', marginTop: 8 }}>click any element (chip · trace · gate · rule · core · volume) to inspect</div>
  } else if (selection.kind === 'instance') {
    const inst = compiled.instances[selection.instanceId]
    const bp = inst ? doc.blueprints[inst.blueprintId] : undefined
    const pl = inst ? doc.placements[inst.placementId] : undefined
    const m = display.instances[selection.instanceId]
    const rt = pl?.runtime
    const memLimit = rt?.type === 'container' ? rt.memLimitMb : null
    const oom = memLimit && m ? m.ramMb >= memLimit * 0.9 : false
    body = (
      <div style={{ ...railText, marginTop: 8 }}>
        <div style={{ color: '#DBEAFE' }}>{bp?.name}</div>
        <div>runtime <span style={{ color: '#C4B5FD' }}>{rt?.type}{rt?.type === 'container' ? ` · stack: ${rt.stackName}` : ''}</span></div>
        {rt?.type === 'container' && <div>binds <span style={{ color: '#9CC8FF' }}>{rt.portMappings.map(p => `:${p.host}→${p.container}`).join(' ') || '—'}</span></div>}
        {rt?.type === 'container' && <div>cpu {m?.cpuCoresUsed?.toFixed(1) ?? '—'}c of {rt.cpuLimit ?? '∞'}</div>}
        {rt?.type === 'container' && <div style={{ color: oom ? 'var(--color-danger)' : undefined }}>mem {m ? Math.round(m.ramMb) : '—'}M / {memLimit ?? '∞'}M {oom && '⚠'}</div>}
        <div style={{ marginTop: 7, color: '#475569', letterSpacing: '0.08em' }}>RESOURCES ON HOST</div>
        <div>p50 {m?.p50Ms?.toFixed(1) ?? '—'}ms · {m?.activeConnections ?? '—'} conn</div>
        {inst && <WorkloadForm key={inst.blueprintId} blueprintId={inst.blueprintId} />}
        {inst && rt?.type === 'container' && <RuntimeForm key={inst.placementId} placementId={inst.placementId} />}
      </div>
    )
  } else if (selection.kind === 'nic') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 8 }}>
      <div>speed {server?.specs.nicMbps} Mbps</div>
      <div>in {sm ? Math.round(sm.nicInMbps) : '—'} · out {sm ? Math.round(sm.nicOutMbps) : '—'} Mb/s</div>
    </div>
  } else if (selection.kind === 'firewall' || selection.kind === 'rule') {
    const rules = server?.firewall ?? []
    body = <div style={{ ...railText, marginTop: 8 }}>
      <div style={{
        border: '1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)',
        borderRadius: 6, padding: 8,
        background: 'color-mix(in srgb, var(--color-warning) 4%, transparent)',
        marginTop: 6,
      }}>
        <div style={flowCaption}>▼ evaluated top-down · first match wins ▼</div>
        {rules.map((r, i) => {
          const selected = selection.kind === 'rule' && selection.ruleId === r.id
          return (
            <div key={r.id} data-testid="fw-rule-row"
              onClick={() => onSelect(selected ? { kind: 'firewall' } : { kind: 'rule', ruleId: r.id })}
              style={{
                display: 'flex', gap: 6, fontSize: 10.5, padding: '4px 6px', borderRadius: 4,
                cursor: 'pointer', alignItems: 'baseline',
                background: selected ? 'color-mix(in srgb, var(--color-text-primary) 3%, transparent)' : undefined,
              }}>
              <span style={{ color: 'var(--color-text-muted)', width: 12, fontVariantNumeric: 'tabular-nums' }}>{i + 1}</span>
              <span>
                <span style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {r.action === 'allow' ? 'Let' : 'Block'}
                </span>{' '}
                <b style={{ color: '#DBEAFE' }}>{ruleSourceWords(r.source)}</b>{' '}
                {r.action === 'allow' ? 'reach' : 'reaching'}{' '}
                <b style={{ color: '#DBEAFE' }}>{rulePortPhrase(r)}</b>
                {r.protocol === 'udp' ? ' udp' : ''}
              </span>
            </div>
          )
        })}
        {/* Unconditional (firewall-rules-modal Task 2) — rendered whenever this branch is
            active regardless of rules.length or which rule (if any) is selected, so rule-adding
            stays reachable even from zero rules without an empty-list special case. Opens
            FirewallRulesModal.tsx, which replaced the old inline FirewallEditor mounted here. */}
        <button
          type="button" className="kit-press" data-testid="firewall-open-rules-modal"
          style={editRulesBtn} onClick={onOpenFirewallRules}
        >
          edit rules…
        </button>
        <div style={{ ...flowCaption, color: 'var(--color-danger)' }}>▼ everything else: DENIED ▼</div>
      </div>
    </div>
  } else if (selection.kind === 'stack') {
    const st = server?.stacks.find(s => s.name === selection.stackName)
    const members = Object.values(compiled.instances).filter(i => {
      const pl = doc.placements[i.placementId]
      return i.serverId === serverId && pl?.runtime.type === 'container' && pl.runtime.stackName === selection.stackName
    })
    body = <div style={{ ...railText, marginTop: 8 }}>
      <div>networks {st?.networks.map(n => n.cidr).join(', ') || '—'}</div>
      <div>volumes {st?.volumes.map(v => `${v.name} ${v.sizeGb}G`).join(', ') || '—'}</div>
      <div>members {members.map(i => doc.blueprints[i.blueprintId]?.name).join(', ') || '—'}</div>
      <VolumesEditor key={`${serverId}:${selection.stackName}`} serverId={serverId} stackName={selection.stackName} />
    </div>
  } else if (selection.kind === 'volume') {
    const consumers = Object.values(doc.blueprints).filter(b => b.volumeName === selection.volumeName)
    const vol = server?.stacks.find(s => s.name === selection.stackName)?.volumes.find(v => v.name === selection.volumeName)
    body = <div style={{ ...railText, marginTop: 8 }}>
      <div>size {vol?.sizeGb ?? '—'}G</div>
      <div>consumers {consumers.map(b => b.name).join(', ') || '—'}</div>
    </div>
  } else if (selection.kind === 'hardware') {
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 8 }}>
      {selection.part === 'cpu' && <div>cores {sm?.coreUtilization.length ?? server?.specs.vcpu} · steal {sm ? Math.round(sm.stealFraction * 100) : 0}%</div>}
      {selection.part === 'ram' && <div>ram {sm ? (sm.ramUsedMb / 1024).toFixed(1) : '—'}/{sm ? (sm.ramTotalMb / 1024).toFixed(0) : Math.round((server?.specs.ramMb ?? 0) / 1024)}G</div>}
      {selection.part === 'disk' && <div>io {sm ? Math.round(sm.diskIoFraction * 100) : 0}% · {server?.specs.diskGb}G</div>}
    </div>
  } else { // core
    const sm = display.server
    body = <div style={{ ...railText, marginTop: 8 }}>core {selection.coreIndex} · {sm ? Math.round((sm.coreUtilization[selection.coreIndex] ?? 0) * 100) : 0}%</div>
  }

  const title = selection?.kind === 'instance'
    ? (doc.blueprints[compiled.instances[selection.instanceId]?.blueprintId]?.name ?? 'instance')
    : (selection?.kind ?? 'server')
  // D8/T6 (mockup `.b3insp`): re-housed as a docked strip pinned to the board's bottom-right by
  // `bottom`/`right` (not `top`) — a collapsed empty-selection body is naturally just the header
  // + one hint line ("two-line dock strip"); selecting anything grows `body` underneath the SAME
  // byte-identical header/body pair, and because the box's BOTTOM edge stays pinned while its
  // height is intrinsic, the growth reads as "expands upward" for free, no JS/state needed. Was a
  // permanent-width flex sidebar (`width:240` + `borderLeft`) that always ate board layout width;
  // now an absolutely-positioned overlay (`position:relative` on ServerView's board wrapper is
  // the positioning ancestor) so the board itself gets the full width back regardless of
  // selection state ("never eats the board" — spec D8).
  return (
    <aside data-inspector-rail data-expanded={selection !== null} style={{
      position: 'absolute', right: 16, bottom: 16, width: 280, maxHeight: 'calc(100% - 32px)',
      borderRadius: 8, border: '1px solid #1E2734', background: 'linear-gradient(180deg,#0D1117EE,#0A0D12EE)',
      boxShadow: '0 12px 32px #00000066', padding: 10, overflowY: 'auto', zIndex: 4,
    }}>
      {/* mockup .b3insp::after scan sweep — purely decorative, so it's the one part of this
          shell allowed to be reduced-motion-gated without affecting body/dispatches. */}
      {!reduced && (
        <div aria-hidden="true" className="hw-scan" style={{
          position: 'absolute', left: 0, right: 0, height: 22, top: '-20%', overflow: 'hidden',
          background: 'linear-gradient(180deg, transparent, #7cffe90a, transparent)',
          animation: 'hw-scanline 3.6s linear infinite', pointerEvents: 'none',
        }} />
      )}
      {header(title)}
      {body}
    </aside>
  )
}
