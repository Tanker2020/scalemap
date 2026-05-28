import { useState, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore, type SimulationRun } from '../store/simulation.store'
import { useUiStore } from '../store/ui.store'
import { NODE_CONFIG, type NodeType, type NodeData } from '../../lib/nodeConfig'
import { EventCard } from '../simulation/SimConfigPanel'
import styles from './ReportsPanel.module.css'

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
                  const color = m.utilization >= 0.85 ? '#EF4444' : m.utilization >= 0.6 ? '#F59E0B' : '#22C55E'
                  return (
                    <div key={id} className={styles.barRow}>
                      <div className={styles.barLabel}>
                        {cfg?.icon && <cfg.icon size={10} style={{ color: '#64748B' }} />}
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
                        {cfg?.icon && <cfg.icon size={11} style={{ color: '#EF4444' }} />}
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

          {/* Share stub */}
          <div className={styles.shareRow}>
            <button className={styles.shareBtn} disabled title="Coming soon — disk export in next release">
              Share Report
            </button>
            <span className={styles.shareHint}>Disk export coming soon</span>
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
