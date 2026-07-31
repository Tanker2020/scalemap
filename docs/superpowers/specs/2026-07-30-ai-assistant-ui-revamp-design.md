# AI Assistant UI Revamp — Design

**Goal:** Turn the AI chat assistant from a fixed, full-screen, monotone modal into a floating,
draggable, resizable, non-modal window with real checkbox affordances for attachments,
category-colored accents, and an explicit token-cost disclosure.

**Context:** The assistant (`src/app/world/ai/`) currently renders as a `ConnectionsView`-style
full-screen modal: a `rgba(0,0,0,0.6)` backdrop, a centered `94vw × 90vh` fixed-size surface, and
attachment toggles that are plain `<button>` elements styled as pill chips — no checkbox
semantics, no visual "this is a toggle" affordance beyond a border-color change. Colors are
entirely the app's monotone surface/accent tokens (no per-attachment-kind color).

Three changes, driven by user feedback after trying the shipped v1:
1. Attachment toggles don't read as checkboxes.
2. The window can't be moved or resized — it locks over the whole screen.
3. The whole surface is monotone; it should be livelier.

## 1. Color scheme — reuse existing category accents, zero new hex

`src/app/world/ui/kit.tsx` already injects theme-aware CSS custom properties for exactly this
purpose — `--kit-cat-compute`, `--kit-cat-messaging`, `--kit-cat-network`, `--kit-cat-storage` —
swapping between `CATEGORY_COLORS.*.accent` (dark) and `CATEGORY_COLORS.*.foreground.light`
(light) via the same `:root[data-theme="light"]` override pattern the rest of the app's
theme-aware CSS uses. These are already consumed by `AiReviewSection.tsx`, `azFloorStyles.ts`,
`r3Styles.ts`, `timelineStyles.ts` — this is the established idiom, not a new one.

Mapping (fixed attachment kinds only — `entity` is handled separately below):

| Attachment kind | CSS var | Dark hex | Light hex |
|---|---|---|---|
| `events` | `var(--kit-cat-compute)` | `#5B9CF6` | `#3F6DAC` |
| `replay` | `var(--kit-cat-storage)` | `#E0A552` | `#916B35` |
| `findings` | `var(--kit-cat-messaging)` | `#9C8CE0` | `#6D629C` |
| `topology` | `var(--kit-cat-network)` | `#3FC7B8` | `#288177` |
| `entity` | `var(--color-accent)` | (theme's own accent token) | (theme's own accent token) |

`entity` is dynamic (whatever server the user is currently looking at, not a fixed content
category), so it uses the app's general accent token rather than being force-fit into one of the
four category hues — this also sidesteps needing a 5th `--kit-cat-*` var that doesn't exist today
and isn't used anywhere else.

Chip backgrounds use the same `color-mix(in srgb, <var> N%, transparent)` idiom `kit.tsx`'s own
`.kit-row:hover`/`.kit-pcard:hover` rules already use (e.g. `color-mix(in srgb,
var(--kit-cat-compute) 15%, transparent)`) — no new hex, no new CSS custom properties, nothing
added to `theme.ts`.

`AttachmentBar.tsx` imports nothing new from `theme.ts`; it just switches its per-chip inline
`border`/`background`/`color` from the current single `chip(active)` function to a small
`kind → cssVar` lookup table feeding the same `color-mix` pattern.

## 2. Checkbox affordance + explicit token-cost disclosure

Each attachment toggle becomes a real `<input type="checkbox">` (visually hidden, not
`display:none` — kept focusable/screen-reader-operable) paired with a styled `<span>` indicator
box that fills with the category color and shows a checkmark when checked, inside the existing
capsule-chip shape. This is the standard "visually-restyled native checkbox" pattern — genuinely
operable via keyboard/Tab and correctly announced by assistive tech, not just a `<button>` with a
checkbox glyph.

A persistent one-line caption sits above the chip row (not just implied by the per-chip token
counts):

> Checked items below are sent to the model with every message — more context, more tokens.

The existing per-chip `~Ntok` label and the running "N tokens total" line are unchanged in
substance, just recolored to match their chip's category instead of only turning amber past the
12k warning threshold (the amber warning at >12k stays — it now layers on top of, not replaces,
the per-kind coloring).

## 3. Floating, non-modal, draggable, resizable window

**Non-modal:** the `rgba(0,0,0,0.6)` backdrop `<div>` is removed entirely. The window renders via
`createPortal(..., document.body)` as before, but as a plain `position: fixed` box with no
full-viewport wrapper — clicks on the globe/region/AZ/server views and other panels behind it
work normally while it's open. There is no "click outside to close" anymore (nothing to click
outside of); Escape still closes it via the existing capture-phase listener, unchanged.

**Drag:** the header bar (`<span>AI Assistant</span>` + settings/close buttons) is the drag
handle. `onPointerDown` on the header (excluding clicks that land on the settings/close
`<button>`s themselves) starts a drag; `pointermove`/`pointerup` on `window` update position and
end the drag. Hand-rolled with plain pointer events — no new dependency, consistent with this
feature's established "no new libraries" pattern (`formatResponse.ts`'s hand-rolled markdown
parser was the precedent-setting choice here).

**Resize:** a single bottom-right corner handle (matching the approved mockup), same pointer-event
mechanism, adjusting `width`/`height` from that corner.

**Bounds:**
- Minimum size: `380×320` — small enough to feel like a real floating tool window, large enough
  that the composer and attachment row don't get clipped.
- Position is clamped so the header stays at least partially on-screen (can't drag it fully off
  any edge and lose it) — clamp `x`/`y` so at least, say, 40px of the header remains within the
  viewport on every edge.
- No explicit maximum size beyond the viewport itself (resizing past the visible screen is simply
  clamped to viewport bounds each frame, same clamp math as the position clamp).

**Persistence:** position and size live in `chat.store.ts` as one `windowRect: { x: number; y:
number; width: number; height: number } | null` field (`null` = "never customized, use the
computed default"), with one `setWindowRect` setter — matching the store's existing flat,
synchronous, no-middleware style. This persists for the session (survives close/reopen, matching
how `turns`/`selected` already behave) and is never written to disk, `.scalemap`, or `localStorage`
— same in-memory-only guarantee as the rest of `chat.store.ts`.

**Default (first-ever-open) position/size:** `720×600`, centered in the current viewport
(`(innerWidth - 720) / 2`, `(innerHeight - 600) / 2`), computed once at first open rather than
hardcoded — so it looks reasonable regardless of window size — and then written into
`windowRect` so subsequent opens reuse exactly where the user left it.

## What does NOT change

- `chat.store.ts`'s generation-counter guard, `sendChatTurn.ts`, `ChatComposer.tsx`,
  `ChatTranscript.tsx`, `ResponseBlocks.tsx`, `EntityChip.tsx`, and every `src/lib/aiChat/**` file
  are untouched — this is a presentation-layer change to `AssistantView.tsx` and
  `AttachmentBar.tsx` plus one new field in `chat.store.ts`.
- The read-only guarantee, the fresh-per-send `loadLlmSettings()` call, and the no-`<fieldset
  disabled={running}>` decision all carry over unchanged.
- Escape-closes-and-abandons-in-flight-turn behavior is unchanged.

## Testing

- `AssistantView.test.tsx`: no existing test asserts the backdrop's presence or exact
  surface/backdrop styles, so removing the backdrop shouldn't break the 5 existing cases. New
  cases: dragging the header updates `windowRect`; resizing from the corner handle updates
  `windowRect.width`/`height` and respects the `380×320` floor; position/size survive a
  close→reopen cycle within the same session (store field persists); a drag that would take the
  header fully off-screen is clamped.
- `AttachmentBar.test.tsx` (new, doesn't exist today — will need creating): each checkbox is a
  real `<input type="checkbox">` with correct `checked`/`aria` state; clicking the label toggles
  it; the token-disclosure caption is present; per-kind coloring maps to the right CSS var.
- `chat.store.test.ts`: `setWindowRect` updates the field; default is `null` until first set.

## Open questions resolved during brainstorming

- Color direction: Option A (category accents) over a single bold gradient or full multi-hue —
  see the approved mockup at `.superpowers/brainstorm/4266-1785445268/content/color-style.html`
  (gitignored brainstorm scratch, not committed — the mapping table in section 1 above is the
  durable record).
- Modal vs. floating: floating/non-modal, confirmed.
- Position/size persistence: session-persisted (not reset every open), confirmed.
