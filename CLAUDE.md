# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Scalemap is a desktop application (Tauri 2 + React 19 + TypeScript) for visualizing and simulating infrastructure systems. Users drag and drop infrastructure nodes onto a canvas, draw connections, and watch animated data flow. A Terraform HCL import feature parses `.tf` files and renders the described infrastructure as an interactive graph.

The project is currently at the **boilerplate stage** — `src/App.tsx` and `src-tauri/src/lib.rs` contain only the default Tauri scaffold. All features described below are yet to be built per the PRD in `prd.txt`.

---

## Commands

```bash
# Full Tauri dev (Rust + React hot-reload) — use this for all feature work
npm run tauri dev

# Vite-only dev server (no Tauri APIs available)
npm run dev

# Type-check + build frontend
npm run build

# Build native app (release)
npm run tauri build

# Rust-only (from src-tauri/)
cargo build
cargo test
```

Vite dev server runs on port 1420 (strict — fails if occupied).

---

## Planned Architecture

The target structure from the PRD (nothing exists yet beyond the scaffold):

```
src/
  app/
    store/
      canvas.store.ts      # Nodes, edges, viewport — source of truth for React Flow
      simulation.store.ts  # Particle engine (particles in refs, NOT reactive state)
      ui.store.ts          # Sidebar open/close, active tool, selected elements
      file.store.ts        # File path, dirty flag, undo/redo history stack
    canvas/
      Canvas.tsx           # React Flow wrapper
      nodes/               # One custom component per node type
      edges/               # Custom edge components
      simulation/          # HTML5 canvas overlay + rAF particle loop
    sidebar/
      NodePalette.tsx
      PropertiesPanel.tsx
    toolbar/
      Toolbar.tsx
    home/
      HomeScreen.tsx
  lib/
    nodeConfig.ts          # NODE_ICON_MAP — central icon registry; swap icons here, not in components
    terraform/             # HCL JSON → graph conversion + unresolved variable detection
    layout/                # Dagre auto-layout for Terraform import
    export/                # .scalemap serialization (JSON)

src-tauri/src/
  commands/
    file.rs                # save_diagram, load_diagram, get_recent_files, file dialogs
    terraform.rs           # parse_terraform (calls hcl-rs sidecar, returns JSON)
    export.rs              # export_png, export_svg
  state.rs                 # App-level state (recent files, preferences)
```

---

## Key Architecture Decisions

**Canvas engine:** Use `@xyflow/react` (React Flow). Never use its default visual style — write custom components for every node and edge type.

**State management:** Zustand with one store per domain (listed above). No monolithic store.

**Simulation particles:** Particle state lives in a `useRef`, mutated directly inside the `requestAnimationFrame` loop. It must never be stored in reactive Zustand state — this would trigger thousands of re-renders per second. `queueLevels` and `concurrency` (updated at lower frequency) are reactive.

**Node icons:** Route all icons through `NODE_ICON_MAP` in `src/lib/nodeConfig.ts`. Never hard-code icon elements in node JSX — post-MVP will swap Lucide placeholders for custom SVGs with zero structural change.

**HCL parsing:** The Rust sidecar converts HCL → JSON using the `hcl-rs` crate. The TypeScript frontend receives JSON and walks the resource tree. Do not parse HCL in the browser. Any field value matching `\$\{[^}]+\}` or starting with `var.`, `local.`, or `data.` is flagged as unresolved and stored in `node.data.warnings[]`.

**Undo/redo:** Immutable history stack in `canvas.store`. Each user action pushes a snapshot. Max 100 entries.

**Cross-platform:** All Tauri API calls (file dialogs, path resolution) must use Tauri's cross-platform abstractions. No macOS-specific system calls. CI builds macOS (Intel + Apple Silicon) and Windows (`x86_64-pc-windows-msvc`) on every push to `main` — Windows CI failure is blocking.

---

## Design System

```
Background:       #0D0F12
Node base:        #161920  /  border: #2A2E38
Compute:          #4A9EFF  (blue)
Storage:          #F5A623  (amber)
Network:          #2DD4BF  (teal)
Messaging:        #A78BFA  (purple)
Text primary:     #F1F5F9  /  secondary: #94A3B8  /  muted: #475569
```

Font: `JetBrains Mono` throughout. All animations must respect `prefers-reduced-motion`.

---

## Diagram File Format

`.scalemap` files are JSON with this shape:

```json
{
  "version": "1",
  "meta": { "name": "", "created": "", "modified": "" },
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "nodes": [{ "id": "", "type": "", "position": {}, "data": { "label": "", "subtitle": "", "status": "", "notes": "", "warnings": [] } }],
  "edges": [{ "id": "", "source": "", "target": "", "type": "", "data": { "label": "", "throughput": 100, "latency": 20 } }]
}
```

Default save location: `~/Documents/Scalemap/`. Auto-save interval: 30 seconds.

---

## Key Dependencies to Add

| Package | Purpose |
|---|---|
| `@xyflow/react` | Canvas — node/edge rendering, pan/zoom, minimap |
| `zustand` | State management |
| `dagre` | Auto-layout on Terraform import |
| `framer-motion` | Panel/node animations |
| `lucide-react` | Placeholder node icons |

Rust (`src-tauri/Cargo.toml`): add `hcl-rs` for Terraform parsing.
