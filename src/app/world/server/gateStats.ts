// src/app/world/server/gateStats.ts
import type { EngineEvent } from '../../../lib/worldEngine/types'

// Refused connections attributed to this server within the trailing window, per second.
export function blockedPerSecond(
  events: EngineEvent[], serverId: string, nowSimMs: number, windowMs = 5000,
): number {
  const lo = nowSimMs - windowMs
  let count = 0
  for (const e of events) {
    if (e.kind !== 'connection_refused') continue
    if (e.simMs <= lo || e.simMs > nowSimMs) continue
    if (e.affected.includes(serverId)) count++
  }
  return count / (windowMs / 1000)
}
