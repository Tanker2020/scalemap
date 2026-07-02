import { describe, it, expect } from 'vitest'
import { DARK_COLORS, LIGHT_COLORS, CATEGORY_COLORS } from './theme'

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function srgbToLinear(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('WCAG AA contrast — light mode', () => {
  it('textPrimary/Secondary/Muted on card surface all pass normal-text AA (4.5:1)', () => {
    expect(contrastRatio(LIGHT_COLORS.textPrimary, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(LIGHT_COLORS.textSecondary, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(LIGHT_COLORS.textMuted, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
  })

  it('danger and warning pass normal-text AA on card surface', () => {
    expect(contrastRatio(LIGHT_COLORS.danger, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(LIGHT_COLORS.warning, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
  })

  it('success passes large-text/icon AA (3:1) as a status dot; successText passes normal-text AA', () => {
    expect(contrastRatio(LIGHT_COLORS.success, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(3.0)
    expect(contrastRatio(LIGHT_COLORS.successText, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
  })

  it('every category foreground color passes normal-text AA on the light card surface', () => {
    for (const key of Object.keys(CATEGORY_COLORS) as (keyof typeof CATEGORY_COLORS)[]) {
      if (key === 'grouping') continue // transparent bg, exempt — never rendered as text on a solid card
      const fg = CATEGORY_COLORS[key].foreground.light
      expect(contrastRatio(fg, LIGHT_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('WCAG AA contrast — dark mode', () => {
  it('textPrimary/Secondary on card surface pass normal-text AA', () => {
    expect(contrastRatio(DARK_COLORS.textPrimary, DARK_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(DARK_COLORS.textSecondary, DARK_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
  })

  it('every category accent color passes normal-text AA on the dark card surface', () => {
    for (const key of Object.keys(CATEGORY_COLORS) as (keyof typeof CATEGORY_COLORS)[]) {
      if (key === 'grouping') continue
      const accent = CATEGORY_COLORS[key].accent
      expect(contrastRatio(accent, DARK_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('status colors pass normal-text AA on the dark card surface', () => {
    expect(contrastRatio(DARK_COLORS.danger, DARK_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(DARK_COLORS.warning, DARK_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(DARK_COLORS.success, DARK_COLORS.nodeBase)).toBeGreaterThanOrEqual(4.5)
  })
})
