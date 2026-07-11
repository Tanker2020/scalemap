// src/app/world/region/r3Styles.ts
// Region v4 (Polish 3 T3, mockup `.r3` section of docs/superpowers/specs/mockups/
// level-redesign-v5.html) — the injected-stylesheet-once idiom `ui/kit.tsx` established, but
// self-contained to `region/` rather than importing `ui/kit.tsx`: `region/*`'s documented
// boundary rule (module-boundaries.md §M) is "imports only lib/ + app stores", so this file
// pulls its two theme-matched tokens (teal/amber) from `lib/theme.ts`'s `CATEGORY_COLORS`
// (a `lib/` import, allowed) instead of reaching into `ui/kit.tsx`'s `--kit-*` vars. The
// hud/hud-dim cyan pair has no `lib/`-owned source, so it's a manually-synced literal mirror of
// `ui/kit.tsx`'s `KIT_GLOW_TEXT`/`KIT_GLOW_DIM` (dark) and their light counterparts — the same
// "documented manual mirror, not an import" carve-out `regionData.ts` already uses for
// `CROSS_AZ_HOP_MS`. If `ui/kit.tsx`'s glow hexes ever change, update the four hud/hud-dim
// literals below by hand.
import { CATEGORY_COLORS } from '../../../lib/theme'

const R3_STYLE_ID = 'scalemap-r3-styles'

if (typeof document !== 'undefined' && !document.getElementById(R3_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = R3_STYLE_ID
  style.textContent = `
:root {
  --r3-teal: ${CATEGORY_COLORS.network.accent};
  --r3-amber: ${CATEGORY_COLORS.storage.accent};
  --r3-amber-text: #b98a45;
  --r3-hud: #7CFFE9;
  --r3-hud-dim: #2DD4BF44;
}
:root[data-theme="light"] {
  --r3-teal: ${CATEGORY_COLORS.network.foreground.light};
  --r3-amber: ${CATEGORY_COLORS.storage.accent};
  --r3-amber-text: ${CATEGORY_COLORS.storage.foreground.light};
  --r3-hud: #0F766E;
  --r3-hud-dim: #0F766E33;
}

/* .azcard hover reveal (mockup lines 66-73) — plain :hover, NOT :has() (webview-flaky per the
   T3 brief; the replica rail's own hover state below uses React, not CSS, for that reason). */
.r3-azcard { transition: border-color 0.16s, box-shadow 0.16s; }
.r3-azcard:hover { border-color: #3fc7b866; box-shadow: 0 0 0 1px #3fc7b822, 0 10px 26px #00000088; }
.r3-cfgbar { opacity: 0; transform: translateY(-4px); transition: opacity 0.16s, transform 0.16s; pointer-events: none; }
.r3-azcard:hover .r3-cfgbar { opacity: 1; transform: translateY(0); pointer-events: auto; }
.r3-cfgbtn:hover:not(:disabled) { color: var(--r3-hud); border-color: var(--r3-hud-dim); }
.r3-cfgbtn.x:hover:not(:disabled) { color: var(--color-danger); border-color: var(--color-danger); }
.r3-cfgbtn:disabled { opacity: 0.4; cursor: default; }

@keyframes dashflow { to { stroke-dashoffset: -30; } }
@keyframes marchr { to { background-position: 22px 0; } }
@keyframes dotrun { from { left: -4px; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } to { left: 100%; opacity: 0; } }
`
  document.head.appendChild(style)
}
