// The ONE place a bound packet mix (or the absence of one) turns into wire bytes.
//
// Every byte-consuming site — the entry tier's route bytes, the flow solver's cross-AZ/region cost
// accumulator, the NIC booking, the CPU-per-KB blend — reads through `resolveWireSize` so the
// fallback chain exists exactly once:
//
//   1. bound packet mix   — weighted mean over the referenced library packets
//   2. inline req/resp KB — the carrier's own authored sizes (a route's sizeKb/responseSizeKb,
//                           an edge's reqKb/respKb)
//   3. registry default   — `PacketRegistry.defaultPacket`, the world-level knob
//   4. 2 KB each way      — DEFAULT_PACKET_BYTES_EACH_WAY, the historical constant
//
// Tier 4 is why an existing .scalemap with no authored packets simulates byte-identically: an
// unbound, unauthored hop resolves to exactly the pre-packet-library numbers, and `sigma === 0`
// keeps the engine's seeded rng stream untouched (see sampleSizeMultiplier's sigma > 0 gate).
//
// Pure and dependency-free (registry types only) so it is node-testable and safe to call from the
// engine's hot path and from render-time particle code alike.

import type { DbTemplate, HttpTemplate, PacketMixEntry, PacketProtocol, PacketRegistry, PacketTemplate } from './nodeConfig'

// The engine's long-standing BYTES_PER_REQUEST_EACH_WAY convention. Moved here from nodeConfig.ts
// with routeIngressBytes when the packet library landed.
export const DEFAULT_PACKET_BYTES_EACH_WAY = 2048

// Write amplification a WAL-backed db packet implies on its WRITE bytes: the payload is written
// once to the log and once to the data pages. Applied only to the write share of a hop's bytes.
export const WAL_WRITE_AMPLIFICATION = 2

export interface WireSize {
  reqBytes: number          // per-request bytes on the caller→callee leg
  respBytes: number         // per-request bytes on the callee→caller leg
  sizeKb: number            // request KB — the input to WorkloadProfile.cpuMsPerKb
  sigma: number             // log-normal NIC-burst coefficient; 0 ⇒ no jitter, no rng draw
  // Fraction of this hop's calls that MUTATE the target, derived from db packets' queryType.
  // `undefined` (no db packet in the mix) means "not derived" — the caller keeps its own
  // hand-authored BlueprintDependency.writeFraction rather than being overridden with 0.
  writeFraction?: number
  amplification: number     // WAL write amplification on booked write bytes; 1 when none
}

// Per-request wire bytes an HTTP route implies, split request/response (KB×1024). Kept as a thin
// named wrapper over the tier-2/4 path because the entry tier reads routes, not mixes.
export function routeIngressBytes(route: HttpTemplate | undefined): { reqBytes: number; respBytes: number } {
  return {
    reqBytes: route?.sizeKb != null ? route.sizeKb * 1024 : DEFAULT_PACKET_BYTES_EACH_WAY,
    respBytes: route?.responseSizeKb != null ? route.responseSizeKb * 1024 : DEFAULT_PACKET_BYTES_EACH_WAY,
  }
}

const isDb = (t: PacketTemplate): t is DbTemplate => t.protocol === 'db'

// A db packet answers with `resultSizeKb`; every other kind uses `responseSizeKb`. Absent ⇒ null,
// so the caller can fall through to the next tier for the response leg alone.
function packetRespKb(t: PacketTemplate): number | null {
  if (isDb(t)) return t.resultSizeKb ?? t.responseSizeKb ?? null
  return t.responseSizeKb ?? null
}

/**
 * Resolve a carrier's bound mix + inline sizes into concrete per-request wire bytes.
 *
 * `mix` entries referencing a deleted packet are ignored (defensive — the store cascades on
 * delete, but a hand-authored file may dangle). A mix whose entries all dangle, or whose weights
 * sum to <= 0, falls through to the inline tier as if unbound.
 */
export function resolveWireSize(
  reg: PacketRegistry,
  mix: PacketMixEntry[] | undefined,
  inlineReqKb?: number,
  inlineRespKb?: number,
): WireSize {
  const defReqBytes = reg.defaultPacket?.reqKb != null ? reg.defaultPacket.reqKb * 1024 : DEFAULT_PACKET_BYTES_EACH_WAY
  const defRespBytes = reg.defaultPacket?.respKb != null ? reg.defaultPacket.respKb * 1024 : DEFAULT_PACKET_BYTES_EACH_WAY

  const resolved = (mix ?? [])
    .map(e => ({ entry: e, tpl: reg.templates[e.packetId] as PacketTemplate | undefined }))
    .filter((x): x is { entry: PacketMixEntry; tpl: PacketTemplate } =>
      x.tpl != null && Number.isFinite(x.entry.weight) && x.entry.weight > 0)

  const totalWeight = resolved.reduce((sum, x) => sum + x.entry.weight, 0)

  if (resolved.length === 0 || totalWeight <= 0) {
    // Tiers 2 → 3 → 4, each leg independently (matching routeIngressBytes' per-field fallback).
    const reqBytes = inlineReqKb != null ? inlineReqKb * 1024 : defReqBytes
    const respBytes = inlineRespKb != null ? inlineRespKb * 1024 : defRespBytes
    return { reqBytes, respBytes, sizeKb: reqBytes / 1024, sigma: 0, amplification: 1 }
  }

  let reqBytes = 0
  let respBytes = 0
  let sigma = 0
  let writeWeight = 0
  let dbWeight = 0
  let amplification = 0
  for (const { entry, tpl } of resolved) {
    const w = entry.weight / totalWeight
    reqBytes += w * (tpl.sizeKb != null ? tpl.sizeKb * 1024 : defReqBytes)
    const respKb = packetRespKb(tpl)
    respBytes += w * (respKb != null ? respKb * 1024 : defRespBytes)
    sigma += w * (tpl.sizeVariance ?? 0)
    if (isDb(tpl)) {
      dbWeight += w
      if (tpl.queryType === 'write' || tpl.queryType === 'transaction') writeWeight += w
      amplification += w * (tpl.isWAL ? WAL_WRITE_AMPLIFICATION : 1)
    } else {
      amplification += w
    }
  }

  return {
    reqBytes,
    respBytes,
    sizeKb: reqBytes / 1024,
    sigma,
    // Only a mix that actually contains db packets speaks for the write fraction; otherwise the
    // edge's hand-authored writeFraction stands.
    ...(dbWeight > 0 ? { writeFraction: writeWeight } : {}),
    amplification,
  }
}

// The mix's majority-weight protocol (audit ISSUE-007/002) — the ONE place "what protocol does
// this dependency actually speak" gets resolved, shared by the compile-time protocol-mismatch
// finding (`compileWorld.ts`) and the engine's event/broker gating (`flows.ts`), so the two can
// never disagree about which protocol a bound mix implies. Ties broken by first-encountered order,
// matching resolveWireSize/resolveConnectionProfile's own weighted-fold iteration order. Entries
// referencing a deleted packet, or a non-finite/non-positive weight, are ignored — same defensive
// filter every other packet-mix reader applies. Returns null for an empty/all-dangling/
// all-zero-weight mix (nothing to resolve).
export function resolveMixProtocol(reg: PacketRegistry, mix: PacketMixEntry[] | undefined): PacketProtocol | null {
  const weightByProtocol: Partial<Record<PacketProtocol, number>> = {}
  for (const entry of mix ?? []) {
    if (!Number.isFinite(entry.weight) || entry.weight <= 0) continue
    const tpl = reg.templates[entry.packetId]
    if (!tpl) continue
    weightByProtocol[tpl.protocol] = (weightByProtocol[tpl.protocol] ?? 0) + entry.weight
  }
  let best: PacketProtocol | null = null
  let bestWeight = -Infinity
  for (const [protocol, weight] of Object.entries(weightByProtocol)) {
    if (weight! > bestWeight) { best = protocol as PacketProtocol; bestWeight = weight! }
  }
  return best
}

// Deterministic, rng-FREE weighted pick for particle tinting.
//
// Particles are rebuilt from `renderAll` at wall-clock frame rate, not on the sim step — drawing
// from `s.rng` there would make the seeded stream depend on frame rate and break replay. So the
// caller's existing particle loop counter picks the packet instead: same k ⇒ same packet, always.
//
// The index maps to a position in [0,1) by the base-2 RADICAL INVERSE (van der Corput) rather
// than by `k / N`. A linear scan would lay the mix out in blocks — with a 3:1 mix, indices 0..47
// of a 64-slot cycle are all the majority packet, so a hop rendering only a handful of particles
// would never show the minority one at all. The radical inverse interleaves
// (0, ½, ¼, ¾, ⅛, ⅝, …), so even 4 particles sample the whole distribution, while over a full
// 2^n indices it remains an exact permutation of the uniform slots — the long-run proportions are
// unchanged.
const PATTERN_SLOTS = 64

function radicalInverse2(k: number): number {
  let bits = k >>> 0
  bits = ((bits << 16) | (bits >>> 16)) >>> 0
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0
  return bits * 2.3283064365386963e-10   // / 2^32
}

// Precomputed pick table (audit ISSUE-013): a mix's filtered entries + total weight, resolved ONCE
// per dependency at start() rather than re-filtered/re-summed on every particle on every frame.
// `mix` is read from the frozen `doc` and cannot change while the engine runs (topology is
// edit-locked), so every post-start() call recomputing this was pure waste — up to ~24,000
// filter+reduce allocations/sec at the render cap. `null` mirrors pickPacketByIndex's old
// "no valid entries" return of `null`.
export interface PickTable {
  entries: PacketMixEntry[]
  total: number
}

export function buildPickTable(mix: PacketMixEntry[] | undefined): PickTable | null {
  const entries = (mix ?? []).filter(e => Number.isFinite(e.weight) && e.weight > 0)
  if (entries.length === 0) return null
  const total = entries.reduce((sum, e) => sum + e.weight, 0)
  return { entries, total }
}

export function pickPacketByIndex(table: PickTable | null, k: number): number | null {
  if (table === null) return null
  const slot = ((k % PATTERN_SLOTS) + PATTERN_SLOTS) % PATTERN_SLOTS
  const x = radicalInverse2(slot) * table.total
  let cum = 0
  for (const e of table.entries) {
    cum += e.weight
    if (x < cum) return e.packetId
  }
  return table.entries[table.entries.length - 1].packetId
}
