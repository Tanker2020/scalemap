import { useMemo, useState } from 'react'
import type { Node } from '@xyflow/react'
import { ChevronDown, ChevronRight, DollarSign } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulation.store'
import { computeCost, formatUsd } from '../../lib/costModel'
import type { NodeData } from '../../lib/nodeConfig'
import styles from './CostTracker.module.css'

// Live cloud-cost tracker for the simulation session. Derives cost purely from current
// node config + live traffic metrics (no engine coupling). Hidden until at least one node
// has a provider/pricing assigned, so generic diagrams aren't cluttered.
export function CostTracker() {
  const nodes = useCanvasStore(s => s.nodes)
  const nodeMetrics = useSimulationStore(s => s.nodeMetrics)
  const [open, setOpen] = useState(false)

  const summary = useMemo(
    () => computeCost(nodes as Node<NodeData>[], nodeMetrics),
    [nodes, nodeMetrics],
  )

  if (summary.perNode.length === 0) return null

  return (
    <div className={styles.bar}>
      <button className={styles.head} onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <DollarSign size={11} className={styles.icon} />
        <span className={styles.live}>
          {formatUsd(summary.totalHourlyUsd)}<span className={styles.unit}>/hr</span>
        </span>
        <span className={styles.sep}>·</span>
        <span className={styles.monthly}>
          ~{formatUsd(summary.totalMonthlyUsd)}<span className={styles.unit}>/mo</span>
        </span>
        <span className={styles.hint}>est. cloud spend</span>
      </button>

      {open && (
        <div className={styles.breakdown}>
          {summary.perNode.map(n => (
            <div key={n.nodeId} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.rowLabel} title={n.nodeLabel}>{n.nodeLabel}</span>
                <span className={styles.rowService}>{n.serviceName}</span>
              </div>
              <div className={styles.rowRight}>
                <span className={styles.rowMonthly}>
                  {formatUsd(n.monthlyUsd)}<span className={styles.unit}>/mo</span>
                </span>
                <div className={styles.chips}>
                  {n.components.map((c, i) => (
                    <span key={i} className={styles.chip}>{c.label}: {formatUsd(c.monthlyUsd)}</span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
