// src/app/canvas/simulation/particleEngine/lbRouting.ts
import type { CircuitState } from '../../../store/simulationLegacy.store'

type HealthState = 'healthy' | 'degraded' | 'down'

// Filters a load balancer / API gateway's outbound edges down to the backends that can currently
// accept traffic: the edge's circuit breaker is not open AND the target node is not 'down'.
//
// Returns the eligible subset — which may be EMPTY. Callers MUST treat an empty result as
// "no healthy backend → reject/503" and drop the request; they must NOT fall back to routing over
// the full pool. Forwarding onto a tripped/down edge was the bug this helper was extracted to kill:
// the load balancer's forwarding mint bypasses effectiveRps, so a request pushed onto a tripped
// edge left the LB reporting outRps=0 while a real particle still flowed to (and was re-dropped by)
// the down backend. See particleEngine.ts handleParticleArrival (forwarding) and dropParticle
// (retry reroute) for the two call sites, and circuitBreakers.ts for the per-edge breaker model.
//
// half-open counts as available (it is "not open"); the single-probe throttle for half-open lives
// in spawnParticles, not here, so this preserves the exact predicate the two call sites used inline
// before the extraction.
export function availableBackendEdges<E extends { id: string }>(
  outEdges: E[],
  edgeTarget: (edgeId: string) => string | undefined,
  breakerState: (edgeId: string) => CircuitState,
  nodeHealth: (nodeId: string) => HealthState | undefined,
): E[] {
  return outEdges.filter(e => {
    const targetId = edgeTarget(e.id)
    return breakerState(e.id) !== 'open'
      && (targetId === undefined || nodeHealth(targetId) !== 'down')
  })
}
