// src/lib/world/populationLabel.test.ts
import { describe, it, expect } from 'vitest'
import { nextPopulationLabel } from './populationLabel'
import { createPopulation } from './factories'
import type { ClientPopulation, PopulationId } from './types'

function byId(pops: ClientPopulation[]): Record<PopulationId, ClientPopulation> {
  const out: Record<PopulationId, ClientPopulation> = {}
  for (const p of pops) out[p.id] = p
  return out
}

describe('nextPopulationLabel', () => {
  it('returns pop-1 for an empty population map', () => {
    expect(nextPopulationLabel({})).toBe('pop-1')
  })

  it('scans the max existing pop-N suffix rather than counting entries', () => {
    const a = createPopulation('pop-1', 0, 0)
    const b = createPopulation('pop-3', 0, 0)
    expect(nextPopulationLabel(byId([a, b]))).toBe('pop-4')
  })

  it('ignores non-matching / manually-renamed labels', () => {
    const a = createPopulation('nyc', 0, 0)
    const b = createPopulation('pop-2', 0, 0)
    expect(nextPopulationLabel(byId([a, b]))).toBe('pop-3')
  })

  it('is stable after a remove + re-add that would collide under a length-based counter', () => {
    // Reproduces the exact Phase-5 backlog scenario: pop-1 and pop-2 both added, then pop-1
    // removed (leaving one entry — length 1). A naive `pop-${length + 1}` would re-issue
    // 'pop-2', a real duplicate. The max-suffix scan instead sees the surviving 'pop-2' and
    // correctly continues at 'pop-3'.
    const survivor = createPopulation('pop-2', 0, 0)
    expect(nextPopulationLabel(byId([survivor]))).toBe('pop-3')
  })
})
