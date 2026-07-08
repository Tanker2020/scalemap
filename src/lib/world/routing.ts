// Pure routing-table + volume-consistency computation. Static ordering only — live health
// state and TTL-lagged cutover are the Phase-2 engine's job; it consumes these orders.
import type {
  WorldDoc, CompiledRouting, CompileFinding, ServiceInstance, InstanceId, Region,
} from './types'
import { REGION_GEO, greatCircleKm } from './regionGeo'
import { WORLD_REGIONS } from '../regionConfig'

function distanceScore(popLat: number, popLon: number, region: Region): number {
  const geo = REGION_GEO[region.catalogId]
  if (!geo) return Number.MAX_SAFE_INTEGER
  return greatCircleKm(popLat, popLon, geo.lat, geo.lon)
}

export function computeRouting(
  doc: WorldDoc,
  instances: Record<InstanceId, ServiceInstance>,
): CompiledRouting {
  const regions = Object.values(doc.regions)
  const populationRegionOrder: CompiledRouting['populationRegionOrder'] = {}

  for (const pop of Object.values(doc.populations)) {
    const scored = regions.map(region => {
      const km = distanceScore(pop.lat, pop.lon, region)
      const baseLatency = WORLD_REGIONS.find(w => w.id === region.catalogId)?.baseLatencyMs ?? 0
      let score: number
      switch (doc.routing.policy) {
        case 'geo':      score = km; break
        case 'latency':  score = km + baseLatency * 10; break
        case 'weighted': score = -(doc.routing.weights[region.id] ?? 0) * 1e9 + km; break
        case 'priority': {
          const idx = doc.routing.priorityOrder.indexOf(region.id)
          score = (idx === -1 ? 1e6 : idx) * 1e9 + km
          break
        }
      }
      return { region, score }
    })
    scored.sort((a, b) => a.score - b.score)
    // Stable partition: passive regions to the end (spec D8 active-passive semantics).
    const active = scored.filter(s => s.region.role === 'active')
    const passive = scored.filter(s => s.region.role === 'passive')
    populationRegionOrder[pop.id] = [...active, ...passive].map(s => s.region.id)
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

  return { populationRegionOrder, regionAzSpread, azBlueprintTargets }
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
