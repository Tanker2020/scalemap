// src/app/world/region/SplitLines.tsx
// Ingress-beam SVG column between the source column and the AZ card stack (Region v4, Polish 3
// T3, mockup `.r3 svg.flows path.beam`/`.sharepill`). One cubic path per AZ share, its width
// scaling with the share's fraction, labeled with a "58% · 712" share pill; a down AZ gets a
// thin dashed red stub pinned to 0%. Motion budget (spec D1): at most the TOP ONE (by fraction,
// excluding down AZs) beam marches via `dashflow` — every other beam (a second-plus AZ, or any
// down AZ) renders the identical dashed stroke statically, no `<animate>` child. This is a hard
// cap independent of AZ count, not just this mock's 2-AZ example — see the T3 report. Tightened
// from TOP TWO to TOP ONE in the T8 motion-budget sweep: with `ReplicaRail.tsx`'s
// `MAX_ANIMATED_RAILS` (added after this file, in a later review-fix wave) folded in, the
// region page's documented running total (1 trunk + up to 5 dot-streams + up to N beams + up to
// 1 rail) exceeded the app-wide ≤8 concurrent-infinite-stroke budget (D1) at TOP TWO beams — see
// module-boundaries.md §R's motion-budget table.
import { useReducedMotion } from 'framer-motion'
import type { ReactElement } from 'react'
import type { AzShare } from './regionData'
import './r3Styles'

const TEAL = '#3FC7B8'   // mockup `--teal` (verbatim) — see r3Styles.ts's header note on why
                          // region/* mirrors hex literals locally instead of importing a token
const PILL_FILL = '#10141b'
const PILL_STROKE = '#2a2e38'
const SVG_W = 90
const ORIGIN_X = 5
const TARGET_X = 85
// User override 2026-07-11 (previously 1, from the T8 motion-budget sweep): with two AZs both
// receiving live traffic, animating only one beam read as a BUG ("only one of the data flows is
// animated"). Every beam carrying rps now marches — still bounded: the rps>0 filter keeps the
// idle page static and a region has 2–4 AZs in practice; the cap is a safety rail, not the norm.
const MAX_ANIMATED_BEAMS = 4

export interface SplitLinesProps { shares: AzShare[]; height: number }

export function SplitLines({ shares, height }: SplitLinesProps): ReactElement {
  const reduced = useReducedMotion()
  const originY = height / 2
  const rowY = (i: number) => ((i + 0.5) * height) / Math.max(1, shares.length)
  const midX = (ORIGIN_X + TARGET_X) / 2

  // Rank by fraction (desc) among the up (non-down) shares CARRYING TRAFFIC only — down AZs
  // never animate, and neither does anything at 0 rps (dash speed = rate, D1: an idle beam
  // must sit static — user report 2026-07-11 caught the top beam marching pre-simulation).
  const animatedAzIds = new Set(
    [...shares].filter(s => !s.down && s.rps > 0).sort((a, b) => b.fraction - a.fraction).slice(0, MAX_ANIMATED_BEAMS).map(s => s.azId),
  )

  return (
    <svg width={SVG_W} height={height} style={{ flexShrink: 0 }} aria-hidden="true">
      {shares.map((s, i) => {
        const y = rowY(i)
        const d = `M${ORIGIN_X},${originY} C${midX - 5},${originY} ${midX},${y} ${TARGET_X},${y}`
        const pct = Math.round(s.fraction * 100)
        const strokeWidth = s.down ? 1 : 1.5 + 2.5 * s.fraction
        const stroke = s.down ? 'var(--color-danger)' : TEAL
        // Up-beam dash period MUST divide the `dashflow` keyframe's -30 offset delta (seamless-
        // loop law, taskA-brief.md) — '7 8' -> period 15, 30/15 = 2 whole cycles per wrap, so the
        // dash pattern lines back up exactly where it started (no visible snap). The prior '8 9'
        // (period 17) didn't divide 30 (30 mod 17 = 13), so the animated beam visibly jumped
        // ~13/17 of a period every cycle (user report 2026-07-11). Chose the "change the dash,
        // keep `values="0;-30"`" fix (brief option (a)) over rescaling the offset/dur per-beam:
        // it preserves the exact px/sec speed and the existing `periodSec` formula untouched, and
        // is a one-character-wider dash rather than a per-beam offset/duration derivation. Down
        // stubs ('2 7', period 9) stay untouched — they never carry `<animate>`, so their period
        // is irrelevant to seamlessness (see file header note).
        const dash = s.down ? '2 7' : '7 8'
        const animated = !reduced && !s.down && animatedAzIds.has(s.azId)
        // fraction 0 → slowest (1.3s), fraction 1 → fastest (0.9s) — both endpoints are the
        // mock's own two literal durations (default 0.9s + the explicit 1.3s override).
        const periodSec = (1.3 - 0.4 * s.fraction).toFixed(2)
        const pillW = 60
        const pillX = midX - pillW / 2
        const pillY = y - 22
        return (
          <g key={s.azId}>
            <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} opacity={s.down ? 0.5 : 0.75 + 0.1 * s.fraction}>
              {animated && (
                <animate attributeName="stroke-dashoffset" values="0;-30" dur={`${periodSec}s`} repeatCount="indefinite" />
              )}
            </path>
            {s.down ? (
              <text x={midX} y={y - 6} fill="var(--color-danger)" fontSize={9}>{pct}%</text>
            ) : (
              <g>
                <rect className="sharepill" x={pillX} y={pillY} rx={4} width={pillW} height={16} fill={PILL_FILL} stroke={PILL_STROKE} />
                <text x={pillX + 6} y={pillY + 11} fill="var(--r3-hud)" fontSize={9.5}>{pct}% · {Math.round(s.rps)}</text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}
