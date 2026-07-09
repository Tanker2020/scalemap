// EngineEvent construction + bounded ring. The facade owns the id sequence (idSeq param)
// so event ids stay monotonic across subsystems.
import type { EngineEvent, EngineEventKind } from './types'

export interface EventRing {
  push(e: EngineEvent): void
  drain(): EngineEvent[]   // events pushed since the last drain (ReplayFrame windows)
  all(): EngineEvent[]     // retained ring, oldest → newest
}

export function createEventRing(cap = 500): EventRing {
  const ring: EngineEvent[] = []
  let pending: EngineEvent[] = []
  return {
    push(e) {
      ring.push(e)
      if (ring.length > cap) ring.splice(0, ring.length - cap)
      pending.push(e)
    },
    drain() {
      const out = pending
      pending = []
      return out
    },
    all() {
      return [...ring]
    },
  }
}

export function mkEvent(
  kind: EngineEventKind,
  severity: EngineEvent['severity'],
  message: string,
  affected: string[],
  simMs: number,
  idSeq: number,
): EngineEvent {
  return { id: `evt-${idSeq}`, simMs, kind, severity, message, affected }
}
