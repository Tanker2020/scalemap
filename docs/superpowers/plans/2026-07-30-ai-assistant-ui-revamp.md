# AI Assistant UI Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the AI chat assistant from a fixed, full-screen, monotone modal into a floating,
draggable, resizable, non-modal window with real checkbox affordances for attachments,
category-colored accents, and an explicit token-cost disclosure.

**Architecture:** Three isolated changes on top of the existing `src/app/world/ai/` feature: (1)
one new persisted-for-the-session field in `chat.store.ts` for window position/size, (2)
`AttachmentBar.tsx`'s chips become real `<input type="checkbox">` elements tinted with the app's
existing `kit.tsx` category-color CSS variables, (3) `AssistantView.tsx` drops its backdrop and
gains hand-rolled pointer-event drag (header) and resize (corner handle).

**Tech Stack:** React 19, Zustand (no middleware), plain pointer events (no new dependency),
existing `kit.tsx` theme-aware CSS custom properties.

## Global Constraints

- No new npm dependency — drag/resize is hand-rolled with plain `PointerEvent` handlers, matching
  this feature's established pattern (`formatResponse.ts`'s hand-rolled markdown parser was the
  precedent for avoiding new libraries).
- No new hex color values anywhere. Category colors come from `src/app/world/ui/kit.tsx`'s
  already-injected, already-theme-aware CSS vars: `--kit-cat-compute`, `--kit-cat-storage`,
  `--kit-cat-messaging`, `--kit-cat-network`. The `entity` attachment uses `var(--color-accent)`
  instead of a category hue (it's a dynamic "whatever you're looking at" attachment, not a fixed
  content category — see design spec §1).
- `chat.store.ts`'s window position/size persists for the session (survives close/reopen) but is
  never written to disk, `.scalemap`, or `localStorage` — same in-memory-only guarantee as the
  rest of the store.
- The window has no backdrop and is non-modal: clicking the globe/region/AZ/server views or other
  panels behind it must work normally while it's open. There is no click-outside-to-close.
  Escape-closes-and-abandons-in-flight-turn behavior is unchanged.
- Minimum window size: `380×320`. Default (first-ever-open) size: `720×600`, centered in the
  current viewport. Dragging is clamped so at least `40px` of the window stays reachable on every
  edge (see Task 3 for exact clamp math).
- Read-only guarantee, fresh-per-send `loadLlmSettings()`, and the no-`<fieldset
  disabled={running}>` decision all carry over unchanged — this plan touches presentation only.
- Design spec (read for full rationale, mockup reference, and rejected alternatives):
  `docs/superpowers/specs/2026-07-30-ai-assistant-ui-revamp-design.md`

---

## Task 1: `windowRect` state in `chat.store.ts`

**Files:**
- Modify: `src/app/store/chat.store.ts`
- Modify: `src/app/store/chat.store.test.ts`

**Interfaces:**
- Produces (consumed by Task 3's `AssistantView.tsx`):
  ```ts
  export interface WindowRect { x: number; y: number; width: number; height: number }
  ```
  New `ChatStore` fields: `windowRect: WindowRect | null` (default `null` — "never customized, use
  the computed default"), `setWindowRect: (rect: WindowRect) => void`.

Current file state (verified, `src/app/store/chat.store.ts`): the `ChatStore` interface (lines
16-30) and its `create<ChatStore>((set, get) => ({...}))` body (lines 34-87) are exactly as shown
below in context — this task only adds to both, it does not restructure anything.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/store/chat.store.test.ts` (inside the existing `describe('chat.store', ...)`
block, after the last `it(...)`):

```ts
  it('windowRect defaults to null', () => {
    expect(useChatStore.getState().windowRect).toBeNull()
  })

  it('setWindowRect updates the field', () => {
    useChatStore.getState().setWindowRect({ x: 10, y: 20, width: 500, height: 400 })
    expect(useChatStore.getState().windowRect).toEqual({ x: 10, y: 20, width: 500, height: 400 })
  })

  it('setWindowRect replaces the previous rect wholesale', () => {
    useChatStore.getState().setWindowRect({ x: 10, y: 20, width: 500, height: 400 })
    useChatStore.getState().setWindowRect({ x: 0, y: 0, width: 720, height: 600 })
    expect(useChatStore.getState().windowRect).toEqual({ x: 0, y: 0, width: 720, height: 600 })
  })
```

Also add `windowRect: null` to the existing `beforeEach`'s `useChatStore.setState({...})` call
(line 5) so each test starts from a clean slate:

```ts
beforeEach(() => {
  useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null, windowRect: null })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/store/chat.store.test.ts`
Expected: FAIL — `windowRect`/`setWindowRect` do not exist on the store yet.

- [ ] **Step 3: Implement the store changes**

In `src/app/store/chat.store.ts`, add the exported type near the top (after the `ChatTurn`
interface, before `interface ChatStore`):

```ts
export interface WindowRect { x: number; y: number; width: number; height: number }
```

Add two fields to the `ChatStore` interface:

```ts
interface ChatStore {
  turns: ChatTurn[]
  draft: string
  selected: Attachment[]
  requestGen: number
  inFlightTurnId: string | null
  windowRect: WindowRect | null
  setDraft: (d: string) => void
  toggleAttachment: (a: Attachment) => void
  clearAttachments: () => void
  clearTranscript: () => void
  setWindowRect: (rect: WindowRect) => void
  beginTurn: (question: string, attachments: Attachment[], contextTokens: number, worldChangedSincePrev: boolean) => { turnId: string; gen: number }
  resolveTurn: (turnId: string, gen: number, answer: string) => void
  failTurn: (turnId: string, gen: number, message: string) => void
  abandonInFlight: () => void
}
```

Add the initial value and setter inside `create<ChatStore>((set, get) => ({ ... }))`, right after
`inFlightTurnId: null,` and right after `setDraft: (d) => set({ draft: d }),` respectively:

```ts
  inFlightTurnId: null,
  windowRect: null,
```

```ts
  setDraft: (d) => set({ draft: d }),

  setWindowRect: (rect) => set({ windowRect: rect }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/store/chat.store.test.ts`
Expected: PASS (10 tests — 7 existing + 3 new)

- [ ] **Step 5: Run the whole suite and `tsc`, then commit**

Run: `npx vitest run` then `npx tsc --noEmit -p .`
Expected: both clean.

```bash
git add src/app/store/chat.store.ts src/app/store/chat.store.test.ts
git commit -m "feat: add session-persisted window position/size to chat.store"
```

---

## Task 2: Real checkboxes + category colors + token-cost caption in `AttachmentBar.tsx`

**Files:**
- Modify: `src/app/world/ai/AttachmentBar.tsx`
- Create: `src/app/world/ai/AttachmentBar.test.tsx`

**Interfaces:**
- Consumes: Task 1's `windowRect`/`setWindowRect` are NOT used here (this task is independent of
  Task 1 — order between Task 1 and Task 2 doesn't matter, only Task 3 depends on Task 1). Consumes
  the existing `src/app/world/ui/kit.tsx` (for its side-effect CSS-var injection — no named export
  needed) and the existing `src/lib/aiChat/context.ts` (`attachmentPreview`, `attachmentKey`,
  `Attachment`, `ChatContextInput` — all unchanged).
- Produces: no new exports beyond the existing `AttachmentBar` component — its props (`{
  contextInput: ChatContextInput; running: boolean }`) are unchanged, so Task 3 doesn't need any
  changes at its call site for this task alone.

Current file state (verified, full contents of `src/app/world/ai/AttachmentBar.tsx`):

```tsx
// Opt-in attachment toggles (events/replay/findings/topology, plus the currently-selected server
// as an `entity` attachment) shown with a live token-cost preview per chip and a running total —
// context.ts's attachmentPreview/estimateTokens do the actual sizing, this is presentation only.
import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import { useChatStore } from '../../store/chat.store'
import { attachmentPreview, attachmentKey, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
import { useUiStore } from '../../store/ui.store'

const chip = (active: boolean): CSSProperties => ({
  font: '10px var(--font-mono)', padding: '2px 6px', borderRadius: 4, marginRight: 4,
  border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-node-border)'}`,
  background: active ? 'var(--color-surface-hover)' : 'transparent',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  cursor: 'pointer',
})

export function AttachmentBar({ contextInput, running }: { contextInput: ChatContextInput; running: boolean }) {
  const selected = useChatStore(s => s.selected)
  const toggle = useChatStore(s => s.toggleAttachment)
  const selectedServerId = useUiStore(s => s.selectedServerId)

  const options = useMemo<Attachment[]>(() => {
    const base: Attachment[] = [{ kind: 'events' }, { kind: 'replay' }, { kind: 'findings' }, { kind: 'topology' }]
    const entityAttachment: Attachment | null = selectedServerId ? { kind: 'entity', id: selectedServerId } : null
    return entityAttachment ? [...base, entityAttachment] : base
  }, [selectedServerId])

  const previews = useMemo(
    () => new Map(options.map(a => [attachmentKey(a), attachmentPreview(a, contextInput)])),
    [options, contextInput],
  )

  const isSelected = (a: Attachment) => selected.some(s => attachmentKey(s) === attachmentKey(a))
  const totalTokens = selected.reduce((sum, a) => sum + (previews.get(attachmentKey(a))?.tokens ?? attachmentPreview(a, contextInput).tokens), 0)

  return (
    <div style={{ padding: '4px 8px', borderTop: '1px solid var(--color-node-border)' }}>
      {options.map(a => {
        const preview = previews.get(attachmentKey(a))!
        return (
          <button key={attachmentKey(a)} style={chip(isSelected(a))} onClick={() => toggle(a)} title={`~${preview.tokens} tokens`}>
            {preview.label} · ~{preview.tokens}tok
          </button>
        )
      })}
      <span style={{ font: '10px var(--font-mono)', color: totalTokens > 12000 ? 'var(--color-warning)' : 'var(--color-text-muted)', marginLeft: 8 }}>
        {totalTokens} tokens total
      </span>
      {running && (
        <div style={{ font: '10px var(--font-mono)', color: 'var(--color-warning)', marginTop: 4 }}>
          Ending the run clears its metrics window — attach events/replay before stopping if you want them referenced.
        </div>
      )}
    </div>
  )
}
```

`src/app/world/ui/kit.tsx` already injects theme-aware `--kit-cat-compute` / `--kit-cat-storage` /
`--kit-cat-messaging` / `--kit-cat-network` CSS custom properties into `:root` on module load (see
`kit.tsx` lines 20-48) — this is the SAME idiom `AiReviewSection.tsx`/`azFloorStyles.ts`/
`r3Styles.ts`/`timelineStyles.ts` already consume. `Attachment['kind']` (from
`src/lib/aiChat/context.ts`) is the union `'events' | 'replay' | 'findings' | 'topology' |
'traces' | 'entity'`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/app/world/ai/AttachmentBar.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AttachmentBar } from './AttachmentBar'
import { useChatStore } from '../../store/chat.store'
import { useUiStore } from '../../store/ui.store'
import type { ChatContextInput } from '../../../lib/aiChat/context'

function baseContextInput(): ChatContextInput {
  return {
    doc: {
      routing: { policy: 'latency', dnsTtlSec: 30, healthCheckIntervalMs: 10000, healthCheckFailureThreshold: 3 },
      regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {}, populations: {},
    } as never,
    compiled: { instances: {}, paths: [], findings: [], routing: {} } as never,
    findings: [], compileFindings: [], latestBatch: null, events: [], replayFrames: [],
  }
}

beforeEach(() => {
  useChatStore.setState({ selected: [] })
  useUiStore.setState({ selectedServerId: null } as never)
})

describe('AttachmentBar', () => {
  it('renders the token-cost disclosure caption', () => {
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    expect(screen.getByText(/sent to the model with every message/i)).toBeTruthy()
  })

  it('renders each attachment as a real, unchecked checkbox input by default', () => {
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.length).toBe(4) // events, replay, findings, topology (no selected server, so no entity chip)
    expect(boxes.every(b => b.checked === false)).toBe(true)
  })

  it('clicking a checkbox label toggles the store selection', () => {
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    const eventsBox = screen.getAllByRole('checkbox')[0] as HTMLInputElement
    fireEvent.click(eventsBox)
    expect(useChatStore.getState().selected).toEqual([{ kind: 'events' }])
    fireEvent.click(eventsBox)
    expect(useChatStore.getState().selected).toEqual([])
  })

  it('reflects store selection as checked', () => {
    useChatStore.setState({ selected: [{ kind: 'replay' }] })
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    const replayBox = boxes.find(b => b.id.includes('replay'))!
    expect(replayBox.checked).toBe(true)
  })

  it('shows an entity checkbox when a server is selected', () => {
    useUiStore.setState({ selectedServerId: 'srv-1' } as never)
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    expect(screen.getAllByRole('checkbox').length).toBe(5)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/world/ai/AttachmentBar.test.tsx`
Expected: FAIL — no `role="checkbox"` elements exist yet (current chips are `<button>`s), no
disclosure caption text exists yet.

- [ ] **Step 3: Rewrite `AttachmentBar.tsx`**

```tsx
// src/app/world/ai/AttachmentBar.tsx
// Opt-in attachment toggles (events/replay/findings/topology, plus the currently-selected server
// as an `entity` attachment), each a real <input type="checkbox"> (keyboard/screen-reader
// operable, not a button styled to look like one) with a live token-cost preview and a running
// total — context.ts's attachmentPreview/estimateTokens do the actual sizing, this file is
// presentation only. Each kind is tinted with kit.tsx's existing theme-aware --kit-cat-* category
// vars (already used by AiReviewSection.tsx/azFloorStyles.ts/r3Styles.ts/timelineStyles.ts) — no
// new colors are defined anywhere for this. `entity` uses --color-accent instead of a category
// hue since it's a dynamic "whatever you're looking at" attachment, not a fixed content category.
import type { CSSProperties } from 'react'
import { useMemo } from 'react'
import '../ui/kit' // side-effect import: guarantees kit.tsx's --kit-cat-* CSS vars are injected
import { useChatStore } from '../../store/chat.store'
import { attachmentPreview, attachmentKey, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
import { useUiStore } from '../../store/ui.store'

const CATEGORY_VAR: Record<Attachment['kind'], string> = {
  events: '--kit-cat-compute',
  replay: '--kit-cat-storage',
  findings: '--kit-cat-messaging',
  topology: '--kit-cat-network',
  traces: '--kit-cat-network',
  entity: '--color-accent',
}

function chipStyle(active: boolean, colorVar: string): CSSProperties {
  const color = `var(${colorVar})`
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
    font: '10px var(--font-mono)', padding: '3px 8px 3px 6px', borderRadius: 5, marginRight: 4,
    border: `1px solid ${active ? color : 'var(--color-node-border)'}`,
    background: active ? `color-mix(in srgb, ${color} 15%, transparent)` : 'transparent',
    color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  }
}

function boxStyle(active: boolean, colorVar: string): CSSProperties {
  const color = `var(${colorVar})`
  return {
    width: 12, height: 12, borderRadius: 3, flexShrink: 0, lineHeight: 1, fontSize: 9, fontWeight: 900,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: `1.5px solid ${active ? color : 'var(--color-text-muted)'}`,
    background: active ? color : 'transparent',
    color: active ? 'var(--color-on-accent)' : 'transparent',
  }
}

// Standard "clip" sr-only technique — NOT display:none, which would remove the input from the
// tab order and break keyboard/screen-reader operability. The visible checkmark is the boxStyle
// span above; this input is what makes the whole thing a REAL checkbox.
const srOnly: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
}

export function AttachmentBar({ contextInput, running }: { contextInput: ChatContextInput; running: boolean }) {
  const selected = useChatStore(s => s.selected)
  const toggle = useChatStore(s => s.toggleAttachment)
  const selectedServerId = useUiStore(s => s.selectedServerId)

  const options = useMemo<Attachment[]>(() => {
    const base: Attachment[] = [{ kind: 'events' }, { kind: 'replay' }, { kind: 'findings' }, { kind: 'topology' }]
    const entityAttachment: Attachment | null = selectedServerId ? { kind: 'entity', id: selectedServerId } : null
    return entityAttachment ? [...base, entityAttachment] : base
  }, [selectedServerId])

  const previews = useMemo(
    () => new Map(options.map(a => [attachmentKey(a), attachmentPreview(a, contextInput)])),
    [options, contextInput],
  )

  const isSelected = (a: Attachment) => selected.some(s => attachmentKey(s) === attachmentKey(a))
  const totalTokens = selected.reduce((sum, a) => sum + (previews.get(attachmentKey(a))?.tokens ?? attachmentPreview(a, contextInput).tokens), 0)

  return (
    <div style={{ padding: '4px 8px', borderTop: '1px solid var(--color-node-border)' }}>
      <div style={{ font: '10px var(--font-mono)', color: 'var(--color-text-muted)', marginBottom: 4 }}>
        Checked items below are sent to the model with every message — more context, more tokens.
      </div>
      {options.map(a => {
        const preview = previews.get(attachmentKey(a))!
        const active = isSelected(a)
        const colorVar = CATEGORY_VAR[a.kind]
        const inputId = `chat-attachment-${attachmentKey(a)}`
        return (
          <label key={attachmentKey(a)} htmlFor={inputId} style={chipStyle(active, colorVar)} title={`~${preview.tokens} tokens`}>
            <input id={inputId} type="checkbox" checked={active} onChange={() => toggle(a)} style={srOnly} />
            <span style={boxStyle(active, colorVar)} aria-hidden="true">{active ? '✓' : ''}</span>
            <span>{preview.label} · ~{preview.tokens}tok</span>
          </label>
        )
      })}
      <span style={{ font: '10px var(--font-mono)', color: totalTokens > 12000 ? 'var(--color-warning)' : 'var(--color-text-muted)', marginLeft: 8 }}>
        {totalTokens} tokens total
      </span>
      {running && (
        <div style={{ font: '10px var(--font-mono)', color: 'var(--color-warning)', marginTop: 4 }}>
          Ending the run clears its metrics window — attach events/replay before stopping if you want them referenced.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/world/ai/AttachmentBar.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the whole suite and `tsc`, then commit**

Run: `npx vitest run` then `npx tsc --noEmit -p .`
Expected: both clean. (`AssistantView.test.tsx`'s existing tests render `AttachmentBar` as a
child and don't assert on its internal markup, so they should be unaffected — confirm this in the
full run.)

```bash
git add src/app/world/ai/AttachmentBar.tsx src/app/world/ai/AttachmentBar.test.tsx
git commit -m "feat: real checkbox inputs + category-colored attachment chips + token-cost caption"
```

---

## Task 3: Floating, draggable, resizable, non-modal window in `AssistantView.tsx`

**Files:**
- Modify: `src/app/world/ai/AssistantView.tsx`
- Modify: `src/app/world/ai/AssistantView.test.tsx`

**Interfaces:**
- Consumes: Task 1's `WindowRect`/`windowRect`/`setWindowRect` from `chat.store.ts`.
- Produces: `AssistantView`'s own props (`{ open, onClose, openSettings }`) are UNCHANGED — Task
  12 of the original feature plan already wires it into `WorldShell.tsx`; nothing there needs to
  change.

Current file state (verified, full contents of `src/app/world/ai/AssistantView.tsx` as of this
plan's Global Constraints section) is exactly the version shown in Task 1/Task 2's "current file
state" context above this plan — re-read the file at implementation time to confirm it still
matches (Tasks 1 and 2 don't touch it, so it should).

- [ ] **Step 1: Write the failing tests**

Add to `src/app/world/ai/AssistantView.test.tsx`, inside the existing `describe('AssistantView',
...)` block, after the last existing `it(...)` (the "sending a new question..." test):

```tsx
  it('dragging the header moves the window by the drag delta', async () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const header = screen.getByText('AI Assistant').closest('div') as HTMLElement
    // windowRect starts null (beforeEach), so the rendered position comes from the computed
    // default — read it off the DOM rather than the store so this test doesn't depend on
    // jsdom's exact viewport dimensions or assume windowRect is already set.
    const surface = header.parentElement as HTMLElement
    const startLeft = parseFloat(surface.style.left)
    const startTop = parseFloat(surface.style.top)

    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 150, clientY: 130 })
    fireEvent.pointerUp(window)

    const rect = useChatStore.getState().windowRect
    expect(rect).not.toBeNull()
    expect(rect!.x).toBe(startLeft + 50)
    expect(rect!.y).toBe(startTop + 30)
  })

  it('clicking a header button does not start a drag', () => {
    const onClose = vi.fn()
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    const closeBtn = screen.getByText('close')
    fireEvent.pointerDown(closeBtn, { clientX: 200, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 })
    fireEvent.pointerUp(window)
    // windowRect should still be unset (or unchanged) — the drag never engaged for a button target.
    expect(useChatStore.getState().windowRect).toBeNull()
  })

  it('resizing from the corner handle updates stored width/height and respects the minimum size', async () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const handle = screen.getByRole('button', { name: 'resize' })
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 500 })
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 }) // drag far up-left — should clamp to the floor
    fireEvent.pointerUp(window)
    const rect = useChatStore.getState().windowRect!
    expect(rect.width).toBe(380)
    expect(rect.height).toBe(320)
  })

  it('position/size survive a close-then-reopen cycle within the same session', async () => {
    const { rerender } = render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const header = screen.getByText('AI Assistant').closest('div') as HTMLElement
    fireEvent.pointerDown(header, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 20 })
    fireEvent.pointerUp(window)
    const rectAfterDrag = useChatStore.getState().windowRect

    rerender(<AssistantView open={false} onClose={() => {}} openSettings={() => {}} />)
    rerender(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)

    expect(useChatStore.getState().windowRect).toEqual(rectAfterDrag)
  })
```

Also add `import { fireEvent } from '@testing-library/react'`'s existing import already covers
`fireEvent` (it's already imported at the top of this file) — no new import needed there. Add
`windowRect: null` to the file's existing `beforeEach`'s `useChatStore.setState({...})` call.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/world/ai/AssistantView.test.tsx`
Expected: FAIL — no drag/resize handlers exist yet, no element with `aria-label="resize"` exists.

- [ ] **Step 3: Rewrite `AssistantView.tsx`**

```tsx
// src/app/world/ai/AssistantView.tsx
// The read-only AI chat assistant overlay — a floating, non-modal window (hand-rolled drag via
// the header + resize via the corner handle, no new dependency). Builds a fresh ChatContextInput
// from the live doc/compiled/simulation state on every render and hands it to sendChatTurn.ts,
// which owns the actual request lifecycle via chat.store.ts. Position/size persist for the
// session in chat.store.ts's windowRect field (in-memory only, dies on app restart).
import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useChatStore, type WindowRect } from '../../store/chat.store'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { useCompiledWorld } from '../useCompiledWorld'
import { runAnalysis } from '../../../lib/analysis/runAnalysis'
import { loadLlmSettings } from '../../../lib/tauri'
import { sendChatTurn } from './sendChatTurn'
import { ChatComposer } from './ChatComposer'
import { ChatTranscript } from './ChatTranscript'
import { AttachmentBar } from './AttachmentBar'
import type { ChatTurn } from '../../store/chat.store'
import type { ChatContextInput } from '../../../lib/aiChat/context'

const WINDOW_MIN_WIDTH = 380
const WINDOW_MIN_HEIGHT = 320
const WINDOW_DEFAULT_WIDTH = 720
const WINDOW_DEFAULT_HEIGHT = 600
// Minimum px of the window that must stay reachable on every edge after a drag — prevents
// dragging the header fully off-screen and losing the window with no way to grab it back.
const EDGE_MARGIN = 40

function clampRect(rect: WindowRect): WindowRect {
  const width = Math.max(WINDOW_MIN_WIDTH, Math.min(rect.width, window.innerWidth))
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.min(rect.height, window.innerHeight))
  const minX = EDGE_MARGIN - width
  const maxX = window.innerWidth - EDGE_MARGIN
  const minY = 0
  const maxY = Math.max(0, window.innerHeight - EDGE_MARGIN)
  const x = Math.max(minX, Math.min(rect.x, maxX))
  const y = Math.max(minY, Math.min(rect.y, maxY))
  return { x, y, width, height }
}

const headerStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 12px', borderBottom: '1px solid var(--color-node-border)',
  cursor: 'grab', userSelect: 'none', flexShrink: 0,
}

export function AssistantView({ open, onClose, openSettings }: {
  open: boolean; onClose: () => void; openSettings: () => void
}) {
  const doc = useWorldStore(s => s.doc)
  const compiled = useCompiledWorld()
  const events = useSimulationStore(s => s.events)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const batchSimMs = latestBatch?.simMs ?? null
  const replayFrames = useMemo(() => useSimulationStore.getState().getReplayFrames(), [batchSimMs])
  const reducedMotion = useReducedMotion() ?? false

  const storedRect = useChatStore(s => s.windowRect)
  const setWindowRect = useChatStore(s => s.setWindowRect)
  // Computed once per mount from the viewport size at that time — only matters until the user's
  // first drag/resize, after which storedRect always wins.
  const defaultRect = useMemo<WindowRect>(() => ({
    width: WINDOW_DEFAULT_WIDTH, height: WINDOW_DEFAULT_HEIGHT,
    x: Math.max(0, (window.innerWidth - WINDOW_DEFAULT_WIDTH) / 2),
    y: Math.max(0, (window.innerHeight - WINDOW_DEFAULT_HEIGHT) / 2),
  }), [])
  // Ephemeral, only set while a drag/resize is actively in progress — lets the window visually
  // track the pointer without writing to the store on every pointermove. Committed to the store
  // once, on pointerup.
  const [liveRect, setLiveRect] = useState<WindowRect | null>(null)
  const liveRectRef = useRef<WindowRect | null>(null)
  const dragState = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; startRect: WindowRect } | null>(null)
  const rect = liveRect ?? storedRect ?? defaultRect

  const onDragMove = useCallback((e: PointerEvent) => {
    const ds = dragState.current
    if (!ds) return
    const dx = e.clientX - ds.startX
    const dy = e.clientY - ds.startY
    const next = clampRect(ds.mode === 'move'
      ? { ...ds.startRect, x: ds.startRect.x + dx, y: ds.startRect.y + dy }
      : { ...ds.startRect, width: ds.startRect.width + dx, height: ds.startRect.height + dy })
    liveRectRef.current = next
    setLiveRect(next)
  }, [])

  const onDragEnd = useCallback(() => {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    if (liveRectRef.current) setWindowRect(liveRectRef.current)
    dragState.current = null
    liveRectRef.current = null
    setLiveRect(null)
  }, [onDragMove, setWindowRect])

  const beginDrag = useCallback((e: ReactPointerEvent<HTMLElement>, mode: 'move' | 'resize') => {
    if (mode === 'move' && (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    dragState.current = { mode, startX: e.clientX, startY: e.clientY, startRect: rect }
    liveRectRef.current = rect
    setLiveRect(rect)
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
  }, [rect, onDragMove, onDragEnd])

  // Closing the overlay abandons any turn still in flight — otherwise a late resolve/fail from
  // a question the user has already walked away from would silently land in the transcript (or
  // mutate inFlightTurnId) the next time the overlay reopens. abandonInFlight() bumps
  // chat.store.ts's requestGen, which makes resolveTurn/failTurn's gen check a no-op for that
  // turn (see sendChatTurn.ts).
  const handleClose = useCallback(() => {
    if (useChatStore.getState().inFlightTurnId) useChatStore.getState().abandonInFlight()
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation(); e.preventDefault()
      handleClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, handleClose])

  // Memoized so a metrics tick (latestBatch/events churn roughly once a second while a sim runs)
  // doesn't force a full runAnalysis() pass + rebuild the whole ChatContextInput on every render —
  // real jank risk on larger worlds, and the whole point of NOT gating this overlay behind
  // `disabled={running}` is that it has to stay responsive mid-run.
  const contextInput: ChatContextInput = useMemo(() => ({
    doc, compiled,
    findings: runAnalysis(doc, compiled, latestBatch ?? null),
    compileFindings: compiled.findings,
    latestBatch: latestBatch ?? null,
    events,
    replayFrames,
  }), [doc, compiled, latestBatch, events, replayFrames])

  const send = useCallback(async (question: string) => {
    // Loaded fresh on every send, NOT cached — matching AiReviewSection.tsx's own
    // `await loadLlmSettings()`-per-request convention.
    const settings = await loadLlmSettings()
    const selected = useChatStore.getState().selected
    if (useChatStore.getState().inFlightTurnId) useChatStore.getState().abandonInFlight()
    await sendChatTurn(settings, question, selected, contextInput)
  }, [contextInput])

  const retry = useCallback((turn: ChatTurn) => { void send(turn.question) }, [send])

  if (!open) return null

  const surfaceStyle: CSSProperties = {
    position: 'fixed', left: rect.x, top: rect.y, width: rect.width, height: rect.height,
    background: 'var(--color-surface)', border: '1px solid var(--color-node-border)', borderRadius: 8,
    display: 'flex', flexDirection: 'column',
    font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
    zIndex: 1000, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  }
  const resizeHandleStyle: CSSProperties = {
    position: 'absolute', bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize',
    background: `linear-gradient(135deg, transparent 0%, transparent 40%, var(--color-node-border) 40%,
      var(--color-node-border) 45%, transparent 45%, transparent 65%, var(--color-node-border) 65%,
      var(--color-node-border) 70%, transparent 70%, transparent 90%, var(--color-node-border) 90%,
      var(--color-node-border) 95%, transparent 95%)`,
  }

  // Deliberately NO backdrop <div> — this window is floating/non-modal (design spec §3): clicks
  // on the globe/region/AZ/server views and other panels behind it work normally while it's open.
  // There is no click-outside-to-close; Escape (handled above) is the only dismiss affordance
  // besides the "close" button.
  return createPortal(
    <div style={surfaceStyle} onClick={e => e.stopPropagation()}>
      <div style={headerStyle} onPointerDown={e => beginDrag(e, 'move')}>
        <span>AI Assistant</span>
        <div>
          <button onClick={openSettings} style={{ marginRight: 8 }}>settings</button>
          <button onClick={handleClose}>close</button>
        </div>
      </div>
      <AttachmentBar contextInput={contextInput} running={running} />
      <ChatTranscript doc={doc} compiled={compiled} onNavigated={handleClose} onRetry={retry} reducedMotion={reducedMotion} />
      {/*
        Deliberately NO <fieldset disabled={running}> wrapping the body below — unlike every
        other portal surface in the app (see WorldPanel.tsx's `disabled={running && tab !==
        'events'}`). This overlay is a read-only advisor that never mutates the world, and
        "what just went wrong" is inherently a mid-run question — mirroring WorldPanel's own
        Events-tab exemption. Do not paste a fieldset back in when copying this file's recipe.
      */}
      <ChatComposer onSend={send} disabled={false} />
      <div
        role="button"
        aria-label="resize"
        tabIndex={-1}
        style={resizeHandleStyle}
        onPointerDown={e => beginDrag(e, 'resize')}
      />
    </div>,
    document.body,
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/app/world/ai/AssistantView.test.tsx`
Expected: PASS (9 tests — 5 existing + 4 new)

- [ ] **Step 5: Run the whole suite and `tsc`, then commit**

Run: `npx vitest run` then `npx tsc --noEmit -p .`
Expected: both clean.

```bash
git add src/app/world/ai/AssistantView.tsx src/app/world/ai/AssistantView.test.tsx
git commit -m "feat: floating, draggable, resizable, non-modal AI assistant window"
```

- [ ] **Step 6: Manual verification**

Run `npm run tauri dev`, open the assistant, and confirm: dragging the header moves the window;
resizing from the bottom-right corner works and won't shrink below a usable size; the world/globe
behind the window is clickable while the assistant is open; closing and reopening the assistant
keeps it where you left it; clicking "settings"/"close" in the header does NOT start a drag;
Escape still closes it; toggling attachment checkboxes still works and reads clearly as
checkboxes now; the token-cost caption is visible; colors differ per attachment kind and switch
correctly between dark/light theme.

---

## Verification Summary

After Task 3: `npx vitest run` full suite green, `npx tsc --noEmit -p .` clean, `npm run build`
clean, manual pass in `npm run tauri dev` per Task 3 Step 6.
