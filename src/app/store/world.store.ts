// Source of truth for the .scalemap v2 document. Normalized WorldDoc + immutable-snapshot
// undo/redo (same pattern as canvas.store.ts). Every mutation goes through pushHistory()
// and replaces `doc` wholesale so useCompiledWorld()'s useMemo invalidates.
import { create } from 'zustand'
import type {
  WorldDoc, Server, ServiceBlueprint, Placement, ManagedScope, ClientPopulation,
  RoutingConfig, TrafficConfig,
} from '../../lib/world/types'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createPopulation, nextWorldId, type InstancePresetLike,
} from '../../lib/world/factories'
import { useFileStore } from './file.store'

const deepCopy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

// ─── Pure cascade helpers ────────────────────────────────────────────────────

function withoutServer(doc: WorldDoc, serverId: string): WorldDoc {
  const servers = { ...doc.servers }
  delete servers[serverId]
  const placements = Object.fromEntries(
    Object.entries(doc.placements).filter(([, p]) => p.serverId !== serverId))
  return { ...doc, servers, placements }
}

function withoutAz(doc: WorldDoc, azId: string): WorldDoc {
  let next: WorldDoc = doc
  for (const s of Object.values(doc.servers)) if (s.azId === azId) next = withoutServer(next, s.id)
  const azs = { ...next.azs }
  delete azs[azId]
  const managedServices = Object.fromEntries(
    Object.entries(next.managedServices).filter(([, m]) => !(m.scope.kind === 'az' && m.scope.azId === azId)))
  return { ...next, azs, managedServices }
}

function withoutRegion(doc: WorldDoc, regionId: string): WorldDoc {
  let next: WorldDoc = doc
  for (const az of Object.values(doc.azs)) if (az.regionId === regionId) next = withoutAz(next, az.id)
  const regions = { ...next.regions }
  delete regions[regionId]
  const managedServices = Object.fromEntries(
    Object.entries(next.managedServices).filter(([, m]) => !(m.scope.kind === 'region' && m.scope.regionId === regionId)))
  const weights = { ...next.routing.weights }
  delete weights[regionId]
  return {
    ...next, regions, managedServices,
    routing: { ...next.routing, weights, priorityOrder: next.routing.priorityOrder.filter(id => id !== regionId) },
  }
}

function stripDependencies(doc: WorldDoc, matches: (dep: ServiceBlueprint['dependencies'][number]) => boolean): WorldDoc {
  const blueprints = Object.fromEntries(Object.entries(doc.blueprints).map(([id, bp]) => [
    id, { ...bp, dependencies: bp.dependencies.filter(d => !matches(d)) },
  ]))
  return { ...doc, blueprints }
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface WorldStore {
  doc: WorldDoc
  history: WorldDoc[]
  future: WorldDoc[]
  newWorld: () => void
  replaceWorld: (doc: WorldDoc) => void
  addRegion: (catalogId: string) => string
  removeRegion: (id: string) => void
  addAz: (regionId: string, label: string) => string
  removeAz: (id: string) => void
  addServer: (azId: string, preset: InstancePresetLike) => string
  updateServer: (id: string, patch: Partial<Server>) => void
  removeServer: (id: string) => void
  addBlueprint: (name: string) => string
  updateBlueprint: (id: string, patch: Partial<ServiceBlueprint>) => void
  removeBlueprint: (id: string) => void
  addPlacement: (blueprintId: string, serverId: string) => string
  updatePlacement: (id: string, patch: Partial<Placement>) => void
  removePlacement: (id: string) => void
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number) => string
  removeManagedService: (id: string) => void
  addPopulation: (label: string, lat: number, lon: number) => string
  updatePopulation: (id: string, patch: Partial<ClientPopulation>) => void
  removePopulation: (id: string) => void
  updateRouting: (patch: Partial<RoutingConfig>) => void
  updateTraffic: (patch: Partial<TrafficConfig>) => void
  pushHistory: () => void
  undo: () => void
  redo: () => void
}

export const useWorldStore = create<WorldStore>((set, get) => {
  // Wraps a doc-transform as a history-pushing mutation.
  const mutate = (fn: (doc: WorldDoc) => WorldDoc) => {
    get().pushHistory()
    set(s => ({ doc: fn(s.doc) }))
    useFileStore.getState().setDirty(true)
  }

  return {
    doc: createWorld(),
    history: [],
    future: [],

    newWorld: () => {
      set({ doc: createWorld(), history: [], future: [] })
      // A fresh world is pristine: clear the dirty flag and created stamp so the
      // autosave gate and Save's meta.created both start clean.
      useFileStore.getState().setDirty(false)
      useFileStore.getState().setCreatedIso(null)
    },
    replaceWorld: (doc) => set({ doc, history: [], future: [] }),

    addRegion: (catalogId) => {
      const region = createRegion(catalogId)
      mutate(d => ({ ...d, regions: { ...d.regions, [region.id]: region } }))
      return region.id
    },
    removeRegion: (id) => mutate(d => withoutRegion(d, id)),

    addAz: (regionId, label) => {
      const az = createAz(regionId, label)
      mutate(d => ({ ...d, azs: { ...d.azs, [az.id]: az } }))
      return az.id
    },
    removeAz: (id) => mutate(d => withoutAz(d, id)),

    addServer: (azId, preset) => {
      const server = createServer(azId, preset)
      server.label = `server-${Object.keys(get().doc.servers).length + 1}`
      mutate(d => ({ ...d, servers: { ...d.servers, [server.id]: server } }))
      return server.id
    },
    updateServer: (id, patch) => mutate(d => {
      const existing = d.servers[id]
      if (!existing) return d
      return { ...d, servers: { ...d.servers, [id]: { ...existing, ...patch, id } } }
    }),
    removeServer: (id) => mutate(d => withoutServer(d, id)),

    addBlueprint: (name) => {
      const bp = createBlueprint(name, Object.keys(get().doc.blueprints).length)
      mutate(d => ({ ...d, blueprints: { ...d.blueprints, [bp.id]: bp } }))
      return bp.id
    },
    updateBlueprint: (id, patch) => mutate(d => {
      const existing = d.blueprints[id]
      if (!existing) return d
      return { ...d, blueprints: { ...d.blueprints, [id]: { ...existing, ...patch, id } } }
    }),
    removeBlueprint: (id) => mutate(d => {
      const blueprints = { ...d.blueprints }
      delete blueprints[id]
      const placements = Object.fromEntries(
        Object.entries(d.placements).filter(([, p]) => p.blueprintId !== id))
      return stripDependencies({ ...d, blueprints, placements },
        dep => dep.target.kind === 'blueprint' && dep.target.blueprintId === id)
    }),

    addPlacement: (blueprintId, serverId) => {
      const pl = createPlacement(blueprintId, serverId)
      mutate(d => ({ ...d, placements: { ...d.placements, [pl.id]: pl } }))
      return pl.id
    },
    updatePlacement: (id, patch) => mutate(d => {
      const existing = d.placements[id]
      if (!existing) return d
      return { ...d, placements: { ...d.placements, [id]: { ...existing, ...patch, id } } }
    }),
    removePlacement: (id) => mutate(d => {
      const placements = { ...d.placements }
      delete placements[id]
      return { ...d, placements }
    }),

    addManagedService: (nodeType, label, scope, port) => {
      const id = nextWorldId('ms')
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: { id, label, nodeType, scope, provider: 'generic', port } } }))
      return id
    },
    removeManagedService: (id) => mutate(d => {
      const managedServices = { ...d.managedServices }
      delete managedServices[id]
      return stripDependencies({ ...d, managedServices },
        dep => dep.target.kind === 'managed' && dep.target.managedServiceId === id)
    }),

    addPopulation: (label, lat, lon) => {
      const pop = createPopulation(label, lat, lon)
      mutate(d => ({ ...d, populations: { ...d.populations, [pop.id]: pop } }))
      return pop.id
    },
    updatePopulation: (id, patch) => mutate(d => {
      const existing = d.populations[id]
      if (!existing) return d
      return { ...d, populations: { ...d.populations, [id]: { ...existing, ...patch, id } } }
    }),
    removePopulation: (id) => mutate(d => {
      const populations = { ...d.populations }
      delete populations[id]
      return { ...d, populations }
    }),

    updateRouting: (patch) => mutate(d => ({ ...d, routing: { ...d.routing, ...patch } })),
    updateTraffic: (patch) => mutate(d => ({ ...d, traffic: { ...d.traffic, ...patch } })),

    pushHistory: () => {
      const { doc, history } = get()
      const trimmed = history.length >= 100 ? history.slice(1) : history
      set({ history: [...trimmed, deepCopy(doc)], future: [] })
    },
    undo: () => {
      const { history, doc, future } = get()
      if (history.length === 0) return
      set({
        doc: history[history.length - 1],
        history: history.slice(0, -1),
        future: [deepCopy(doc), ...future],
      })
    },
    redo: () => {
      const { future, doc, history } = get()
      if (future.length === 0) return
      set({
        doc: future[0],
        history: [...history, deepCopy(doc)],
        future: future.slice(1),
      })
    },
  }
})
