import type { Edge, Node } from '@xyflow/react'
import {
  GROUPING_TYPES,
  defaultEdgeConfig,
  type EdgeData,
  type NodeData,
  type RetryConfig,
  type RequestEdgeConfig,
  type StreamEdgeConfig,
  type EventEdgeConfig,
  type DependencyEdgeConfig,
} from '../../lib/nodeConfig'
import styles from './PropertiesPanel.module.css'

// Node types that can act as a dead-letter destination (queue/stream-like sinks)
const DLQ_TARGET_TYPES = new Set(['queue', 'eventBus', 'pubsub', 'stream'])

interface EdgeConfigFormProps {
  edge: Edge<EdgeData>
  nodes: Node<NodeData>[]
  running: boolean
  updateEdgeData: (id: string, data: Partial<EdgeData>) => void
}

export function EdgeConfigForm({ edge, nodes, running, updateEdgeData }: EdgeConfigFormProps) {
  const data = edge.data as EdgeData
  const edgeType = data?.edgeType ?? 'request'
  const config = data?.config ?? defaultEdgeConfig(edgeType)

  switch (edgeType) {
    case 'request':
      return (
        <RequestConfigForm
          config={config as RequestEdgeConfig}
          running={running}
          onChange={next => updateEdgeData(edge.id, { config: { ...config, ...next } })}
        />
      )
    case 'stream':
      return (
        <StreamConfigForm
          config={config as StreamEdgeConfig}
          running={running}
          onChange={next => updateEdgeData(edge.id, { config: { ...config, ...next } })}
        />
      )
    case 'event':
      return (
        <EventConfigForm
          config={config as EventEdgeConfig}
          running={running}
          nodes={nodes}
          onChange={next => updateEdgeData(edge.id, { config: { ...config, ...next } })}
        />
      )
    case 'dependency':
      return (
        <DependencyConfigForm
          config={config as DependencyEdgeConfig}
          running={running}
          onChange={next => updateEdgeData(edge.id, { config: { ...config, ...next } })}
        />
      )
    default:
      return null
  }
}

// ─── Shared retry config fields ─────────────────────────────────────────────

function RetryConfigFields({ config, onChange }: {
  config: RetryConfig
  onChange: (next: Partial<RetryConfig>) => void
}) {
  return (
    <>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Max retries</span>
        <input
          className={styles.numberInput}
          type="number"
          min={0}
          max={10}
          value={config.maxRetries}
          onChange={e => onChange({ maxRetries: Number(e.target.value) })}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Base delay (ms)</span>
        <input
          className={styles.numberInput}
          type="number"
          min={10}
          step={50}
          value={config.baseDelayMs}
          onChange={e => onChange({ baseDelayMs: Number(e.target.value) })}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Max delay (ms)</span>
        <input
          className={styles.numberInput}
          type="number"
          min={0}
          step={500}
          value={config.maxDelayMs ?? 0}
          onChange={e => onChange({ maxDelayMs: Number(e.target.value) || undefined })}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Jitter</span>
        <select
          className={styles.edgeTypeSelect}
          value={config.jitter}
          onChange={e => onChange({ jitter: e.target.value as RetryConfig['jitter'] })}
        >
          <option value="full">Full (AWS-recommended)</option>
          <option value="equal">Equal (min spacing)</option>
        </select>
      </div>
      {config.maxRetries === 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
          Retries disabled — dropped messages are permanently lost
        </div>
      )}
    </>
  )
}

// ─── Request edges ──────────────────────────────────────────────────────────

function RequestConfigForm({ config, running, onChange }: {
  config: RequestEdgeConfig
  running: boolean
  onChange: (next: Partial<RequestEdgeConfig>) => void
}) {
  const dist = config.methodDistribution
  const setMethodWeight = (method: keyof RequestEdgeConfig['methodDistribution'], value: number) => {
    onChange({ methodDistribution: { ...dist, [method]: value } })
  }
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>
        Request config
        {running && <span className={styles.lockHint}> · stop sim to edit</span>}
      </div>
      <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, opacity: running ? 0.45 : 1 }}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Method distribution</span>
        </div>
        {(['GET', 'POST', 'PUT', 'DELETE'] as const).map(method => (
          <div className={styles.row} key={method}>
            <span className={styles.rowLabel}>{method}</span>
            <input
              className={styles.numberInput}
              type="number"
              min={0}
              max={100}
              value={dist[method]}
              onChange={e => setMethodWeight(method, Number(e.target.value))}
            />
          </div>
        ))}
        <div className={styles.row}>
          <span className={styles.rowLabel}>Timeout (ms)</span>
          <input
            className={styles.numberInput}
            type="number"
            min={0}
            value={config.timeoutMs}
            onChange={e => onChange({ timeoutMs: Number(e.target.value) })}
          />
        </div>
        <RetryConfigFields
          config={config.retryConfig}
          onChange={next => onChange({ retryConfig: { ...config.retryConfig, ...next } })}
        />
      </fieldset>
    </div>
  )
}

// ─── Stream edges ───────────────────────────────────────────────────────────

function StreamConfigForm({ config, running, onChange }: {
  config: StreamEdgeConfig
  running: boolean
  onChange: (next: Partial<StreamEdgeConfig>) => void
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>
        Stream config
        {running && <span className={styles.lockHint}> · stop sim to edit</span>}
      </div>
      <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, opacity: running ? 0.45 : 1 }}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Throughput (particles/s)</span>
          <input
            className={styles.numberInput}
            type="number"
            min={1}
            value={config.throughputRate}
            onChange={e => onChange({ throughputRate: Number(e.target.value) })}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Delivery mode</span>
          <select
            className={styles.edgeTypeSelect}
            value={config.streamType}
            onChange={e => onChange({ streamType: e.target.value as StreamEdgeConfig['streamType'] })}
          >
            <option value="lossless_tcp">Lossless (TCP) — backpressure</option>
            <option value="lossful_udp">Lossy (UDP) — drop on overload</option>
          </select>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Max consumer lag</span>
          <input
            className={styles.numberInput}
            type="number"
            min={1}
            value={config.maxConsumerLag}
            onChange={e => onChange({ maxConsumerLag: Number(e.target.value) })}
          />
        </div>
      </fieldset>
    </div>
  )
}

// ─── Event edges ────────────────────────────────────────────────────────────

function EventConfigForm({ config, running, nodes, onChange }: {
  config: EventEdgeConfig
  running: boolean
  nodes: Node<NodeData>[]
  onChange: (next: Partial<EventEdgeConfig>) => void
}) {
  const dlqCandidates = nodes.filter(n => DLQ_TARGET_TYPES.has(n.type as string) && !GROUPING_TYPES.has(n.type as never))
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>
        Event config
        {running && <span className={styles.lockHint}> · stop sim to edit</span>}
      </div>
      <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, opacity: running ? 0.45 : 1 }}>
        <RetryConfigFields
          config={config.retryConfig}
          onChange={next => onChange({ retryConfig: { ...config.retryConfig, ...next } })}
        />
        <div className={styles.row}>
          <span className={styles.rowLabel}>Retry backoff</span>
          <select
            className={styles.edgeTypeSelect}
            value={config.retryBackoff}
            onChange={e => onChange({ retryBackoff: e.target.value as EventEdgeConfig['retryBackoff'] })}
          >
            <option value="immediate">Immediate</option>
            <option value="linear">Linear</option>
            <option value="exponential">Exponential</option>
          </select>
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Dead-letter routing</span>
          <input
            type="checkbox"
            checked={config.deadLetterRouting}
            onChange={e => onChange({ deadLetterRouting: e.target.checked })}
            style={{ accentColor: 'var(--color-accent)' }}
          />
        </div>
        {config.deadLetterRouting && (
          <div className={styles.row}>
            <span className={styles.rowLabel}>DLQ target</span>
            <select
              className={styles.edgeTypeSelect}
              value={config.deadLetterTargetId ?? ''}
              onChange={e => onChange({ deadLetterTargetId: e.target.value || undefined })}
            >
              <option value="">— none —</option>
              {dlqCandidates.map(n => (
                <option key={n.id} value={n.id}>{(n.data as NodeData).label || n.id}</option>
              ))}
            </select>
          </div>
        )}
      </fieldset>
    </div>
  )
}

// ─── Dependency edges ───────────────────────────────────────────────────────

function DependencyConfigForm({ config, running, onChange }: {
  config: DependencyEdgeConfig
  running: boolean
  onChange: (next: Partial<DependencyEdgeConfig>) => void
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>
        Dependency config
        {running && <span className={styles.lockHint}> · stop sim to edit</span>}
      </div>
      <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, opacity: running ? 0.45 : 1 }}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Critical dependency</span>
          <input
            type="checkbox"
            checked={config.isCritical}
            onChange={e => onChange({ isCritical: e.target.checked })}
            style={{ accentColor: 'var(--color-text-muted)' }}
          />
        </div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>Health propagation</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(config.healthPropagation * 100)}
              onChange={e => onChange({ healthPropagation: Number(e.target.value) / 100 })}
              style={{ flex: 1, accentColor: 'var(--color-text-muted)' }}
            />
            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
              {Math.round(config.healthPropagation * 100)}%
            </span>
          </div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          Dependency edges don't carry traffic. If the target is down and this is marked critical,
          the source node's health score is reduced by the propagation factor.
        </div>
      </fieldset>
    </div>
  )
}
