// Opt-in attachment toggles (events/replay/findings/topology, plus the currently-selected server
// as an `entity` attachment) shown with a live token-cost preview per chip and a running total —
// context.ts's attachmentPreview/estimateTokens do the actual sizing, this is presentation only.
import type { CSSProperties } from 'react'
import { useChatStore } from '../../store/chat.store'
import { attachmentPreview, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
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

  const base: Attachment[] = [{ kind: 'events' }, { kind: 'replay' }, { kind: 'findings' }, { kind: 'topology' }]
  const entityAttachment: Attachment | null = selectedServerId ? { kind: 'entity', id: selectedServerId } : null
  const options = entityAttachment ? [...base, entityAttachment] : base

  const isSelected = (a: Attachment) => selected.some(s => JSON.stringify(s) === JSON.stringify(a))
  const totalTokens = selected.reduce((sum, a) => sum + attachmentPreview(a, contextInput).tokens, 0)

  return (
    <div style={{ padding: '4px 8px', borderTop: '1px solid var(--color-node-border)' }}>
      {options.map(a => {
        const preview = attachmentPreview(a, contextInput)
        return (
          <button key={JSON.stringify(a)} style={chip(isSelected(a))} onClick={() => toggle(a)} title={`~${preview.tokens} tokens`}>
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
