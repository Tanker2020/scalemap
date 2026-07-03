import { useState, useEffect } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { useDisplayMetrics, useDisplayMetricsMap } from '../canvas/simulation/useDisplayMetrics'
import { NODE_CONFIG, GROUPING_TYPES, edgeAcceptsProtocol, type NodeStatus, type EdgeType, type NodeType, type NodeData as ND, type NodeCostConfig, type PacketProtocol } from '../../lib/nodeConfig'
import { REGIONS_BY_ZONE, WORLD_REGIONS } from '../../lib/regionConfig'
import { CATEGORY_COLORS } from '../../lib/theme'
import { CLOUD_REGISTRY, getServiceSpec, providerLabelForNode, type CloudProvider, type CostComponentSpec } from '../../lib/cloudRegistry'
import { Sparkline } from './Sparkline'
import { EventCard } from '../simulation/SimConfigPanel'
import { MetricGraphOverlay, type GraphMetric } from '../analytics/MetricGraphOverlay'
import { EdgeConfigForm } from './EdgeConfigForm'
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
  const nodeMetrics = useDisplayMetricsMap()
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
          <span className={styles.metricVal} style={{ color: bottlenecks.size > 0 ? 'var(--color-warning)' : 'var(--color-success-text)' }}>
            {bottlenecks.size} node{bottlenecks.size !== 1 ? 's' : ''}
          </span>
        </div>
        {sloStatus.size > 0 && (
          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>SLO Status</span>
            <span className={styles.metricVal} style={{ color: sloViolations > 0 ? 'var(--color-danger)' : 'var(--color-success-text)' }}>
              {sloPassing} pass · {sloViolations} fail
            </span>
          </div>
        )}
      </div>

      {sysUtilData.length > 1 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>System Utilization (60s)</div>
          <Sparkline data={sysUtilData} color="var(--color-accent)" height={32} />
        </div>
      )}

      {sysRpsData.length > 1 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Traffic (60s)</div>
          <Sparkline data={sysRpsData} color="var(--color-success)" height={28} />
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

// ─── Packet distribution (custom mode, traffic-generating nodes) ──────────────

const PROTOCOL_DOT: Record<string, string> = {
  http: '#4A9EFF', event: '#2DD4BF', stream: '#A78BFA', db: '#F5A623',
}

// Transport groups, in display order. Templates within a group renormalize independently, since
// each group's traffic rides its own edge type and its cross-group volume is set by edge rps.
const TRANSPORT_GROUPS: { type: EdgeType; label: string }[] = [
  { type: 'request', label: 'Request · HTTP / DB' },
  { type: 'event',   label: 'Event' },
  { type: 'stream',  label: 'Stream' },
]

// Which transport group a protocol belongs to (http/db → request, event → event, stream → stream).
function groupOfProtocol(protocol: PacketProtocol): EdgeType {
  return (TRANSPORT_GROUPS.find(g => edgeAcceptsProtocol(g.type, protocol))?.type) ?? 'request'
}

function PacketDistributionSection({ nodeId }: { nodeId: string }) {
  const packetMode      = useCanvasStore(s => s.packetMode)
  const templates       = useCanvasStore(s => s.packetTemplates)
  const edges           = useCanvasStore(s => s.edges)
  const updateNodeData  = useCanvasStore(s => s.updateNodeData)
  const setPacketEditorOpen = useUiStore(s => s.setPacketEditorOpen)
  const node            = useCanvasStore(s => s.nodes.find(n => n.id === nodeId))
  const running         = useSimulationStore(s => s.running)

  // Only meaningful in custom mode for nodes that actually originate traffic on an outbound edge.
  const outboundTypes = new Set<EdgeType>(
    edges.filter(e => e.source === nodeId && (e.data?.edgeType ?? 'request') !== 'dependency')
         .map(e => (e.data?.edgeType ?? 'request') as EdgeType),
  )
  if (packetMode !== 'custom' || outboundTypes.size === 0) return null

  const data = (node?.data ?? {}) as ND
  const dist = data.packetDistribution ?? []
  const templateList = Object.values(templates).sort((a, b) => a.id - b.id)
  const setDist = (next: typeof dist) => updateNodeData(nodeId, { packetDistribution: next })

  const addRow = () => {
    const used = new Set(dist.map(d => d.templateId))
    const free = templateList.find(t => !used.has(t.id))
    if (!free) return
    setDist([...dist, { templateId: free.id, weight: 10 }])
  }

  // Rows paired with their original index (needed to write back into the flat dist array).
  const rows = dist.map((row, i) => ({ row, i, tpl: templates[row.templateId] }))

  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Packet Distribution</div>

      {templateList.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          No packet templates yet.{' '}
          <button className={styles.addLink} onClick={() => setPacketEditorOpen(true)}>Open Packet Editor</button>
        </div>
      ) : (
        <>
          {dist.length === 0 && (
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', lineHeight: 1.5, marginBottom: 5 }}>No traffic mix assigned — this node generates generic packets.</div>
          )}

          {TRANSPORT_GROUPS.map(group => {
            const groupRows = rows.filter(r => r.tpl && groupOfProtocol(r.tpl.protocol) === group.type)
            if (groupRows.length === 0) return null
            const groupTotal = groupRows.reduce((s, r) => s + (r.row.weight > 0 ? r.row.weight : 0), 0)
            const noEdge = !outboundTypes.has(group.type)  // dead weight: nothing will spawn

            return (
              <div key={group.type} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 9, color: noEdge ? 'var(--color-danger)' : 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
                  {group.label}{noEdge ? ' — no matching edge, won’t spawn' : ''}
                </div>
                {groupRows.map(({ row, i, tpl }) => {
                  const pct = groupTotal > 0 && row.weight > 0 ? Math.round((row.weight / groupTotal) * 100) : 0
                  return (
                    <div key={i} className={styles.row} style={{ gap: 6, alignItems: 'center', marginBottom: 5, opacity: noEdge ? 0.5 : 1 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: tpl?.colorOverride ?? PROTOCOL_DOT[tpl?.protocol ?? 'http'], flexShrink: 0 }} />
                      <select
                        className={styles.field}
                        style={{ flex: 1, minWidth: 0 }}
                        disabled={running}
                        value={row.templateId}
                        onChange={e => {
                          const next = [...dist]
                          next[i] = { ...row, templateId: Number(e.target.value) }
                          setDist(next)
                        }}
                      >
                        {templateList.map(t => <option key={t.id} value={t.id}>#{t.id} {t.name}</option>)}
                      </select>
                      <input
                        className={styles.field}
                        style={{ width: 52 }}
                        type="number"
                        min={0}
                        disabled={running}
                        value={row.weight}
                        onChange={e => {
                          const next = [...dist]
                          next[i] = { ...row, weight: Math.max(0, Number(e.target.value)) }
                          setDist(next)
                        }}
                      />
                      <span style={{ fontSize: 10, color: 'var(--color-text-muted)', width: 30, textAlign: 'right' }}>{pct}%</span>
                      <button
                        className={styles.addLink}
                        disabled={running}
                        style={{ color: 'var(--color-danger)' }}
                        onClick={() => setDist(dist.filter((_, j) => j !== i))}
                        title="Remove"
                      >×</button>
                    </div>
                  )
                })}
              </div>
            )
          })}

          {dist.length < templateList.length && (
            <button className={styles.addLink} disabled={running} onClick={addRow}>+ Add template</button>
          )}
        </>
      )}
    </div>
  )
}

function NodePanel({ nodeId }: { nodeId: string }) {
  const { nodes, updateNodeData } = useCanvasStore()
  const selectedNode = nodes.find(n => n.id === nodeId)!
  const nodeType = selectedNode.type as NodeType
  const config = NODE_CONFIG[nodeType]
  const themeMode = useUiStore(s => s.themeMode)
  const colors = config ? CATEGORY_COLORS[config.category] : CATEGORY_COLORS.compute
  const accentColor = themeMode === 'light' ? colors.foreground.light : colors.accent
  const data = selectedNode.data as import('../../lib/nodeConfig').NodeData
  const [showNotes, setShowNotes] = useState(!!data.notes)
  const [showSubtitle, setShowSubtitle] = useState(!!data.subtitle)
  const [graphOverlay, setGraphOverlay] = useState<GraphMetric | null>(null)
  const running = useSimulationStore(s => s.running)
  const nodeHistory = useMetricsHistoryStore(s => s.history.get(nodeId))
  const consumerLagMs = useDisplayMetrics(nodeId)?.consumerLagMs

  return (
    <>
      {config && (
        <div className={styles.header}>
          <span
            className={styles.typeBadge}
            style={{ color: accentColor, borderColor: `color-mix(in srgb, ${accentColor} 27%, transparent)` }}
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
        {/* Editing is locked during a run — grey out all config, but keep Live Metrics below live. */}
        <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, minInlineSize: 0, opacity: running ? 0.5 : 1 }}>
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Identity</div>
          <input
            className={styles.field}
            placeholder="Label"
            value={data.label}
            onChange={e => updateNodeData(selectedNode.id, { label: e.target.value, labelCustomized: true })}
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
                  '--dot-color': s === 'healthy' ? 'var(--color-success)' : s === 'degraded' ? 'var(--color-warning)' : s === 'down' ? 'var(--color-danger)' : 'var(--color-text-muted)',
                } as React.CSSProperties}
                onClick={() => updateNodeData(selectedNode.id, { status: s })}
                title={s.charAt(0).toUpperCase() + s.slice(1)}
              />
            ))}
            <span className={styles.statusLabel}>{data.status}</span>
          </div>
        </div>

        {/* Cloud provider mapping + pricing parameters */}
        {CLOUD_REGISTRY[nodeType] && (() => {
          const provider = data.provider ?? 'generic'
          const spec = getServiceSpec(nodeType, provider)
          const cost = data.cost ?? {}
          const updCost = (patch: Partial<NodeCostConfig>) =>
            updateNodeData(selectedNode.id, { cost: { ...cost, ...patch } })
          const find = <K extends CostComponentSpec['kind']>(kind: K) =>
            spec?.pricing.find(p => p.kind === kind) as Extract<CostComponentSpec, { kind: K }> | undefined
          const instanceComp = find('instanceHourly')
          const storageComp  = find('storageGbMonth')
          const egressComp   = find('egress')
          const reqComp      = find('requestsPerMillion')
          const fixedComp    = find('fixedMonthly')
          return (
            <>
              <div className={styles.section}>
                <div className={styles.sectionLabel}>Cloud Provider</div>
                <div className={styles.row}>
                  <span className={styles.rowLabel}>Provider</span>
                  <select className={styles.edgeTypeSelect} value={provider}
                    onChange={e => {
                      const nextProvider = e.target.value as CloudProvider
                      const genericLabel = config?.label ?? nodeType
                      const nextLabel = providerLabelForNode(nodeType, nextProvider, data.label, genericLabel, data.labelCustomized)
                      updateNodeData(selectedNode.id, { provider: nextProvider, label: nextLabel })
                    }}>
                    <option value="generic">Generic</option>
                    <option value="aws">AWS</option>
                    <option value="gcp">GCP</option>
                    <option value="azure">Azure</option>
                  </select>
                </div>
                {spec && (
                  <div style={{ fontSize: 11, color: accentColor, marginTop: 4 }}>
                    Mapped service: <strong>{spec.serviceName}</strong>
                  </div>
                )}
              </div>

              {spec && (
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Cost Parameters</div>

                  {instanceComp && (
                    <>
                      <div className={styles.row}>
                        <span className={styles.rowLabel}>{instanceComp.label} count</span>
                        <input className={styles.numberInput} type="number" min={0} step={1}
                          value={cost.instanceCount ?? instanceComp.defaultCount}
                          onChange={e => updCost({ instanceCount: Number(e.target.value) })} />
                      </div>
                      <div className={styles.row}>
                        <span className={styles.rowLabel}>Rate ($/hr)</span>
                        <input className={styles.numberInput} type="number" min={0} step={0.001}
                          value={cost.instanceRateUsdHr ?? instanceComp.defaultRateUsdHr}
                          onChange={e => updCost({ instanceRateUsdHr: Number(e.target.value) })} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
                        ≈ ${(((cost.instanceRateUsdHr ?? instanceComp.defaultRateUsdHr) / 60)).toFixed(4)}/min per {instanceComp.label.toLowerCase()}
                      </div>
                    </>
                  )}

                  {storageComp && (
                    <>
                      <div className={styles.row}>
                        <span className={styles.rowLabel}>Storage tier</span>
                        <select className={styles.edgeTypeSelect}
                          value={cost.storageTierId ?? storageComp.tiers[0].id}
                          onChange={e => updCost({ storageTierId: e.target.value })}>
                          {storageComp.tiers.map(t => (
                            <option key={t.id} value={t.id}>{t.label} — ${t.storageGbMonth}/GB·mo</option>
                          ))}
                        </select>
                      </div>
                      <div className={styles.row}>
                        <span className={styles.rowLabel}>Stored data (GB)</span>
                        <input className={styles.numberInput} type="number" min={0} step={10}
                          value={cost.storageGb ?? 0}
                          onChange={e => updCost({ storageGb: Number(e.target.value) })} />
                      </div>
                      <input type="range" min={0} max={10000} step={10}
                        value={Math.min(cost.storageGb ?? 0, 10000)}
                        onChange={e => updCost({ storageGb: Number(e.target.value) })}
                        style={{ width: '100%', accentColor: accentColor, marginTop: 2 }} />
                    </>
                  )}

                  {/* Payload sizes drive the simulation's per-request data flow. Response size
                      feeds live egress bandwidth/cost; request size is reserved for future
                      ingress pricing. Shown for every mapped service, not just egress nodes. */}
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Avg request size (KB)</span>
                    <input className={styles.numberInput} type="number" min={0} step={1}
                      value={cost.avgRequestKb ?? 0}
                      onChange={e => updCost({ avgRequestKb: Number(e.target.value) })} />
                  </div>
                  <div className={styles.row}>
                    <span className={styles.rowLabel}>Avg response size (KB)</span>
                    <input className={styles.numberInput} type="number" min={0} step={1}
                      value={cost.avgResponseKb ?? 0}
                      onChange={e => updCost({ avgResponseKb: Number(e.target.value) })} />
                  </div>

                  {(reqComp || fixedComp || egressComp) && (
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 6, lineHeight: 1.6 }}>
                      {reqComp && <div>{reqComp.label}: ${reqComp.usdPerMillion}/M requests</div>}
                      {fixedComp && <div>{fixedComp.label}: ${fixedComp.usd}/mo fixed</div>}
                      {egressComp && <div>Egress billed on measured outbound response bandwidth (avg response size × live traffic).</div>}
                    </div>
                  )}
                </div>
              )}
            </>
          )
        })()}

        {/* K8s cluster config — node pool, service mesh, CNI latency */}
        {(nodeType === 'k8sCluster' || nodeType === 'ecsCluster' || nodeType === 'dockerCompose') && (() => {
          const simCfg = data.simConfig ?? {}
          const kc = simCfg.k8sCluster ?? { nodePoolCapacityRps: 5000, hasServiceMesh: false, cniLatencyMs: 0.5 }
          const upd = (patch: Partial<typeof kc>) =>
            updateNodeData(selectedNode.id, { simConfig: { ...simCfg, k8sCluster: { ...kc, ...patch } } })
          return (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Cluster Config</div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Node Pool Capacity (RPS)</span>
                <input className={styles.numberInput} type="number" min={100} step={500}
                  value={kc.nodePoolCapacityRps}
                  onChange={e => upd({ nodePoolCapacityRps: Number(e.target.value) })} />
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>CNI Latency (ms)</span>
                <input className={styles.numberInput} type="number" min={0} step={0.5}
                  value={kc.cniLatencyMs}
                  onChange={e => upd({ cniLatencyMs: Number(e.target.value) })} />
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Service Mesh (Istio/Linkerd)</span>
                <input type="checkbox" checked={kc.hasServiceMesh}
                  onChange={e => upd({ hasServiceMesh: e.target.checked })} />
              </div>
              {kc.hasServiceMesh && (
                <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.6 }}>
                  +2ms Envoy sidecar overhead on intra-cluster pod-to-pod hops.
                </div>
              )}
            </div>
          )
        })()}

        {/* Namespace config — resource quota + network policy */}
        {nodeType === 'namespace' && (() => {
          const simCfg = data.simConfig ?? {}
          const kn = simCfg.k8sNamespace ?? { resourceQuotaRps: 10000, networkPolicy: 'open' as const }
          const upd = (patch: Partial<typeof kn>) =>
            updateNodeData(selectedNode.id, { simConfig: { ...simCfg, k8sNamespace: { ...kn, ...patch } } })
          return (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Namespace Config</div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Resource Quota (RPS)</span>
                <input className={styles.numberInput} type="number" min={100} step={1000}
                  value={kn.resourceQuotaRps}
                  onChange={e => upd({ resourceQuotaRps: Number(e.target.value) })} />
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Network Policy</span>
                <select
                  style={{ background: 'var(--color-canvas)', color: 'var(--color-text-primary)', border: '1px solid var(--color-node-border)',
                    borderRadius: 4, padding: '3px 6px', fontSize: 11, fontFamily: 'inherit', cursor: 'pointer' }}
                  value={kn.networkPolicy}
                  onChange={e => upd({ networkPolicy: e.target.value as 'open' | 'strict' })}>
                  <option value="open">Open — allow all inbound</option>
                  <option value="strict">Strict — drop cross-namespace traffic</option>
                </select>
              </div>
            </div>
          )
        })()}

        {/* Group containers: configure which geographic region they represent (vpc/subnet/az/region only) */}
        {GROUPING_TYPES.has(nodeType)
          && nodeType !== 'k8sCluster' && nodeType !== 'ecsCluster'
          && nodeType !== 'dockerCompose' && nodeType !== 'namespace' && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Geographic Region</div>
            <select
              value={data.regionId ?? ''}
              onChange={e => updateNodeData(selectedNode.id, { regionId: e.target.value || undefined })}
              style={{
                width: '100%', background: 'var(--color-canvas)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-node-border)', borderRadius: 4,
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
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 6, lineHeight: 1.6 }}>
                Cross-region edge latency is determined by the zone pair, not the region itself:
                <div style={{ marginTop: 4, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1px 8px', fontFamily: 'inherit' }}>
                  <span style={{ color: 'var(--color-accent)' }}>AMER ↔ EMEA</span><span>~80ms</span>
                  <span style={{ color: 'var(--color-accent)' }}>AMER ↔ APAC</span><span>~170ms</span>
                  <span style={{ color: 'var(--color-accent)' }}>EMEA ↔ APAC</span><span>~140ms</span>
                  <span style={{ color: 'var(--color-accent)' }}>Same zone</span><span>~25–45ms</span>
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
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '4px 0' }}>
                    {region.label}
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 10, marginLeft: 6 }}>
                      +{region.baseLatencyMs}ms base latency
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
                    Inherited from <span style={{ color: 'var(--color-text-muted)' }}>{(cur.data as ND)?.label ?? cur.id}</span>
                  </div>
                </div>
              ) : null
            }
            cur = cur.parentId ? nodeMap.get(cur.parentId) : undefined
          }
          return null
        })()}

        <PacketDistributionSection nodeId={selectedNode.id} />

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
        </fieldset>

        {running && nodeHistory && nodeHistory.length > 1 && (
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Live Metrics</div>
            <button className={styles.sparkClickable} onClick={() => setGraphOverlay('utilization')} title="Click for full graph">
              <span className={styles.sparkClickLabel}>Utilization</span>
              <Sparkline data={nodeHistory.map(s => s.utilization)} color="var(--color-accent)" height={26} />
            </button>
            <button className={styles.sparkClickable} onClick={() => setGraphOverlay('inRps')} title="Click for full graph">
              <span className={styles.sparkClickLabel}>RPS</span>
              <Sparkline data={nodeHistory.map(s => s.inRps)} color="var(--color-success)" height={26} />
            </button>
            <button className={styles.sparkClickable} onClick={() => setGraphOverlay('errorRate')} title="Click for full graph">
              <span className={styles.sparkClickLabel}>Errors</span>
              <Sparkline data={nodeHistory.map(s => s.errorRate)} color="var(--color-danger)" height={26} />
            </button>
            {consumerLagMs !== undefined && (
              <div className={styles.metricRow} title="Time to drain the current backlog at the consumer's current rate">
                <span className={styles.metricLabel}>Consumer Lag</span>
                <span className={styles.metricVal} style={{ color: consumerLagMs > 5000 ? 'var(--color-danger)' : consumerLagMs > 1000 ? 'var(--color-warning)' : 'var(--color-success-text)' }}>
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
  const { selectedNodeId, selectedEdgeId, rightTab, setRightTab, simConfigOpen } = useUiStore()
  const { nodes, edges, updateEdgeData, changeEdgeType } = useCanvasStore()
  const { setEdgeRps, getEdgeRps, running } = useSimulationStore()
  const reduceMotion = useReducedMotion()

  // Auto-switch to Analytics when simulation starts
  useEffect(() => {
    if (running) setRightTab('analytics')
  }, [running, setRightTab])

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)
  // SimConfigPanel (the Inspector) takes over this same floating corner while it's open — see
  // Step 5 below. rightTab === 'analytics' counts as "something to show" on its own: a running
  // simulation auto-switches to it above, so system-wide stats stay visible through a run even
  // with nothing selected — this must keep working now that the panel can fully unmount.
  const shouldShow = !simConfigOpen && (!!selectedNode || !!selectedEdge || rightTab === 'analytics')

  let contentKey: 'analytics' | 'node' | 'edge' = 'analytics'
  let content: React.ReactNode = null

  if (shouldShow && rightTab === 'analytics') {
    contentKey = 'analytics'
    content = (
      <>
        <TabBar />
        <AnalyticsPane />
      </>
    )
  } else if (shouldShow && selectedNode) {
    contentKey = 'node'
    content = (
      <>
        <TabBar />
        <NodePanel nodeId={selectedNode.id} />
      </>
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

    contentKey = 'edge'
    content = (
      <>
        <TabBar />
        <div className={styles.header}>
          <span className={styles.typeBadge} style={{ color: 'var(--color-accent)', borderColor: 'color-mix(in srgb, var(--color-accent) 27%, transparent)' }}>
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
              background: 'color-mix(in srgb, var(--color-warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--color-warning) 27%, transparent)', borderRadius: 5,
            }}>
              <div style={{ fontSize: 10, color: 'var(--color-warning)', fontWeight: 600, marginBottom: 3 }}>
                ⚠ Partial region coverage
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                {srcRegion
                  ? <>Source is in <span style={{ color: 'var(--color-text-primary)' }}>{srcRegion.label}</span> ({srcRegion.regionId}) but the target has no region assigned.</>
                  : <>Target is in <span style={{ color: 'var(--color-text-primary)' }}>{tgtRegion!.label}</span> ({tgtRegion!.regionId}) but the source has no region assigned.</>
                }
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
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

          {data?.edgeType !== 'dependency' && (
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
            {(() => {
              const targetNode = nodes.find(n => n.id === selectedEdge.target)
              const isDbEdge = targetNode?.type === 'dbSql' || targetNode?.type === 'dbNoSql'
              // For request edges, the method distribution (below) derives the read/write split.
              if (!isDbEdge || data?.edgeType === 'request') return null
              const readPct = data?.readPercentage ?? 0.8
              return (
                <div className={styles.row}>
                  <span className={styles.rowLabel}>Read/Write ratio</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(readPct * 100)}
                      onChange={e => updateEdgeData(selectedEdge.id, { readPercentage: Number(e.target.value) / 100 })}
                      style={{ flex: 1, accentColor: 'var(--color-accent)' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                      {Math.round(readPct * 100)}% R / {100 - Math.round(readPct * 100)}% W
                    </span>
                  </div>
                </div>
              )
            })()}
            </fieldset>
          </div>
          )}

          <EdgeConfigForm
            edge={selectedEdge}
            nodes={nodes}
            running={running}
            updateEdgeData={updateEdgeData}
          />
        </motion.div>
        </AnimatePresence>
      </>
    )
  }

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.aside
          key={contentKey}
          className={styles.sidebar}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
          {content}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
