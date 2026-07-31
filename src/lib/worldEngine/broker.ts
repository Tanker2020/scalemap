// src/lib/worldEngine/broker.ts
// The async `event` delivery model (audit ISSUE-002) — pure, no engine imports, modelled directly
// on managedDbRuntime.ts's shape (aggregate load -> per-topic failure model -> whole-step runtime).
//
// Before this module, `event` was a synchronous blocking RPC wearing a different label:
// `connectionClassOf` collapsed it to keep-alive and `packetResolve` turned it into plain
// request/response bytes — no queue, no lag, no ACK/NACK, no DLQ, no producer/consumer decoupling.
// A struggling CONSUMER opened the PRODUCER's breaker, the literal opposite of what a message
// broker exists for. This module gives `event` a bounded backlog that absorbs the gap between
// producer and consumer rate instead of transmitting it upstream as synchronous pressure.
//
// ⚠ DELIBERATE EXCEPTION to this audit's "every new field defaults to unchanged behaviour" rule
// (Global Constraint 4): unlike every other issue here, this ONE changes default behaviour for
// every EXISTING `event` packet, not just newly-authored ones — an `event` dependency is now
// simulated as asynchronous by default, which is the entire point of the fix. See CLAUDE.md's
// Known Issues / Roadmap (the `event` bullet is removed in the same change that adds this file).
//
// AGGREGATE, like managedDbRuntime.ts: a topic's backlog/lag/drop/DLQ rates are properties of
// TOTAL arrival vs TOTAL consumer capacity, not any one producer's share — so this module computes
// ONE entry per topic (keyed by dependency id — this schema has no separate "Topic" entity; the
// dependency edge IS the topic instance) from the PREVIOUS step's flows, and `flows.ts` applies the
// resulting drop/DLQ fractions to each producer's own share. Same one-step lag as
// `admittedScale`/`managedDbRuntime`.
import type { InstanceId, WorldDoc, CompiledWorld } from '../world/types'
import { resolveMixProtocol } from '../packetResolve'

const EPSILON_RPS = 1e-9
// Absent `maxRedeliveries` ⇒ one redelivery attempt before DLQ (a reasonable at-least-once
// default — never silently drop, but don't retry forever either).
const DEFAULT_MAX_REDELIVERIES = 1

export interface TopicRuntimeEntry {
  totalArrivalRps: number   // aggregate producer rps into this topic (previous step)
  backlogCount: number      // persistent queue depth carried across steps
  drainRps: number          // rps actually delivered-and-acknowledged this step
  lagSec: number            // backlogCount / drainRps — consumer lag, the user-visible number
  dropRps: number           // retention-cap overflow — at-most-once loses these, never redelivered
  redeliverRps: number      // consumer NACKs fed back into the backlog for another attempt
  dlqRps: number            // exhausted maxRedeliveries — terminal, does not re-enter the backlog
}

export type TopicRuntime = Record<string, TopicRuntimeEntry>   // keyed by dependencyId

// Aggregate load reaching each event-protocol dependency ("topic"), summed across every producer
// instance's downstream rows — the input the model below needs and a per-caller view structurally
// cannot see (you can't compute backlog/lag from one producer's share). `consumerCapacityRps` is
// the SAME per-instance service rate the flow solver's queue model already resolves
// (`FlowInput.serviceRateByInstance`) — reused here, not re-derived, so a consumer's simulated
// capacity can never disagree between its own queue and the topic it's draining.
interface TopicFlowView {
  instanceId: InstanceId
  admittedRps: number
  errorRps: number
  downstream: { dependencyId: string; toInstanceId?: InstanceId; rps: number; blocked: boolean }[]
}

export function aggregateTopicLoad(
  prevFlows: Record<InstanceId, TopicFlowView>,
  compiled: CompiledWorld,
  doc: WorldDoc,
  serviceRateByInstance: Record<InstanceId, number>,
): Record<string, { arrivalRps: number; consumerCapacityRps: number; consumerErrorFraction: number }> {
  const arrival = new Map<string, number>()
  const consumerIds = new Map<string, Set<InstanceId>>()
  // Consumer error fraction (this step's own errorRps/(admitted+errorRps), rps-weighted across a
  // topic's resolved consumer instances) — the NACK signal driving redelivery below. Reused from
  // the same InstanceFlow fields every other rule reads, not a new capacity/health resolution.
  const consumerErrorWeighted = new Map<string, { errW: number; totalW: number }>()

  for (const flow of Object.values(prevFlows)) {
    for (const row of flow.downstream) {
      if (row.blocked || row.rps <= 0 || row.toInstanceId == null) continue
      const bp = doc.blueprints[compiled.instances[flow.instanceId]?.blueprintId ?? '']
      const dep = bp?.dependencies.find(d => d.id === row.dependencyId)
      if (!dep) continue
      const protocol = resolveMixProtocol(doc.packets, dep.packetMix) ?? dep.protocol
      if (protocol !== 'event') continue

      arrival.set(row.dependencyId, (arrival.get(row.dependencyId) ?? 0) + row.rps)
      const ids = consumerIds.get(row.dependencyId) ?? new Set<InstanceId>()
      ids.add(row.toInstanceId)
      consumerIds.set(row.dependencyId, ids)

      const consumerFlow = prevFlows[row.toInstanceId]
      if (consumerFlow) {
        const total = consumerFlow.admittedRps + consumerFlow.errorRps
        const w = consumerErrorWeighted.get(row.dependencyId) ?? { errW: 0, totalW: 0 }
        w.errW += consumerFlow.errorRps
        w.totalW += total
        consumerErrorWeighted.set(row.dependencyId, w)
      }
    }
  }

  const out: Record<string, { arrivalRps: number; consumerCapacityRps: number; consumerErrorFraction: number }> = {}
  for (const [depId, arrivalRps] of arrival) {
    let capacity = 0
    for (const id of consumerIds.get(depId) ?? []) capacity += serviceRateByInstance[id] ?? 0
    const w = consumerErrorWeighted.get(depId)
    const consumerErrorFraction = w && w.totalW > EPSILON_RPS ? Math.min(1, w.errW / w.totalW) : 0
    out[depId] = { arrivalRps, consumerCapacityRps: capacity, consumerErrorFraction }
  }
  return out
}

// The failure model for ONE topic at a given aggregate load, carrying its own persistent backlog
// across steps (mutated in place — same ownership pattern as `flows.ts`'s `queueDepth`).
function topicRuntimeFor(
  load: { arrivalRps: number; consumerCapacityRps: number; consumerErrorFraction: number },
  backlogPrev: number,
  stepSec: number,
  retentionCapCount: number | undefined,
  maxRedeliveries: number | undefined,
): TopicRuntimeEntry {
  const retentionCap = retentionCapCount != null && retentionCapCount > 0 ? retentionCapCount : Infinity
  const maxRedel = maxRedeliveries ?? DEFAULT_MAX_REDELIVERIES

  // Worked in COUNTS (messages this step), not rates — clearer arithmetic than converting back and
  // forth. backlogPrev is already a count (persisted); arrival/capacity convert via stepSec.
  const arrivalCount = load.arrivalRps * stepSec
  const capacityCount = load.consumerCapacityRps * stepSec
  const offeredCount = backlogPrev + arrivalCount

  // How much the consumer actually attempts this step: backlog first, then fresh arrivals, capped
  // at its own capacity — the same "served = min(capacity, backlog-first + arrivals)" shape
  // flows.ts's queue model already uses for a synchronous instance's own backlog.
  const attemptedCount = Math.min(capacityCount, offeredCount)
  const succeededCount = attemptedCount * (1 - load.consumerErrorFraction)
  const failedCount = attemptedCount - succeededCount
  // maxRedeliveries === 0: no redelivery budget authored — a failed attempt goes straight to the
  // DLQ. Otherwise every failure gets fed back into the backlog for one more attempt; this is a
  // simplification of true per-message attempt-counting (this is an aggregate rps model, not a
  // per-message one) — a topic with a high sustained consumer error rate keeps re-attempting the
  // same failing share indefinitely rather than exhausting a per-message counter, the reasonable
  // aggregate analogue of "the DLQ only catches messages that are ACTUALLY exhausted."
  const redeliverCount = maxRedel > 0 ? failedCount : 0
  const dlqCount = maxRedel > 0 ? 0 : failedCount

  const unattemptedCount = offeredCount - attemptedCount   // never even reached the consumer this step
  const backlogRawCount = unattemptedCount + redeliverCount
  const dropCount = Math.max(0, backlogRawCount - retentionCap)
  const backlogCount = Math.min(backlogRawCount, retentionCap)

  const drainRps = succeededCount / stepSec
  const dropRps = dropCount / stepSec
  const redeliverRps = redeliverCount / stepSec
  const dlqRps = dlqCount / stepSec
  const lagSec = drainRps > EPSILON_RPS ? backlogCount / drainRps : (backlogCount > EPSILON_RPS ? Infinity : 0)

  return {
    totalArrivalRps: load.arrivalRps, backlogCount, drainRps, lagSec, dropRps, redeliverRps, dlqRps,
  }
}

// The whole per-step runtime: aggregate last step's load, then run the failure model per topic,
// carrying each topic's backlog forward in `backlogByTopic` (mutated in place, like `queueDepth`).
export function topicRuntime(
  prevFlows: Parameters<typeof aggregateTopicLoad>[0],
  compiled: CompiledWorld,
  doc: WorldDoc,
  serviceRateByInstance: Record<InstanceId, number>,
  backlogByTopic: Map<string, number>,
  stepSec: number,
): TopicRuntime {
  const load = aggregateTopicLoad(prevFlows, compiled, doc, serviceRateByInstance)
  const out: TopicRuntime = {}
  for (const [depId, l] of Object.entries(load)) {
    // Find the authored EventTemplate for this dependency's bound mix (majority-weight packet, the
    // same one resolveMixProtocol picked 'event' from) for retentionCapCount/maxRedeliveries.
    let retentionCapCount: number | undefined
    let maxRedeliveries: number | undefined
    outer: for (const bp of Object.values(doc.blueprints)) {
      for (const dep of bp.dependencies) {
        if (dep.id !== depId) continue
        for (const entry of dep.packetMix ?? []) {
          const tpl = doc.packets.templates[entry.packetId]
          if (tpl?.protocol === 'event') {
            retentionCapCount = tpl.retentionCapCount
            maxRedeliveries = tpl.maxRedeliveries
            break outer
          }
        }
      }
    }
    const backlogPrev = backlogByTopic.get(depId) ?? 0
    const entry = topicRuntimeFor(l, backlogPrev, stepSec, retentionCapCount, maxRedeliveries)
    backlogByTopic.set(depId, entry.backlogCount)
    out[depId] = entry
  }
  return out
}
