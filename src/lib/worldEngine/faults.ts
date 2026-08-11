import type { EngineEvent, FaultKind, FaultScope, FaultSpec, LinkEndpoint, PartitionFault } from './types'
import type { InstanceId } from '../world/types'

export interface FaultState {
  active: Map<string, FaultSpec>        // keyed `${scope}:${id}`, mirrors failover.ts's outageKey shape
  leakAccumMb: Map<InstanceId, number>  // memory-leak accumulator, reset on restart/clear
  partitions: PartitionFault[]          // FEAT-002 active network partitions
  // Monotonic counter backing addPartition's auto-assigned id (audit final-review I3) — never
  // reused within a run, so an id always names exactly one partition even after others are healed.
  nextPartitionId: number
}

export function createFaultState(): FaultState {
  return { active: new Map(), leakAccumMb: new Map(), partitions: [], nextPartitionId: 0 }
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

// ─── Network partitions (FEAT-002) ───────────────────────────────────────────

function endpointLabel(e: LinkEndpoint): string {
  return e.kind === 'internet' ? 'internet' : `${e.kind}:${e.id}`
}

// Audit final-review I3: partitions are addressed by stable id, not array position — the
// PartitionsSection UI is usable WHILE running (edit-lock inverse), so authoring/healing a
// partition by hand mid-scenario-run must never shift another partition's identity out from
// under a scenario's `heal-partition` step. `fault.id` is caller-supplied when the author needs a
// stable handle to pair with a later heal (e.g. a scenario's matched partition/heal-partition step
// pair); when absent, it is auto-assigned here from the run's monotonic counter — every partition
// gets a real id either way, so removePartition can always address by identity.
export function addPartition(state: FaultState, fault: PartitionFault, simMs: number): EngineEvent {
  if (!fault.id) fault.id = `partition-${state.nextPartitionId++}`
  state.partitions.push(fault)
  return {
    id: `evt-partition:${fault.id}:${simMs}`,
    kind: 'partition_started',
    severity: 'warning',
    message: `partition ${endpointLabel(fault.from)} -> ${endpointLabel(fault.to)} (${fault.mode})`,
    affected: [],
    simMs,
  }
}

// Returns null when the id is unknown (no-op) rather than throwing — a stale/already-healed id
// (e.g. a scenario step racing a manual heal, or replaying against a shifted list under the OLD
// index-based scheme) simply has no matching partition to describe an event for.
export function removePartition(state: FaultState, id: string, simMs: number): EngineEvent | null {
  const index = state.partitions.findIndex(p => p.id === id)
  if (index === -1) return null
  const [removed] = state.partitions.splice(index, 1)
  return {
    id: `evt-partition-healed:${id}:${simMs}`,
    kind: 'partition_healed',
    severity: 'info',
    message: `partition healed: ${endpointLabel(removed.from)} -> ${endpointLabel(removed.to)}`,
    affected: [],
    simMs,
  }
}

// Plain, already-resolved endpoint identity for one side of a path — the caller (a later
// task) resolves a CompiledPath's from/to instance/managed-service into these ids via
// compiled.instances/doc.managedServices before calling impairmentFor. Kept decoupled from
// CompiledPath entirely so this module stays pure (no world/compileWorld imports), matching
// flows.ts's faultErrorFractionByServer discipline.
export interface EndpointIds {
  regionId?: string
  azId?: string
  serverId?: string
  subnetId?: string
  natGatewayId?: string
}

// Exhaustive switch over LinkEndpoint['kind'] (FEAT-014) — deliberately NOT an if-chain with a
// trailing fallthrough. The pre-FEAT-014 version ended `return ids.serverId === endpoint.id` as
// its final branch, which meant any endpoint kind other than 'internet'/'region'/'az' (including
// the 'subnet'/'natGateway' kinds added here) would silently be compared against ids.serverId —
// a subnet-scoped partition could wrongly match a server whose id happened to equal the subnet
// id string, or wrongly fail to match a real subnet endpoint. The switch's implicit exhaustiveness
// (no default) means a future LinkEndpoint kind added without a matching case here is a compile
// error, not a silent fallthrough.
function endpointMatches(endpoint: LinkEndpoint, ids: EndpointIds): boolean {
  switch (endpoint.kind) {
    case 'internet': return false
    case 'region': return ids.regionId === endpoint.id
    case 'az': return ids.azId === endpoint.id
    case 'server': return ids.serverId === endpoint.id
    case 'subnet': return ids.subnetId === endpoint.id
    case 'natGateway': return ids.natGatewayId === endpoint.id
  }
}

export function impairmentFor(
  fromIds: EndpointIds,
  toIds: EndpointIds,
  partitions: PartitionFault[],
): { blocked: boolean; lossFraction: number; delayMs: number } {
  let blocked = false
  let lossFraction = 0
  let delayMs = 0
  for (const p of partitions) {
    const forward = endpointMatches(p.from, fromIds) && endpointMatches(p.to, toIds)
    const backward = p.symmetric && endpointMatches(p.to, fromIds) && endpointMatches(p.from, toIds)
    if (!forward && !backward) continue
    if (p.mode === 'drop') blocked = true
    if (p.mode === 'loss') lossFraction = Math.max(lossFraction, p.lossFraction ?? 0)
    if (p.mode === 'delay') delayMs += p.delayMs ?? 0
  }
  return { blocked, lossFraction, delayMs }
}
