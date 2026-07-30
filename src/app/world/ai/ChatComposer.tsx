// The question input: Enter sends, Shift+Enter inserts a newline, auto-growing up to a max
// height. Draft text lives in chat.store so it survives the composer unmounting (overlay close).
import { useRef, type KeyboardEvent } from 'react'
import { useChatStore } from '../../store/chat.store'

const fieldStyle = {
  font: '11px var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-surface)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '6px 8px',
  resize: 'none' as const, minHeight: 52, maxHeight: 160, overflowY: 'auto' as const, width: '100%',
}

export function ChatComposer({ onSend, disabled }: { onSend: (question: string) => void; disabled: boolean }) {
  const draft = useChatStore(s => s.draft)
  const setDraft = useChatStore(s => s.setDraft)
  const ref = useRef<HTMLTextAreaElement>(null)

  const send = () => {
    const q = draft.trim()
    if (!q || disabled) return
    onSend(q)
    setDraft('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div style={{ padding: 8, borderTop: '1px solid var(--color-node-border)', flexShrink: 0 }}>
      <textarea
        ref={ref}
        style={fieldStyle}
        value={draft}
        placeholder="Ask about this world's design or what went wrong in the run..."
        onChange={e => {
          setDraft(e.target.value)
          const el = e.target
          el.style.height = 'auto'
          el.style.height = `${Math.min(160, el.scrollHeight)}px`
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
