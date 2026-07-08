import { useEffect, useState } from 'react'
import { FilePlus, Clock, Import } from 'lucide-react'
import { useFileStore } from '../store/file.store'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { getRecentFiles, type RecentFile } from '../../lib/tauri'
import { openWorldFromPath } from '../world/fileOps'
import styles from './HomeScreen.module.css'

export function HomeScreen() {
  const [recents, setRecents] = useState<RecentFile[]>([])
  const [openError, setOpenError] = useState<string | null>(null)
  const { setShowHome, setRecentFiles } = useFileStore()

  useEffect(() => {
    getRecentFiles().then(files => {
      setRecents(files)
      setRecentFiles(files)
    })
  }, [setRecentFiles])

  const openNew = () => {
    useWorldStore.getState().newWorld()
    useNavStore.getState().goGlobe()
    useFileStore.getState().setFilePath(null)
    setShowHome(false)
  }

  const openFile = async (path: string) => {
    try {
      await openWorldFromPath(path)
      setShowHome(false)
    } catch (e) {
      console.error('Failed to open file:', e)
      setOpenError(e instanceof Error ? e.message : 'Failed to open file')
    }
  }

  return (
    <div className={styles.screen}>
      <div className={styles.inner}>
        <div className={styles.logo}>
          <span className={styles.logoText}>scalemap</span>
          <span className={styles.logoSub}>Infrastructure visualization</span>
        </div>

        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={openNew}>
            <FilePlus size={20} />
            <span className={styles.actionLabel}>New World</span>
            <span className={styles.actionSub}>Start from scratch</span>
          </button>
          <button className={styles.actionBtn} disabled>
            <Import size={20} />
            <span className={styles.actionLabel}>Import Terraform</span>
            <span className={styles.actionSub}>Coming soon</span>
          </button>
        </div>

        {recents.length > 0 && (
          <div className={styles.recents}>
            <div className={styles.recentsHeader}>
              <Clock size={12} /> Recent files
            </div>
            {recents.map(f => (
              <button key={f.path} className={styles.recentItem} onClick={() => openFile(f.path)}>
                <span className={styles.recentName}>{f.name}</span>
                <span className={styles.recentDate}>
                  {new Date(f.modified).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
        {openError && <div style={{ color: 'var(--color-danger)', font: '11px var(--font-mono)', marginTop: 8 }}>{openError}</div>}
      </div>
    </div>
  )
}
