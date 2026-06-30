import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useSimulationStore } from '../../store/simulation.store'
import styles from './RequestInspector.module.css'

const METHOD_COLORS: Record<string, string> = {
  GET:       '#22C55E',
  POST:      '#4A9EFF',
  PUT:       '#F59E0B',
  DELETE:    '#EF4444',
  PATCH:     '#A78BFA',
  PUBLISH:   '#2DD4BF',
  CONSUME:   '#2DD4BF',
  EMIT:      '#A78BFA',
  SUBSCRIBE: '#A78BFA',
}

const EDGE_TYPE_LABELS: Record<string, string> = {
  request:    'HTTP Request',
  stream:     'Stream',
  event:      'Event',
  dependency: 'Dependency',
}

const PROTOCOL_COLORS: Record<string, string> = {
  http:   '#4A9EFF',
  event:  '#2DD4BF',
  stream: '#A78BFA',
  db:     '#F5A623',
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${Math.round(b)} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(2)} MB`
}

function statusColor(code: number): string {
  if (code >= 500) return '#EF4444'
  if (code >= 400) return '#F59E0B'
  if (code >= 300) return '#A78BFA'
  return '#22C55E'
}

export function RequestInspector() {
  const request = useSimulationStore(s => s.inspectedRequest)
  const setInspectedRequest = useSimulationStore(s => s.setInspectedRequest)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setInspectedRequest(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setInspectedRequest])

  const methodColor = request ? (METHOD_COLORS[request.httpMethod] ?? '#94A3B8') : '#94A3B8'
  const tpl = request?.templateInfo

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          className={styles.panel}
          initial={{ opacity: 0, y: 12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        >
          {/* Header */}
          <div className={styles.header}>
            <span className={styles.headerTitle}>In-Flight Request</span>
            <button
              className={styles.closeBtn}
              onClick={() => setInspectedRequest(null)}
              title="Close (Escape)"
            >
              <X size={11} />
            </button>
          </div>

          {/* Route: source → target */}
          <div className={styles.route}>
            <span className={styles.routeNode}>{request.sourceLabel}</span>
            <span className={styles.routeArrow}>→</span>
            <span className={styles.routeNode}>{request.targetLabel}</span>
            <span className={styles.edgeTypeBadge}>{EDGE_TYPE_LABELS[request.edgeType] ?? request.edgeType}</span>
          </div>

          {/* Method + path */}
          <div className={styles.methodRow}>
            <span className={styles.methodBadge} style={{ color: methodColor, borderColor: `${methodColor}44`, background: `${methodColor}11` }}>
              {request.httpMethod}
            </span>
            <span className={styles.path}>{request.httpPath}</span>
            <span className={styles.statusBadge}>IN FLIGHT</span>
          </div>

          {/* Protocol-specific template card (custom packet mode) */}
          {tpl && (
            <div className={styles.templateCard}>
              <div className={styles.templateHead}>
                <span className={styles.templateName}>{tpl.name}</span>
                <span
                  className={styles.protocolBadge}
                  style={{
                    color: PROTOCOL_COLORS[tpl.protocol] ?? '#94A3B8',
                    borderColor: `${PROTOCOL_COLORS[tpl.protocol] ?? '#94A3B8'}44`,
                    background: `${PROTOCOL_COLORS[tpl.protocol] ?? '#94A3B8'}11`,
                    border: '1px solid',
                  }}
                >
                  {tpl.protocol}
                </span>
              </div>
              <div className={styles.kvGrid}>
                {tpl.protocol === 'http' && (
                  <>
                    <KV k="Request" v={`${tpl.method} ${tpl.path}`} />
                    <KV k="Status" v={String(tpl.statusCode)} color={statusColor(tpl.statusCode ?? 200)} />
                  </>
                )}
                {tpl.protocol === 'db' && (
                  <>
                    <KV k="Query" v={(tpl.queryType ?? '').toUpperCase()} color={tpl.queryType === 'read' ? '#22C55E' : '#F59E0B'} />
                    <KV k="WAL" v={tpl.isWAL ? 'true' : 'false'} />
                    <KV k="Result" v={`${tpl.resultSizeKb} KB`} />
                  </>
                )}
                {tpl.protocol === 'event' && (
                  <>
                    <KV k="Topic" v={tpl.topic ?? ''} />
                    <KV k="Type" v={tpl.eventType ?? ''} />
                    <KV k="Delivery" v={tpl.deliveryMode ?? ''} />
                  </>
                )}
                {tpl.protocol === 'stream' && (
                  <>
                    <KV k="Stream" v={tpl.streamId ?? ''} />
                    <KV k="Compression" v={tpl.compressionType ?? 'none'} />
                  </>
                )}
                <KV k="Size" v={`${tpl.sizeKb} KB`} />
              </div>
            </div>
          )}

          {/* Metadata grid */}
          <div className={styles.meta}>
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>Payload</span>
              <span className={styles.metaVal}>{fmtBytes(request.payloadBytes)}</span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>Retries</span>
              <span className={styles.metaVal} style={{ color: request.retries > 0 ? '#F59E0B' : '#94A3B8' }}>
                {request.retries > 0 ? `${request.retries} retry${request.retries > 1 ? ' (x' + request.retries + ')' : ''}` : 'None'}
              </span>
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaLabel}>Request ID</span>
              <span className={styles.metaVal} style={{ color: '#475569', fontFamily: 'monospace', fontSize: 9 }}>
                #{request.particleId.toString().padStart(6, '0')}
              </span>
            </div>
          </div>

          {/* Progress bar */}
          <div className={styles.progressSection}>
            <div className={styles.progressLabel}>
              <span>Transit progress</span>
              <span>{Math.round(request.progress * 100)}%</span>
            </div>
            <div className={styles.progressTrack}>
              <motion.div
                className={styles.progressFill}
                style={{ width: `${Math.round(request.progress * 100)}%` }}
              />
            </div>
            <div className={styles.progressEndpoints}>
              <span>{request.sourceLabel}</span>
              <span>{request.targetLabel}</span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function KV({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className={styles.kvRow}>
      <span className={styles.kvKey}>{k}</span>
      <span className={styles.kvVal} style={color ? { color } : undefined}>{v}</span>
    </div>
  )
}
