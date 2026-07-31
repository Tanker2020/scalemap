import { describe, it, expect } from 'vitest'
import { formatResponse } from './formatResponse'

const noEntities = () => false

describe('formatResponse', () => {
  it('splits fenced code blocks first, at highest precedence', () => {
    const blocks = formatResponse('before\n```ts\nconst x = 1\n```\nafter', noEntities)
    expect(blocks.map(b => b.kind)).toEqual(['paragraph', 'code', 'paragraph'])
    const code = blocks[1] as { kind: 'code'; lang: string | null; text: string }
    expect(code.lang).toBe('ts')
    expect(code.text).toBe('const x = 1')
  })

  it('consumes trailing info-string text on the opening fence line instead of leaking it into the code', () => {
    const blocks = formatResponse('```js extra info\nconst x = 1\n```', noEntities)
    const code = blocks[0] as { kind: 'code'; lang: string | null; text: string }
    expect(code.lang).toBe('js')
    expect(code.text).toBe('const x = 1')
  })

  it('handles an unterminated fence by taking the remainder', () => {
    const blocks = formatResponse('```\nno closing fence here', noEntities)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('code')
  })

  it('does not parse markdown inside a fenced block', () => {
    const blocks = formatResponse('```\n**not bold** `not code`\n```', noEntities)
    const code = blocks[0] as { kind: 'code'; text: string }
    expect(code.text).toContain('**not bold**')
  })

  it('splits blank-line-separated paragraphs', () => {
    const blocks = formatResponse('first para\n\nsecond para', noEntities)
    expect(blocks).toHaveLength(2)
    expect(blocks.every(b => b.kind === 'paragraph')).toBe(true)
  })

  it('parses flat bullets with -, *, and N.', () => {
    const blocks = formatResponse('- one\n- two\n* three', noEntities)
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as { kind: 'bullets'; items: unknown[] }).items).toHaveLength(3)
  })

  it('parses ## and ### headings', () => {
    const blocks = formatResponse('## Heading', noEntities)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 2 })
  })

  it('does not match bold across a paragraph break', () => {
    const blocks = formatResponse('**opens but\n\nnever closes', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string }[] }
    expect(paragraph.spans.every(s => s.kind !== 'strong')).toBe(true)
  })

  it('bolds **text** within one paragraph', () => {
    const blocks = formatResponse('a **bold** word', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; text: string }[] }
    expect(paragraph.spans.some(s => s.kind === 'strong' && s.text === 'bold')).toBe(true)
  })

  it('renders inline code spans', () => {
    const blocks = formatResponse('call `foo()` now', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; text: string }[] }
    expect(paragraph.spans.some(s => s.kind === 'code' && s.text === 'foo()')).toBe(true)
  })

  it('upgrades a resolvable inline-code span to an entity span', () => {
    const resolve = (token: string) => token === 'srv-1'
    const blocks = formatResponse('see `srv-1` for details', resolve)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; id?: string }[] }
    expect(paragraph.spans.some(s => s.kind === 'entity' && s.id === 'srv-1')).toBe(true)
  })

  it('keeps unsupported syntax (tables, links, raw HTML) as literal text', () => {
    const blocks = formatResponse('<script>alert(1)</script> and [a link](http://x)', noEntities)
    const paragraph = blocks[0] as { kind: 'paragraph'; spans: { kind: string; text: string }[] }
    const joined = paragraph.spans.map(s => s.text).join('')
    expect(joined).toContain('<script>alert(1)</script>')
    expect(joined).toContain('[a link](http://x)')
  })
})
