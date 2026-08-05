// src/app/world/server/useServerDisplayMetrics.ts
// Scrub-aware slice of the metrics pyramid for one server + its resident instances (D5).
// Plain store selector — no renderer subscription, no per-frame setState (T14 lesson).
import { useMemo } from 'react'
import { useSimulationStore } from '../../store/simulation.store'
import type { ServerMetrics, InstanceMetrics } from '../../../lib/worldEngine/types'
import type { InstanceId, PlacementId } from '../../../lib/world/types'   // id types live in world/types, NOT re-exported by worldEngine/types

export interface ServerDisplay {
  server: ServerMetrics | null
  instances: Record<InstanceId, InstanceMetrics>
  scrubbing: boolean
  // FEAT-008 (Task 21): the batch-level (not server-level) running-instance count per
  // autoscaled placement — published verbatim off `MetricsBatch.runningByPlacement` (Task 16).
  // Undefined when the batch predates any autoscale (or there is no batch yet); {} is a real,
  // distinct "autoscale exists, nothing running yet" state (same convention the batch field
  // itself documents) — never re-derived here, matching the two-call-site divergence-guard
  // discipline the engine enforces for `activeConnections`.
  runningByPlacement: Record<PlacementId, number> | undefined
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
      runningByPlacement: batch?.runningByPlacement,
    }
  }, [scrubBatch, latestBatch, serverId])
}
