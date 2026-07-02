import { create } from 'zustand'

export type ActiveTool = 'select' | 'hand' | 'connect'
export type RightTab = 'properties' | 'analytics'
export type DockTab = 'diagnostics' | 'reports'

interface UiStore {
  activeTool: ActiveTool
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  rightTab: RightTab
  selectedNodeId: string | null
  selectedEdgeId: string | null
  gridEnabled: boolean
  connectSourceId: string | null
  contextMenu: { x: number; y: number; targetId: string; targetType: 'node' | 'edge' } | null
  simConfigOpen: boolean
  simConfigPanelNodeId: string | null
  /** Unified Diagnostics/Reports dock (see UtilityDock.tsx) — one overlay slot, two tabs,
   *  replacing the formerly-independent reportsPanelOpen/diagnosticsOpen flags that could
   *  both be true at once and stack on top of each other at the same right-edge position. */
  dockOpen: boolean
  dockTab: DockTab
  packetEditorOpen: boolean
  highlightedNodeIds: string[]   // transient "look here" pulse driven by the diagnostics panel
  themeMode: 'dark' | 'light'

  setActiveTool: (tool: ActiveTool) => void
  setSelectedNode: (id: string | null) => void
  setSelectedEdge: (id: string | null) => void
  toggleGrid: () => void
  setConnectSource: (id: string | null) => void
  setContextMenu: (menu: UiStore['contextMenu']) => void
  closeContextMenu: () => void
  setRightTab: (tab: RightTab) => void
  setSimConfigOpen: (open: boolean) => void
  setSimConfigPanelNode: (id: string | null) => void
  setDockOpen: (open: boolean) => void
  /** Opens the dock on a specific tab (switches tab even if already open). */
  openDockTab: (tab: DockTab) => void
  setPacketEditorOpen: (open: boolean) => void
  setHighlightedNodes: (ids: string[]) => void
  setThemeMode: (mode: 'dark' | 'light') => void
}

export const useUiStore = create<UiStore>((set) => ({
  activeTool: 'select',
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  rightTab: 'properties',
  selectedNodeId: null,
  selectedEdgeId: null,
  gridEnabled: true,
  connectSourceId: null,
  contextMenu: null,
  simConfigOpen: false,
  simConfigPanelNodeId: null,
  dockOpen: false,
  dockTab: 'diagnostics',
  packetEditorOpen: false,
  highlightedNodeIds: [],
  themeMode: (localStorage.getItem('scalemap-theme-mode') as 'dark' | 'light') ?? 'dark',

  setActiveTool: (tool) => set({ activeTool: tool, connectSourceId: null }),
  setSelectedNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  setSelectedEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),
  toggleGrid: () => set(s => ({ gridEnabled: !s.gridEnabled })),
  setConnectSource: (id) => set({ connectSourceId: id }),
  setContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  setRightTab: (tab) => set({ rightTab: tab }),
  setSimConfigOpen: (open) => set({ simConfigOpen: open }),
  setSimConfigPanelNode: (id) => set({ simConfigPanelNodeId: id }),
  setDockOpen: (open) => set({ dockOpen: open }),
  openDockTab: (tab) => set({ dockOpen: true, dockTab: tab }),
  setPacketEditorOpen: (open) => set({ packetEditorOpen: open }),
  setHighlightedNodes: (ids) => set({ highlightedNodeIds: ids }),
  setThemeMode: (mode) => {
    localStorage.setItem('scalemap-theme-mode', mode)
    set({ themeMode: mode })
  },
}))
