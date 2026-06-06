import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Search, SlidersHorizontal, ChevronUp, ChevronDown, Activity, Bell } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { NODE_CONFIG, GROUPING_TYPES, type NodeType, type TrafficOrigin } from '../../lib/nodeConfig'
import { WORLD_REGIONS, REGIONS_BY_ZONE } from '../../lib/regionConfig'
import { NODE_SIM_DEFAULTS, DEFAULT_SLO } from './defaults'
import { CATEGORY_COLORS } from '../../lib/theme'
import { Sparkline } from '../sidebar/Sparkline'
import { MetricGraphOverlay, type GraphMetric } from '../analytics/MetricGraphOverlay'
import { EventLogPanel } from './EventLogPanel'
import type { NodeData, NodeSlo } from '../../lib/nodeConfig'
import styles from './SimConfigPanel.module.css'

// ─── Numeric stepper ──────────────────────────────────────────────────────────

function NumericStepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
}) {
  const inc = () => onChange(max !== undefined ? Math.min(max, value + step) : value + step)
  const dec = () => onChange(Math.max(min, value - step))

  return (
    <div className={styles.stepper}>
      <input
        className={styles.stepInput}
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={e => {
          const n = Number(e.target.value)
          if (!isNaN(n)) onChange(max !== undefined ? Math.min(max, Math.max(min, n)) : Math.max(min, n))
        }}
      />
      <div className={styles.stepBtns}>
        <button className={styles.stepBtn} onClick={inc} tabIndex={-1} title="Increase">
          <ChevronUp size={8} />
        </button>
        <button className={styles.stepBtn} onClick={dec} tabIndex={-1} title="Decrease">
          <ChevronDown size={8} />
        </button>
      </div>
    </div>
  )
}

// ─── Util mini-bar ────────────────────────────────────────────────────────────

function UtilBar({ value }: { value: number }) {
  const color = value >= 0.8 ? '#EF4444' : value >= 0.5 ? '#F59E0B' : '#22C55E'
  return (
    <div className={styles.utilBar}>
      <div className={styles.utilFill} style={{ width: `${Math.min(1, value) * 100}%`, background: color }} />
    </div>
  )
}

// ─── Event type helpers ───────────────────────────────────────────────────────

type SimEventType = import('../store/simulation.store').SimEventType

const EVENT_META: Record<SimEventType, { label: string; icon: string }> = {
  saturation_start:          { label: 'Saturated',          icon: '⚠' },
  saturation_end:            { label: 'Recovered',          icon: '✓' },
  circuit_open:              { label: 'Circuit Open',       icon: '⊘' },
  circuit_close:             { label: 'Circuit Closed',     icon: '✓' },
  circuit_half_open:         { label: 'Half-Open',          icon: '⊡' },
  cascade_detected:          { label: 'Cascade',            icon: '↯' },
  simulation_start:          { label: 'Sim Started',        icon: '▶' },
  simulation_stop:           { label: 'Sim Stopped',        icon: '■' },
  chaos_failure:             { label: 'Chaos Failure',      icon: '✕' },
  chaos_recovery:            { label: 'Chaos Recovery',     icon: '✓' },
  connection_pool_exhausted: { label: 'Pool Exhausted',     icon: '⛔' },
  lambda_cold_start:         { label: 'Cold Start',         icon: '❄' },
  request_timeout:           { label: 'Timeout',            icon: '⏱' },
  slo_violation:             { label: 'SLO Violated',       icon: '✗' },
  slo_recovery:              { label: 'SLO Recovered',      icon: '✓' },
  autoscale_triggered:       { label: 'Scaling Out',        icon: '⬆' },
  autoscale_complete:        { label: 'Scale Complete',     icon: '✓' },
  autoscale_scaledin:        { label: 'Scaled In',          icon: '⬇' },
  crash_loop_detected:       { label: 'Crash Loop',         icon: '⚡' },
  retry_storm:               { label: 'Retry Storm',         icon: '↺' },
}

type SimEvent = import('../store/simulation.store').SimEvent

function EventDetailOverlay({
  ev, meta, nodeLabel, nodeType, nodeConfig, severityColor, onClose,
}: {
  ev: SimEvent
  meta: { label: string; icon: string }
  nodeLabel: string
  nodeType?: NodeType
  nodeConfig?: typeof NODE_CONFIG[NodeType]
  severityColor: string
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const snap = ev.metricsSnapshot
  const ts   = new Date(ev.at).toLocaleTimeString()
  const NodeIcon = nodeConfig?.icon

  return (
    <div className={styles.detailOverlayBackdrop} onClick={onClose}>
      <div className={styles.detailOverlayCard} onClick={e => e.stopPropagation()}>
        <div className={styles.detailOverlayHeader}>
          <span className={styles.detailOverlayBadge} style={{ color: severityColor, borderColor: severityColor + '55' }}>
            {meta.icon} {meta.label.toUpperCase()}
          </span>
          <button className={styles.detailOverlayClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.detailOverlayBody}>
          {nodeLabel && (
            <div className={styles.detailOverlayRow}>
              <span className={styles.detailOverlayRowLabel}>Node</span>
              <span className={styles.detailOverlayRowVal}>
                {NodeIcon && <NodeIcon size={11} />}
                {nodeLabel}
                {nodeType && <span className={styles.detailOverlayNodeType}>{nodeType}</span>}
              </span>
            </div>
          )}
          <div className={styles.detailOverlayRow}>
            <span className={styles.detailOverlayRowLabel}>Time</span>
            <span className={styles.detailOverlayRowVal}>{ts} · +{ev.elapsedS}s into run</span>
          </div>
          <div className={styles.detailOverlayRow}>
            <span className={styles.detailOverlayRowLabel}>Detail</span>
            <span className={styles.detailOverlayRowVal} style={{ color: '#CBD5E1' }}>{ev.message}</span>
          </div>
          {snap && (snap.p90LatencyMs !== undefined || snap.utilization !== undefined || snap.errorRate !== undefined) && (
            <div className={styles.detailOverlayMetrics}>
              {snap.p90LatencyMs !== undefined && (
                <div className={styles.detailOverlayMetric}>
                  <span className={styles.detailOverlayMetricLabel}>P90 Latency</span>
                  <span className={styles.detailOverlayMetricVal}>{Math.round(snap.p90LatencyMs)}ms</span>
                </div>
              )}
              {snap.utilization !== undefined && (
                <div className={styles.detailOverlayMetric}>
                  <span className={styles.detailOverlayMetricLabel}>Utilization</span>
                  <span className={styles.detailOverlayMetricVal} style={{ color: snap.utilization >= 1 ? '#EF4444' : snap.utilization >= 0.8 ? '#F59E0B' : '#22C55E' }}>
                    {Math.round(snap.utilization * 100)}%
                  </span>
                </div>
              )}
              {snap.errorRate !== undefined && (
                <div className={styles.detailOverlayMetric}>
                  <span className={styles.detailOverlayMetricLabel}>Error Rate</span>
                  <span className={styles.detailOverlayMetricVal} style={{ color: snap.errorRate > 0.01 ? '#EF4444' : '#22C55E' }}>
                    {(snap.errorRate * 100).toFixed(2)}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function EventCard({ ev }: { ev: SimEvent }) {
  const [detailOpen, setDetailOpen] = useState(false)
  const meta = EVENT_META[ev.type] ?? { label: ev.type, icon: '●' }
  const severityColor =
    ev.severity === 'critical' ? '#EF4444' :
    ev.severity === 'warn'     ? '#F59E0B' : '#4A9EFF'
  const severityBg =
    ev.severity === 'critical' ? '#EF444408' :
    ev.severity === 'warn'     ? '#F59E0B08' : '#4A9EFF06'

  const { nodes } = useCanvasStore()
  const node        = ev.nodeId ? nodes.find(n => n.id === ev.nodeId) : undefined
  const nodeLabel   = (node?.data as NodeData)?.label ?? ev.nodeId ?? ''
  const nodeType    = node?.type as NodeType | undefined
  const nodeConfig  = nodeType ? NODE_CONFIG[nodeType] : undefined
  const snap        = ev.metricsSnapshot

  return (
    <>
      <button
        className={styles.eventCard}
        style={{ background: severityBg, borderLeftColor: severityColor }}
        onClick={() => setDetailOpen(true)}
      >
        <div className={styles.eventCardHead}>
          <span className={styles.eventCardDot} style={{ color: severityColor }}>◉</span>
          <span className={styles.eventCardType} style={{ color: severityColor }}>{meta.label.toUpperCase()}</span>
          {nodeLabel && <span className={styles.eventCardNodeName}>{nodeLabel}</span>}
          <span className={styles.eventCardTime}>+{ev.elapsedS}s</span>
          <span className={styles.eventCardArrow}>→</span>
        </div>
        <div className={styles.eventCardMsg}>{ev.message}</div>
        {snap && (snap.p90LatencyMs !== undefined || snap.utilization !== undefined || snap.errorRate !== undefined) && (
          <div className={styles.eventMetricPills}>
            {snap.p90LatencyMs !== undefined && <span className={styles.eventMetricPill}>P90: {Math.round(snap.p90LatencyMs)}ms</span>}
            {snap.utilization  !== undefined && <span className={styles.eventMetricPill}>Util: {Math.round(snap.utilization * 100)}%</span>}
            {snap.errorRate    !== undefined && <span className={styles.eventMetricPill}>Err: {(snap.errorRate * 100).toFixed(1)}%</span>}
          </div>
        )}
      </button>
      {detailOpen && (
        <EventDetailOverlay
          ev={ev} meta={meta} nodeLabel={nodeLabel} nodeType={nodeType}
          nodeConfig={nodeConfig} severityColor={severityColor}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </>
  )
}

// ─── Node row in list ─────────────────────────────────────────────────────────

function NodeRow({
  nodeId,
  selected,
  onClick,
}: {
  nodeId: string
  selected: boolean
  onClick: () => void
}) {
  const { nodes } = useCanvasStore()
  const running     = useSimulationStore(s => s.running)
  const metrics     = useSimulationStore(
    useShallow(s => { const m = s.nodeMetrics.get(nodeId); return m ? { utilization: m.utilization } : null }),
  )
  const bottlenecks = useSimulationStore(s => s.bottlenecks)
  const sloStatus   = useSimulationStore(s => s.sloStatus.get(nodeId))

  const node = nodes.find(n => n.id === nodeId)
  if (!node) return null

  const nodeType = node.type as NodeType
  const config = NODE_CONFIG[nodeType]
  const data = node.data as NodeData
  const colors = config ? CATEGORY_COLORS[config.category] : CATEGORY_COLORS.compute

  const util = metrics?.utilization ?? 0
  const isSaturated = bottlenecks.has(nodeId)
  const sloFailed = sloStatus?.passing === false

  let healthColor = '#2A2E38'
  if (running && metrics) {
    healthColor = isSaturated ? '#EF4444' : util >= 0.5 ? '#F59E0B' : '#22C55E'
  }

  return (
    <button
      className={`${styles.nodeRow} ${selected ? styles.nodeRowSelected : ''}`}
      onClick={onClick}
    >
      <span className={styles.healthDot} style={{ background: healthColor }} />
      <span className={styles.nodeIcon} style={{ color: colors.accent }}>
        {config?.icon && <config.icon size={11} />}
      </span>
      <span className={styles.nodeLabel}>{data.label || nodeType}</span>
      {running && metrics ? (
        <div className={styles.nodeMetaLive}>
          <UtilBar value={util} />
          {sloFailed && <span className={styles.sloFail}>SLO</span>}
        </div>
      ) : (
        <span className={styles.nodeTypeBadge} style={{ color: colors.accent }}>{nodeType}</span>
      )}
    </button>
  )
}

// ─── Config inputs ────────────────────────────────────────────────────────────

function ConfigSection({ nodeId }: { nodeId: string }) {
  const { nodes, updateNodeData } = useCanvasStore()
  const nodeConfigs   = useSimulationStore(s => s.nodeConfigs)
  const setNodeConfig = useSimulationStore(s => s.setNodeConfig)
  const running       = useSimulationStore(s => s.running)

  const node = nodes.find(n => n.id === nodeId)
  if (!node) return null

  const nodeType = node.type as NodeType
  const data     = node.data as NodeData
  const defaults = NODE_SIM_DEFAULTS[nodeType] ?? { maxRps: 1000, processingMs: 10, errorRate: 0 }
  const override = nodeConfigs.get(nodeId)
  const eff      = { ...defaults, ...override }

  const isQueue      = ['queue', 'pubsub', 'stream', 'eventBus'].includes(nodeType)
  const isLambda     = nodeType === 'lambda'
  const isAutoScale  = nodeType === 'k8sCluster' || nodeType === 'ecsCluster'
  const isEntryPoint = nodeType === 'cdn' || nodeType === 'loadBalancer' || nodeType === 'apiGateway'
  const hasConnPool = eff.connectionPool !== undefined
  const hasTimeout  = eff.timeoutMs !== undefined
  const slo: NodeSlo | undefined = data.slo ?? DEFAULT_SLO[nodeType]

  return (
    <>
      {running && (
        <div className={styles.configLockNotice}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18 10V7A6 6 0 0 0 6 7v3H4v12h16V10h-2zm-8-3a4 4 0 0 1 8 0v3h-8V7zm10 13H4V12h16v8z"/></svg>
          Stop simulation to edit configuration
        </div>
      )}
      <fieldset disabled={running} className={styles.configFieldset}>
      <div className={styles.configBlock}>
        <div className={styles.configBlockTitle}>Capacity</div>
        <div className={styles.configGrid}>
          <div className={styles.configField}>
            <span className={styles.configLabel}>Max RPS</span>
            <NumericStepper
              value={eff.maxRps}
              onChange={v => setNodeConfig(nodeId, { maxRps: v })}
              min={1}
              step={100}
            />
          </div>
          <div className={styles.configField}>
            <span className={styles.configLabel}>Processing (ms)</span>
            <NumericStepper
              value={eff.processingMs}
              onChange={v => setNodeConfig(nodeId, { processingMs: v })}
              min={0}
              step={5}
            />
          </div>
          <div className={styles.configField}>
            <span className={styles.configLabel}>Error Rate (%)</span>
            <NumericStepper
              value={Math.round(eff.errorRate * 100)}
              onChange={v => setNodeConfig(nodeId, { errorRate: v / 100 })}
              min={0}
              max={100}
              step={1}
            />
          </div>
          {!isQueue && !GROUPING_TYPES.has(nodeType) && (
            <div className={styles.configField}>
              <span className={styles.configLabel}>Fault Inject</span>
              <select
                value={eff.forcedHealthState ?? 'auto'}
                onChange={e => setNodeConfig(nodeId, { forcedHealthState: e.target.value as 'auto' | 'healthy' | 'degraded' | 'down' })}
                style={{
                  background: '#0D0F12', color: '#F1F5F9', border: '1px solid #2A2E38',
                  borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
                  cursor: 'pointer', width: '100%',
                }}
              >
                <option value="auto">Auto (score-based)</option>
                <option value="healthy">Force Healthy</option>
                <option value="degraded">Force Degraded</option>
                <option value="down">Force Down</option>
              </select>
            </div>
          )}
          {(nodeType === 'loadBalancer' || nodeType === 'apiGateway') && (
            <div className={styles.configField}>
              <span className={styles.configLabel}>Routing</span>
              <select
                value={eff.lbRouting ?? 'round-robin'}
                onChange={e => setNodeConfig(nodeId, { lbRouting: e.target.value as 'round-robin' | 'least-connections' })}
                style={{
                  background: '#0D0F12', color: '#F1F5F9', border: '1px solid #2A2E38',
                  borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
                  cursor: 'pointer', width: '100%',
                }}
              >
                <option value="round-robin">Round Robin</option>
                <option value="least-connections">Least Active Connections</option>
              </select>
            </div>
          )}
          {isLambda && (
            <div className={styles.configField}>
              <span className={styles.configLabel}>Max Concurrency</span>
              <NumericStepper
                value={eff.maxConcurrency ?? 10}
                onChange={v => setNodeConfig(nodeId, { maxConcurrency: v })}
                min={1}
                step={1}
              />
            </div>
          )}
          {isQueue && (
            <div className={styles.configField}>
              <span className={styles.configLabel}>Queue Capacity</span>
              <NumericStepper
                value={eff.queueCapacity ?? 1000}
                onChange={v => setNodeConfig(nodeId, { queueCapacity: v })}
                min={1}
                step={100}
              />
            </div>
          )}
        </div>
      </div>

      <div className={styles.configBlock}>
        <div className={styles.configBlockTitle}>SLO Targets</div>
        <div className={styles.configGrid}>
          <div className={styles.configField}>
            <span className={styles.configLabel}>P90 Latency (ms)</span>
            <NumericStepper
              value={slo?.maxP90LatencyMs ?? 0}
              onChange={v => updateNodeData(nodeId, {
                slo: { ...(data.slo ?? {}), maxP90LatencyMs: v || undefined }
              })}
              min={0}
              step={10}
            />
          </div>
          <div className={styles.configField}>
            <span className={styles.configLabel}>Max Error Rate (%)</span>
            <NumericStepper
              value={slo?.maxErrorRate !== undefined ? Math.round(slo.maxErrorRate * 100) : 0}
              onChange={v => updateNodeData(nodeId, {
                slo: { ...(data.slo ?? {}), maxErrorRate: v / 100 || undefined }
              })}
              min={0}
              max={100}
              step={1}
            />
          </div>
          <div className={styles.configField}>
            <span className={styles.configLabel}>Max Utilization (%)</span>
            <NumericStepper
              value={slo?.maxUtilization !== undefined ? Math.round(slo.maxUtilization * 100) : 0}
              onChange={v => updateNodeData(nodeId, {
                slo: { ...(data.slo ?? {}), maxUtilization: v / 100 || undefined }
              })}
              min={0}
              max={100}
              step={5}
            />
          </div>
        </div>
      </div>

      {/* Resource Limits — connection pools, timeouts, cold starts */}
      {(hasConnPool || hasTimeout || isLambda) && (
        <div className={styles.configBlock}>
          <div className={styles.configBlockTitle}>Resource Limits</div>
          <div className={styles.configGrid}>
            {hasConnPool && (
              <div className={styles.configField}>
                <span className={styles.configLabel}>Conn Pool Max</span>
                <NumericStepper
                  value={eff.connectionPool!.max}
                  onChange={v => setNodeConfig(nodeId, { connectionPool: { ...eff.connectionPool!, max: v } })}
                  min={1}
                  step={10}
                />
              </div>
            )}
            {hasTimeout && (
              <div className={styles.configField}>
                <span className={styles.configLabel}>Timeout (ms)</span>
                <NumericStepper
                  value={eff.timeoutMs!}
                  onChange={v => setNodeConfig(nodeId, { timeoutMs: v })}
                  min={100}
                  step={1000}
                />
              </div>
            )}
            {isLambda && (
              <>
                <div className={styles.configField}>
                  <span className={styles.configLabel}>Cold Start P50 (ms)</span>
                  <NumericStepper
                    value={eff.coldStart?.p50Ms ?? 400}
                    onChange={v => setNodeConfig(nodeId, { coldStart: { p50Ms: v, p99Ms: eff.coldStart?.p99Ms ?? 2500 } })}
                    min={50}
                    step={50}
                  />
                </div>
                <div className={styles.configField}>
                  <span className={styles.configLabel}>Max Warm Instances</span>
                  <NumericStepper
                    value={eff.maxWarmInstances ?? 5}
                    onChange={v => setNodeConfig(nodeId, { maxWarmInstances: v })}
                    min={0}
                    step={1}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Retry Strategy — shown for nodes that have a retryConfig */}
      {eff.retryConfig && (
        <div className={styles.configBlock}>
          <div className={styles.configBlockTitle}>Retry Strategy</div>
          <div className={styles.configGrid}>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Max Retries</span>
              <NumericStepper
                value={eff.retryConfig.maxRetries}
                onChange={v => setNodeConfig(nodeId, { retryConfig: { ...eff.retryConfig!, maxRetries: v } })}
                min={0}
                max={10}
                step={1}
              />
            </div>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Base Delay (ms)</span>
              <NumericStepper
                value={eff.retryConfig.baseDelayMs}
                onChange={v => setNodeConfig(nodeId, { retryConfig: { ...eff.retryConfig!, baseDelayMs: v } })}
                min={10}
                step={50}
              />
            </div>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Max Delay (ms)</span>
              <NumericStepper
                value={eff.retryConfig.maxDelayMs ?? 0}
                onChange={v => setNodeConfig(nodeId, { retryConfig: { ...eff.retryConfig!, maxDelayMs: v || undefined } })}
                min={0}
                step={500}
              />
            </div>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Jitter</span>
              <select
                value={eff.retryConfig.jitter}
                onChange={e => setNodeConfig(nodeId, { retryConfig: { ...eff.retryConfig!, jitter: e.target.value as 'full' | 'equal' } })}
                style={{
                  background: '#0D0F12', color: '#F1F5F9', border: '1px solid #2A2E38',
                  borderRadius: 4, padding: '2px 6px', fontSize: 11, fontFamily: 'inherit',
                  cursor: 'pointer', width: '100%',
                }}
              >
                <option value="full">Full (AWS-recommended)</option>
                <option value="equal">Equal (min spacing)</option>
              </select>
            </div>
          </div>
          {eff.retryConfig.maxRetries === 0 && (
            <div style={{ fontSize: 10, color: '#475569', marginTop: 4, paddingLeft: 2 }}>
              Retries disabled — dropped requests are permanently lost
            </div>
          )}
        </div>
      )}

      {/* Auto-Scaling — K8s / ECS only */}
      {isAutoScale && eff.autoScale && (
        <div className={styles.configBlock}>
          <div className={styles.configBlockTitle}>Auto-Scaling</div>
          <div className={styles.configGrid}>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Min Capacity (RPS)</span>
              <NumericStepper
                value={eff.autoScale.minCapacityRps}
                onChange={v => setNodeConfig(nodeId, { autoScale: { ...eff.autoScale!, minCapacityRps: v } })}
                min={1}
                step={100}
              />
            </div>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Max Capacity (RPS)</span>
              <NumericStepper
                value={eff.autoScale.maxCapacityRps}
                onChange={v => setNodeConfig(nodeId, { autoScale: { ...eff.autoScale!, maxCapacityRps: v } })}
                min={1}
                step={500}
              />
            </div>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Scale-out Threshold (%)</span>
              <NumericStepper
                value={Math.round(eff.autoScale.scaleOutThreshold * 100)}
                onChange={v => setNodeConfig(nodeId, { autoScale: { ...eff.autoScale!, scaleOutThreshold: v / 100 } })}
                min={1}
                max={100}
                step={5}
              />
            </div>
            <div className={styles.configField}>
              <span className={styles.configLabel}>Scale-out Delay (s)</span>
              <NumericStepper
                value={eff.autoScale.scaleOutDelayMs / 1000}
                onChange={v => setNodeConfig(nodeId, { autoScale: { ...eff.autoScale!, scaleOutDelayMs: v * 1000 } })}
                min={1}
                step={5}
              />
            </div>
            {eff.selfHealing && (
              <div className={styles.configField}>
                <span className={styles.configLabel}>Restart Delay (s)</span>
                <NumericStepper
                  value={eff.selfHealing.restartDelayMs / 1000}
                  onChange={v => setNodeConfig(nodeId, { selfHealing: { ...eff.selfHealing!, restartDelayMs: v * 1000 } })}
                  min={1}
                  step={5}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Traffic Origins — CDN / LB / API Gateway only */}
      {isEntryPoint && (() => {
        const origins: TrafficOrigin[] = eff.trafficOrigins ?? []
        const totalWeight = Math.round(origins.reduce((s, o) => s + o.weight, 0) * 100)
        const selectStyle: React.CSSProperties = {
          background: '#0D0F12', color: '#F1F5F9', border: '1px solid #2A2E38',
          borderRadius: 4, padding: '2px 4px', fontSize: 10, fontFamily: 'inherit',
          cursor: 'pointer', flex: 1, minWidth: 0,
        }
        const updateOrigins = (next: TrafficOrigin[]) => setNodeConfig(nodeId, { trafficOrigins: next })
        return (
          <div className={styles.configBlock}>
            <div className={styles.configBlockTitle}>Traffic Origins</div>
            {origins.map((origin, i) => (
              <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                <select
                  value={origin.regionId}
                  style={selectStyle}
                  onChange={e => {
                    const region = WORLD_REGIONS.find(r => r.id === e.target.value)
                    const next = origins.map((o, j) => j === i
                      ? { ...o, regionId: e.target.value, baseLatencyMs: region?.baseLatencyMs ?? o.baseLatencyMs }
                      : o)
                    updateOrigins(next)
                  }}
                >
                  <optgroup label="AMER">
                    {REGIONS_BY_ZONE.AMER.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </optgroup>
                  <optgroup label="EMEA">
                    {REGIONS_BY_ZONE.EMEA.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </optgroup>
                  <optgroup label="APAC">
                    {REGIONS_BY_ZONE.APAC.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </optgroup>
                </select>
                <NumericStepper
                  value={Math.round(origin.weight * 100)}
                  onChange={v => updateOrigins(origins.map((o, j) => j === i ? { ...o, weight: v / 100 } : o))}
                  min={1} max={100} step={5}
                />
                <span style={{ fontSize: 10, color: '#94A3B8' }}>%</span>
                <NumericStepper
                  value={origin.baseLatencyMs}
                  onChange={v => updateOrigins(origins.map((o, j) => j === i ? { ...o, baseLatencyMs: v } : o))}
                  min={0} step={5}
                />
                <span style={{ fontSize: 10, color: '#94A3B8' }}>ms</span>
                <button
                  onClick={() => updateOrigins(origins.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: '0 2px', fontSize: 13, lineHeight: 1 }}
                >×</button>
              </div>
            ))}
            {totalWeight !== 100 && origins.length > 0 && (
              <div style={{ fontSize: 10, color: '#F59E0B', marginBottom: 4 }}>
                Weights sum to {totalWeight}% — should be 100%
              </div>
            )}
            <button
              onClick={() => updateOrigins([...origins, { regionId: 'us-east-1', weight: 0.5, baseLatencyMs: 15 }])}
              style={{ fontSize: 10, color: '#4A9EFF', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
            >
              + Add origin
            </button>
          </div>
        )
      })()}
      </fieldset>
    </>
  )
}

// ─── Live analytics section ───────────────────────────────────────────────────

function LiveSection({ nodeId }: { nodeId: string }) {
  const running     = useSimulationStore(s => s.running)
  const metrics     = useSimulationStore(useShallow(s => s.nodeMetrics.get(nodeId)))
  const bottlenecks = useSimulationStore(s => s.bottlenecks)
  const sloStatus  = useSimulationStore(s => s.sloStatus.get(nodeId))
  const historyMap = useMetricsHistoryStore(s => s.history)
  const { nodes }  = useCanvasStore()
  const [graphOverlay, setGraphOverlay] = useState<{ metric: GraphMetric } | null>(null)
  const openGraph = useCallback((metric: GraphMetric) => setGraphOverlay({ metric }), [])

  const node     = nodes.find(n => n.id === nodeId)
  const nodeType = node?.type as NodeType | undefined
  const config   = nodeType ? NODE_CONFIG[nodeType] : undefined
  const colors   = config ? CATEGORY_COLORS[config.category] : CATEGORY_COLORS.compute
  const data     = node?.data as NodeData | undefined

  const nodeHistory = historyMap.get(nodeId) ?? []
  const utilHistory = nodeHistory.map(s => s.utilization)
  const rpsHistory  = nodeHistory.map(s => s.inRps)

  const nodeSlo = data?.slo ?? (nodeType ? DEFAULT_SLO[nodeType] : undefined)

  if (!running) {
    return (
      <div className={styles.liveOff}>
        <Activity size={14} className={styles.liveOffIcon} />
        <span>Start simulation to see live metrics</span>
      </div>
    )
  }

  if (!metrics) {
    return (
      <div className={styles.liveOff}>
        <span>Initializing…</span>
      </div>
    )
  }

  const util = metrics.utilization
  const utilColor = util >= 0.8 ? '#EF4444' : util >= 0.5 ? '#F59E0B' : colors.accent
  const isBottleneck = bottlenecks.has(nodeId)
  const isQueue  = nodeType && ['queue', 'pubsub', 'stream', 'eventBus'].includes(nodeType)
  const isLambda = nodeType === 'lambda'

  return (
    <div className={styles.liveContent}>
      {isBottleneck && (
        <div className={styles.liveAlert} style={{
          borderColor: util >= 1 ? '#EF444466' : '#F59E0B66',
          color: util >= 1 ? '#FCA5A5' : '#FCD34D',
        }}>
          {util >= 1 ? '● Saturated — dropping requests' : '▲ High utilization'}
        </div>
      )}
      {metrics.circuitState === 'open' && (
        <div className={styles.liveAlert} style={{ borderColor: '#F59E0B66', color: '#FCD34D' }}>
          ⊘ Circuit open — rejecting requests
        </div>
      )}

      <div className={styles.liveStats}>
        <button className={`${styles.liveStat} ${styles.liveStatClickable}`} onClick={() => openGraph('inRps')} title="Click to view RPS history">
          <span className={styles.liveStatLabel}>In</span>
          <span className={styles.liveStatVal}>{Math.round(metrics.inRps)}</span>
          <span className={styles.liveStatUnit}>RPS</span>
        </button>
        <div className={styles.liveStat}>
          <span className={styles.liveStatLabel}>Out</span>
          <span className={styles.liveStatVal}>{Math.round(metrics.outRps)}</span>
          <span className={styles.liveStatUnit}>RPS</span>
        </div>
        <button className={`${styles.liveStat} ${styles.liveStatClickable}`} onClick={() => openGraph('utilization')} title="Click to view utilization history">
          <span className={styles.liveStatLabel}>Util</span>
          <span className={styles.liveStatVal} style={{ color: utilColor }}>{Math.round(util * 100)}</span>
          <span className={styles.liveStatUnit}>%</span>
        </button>
        {metrics.errorRate > 0 && (
          <button className={`${styles.liveStat} ${styles.liveStatClickable}`} onClick={() => openGraph('errorRate')} title="Click to view error rate history">
            <span className={styles.liveStatLabel}>Errors</span>
            <span className={styles.liveStatVal} style={{ color: '#EF4444' }}>{(metrics.errorRate * 100).toFixed(1)}</span>
            <span className={styles.liveStatUnit}>%</span>
          </button>
        )}
        {metrics.activeRequests !== undefined && !isQueue && (
          <div className={styles.liveStat}>
            <span className={styles.liveStatLabel}>Active</span>
            <span className={styles.liveStatVal}>{metrics.activeRequests}</span>
            <span className={styles.liveStatUnit}>req</span>
          </div>
        )}
        {isLambda && metrics.concurrency !== undefined && (
          <div className={styles.liveStat}>
            <span className={styles.liveStatLabel}>Concur.</span>
            <span className={styles.liveStatVal}>{metrics.concurrency}</span>
            <span className={styles.liveStatUnit}>threads</span>
          </div>
        )}
        {isQueue && metrics.queueDepth !== undefined && (
          <div className={styles.liveStat}>
            <span className={styles.liveStatLabel}>Queue</span>
            <span className={styles.liveStatVal}>{Math.round(metrics.queueDepth).toLocaleString()}</span>
            <span className={styles.liveStatUnit}>msgs</span>
          </div>
        )}
        {metrics.consumerLagMs !== undefined && (
          <div className={styles.liveStat} title="Time to drain the current backlog at the consumer's current rate">
            <span className={styles.liveStatLabel}>Lag</span>
            <span className={styles.liveStatVal} style={{ color: metrics.consumerLagMs > 5000 ? '#EF4444' : metrics.consumerLagMs > 1000 ? '#F59E0B' : '#22C55E' }}>
              {metrics.consumerLagMs === Infinity ? '∞'
                : metrics.consumerLagMs >= 60000 ? `${(metrics.consumerLagMs / 60000).toFixed(1)}m`
                : metrics.consumerLagMs >= 1000  ? `${(metrics.consumerLagMs / 1000).toFixed(1)}s`
                : `${Math.round(metrics.consumerLagMs)}`}
            </span>
            <span className={styles.liveStatUnit}>
              {metrics.consumerLagMs === Infinity ? '' : metrics.consumerLagMs >= 1000 ? '' : 'ms'}
            </span>
          </div>
        )}
        {(metrics.droppedRequests ?? 0) > 0 && (
          <div className={styles.liveStat}>
            <span className={styles.liveStatLabel}>Dropped</span>
            <span className={styles.liveStatVal} style={{ color: '#EF4444' }}>
              {metrics.droppedRequests! >= 1000
                ? `${(metrics.droppedRequests! / 1000).toFixed(1)}k`
                : metrics.droppedRequests}
            </span>
            <span className={styles.liveStatUnit}>req</span>
          </div>
        )}
      </div>

      {metrics.p90LatencyMs > 0 && (
        <div className={styles.latencyRow}>
          <div className={styles.latencyStat}>
            <span className={styles.liveStatLabel}>P50</span>
            <span className={styles.latencyVal}>{Math.round(metrics.p50LatencyMs)}ms</span>
          </div>
          <div className={styles.latencyStat}>
            <span className={styles.liveStatLabel}>P75</span>
            <span className={styles.latencyVal}>{Math.round(metrics.p75LatencyMs)}ms</span>
          </div>
          <div className={styles.latencyStat}>
            <span className={styles.liveStatLabel}>P90</span>
            <span className={styles.latencyVal}>{Math.round(metrics.p90LatencyMs)}ms</span>
          </div>
          <div className={styles.latencyStat}>
            <span className={styles.liveStatLabel}>P99</span>
            <span className={styles.latencyVal} style={{ color: '#F59E0B' }}>{Math.round(metrics.p99LatencyMs)}ms</span>
          </div>
        </div>
      )}

      {utilHistory.length > 1 && (
        <button className={`${styles.sparkWrap} ${styles.sparkClickable}`} onClick={() => openGraph('utilization')} title="Click to expand utilization chart">
          <span className={styles.sparkLabel}>Utilization (60s) ↗</span>
          <Sparkline data={utilHistory} color={utilColor} height={26} />
        </button>
      )}

      {rpsHistory.length > 1 && (
        <button className={`${styles.sparkWrap} ${styles.sparkClickable}`} onClick={() => openGraph('inRps')} title="Click to expand traffic chart">
          <span className={styles.sparkLabel}>Traffic (60s) ↗</span>
          <Sparkline data={rpsHistory} color="#22C55E" height={26} />
        </button>
      )}

      {graphOverlay && (
        <MetricGraphOverlay
          nodeId={nodeId}
          metric={graphOverlay.metric}
          onClose={() => setGraphOverlay(null)}
        />
      )}

      {nodeSlo && (
        <div className={styles.sloBlock}>
          <div className={styles.sloBlockHead}>
            <span className={styles.sloBlockLabel}>SLO</span>
            <span className={sloStatus?.passing === false ? styles.sloBadgeFail : styles.sloBadgePass}>
              {sloStatus?.passing === false ? '✗ Violated' : '✓ Passing'}
            </span>
          </div>
          {nodeSlo.maxP90LatencyMs !== undefined && (
            <div className={styles.sloRow}>
              <span className={styles.sloRowLabel}>P90 Latency</span>
              <span className={styles.sloTarget}>&lt; {nodeSlo.maxP90LatencyMs}ms</span>
              <span style={{ color: metrics.p90LatencyMs > nodeSlo.maxP90LatencyMs ? '#EF4444' : '#22C55E' }}>
                {metrics.p90LatencyMs > 0 ? `${Math.round(metrics.p90LatencyMs)}ms` : '—'}
              </span>
            </div>
          )}
          {nodeSlo.maxErrorRate !== undefined && (
            <div className={styles.sloRow}>
              <span className={styles.sloRowLabel}>Error Rate</span>
              <span className={styles.sloTarget}>&lt; {(nodeSlo.maxErrorRate * 100).toFixed(1)}%</span>
              <span style={{ color: metrics.errorRate > nodeSlo.maxErrorRate ? '#EF4444' : '#22C55E' }}>
                {(metrics.errorRate * 100).toFixed(1)}%
              </span>
            </div>
          )}
          {nodeSlo.maxUtilization !== undefined && (
            <div className={styles.sloRow}>
              <span className={styles.sloRowLabel}>Utilization</span>
              <span className={styles.sloTarget}>&lt; {Math.round(nodeSlo.maxUtilization * 100)}%</span>
              <span style={{ color: util > nodeSlo.maxUtilization ? '#EF4444' : '#22C55E' }}>
                {Math.round(util * 100)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Detail pane content ──────────────────────────────────────────────────────

function DetailContent({ nodeId }: { nodeId: string }) {
  const { nodes } = useCanvasStore()
  const running   = useSimulationStore(s => s.running)

  const node = nodes.find(n => n.id === nodeId)
  if (!node) return null

  const nodeType = node.type as NodeType
  const config   = NODE_CONFIG[nodeType]
  const data     = node.data as NodeData
  const colors   = config ? CATEGORY_COLORS[config.category] : CATEGORY_COLORS.compute

  return (
    <div className={styles.detailInner}>
      {/* Node identity header */}
      <div className={styles.detailHead}>
        <span className={styles.detailIcon} style={{ color: colors.accent }}>
          {config?.icon && <config.icon size={14} />}
        </span>
        <div>
          <div className={styles.detailLabel}>{data.label || nodeType}</div>
          <div className={styles.detailType} style={{ color: colors.accent }}>{nodeType}</div>
        </div>
      </div>

      {/* Config section */}
      <div className={styles.sectionDivider}>
        <span className={styles.sectionDividerLabel}>Configuration</span>
      </div>
      <ConfigSection nodeId={nodeId} />

      {/* Live metrics section — visually distinct */}
      <div className={`${styles.sectionDivider} ${running ? styles.sectionDividerLive : styles.sectionDividerOff}`}>
        <span className={styles.sectionDividerLabel}>
          {running ? (
            <><span className={styles.livePulse} />Live Metrics</>
          ) : 'Live Metrics'}
        </span>
        {!running && <span className={styles.sectionDividerHint}>start simulation</span>}
      </div>
      <LiveSection nodeId={nodeId} />
    </div>
  )
}

// ─── Main panel (side tray) ───────────────────────────────────────────────────

export function SimConfigPanel() {
  const { setSimConfigOpen, simConfigPanelNodeId, setSimConfigPanelNode } = useUiStore()
  const { nodes } = useCanvasStore()
  const running   = useSimulationStore(s => s.running)
  const events    = useSimulationStore(s => s.events)
  const [search, setSearch] = useState('')
  const [eventLogOpen, setEventLogOpen] = useState(false)
  const lastSeenEventsRef = useRef(0)

  const unreadEvents = events.length - lastSeenEventsRef.current

  const handleOpenEvents = useCallback(() => {
    setEventLogOpen(true)
    lastSeenEventsRef.current = events.length
  }, [events.length])

  useEffect(() => {
    if (!eventLogOpen) return
    lastSeenEventsRef.current = events.length
  }, [events.length, eventLogOpen])

  const nonGroupNodes = useMemo(
    () => nodes.filter(n => !GROUPING_TYPES.has(n.type as NodeType)),
    [nodes],
  )

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return nonGroupNodes
    return nonGroupNodes.filter(n => {
      const data = n.data as NodeData
      return data.label.toLowerCase().includes(q) || (n.type ?? '').toLowerCase().includes(q)
    })
  }, [nonGroupNodes, search])

  return (
    <aside className={styles.tray}>
      {/* Header */}
      <div className={styles.trayHeader}>
        <div className={styles.trayTitle}>
          <SlidersHorizontal size={12} className={styles.trayTitleIcon} />
          <span>Simulation Inspector</span>
          <span className={styles.trayCount}>{nonGroupNodes.length}</span>
          {running && <span className={styles.trayLiveBadge}><span className={styles.livePulse} />Live</span>}
        </div>
        <div className={styles.trayHeaderActions}>
          <button
            className={`${styles.eventsBtn} ${eventLogOpen ? styles.eventsBtnActive : ''}`}
            onClick={handleOpenEvents}
            title="Open event log"
          >
            <Bell size={11} />
            Events
            {unreadEvents > 0 && !eventLogOpen && (
              <span className={styles.eventsBadge}>{unreadEvents > 99 ? '99+' : unreadEvents}</span>
            )}
          </button>
          <button
            className={styles.trayClose}
            onClick={() => setSimConfigOpen(false)}
            title="Close Inspector"
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {eventLogOpen && <EventLogPanel onClose={() => setEventLogOpen(false)} />}

      {/* Body */}
      <div className={styles.trayBody}>
        {/* Left: node list */}
        <div className={styles.nodeList}>
          <div className={styles.searchWrap}>
            <Search size={10} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              placeholder="Filter…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className={styles.nodeListBody}>
            {filtered.length === 0 && (
              <div className={styles.noMatch}>No matches</div>
            )}
            {filtered.map(node => (
              <NodeRow
                key={node.id}
                nodeId={node.id}
                selected={simConfigPanelNodeId === node.id}
                onClick={() => setSimConfigPanelNode(node.id)}
              />
            ))}
          </div>
        </div>

        {/* Right: detail */}
        <div className={styles.detailPane}>
          <AnimatePresence mode="wait">
            {simConfigPanelNodeId ? (
              <motion.div
                key={simConfigPanelNodeId}
                className={styles.detailScroll}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.16 }}
              >
                <DetailContent nodeId={simConfigPanelNodeId} />
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                className={styles.detailEmpty}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <SlidersHorizontal size={22} className={styles.detailEmptyIcon} />
                <span className={styles.detailEmptyTitle}>Select a node</span>
                <span className={styles.detailEmptySub}>
                  Configure simulation parameters and watch live metrics side by side
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </aside>
  )
}
