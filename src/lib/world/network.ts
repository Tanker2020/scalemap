// Pure network-path evaluation: firewall rules, port bindings, docker-network isolation.
// Semantics (spec D10 + plan "Semantics locked here"): same-server traffic never hits the
// firewall; cross-server evaluates the TARGET server's rules first-match-wins with default
// deny; in Phase 1 every in-world flow counts as 'internal' and CIDR sources match it.
//
// ── Firewall model, stated explicitly (audit ISSUE-064) ─────────────────────────────────────
// This is an ORDERED, FIRST-MATCH-WINS rule list with allow AND deny actions and an implicit
// default-deny — iptables/network-ACL semantics. It is deliberately NOT an AWS Security Group:
// an SG is an unordered permissive UNION (allow rules only, no deny, no ordering, implicit deny
// only as the absence of any allow). Users reasoning in SG terms should note the differences:
// a deny rule above an allow WINS here, and rule ORDER matters. One model, one evaluator
// (firewallFirstMatch below, audit ISSUE-063) — an SG-style union-allow mode would be a second
// evaluator behind a model flag, deliberately not implemented until authoring demand exists.
import type {
  Server, AvailabilityZone, FirewallRule, FirewallSource, ServiceBlueprint, PlacementRuntime,
  HopClass, BlockReason, Subnet, RouteTable, RouteTarget, SecurityGroup,
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

// THE first-match rule (audit ISSUE-063): the single definition of "which firewall rule
// matches a port" for BOTH the compile-side verdict (evaluateFirewall below) and the analysis
// rules (network.ts's openToAny/db-port-exposed/entry-unreachable read the returned rule's
// action + source themselves). Two divergent copies of this loop existed before — a latent
// security-logic split waiting to drift. null = no match = default deny.
export function firewallFirstMatch(rules: FirewallRule[], port: number): FirewallRule | null {
  for (const rule of rules) {
    const portMatches = rule.port === 'any' || rule.port === port
    const protocolMatches = rule.protocol === 'any' || rule.protocol === 'tcp' // all Phase-1 dep protocols ride tcp
    if (portMatches && protocolMatches) return rule
  }
  return null
}

export function evaluateFirewall(
  rules: FirewallRule[],
  port: number,
): { allowed: boolean; matchedRuleId: string | null } {
  const match = firewallFirstMatch(rules, port)
  if (match) return { allowed: match.action === 'allow', matchedRuleId: match.id }
  return { allowed: false, matchedRuleId: null } // default deny
}

// Route-table resolution (spec's original resolveRoute(sourceSubnet, destination, routeTables)
// assumed CIDR-aware destination matching; this codebase's Server/AvailabilityZone model carries
// no per-server IP address to match a destination CIDR against — hopClassBetween classifies
// purely by az/region id, never an address. Simplified to what the data model actually supports:
// same-VPC traffic is always 'local' (no route lookup needed, matching real VPC semantics);
// egress-needing traffic requires a non-local route in the table, found via a most-specific-
// prefix stand-in that in practice degenerates to "does any route exist with a non-local
// target" since this model has no destination CIDR to compare against yet.
export function resolveRoute(routeTable: RouteTable, needsEgress: boolean): RouteTarget | null {
  if (!needsEgress) return { kind: 'local' }
  const egressRoute = routeTable.routes.find(r => r.target.kind !== 'local')
  return egressRoute ? egressRoute.target : null
}

// Security-group evaluator: an unordered, allow-only UNION of every attached group's rules —
// genuinely different from evaluateFirewall's ordered first-match-wins semantics above. Any
// attached group with a matching rule allows; no group with a match denies (implicit deny is
// simply the absence of any match, never an explicit deny rule).
export function evaluateSecurityGroups(
  server: Server,
  securityGroups: Record<string, SecurityGroup>,
  port: number,
): { allowed: boolean; matchedGroupId: string | null } {
  for (const groupId of server.securityGroupIds ?? []) {
    const group = securityGroups[groupId]
    if (!group) continue
    const match = group.rules.find(r => r.port === port && r.protocol === 'tcp') // all Phase-1 dep protocols ride tcp, mirrors firewallFirstMatch above
    if (match) return { allowed: true, matchedGroupId: groupId }
  }
  return { allowed: false, matchedGroupId: null }
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
  fromSubnet?: Subnet | null       // resolved by the caller (compileWorld) when fromServer.subnetId is set
  fromRouteTable?: RouteTable | null
  needsEgress?: boolean            // true when hopClass is cross-region OR destination is a managed/internet target
  securityGroups?: Record<string, SecurityGroup>
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
  const { fromServer, toServer, fromRuntime, toRuntime, toBlueprint, port, azs, fromSubnet, fromRouteTable, needsEgress, securityGroups } = ctx
  const hopClass = hopClassBetween(fromServer, toServer, azs)
  const bindsPort = toBlueprint.ports.some(p => p.port === port)

  if (fromSubnet && fromRouteTable) {
    const target = resolveRoute(fromRouteTable, needsEgress ?? hopClass === 'cross-region')
    if (!target) {
      return blocked(hopClass, {
        kind: 'no-egress-route',
        detail: `${fromServer.label}'s subnet has no route to ${hopClass === 'cross-region' ? 'this region' : 'the destination'}`,
        firewallRuleId: null,
      })
    }
  }

  if (toRuntime.type === 'process') {
    if (!bindsPort) {
      return blocked(hopClass, {
        kind: 'no-port-binding',
        detail: `${toBlueprint.name} does not bind port ${port}`,
        firewallRuleId: null,
      })
    }
    if (hopClass === 'localhost') return permitted(hopClass)
    return firewallVerdict(toServer, port, hopClass, securityGroups)
  }

  // Container target.
  const sameServer = fromServer.id === toServer.id
  const sharedNetwork =
    sameServer &&
    fromRuntime.type === 'container' &&
    fromRuntime.stackName === toRuntime.stackName &&
    fromRuntime.networkNames.some(n => toRuntime.networkNames.includes(n))
  // Overlay networks span servers (audit ISSUE-065): Swarm/CNI semantics — co-networked
  // containers on DIFFERENT hosts communicate over the overlay without host port publishing.
  // The compose bridge (`networkNames`) stays per-host; only overlayNetworkNames cross it.
  const sharedOverlay =
    !sharedNetwork &&
    fromRuntime.type === 'container' &&
    fromRuntime.stackName === toRuntime.stackName &&
    (fromRuntime.overlayNetworkNames ?? []).some(n => (toRuntime.overlayNetworkNames ?? []).includes(n))

  if (sharedNetwork || sharedOverlay) {
    // Container-to-container over the bridge/overlay: the CONTAINER port must be bound.
    // A same-host hop stays 'localhost'; an overlay hop keeps its REAL network class (the
    // overlay removes the firewall/publishing barrier, not the physical distance).
    const overlayHop = sharedOverlay && !sameServer ? hopClass : 'localhost'
    if (!bindsPort) {
      return blocked(overlayHop, {
        kind: 'no-port-binding',
        detail: `${toBlueprint.name} container does not bind port ${port}`,
        firewallRuleId: null,
      })
    }
    return permitted(overlayHop)
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
  return firewallVerdict(toServer, mapping.host, hopClass, securityGroups)
}

function firewallVerdict(
  toServer: Server,
  port: number,
  hopClass: HopClass,
  securityGroups?: Record<string, SecurityGroup>,
): PathEvaluation {
  if (toServer.securityGroupIds?.length && securityGroups) {
    const sg = evaluateSecurityGroups(toServer, securityGroups, port)
    if (sg.allowed) return permitted(hopClass)
    return blocked(hopClass, {
      kind: 'firewall-deny',
      detail: `denied by security group on ${toServer.label} (port ${port}, no matching allow rule)`,
      firewallRuleId: null,
    })
  }
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
