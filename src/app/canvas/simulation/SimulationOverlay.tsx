import { useEffect, useRef, useCallback } from 'react'
import type { Node, Edge } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvas.store'
import { useSimulationStore, type SimEventType, type NodeMetrics, type SimulationRun } from '../../store/simulation.store'
import { useMetricsHistoryStore } from '../../store/metricsHistory.store'
import { DEFAULT_SLO } from '../../simulation/defaults'
import type { NodeData, NodeType } from '../../../lib/nodeConfig'
import {
  startSimulation,
  stopSimulation,
  updateSpeed,
  updateTrafficMode,
  updateGlobalMultiplier,
  setNodeConfigs,
  setCallbacks,
  pickParticleAtPoint,
} from './particleEngine'

function getTopoKey(ns: Node[], es: Edge[]): string {
  const nk = ns.map(n => `${n.id}:${n.type}:${~~n.position.x},${~~n.position.y}`).sort().join(';')
  const ek = es.map(e => `${e.source}→${e.target}`).sort().join(';')
  return `${nk}|${ek}`
}

interface Props {
  width: number
  height: number
}

export function SimulationOverlay({ width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const prevTopoRef = useRef('')
  const { nodes, edges } = useCanvasStore()
  const {
    running, speed,
    simulationMode, globalMultiplier, nodeConfigs,
    setAllNodeMetrics, markBottleneck, addEvent,
  } = useSimulationStore()

  const simStartRef    = useRef<number>(0)
  const prevSloRef     = useRef<Map<string, boolean>>(new Map())
  const mouseDownRef   = useRef<{ x: number; y: number } | null>(null)
  const setInspectedRequest = useSimulationStore(s => s.setInspectedRequest)

  // Peak metric tracking for SimulationRun summary
  const peakRpsRef  = useRef(0)
  const peakUtilRef = useRef(0)
  const sumErrRef   = useRef(0)
  const errTicksRef = useRef(0)

  const onNodeMetrics = useCallback(
    (batch: Map<string, NodeMetrics>) => setAllNodeMetrics(batch),
    [setAllNodeMetrics],
  )

  const onBottleneck = useCallback(
    (nodeId: string, isSaturated: boolean) => markBottleneck(nodeId, isSaturated),
    [markBottleneck],
  )

  const onEvent = useCallback(
    (type: SimEventType, nodeId: string | undefined, message: string, severity: 'info' | 'warn' | 'critical', snapshot?: Partial<NodeMetrics>, causedByNodeId?: string) => {
      const elapsedS = Math.round((Date.now() - simStartRef.current) / 1000)
      addEvent({ type, nodeId, at: Date.now(), elapsedS, message, severity, metricsSnapshot: snapshot, causedByNodeId })
    },
    [addEvent],
  )

  // Register callbacks once (stable refs)
  useEffect(() => {
    setCallbacks(onNodeMetrics, onBottleneck, onEvent)
  }, [onNodeMetrics, onBottleneck, onEvent])

  // Start / stop simulation
  useEffect(() => {
    if (!canvasRef.current) return
    if (running) {
      simStartRef.current = Date.now()
      prevTopoRef.current = getTopoKey(nodes, edges)
      prevSloRef.current.clear()
      peakRpsRef.current  = 0
      peakUtilRef.current = 0
      sumErrRef.current   = 0
      errTicksRef.current = 0
      startSimulation(canvasRef.current, nodes, edges, speed)
      addEvent({
        type: 'simulation_start',
        nodeId: undefined,
        at: Date.now(),
        elapsedS: 0,
        message: `${simulationMode} mode · ${globalMultiplier}× volume`,
        severity: 'info',
      })
    } else {
      stopSimulation()
      // Build SimulationRun summary (only for meaningful runs > 2s)
      const endedAt  = Date.now()
      const durationS = Math.round((endedAt - simStartRef.current) / 1000)
      if (durationS > 2) {
        const { events, nodeMetrics, bottlenecks, sloStatus, pushRun } = useSimulationStore.getState()
        const sloViolations = [...sloStatus.values()].filter(s => !s.passing).length
        const avgErrorRate  = errTicksRef.current > 0 ? sumErrRef.current / errTicksRef.current : 0
        const { simulationMode: mode, globalMultiplier: mult } = useSimulationStore.getState()
        const run: SimulationRun = {
          id: String(Date.now()),
          startedAt: simStartRef.current,
          endedAt,
          durationS,
          peakRps: peakRpsRef.current,
          peakUtilization: peakUtilRef.current,
          avgErrorRate,
          sloViolations,
          bottleneckNodeIds: [...bottlenecks],
          events: [...events],
          nodeSnapshots: new Map(nodeMetrics),
          trafficMode: mode,
          globalMultiplier: mult,
        }
        pushRun(run)
      }
    }
    return () => { stopSimulation() }
  }, [running]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restart when topology changes while running (ignore selection-only changes)
  useEffect(() => {
    if (!running || !canvasRef.current) return
    const key = getTopoKey(nodes, edges)
    if (key === prevTopoRef.current) return
    prevTopoRef.current = key
    startSimulation(canvasRef.current, nodes, edges, speed)
  }, [nodes, edges]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync scalar engine settings
  useEffect(() => { updateSpeed(speed) }, [speed])
  useEffect(() => { updateTrafficMode(simulationMode) }, [simulationMode])
  useEffect(() => { updateGlobalMultiplier(globalMultiplier) }, [globalMultiplier])
  useEffect(() => { setNodeConfigs(nodeConfigs) }, [nodeConfigs])

  // 1s interval: record history + check SLOs + update peak trackers
  useEffect(() => {
    if (!running) return
    const { record, recordSystem } = useMetricsHistoryStore.getState()

    const interval = setInterval(() => {
      const { nodeMetrics, addEvent: addEv, setSloStatus: setSlo, paused } = useSimulationStore.getState()
      // Don't record history or fire SLO events while paused — analytics must be frozen
      if (paused) return
      const elapsedS = Math.round((Date.now() - simStartRef.current) / 1000)
      let totalRps  = 0
      let totalUtil = 0
      let totalErr  = 0
      let count     = 0

      for (const [nodeId, metrics] of nodeMetrics) {
        record(nodeId, {
          t: performance.now(),
          inRps: metrics.inRps,
          utilization: metrics.utilization,
          errorRate: metrics.errorRate,
          p90LatencyMs: metrics.p90LatencyMs,
        })

        // SLO check
        const node    = nodes.find(n => n.id === nodeId)
        const nodeType = node?.type as NodeType | undefined
        const nodeSlo = (node?.data as NodeData)?.slo ?? (nodeType ? DEFAULT_SLO[nodeType] : undefined)

        if (nodeSlo) {
          const violations: string[] = []
          if (nodeSlo.maxP90LatencyMs !== undefined && metrics.p90LatencyMs > nodeSlo.maxP90LatencyMs)
            violations.push(`P90 latency ${Math.round(metrics.p90LatencyMs)}ms > ${nodeSlo.maxP90LatencyMs}ms`)
          if (nodeSlo.maxErrorRate !== undefined && metrics.errorRate > nodeSlo.maxErrorRate)
            violations.push(`Error rate ${(metrics.errorRate * 100).toFixed(1)}% > ${(nodeSlo.maxErrorRate * 100).toFixed(1)}%`)
          if (nodeSlo.maxUtilization !== undefined && metrics.utilization > nodeSlo.maxUtilization)
            violations.push(`Utilization ${Math.round(metrics.utilization * 100)}% > ${Math.round(nodeSlo.maxUtilization * 100)}%`)

          const nowPassing = violations.length === 0
          const wasPassing = prevSloRef.current.get(nodeId) ?? true

          setSlo(nodeId, { passing: nowPassing, violations })

          if (wasPassing && !nowPassing) {
            const label = (node?.data as NodeData)?.label ?? nodeId
            addEv({ type: 'slo_violation', nodeId, at: performance.now(), elapsedS, message: `${label} SLO breached: ${violations[0]}`, severity: 'warn', metricsSnapshot: { utilization: metrics.utilization, errorRate: metrics.errorRate, p90LatencyMs: metrics.p90LatencyMs } })
          } else if (!wasPassing && nowPassing) {
            const label = (node?.data as NodeData)?.label ?? nodeId
            addEv({ type: 'slo_recovery', nodeId, at: performance.now(), elapsedS, message: `${label} SLO recovered`, severity: 'info' })
          }
          prevSloRef.current.set(nodeId, nowPassing)
        }

        totalRps  += metrics.inRps
        totalUtil += metrics.utilization
        totalErr  += metrics.errorRate
        count++
      }

      // Update peak trackers
      if (count > 0) {
        const avgUtil = totalUtil / count
        const avgErr  = totalErr / count
        if (totalRps  > peakRpsRef.current)  peakRpsRef.current  = totalRps
        if (avgUtil   > peakUtilRef.current) peakUtilRef.current = avgUtil
        sumErrRef.current   += avgErr
        errTicksRef.current += 1

        recordSystem({
          t: performance.now(),
          inRps: totalRps / 2,
          utilization: avgUtil,
          errorRate: avgErr,
          p90LatencyMs: 0,
        })
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [running, nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        pointerEvents: running ? 'auto' : 'none',
        cursor: running ? 'crosshair' : 'default',
      }}
      onMouseDown={e => { mouseDownRef.current = { x: e.clientX, y: e.clientY } }}
      onMouseUp={e => {
        const down = mouseDownRef.current
        mouseDownRef.current = null
        if (!down || !canvasRef.current) return
        const dx = e.clientX - down.x
        const dy = e.clientY - down.y
        if (Math.sqrt(dx * dx + dy * dy) >= 5) return  // was a drag, not a click
        const rect = canvasRef.current.getBoundingClientRect()
        const snap = pickParticleAtPoint(e.clientX, e.clientY, rect)
        setInspectedRequest(snap)  // null clears the panel on a miss
      }}
    />
  )
}
