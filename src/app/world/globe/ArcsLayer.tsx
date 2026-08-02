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
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { useFrame } from '@react-three/fiber'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { useSimulationStore } from '../../store/simulation.store'
import { useWorldStore } from '../../store/world.store'
import { greatCirclePoints } from './geo'
import { REGION_GEO } from '../../../lib/world/regionGeo'
// FEAT-002 Task 14: impairmentFor is a pure predicate (no engine-runtime deps — see faults.ts's
// own file banner), safe to import directly into a render file rather than reimplementing its
// forward/backward matching by hand.
import { impairmentFor } from '../../../lib/worldEngine/faults'
// From types.ts, NOT the engine facade (audit ISSUE-050): importing the value from
// lib/worldEngine pulled index.ts — which constructs the worldEngine singleton at module
// load — into the globe view's import graph for one shared render-cap constant.
import { MAX_GLOBE_ARCS } from '../../../lib/worldEngine/types'
import type { VisualArc, FramePayload, PartitionFault } from '../../../lib/worldEngine/types'
import type { WorldDoc } from '../../../lib/world/types'

const ARC_SEGMENTS = 48
const ARC_RADIUS = 1.001
const DASH_SIZE = 0.045
const GAP_SIZE = 0.03
const DASH_SPEED = 0.15   // dashOffset units/sec

const ARC_COLOR: Record<VisualArc['kind'], string> = {
  client: '#2DD4BF', 'inter-region': '#4A9EFF', drain: '#EF4444',
}
// Matches theme.ts's DARK_COLORS.danger — a WebGL material color can't read a CSS custom
// property, so this mirrors the existing precedent in this same file (ARC_COLOR.drain is
// already this exact hex for the same reason).
const DANGER_ARC_COLOR = '#EF4444'

// ─── FEAT-002 partition matching (Task 14) ──────────────────────────────────────────
// VisualArc (the render contract) carries lat/lon only, no region id — so matching a partition
// (authored against a region/az/server id) against an arc requires resolving each endpoint's
// lat/lon back to a region id via the SAME REGION_GEO table RegionPins.tsx uses to place pins.
// Pure + exported so it's unit-testable without WebGL (mirrors arcsSignature/arcsEqual above).
export function buildRegionGeoIndex(doc: WorldDoc): Map<string, string> {
  const index = new Map<string, string>()
  for (const region of Object.values(doc.regions)) {
    const geo = REGION_GEO[region.catalogId]
    if (geo) index.set(`${geo.lat},${geo.lon}`, region.id)
  }
  return index
}

export interface ArcImpairment { blocked: boolean; lossFraction: number; delayMs: number }

// Resolves an arc's two endpoints to region ids (undefined when the endpoint isn't a known
// region — e.g. a client population marker) and runs the SAME impairmentFor predicate the engine
// itself uses. An arc with an unresolvable endpoint (client-side) simply never matches — mirrors
// impairmentFor's own `internet` semantics, which never match a concrete id either.
export function arcImpairment(
  arc: VisualArc, geoIndex: Map<string, string>, partitions: PartitionFault[],
): ArcImpairment {
  if (partitions.length === 0) return { blocked: false, lossFraction: 0, delayMs: 0 }
  const fromRegionId = geoIndex.get(`${arc.fromLatLon[0]},${arc.fromLatLon[1]}`)
  const toRegionId = geoIndex.get(`${arc.toLatLon[0]},${arc.toLatLon[1]}`)
  return impairmentFor({ regionId: fromRegionId }, { regionId: toRegionId }, partitions)
}

// Order-sensitive by design: a reorder of the SAME arcs (which would misalign the pool's
// index-to-arc mapping between frames) also changes this string, forcing a rebuild — see the
// per-frame update loop below for why that alignment matters.
export function arcsSignature(arcs: VisualArc[]): string {
  return arcs.map(a => `${a.kind}:${a.fromLatLon}:${a.toLatLon}`).join('|')
}

// Zero-allocation change detection (audit ISSUE-056): same order-sensitive identity as
// arcsSignature, but as direct element comparisons — the joined string allocated ~200 short
// strings EVERY rAF frame even when nothing changed. `intensity` is deliberately excluded
// (like the signature): it updates per frame without a geometry rebuild.
export function arcsEqual(a: VisualArc[], b: VisualArc[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.kind !== y.kind ||
        x.fromLatLon[0] !== y.fromLatLon[0] || x.fromLatLon[1] !== y.fromLatLon[1] ||
        x.toLatLon[0] !== y.toLatLon[0] || x.toLatLon[1] !== y.toLatLon[1]) return false
  }
  return true
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
  // geometry rebuild (arc-set change), not per frame.
  // (Audit ISSUE-056 considered a shader-driven phase uniform via onBeforeCompile to drop the
  // CPU rewrite + per-arc GPU re-upload entirely; deliberately NOT taken — this path has no
  // automated visual gate, and patching the linedashed shader unverified trades a bounded,
  // known-correct 48-float write for silent-breakage risk.)
  baseDistances: Float32Array | null
  // Typed handle to the geometry's lineDistance attribute, captured at rebuild (audit
  // ISSUE-054): the frame loop writes through THIS instead of re-fetching with an `as` cast —
  // getAttribute can legally return an InterleavedBufferAttribute, and the cast would silently
  // misbehave if geometry construction ever changed. Null when the runtime check fails.
  distAttr: THREE.BufferAttribute | null
  phase: number
  // FEAT-002 (Task 14): this arc's current partition impairment, computed at rebuild time —
  // `drop` breaks the arc (danger color, frozen wide gap, no dash flow); `loss` stipples it
  // (tighter dash, dimmer) but keeps flowing; `delay` renders normally (the hop's latency chip,
  // driven elsewhere off the same 1 Hz batch, already reflects the added delay).
  blocked: boolean
  lossFraction: number
}

export function ArcsLayer(): ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  const poolRef = useRef<PoolEntry[]>([])
  const latestArcsRef = useRef<VisualArc[]>([])
  const lastArcsRef = useRef<VisualArc[]>([])   // the arc set the pool geometry was last built for
  const running = useSimulationStore(s => s.running)
  const partitions = useSimulationStore(s => s.partitions)
  const doc = useWorldStore(s => s.doc)
  const geoIndex = useMemo(() => buildRegionGeoIndex(doc), [doc.regions])
  const lastPartitionsRef = useRef<typeof partitions>(partitions)
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
      pool.push({ line, material, geometry, baseDistances: null, distAttr: null, phase: 0, blocked: false, lossFraction: 0 })
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
    // Zero-allocation change detection (audit ISSUE-056): direct element comparison against
    // the last-built arc set — the old per-frame arcsSignature join allocated ~200 short
    // strings every rAF even in steady state. Every per-frame write below touches only
    // refs/material props, no allocations.
    const partitionsChanged = partitions !== lastPartitionsRef.current
    if (!arcsEqual(arcs, lastArcsRef.current) || partitionsChanged) {
      lastArcsRef.current = arcs
      lastPartitionsRef.current = partitions
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
        // One-time-per-rebuild capture (not steady-state): a RUNTIME-checked typed handle to
        // the attribute (audit ISSUE-054) + the mutable base the flow loop adds its phase onto.
        const distAttr = entry.geometry.getAttribute('lineDistance')
        if (distAttr instanceof THREE.BufferAttribute && distAttr.array instanceof Float32Array) {
          entry.distAttr = distAttr
          entry.baseDistances = Float32Array.from(distAttr.array)
        } else {
          entry.distAttr = null
          entry.baseDistances = null
        }
        entry.phase = 0
        // FEAT-002 (Task 14): a `drop`-partitioned arc renders danger-red with a static wide
        // gap (a broken link, not a pulse — no new looping animation per the reduced-motion
        // law); `loss` keeps the arc's own kind color but stipples the dash tighter/dimmer.
        const impairment = arcImpairment(arc, geoIndex, partitions)
        entry.blocked = impairment.blocked
        entry.lossFraction = impairment.lossFraction
        entry.material.color.set(impairment.blocked ? DANGER_ARC_COLOR : ARC_COLOR[arc.kind])
        entry.material.dashSize = impairment.blocked ? DASH_SIZE * 0.4 : DASH_SIZE
        entry.material.gapSize = impairment.blocked ? GAP_SIZE * 6 : GAP_SIZE
        entry.line.visible = true
      }
    }

    // Per-frame updates independent of the arc set: opacity tracks intensity, dash pattern
    // flows (skipped under reduced motion, AND for a `drop`-broken arc — a severed link is a
    // static gap, never a pulse).
    for (let i = 0; i < arcs.length && i < pool.length; i++) {
      const entry = pool[i]
      const arc = arcs[i]
      const lossOpacity = entry.lossFraction > 0 ? 1 - 0.6 * entry.lossFraction : 1
      entry.material.opacity = (0.25 + 0.75 * arc.intensity) * lossOpacity
      if (!reduced && !entry.blocked && entry.baseDistances && entry.distAttr) {
        const period = entry.material.dashSize + entry.material.gapSize
        entry.phase = ((entry.phase - delta * DASH_SPEED) % period + period) % period
        const arr = entry.distAttr.array as Float32Array   // established Float32 at capture
        const base = entry.baseDistances
        for (let j = 0; j < arr.length; j++) arr[j] = base[j] + entry.phase
        entry.distAttr.needsUpdate = true
      }
    }
  })

  return <group ref={groupRef} />
}
