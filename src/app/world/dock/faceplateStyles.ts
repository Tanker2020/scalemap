// src/app/world/dock/faceplateStyles.ts
// Polish 4 T4 (spec D3/D6): the faceplate's ONE ambient stroke — the vitals pulse's 3.6s idle
// breathe, a user-ratified bounded exception to the static-at-0-rps law (global-constraints.md:
// "ratified exceptions: faceplate idle breathe (3.6s)"). Injected-stylesheet-once, same idiom as
// `ui/kit.tsx` / `dock/floorPlanStyles.ts`. `ServerFaceplate.tsx` gates the class ON in JS
// (`useReducedMotion()`, matching AzConfigTab's `dockfp-led-blink` precedent) — the `@media`
// block below is defense-in-depth, not the only guard. T5 (watching mode) extends this with a
// 2.2s "under load" rate via its own inline `animationDuration` override; the keyframe shape
// itself doesn't change between postures.
const STYLE_ID = 'scalemap-dock-faceplate-styles'

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@keyframes dockfp-vitals-breathe { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.9; } }
.dockfp-vitals-pulse { animation: dockfp-vitals-breathe 3.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .dockfp-vitals-pulse { animation: none !important; opacity: 0.9; }
}
`
  document.head.appendChild(style)
}

export {}
