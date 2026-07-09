// src/app/world/server/gateStats.ts
import type { EngineEvent } from '../../../lib/worldEngine/types'

// Refused connections attributed to this server within the trailing window, per second.
// The engine emits connection_refused events with the source+target INSTANCE ids in
// `affected`, not the serverId — so a refused event is attributed here if `affected`
// contains this server's serverId directly (defensive) OR any of its resident instance
// ids (the real engine shape). This correctly attributes both a resident's refused
// outbound connection and a refused inbound connection to a resident, since both belong
// at this server's gate.
export function blockedPerSecond(
  events: EngineEvent[], serverId: string, residentInstanceIds: string[], nowSimMs: number, windowMs = 5000,
): number {
  const lo = nowSimMs - windowMs
  // `serverId` itself is included defensively/for back-compat — the current engine only ever
  // stamps instance ids (never the serverId) into `affected`, so `residentInstanceIds` is the
  // load-bearing half of this set; the serverId branch exists in case that ever changes upstream.
  const ids = new Set<string>([serverId, ...residentInstanceIds])
  let count = 0
  for (const e of events) {
    if (e.kind !== 'connection_refused') continue
    if (e.simMs <= lo || e.simMs > nowSimMs) continue
    if (e.affected.some(a => ids.has(a))) count++
  }
  return count / (windowMs / 1000)
}
