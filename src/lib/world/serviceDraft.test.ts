import { describe, it, expect } from 'vitest'
import { defaultDraft, draftWorkload, draftPorts, HOSTABLE_KINDS, COST_MS } from './serviceDraft'

describe('HOSTABLE_KINDS', () => {
  // A database needs its own box (it comes from the AZ palette as an appliance, and its blueprint
  // carries ownerServerKind). Offering a db kind in a form that mounts onto a general-purpose host
  // would create a service that canHost() then refuses to place.
  it('excludes the db kinds, which are appliance-only', () => {
    expect(HOSTABLE_KINDS).not.toContain('db-sql')
    expect(HOSTABLE_KINDS).not.toContain('db-nosql')
  })

  it('offers api, worker and cache', () => {
    expect([...HOSTABLE_KINDS]).toEqual(['api', 'worker', 'cache'])
  })
})

describe('draftWorkload', () => {
  it('maps the cost preset onto cpu-ms per request', () => {
    expect(draftWorkload('api', 'light', 'small').cpuMsPerRequest).toBe(COST_MS.light)
    expect(draftWorkload('api', 'medium', 'small').cpuMsPerRequest).toBe(COST_MS.medium)
    expect(draftWorkload('api', 'heavy', 'small').cpuMsPerRequest).toBe(COST_MS.heavy)
  })

  it('scales base and per-connection memory together across the memory presets', () => {
    const small = draftWorkload('api', 'medium', 'small')
    const large = draftWorkload('api', 'medium', 'large')
    expect(large.ramBaseMb).toBeGreaterThan(small.ramBaseMb)
    expect(large.ramPerConnMb).toBeGreaterThan(small.ramPerConnMb)
  })

  // The presets ARE the WorkloadProfile — not a parallel model the engine has to learn about.
  // Advanced shows these same numbers, so every field the engine reads must be populated.
  it('produces a complete WorkloadProfile', () => {
    expect(Object.keys(draftWorkload('api', 'medium', 'small')).sort())
      .toEqual([
        'cpuMsPerRequest',
        'diskIoPerRequest',
        'coldStartMs',
        'ramBaseMb',
        'ramPerConnMb',
        'warmCapacityFraction',
      ].sort())
  })
})

describe('draftWorkload cold-start defaults', () => {
  // 'db-sql'/'db-nosql' aren't HostableKind (they're appliance-only, see HOSTABLE_KINDS above),
  // so this uses a heavy/large cache preset to stand in for the "db-flavored heavy workload" the
  // brief describes — coldStartMs is driven purely by the cost preset, not by kind.
  it('gives a heavy workload a visibly longer cold start than a light worker', () => {
    const heavy = draftWorkload('cache', 'heavy', 'large')
    const worker = draftWorkload('worker', 'light', 'small')
    expect(heavy.coldStartMs).toBeGreaterThan(worker.coldStartMs!)
    expect(worker.coldStartMs).toBeGreaterThan(0)
  })

  it('always sets warmCapacityFraction between 0 and 1', () => {
    const w = draftWorkload('api', 'medium', 'medium')
    expect(w.warmCapacityFraction).toBeGreaterThan(0)
    expect(w.warmCapacityFraction).toBeLessThanOrEqual(1)
  })
})

describe('defaultDraft', () => {
  it('starts an api on an internal port', () => {
    const draft = defaultDraft('api')
    expect(draft.kind).toBe('api')
    expect(draft.port).toBe(8080)
    expect(draft.visibility).toBe('internal')
  })

  // A worker pulls work rather than serving it, so it binds nothing. Giving it a port would put a
  // phantom listener into compileWorld's port/firewall reasoning.
  it('gives a worker no inbound port', () => {
    expect(defaultDraft('worker').port).toBeNull()
  })

  it('starts a cache memory-heavy and cheap per request', () => {
    const draft = defaultDraft('cache')
    expect(draft.memory).toBe('large')
    expect(draft.cost).toBe('light')
    expect(draft.port).toBe(6379)
  })
})

describe('draftPorts', () => {
  it('emits one port binding for a port-bearing draft', () => {
    const ports = draftPorts({ ...defaultDraft('api'), port: 8443, visibility: 'public' })
    expect(ports).toEqual([{ port: 8443, protocol: 'tcp', visibility: 'public' }])
  })

  it('emits no bindings for a portless draft', () => {
    expect(draftPorts(defaultDraft('worker'))).toEqual([])
  })
})
