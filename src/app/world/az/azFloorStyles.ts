// src/app/world/az/azFloorStyles.ts
// The injected-stylesheet-once idiom `region/r3Styles.ts` established for Region v4, applied to
// the `.iso3` datacenter-floor section of the same mockup (level-redesign-v5.html). Keyframe
// names/timings/easings are transcribed verbatim (`rackin`/`bootled`/`blink`/`dashflow`), just
// namespaced `az-*` to avoid colliding with `region/`'s own copies of `dashflow`. Self-contained
// per `region/`'s documented boundary precedent — pulls its one theme-matched token (teal) from
// `lib/theme.ts` rather than reaching into `ui/kit.tsx`.
import { CATEGORY_COLORS } from '../../../lib/theme'

const AZ_STYLE_ID = 'scalemap-az-floor-styles'

if (typeof document !== 'undefined' && !document.getElementById(AZ_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = AZ_STYLE_ID
  style.textContent = `
:root {
  --az-hud: #7CFFE9;
  --az-hud-dim: #2DD4BF44;
  --az-teal: ${CATEGORY_COLORS.network.accent};
}
:root[data-theme="light"] {
  --az-hud: #0F766E;
  --az-hud-dim: #0F766E33;
  --az-teal: ${CATEGORY_COLORS.network.foreground.light};
}

/* mockup lines 30-32, 117-121 (level-redesign-v5.html .iso3 section) */
@keyframes az-dashflow { to { stroke-dashoffset: -30; } }
@keyframes az-blink { 0%, 72% { opacity: 1; } 73%, 84% { opacity: 0.25; } 85%, 100% { opacity: 1; } }
@keyframes az-rackin {
  from { transform: translateY(-16px); opacity: 0; }
  55% { transform: translateY(2px); opacity: 1; }
  75% { transform: translateY(-1px); }
  to { transform: translateY(0); opacity: 1; }
}
@keyframes az-bootled {
  0%, 18%, 36% { fill: var(--color-warning); }
  9%, 27% { fill: #332a14; }
  45%, 100% { fill: var(--color-success); }
}

g.az-rack3 { cursor: pointer; }
g.az-rack3 .az-lift { transition: transform 0.18s cubic-bezier(0.3, 0.9, 0.3, 1.2); }
g.az-rack3:hover .az-lift { transform: translateY(-6px); }
g.az-rack3 .az-halo { opacity: 0; transition: opacity 0.18s; }
g.az-rack3:hover .az-halo { opacity: 1; }

g.az-newslot { opacity: 0; }
g.az-newslot.go { animation: az-rackin 0.55s cubic-bezier(0.3, 0.9, 0.4, 1.25) forwards; }
g.az-newslot.go circle.az-led { animation: az-bootled 2.2s steps(1) forwards; }

.az-pod3 { cursor: pointer; }
.az-pod3:hover .az-podbody { stroke: var(--az-teal); }

.az-ghost { cursor: pointer; opacity: 0.45; transition: opacity 0.15s; }
.az-ghost:hover { opacity: 0.85; }

.az-trace-animated { animation-name: az-dashflow; animation-timing-function: linear; animation-iteration-count: infinite; }
.az-led-blink { animation: az-blink steps(1) infinite; }

@media (prefers-reduced-motion: reduce) {
  g.az-newslot.go, g.az-newslot.go circle.az-led, .az-trace-animated, .az-led-blink,
  g.az-rack3 .az-lift, g.az-rack3 .az-halo {
    animation: none !important; transition: none !important;
  }
  g.az-newslot, g.az-newslot.go { opacity: 1 !important; }
}
`
  document.head.appendChild(style)
}
