export interface ColorTokens {
  canvas: string
  canvasDots: string
  nodeBase: string
  nodeBorder: string
  surface: string
  surfaceHover: string
  toolbar: string
  toolbarBorder: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  danger: string
  success: string
  successText: string   // text-safe variant — success's own value only passes the 3:1 icon/large-text threshold
  warning: string
  accent: string
  onAccent: string   // text/icon color for content rendered ON a saturated accent/danger/warning chip
}

export const DARK_COLORS: ColorTokens = {
  canvas: '#0D0F12',
  canvasDots: '#1A1D22',
  nodeBase: '#161920',
  nodeBorder: '#2A2E38',
  surface: '#0F1117',
  surfaceHover: '#13161E',
  toolbar: '#111318',
  toolbarBorder: '#1E2128',
  textPrimary: '#F1F5F9',
  textSecondary: '#94A3B8',
  textMuted: '#64748B',
  danger: '#EF4444',
  success: '#22C55E',
  successText: '#22C55E', // already passes 4.5:1 on dark surfaces, no separate variant needed
  warning: '#F59E0B',
  accent: '#4A9EFF',
  onAccent: '#FFFFFF',   // white always reads on these saturated chip backgrounds in both themes
}

export const LIGHT_COLORS: ColorTokens = {
  canvas: '#F4F6FA',
  canvasDots: '#E1E7F0',
  nodeBase: '#FFFFFF',
  nodeBorder: '#E1E7F0', // intentionally low-contrast (~1.15:1) — card elevation reads via shadow
                          // (see BaseNode glow treatment, Task 6), not border color; this is a
                          // redundant/secondary cue, not the only way the boundary is conveyed
  surface: '#FAFAF8',
  surfaceHover: '#F0F0EE',
  toolbar: '#FAFAF8',
  toolbarBorder: '#E5E5E0',
  textPrimary: '#0F172A',
  textSecondary: '#475569',
  textMuted: '#64748B',
  danger: '#DC2626',      // darkened from dark-mode's #EF4444 — 4.83:1 on white, passes normal-text AA
  success: '#16A34A',     // matches approved Soft Halo mockup — 3.30:1, passes icon/large-text AA only
  successText: '#11823B', // 4.91:1 — use this instead of `success` when rendering as small text
  warning: '#B45309',     // darkened from dark-mode's #F59E0B — 5.02:1 on white, passes normal-text AA
  accent: '#3F6DAC',      // matches compute category's light-mode foreground (see CATEGORY_COLORS)
  onAccent: '#FFFFFF',    // white always reads on these saturated chip backgrounds in both themes
}

export const CATEGORY_COLORS = {
  compute: {
    accent: '#5B9CF6',                              // dark mode — 6.31:1 on dark card, matches spec's harmonized value
    foreground: { light: '#3F6DAC' },                // light mode text/icon-stroke use — 5.26:1 on white
    bg: '#0D1F35', border: '#1A3A5C',
  },
  network: {
    accent: '#3FC7B8',
    foreground: { light: '#288177' },                // 4.67:1 on white
    bg: '#001F1E', border: '#003E3A',
  },
  storage: {
    accent: '#E0A552',
    foreground: { light: '#916B35' },                // 4.82:1 on white
    bg: '#1F1400', border: '#3A2800',
  },
  messaging: {
    accent: '#9C8CE0',
    foreground: { light: '#6D629C' },                // 5.42:1 on white
    bg: '#180F2A', border: '#2E1A50',
  },
  caching: {
    accent: '#E0A552',
    foreground: { light: '#916B35' },
    bg: '#1F1400', border: '#3A2800',
  },
  orchestration: {
    accent: '#5B9CF6',
    foreground: { light: '#3F6DAC' },
    bg: '#0D1F35', border: '#1A3A5C',
  },
  grouping: {
    accent: '#8391A5',                // 5.49:1 on dark card — was #475569 (2.32:1, failed AA);
                                       // grouping's accent is used as a foreground/icon-stroke
                                       // color on BaseNode/GroupNode, not only a transparent-bg
                                       // tint, so it needs the same AA guarantee every other
                                       // category gets (task-1 review caught the original value)
    foreground: { light: '#475569' }, // 7.58:1 on white — already passing, unaffected
    bg: 'transparent', border: '#2A2E38',
  },
} as const

export const FONT_DISPLAY = "'Space Grotesk', sans-serif"
export const FONT_BODY = "'Inter', sans-serif"
export const FONT_MONO = "'JetBrains Mono', monospace"

export const SPACING = {
  space1: 4,
  space2: 8,
  space3: 12,
  space4: 16,
  space5: 24,
  space6: 32,
}

export const MOTION = {
  breatheDurationMs: 3000,
  hoverDurationMs: 175,
  panelDurationMs: 200,
}
