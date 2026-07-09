import { useShallow } from 'zustand/react/shallow'
import { useSimulationStore, type NodeMetrics } from '../../store/simulationLegacy.store'
import { useReplayStore } from '../../store/replay.store'

// Single indirection so consumers don't each branch on replay state:
// while replaying, return the recorded metrics at the scrub cursor; otherwise live metrics.

export function useDisplayMetrics(nodeId: string): NodeMetrics | null {
  const isReplaying = useReplayStore(s => s.isReplaying)
  const replayMetrics = useReplayStore(s => (s.isReplaying ? s.metricsAt(nodeId) : null))
  const liveMetrics = useSimulationStore(useShallow(s => s.nodeMetrics.get(nodeId) ?? null))
  return isReplaying ? replayMetrics : liveMetrics
}

export function useDisplayMetricsMap(): Map<string, NodeMetrics> {
  const isReplaying = useReplayStore(s => s.isReplaying)
  const replayMap = useReplayStore(s => (s.isReplaying ? s.currentMetricsMap() : null))
  const liveMap = useSimulationStore(s => s.nodeMetrics)
  return (isReplaying ? replayMap : liveMap) ?? liveMap
}
