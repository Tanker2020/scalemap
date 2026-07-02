import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore, type SimulationRun } from '../store/simulation.store'
import { useUiStore } from '../store/ui.store'
import { NODE_CONFIG, type NodeType, type NodeData } from '../../lib/nodeConfig'
import { formatUsd } from '../../lib/costModel'
import { EventCard } from '../simulation/SimConfigPanel'
import styles from './ReportsPanel.module.css'
import type { Node } from '@xyflow/react'

// ─── PDF export ───────────────────────────────────────────────────────────────

function severityColor(s: string) {
  return s === 'critical' ? 'var(--color-danger)' : s === 'warn' ? 'var(--color-warning)' : 'var(--color-success-text)'
}

function exportRunAsPdf(run: SimulationRun, runIndex: number, nodes: Node<NodeData>[]) {
  const getLabel = (id: string) => (nodes.find(n => n.id === id)?.data as NodeData)?.label ?? id
  const getType  = (id: string) => nodes.find(n => n.id === id)?.type ?? ''

  const durationLabel = run.durationS >= 60
    ? `${Math.floor(run.durationS / 60)}m ${run.durationS % 60}s`
    : `${run.durationS}s`

  const startLabel = new Date(run.startedAt).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const modeLabel: Record<string, string> = {
    steady: 'Steady Load', ramp: 'Gradual Ramp', spike: 'Flash Crowd', chaos: 'Chaos',
  }

  const topNodes = Array.from(run.nodeSnapshots.entries())
    .sort(([, a], [, b]) => b.utilization - a.utilization)
    .slice(0, 10)

  const sloViolationEvents = run.events.filter(e => e.type === 'slo_violation')
  const violatedNodeIds = [...new Set(sloViolationEvents.map(e => e.nodeId).filter(Boolean))] as string[]

  const topNodesRows = topNodes.map(([id, m]) => {
    const pct   = Math.min(100, Math.round(m.utilization * 100))
    const color = pct >= 85 ? 'var(--color-danger)' : pct >= 60 ? 'var(--color-warning)' : 'var(--color-success-text)'
    return `<tr>
      <td>${getLabel(id)}</td>
      <td style="color:var(--color-text-secondary);font-size:10px">${getType(id)}</td>
      <td><div style="height:6px;background:var(--color-surface-hover);border-radius:3px;width:120px">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:3px"></div>
      </div></td>
      <td style="text-align:right;color:${color}">${pct}%</td>
      <td style="text-align:right">${Math.round(m.inRps)}</td>
      <td style="text-align:right;color:${m.errorRate > 0.01 ? 'var(--color-danger)' : 'var(--color-text-secondary)'}">${(m.errorRate * 100).toFixed(1)}%</td>
      <td style="text-align:right">${Math.round(m.p90LatencyMs)}ms</td>
    </tr>`
  }).join('')

  const sloHtml = violatedNodeIds.length === 0
    ? `<tr><td colspan="3" style="color:var(--color-success-text)">✓ All SLOs passed</td></tr>`
    : violatedNodeIds.map(id => {
        const snap = run.nodeSnapshots.get(id)
        const msg  = sloViolationEvents.find(e => e.nodeId === id)?.message ?? ''
        return `<tr>
          <td>${getLabel(id)}</td>
          <td style="color:var(--color-text-secondary);font-size:10px">${getType(id)}</td>
          <td style="color:var(--color-danger)">${msg}${snap ? ` — Util ${Math.round(snap.utilization * 100)}% · P90 ${Math.round(snap.p90LatencyMs)}ms` : ''}</td>
        </tr>`
      }).join('')

  const eventsHtml = run.events.map(ev => {
    const color   = severityColor(ev.severity)
    const elapsed = ev.elapsedS != null ? `+${ev.elapsedS.toFixed(1)}s` : ''
    return `<tr>
      <td style="color:${color};white-space:nowrap">${elapsed}</td>
      <td style="color:${color};text-transform:uppercase;font-size:10px;white-space:nowrap">${ev.type.replace(/_/g, ' ')}</td>
      <td style="color:var(--color-text-secondary)">${ev.message}</td>
    </tr>`
  }).join('')

  const allNodesRows = Array.from(run.nodeSnapshots.entries()).map(([id, m]) => `<tr>
    <td>${getLabel(id)}</td>
    <td style="color:var(--color-text-secondary);font-size:10px">${getType(id)}</td>
    <td style="text-align:right">${Math.round(m.inRps)}</td>
    <td style="text-align:right;color:${m.utilization > 0.85 ? 'var(--color-danger)' : 'var(--color-text-primary)'}">${Math.round(m.utilization * 100)}%</td>
    <td style="text-align:right;color:${m.errorRate > 0.01 ? 'var(--color-danger)' : 'var(--color-text-primary)'}">${(m.errorRate * 100).toFixed(2)}%</td>
    <td style="text-align:right">${Math.round(m.p50LatencyMs)}ms</td>
    <td style="text-align:right">${Math.round(m.p90LatencyMs)}ms</td>
    <td style="text-align:right">${Math.round(m.p99LatencyMs)}ms</td>
  </tr>`).join('')

  const css = `
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Courier New',monospace;font-size:12px;background:var(--color-canvas);color:var(--color-text-primary);padding:32px}
    h1{font-size:20px;font-weight:700;margin-bottom:4px}
    h2{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--color-text-muted);margin:24px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--color-node-border)}
    table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px}
    th{text-align:left;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;font-size:9px;padding:4px 8px;border-bottom:1px solid var(--color-node-border)}
    td{padding:5px 8px;border-bottom:1px solid var(--color-canvas)}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:4px}
    .s{background:var(--color-node-base);border:1px solid var(--color-node-border);border-radius:6px;padding:10px 12px}
    .sl{font-size:9px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.06em}
    .sv{font-size:20px;font-weight:700;margin-top:2px}
    .red{color:var(--color-danger)}.grn{color:var(--color-success-text)}
  `

  const body = `
    <h1>Scalemap Simulation Report</h1>
    <p style="color:var(--color-text-muted);font-size:11px;margin-top:4px;margin-bottom:20px">
      Run #${runIndex + 1} &nbsp;·&nbsp; ${startLabel} &nbsp;·&nbsp;
      ${modeLabel[run.trafficMode] ?? run.trafficMode} &nbsp;·&nbsp;
      ${run.globalMultiplier}× &nbsp;·&nbsp; ${durationLabel}
    </p>

    <h2>Summary</h2>
    <div class="stats">
      <div class="s"><div class="sl">Duration</div><div class="sv">${durationLabel}</div></div>
      <div class="s"><div class="sl">Peak RPS</div><div class="sv">${run.peakRps >= 1000 ? `${(run.peakRps / 1000).toFixed(1)}k` : Math.round(run.peakRps)}</div></div>
      <div class="s"><div class="sl">Peak Util</div><div class="sv ${run.peakUtilization > 0.85 ? 'red' : 'grn'}">${Math.round(run.peakUtilization * 100)}%</div></div>
      <div class="s"><div class="sl">Avg Error</div><div class="sv ${run.avgErrorRate > 0.01 ? 'red' : 'grn'}">${(run.avgErrorRate * 100).toFixed(2)}%</div></div>
      <div class="s"><div class="sl">SLO Failures</div><div class="sv ${run.sloViolations > 0 ? 'red' : 'grn'}">${run.sloViolations}</div></div>
      <div class="s"><div class="sl">Nodes</div><div class="sv">${run.nodeSnapshots.size}</div></div>
      <div class="s"><div class="sl">Events</div><div class="sv">${run.events.length}</div></div>
      <div class="s"><div class="sl">Traffic Mode</div><div class="sv" style="font-size:13px">${modeLabel[run.trafficMode] ?? run.trafficMode}</div></div>
    </div>

    <h2>SLO Status</h2>
    <table><thead><tr><th>Node</th><th>Type</th><th>Violation</th></tr></thead><tbody>${sloHtml}</tbody></table>

    <h2>Top Nodes by Utilization</h2>
    <table>
      <thead><tr><th>Node</th><th>Type</th><th colspan="2">Utilization</th><th style="text-align:right">RPS In</th><th style="text-align:right">Error</th><th style="text-align:right">P90</th></tr></thead>
      <tbody>${topNodesRows}</tbody>
    </table>

    <h2>All Node Snapshots</h2>
    <table>
      <thead><tr><th>Node</th><th>Type</th><th style="text-align:right">RPS In</th><th style="text-align:right">Util</th><th style="text-align:right">Error</th><th style="text-align:right">P50</th><th style="text-align:right">P90</th><th style="text-align:right">P99</th></tr></thead>
      <tbody>${allNodesRows}</tbody>
    </table>

    <h2>Event Timeline (${run.events.length} events)</h2>
    <table><thead><tr><th>Time</th><th>Type</th><th>Message</th></tr></thead><tbody>${eventsHtml}</tbody></table>
  `

  // Inject report into current document and use window.print()
  // (window.open() is blocked by Tauri's webview security policy)
  const styleEl = document.createElement('style')
  styleEl.id = 'smp-print-style'
  styleEl.textContent = css + `
    #smp-print-root { display: none }
    @media print {
      #smp-print-root { display: block !important }
      body > *:not(#smp-print-root) { display: none !important }
    }
  `

  const rootEl = document.createElement('div')
  rootEl.id = 'smp-print-root'
  rootEl.innerHTML = body

  document.head.appendChild(styleEl)
  document.body.appendChild(rootEl)

  function cleanup() {
    styleEl.remove()
    rootEl.remove()
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)

  window.print()
}

// ─── RunDetailOverlay ─────────────────────────────────────────────────────────

function RunDetailOverlay({ run, runIndex, onClose }: { run: SimulationRun; runIndex: number; onClose: () => void }) {
  const { nodes } = useCanvasStore()

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const durationLabel = run.durationS >= 60
    ? `${Math.floor(run.durationS / 60)}m ${run.durationS % 60}s`
    : `${run.durationS}s`

  const startLabel = new Date(run.startedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const allPass = run.sloViolations === 0

  const modeLabel: Record<string, string> = {
    steady: 'Steady Load', ramp: 'Gradual Ramp', spike: 'Flash Crowd', chaos: 'Chaos',
  }

  // Top-5 nodes by utilization
  const topNodes = Array.from(run.nodeSnapshots.entries())
    .sort(([, a], [, b]) => b.utilization - a.utilization)
    .slice(0, 5)

  // SLO violation events grouped by nodeId
  const sloViolationEvents = run.events.filter(e => e.type === 'slo_violation')
  const violatedNodeIds = [...new Set(sloViolationEvents.map(e => e.nodeId).filter(Boolean))] as string[]

  const getNodeLabel = (id: string) => {
    const n = nodes.find(n => n.id === id)
    return (n?.data as NodeData)?.label ?? id
  }
  const getNodeType = (id: string) => nodes.find(n => n.id === id)?.type as NodeType | undefined

  return (
    <div className={styles.overlayBackdrop} onClick={onClose}>
      <div className={styles.overlayCard} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.overlayHeader}>
          <div className={styles.overlayHeaderLeft}>
            <span className={styles.overlayRunNum}>Run #{runIndex + 1}</span>
            <span className={`${styles.overlayPassBadge} ${allPass ? styles.overlayPassBadgeGreen : styles.overlayPassBadgeRed}`}>
              {allPass ? '✓ All SLOs Pass' : `✗ ${run.sloViolations} SLO${run.sloViolations !== 1 ? 's' : ''} Failed`}
            </span>
            <span className={styles.overlayModePill}>
              {modeLabel[run.trafficMode] ?? run.trafficMode} · {run.globalMultiplier}×
            </span>
          </div>
          <button className={styles.overlayClose} onClick={onClose} title="Close (Escape)">
            <X size={13} />
          </button>
        </div>

        <div className={styles.overlayBody}>
          {/* Stats grid */}
          <div className={styles.statsGrid}>
            {[
              { label: 'Duration',    value: durationLabel },
              { label: 'Peak RPS',    value: run.peakRps >= 1000 ? `${(run.peakRps/1000).toFixed(1)}k` : String(Math.round(run.peakRps)) },
              { label: 'Peak Util',   value: `${Math.round(run.peakUtilization * 100)}%`, alert: run.peakUtilization > 0.85 },
              { label: 'Avg Error',   value: `${(run.avgErrorRate * 100).toFixed(2)}%`, alert: run.avgErrorRate > 0.01 },
              { label: 'SLO Fails',   value: String(run.sloViolations), alert: run.sloViolations > 0 },
              { label: 'Nodes',       value: String(run.nodeSnapshots.size) },
              { label: 'Events',      value: String(run.events.length) },
              { label: 'Started',     value: startLabel },
              ...(run.costSummary ? [{ label: 'Est. Cost/mo', value: formatUsd(run.costSummary.totalMonthlyUsd) }] : []),
            ].map(({ label, value, alert }) => (
              <div key={label} className={styles.statCard}>
                <span className={styles.statLabel}>{label}</span>
                <span className={`${styles.statVal} ${alert ? styles.statValAlert : ''}`}>{value}</span>
              </div>
            ))}
          </div>

          {/* Top-5 utilization bar chart */}
          {topNodes.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Top Nodes by Utilization</div>
              <div className={styles.barChart}>
                {topNodes.map(([id, m]) => {
                  const label = getNodeLabel(id)
                  const nt = getNodeType(id)
                  const cfg = nt ? NODE_CONFIG[nt] : undefined
                  const pct = Math.min(100, Math.round(m.utilization * 100))
                  const color = m.utilization >= 0.85 ? 'var(--color-danger)' : m.utilization >= 0.6 ? 'var(--color-warning)' : 'var(--color-success-text)'
                  return (
                    <div key={id} className={styles.barRow}>
                      <div className={styles.barLabel}>
                        {cfg?.icon && <cfg.icon size={10} style={{ color: 'var(--color-text-muted)' }} />}
                        <span>{label}</span>
                      </div>
                      <div className={styles.barTrack}>
                        <div className={styles.barFill} style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <span className={styles.barPct} style={{ color }}>{pct}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Estimated cloud cost breakdown */}
          {run.costSummary && run.costSummary.perNode.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>
                Estimated Cloud Cost — ~{formatUsd(run.costSummary.totalMonthlyUsd)}/mo
              </div>
              <div className={styles.sloTable}>
                {run.costSummary.perNode.map(n => (
                  <div key={n.nodeId} className={styles.barRow}>
                    <div className={styles.barLabel}>
                      <span>{n.nodeLabel}</span>
                      <span style={{ color: 'var(--color-text-muted)', fontSize: 9 }}>{n.serviceName}</span>
                    </div>
                    <span className={styles.barPct} style={{ color: 'var(--color-warning)', marginLeft: 'auto' }}>
                      {formatUsd(n.monthlyUsd)}/mo
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* SLO breakdown */}
          {violatedNodeIds.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>SLO Violations</div>
              <div className={styles.sloTable}>
                {violatedNodeIds.map(id => {
                  const nt = getNodeType(id)
                  const cfg = nt ? NODE_CONFIG[nt] : undefined
                  const snap = run.nodeSnapshots.get(id)
                  const evs = sloViolationEvents.filter(e => e.nodeId === id)
                  return (
                    <div key={id} className={styles.sloRow}>
                      <div className={styles.sloRowLeft}>
                        {cfg?.icon && <cfg.icon size={11} style={{ color: 'var(--color-danger)' }} />}
                        <span className={styles.sloNodeName}>{getNodeLabel(id)}</span>
                        {nt && <span className={styles.sloNodeType}>{nt}</span>}
                      </div>
                      <div className={styles.sloRowRight}>
                        {evs[0]?.message && (
                          <span className={styles.sloMsg}>{evs[0].message}</span>
                        )}
                        {snap && (
                          <span className={styles.sloMetrics}>
                            Util {Math.round(snap.utilization * 100)}% · P90 {Math.round(snap.p90LatencyMs)}ms
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Event timeline */}
          {run.events.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Event Timeline ({run.events.length})</div>
              <div className={styles.eventList}>
                {run.events.slice(0, 30).map(ev => (
                  <EventCard key={ev.id} ev={ev} />
                ))}
                {run.events.length > 30 && (
                  <div className={styles.eventListMore}>+{run.events.length - 30} more events</div>
                )}
              </div>
            </div>
          )}

          {/* PDF export */}
          <div className={styles.shareRow}>
            <button
              className={styles.shareBtn}
              onClick={() => exportRunAsPdf(run, runIndex, nodes)}
            >
              Export PDF
            </button>
            <span className={styles.shareHint}>Opens print dialog — save as PDF</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Run card ─────────────────────────────────────────────────────────────────

function RunCard({ run, runIndex, onClick }: { run: SimulationRun; runIndex: number; onClick: () => void }) {
  const durationLabel = run.durationS >= 60
    ? `${Math.floor(run.durationS / 60)}m ${run.durationS % 60}s`
    : `${run.durationS}s`

  const modeLabel: Record<string, string> = {
    steady: 'Steady Load', ramp: 'Gradual Ramp', spike: 'Flash Crowd', chaos: 'Chaos',
  }

  const allPass = run.sloViolations === 0
  const dateLabel = new Date(run.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  return (
    <button className={styles.runCard} onClick={onClick}>
      <div className={styles.runCardTop}>
        <span className={styles.runCardNum}>Run #{runIndex + 1}</span>
        <span className={styles.runCardDur}>{durationLabel}</span>
        <span className={styles.runCardTime}>{dateLabel}</span>
      </div>
      <div className={styles.runCardMid}>
        <span className={styles.runCardRps}>Peak {run.peakRps >= 1000 ? `${(run.peakRps/1000).toFixed(1)}k` : Math.round(run.peakRps)} RPS</span>
        <span className={`${styles.runCardSlo} ${allPass ? styles.runCardSloPass : styles.runCardSloFail}`}>
          {allPass ? `✓ ${run.nodeSnapshots.size} nodes pass` : `✗ ${run.sloViolations} SLO fail`}
        </span>
      </div>
      <div className={styles.runCardBot}>
        <span className={styles.runCardMode}>{modeLabel[run.trafficMode] ?? run.trafficMode} · {run.globalMultiplier}×</span>
      </div>
    </button>
  )
}

// ─── ReportsPanel ─────────────────────────────────────────────────────────────

export function ReportsPanel() {
  const { setReportsPanelOpen } = useUiStore()
  const runs = useSimulationStore(s => s.runs)
  const [selectedRun, setSelectedRun] = useState<{ run: SimulationRun; index: number } | null>(null)

  const handleClose = useCallback(() => setReportsPanelOpen(false), [setReportsPanelOpen])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !selectedRun) handleClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [handleClose, selectedRun])

  return (
    <>
      <div className={styles.panel}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.title}>Reports</span>
            <span className={styles.runCount}>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
          </div>
          <button className={styles.closeBtn} onClick={handleClose} title="Close (Escape)">
            <X size={13} />
          </button>
        </div>

        {/* Run list */}
        <div className={styles.body}>
          {runs.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>📊</div>
              <div className={styles.emptyTitle}>No runs yet</div>
              <div className={styles.emptySub}>Run the simulation and stop it to capture a report</div>
            </div>
          ) : (
            runs.map((run, i) => (
              <RunCard
                key={run.id}
                run={run}
                runIndex={i}
                onClick={() => setSelectedRun({ run, index: i })}
              />
            ))
          )}
        </div>

        {/* Footer note */}
        {runs.length > 0 && (
          <div className={styles.footer}>
            {/* TODO: persist to disk via Tauri fs */}
            Reports stored in memory · reset on reload
          </div>
        )}
      </div>

      {selectedRun && (
        <RunDetailOverlay
          run={selectedRun.run}
          runIndex={selectedRun.index}
          onClose={() => setSelectedRun(null)}
        />
      )}
    </>
  )
}
