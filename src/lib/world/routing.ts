// Pure routing-table + volume-consistency computation. Static ordering only — live health
// state and TTL-lagged cutover are the Phase-2 engine's job; it consumes these orders.
import type {
  WorldDoc, CompiledRouting, CompileFinding, ServiceInstance, InstanceId, Region, RegionId,
  ClientPopulation, ServiceBlueprint, LoadBalancer, BlueprintId,
} from './types'
import { REGION_GEO, greatCircleKm } from './regionGeo'

function distanceScore(popLat: number, popLon: number, region: Region): number {
  const geo = REGION_GEO[region.catalogId]
  if (!geo) return Number.MAX_SAFE_INTEGER
  return greatCircleKm(popLat, popLon, geo.lat, geo.lon)
}

// Latency model (audit ISSUE-009): light in fiber ≈ 200,000 km/s ⇒ ~0.01 ms RTT per km, plus a
// small LOCATION-INDEPENDENT per-region processing constant. The old formula added the region's
// baseLatencyMs — latency from a US-EAST reference client, not from this population — which
// biased every population on Earth toward regions near Virginia.
const PROPAGATION_MS_PER_KM = 0.01
const REGION_PROCESSING_MS = 2

// The per-population region ordering (latency/geo/weighted/priority policies) — extracted from
// computeRouting (Polish 4 T7, spec D9) so the globe's traffic-placement preview can compute the
// EXACT landing region for a not-yet-placed population (a city snap), not an estimate. Takes only
// {lat, lon} so a WorldCity (cityCatalog.ts) — which has no PopulationId — satisfies it too.
// Behavior-identical to the inline loop this replaced: routing.test.ts's golden orderings still
// pass unmodified.
export function regionOrderFor(pop: Pick<ClientPopulation, 'lat' | 'lon'>, doc: WorldDoc): RegionId[] {
  const regions = Object.values(doc.regions)
  const scored = regions.map(region => {
    const km = distanceScore(pop.lat, pop.lon, region)
    let score: number
    switch (doc.routing.policy) {
      case 'geo':      score = km; break
      // Population→region great-circle propagation + a constant processing term (ISSUE-009).
      case 'latency':  score = km * PROPAGATION_MS_PER_KM + REGION_PROCESSING_MS; break
      case 'weighted': score = -(doc.routing.weights[region.id] ?? 0) * 1e9 + km; break
      case 'priority': {
        const idx = doc.routing.priorityOrder.indexOf(region.id)
        score = (idx === -1 ? 1e6 : idx) * 1e9 + km
        break
      }
      // Defense in depth (audit ISSUE-012): a corrupt policy that slipped the file boundary must
      // never leave `score` undefined (an undefined score poisons the whole sort) — fall back to geo.
      default:         score = km; break
    }
    return { region, score }
  })
  scored.sort((a, b) => a.score - b.score)
  // Stable partition: passive regions to the end (spec D8 active-passive semantics).
  const active = scored.filter(s => s.region.role === 'active')
  const passive = scored.filter(s => s.region.role === 'passive')
  return [...active, ...passive].map(s => s.region.id)
}

export function computeRouting(
  doc: WorldDoc,
  instances: Record<InstanceId, ServiceInstance>,
): CompiledRouting {
  const regions = Object.values(doc.regions)
  const populationRegionOrder: CompiledRouting['populationRegionOrder'] = {}

  for (const pop of Object.values(doc.populations)) {
    populationRegionOrder[pop.id] = regionOrderFor(pop, doc)
  }

  const regionAzSpread: CompiledRouting['regionAzSpread'] = {}
  for (const region of regions) {
    regionAzSpread[region.id] = Object.values(doc.azs)
      .filter(az => az.regionId === region.id)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(az => az.id)
  }

  const azBlueprintTargets: CompiledRouting['azBlueprintTargets'] = {}
  for (const inst of Object.values(instances)) {
    const byBp = (azBlueprintTargets[inst.azId] ??= {})
    ;(byBp[inst.blueprintId] ??= []).push(inst.id)
  }
  for (const byBp of Object.values(azBlueprintTargets)) {
    for (const list of Object.values(byBp)) list.sort()
  }

  return { populationRegionOrder, regionAzSpread, azBlueprintTargets, lbRouting: computeLbRouting(doc, instances) }
}

// A blueprint is a client entry point when it exposes a 'public' port (the documented entry
// rule the engine's distribution reads).
function isEntryBlueprint(bp: ServiceBlueprint): boolean {
  return bp.ports.some(p => p.visibility === 'public')
}

// Resolves each region's regional LB (authored in doc.loadBalancers, else a synthesized default)
// into the CompiledLbRouting the engine consumes. The synthesized default is an NLB (L4,
// cross-zone off) whose targets are the region's entry blueprints — byte-equivalent to the
// pre-LB equal-per-AZ distribution. `defaultTargetBlueprintIds` lists only blueprints that
// actually have an instance in the region (a target with no instances would route nowhere).
function computeLbRouting(
  doc: WorldDoc,
  instances: Record<InstanceId, ServiceInstance>,
): CompiledRouting['lbRouting'] {
  const blueprintsByRegion = new Map<RegionId, Set<BlueprintId>>()
  for (const inst of Object.values(instances)) {
    let set = blueprintsByRegion.get(inst.regionId)
    if (!set) { set = new Set(); blueprintsByRegion.set(inst.regionId, set) }
    set.add(inst.blueprintId)
  }
  const lbByRegion = new Map<RegionId, LoadBalancer>()
  for (const lb of Object.values(doc.loadBalancers)) lbByRegion.set(lb.regionId, lb)

  const result: CompiledRouting['lbRouting'] = {}
  for (const region of Object.values(doc.regions)) {
    const present = blueprintsByRegion.get(region.id) ?? new Set<BlueprintId>()
    const lb = lbByRegion.get(region.id)
    const entryTargets = Object.values(doc.blueprints)
      .filter(bp => isEntryBlueprint(bp) && present.has(bp.id))
      .map(bp => bp.id)
      .sort()
    const defaultTargetBlueprintIds =
      lb?.defaultTargetBlueprintId != null
        ? (present.has(lb.defaultTargetBlueprintId) ? [lb.defaultTargetBlueprintId] : [])
        : entryTargets
    // L7 (ALB): resolve listener rules into compiled first-match rules, IN AUTHORED ORDER. Rules
    // are kept verbatim — even one whose target has no instance in the region — so first-match
    // semantics are accurate: a matching rule with an empty target group catches the route and
    // the engine drops it (AWS's "target group with no healthy targets → 503"), rather than the
    // route silently falling through to a later rule. The absent-target case is surfaced by the
    // analysis rule, not by reordering here. L4 (NLB) has no path routing ⇒ no rules.
    const rules = lb?.mode === 'l7'
      ? lb.listenerRules.map(r => ({ pathPattern: r.pathPattern, targetBlueprintId: r.targetBlueprintId }))
      : []
    result[region.id] = {
      mode: lb?.mode ?? 'l4',
      crossZone: lb?.crossZone ?? false,
      algorithm: lb?.algorithm ?? 'round-robin',
      rules,
      defaultTargetBlueprintIds,
    }
  }
  return result
}

export function volumeFindings(doc: WorldDoc): CompileFinding[] {
  const findings: CompileFinding[] = []

  for (const bp of Object.values(doc.blueprints)) {
    if (bp.stateful && !bp.volumeName) {
      findings.push({
        id: `finding-vol-${bp.id}`,
        severity: 'warning',
        kind: 'stateful-without-volume',
        message: `${bp.name} is stateful but has no volume configured — data is lost on restart`,
        affected: [bp.id],
      })
    }
  }

  for (const pl of Object.values(doc.placements)) {
    const bp = doc.blueprints[pl.blueprintId]
    const server = doc.servers[pl.serverId]
    if (!bp || !server || !bp.stateful || !bp.volumeName) continue
    if (pl.runtime.type !== 'container') continue
    const { stackName } = pl.runtime
    const stack = server.stacks.find(s => s.name === stackName)
    const hasVolume = stack?.volumes.some(v => v.name === bp.volumeName) ?? false
    if (!hasVolume) {
      findings.push({
        id: `finding-vol-${pl.id}`,
        severity: 'error',
        kind: 'missing-volume',
        message: `${bp.name} needs volume "${bp.volumeName}" but stack "${stackName}" on ${server.label} does not define it`,
        affected: [pl.id, server.id, bp.id],
      })
    }
  }

  return findings
}
