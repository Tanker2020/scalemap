// src/app/world/server/FirewallGate.tsx
// Polish 3 T5 (spec D7): a shield built from its own rules, transcribed from the mockup's `.b3fw2`
// (docs/superpowers/specs/mockups/level-redesign-v5.html lines 168-180) — clip-path shield/inner
// layers, up to 4 rule "slats" (allow=green/deny=red) via `shieldSlats`, a scan sweep, a beacon
// (present once the firewall has any rule), and reject sparks driven by the real blocked/s count
// (`gateStats.blockedPerSecond`, one spark stroke max per the motion budget). `data-firewall` +
// the single `onSelect()` click dispatch are preserved byte-for-byte from the pre-T5 gate —
// clicking the shield OR any slat bubbles to the SAME onClick, so InspectorRail's firewall
// selection wiring at the ServerBoard.tsx call site needs no change.
import type { CSSProperties, ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import './gateStyles'
import type { Box } from './boardLayout'
import type { FirewallRule } from '../../../lib/world/types'

const AMBER = '#E0A552'
const SHIELD_CLIP = 'polygon(50% 0, 100% 9%, 100% 91%, 50% 100%, 0 91%, 0 9%)'
const SHIELD_BODY_GRADIENT = 'linear-gradient(180deg, #7a5a26, #3a2c12)'
const SHIELD_INNER_GRADIENT = 'linear-gradient(180deg, #17120a, #100c06)'

export interface RuleSlat { kind: 'rule'; rule: FirewallRule }
export interface MoreSlat { kind: 'more'; count: number }
export type ShieldSlat = RuleSlat | MoreSlat

// D7: rules.length <= maxSlats -> every rule as its own slat; else the first (maxSlats - 1)
// rules keep their own slat and the remainder folds into one trailing {kind:'more'} slat, so
// the shield never grows past `maxSlats` slats regardless of rule count.
export function shieldSlats(rules: FirewallRule[], maxSlats = 4): ShieldSlat[] {
  if (rules.length <= maxSlats) return rules.map(rule => ({ kind: 'rule', rule }))
  const head: ShieldSlat[] = rules.slice(0, maxSlats - 1).map(rule => ({ kind: 'rule', rule }))
  return [...head, { kind: 'more', count: rules.length - (maxSlats - 1) }]
}

export interface FirewallGateProps {
  box: Box
  rules: FirewallRule[]
  blockedPerSecond?: number
  trafficActive?: boolean      // server inbound rps > 0 — gates the allow slat's edge-dot
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
}

// Slats are evenly distributed down the shield's inner band, clear of the clip-path's top/bottom
// corner cuts (9%/91%) — the mockup only ever shows the 2-rule case (fixed 25%/52%); this
// generalizes to up to 4 slats.
function slatTop(index: number, count: number): number {
  if (count <= 1) return 40
  const bandTop = 14, bandBottom = 88 - 15
  return bandTop + (index * (bandBottom - bandTop)) / (count - 1)
}

function slatLabel(rule: FirewallRule, index: number): string {
  const port = rule.port === 'any' ? 'any' : `:${rule.port}`
  return `${index + 1} · ${port} ${rule.action === 'allow' ? '✓' : '✕'}`
}

function slatStyle(index: number, count: number, slat: ShieldSlat): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute', left: '11%', right: '11%', top: `${slatTop(index, count)}%`, height: '15%',
    borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 6.5, letterSpacing: '0.02em', whiteSpace: 'nowrap',
  }
  if (slat.kind === 'more') {
    return { ...base, background: 'color-mix(in srgb, var(--color-text-secondary) 12%, transparent)', border: '1px solid var(--color-node-border)', color: 'var(--color-text-secondary)' }
  }
  return slat.rule.action === 'allow'
    ? { ...base, background: '#22c55e12', border: '1px solid #22c55e50', color: 'var(--color-success)' }
    : { ...base, background: '#ef444412', border: '1px solid #ef444450', color: 'var(--color-danger)' }
}

export function FirewallGate({ box, rules, blockedPerSecond, trafficActive, selected, dimmed, onSelect }: FirewallGateProps): ReactElement {
  const reduced = useReducedMotion()
  const slats = shieldSlats(rules)
  const hasRules = rules.length > 0
  const showSpark = !reduced && (blockedPerSecond ?? 0) > 0

  return (
    <div data-firewall className="gw-shield"
      style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, cursor: 'pointer', opacity: dimmed ? 0.45 : 1 }}
      onClick={onSelect}>
      {/* nowrap + center-anchor — wrapping dropped "· N RULES" onto the shield face (same
          label-occlusion fix as NicBlock's, user screenshot 2026-07-11). */}
      <span style={{ position: 'absolute', top: -16, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: 8, color: AMBER, letterSpacing: '0.08em', textShadow: `0 0 6px ${AMBER}` }}>
        FIREWALL · {rules.length} RULE{rules.length === 1 ? '' : 'S'}
      </span>
      <div style={{
        position: 'absolute', inset: 0, clipPath: SHIELD_CLIP, background: SHIELD_BODY_GRADIENT,
        boxShadow: selected ? `0 0 14px ${AMBER}` : '0 0 16px #e0a55226',
        outline: selected ? `1.5px solid ${AMBER}` : undefined,
      }} />
      <div style={{ position: 'absolute', inset: 2, clipPath: SHIELD_CLIP, background: SHIELD_INNER_GRADIENT, overflow: 'hidden' }}>
        {slats.map((slat, i) => (
          <div key={slat.kind === 'rule' ? slat.rule.id : 'more'} data-testid={slat.kind === 'rule' ? 'fw-slat-rule' : 'fw-slat-more'}
            style={slatStyle(i, slats.length, slat)}>
            {slat.kind === 'rule' ? slatLabel(slat.rule, i) : `+${slat.count} more`}
            {slat.kind === 'rule' && slat.rule.action === 'allow' && trafficActive && (
              <span data-testid="fw-edge-dot" className={reduced ? undefined : 'gw-edgedot'} style={{
                position: 'absolute', right: -3, top: '50%', width: 6, height: 6, borderRadius: '50%',
                background: 'var(--color-success)', boxShadow: '0 0 6px var(--color-success)', transform: 'translateY(-50%)',
                animation: reduced ? undefined : 'gw-blink 1.6s steps(1) infinite',
              }} />
            )}
          </div>
        ))}
        {!reduced && (
          <div className="gw-scan" style={{
            position: 'absolute', left: '8%', right: '8%', height: '14%',
            background: 'linear-gradient(180deg, transparent, #e0a5521c, transparent)',
            animation: 'gw-scanline 2.8s linear infinite',
          }} />
        )}
      </div>
      {hasRules && (
        <span data-testid="fw-beacon" className={reduced ? undefined : 'gw-beacon'} style={{
          position: 'absolute', top: -5, left: '50%', width: 7, height: 7, borderRadius: '50%',
          background: AMBER, boxShadow: `0 0 9px ${AMBER}`, transform: 'translateX(-50%)',
          animation: reduced ? undefined : 'gw-blink 2.2s steps(1) infinite',
        }} />
      )}
      {showSpark && (
        <span data-testid="fw-spark" className="gw-spark" style={{
          position: 'absolute', left: -10, top: '62%', width: 8, height: 3, borderRadius: 2,
          background: 'var(--color-danger)', animation: 'gw-fwspark 2.4s linear infinite 0.9s',
        }} />
      )}
    </div>
  )
}
