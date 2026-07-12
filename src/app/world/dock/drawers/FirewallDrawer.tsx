// src/app/world/dock/drawers/FirewallDrawer.tsx
// Polish 4 T4 (spec D6): the FIREWALL drawer body — numbered rule sentences built with the
// board's EXISTING grammar helpers (`server/ruleSentence.ts`'s `ruleSourceWords`/
// `rulePortPhrase` — imported, not re-derived, per the brief), `Let`/`Block` colored
// success/danger. `+ rule` appends `createServer`'s default rule shape (factories.ts)
// byte-for-byte via `updateServer(id, { firewall: [...] })` — deep rule editing stays on the
// board (InspectorRail), this drawer only appends/reads.
//
// T8 motion/theme audit fix: the source/port id spans originally copied InspectorRail.tsx's
// exact hardcoded `#DBEAFE` (a light pastel blue calibrated for InspectorRail's OWN
// always-dark scene background — see InspectorRail.tsx's "hardcoded dark scene ... regardless
// of app theme" comment). This drawer's body is below-header dock chrome, not a scene — it
// already sits on `var(--color-canvas)`, which flips to near-white in light theme, so the
// literal hex read as near-invisible light-on-light text there. Swapped to `var(--kit-accent)`,
// the SAME theme-aware id/hud accent every other dock surface already uses (AtlasHeader's ring,
// ScopeRail's "here" pill) — legible in both themes, per D3/D11.
//
// Polish 4 T5 (spec D7): the BODY sentences are unchanged while watching — the frozen metrics
// contract carries no per-rule or blocked-connection counter to re-voice them with, and the
// engine is frozen (no new counter to add). Only the pv readout re-voices, to `≈N req/s
// allowed` where N is the server's summed instance rps (ServerFaceplate computes it once,
// shared with HardwareDrawer's live rps row) — a RATIFIED documented deviation from the mock's
// `418 allowed/s · 0 blocked` (task-5-brief.md).
import { type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { nextWorldId } from '../../../../lib/world/factories'
import { ruleSourceWords, rulePortPhrase } from '../../server/ruleSentence'
import type { Server } from '../../../../lib/world/types'

export function firewallPv(server: Server, liveAllowedRps?: number | null): string {
  if (liveAllowedRps != null) return `≈${Math.round(liveAllowedRps).toLocaleString('en-US')} req/s allowed`
  const allow = server.firewall.filter(r => r.action === 'allow').length
  const deny = server.firewall.filter(r => r.action === 'deny').length
  return `${allow} allow · ${deny} deny`
}

export interface FirewallDrawerProps {
  server: Server
  running: boolean
}

const SENTENCE_ID_COLOR = 'var(--kit-accent)'

export function FirewallDrawer({ server, running }: FirewallDrawerProps): ReactElement {
  const addRule = () => {
    // Byte-for-byte the same default rule shape createServer() (factories.ts) gives a fresh
    // server: allow · any port · any protocol · internal source. `nextWorldId('fw')` is the
    // SAME id generator factories.ts already exports and uses for this exact purpose.
    const rule = { id: nextWorldId('fw'), action: 'allow' as const, port: 'any' as const, protocol: 'any' as const, source: 'internal' }
    useWorldStore.getState().updateServer(server.id, { firewall: [...server.firewall, rule] })
  }

  return (
    <div data-testid="firewall-drawer-body">
      {server.firewall.map((r, i) => (
        <div
          key={r.id} data-testid="firewall-drawer-sentence"
          style={{
            color: 'var(--color-text-secondary)', background: 'var(--color-canvas)',
            borderLeft: '2px solid var(--kit-accent-dim)', borderRadius: 5, padding: '6px 9px',
            margin: '4px 0', lineHeight: 1.6, fontSize: 10,
          }}
        >
          {i + 1} · <b style={{ color: r.action === 'allow' ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {r.action === 'allow' ? 'Let' : 'Block'}
          </b>{' '}
          <b style={{ color: SENTENCE_ID_COLOR }}>{ruleSourceWords(r.source)}</b>{' '}
          {r.action === 'allow' ? 'reach' : 'reaching'}{' '}
          <b style={{ color: SENTENCE_ID_COLOR }}>{rulePortPhrase(r)}</b>
          {r.protocol === 'udp' ? ' udp' : ''}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
        <button
          type="button" className="kit-press" data-testid="firewall-add-rule"
          style={{
            font: '10px var(--font-mono)', background: 'var(--color-node-base)',
            border: '1px solid var(--color-node-border)', borderRadius: 5, padding: '4px 12px',
            color: 'var(--color-text-secondary)', cursor: running ? 'default' : 'pointer',
            opacity: running ? 0.35 : 1,
          }}
          disabled={running}
          title={running ? 'stop the simulation to edit' : undefined}
          onClick={addRule}
        >
          + rule
        </button>
      </div>
      <div style={{ fontSize: 9.5, color: 'var(--color-text-muted)', marginTop: 6 }}>
        edit rules on the board
      </div>
    </div>
  )
}
