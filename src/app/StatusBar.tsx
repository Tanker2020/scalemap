import { useFileStore } from './store/file.store'
import { useSimulationStore } from './store/simulation.store'
import styles from './StatusBar.module.css'

function formatAutosave(date: Date | null): string {
  if (!date) return 'not yet saved'
  const secs = Math.floor((Date.now() - date.getTime()) / 1000)
  if (secs < 5) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  return `${mins}m ago`
}

interface StatusBarProps {
  onToggleDrawer: () => void
  drawerOpen: boolean
}

export function StatusBar({ onToggleDrawer, drawerOpen }: StatusBarProps) {
  const { fileName, dirty, lastAutosave } = useFileStore()
  const running = useSimulationStore(s => s.running)
  const events  = useSimulationStore(s => s.events)

  const hasActivity = running || events.length > 0

  return (
    <div className={styles.bar}>
      {dirty ? (
        <span className={styles.item} style={{ color: '#F59E0B' }}>● unsaved</span>
      ) : (
        <span className={styles.item} style={{ color: '#2A2E38' }}>
          {fileName ? fileName : 'untitled'} · {formatAutosave(lastAutosave)}
        </span>
      )}
      <span className={styles.spacer} />
      {hasActivity && (
        <button
          className={`${styles.item} ${styles.btn} ${drawerOpen ? styles.active : ''}`}
          onClick={onToggleDrawer}
          title="Toggle metrics drawer"
        >
          Metrics {drawerOpen ? '▾' : '▴'}
        </button>
      )}
    </div>
  )
}
