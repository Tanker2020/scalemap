import { useEffect, useState } from 'react'
import { FilePlus, Clock, Import } from 'lucide-react'
import { useFileStore } from '../store/file.store'
import { useWorldStore } from '../store/world.store'
import { useNavStore } from '../store/nav.store'
import { useUiStore } from '../store/ui.store'
import { getRecentFiles, type RecentFile } from '../../lib/tauri'
import { openWorldFromPath } from '../world/fileOps'
import { VaultCard } from './VaultCard'
import { VAULT, type VaultEntry } from '../../lib/vault/exampleWorlds'
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

  const openExample = (entry: VaultEntry) => {
    // Mirrors openNew's stance exactly: replaceWorld doesn't touch the file store the way
    // newWorld does, so the resets below are explicit here — pristine, no path, no created
    // stamp (Save will ask for a location, same as a brand-new world).
    useWorldStore.getState().replaceWorld(entry.build())
    useFileStore.getState().setFilePath(null)
    useFileStore.getState().setDirty(false)
    useFileStore.getState().setCreatedIso(null)
    // Teaching-only: queue the Analysis tab so the broken world opens straight onto its
    // findings instead of Topology — every other card leaves this null.
    if (entry.id === 'broken-teaching') useUiStore.getState().setPendingPanelTab('analysis')
    useNavStore.getState().goGlobe()
    setShowHome(false)
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

        <div className={styles.vaultSection}>
          <div className={styles.vaultHeader}>Start from an example</div>
          <div className={styles.vaultGrid}>
            {VAULT.map(e => <VaultCard key={e.id} entry={e} onOpen={openExample} />)}
          </div>
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
