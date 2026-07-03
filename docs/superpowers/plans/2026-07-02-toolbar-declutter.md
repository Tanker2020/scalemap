# Toolbar Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the toolbar's horizontal scrollbar by consolidating file-operation buttons into one menu, making the tool cluster icon-only, collapsing genuinely-locked controls while simulating, and adding a CSS-only safety net so the bar never scrolls at any window width.

**Architecture:** Presentation-only change to `src/app/toolbar/Toolbar.tsx` and `Toolbar.module.css`, plus one new component file `src/app/toolbar/FileMenu.tsx`. No store, engine, or non-toolbar file changes.

**Tech Stack:** React 19 + TypeScript, CSS Modules, lucide-react icons, Zustand (read-only, no new state).

## Global Constraints

- No changes to any Zustand store shape (`simulation.store.ts`, `canvas.store.ts`, `file.store.ts`, `ui.store.ts` are read-only in this work).
- No new automated test infrastructure — verify every task manually via `npm run dev` + the Playwright MCP browser tools, per this project's existing UI-testing convention (no `*.test.tsx` files exist for any panel/toolbar component today).
- Every UI-visible step must be visually verified in-browser before being marked done (CLAUDE.md: "For UI or frontend changes... use the feature in a browser before reporting the task as complete").
- Keep diffs minimal and targeted — do not restructure `ProviderMenu`, the Panels group, the ScaleScript pill, or the Simulate split-button's own internals; only their surrounding wrapper/visibility changes.
- Update `docs/module-boundaries.md` if this introduces a new file other modules will need to know about (it does — `FileMenu.tsx` is new).

## Deviations from the approved spec (`docs/superpowers/specs/2026-07-02-toolbar-declutter-design.md`)

Found while translating the spec into exact code — both are corrections, not scope changes:

1. **Running-state collapse is narrower than the spec described.** The spec assumed `File`/`Provider`/`Select`/`Hand`/`Connect`/`Undo`/`Redo` are "already functionally locked (disabled) today" during a run. Checking the actual code: only `New`, `Import`, `Provider`, `Undo`, `Redo` are `disabled={running}`. `Save`/`Export` have no running-gate and work mid-simulation; `Select`/`Hand`/`Connect` have no running-gate at all (Hand-tool panning must keep working while simulating — that's the exact scenario the particle-desync-on-pan bugfix landed for). This plan hides only `Provider ▾` + `Undo` + `Redo` while running (replaced by a small lock badge) and keeps `FileMenu` and the tool cluster visible and functional throughout.
2. **Overflow safety net is CSS breakpoints, not a JS ResizeObserver + relocatable dropdown.** Relocating stateful dropdown components (`FileMenu`, `ProviderMenu`, the Panels group's own popovers) into a floating "more" menu would require them to work correctly nested inside another popover — real complexity for a case the spec itself calls a rare safety net. Two `max-width` breakpoints (hide `Undo`/`Redo` — has a Cmd+Z/Cmd+Shift+Z keyboard fallback already in its tooltip — then the ScaleScript pill) plus a hard `overflow-x: hidden` give the same guarantee (never scrolls, nothing clips) with far less risk.

---

### Task 1: Icon-only Select/Hand/Connect tool cluster

**Files:**
- Modify: `src/app/toolbar/Toolbar.module.css`
- Modify: `src/app/toolbar/Toolbar.tsx:443-463` (Tools section, current line numbers)

**Interfaces:**
- Consumes: existing `styles.btnTool`, `styles.active` CSS classes (unchanged); existing `activeTool`/`setActiveTool` from `useUiStore()` (unchanged).
- Produces: new CSS class `styles.btnToolIcon` (a sizing modifier layered on top of `.btnTool`), consumed by no other task.

- [ ] **Step 1: Add the icon-only sizing class**

In `src/app/toolbar/Toolbar.module.css`, add immediately after the `.btnTool.active { ... }` rule (currently ending at line 118):

```css
.btnToolIcon {
  padding: 6px;
  width: 28px;
  height: 28px;
  justify-content: center;
}
```

- [ ] **Step 2: Convert the three tool buttons to icon-only**

In `src/app/toolbar/Toolbar.tsx`, replace the `{/* Tools */}` block (current lines 443-463):

```tsx
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
```

with:

```tsx
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
```

- [ ] **Step 3: Verify in-browser**

Run `npm run dev` (background). Use the Playwright MCP browser tools to open `http://localhost:1420`, load or build a diagram, and take a screenshot of the toolbar.

Expected: Select/Hand/Connect show only icons (no "Select"/"Hand"/"Connect" text). Click each — the active one gets the highlighted (`.active`) background. Hover each — the browser tooltip shows "Select (V)" / "Hand (H)" / "Connect (C)".

- [ ] **Step 4: Commit**

```bash
git add src/app/toolbar/Toolbar.tsx src/app/toolbar/Toolbar.module.css
git commit -m "$(cat <<'EOF'
refactor: make toolbar Select/Hand/Connect icon-only

First step of the toolbar declutter (docs/superpowers/specs/2026-07-02-toolbar-declutter-design.md)
— drops the text labels to free horizontal space, tooltips carry the
label + existing keyboard shortcut unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Consolidate File/Save/Export/Import into one `FileMenu`

**Files:**
- Create: `src/app/toolbar/FileMenu.tsx`
- Modify: `src/app/toolbar/Toolbar.tsx` (imports, `SaveButton`/`ExportMenu`/`ImportMenu`/`downloadBlob`/`handleNew` removal, JSX wiring)
- Modify: `src/app/toolbar/Toolbar.module.css` (new submenu classes)

**Interfaces:**
- Consumes: `useCanvasStore`, `useSimulationStore`, `useMetricsHistoryStore`, `useCostHistoryStore`, `useFileStore` (all existing, unchanged shapes), `serialize` (`src/lib/serializer.ts`), `exportTerraform` (`src/lib/terraform/exportTerraform.ts`), `parseScaleScript`/`applyScaleScript`/`exportScaleScript` (`src/lib/scalescript.ts`).
- Produces: `FileMenu` component with signature `function FileMenu({ fileName }: { fileName: string | null }): JSX.Element`, imported by `Toolbar.tsx` as `import { FileMenu } from './FileMenu'`. Later tasks render it as `<FileMenu fileName={fileName} />`.

- [ ] **Step 1: Create `src/app/toolbar/FileMenu.tsx`**

```tsx
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
```

- [ ] **Step 2: Add submenu + disabled-item CSS**

In `src/app/toolbar/Toolbar.module.css`, add after the `.dropdownItemDesc { ... }` rule:

```css
.dropdownItem:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dropdownItem:disabled:hover {
  background: none;
}

.dropdownSubWrap {
  position: relative;
}

.submenuChevron {
  margin-left: auto;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.dropdownSubmenu {
  position: absolute;
  top: 0;
  left: 100%;
  margin-left: 6px;
  min-width: 200px;
  background: var(--color-toolbar);
  border: 1px solid var(--color-node-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.65), 0 2px 8px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  z-index: 1001;
  animation: dropIn 0.12s ease;
}
```

- [ ] **Step 3: Remove `SaveButton`/`ExportMenu`/`ImportMenu`/`downloadBlob`/`handleNew` from `Toolbar.tsx`, wire in `FileMenu`**

In `src/app/toolbar/Toolbar.tsx`:

1. Delete the `SaveButton` function (current lines 29-45), the `ExportMenu` function (lines 49-124), the `ImportMenu` function (lines 128-208), and the `downloadBlob` helper (lines 340-348).
2. Replace the top import block:

```tsx
import { FilePlus, FolderOpen, ChevronDown, MousePointer2, Hand, Zap, SlidersHorizontal, Save, Upload, Download, ClipboardList, ShieldCheck, Package, Sun, Moon, Cloud } from 'lucide-react'
```

with:

```tsx
import { ChevronDown, MousePointer2, Hand, Zap, SlidersHorizontal, ClipboardList, ShieldCheck, Package, Sun, Moon, Cloud } from 'lucide-react'
```

3. Remove these now-unused imports entirely (only `SaveButton`/`ExportMenu`/`ImportMenu` used them):

```tsx
import { exportTerraform } from '../../lib/terraform/exportTerraform'
import { serialize } from '../../lib/serializer'
import { parseScaleScript, applyScaleScript, exportScaleScript } from '../../lib/scalescript'
import type { NodeData, NodeSlo, EdgeData } from '../../lib/nodeConfig'
```

4. Add:

```tsx
import { FileMenu } from './FileMenu'
```

5. In the main `Toolbar()` function body, delete the `handleNew` useCallback (current lines 375-383), and change:

```tsx
  const { activeTool, setActiveTool, setSimConfigOpen, simConfigOpen, dockOpen, dockTab, openDockTab, setDockOpen, packetEditorOpen, setPacketEditorOpen, themeMode, setThemeMode } = useUiStore()
  const packetMode = useCanvasStore(s => s.packetMode)
  const diagnosticsCount = useDiagnosticsStore(s => s.diagnostics.length)
  const { showHome, setShowHome, fileName } = useFileStore()
```

to:

```tsx
  const { activeTool, setActiveTool, setSimConfigOpen, simConfigOpen, dockOpen, dockTab, openDockTab, setDockOpen, packetEditorOpen, setPacketEditorOpen, themeMode, setThemeMode } = useUiStore()
  const packetMode = useCanvasStore(s => s.packetMode)
  const diagnosticsCount = useDiagnosticsStore(s => s.diagnostics.length)
  const { showHome, fileName } = useFileStore()
```

6. Replace the `{/* File */}` JSX block (current lines 415-438):

```tsx
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
          <ProviderMenu />
        </>
      )}
```

with:

```tsx
      <FileMenu fileName={fileName} />
      {!showHome && <ProviderMenu />}
```

- [ ] **Step 4: Verify in-browser**

Run `npm run dev` (background), use Playwright to:
1. Load a diagram with at least one node. Click `File ▾` — confirm New/Open/Save/Export/Import all appear.
2. Click `Export` — confirm it expands inline to show Terraform/ScaleScript (and Run Report if a run exists), each downloading correctly (check the browser's download event or `browser_network_requests`/console for the blob URL creation — no network call is made, so confirm via a captured `download` DOM event or by checking `input`/`a` element creation in `browser_evaluate`).
3. Click `Import` — confirm it expands to show ScaleScript.../Terraform..., and ScaleScript import opens a file picker (confirm via `input[type=file]` creation).
4. Start a simulation. Reopen `File ▾` — confirm `New` and `Import` are visibly dimmed (from the `.dropdownItem:disabled` rule) and don't respond to click, while `Save` and `Export` remain fully clickable and functional.
5. End the simulation — confirm `New`/`Import` re-enable.

- [ ] **Step 5: Commit**

```bash
git add src/app/toolbar/FileMenu.tsx src/app/toolbar/Toolbar.tsx src/app/toolbar/Toolbar.module.css
git commit -m "$(cat <<'EOF'
refactor: consolidate New/Open/Save/Export/Import into one File menu

Second step of the toolbar declutter — replaces four separate
top-level buttons (Save, Export, Import, plus the standalone New/Open)
with a single File dropdown with inline Export/Import submenus, same
underlying logic and running-state gating as before.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Correct running-state collapse + relocate theme toggle to a fixed corner

**Files:**
- Modify: `src/app/toolbar/Toolbar.tsx` (full `return` statement, plus one new icon import)
- Modify: `src/app/toolbar/Toolbar.module.css`

**Interfaces:**
- Consumes: `FileMenu` (Task 2), icon-only tool buttons (Task 1), existing `ProviderMenu`, `SimSettings`, `runDiagnostics`, `handleStartSim`/`handlePause`/`handleResume`/`handleEnd` (all unchanged, defined earlier in the same file).
- Produces: new CSS classes `.toolbarMain`, `.undoRedoGroup`, `.lockedBadge`, `.themeToggleFixed`, consumed by Task 4 (which adds breakpoints targeting `.undoRedoGroup` and `.scriptPill`, and sets `overflow-x: hidden` on `.toolbarMain`).

- [ ] **Step 1: Add the new layout CSS classes and adjust `.toolbar`**

In `src/app/toolbar/Toolbar.module.css`, replace the `.toolbar { ... }` rule and the three `.toolbar::-webkit-scrollbar*` rules and the `.toolbar > * { flex-shrink: 0; }` rule (current lines 1-24) with:

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: var(--color-toolbar);
  border-bottom: 1px solid var(--color-toolbar-border);
  height: 42px;
  flex-shrink: 0;
}

.toolbarMain {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.toolbarMain > * {
  flex-shrink: 0;
}

.undoRedoGroup {
  display: flex;
  align-items: center;
  gap: 4px;
}

.lockedBadge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--color-text-muted);
  cursor: default;
}

.themeToggleFixed {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
  flex-shrink: 0;
}

.themeToggleFixed:hover {
  background: var(--color-surface-hover);
  border-color: var(--color-toolbar-border);
  color: var(--color-text-primary);
}
```

- [ ] **Step 2: Add the `Lock` icon import**

In `src/app/toolbar/Toolbar.tsx`, change:

```tsx
import { ChevronDown, MousePointer2, Hand, Zap, SlidersHorizontal, ClipboardList, ShieldCheck, Package, Sun, Moon, Cloud } from 'lucide-react'
```

to:

```tsx
import { ChevronDown, MousePointer2, Hand, Zap, SlidersHorizontal, ClipboardList, ShieldCheck, Package, Sun, Moon, Cloud, Lock } from 'lucide-react'
```

- [ ] **Step 3: Replace the entire `return` statement**

In `src/app/toolbar/Toolbar.tsx`, replace everything from `return (` to the matching closing `)` (the full JSX return of the `Toolbar` function) with:

```tsx
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
                Inspect
              </button>

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
```

- [ ] **Step 4: Verify in-browser**

Using Playwright against `npm run dev`:
1. Idle state, diagram loaded: confirm `File ▾`, `Provider ▾`, tool icons, `Undo`/`Redo`, Panels group, Simulate button all render left-to-right, theme toggle sits at the far right edge of the bar.
2. Start a simulation: confirm `Provider ▾` and `Undo`/`Redo` disappear, a small lock icon appears in their place (hover it — tooltip reads "Provider, Undo, and Redo are locked while a simulation is running"), `File ▾` and the tool icons remain visible and clickable, Panels group and Simulate/Pause/End remain fully interactive, theme toggle stays in place.
3. Click the Hand tool while simulating, then drag-pan the canvas — confirm this still works (this is the control path the particle-desync bugfix depends on staying enabled).
4. Toggle theme (light/dark) in both idle and running states — confirm the toggle button stays reachable and styled correctly in both.
5. End the simulation — confirm `Provider ▾`/`Undo`/`Redo` reappear and the lock badge disappears.

- [ ] **Step 5: Commit**

```bash
git add src/app/toolbar/Toolbar.tsx src/app/toolbar/Toolbar.module.css
git commit -m "$(cat <<'EOF'
refactor: collapse only genuinely-locked controls while simulating

Third step of the toolbar declutter. Hides Provider/Undo/Redo (the
controls actually disabled during a run) behind a small lock badge,
keeps File menu and Select/Hand/Connect visible and functional
throughout (Hand-tool panning must keep working mid-simulation), and
moves the theme toggle to a fixed corner slot outside the main
control flow.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: CSS-only overflow safety net

**Files:**
- Modify: `src/app/toolbar/Toolbar.module.css`

**Interfaces:**
- Consumes: `.toolbarMain`, `.undoRedoGroup`, `.scriptPill` (all from Tasks 2-3).
- Produces: nothing consumed by later tasks — this is the last structural change.

- [ ] **Step 1: Add the hard overflow guarantee and two shed-weight breakpoints**

In `src/app/toolbar/Toolbar.module.css`, add to the end of the `.toolbarMain { ... }` rule (from Task 3) the line `overflow-x: hidden;`, so it reads:

```css
.toolbarMain {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
}
```

Then add at the end of the file (after the `@keyframes dropIn { ... }` block):

```css
/* ── Narrow-window safety net ───────────────────────
   .toolbarMain has overflow-x: hidden as a hard guarantee against ever scrolling — these two
   breakpoints shed the lowest-priority content before that hidden overflow would otherwise clip
   anything. Undo/Redo have a Cmd+Z / Cmd+Shift+Z keyboard fallback already in their tooltips, so
   hiding the buttons doesn't remove the capability. The ScaleScript pill is informational (the
   script itself keeps running); losing its toolbar visibility at extreme widths is an acceptable
   trade for guaranteeing no clipped/unreachable Simulate button. */
@media (max-width: 1000px) {
  .undoRedoGroup {
    display: none;
  }
}

@media (max-width: 860px) {
  .scriptPill {
    display: none;
  }
}
```

- [ ] **Step 2: Verify in-browser at three widths**

Using Playwright's `browser_resize` against `npm run dev`, with a diagram loaded and (for one pass) an active ScaleScript:
1. 1440px wide: confirm every control is visible, no gap where Undo/Redo/ScaleScript pill would be.
2. 1024px wide: confirm every control still fits (this is the spec's "realistic minimum" target).
3. 950px wide: confirm `Undo`/`Redo` have disappeared (below the 1000px breakpoint) and nothing else clips.
4. 820px wide: confirm the ScaleScript pill has also disappeared (below the 860px breakpoint) and the Simulate button is still fully visible and clickable.
5. At each width, run `browser_evaluate` on the `.toolbarMain` element checking `el.scrollWidth <= el.clientWidth + 1` (small rounding tolerance) — confirm true at every width, proving nothing is scrollable.

If step 5 fails at any width (content still overflows), lower the two breakpoint values (e.g. 1000px → 1080px, 860px → 920px) until it passes — the exact numbers aren't load-bearing, only the "never scrolls" invariant is.

- [ ] **Step 3: Commit**

```bash
git add src/app/toolbar/Toolbar.module.css
git commit -m "$(cat <<'EOF'
fix: guarantee the toolbar never scrolls at any window width

Final step of the toolbar declutter (docs/superpowers/specs/2026-07-02-toolbar-declutter-design.md).
Replaces the old overflow-x: auto stopgap with overflow-x: hidden plus
two breakpoints that shed Undo/Redo (has a keyboard-shortcut fallback)
then the ScaleScript pill before anything would clip.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full integration verification + docs update

**Files:**
- Modify: `docs/module-boundaries.md`
- No source changes — this task is verification + documentation only.

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: nothing — terminal task.

- [ ] **Step 1: Run the full spec verification checklist**

Using Playwright against `npm run dev`, with `npm run build` also run once to confirm no type errors from the whole set of changes:

```bash
npx tsc --noEmit
```

Expected: no errors.

Then in-browser:
1. Idle state at 1440px/1024px/900px, **both themes** (toggle via the corner theme button) — no scrollbar at any width/theme, `File ▾`/`Provider ▾` open and close correctly, icon-only tools show correct tooltips.
2. Start a simulation — `Provider`/`Undo`/`Redo` disappear, lock badge appears, `File ▾` and tool icons stay usable, Panels group (`Inspect`/`Dock`/`Packets`/`Diagnostics`) all still open correctly.
3. Pause → Resume → End — confirm the split-button's existing behavior (unchanged in Tasks 1-4) still works exactly as before this whole effort started.
4. Force ~700px width — confirm the two CSS breakpoints have already shed Undo/Redo and the ScaleScript pill, and the Simulate button remains fully visible and clickable with zero scrollbar.
5. Toggle theme in both idle and running states — corner toggle stays reachable and styled correctly in both.

- [ ] **Step 2: Update `docs/module-boundaries.md`**

Add a new subsection under `## 1. Feature modules` (after the existing `### H. Utility dock` section, before `## 2. Shared "hub" files`):

```markdown
### I. Toolbar (2026-07-02, declutter pass)

| File | Role |
|---|---|
| `src/app/toolbar/Toolbar.tsx` | Main toolbar shell. Split into an always-flexible `.toolbarMain` region (File menu, Provider, tool cluster, Undo/Redo or lock badge, Panels group, ScaleScript pill, Simulate split-button) and a fixed-position theme toggle outside it, so the toggle is never subject to the narrow-width CSS breakpoints in `Toolbar.module.css`. Only `Provider`/`Undo`/`Redo` hide while `running` (replaced by a small lock badge) — `FileMenu` and Select/Hand/Connect stay visible and functional throughout, since Save/Export and Hand-tool panning are not actually locked during a run (verify against the file directly before assuming otherwise — this correction was found by re-checking the code, not by design intent). |
| `src/app/toolbar/FileMenu.tsx` (new) | Consolidates what were previously three separate components (`SaveButton`/`ExportMenu`/`ImportMenu`, plus the standalone New/Open buttons) into one dropdown with inline Export/Import sub-panels. Same underlying store calls as before, just one entry point. |
| `src/app/toolbar/Toolbar.module.css` | `.toolbarMain` carries `overflow-x: hidden` as a hard "never scrolls" guarantee; two `max-width` breakpoints (1000px hides `.undoRedoGroup`, 860px hides `.scriptPill`) shed low-priority content before that guarantee would otherwise clip anything. |

**Blast radius:** low. `FileMenu.tsx` has 1 caller (`Toolbar.tsx`). No store shape changes — this whole pass is presentation-only.
```

- [ ] **Step 3: Commit**

```bash
git add docs/module-boundaries.md
git commit -m "$(cat <<'EOF'
docs: document the toolbar declutter's new file/CSS structure

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
