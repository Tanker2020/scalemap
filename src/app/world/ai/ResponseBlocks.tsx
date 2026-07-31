// Renders formatResponse's parsed Block[] as read-only markdown-subset output, resolving
// backtick-quoted entity ids against the compiled world into clickable EntityChips instead of
// plain inline code (buildCitationIndex is the id membership test formatResponse consults).
import type { CSSProperties } from 'react'
import { formatResponse, type Span } from '../../../lib/aiChat/formatResponse'
import { buildCitationIndex } from '../../../lib/aiChat/citations'
import { EntityChip } from './EntityChip'
import type { WorldDoc, CompiledWorld } from '../../../lib/world/types'

function renderSpan(span: Span, key: number, doc: WorldDoc, compiled: CompiledWorld, onNavigated: () => void) {
  if (span.kind === 'text') return <span key={key}>{span.text}</span>
  if (span.kind === 'strong') return <strong key={key}>{span.text}</strong>
  if (span.kind === 'entity') return <EntityChip key={key} id={span.id} doc={doc} compiled={compiled} onNavigated={onNavigated} />
  return <code key={key} style={{ background: 'var(--color-surface-hover)', padding: '0 3px', borderRadius: 3 }}>{span.text}</code>
}

const codeBlockStyle: CSSProperties = {
  background: 'var(--color-surface-hover)', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: 8, overflowX: 'auto', whiteSpace: 'pre',
}

export function ResponseBlocks({ raw, doc, compiled, onNavigated }: {
  raw: string; doc: WorldDoc; compiled: CompiledWorld; onNavigated: () => void
}) {
  const citations = buildCitationIndex(doc, compiled)
  const blocks = formatResponse(raw, citations.has)
  return (
    <div style={{ font: '11px var(--font-mono)', lineHeight: 1.5 }}>
      {blocks.map((b, i) => {
        if (b.kind === 'code') return <pre key={i} style={codeBlockStyle}>{b.text}</pre>
        if (b.kind === 'heading') return <div key={i} style={{ fontWeight: 700, marginTop: 8 }}>{b.spans.map((s, j) => renderSpan(s, j, doc, compiled, onNavigated))}</div>
        if (b.kind === 'bullets') return (
          <ul key={i} style={{ margin: '4px 0', paddingLeft: 18 }}>
            {b.items.map((spans, j) => <li key={j}>{spans.map((s, k) => renderSpan(s, k, doc, compiled, onNavigated))}</li>)}
          </ul>
        )
        return <p key={i} style={{ margin: '4px 0' }}>{b.spans.map((s, j) => renderSpan(s, j, doc, compiled, onNavigated))}</p>
      })}
    </div>
  )
}
