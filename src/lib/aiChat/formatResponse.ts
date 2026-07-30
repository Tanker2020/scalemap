export type Span =
  | { kind: 'text'; text: string } | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string } | { kind: 'entity'; id: string; text: string }
export type Block =
  | { kind: 'paragraph'; spans: Span[] } | { kind: 'bullets'; items: Span[][] }
  | { kind: 'heading'; level: 2 | 3; spans: Span[] } | { kind: 'code'; lang: string | null; text: string }

function parseInline(text: string, resolveEntity: (token: string) => boolean): Span[] {
  const spans: Span[] = []
  let i = 0
  while (i < text.length) {
    const boldStart = text.indexOf('**', i)
    const codeStart = text.indexOf('`', i)
    const nextSpecial = [boldStart, codeStart].filter(n => n >= 0).sort((a, b) => a - b)[0]
    if (nextSpecial === undefined) { spans.push({ kind: 'text', text: text.slice(i) }); break }
    if (nextSpecial === boldStart) {
      const close = text.indexOf('**', boldStart + 2)
      const newline = text.indexOf('\n\n', boldStart)
      if (close === -1 || (newline !== -1 && newline < close)) {
        spans.push({ kind: 'text', text: text.slice(i, boldStart + 2) })
        i = boldStart + 2
        continue
      }
      if (boldStart > i) spans.push({ kind: 'text', text: text.slice(i, boldStart) })
      spans.push({ kind: 'strong', text: text.slice(boldStart + 2, close) })
      i = close + 2
    } else {
      const close = text.indexOf('`', codeStart + 1)
      if (close === -1) { spans.push({ kind: 'text', text: text.slice(i) }); break }
      if (codeStart > i) spans.push({ kind: 'text', text: text.slice(i, codeStart) })
      const token = text.slice(codeStart + 1, close)
      spans.push(resolveEntity(token) ? { kind: 'entity', id: token, text: token } : { kind: 'code', text: token })
      i = close + 1
    }
  }
  return spans
}

export function formatResponse(raw: string, resolveEntity: (token: string) => boolean): Block[] {
  const blocks: Block[] = []
  const fenceRe = /```(\w*)\n?/g
  let cursor = 0
  let match: RegExpExecArray | null

  const pushProse = (segment: string): void => {
    for (const para of segment.split(/\n\n+/)) {
      const trimmed = para.trim()
      if (!trimmed) continue
      const headingMatch = /^(#{2,3})\s+(.*)$/.exec(trimmed)
      if (headingMatch) {
        blocks.push({ kind: 'heading', level: headingMatch[1].length as 2 | 3, spans: parseInline(headingMatch[2], resolveEntity) })
        continue
      }
      const lines = trimmed.split('\n')
      if (lines.every(l => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        blocks.push({ kind: 'bullets', items: lines.map(l => parseInline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''), resolveEntity)) })
        continue
      }
      blocks.push({ kind: 'paragraph', spans: parseInline(trimmed, resolveEntity) })
    }
  }

  while ((match = fenceRe.exec(raw)) !== null) {
    pushProse(raw.slice(cursor, match.index))
    const closeIdx = raw.indexOf('```', fenceRe.lastIndex)
    const lang = match[1] || null
    if (closeIdx === -1) {
      blocks.push({ kind: 'code', lang, text: raw.slice(fenceRe.lastIndex) })
      cursor = raw.length
      break
    }
    // The line break immediately preceding the closing fence delimiter is part of the
    // fence syntax, not the code content (standard fenced-code-block semantics) — strip
    // exactly one trailing newline, not any blank lines the author put inside the block.
    const rawText = raw.slice(fenceRe.lastIndex, closeIdx)
    const text = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText
    blocks.push({ kind: 'code', lang, text })
    cursor = closeIdx + 3
    fenceRe.lastIndex = cursor
  }
  pushProse(raw.slice(cursor))
  return blocks
}
