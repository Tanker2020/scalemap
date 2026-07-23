// Pure network-path evaluation: firewall rules, port bindings, docker-network isolation.
// Semantics (spec D10 + plan "Semantics locked here"): same-server traffic never hits the
// firewall; cross-server evaluates the TARGET server's rules first-match-wins with default
// deny; in Phase 1 every in-world flow counts as 'internal' and CIDR sources match it.
import type {
  Server, AvailabilityZone, FirewallRule, FirewallSource, ServiceBlueprint, PlacementRuntime,
  HopClass, BlockReason,
} from './types'

// The single source of truth for "this source means the entire internet" (audit ISSUE-011):
// the literal 'any' plus every 0-length CIDR prefix — '0.0.0.0/0', '::/0', even '1.2.3.4/0'
// all admit every address. Consumed by the network-security analysis rules; source-aware
// firewall evaluation itself is still Phase-1 all-internal (see evaluateFirewall below).
export function isInternetSource(source: FirewallSource): boolean {
  if (source === 'any') return true
  const slash = source.lastIndexOf('/')
  if (slash === -1) return false
  const prefix = source.slice(slash + 1)
  return prefix !== '' && Number(prefix) === 0
}

export function evaluateFirewall(
  rules: FirewallRule[],
  port: number,
): { allowed: boolean; matchedRuleId: string | null } {
  for (const rule of rules) {
    const portMatches = rule.port === 'any' || rule.port === port
    const protocolMatches = rule.protocol === 'any' || rule.protocol === 'tcp' // all Phase-1 dep protocols ride tcp
    if (portMatches && protocolMatches) {
      return { allowed: rule.action === 'allow', matchedRuleId: rule.id }
    }
  }
  return { allowed: false, matchedRuleId: null } // default deny
}

export function hopClassBetween(
  fromServer: Server,
  toServer: Server,
  azs: Record<string, AvailabilityZone>,
): HopClass {
  if (fromServer.id === toServer.id) return 'localhost'
  if (fromServer.azId === toServer.azId) return 'same-az'
  const fromRegion = azs[fromServer.azId]?.regionId
  const toRegion = azs[toServer.azId]?.regionId
  return fromRegion === toRegion ? 'cross-az' : 'cross-region'
}

export interface InstancePathContext {
  fromServer: Server
  toServer: Server
  fromRuntime: PlacementRuntime
  toRuntime: PlacementRuntime
  toBlueprint: ServiceBlueprint
  port: number
  azs: Record<string, AvailabilityZone>
}

export interface PathEvaluation {
  hopClass: HopClass
  verdict: 'permitted' | 'blocked'
  blockReason: BlockReason | null
}

const blocked = (hopClass: HopClass, reason: BlockReason): PathEvaluation =>
  ({ hopClass, verdict: 'blocked', blockReason: reason })
const permitted = (hopClass: HopClass): PathEvaluation =>
  ({ hopClass, verdict: 'permitted', blockReason: null })

export function evaluateInstancePath(ctx: InstancePathContext): PathEvaluation {
  const { fromServer, toServer, fromRuntime, toRuntime, toBlueprint, port, azs } = ctx
  const hopClass = hopClassBetween(fromServer, toServer, azs)
  const bindsPort = toBlueprint.ports.some(p => p.port === port)

  if (toRuntime.type === 'process') {
    if (!bindsPort) {
      return blocked(hopClass, {
        kind: 'no-port-binding',
        detail: `${toBlueprint.name} does not bind port ${port}`,
        firewallRuleId: null,
      })
    }
    if (hopClass === 'localhost') return permitted(hopClass)
    return firewallVerdict(toServer, port, hopClass)
  }

  // Container target.
  const sameServer = fromServer.id === toServer.id
  const sharedNetwork =
    sameServer &&
    fromRuntime.type === 'container' &&
    fromRuntime.stackName === toRuntime.stackName &&
    fromRuntime.networkNames.some(n => toRuntime.networkNames.includes(n))

  if (sharedNetwork) {
    // Container-to-container over the compose bridge: the CONTAINER port must be bound.
    if (!bindsPort) {
      return blocked('localhost', {
        kind: 'no-port-binding',
        detail: `${toBlueprint.name} container does not bind port ${port}`,
        firewallRuleId: null,
      })
    }
    return permitted('localhost')
  }

  // Off-network access needs the container port published on the host.
  const mapping = toRuntime.portMappings.find(m => m.container === port)
  if (!mapping) {
    if (sameServer && fromRuntime.type === 'container') {
      return blocked('localhost', {
        kind: 'network-isolation',
        detail: `no shared docker network between containers and port ${port} is not published on the host`,
        firewallRuleId: null,
      })
    }
    return blocked(hopClass, {
      kind: 'no-port-binding',
      detail: `container port ${port} is not published via a host port mapping`,
      firewallRuleId: null,
    })
  }
  if (!bindsPort) {
    return blocked(hopClass, {
      kind: 'no-port-binding',
      detail: `${toBlueprint.name} does not bind container port ${port}`,
      firewallRuleId: null,
    })
  }
  if (hopClass === 'localhost') return permitted(hopClass)
  return firewallVerdict(toServer, mapping.host, hopClass)
}

function firewallVerdict(toServer: Server, port: number, hopClass: HopClass): PathEvaluation {
  const fw = evaluateFirewall(toServer.firewall, port)
  if (fw.allowed) return permitted(hopClass)
  return blocked(hopClass, {
    kind: 'firewall-deny',
    detail: fw.matchedRuleId
      ? `denied by firewall rule on ${toServer.label} (port ${port})`
      : `no matching allow rule on ${toServer.label} (default deny, port ${port})`,
    firewallRuleId: fw.matchedRuleId,
  })
}
