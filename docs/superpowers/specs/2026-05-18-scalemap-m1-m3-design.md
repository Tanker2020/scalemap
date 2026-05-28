# Scalemap M1–M3 Implementation Design

**Date:** 2026-05-18  
**Scope:** Milestones 1–3 (Canvas Foundation, Full Node Library, Simulation Mode)  
**Approach:** Vertical slice first — one end-to-end working build, then expand breadth  
**Dev mode:** Frontend-first with Tauri mock layer; Rust backend wired up separately

---

## 1. Project Setup

### Dependencies to install

```bash
npm install @xyflow/react zustand dagre framer-motion lucide-react
npm install -D @types/dagre
```

Add JetBrains Mono to `index.html` via Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Folder structure

```
src/
  app/
    store/
      canvas.store.ts       # nodes, edges, viewport, selection, undo/redo
      simulation.store.ts   # running, speed, queueLevels, concurrency, edgeRps
      ui.store.ts           # activeTool, sidebar visibility, active panel
      file.store.ts         # filename, dirty flag
    canvas/
      Canvas.tsx            # React Flow wrapper
      nodes/
        BaseNode.tsx        # shared base component, parameterized by NODE_CONFIG
        GroupNode.tsx       # grouping nodes (VPC, Subnet, AZ, Region, Namespace)
      edges/                # one file per edge type (4 total)
      simulation/
        SimulationOverlay.tsx   # positions the HTML5 canvas on top of React Flow
        particleEngine.ts       # rAF loop, particle state, spawn/update/draw
    sidebar/
      NodePalette.tsx
      PropertiesPanel.tsx
    toolbar/
      Toolbar.tsx
    home/
      HomeScreen.tsx
  lib/
    nodeConfig.ts           # NODE_ICON_MAP, category colors, node metadata
    tauri.ts                # shim: real invoke vs mock depending on __TAURI_INTERNALS__
    tauriMock.ts            # localStorage-backed save/load/recent-files
    layout/
      dagre.ts              # auto-layout helper (used in M4 Terraform import)
    export/
      serializer.ts         # .scalemap JSON serialization/deserialization
```

### Tauri mock shim

`src/lib/tauri.ts` checks `window.__TAURI_INTERNALS__` at runtime:
- Present → delegates to real `@tauri-apps/api/core` invoke
- Absent → delegates to `tauriMock.ts` (localStorage)

`tauriMock.ts` implements: `save_diagram`, `load_diagram`, `get_recent_files`, `open_file_dialog`, `save_file_dialog` — same signatures as the Rust commands. Zero changes needed when the real backend is wired up.

---

## 2. Vertical Slice

The first deliverable: a real canvas with one node type, one edge type, particle simulation, drag-to-place from palette, and save/load. Everything after this is additive.

### 2.1 App shell

Three-column layout matching the v2 mockup:

```
[ Node Palette 196px ] [ Canvas flex-1 ] [ Properties Panel 218px ]
```

Toolbar above canvas. Status bar below. All sizing in CSS variables for easy adjustment. Toolbar zones:
- Left: New / Open / Save (filled `#1E2430` background, `#3A4255` border, bold text)
- Center: Select / Hand / Connect (ghost buttons, active state `#152035` + blue border)
- Right: ▶ Simulate (green gradient, play triangle), speed buttons, zoom controls

Active tool stored in `ui.store.activeTool`.

### 2.2 Canvas

`Canvas.tsx` wraps `<ReactFlow>` with:
- `nodeTypes` and `edgeTypes` maps (custom components only — no React Flow defaults)
- `defaultEdgeOptions` set to the Request/Response style
- Background: `<Background variant="dots" color="#1A1D22" gap={24} />`
- Minimap: `<MiniMap />` custom styled, bottom-right
- Pan/zoom: trackpad pinch + scroll, range 10%–400%
- Grid snapping: 8px, toggle stored in `ui.store`
- Multi-select: drag rectangle selection

Canvas reads nodes/edges from `canvas.store` and dispatches mutations back to it on React Flow events (`onNodesChange`, `onEdgesChange`, `onConnect`).

### 2.3 EC2 node component

File: `src/app/canvas/nodes/EC2Node.tsx`

Structure:
```
┌─────────────────────────────┐
│  [icon]  Label        [●]   │  ← status dot
│          subtitle           │
└─────────────────────────────┘
```

- Icon: `lucide-react` `Server` icon, sourced via `NODE_CONFIG['ec2'].icon`
- Accent: blue `#4A9EFF`, background `#0D1F35`, border `#1A3A5C`
- Connection handles: all four sides, visible only on hover (`opacity: 0` → `1` on `.react-flow__node:hover`)
- Selected state: `border-color: #4A9EFF99`, outer glow `box-shadow: 0 0 0 2px #4A9EFF1A`
- Double-click label → inline `<input>` auto-focused, commits on Enter/blur, dispatches to `canvas.store`
- Framer Motion: enter with `scale: 0.8 → 1.0`, spring physics, 200ms

### 2.4 Request/Response edge

File: `src/app/canvas/edges/RequestResponseEdge.tsx`

- Solid line, `stroke: #4A9EFF55`, `strokeWidth: 1.5`
- Bidirectional arrows via SVG `<marker>` definitions
- Selected state: stroke brightens to `#4A9EFF`
- Click to select + show label editor in properties panel

### 2.5 Simulation overlay (partial)

Files: `SimulationOverlay.tsx` + `particleEngine.ts`

`SimulationOverlay` renders a `<canvas>` element absolutely positioned over the React Flow SVG, same dimensions, `pointer-events: none`. It reads edge path data from React Flow's internal store to know where to draw particles.

`particleEngine.ts` exports:
```typescript
startSimulation(edges, speed, canvasEl)  // begins rAF loop
stopSimulation()                          // cancels rAF
injectBurst(nodeId)                       // adds 20 particles to all outbound edges from a node
```

Particle state: `Map<edgeId, Particle[]>` stored in a module-level ref (outside React). Each `Particle`: `{ t: number, speed: number, color: string }` where `t` is 0→1 progress along the edge path.

Each frame: advance `t` by `delta * speed * particleSpeed`, draw as a 3px circle with `shadowBlur: 8` for glow. Remove when `t >= 1`. Spawn new particles based on edge RPS from `simulation.store.edgeRps`.

Play/Pause: `simulation.store.running` toggled by toolbar button and Space key.

### 2.6 Drag-to-canvas from palette

`NodePalette` items are draggable (`draggable` attribute). `Canvas.tsx` has an `onDrop` handler that:
1. Reads `event.dataTransfer.getData('nodeType')`
2. Converts screen coordinates to React Flow coordinates via `screenToFlowPosition`
3. Dispatches `canvas.store.addNode({ type, position })`

### 2.7 Save / Load

`file.store` calls `tauri.ts` shim:
- Cmd+S → `save_diagram(path, JSON.stringify(diagram))` — serializes `canvas.store` nodes + edges + viewport to `.scalemap` format
- On load → `load_diagram(path)` → hydrates `canvas.store`
- Auto-save: `setInterval` every 30s if `file.store.dirty === true`

Home screen shows last 10 files from `get_recent_files()`, each with a placeholder thumbnail. "New Diagram" and "Import Terraform" buttons (Import Terraform is post-M3, shown but disabled).

---

## 3. Full Node Library (M2)

### 3.1 Node type registry

`src/lib/nodeConfig.ts` is the single source of truth:

```typescript
export const NODE_CONFIG: Record<NodeType, NodeConfig> = {
  ec2:          { label: 'EC2 / VM',        icon: Server,       category: 'compute'  },
  lambda:       { label: 'Lambda',           icon: Zap,          category: 'compute'  },
  container:    { label: 'Container',        icon: Box,          category: 'compute'  },
  pod:          { label: 'Pod',              icon: Circle,       category: 'compute'  },
  loadBalancer: { label: 'Load Balancer',    icon: GitBranch,    category: 'network'  },
  apiGateway:   { label: 'API Gateway',      icon: Globe,        category: 'network'  },
  cdn:          { label: 'CDN',              icon: Wifi,         category: 'network'  },
  dns:          { label: 'DNS',              icon: Link,         category: 'network'  },
  firewall:     { label: 'Firewall',         icon: Shield,       category: 'network'  },
  vpn:          { label: 'VPN',              icon: Lock,         category: 'network'  },
  dbSql:        { label: 'Database (SQL)',   icon: Database,     category: 'storage'  },
  dbNoSql:      { label: 'Database (NoSQL)', icon: Database,     category: 'storage'  },
  objectStorage:{ label: 'Object Storage',   icon: Archive,      category: 'storage'  },
  fileStorage:  { label: 'File Storage',     icon: HardDrive,    category: 'storage'  },
  queue:        { label: 'Message Queue',    icon: AlignLeft,    category: 'messaging'},
  eventBus:     { label: 'Event Bus',        icon: Radio,        category: 'messaging'},
  pubsub:       { label: 'Pub/Sub Topic',    icon: Share2,       category: 'messaging'},
  stream:       { label: 'Stream (Kafka)',   icon: Activity,     category: 'messaging'},
  redis:        { label: 'Redis',            icon: Layers,       category: 'caching'  },
  memcached:    { label: 'Memcached',        icon: Layers,       category: 'caching'  },
  cdnCache:     { label: 'CDN Cache',        icon: Wifi,         category: 'caching'  },
  k8sCluster:   { label: 'K8s Cluster',      icon: Cpu,          category: 'orchestration' },
  ecsCluster:   { label: 'ECS Cluster',      icon: Cpu,          category: 'orchestration' },
  dockerCompose:{ label: 'Docker Compose',   icon: Package,      category: 'orchestration' },
  vpc:          { label: 'VPC',              icon: Layout,       category: 'grouping' },
  subnet:       { label: 'Subnet',           icon: Layout,       category: 'grouping' },
  az:           { label: 'Availability Zone',icon: Layout,       category: 'grouping' },
  region:       { label: 'Region',           icon: Map,          category: 'grouping' },
}

export const CATEGORY_COLORS = {
  compute:       { accent: '#4A9EFF', bg: '#0D1F35', border: '#1A3A5C' },
  network:       { accent: '#2DD4BF', bg: '#001F1E', border: '#003E3A' },
  storage:       { accent: '#F5A623', bg: '#1F1400', border: '#3A2800' },
  messaging:     { accent: '#A78BFA', bg: '#180F2A', border: '#2E1A50' },
  caching:       { accent: '#F5A623', bg: '#1F1400', border: '#3A2800' },
  orchestration: { accent: '#4A9EFF', bg: '#0D1F35', border: '#1A3A5C' },
  grouping:      { accent: '#475569', bg: 'transparent', border: '#2A2E38' },
}
```

All 28 non-grouping nodes share `BaseNode.tsx`, parameterized by their `NODE_CONFIG` entry. The `nodeTypes` map in `Canvas.tsx` maps every non-grouping type key to `BaseNode` — no per-type files needed. Adding a new node type is one config entry in `nodeConfig.ts` and one line in the `nodeTypes` map.

### 3.2 Grouping nodes

Separate `GroupNode.tsx` component. Uses React Flow's built-in parent/child node support (`parentId` on child nodes). Visual: large transparent background, dashed border in category color, label in top-left corner. Collapse/expand toggle hides child nodes and shrinks the group to label-only size.

### 3.3 All 4 edge types

| Type | Style |
|---|---|
| `request` | Solid, bidirectional arrows, `#4A9EFF55` |
| `stream` | Animated dash (`stroke-dashoffset` CSS animation), unidirectional, `#A78BFA55` |
| `event` | Dotted, small triangle arrowhead, `#2DD4BF55` |
| `dependency` | Thin solid, no arrow, `#47556955` |

All share a base edge component; type determines dash pattern, arrowhead, and color.

### 3.4 Context menus

`ContextMenu.tsx` — absolutely positioned `div`, rendered via React portal. Triggered by `onContextMenu` on nodes and edges. Closes on outside click or Escape. Node menu: Duplicate, Delete, Change Type (submenu), Add to Group. Edge menu: Change Type, Delete.

### 3.5 Undo / redo

`canvas.store` maintains:
```typescript
history: CanvasSnapshot[]   // past states
future:  CanvasSnapshot[]   // redo stack
```
Every mutation calls `pushHistory()` which snapshots `{ nodes, edges }` and clears `future`. Cmd+Z calls `undo()`, Cmd+Shift+Z calls `redo()`. Max 100 history entries (oldest dropped on overflow).

---

## 4. Simulation Mode (M3)

### 4.1 Particle engine (complete)

Extends the vertical slice implementation with node-type-aware behavior:

**Load balancer:** Tracks a `roundRobinIndex` per node. On particle arrival, routes to downstream edge at current index, increments. If downstream node status is `degraded`, weight is 0.25 (receives 1 in 4 particles instead of equal share).

**Queue:** `simulation.store.queueLevels` maps `nodeId → 0.0..1.0`. Each frame: compare inbound particle arrival rate vs downstream edge RPS. If inbound > outbound, `queueLevel` increments; if inbound < outbound, it drains. The node component renders a fill bar inside its body reflecting `queueLevel`.

**Database / Cache:** Particles are absorbed (removed from engine) on arrival. Triggers a pulse animation on the node.

**Lambda:** `simulation.store.concurrency` maps `nodeId → number`. Increments on particle arrival, decrements after a `processingTime` delay (configurable in properties, default 200ms). Node component renders a badge showing live count.

### 4.2 Node pulse animation

When a node receives a particle, `particleEngine.ts` calls `triggerPulse(nodeId)`. `SimulationOverlay` maintains a `pulses: Map<nodeId, PulseState>` ref. Each frame, active pulses draw an expanding ring centered on the node: radius grows from node size to node size + 20px over 300ms, opacity fades from 0.6 to 0. Color matches node category accent.

### 4.3 Traffic burst on click

During simulation, clicking a node calls `injectBurst(nodeId)` — adds 20 particles to all outbound edges simultaneously, showing the propagation effect.

### 4.4 Simulation controls

- **Play/Pause:** `simulation.store.running` toggled via toolbar button (▶/⏸) and Space key
- **Speed:** `simulation.store.speed` ∈ `{0.5, 1, 2, 5}`, multiplied into `requestAnimationFrame` delta
- **Per-edge RPS:** Set in properties panel when edge selected; stored in `simulation.store.edgeRps`

### 4.5 Framer Motion animations (polish pass)

Applied at the end of M3:
- Node enter: `initial={{ scale: 0.8, opacity: 0 }}` → `animate={{ scale: 1, opacity: 1 }}`, spring
- Node delete: `exit={{ scale: 0.8, opacity: 0 }}`, 150ms ease-out, via `AnimatePresence`
- Edge draw: SVG `pathLength` animated 0→1, 200ms
- Panel open/close: `x: ±20, opacity: 0` → resting, 180ms ease
- All wrapped in `motion.div`; `useReducedMotion()` hook disables if system preference set

---

## 5. Design System Constants

```typescript
// src/lib/theme.ts
export const COLORS = {
  canvas:       '#0D0F12',
  canvasDots:   '#1A1D22',
  nodeBase:     '#161920',
  nodeBorder:   '#2A2E38',
  textPrimary:  '#F1F5F9',
  textSecondary:'#94A3B8',
  textMuted:    '#475569',
}
export const FONT = "'JetBrains Mono', monospace"
```

---

## 6. Key Constraints

- Particle state (`Map<edgeId, Particle[]>`) lives in a module-level ref inside `particleEngine.ts` — never in React state or Zustand. Mutations inside the rAF loop must not trigger re-renders.
- Node icons are never hardcoded in JSX — always sourced from `NODE_CONFIG[type].icon`.
- All Tauri API calls go through `src/lib/tauri.ts` shim — never import `@tauri-apps/api` directly in feature code.
- Windows CI must compile. No macOS-specific APIs.
- Canvas must hold 60fps under 200 nodes / 300 edges / 500 particles.
