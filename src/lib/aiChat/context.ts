// Read-only AI chat context builder — the ONE place that turns the compiled world + live
// state into text an LLM sees. `buildChatDigest` is the always-on, small, rollup-only summary
// sent with every turn; `buildContextBlock` renders the user's opt-in attachments (full detail,
// but still never a raw LlmSettings/API-key value and never a full instance/server map outside
// a top-8 truncation — see the security canary tests in context.test.ts).
import type { WorldDoc, CompiledWorld, CompileFinding } from '../world/types'
import type { AnalysisFinding } from '../analysis/types'
import type { MetricsBatch, EngineEvent, ReplayFrame, RenderScope } from '../worldEngine/types'
import { dependencyIndexFor } from '../world/dependents'
import { buildCausalEpisodes } from './eventCausality'

export type Attachment =
  | { kind: 'events' } | { kind: 'replay' } | { kind: 'findings' } | { kind: 'topology' }
  | { kind: 'traces'; scope: RenderScope } | { kind: 'entity'; id: string }

export interface ChatContextInput {
  doc: WorldDoc
  compiled: CompiledWorld
  findings: AnalysisFinding[]
  compileFindings: CompileFinding[]
  latestBatch: MetricsBatch | null
  events: EngineEvent[]
  replayFrames: ReplayFrame[]
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function attachmentKey(a: Attachment): string {
  switch (a.kind) {
    case 'entity': return `entity:${a.id}`
    case 'traces': {
      const s = a.scope as { level: string; azId?: string; serverId?: string; regionId?: string }
      const id = s.serverId ?? s.azId ?? s.regionId ?? 'world'
      return `traces:${s.level}:${id}`
    }
    default: return a.kind
  }
}

function topN<T>(items: T[], n: number, byKey: (t: T) => number): T[] {
  return [...items].sort((a, b) => byKey(b) - byKey(a)).slice(0, n)
}

function worldSummary(doc: WorldDoc): unknown {
  return {
    routingPolicy: doc.routing.policy,
    dnsTtlSec: doc.routing.dnsTtlSec,
    healthCheckIntervalMs: doc.routing.healthCheckIntervalMs,
    healthCheckFailureThreshold: doc.routing.healthCheckFailureThreshold,
    regionCount: Object.keys(doc.regions).length,
    azCount: Object.keys(doc.azs).length,
    serverCount: Object.keys(doc.servers).length,
  }
}

function servicesSummary(doc: WorldDoc): unknown[] {
  return Object.values(doc.blueprints).map(bp => ({
    id: bp.id, name: bp.name,
    dependencies: bp.dependencies.map(d => d.target.kind === 'blueprint' ? d.target.blueprintId : d.target.managedServiceId),
    placementCount: Object.values(doc.placements).filter(p => p.blueprintId === bp.id).length,
  }))
}

function liveStateSummary(batch: MetricsBatch | null): unknown {
  if (!batch) return null
  const servers = topN(Object.values(batch.servers), 8, s => Math.max(0, ...s.coreUtilization))
    .map(s => ({ serverId: s.serverId, maxCoreUtilization: Math.max(0, ...s.coreUtilization) }))
  const instances = topN(Object.values(batch.instances), 8, i => i.errorRate)
    .map(i => ({ instanceId: i.instanceId, errorRate: i.errorRate, p99Ms: i.p99Ms }))
  return {
    world: batch.world,
    regions: batch.regions,
    azs: batch.azs,
    servers, instances,
  }
}

function findingsIndex(findings: AnalysisFinding[]): unknown[] {
  const byRule = new Map<string, { ruleId: string; severity: string; affectedCount: number }>()
  for (const f of findings as unknown as { ruleId: string; severity: string; affected: string[] }[]) {
    const existing = byRule.get(f.ruleId)
    if (existing) existing.affectedCount += f.affected.length
    else byRule.set(f.ruleId, { ruleId: f.ruleId, severity: f.severity, affectedCount: f.affected.length })
  }
  return [...byRule.values()]
}

function eventSummary(events: EngineEvent[]): unknown {
  const counts: Record<string, number> = {}
  for (const e of events) counts[`${e.kind}:${e.severity}`] = (counts[`${e.kind}:${e.severity}`] ?? 0) + 1
  const mostSevere = [...events].filter(e => e.severity !== 'info').slice(-5)
  return {
    counts,
    firstSimMs: events[0]?.simMs ?? null,
    lastSimMs: events[events.length - 1]?.simMs ?? null,
    mostSevere: mostSevere.map(e => ({ id: e.id, kind: e.kind, severity: e.severity, message: e.message })),
  }
}

const LIMITATIONS = [
  'No queue-depth or offered-vs-admitted-rps signal exists — infer saturation from coreUtilization/p99Ms/errorRate/droppedRps/refusedRps only.',
  'There is no connection pool or connection ceiling model — RAM is the only hard capacity constraint.',
  'k8s/ECS scheduling, ScaleScript, Terraform export, and spot instances are not implemented in this app — never recommend them.',
]

export function buildChatDigest(input: ChatContextInput): string {
  const idx = dependencyIndexFor(input.doc, input.compiled)
  const payload = {
    worldSummary: worldSummary(input.doc),
    services: servicesSummary(input.doc),
    managed: Object.keys(input.doc.managedServices),
    blastRadiusIndexSize: idx.dependentInstances.size,
    liveState: liveStateSummary(input.latestBatch),
    findingsIndex: findingsIndex(input.findings),
    eventSummary: eventSummary(input.events),
    limitations: LIMITATIONS,
  }
  return JSON.stringify(payload)
}

function findingsBlock(input: ChatContextInput): string {
  return JSON.stringify(input.findings)
}

function eventsBlock(input: ChatContextInput): string {
  return JSON.stringify(buildCausalEpisodes(input.replayFrames, input.doc, input.compiled))
}

function replayBlock(input: ChatContextInput): string {
  const rows = input.replayFrames.slice(-60).map(f => ({
    simMs: f.simMs, worldRps: f.batch.world.totalRps, worldErrorRate: f.batch.world.errorRate,
    eventCount: f.events.length,
  }))
  return JSON.stringify(rows)
}

function topologyBlock(input: ChatContextInput): string {
  return JSON.stringify(input.doc)
}

function entityBlock(id: string, input: ChatContextInput): string {
  const record =
    input.doc.regions[id] ?? input.doc.azs[id] ?? input.doc.servers[id] ??
    input.doc.blueprints[id] ?? input.doc.managedServices[id] ?? input.doc.populations[id] ??
    input.compiled.instances[id] ?? null
  return JSON.stringify({ id, record })
}

export function buildContextBlock(attachments: Attachment[], input: ChatContextInput): string {
  const parts: string[] = []
  for (const a of attachments) {
    switch (a.kind) {
      case 'events': parts.push(`EVENTS:\n${eventsBlock(input)}`); break
      case 'replay': parts.push(`REPLAY:\n${replayBlock(input)}`); break
      case 'findings': parts.push(`FINDINGS:\n${findingsBlock(input)}`); break
      case 'topology': parts.push(`TOPOLOGY:\n${topologyBlock(input)}`); break
      case 'entity': parts.push(`ENTITY ${a.id}:\n${entityBlock(a.id, input)}`); break
      case 'traces': parts.push(`TRACES ${JSON.stringify(a.scope)}: unavailable in this build`); break
    }
  }
  return parts.join('\n\n')
}

export function attachmentPreview(a: Attachment, input: ChatContextInput): { label: string; tokens: number } {
  const block = buildContextBlock([a], input)
  const labels: Record<Attachment['kind'], string> = {
    events: 'Events', replay: 'Replay', findings: 'Findings', topology: 'Topology (full world)',
    traces: 'Traces', entity: 'Entity',
  }
  return { label: labels[a.kind], tokens: estimateTokens(block) }
}
