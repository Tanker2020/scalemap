// src/app/world/EventHistory.tsx
// The Events tab's history browser (user request 2026-07-12: "a way to at least view or delete
// the old history"). Reads the durable SQLite event log through the event_log_* commands —
// runs newest-first, each expandable to its newest events with backward paging — and offers a
// two-step clear-all. VIEWING is allowed mid-run (WAL: readers never block the 1 Hz writer);
// CLEARING is not — the flusher is actively appending to the very table being emptied, so the
// button follows the app's edit-lock convention instead.
import { useState, type CSSProperties } from 'react'
import {
  eventLogRuns, eventLogTail, eventLogClear, type EventLogRun, type LoggedEventRow,
} from '../../lib/tauri'
import { useSimulationStore } from '../store/simulation.store'
import { sectionLabel } from './panels/panelStyles'

const PAGE = 50

const SEVERITY_COLOR: Record<string, string> = {
  info: 'var(--color-text-muted)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
}

const rowButtonStyle: CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'none', cursor: 'pointer',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 8px',
  marginBottom: 4, font: '10px var(--font-mono)', color: 'var(--color-text-secondary)',
}
const smallButtonStyle: CSSProperties = {
  background: 'none', cursor: 'pointer', border: '1px solid var(--color-node-border)',
  borderRadius: 4, padding: '3px 8px', font: '10px var(--font-mono)',
  color: 'var(--color-text-muted)',
}

function startedLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export function EventHistory() {
  const running = useSimulationStore(s => s.running)
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<EventLogRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openRunId, setOpenRunId] = useState<number | null>(null)
  const [rows, setRows] = useState<LoggedEventRow[]>([])
  const [exhausted, setExhausted] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  const refresh = () => {
    setError(null)
    eventLogRuns().then(setRuns).catch(() => setError('could not read the event log'))
  }

  const toggleOpen = () => {
    const next = !open
    setOpen(next)
    setConfirmingClear(false)
    if (next) refresh()
  }

  const toggleRun = (id: number) => {
    if (openRunId === id) { setOpenRunId(null); return }
    setOpenRunId(id)
    setRows([])
    setExhausted(false)
    eventLogTail(id, null, PAGE)
      .then(r => { setRows(r); setExhausted(r.length < PAGE) })
      .catch(() => setError('could not read the event log'))
  }

  const loadOlder = () => {
    if (openRunId === null || rows.length === 0) return
    const before = rows[rows.length - 1].seq
    eventLogTail(openRunId, before, PAGE)
      .then(r => { setRows(prev => [...prev, ...r]); setExhausted(r.length < PAGE) })
      .catch(() => setError('could not read the event log'))
  }

  const clearAll = () => {
    if (!confirmingClear) { setConfirmingClear(true); return }
    setConfirmingClear(false)
    eventLogClear()
      .then(() => {
        setRuns([])
        setOpenRunId(null)
        setRows([])
        // The live header's "latest N of TOTAL" now has no durable rows behind it.
        useSimulationStore.setState({ eventLogTotal: 0 })
      })
      .catch(() => setError('could not clear the event log'))
  }

  return (
    <div data-testid="event-history" style={{ marginTop: 14 }}>
      <button
        type="button" className="kit-press" data-testid="event-history-toggle"
        onClick={toggleOpen} style={{ ...sectionLabel, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        {open ? '▾' : '▸'} past runs
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {error && <div style={{ color: 'var(--color-danger)', marginBottom: 6 }}>{error}</div>}
          {runs !== null && runs.length === 0 && (
            <div style={{ color: 'var(--color-text-muted)', marginBottom: 6 }}>
              no recorded runs yet — every simulation writes its full event history here
            </div>
          )}
          {(runs ?? []).map(run => (
            <div key={run.id}>
              <button
                type="button" className="kit-press" data-testid={`event-history-run-${run.id}`}
                style={rowButtonStyle} onClick={() => toggleRun(run.id)}
              >
                {openRunId === run.id ? '▾' : '▸'} run #{run.id} · {run.worldName} · {startedLabel(run.startedAt)} ·{' '}
                {run.events} event{run.events === 1 ? '' : 's'}
              </button>
              {openRunId === run.id && (
                <div style={{ padding: '2px 0 6px 10px' }}>
                  {rows.map(e => (
                    <div key={e.seq} style={{
                      marginBottom: 6, borderLeft: `2px solid ${SEVERITY_COLOR[e.severity] ?? 'var(--color-text-muted)'}`, paddingLeft: 6,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: SEVERITY_COLOR[e.severity] ?? 'var(--color-text-muted)' }}>
                        <span>{e.kind}</span>
                        <span style={{ color: 'var(--color-text-muted)' }}>{(e.simMs / 1000).toFixed(1)}s</span>
                      </div>
                      <div style={{ color: 'var(--color-text-secondary)' }}>{e.message}</div>
                    </div>
                  ))}
                  {rows.length === 0 && <div style={{ color: 'var(--color-text-muted)' }}>no events in this run</div>}
                  {!exhausted && rows.length > 0 && (
                    <button type="button" className="kit-press" style={smallButtonStyle} onClick={loadOlder}>
                      older events ▸
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {runs !== null && runs.length > 0 && (
            <button
              type="button" className="kit-press" data-testid="event-history-clear"
              style={{ ...smallButtonStyle, color: confirmingClear ? 'var(--color-danger)' : 'var(--color-text-muted)', marginTop: 4 }}
              disabled={running}
              title={running ? 'stop the simulation to edit' : 'deletes every recorded run from disk'}
              onClick={clearAll}
            >
              {confirmingClear
                ? `delete ${runs.length} run${runs.length === 1 ? '' : 's'} forever? click again`
                : 'clear history'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
