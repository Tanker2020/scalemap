// Audit ISSUE-028: one compile per doc identity, shared across every consumer.
import { describe, it, expect } from 'vitest'
import { compiledFor } from './useCompiledWorld'
import { createWorld } from '../../lib/world/factories'

describe('compiledFor (ISSUE-028 compile-once cache)', () => {
  it('returns the same compiled object for the same doc identity', () => {
    const doc = createWorld()
    const a = compiledFor(doc)
    const b = compiledFor(doc)
    expect(b).toBe(a)   // cache hit — compileWorld ran once, N consumers share it
  })

  it('a new doc identity compiles fresh; the old entry still serves the old doc', () => {
    const docA = createWorld()
    const docB = createWorld()
    const a = compiledFor(docA)
    const b = compiledFor(docB)
    expect(b).not.toBe(a)
    expect(compiledFor(docA)).toBe(a)   // undo-style return to a prior doc is a cache hit
  })
})
