import { useEffect, useRef, useState, useCallback } from 'react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulationLegacy.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { NODE_CONFIG, type NodeType, type NodeData } from '../../lib/nodeConfig'
import { DEFAULT_SLO } from '../simulation/defaults'
import styles from './MetricGraphOverlay.module.css'

export type GraphMetric = 'utilization' | 'inRps' | 'errorRate' | 'p90LatencyMs'

interface Props {
  nodeId: string
  metric: GraphMetric
  onClose: () => void
}

const METRIC_CONFIG: Record<GraphMetric, { label: string; color: string; unit: string; format: (v: number) => string }> = {
  utilization:  { label: 'Utilization',  color: 'var(--color-accent)', unit: '%',  format: v => `${Math.round(v * 100)}%` },
  inRps:        { label: 'Inbound RPS',  color: 'var(--color-success)', unit: 'rps', format: v => v >= 1000 ? `${(v/1000).toFixed(1)}k` : `${Math.round(v)}` },
  errorRate:    { label: 'Error Rate',   color: 'var(--color-danger)', unit: '%',  format: v => `${(v * 100).toFixed(2)}%` },
  p90LatencyMs: { label: 'P90 Latency', color: 'var(--color-warning)', unit: 'ms', format: v => `${Math.round(v)}ms` },
}

const ALL_METRICS: GraphMetric[] = ['utilization', 'inRps', 'errorRate', 'p90LatencyMs']

function niceMax(val: number): number {
  if (val <= 0) return 1
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]
  for (const c of candidates) if (c >= val) return c
  return Math.ceil(val / 1000) * 1000
}

function extractValues(history: { t: number; inRps: number; utilization: number; errorRate: number; p90LatencyMs: number }[], metric: GraphMetric): number[] {
  return history.map(s => s[metric])
}

interface TooltipState {
  x: number
  y: number
  idx: number
  values: Partial<Record<GraphMetric, number>>
  t: number
}

export function MetricGraphOverlay({ nodeId, metric: initialMetric, onClose }: Props) {
  const [activeMetrics, setActiveMetrics] = useState<GraphMetric[]>([initialMetric])
  const [showAll, setShowAll] = useState(false)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const history = useMetricsHistoryStore(s => s.history.get(nodeId) ?? [])
  const node    = useCanvasStore(s => s.nodes.find(n => n.id === nodeId))
  const nodeType = node?.type as NodeType | undefined
  const nodeLabel = (node?.data as NodeData)?.label ?? nodeId
  const nodeSlo = (node?.data as NodeData)?.slo ?? (nodeType ? DEFAULT_SLO[nodeType] : undefined)
  const running = useSimulationStore(s => s.running)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const metrics = showAll ? ALL_METRICS : activeMetrics

  const CHART_W = 660
  const CHART_H = 260
  const PAD_L = 52
  const PAD_R = 16
  const PAD_T = 16
  const PAD_B = 32
  const chartW = CHART_W - PAD_L - PAD_R
  const chartH = CHART_H - PAD_T - PAD_B

  const n = history.length

  const buildPath = useCallback((vals: number[], maxVal: number) => {
    if (vals.length < 2) return ''
    return vals.map((v, i) => {
      const x = PAD_L + (i / (n - 1)) * chartW
      const y = PAD_T + chartH - (v / maxVal) * chartH
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }, [n, chartW, chartH, PAD_L, PAD_T])

  const buildArea = useCallback((vals: number[], maxVal: number) => {
    if (vals.length < 2) return ''
    const line = vals.map((v, i) => {
      const x = PAD_L + (i / (n - 1)) * chartW
      const y = PAD_T + chartH - (v / maxVal) * chartH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' L')
    const lastX = (PAD_L + chartW).toFixed(1)
    const firstX = PAD_L.toFixed(1)
    const bottom = (PAD_T + chartH).toFixed(1)
    return `M${line.split(' L')[0]} L${line.split(' L').slice(1).join(' L')} L${lastX},${bottom} L${firstX},${bottom} Z`
  }, [n, chartW, chartH, PAD_L, PAD_T])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || n < 2) return
    const rect = svgRef.current.getBoundingClientRect()
    const svgX = (e.clientX - rect.left) * (CHART_W / rect.width)
    const relX = svgX - PAD_L
    if (relX < 0 || relX > chartW) { setTooltip(null); return }
    const idx = Math.round((relX / chartW) * (n - 1))
    const snap = history[idx]
    if (!snap) return
    setTooltip({
      x: PAD_L + (idx / (n - 1)) * chartW,
      y: 0,
      idx,
      values: { utilization: snap.utilization, inRps: snap.inRps, errorRate: snap.errorRate, p90LatencyMs: snap.p90LatencyMs },
      t: snap.t,
    })
  }, [n, history, chartW, PAD_L])

  const sloValue = (metric: GraphMetric): number | undefined => {
    if (!nodeSlo) return undefined
    if (metric === 'utilization') return nodeSlo.maxUtilization
    if (metric === 'errorRate') return nodeSlo.maxErrorRate
    if (metric === 'p90LatencyMs') return nodeSlo.maxP90LatencyMs
    return undefined
  }

  const maxForMetric = (metric: GraphMetric): number => {
    const vals = extractValues(history, metric)
    const dataMax = Math.max(...vals, 0)
    const slo = sloValue(metric)
    const combined = slo !== undefined ? Math.max(dataMax, slo * 1.2) : dataMax
    if (metric === 'utilization') return 1
    if (metric === 'errorRate') return Math.max(combined, 0.1)
    return niceMax(combined)
  }

  const NodeIcon = nodeType ? NODE_CONFIG[nodeType]?.icon : null

  const formatTime = (t: number): string => {
    const elapsedS = Math.round((t - (history[0]?.t ?? t)) / 1000)
    const m = Math.floor(elapsedS / 60)
    const s = elapsedS % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {NodeIcon && <NodeIcon size={14} className={styles.headerIcon} />}
            <span className={styles.headerLabel}>{nodeLabel}</span>
            {nodeType && <span className={styles.headerType}>{nodeType}</span>}
            {running && <span className={styles.liveDot} />}
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close (Escape)">✕</button>
        </div>

        {/* Metric tabs */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${showAll ? styles.tabActive : ''}`}
            onClick={() => { setShowAll(true) }}
          >All</button>
          {ALL_METRICS.map(m => (
            <button
              key={m}
              className={`${styles.tab} ${!showAll && activeMetrics.includes(m) ? styles.tabActive : ''}`}
              style={{ '--metric-color': METRIC_CONFIG[m].color } as React.CSSProperties}
              onClick={() => { setShowAll(false); setActiveMetrics([m]) }}
            >
              {METRIC_CONFIG[m].label}
            </button>
          ))}
        </div>

        {/* Chart area */}
        <div className={styles.chartWrap}>
          {n < 2 ? (
            <div className={styles.noData}>No history yet — run the simulation to collect data</div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              className={styles.svg}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setTooltip(null)}
            >
              {/* Grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const y = PAD_T + frac * chartH
                return (
                  <line key={frac} x1={PAD_L} y1={y} x2={PAD_L + chartW} y2={y}
                    stroke="var(--color-toolbar-border)" strokeWidth="1" />
                )
              })}

              {/* Y-axis labels */}
              {metrics.slice(0, 1).map(m => {
                const maxV = maxForMetric(m)
                return [0, 0.25, 0.5, 0.75, 1].map(frac => {
                  const y = PAD_T + (1 - frac) * chartH
                  const val = frac * maxV
                  const label = METRIC_CONFIG[m].format(val)
                  return (
                    <text key={`y-${frac}`} x={PAD_L - 5} y={y + 4} textAnchor="end"
                      fontSize="9" fill="var(--color-text-muted)">{label}</text>
                  )
                })
              })}

              {/* X-axis labels */}
              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const idx = Math.round(frac * (n - 1))
                const snap = history[idx]
                if (!snap) return null
                const x = PAD_L + frac * chartW
                return (
                  <text key={`x-${frac}`} x={x} y={PAD_T + chartH + 18} textAnchor="middle"
                    fontSize="9" fill="var(--color-text-muted)">{formatTime(snap.t)}</text>
                )
              })}

              {/* Metric lines */}
              {metrics.map(m => {
                const maxV = maxForMetric(m)
                const vals = extractValues(history, m)
                const cfg  = METRIC_CONFIG[m]
                const slo  = sloValue(m)

                return (
                  <g key={m}>
                    {/* Area fill */}
                    <path d={buildArea(vals, maxV)} fill={cfg.color} fillOpacity="0.08" />
                    {/* SLO threshold */}
                    {slo !== undefined && (
                      <>
                        <line
                          x1={PAD_L} y1={PAD_T + chartH - (slo / maxV) * chartH}
                          x2={PAD_L + chartW} y2={PAD_T + chartH - (slo / maxV) * chartH}
                          stroke={cfg.color} strokeWidth="1" strokeDasharray="4,3" opacity="0.5"
                        />
                        <text
                          x={PAD_L + chartW - 2}
                          y={PAD_T + chartH - (slo / maxV) * chartH - 3}
                          textAnchor="end" fontSize="8" fill={cfg.color} opacity="0.7"
                        >SLO</text>
                      </>
                    )}
                    {/* Line */}
                    <path d={buildPath(vals, maxV)} fill="none" stroke={cfg.color} strokeWidth="1.5" strokeLinejoin="round" />
                  </g>
                )
              })}

              {/* Tooltip hairline */}
              {tooltip && (
                <line
                  x1={tooltip.x} y1={PAD_T}
                  x2={tooltip.x} y2={PAD_T + chartH}
                  stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="2,2"
                />
              )}

              {/* Invisible hit area */}
              <rect x={PAD_L} y={PAD_T} width={chartW} height={chartH} fill="transparent" />
            </svg>
          )}

          {/* Tooltip box */}
          {tooltip && (
            <div
              className={styles.tooltip}
              style={{ left: `${(tooltip.x / CHART_W) * 100}%`, transform: tooltip.x > CHART_W / 2 ? 'translateX(-110%)' : 'translateX(5%)' }}
            >
              <div className={styles.tooltipTime}>{formatTime(tooltip.t)}</div>
              {metrics.map(m => (
                <div key={m} className={styles.tooltipRow}>
                  <span className={styles.tooltipDot} style={{ background: METRIC_CONFIG[m].color }} />
                  <span className={styles.tooltipLabel}>{METRIC_CONFIG[m].label}</span>
                  <span className={styles.tooltipVal}>{METRIC_CONFIG[m].format(tooltip.values[m] ?? 0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Legend */}
        <div className={styles.legend}>
          {metrics.map(m => (
            <div key={m} className={styles.legendItem}>
              <span className={styles.legendDot} style={{ background: METRIC_CONFIG[m].color }} />
              <span className={styles.legendLabel}>{METRIC_CONFIG[m].label}</span>
            </div>
          ))}
          <div className={styles.legendCount}>{n} samples · ~{Math.round(n / 60)}min</div>
        </div>
      </div>
    </div>
  )
}
