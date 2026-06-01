import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { NODE_CONFIG, type NodeStatus, type EdgeType, type NodeType } from '../../lib/nodeConfig'
import { REGIONS_BY_ZONE } from '../../lib/regionConfig'
import { CATEGORY_COLORS } from '../../lib/theme'
import { Sparkline } from './Sparkline'
import { EventCard } from '../simulation/SimConfigPanel'
import { MetricGraphOverlay, type GraphMetric } from '../analytics/MetricGraphOverlay'
import styles from './PropertiesPanel.module.css'

// ─── Tab bar ──────────────────────────────────────────────────────────────────

function TabBar() {
  const { rightTab, setRightTab } = useUiStore()
  return (
    <div className={styles.tabs}>
      <button
        className={`${styles.tab} ${rightTab === 'properties' ? styles.activeTab : ''}`}
        onClick={() => setRightTab('properties')}
      >
        Properties
      </button>
      <button
        className={`${styles.tab} ${rightTab === 'analytics' ? styles.activeTab : ''}`}
        onClick={() => setRightTab('analytics')}
      >
        Analytics
      </button>
    </div>
  )
}

// ─── Analytics pane (system-wide only) ───────────────────────────────────────

function AnalyticsPane() {
  const running     = useSimulationStore(s => s.running)
  const bottlenecks = useSimulationStore(s => s.bottlenecks)
  const nodeMetrics = useSimulationStore(s => s.nodeMetrics)
  const events      = useSimulationStore(s => s.events)
  const sloStatus   = useSimulationStore(s => s.sloStatus)
  const systemHistory = useMetricsHistoryStore(s => s.systemHistory)
  const { setSimConfigOpen } = useUiStore()

  const totalInRps    = Array.from(nodeMetrics.values()).reduce((s, m) => s + m.inRps, 0)
  const sloViolations = Array.from(sloStatus.values()).filter(s => !s.passing).length
  const sloPassing    = Array.from(sloStatus.values()).filter(s => s.passing).length
  const sysUtilData   = systemHistory.map(s => s.utilization)
  const sysRpsData    = systemHistory.map(s => s.inRps)

  if (!running) {
    return (
      <div className={styles.analyticsPane}>
        <div className={styles.analyticsIcon}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </div>
        <div className={styles.analyticsTitle}>System Analytics</div>
        <div className={styles.analyticsSub}>
          Run a simulation to see system-wide throughput, bottlenecks, and SLO status.
        </div>
        {events.length > 0 && (
          <div className={styles.eventLogSection} style={{ width: '100%', textAlign: 'left', marginTop: 12 }}>
            <div className={styles.sectionLabel}>Last Run Events</div>
            {events.slice(0, 5).map(ev => <EventCard key={ev.id} ev={ev} />)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.scroll}>
      <div className={styles.section}>
        <div className={styles.sectionLabel}>System</div>
        <div className={styles.metricRow}>
          <span className={styles.metricLabel}>Total Traffic</span>
          <span className={styles.metricVal}>{Math.round(totalInRps / 2)} RPS</span>
        </div>
        <div className={styles.metricRow}>
          <span className={styles.metricLabel}>Bottlenecks</span>
          <span className={styles.metricVal} style={{ color: bottlenecks.size > 0 ? '#F59E0B' : '#22C55E' }}>
            {bottlenecks.size} node{bottlenecks.size !== 1 ? 's' : ''}
          </span>
        </div>
        {sloStatus.size > 0 && (
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>SLO Status</span>
            <span className={styles.metricVal} style={{ color: sloViolations > 0 ? '#EF4444' : '#22C55E' }}>
              {sloPassing} pass · {sloViolations} fail
            </span>
          </div>
        )}
      </div>

      {sysUtilData.length > 1 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>System Utilization (60s)</div>
          <Sparkline data={sysUtilData} color="#4A9EFF" height={32} />
        </div>
      )}

      {sysRpsData.length > 1 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Traffic (60s)</div>
          <Sparkline data={sysRpsData} color="#22C55E" height={28} />
        </div>
      )}

      {events.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Event Log</div>
          <div className={styles.eventCards}>
            {events.slice(0, 8).map(ev => <EventCard key={ev.id} ev={ev} />)}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <button className={styles.inspectorHintBtn} onClick={() => setSimConfigOpen(true)}>
          <span>⚙ Open Simulation Inspector</span>
          <span className={styles.inspectorHintArrow}>→</span>
        </button>
      </div>
    </div>
  )
}

// ─── Inspector hint ───────────────────────────────────────────────────────────

function OpenInInspectorHint({ nodeId }: { nodeId: string }) {
  const { setSimConfigOpen, setSimConfigPanelNode } = useUiStore()

  function open() {
    setSimConfigPanelNode(nodeId)
    setSimConfigOpen(true)
  }

  return (
    <div className={styles.section}>
      <button className={styles.inspectorHintBtn} onClick={open}>
        <span>⚙ Configure simulation &amp; view live metrics</span>
        <span className={styles.inspectorHintArrow}>→</span>
      </button>
    </div>
  )
}

// ─── Node properties panel ────────────────────────────────────────────────────

function NodePanel({ nodeId }: { nodeId: string }) {
  const { nodes, updateNodeData } = useCanvasStore()
  const selectedNode = nodes.find(n => n.id === nodeId)!
  const nodeType = selectedNode.type as NodeType
  const config = NODE_CONFIG[nodeType]
  const colors = config ? CATEGORY_COLORS[config.category] : CATEGORY_COLORS.compute
  const data = selectedNode.data as import('../../lib/nodeConfig').NodeData
  const [showNotes, setShowNotes] = useState(!!data.notes)
  const [showSubtitle, setShowSubtitle] = useState(!!data.subtitle)
  const [graphOverlay, setGraphOverlay] = useState<GraphMetric | null>(null)
  const running = useSimulationStore(s => s.running)
  const nodeHistory = useMetricsHistoryStore(s => s.history.get(nodeId))

  return (
    <>
      {config && (
        <div className={styles.header}>
          <span
            className={styles.typeBadge}
            style={{ color: colors.accent, borderColor: `${colors.accent}44` }}
          >
            {config.category}
          </span>
        </div>
      )}
      <AnimatePresence mode="wait">
      <motion.div
        key={selectedNode.id}
        className={styles.scroll}
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 8 }}
        transition={{ duration: 0.18 }}
      >
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Identity</div>
          <input
            className={styles.field}
            placeholder="Label"
            value={data.label}
            onChange={e => updateNodeData(selectedNode.id, { label: e.target.value })}
          />
          {showSubtitle ? (
            <input
              className={styles.field}
              placeholder="Subtitle (e.g. instance type)"
              value={data.subtitle}
              onChange={e => updateNodeData(selectedNode.id, { subtitle: e.target.value })}
            />
          ) : (
            <button className={styles.addLink} onClick={() => setShowSubtitle(true)}>+ Add subtitle</button>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>Status</div>
          <div className={styles.statusDots}>
            {(['healthy', 'degraded', 'down', 'idle'] as NodeStatus[]).map(s => (
              <button
                key={s}
                className={`${styles.statusDotBtn} ${data.status === s ? styles.statusDotBtnActive : ''}`}
                style={{
                  '--dot-color': s === 'healthy' ? '#22C55E' : s === 'degraded' ? '#F59E0B' : s === 'down' ? '#EF4444' : '#475569',
                } as React.CSSProperties}
                onClick={() => updateNodeData(selectedNode.id, { status: s })}
                title={s.charAt(0).toUpperCase() + s.slice(1)}
              />
            ))}
            <span className={styles.statusLabel}>{data.status}</span>
          </div>
        </div>

        {nodeType === 'region' && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Geographic Region</div>
            <select
              value={data.regionId ?? ''}
              onChange={e => updateNodeData(selectedNode.id, { regionId: e.target.value || undefined })}
              style={{
                width: '100%', background: '#0D0F12', color: '#F1F5F9',
                border: '1px solid #2A2E38', borderRadius: 4,
                padding: '6px 8px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer',
              }}
            >
              <option value="">None (no geographic latency)</option>
              <optgroup label="── AMER ──">
                {REGIONS_BY_ZONE.AMER.map(r => (
                  <option key={r.id} value={r.id}>{r.label} (+{r.baseLatencyMs}ms)</option>
                ))}
              </optgroup>
              <optgroup label="── EMEA ──">
                {REGIONS_BY_ZONE.EMEA.map(r => (
                  <option key={r.id} value={r.id}>{r.label} (+{r.baseLatencyMs}ms)</option>
                ))}
              </optgroup>
              <optgroup label="── APAC ──">
                {REGIONS_BY_ZONE.APAC.map(r => (
                  <option key={r.id} value={r.id}>{r.label} (+{r.baseLatencyMs}ms)</option>
                ))}
              </optgroup>
            </select>
            {data.regionId && (
              <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
                Nodes inside this region container will incur inter-region latency on cross-region edges.
              </div>
            )}
          </div>
        )}

        {showNotes ? (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Notes</div>
            <textarea
              className={styles.field}
              placeholder="Add notes..."
              value={data.notes}
              onChange={e => updateNodeData(selectedNode.id, { notes: e.target.value })}
            />
          </div>
        ) : (
          <div className={styles.section}>
            <button className={styles.addLink} onClick={() => setShowNotes(true)}>+ Add notes</button>
          </div>
        )}

        {running && nodeHistory && nodeHistory.length > 1 && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Live Metrics</div>
            <button className={styles.sparkClickable} onClick={() => setGraphOverlay('utilization')} title="Click for full graph">
              <span className={styles.sparkClickLabel}>Utilization</span>
              <Sparkline data={nodeHistory.map(s => s.utilization)} color="#4A9EFF" height={26} />
            </button>
            <button className={styles.sparkClickable} onClick={() => setGraphOverlay('inRps')} title="Click for full graph">
              <span className={styles.sparkClickLabel}>RPS</span>
              <Sparkline data={nodeHistory.map(s => s.inRps)} color="#22C55E" height={26} />
            </button>
            <button className={styles.sparkClickable} onClick={() => setGraphOverlay('errorRate')} title="Click for full graph">
              <span className={styles.sparkClickLabel}>Errors</span>
              <Sparkline data={nodeHistory.map(s => s.errorRate)} color="#EF4444" height={26} />
            </button>
          </div>
        )}

        {config && !config.isGroup && (
          <OpenInInspectorHint nodeId={selectedNode.id} />
        )}
      </motion.div>
      </AnimatePresence>

      {graphOverlay && (
        <MetricGraphOverlay nodeId={nodeId} metric={graphOverlay} onClose={() => setGraphOverlay(null)} />
      )}
    </>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function PropertiesPanel() {
  const { selectedNodeId, selectedEdgeId, rightTab, setRightTab } = useUiStore()
  const { nodes, edges, updateEdgeData, changeEdgeType } = useCanvasStore()
  const { setEdgeRps, getEdgeRps, running } = useSimulationStore()

  // Auto-switch to Analytics when simulation starts
  useEffect(() => {
    if (running) setRightTab('analytics')
  }, [running, setRightTab])

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)

  if (rightTab === 'analytics') {
    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <AnalyticsPane />
      </aside>
    )
  }

  if (!selectedNode && !selectedEdge) {
    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <div className={styles.empty}>Select a node or edge to view its properties</div>
      </aside>
    )
  }

  if (selectedNode) {
    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <NodePanel nodeId={selectedNode.id} />
      </aside>
    )
  }

  // Edge selected
  if (selectedEdge) {
    const data = selectedEdge.data as import('../../lib/nodeConfig').EdgeData
    const rps = getEdgeRps(selectedEdge.id)

    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <div className={styles.header}>
          <span className={styles.typeBadge} style={{ color: '#4A9EFF', borderColor: '#4A9EFF44' }}>
            Edge
          </span>
        </div>
        <AnimatePresence mode="wait">
        <motion.div
          key={selectedEdge.id}
          className={styles.scroll}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 8 }}
          transition={{ duration: 0.18 }}
        >
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Type</div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Connection type</span>
              <select
                className={styles.edgeTypeSelect}
                value={data?.edgeType ?? 'request'}
                onChange={e => changeEdgeType(selectedEdge.id, e.target.value as EdgeType)}
              >
                <option value="request">Request/Response</option>
                <option value="stream">Data Stream</option>
                <option value="event">Event</option>
                <option value="dependency">Dependency</option>
              </select>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionLabel}>Label</div>
            <input
              className={styles.field}
              placeholder="Edge label"
              value={data?.label ?? ''}
              onChange={e => updateEdgeData(selectedEdge.id, { label: e.target.value })}
            />
          </div>

          <div className={styles.section}>
            <div className={styles.sectionLabel}>Simulation</div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Throughput (RPS)</span>
              <input
                className={styles.numberInput}
                type="number"
                min={1}
                max={10000}
                value={rps}
                onChange={e => setEdgeRps(selectedEdge.id, Number(e.target.value))}
              />
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Latency (ms)</span>
              <input
                className={styles.numberInput}
                type="number"
                min={0}
                value={data?.latency ?? 20}
                onChange={e => updateEdgeData(selectedEdge.id, { latency: Number(e.target.value) })}
              />
            </div>
          </div>
        </motion.div>
        </AnimatePresence>
      </aside>
    )
  }

  return null
}
