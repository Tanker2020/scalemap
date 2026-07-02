# Scalemap Design System Foundation — Spec

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:writing-plans` to turn this spec into an implementation plan, then execute via `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

**Goal:** Replace Scalemap's current single-tone, animation-free, monospace-everywhere visual language with a cohesive "Living Circuit" design system — bioluminescent/glassy dark mode as the primary experience, a true (not naive-inverted) light mode, restrained ambient motion, and a three-tier type system — without touching simulation/lint/cost-model logic. This is the foundation every other UI sub-project in this rework (layout/IA, packet editor, cost dashboard, event log, diagnostics) will build on.

**Architecture:** All tokens live in `src/lib/theme.ts` today (28 lines, single source of truth, imported wherever color/font is needed — `COLORS`, `CATEGORY_COLORS`, `FONT`). This spec extends that file into a fuller token set (adds light-mode variants, motion tokens, elevation/glow tokens, spacing scale) and threads two new concerns through the app: a **theme mode** (dark/light, user-toggleable, persisted) and a **`prefers-reduced-motion`-respecting animation layer** (CLAUDE.md already mandates this; today there's effectively no motion to gate, this spec adds motion that must honor it).

**Tech Stack:** Existing CSS Modules per component (no CSS-in-JS, no Tailwind) + `theme.ts` constants + CSS custom properties for the two things that must swap at runtime (theme mode) — framer-motion (already a dependency, currently underused per CLAUDE.md's dependency table) for the motion layer.

## Global Constraints

- No simulation/lint/cost-model/ScaleScript logic changes. This spec is look-and-feel only.
- Every new color must meet WCAG AA contrast (4.5:1 text, 3:1 large text/UI) against its background, in both theme modes — the "hard to read" complaint is a hard requirement to fix, not just an aesthetic one.
- All motion must respect `prefers-reduced-motion: reduce` (CLAUDE.md already states this; today's near-zero-motion baseline made it moot — it stops being moot once this spec ships).
- `theme.ts` remains the single source of truth; components read tokens, never hardcode hex values (existing violations found during implementation should be fixed, not left as-is, since this spec's whole point is consistency).
- Category color fan-out (`CATEGORY_COLORS`) currently has 31 files importing `nodeConfig.ts` and several importing `theme.ts` directly — per `docs/module-boundaries.md` §2, treat `theme.ts` as append-only during this work; a like-for-like key rename/removal is fine (renaming isn't "appending" but is unavoidable here since we're changing values, not just adding — call this out explicitly in the implementation plan as the one exception to append-only, and grep every consumer before changing a key name).

---

## 1. Visual Direction: Living Circuit

Nodes and panels feel like living, glassy organisms rather than flat rectangles. Bioluminescent glow (colored box-shadow, not just border color) signals health/activity; particles read as blood-cells-in-veins flowing along edges. This is a deliberate *evolution* of the current aesthetic (same instinct, executed with actual glow/depth/motion instead of flat fills), not a replacement — so it stays legible as "the same app, now finished" rather than a jarring reskin.

**Derived surface treatment** (not separately shown in mockups, following directly from the chosen direction):

- Panels/cards: soft rounded corners (12–14px for node cards and major panels, 6–8px for buttons/inputs/chips/badges — smaller elements stay crisper so the glassy roundness doesn't read as bubbly/toylike at high density).
- Elevation is glow-based, not neutral-drop-shadow-based: a resting panel gets a faint neutral shadow for depth (`0 4px 24px rgba(0,0,0,0.4)`); an *active/healthy/selected* element's elevation shifts to a colored glow keyed to its status or category color. Error/critical states use `danger`-tinted glow instead of a generic red border — glow intensity itself becomes a severity signal.
- Node/panel backgrounds gain a subtle gradient (`linear-gradient(145deg, <accent>08, <accent>04)` over the base surface color) rather than a flat fill, plus a 1px border at ~30-40% accent opacity instead of a hard neutral border — this is what "glassy" means concretely.

## 2. Light Mode: Soft Halo

Light mode is a first-class mode (toggle in the toolbar, persisted to local settings), not a hidden/incomplete afterthought. Glow survives the transition as a soft colored drop-shadow (e.g. `0 4px 24px rgba(<accent>,0.18)`) rather than vanishing — the app should still feel like the same living system in daylight, just less neon.

**New tokens required in `theme.ts`:** every existing `COLORS` entry needs a light-mode counterpart. Concrete values, taken from the approved Soft Halo mockup:

| Token | Dark (existing) | Light (new) |
| - | - | - |
| `canvas` (page bg) | `#0D0F12` | `#F4F6FA` |
| `nodeBase`/card surface | `#161920` | `#FFFFFF` |
| `nodeBorder` | `#2A2E38` | `#E1E7F0` |
| `textPrimary` | `#F1F5F9` | `#0F172A` |
| `textSecondary` | `#94A3B8` | `#475569`/`#64748B` |
| `success` | `#22C55E` | `#16A34A` |
| glow/elevation shadow | neon bloom, e.g. `0 0 10px <accent>` | soft drop-shadow, e.g. `0 4px 24px rgba(<accent>,0.18)` |

`surface`/`toolbar` follow `nodeBase`'s lightening at a slightly dimmer step (same relationship they have in dark mode, e.g. `toolbar` a touch darker than `canvas`). `danger`/`warning` get the same treatment as `success` above (small lightness/saturation adjustment for AA contrast against white, same hue) — status colors must not be reinterpreted per-mode, or muscle memory breaks. Remaining tokens not shown in the mockup (e.g. exact `warning`/`danger` light-mode values) follow the same derivation and get verified against WCAG AA during implementation, not hand-waved.

**Implementation shape:** CSS custom properties on `:root`/`[data-theme="light"]`, generated from a `LIGHT_COLORS`/`DARK_COLORS` pair in `theme.ts`, with a `ThemeMode` type and a small `ui.store.ts` addition (`themeMode: 'dark' | 'light'`, persisted) — `ui.store.ts` already holds UI-only state (active tool, panel visibility) per `CLAUDE.md`, this fits there, not a new store.

## 3. Typography: Three-Tier

- **Space Grotesk** — panel titles, major section headings only (`h2`/`h3`-equivalents: "Simulation Results", "Node Palette", node card *type label* if desired). Used sparingly — this is what adds character, and character overused stops being character.
- **Inter** — everything else that's prose or a label: descriptions, tooltips, diagnostics messages, event log text, form labels, button text, node *name* (not its numeric stats).
- **JetBrains Mono** (unchanged, already a dependency) — reserved for anything numeric or code-like: RPS/latency/utilization readouts, IDs, ScaleScript snippets, Terraform export preview, packet template field values.

**Concretely, in `theme.ts`:** `FONT` (single constant) becomes `FONT_DISPLAY` / `FONT_BODY` / `FONT_MONO`, three exported strings. Every component currently hardcoding `fontFamily: 'inherit'` or relying on the single global `FONT` needs an explicit pick of one of the three — this is the one place in this spec where "derive defaults, don't relitigate" doesn't fully apply; the implementation plan should include a per-component audit (roughly: any `.tsx` currently setting `font-family` or relying on body-inherited monospace) rather than a blanket find-replace, since getting tier assignment wrong per-component undoes the point.

New Google Fonts dependency: Space Grotesk + Inter, self-hosted (per `@fontsource` packages, not a runtime Google Fonts CDN `<link>` — this is a desktop Tauri app; a network-dependent font load on first paint is the wrong tradeoff, and `@fontsource/space-grotesk` + `@fontsource/inter` npm packages avoid it). JetBrains Mono's existing loading mechanism, wherever it lives today, should be checked and given the same treatment if it isn't already self-hosted.

## 4. Motion: Restrained

Baseline ambient motion is subtle, not decorative:

- Healthy/active nodes: slow breathing glow, ~3s ease-in-out cycle, box-shadow intensity oscillating in a narrow band (not scale/transform — scale-breathing at this speed reads as "broken/glitchy" more than "alive").
- Hover: 1px lift + shadow response, ~150-200ms, no bounce/spring (spring easing is reserved for higher-motion-budget contexts, e.g. the packet editor sub-project).
- Particles: steady-pace flow along edges (no trail/comet effect at this tier — trails are a Lively/Cinematic-tier device), consistent with the existing particle engine's per-frame position updates; this is a rendering/style change only (color, size, glow), not a particleEngine.ts logic change.
- Panel open/close, tab switches, popover appearance: short (150-250ms) fade+slight-translate via framer-motion, matching the restraint level — no elaborate spring/stagger choreography.
- **Event-driven motion is a separate, higher-intensity budget layered on top regardless of this baseline**: saturation/circuit-open/cascade events get sharper, faster, more attention-grabbing motion (flash, shake, faster pulse) than idle-state breathing — severity should be legible from motion alone, glanced from across a large diagram. This spec sets the *idle* baseline; event-motion detail can be specced alongside whichever sub-project touches `EventLogPanel`/diagnostics, since it's tightly coupled to event severity data already flowing there.
- All of the above gated behind `prefers-reduced-motion: reduce` → motion tokens collapse to instant/near-instant transitions, glow becomes static (no breathing), particles still move (that's core information, not decoration) but without the pulse/hover embellishments.

## 5. Palette: Harmonized

Same four category hue families (compute=blue, network=teal, storage=amber, messaging=purple per `CATEGORY_COLORS`), desaturated roughly 15-20% and balanced to closer perceived lightness so no one category visually dominates when several appear on the same diagram — concretely (dark mode): `compute #5B9CF6` (was `#4A9EFF`), `network #3FC7B8` (was `#2DD4BF`), `storage #E0A552` (was `#F5A623`), `messaging #9C8CE0` (was `#A78BFA`). Exact light-mode equivalents follow the same relative desaturation, computed during implementation against the AA-contrast requirement (§ Global Constraints) rather than hand-picked.

`grouping` (transparent bg) was originally assumed unaffected ("never in the loud set"), but its accent value is also used as a foreground/icon-stroke color on `BaseNode`/`GroupNode`, not only as a transparent-bg tint — so it needs its own WCAG-verified value like the other four categories, not an exemption. Dark mode: `#8391A5` (5.49:1 against the dark card surface, up from the original `#475569`'s 2.32:1, which failed AA). Light mode `foreground.light` stays `#475569` (7.58:1 against white — already passing, unaffected).

## 6. Derived Mechanical Details (spacing, icons, cursors)

- **Spacing scale:** standard 4px-based scale — `4 / 8 / 12 / 16 / 24 / 32` — as CSS custom properties (`--space-1` through `--space-6` or similar). Nothing shown in the visual review contradicts this; it's the de facto scale already loosely followed across existing CSS modules, this spec just makes it an explicit token set instead of ad hoc pixel values.
- **Icons:** keep `lucide-react` (already a dependency, clean line-icon set, pairs fine with both the Inter/Space Grotesk sans tier and the mono tier). Change: icons on node cards pick up a soft category-colored glow/halo consistent with §1's elevation treatment, rather than rendering as flat single-color glyphs.
- **Cursors:** the crosshair-during-simulation *bug* is already fixed (separate commit, this session). The remaining aesthetic question — Connect-mode's crosshair — is a legitimate, standard affordance for "click to wire two nodes" and is left as native `cursor: crosshair`; no custom cursor glyph is in scope for this spec (real cost/complexity for a small win — revisit only if it comes up again after the rest of this system ships).

---

## Testing / Verification Approach

No unit-testable surface here (this is CSS/token values and framer-motion configuration, not logic) — verification is the same Playwright-driven, running-app screenshot approach used for this session's earlier bug fixes: load a template, toggle light/dark, drive a simulation to see motion/glow live, and visually confirm against this spec's descriptions plus WCAG contrast checks (automatable via `axe-core` or a manual contrast-ratio check on the final hex pairs once chosen).

## Definition of Done

- [ ] `theme.ts` exports `DARK_COLORS`/`LIGHT_COLORS`, `CATEGORY_COLORS` (harmonized values), `FONT_DISPLAY`/`FONT_BODY`/`FONT_MONO`, spacing tokens, and motion duration/easing tokens.
- [ ] Theme mode toggle exists in the toolbar, persists across restarts, defaults to dark.
- [ ] Every color pairing meets WCAG AA in both modes.
- [ ] Space Grotesk + Inter self-hosted via `@fontsource`, no runtime CDN font fetch.
- [ ] Baseline idle motion (breathing glow, hover lift, particle styling) implemented and gated behind `prefers-reduced-motion`.
- [ ] `npm run build` passes; manual Playwright-driven verification in both theme modes, motion on and with `prefers-reduced-motion` simulated.
