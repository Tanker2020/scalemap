// src/app/world/globe/GlobeScene.tsx
// R3F night-earth scene (Phase 5 D2): self-lit sphere with the T1 NASA Black Marble texture, a
// backside additive-fresnel atmosphere shell, clamped OrbitControls, idle rotation (paused on
// interaction / disabled under reduced motion), and place-mode click-to-latlon. T4/T5 layers
// (RegionPins, PopulationMarkers, ArcsLayer) mount as `children` INSIDE the rotating group so
// they track the globe's orientation for free — no extra wiring needed here or in those files.
import { Suspense, useCallback, useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, useTexture } from '@react-three/drei'
import { useReducedMotion } from 'framer-motion'
import * as THREE from 'three'
import { vec3ToLatLon } from './geo'
// Texture: NASA Black Marble 2016 night-lights composite (public domain,
// https://earthobservatory.nasa.gov/features/NightLights). 4096x2048, downsampled from the
// 13500x6750 "3km" original — the 2k version undersampled badly on a full-window globe
// (visible hemisphere ≈ 1024 texture px stretched across ~1500 device px).
import earthTextureUrl from '../../../assets/globe/black-marble-4k.jpg'

const EARTH_RADIUS = 1
const ATMOSPHERE_SCALE = 1.035
const IDLE_ROTATION_RAD_PER_S = 0.02

// J1 (fragment header): three.js's default SphereGeometry (phiStart=0, phiLength=2π) places
// vertices at the equator as x=-r·cos(phi), z=r·sin(phi) where phi=u_geom·2π (u_geom = the
// geometry's own u coordinate, 0..1). T1's latLonToVec3 places the equator at x=r·sin(lon),
// z=r·cos(lon). Solving x/z equal at lon=0 (x=0,z=r) against the geometry's formula (x=0,z=r
// happens at phi=π/2, i.e. u_geom=0.25) shows the geometry's own u=0.25 seam sits at lon=0. A
// standard NASA Black Marble equirectangular mosaic centers the prime meridian at the image's
// horizontal middle (u_texture=0.5, since it spans lon -180..180 left-to-right). Sampling the
// texture at (u_geom + 0.25) aligns the two — hence texture.offset.x = 0.25. THIS IS THE
// PHASE'S HIGHEST-RISK CALIBRATION: if the live smoke shows continents mirrored/rotated, or
// (Task 4) us-east-1's pin lands in the Atlantic instead of Virginia, retune this ONE constant
// first (try 0.75, or negate lon in latLonToVec3's caller — but that would also move every pin,
// so prefer retuning this offset).
const TEXTURE_LON_OFFSET = 0.25

// ~20-line backside additive fresnel glow (Phase 5 D2/D6): rim brightens where the surface
// normal is near-perpendicular to the view direction, faint head-on. No external light needed —
// intensity is purely a function of view angle.
const ATMOSPHERE_VERTEX_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`
const ATMOSPHERE_FRAGMENT_SHADER = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform vec3 glowColor;
  uniform float limbDot;
  void main() {
    // On this BACKSIDE shell the outward normal points away from the camera everywhere it
    // is visible, so dot(normal, view) runs from ~0 at the shell's outer silhouette down to
    // -limbDot where the view ray grazes the planet's limb. Remap that range so the glow
    // peaks at the limb and falls smoothly to nothing at the shell edge. (The previous
    // max(dot, 0) clamp saturated every visible fragment to full intensity, rendering a
    // hard uniform ring instead of an atmosphere.)
    float toward = clamp(-dot(normalize(vNormal), normalize(vViewDir)) / limbDot, 0.0, 1.0);
    float intensity = pow(toward, 3.0);
    gl_FragColor = vec4(glowColor, intensity * 0.32);
  }
`

interface EarthProps { placeMode: boolean; onPlace: (lat: number, lon: number) => void }

function Earth({ placeMode, onPlace }: EarthProps): ReactElement {
  const texture = useTexture(earthTextureUrl)
  const gl = useThree(s => s.gl)
  // Phase 6 T9 carry-forward: this texture wrap/offset mutation is a SIDE EFFECT (mutating a
  // shared THREE.Texture instance + flagging it for a GPU re-upload), not a memoized pure
  // derivation — useLayoutEffect is the conventional home for a synchronous, pre-paint
  // side effect. useMemo happened to work because its body also runs synchronously during
  // render, but React does not guarantee a useMemo body runs exactly once per input or is
  // never re-invoked/discarded (e.g. under future concurrent-rendering behavior) the way an
  // effect's cleanup/rerun contract is guaranteed. Same dependency array, same body, same
  // texture.needsUpdate=true flag — behavior-preserving.
  useLayoutEffect(() => {
    texture.wrapS = THREE.RepeatWrapping
    texture.offset.x = TEXTURE_LON_OFFSET
    texture.colorSpace = THREE.SRGBColorSpace
    // Max anisotropic filtering keeps the equirectangular map crisp at the sphere's grazing
    // angles (the limb smeared badly without it — part of the reported "globe looks low res").
    texture.anisotropy = gl.capabilities.getMaxAnisotropy()
    // useTexture returns an already-uploaded texture; changing wrap mode after upload needs
    // needsUpdate so the GPU sampler is re-configured — otherwise some three.js versions keep
    // ClampToEdge and smear a seam at the offset's wrap boundary. (wrapT/repeat unchanged: the
    // offset only shifts horizontally and the image already spans the full 0..1 V range.)
    texture.needsUpdate = true
  }, [texture, gl])

  // Raycasts the earth mesh only (r3f's onClick gives the world-space intersection point,
  // already correct even though this mesh lives inside the rotating group — r3f resolves hits
  // in world space, not group-local space).
  const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
    if (!placeMode) return
    e.stopPropagation()
    const { lat, lon } = vec3ToLatLon(e.point)
    onPlace(lat, lon)
  }, [placeMode, onPlace])

  return (
    <mesh onClick={handleClick}>
      <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
      <meshBasicMaterial map={texture} />
    </mesh>
  )
}

function Atmosphere(): ReactElement {
  // useMemo so the THREE.Color instance (and its allocation) isn't recreated every render.
  // limbDot = |dot(normal, view)| where a view ray tangent to the planet (radius 1) crosses
  // this shell (radius ATMOSPHERE_SCALE): sqrt(1 - 1/scale²) — the shader's remap anchor.
  const uniforms = useMemo(() => ({
    glowColor: { value: new THREE.Color('#4A9EFF') },
    limbDot: { value: Math.sqrt(1 - 1 / (ATMOSPHERE_SCALE * ATMOSPHERE_SCALE)) },
  }), [])
  return (
    <mesh scale={ATMOSPHERE_SCALE}>
      <sphereGeometry args={[EARTH_RADIUS, 64, 64]} />
      <shaderMaterial
        vertexShader={ATMOSPHERE_VERTEX_SHADER}
        fragmentShader={ATMOSPHERE_FRAGMENT_SHADER}
        uniforms={uniforms}
        side={THREE.BackSide}
        blending={THREE.AdditiveBlending}
        transparent
        depthWrite={false}
      />
    </mesh>
  )
}

interface RotatingGroupProps { paused: boolean; interactingRef: { current: boolean }; children?: ReactNode }

function RotatingGroup({ paused, interactingRef, children }: RotatingGroupProps): ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, delta) => {
    if (paused || interactingRef.current) return
    if (groupRef.current) groupRef.current.rotation.y += IDLE_ROTATION_RAD_PER_S * delta
  })
  return <group ref={groupRef}>{children}</group>
}

export interface GlobeSceneProps {
  placeMode: boolean                                   // T6 arms this; T3 wires the prop through inert
  onPlace: (lat: number, lon: number) => void
  autoRotate?: boolean                                 // GlobeView's lock button; default on
  children?: ReactNode                                 // T4/T5 layers mount inside the Canvas
}

export function GlobeScene({ placeMode, onPlace, autoRotate = true, children }: GlobeSceneProps): ReactElement {
  const reduced = useReducedMotion() ?? false
  // J4 (fragment header): OrbitControls' onStart/onEnd are documented pass-throughs to the
  // underlying three.js controls' 'start'/'end' events, which fire on pointerdown/pointerup —
  // this IS the "pointerdown/up listeners" pause the skeleton describes, via the idiomatic drei
  // API rather than raw DOM listeners.
  const interactingRef = useRef(false)

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 2.8], fov: 45 }}
      style={{ cursor: placeMode ? 'crosshair' : 'default' }}
    >
      <Suspense fallback={null}>
        <RotatingGroup paused={reduced || !autoRotate} interactingRef={interactingRef}>
          <Earth placeMode={placeMode} onPlace={onPlace} />
          <Atmosphere />
          {children}
        </RotatingGroup>
      </Suspense>
      <OrbitControls
        enablePan={false}
        minDistance={1.6}
        maxDistance={5}
        enableDamping
        onStart={() => { interactingRef.current = true }}
        onEnd={() => { interactingRef.current = false }}
      />
    </Canvas>
  )
}
