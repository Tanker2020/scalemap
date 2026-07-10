// src/app/world/globe/webgl.ts
// One-shot cached WebGL feature-detect (Phase 5 D7). GlobeView calls this to decide between the
// real r3f scene and the GlobeCards fallback. Cached after the first call — probing WebGL forces
// the browser to spin up (and immediately discard) a GL context, which is wasteful to repeat on
// every GlobeView render/remount.
let cached: boolean | null = null

export function webglAvailable(): boolean {
  if (cached !== null) return cached
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    cached = !!gl
  } catch {
    cached = false
  }
  return cached
}
