// src/app/canvas/simulation/particleEngine/circuitVisual.ts
import { getAllBreakers } from './circuitBreakers'

// ─── Circuit-breaker edge overlay ──────────────────────────────────────────
// Draws a translucent "neon sheath" along an open/half-open edge's actual rendered
// path (sampled via the same getEdgePoint the particles themselves use, so it
// correctly follows bowed/parallel-edge curves and stays pan/zoom-correct).
// Calibrated interactively — see docs/superpowers/specs/2026-07-03-circuit-breaker-edge-visualization-design.md.
// Do not speed up the scan cycle without re-confirming with the user; it was
// slowed down three times in response to "too aggressive on the eyes" feedback.

const SHEATH_COLOR = '#F59E0B'
const SHEATH_THICKNESS = 14
const SAMPLE_COUNT = 24        // polyline segments approximating the edge's curve
const TICK_COUNT = 10          // number of scan ticks visible along the edge at once
const TICK_HALF_LENGTH = 10    // px, each side of the tick's center point
const OPEN_SCAN_CYCLE_MS = 3500
const HALF_OPEN_SCAN_CYCLE_MS = 7000
const PULSE_CYCLE_MS = 2500
const PULSE_FADE_FRACTION = 0.08 // fraction of the cycle spent fading in/out at each end

// Samples the edge's path into a polyline. Returns null if the underlying SVG path
// element isn't in the DOM yet (getEdgePoint's own contract) — callers must skip
// drawing entirely for this edge on this frame rather than drawing a partial shape.
function samplePath(
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
): [number, number][] | null {
  const pts: [number, number][] = []
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const p = getPoint(edgeId, i / SAMPLE_COUNT)
    if (!p) return null
    pts.push(p)
  }
  return pts
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
  ctx.beginPath()
  ctx.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
  ctx.stroke()
}

// Thick translucent glow pass + a crisper lighter border pass on top — the glow is
// what keeps the underlying edge line/particles visible through it (a solid opaque
// tube was tried and explicitly rejected during design for not scaling visually to
// several simultaneously-failing edges).
function drawSheath(ctx: CanvasRenderingContext2D, pts: [number, number][], opacityMul: number, dashedBorder: boolean) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  ctx.globalAlpha = 0.16 * opacityMul
  ctx.strokeStyle = SHEATH_COLOR
  ctx.shadowColor = SHEATH_COLOR
  ctx.shadowBlur = 10 * opacityMul
  ctx.lineWidth = SHEATH_THICKNESS
  strokePolyline(ctx, pts)

  ctx.shadowBlur = 0
  ctx.globalAlpha = 0.5 * opacityMul
  ctx.lineWidth = 1.5
  if (dashedBorder) ctx.setLineDash([4, 3])
  strokePolyline(ctx, pts)

  ctx.restore()
}

// A short bright tick perpendicular to the path at parameter t, using two nearby
// samples to derive the local tangent (and therefore perpendicular) direction.
function drawTickAt(
  ctx: CanvasRenderingContext2D,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
  t: number,
  halfLength: number,
  color: string,
  alpha: number,
  lineWidth: number,
) {
  const p1 = getPoint(edgeId, t)
  const p2 = getPoint(edgeId, Math.min(0.999, t + 0.01))
  if (!p1 || !p2) return
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(p1[0] - nx * halfLength, p1[1] - ny * halfLength)
  ctx.lineTo(p1[0] + nx * halfLength, p1[1] + ny * halfLength)
  ctx.stroke()
  ctx.restore()
}

function drawScanTicks(
  ctx: CanvasRenderingContext2D,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
  now: number,
  cycleMs: number,
  alpha: number,
) {
  const phase = (now % cycleMs) / cycleMs
  for (let i = 0; i < TICK_COUNT; i++) {
    const t = (i / TICK_COUNT + phase) % 1
    drawTickAt(ctx, getPoint, edgeId, t, TICK_HALF_LENGTH, SHEATH_COLOR, alpha, 2)
  }
}

// Single bright "probe" pulse traveling the full edge — open state only (half-open
// deliberately has no pulse, per the final approved design).
function drawPulse(
  ctx: CanvasRenderingContext2D,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
  edgeId: string,
  now: number,
) {
  const t = (now % PULSE_CYCLE_MS) / PULSE_CYCLE_MS
  const fade =
    t < PULSE_FADE_FRACTION ? t / PULSE_FADE_FRACTION
    : t > 1 - PULSE_FADE_FRACTION ? (1 - t) / PULSE_FADE_FRACTION
    : 1
  ctx.save()
  ctx.shadowColor = SHEATH_COLOR
  ctx.shadowBlur = 8
  drawTickAt(ctx, getPoint, edgeId, t, 7, '#FFFFFF', 0.85 * fade, 2)
  ctx.restore()
}

// Called once per frame from particleEngine.ts's advanceAndDraw. Draws nothing for
// closed edges (the common case) and nothing at all if the DOM path element for an
// open/half-open edge isn't resolvable yet on this frame.
export function drawCircuitOverlay(
  ctx: CanvasRenderingContext2D,
  now: number,
  getPoint: (edgeId: string, t: number) => [number, number] | null,
): void {
  for (const [edgeId, breaker] of getAllBreakers()) {
    if (breaker.state === 'closed') continue

    const pts = samplePath(getPoint, edgeId)
    if (!pts) continue

    const isOpen = breaker.state === 'open'
    const opacityMul = isOpen ? 1 : 0.55

    drawSheath(ctx, pts, opacityMul, !isOpen)
    drawScanTicks(ctx, getPoint, edgeId, now, isOpen ? OPEN_SCAN_CYCLE_MS : HALF_OPEN_SCAN_CYCLE_MS, isOpen ? 0.5 : 0.25)
    if (isOpen) drawPulse(ctx, getPoint, edgeId, now)
  }
}
