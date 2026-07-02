# Design System Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Living Circuit" design system from `docs/superpowers/specs/2026-07-01-design-system-design.md` — extended color/font/spacing/motion tokens, a runtime-switchable light/dark theme, self-hosted fonts, reduced-motion-safe ambient motion — and apply it to the canvas's core visual surface (nodes, groups, edges, canvas chrome), which is what every other UI sub-project in the broader rework will build on.

**Architecture:** `src/lib/theme.ts` becomes the single source of truth for both JS consumers (canvas 2D drawing in `particleEngine.ts`, inline style objects) and CSS consumers — a small runtime bootstrap in `App.tsx` writes `theme.ts`'s token objects onto `document.documentElement.style` as CSS custom properties (`--color-*`, `--font-*`, `--space-*`, `--motion-*`) whenever the theme mode changes, replacing the currently-static, hand-duplicated `:root` block in `index.css`. Fonts move from a runtime Google Fonts CDN `<link>` (current, wrong for a desktop app) to self-hosted `@fontsource` packages. Motion uses plain CSS transitions/animations plus framer-motion (already a dependency) for component enter/exit — both automatically respect the `prefers-reduced-motion` media query already present in `index.css`.

**Tech Stack:** TypeScript, CSS custom properties, CSS Modules (existing pattern — no CSS-in-JS/Tailwind), `@fontsource/space-grotesk` + `@fontsource/inter` + `@fontsource/jetbrains-mono` (new deps), framer-motion (existing dep), Vitest.

## Global Constraints

- No simulation/lint/cost-model/ScaleScript logic changes — this plan is look-and-feel only.
- Every color pairing must meet WCAG AA: 4.5:1 for normal text, 3:1 for large text/icons/UI components. All values in this plan are pre-verified against these thresholds (computed with the standard WCAG relative-luminance formula) — do not substitute different hex values without re-verifying.
- All motion must respect `prefers-reduced-motion: reduce`. `index.css` already has a global rule collapsing all `animation-duration`/`transition-duration` to `0.01ms` under this media query — new CSS-driven motion gets this for free; anything using framer-motion's JS-driven animation must additionally check `useReducedMotion()` (framer-motion's built-in hook) since the blanket CSS override does not reach framer-motion's transform interpolation.
- `theme.ts` is treated as append-only per `docs/module-boundaries.md` §2, with one explicit exception: `CATEGORY_COLORS`'s existing values are being replaced (harmonized), not appended alongside. Grep every consumer before changing shape.
- `npm run build` must pass after every task. Manual Playwright verification (both theme modes, motion on, `prefers-reduced-motion` simulated) at the end.

---

## File Structure

**Modify:**
- `src/lib/theme.ts` — extend with `DARK_COLORS`/`LIGHT_COLORS` (replacing flat `COLORS`), harmonized `CATEGORY_COLORS` with light-mode foreground variants, `FONT_DISPLAY`/`FONT_BODY`/`FONT_MONO`, `SPACING`, `MOTION` tokens.
- `src/index.css` — remove the hardcoded `:root` color block (values now written at runtime from `theme.ts`); keep structural rules (box-sizing, React Flow overrides, reduced-motion block) and the CSS custom property *names* as documented fallbacks.
- `index.html` — remove the Google Fonts CDN `<link>`/`<preconnect>` tags.
- `src/App.tsx` — add the theme-bootstrap effect (writes CSS custom properties from `theme.ts` based on `themeMode`) and the three font imports.
- `src/app/store/ui.store.ts` — add `themeMode: 'dark' | 'light'` + `setThemeMode`, persisted.
- `src/app/toolbar/Toolbar.tsx` + `Toolbar.module.css` — theme toggle button.
- `src/app/canvas/nodes/BaseNode.tsx` + `BaseNode.module.css` — glassy surface treatment, breathing glow, category-color icon halo.
- `src/app/canvas/nodes/GroupNode.tsx` + `GroupNode.module.css` — consistent corner radius/border treatment.
- `src/app/canvas/edges/BaseEdge.tsx` (and its CSS module, if any) — edge color sourced from harmonized `CATEGORY_COLORS`.
- `src/app/canvas/simulation/particleEngine.ts` — `edgeColor()`/`nodeAccentColor()` hardcoded hex maps updated to the harmonized values (values only, no logic change).
- `src/app/canvas/Canvas.module.css` — canvas background, minimap chrome, toolbar-adjacent surfaces.

**Create:**
- `src/lib/theme.test.ts` — WCAG contrast verification for every token pairing.
- `src/lib/motion.ts` — reduced-motion-aware framer-motion variants (breathing glow keyframes as a CSS class generator, hover/panel transition presets).
- `src/lib/motion.test.ts` — unit test for the reduced-motion gating helper.
- `package.json` — new deps: `@fontsource/space-grotesk`, `@fontsource/inter`, `@fontsource/jetbrains-mono`.

---

### Task 1: Extend `theme.ts` with the full token set + WCAG contrast tests

**Files:**
- Modify: `src/lib/theme.ts`
- Test: `src/lib/theme.test.ts` (new)

**Interfaces:**
- Produces: `DARK_COLORS`, `LIGHT_COLORS` (both matching a shared `ColorTokens` type), `CATEGORY_COLORS` (harmonized, each entry gaining a `foreground` field alongside existing `accent`/`bg`/`border`), `FONT_DISPLAY`/`FONT_BODY`/`FONT_MONO` (strings), `SPACING` (object: `space1`..`space6` = `4/8/12/16/24/32`), `MOTION` (object: `breatheDurationMs: 3000`, `hoverDurationMs: 175`, `panelDurationMs: 200`). All consumed by Task 3 (CSS var bootstrap) and every later task.

Every hex value below is pre-computed and WCAG-verified — copy exactly, do not adjust.

- [ ] **Step 1: Write the failing contrast test**

```typescript
// src/lib/theme.test.ts
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

  it('every category foreground color, including grouping, passes normal-text AA on the light card surface', () => {
    // No exemptions: every CATEGORY_COLORS entry's foreground is used as a text/icon-stroke
    // color somewhere (BaseNode/GroupNode), so every one must independently pass AA — an earlier
    // version of this plan exempted `grouping` on the assumption it only ever renders on a
    // transparent background, which turned out to be false (task-1 review caught it).
    for (const key of Object.keys(CATEGORY_COLORS) as (keyof typeof CATEGORY_COLORS)[]) {
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

  it('every category accent color, including grouping, passes normal-text AA on the dark card surface', () => {
    for (const key of Object.keys(CATEGORY_COLORS) as (keyof typeof CATEGORY_COLORS)[]) {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: FAIL — `DARK_COLORS`/`LIGHT_COLORS`/`successText`/`foreground` don't exist yet (current `theme.ts` only exports flat `COLORS`).

- [ ] **Step 3: Replace `theme.ts` with the full token set**

```typescript
// src/lib/theme.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: PASS — all contrast assertions hold.

- [ ] **Step 5: Find and update every consumer of the old flat `COLORS` export**

Run: `grep -rln "from '.*lib/theme'" src/ --include="*.tsx" --include="*.ts"` and `grep -rln "COLORS\." src/`

For each hit, replace `COLORS.<key>` with the CSS custom property equivalent (`var(--color-<kebab-key>)`) if it's a `style={{ }}` inline usage in a component that renders conditionally on theme (preferred — automatically theme-reactive), or leave as a direct `DARK_COLORS`/`LIGHT_COLORS` reference only in contexts that are provably always-dark regardless of theme mode (there should be none after Task 3 lands, but do this file-by-file and don't guess — if a consumer isn't touched in Tasks 6-9 of this plan, leave a `// TODO(design-system): audit for theme-mode reactivity` comment rather than silently leaving it dark-only, so it surfaces in a later sub-project's work instead of shipping a silent light-mode bug).

- [ ] **Step 6: Run build**

Run: `npm run build`
Expected: TypeScript errors listing every remaining `COLORS.*` reference (since `COLORS` no longer exists) — work through them per Step 5's guidance until zero errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/theme.ts src/lib/theme.test.ts
git commit -m "feat: extend theme.ts with light/dark tokens, harmonized palette, WCAG-verified contrast (design system foundation)"
```

---

### Task 2: Self-host fonts (Space Grotesk, Inter, JetBrains Mono)

**Files:**
- Modify: `package.json`, `index.html`, `src/App.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FONT_DISPLAY`/`FONT_BODY`/`FONT_MONO` from Task 1 become actually renderable (currently only JetBrains Mono has any font file loaded, and it's loaded the wrong way).

- [ ] **Step 1: Install the font packages**

Run: `npm install @fontsource/space-grotesk @fontsource/inter @fontsource/jetbrains-mono`

- [ ] **Step 2: Remove the Google Fonts CDN link from `index.html`**

```html
<!-- index.html — remove these three lines from <head> -->
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

- [ ] **Step 3: Import the self-hosted font files in `App.tsx`**

```typescript
// src/App.tsx — add near the top, alongside existing imports
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
```

- [ ] **Step 4: Run build and verify no network font requests**

Run: `npm run build && npm run preview` (or `npm run dev`)
Expected: build succeeds; opening the app and checking the Network tab shows zero requests to `fonts.googleapis.com`/`fonts.gstatic.com` — all font files served from the local bundle.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json index.html src/App.tsx
git commit -m "feat: self-host Space Grotesk/Inter/JetBrains Mono, remove Google Fonts CDN dependency"
```

---

### Task 3: Theme mode state, persistence, and CSS custom property bootstrap

**Files:**
- Modify: `src/app/store/ui.store.ts`, `src/App.tsx`, `src/index.css`

**Interfaces:**
- Consumes: `DARK_COLORS`/`LIGHT_COLORS`/`FONT_DISPLAY`/`FONT_BODY`/`FONT_MONO`/`SPACING`/`MOTION` from Task 1.
- Produces: `useUiStore(s => s.themeMode)` (`'dark' | 'light'`), `useUiStore(s => s.setThemeMode)` — consumed by Task 4's toggle button. CSS custom properties `--color-canvas`, `--color-node-base`, etc. (kebab-case of every `ColorTokens` key), `--font-display`, `--font-body`, `--font-mono`, `--space-1`..`--space-6`, `--motion-breathe-ms`, `--motion-hover-ms`, `--motion-panel-ms` — consumed by every CSS Module in Tasks 6-9.

- [ ] **Step 1: Add `themeMode` to `ui.store.ts`**

Read the existing store first (`src/app/store/ui.store.ts`) to match its persistence pattern (it already persists other UI state — panel visibility, active tool — follow that exact mechanism, whether it's a custom `localStorage` read/write or a `zustand/middleware` `persist` wrapper). Add:

```typescript
// Add to the store's state interface
themeMode: 'dark' | 'light'
setThemeMode: (mode: 'dark' | 'light') => void
```

```typescript
// Add to the store's creator function, following whatever persistence pattern the file already uses
themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',
setThemeMode: (mode) => {
  localStorage.setItem('scalemap-theme-mode', mode)
  set({ themeMode: mode })
},
```

(If `ui.store.ts` already uses zustand's `persist` middleware for other fields, add `themeMode` to that persisted state shape instead of the manual `localStorage` calls above — match the existing pattern exactly, don't introduce a second persistence mechanism in the same store.)

- [ ] **Step 2: Write the CSS custom property bootstrap in `App.tsx`**

```typescript
// src/App.tsx — add this effect near the top of the root component
import { useEffect } from 'react'
import { DARK_COLORS, LIGHT_COLORS, FONT_DISPLAY, FONT_BODY, FONT_MONO, SPACING, MOTION } from './lib/theme'
import { useUiStore } from './app/store/ui.store'

function useThemeBootstrap() {
  const themeMode = useUiStore(s => s.themeMode)

  useEffect(() => {
    const colors = themeMode === 'light' ? LIGHT_COLORS : DARK_COLORS
    const root = document.documentElement.style
    for (const [key, value] of Object.entries(colors)) {
      const kebab = key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)
      root.setProperty(`--color-${kebab}`, value)
    }
    root.setProperty('--font-display', FONT_DISPLAY)
    root.setProperty('--font-body', FONT_BODY)
    root.setProperty('--font-mono', FONT_MONO)
    for (const [key, value] of Object.entries(SPACING)) {
      root.setProperty(`--space-${key.replace('space', '')}`, `${value}px`)
    }
    root.setProperty('--motion-breathe-ms', `${MOTION.breatheDurationMs}ms`)
    root.setProperty('--motion-hover-ms', `${MOTION.hoverDurationMs}ms`)
    root.setProperty('--motion-panel-ms', `${MOTION.panelDurationMs}ms`)
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])
}
```

Call `useThemeBootstrap()` at the top of the root `App` component function, before the existing return/JSX.

- [ ] **Step 3: Simplify `index.css` — remove the hardcoded color block, keep structural rules**

```css
/* src/index.css — replace the `:root { --font: ...; --color-*: ...; }` block with just this: */
:root {
  /* Color, font, spacing, and motion custom properties are set at runtime by App.tsx's
     theme bootstrap (src/App.tsx, useThemeBootstrap) from src/lib/theme.ts — DARK_COLORS by
     default until the bootstrap effect runs on first render. Do not hardcode values here;
     theme.ts is the single source of truth. */
}
```

Keep every other rule in `index.css` unchanged (box-sizing reset, `body`/`button`/`input` font-family references — but see Step 4 below for the one required change to those), the React Flow override block, and the `prefers-reduced-motion` block exactly as they are.

Also add a global heading default, so the display tier (§3 of the spec) applies automatically to any `h1`/`h2`/`h3` anywhere in the app — including panels other sub-projects add later — without needing to touch every panel component in this plan:

```css
/* index.css — new rule */
h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 600;
}
```

- [ ] **Step 4: Update `index.css`'s default font assignments to match the new tiers**

```css
/* index.css — body's default font changes from mono to body-tier (Inter); buttons/inputs
   follow, since most UI chrome is body-tier text, not data readouts. Anything that needs
   FONT_MONO (numeric readouts, IDs) sets font-family explicitly at the component level. */
body {
  font-family: var(--font-body);
  font-size: 13px;
  background: var(--color-canvas);
  color: var(--color-text-primary);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}

button {
  font-family: var(--font-body);
  cursor: pointer;
  border: none;
  background: none;
}

input, textarea, select {
  font-family: var(--font-body);
  outline: none;
}
```

- [ ] **Step 5: Run build and manually verify the app still renders (dark mode, since that's the default)**

Run: `npm run build`
Expected: zero errors. Then `npm run dev`, load the app, confirm it looks the same as before this task (dark mode, same colors) — this task should be visually invisible so far (the runtime bootstrap reproduces the same dark values `index.css` used to hardcode); Task 4 is what makes the mode actually switchable from the UI.

- [ ] **Step 6: Commit**

```bash
git add src/app/store/ui.store.ts src/App.tsx src/index.css
git commit -m "feat: runtime CSS custom property bootstrap from theme.ts, theme mode state in ui.store"
```

---

### Task 4: Theme toggle in the toolbar

**Files:**
- Modify: `src/app/toolbar/Toolbar.tsx`, `src/app/toolbar/Toolbar.module.css`

**Interfaces:**
- Consumes: `useUiStore(s => s.themeMode)` / `setThemeMode` from Task 3.
- Produces: nothing new consumed elsewhere — this is a leaf UI addition.

- [ ] **Step 1: Read `Toolbar.tsx`** to find where the existing toolbar buttons are laid out (e.g. `Undo`/`Redo`/`Inspect` group seen in this session's Playwright verification) and add a theme toggle button in that cluster, using `lucide-react`'s `Sun`/`Moon` icons (already the icon library per `CLAUDE.md`).

```typescript
// Toolbar.tsx — add import
import { Sun, Moon } from 'lucide-react'

// Add inside the component, near the other toolbar buttons
const themeMode = useUiStore(s => s.themeMode)
const setThemeMode = useUiStore(s => s.setThemeMode)

// Add to JSX, in the toolbar's button cluster
<button
  className={styles.toolbarButton}
  onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
  title={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
>
  {themeMode === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
</button>
```

Match the exact className/structure of a neighboring existing toolbar button (read one first) rather than inventing new markup shape.

- [ ] **Step 2: Manual verification**

Run: `npm run dev`, click the new toggle, confirm the entire app (canvas background, toolbar, sidebar panels — everything already wired to `var(--color-*)`) switches to light-mode colors immediately, and toggling back returns to dark. Confirm the choice survives a page reload (persistence from Task 3, Step 1).

- [ ] **Step 3: Commit**

```bash
git add src/app/toolbar/Toolbar.tsx src/app/toolbar/Toolbar.module.css
git commit -m "feat: add light/dark theme toggle to toolbar"
```

---

### Task 5: Motion primitives module

**Files:**
- Create: `src/lib/motion.ts`, `src/lib/motion.test.ts`

**Interfaces:**
- Produces: `breatheKeyframes(color: string): string` (returns a CSS `@keyframes` block as a string — a reusable pattern for any *future* component needing a differently-colored breathing glow; Task 6 inlines the same pattern as a static CSS Module keyframe instead of calling this directly, since `BaseNode`'s accent color varies per-node via a CSS custom property rather than needing a JS-generated string — see Task 6 Step 3 for the reasoning), `panelTransition` and `hoverLiftVariants` (framer-motion `Transition`/`Variants` objects, not consumed by any task in this plan — this foundation plan's scope stops at canvas-core components per its own File Structure section; these two exports exist so later sub-projects touching actual open/close panels — `SimConfigPanel`, `DiagnosticsPanel`, `PropertiesPanel`, etc. — have a ready-made, spec-aligned transition to import instead of each inventing their own timing).
- Consumed by: Task 6 (the breathing-glow *pattern*, not a direct function call — see above). `panelTransition`/`hoverLiftVariants` are not consumed within this plan; they're published for later sub-projects.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/motion.test.ts
import { describe, it, expect } from 'vitest'
import { panelTransition, hoverLiftVariants } from './motion'
import { MOTION } from './theme'

describe('motion primitives', () => {
  it('panelTransition duration matches the MOTION.panelDurationMs token, in seconds', () => {
    expect(panelTransition.duration).toBeCloseTo(MOTION.panelDurationMs / 1000, 5)
  })

  it('hoverLiftVariants defines rest and hover states with a 1px lift', () => {
    expect(hoverLiftVariants.rest).toEqual({ y: 0 })
    expect(hoverLiftVariants.hover).toEqual({ y: -1 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/motion.test.ts`
Expected: FAIL — `src/lib/motion.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

```typescript
// src/lib/motion.ts
import type { Transition, Variants } from 'framer-motion'
import { MOTION } from './theme'

// CSS-driven (not framer-motion) breathing glow — used via a <style> tag or CSS Module
// keyframe reference in Task 6. Kept CSS-native (not JS-animated) so it automatically respects
// the prefers-reduced-motion block already in index.css, with zero extra reduced-motion logic.
export function breatheKeyframes(color: string): string {
  return `
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 8px ${color}66; }
      50% { box-shadow: 0 0 16px ${color}B3; }
    }
  `
}

export const panelTransition: Transition = {
  duration: MOTION.panelDurationMs / 1000,
  ease: 'easeOut',
}

export const hoverLiftVariants: Variants = {
  rest: { y: 0 },
  hover: { y: -1 },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/motion.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/motion.ts src/lib/motion.test.ts
git commit -m "feat: add reduced-motion-safe motion primitives (breathing glow, panel transition, hover lift)"
```

---

### Task 6: Apply the design system to `BaseNode.tsx`

**Files:**
- Modify: `src/app/canvas/nodes/BaseNode.tsx`, `src/app/canvas/nodes/BaseNode.module.css`

**Interfaces:**
- Consumes: `CATEGORY_COLORS` (harmonized, with `.foreground.light`) from Task 1, `breatheKeyframes` from Task 5, `--color-*`/`--font-*`/`--space-*` custom properties from Task 3.

- [ ] **Step 1: Read `BaseNode.tsx` and `BaseNode.module.css` in full** to find the current node card structure (icon, label, subtitle, metrics row, selection state, health-state color logic) before changing anything — this is the single highest-fan-in visual component in the app (per `docs/module-boundaries.md` §1A, 1 direct caller but renders every non-group node type), get it right.

- [ ] **Step 2: Update `BaseNode.module.css`'s card surface to the glassy treatment**

```css
/* BaseNode.module.css — the root card class (read the existing class name first, likely
   something like .node or .nodeCard — apply these properties to it) */
.node {
  border-radius: 12px;
  background: linear-gradient(145deg, color-mix(in srgb, var(--node-accent) 8%, var(--color-node-base)), var(--color-node-base));
  border: 1px solid color-mix(in srgb, var(--node-accent) 35%, transparent);
  transition: transform var(--motion-hover-ms) ease, box-shadow var(--motion-hover-ms) ease;
}

.node:hover {
  transform: translateY(-1px);
}
```

`--node-accent` is a *per-node* custom property (not global) — set inline on the node's root element in `BaseNode.tsx` from `CATEGORY_COLORS[category].accent` (dark) or `.foreground.light` (light), since each node's accent color depends on its category, not the global theme. Use `color-mix()` (supported in all Tauri-bundled webview targets per this being a Vite 7/modern-target build — verify with a quick `npm run build` after this step; if `color-mix()` isn't supported by the target webview, fall back to pre-computed rgba strings per category instead) rather than hardcoding per-category CSS blocks.

- [ ] **Step 3: Wire the per-node accent custom property and breathing glow in `BaseNode.tsx`**

```typescript
// BaseNode.tsx — near where the node's category/color is currently resolved
import { CATEGORY_COLORS } from '../../../lib/theme'
import { useUiStore } from '../../store/ui.store'

// Inside the component, where category is already known:
const themeMode = useUiStore(s => s.themeMode)
const categoryColors = CATEGORY_COLORS[category] // `category` = however the existing code derives it
const accentColor = themeMode === 'light' ? categoryColors.foreground.light : categoryColors.accent

// On the root node element:
<div
  className={styles.node}
  style={{ '--node-accent': accentColor } as React.CSSProperties}
  data-healthy={isHealthy} // however the existing healthy/active state is already computed
>
```

```css
/* BaseNode.module.css — breathing glow only when healthy/active, per the Restrained motion tier */
.node[data-healthy="true"] {
  animation: breathe var(--motion-breathe-ms) ease-in-out infinite;
}

@keyframes breathe {
  0%, 100% { box-shadow: 0 0 8px color-mix(in srgb, var(--node-accent) 40%, transparent); }
  50% { box-shadow: 0 0 16px color-mix(in srgb, var(--node-accent) 70%, transparent); }
}
```

(This inlines the equivalent of Task 5's `breatheKeyframes` helper directly as a static CSS Module keyframe, which is simpler than JS-injecting a string for a single fixed use site — `breatheKeyframes` from `motion.ts` stays available for any *other* component that needs a differently-colored breathing glow without a static keyframe per color.)

- [ ] **Step 4: Route the node's icon through the category color halo**

Find where the node's `lucide-react` icon is rendered (per `CLAUDE.md`, routed through `NODE_CONFIG` in `src/lib/nodeConfig.ts` — read that to confirm the icon component is passed through, not hardcoded per node type) and wrap it with a soft glow matching `accentColor`:

```css
.nodeIcon {
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--node-accent) 50%, transparent));
}
```

- [ ] **Step 5: Manual verification in both theme modes**

Run: `npm run dev`, place a few different-category nodes on the canvas, confirm: rounded glassy cards with category-tinted gradient/border, hover lift, breathing glow on healthy nodes, icon halo — in both dark and light mode (toggle via Task 4's button), confirm nothing looks broken or illegibly low-contrast in light mode.

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/nodes/BaseNode.tsx src/app/canvas/nodes/BaseNode.module.css
git commit -m "feat: apply Living Circuit glassy/glow treatment to BaseNode"
```

---

### Task 7: Apply the design system to `GroupNode.tsx`

**Files:**
- Modify: `src/app/canvas/nodes/GroupNode.tsx`, `src/app/canvas/nodes/GroupNode.module.css`

**Interfaces:**
- Consumes: same tokens as Task 6, but group nodes use `CATEGORY_COLORS.grouping` (transparent bg, per the spec — grouping containers are visual bounding boxes, not traffic targets, and should stay visually recessive relative to the nodes inside them).

- [ ] **Step 1: Read `GroupNode.tsx`/`GroupNode.module.css` in full** — this is a resizable/collapsible container (VPC, subnet, AZ, region, k8s cluster, etc. per `CLAUDE.md`), structurally different from `BaseNode` (no breathing glow — a container shouldn't visually compete with the nodes inside it for the "alive" cue).

- [ ] **Step 2: Update the corner radius and border to match the system, without adding glow/breathing**

```css
/* GroupNode.module.css — root container class */
.group {
  border-radius: 12px;
  border: 1px solid var(--color-node-border);
  background: color-mix(in srgb, var(--color-grouping-accent, #8391A5) 4%, transparent);
}
```

No hover lift, no breathing animation — grouping containers stay static per Task 6's Step-1 rationale.

- [ ] **Step 3: Manual verification**

Run: `npm run dev`, drop a VPC or region group node, confirm corner radius matches `BaseNode`'s (visual family resemblance) but it stays visually quiet (no glow/motion) relative to the nodes placed inside it, in both theme modes.

- [ ] **Step 4: Commit**

```bash
git add src/app/canvas/nodes/GroupNode.tsx src/app/canvas/nodes/GroupNode.module.css
git commit -m "feat: apply design-system corner radius/border to GroupNode, deliberately static"
```

---

### Task 8: Apply the harmonized palette to edges and particles

**Files:**
- Modify: `src/app/canvas/edges/BaseEdge.tsx` (+ CSS module if one exists — check), `src/app/canvas/simulation/particleEngine.ts`

**Interfaces:**
- Consumes: `CATEGORY_COLORS` (harmonized) from Task 1.
- Produces: no new exports — this task's job is making `particleEngine.ts`'s already-existing `edgeColor()`/`nodeAccentColor()` functions (confirmed present, hardcoded hex maps) return the same harmonized values `BaseEdge.tsx`'s SVG rendering uses, so a request particle's glow color matches the edge/node it's traveling along instead of clashing with the old pre-harmonized hues.

- [ ] **Step 1: Read `BaseEdge.tsx` in full** to find its current edge-type-to-color mapping (request/stream/event/dependency, per `CLAUDE.md`'s edge type list).

- [ ] **Step 2: Read `particleEngine.ts`'s `edgeColor()` and `nodeAccentColor()` functions** (confirmed present in this codebase — `edgeColor(edgeType)` switches on `'stream'|'event'|'dependency'|default`, `nodeAccentColor(nodeType)` maps every `NodeType` to a hex string) and update every hardcoded hex value to the Task 1 harmonized equivalents:

```typescript
// particleEngine.ts — edgeColor(): update the four hardcoded hex values to match
// CATEGORY_COLORS' harmonized accents (dark-mode values — canvas particle rendering doesn't
// currently theme-switch; see Step 4 note below)
function edgeColor(edgeType: string): string {
  switch (edgeType) {
    case 'stream':     return '#9C8CE0' // was #A78BFA — messaging category, harmonized
    case 'event':      return '#3FC7B8' // was #2DD4BF — network category, harmonized
    case 'dependency': return '#475569' // unchanged — grouping/neutral, not part of the harmonized set
    default:           return '#5B9CF6' // was #4A9EFF — compute category, harmonized
  }
}

// nodeAccentColor(): update every entry to the harmonized equivalent
function nodeAccentColor(nodeType: NodeType): string {
  const map: Record<string, string> = {
    ec2: '#5B9CF6', lambda: '#5B9CF6', container: '#5B9CF6', pod: '#5B9CF6',
    loadBalancer: '#3FC7B8', apiGateway: '#3FC7B8', cdn: '#3FC7B8',
    dns: '#3FC7B8', firewall: '#3FC7B8', vpn: '#3FC7B8',
    dbSql: '#E0A552', dbNoSql: '#E0A552', objectStorage: '#E0A552', fileStorage: '#E0A552',
    queue: '#9C8CE0', eventBus: '#9C8CE0', pubsub: '#9C8CE0', stream: '#9C8CE0',
    redis: '#E0A552', memcached: '#E0A552', cdnCache: '#E0A552',
    k8sCluster: '#5B9CF6', ecsCluster: '#5B9CF6', dockerCompose: '#5B9CF6',
  }
  return map[nodeType] ?? '#5B9CF6'
}
```

Cross-reference: these are exactly `CATEGORY_COLORS[category].accent` from Task 1 for each category — verify each substitution against Task 1's values rather than retyping from memory, to avoid a transcription mismatch between the two files.

- [ ] **Step 3: Update `BaseEdge.tsx`'s equivalent color mapping to the same harmonized values**, so the static SVG edge line and the canvas-drawn particles agree. Read the file first to find its exact current mapping shape before editing — it may reference `theme.ts`'s `CATEGORY_COLORS` directly already (preferred, in which case Task 1 already fixed it and this step is just verification) or hardcode its own hex values redundantly (in which case, replace with a `CATEGORY_COLORS` import, removing the duplication rather than hand-syncing a third copy of the same values).

- [ ] **Step 4: Note on canvas particle theme-reactivity (do not implement in this task — document only)**

`particleEngine.ts`'s canvas 2D particle rendering is a rAF-driven imperative loop, not a React component — it doesn't re-render on `themeMode` changes the way CSS-var-driven components do. For this plan, particle colors stay fixed to the dark-mode harmonized values regardless of light/dark toggle (acceptable: particles are small, glowing accents that read fine against either canvas background per the Soft Halo mockup's "glow survives as a soft drop-shadow" principle — verify this visually in Step 5, and only escalate to wiring `themeMode` into `setNodeConfigs`-style engine state if it visually clashes). Leave a comment at `edgeColor()`/`nodeAccentColor()` noting this is dark-mode-only by design, not an oversight, so a future light-mode-focused pass doesn't have to re-discover it.

- [ ] **Step 5: Manual verification**

Run: `npm run dev`, load a template, start a simulation, confirm edge lines and particle glow colors visually agree (no color clash) in dark mode; toggle to light mode mid-simulation and confirm particles still read clearly against the lighter canvas background (per Step 4, particles themselves don't change color — verify this is visually acceptable, not confirm they change).

- [ ] **Step 6: Commit**

```bash
git add src/app/canvas/edges/BaseEdge.tsx src/app/canvas/simulation/particleEngine.ts
git commit -m "fix: sync particleEngine's hardcoded edge/node accent colors to the harmonized palette"
```

---

### Task 9: Apply the design system to canvas chrome (Toolbar, canvas background, minimap)

**Files:**
- Modify: `src/app/canvas/Canvas.module.css`, `src/app/toolbar/Toolbar.module.css`

**Interfaces:**
- Consumes: `--color-*`/`--font-*` custom properties from Task 3 (already-wired, since these files already reference `var(--color-canvas)` etc. per this session's earlier reading of `Canvas.module.css` — this task is a smaller polish pass, not new plumbing).

- [ ] **Step 1: Read `Canvas.module.css` and `Toolbar.module.css` in full**, confirm every color reference already uses `var(--color-*)` (most do, per this session's earlier investigation) — any literal hex value found is a bug this task fixes (grep: `grep -n "#[0-9A-Fa-f]\{3,6\}" src/app/canvas/Canvas.module.css src/app/toolbar/Toolbar.module.css`).

- [ ] **Step 2: Update panel/toolbar corner radius and font-family to match the system**

Wherever `Toolbar.module.css`/`Canvas.module.css` set `border-radius` on buttons/chips, align to Task 1's radius convention (12-14px major panels, 6-8px buttons/chips, per the spec) if they currently diverge. Wherever they set `font-family` explicitly (rather than inheriting `body`'s new `var(--font-body)` default from Task 3), confirm the tier is correct per the spec (toolbar labels = body/Inter, not mono).

- [ ] **Step 3: Manual verification in both theme modes**

Run: `npm run dev`, toggle theme, confirm toolbar/canvas background/minimap all track the theme with no leftover hardcoded-dark elements.

- [ ] **Step 4: Commit**

```bash
git add src/app/canvas/Canvas.module.css src/app/toolbar/Toolbar.module.css
git commit -m "polish: align canvas chrome corner radius/typography to the design system"
```

---

### Task 10: Final verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full build and test suite**

Run: `npm run build && npx vitest run`
Expected: zero errors, all tests pass (including Task 1/5's new contrast/motion tests and every pre-existing test from this session's earlier work).

- [ ] **Step 2: Playwright-driven manual verification, dark mode**

Start `npm run dev`, load a vault template, confirm: glassy node cards with category-tinted glow, breathing animation on healthy nodes, hover lift, edge/particle colors agreeing, toolbar/canvas chrome consistent. Screenshot for the record.

- [ ] **Step 3: Playwright-driven manual verification, light mode**

Toggle to light mode via the Task 4 button, repeat Step 2's checks — confirm text is legible everywhere (per the WCAG constraint), soft-halo glow reads correctly, no leftover dark-only element breaks the light theme. Screenshot for the record.

- [ ] **Step 4: `prefers-reduced-motion` verification**

Using Playwright's `page.emulateMedia({ reducedMotion: 'reduce' })` (or the browser devtools rendering tab's "Emulate CSS media feature prefers-reduced-motion"), confirm breathing glow and hover-lift animations collapse to instant/static per `index.css`'s existing global rule, while particle movement (core information) continues.

- [ ] **Step 5: Cross-check against the spec's Definition of Done**

Re-read `docs/superpowers/specs/2026-07-01-design-system-design.md`'s "Definition of Done" checklist and confirm every line item is satisfied by this plan's completed tasks. Note any gap in the final report rather than silently closing it out.
