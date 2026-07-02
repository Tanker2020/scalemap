import { useEffect, useState } from 'react'
import { FilePlus, Clock, Import, Server, Zap, Database, Box, Network } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useFileStore } from '../store/file.store'
import { useSimulationStore } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { useCostHistoryStore } from '../store/costHistory.store'
import { useUiStore } from '../store/ui.store'
import { getRecentFiles, loadDiagram, type RecentFile } from '../../lib/tauri'
import { deserialize } from '../../lib/serializer'
import { VAULT_TEMPLATES, type VaultTemplate } from '../../lib/vault/templates'
import styles from './HomeScreen.module.css'

const CATEGORY_ICONS = {
  web:        <Server size={14} />,
  serverless: <Zap size={14} />,
  data:       <Database size={14} />,
  k8s:        <Box size={14} />,
  network:    <Network size={14} />,
}

// Dark-mode values are the original vivid brand accents (calibrated against the near-black
// canvas). Light-mode values reuse theme.ts's already-WCAG-verified CATEGORY_COLORS foreground
// variants (closest matching hue) rather than computing new ones — a straight accent swap at
// full opacity fails AA as small text on the light card (~2.5:1).
const CATEGORY_COLORS_DARK = {
  web:        '#4A9EFF',
  serverless: '#A78BFA',
  data:       '#F5A623',
  k8s:        '#2DD4BF',
  network:    '#2DD4BF',
}

const CATEGORY_COLORS_LIGHT = {
  web:        '#3F6DAC', // matches CATEGORY_COLORS.compute.foreground.light — 5.26:1 on white
  serverless: '#6D629C', // matches CATEGORY_COLORS.messaging.foreground.light — 5.42:1 on white
  data:       '#916B35', // matches CATEGORY_COLORS.storage.foreground.light — 4.82:1 on white
  k8s:        '#288177', // matches CATEGORY_COLORS.network.foreground.light — 4.67:1 on white
  network:    '#288177',
}

export function HomeScreen() {
  const [recents, setRecents] = useState<RecentFile[]>([])
  const { setShowHome, markSaved, setRecentFiles } = useFileStore()
  const loadDiagramStore = useCanvasStore(s => s.loadDiagram)
  const themeMode = useUiStore(s => s.themeMode)
  const CATEGORY_COLORS = themeMode === 'light' ? CATEGORY_COLORS_LIGHT : CATEGORY_COLORS_DARK

  useEffect(() => {
    getRecentFiles().then(files => {
      setRecents(files)
      setRecentFiles(files)
    })
  }, [setRecentFiles])

  const resetSim = () => {
    useSimulationStore.getState().reset()
    useMetricsHistoryStore.getState().clearHistory()
    useCostHistoryStore.getState().clearHistory()
  }

  const openNew = () => {
    resetSim()
    useCanvasStore.setState({ nodes: [], edges: [], history: [], future: [] })
    useFileStore.getState().setFilePath(null)
    setShowHome(false)
  }

  const openFile = async (path: string) => {
    try {
      const raw = await loadDiagram(path)
      const diagram = deserialize(raw)
      resetSim()
      loadDiagramStore(diagram.nodes, diagram.edges, diagram.viewport, diagram.packets)
      markSaved(path)
      setShowHome(false)
    } catch (e) {
      console.error('Failed to open file:', e)
    }
  }

  const loadTemplate = (tpl: VaultTemplate) => {
    resetSim()
    useCanvasStore.setState({ nodes: tpl.nodes, edges: tpl.edges, history: [], future: [] })
    useFileStore.getState().setFilePath(null)
    useFileStore.getState().setDirty(true)
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
            <span className={styles.actionLabel}>New Diagram</span>
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

        <div className={styles.vault}>
          <div className={styles.vaultHeader}>
            Template Vault
            <span className={styles.vaultCount}>{VAULT_TEMPLATES.length} templates</span>
          </div>
          <div className={styles.vaultGrid}>
            {VAULT_TEMPLATES.map(tpl => (
              <button
                key={tpl.id}
                className={styles.templateCard}
                onClick={() => loadTemplate(tpl)}
                style={{ '--cat-color': CATEGORY_COLORS[tpl.category] } as React.CSSProperties}
              >
                <div className={styles.templateTop}>
                  <span className={styles.templateCategory}>
                    {CATEGORY_ICONS[tpl.category]}
                    {tpl.category}
                  </span>
                  <span className={styles.templateNodes}>{tpl.nodes.length} nodes</span>
                </div>
                <div className={styles.templateName}>{tpl.name}</div>
                <div className={styles.templateDesc}>{tpl.description}</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
