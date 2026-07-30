import { describe, it, expect } from 'vitest'
import { decodeAffected, buildCausalEpisodes } from './eventCausality'
import type { EngineEvent, ReplayFrame } from '../worldEngine/types'
import type { WorldDoc, CompiledWorld } from '../world/types'

describe('decodeAffected', () => {
  it('decodes oom_kill as victim/host', () => {
    expect(decodeAffected('oom_kill', ['inst-1', 'srv-1'])).toEqual({ primaryId: 'inst-1', secondaryId: 'srv-1' })
  })
  it('decodes connection_refused with a possibly-empty callee', () => {
    expect(decodeAffected('connection_refused', ['inst-1', ''])).toEqual({ primaryId: 'inst-1', secondaryId: null })
  })
  it('decodes replica_promoted instance form', () => {
    expect(decodeAffected('replica_promoted', ['inst-2', 'inst-1'])).toEqual({ primaryId: 'inst-2', secondaryId: 'inst-1' })
  })
  it('decodes replica_promoted managed form (single id)', () => {
    expect(decodeAffected('replica_promoted', ['managed-db'])).toEqual({ primaryId: 'managed-db', secondaryId: null })
  })
  it('decodes primary_failback taking the LAST id as promoted', () => {
    expect(decodeAffected('primary_failback', ['inst-1', 'inst-2', 'inst-3'])).toEqual({ primaryId: 'inst-3', secondaryId: 'inst-1' })
  })
  it('decodes single-scope kinds', () => {
    expect(decodeAffected('health_check_failed', ['srv-1'])).toEqual({ primaryId: 'srv-1', secondaryId: null })
    expect(decodeAffected('noisy_neighbor', ['srv-1'])).toEqual({ primaryId: 'srv-1', secondaryId: null })
  })
  it('decodes engine_degraded with no ids', () => {
    expect(decodeAffected('engine_degraded', [])).toEqual({ primaryId: '', secondaryId: null })
  })
  it('decodes ttl_lag_expired as population/from/to', () => {
    expect(decodeAffected('ttl_lag_expired', ['pop-1', 'r1', 'r2'])).toEqual({ primaryId: 'pop-1', secondaryId: 'r2' })
  })
})

function frame(simMs: number, events: EngineEvent[], instanceErrorRates: Record<string, number>) {
  return {
    simMs,
    batch: {
      simMs,
      instances: Object.fromEntries(Object.entries(instanceErrorRates).map(([id, errorRate]) => [
        id, { instanceId: id, rps: 10, errorRate, p50Ms: 1, p99Ms: 1, activeConnections: 1, cpuCoresUsed: 1, ramMb: 1, health: 'healthy' },
      ])),
      servers: {}, azs: {}, regions: {}, world: { totalRps: 0, errorRate: 0 },
    },
    events,
  } as unknown as ReplayFrame
}

describe('buildCausalEpisodes', () => {
  it('seeds on oom_kill, joins dependents, and separates unrelated spikes', () => {
    const doc = {
      blueprints: {}, placements: {}, managedServices: {},
    } as unknown as WorldDoc
    const compiled = {
      instances: {
        'instA': { id: 'instA', serverId: 'srvX', azId: 'az1', regionId: 'r1' },
        'instB': { id: 'instB', serverId: 'srv2', azId: 'az1', regionId: 'r1' },
        'instC': { id: 'instC', serverId: 'srv3', azId: 'az1', regionId: 'r1' },
        'instD': { id: 'instD', serverId: 'srv4', azId: 'az1', regionId: 'r1' },
      },
      paths: [
        { id: 'p1', dependencyId: 'd1', fromInstanceId: 'instB', to: { kind: 'instance', instanceId: 'instA' }, verdict: 'permitted' },
        { id: 'p2', dependencyId: 'd2', fromInstanceId: 'instC', to: { kind: 'instance', instanceId: 'instA' }, verdict: 'permitted' },
      ],
      findings: [], routing: {},
    } as unknown as CompiledWorld

    const oomEvent: EngineEvent = { id: 'e1', simMs: 47000, kind: 'oom_kill', severity: 'critical', message: 'instA OOM-killed on srvX', affected: ['instA', 'srvX'] }
    const frames = [
      frame(45000, [], { instA: 0.01, instB: 0.01, instC: 0.01, instD: 0.01 }),
      frame(47000, [oomEvent], { instA: 0.9, instB: 0.6, instC: 0.6, instD: 0.7 }),
    ]

    const episodes = buildCausalEpisodes(frames, doc, compiled)
    expect(episodes).toHaveLength(1)
    const [ep] = episodes
    expect(ep.kind).toBe('oom_kill')
    const consequenceIds = ep.consequences.map(c => c.id)
    expect(consequenceIds).toContain('instB')
    expect(consequenceIds).toContain('instC')
    expect(consequenceIds).not.toContain('instD')
    expect(ep.unexplainedSpikes).toContain('instD')
  })

  it('collapses consecutive identical events into one episode with repeatedForMs', () => {
    const doc = { blueprints: {}, placements: {}, managedServices: {} } as unknown as WorldDoc
    const compiled = { instances: {}, paths: [], findings: [], routing: {} } as unknown as CompiledWorld
    const mkRefused = (simMs: number): EngineEvent => ({
      id: `e-${simMs}`, simMs, kind: 'connection_refused', severity: 'warning',
      message: 'x refused on y', affected: ['instX', 'instY'],
    })
    const frames = [1000, 2000, 3000].map(ms => frame(ms, [mkRefused(ms)], {}))
    const episodes = buildCausalEpisodes(frames, doc, compiled)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].repeatedForMs).toBeGreaterThanOrEqual(2000)
  })
})
