// The examples vault (Polish 1 D4): four complete WorldDoc builders. Pure data — imports the
// world factories only (module-boundaries §P). Every entry's findings contract is enforced by
// exampleWorlds.test.ts: the three clean worlds compile to ZERO compile+analysis findings; the
// teaching world trips ≥10 analysis findings across all three families. Composition notes:
// - Single-region worlds carry NO population: no-failover-region fires critical for any
//   population whose region order has one entry, which would break their zero-findings contract.
//   (Auto-baseline was removed 2026-07-15, so these worlds show no live traffic until a population
//   is added — a deliberate trade to keep them finding-clean.)
// - multi-region's third population is São Paulo (not Singapore): passive regions sort to the
//   end of every routing order, so a population nearest the passive region would always trip
//   ocean-crossing-population.
import type { WorldDoc, Server, ServiceBlueprint, FirewallRule } from '../world/types'
import {
  createWorld, createRegion, createAz, createServer, createBlueprint, createPlacement,
  createPopulation,
} from '../world/factories'
import { getPreset } from '../world/instanceCatalog'

export interface VaultEntry {
  id: 'three-tier' | 'multi-region-failover' | 'event-driven' | 'broken-teaching'
  name: string
  blurb: string
  tags: string[]
  difficulty: 'beginner' | 'intermediate' | 'teaching'
  build: () => WorldDoc
}

// ── doc-building helpers (same idiom as src/lib/analysis/__fixtures__/worlds.ts) ──
function region(doc: WorldDoc, catalogId: string, role: 'active' | 'passive' = 'active') {
  const r = createRegion(catalogId); r.role = role; doc.regions[r.id] = r; return r
}
function az(doc: WorldDoc, regionId: string, label: string) {
  const a = createAz(regionId, label); doc.azs[a.id] = a; return a
}
function server(doc: WorldDoc, azId: string, presetId: string, label: string): Server {
  const s = createServer(azId, getPreset(presetId)!); s.label = label; doc.servers[s.id] = s; return s
}
function blueprint(doc: WorldDoc, name: string, colorIndex: number): ServiceBlueprint {
  const b = createBlueprint(name, colorIndex); doc.blueprints[b.id] = b; return b
}
function place(doc: WorldDoc, blueprintId: string, serverId: string, role: 'primary' | 'replica' = 'primary') {
  const p = createPlacement(blueprintId, serverId); p.role = role; doc.placements[p.id] = p; return p
}
function dep(id: string, target: { kind: 'blueprint'; blueprintId: string } | { kind: 'managed'; managedServiceId: string },
  port: number, protocol: 'http' | 'db' | 'event' | 'stream') {
  return { id, target, port, protocol, packetTemplateId: null }
}
const allowAny = (port: number): FirewallRule =>
  ({ id: `fw-${port}-any`, action: 'allow', port, protocol: 'tcp', source: 'any' })
const denyAny = (port: number): FirewallRule =>
  ({ id: `fw-${port}-deny`, action: 'deny', port, protocol: 'tcp', source: 'any' })

function threeTier(): WorldDoc {
  const doc = createWorld()
  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')
  const azb = az(doc, r.id, 'us-east-1b')

  const lb1 = server(doc, aza.id, 'vps-large', 'lb-01')
  const web1 = server(doc, aza.id, 'vps-large', 'web-01')
  const web2 = server(doc, azb.id, 'vps-large', 'web-02')
  const api1 = server(doc, azb.id, 'vps-large', 'api-01')
  const dbP = server(doc, aza.id, 'dedicated-8', 'db-primary')
  const dbR = server(doc, azb.id, 'dedicated-8', 'db-replica')

  lb1.firewall = [allowAny(443), ...lb1.firewall]

  const lb = blueprint(doc, 'lb', 1)
  lb.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const api = blueprint(doc, 'api', 2)
  api.ports = [{ port: 8081, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 3)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  db.stateful = true; db.volumeName = 'pgdata'
  lb.dependencies = [dep('d-lb-web', { kind: 'blueprint', blueprintId: web.id }, 8080, 'http')]
  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8081, 'http')]
  api.dependencies = [dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]

  place(doc, lb.id, lb1.id)
  place(doc, web.id, web1.id)
  place(doc, web.id, web2.id)
  place(doc, api.id, api1.id)
  place(doc, db.id, dbP.id, 'primary')
  place(doc, db.id, dbR.id, 'replica')
  // No populations: a single-region world's only population would trip no-failover-region. Shows
  // no live traffic until a population is added (auto-baseline removed 2026-07-15).
  return doc
}

function multiRegion(): WorldDoc {
  const doc = createWorld()
  doc.routing.dnsTtlSec = 20
  doc.routing.healthCheckIntervalMs = 3000
  doc.routing.healthCheckFailureThreshold = 2

  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const api = blueprint(doc, 'api', 1)
  api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 2)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  db.stateful = true; db.volumeName = 'pgdata'
  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8080, 'http')]
  api.dependencies = [dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]

  for (const catalogId of ['us-east-1', 'eu-west-1']) {
    const r = region(doc, catalogId)
    const aza = az(doc, r.id, `${catalogId}a`)
    const azb = az(doc, r.id, `${catalogId}b`)
    const webS = server(doc, aza.id, 'vps-large', `web-${catalogId}`)
    webS.firewall = [allowAny(443), ...webS.firewall]
    const apiS = server(doc, azb.id, 'vps-large', `api-${catalogId}`)
    const dbP = server(doc, aza.id, 'dedicated-8', `db-primary-${catalogId}`)
    const dbR = server(doc, azb.id, 'dedicated-8', `db-replica-${catalogId}`)
    place(doc, web.id, webS.id)
    place(doc, api.id, apiS.id)
    place(doc, db.id, dbP.id, 'primary')
    place(doc, db.id, dbR.id, 'replica')
  }
  const passive = region(doc, 'ap-southeast-1', 'passive')
  az(doc, passive.id, 'ap-southeast-1a')
  az(doc, passive.id, 'ap-southeast-1b')
  // Warm-standby placeholder: no servers — regions without instances are exempt from
  // single-az-region, and a population near a passive region would trip
  // ocean-crossing-population (grounded correction #2), hence São Paulo below.

  const nyc = createPopulation('NYC', 40.7, -74.0); nyc.peakRps = 400; doc.populations[nyc.id] = nyc
  const lon = createPopulation('London', 51.5, -0.1); lon.peakRps = 400; doc.populations[lon.id] = lon
  const sp = createPopulation('São Paulo', -23.5, -46.6); sp.peakRps = 200; doc.populations[sp.id] = sp
  return doc
}

function eventDriven(): WorldDoc {
  const doc = createWorld()
  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')
  const azb = az(doc, r.id, 'us-east-1b')

  const msId = 'ms-queue'
  doc.managedServices[msId] = { id: msId, label: 'Queue', nodeType: 'queue', scope: { kind: 'region', regionId: r.id }, provider: 'aws', port: 443 }

  const api = blueprint(doc, 'api', 0)
  api.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const worker = blueprint(doc, 'worker', 1)
  worker.ports = [{ port: 9000, protocol: 'tcp', visibility: 'internal' }]
  const store = blueprint(doc, 'store', 2)
  store.ports = [{ port: 5432, protocol: 'tcp', visibility: 'internal' }]
  store.stateful = true; store.volumeName = 'eventdata'
  api.dependencies = [dep('d-api-q', { kind: 'managed', managedServiceId: msId }, 443, 'event')]
  worker.dependencies = [
    dep('d-w-q', { kind: 'managed', managedServiceId: msId }, 443, 'event'),
    dep('d-w-store', { kind: 'blueprint', blueprintId: store.id }, 5432, 'db'),
  ]

  const api1 = server(doc, aza.id, 'vps-large', 'api-01')
  api1.firewall = [allowAny(443), ...api1.firewall]
  const api2 = server(doc, azb.id, 'vps-large', 'api-02')
  api2.firewall = [allowAny(443), ...api2.firewall]
  const w1 = server(doc, aza.id, 'vps-large', 'worker-01')
  w1.stacks = [{ name: 'workers', networks: [{ name: 'wnet', cidr: '172.19.0.0/16' }], volumes: [] }]
  const w2 = server(doc, azb.id, 'vps-large', 'worker-02')
  w2.stacks = [{ name: 'workers', networks: [{ name: 'wnet', cidr: '172.19.0.0/16' }], volumes: [] }]
  const st1 = server(doc, aza.id, 'dedicated-8', 'store-01')
  st1.stacks = [{ name: 'data', networks: [{ name: 'datanet', cidr: '172.20.0.0/16' }], volumes: [{ name: 'eventdata', sizeGb: 20 }] }]

  place(doc, api.id, api1.id)
  place(doc, api.id, api2.id)
  const wp1 = place(doc, worker.id, w1.id); wp1.count = 2
  wp1.runtime = { type: 'container', stackName: 'workers', networkNames: ['wnet'], portMappings: [], cpuLimit: null, memLimitMb: null }
  const wp2 = place(doc, worker.id, w2.id); wp2.count = 2
  wp2.runtime = { type: 'container', stackName: 'workers', networkNames: ['wnet'], portMappings: [], cpuLimit: null, memLimitMb: null }
  const sp1 = place(doc, store.id, st1.id)
  // The host port mapping is what keeps worker→store permitted cross-server.
  sp1.runtime = { type: 'container', stackName: 'data', networkNames: ['datanet'], portMappings: [{ host: 5432, container: 5432 }], cpuLimit: null, memLimitMb: null }
  // No populations: a single-region world's only population would trip no-failover-region. Shows
  // no live traffic until a population is added (auto-baseline removed 2026-07-15).
  return doc
}

function brokenTeaching(): WorldDoc {
  const doc = createWorld()
  doc.routing.dnsTtlSec = 5                    // ttl-outlives-detection: 5s TTL vs
  doc.routing.healthCheckIntervalMs = 12000    // 12s × 3 = 36s detection window
  doc.routing.healthCheckFailureThreshold = 3

  const r = region(doc, 'us-east-1')
  const aza = az(doc, r.id, 'us-east-1a')      // ONE AZ — single-az-region

  const webS = server(doc, aza.id, 'vps-medium', 'web-01')
  webS.firewall = [allowAny(443), ...webS.firewall]      // front door stays REACHABLE (correction #4)
  const apiS = server(doc, aza.id, 'vps-medium', 'api-01')
  const dbS = server(doc, aza.id, 'vps-small', 'db-01')
  dbS.firewall = [allowAny(5432), ...dbS.firewall]       // db-port-exposed (a)
  const cacheS = server(doc, aza.id, 'vps-small', 'cache-01')
  cacheS.firewall = [denyAny(6379), ...cacheS.firewall]  // blocked-dependency-path
  const adminS = server(doc, aza.id, 'vps-small', 'admin-01')  // default internal-only → entry-unreachable

  const web = blueprint(doc, 'web', 0)
  web.ports = [{ port: 443, protocol: 'tcp', visibility: 'public' }]
  const api = blueprint(doc, 'api', 1)
  api.ports = [{ port: 8080, protocol: 'tcp', visibility: 'internal' }]
  const auth = blueprint(doc, 'auth', 4)
  auth.ports = [{ port: 8100, protocol: 'tcp', visibility: 'internal' }]
  const profile = blueprint(doc, 'profile', 5)
  profile.ports = [{ port: 8200, protocol: 'tcp', visibility: 'internal' }]
  const db = blueprint(doc, 'db', 2)
  db.ports = [{ port: 5432, protocol: 'tcp', visibility: 'public' }]   // db-port-exposed (b)
  db.stateful = true; db.volumeName = null                             // stateful-without-volume (compile)
  db.workload = { ...db.workload, ramBaseMb: 2400 }                    // 2 × 2400 > 4096 → ram-oversubscribed
  const cache = blueprint(doc, 'cache', 3)
  cache.ports = [{ port: 6379, protocol: 'tcp', visibility: 'internal' }]
  const admin = blueprint(doc, 'admin', 1)
  admin.ports = [{ port: 8443, protocol: 'tcp', visibility: 'public' }]

  web.dependencies = [dep('d-web-api', { kind: 'blueprint', blueprintId: api.id }, 8080, 'http')]
  api.dependencies = [
    dep('d-api-auth', { kind: 'blueprint', blueprintId: auth.id }, 8100, 'http'),
    dep('d-api-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db'),
    dep('d-api-cache', { kind: 'blueprint', blueprintId: cache.id }, 6379, 'stream'),
  ]
  auth.dependencies = [dep('d-auth-profile', { kind: 'blueprint', blueprintId: profile.id }, 8200, 'http')]
  profile.dependencies = [dep('d-profile-db', { kind: 'blueprint', blueprintId: db.id }, 5432, 'db')]
  // web→api→auth→profile→db = 4 http/db hops → deep-sync-chain

  place(doc, web.id, webS.id)
  place(doc, api.id, apiS.id)
  place(doc, auth.id, apiS.id)
  place(doc, profile.id, apiS.id)
  place(doc, db.id, dbS.id, 'primary')
  place(doc, db.id, dbS.id, 'replica')   // primary + replica in the same AZ → replicas-colocated
  place(doc, cache.id, cacheS.id)
  place(doc, admin.id, adminS.id)

  doc.managedServices['ms-metrics'] = { id: 'ms-metrics', label: 'Metrics store', nodeType: 'redis', scope: { kind: 'az', azId: aza.id }, provider: 'aws', port: 6380 }
  // nothing depends on it → unused-managed-service

  const pop = createPopulation('customers', 40.7, -74.0)   // 1-region order → no-failover-region
  pop.peakRps = 500
  doc.populations[pop.id] = pop
  return doc
}

export const VAULT: VaultEntry[] = [
  {
    id: 'three-tier',
    name: 'Classic three-tier',
    blurb: 'LB-fronted web + api + replicated db across two AZs. The on-ramp.',
    tags: ['1 region', '6 servers'],
    difficulty: 'beginner',
    build: threeTier,
  },
  {
    id: 'multi-region-failover',
    name: 'Multi-region failover',
    blurb: 'Active/passive across three continents, TTL tuned so killing a region tells the whole DNS-lag story.',
    tags: ['3 regions', 'populations'],
    difficulty: 'intermediate',
    build: multiRegion,
  },
  {
    id: 'event-driven',
    name: 'Event-driven microservices',
    blurb: 'Services publishing through a managed queue to worker pools in compose stacks — networks, volumes, the works.',
    tags: ['1 region', 'queue + workers'],
    difficulty: 'intermediate',
    build: eventDriven,
  },
  {
    id: 'broken-teaching',
    name: 'Everything wrong at once',
    blurb: 'Exposed database, single-AZ SPOF, oversubscribed RAM, TTL slower than detection. Run the analysis, then fix it.',
    tags: ['teaching world', '12 findings'],
    difficulty: 'teaching',
    build: brokenTeaching,
  },
]
