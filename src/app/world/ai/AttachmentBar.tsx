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
    // The sr-only checkbox input inside this label is `position: absolute` — without this, it
    // resolves against the nearest positioned ancestor, which (with the window now floating via
    // AssistantView's `position: fixed` surface) is that surface itself, physically placing the
    // invisible-but-focusable input at the window's top-left corner instead of inside its own
    // chip. `relative` here makes it resolve against the chip, where it belongs.
    position: 'relative',
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

  // `options` (which servers/entity is attachable) only changes when the selected server changes,
  // but the previews inside it — attachmentPreview() for 'topology' does a full
  // JSON.stringify(contextInput.doc) — must be recomputed whenever contextInput itself changes
  // (a new doc/compiled/batch). Memoizing both keeps this from re-stringifying the whole world on
  // every ~1s metrics tick while the assistant stays open mid-run.
  const options = useMemo<Attachment[]>(() => {
    const base: Attachment[] = [{ kind: 'events' }, { kind: 'replay' }, { kind: 'findings' }, { kind: 'topology' }]
    const entityAttachment: Attachment | null = selectedServerId ? { kind: 'entity', id: selectedServerId } : null
    return entityAttachment ? [...base, entityAttachment] : base
  }, [selectedServerId])

  const previews = useMemo(
    () => new Map(options.map(a => [attachmentKey(a), attachmentPreview(a, contextInput)])),
    [options, contextInput],
  )

  // attachmentKey() is the same identity chat.store.ts's toggleAttachment uses for its own
  // dedup — matching it here (rather than a separate JSON.stringify comparison) keeps "selected"
  // and "keyed for React" in exact lockstep with the store's notion of attachment identity.
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
          <label key={attachmentKey(a)} htmlFor={inputId} className="chat-attachment-chip" style={chipStyle(active, colorVar)} title={`~${preview.tokens} tokens`}>
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
