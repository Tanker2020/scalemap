import { describe, it, expect } from 'vitest'
import { VAULT } from './exampleWorlds'
import { compileWorld } from '../world/compileWorld'
import { runAnalysis } from '../analysis/runAnalysis'
import { createWorldEngine } from '../worldEngine'
import type { MetricsBatch } from '../worldEngine/types'

const entry = (id: string) => VAULT.find(e => e.id === id)!

describe('VAULT registry', () => {
  it('has the four entries with unique ids and names', () => {
    expect(VAULT).toHaveLength(4)
    expect(new Set(VAULT.map(e => e.id)).size).toBe(4)
    expect(new Set(VAULT.map(e => e.name)).size).toBe(4)
    expect(VAULT.map(e => e.id)).toEqual(['three-tier', 'multi-region-failover', 'event-driven', 'broken-teaching'])
  })

  it('every build() returns a fresh document', () => {
    for (const e of VAULT) {
      const a = e.build()
      const b = e.build()
      expect(a).not.toBe(b)
      expect(Object.keys(a.servers)).not.toEqual(Object.keys(b.servers)) // fresh ids, no shared refs
    }
  })
})

describe.each([['three-tier'], ['multi-region-failover'], ['event-driven']])('%s (clean world)', (id) => {
  it('compiles with zero compile findings and zero analysis findings', () => {
    const doc = entry(id).build()
    const compiled = compileWorld(doc)
    expect(compiled.findings).toEqual([])
    expect(runAnalysis(doc, compiled, null)).toEqual([])
    expect(compiled.paths.some(p => p.verdict === 'blocked')).toBe(false)
  })
})

describe('broken-teaching (teaching world)', () => {
  it('trips ≥10 analysis findings spanning all three families', () => {
    const doc = entry('broken-teaching').build()
    const compiled = compileWorld(doc)
    const findings = runAnalysis(doc, compiled, null)
    expect(findings.length).toBeGreaterThanOrEqual(10)
    for (const family of ['structural', 'network', 'capacity'] as const) {
      expect(findings.some(f => f.family === family)).toBe(true)
    }
    const ruleIds = new Set(findings.map(f => f.ruleId))
    for (const expected of [
      'single-az-region', 'no-failover-region', 'replicas-colocated', 'deep-sync-chain',
      'unused-managed-service', 'blocked-dependency-path', 'db-port-exposed',
      'entry-unreachable', 'ram-oversubscribed', 'ttl-outlives-detection',
    ]) expect(ruleIds.has(expected), `expected rule ${expected}`).toBe(true)
    expect(compiled.findings.map(f => f.kind).sort()).toEqual(['blocked-path', 'stateful-without-volume'])
  })
})

describe.each(VAULT.map(e => [e.id] as const))('%s engine smoke', (id) => {
  it('seeded engine runs and produces metrics; worlds with populations reach non-zero rps', () => {
    const doc = entry(id).build()
    const compiled = compileWorld(doc)
    const engine = createWorldEngine(1)
    const batches: MetricsBatch[] = []
    engine.start(doc, compiled, { onMetrics: b => batches.push(b), onEvent: () => {}, onHealthChange: () => {} })
    engine.__test_step(50)
    engine.stop()
    expect(batches.length).toBeGreaterThan(0)
    // Auto-baseline was removed 2026-07-15: traffic comes only from authored populations, so the
    // single-region clean worlds (three-tier, event-driven — deliberately population-less to stay
    // finding-clean) legitimately idle at zero rps.
    const expectRps = Object.keys(doc.populations).length > 0
    expect(batches[batches.length - 1].world.totalRps > 0).toBe(expectRps)
  })
})
