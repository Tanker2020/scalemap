// src/app/world/server/hwStyles.ts
// Injected-stylesheet-once idiom (`gateStyles.ts`'s own precedent, one directory up in lineage —
// see that file's header) applied to Polish 3 Task 6's substrate (D8, mockup `.b3hw` — corebank/
// corecell/stealx/dimms/platter/qdepth, lines 196-220 of level-redesign-v5.html), TraceLayer's
// flowing-dash overlay, and InspectorRail's dock scanline. Only @keyframes live here — everything
// else (colors, positions, clip-paths) is inline per component. Keyframe/class names prefixed
// `hw-` so they can't collide with `region/r3Styles.ts`'s own unprefixed `dashflow` or
// `az/azFloorStyles.ts`'s `az-` prefix (documented precedent: az's own header explains why a
// same-named keyframe in a different scene file needs its own copy, not a cross-scene import —
// this file follows the identical self-contained discipline for the exact same reason: nothing
// guarantees `region/`'s or `az/`'s style module has been evaluated before a user deep-links
// straight to the server view).
const HW_STYLE_ID = 'scalemap-hw-styles'

if (typeof document !== 'undefined' && !document.getElementById(HW_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = HW_STYLE_ID
  style.textContent = `
/* mockup line 34 (.corecell i) */
@keyframes hw-coreflicker { 0%, 100% { opacity: 0.85; } 40% { opacity: 1; } 60% { opacity: 0.7; } }
/* mockup line 35 (.corecell .stealx) */
@keyframes hw-glitch { 0%, 92%, 100% { opacity: 0; } 93%, 97% { opacity: 0.9; } }
/* TraceLayer's flowing-dash overlay — same shape as region/r3Styles.ts's and
   az/azFloorStyles.ts's own copies (stroke-dashoffset -30), self-contained here. */
@keyframes hw-dashflow { to { stroke-dashoffset: -30; } }
/* mockup line 37 (.b3insp::after scanline), reused for InspectorRail's docked scan sweep. */
@keyframes hw-scanline { from { top: -20%; } to { top: 120%; } }

@media (prefers-reduced-motion: reduce) {
  .hw-flicker, .hw-steal, .hw-flow, .hw-scan, .hw-spin {
    animation: none !important;
  }
}
`
  document.head.appendChild(style)
}
