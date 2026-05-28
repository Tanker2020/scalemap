import { create } from 'zustand'

export type ActiveTool = 'select' | 'hand' | 'connect'
export type RightTab = 'properties' | 'analytics'

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
  reportsPanelOpen: boolean

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
  setReportsPanelOpen: (open: boolean) => void
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
  reportsPanelOpen: false,

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
  setReportsPanelOpen: (open) => set({ reportsPanelOpen: open }),
}))
