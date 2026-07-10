// src/app/world/globe/ArcsLayer.tsx
// Live great-circle traffic arcs (Phase 5 D6): attaches the globe-scope renderer once per
// `running`, writes each frame's VisualArc[] into a ref, and drives a fixed-size pool of
// THREE.Line objects (LineDashedMaterial) — geometry rebuilt only when the arc SET's signature
// changes (endpoints/kind), opacity and dash-flow updated every frame regardless. Dash flow is
// driven by mutating the geometry's `lineDistance` attribute in place (this three.js build's
// classic LineDashedMaterial has no `dashOffset` uniform — see the PoolEntry comment below), not
// a material property. Mounted as a GlobeScene child (T3), alongside RegionPins/PopulationMarkers
// (T4) — lives in the same rotating group so arcs track the globe's orientation. R3F component;
// NOT jsdom-tested (no WebGL there) — this task's live smoke is the gate. arcsSignature is the
// one exported pure helper, unit-tested in ArcsLayer.test.ts.
import { useEffect, useRef, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { useSimulationStore } from '../../store/simulation.store'
import { greatCirclePoints } from './geo'
import type { VisualArc, FramePayload } from '../../../lib/worldEngine/types'

// Mirrors worldEngine's own (unexported) MAX_GLOBE_ARCS — the pool only ever needs to match the
// engine's own render cap (D6); not importable, so kept in sync manually here.
const MAX_GLOBE_ARCS = 200
const ARC_SEGMENTS = 48
const ARC_RADIUS = 1.001
const DASH_SIZE = 0.045
const GAP_SIZE = 0.03
const DASH_SPEED = 0.15   // dashOffset units/sec

const ARC_COLOR: Record<VisualArc['kind'], string> = {
  client: '#2DD4BF', 'inter-region': '#4A9EFF', drain: '#EF4444',
}

// Order-sensitive by design: a reorder of the SAME arcs (which would misalign the pool's
// index-to-arc mapping between frames) also changes this string, forcing a rebuild — see the
// per-frame update loop below for why that alignment matters.
export function arcsSignature(arcs: VisualArc[]): string {
  return arcs.map(a => `${a.kind}:${a.fromLatLon}:${a.toLatLon}`).join('|')
}

interface PoolEntry {
  line: THREE.Line
  material: THREE.LineDashedMaterial
  geometry: THREE.BufferGeometry
  // Dash-flow state: this three.js build's classic (non-Node) LineDashedMaterial has no
  // `dashOffset` uniform (verified against the installed three source — the linedashed shader
  // only reads dashSize/gapSize against the geometry's own `lineDistance` attribute), so flow is
  // simulated by adding a per-entry phase to a cached copy of the rebuild-time distances and
  // rewriting the `lineDistance` attribute's typed array IN PLACE every frame (no new
  // allocation — same array reference, values mutated). baseDistances is captured once per
  // geometry rebuild (signature change), not per frame.
  baseDistances: Float32Array | null
  phase: number
}

export function ArcsLayer(): ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  const poolRef = useRef<PoolEntry[]>([])
  const latestArcsRef = useRef<VisualArc[]>([])
  const lastSignatureRef = useRef<string>('')
  const running = useSimulationStore(s => s.running)
  const reduced = useReducedMotion() ?? false

  // Build the fixed-size pool once (mount only) — lines start hidden until real arcs fill them.
  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const pool: PoolEntry[] = []
    for (let i = 0; i < MAX_GLOBE_ARCS; i++) {
      const geometry = new THREE.BufferGeometry()
      const material = new THREE.LineDashedMaterial({
        color: ARC_COLOR.client, dashSize: DASH_SIZE, gapSize: GAP_SIZE, transparent: true, opacity: 0,
      })
      const line = new THREE.Line(geometry, material)
      line.visible = false
      line.frustumCulled = false
      group.add(line)
      pool.push({ line, material, geometry, baseDistances: null, phase: 0 })
    }
    poolRef.current = pool
    return () => {
      for (const entry of pool) {
        group.remove(entry.line)
        entry.geometry.dispose()
        entry.material.dispose()
      }
      poolRef.current = []
    }
  }, [])

  // Attach the globe renderer once per `running` (AzSimOverlay precedent): imperative
  // getState().attachRenderer call, ref-only writes inside onFrame, detach on stop/unmount.
  useEffect(() => {
    if (!running) {
      latestArcsRef.current = []
      return
    }
    const detach = useSimulationStore.getState().attachRenderer({ level: 'globe' }, (payload: FramePayload) => {
      latestArcsRef.current = payload.arcs
    })
    return detach
  }, [running])

  useFrame((_, delta) => {
    const pool = poolRef.current
    if (pool.length === 0) return
    const arcs = latestArcsRef.current
    // The one per-frame allocation this file makes — mandated by the skeleton's exact
    // signature algorithm, bounded by MAX_GLOBE_ARCS (≤200 short strings), cheap relative to
    // the WebGL frame budget. Every other per-frame write below touches only refs/material
    // props, no allocations.
    const signature = arcsSignature(arcs)

    if (signature !== lastSignatureRef.current) {
      lastSignatureRef.current = signature
      for (let i = 0; i < pool.length; i++) {
        const entry = pool[i]
        const arc = arcs[i]
        if (!arc) { entry.line.visible = false; continue }
        const points = greatCirclePoints(
          { lat: arc.fromLatLon[0], lon: arc.fromLatLon[1] },
          { lat: arc.toLatLon[0], lon: arc.toLatLon[1] },
          ARC_RADIUS, ARC_SEGMENTS)
        entry.geometry.setFromPoints(points)
        entry.line.computeLineDistances()
        // One-time-per-rebuild copy (not steady-state) — the mutable base the per-frame flow
        // loop below adds its phase onto.
        const distAttr = entry.geometry.getAttribute('lineDistance') as THREE.BufferAttribute
        entry.baseDistances = Float32Array.from(distAttr.array as Float32Array)
        entry.phase = 0
        entry.material.color.set(ARC_COLOR[arc.kind])
        entry.line.visible = true
      }
    }

    // Per-frame updates independent of signature: opacity tracks intensity, dash pattern flows
    // (skipped under reduced motion — dashes render static).
    for (let i = 0; i < arcs.length && i < pool.length; i++) {
      const entry = pool[i]
      const arc = arcs[i]
      entry.material.opacity = 0.25 + 0.75 * arc.intensity
      if (!reduced && entry.baseDistances) {
        const period = DASH_SIZE + GAP_SIZE
        entry.phase = ((entry.phase - delta * DASH_SPEED) % period + period) % period
        const distAttr = entry.geometry.getAttribute('lineDistance') as THREE.BufferAttribute
        const arr = distAttr.array as Float32Array
        const base = entry.baseDistances
        for (let j = 0; j < arr.length; j++) arr[j] = base[j] + entry.phase
        distAttr.needsUpdate = true
      }
    }
  })

  return <group ref={groupRef} />
}
