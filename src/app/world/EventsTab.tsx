// WorldPanel's Events tab: the store's `events` window (last 500, oldest→newest), rendered
// newest-first with severity-colored left borders. The window is presentation-only — every
// event of the run is durably in the SQLite event log (simulation.store's 1 Hz spill), and
// `eventLogTotal` is that true count, shown when it outgrows the window.
import { useSimulationStore } from '../store/simulation.store'
import { sectionLabel } from './panels/panelStyles'

const SEVERITY_COLOR: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--color-text-muted)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
}

export function EventsTab() {
  const events = useSimulationStore(s => s.events)
  const total = useSimulationStore(s => s.eventLogTotal)
  const ordered = [...events].reverse()

  return (
    <div>
      <div style={sectionLabel}>
        Events ({total > events.length ? `latest ${events.length} of ${total}` : events.length})
      </div>
      {total > events.length && (
        <div style={{ color: 'var(--color-text-muted)', marginBottom: 6 }}>
          full run history is on disk (events.db in app data)
        </div>
      )}
      {ordered.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)' }}>No events yet — start the simulation.</div>
      )}
      {ordered.map(e => (
        <div key={e.id} style={{
          marginBottom: 6, borderLeft: `2px solid ${SEVERITY_COLOR[e.severity]}`, paddingLeft: 6,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: SEVERITY_COLOR[e.severity] }}>
            <span>{e.kind}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>{(e.simMs / 1000).toFixed(1)}s</span>
          </div>
          <div style={{ color: 'var(--color-text-secondary)' }}>{e.message}</div>
        </div>
      ))}
    </div>
  )
}
