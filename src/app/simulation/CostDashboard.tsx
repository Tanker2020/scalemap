import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { Node } from '@xyflow/react'
import { X, TrendingUp, TrendingDown } from 'lucide-react'
import { useCostHistoryStore } from '../store/costHistory.store'
import { computeCostByCategory, formatUsd, type CostSummary } from '../../lib/costModel'
import { NODE_CONFIG, type NodeData, type NodeCategory, type NodeType } from '../../lib/nodeConfig'
import { CATEGORY_COLORS } from '../../lib/theme'
import { useUiStore } from '../store/ui.store'
import styles from './CostDashboard.module.css'

// CATEGORY_COLORS.accent is dark-mode-only (see BaseNode.tsx/NodePalette.tsx for the same
// pattern) -- swap to .foreground.light in light mode so category dots/bars/hero chart stay
// legible instead of using the vivid dark-tuned hue verbatim on a light background.
function categoryColor(category: NodeCategory | undefined, themeMode: 'dark' | 'light'): string {
  if (!category) return 'var(--color-text-secondary)'
  const c = CATEGORY_COLORS[category]
  if (!c) return 'var(--color-text-secondary)'
  return themeMode === 'light' ? c.foreground.light : c.accent
}

interface Props {
  summary: CostSummary
  nodes: Node<NodeData>[]
  onClose: () => void
}

const CATEGORY_LABEL: Record<NodeCategory, string> = {
  compute: 'Compute',
  network: 'Network',
  storage: 'Storage',
  messaging: 'Messaging',
  caching: 'Caching',
  orchestration: 'Orchestration',
  grouping: 'Grouping',
}

function niceMax(val: number): number {
  if (val <= 0) return 1
  const candidates = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000]
  for (const c of candidates) if (c >= val) return c
  return Math.ceil(val / 100000) * 100000
}

interface TooltipState {
  x: number
  idx: number
  totalMonthlyUsd: number
  totalHourlyUsd: number
  t: number
}

export function CostDashboard({ summary, nodes, onClose }: Props) {
  const history = useCostHistoryStore(s => s.history)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const themeMode = useUiStore(s => s.themeMode)
  // "Cost is amber" branding is independent of any node category (it's a money signal, not a
  // storage-category signal that happens to share a hex value) -- var(--color-warning) already
  // resolves an AA-safe amber in both themes, no JS/themeMode branching needed.
  const heroColor = 'var(--color-warning)'

  const categories = useMemo(() => computeCostByCategory(summary, nodes), [summary, nodes])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Trend: compare the latest sample to the sample ~60s ago (or the earliest available).
  const trend = useMemo(() => {
    if (history.length < 2) return null
    const latest = history[history.length - 1]
    const compareIdx = Math.max(0, history.length - 61)
    const prior = history[compareIdx]
    if (prior.totalMonthlyUsd <= 0) return null
    const deltaPct = ((latest.totalMonthlyUsd - prior.totalMonthlyUsd) / prior.totalMonthlyUsd) * 100
    return deltaPct
  }, [history])

  const CHART_W = 660
  const CHART_H = 180
  const PAD_L = 56
  const PAD_R = 16
  const PAD_T = 14
  const PAD_B = 26
  const chartW = CHART_W - PAD_L - PAD_R
  const chartH = CHART_H - PAD_T - PAD_B
  const n = history.length

  const maxMonthly = useMemo(() => niceMax(Math.max(...history.map(h => h.totalMonthlyUsd), summary.totalMonthlyUsd, 0)), [history, summary.totalMonthlyUsd])

  const buildPath = useCallback((vals: number[], maxVal: number) => {
    if (vals.length < 2) return ''
    return vals.map((v, i) => {
      const x = PAD_L + (i / (n - 1)) * chartW
      const y = PAD_T + chartH - (v / maxVal) * chartH
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }, [n, chartW, chartH])

  const buildArea = useCallback((vals: number[], maxVal: number) => {
    if (vals.length < 2) return ''
    const pts = vals.map((v, i) => {
      const x = PAD_L + (i / (n - 1)) * chartW
      const y = PAD_T + chartH - (v / maxVal) * chartH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    const lastX = (PAD_L + chartW).toFixed(1)
    const firstX = PAD_L.toFixed(1)
    const bottom = (PAD_T + chartH).toFixed(1)
    return `M${pts[0]} L${pts.slice(1).join(' L')} L${lastX},${bottom} L${firstX},${bottom} Z`
  }, [n, chartW, chartH])

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
      idx,
      totalMonthlyUsd: snap.totalMonthlyUsd,
      totalHourlyUsd: snap.totalHourlyUsd,
      t: snap.t,
    })
  }, [n, history, chartW])

  const formatTime = (t: number): string => {
    const elapsedS = Math.round((t - (history[0]?.t ?? t)) / 1000)
    const m = Math.floor(elapsedS / 60)
    const s = elapsedS % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const monthlyVals = history.map(h => h.totalMonthlyUsd)
  const maxCategoryUsd = Math.max(...categories.map(c => c.monthlyUsd), 0.0001)

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.card} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerLabel}>Cost Dashboard</span>
            <span className={styles.headerHint}>estimated cloud spend</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close (Escape)">
            <X size={13} />
          </button>
        </div>

        {/* Hero: monthly projection */}
        <div className={styles.hero}>
          <div className={styles.heroMain}>
            <div className={styles.heroLabel}>Projected monthly spend</div>
            <div className={styles.heroValue}>{formatUsd(summary.totalMonthlyUsd)}</div>
            <div className={styles.heroSub}>
              {formatUsd(summary.totalHourlyUsd)}/hr · {summary.perNode.length} priced node{summary.perNode.length === 1 ? '' : 's'}
            </div>
          </div>
          {trend !== null && (
            <div className={`${styles.heroTrend} ${trend >= 0 ? styles.trendUp : styles.trendDown}`}>
              {trend >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              <span>{trend >= 0 ? '+' : ''}{trend.toFixed(1)}%</span>
              <span className={styles.trendHint}>last ~60s</span>
            </div>
          )}
        </div>

        {/* Cost over time */}
        <div className={styles.sectionLabel}>Cost over time</div>
        <div className={styles.chartWrap}>
          {n < 2 ? (
            <div className={styles.noData}>No history yet — run the simulation to collect cost samples</div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              className={styles.svg}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setTooltip(null)}
            >
              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const y = PAD_T + frac * chartH
                return <line key={frac} x1={PAD_L} y1={y} x2={PAD_L + chartW} y2={y} stroke="var(--color-toolbar-border)" strokeWidth="1" />
              })}

              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const y = PAD_T + (1 - frac) * chartH
                const val = frac * maxMonthly
                return (
                  <text key={`y-${frac}`} x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize="9" fill="var(--color-text-muted)">
                    {formatUsd(val)}
                  </text>
                )
              })}

              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const idx = Math.round(frac * (n - 1))
                const snap = history[idx]
                if (!snap) return null
                const x = PAD_L + frac * chartW
                return (
                  <text key={`x-${frac}`} x={x} y={PAD_T + chartH + 18} textAnchor="middle" fontSize="9" fill="var(--color-text-muted)">
                    {formatTime(snap.t)}
                  </text>
                )
              })}

              <path d={buildArea(monthlyVals, maxMonthly)} fill={heroColor} fillOpacity="0.1" />
              <path d={buildPath(monthlyVals, maxMonthly)} fill="none" stroke={heroColor} strokeWidth="1.5" strokeLinejoin="round" />

              {tooltip && (
                <line x1={tooltip.x} y1={PAD_T} x2={tooltip.x} y2={PAD_T + chartH} stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="2,2" />
              )}

              <rect x={PAD_L} y={PAD_T} width={chartW} height={chartH} fill="transparent" />
            </svg>
          )}

          {tooltip && (
            <div
              className={styles.tooltip}
              style={{ left: `${(tooltip.x / CHART_W) * 100}%`, transform: tooltip.x > CHART_W / 2 ? 'translateX(-110%)' : 'translateX(5%)' }}
            >
              <div className={styles.tooltipTime}>{formatTime(tooltip.t)}</div>
              <div className={styles.tooltipRow}>
                <span className={styles.tooltipDot} style={{ background: heroColor }} />
                <span className={styles.tooltipLabel}>Monthly</span>
                <span className={styles.tooltipVal}>{formatUsd(tooltip.totalMonthlyUsd)}</span>
              </div>
              <div className={styles.tooltipRow}>
                <span className={styles.tooltipDot} style={{ background: 'transparent' }} />
                <span className={styles.tooltipLabel}>Hourly</span>
                <span className={styles.tooltipVal}>{formatUsd(tooltip.totalHourlyUsd)}</span>
              </div>
            </div>
          )}
        </div>
        {n >= 2 && <div className={styles.sampleCount}>{n} sample{n === 1 ? '' : 's'} · ~{Math.round(n / 60)}min</div>}

        {/* Cost by category */}
        <div className={styles.sectionLabel}>Cost by category</div>
        <div className={styles.categoryList}>
          {categories.length === 0 && <div className={styles.noData}>No categorized costs yet</div>}
          {categories.map(c => {
            const color = categoryColor(c.category, themeMode)
            return (
              <div key={c.category} className={styles.categoryRow}>
                <div className={styles.categoryHead}>
                  <span className={styles.categoryDot} style={{ background: color }} />
                  <span className={styles.categoryName}>{CATEGORY_LABEL[c.category]}</span>
                  <span className={styles.categoryPct}>{(c.share * 100).toFixed(0)}%</span>
                  <span className={styles.categoryUsd}>{formatUsd(c.monthlyUsd)}<span className={styles.unit}>/mo</span></span>
                </div>
                <div className={styles.categoryTrack}>
                  <div
                    className={styles.categoryFill}
                    style={{ width: `${Math.max(2, (c.monthlyUsd / maxCategoryUsd) * 100)}%`, background: color }}
                  />
                </div>
              </div>
            )
          })}
        </div>

        {/* Per-node breakdown */}
        <div className={styles.sectionLabel}>Per-node breakdown</div>
        <div className={styles.nodeList}>
          {summary.perNode.map(nd => {
            const node = nodes.find(x => x.id === nd.nodeId)
            const category = node ? NODE_CONFIG[node.type as NodeType]?.category : undefined
            const color = categoryColor(category, themeMode)
            return (
              <div key={nd.nodeId} className={styles.nodeRow}>
                <span className={styles.nodeDot} style={{ background: color }} />
                <div className={styles.nodeMain}>
                  <span className={styles.nodeLabel} title={nd.nodeLabel}>{nd.nodeLabel}</span>
                  <span className={styles.nodeService}>{nd.serviceName}</span>
                </div>
                <div className={styles.nodeRight}>
                  <span className={styles.nodeMonthly}>{formatUsd(nd.monthlyUsd)}<span className={styles.unit}>/mo</span></span>
                  <div className={styles.chips}>
                    {nd.components.map((c, i) => (
                      <span key={i} className={styles.chip}>{c.label}: {formatUsd(c.monthlyUsd)}</span>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
