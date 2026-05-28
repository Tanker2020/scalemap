import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Search, X } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulation.store'
import { EventCard } from './SimConfigPanel'
import type { SimEvent } from '../store/simulation.store'
import type { NodeData } from '../../lib/nodeConfig'
import styles from './EventLogPanel.module.css'

type SeverityFilter = 'all' | 'critical' | 'warn' | 'info'

interface Props {
  onClose: () => void
}

export function EventLogPanel({ onClose }: Props) {
  const events = useSimulationStore(s => s.events)
  const clearEvents = useSimulationStore(s => s.clearEvents)
  const { nodes } = useCanvasStore()

  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [search, setSearch] = useState('')
  const lastSeenCount = useRef(events.length)

  // Track unread count relative to when panel opened
  useEffect(() => {
    lastSeenCount.current = events.length
  }, []) // only on mount

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    let result = events
    if (severityFilter !== 'all') result = result.filter(e => e.severity === severityFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter(ev => {
        const msg = ev.message.toLowerCase()
        const nodeLabel = ev.nodeId
          ? ((nodes.find(n => n.id === ev.nodeId)?.data as NodeData)?.label ?? '').toLowerCase()
          : ''
        return msg.includes(q) || nodeLabel.includes(q) || ev.type.toLowerCase().includes(q)
      })
    }
    return result
  }, [events, severityFilter, search, nodes])

  // Group events by minute bucket
  const grouped = useMemo(() => {
    const groups: { label: string; events: SimEvent[] }[] = []
    let currentBucket = -1
    let currentGroup: SimEvent[] = []

    for (const ev of filtered) {
      const bucket = Math.floor(ev.elapsedS / 60)
      if (bucket !== currentBucket) {
        if (currentGroup.length > 0) {
          const start = Math.floor(currentBucket * 60)
          const end = start + 60
          groups.push({
            label: `${fmtTime(start)}–${fmtTime(end)} · ${currentGroup.length} event${currentGroup.length !== 1 ? 's' : ''}`,
            events: currentGroup,
          })
        }
        currentBucket = bucket
        currentGroup = [ev]
      } else {
        currentGroup.push(ev)
      }
    }
    if (currentGroup.length > 0 && currentBucket >= 0) {
      const start = Math.floor(currentBucket * 60)
      const end = start + 60
      groups.push({
        label: `${fmtTime(start)}–${fmtTime(end)} · ${currentGroup.length} event${currentGroup.length !== 1 ? 's' : ''}`,
        events: currentGroup,
      })
    }
    return groups
  }, [filtered])

  const handleClear = useCallback(() => {
    clearEvents()
    lastSeenCount.current = 0
  }, [clearEvents])

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

      {/* Event list */}
      <div className={styles.body}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            {events.length === 0 ? 'No events yet — run the simulation' : 'No events match the current filter'}
          </div>
        ) : (
          grouped.map((group, gi) => (
            <div key={gi} className={styles.group}>
              <div className={styles.groupLabel}>{group.label}</div>
              <div className={styles.groupEvents}>
                {group.events.map(ev => (
                  <EventCard key={ev.id} ev={ev} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <span>{events.length} total</span>
        {filtered.length !== events.length && (
          <span className={styles.footerFiltered}>· {filtered.length} shown</span>
        )}
      </div>
    </div>
  )
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}
