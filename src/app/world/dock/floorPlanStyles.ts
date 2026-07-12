// src/app/world/dock/floorPlanStyles.ts
// Polish 4 T3 (spec D3/D5): injected-stylesheet-once CSS shared by the floor-plan instrument's
// two pieces — FloorPlanHeader's clickable minimap (cabinet/pod hover + `sel` ring) and
// AzConfigTab's slat rows (hover shunt) and ghost rack well. Same idiom `ui/kit.tsx` and
// `az/azFloorStyles.ts` already establish (a single guarded `<style>` tag, injected once,
// namespaced so it can't collide with either), because inline React styles can't express
// `:hover`. `dockfp-blink` is the dock's ONE ambient stroke at AZ scope (D3's motion table) —
// AzConfigTab computes a budget-of-1 "busiest server" id (mirroring the floor's own
// `MAX_ANIMATED_LEDS` ranking shape, just capped at 1 instead of 3) and applies
// `.dockfp-led-blink` to ONLY that one slat's LED, running-only, never reduced-motion. Every
// other rule below is hover-reactive only, per the brief's "T2 was dinged for exactly this"
// warning against always-on motion.
const STYLE_ID = 'scalemap-dock-floorplan-styles'

if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
@keyframes dockfp-blink { 0%, 72% { opacity: 1; } 73%, 84% { opacity: 0.25; } 85%, 100% { opacity: 1; } }

.dockfp-cab, .dockfp-pod { cursor: pointer; transition: filter 0.14s; }
.dockfp-cab:hover, .dockfp-pod:hover { filter: brightness(1.5); }
.dockfp-cab.sel, .dockfp-pod.sel { stroke: var(--kit-accent); filter: drop-shadow(0 0 5px var(--kit-accent-dim)); }

.dockfp-slat {
  display: flex; align-items: center; gap: 8px; cursor: pointer; width: 100%;
  background: var(--color-node-base); border: 1px solid var(--color-node-border); border-radius: 4px;
  padding: 5px 9px; margin: 0 0 5px; font: 10.5px var(--font-mono); text-align: left;
  transition: transform 0.14s, border-color 0.14s;
}
.dockfp-slat:hover { transform: translateX(4px); border-color: var(--kit-teal); }
.dockfp-led-blink { animation: dockfp-blink 2.4s steps(1) infinite; }

.dockfp-rackwell-ghost { transition: opacity 0.15s; }
.dockfp-rackwell-ghost:hover { opacity: 0.85 !important; }

@media (prefers-reduced-motion: reduce) {
  .dockfp-led-blink { animation: none !important; }
  .dockfp-cab, .dockfp-pod, .dockfp-slat, .dockfp-rackwell-ghost { transition: none !important; }
}
`
  document.head.appendChild(style)
}

export {}
