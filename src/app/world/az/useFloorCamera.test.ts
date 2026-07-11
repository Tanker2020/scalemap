// Node-env unit tests for the floor camera's pure math (useFloorCamera.ts). The hook's DOM
// wiring (wheel listener, pointer capture) is live-smoke territory; the math is exact here.
import { describe, expect, it } from 'vitest'
import { CAMERA_MAX_SCALE, CAMERA_MIN_SCALE, FIT_MARGIN, clampScale, fitCamera, zoomAt } from './useFloorCamera'

describe('clampScale', () => {
  it('clamps to the [min, max] band', () => {
    expect(clampScale(0.01)).toBe(CAMERA_MIN_SCALE)
    expect(clampScale(99)).toBe(CAMERA_MAX_SCALE)
    expect(clampScale(1.3)).toBe(1.3)
  })
})

describe('fitCamera', () => {
  it('scales to the limiting axis with the fit margin and centers the content', () => {
    // container 1800×900, content 900×430: width ratio 2, height ratio ~2.093 → limited by
    // width → scale 2 · 0.94 = 1.88; centered on both axes.
    const cam = fitCamera(1800, 900, 900, 430)
    expect(cam.scale).toBeCloseTo(2 * FIT_MARGIN, 10)
    expect(cam.tx).toBeCloseTo((1800 - 900 * cam.scale) / 2, 10)
    expect(cam.ty).toBeCloseTo((900 - 430 * cam.scale) / 2, 10)
  })

  it('clamps a tiny container to the minimum scale', () => {
    expect(fitCamera(100, 100, 900, 430).scale).toBe(CAMERA_MIN_SCALE)
  })

  it('returns the identity camera for a zero-sized container (jsdom pre-layout)', () => {
    expect(fitCamera(0, 0, 900, 430)).toEqual({ scale: 1, tx: 0, ty: 0 })
  })
})

describe('zoomAt', () => {
  it('keeps the content point under the cursor stationary', () => {
    const before = { scale: 1, tx: 0, ty: 0 }
    const after = zoomAt(before, 100, 50, 2)
    expect(after.scale).toBe(2)
    // content point that was at container (100,50): c = (100 - tx)/scale = 100 → after zoom
    // it must map back to container 100: 100·2 + tx' = 100 → tx' = -100.
    expect(after.tx).toBe(-100)
    expect(after.ty).toBe(-50)
  })

  it('is the identity at factor 1 and clamps at the band edges', () => {
    const cam = { scale: 1.2, tx: 30, ty: -12 }
    expect(zoomAt(cam, 40, 40, 1)).toEqual(cam)
    expect(zoomAt(cam, 40, 40, 100).scale).toBe(CAMERA_MAX_SCALE)
    expect(zoomAt(cam, 40, 40, 0.001).scale).toBe(CAMERA_MIN_SCALE)
  })
})
