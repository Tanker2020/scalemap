import { describe, it, expect } from 'vitest'
import { proxyDependencyFractions, localAzWeightOverride } from './proxyRouting'
import type { CompiledPath, ProxyConfig } from '../world/types'

const l4 = (weights?: Record<string, number>): ProxyConfig =>
  ({ mode: 'l4', upstreamWeights: weights, listenerRules: [], defaultDependencyId: null, preferLocalAz: true })
const l7 = (rules: [string, string][], def: string | null): ProxyConfig => ({
  mode: 'l7', listenerRules: rules.map(([pathPattern, dependencyId], i) => ({ id: `r${i}`, pathPattern, dependencyId })),
  defaultDependencyId: def, preferLocalAz: true,
})
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

describe('proxyDependencyFractions — L4', () => {
  it('forwards everything to a single upstream', () => {
    expect(proxyDependencyFractions(l4(), ['web'], undefined)).toEqual({ byDep: { web: 1 }, dropped: 0 })
  })
  it('splits evenly across unweighted upstreams — one-of, never a copy to each', () => {
    expect(proxyDependencyFractions(l4(), ['web', 'api'], undefined)).toEqual({ byDep: { web: 0.5, api: 0.5 }, dropped: 0 })
  })
  it('honors relative weights and drops a zero-weight upstream', () => {
    expect(proxyDependencyFractions(l4({ blue: 3, green: 1, old: 0 }), ['blue', 'green', 'old'], undefined))
      .toEqual({ byDep: { blue: 0.75, green: 0.25 }, dropped: 0 })
  })
  it('drops everything when every upstream is drained or none exists', () => {
    expect(proxyDependencyFractions(l4({ a: 0 }), ['a'], undefined)).toEqual({ byDep: {}, dropped: 1 })
    expect(proxyDependencyFractions(l4(), [], undefined)).toEqual({ byDep: {}, dropped: 1 })
  })
  it('ignores the route breakdown entirely', () => {
    expect(proxyDependencyFractions(l4(), ['web'], { '/api/x': 10 })).toEqual({ byDep: { web: 1 }, dropped: 0 })
  })
})

describe('proxyDependencyFractions — L7', () => {
  const cfg = l7([['/api/*', 'api'], ['/static/*', 'cdn']], 'web')
  it('routes entry traffic by first-matching rule, unmatched and pathless to the default', () => {
    const f = proxyDependencyFractions(cfg, ['web', 'api', 'cdn'], { '/api/users': 30, '/': 50, '': 20 })
    expect(f.byDep.api).toBeCloseTo(0.3, 12)
    expect(f.byDep.web).toBeCloseTo(0.7, 12)
    expect(f.byDep.cdn).toBeUndefined()
    expect(f.dropped).toBe(0)
  })
  it('sends internal-origin traffic (no route breakdown) to the default upstream', () => {
    expect(proxyDependencyFractions(cfg, ['web', 'api', 'cdn'], undefined)).toEqual({ byDep: { web: 1 }, dropped: 0 })
  })
  it('drops unmatched traffic as a 503 when there is no default', () => {
    const f = proxyDependencyFractions(l7([['/api/*', 'api']], null), ['api'], { '/api/a': 1, '/home': 3 })
    expect(f.byDep).toEqual({ api: 0.25 })
    expect(f.dropped).toBe(0.75)
    expect(proxyDependencyFractions(l7([], null), ['api'], undefined)).toEqual({ byDep: {}, dropped: 1 })
  })
  it('skips a rule pointing at a non-routable dependency and falls through', () => {
    const f = proxyDependencyFractions(l7([['/api/*', 'gone'], ['/*', 'web']], null), ['web'], { '/api/a': 1 })
    expect(f).toEqual({ byDep: { web: 1 }, dropped: 0 })
  })
  it('fractions plus dropped always sum to 1', () => {
    const f = proxyDependencyFractions(l7([['/a/*', 'a']], 'b'), ['a', 'b'], { '/a/1': 0.1, '/a/2': 0.2, '/c': 0.3 })
    expect(sum(f.byDep) + f.dropped).toBeCloseTo(1, 12)
  })
})

describe('localAzWeightOverride', () => {
  const path = (id: string): CompiledPath => ({
    id: `p-${id}`, dependencyId: 'd', fromInstanceId: 'px', to: { kind: 'instance', instanceId: id } as CompiledPath['to'],
    hopClass: 'same-az', verdict: 'permitted', blockReason: null,
  } as CompiledPath)
  const az: Record<string, string> = { a1: 'az-a', b1: 'az-b' }
  const cands = [path('a1'), path('b1')]
  it('zeroes out-of-AZ candidates while a local one is usable', () => {
    const w = localAzWeightOverride(() => 1, cands, 'az-a', id => az[id])
    expect([w('a1'), w('b1')]).toEqual([1, 0])
  })
  it('passes base weights through when every local candidate is down', () => {
    const base = (id: string) => (id === 'a1' ? 0 : 1)
    const w = localAzWeightOverride(base, cands, 'az-a', id => az[id])
    expect([w('a1'), w('b1')]).toEqual([0, 1])
  })
  it('passes through when the proxy AZ has no candidate at all', () => {
    const w = localAzWeightOverride(() => 1, cands, 'az-c', id => az[id])
    expect([w('a1'), w('b1')]).toEqual([1, 1])
  })
})
