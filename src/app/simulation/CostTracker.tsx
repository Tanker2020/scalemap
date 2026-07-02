import { useMemo, useState } from 'react'
import type { Node } from '@xyflow/react'
import { DollarSign, BarChart3 } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCostHistoryStore } from '../store/costHistory.store'
import { computeCost, formatUsd } from '../../lib/costModel'
import type { NodeData } from '../../lib/nodeConfig'
import { Sparkline } from '../sidebar/Sparkline'
import { CostDashboard } from './CostDashboard'
import styles from './CostTracker.module.css'

// Live cloud-cost tracker for the simulation session. Derives cost purely from current
// node config + live traffic metrics (no engine coupling). Hidden until at least one node
// has a provider/pricing assigned, so generic diagrams aren't cluttered. Clicking it opens
// CostDashboard.tsx — a full modal with a cost-over-time chart, category breakdown, and the
// per-node list (previously inlined here as a plain expandable list of colored numbers).
export function CostTracker() {
  const nodes = useCanvasStore(s => s.nodes)
  const nodeMetrics = useSimulationStore(s => s.nodeMetrics)
  const costHistory = useCostHistoryStore(s => s.history)
  const [dashboardOpen, setDashboardOpen] = useState(false)

  const summary = useMemo(
    () => computeCost(nodes as Node<NodeData>[], nodeMetrics),
    [nodes, nodeMetrics],
  )

  const sparkData = useMemo(() => costHistory.map(h => h.totalMonthlyUsd), [costHistory])

  if (summary.perNode.length === 0) return null

  return (
    <>
      <button className={styles.bar} onClick={() => setDashboardOpen(true)} title="Open cost dashboard">
        <DollarSign size={11} className={styles.icon} />
        <span className={styles.live}>
          {formatUsd(summary.totalHourlyUsd)}<span className={styles.unit}>/hr</span>
        </span>
        <span className={styles.sep}>·</span>
        <span className={styles.monthly}>
          ~{formatUsd(summary.totalMonthlyUsd)}<span className={styles.unit}>/mo</span>
        </span>
        {sparkData.length >= 2 && (
          <span className={styles.spark}>
            <Sparkline data={sparkData} color="var(--color-warning)" height={16} maxPoints={60} />
          </span>
        )}
        <span className={styles.hint}>
          <BarChart3 size={10} />
          est. cloud spend
        </span>
      </button>

      {dashboardOpen && (
        <CostDashboard
          summary={summary}
          nodes={nodes as Node<NodeData>[]}
          onClose={() => setDashboardOpen(false)}
        />
      )}
    </>
  )
}
