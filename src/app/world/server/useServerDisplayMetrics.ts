// src/app/world/server/useServerDisplayMetrics.ts
// Scrub-aware slice of the metrics pyramid for one server + its resident instances (D5).
// Plain store selector — no renderer subscription, no per-frame setState (T14 lesson).
import { useMemo } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import type { ServerMetrics, InstanceMetrics } from '../../../lib/worldEngine/types'
import type { InstanceId } from '../../../lib/world/types'   // id types live in world/types, NOT re-exported by worldEngine/types

export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
}

export function useServerDisplayMetrics(serverId: string): ServerDisplay {
  const scrubBatch = useSimulationStore(s => s.scrubBatch)
  const latestBatch = useSimulationStore(s => s.latestBatch)
  return useMemo(() => {
    const batch = scrubBatch ?? latestBatch
    return {
      server: batch?.servers[serverId] ?? null,
      instances: batch?.instances ?? {},
      scrubbing: scrubBatch !== null,
    }
  }, [scrubBatch, latestBatch, serverId])
}
