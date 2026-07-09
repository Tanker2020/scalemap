import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, X, ChevronDown } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulationLegacy.store'
import { useReplayStore } from '../store/replay.store'
import { EventCard } from './SimConfigPanel'
import type { SimEvent, SimEventType } from '../store/simulationLegacy.store'
import type { NodeData } from '../../lib/nodeConfig'
import styles from './EventLogPanel.module.css'

type SeverityFilter = 'all' | 'critical' | 'warn' | 'info'
type PanelTab = 'events' | 'summary'

// ─── Incident types ────────────────────────────────────────────────────────────

interface IncidentNode {
  nodeId: string
  label: string
  eventType: SimEventType
  elapsedS: number
}

interface Incident {
  id: string
  rootNodeId: string
  rootLabel: string
  rootEventType: SimEventType
  startElapsedS: number
  chain: IncidentNode[]      // proven propagation path from root
  relatedTypes: Set<SimEventType>
  resolved: boolean
  severity: 'critical' | 'warn'
  eventCount: number
}

// ─── Incident builder ──────────────────────────────────────────────────────────

const ROOT_EVENT_TYPES = new Set<SimEventType>([
  'saturation_start', 'circuit_open', 'chaos_failure',
  'connection_pool_exhausted', 'crash_loop_detected',
])

const RESOLUTION_MAP: Partial<Record<SimEventType, SimEventType>> = {
  saturation_start: 'saturation_end',
  circuit_open:     'circuit_close',
  chaos_failure:    'chaos_recovery',
}

function buildIncidents(events: SimEvent[], nodeLabel: (id: string) => string): Incident[] {
  // Build a map from nodeId → list of events for that node, in order
  const byNode = new Map<string, SimEvent[]>()
  for (const ev of events) {
    if (!ev.nodeId) continue
    const arr = byNode.get(ev.nodeId) ?? []
    arr.push(ev)
    byNode.set(ev.nodeId, arr)
  }

  // Find root events: failure events with no causedByNodeId
  const rootEvents = events.filter(ev =>
    ev.nodeId &&
    ROOT_EVENT_TYPES.has(ev.type) &&
    !ev.causedByNodeId,
  )

  const incidents: Incident[] = []
  const assignedEventIds = new Set<string>()

  for (const root of rootEvents) {
    if (!root.nodeId || assignedEventIds.has(root.id)) continue
    assignedEventIds.add(root.id)

    // BFS through the causal graph following causedByNodeId pointers
    // An event E with causedByNodeId = root.nodeId is proven to be caused by this root
    const incidentNodeIds = new Set<string>([root.nodeId])
    const queue = [root.nodeId]
    const chain: IncidentNode[] = []
    const relatedTypes = new Set<SimEventType>([root.type])
    let eventCount = 1

    while (queue.length > 0) {
      const currentId = queue.shift()!
      // Find events whose causedByNodeId points to currentId
      const caused = events.filter(ev =>
        ev.nodeId &&
        ev.causedByNodeId === currentId &&
        !assignedEventIds.has(ev.id) &&
        ROOT_EVENT_TYPES.has(ev.type),
      )
      for (const ev of caused) {
        if (!ev.nodeId || incidentNodeIds.has(ev.nodeId)) continue
        assignedEventIds.add(ev.id)
        incidentNodeIds.add(ev.nodeId)
        queue.push(ev.nodeId)
        chain.push({
          nodeId: ev.nodeId,
          label: nodeLabel(ev.nodeId),
          eventType: ev.type,
          elapsedS: ev.elapsedS,
        })
        relatedTypes.add(ev.type)
        eventCount++
      }
    }

    // Collect all events in this incident (cascade_detected, retry_storm, etc.)
    for (const ev of events) {
      if (!ev.nodeId || assignedEventIds.has(ev.id)) continue
      if (incidentNodeIds.has(ev.nodeId) || (ev.causedByNodeId && incidentNodeIds.has(ev.causedByNodeId))) {
        assignedEventIds.add(ev.id)
        relatedTypes.add(ev.type)
        eventCount++
      }
    }

    // Check if all nodes in incident have resolved
    let resolved = true
    for (const nid of incidentNodeIds) {
      const nodeEvents = byNode.get(nid) ?? []
      const rootEv = nodeEvents.find(e => ROOT_EVENT_TYPES.has(e.type) && incidentNodeIds.has(nid))
      if (!rootEv) continue
      const resType = RESOLUTION_MAP[rootEv.type]
      if (!resType) { resolved = false; break }
      const hasResolution = nodeEvents.some(e => e.type === resType && e.elapsedS > rootEv.elapsedS)
      if (!hasResolution) { resolved = false; break }
    }

    incidents.push({
      id: root.id,
      rootNodeId: root.nodeId,
      rootLabel: nodeLabel(root.nodeId),
      rootEventType: root.type,
      startElapsedS: root.elapsedS,
      chain,
      relatedTypes,
      resolved,
      severity: root.severity === 'critical' ? 'critical' : 'warn',
      eventCount,
    })
  }

  // Sort: unresolved first, then by start time descending
  return incidents.sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
    return b.startElapsedS - a.startElapsedS
  })
}

// ─── Incident card ─────────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Partial<Record<SimEventType, string>> = {
  saturation_start:          'Saturated',
  circuit_open:              'Circuit open',
  chaos_failure:             'Chaos failure',
  connection_pool_exhausted: 'Pool exhausted',
  crash_loop_detected:       'Crash loop',
  cascade_detected:          'Cascading',
  retry_storm:               'Retry storm',
  slo_violation:             'SLO violated',
}

function IncidentCard({ incident }: { incident: Incident }) {
  const [expanded, setExpanded] = useState(false)
  const severityColor = incident.severity === 'critical' ? 'var(--color-danger)' : 'var(--color-warning)'
  const severityBg    = incident.severity === 'critical'
    ? 'color-mix(in srgb, var(--color-danger) 3%, transparent)'
    : 'color-mix(in srgb, var(--color-warning) 3%, transparent)'
  const statusColor   = incident.resolved ? 'var(--color-success-text)' : severityColor

  const rootTypeLabel = EVENT_TYPE_LABELS[incident.rootEventType] ?? incident.rootEventType

  const relatedLabels = [...incident.relatedTypes]
    .filter(t => !ROOT_EVENT_TYPES.has(t))
    .map(t => EVENT_TYPE_LABELS[t] ?? t)
    .filter(Boolean)

  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`${styles.incidentCard} ${!incident.resolved && incident.severity === 'critical' ? styles.incidentCardCritical : ''}`}
      style={{ background: severityBg, borderLeftColor: severityColor, '--severity-color': severityColor } as React.CSSProperties}
      onClick={() => setExpanded(e => !e)}
    >
      <div className={styles.incidentHead}>
        <span className={styles.incidentDot} style={{ color: statusColor }}>
          {incident.resolved ? '✓' : '●'}
        </span>
        <span className={styles.incidentTitle} style={{ color: severityColor }}>
          {incident.chain.length > 0 ? 'CASCADING FAILURE' : rootTypeLabel.toUpperCase()}
        </span>
        <span className={styles.incidentStatus} style={{ color: incident.resolved ? 'var(--color-success-text)' : 'var(--color-text-secondary)' }}>
          {incident.resolved ? 'resolved' : 'ongoing'}
        </span>
        <span className={styles.incidentTime}>+{incident.startElapsedS}s</span>
        <span className={styles.incidentChevron}>{expanded ? '▲' : '▼'}</span>
      </div>

      {/* Chain summary — rendered as literal connected nodes on a mini causal
          spine rather than a text arrow chain, so a cascading failure reads
          as a propagation path at a glance. */}
      <div className={styles.incidentChain}>
        <span className={styles.incidentChainDot} style={{ background: severityColor }} />
        <span className={styles.incidentRoot} style={{ color: severityColor }}>
          {incident.rootLabel}
        </span>
        {incident.chain.map((n) => (
          <span key={n.nodeId} className={styles.incidentChainLink}>
            <span className={styles.incidentChainWire} />
            <span className={styles.incidentChainDot} style={{ background: severityColor }} />
            <span className={styles.incidentChainNode}>{n.label}</span>
          </span>
        ))}
      </div>

      {/* Detail — only when expanded */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className={styles.incidentDetail}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            <div className={styles.incidentDetailRow}>
              <span className={styles.incidentDetailLabel}>Root cause</span>
              <span className={styles.incidentDetailVal}>{incident.rootLabel} ({rootTypeLabel})</span>
            </div>
            {incident.chain.length > 0 && (
              <div className={styles.incidentDetailRow}>
                <span className={styles.incidentDetailLabel}>Propagated to</span>
                <span className={styles.incidentDetailVal}>
                  {incident.chain.map(n => n.label).join(' → ')}
                </span>
              </div>
            )}
            {relatedLabels.length > 0 && (
              <div className={styles.incidentDetailRow}>
                <span className={styles.incidentDetailLabel}>Also</span>
                <span className={styles.incidentDetailVal}>{relatedLabels.join(', ')}</span>
              </div>
            )}
            <div className={styles.incidentDetailRow}>
              <span className={styles.incidentDetailLabel}>Events</span>
              <span className={styles.incidentDetailVal}>{incident.eventCount} total</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  )
}

// ─── Run-length collapsing ──────────────────────────────────────────────────────
//
// Under chaos/spike traffic the same (type, nodeId) pair can fire many times a
// second (e.g. repeated saturation pulses on one gateway). Rendering each as a
// full card makes the feed unusable and jank-prone. Consecutive events sharing
// type+nodeId collapse into a single run, shown as one card with a "×N" badge;
// clicking it expands to the individual instances. Only *adjacent* repeats
// collapse (order-preserving), so a real interleaving of distinct events never
// gets merged away.

interface EventRun {
  key: string
  type: SimEventType
  nodeId?: string
  events: SimEvent[]  // newest-relevant order preserved from input
}

function collapseRuns(events: SimEvent[]): EventRun[] {
  const runs: EventRun[] = []
  for (const ev of events) {
    const last = runs[runs.length - 1]
    if (last && last.type === ev.type && last.nodeId === ev.nodeId) {
      last.events.push(ev)
    } else {
      runs.push({ key: ev.id, type: ev.type, nodeId: ev.nodeId, events: [ev] })
    }
  }
  return runs
}

function EventRunCard({ run, nodeLabel }: { run: EventRun; nodeLabel: (id: string) => string }) {
  const [expanded, setExpanded] = useState(false)
  const head = run.events[run.events.length - 1] // most recent instance carries the freshest snapshot/message
  const count = run.events.length

  if (count === 1) {
    return <EventCard ev={head} />
  }

  const severityColor =
    head.severity === 'critical' ? 'var(--color-danger)' :
    head.severity === 'warn'     ? 'var(--color-warning)' : 'var(--color-accent)'

  return (
    <div className={styles.runWrap}>
      <button
        className={styles.runHeader}
        style={{ borderLeftColor: severityColor }}
        onClick={() => setExpanded(e => !e)}
        title={`${count} repeated ${run.type} events on ${run.nodeId ? nodeLabel(run.nodeId) : 'this run'}`}
      >
        <span className={styles.runCount} style={{ color: severityColor, borderColor: severityColor }}>×{count}</span>
        <span className={styles.runLabel}>repeated · +{run.events[0].elapsedS}s–+{head.elapsedS}s</span>
        <ChevronDown size={10} className={styles.runChevron} style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
      </button>
      {expanded ? (
        <div className={styles.runExpanded}>
          {run.events.map(ev => <EventCard key={ev.id} ev={ev} />)}
        </div>
      ) : (
        <EventCard ev={head} />
      )}
    </div>
  )
}

// ─── Main panel ────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void
}

export function EventLogPanel({ onClose }: Props) {
  const events = useSimulationStore(s => s.events)
  const clearEvents = useSimulationStore(s => s.clearEvents)
  const { nodes } = useCanvasStore()

  const [tab, setTab] = useState<PanelTab>('events')
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [search, setSearch] = useState('')
  const lastSeenCount = useRef(events.length)

  useEffect(() => {
    lastSeenCount.current = events.length
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const nodeLabel = useCallback((id: string) => {
    return (nodes.find(n => n.id === id)?.data as NodeData)?.label ?? id
  }, [nodes])

  // Replay-aware: while scrubbing, only show events up to the replay cursor time T.
  const isReplaying = useReplayStore(s => s.isReplaying)
  const replayT = useReplayStore(s => (s.isReplaying ? s.frameTimes[s.replayIndex] ?? Infinity : Infinity))
  const visibleEvents = useMemo(
    () => (isReplaying ? events.filter(e => e.elapsedS <= replayT) : events),
    [events, isReplaying, replayT],
  )

  const incidents = useMemo(() => buildIncidents(visibleEvents, nodeLabel), [visibleEvents, nodeLabel])

  const filtered = useMemo(() => {
    let result = visibleEvents
    if (severityFilter !== 'all') result = result.filter(e => e.severity === severityFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(ev => {
        const msg = ev.message.toLowerCase()
        const label = ev.nodeId ? nodeLabel(ev.nodeId).toLowerCase() : ''
        return msg.includes(q) || label.includes(q) || ev.type.toLowerCase().includes(q)
      })
    }
    return result
  }, [visibleEvents, severityFilter, search, nodeLabel])

  const grouped = useMemo(() => {
    const groups: { label: string; events: SimEvent[]; runs: EventRun[] }[] = []
    let currentBucket = -1
    let currentGroup: SimEvent[] = []

    const flush = () => {
      if (currentGroup.length === 0 || currentBucket < 0) return
      const start = Math.floor(currentBucket * 60)
      const end = start + 60
      groups.push({
        label: `${fmtTime(start)}–${fmtTime(end)} · ${currentGroup.length} event${currentGroup.length !== 1 ? 's' : ''}`,
        events: currentGroup,
        runs: collapseRuns(currentGroup),
      })
    }

    for (const ev of filtered) {
      const bucket = Math.floor(ev.elapsedS / 60)
      if (bucket !== currentBucket) {
        flush()
        currentBucket = bucket
        currentGroup = [ev]
      } else {
        currentGroup.push(ev)
      }
    }
    flush()
    return groups
  }, [filtered])

  const handleClear = useCallback(() => {
    clearEvents()
    lastSeenCount.current = 0
  }, [clearEvents])

  const unresolvedCount = incidents.filter(i => !i.resolved).length

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <span className={styles.title}>Event Log</span>
        <div className={styles.headerActions}>
          <button className={styles.clearBtn} onClick={handleClear} title="Clear all events">Clear</button>
          <button className={styles.closeBtn} onClick={onClose} title="Close (Escape)">
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button
          className={`${styles.tabBtn} ${tab === 'events' ? styles.tabBtnActive : ''}`}
          onClick={() => setTab('events')}
        >
          Events
          <span className={styles.tabCount}>{events.length}</span>
        </button>
        <button
          className={`${styles.tabBtn} ${tab === 'summary' ? styles.tabBtnActive : ''}`}
          onClick={() => setTab('summary')}
        >
          Summary
          {unresolvedCount > 0 && (
            <span className={styles.tabCountCritical}>{unresolvedCount}</span>
          )}
        </button>
      </div>

      {tab === 'events' ? (
        <>
          {/* Filter chips */}
          <div className={styles.filters}>
            {(['all', 'critical', 'warn', 'info'] as SeverityFilter[]).map(s => (
              <button
                key={s}
                className={`${styles.chip} ${severityFilter === s ? styles.chipActive : ''} ${s !== 'all' ? styles[`chip_${s}`] : ''}`}
                onClick={() => setSeverityFilter(s)}
              >
                {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
                {s !== 'all' && (
                  <span className={styles.chipCount}>
                    {events.filter(e => e.severity === s).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className={styles.searchWrap}>
            <Search size={10} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              placeholder="Search events, node names…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')}>×</button>
            )}
          </div>

          {/* Event list — a live timeline spine down the left edge. Each run's
              tick pulses on critical severity, echoing the same ring-pulse the
              canvas uses for saturated nodes, so an event feels like a live
              pulse traveling down a wire rather than a static log line. */}
          <div className={styles.body}>
            {filtered.length === 0 ? (
              <div className={styles.empty}>
                {events.length === 0 ? 'No events yet — run the simulation' : 'No events match the current filter'}
              </div>
            ) : (
              grouped.map((group, gi) => (
                <div key={gi} className={styles.group}>
                  <div className={styles.groupLabel}>{group.label}</div>
                  <div className={styles.spine}>
                    <AnimatePresence initial={false}>
                      {group.runs.map(run => {
                        const head = run.events[run.events.length - 1]
                        const tickColor =
                          head.severity === 'critical' ? 'var(--color-danger)' :
                          head.severity === 'warn'     ? 'var(--color-warning)' : 'var(--color-accent)'
                        return (
                          <motion.div
                            key={run.key}
                            layout
                            className={styles.spineRow}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                          >
                            <span
                              className={`${styles.spineTick} ${head.severity === 'critical' ? styles.spineTickCritical : ''}`}
                              style={{ background: tickColor, '--severity-color': tickColor } as React.CSSProperties}
                            />
                            <div className={styles.spineContent}>
                              <EventRunCard run={run} nodeLabel={nodeLabel} />
                            </div>
                          </motion.div>
                        )
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className={styles.footer}>
            <span>{events.length} total</span>
            {filtered.length !== events.length && (
              <span className={styles.footerFiltered}>· {filtered.length} shown</span>
            )}
          </div>
        </>
      ) : (
        /* Summary tab */
        <div className={styles.body}>
          {incidents.length === 0 ? (
            <div className={styles.empty}>
              {events.length === 0
                ? 'No incidents yet — run the simulation'
                : 'No provable failure chains detected'}
            </div>
          ) : (
            <div style={{ padding: '8px 0' }}>
              {unresolvedCount > 0 && (
                <div className={styles.summarySection}>
                  <div className={styles.summarySectionLabel}>
                    Active · {unresolvedCount}
                  </div>
                  {incidents.filter(i => !i.resolved).map(inc => (
                    <IncidentCard key={inc.id} incident={inc} />
                  ))}
                </div>
              )}
              {incidents.some(i => i.resolved) && (
                <div className={styles.summarySection}>
                  <div className={styles.summarySectionLabel}>
                    Resolved · {incidents.filter(i => i.resolved).length}
                  </div>
                  {incidents.filter(i => i.resolved).map(inc => (
                    <IncidentCard key={inc.id} incident={inc} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}
