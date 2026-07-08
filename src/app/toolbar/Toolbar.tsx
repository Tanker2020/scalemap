import { useCallback, useState, useRef, useEffect } from 'react'
import { ChevronDown, MousePointer2, Hand, Zap, SlidersHorizontal, ClipboardList, Package, Sun, Moon, Cloud, Lock } from 'lucide-react'
import { useCanvasStore } from '../store/canvas.store'
import type { CloudProvider } from '../../lib/cloudRegistry'
import { useSimulationStore, type TrafficMode } from '../store/simulation.store'
import { useUiStore } from '../store/ui.store'
import { useFileStore } from '../store/file.store'
import { FileMenu } from './FileMenu'
import styles from './Toolbar.module.css'

const SPEEDS: number[]      = [0.5, 1, 2, 5]
const MULTIPLIERS: number[] = [0.5, 1, 2, 5]
const TRAFFIC_MODES: { key: TrafficMode; label: string; short: string; desc: string }[] = [
  { key: 'steady', label: 'Steady Load',            short: 'Steady',  desc: 'Constant traffic at configured volume' },
  { key: 'ramp',   label: 'Gradual Ramp',           short: 'Ramp',    desc: 'Linear ramp from 0 → 100% over 2 min. Models gradual rollout or morning traffic rise.' },
  { key: 'spike',  label: 'Flash Crowd',            short: 'Spike',   desc: '8× burst for 10s every 40s. Models flash sales or viral events.' },
  { key: 'chaos',  label: 'Chaos / Fault Injection', short: 'Chaos',  desc: 'Random node failures (5–20s) + 6× traffic spikes. Models production chaos or game day.' },
]

// ─── Provider menu ────────────────────────────────────────────────────────────

const PROVIDER_OPTIONS: { key: CloudProvider; label: string }[] = [
  { key: 'generic', label: 'Generic' },
  { key: 'aws',     label: 'AWS' },
  { key: 'gcp',     label: 'GCP' },
  { key: 'azure',   label: 'Azure' },
]

function ProviderMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const running = useSimulationStore(s => s.running)
  const nodeCount = useCanvasStore(s => s.nodes.length)
  const applyProviderToAll = useCanvasStore(s => s.applyProviderToAll)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const handlePick = useCallback((provider: CloudProvider) => {
    setOpen(false)
    applyProviderToAll(provider)
  }, [applyProviderToAll])

  return (
    <div ref={ref} className={styles.dropdownWrap}>
      <button
        className={`${styles.btnPrimary} ${styles.btnDropdown} ${styles.btnProvider}`}
        onClick={() => setOpen(o => !o)}
        disabled={running || nodeCount === 0}
        title={running ? 'Editing locked while simulation is running' : 'Apply a cloud provider to every node in the diagram'}
      >
        <Cloud size={12} /> <span className={styles.panelBtnLabel}>Provider</span> <ChevronDown size={10} className={open ? styles.chevronOpen : ''} />
      </button>
      {open && (
        <div className={styles.dropdownMenu}>
          {PROVIDER_OPTIONS.map(({ key, label }) => (
            <button key={key} className={styles.dropdownItem} onClick={() => handlePick(key)}>
              <span className={styles.dropdownItemIcon}>⬡</span>
              <span>
                <span className={styles.dropdownItemLabel}>{label}</span>
                <span className={styles.dropdownItemDesc}>Map every node to {label}, undoable in one step</span>
              </span>
            </button>
          ))}
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

// ─── Main toolbar ─────────────────────────────────────────────────────────────

export function Toolbar() {
  const { undo, redo } = useCanvasStore()
  const { running, paused, setRunning, setPaused, activeScript, setActiveScript, runs, simulationMode, globalMultiplier } = useSimulationStore()
  const { activeTool, setActiveTool, setSimConfigOpen, simConfigOpen, dockOpen, dockTab, openDockTab, setDockOpen, packetEditorOpen, setPacketEditorOpen, themeMode, setThemeMode } = useUiStore()
  const packetMode = useCanvasStore(s => s.packetMode)
  const { showHome, fileName } = useFileStore()

  const [scriptPreviewOpen, setScriptPreviewOpen] = useState(false)
  const [simSettingsOpen, setSimSettingsOpen] = useState(false)
  const simWrapRef = useRef<HTMLDivElement>(null)
  const isNonDefault = simulationMode !== 'steady' || globalMultiplier !== 1
  const modeLabel = TRAFFIC_MODES.find(m => m.key === simulationMode)?.short ?? 'Steady'

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
      <div className={styles.toolbarMain}>
        <FileMenu fileName={fileName} />
        {!showHome && !running && <ProviderMenu />}

        <div className={styles.sep} />

        {/* Tools — icon-only, always visible regardless of showHome/running: Hand-tool panning
            must stay available even while a simulation is running. */}
        <button
          className={`${styles.btnTool} ${styles.btnToolIcon} ${activeTool === 'select' ? styles.active : ''}`}
          onClick={() => setActiveTool('select')}
          title="Select (V)"
        >
          <MousePointer2 size={14} />
        </button>
        <button
          className={`${styles.btnTool} ${styles.btnToolIcon} ${activeTool === 'hand' ? styles.active : ''}`}
          onClick={() => setActiveTool('hand')}
          title="Hand (H)"
        >
          <Hand size={14} />
        </button>
        <button
          className={`${styles.btnTool} ${styles.btnToolIcon} ${activeTool === 'connect' ? styles.active : ''}`}
          onClick={() => setActiveTool('connect')}
          title="Connect (C)"
        >
          <Zap size={14} />
        </button>

        {!showHome && !running && (
          <div className={styles.undoRedoGroup}>
            <div className={styles.sep} />
            <button className={styles.btnTool} onClick={() => undo()} title="Undo (Cmd+Z)">Undo</button>
            <button className={styles.btnTool} onClick={() => redo()} title="Redo (Cmd+Shift+Z)">Redo</button>
          </div>
        )}
        {!showHome && running && (
          <span className={styles.lockedBadge} title="Provider, Undo, and Redo are locked while a simulation is running">
            <Lock size={11} />
          </span>
        )}

        {!showHome && (
          <>
            <div className={styles.spacer} />

            <div className={styles.panelGroup}>
              <span className={styles.panelGroupLabel}>Panels</span>

              <button
                className={`${styles.btnInspect} ${simConfigOpen ? styles.btnInspectActive : ''}`}
                onClick={() => setSimConfigOpen(!simConfigOpen)}
                title="Simulation Inspector — configure capacity, latency, SLOs and watch live metrics for every node"
              >
                <SlidersHorizontal size={12} />
                <span className={styles.panelBtnLabel}>Inspect</span>
              </button>

              <button
                className={`${styles.btnReports} ${dockOpen ? styles.btnReportsActive : ''}`}
                onClick={() => {
                  if (dockOpen && dockTab === 'reports') { setDockOpen(false); return }
                  openDockTab('reports')
                }}
                title="Reports dock — simulation run history"
              >
                <ClipboardList size={12} />
                <span className={styles.panelBtnLabel}>Dock</span>
                {runs.length > 0 && (
                  <span className={styles.reportsBadge}>{runs.length}</span>
                )}
              </button>

              <button
                className={`${styles.btnReports} ${packetEditorOpen ? styles.btnReportsActive : ''}`}
                onClick={() => setPacketEditorOpen(!packetEditorOpen)}
                title="Packet templates — define request types and per-node traffic distribution"
              >
                <Package size={12} />
                <span className={styles.panelBtnLabel}>Packets</span>
                {packetMode === 'custom' && (
                  <span className={styles.reportsBadge}>on</span>
                )}
              </button>
            </div>

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

      <button
        className={styles.themeToggleFixed}
        onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
        title={themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {themeMode === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
      </button>
    </div>
  )
}
