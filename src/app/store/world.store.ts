// Source of truth for the .scalemap v2 document. Normalized WorldDoc + immutable-snapshot
// undo/redo (same pattern as canvas.store.ts). Every mutation goes through pushHistory()
// and replaces `doc` wholesale so useCompiledWorld()'s useMemo invalidates.
import { create } from 'zustand'
import type {
  WorldDoc, Server, ServiceBlueprint, Placement, ManagedScope, ManagedService, ClientPopulation,
  RoutingConfig, AzId, Rack, RackId, LoadBalancer, DependencyTarget, BlueprintDependency,
  Scenario, ScenarioStep,
} from '../../lib/world/types'
import { planReachability, applyReachabilityPlan } from '../../lib/world/connections'
import { planSpread } from '../../lib/world/spread'
import { draftWorkload, draftPorts, type ServiceDraft } from '../../lib/world/serviceDraft'
import { getPreset } from '../../lib/world/instanceCatalog'
import { managedDbEngine } from '../../lib/world/types'
import { defaultDbClassId } from '../../lib/dbInstanceClasses'
import {
  createWorld, createRegion, createAz, createServer, createDbServer, createBlueprint, createPlacement,
  createPopulation, createRack, createLoadBalancer, nextWorldId, type InstancePresetLike,
} from '../../lib/world/factories'
import {
  canAssign, rackUsedU, serverHeightU, autoArrangePlan,
  RACK_CAPACITY_MIN, RACK_CAPACITY_MAX,
} from '../../lib/world/rackModel'
import {
  addRoute as addRouteToRegistry, updateRoute as updateRouteInRegistry,
  removeRoute as removeRouteFromRegistry, routeIdOf, type RouteFields,
  addPacket as addPacketToRegistry, updatePacket as updatePacketInRegistry,
  removePacket as removePacketFromRegistry, duplicatePacket as duplicatePacketInRegistry,
  getPacket, listPackets, type PacketFields, type PacketMixEntry,
} from '../../lib/nodeConfig'
import { nextCopyName } from '../../lib/world/populationLabel'
import { useFileStore } from './file.store'
import { useSimulationStore } from './simulation.store'

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
  const loadBalancers = Object.fromEntries(
    Object.entries(next.loadBalancers).filter(([, lb]) => lb.regionId !== regionId))
  const weights = { ...next.routing.weights }
  delete weights[regionId]
  return {
    ...next, regions, managedServices, loadBalancers,
    routing: { ...next.routing, weights, priorityOrder: next.routing.priorityOrder.filter(id => id !== regionId) },
  }
}

function stripDependencies(doc: WorldDoc, matches: (dep: ServiceBlueprint['dependencies'][number]) => boolean): WorldDoc {
  const blueprints = Object.fromEntries(Object.entries(doc.blueprints).map(([id, bp]) => [
    id, { ...bp, dependencies: bp.dependencies.filter(d => !matches(d)) },
  ]))
  return { ...doc, blueprints }
}

// Removing a blueprint must not leave a regional LB pointing a listener rule or its default action
// at a service that no longer exists (compile would resolve it to an empty target group and the
// engine would silently drop that route). Drop matching listener rules; null out a default action
// that referenced the removed blueprint (⇒ compile falls back to the region's entry blueprints).
function scrubBlueprintFromLbs(doc: WorldDoc, blueprintId: string): WorldDoc {
  const loadBalancers = Object.fromEntries(Object.entries(doc.loadBalancers).map(([id, lb]) => [id, {
    ...lb,
    listenerRules: lb.listenerRules.filter(r => r.targetBlueprintId !== blueprintId),
    defaultTargetBlueprintId: lb.defaultTargetBlueprintId === blueprintId ? null : lb.defaultTargetBlueprintId,
  }]))
  return { ...doc, loadBalancers }
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
  /** Drops a self-hosted DB appliance: box + owned blueprint + primary placement, one undo step. */
  addDbServer: (azId: string, preset: InstancePresetLike, name: string) =>
    { serverId: string; blueprintId: string; placementId: string }
  /** Replicates a blueprint into each target AZ (reusing a fitting host, else creating one). */
  spreadBlueprint: (blueprintId: string, targetAzIds: string[]) => void
  /** Authors a NEW global service and places it on this host, in one undo step. */
  addServiceToServer: (serverId: string, draft: ServiceDraft) =>
    { blueprintId: string; placementId: string }
  updateServer: (id: string, patch: Partial<Server>) => void
  removeServer: (id: string) => void
  addBlueprint: (name: string) => string
  updateBlueprint: (id: string, patch: Partial<ServiceBlueprint>) => void
  removeBlueprint: (id: string) => void
  /** Deep-copies a blueprint (fresh dependency ids, NO placements) — returns the new id, or null. */
  duplicateBlueprint: (id: string) => string | null
  // Service-connections layer (app/world/connections/): author a service→service/managed edge
  // (intent) and, when autoProvision is on, open the firewall + bind the port in the same undo
  // step. disconnect drops just the intent; fixReachability re-provisions a blocked edge;
  // setInternetFacing toggles a blueprint's public port (ingress) + opens `allow … any`.
  connectServices: (fromBpId: string, target: DependencyTarget, opts: { port: number; protocol: BlueprintDependency['protocol']; autoProvision: boolean }) => string
  disconnectServices: (fromBpId: string, depId: string) => void
  fixReachability: (fromBpId: string, depId: string) => void
  /** Sets a dependency's read/write split (node-model Phase 3); clamped to [0,1]. */
  setDependencyWriteFraction: (fromBpId: string, depId: string, writeFraction: number) => void
  /** Binds (or, with an empty mix, unbinds) the packets this edge puts on the wire per call. */
  setDependencyPacketMix: (fromBpId: string, depId: string, mix: PacketMixEntry[]) => void
  /** The edge's inline tier-2 sizes, used only while no packet mix is bound. */
  setDependencyWireSize: (fromBpId: string, depId: string, patch: { reqKb?: number; respKb?: number }) => void
  /** Binds (or, with null, unbinds) the sibling dependency id this db edge's cache-aside reads through. */
  setDependencyCacheAsideVia: (fromBpId: string, depId: string, cacheAsideVia: string | null) => void
  setInternetFacing: (bpId: string, port: number, exposed: boolean) => void
  // Connections-editor node layout: store a single dragged node's override (one undo step per
  // drag) or clear every override back to the auto tree-layout ("auto-arrange").
  setNodePosition: (nodeId: string, pos: { x: number; y: number }) => void
  clearConnectionLayout: () => void
  addPlacement: (blueprintId: string, serverId: string) => string
  updatePlacement: (id: string, patch: Partial<Placement>) => void
  removePlacement: (id: string) => void
  addManagedService: (nodeType: string, label: string, scope: ManagedScope, port: number, provider?: ManagedService['provider'], config?: Partial<ManagedService>) => string
  /** Patches a managed service (e.g. a cloud DB's instance class / replicas / storage). */
  updateManagedService: (id: string, patch: Partial<ManagedService>) => void
  removeManagedService: (id: string) => void
  addPopulation: (label: string, lat: number, lon: number) => string
  updatePopulation: (id: string, patch: Partial<ClientPopulation>) => void
  removePopulation: (id: string) => void
  updateRouting: (patch: Partial<RoutingConfig>) => void
  addLoadBalancer: (regionId: string) => string
  updateLoadBalancer: (id: string, patch: Partial<LoadBalancer>) => void
  addRoute: (fields: RouteFields) => string
  updateRoute: (routeId: string, patch: Partial<RouteFields>) => void
  removeRoute: (routeId: string) => void
  /** The route's "advanced" packet binding — supersedes its inline sizeKb/responseSizeKb. */
  setRoutePacketMix: (routeId: string, mix: PacketMixEntry[]) => void
  // Packet library (the registry's pathless view). Same monotonic id space as the routes above.
  addPacket: (fields: PacketFields) => number
  /** Replaces a packet's shape wholesale (a protocol switch strands no fields). */
  updatePacket: (packetId: number, fields: PacketFields) => void
  /** Deletes a packet AND scrubs its id from every dependency and route mix bound to it. */
  removePacket: (packetId: number) => void
  duplicatePacket: (packetId: number) => number | null
  /** The world-level tier-3 wire-size default; `null` clears it back to the 2 KB convention. */
  setDefaultPacket: (value: { reqKb: number; respKb: number } | null) => void
  addRack: (azId: AzId) => void
  updateRack: (id: RackId, patch: Partial<Pick<Rack, 'label' | 'capacityU'>>) => void
  removeRack: (id: RackId) => void
  assignServerToRack: (serverId: string, rackId: RackId | null) => void
  autoArrangeAz: (azId: AzId) => void
  setScenario: (scenario: Scenario | null) => void
  addScenarioStep: (step: ScenarioStep) => void
  removeScenarioStep: (index: number) => void
  updateScenarioStep: (index: number, step: ScenarioStep) => void
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
      // Swapping the doc under a RUNNING engine leaves the sim ticking a world that no
      // longer exists and every authoring control edit-locked behind `running` — the app
      // looks dead after New. Same centralize-the-reset stance as the Phase-1 autosave
      // fix: the doc-swap action owns stopping the sim (engine stop() is idle-safe).
      // resetSession (not stop()): the session state — latestBatch, events, scrub
      // position, health overrides — references the discarded doc's ids, so the swap
      // clears it wholesale instead of leaving stale frames scrubbable (see Task 7).
      useSimulationStore.getState().resetSession()
      set({ doc: createWorld(), history: [], future: [] })
      // A fresh world is pristine: clear the dirty flag and created stamp so the
      // autosave gate and Save's meta.created both start clean.
      useFileStore.getState().setDirty(false)
      useFileStore.getState().setCreatedIso(null)
    },
    replaceWorld: (doc) => {
      // Open-while-running has the same stale-engine + edit-lock failure as newWorld.
      // resetSession (not stop()): the incoming doc's ids don't match the discarded
      // world's session state, so the swap clears it wholesale instead of leaving stale
      // frames scrubbable (see Task 7).
      useSimulationStore.getState().resetSession()
      set({ doc, history: [], future: [] })
    },

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
    // ONE mutate() for all three records: a half-applied appliance (a db box whose blueprint
    // hasn't landed yet) is not a state the user should ever be able to undo into.
    addDbServer: (azId, preset, name) => {
      const { server, blueprint, placement } = createDbServer(azId, preset, name)
      mutate(d => ({
        ...d,
        servers: { ...d.servers, [server.id]: server },
        blueprints: { ...d.blueprints, [blueprint.id]: blueprint },
        placements: { ...d.placements, [placement.id]: placement },
      }))
      return { serverId: server.id, blueprintId: blueprint.id, placementId: placement.id }
    },
    // The "door": authoring a service from a host creates a normal GLOBAL service record and a
    // placement binding it here. The host is an entry point, not an owner — `ownerServerKind`
    // stays null (only appliance boxes stamp it), so this service can later be spread, mounted on
    // other hosts, or edited from any surface. One mutate(): create-and-place is one action to
    // the user, and undoing it must not strand a blueprint nothing runs.
    addServiceToServer: (serverId, draft) => {
      const bp = createBlueprint(draft.name, Object.keys(get().doc.blueprints).length)
      bp.kind = draft.kind
      bp.workload = draft.workload ?? draftWorkload(draft.kind, draft.cost, draft.memory)
      bp.ports = draftPorts(draft)
      const placement = createPlacement(bp.id, serverId)

      mutate(d => ({
        ...d,
        blueprints: { ...d.blueprints, [bp.id]: bp },
        placements: { ...d.placements, [placement.id]: placement },
      }))
      return { blueprintId: bp.id, placementId: placement.id }
    },
    // Applies planSpread's whole plan in ONE mutate(): a half-applied spread — a freshly created
    // host with no placement on it — is not a state undo should be able to land in. Bails BEFORE
    // mutate() when the plan is empty so a no-op spread never burns an undo slot.
    spreadBlueprint: (blueprintId, targetAzIds) => {
      const plan = planSpread(get().doc, blueprintId, targetAzIds)
      if (plan.length === 0) return

      mutate(d => {
        const servers = { ...d.servers }
        const placements = { ...d.placements }

        for (const target of plan) {
          let serverId: string
          if (target.kind === 'existing') {
            serverId = target.serverId
          } else {
            const preset = getPreset(target.presetId)
            if (!preset) continue   // catalog drift — skip rather than place onto nothing
            const server = createServer(target.azId, preset)
            // Name it after the service and the AZ's LABEL suffix ('web-1c'), never the AZ id —
            // ids look like 'az-3-mf8k36su', so slicing them yields names like 'web-36su'.
            const azSuffix = d.azs[target.azId]?.label.split('-').pop() ?? 'az'
            server.label = `${d.blueprints[blueprintId]?.name ?? 'server'}-${azSuffix}`
            servers[server.id] = server
            serverId = server.id
          }
          const placement = createPlacement(blueprintId, serverId)
          // Spread copies are replicas: the source placement stays the primary. This is what
          // makes a spread DB a real cluster (one writer, N read replicas) rather than N primaries.
          placement.role = 'replica'
          placements[placement.id] = placement
        }

        return { ...d, servers, placements }
      })
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
      return stripDependencies(scrubBlueprintFromLbs({ ...d, blueprints, placements }, id),
        dep => dep.target.kind === 'blueprint' && dep.target.blueprintId === id)
    }),
    // A blueprint is a GLOBAL, reusable definition — duplicating one gives you a second definition
    // to diverge from, deliberately with NO placements (the copy is not running anywhere until you
    // mount it) and with fresh dependency ids, since dep ids are unique per document and the copy's
    // edges must be independently editable/removable from the original's.
    duplicateBlueprint: (id) => {
      const src = get().doc.blueprints[id]
      if (!src) return null
      const newId = nextWorldId('bp')
      mutate(d => {
        const bp = d.blueprints[id]
        if (!bp) return d
        const copy: ServiceBlueprint = {
          ...structuredClone(bp),
          id: newId,
          name: nextCopyName(Object.values(d.blueprints).map(b => b.name), bp.name),
          dependencies: bp.dependencies.map(dep => ({ ...structuredClone(dep), id: nextWorldId('dep') })),
        }
        return { ...d, blueprints: { ...d.blueprints, [newId]: copy } }
      })
      return newId
    },

    connectServices: (fromBpId, target, opts) => {
      const depId = nextWorldId('dep')
      mutate(d => {
        const bp = d.blueprints[fromBpId]
        if (!bp) return d
        const dep: BlueprintDependency = { id: depId, target, port: opts.port, protocol: opts.protocol, packetTemplateId: null }
        let next: WorldDoc = { ...d, blueprints: { ...d.blueprints, [fromBpId]: { ...bp, dependencies: [...bp.dependencies, dep] } } }
        if (opts.autoProvision) next = applyReachabilityPlan(next, planReachability(next, target, opts.port, 'internal'))
        return next
      })
      return depId
    },
    disconnectServices: (fromBpId, depId) => mutate(d => {
      const bp = d.blueprints[fromBpId]
      if (!bp) return d
      return { ...d, blueprints: { ...d.blueprints, [fromBpId]: { ...bp, dependencies: bp.dependencies.filter(dep => dep.id !== depId) } } }
    }),
    fixReachability: (fromBpId, depId) => mutate(d => {
      const dep = d.blueprints[fromBpId]?.dependencies.find(x => x.id === depId)
      if (!dep) return d
      return applyReachabilityPlan(d, planReachability(d, dep.target, dep.port, 'internal'))
    }),
    setDependencyWriteFraction: (fromBpId, depId, writeFraction) => mutate(d => {
      const bp = d.blueprints[fromBpId]
      if (!bp) return d
      const w = Math.min(1, Math.max(0, writeFraction))
      return { ...d, blueprints: { ...d.blueprints, [fromBpId]: {
        ...bp,
        dependencies: bp.dependencies.map(dep => dep.id === depId ? { ...dep, writeFraction: w } : dep),
      } } }
    }),
    setDependencyPacketMix: (fromBpId, depId, mix) => mutate(d => {
      const bp = d.blueprints[fromBpId]
      if (!bp) return d
      // Weight-0 rows are the editor's "not in the mix" state; strip them here so the stored
      // document only ever holds live bindings and the resolver never has to reason about them.
      const clean = mix.filter(e => Number.isFinite(e.weight) && e.weight > 0)
      return { ...d, blueprints: { ...d.blueprints, [fromBpId]: {
        ...bp,
        dependencies: bp.dependencies.map(dep => dep.id === depId
          ? { ...dep, packetMix: clean.length > 0 ? clean : undefined }
          : dep),
      } } }
    }),
    setDependencyWireSize: (fromBpId, depId, patch) => mutate(d => {
      const bp = d.blueprints[fromBpId]
      if (!bp) return d
      const clamp = (v: number | undefined) => v == null || !Number.isFinite(v) ? undefined : Math.max(0, v)
      return { ...d, blueprints: { ...d.blueprints, [fromBpId]: {
        ...bp,
        dependencies: bp.dependencies.map(dep => dep.id === depId ? {
          ...dep,
          ...('reqKb' in patch ? { reqKb: clamp(patch.reqKb) } : {}),
          ...('respKb' in patch ? { respKb: clamp(patch.respKb) } : {}),
        } : dep),
      } } }
    }),
    setDependencyCacheAsideVia: (fromBpId, depId, cacheAsideVia) => mutate(d => {
      const bp = d.blueprints[fromBpId]
      if (!bp) return d
      return { ...d, blueprints: { ...d.blueprints, [fromBpId]: {
        ...bp,
        dependencies: bp.dependencies.map(dep => dep.id === depId
          ? { ...dep, cacheAsideVia: cacheAsideVia ?? undefined }
          : dep),
      } } }
    }),
    setInternetFacing: (bpId, port, exposed) => mutate(d => {
      const bp = d.blueprints[bpId]
      if (!bp) return d
      const has = bp.ports.some(p => p.port === port)
      const visibility: 'public' | 'internal' = exposed ? 'public' : 'internal'
      const ports = has
        ? bp.ports.map(p => (p.port === port ? { ...p, visibility } : p))
        : exposed ? [...bp.ports, { port, protocol: 'tcp' as const, visibility }] : bp.ports
      let next: WorldDoc = { ...d, blueprints: { ...d.blueprints, [bpId]: { ...bp, ports } } }
      if (exposed) next = applyReachabilityPlan(next, planReachability(next, { kind: 'blueprint', blueprintId: bpId }, port, 'any'))
      return next
    }),
    setNodePosition: (nodeId, pos) => mutate(d => ({ ...d, connectionLayout: { ...d.connectionLayout, [nodeId]: pos } })),
    clearConnectionLayout: () => mutate(d => ({ ...d, connectionLayout: {} })),

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

    addManagedService: (nodeType, label, scope, port, provider = 'generic', config) => {
      const id = nextWorldId('ms')
      // A cloud-managed DB is born on the smallest class of its engine (node-model Phase 3), so its
      // capacity ceiling and realistic pricing are live immediately — the user sizes up from there.
      // Non-DB managed services carry none of these fields.
      const engine = managedDbEngine(nodeType)
      const dbFields = engine
        ? { instanceClassId: defaultDbClassId(engine), replicaCount: 0, multiAz: false, storageGb: 100 }
        : {}
      // Merge caller-supplied config over the engine-derived defaults, stripping explicitly-
      // undefined keys first: on this CREATE path an undefined value in config means "nothing to
      // set here", not "clear this field" (that distinction only matters on the UPDATE path via
      // updateManagedService, which is untouched). `id` is re-pinned last so config can never
      // rewrite the entity's identity, even though draftToConfig should never emit one.
      const configOverrides = config
        ? Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))
        : {}
      const record = { id, label, nodeType, scope, provider, port, ...dbFields, ...configOverrides }
      record.id = id   // re-pin last: config can never rewrite the entity's identity
      mutate(d => ({ ...d, managedServices: { ...d.managedServices, [id]: record } }))
      return id
    },
    updateManagedService: (id, patch) => mutate(d => {
      const existing = d.managedServices[id]
      if (!existing) return d
      return { ...d, managedServices: { ...d.managedServices, [id]: { ...existing, ...patch, id } } }
    }),
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

    addLoadBalancer: (regionId) => {
      const lb = createLoadBalancer(regionId)
      mutate(d => ({ ...d, loadBalancers: { ...d.loadBalancers, [lb.id]: lb } }))
      return lb.id
    },
    updateLoadBalancer: (id, patch) => mutate(d => {
      const existing = d.loadBalancers[id]
      if (!existing) return d
      return { ...d, loadBalancers: { ...d.loadBalancers, [id]: { ...existing, ...patch, id } } }
    }),

    // Route catalog CRUD (Phase 2). Routes live in doc.packets (the revived registry) so these
    // ride mutate() for undo/dirty like every other entity. The new route's id is the registry's
    // pre-mutation nextId — captured inside the synchronous mutate() transform.
    addRoute: (fields) => {
      let id = ''
      mutate(d => {
        const { registry, route } = addRouteToRegistry(d.packets, fields)
        id = routeIdOf(route)
        return { ...d, packets: registry }
      })
      return id
    },
    updateRoute: (routeId, patch) => mutate(d => ({ ...d, packets: updateRouteInRegistry(d.packets, routeId, patch) })),
    // Deleting a route scrubs every population's requestMix reference to it, so no population is
    // left emitting a class that resolves to nothing (which the engine would drop and analysis flag).
    removeRoute: (routeId) => mutate(d => {
      const packets = removeRouteFromRegistry(d.packets, routeId)
      const populations = Object.fromEntries(Object.entries(d.populations).map(([id, pop]) => {
        if (!pop.requestMix) return [id, pop]
        return [id, { ...pop, requestMix: pop.requestMix.filter(e => e.routeId !== routeId) }]
      }))
      return { ...d, packets, populations }
    }),
    setRoutePacketMix: (routeId, mix) => mutate(d => {
      const existing = d.packets.templates[Number(routeId)]
      if (!existing || existing.protocol !== 'http') return d
      const clean = mix.filter(e => Number.isFinite(e.weight) && e.weight > 0)
      return { ...d, packets: { ...d.packets, templates: { ...d.packets.templates,
        [existing.id]: { ...existing, packetMix: clean.length > 0 ? clean : undefined } } } }
    }),

    // ─── Packet library CRUD ──────────────────────────────────────────────────
    // Same registry, same monotonic id space as the routes above (a packet is a template with no
    // path), so these ride mutate() for undo/dirty identically. The new id is the registry's
    // pre-mutation nextId, captured inside the synchronous transform.
    addPacket: (fields) => {
      let id = 0
      mutate(d => {
        const { registry, packet } = addPacketToRegistry(d.packets, fields)
        id = packet.id
        return { ...d, packets: registry }
      })
      return id
    },
    updatePacket: (packetId, fields) => mutate(d => ({ ...d, packets: updatePacketInRegistry(d.packets, packetId, fields) })),
    // Deleting a packet scrubs its id out of every binding — dependency mixes AND route mixes —
    // mirroring removeRoute's requestMix cascade. Without this, an edge would keep a dangling
    // entry; the resolver ignores dangling ids defensively, but a stored one would resurface
    // wrongly if the id were later reissued (it can't be — nextId is monotonic — but the document
    // should not carry references to things that don't exist).
    removePacket: (packetId) => mutate(d => {
      const scrub = (mix: PacketMixEntry[] | undefined): PacketMixEntry[] | undefined => {
        if (!mix) return undefined
        const next = mix.filter(e => e.packetId !== packetId)
        return next.length === mix.length ? mix : (next.length > 0 ? next : undefined)
      }
      const registry = removePacketFromRegistry(d.packets, packetId)
      const templates = Object.fromEntries(Object.entries(registry.templates).map(([id, t]) => {
        if (t.protocol !== 'http' || t.packetMix == null) return [id, t]
        return [id, { ...t, packetMix: scrub(t.packetMix) }]
      }))
      const blueprints = Object.fromEntries(Object.entries(d.blueprints).map(([id, bp]) => {
        if (!bp.dependencies.some(dep => dep.packetMix?.some(e => e.packetId === packetId))) return [id, bp]
        return [id, { ...bp, dependencies: bp.dependencies.map(dep => ({ ...dep, packetMix: scrub(dep.packetMix) })) }]
      }))
      return { ...d, packets: { ...registry, templates }, blueprints }
    }),
    duplicatePacket: (packetId) => {
      const reg = get().doc.packets
      const src = getPacket(reg, packetId)
      if (!src) return null
      let id: number | null = null
      mutate(d => {
        const name = nextCopyName(listPackets(d.packets).map(p => p.name), src.name)
        const result = duplicatePacketInRegistry(d.packets, packetId, name)
        if (!result) return d
        id = result.packet.id
        return { ...d, packets: result.registry }
      })
      return id
    },
    setDefaultPacket: (value) => mutate(d => ({
      ...d,
      packets: value == null
        ? (({ defaultPacket: _drop, ...rest }) => rest)(d.packets)
        : { ...d.packets, defaultPacket: { reqKb: Math.max(0, value.reqKb), respKb: Math.max(0, value.respKb) } },
    })),

    addRack: (azId) => mutate(d => {
      const count = Object.values(d.racks).filter(r => r.azId === azId).length
      const rack = createRack(azId, `rack-${count + 1}`)
      return { ...d, racks: { ...d.racks, [rack.id]: rack } }
    }),
    updateRack: (id, patch) => mutate(d => {
      const existing = d.racks[id]
      if (!existing) return d
      const next = { ...existing, ...patch }
      if (patch.capacityU !== undefined) {
        const clamped = Math.min(RACK_CAPACITY_MAX, Math.max(RACK_CAPACITY_MIN, patch.capacityU))
        next.capacityU = Math.max(clamped, rackUsedU(d, id))
      }
      return { ...d, racks: { ...d.racks, [id]: next } }
    }),
    // Sends every resident server to the free pool, then deletes the rack — one mutate,
    // one undo step (the brief's explicit acceptance test).
    removeRack: (id) => mutate(d => {
      if (!d.racks[id]) return d
      const servers = Object.fromEntries(Object.entries(d.servers).map(([sid, s]) =>
        s.rack?.rackId === id ? [sid, { ...s, rack: null }] : [sid, s]))
      const racks = { ...d.racks }
      delete racks[id]
      return { ...d, servers, racks }
    }),
    assignServerToRack: (serverId, rackId) => mutate(d => {
      const server = d.servers[serverId]
      if (!server) return d
      if (rackId === null) {
        return { ...d, servers: { ...d.servers, [serverId]: { ...server, rack: null } } }
      }
      if (!canAssign(d, serverId, rackId)) return d
      const position = { rackId, unit: rackUsedU(d, rackId) + 1, heightU: serverHeightU(server) }
      return { ...d, servers: { ...d.servers, [serverId]: { ...server, rack: position } } }
    }),
    // Applies an autoArrangePlan's newRacks + all assignments in ONE mutate — one undo step.
    autoArrangeAz: (azId) => mutate(d => {
      const plan = autoArrangePlan(d, azId)
      const racks = { ...d.racks }
      for (const r of plan.newRacks) racks[r.id] = r
      const servers = { ...d.servers }
      for (const [sid, pos] of Object.entries(plan.assignments)) {
        servers[sid] = { ...servers[sid], rack: pos }
      }
      return { ...d, racks, servers }
    }),

    setScenario: (scenario) => mutate(d => ({ ...d, scenario: scenario ?? undefined })),
    addScenarioStep: (step) => mutate(d => {
      if (!d.scenario) return d
      return { ...d, scenario: { ...d.scenario, steps: [...d.scenario.steps, step] } }
    }),
    removeScenarioStep: (index) => mutate(d => {
      if (!d.scenario) return d
      return { ...d, scenario: { ...d.scenario, steps: d.scenario.steps.filter((_, i) => i !== index) } }
    }),
    updateScenarioStep: (index, step) => mutate(d => {
      if (!d.scenario) return d
      return { ...d, scenario: { ...d.scenario, steps: d.scenario.steps.map((s, i) => (i === index ? step : s)) } }
    }),

    // Audit ISSUE-031: history/future hold doc REFERENCES, not JSON deep clones. Every mutation
    // already replaces `doc` wholesale with a new structurally-shared immutable value (mutate()'s
    // contract — nothing in the store edits a doc in place), so the old
    // JSON.parse(JSON.stringify(doc)) round-trip per keystroke was pure waste: serialize+parse of
    // the whole world per edit, and up to 100 full-world copies of heap. Sharing references makes
    // pushHistory O(1) and history memory a small multiple of one doc.
    pushHistory: () => {
      const { doc, history } = get()
      const trimmed = history.length >= 100 ? history.slice(1) : history
      set({ history: [...trimmed, doc], future: [] })
    },
    undo: () => {
      const { history, doc, future } = get()
      if (history.length === 0) return
      set({
        doc: history[history.length - 1],
        history: history.slice(0, -1),
        future: [doc, ...future],
      })
      useFileStore.getState().setDirty(true)
    },
    redo: () => {
      const { future, doc, history } = get()
      if (future.length === 0) return
      set({
        doc: future[0],
        history: [...history, doc],
        future: future.slice(1),
      })
      useFileStore.getState().setDirty(true)
    },
  }
})
