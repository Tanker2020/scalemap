// The ONE place connection semantics live — the companion to packetResolve.ts.
//
// packetResolve answers "how many bytes does this call move"; this module answers "how long is the
// connection held, and what does establishing it cost". That distinction is what separates a
// CPU-bound failure from a RAM-bound one: a service comfortable at 1,000 rps on pooled connections
// can fall over at the same rps on handshake CPU, and a streaming service can drown in RAM at a
// fraction of that throughput.
//
// Pure and dependency-free (registry types only) so it is node-testable and safe to call from the
// engine's hot path — and, critically, so the engine's TWO connection call sites (the host
// scheduler's InstanceLoad.activeConnections and the published InstanceMetrics.activeConnections)
// can never disagree. Little's law used to be spelled out twice; both now call activeConnections().
//
// REGRESSION FLOOR: `keep-alive` is the identity. KEEP_ALIVE_PROFILE reproduces the historical
// `rps × latencyMs / 1000` EXACTLY (not approximately — a test asserts `toBe`), which is what keeps
// an unauthored world, and any world whose routes carry the default keep-alive, byte-identical.

import type { HttpTemplate, PacketMixEntry, PacketRegistry, PacketTemplate, StreamTemplate } from './nodeConfig'

// ── Constants ────────────────────────────────────────────────────────────────────────────────
// Engine constants, not authored: handshake and linger costs vary far less than hold time does.
export const HANDSHAKE_MS = 15         // ~2 RTT + TLS negotiation, added to the connection's hold
export const HANDSHAKE_CPU_MS = 2      // asymmetric crypto on the server, per request
export const LINGER_MS = 100           // TIME_WAIT tail after close — the connection still costs RAM
export const DEFAULT_HOLD_SEC = 30     // a streaming connection with no authored holdSeconds

export type ConnectionClass = 'keep-alive' | 'short-lived' | 'streaming'

/**
 * What one connection class (or a weighted blend of several) costs.
 *
 * NOTE on `latencyShare` — a plain `latencyCoupled: boolean` cannot survive blending: a 50/50
 * keep-alive + streaming mix is HALF latency-coupled, and a boolean would have to round that to
 * one class or the other. Carrying the coupled SHARE instead makes the struct closed under the
 * weighted mean: every field blends linearly, and each pure class is just a corner of that space.
 */
export interface ConnectionProfile {
  latencyShare: number     // 0..1 — fraction of calls whose hold tracks request latency
  fixedHoldSec: number     // weighted fixed hold (streaming), in seconds
  extraHoldSec: number     // weighted handshake + linger tail (short-lived), in seconds
  handshakeCpuMs: number   // weighted per-request CPU adder
  // Audit ISSUE-004: for a stream, `rps` means "new connections/sec" (what activeConnections()
  // above needs) — this is the SEPARATE "frames pushed per second, per open connection" factor,
  // decoupled from connection rate. `frameRps = rps × frameMultiplier` is what a caller feeds into
  // NIC/byte/cpuMsPerKb accounting instead of raw `rps`; `activeConnections()` itself never reads
  // this field, so the connection-count formula is untouched. 1 for keep-alive/short-lived (rps
  // already means "requests", i.e. 1 frame per unit) and for an unauthored stream — the exact
  // pre-issue 1:1 rps:frame reading, so an existing `.scalemap`'s stream packets are unchanged.
  frameMultiplier: number
}

// The identity: hold == latency, nothing extra, no CPU. Frozen so no caller can mutate the shared
// constant out from under the regression floor.
export const KEEP_ALIVE_PROFILE: ConnectionProfile = Object.freeze({
  latencyShare: 1, fixedHoldSec: 0, extraHoldSec: 0, handshakeCpuMs: 0, frameMultiplier: 1,
})

// `holdSeconds` lives on the two kinds that can be persistent. Non-positive/non-finite ⇒ absent.
function authoredHoldSec(tpl: PacketTemplate): number | undefined {
  if (tpl.protocol !== 'http' && tpl.protocol !== 'stream') return undefined
  return (tpl as HttpTemplate | StreamTemplate).holdSeconds
}

// `framesPerSecond` lives only on StreamTemplate (audit ISSUE-004). Non-positive/non-finite ⇒
// absent ⇒ the 1:1 rps:frame default.
function authoredFramesPerSecond(tpl: PacketTemplate): number | undefined {
  if (tpl.protocol !== 'stream') return undefined
  return tpl.framesPerSecond
}

/**
 * The connection class a template implies.
 *
 * PROTOCOL WINS for the non-http kinds: `ConnectionType` only exists on HttpTemplate, but
 * `protocol` describes the same axis for the others, and the protocol is the stronger statement.
 *   - http   → its authored connectionType (default keep-alive)
 *   - stream → streaming; a stream IS a persistent connection by definition
 *   - db     → keep-alive; real DB clients pool
 *   - event  → keep-alive; broker connections are long-lived and shared
 */
export function connectionClassOf(tpl: PacketTemplate | undefined): ConnectionClass {
  if (!tpl) return 'keep-alive'
  if (tpl.protocol === 'stream') return 'streaming'
  if (tpl.protocol === 'http') return (tpl as HttpTemplate).connectionType ?? 'keep-alive'
  return 'keep-alive'
}

/**
 * The profile for one pure class. `holdSeconds` is read only by `streaming`; `framesPerSecond`
 * (audit ISSUE-004) likewise — absent/non-positive ⇒ frameMultiplier 1, the pre-issue identity.
 */
export function profileFor(cls: ConnectionClass, holdSeconds?: number, framesPerSecond?: number): ConnectionProfile {
  switch (cls) {
    case 'short-lived':
      return {
        latencyShare: 1,
        fixedHoldSec: 0,
        extraHoldSec: (HANDSHAKE_MS + LINGER_MS) / 1000,
        handshakeCpuMs: HANDSHAKE_CPU_MS,
        frameMultiplier: 1,
      }
    case 'streaming': {
      const hold = holdSeconds != null && Number.isFinite(holdSeconds) && holdSeconds > 0
        ? holdSeconds
        : DEFAULT_HOLD_SEC
      const frameMultiplier = framesPerSecond != null && Number.isFinite(framesPerSecond) && framesPerSecond > 0
        ? framesPerSecond
        : 1
      return { latencyShare: 0, fixedHoldSec: hold, extraHoldSec: 0, handshakeCpuMs: 0, frameMultiplier }
    }
    case 'keep-alive':
    default:
      return KEEP_ALIVE_PROFILE
  }
}

/**
 * Weighted blend of the connection profiles across a bound packet mix — the exact shape
 * `resolveWireSize` uses for sizes, so the two resolvers stay recognizably the same idiom.
 *
 * Entries referencing a deleted packet are ignored (defensive: the store cascades on delete, but a
 * hand-authored file may dangle). A mix that is absent, empty, all-dangling, or whose weights sum
 * to <= 0 falls through to `fallback` — keep-alive unless the caller knows better.
 */
export function resolveConnectionProfile(
  reg: PacketRegistry,
  mix: PacketMixEntry[] | undefined,
  fallback: ConnectionClass = 'keep-alive',
): ConnectionProfile {
  const resolved = (mix ?? [])
    .map(e => ({ entry: e, tpl: reg.templates[e.packetId] as PacketTemplate | undefined }))
    .filter((x): x is { entry: PacketMixEntry; tpl: PacketTemplate } =>
      x.tpl != null && Number.isFinite(x.entry.weight) && x.entry.weight > 0)

  const totalWeight = resolved.reduce((sum, x) => sum + x.entry.weight, 0)
  if (resolved.length === 0 || totalWeight <= 0) return profileFor(fallback)

  let latencyShare = 0
  let fixedHoldSec = 0
  let extraHoldSec = 0
  let handshakeCpuMs = 0
  let frameMultiplier = 0
  for (const { entry, tpl } of resolved) {
    const w = entry.weight / totalWeight
    const p = profileFor(connectionClassOf(tpl), authoredHoldSec(tpl), authoredFramesPerSecond(tpl))
    latencyShare += w * p.latencyShare
    fixedHoldSec += w * p.fixedHoldSec
    extraHoldSec += w * p.extraHoldSec
    handshakeCpuMs += w * p.handshakeCpuMs
    frameMultiplier += w * p.frameMultiplier
  }
  return { latencyShare, fixedHoldSec, extraHoldSec, handshakeCpuMs, frameMultiplier }
}

/**
 * The rps a caller should feed into NIC/byte/cpuMsPerKb accounting instead of raw connection rps
 * (audit ISSUE-004) — `rps × frameMultiplier`. For every class except an authored streaming
 * profile this is the identity (`frameMultiplier` is 1), so an existing world's byte/CPU
 * accounting is unchanged; `activeConnections()` above is deliberately untouched by this — it
 * keeps meaning "connection rate", never "frame rate".
 */
export function resolvedFrameRps(rps: number, p: ConnectionProfile): number {
  return rps * p.frameMultiplier
}

/**
 * THE connection formula — Little's law, parameterized by the profile. Both engine call sites go
 * through this; see the module header on why that matters.
 *
 *   connections = rps × (latencyShare × latencyMs/1000 + extraHoldSec + fixedHoldSec)
 *
 * With KEEP_ALIVE_PROFILE this is EXACTLY `rps * (latencyMs / 1000)` — same expression, same
 * floating-point result, no added terms. That identity is the phase's regression floor.
 */
export function activeConnections(rps: number, latencyMs: number, p: ConnectionProfile): number {
  if (!Number.isFinite(rps) || rps <= 0) return 0
  if (p.latencyShare === 1 && p.fixedHoldSec === 0 && p.extraHoldSec === 0) {
    // Spelled out rather than folded into the general expression below so the identity is
    // bit-exact, not merely algebraically equal (`1 * x + 0 + 0` is not guaranteed to round the
    // same way as `x` for every input, and the golden engine tests compare exact numbers).
    return Number.isFinite(latencyMs) ? rps * (latencyMs / 1000) : 0
  }
  const coupled = Number.isFinite(latencyMs) ? p.latencyShare * (latencyMs / 1000) : 0
  return rps * (coupled + p.extraHoldSec + p.fixedHoldSec)
}
