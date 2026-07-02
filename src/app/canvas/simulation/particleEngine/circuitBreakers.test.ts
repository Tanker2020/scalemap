import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getBreaker, getAllBreakers, recordBreakerResult, checkBreakerTransition,
  forceOpenBreakersForNode, resetBreakersIfRecovered, clearBreakers,
} from './circuitBreakers'
import type { Edge, Node } from '@xyflow/react'
import type { EdgeData, NodeData, NodeSimConfig, NodeType } from '../../../../lib/nodeConfig'

const noop = vi.fn()

function makeEdge(id: string, source: string, target: string): Edge<EdgeData> {
  return {
    id, source, target, type: 'request',
    data: { label: '', edgeType: 'request', throughput: 0, latency: 0 } as EdgeData,
  }
}

function makeNode(id: string, label: string): Node<NodeData> {
  return { id, type: 'ec2', position: { x: 0, y: 0 }, data: { label } as NodeData }
}

const configWithBreaker: NodeSimConfig = {
  maxRps: 1000,
  processingMs: 10,
  errorRate: 0,
  circuitBreaker: { errorThreshold: 0.5, resetMs: 1000 },
} as unknown as NodeSimConfig

describe('circuitBreakers', () => {
  beforeEach(() => {
    clearBreakers()
    noop.mockClear()
  })

  it('getBreaker creates a fresh closed breaker on first access', () => {
    const b = getBreaker('e1')
    expect(b.state).toBe('closed')
    expect(b.openedAt).toBe(0)
    expect(b.errorWindow).toEqual([])
  })

  it('getBreaker returns the same entry on repeat access (memoized per edge id)', () => {
    const a = getBreaker('e1')
    a.state = 'open'
    const b = getBreaker('e1')
    expect(b.state).toBe('open')
  })

  it('clearBreakers resets all breaker state', () => {
    getBreaker('e1').state = 'open'
    clearBreakers()
    expect(getBreaker('e1').state).toBe('closed')
    expect(getAllBreakers().size).toBe(1) // clearBreakers wipes then getBreaker('e1') re-creates it
  })

  it('recordBreakerResult opens the breaker once the error threshold is crossed', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    for (let i = 0; i < 10; i++) {
      recordBreakerResult('e1', true, configWithBreaker, i, edgesData, nodesMap, new Map(), new Map(), noop)
    }
    expect(getBreaker('e1').state).toBe('open')
  })

  it('checkBreakerTransition moves an open breaker to half-open after resetMs elapses', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const nodeHealthStates = new Map<string, 'healthy' | 'degraded' | 'down'>()
    const b = getBreaker('e1')
    b.state = 'open'
    b.openedAt = 0
    const state = checkBreakerTransition('e1', configWithBreaker, 5000, edgesData, nodesMap, nodeHealthStates, noop)
    expect(state).toBe('half-open')
  })

  it('forceOpenBreakersForNode opens breakers on the given inbound edges', () => {
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const edgesData = [makeEdge('e1', 'a', 'b')]
    forceOpenBreakersForNode('b', edgesData, 100, nodesMap, noop)
    expect(getBreaker('e1').state).toBe('open')
  })

  it('resetBreakersIfRecovered transitions a recoverable open breaker to half-open', () => {
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodeHealthStates = new Map<string, 'healthy' | 'degraded' | 'down'>([['b', 'healthy']])
    const b = getBreaker('e1')
    b.state = 'open'
    b.openedAt = 0
    const effectiveConfig = (_nodeId: string, _nodeType: NodeType) => configWithBreaker
    resetBreakersIfRecovered(5000, edgesData, nodesMap, nodeHealthStates, effectiveConfig, noop)
    expect(getBreaker('e1').state).toBe('half-open')
  })
})
