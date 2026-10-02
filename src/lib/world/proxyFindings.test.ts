import { describe, it, expect } from 'vitest'
import { proxyFindings, proxyUpstreamIds } from './proxyFindings'
import { createWorld, createBlueprint, defaultProxyConfig } from './factories'
import type { BlueprintDependency, ProxyConfig, WorldDoc } from './types'

const dep = (id: string, protocol: BlueprintDependency['protocol'] = 'http'): BlueprintDependency =>
  ({ id, target: { kind: 'blueprint', blueprintId: 'x' }, port: 8080, protocol, packetTemplateId: null })

function world(deps: BlueprintDependency[], cfg: ProxyConfig | undefined = defaultProxyConfig()): { doc: WorldDoc; id: string } {
  const doc = createWorld()
  const bp = createBlueprint('edge', 0)
  bp.kind = 'proxy'
  bp.dependencies = deps
  bp.proxyConfig = cfg
  doc.blueprints[bp.id] = bp
  return { doc, id: bp.id }
}
const kinds = (doc: WorldDoc) => proxyFindings(doc).map(f => f.kind)

describe('proxyFindings', () => {
  it('is silent for a doc with no proxy, and for a well-formed proxy', () => {
    const doc = createWorld()
    doc.blueprints.a = { ...createBlueprint('api', 0), id: 'a', dependencies: [dep('d1', 'event')] }
    expect(proxyFindings(doc)).toEqual([])
    expect(kinds(world([dep('d1')]).doc)).toEqual([])
  })
  it('flags a proxy with no upstreams', () => {
    expect(kinds(world([]).doc)).toEqual(['proxy-no-upstreams'])
  })
  it('flags an event dependency and excludes it from the upstreams', () => {
    const { doc, id } = world([dep('d1'), dep('d2', 'event')])
    expect(kinds(doc)).toEqual(['proxy-event-upstream'])
    expect(proxyUpstreamIds(doc.packets, doc.blueprints[id])).toEqual(['d1'])
  })
  it('flags rules, default, or weights naming a dependency that is not connected', () => {
    const l7: ProxyConfig = { mode: 'l7', listenerRules: [{ id: 'r', pathPattern: '/a/*', dependencyId: 'gone' }], defaultDependencyId: 'd1', preferLocalAz: true }
    expect(kinds(world([dep('d1')], l7).doc)).toEqual(['proxy-unknown-upstream'])
    expect(kinds(world([dep('d1')], { ...defaultProxyConfig(), upstreamWeights: { gone: 2 } }).doc)).toEqual(['proxy-unknown-upstream'])
  })
  it('warns when an L7 proxy has no default upstream', () => {
    const l7: ProxyConfig = { mode: 'l7', listenerRules: [{ id: 'r', pathPattern: '/a/*', dependencyId: 'd1' }], defaultDependencyId: null, preferLocalAz: true }
    expect(kinds(world([dep('d1')], l7).doc)).toEqual(['proxy-l7-no-default'])
  })
})
