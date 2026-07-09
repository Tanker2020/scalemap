import { describe, it, expect } from 'vitest'
import { availableBackendEdges } from './lbRouting'
import type { CircuitState } from '../../../store/simulationLegacy.store'

type HealthState = 'healthy' | 'degraded' | 'down'

function selectors(
  targets: Record<string, string>,
  breakers: Record<string, CircuitState>,
  health: Record<string, HealthState>,
) {
  return {
    edgeTarget: (id: string) => targets[id],
    breakerState: (id: string): CircuitState => breakers[id] ?? 'closed',
    nodeHealth: (id: string): HealthState | undefined => health[id],
  }
}

const edges = [{ id: 'e1' }, { id: 'e2' }]

describe('availableBackendEdges', () => {
  it('returns every edge when all backends are closed and healthy', () => {
    const s = selectors({ e1: 's1', e2: 's2' }, {}, { s1: 'healthy', s2: 'healthy' })
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual(edges)
  })

  it('excludes an edge whose breaker is open', () => {
    const s = selectors({ e1: 's1', e2: 's2' }, { e1: 'open' }, { s1: 'healthy', s2: 'healthy' })
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual([{ id: 'e2' }])
  })

  it('excludes an edge whose target node is down', () => {
    const s = selectors({ e1: 's1', e2: 's2' }, {}, { s1: 'down', s2: 'healthy' })
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual([{ id: 'e2' }])
  })

  // The reported bug's core: when every backend is unavailable the result MUST be empty so the
  // caller drops (503) — it must never fall back to the full pool.
  it('returns empty when every backend breaker is open', () => {
    const s = selectors({ e1: 's1', e2: 's2' }, { e1: 'open', e2: 'open' }, { s1: 'healthy', s2: 'healthy' })
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual([])
  })

  it('returns empty when every backend node is down', () => {
    const s = selectors({ e1: 's1', e2: 's2' }, {}, { s1: 'down', s2: 'down' })
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual([])
  })

  // half-open is "not open" — it stays eligible (the single-probe throttle is enforced in
  // spawnParticles, not here), preserving the pre-refactor filter semantics exactly.
  it('treats a half-open edge as available', () => {
    const s = selectors({ e1: 's1', e2: 's2' }, { e1: 'half-open' }, { s1: 'healthy', s2: 'healthy' })
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual(edges)
  })

  it('keeps an edge whose target cannot be resolved (cannot prove it is down)', () => {
    const s = selectors({ e2: 's2' }, {}, { s2: 'healthy' }) // e1 has no target mapping
    expect(availableBackendEdges(edges, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual(edges)
  })

  it('returns only the healthy edge under mixed states', () => {
    const three = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]
    const s = selectors(
      { e1: 's1', e2: 's2', e3: 's3' },
      { e1: 'open' },
      { s1: 'healthy', s2: 'down', s3: 'healthy' },
    )
    expect(availableBackendEdges(three, s.edgeTarget, s.breakerState, s.nodeHealth)).toEqual([{ id: 'e3' }])
  })
})
