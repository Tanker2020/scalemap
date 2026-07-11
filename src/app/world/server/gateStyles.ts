// src/app/world/server/gateStyles.ts
// Injected-stylesheet-once idiom (region/r3Styles.ts, az/azFloorStyles.ts) applied to Polish 3
// Task 5's `.b3nic .jack` (NicBlock, D6) and `.b3fw2` (FirewallGate, D7) sections of the mockup
// (docs/superpowers/specs/mockups/level-redesign-v5.html, lines 142-180). Only the pieces that
// CANNOT be expressed as inline React style objects live here — @keyframes declarations and the
// two hover-filter rules. Everything else (clip-paths, colors, positions) is set inline per
// component. Keyframe/class names prefixed `gw-` (gate/wire) so they can't collide with a
// same-named copy in region's/az's own injected sheets (az-floor's own `az-` precedent). No
// lib/theme.ts import needed — unlike r3Styles/azFloorStyles this file has no theme-swapped
// tokens of its own; every color NicBlock/FirewallGate use is either a literal scene-local hex
// (transcribed verbatim from the mockup, matching this directory's existing sanctioned-hex
// precedent — TEAL/AMBER/CPU_BLUE constants in NicBlock.tsx/FirewallGate.tsx/
// HardwarePlatform.tsx) or a `var(--color-*)` token for anything semantic (success/danger).
const GATE_STYLE_ID = 'scalemap-gate-styles'

if (typeof document !== 'undefined' && !document.getElementById(GATE_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = GATE_STYLE_ID
  style.textContent = `
/* mockup lines 148, 156, 159-160 (.b3nic .jack .pinrow/.led.act) */
@keyframes gw-pinseq { 0%, 18%, 100% { opacity: 0.45; } 6% { opacity: 1; filter: drop-shadow(0 0 3px #ffd98a); } }
@keyframes gw-actblink { 0%, 58% { opacity: 1; } 59%, 100% { opacity: 0.15; } }

/* mockup lines 162-164 (.b3nic .pk2 intake lanes), adapted from the mockup's 158px-wide .b3nic
   wrapper to this component's box-local coordinate frame (see NicBlock.tsx) — same staggered/
   converging shape, shorter travel distance. */
@keyframes gw-laneA { from { transform: translate(0, 0); opacity: 0; } 12% { opacity: 1; } 82% { transform: translate(52px, 8px); opacity: 1; } to { transform: translate(60px, 9px); opacity: 0; } }
@keyframes gw-laneB { from { transform: translate(0, 0); opacity: 0; } 12% { opacity: 1; } 82% { transform: translate(52px, -5px); opacity: 1; } to { transform: translate(60px, -6px); opacity: 0; } }
@keyframes gw-laneC { from { transform: translate(0, 0); opacity: 0; } 12% { opacity: 1; } 82% { transform: translate(52px, -18px); opacity: 1; } to { transform: translate(60px, -20px); opacity: 0; } }

/* mockup lines 32, 37, 177-180 (.b3fw2 .scan/.beacon/.spark + shared blink/scanline keyframes) */
@keyframes gw-scanline { from { top: -20%; } to { top: 120%; } }
@keyframes gw-blink { 0%, 72% { opacity: 1; } 73%, 84% { opacity: 0.25; } 85%, 100% { opacity: 1; } }
@keyframes gw-fwspark {
  0% { transform: translate(0, 0); opacity: 0; }
  8% { opacity: 1; }
  55% { transform: translate(14px, 0); opacity: 1; }
  66% { transform: translate(20px, -12px); opacity: 1; filter: drop-shadow(0 0 4px var(--color-danger)); }
  100% { transform: translate(26px, -34px); opacity: 0; }
}

/* mockup lines 145, 168-169 (.b3nic .jack .bezel, .b3fw2:hover) — :hover can't be expressed as
   an inline React style, so it lives here; both are purely cosmetic glow bumps. */
.gw-jack-bezel:hover { box-shadow: 0 0 20px #3fc7b833, inset 0 1px 0 #ffffff14; }
.gw-shield:hover { filter: drop-shadow(0 0 26px #e0a55240); }

@media (prefers-reduced-motion: reduce) {
  .gw-pin, .gw-act, .gw-lane, .gw-scan, .gw-beacon, .gw-spark, .gw-edgedot {
    animation: none !important;
  }
}
`
  document.head.appendChild(style)
}
