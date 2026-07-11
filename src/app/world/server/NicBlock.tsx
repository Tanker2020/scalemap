// src/app/world/server/NicBlock.tsx
// Polish 3 T5 (spec D6): a physical RJ45 jack, transcribed from the mockup's `.b3nic .jack`
// (docs/superpowers/specs/mockups/level-redesign-v5.html lines 142-165) — bezel, keystone-notch
// socket (clip-path verbatim), an 8-pin gold row with staggered ripple, LINK/ACT LEDs, and 3
// decorative intake packet lanes converging on the jack mouth. No container rectangle (background/
// border: none on the outer block — only the jack bezel itself is drawn). Live wiring: pin ripple
// rate follows NIC throughput (idle = 0 in/out -> pins rest at 0.45 opacity, no ripple), LINK is
// steady success while the server isn't down (off when it is), ACT blinks at a period inversely
// proportional to inbound rps (dark at rps 0). All ripple/blink/lane motion no-ops under
// prefers-reduced-motion (LEDs render statically on/off instead).
import type { CSSProperties, ReactElement } from 'react'
import { useReducedMotion } from 'framer-motion'
import './gateStyles'
import type { Box } from './boardLayout'
import type { HealthState } from '../../../lib/worldEngine/types'

const JACK_TEAL = '#3FC7B8'
const PIN_GOLD_TOP = '#F2D488'
const PIN_GOLD_BOTTOM = '#A97E2A'
const BASE_PIN_DURATION_S = 1.4
const MIN_PIN_DURATION_S = 0.3
const BASE_ACT_PERIOD_S = 0.34
const MIN_ACT_PERIOD_S = 0.12

const PIN_DELAYS_S = [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.42, 0.49]
const LANES: { key: 'A' | 'B' | 'C'; top: number; delayS: number }[] = [
  { key: 'A', top: 18, delayS: 0 },
  { key: 'B', top: 30, delayS: 0.45 },
  { key: 'C', top: 42, delayS: 0.9 },
]

export interface NicBlockProps {
  box: Box
  nicMbps: number
  inMbps?: number
  outMbps?: number
  inboundRps?: number          // Σ resident instance rps — drives the ACT LED blink period
  health?: HealthState         // server.health — LINK LED goes off only when 'down'
  selected?: boolean
  dimmed?: boolean
  onSelect?: () => void
  onHover?: (v: boolean) => void
}

export function NicBlock({ box, nicMbps, inMbps, outMbps, inboundRps = 0, health = 'healthy', selected, dimmed, onSelect, onHover }: NicBlockProps): ReactElement {
  const reduced = useReducedMotion()
  const throughput = (inMbps ?? 0) + (outMbps ?? 0)
  const rippling = !reduced && throughput > 0
  // "acting" (activity signal — is there any inbound rps at all) is independent of motion
  // preference; "animating" (permission to actually blink) additionally requires !reduced. Under
  // reduced motion the LED still renders bright/on while active — "static-on", never forced dark
  // — only the blink animation itself is suppressed (same rule the beacon/edge-dot below already
  // follow: render steady when the underlying condition holds, animate only when allowed to).
  const acting = inboundRps > 0
  const actAnimating = !reduced && acting
  const linkOn = health !== 'down'

  const pinDurationS = Math.max(MIN_PIN_DURATION_S, BASE_PIN_DURATION_S / (1 + throughput / 100))
  const actPeriodS = Math.max(MIN_ACT_PERIOD_S, BASE_ACT_PERIOD_S / (1 + inboundRps / 50))

  const outerStyle: CSSProperties = {
    position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h,
    background: 'none', border: 'none', cursor: 'pointer', opacity: dimmed ? 0.45 : 1,
  }

  return (
    <div data-nic style={outerStyle} onClick={onSelect}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <span style={{ position: 'absolute', top: -14, left: 0, width: '100%', textAlign: 'center', fontSize: 8, color: JACK_TEAL, letterSpacing: '0.06em' }}>
        eth0 · {nicMbps}M INTAKE
      </span>

      <div className="gw-jack-bezel" style={{
        position: 'absolute', inset: 0, borderRadius: 6,
        background: 'linear-gradient(180deg, #24313b, #141d26)',
        border: `1px solid ${selected ? JACK_TEAL : '#3fc7b877'}`,
        boxShadow: selected ? `0 0 20px ${JACK_TEAL}66, inset 0 1px 0 #ffffff14` : '0 0 16px #3fc7b822, inset 0 1px 0 #ffffff14',
      }}>
        <div style={{
          position: 'absolute', left: 9, right: 9, top: 9, bottom: 8, background: '#04070b',
          clipPath: 'polygon(0 0, 100% 0, 100% 58%, 76% 58%, 76% 79%, 61% 79%, 61% 100%, 39% 100%, 39% 79%, 24% 79%, 24% 58%, 0 58%)',
          boxShadow: 'inset 0 2px 6px #000',
        }} />
        <div style={{ position: 'absolute', left: 13, right: 13, top: 12, display: 'flex', gap: 2 }}>
          {PIN_DELAYS_S.map((delayS, i) => (
            <i key={i} data-testid="nic-pin" style={{
              flex: 1, height: 9, borderRadius: '0 0 1px 1px',
              background: `linear-gradient(180deg, ${PIN_GOLD_TOP}, ${PIN_GOLD_BOTTOM})`,
              opacity: rippling ? undefined : 0.45,
              animation: rippling ? `gw-pinseq ${pinDurationS}s linear infinite ${delayS}s` : undefined,
            }} className={rippling ? 'gw-pin' : undefined} />
          ))}
        </div>
        <span data-testid="nic-link-led" data-on={linkOn} style={{
          position: 'absolute', bottom: 5, left: 4, width: 7, height: 5, borderRadius: 1,
          background: linkOn ? 'var(--color-success)' : '#2A2E38',
          boxShadow: linkOn ? '0 0 6px var(--color-success)' : undefined,
        }} />
        <span data-testid="nic-act-led" data-active={acting} className={actAnimating ? 'gw-act' : undefined} style={{
          position: 'absolute', bottom: 5, right: 4, width: 7, height: 5, borderRadius: 1,
          background: 'var(--color-warning)',
          boxShadow: acting ? '0 0 6px var(--color-warning)' : undefined,
          opacity: acting ? undefined : 0.15,
          animation: actAnimating ? `gw-actblink ${actPeriodS}s steps(1) infinite` : undefined,
        }} />
      </div>

      {rippling && LANES.map(lane => (
        <span key={lane.key} className="gw-lane" style={{
          position: 'absolute', left: 4, top: lane.top, width: 10, height: 4, borderRadius: 2,
          background: 'linear-gradient(90deg, transparent, #7CFFE9)', filter: 'drop-shadow(0 0 3px #7CFFE9)',
          animation: `gw-lane${lane.key} 1.4s linear infinite ${lane.delayS}s`,
        }} />
      ))}

      <span style={{ position: 'absolute', bottom: -14, left: 0, width: '100%', textAlign: 'center', fontSize: 8, color: 'var(--color-text-secondary)' }}>
        ↓{Math.round(inMbps ?? 0)} ↑{Math.round(outMbps ?? 0)} Mb/s
      </span>
    </div>
  )
}
