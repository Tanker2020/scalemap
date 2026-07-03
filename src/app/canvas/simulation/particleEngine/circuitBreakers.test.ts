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

  it('forceOpenBreakersForNode opens breakers on the given inbound edges when the node type has a circuitBreaker config', () => {
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const edgesData = [makeEdge('e1', 'a', 'b')]
    forceOpenBreakersForNode('b', edgesData, /* hasBreakerConfig */ true, 100, nodesMap, noop)
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

  it('getBreaker creates a fresh breaker with trialPending false', () => {
    const b = getBreaker('e1')
    expect(b.trialPending).toBe(false)
  })

  it('checkBreakerTransition resets trialPending to false when opening into half-open', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const nodeHealthStates = new Map<string, 'healthy' | 'degraded' | 'down'>()
    const b = getBreaker('e1')
    b.state = 'open'
    b.openedAt = 0
    b.trialPending = true // stale from a previous half-open window
    checkBreakerTransition('e1', configWithBreaker, 5000, edgesData, nodesMap, nodeHealthStates, noop)
    expect(getBreaker('e1').trialPending).toBe(false)
  })

  it('recordBreakerResult clears trialPending when a half-open trial succeeds (closes)', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const b = getBreaker('e1')
    b.state = 'half-open'
    b.trialPending = true
    recordBreakerResult('e1', false, configWithBreaker, 100, edgesData, nodesMap, new Map(), new Map(), noop)
    expect(getBreaker('e1').state).toBe('closed')
    expect(getBreaker('e1').trialPending).toBe(false)
  })

  it('recordBreakerResult clears trialPending when a half-open trial fails (reopens)', () => {
    const edgesData = [makeEdge('e1', 'a', 'b')]
    const nodesMap = new Map([['a', makeNode('a', 'A')], ['b', makeNode('b', 'B')]])
    const b = getBreaker('e1')
    b.state = 'half-open'
    b.trialPending = true
    recordBreakerResult('e1', true, configWithBreaker, 100, edgesData, nodesMap, new Map(), new Map(), noop)
    expect(getBreaker('e1').state).toBe('open')
    expect(getBreaker('e1').trialPending).toBe(false)
  })

  // ─── C1: config-less node types must never latch a breaker open forever ─────
  describe('force-open on config-less node types (C1)', () => {
    const configNoBreaker: NodeSimConfig = {
      maxRps: 50000,
      processingMs: 1,
      errorRate: 0,
      // no circuitBreaker key — mirrors NODE_SIM_DEFAULTS.redis / queue / loadBalancer / etc.
    } as unknown as NodeSimConfig

    it('does not open a breaker for a node type with no circuitBreaker config (redis)', () => {
      const nodesMap = new Map([['api-1', makeNode('api-1', 'API')], ['redis-1', makeNode('redis-1', 'Redis')]])
      const edgesData = [makeEdge('e1', 'api-1', 'redis-1')]
      forceOpenBreakersForNode('redis-1', edgesData, /* hasBreakerConfig */ false, 100, nodesMap, noop)
      expect(getBreaker('e1').state).not.toBe('open')
    })

    it('can still close a breaker that was already force-opened before this fix shipped', () => {
      const nodesMap = new Map([['api-1', makeNode('api-1', 'API')], ['redis-1', makeNode('redis-1', 'Redis')]])
      const edgesData = [makeEdge('e1', 'api-1', 'redis-1')]
      const nodeHealthStates = new Map<string, 'healthy' | 'degraded' | 'down'>([['redis-1', 'healthy']])
      const b = getBreaker('e1')
      b.state = 'open'
      b.openedAt = Date.now() - 10_000
      const effectiveConfig = (_nodeId: string, _nodeType: NodeType) => configNoBreaker
      resetBreakersIfRecovered(Date.now(), edgesData, nodesMap, nodeHealthStates, effectiveConfig, noop)
      expect(getBreaker('e1').state).not.toBe('open')
    })
  })
})
