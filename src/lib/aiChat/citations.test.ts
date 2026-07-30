import { describe, it, expect } from 'vitest'
import { buildCitationIndex } from './citations'
import type { WorldDoc, CompiledWorld } from '../world/types'

function fixture(): { doc: WorldDoc; compiled: CompiledWorld } {
  const doc = {
    regions: { 'r1': {} }, azs: { 'az1': {} }, servers: { 'srv-1': {} },
    blueprints: { 'bp-1': {} }, managedServices: {}, populations: {}, placements: {},
  } as unknown as WorldDoc
  const compiled = { instances: { 'inst-1': {}, 'inst-1#0': {} }, paths: [], findings: [], routing: {} } as unknown as CompiledWorld
  return { doc, compiled }
}

describe('buildCitationIndex', () => {
  it('matches a known id with word-boundary-like lookarounds', () => {
    const { doc, compiled } = fixture()
    const idx = buildCitationIndex(doc, compiled)
    expect(idx.has('srv-1')).toBe(true)
    expect(idx.has('unknown-id')).toBe(false)
  })

  it('matches the longer id first when one id is a prefix of another', () => {
    const { doc, compiled } = fixture()
    const idx = buildCitationIndex(doc, compiled)
    expect(idx.has('inst-1#0')).toBe(true)
    expect(idx.has('inst-1')).toBe(true)
  })

  it('does not match a substring that only partially overlaps an id', () => {
    const { doc, compiled } = fixture()
    const idx = buildCitationIndex(doc, compiled)
    expect(idx.has('srv-12')).toBe(false)
    expect(idx.has('xsrv-1')).toBe(false)
  })

  it('memoizes per compiled identity', () => {
    const { doc, compiled } = fixture()
    expect(buildCitationIndex(doc, compiled)).toBe(buildCitationIndex(doc, compiled))
  })
})
