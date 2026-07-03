import { useCallback, useEffect, useRef, useState } from 'react'
import { FilePlus, FolderOpen, Save, Download, Upload, ChevronDown, ChevronRight } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { useCostHistoryStore } from '../store/costHistory.store'
import { useFileStore } from '../store/file.store'
import { exportTerraform } from '../../lib/terraform/exportTerraform'
import { serialize } from '../../lib/serializer'
import { parseScaleScript, applyScaleScript, exportScaleScript } from '../../lib/scalescript'
import type { NodeData, NodeSlo, EdgeData } from '../../lib/nodeConfig'
import styles from './Toolbar.module.css'

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

interface Props {
  fileName: string | null
}

export function FileMenu({ fileName }: Props) {
  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<'export' | 'import' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { running, runs } = useSimulationStore()
  const { showHome, setShowHome } = useFileStore()

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setSubmenu(null) }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const closeAll = useCallback(() => { setOpen(false); setSubmenu(null) }, [])

  const handleNew = useCallback(() => {
    if (useSimulationStore.getState().running) return
    closeAll()
    useSimulationStore.getState().reset()
    useMetricsHistoryStore.getState().clearHistory()
    useCostHistoryStore.getState().clearHistory()
    useCanvasStore.setState({ nodes: [], edges: [], history: [], future: [] })
    useFileStore.getState().setFilePath(null)
    useFileStore.getState().setShowHome(false)
  }, [closeAll])

  const handleOpen = useCallback(() => {
    closeAll()
    setShowHome(!showHome)
  }, [closeAll, showHome, setShowHome])

  const handleSave = useCallback(() => {
    closeAll()
    const { nodes, edges, viewport, packetMode, packetTemplates, nextTemplateId } = useCanvasStore.getState()
    const name    = fileName?.replace('.scalemap', '') || 'diagram'
    const created = new Date().toISOString()
    const json    = serialize(nodes, edges, viewport, name, created, {
      mode: packetMode, templates: packetTemplates, nextId: nextTemplateId,
    })
    downloadBlob(json, `${name}.scalemap`, 'application/json')
  }, [fileName, closeAll])

  const handleTf = useCallback(() => {
    closeAll()
    const { nodes, edges } = useCanvasStore.getState()
    const name = fileName?.replace('.scalemap', '') || 'main'
    const hcl  = exportTerraform(nodes, edges, name)
    downloadBlob(hcl, `${name}.tf`, 'text/plain')
  }, [fileName, closeAll])

  const handleExportScript = useCallback(() => {
    closeAll()
    const { nodes, edges } = useCanvasStore.getState()
    const { nodeConfigs, edgeRps, sloStatus, simulationMode, globalMultiplier, speed } = useSimulationStore.getState()
    const sloMap = new Map<string, NodeSlo>()
    for (const [nid] of sloStatus) {
      const node = nodes.find(n => n.id === nid)
      const slo = (node?.data as NodeData)?.slo
      if (slo) sloMap.set(nid, slo)
    }
    const name = fileName?.replace('.scalemap', '') || 'script'
    const json = exportScaleScript(name, nodes, nodeConfigs, edgeRps, sloMap, simulationMode, globalMultiplier, speed, edges)
    downloadBlob(json, `${name}.scalescript.json`, 'application/json')
  }, [fileName, closeAll])

  const handleImportScript = useCallback(() => {
    if (useSimulationStore.getState().running) return
    closeAll()
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      if (useSimulationStore.getState().running) return
      try {
        const text = await file.text()
        const script = parseScaleScript(text)
        const { nodes, edges } = useCanvasStore.getState()
        const applied = applyScaleScript(script, nodes, edges)
        const simStore = useSimulationStore.getState()
        for (const { nodeId, simConfig } of applied.nodeConfigs) {
          simStore.setNodeConfig(nodeId, simConfig)
        }
        for (const { edgeId, rps } of applied.edgeRps) {
          simStore.setEdgeRps(edgeId, rps)
        }
        for (const { edgeId, config } of applied.edgeConfigs) {
          useCanvasStore.getState().updateEdgeData(edgeId, { config: config as unknown as EdgeData['config'] })
        }
        if (applied.simulationOverrides?.mode) simStore.setSimulationMode(applied.simulationOverrides.mode)
        if (applied.simulationOverrides?.baseMultiplier) simStore.setGlobalMultiplier(applied.simulationOverrides.baseMultiplier)
        if (applied.simulationOverrides?.speed) simStore.setSpeed(applied.simulationOverrides.speed)
        simStore.setActiveScript(script)
      } catch (err) {
        console.error('Failed to load ScaleScript:', err)
      }
    }
    input.click()
  }, [closeAll])

  return (
    <div ref={ref} className={styles.dropdownWrap}>
      <button
        className={`${styles.btnPrimary} ${styles.btnDropdown}`}
        onClick={() => setOpen(o => !o)}
        title="File — new, open, save, export, import"
      >
        <FilePlus size={12} /> File <ChevronDown size={10} className={open ? styles.chevronOpen : ''} />
      </button>
      {open && (
        <div className={styles.dropdownMenu}>
          <button
            className={styles.dropdownItem}
            onClick={handleNew}
            disabled={running}
            title={running ? 'Editing locked while simulation is running' : 'New diagram (Cmd+N)'}
          >
            <span className={styles.dropdownItemIcon}><FilePlus size={13} /></span>
            <span><span className={styles.dropdownItemLabel}>New</span></span>
          </button>

          <button className={styles.dropdownItem} onClick={handleOpen} title="Open diagram">
            <span className={styles.dropdownItemIcon}><FolderOpen size={13} /></span>
            <span><span className={styles.dropdownItemLabel}>Open</span></span>
          </button>

          {!showHome && (
            <>
              <button className={styles.dropdownItem} onClick={handleSave} title="Save diagram as .scalemap">
                <span className={styles.dropdownItemIcon}><Save size={13} /></span>
                <span><span className={styles.dropdownItemLabel}>Save</span></span>
              </button>

              <div className={styles.dropdownSubWrap}>
                <button
                  className={styles.dropdownItem}
                  onClick={() => setSubmenu(s => s === 'export' ? null : 'export')}
                  title="Export diagram files"
                >
                  <span className={styles.dropdownItemIcon}><Download size={13} /></span>
                  <span><span className={styles.dropdownItemLabel}>Export</span></span>
                  <ChevronRight size={12} className={styles.submenuChevron} />
                </button>
                {submenu === 'export' && (
                  <div className={styles.dropdownSubmenu}>
                    <button className={styles.dropdownItem} onClick={handleTf}>
                      <span className={styles.dropdownItemIcon}>⬡</span>
                      <span>
                        <span className={styles.dropdownItemLabel}>Terraform</span>
                        <span className={styles.dropdownItemDesc}>HashiCorp HCL (.tf)</span>
                      </span>
                    </button>
                    <button className={styles.dropdownItem} onClick={handleExportScript}>
                      <span className={styles.dropdownItemIcon}>⚙</span>
                      <span>
                        <span className={styles.dropdownItemLabel}>ScaleScript</span>
                        <span className={styles.dropdownItemDesc}>Portable simulation config (.json)</span>
                      </span>
                    </button>
                    {runs.length > 0 && (
                      <button className={styles.dropdownItem} disabled title="Coming soon">
                        <span className={styles.dropdownItemIcon} style={{ opacity: 0.4 }}>📊</span>
                        <span>
                          <span className={styles.dropdownItemLabel} style={{ opacity: 0.4 }}>Run Report</span>
                          <span className={styles.dropdownItemDesc}>Coming soon — disk export</span>
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className={styles.dropdownSubWrap}>
                <button
                  className={styles.dropdownItem}
                  onClick={() => setSubmenu(s => s === 'import' ? null : 'import')}
                  disabled={running}
                  title={running ? 'Editing locked while simulation is running' : 'Import files into diagram'}
                >
                  <span className={styles.dropdownItemIcon}><Upload size={13} /></span>
                  <span><span className={styles.dropdownItemLabel}>Import</span></span>
                  <ChevronRight size={12} className={styles.submenuChevron} />
                </button>
                {submenu === 'import' && !running && (
                  <div className={styles.dropdownSubmenu}>
                    <button className={styles.dropdownItem} onClick={handleImportScript}>
                      <span className={styles.dropdownItemIcon}>⚙</span>
                      <span>
                        <span className={styles.dropdownItemLabel}>ScaleScript…</span>
                        <span className={styles.dropdownItemDesc}>Load simulation config (.json)</span>
                      </span>
                    </button>
                    <button className={styles.dropdownItem} disabled title="Coming soon" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
                      <span className={styles.dropdownItemIcon}>⬡</span>
                      <span>
                        <span className={styles.dropdownItemLabel}>Terraform…</span>
                        <span className={styles.dropdownItemDesc}>Coming soon</span>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
