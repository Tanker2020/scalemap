import type { EngineEvent, FaultKind, FaultScope, FaultSpec } from './types'
import type { InstanceId } from '../world/types'

export interface FaultState {
  active: Map<string, FaultSpec>        // keyed `${scope}:${id}`, mirrors failover.ts's outageKey shape
  leakAccumMb: Map<InstanceId, number>  // memory-leak accumulator, reset on restart/clear
}

export function createFaultState(): FaultState {
  return { active: new Map(), leakAccumMb: new Map() }
}

function faultKey(scope: FaultScope, id: string): string {
  return `${scope}:${id}`
}

function specsEqual(a: FaultSpec, b: FaultSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function faultEvent(
  kind: 'fault_injected' | 'fault_cleared' | 'outage_triggered' | 'outage_cleared',
  scope: FaultScope,
  id: string,
  faultKind: FaultKind | undefined,
  simMs: number,
): EngineEvent {
  const suffix = faultKind && faultKind !== 'down' ? ` (${faultKind})` : ''
  return {
    id: `evt-fault:${scope}:${id}`,
    kind,
    severity: kind === 'fault_cleared' || kind === 'outage_cleared' ? 'info' : 'warning',
    message: `${scope} ${id}${suffix} ${kind.endsWith('cleared') ? 'fault cleared' : 'fault injected'}`,
    affected: [id],
    simMs,
  }
}

export function setFault(
  state: FaultState,
  scope: FaultScope,
  id: string,
  spec: FaultSpec | null,
  simMs: number,
  affectedInstanceIds: InstanceId[] = [],
): EngineEvent[] {
  const key = faultKey(scope, id)
  const existing = state.active.get(key)

  if (spec === null) {
    if (!existing) return []
    state.active.delete(key)
    for (const instId of affectedInstanceIds) state.leakAccumMb.delete(instId)
    return [faultEvent(existing.kind === 'down' ? 'outage_cleared' : 'fault_cleared', scope, id, existing.kind, simMs)]
  }

  if (existing && specsEqual(existing, spec)) return []
  state.active.set(key, spec)
  return [faultEvent(spec.kind === 'down' ? 'outage_triggered' : 'fault_injected', scope, id, spec.kind, simMs)]
}

export function faultsForServer(serverId: string, azId: string, regionId: string, state: FaultState): FaultSpec[] {
  const out: FaultSpec[] = []
  const serverSpec = state.active.get(faultKey('server', serverId))
  if (serverSpec) out.push(serverSpec)
  const azSpec = state.active.get(faultKey('az', azId))
  if (azSpec) out.push(azSpec)
  const regionSpec = state.active.get(faultKey('region', regionId))
  if (regionSpec) out.push(regionSpec)
  return out
}

export function stepLeaks(
  state: FaultState,
  activeLeaks: { instanceId: InstanceId; mbPerMinute: number }[],
  stepSec: number,
): void {
  for (const { instanceId, mbPerMinute } of activeLeaks) {
    const prev = state.leakAccumMb.get(instanceId) ?? 0
    state.leakAccumMb.set(instanceId, prev + (mbPerMinute * stepSec) / 60)
  }
}
