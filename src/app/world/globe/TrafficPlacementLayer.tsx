// src/app/world/globe/TrafficPlacementLayer.tsx
// Globe traffic-placement-mode preview (Polish 4 T7, spec D9): mounted as a GlobeScene child
// (T3/T4/T5's pattern — lives in the same rotating group so it tracks the globe's orientation
// for free), active ONLY while `placeMode`. A transparent raycast sphere tracks pointer-move,
// snaps to the nearest real city (cityCatalog.ts), and renders: a dashed crosshair ring at the
// snapped city (2s blink — a RATIFIED bounded exception, an authoring-mode affordance like a
// text caret; static under reduced motion), an Html preview card (who/how much/where/latency/
// egress, via regionOrderFor — the compiler's own policy math, not an estimate), and ONE static
// dashed great-circle ghost arc to the landing region (rebuilt only when the snapped city or
// landing region changes — NO per-frame marching, unlike ArcsLayer's live dash-flow).
//
// It does NOT handle click — GlobeScene.tsx's Earth component already does (placeMode click ->
// GlobeView's onPlace), so there is no double commit path here.
//
// R3F component; NOT jsdom-tested (no WebGL there) — this task's live smoke is the gate. The
// card's MATH (nearestCity/regionOrderFor/placementEgressUsdPerHr) is covered by the pure-helper
// unit tests in cityCatalog.test.ts / regionOrderFor.test.ts / derived.test.ts instead.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { useWorldStore } from '../../store/world.store'
import { nearestCity, type WorldCity } from '../../../lib/world/cityCatalog'
import { regionOrderFor } from '../../../lib/world/routing'
import { REGION_GEO, greatCircleKm } from '../../../lib/world/regionGeo'
import { POP_LATENCY_KM_PER_MS, placementEgressUsdPerHr } from '../ui/derived'
import { latLonToVec3, greatCirclePoints, vec3ToLatLon } from './geo'

const RAYCAST_RADIUS = 1.0005
const MARKER_ALTITUDE = 1.004   // ring + card altitude — same "lifted off surface" convention
                                 // as PIN_ALTITUDE/MARKER_ALTITUDE elsewhere in globe/
const RING_OUTER = 0.022
const RING_INNER = 0.015
const ARC_RADIUS = 1.001
const ARC_SEGMENTS = 48
const BLINK_PERIOD_S = 2   // spec D9's ratified place-mode ghost blink
const PREVIEW_RPS = 500    // createPopulation's real default (factories.ts) — the card previews
                            // exactly what the click will place, not a made-up number.
// WebGL material color (meshBasicMaterial/LineDashedMaterial can't consume a CSS custom
// property — three.js Color parses real hex only), matching the globe's established
// hardcoded-hex-for-scene-geometry precedent (RegionPins.tsx/ArcsLayer.tsx). Equal to kit.tsx's
// own KIT_TEAL dark-theme value by design.
const HUD_TEAL = '#2DD4BF'

// Blinks visibility on a fixed 2s period (steps, not a fade — matches the mockup's
// `animation: blink 2s steps(1) infinite`); a static, always-visible ring under reduced motion.
function GhostRing(): ReactElement {
  const meshRef = useRef<THREE.Mesh>(null)
  const reduced = useReducedMotion() ?? false

  useFrame((state) => {
    if (!meshRef.current) return
    if (reduced) { meshRef.current.visible = true; return }
    const t = (state.clock.elapsedTime % BLINK_PERIOD_S) / BLINK_PERIOD_S
    meshRef.current.visible = t < 0.5
  })

  return (
    <mesh ref={meshRef} rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[RING_INNER, RING_OUTER, 32]} />
      <meshBasicMaterial color={HUD_TEAL} transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  )
}

// One static dashed great-circle line, built imperatively (same primitive-object pattern as
// ArcsLayer.tsx's pool, minus the pool and the per-frame dash-flow) — rebuilt only when the
// endpoint pair changes, never per frame. Removed (effect cleanup) on unmount/change, i.e. on
// commit or cancel.
function GhostArc({ fromLat, fromLon, toLat, toLon }: { fromLat: number; fromLon: number; toLat: number; toLon: number }): ReactElement {
  const groupRef = useRef<THREE.Group>(null)

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    const points = greatCirclePoints({ lat: fromLat, lon: fromLon }, { lat: toLat, lon: toLon }, ARC_RADIUS, ARC_SEGMENTS)
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    const material = new THREE.LineDashedMaterial({
      color: HUD_TEAL, dashSize: 0.03, gapSize: 0.025, transparent: true, opacity: 0.55,
    })
    const line = new THREE.Line(geometry, material)
    line.computeLineDistances()
    group.add(line)
    return () => {
      group.remove(line)
      geometry.dispose()
      material.dispose()
    }
  }, [fromLat, fromLon, toLat, toLon])

  return <group ref={groupRef} />
}

interface TrafficPlacementLayerProps {
  placeMode: boolean
}

export function TrafficPlacementLayer({ placeMode }: TrafficPlacementLayerProps): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const [city, setCity] = useState<WorldCity | null>(null)

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    const { lat, lon } = vec3ToLatLon(e.point)
    setCity(nearestCity(lat, lon))
  }

  // Cleared whenever place mode disarms, so a stale ghost can't survive into the next armed
  // session (e.g. re-arming somewhere the pointer hasn't moved yet).
  useEffect(() => {
    if (!placeMode) setCity(null)
  }, [placeMode])

  if (!placeMode) return null

  const landingRegionId = city ? regionOrderFor(city, doc)[0] : undefined
  const landingRegion = landingRegionId ? doc.regions[landingRegionId] : undefined
  const landingGeo = landingRegion ? REGION_GEO[landingRegion.catalogId] : undefined
  const hasLanding = !!(landingRegion && landingGeo)
  const cityPosition = city ? latLonToVec3(city.lat, city.lon, MARKER_ALTITUDE) : null

  return (
    <group>
      {/* Transparent overlay sphere, slightly proud of the Earth mesh — catches pointer-move
          for the snap preview without needing a handler on Earth itself (which only handles
          click). Radius per spec D9 (~1.0005). */}
      <mesh onPointerMove={handlePointerMove} onPointerOut={() => setCity(null)}>
        <sphereGeometry args={[RAYCAST_RADIUS, 32, 32]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>

      {city && cityPosition && (
        <group position={cityPosition}>
          <GhostRing />
          <Html style={{ pointerEvents: 'none' }} zIndexRange={[60, 50]}>
            <div
              style={{
                transform: 'translate(16px, -10px)', whiteSpace: 'nowrap',
                background: 'var(--color-surface)', border: '1px solid var(--color-toolbar-border)',
                borderRadius: 6, padding: '7px 11px', font: '10px var(--font-mono)',
                color: 'var(--color-text-secondary)',
              }}
            >
              {hasLanding && landingGeo && landingRegion ? (
                <>
                  <b style={{ color: 'var(--color-text-primary)' }}>{city.name}</b> · would send{' '}
                  {/* T8 light-theme audit fix: this Html-overlay card is a token-driven DOM
                      surface (unlike the globe's WebGL geometry above/RegionPins' fixed-hex
                      scene labels) — it already uses var(--color-*) for every other span, so
                      the "rps" figure gets the theme-aware kit-teal token (same dark-theme
                      value as HUD_TEAL) instead of a literal hex that read low-contrast on a
                      light card. */}
                  <span style={{ color: 'var(--kit-teal)' }}>{PREVIEW_RPS} rps</span>
                  <br />
                  → lands on <b style={{ color: 'var(--color-text-primary)' }}>{landingRegion.catalogId}</b> ·{' '}
                  {Math.round(greatCircleKm(city.lat, city.lon, landingGeo.lat, landingGeo.lon) / POP_LATENCY_KM_PER_MS)} ms ·{' '}
                  <span style={{ color: 'var(--color-price)' }}>
                    +${placementEgressUsdPerHr(PREVIEW_RPS).toFixed(2)}/hr egress
                  </span>
                </>
              ) : (
                <span>no regions yet — traffic has nowhere to land</span>
              )}
            </div>
          </Html>
        </group>
      )}

      {city && hasLanding && landingGeo && (
        <GhostArc fromLat={city.lat} fromLon={city.lon} toLat={landingGeo.lat} toLon={landingGeo.lon} />
      )}
    </group>
  )
}
