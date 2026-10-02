// src/lib/world/serviceDraft.ts
// The vocabulary the "add a service" form speaks, and its translation into the engine's.
//
// Authoring a service used to mean filling in four raw physics numbers — cpu-ms per request, ram
// base, ram per connection, disk io per request — identically for an API and a database. This
// module gives the form a smaller, human vocabulary (kind + a cost preset + a memory preset) and
// maps it onto exactly the same `WorkloadProfile` the engine already reads.
//
// The presets ARE the WorkloadProfile. There is no parallel model, no second source of truth, and
// nothing new for the engine to learn: the form's Advanced disclosure edits these very numbers, so
// a preset is just a named starting point a user can then walk away from.
//
// PURE: no React, no store — node-env testable, same contract as spread.ts/rackModel.ts beside it.
import type { BlueprintKind, ServicePort, WorkloadProfile } from './types'

// The kinds you can mount on a GENERAL-PURPOSE host. Deliberately excludes 'db-sql'/'db-nosql':
// a database arrives as an appliance node from the AZ palette, carrying its own box, and its
// blueprint's `ownerServerKind` makes spread's canHost() refuse it on a plain VPS. Offering a db
// kind here would let the form create a service nothing can host.
export const HOSTABLE_KINDS = ['api', 'worker', 'cache', 'proxy'] as const satisfies readonly BlueprintKind[]
export type HostableKind = typeof HOSTABLE_KINDS[number]

export type CostPreset = 'light' | 'medium' | 'heavy'
export type MemoryPreset = 'small' | 'medium' | 'large'

// CPU milliseconds of work one request costs. These directly set how fast a host saturates in the
// simulation, so they are a teaching decision as much as a default: 'light' is a thin proxy or
// cache lookup, 'medium' a typical JSON endpoint doing a query or two, 'heavy' something doing
// real work per request (rendering, serialization of a big payload, a fan-out of calls).
export const COST_MS: Record<CostPreset, number> = { light: 2, medium: 8, heavy: 25 }

// A reverse proxy's per-request CPU is an order of magnitude below an app's: it parses headers and
// copies bytes, it doesn't run business logic. 'light' is a plain L4/L7 forward, 'medium' adds TLS
// termination, 'heavy' is WAF-style inspection or heavy header rewriting. Payload size adds its own
// per-KB cost (PROXY_CPU_MS_PER_KB) — TLS and buffer copies scale with bytes, not requests.
export const PROXY_COST_MS: Record<CostPreset, number> = { light: 0.2, medium: 0.5, heavy: 1.5 }
export const PROXY_CPU_MS_PER_KB = 0.01
// Proxies hold connections cheaply (event-loop buffers, not a thread or an app session each):
// ~100 KB per connection whatever the memory preset, which only moves the baseline.
export const PROXY_RAM_PER_CONN_MB = 0.1

// Cold-start time (FEAT-007): how long a freshly-started instance takes to reach full rated
// capacity. Scales with the cost preset on the same reasoning as COST_MS itself — a heavier
// workload (more to warm up: JIT/caches/connection pools/query planning) takes longer to become
// fully productive than a thin proxy.
export const COLD_START_MS: Record<CostPreset, number> = { light: 2_000, medium: 8_000, heavy: 30_000 }

// Capacity available at t=0 as a fraction of rated capacity, ramping to 1 as the instance warms
// up. One flat default across all presets — see hostScheduler.ts's warmthOf (Task 2) for the ramp.
export const WARM_CAPACITY_FRACTION = 0.3

// Base footprint plus per-connection growth. Both move together: a service that holds more state
// per connection generally holds a bigger baseline too.
export const MEMORY_MB: Record<MemoryPreset, { base: number; perConn: number }> = {
  small: { base: 512, perConn: 2 },
  medium: { base: 2048, perConn: 4 },
  large: { base: 8192, perConn: 8 },
}

export interface ServiceDraft {
  name: string
  kind: HostableKind
  cost: CostPreset
  memory: MemoryPreset
  /** null ⇒ binds nothing inbound (a worker pulls work rather than serving it). */
  port: number | null
  visibility: 'public' | 'internal'
  // Hand-tuned override from the form's Advanced disclosure. Absent ⇒ derive from the presets.
  // Presets are a starting point, not a ceiling: a user who opens Advanced and types a number
  // means it, and a user who then picks a preset means THAT — whichever came last wins, which is
  // why this is an explicit field rather than a flag saying "was edited".
  workload?: WorkloadProfile
}

export function draftWorkload(kind: HostableKind, cost: CostPreset, memory: MemoryPreset): WorkloadProfile {
  const ram = MEMORY_MB[memory]
  if (kind === 'proxy') {
    return {
      cpuMsPerRequest: PROXY_COST_MS[cost],
      cpuMsPerKb: PROXY_CPU_MS_PER_KB,
      ramBaseMb: ram.base,
      ramPerConnMb: PROXY_RAM_PER_CONN_MB,
      diskIoPerRequest: 0,
      // A proxy has nothing to warm (no JIT-heavy app code, no caches): the lightest cold start.
      coldStartMs: COLD_START_MS.light,
      warmCapacityFraction: WARM_CAPACITY_FRACTION,
    }
  }
  return {
    cpuMsPerRequest: COST_MS[cost],
    ramBaseMb: ram.base,
    ramPerConnMb: ram.perConn,
    // Disk IO stays at zero by default for every hostable kind — none of api/worker/cache is
    // inherently disk-bound (that is what the DB appliance is for). Advanced can raise it.
    diskIoPerRequest: 0,
    coldStartMs: COLD_START_MS[cost],
    warmCapacityFraction: WARM_CAPACITY_FRACTION,
  }
}

// Per-kind starting points. The kind picker is the form's first control precisely because it
// changes what the rest of the form asks.
export function defaultDraft(kind: HostableKind): ServiceDraft {
  switch (kind) {
    case 'worker':
      // No inbound port: a worker consumes from a queue. A phantom listener here would enter
      // compileWorld's port/firewall reasoning and show up as a bindable target it isn't.
      return { name: '', kind, cost: 'medium', memory: 'small', port: null, visibility: 'internal' }
    case 'cache':
      // Memory-dominant and near-free per request — the shape that makes a cache worth having.
      return { name: '', kind, cost: 'light', memory: 'large', port: 6379, visibility: 'internal' }
    case 'proxy':
      // The edge of the stack: public on 443 by default, since fronting clients is what a reverse
      // proxy is for. Light per request, small footprint.
      return { name: '', kind, cost: 'light', memory: 'small', port: 443, visibility: 'public' }
    case 'api':
    default:
      // Internal by default: exposure to the internet is opted into, never assumed — the same
      // stance createServer takes with its default-internal firewall rule.
      return { name: '', kind, cost: 'medium', memory: 'small', port: 8080, visibility: 'internal' }
  }
}

export function draftPorts(draft: ServiceDraft): ServicePort[] {
  if (draft.port === null) return []
  return [{ port: draft.port, protocol: 'tcp', visibility: draft.visibility }]
}
