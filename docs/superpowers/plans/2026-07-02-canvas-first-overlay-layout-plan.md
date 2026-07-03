# Canvas-First Overlay Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canvas always fill the full window by converting `NodePalette`, `PropertiesPanel`/`SimConfigPanel`, and `UtilityDock` from permanent flex-row columns into `position: fixed` overlays that float on top of the canvas instead of shrinking it.

**Architecture:** `App.tsx`'s `.body` flex row currently has 4 siblings (`NodePalette | canvasColumn | Properties-or-Inspector | UtilityDock`) each reserving width. Converting a flex item to `position: fixed` removes it from flow immediately, so each panel can be converted independently and the canvas widens as each one lands — no big-bang cutover needed. Each panel becomes responsible for its own show/hide + enter/exit animation (reading the same `ui.store`/`simulation.store` state it already reads), so `App.tsx` ends up simpler, not more complex.

**Tech Stack:** React 19, `@xyflow/react`, Zustand (`ui.store.ts`, `simulation.store.ts`), `framer-motion` (`AnimatePresence`/`motion`/`useReducedMotion`), CSS Modules.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md` — read this if anything below is ambiguous, but every task below already contains the exact code/values needed.
- No change to `particleEngine.ts`, lint rules, cost model, packet registry data model, or any simulation/business logic.
- No change to `PacketEditor.tsx` (already a correct `position: fixed; inset: 0` modal), `MetricsDrawer.tsx`, or `StatusBar.tsx`.
- All animations must respect `prefers-reduced-motion` (project convention — see `PacketEditor.tsx`'s `useReducedMotion()` usage) — every new/changed `motion.*` element in this plan branches on `reduceMotion` the same way: drop `scale`/`x`/`y` and zero out the duration.
- Confirmed layout constants: `Toolbar` is `42px` tall (`Toolbar.module.css` `.toolbar { height: 42px }`), `StatusBar` is `28px` tall (`StatusBar.module.css` `.bar { height: 28px }`). Every fixed-position panel in this plan anchors around those two numbers so it never sits under the toolbar or the status bar.
- New z-index for all three overlays: `500` (above the canvas's own internal z-indices — ReactFlow pane/particle canvas sit at `z-index: 20` — but below `Toolbar`'s dropdown menus at `1000`/`2000` and `PacketEditor`'s `9996`).
- Run `npx tsc --noEmit -p .` after every task. This repo has no test files covering these components (confirmed: no `*.test.ts(x)` references `NodePalette`, `PropertiesPanel`, `SimConfigPanel`, or `UtilityDock`), so a clean type-check plus the manual/Playwright pass in Task 4 is the verification bar — do not add new test files as part of this plan (out of scope, would need its own testing-strategy discussion).

---

### Task 1: NodePalette → icon rail + hover-peek/click-pin flyout

**Files:**
- Modify: `src/app/sidebar/NodePalette.tsx` (full rewrite)
- Modify: `src/app/sidebar/NodePalette.module.css` (full rewrite)

**Interfaces:**
- Consumes: `useSimulationStore(s => s.running)` (existing, `src/app/store/simulation.store.ts`), `useUiStore(s => s.themeMode)` (existing), `NODE_CONFIG`/`PALETTE_CATEGORIES`/`NodeType` (existing, `src/lib/nodeConfig.ts`), `CATEGORY_COLORS` (existing, `src/lib/theme.ts`).
- Produces: no new exports — `NodePalette` keeps the same usage (`<NodePalette />`, no props), so `App.tsx` needs no changes for this task.

This task is fully self-contained: converting `NodePalette` to `position: fixed` removes it from `App.tsx`'s `.body` flex row immediately, so the canvas already widens after this task alone, before touching any other file.

- [ ] **Step 1: Replace `src/app/sidebar/NodePalette.tsx` entirely**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { NODE_CONFIG, PALETTE_CATEGORIES, type NodeType } from '../../lib/nodeConfig'
import { CATEGORY_COLORS } from '../../lib/theme'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import styles from './NodePalette.module.css'

// Grace period between the pointer leaving the rail/flyout and the flyout actually closing —
// long enough to cross the small gap between the two without a flicker, short enough that it
// doesn't feel sticky once the user has genuinely moved on.
const CLOSE_DELAY_MS = 150

export function NodePalette() {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const themeMode = useUiStore(s => s.themeMode)
  const running = useSimulationStore(s => s.running)
  const reduceMotion = useReducedMotion()
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // You can't add nodes mid-run (editing is already locked elsewhere), so the flyout has
  // nothing useful to do while running — force it closed; the rail's data-disabled styling
  // communicates that hovering/clicking won't do anything right now.
  useEffect(() => {
    if (running) { setPinned(false); setHoverOpen(false) }
  }, [running])

  const open = !running && (pinned || hoverOpen)

  const filtered = useMemo(() => {
    if (!search.trim()) return PALETTE_CATEGORIES
    const q = search.toLowerCase()
    return PALETTE_CATEGORIES.map(cat => ({
      ...cat,
      types: cat.types.filter(t => NODE_CONFIG[t].label.toLowerCase().includes(q)),
    })).filter(cat => cat.types.length > 0)
  }, [search])

  const clearCloseTimer = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const scheduleClose = () => {
    clearCloseTimer()
    closeTimer.current = setTimeout(() => setHoverOpen(false), CLOSE_DELAY_MS)
  }
  const handleRailEnter = (category?: string) => {
    if (running) return
    clearCloseTimer()
    setHoverOpen(true)
    if (category) {
      // Wait a frame so the flyout has actually mounted before scrolling inside it.
      requestAnimationFrame(() => categoryRefs.current[category]?.scrollIntoView({ block: 'start' }))
    }
  }
  const handleRailClick = (category: string) => {
    if (running) return
    setPinned(p => !p)
    handleRailEnter(category)
  }

  const handleDragStart = (e: React.DragEvent, nodeType: NodeType) => {
    e.dataTransfer.setData('nodeType', nodeType)
    e.dataTransfer.effectAllowed = 'copy'
  }
  // Mirrors a typical picker: once a node has actually been dragged out, the flyout has done
  // its job. onDragEnd fires whether or not the drop landed somewhere valid — an acceptable
  // simplification (closes on both a successful and a cancelled drag).
  const handleDragEnd = () => { setPinned(false); setHoverOpen(false) }

  return (
    <div className={styles.wrap} onMouseLeave={scheduleClose}>
      <div className={styles.rail} data-disabled={running}>
        {PALETTE_CATEGORIES.map(cat => {
          const colors = CATEGORY_COLORS[cat.category]
          const accentColor = themeMode === 'light' ? colors.foreground.light : colors.accent
          const Icon = NODE_CONFIG[cat.types[0]].icon
          return (
            <button
              key={cat.category}
              type="button"
              className={styles.railIcon}
              style={{ '--rail-accent': accentColor } as React.CSSProperties}
              onMouseEnter={() => handleRailEnter(cat.category)}
              onClick={() => handleRailClick(cat.category)}
              title={cat.label}
            >
              <Icon size={15} strokeWidth={1.5} />
            </button>
          )
        })}
      </div>

      <AnimatePresence>
        {open && (
          <motion.aside
            className={styles.flyout}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: 'easeOut' }}
          >
            <div className={styles.header}>
              <LayoutGrid size={12} />
              Node Palette
            </div>

            <div className={styles.searchWrap}>
              <input
                className={styles.searchInput}
                placeholder="Search nodes..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <div className={styles.scroll}>
              {filtered.map(cat => (
                <div key={cat.category} ref={el => { categoryRefs.current[cat.category] = el }}>
                  <div className={styles.categoryLabel}>{cat.label}</div>
                  {cat.types.map(nodeType => {
                    const config = NODE_CONFIG[nodeType]
                    const colors = CATEGORY_COLORS[config.category]
                    const accentColor = themeMode === 'light' ? colors.foreground.light : colors.accent
                    const chipBg     = themeMode === 'light' ? `color-mix(in srgb, ${accentColor} 12%, var(--color-node-base))` : colors.bg
                    const chipBorder = themeMode === 'light' ? `color-mix(in srgb, ${accentColor} 35%, transparent)` : colors.border
                    const Icon = config.icon
                    return (
                      <div
                        key={nodeType}
                        className={styles.item}
                        draggable
                        onDragStart={e => handleDragStart(e, nodeType)}
                        onDragEnd={handleDragEnd}
                        title={`Drag to add ${config.label}`}
                      >
                        <div
                          className={styles.itemIcon}
                          style={{ background: chipBg, border: `1px solid ${chipBorder}`, color: accentColor }}
                        >
                          <Icon size={12} strokeWidth={1.5} />
                        </div>
                        <span className={styles.itemLabel}>{config.label}</span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}
```

- [ ] **Step 2: Replace `src/app/sidebar/NodePalette.module.css` entirely**

```css
/* Fixed-position rail + flyout, anchored to the left edge under the Toolbar (42px) and above
   the StatusBar (28px) — 2026-07-02 canvas-first-overlay pass, see
   docs/superpowers/plans/2026-07-02-canvas-first-overlay-layout-plan.md.
   .wrap itself takes no pointer events so the empty space to the right of a closed flyout lets
   clicks/drags reach the canvas underneath; .rail and .flyout opt back into pointer-events. */
.wrap {
  position: fixed;
  top: 42px;
  left: 0;
  bottom: 28px;
  width: 240px;
  z-index: 500;
  display: flex;
  pointer-events: none;
}

.rail {
  position: relative;
  width: 44px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 0;
  background: var(--color-surface);
  border-right: 1px solid var(--color-toolbar-border);
  pointer-events: auto;
}

.rail[data-disabled='true'] {
  opacity: 0.45;
  pointer-events: none;
}

.railIcon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--rail-accent, var(--color-text-muted));
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}

.railIcon:hover {
  background: var(--color-surface-hover);
  border-color: var(--color-node-border);
}

.flyout {
  width: 196px;
  flex-shrink: 0;
  background: var(--color-surface);
  border-right: 1px solid var(--color-toolbar-border);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  pointer-events: auto;
}

.header {
  padding: 9px 13px;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-toolbar-border);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.searchWrap {
  padding: 8px 10px;
  flex-shrink: 0;
}

.searchInput {
  width: 100%;
  background: var(--color-node-base);
  border: 1px solid var(--color-node-border);
  border-radius: 5px;
  padding: 5px 9px;
  font-size: 11px;
  color: var(--color-text-secondary);
  transition: border-color 0.15s;
}

.searchInput::placeholder {
  color: var(--color-text-muted);
}

.searchInput:focus {
  border-color: color-mix(in srgb, var(--color-accent) 33%, transparent);
  color: var(--color-text-primary);
  outline: none;
}

.scroll {
  overflow-y: auto;
  flex: 1;
  padding-bottom: 12px;
}

.scroll::-webkit-scrollbar { width: 4px; }
.scroll::-webkit-scrollbar-track { background: transparent; }
.scroll::-webkit-scrollbar-thumb { background: var(--color-node-border); border-radius: 2px; }

.categoryLabel {
  font-size: 9px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  padding: 8px 13px 3px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.categoryLabel::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--color-toolbar-border);
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 4px;
  margin: 1px 5px;
  cursor: grab;
  transition: background 0.1s;
}

.item:hover {
  background: var(--color-surface-hover);
}

.item:active {
  cursor: grabbing;
}

.itemIcon {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.itemLabel {
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [ ] **Step 3: Type-check and manually verify**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

Manually verify with the dev server running (`npm run dev`, or reuse an already-running instance on port 1420): the canvas should now extend under where the palette used to reserve space; hovering a rail icon peeks the flyout; clicking pins it open; dragging a node out still adds it to the canvas and closes the flyout; starting a simulation collapses/disables the rail (hover/click do nothing while `running`).

- [ ] **Step 4: Commit**

```bash
git add src/app/sidebar/NodePalette.tsx src/app/sidebar/NodePalette.module.css
git commit -m "refactor: NodePalette becomes a fixed icon rail + flyout, not a permanent column"
```

---

### Task 2: PropertiesPanel + SimConfigPanel → floating top-right card

**Files:**
- Modify: `src/app/sidebar/PropertiesPanel.tsx` (only the `PropertiesPanel` function, lines 687-882 — `TabBar`, `AnalyticsPane`, `NodePanel`, and every other helper above line 687 are untouched)
- Modify: `src/app/sidebar/PropertiesPanel.module.css` (only the `.sidebar` and `.empty` rules)
- Modify: `src/app/simulation/SimConfigPanel.tsx` (only the `SimConfigPanel` function, lines 1045-1178)
- Modify: `src/app/simulation/SimConfigPanel.module.css` (only the `.tray` rule)
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useUiStore(s => s.simConfigOpen)` (existing), `useUiStore(s => s.rightTab)` (existing — drives Properties/Analytics sub-tabs and is already auto-set to `'analytics'` when a run starts, at `PropertiesPanel.tsx:693-695`).
- Produces: `PropertiesPanel` and `SimConfigPanel` each self-gate — `App.tsx` no longer needs to compute which one to show or wrap either in `AnimatePresence`/`motion`.

**Important discovery from reading the current code:** `PropertiesPanel` doesn't only show when a node/edge is selected — when `rightTab === 'analytics'` it shows system-wide stats (Total Traffic/Bottlenecks/SLO) even with nothing selected, and starting a simulation auto-switches `rightTab` to `'analytics'` specifically so that view stays visible through a run with no selection. The floating card's mount condition (`shouldShow` below) must preserve this, or system Analytics becomes unreachable without first selecting a node — a real regression the brainstorming conversation didn't surface, caught by reading the actual component.

- [ ] **Step 1: `PropertiesPanel.tsx` — add `useReducedMotion` import**

```
old_string:
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

new_string:
import { useState, useEffect } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
```

- [ ] **Step 2: `PropertiesPanel.tsx` — replace the function's opening through the `selectedNode` branch**

This is currently lines 687-725 of the file — the function signature, hooks, and the first three of its four `if (...) { return (...) }` branches (`rightTab === 'analytics'`, the "nothing selected" empty state, and `selectedNode`). The "nothing selected" branch is dropped entirely (that's now what `shouldShow === false` means — no render at all, not a placeholder card) and the other two are changed from early `return`s into assignments to `content`/`contentKey`, which the final unified return (Step 4) reads.

```
old_string:
export function PropertiesPanel() {
  const { selectedNodeId, selectedEdgeId, rightTab, setRightTab } = useUiStore()
  const { nodes, edges, updateEdgeData, changeEdgeType } = useCanvasStore()
  const { setEdgeRps, getEdgeRps, running } = useSimulationStore()

  // Auto-switch to Analytics when simulation starts
  useEffect(() => {
    if (running) setRightTab('analytics')
  }, [running, setRightTab])

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)

  if (rightTab === 'analytics') {
    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <AnalyticsPane />
      </aside>
    )
  }

  if (!selectedNode && !selectedEdge) {
    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <div className={styles.empty}>Select a node or edge to view its properties</div>
      </aside>
    )
  }

  if (selectedNode) {
    return (
      <aside className={styles.sidebar}>
        <TabBar />
        <NodePanel nodeId={selectedNode.id} />
      </aside>
    )
  }

new_string:
export function PropertiesPanel() {
  const { selectedNodeId, selectedEdgeId, rightTab, setRightTab, simConfigOpen } = useUiStore()
  const { nodes, edges, updateEdgeData, changeEdgeType } = useCanvasStore()
  const { setEdgeRps, getEdgeRps, running } = useSimulationStore()
  const reduceMotion = useReducedMotion()

  // Auto-switch to Analytics when simulation starts
  useEffect(() => {
    if (running) setRightTab('analytics')
  }, [running, setRightTab])

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)
  // SimConfigPanel (the Inspector) takes over this same floating corner while it's open — see
  // Step 5 below. rightTab === 'analytics' counts as "something to show" on its own: a running
  // simulation auto-switches to it above, so system-wide stats stay visible through a run even
  // with nothing selected — this must keep working now that the panel can fully unmount.
  const shouldShow = !simConfigOpen && (!!selectedNode || !!selectedEdge || rightTab === 'analytics')

  let contentKey: 'analytics' | 'node' | 'edge' = 'analytics'
  let content: React.ReactNode = null

  if (shouldShow && rightTab === 'analytics') {
    contentKey = 'analytics'
    content = (
      <>
        <TabBar />
        <AnalyticsPane />
      </>
    )
  } else if (shouldShow && selectedNode) {
    contentKey = 'node'
    content = (
      <>
        <TabBar />
        <NodePanel nodeId={selectedNode.id} />
      </>
    )
  }
```

- [ ] **Step 3: `PropertiesPanel.tsx` — change the edge branch's opening wrapper**

The edge branch (`if (selectedEdge) { ... }`) keeps every line of its body — only its `return (<aside className={styles.sidebar}>...` opening changes to an assignment. Find this exact text (a few lines after the `hasPartialRegion` computation):

```
old_string:
    const hasPartialRegion = (!!srcRegion) !== (!!tgtRegion)

    return (
      <aside className={styles.sidebar}>
        <TabBar />

new_string:
    const hasPartialRegion = (!!srcRegion) !== (!!tgtRegion)

    contentKey = 'edge'
    content = (
      <>
        <TabBar />
```

- [ ] **Step 4: `PropertiesPanel.tsx` — replace the edge branch's closing and the function's tail**

```
old_string:
        </motion.div>
        </AnimatePresence>
      </aside>
    )
  }

  return null
}

new_string:
        </motion.div>
        </AnimatePresence>
      </>
    )
  }

  return (
    <AnimatePresence>
      {shouldShow && (
        <motion.aside
          key={contentKey}
          className={styles.sidebar}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
          {content}
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
```

- [ ] **Step 5: `PropertiesPanel.module.css` — convert `.sidebar` to a floating card and drop `.empty`**

```
old_string:
.sidebar {
  width: 260px;
  min-width: 260px;
  background: var(--color-surface);
  border-left: 1px solid var(--color-toolbar-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

new_string:
/* position: fixed, top-right — 2026-07-02 canvas-first-overlay pass. Mounts only while
   PropertiesPanel.tsx's shouldShow is true, so this card only occupies screen space while
   there's something to show (a selection, or the Analytics tab). */
.sidebar {
  position: fixed;
  top: 58px;
  right: 16px;
  width: 260px;
  min-width: 260px;
  max-height: calc(100vh - 42px - 28px - 32px);
  z-index: 500;
  background: var(--color-surface);
  border: 1px solid var(--color-toolbar-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

Then delete the now-unused `.empty` rule entirely (its only usage was the "nothing selected" branch removed in Step 2):

```
old_string:
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-node-border);
  font-size: 11px;
}

new_string:
(delete — no replacement)
```

- [ ] **Step 6: `SimConfigPanel.tsx` — add `useReducedMotion`, self-gate on `simConfigOpen`**

```
old_string:
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

new_string:
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
```

```
old_string:
export function SimConfigPanel() {
  const { setSimConfigOpen, simConfigPanelNodeId, setSimConfigPanelNode } = useUiStore()
  const { nodes } = useCanvasStore()
  const running   = useSimulationStore(s => s.running)
  const events    = useSimulationStore(s => s.events)
  const [search, setSearch] = useState('')
  const [eventLogOpen, setEventLogOpen] = useState(false)
  const lastSeenEventsRef = useRef(0)

new_string:
export function SimConfigPanel() {
  const { simConfigOpen, setSimConfigOpen, simConfigPanelNodeId, setSimConfigPanelNode } = useUiStore()
  const { nodes } = useCanvasStore()
  const running   = useSimulationStore(s => s.running)
  const events    = useSimulationStore(s => s.events)
  const [search, setSearch] = useState('')
  const [eventLogOpen, setEventLogOpen] = useState(false)
  const lastSeenEventsRef = useRef(0)
  const reduceMotion = useReducedMotion()
```

```
old_string:
  return (
    <aside className={styles.tray}>
      {/* Header */}
      <div className={styles.trayHeader}>

new_string:
  return (
    <AnimatePresence>
      {simConfigOpen && (
        <motion.aside
          className={styles.tray}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
      {/* Header */}
      <div className={styles.trayHeader}>
```

The file's final four lines (its only closing `</aside>`, matching the return opened above):

```
old_string:
        </div>
      </div>
    </aside>
  )
}

new_string:
        </div>
      </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
```

- [ ] **Step 7: `SimConfigPanel.module.css` — convert `.tray` to the same floating anchor**

```
old_string:
.tray {
  width: 480px;
  min-width: 480px;
  background: var(--color-surface);
  border-left: 1px solid var(--color-node-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

new_string:
/* position: fixed, top-right — 2026-07-02 canvas-first-overlay pass. Same anchor point as
   PropertiesPanel.module.css's .sidebar; safe to share because the two are mutually exclusive
   (SimConfigPanel shows only while simConfigOpen, PropertiesPanel only while !simConfigOpen —
   see both components' self-gating) and never render at the same time. */
.tray {
  position: fixed;
  top: 58px;
  right: 16px;
  width: 480px;
  min-width: 480px;
  max-height: calc(100vh - 42px - 28px - 32px);
  z-index: 500;
  background: var(--color-surface);
  border: 1px solid var(--color-node-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

- [ ] **Step 8: `App.tsx` — remove the `simConfigOpen`-based ternary, mount both panels unconditionally**

```
old_string:
  const simConfigOpen = useUiStore(s => s.simConfigOpen)
  const dockOpen = useUiStore(s => s.dockOpen)

new_string:
  const dockOpen = useUiStore(s => s.dockOpen)
```

```
old_string:
            <AnimatePresence mode="wait">
              {simConfigOpen ? (
                <motion.div
                  key="inspector"
                  style={{ display: 'flex' }}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <SimConfigPanel />
                </motion.div>
              ) : (
                <motion.div
                  key="properties"
                  style={{ display: 'flex' }}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  transition={{ duration: 0.15 }}
                >
                  <PropertiesPanel />
                </motion.div>
              )}
            </AnimatePresence>

new_string:
            <SimConfigPanel />
            <PropertiesPanel />
```

Leave the `motion`/`AnimatePresence` import line in `App.tsx` untouched for now — the Dock block later in the same file still uses `motion.div`/`AnimatePresence` until Task 3.

- [ ] **Step 9: Type-check and manually verify**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

Manually verify: with no node selected and not running, neither Properties nor the Inspector should render anything. Selecting a node shows the Properties card top-right; opening the Inspector (however `simConfigOpen` is triggered elsewhere in the app — e.g. a node's "Configure simulation" link) shows the Inspector card in the same spot and hides Properties. Starting a simulation with nothing selected should still show the Properties card on the Analytics tab (system-wide stats) — this is the behavior called out above; if it doesn't show, `shouldShow`'s `rightTab === 'analytics'` clause is the first thing to check.

- [ ] **Step 10: Commit**

```bash
git add src/app/sidebar/PropertiesPanel.tsx src/app/sidebar/PropertiesPanel.module.css src/app/simulation/SimConfigPanel.tsx src/app/simulation/SimConfigPanel.module.css src/App.tsx
git commit -m "refactor: PropertiesPanel/SimConfigPanel become a self-gating floating top-right card"
```

---

### Task 3: UtilityDock → bottom-right drawer

**Files:**
- Modify: `src/app/dock/UtilityDock.tsx`
- Modify: `src/app/dock/UtilityDock.module.css` (only the `.dock` rule)
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useUiStore(s => s.dockOpen)` (existing).
- Produces: `UtilityDock` self-gates — `App.tsx` no longer needs to read `dockOpen` or wrap it in `AnimatePresence`/`motion`.

- [ ] **Step 1: `UtilityDock.tsx` — update imports, doc comment, and hooks**

```
old_string:
import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, ShieldCheck, ClipboardList } from 'lucide-react'
import { useUiStore, type DockTab } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCanvasStore } from '../store/canvas.store'
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel'
import { ReportsPanel } from '../reports/ReportsPanel'
import styles from './UtilityDock.module.css'

/**
 * Unified right-edge dock for Diagnostics + Reports.
 *
 * Previously these were two independent `position: fixed; right: 0` overlays
 * (DiagnosticsPanel, ReportsPanel), each toggled by its own Toolbar button with no
 * coordination — a user could open both and have them render stacked on top of each other
 * at the exact same screen position. This shell owns the single right-edge slot and a tab
 * strip; only one tab's content is ever mounted-visible at a time, so the two panels can no
 * longer collide. Each panel's own internal logic (filters, run detail overlay, etc.) is
 * untouched — only their outer chrome (position/header/close button) moved up into this file.
 *
 * Rendered as a plain flex child of App.tsx's .body row (same convention as SimConfigPanel/
 * PropertiesPanel — see UtilityDock.module.css) so it reserves its own width in the layout
 * instead of floating on top of the Properties/Inspector column. App.tsx owns the mount/
 * unmount enter-exit motion, matching how it already wraps SimConfigPanel/PropertiesPanel.
 */
// Mounted by App.tsx only while useUiStore.dockOpen is true (mirrors the PacketEditor
// mount pattern) so AnimatePresence sees a real mount/unmount transition.
export function UtilityDock() {
  const dockTab = useUiStore(s => s.dockTab)
  const setDockOpen = useUiStore(s => s.setDockOpen)
  const openDockTab = useUiStore(s => s.openDockTab)

  const nodes = useCanvasStore(s => s.nodes)
  const diagnostics = useDiagnosticsStore(s => s.diagnostics)
  const runs = useSimulationStore(s => s.runs)

new_string:
import { useEffect } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X, ShieldCheck, ClipboardList } from 'lucide-react'
import { useUiStore, type DockTab } from '../store/ui.store'
import { useDiagnosticsStore } from '../store/diagnostics.store'
import { useSimulationStore } from '../store/simulation.store'
import { useCanvasStore } from '../store/canvas.store'
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel'
import { ReportsPanel } from '../reports/ReportsPanel'
import styles from './UtilityDock.module.css'

/**
 * Unified bottom-right drawer for Diagnostics + Reports.
 *
 * Previously these were two independent `position: fixed; right: 0` overlays
 * (DiagnosticsPanel, ReportsPanel), each toggled by its own Toolbar button with no
 * coordination — a user could open both and have them render stacked on top of each other
 * at the exact same screen position. This shell owns the single dock slot and a tab strip;
 * only one tab's content is ever mounted-visible at a time, so the two panels can no longer
 * collide. Each panel's own internal logic (filters, run detail overlay, etc.) is untouched —
 * only their outer chrome (position/header/close button) moved up into this file.
 *
 * `position: fixed`, self-gated on `dockOpen` (2026-07-02 canvas-first-overlay pass — see
 * docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md). This supersedes the
 * earlier "must be a flex child, not fixed" rule recorded in docs/module-boundaries.md: that
 * rule was about two *uncoordinated* fixed panels sharing the same right-edge slot. This dock
 * now anchors bottom-right while PropertiesPanel/SimConfigPanel anchor top-right (different
 * corners), and caps its own max-height (UtilityDock.module.css) so it can never grow tall
 * enough to reach the other panel's corner — coordinated by construction, not by accident.
 */
export function UtilityDock() {
  const dockOpen = useUiStore(s => s.dockOpen)
  const dockTab = useUiStore(s => s.dockTab)
  const setDockOpen = useUiStore(s => s.setDockOpen)
  const openDockTab = useUiStore(s => s.openDockTab)
  const reduceMotion = useReducedMotion()

  const nodes = useCanvasStore(s => s.nodes)
  const diagnostics = useDiagnosticsStore(s => s.diagnostics)
  const runs = useSimulationStore(s => s.runs)
```

- [ ] **Step 2: `UtilityDock.tsx` — wrap the return in self-gating `AnimatePresence`**

```
old_string:
  return (
    <aside className={styles.dock}>
      <div className={styles.header}>

new_string:
  return (
    <AnimatePresence>
      {dockOpen && (
        <motion.aside
          className={styles.dock}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: reduceMotion ? 0 : 0.15 }}
        >
      <div className={styles.header}>
```

```
old_string:
      </div>
    </aside>
  )
}

new_string:
      </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
```

- [ ] **Step 3: `UtilityDock.module.css` — convert `.dock` to a bottom-right drawer**

```
old_string:
/* A normal flex child of App.tsx's .body row (same pattern as PropertiesPanel's .sidebar),
   not position: fixed. Earlier this dock — like the two independent panels it replaced — was
   fixed to the right edge, which meant it silently rendered on top of the Properties/Inspector
   column instead of sharing the row with it (Properties panel is itself a flex child, so
   "open Dock while a node is selected" hid Properties completely behind the dock). Making the
   dock a flex sibling lets the row layout reserve space for both, so they sit side by side. */
.dock {
  width: 340px;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border-left: 1px solid var(--color-node-border);
  overflow: hidden;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}

new_string:
/* position: fixed, bottom-right — 2026-07-02 canvas-first-overlay pass. Anchored above the
   StatusBar (28px tall) with a margin; max-height is capped so this drawer can never grow tall
   enough to reach PropertiesPanel/SimConfigPanel's top-right corner (see UtilityDock.tsx's doc
   comment for why two coordinated fixed panels here don't reintroduce the old stacking bug). */
.dock {
  position: fixed;
  right: 16px;
  bottom: 44px;
  width: 340px;
  min-width: 340px;
  max-height: min(480px, calc(100vh - 42px - 28px - 32px));
  z-index: 500;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-node-border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
}
```

- [ ] **Step 4: `App.tsx` — mount `UtilityDock` unconditionally, drop now-unused state/imports**

```
old_string:
  const dockOpen = useUiStore(s => s.dockOpen)

new_string:
(delete — no replacement; UtilityDock now reads dockOpen itself)
```

```
old_string:
            {/* UtilityDock is a normal flex child here (not position: fixed) so it reserves
                its own space in the row and shifts Properties/Inspector left instead of
                floating on top of them — see UtilityDock.module.css for the rationale. */}
            <AnimatePresence>
              {dockOpen && (
                <motion.div
                  key="dock"
                  style={{ display: 'flex' }}
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <UtilityDock />
                </motion.div>
              )}
            </AnimatePresence>

new_string:
            <UtilityDock />
```

After this edit, `motion` is no longer used anywhere in `App.tsx` (only `AnimatePresence` still is, for the `PacketEditor` mount at the bottom of the file) — update the import:

```
old_string:
import { AnimatePresence, motion } from 'framer-motion'

new_string:
import { AnimatePresence } from 'framer-motion'
```

- [ ] **Step 5: Type-check and manually verify**

Run: `npx tsc --noEmit -p .`
Expected: no errors (in particular, no "declared but never used" for `motion`/`dockOpen` in `App.tsx`).

Manually verify: opening the Dock (Toolbar's Dock button) now slides a card up from the bottom-right instead of pushing the canvas; switching Diagnostics/Reports tabs works as before; closing via the X button or Escape works as before. With a node selected (Properties card showing top-right) and the Dock also open (bottom-right), confirm the two don't overlap at a typical laptop window size.

- [ ] **Step 6: Commit**

```bash
git add src/app/dock/UtilityDock.tsx src/app/dock/UtilityDock.module.css src/App.tsx
git commit -m "refactor: UtilityDock becomes a fixed bottom-right drawer, not a permanent column"
```

---

### Task 4: Cleanup, docs, and full verification pass

**Files:**
- Modify (verify, may need no change): `src/App.module.css`
- Modify: `docs/module-boundaries.md`

**Interfaces:** none — this task is verification and documentation, no new code.

- [ ] **Step 1: Confirm `App.module.css` needs no change**

Read `src/App.module.css`. After Tasks 1-3, `NodePalette`, `PropertiesPanel`, `SimConfigPanel`, and `UtilityDock` are all `position: fixed` and no longer participate in `.body`'s flex layout, so `.canvasColumn` (the only remaining flex child, `flex: 1`) already fills 100% of `.body`'s width automatically — no CSS change should be needed here. Confirm by inspecting the rendered canvas width in the browser (see Step 3) rather than editing this file speculatively.

- [ ] **Step 2: Update `docs/module-boundaries.md` §H**

The current §H ("Utility dock (Diagnostics + Reports) — 2026-07-02") documents the dock as a flex child and explicitly warns future readers off `position: fixed`. That warning is now wrong — replace it.

```
old_string:
| `src/app/dock/UtilityDock.tsx` | Owns the single right-edge shell (header, `Diagnostics \| Reports` tab strip, close button, Escape-to-close) and mounts whichever of `DiagnosticsPanel`/`ReportsPanel` is active. Rendered as a **plain flex child** of `App.tsx`'s `.body` row (same convention as `SimConfigPanel`/`PropertiesPanel`), not `position: fixed` — see the note below on why that distinction matters. |
| `src/app/dock/UtilityDock.module.css` | Tab strip + shell styling; `.dock` is `width: 340px` flex child, no `position`/`z-index` |
| `src/app/diagnostics/DiagnosticsPanel.tsx`, `src/app/reports/ReportsPanel.tsx` | Content-only now — filters/issue cards and run list/`RunDetailOverlay` respectively (see §C above for `DiagnosticsPanel`'s linter-side role). Each dropped its own `position: fixed; right: 0` wrapper, header, and close button (previously duplicated between the two, which is how they ended up stacking on top of each other at the same screen position — the bug this fix addresses) |
| `src/app/store/ui.store.ts` | `dockOpen` + `dockTab: 'diagnostics' \| 'reports'` replace the old independent `reportsPanelOpen`/`diagnosticsOpen` booleans. `openDockTab(tab)` opens the dock on a specific tab (switches tab even if already open) — this is what `Toolbar.tsx`'s single "Dock" button and `MetricsDrawer.tsx`'s "last run" pill both call now instead of toggling two separate flags |

**Why flex child, not `position: fixed`:** the first implementation pass made `UtilityDock` `position: fixed; right: 0`, same as the two panels it replaced. That reintroduced the exact same class of bug one layer up — opening the Dock while a node was selected rendered it on top of the Properties panel (a normal flex child), hiding it completely. Fixed by making the Dock itself a flex sibling of Properties/Inspector in `App.tsx`'s `.body` row, so the row layout reserves space for both and they sit side by side (canvas shrinks to accommodate). **If you add another right-edge panel, make it a flex child of `.body`, not `position: fixed`** — fixed-position panels in this row is the recurring source of the stacking bug.

new_string:
| `src/app/dock/UtilityDock.tsx` | Owns the single dock shell (header, `Diagnostics \| Reports` tab strip, close button, Escape-to-close) and mounts whichever of `DiagnosticsPanel`/`ReportsPanel` is active. **Superseded 2026-07-02** (canvas-first-overlay pass, `docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md`): now `position: fixed`, anchored bottom-right, self-gated on `useUiStore(s => s.dockOpen)` — no longer a flex child of `App.tsx`'s `.body` row. |
| `src/app/dock/UtilityDock.module.css` | Tab strip + shell styling; `.dock` is `position: fixed; right: 16px; bottom: 44px`, `width: 340px`, `max-height` capped to stay clear of `PropertiesPanel`/`SimConfigPanel`'s top-right corner, `z-index: 500` |
| `src/app/diagnostics/DiagnosticsPanel.tsx`, `src/app/reports/ReportsPanel.tsx` | Content-only now — filters/issue cards and run list/`RunDetailOverlay` respectively (see §C above for `DiagnosticsPanel`'s linter-side role). Each dropped its own `position: fixed; right: 0` wrapper, header, and close button (previously duplicated between the two, which is how they ended up stacking on top of each other at the same screen position — the bug the 2026-07-02 panel-clutter-ia fix addressed). Unaffected by the later canvas-first-overlay pass, which only changed `UtilityDock`'s own outer chrome. |
| `src/app/store/ui.store.ts` | `dockOpen` + `dockTab: 'diagnostics' \| 'reports'` replace the old independent `reportsPanelOpen`/`diagnosticsOpen` booleans. `openDockTab(tab)` opens the dock on a specific tab (switches tab even if already open) — this is what `Toolbar.tsx`'s single "Dock" button and `MetricsDrawer.tsx`'s "last run" pill both call now instead of toggling two separate flags |

**Why `position: fixed` is correct here now (this reverses the guidance below from the panel-clutter-ia pass):** the original "flex child, not fixed" rule was about *two uncoordinated* fixed panels (the old independent `DiagnosticsPanel`/`ReportsPanel`) sharing the same right-edge slot with no way to know about each other. The 2026-07-02 canvas-first-overlay pass reintroduces `position: fixed` for the whole panel set (`NodePalette`, `PropertiesPanel`/`SimConfigPanel`, `UtilityDock`) deliberately, to stop them from permanently shrinking the canvas — but this time each panel anchors to a *different* corner/edge (Palette: left edge; Properties/Inspector: top-right; Dock: bottom-right) and the Dock's `max-height` is capped so it can never grow into the top-right corner. Coordinated by construction, not by accident. **If you add another floating panel, give it its own corner/edge and either cap its size or explicitly coordinate with whichever panel might share a corner — don't assume "flex child" is the safe default going forward.**
```

Also update the summary line above §H's table (the intro paragraph) to note the second pass:

```
old_string:
Panel-clutter fix: unifies two formerly-independent right-edge overlays into one dock with
tabs. Full rationale (including rejected alternatives — left-side dock, command palette) in
`docs/superpowers/specs/2026-07-02-panel-clutter-ia-design.md`.

new_string:
Panel-clutter fix: unifies two formerly-independent right-edge overlays into one dock with
tabs. Full rationale (including rejected alternatives — left-side dock, command palette) in
`docs/superpowers/specs/2026-07-02-panel-clutter-ia-design.md`. A second, later pass
(2026-07-02 canvas-first-overlay, `docs/superpowers/specs/2026-07-02-canvas-first-overlay-layout-design.md`)
changed this dock's own positioning again — from a flex column to a fixed bottom-right drawer —
alongside the same change to `NodePalette` and `PropertiesPanel`/`SimConfigPanel`, so the canvas
is no longer permanently shrunk by any of them. See the superseded note in the table below.
```

- [ ] **Step 3: Full verification pass**

Run the full existing suite — this refactor shouldn't touch any file it currently covers, but confirms no accidental regression:

```bash
npx vitest run --exclude '**/.claude/**'
```
Expected: same pass count as before this plan started (90/90 as of the last full run this session).

Run the build:

```bash
npm run build
```
Expected: clean TypeScript + Vite build, no errors.

Then drive the running app (dev server on port 1420, or `npm run tauri dev`) at a simulated laptop viewport — **1280×800** — and confirm:

1. With nothing selected and no panels open, the canvas fills the entire window below the Toolbar and above the StatusBar (no reserved side columns).
2. `NodePalette`: hover a rail icon → flyout peeks; move away → closes after ~150ms; click → pins open; drag a node onto the canvas → it's added and the flyout closes; start a simulation → rail collapses/dims and ignores hover/click.
3. `PropertiesPanel`/`SimConfigPanel`: select a node → Properties card appears top-right; deselect → it disappears; open the Inspector → it replaces Properties in the same corner; start a simulation with nothing selected → the Properties card still appears, showing the Analytics tab (system-wide stats) — this is the behavior documented in Task 2.
4. `UtilityDock`: open via the Toolbar's Dock button → drawer slides up bottom-right; switch Diagnostics/Reports tabs; close via X or Escape.
5. With a node selected (Properties card open top-right) and the Dock also open (bottom-right) at 1280×800, confirm no visual overlap between the two.
6. `PacketEditor` still opens as a centered modal above everything else (unchanged, confirms z-index ordering: `PacketEditor` > `Toolbar` dropdowns > the three new fixed panels > canvas).

- [ ] **Step 4: Commit**

```bash
git add docs/module-boundaries.md
git commit -m "docs: update module-boundaries.md for the canvas-first-overlay layout pass"
```
