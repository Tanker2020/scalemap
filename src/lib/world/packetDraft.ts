// src/lib/world/packetDraft.ts
// The vocabulary the "add a packet" form speaks, and its translation into the registry's.
//
// A library packet is a reusable payload definition — what a service→service hop actually puts on
// the wire. Authoring one means filling in identity (name, protocol, color), sizing (request KB,
// response KB, burst variance), and then whatever the chosen protocol adds on top. This module
// gives PacketModal a draft that captures in-progress editing before commit, and translates it
// into a concrete PacketTemplate.
//
// Mirrors `managedDraft.ts` beside it: PURE — no React, no store — so it is node-env testable and
// the modal stays presentation + dispatch only.
import type { PacketFields, PacketProtocol, PacketTemplate, ConnectionType, HttpTemplate } from '../nodeConfig'

export const PACKET_PROTOCOLS: { key: PacketProtocol; label: string; hint: string }[] = [
  { key: 'http', label: 'HTTP', hint: 'a request/response call between services' },
  { key: 'db', label: 'DB', hint: 'a query — read/write split drives the primary-vs-replica routing' },
  { key: 'event', label: 'Event', hint: 'a message published to a topic — delivered asynchronously via a bounded backlog' },
  { key: 'stream', label: 'Stream', hint: 'a continuous flow (persistent semantics: later phase)' },
]

// Numeric fields are held as STRINGS so a half-typed or intentionally blank input survives
// editing ('' means "leave it to the fallback chain", not 0) — same idiom managedDraft.ts uses
// for its inherit-capable fields.
export interface PacketDraft {
  name: string
  protocol: PacketProtocol
  sizeKb: string
  responseSizeKb: string
  sizeVariance: string
  colorOverride: string        // '' ⇒ no override, inherit the source blueprint's color

  // http
  method?: HttpTemplate['method']
  connectionType?: ConnectionType
  // Shared by http (streaming only) and stream: how long the connection is held open, in seconds.
  // '' ⇒ undefined ⇒ connectionModel's DEFAULT_HOLD_SEC, same blank-means-fallback idiom as the
  // size fields above.
  holdSeconds?: string
  // db
  queryType?: 'read' | 'write' | 'transaction'
  isWAL?: boolean
  resultSizeKb?: string
  // event
  topic?: string
  eventType?: string
  deliveryMode?: 'at-most-once' | 'at-least-once' | 'exactly-once'
  // Broker backlog model (audit ISSUE-002). '' ⇒ undefined ⇒ effectively unbounded retention /
  // a single redelivery attempt before DLQ — same blank-means-fallback idiom as the size fields.
  retentionCapCount?: string
  maxRedeliveries?: string
  // stream
  streamId?: string
  compressionType?: 'none' | 'gzip' | 'snappy'
}

// '' / NaN / negative ⇒ undefined, so the field falls through to the resolver's next tier rather
// than pinning the hop at 0 bytes.
export function parseKb(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const asString = (v: number | undefined): string => (v == null ? '' : String(v))

export function defaultPacketDraft(protocol: PacketProtocol = 'http'): PacketDraft {
  const base: PacketDraft = {
    name: '', protocol, sizeKb: '4', responseSizeKb: '16', sizeVariance: '0', colorOverride: '',
  }
  return applyProtocolChange(base, protocol)
}

// Changing the protocol re-bases the kind-specific fields to that kind's defaults while keeping
// everything shared (name, sizes, color) — the same invalidation idiom as managedDraft's
// applyNodeTypeChange. Fields belonging to OTHER protocols are cleared so draftToTemplate can't
// emit a shape carrying a stale kind's keys.
export function applyProtocolChange(draft: PacketDraft, protocol: PacketProtocol): PacketDraft {
  const shared = {
    name: draft.name, sizeKb: draft.sizeKb, responseSizeKb: draft.responseSizeKb,
    sizeVariance: draft.sizeVariance, colorOverride: draft.colorOverride,
  }
  switch (protocol) {
    case 'http':
      return {
        ...shared, protocol, method: draft.method ?? 'POST',
        connectionType: draft.connectionType ?? 'keep-alive', holdSeconds: draft.holdSeconds ?? '',
      }
    case 'db':
      return {
        ...shared, protocol,
        queryType: draft.queryType ?? 'read', isWAL: draft.isWAL ?? false,
        resultSizeKb: draft.resultSizeKb ?? draft.responseSizeKb,
      }
    case 'event':
      return {
        ...shared, protocol,
        topic: draft.topic ?? '', eventType: draft.eventType ?? '',
        deliveryMode: draft.deliveryMode ?? 'at-least-once',
        retentionCapCount: draft.retentionCapCount ?? '', maxRedeliveries: draft.maxRedeliveries ?? '',
      }
    case 'stream':
      return {
        ...shared, protocol, streamId: draft.streamId ?? '',
        compressionType: draft.compressionType ?? 'none', holdSeconds: draft.holdSeconds ?? '',
      }
  }
}

export function draftFromPacket(tpl: PacketTemplate): PacketDraft {
  const base: PacketDraft = {
    name: tpl.name,
    protocol: tpl.protocol,
    sizeKb: asString(tpl.sizeKb),
    responseSizeKb: asString(tpl.responseSizeKb),
    sizeVariance: asString(tpl.sizeVariance),
    colorOverride: tpl.colorOverride ?? '',
  }
  switch (tpl.protocol) {
    case 'http': return {
      ...base, method: tpl.method, connectionType: tpl.connectionType ?? 'keep-alive',
      holdSeconds: asString(tpl.holdSeconds),
    }
    case 'db': return { ...base, queryType: tpl.queryType, isWAL: tpl.isWAL, resultSizeKb: asString(tpl.resultSizeKb) }
    case 'event': return {
      ...base, topic: tpl.topic, eventType: tpl.eventType, deliveryMode: tpl.deliveryMode,
      retentionCapCount: asString(tpl.retentionCapCount), maxRedeliveries: asString(tpl.maxRedeliveries),
    }
    case 'stream': return {
      ...base, streamId: tpl.streamId, compressionType: tpl.compressionType,
      holdSeconds: asString(tpl.holdSeconds),
    }
  }
}

/**
 * Translate a draft into the registry's shape. Optional numeric fields resolve to `undefined`
 * when blank so the resolver's fallback chain stays reachable; `colorOverride: ''` is likewise
 * dropped rather than stored as an empty string.
 *
 * NOTE: never emits a `path` — that is precisely what keeps a library packet out of the route
 * view (see nodeConfig's listRoutes/listPackets).
 */
export function draftToTemplate(draft: PacketDraft): PacketFields {
  const shared = {
    name: draft.name.trim(),
    sizeKb: parseKb(draft.sizeKb) ?? 0,
    ...(parseKb(draft.responseSizeKb) != null ? { responseSizeKb: parseKb(draft.responseSizeKb) } : {}),
    ...(parseKb(draft.sizeVariance) ? { sizeVariance: parseKb(draft.sizeVariance) } : {}),
    ...(draft.colorOverride.trim() !== '' ? { colorOverride: draft.colorOverride.trim() } : {}),
  }
  switch (draft.protocol) {
    case 'http': {
      const connectionType = draft.connectionType ?? 'keep-alive'
      return {
        ...shared, protocol: 'http', statusCode: 200,
        method: draft.method ?? 'POST', connectionType,
        // ONLY on a streaming http packet: the other two classes derive their hold from request
        // latency, so persisting a number there would be authored-but-inert schema — exactly what
        // this phase set out to eliminate. Blank ⇒ omitted ⇒ DEFAULT_HOLD_SEC.
        ...(connectionType === 'streaming' && parseKb(draft.holdSeconds) != null
          ? { holdSeconds: parseKb(draft.holdSeconds) } : {}),
      }
    }
    case 'db':
      return {
        ...shared, protocol: 'db',
        queryType: draft.queryType ?? 'read', isWAL: draft.isWAL ?? false,
        // A db packet answers with resultSizeKb; fall back to the shared response field so a user
        // who only filled the generic "resp KB" box still gets the size they typed.
        resultSizeKb: parseKb(draft.resultSizeKb) ?? parseKb(draft.responseSizeKb) ?? 0,
      }
    case 'event':
      return {
        ...shared, protocol: 'event',
        topic: draft.topic?.trim() ?? '', eventType: draft.eventType?.trim() ?? '',
        deliveryMode: draft.deliveryMode ?? 'at-least-once',
        ...(parseKb(draft.retentionCapCount) != null ? { retentionCapCount: parseKb(draft.retentionCapCount) } : {}),
        ...(parseKb(draft.maxRedeliveries) != null ? { maxRedeliveries: parseKb(draft.maxRedeliveries) } : {}),
      }
    case 'stream':
      return {
        ...shared, protocol: 'stream',
        streamId: draft.streamId?.trim() ?? '', compressionType: draft.compressionType ?? 'none',
        // A stream is always a persistent connection (connectionModel's protocol-wins rule), so the
        // hold is always meaningful here — unlike the http case above.
        ...(parseKb(draft.holdSeconds) != null ? { holdSeconds: parseKb(draft.holdSeconds) } : {}),
      }
  }
}

export function packetDraftValid(draft: PacketDraft): boolean {
  return draft.name.trim() !== '' && parseKb(draft.sizeKb) != null
}
