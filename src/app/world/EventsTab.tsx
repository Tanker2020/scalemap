// WorldPanel's Events tab: the store's `events` ring (contracts: cap 500, oldest→newest),
// rendered newest-first with severity-colored left borders.
import { useSimulationStore } from '../store/simulation.store'
import { sectionLabel } from './panels/panelStyles'

const SEVERITY_COLOR: Record<'info' | 'warning' | 'critical', string> = {
  info: 'var(--color-text-muted)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-danger)',
}

export function EventsTab() {
  const events = useSimulationStore(s => s.events)
  const ordered = [...events].reverse()

  return (
    <div>
      <div style={sectionLabel}>Events ({events.length})</div>
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
