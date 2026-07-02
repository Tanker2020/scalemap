import { useCallback, useState, useRef, useEffect } from 'react'
import { FilePlus, FolderOpen, ChevronDown, MousePointer2, Hand, Zap, SlidersHorizontal, Save, Upload, Download, ClipboardList, ShieldCheck, Package, Sun, Moon } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import { useSimulationStore, type TrafficMode } from '../store/simulation.store'
import { useMetricsHistoryStore } from '../store/metricsHistory.store'
import { useUiStore } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { useFileStore } from '../store/file.store'
import { lintGraph } from '../../lib/lint/lintGraph'
import { exportTerraform } from '../../lib/terraform/exportTerraform'
import { serialize } from '../../lib/serializer'
import { parseScaleScript, applyScaleScript, exportScaleScript } from '../../lib/scalescript'
import type { NodeData, NodeSlo, EdgeData } from '../../lib/nodeConfig'
import styles from './Toolbar.module.css'

const SPEEDS: number[]      = [0.5, 1, 2, 5]
const MULTIPLIERS: number[] = [0.5, 1, 2, 5]
const TRAFFIC_MODES: { key: TrafficMode; label: string; short: string; desc: string }[] = [
  { key: 'steady', label: 'Steady Load',            short: 'Steady',  desc: 'Constant traffic at configured volume' },
  { key: 'ramp',   label: 'Gradual Ramp',           short: 'Ramp',    desc: 'Linear ramp from 0 → 100% over 2 min. Models gradual rollout or morning traffic rise.' },
  { key: 'spike',  label: 'Flash Crowd',            short: 'Spike',   desc: '8× burst for 10s every 40s. Models flash sales or viral events.' },
  { key: 'chaos',  label: 'Chaos / Fault Injection', short: 'Chaos',  desc: 'Random node failures (5–20s) + 6× traffic spikes. Models production chaos or game day.' },
]

// ─── Save button ─────────────────────────────────────────────────────────────

function SaveButton({ fileName }: { fileName: string | null }) {
  const handleSave = useCallback(() => {
    const { nodes, edges, viewport, packetMode, packetTemplates, nextTemplateId } = useCanvasStore.getState()
    const name    = fileName?.replace('.scalemap', '') || 'diagram'
    const created = new Date().toISOString()
    const json    = serialize(nodes, edges, viewport, name, created, {
      mode: packetMode, templates: packetTemplates, nextId: nextTemplateId,
    })
    downloadBlob(json, `${name}.scalemap`, 'application/json')
  }, [fileName])

  return (
    <button className={styles.btnPrimary} onClick={handleSave} title="Save diagram as .scalemap">
      <Save size={12} /> Save
    </button>
  )
}

// ─── Export menu ──────────────────────────────────────────────────────────────

function ExportMenu({ fileName }: { fileName: string | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { runs } = useSimulationStore()

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handleTf = useCallback(() => {
    setOpen(false)
    const { nodes, edges } = useCanvasStore.getState()
    const name = fileName?.replace('.scalemap', '') || 'main'
    const hcl  = exportTerraform(nodes, edges, name)
    downloadBlob(hcl, `${name}.tf`, 'text/plain')
  }, [fileName])

  const handleExportScript = useCallback(() => {
    setOpen(false)
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
  }, [fileName])

  return (
    <div ref={ref} className={styles.dropdownWrap}>
      <button
        className={`${styles.btnPrimary} ${styles.btnDropdown}`}
        onClick={() => setOpen(o => !o)}
        title="Export diagram files"
      >
        <Download size={12} /> Export <ChevronDown size={10} className={open ? styles.chevronOpen : ''} />
      </button>
      {open && (
        <div className={styles.dropdownMenu}>
          <button className={styles.dropdownItem} onClick={handleTf}>
            <span className={styles.dropdownItemIcon}>⬡</span>
            <span>
              <span className={styles.dropdownItemLabel}>Export as Terraform</span>
              <span className={styles.dropdownItemDesc}>HashiCorp HCL (.tf)</span>
            </span>
          </button>
          <button className={styles.dropdownItem} onClick={handleExportScript}>
            <span className={styles.dropdownItemIcon}>⚙</span>
            <span>
              <span className={styles.dropdownItemLabel}>Export ScaleScript</span>
              <span className={styles.dropdownItemDesc}>Portable simulation config (.json)</span>
            </span>
          </button>
          {runs.length > 0 && (
            <button className={styles.dropdownItem} onClick={() => setOpen(false)} disabled title="Coming soon">
              <span className={styles.dropdownItemIcon} style={{ opacity: 0.4 }}>📊</span>
              <span>
                <span className={styles.dropdownItemLabel} style={{ opacity: 0.4 }}>Export Run Report</span>
                <span className={styles.dropdownItemDesc}>Coming soon — disk export</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Import menu ──────────────────────────────────────────────────────────────

function ImportMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const running = useSimulationStore(s => s.running)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handleImportScript = useCallback(() => {
    if (useSimulationStore.getState().running) return
    setOpen(false)
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
  }, [])

  return (
    <div ref={ref} className={styles.dropdownWrap}>
      <button
        className={`${styles.btnPrimary} ${styles.btnDropdown}`}
        onClick={() => setOpen(o => !o)}
        disabled={running}
        title={running ? 'Editing locked while simulation is running' : 'Import files into diagram'}
      >
        <Upload size={12} /> Import <ChevronDown size={10} className={open ? styles.chevronOpen : ''} />
      </button>
      {open && (
        <div className={styles.dropdownMenu}>
          <button className={styles.dropdownItem} onClick={handleImportScript}>
            <span className={styles.dropdownItemIcon}>⚙</span>
            <span>
              <span className={styles.dropdownItemLabel}>Import ScaleScript…</span>
              <span className={styles.dropdownItemDesc}>Load simulation config (.json)</span>
            </span>
          </button>
          <button className={styles.dropdownItem} disabled title="Coming soon" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            <span className={styles.dropdownItemIcon}>⬡</span>
            <span>
              <span className={styles.dropdownItemLabel}>Import Terraform…</span>
              <span className={styles.dropdownItemDesc}>Coming soon</span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Simulation settings popover ─────────────────────────────────────────────

function SimSettings({ open }: { open: boolean }) {
  const { speed, setSpeed, simulationMode, setSimulationMode, globalMultiplier, setGlobalMultiplier } = useSimulationStore()

  if (!open) return null

  return (
    <div className={styles.settingsPanel}>
      <div className={styles.settingsPanelHeader}>Simulation Settings</div>

      <div className={styles.settingsSection}>
        <div className={styles.settingsSectionLabel}>Playback Speed</div>
        <div className={styles.settingsRow}>
          {SPEEDS.map(s => (
            <button
              key={s}
              className={`${styles.settingsChip} ${speed === s ? styles.settingsChipActive : ''}`}
              onClick={() => setSpeed(s)}
              title={`${s}× animation speed`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>

      <div className={styles.settingsDivider} />

      <div className={styles.settingsSection}>
        <div className={styles.settingsSectionLabel}>Traffic Pattern</div>
        <div className={styles.settingsModeGrid}>
          {TRAFFIC_MODES.map(({ key, label, desc }) => (
            <button
              key={key}
              className={`${styles.settingsModeBtn} ${simulationMode === key ? styles.settingsModeBtnActive : ''}`}
              onClick={() => setSimulationMode(key)}
              title={desc}
            >
              <span className={styles.settingsModeName}>{label}</span>
              <span className={styles.settingsModeDesc}>{desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.settingsDivider} />

      <div className={styles.settingsSection}>
        <div className={styles.settingsSectionLabel}>Traffic Volume</div>
        <div className={styles.settingsRow}>
          {MULTIPLIERS.map(m => (
            <button
              key={m}
              className={`${styles.settingsChip} ${globalMultiplier === m ? styles.settingsChipActive : ''}`}
              onClick={() => setGlobalMultiplier(m)}
              title={`${m}× base request volume`}
            >
              {m}×
            </button>
          ))}
        </div>
      </div>

      <div className={styles.settingsPanelFooter}>
        Press <kbd className={styles.kbd}>Esc</kbd> to close
      </div>
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// ─── Main toolbar ─────────────────────────────────────────────────────────────

export function Toolbar() {
  const { undo, redo } = useCanvasStore()
  const { running, paused, setRunning, setPaused, activeScript, setActiveScript, runs, simulationMode, globalMultiplier } = useSimulationStore()
  const { activeTool, setActiveTool, setSimConfigOpen, simConfigOpen, dockOpen, dockTab, openDockTab, setDockOpen, packetEditorOpen, setPacketEditorOpen, themeMode, setThemeMode } = useUiStore()
  const packetMode = useCanvasStore(s => s.packetMode)
  const diagnosticsCount = useDiagnosticsStore(s => s.diagnostics.length)
  const { showHome, setShowHome, fileName } = useFileStore()

  // Re-runs the linter and opens the dock on the Diagnostics tab. If the dock is already open
  // on Diagnostics, clicking again just re-runs (dock stays open) rather than toggling closed —
  // "Diagnostics" here is primarily an action (run the linter), the dock visibility is a
  // secondary effect, unlike Inspect/Dock-on-Reports which are pure visibility toggles.
  const runDiagnostics = useCallback(() => {
    const { nodes, edges } = useCanvasStore.getState()
    useDiagnosticsStore.getState().setDiagnostics(lintGraph(nodes, edges))
    openDockTab('diagnostics')
  }, [openDockTab])
  const [scriptPreviewOpen, setScriptPreviewOpen] = useState(false)
  const [simSettingsOpen, setSimSettingsOpen] = useState(false)
  const simWrapRef = useRef<HTMLDivElement>(null)
  const isNonDefault = simulationMode !== 'steady' || globalMultiplier !== 1
  const modeLabel = TRAFFIC_MODES.find(m => m.key === simulationMode)?.short ?? 'Steady'

  const handleNew = useCallback(() => {
    if (useSimulationStore.getState().running) return
    useSimulationStore.getState().reset()
    useMetricsHistoryStore.getState().clearHistory()
    useCanvasStore.setState({ nodes: [], edges: [], history: [], future: [] })
    useFileStore.getState().setFilePath(null)
    useFileStore.getState().setShowHome(false)
  }, [])

  const handleStartSim = useCallback(() => {
    setPaused(false)
    setRunning(true)
  }, [setRunning, setPaused])

  const handlePause = useCallback(() => setPaused(true), [setPaused])
  const handleResume = useCallback(() => setPaused(false), [setPaused])
  const handleEnd = useCallback(() => {
    setPaused(false)
    setRunning(false)
  }, [setRunning, setPaused])

  useEffect(() => {
    if (!simSettingsOpen) return
    function onDown(e: MouseEvent) {
      if (simWrapRef.current && !simWrapRef.current.contains(e.target as Node)) setSimSettingsOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSimSettingsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [simSettingsOpen])

  return (
    <div className={styles.toolbar}>
      {/* File */}
      <button
        className={styles.btnPrimary}
        onClick={handleNew}
        disabled={running}
        title={running ? 'Editing locked while simulation is running' : 'New diagram (Cmd+N)'}
      >
        <FilePlus size={12} /> New
      </button>
      <button
        className={styles.btnPrimary}
        onClick={() => setShowHome(!showHome)}
        title="Open diagram"
      >
        <FolderOpen size={12} /> Open
      </button>
      {!showHome && (
        <>
          <SaveButton fileName={fileName} />
          <ExportMenu fileName={fileName} />
          <ImportMenu />
        </>
      )}

      <div className={styles.sep} />

      {/* Tools */}
      <button
        className={`${styles.btnTool} ${activeTool === 'select' ? styles.active : ''}`}
        onClick={() => setActiveTool('select')}
        title="Select (V)"
      >
        <MousePointer2 size={12} /> Select
      </button>
      <button
        className={`${styles.btnTool} ${activeTool === 'hand' ? styles.active : ''}`}
        onClick={() => setActiveTool('hand')}
        title="Hand (H)"
      >
        <Hand size={12} /> Hand
      </button>
      <button
        className={`${styles.btnTool} ${activeTool === 'connect' ? styles.active : ''}`}
        onClick={() => setActiveTool('connect')}
        title="Connect (C)"
      >
        <Zap size={12} /> Connect
      </button>

      <div className={styles.sep} />

      <button
        className={styles.btnTool}
        onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
        title={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {themeMode === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>

      {!showHome && (
        <>
          <div className={styles.sep} />
          <button
            className={styles.btnTool}
            onClick={() => undo()}
            disabled={running}
            title={running ? 'Editing locked while simulation is running' : 'Undo (Cmd+Z)'}
          >Undo</button>
          <button
            className={styles.btnTool}
            onClick={() => redo()}
            disabled={running}
            title={running ? 'Editing locked while simulation is running' : 'Redo (Cmd+Shift+Z)'}
          >Redo</button>

          <div className={styles.spacer} />

          {/* Panels group — Inspect / Dock / Packets are persistent-UI toggles, visually
              distinct from the one-shot actions (Undo/Redo/Export) to their left and the
              Simulate action-button to their right. Previously Reports and Diagnostics were
              two independent toggles that could both be open at once, stacking directly on
              top of each other at the same right-edge position — they're now one Dock button
              with two tabs (see UtilityDock.tsx), so there is exactly one right-edge overlay
              slot instead of three uncoordinated ones. */}
          <div className={styles.panelGroup}>
            <span className={styles.panelGroupLabel}>Panels</span>

            <button
              className={`${styles.btnInspect} ${simConfigOpen ? styles.btnInspectActive : ''}`}
              onClick={() => setSimConfigOpen(!simConfigOpen)}
              title="Simulation Inspector — configure capacity, latency, SLOs and watch live metrics for every node"
            >
              <SlidersHorizontal size={12} />
              Inspect
            </button>

            {/* Dock button — opens the unified Diagnostics/Reports dock. Clicking re-runs
                diagnostics and switches to that tab even if the dock is already open on
                Reports, so this single button covers what used to be two. */}
            <button
              className={`${styles.btnReports} ${dockOpen ? styles.btnReportsActive : ''}`}
              onClick={() => {
                if (dockOpen && dockTab === 'reports') { setDockOpen(false); return }
                openDockTab('reports')
              }}
              title="Reports & Diagnostics dock — simulation run history and architectural lint results"
            >
              <ClipboardList size={12} />
              Dock
              {(runs.length > 0 || diagnosticsCount > 0) && (
                <span className={styles.reportsBadge}>{runs.length + diagnosticsCount}</span>
              )}
            </button>

            {/* Packet editor button — define request templates + traffic mix */}
            <button
              className={`${styles.btnReports} ${packetEditorOpen ? styles.btnReportsActive : ''}`}
              onClick={() => setPacketEditorOpen(!packetEditorOpen)}
              title="Packet templates — define request types and per-node traffic distribution"
            >
              <Package size={12} />
              Packets
              {packetMode === 'custom' && (
                <span className={styles.reportsBadge}>on</span>
              )}
            </button>

            {/* Run Diagnostics — architectural linter action, opens the Dock on its tab */}
            <button
              className={styles.btnDiagnostics}
              onClick={runDiagnostics}
              title="Run architectural diagnostics — detect anti-patterns in the current design"
            >
              <ShieldCheck size={12} />
              Diagnostics
              {diagnosticsCount > 0 && (
                <span className={styles.diagnosticsBadge}>{diagnosticsCount}</span>
              )}
            </button>
          </div>

          {/* Active ScaleScript pill */}
          {activeScript && (
            <div className={styles.scriptPill}>
              <button
                className={styles.scriptName}
                onClick={() => setScriptPreviewOpen(o => !o)}
                title="Click to preview ScaleScript"
              >
                ⚙ {activeScript.name}
              </button>
              <button
                className={styles.scriptClose}
                onClick={() => {
                  setActiveScript(null)
                }}
                title="Clear ScaleScript"
              >×</button>
            </div>
          )}

          {/* Script preview modal */}
          {scriptPreviewOpen && activeScript && (
            <div className={styles.scriptModal} onClick={() => setScriptPreviewOpen(false)}>
              <div className={styles.scriptModalBox} onClick={e => e.stopPropagation()}>
                <div className={styles.scriptModalHeader}>
                  <span>{activeScript.name}</span>
                  <button onClick={() => setScriptPreviewOpen(false)}>×</button>
                </div>
                <pre className={styles.scriptModalBody}>{JSON.stringify(activeScript, null, 2)}</pre>
              </div>
            </div>
          )}

          {/* Simulation split button group */}
          <div ref={simWrapRef} className={styles.simSplitGroup}>
            <div className={styles.simSplitBtn}>
              {!running ? (
                <button
                  className={`${styles.btnSimulate} ${styles.btnSimMain}`}
                  onClick={handleStartSim}
                  title="Start simulation (Space)"
                >
                  <span className={styles.playIcon} />
                  Simulate
                </button>
              ) : paused ? (
                <button
                  className={`${styles.btnSimulate} ${styles.btnResume} ${styles.btnSimMain}`}
                  onClick={handleResume}
                  title="Resume simulation"
                >
                  <span className={styles.playIcon} />
                  Resume
                </button>
              ) : (
                <button
                  className={`${styles.btnSimulate} ${styles.simulating} ${styles.btnSimMain}`}
                  onClick={handlePause}
                  title="Freeze simulation — particles stop, metrics freeze. Click Resume to continue."
                >
                  <span className={styles.pauseIcon}>
                    <span className={styles.pauseBar} />
                    <span className={styles.pauseBar} />
                  </span>
                  Pause
                </button>
              )}
              <button
                className={[
                  styles.btnSimChevron,
                  running && !paused ? styles.btnSimChevronSimulating : '',
                  running && paused ? styles.btnSimChevronResume : '',
                  simSettingsOpen ? styles.btnSimChevronOpen : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setSimSettingsOpen(o => !o)}
                title="Simulation settings — speed, traffic mode, volume"
              >
                {isNonDefault && (
                  <span className={styles.settingsBadge}>{modeLabel} · {globalMultiplier}×</span>
                )}
                <ChevronDown size={11} className={simSettingsOpen ? styles.chevronOpen : ''} />
              </button>
            </div>

            {running && (
              <button
                className={styles.btnEnd}
                onClick={handleEnd}
                title="End simulation and capture run report"
              >
                <span className={styles.stopIcon} />
                End
              </button>
            )}

            <SimSettings open={simSettingsOpen} />
          </div>
        </>
      )}
    </div>
  )
}
