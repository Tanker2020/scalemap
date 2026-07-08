import type { Node, Edge, Viewport } from '@xyflow/react'
import type { NodeData, EdgeData, PacketRegistry } from './nodeConfig'
import type { WorldDoc } from './world/types'

export interface DiagramFile {
  version: '1'
  meta: { name: string; created: string; modified: string }
  viewport: Viewport
  nodes: Node<NodeData>[]
  edges: Edge<EdgeData>[]
  packets?: PacketRegistry  // optional — absent in legacy files (load as generic/empty)
}

export function serialize(
  nodes: Node<NodeData>[],
  edges: Edge<EdgeData>[],
  viewport: Viewport,
  name: string,
  created: string,
  packets?: PacketRegistry,
): string {
  const diagram: DiagramFile = {
    version: '1',
    meta: { name, created, modified: new Date().toISOString() },
    viewport,
    nodes,
    edges,
    ...(packets ? { packets } : {}),
  }
  return JSON.stringify(diagram, null, 2)
}

export function deserialize(raw: string): DiagramFile {
  const data = JSON.parse(raw) as DiagramFile
  if (data.version !== '1') throw new Error(`Unsupported diagram version: ${data.version}`)
  return data
}

// ─── .scalemap v2 (world model) ──────────────────────────────────────────────
// v1 exports above are retained ONLY so unmounted legacy UI keeps compiling; the app's
// live file flow (HomeScreen/WorldShell) uses exclusively the v2 functions below.

export interface WorldViewState {
  level: 'globe' | 'region' | 'az' | 'server'
  regionId?: string
  azId?: string
  serverId?: string
}

export interface ScalemapFileV2 {
  version: '2'
  meta: { name: string; created: string; modified: string }
  world: WorldDoc
  packets?: PacketRegistry
  viewState?: WorldViewState
}

export function serializeWorld(
  world: WorldDoc,
  name: string,
  created: string,
  packets?: PacketRegistry,
  viewState?: WorldViewState,
): string {
  const file: ScalemapFileV2 = {
    version: '2',
    meta: { name, created, modified: new Date().toISOString() },
    world,
    ...(packets ? { packets } : {}),
    ...(viewState ? { viewState } : {}),
  }
  return JSON.stringify(file, null, 2)
}

export function deserializeWorld(raw: string): ScalemapFileV2 {
  const data = JSON.parse(raw) as { version?: unknown; world?: unknown }
  if (data.version === '1') {
    throw new Error('This is a v1 diagram from an older Scalemap and predates the world model — v1 files are not supported.')
  }
  if (data.version !== '2') {
    throw new Error(`Unsupported scalemap version: ${String(data.version)}`)
  }
  const meta = (data as { meta?: unknown }).meta
  const world = data.world as Record<string, unknown> | undefined
  const requiredCollections = [
    'routing', 'traffic', 'populations', 'regions', 'azs', 'servers',
    'blueprints', 'placements', 'managedServices',
  ] as const
  const worldIsValid =
    world != null && typeof world === 'object' &&
    requiredCollections.every(key => world[key] != null && typeof world[key] === 'object')
  if (meta == null || typeof meta !== 'object' || !worldIsValid) {
    throw new Error('Invalid .scalemap file: missing or malformed world document')
  }
  return data as ScalemapFileV2
}
