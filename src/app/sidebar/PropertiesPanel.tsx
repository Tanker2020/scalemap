import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { NODE_CONFIG, GROUPING_TYPES, type NodeStatus, type EdgeType, type NodeType, type NodeData as ND } from '../../lib/nodeConfig'
import { REGIONS_BY_ZONE, WORLD_REGIONS } from '../../lib/regionConfig'
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
  const consumerLagMs = useSimulationStore(s => s.nodeMetrics.get(nodeId)?.consumerLagMs)

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

        {/* Group containers: configure which geographic region they represent */}
        {GROUPING_TYPES.has(nodeType) && (
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
              <option value="">None</option>
              <optgroup label="── AMER ──">
                {REGIONS_BY_ZONE.AMER.map(r => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </optgroup>
              <optgroup label="── EMEA ──">
                {REGIONS_BY_ZONE.EMEA.map(r => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </optgroup>
              <optgroup label="── APAC ──">
                {REGIONS_BY_ZONE.APAC.map(r => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </optgroup>
            </select>
            {data.regionId && (
              <div style={{ fontSize: 10, color: '#475569', marginTop: 6, lineHeight: 1.6 }}>
                Cross-region edge latency is determined by the zone pair, not the region itself:
                <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1px 8px', fontFamily: 'inherit' }}>
                  <span style={{ color: '#4A9EFF' }}>AMER ↔ EMEA</span><span>~80ms</span>
                  <span style={{ color: '#4A9EFF' }}>AMER ↔ APAC</span><span>~170ms</span>
                  <span style={{ color: '#4A9EFF' }}>EMEA ↔ APAC</span><span>~140ms</span>
                  <span style={{ color: '#4A9EFF' }}>Same zone</span><span>~25–45ms</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Compute nodes: show inherited region if inside a group container */}
        {!GROUPING_TYPES.has(nodeType) && (() => {
          // Walk ancestor chain to find nearest container with a regionId
          const nodeMap = new Map(nodes.map(n => [n.id, n]))
          let cur = nodeMap.get(selectedNode.parentId ?? '')
          while (cur) {
            const rid = (cur.data as ND)?.regionId
            if (rid) {
              const region = WORLD_REGIONS.find(r => r.id === rid)
              return region ? (
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Geographic Region</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', padding: '4px 0' }}>
                    {region.label}
                    <span style={{ color: '#475569', fontSize: 10, marginLeft: 6 }}>
                      +{region.baseLatencyMs}ms base latency
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                    Inherited from <span style={{ color: '#64748B' }}>{(cur.data as ND)?.label ?? cur.id}</span>
                  </div>
                </div>
              ) : null
            }
            cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined
          }
          return null
        })()}

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
            {consumerLagMs !== undefined && (
              <div className={styles.metricRow} title="Time to drain the current backlog at the consumer's current rate">
                <span className={styles.metricLabel}>Consumer Lag</span>
                <span className={styles.metricVal} style={{ color: consumerLagMs > 5000 ? '#EF4444' : consumerLagMs > 1000 ? '#F59E0B' : '#22C55E' }}>
                  {consumerLagMs === Infinity ? '∞'
                    : consumerLagMs >= 60000 ? `${(consumerLagMs / 60000).toFixed(1)}m`
                    : consumerLagMs >= 1000  ? `${(consumerLagMs / 1000).toFixed(1)}s`
                    : `${Math.round(consumerLagMs)}ms`}
                </span>
              </div>
            )}
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

    // Resolve the effective regionId for a node by walking its ancestor chain
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    const resolveEdgeRegion = (nodeId: string) => {
      let cur = nodeMap.get(nodeId)
      while (cur) {
        const rid = (cur.data as ND)?.regionId
        if (rid) return { regionId: rid, label: (cur.data as ND)?.label ?? cur.id }
        cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined
      }
      return null
    }
    const srcRegion = resolveEdgeRegion(selectedEdge.source)
    const tgtRegion = resolveEdgeRegion(selectedEdge.target)
    const hasPartialRegion = (!!srcRegion) !== (!!tgtRegion)

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
          {hasPartialRegion && (
            <div style={{
              margin: '0 0 2px', padding: '8px 12px',
              background: '#1C1500', border: '1px solid #F59E0B44', borderRadius: 5,
            }}>
              <div style={{ fontSize: 10, color: '#FCD34D', fontWeight: 600, marginBottom: 3 }}>
                ⚠ Partial region coverage
              </div>
              <div style={{ fontSize: 10, color: '#94A3B8', lineHeight: 1.6 }}>
                {srcRegion
                  ? <>Source is in <span style={{ color: '#F1F5F9' }}>{srcRegion.label}</span> ({srcRegion.regionId}) but the target has no region assigned.</>
                  : <>Target is in <span style={{ color: '#F1F5F9' }}>{tgtRegion!.label}</span> ({tgtRegion!.regionId}) but the source has no region assigned.</>
                }
              </div>
              <div style={{ fontSize: 10, color: '#64748B', marginTop: 4 }}>
                Assign the other node to a region container for accurate inter-region latency. A default +50ms is applied for now.
              </div>
            </div>
          )}

          <div className={styles.section}>
            <div className={styles.sectionLabel}>Type</div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Connection type</span>
              <select
                className={styles.edgeTypeSelect}
                value={data?.edgeType ?? 'request'}
                disabled={running}
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
            <div className={styles.sectionLabel}>
              Simulation
              {running && <span className={styles.lockHint}> · stop sim to edit</span>}
            </div>
            <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, opacity: running ? 0.45 : 1 }}>
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
            </fieldset>
          </div>
        </motion.div>
        </AnimatePresence>
      </aside>
    )
  }

  return null
}
