import { describe, it, expect } from 'vitest'
import { dependencyIndexFor, blastRadius } from './dependents'
import type { WorldDoc, CompiledWorld } from './types'

function makeFixture(): { doc: WorldDoc; compiled: CompiledWorld } {
  // web (bp-web) -> api (bp-api) -> db (managed-db)
  const doc = {
    blueprints: {
      'bp-web': { id: 'bp-web', name: 'web', dependencies: [
        { id: 'dep-1', target: { kind: 'blueprint', blueprintId: 'bp-api' }, port: 80, protocol: 'http', packetTemplateId: null },
      ] },
      'bp-api': { id: 'bp-api', name: 'api', dependencies: [
        { id: 'dep-2', target: { kind: 'managed', managedServiceId: 'managed-db' }, port: 5432, protocol: 'db', packetTemplateId: null },
      ] },
    },
    placements: {}, managedServices: { 'managed-db': { id: 'managed-db', label: 'db' } },
  } as unknown as WorldDoc
  const compiled = {
    instances: {
      'web-1': { id: 'web-1', blueprintId: 'bp-web', serverId: 's1', azId: 'az1', regionId: 'r1' },
      'api-1': { id: 'api-1', blueprintId: 'bp-api', serverId: 's2', azId: 'az1', regionId: 'r1' },
    },
    paths: [
      { id: 'p1', dependencyId: 'dep-1', fromInstanceId: 'web-1', to: { kind: 'instance', instanceId: 'api-1' }, verdict: 'permitted' },
      { id: 'p2', dependencyId: 'dep-2', fromInstanceId: 'api-1', to: { kind: 'managed', managedServiceId: 'managed-db' }, verdict: 'permitted' },
    ],
    findings: [], routing: {},
  } as unknown as CompiledWorld
  return { doc, compiled }
}

describe('dependencyIndexFor', () => {
  it('builds forward and reverse blueprint-level maps', () => {
    const { doc, compiled } = makeFixture()
    const idx = dependencyIndexFor(doc, compiled)
    expect(idx.dependentsOfBlueprint.get('bp-api')).toEqual(['bp-web'])
    expect(idx.dependenciesOfBlueprint.get('bp-web')).toEqual(['bp-api'])
  })

  it('builds instance-level maps from compiled.paths', () => {
    const { doc, compiled } = makeFixture()
    const idx = dependencyIndexFor(doc, compiled)
    expect(idx.dependentInstances.get('api-1')).toEqual(['web-1'])
    expect(idx.dependencyTargets.get('web-1')).toEqual(['api-1'])
  })

  it('memoizes by CompiledWorld identity', () => {
    const { doc, compiled } = makeFixture()
    expect(dependencyIndexFor(doc, compiled)).toBe(dependencyIndexFor(doc, compiled))
  })

  it('rebuilds when the compiled object identity changes', () => {
    const { doc, compiled } = makeFixture()
    const first = dependencyIndexFor(doc, compiled)
    const second = dependencyIndexFor(doc, { ...compiled })
    expect(first).not.toBe(second)
  })
})

describe('blastRadius', () => {
  it('expands a serverId to its hosted instance and returns transitive dependents', () => {
    const { doc, compiled } = makeFixture()
    const result = blastRadius('s2', doc, compiled) // server hosting api-1
    expect(result.direct).toContain('web-1')
  })

  it('is cycle-safe', () => {
    const { doc, compiled } = makeFixture()
    // introduce a cycle api-1 -> web-1
    compiled.paths.push({
      id: 'p3', dependencyId: 'dep-3', fromInstanceId: 'api-1',
      to: { kind: 'instance', instanceId: 'web-1' }, verdict: 'permitted',
    } as never)
    expect(() => blastRadius('web-1', doc, compiled)).not.toThrow()
    const result = blastRadius('web-1', doc, compiled)
    expect(result.transitive.filter(id => id === 'web-1').length).toBeLessThanOrEqual(1)
  })
})
