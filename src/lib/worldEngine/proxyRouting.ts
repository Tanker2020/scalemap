// src/lib/worldEngine/proxyRouting.ts
// The ONE place a self-hosted reverse proxy (BlueprintKind 'proxy') decides where its traffic
// goes. Every other blueprint kind calls EACH of its dependencies with its full admitted rps (a
// request to `web` makes one call to `api` AND one to `cache`); a proxy instead routes each request
// to exactly ONE upstream, so its dependencies receive FRACTIONS of its admitted rps that sum to
// at most 1. The remainder (`dropped`) is the L7 "no rule matched and no default" 503.
//
// PURE: no store, no rng, no React — deterministic arithmetic, so replay and the rng stream are
// untouched. The flow solver (flows.ts) is the only engine caller; analysis/UI surfaces that
// want to show "what share does this upstream get" call the same function rather than re-deriving.
import type { AzId, CompiledPath, InstanceId, ProxyConfig } from '../world/types'
import { routeMatchesPattern } from '../nodeConfig'

export interface ProxyFractions {
  byDep: Record<string, number>   // dependency id → fraction of the item's admitted rps
  dropped: number                 // fraction refused as a structural 503 (L7 only)
}

// `upstreamIds` are the proxy's ROUTABLE dependency ids in authored order — the caller excludes
// event-protocol edges (a proxy does not forward async events; compile flags them). `routeRps` is
// the route breakdown (path, '' for pathless → rps) of traffic that reached this proxy DIRECTLY
// from the regional LB; undefined means the traffic arrived from another service, where route
// identity no longer exists.
export function proxyDependencyFractions(
  cfg: ProxyConfig,
  upstreamIds: readonly string[],
  routeRps: Record<string, number> | undefined,
): ProxyFractions {
  const byDep: Record<string, number> = {}
  if (upstreamIds.length === 0) return { byDep, dropped: 1 }

  if (cfg.mode === 'l4') {
    let total = 0
    for (const id of upstreamIds) total += Math.max(0, cfg.upstreamWeights?.[id] ?? 1)
    if (total <= 0) return { byDep, dropped: 1 }   // every upstream drained
    for (const id of upstreamIds) {
      const w = Math.max(0, cfg.upstreamWeights?.[id] ?? 1)
      if (w > 0) byDep[id] = w / total
    }
    return { byDep, dropped: 0 }
  }

  // L7. A rule or default naming a dependency that isn't routable is skipped (compile reports it),
  // so first-match falls through to the next rule rather than black-holing the route.
  const routable = new Set(upstreamIds)
  const fallback = cfg.defaultDependencyId != null && routable.has(cfg.defaultDependencyId)
    ? cfg.defaultDependencyId : null
  const matchPath = (path: string): string | null => {
    if (path !== '') {
      for (const rule of cfg.listenerRules) {
        if (routable.has(rule.dependencyId) && routeMatchesPattern(path, rule.pathPattern)) return rule.dependencyId
      }
    }
    return fallback
  }

  let total = 0
  if (routeRps) for (const path in routeRps) total += Math.max(0, routeRps[path])
  if (total <= 0) {
    // Internal-origin (or an entry item carrying no route breakdown): the default upstream.
    if (fallback == null) return { byDep, dropped: 1 }
    byDep[fallback] = 1
    return { byDep, dropped: 0 }
  }
  let dropped = 0
  for (const path in routeRps!) {
    const share = Math.max(0, routeRps![path]) / total
    if (share <= 0) continue
    const dep = matchPath(path)
    if (dep == null) dropped += share
    else byDep[dep] = (byDep[dep] ?? 0) + share
  }
  return { byDep, dropped }
}

// Zone-aware upstream selection (ProxyConfig.preferLocalAz): wraps the flow solver's health
// weight so that, while ANY candidate in the proxy instance's own AZ can take traffic, every
// out-of-AZ candidate weighs 0. With no usable local candidate the base weights pass through
// unchanged and traffic crosses AZs. Managed targets (no instance) keep their base weight.
export function localAzWeightOverride(
  baseWeightOf: (id: InstanceId) => number,
  candidates: readonly CompiledPath[],
  proxyAzId: AzId,
  azOf: (id: InstanceId) => AzId | undefined,
): (id: InstanceId) => number {
  let localUsable = false
  for (const p of candidates) {
    if (p.to.kind === 'instance' && azOf(p.to.instanceId) === proxyAzId && baseWeightOf(p.to.instanceId) > 0) {
      localUsable = true
      break
    }
  }
  if (!localUsable) return baseWeightOf
  return (id: InstanceId) => (azOf(id) === proxyAzId ? baseWeightOf(id) : 0)
}
