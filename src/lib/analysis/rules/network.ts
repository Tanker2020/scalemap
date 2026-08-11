// Network/security analysis rules (Phase 6 D2). Pure. Rule matching comes from the ONE shared
// evaluator in src/lib/world/network.ts (audit ISSUE-063 — this file used to carry its own copy
// of the first-match loop, a security-logic split waiting to drift); these rules stay the
// source-AWARE consumers, reading the matched rule's action + source themselves.
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { FirewallRule, Server, WorldDoc } from '../../world/types'
import { isInternetSource, firewallFirstMatch } from '../../world/network'
import { getRoute, routeMatchesPattern } from '../../nodeConfig'
// Internet-open = 'any' OR an all-covering CIDR like '0.0.0.0/0'/'::/0' (audit ISSUE-011) —
// shared by db-port-exposed (no false negatives) and entry-unreachable (no false positives).
const openToAny = (rules: FirewallRule[], port: number): FirewallRule | null => {
  const m = firewallFirstMatch(rules, port)
  return m && m.action === 'allow' && isInternetSource(m.source) ? m : null
}

// Final review Important #5: db-port-exposed/entry-unreachable used to read server.firewall
// unconditionally, ignoring securityGroupIds entirely. For an SG-governed server (subnetId set
// AND securityGroupIds non-empty) that's wrong in BOTH directions — an internet-open SG rule was
// never flagged (false negative on the flagship security finding), and a leftover permissive
// `firewall` rule WAS flagged even though it's inert underneath the SG. This mirrors the EXACT
// condition network.ts's firewallVerdict uses to decide which evaluator actually governs at
// compile/engine time (`toServer.securityGroupIds?.length` non-empty), so "is this port open to
// any source" always asks about whichever rule set is actually in force. SecurityGroupRule has no
// action/id (allow-only, unlike FirewallRule) — so the SG check is just "does ANY attached group
// have a matching internet-open rule", no first-match ordering needed.
function isPortOpenToAny(doc: WorldDoc, server: Server, port: number): boolean {
  if (server.securityGroupIds?.length) {
    return server.securityGroupIds.some(gid => {
      const group = doc.securityGroups[gid]
      return group?.rules.some(r => r.port === port && isInternetSource(r.source)) ?? false
    })
  }
  return openToAny(server.firewall, port) !== null
}

const blockedDependencyPath: AnalysisRule = {
  id: 'blocked-dependency-path', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const path of compiled.paths) {
      if (path.verdict !== 'blocked' || !path.blockReason || path.to.kind !== 'instance') continue
      // Final review Important #6: 'no-egress-route' paths are OWNED exclusively by the
      // dedicated noEgressRoute rule below (added Task 11), which reports them at the correct
      // 'warning' severity with routing-specific advice. Before this fix, the if/else-if chain's
      // trailing `else` branch swept 'no-egress-route' in too, at 'critical' severity, with
      // port-binding advice ("bind the port or publish it via a host port mapping") that made no
      // sense for a routing failure — and produced a second, contradictory finding for the SAME
      // root cause. Skipping here (rather than adding a correctly-worded branch) mirrors the
      // codebase's existing compile-finding-suppression discipline (AnalysisTab.tsx's
      // unsuppressedCompileFindings, which claims compile findings this rule already re-surfaces)
      // — one dedicated rule owns one BlockReasonKind's presentation, never two.
      if (path.blockReason.kind === 'no-egress-route') continue
      const targetId = path.to.instanceId
      const targetServerId = compiled.instances[targetId]?.serverId ?? ''
      const server = doc.servers[targetServerId]
      const br = path.blockReason
      let fix: string
      if (br.kind === 'firewall-deny') {
        fix = `Rule ${br.firewallRuleId ?? '(default deny)'} on ${server?.label ?? targetServerId} blocks this port — add an allow rule above it in the server's firewall (Server view → firewall).`
      } else if (br.kind === 'network-isolation') {
        fix = `${br.detail} — put both containers on a shared compose network or publish the port on the host (Server view → runtime).`
      } else {
        fix = `${br.detail} — bind the port or publish it via a host port mapping (Server view → runtime).`
      }
      const fromName = doc.blueprints[compiled.instances[path.fromInstanceId]?.blueprintId ?? '']?.name ?? path.fromInstanceId
      const toName = doc.blueprints[compiled.instances[targetId]?.blueprintId ?? '']?.name ?? targetId
      out.push({
        id: `blocked-dependency-path:${path.id}`, // embeds the compiled path id for D4 suppression
        ruleId: 'blocked-dependency-path', family: 'network', severity: 'critical',
        title: 'Blocked dependency path',
        why: `${fromName} cannot reach ${toName}: ${br.detail}.`,
        fix,
        affected: [path.fromInstanceId, targetId, targetServerId].filter(Boolean),
      })
    }
    return out
  },
}

const dbPortExposed: AnalysisRule = {
  id: 'db-port-exposed', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    const emitted = new Set<string>()
    const push = (f: AnalysisFinding) => { if (!emitted.has(f.id)) { emitted.add(f.id); out.push(f) } }

    // (a) db-protocol dependency whose target instance's server (firewall OR, when SG-governed,
    // its attached security groups — see isPortOpenToAny above) allows the port from 'any'.
    for (const bp of Object.values(doc.blueprints)) {
      for (const d of bp.dependencies) {
        if (d.protocol !== 'db' || d.target.kind !== 'blueprint') continue
        const targetBpId = d.target.blueprintId
        for (const inst of Object.values(compiled.instances)) {
          if (inst.blueprintId !== targetBpId) continue
          const server = doc.servers[inst.serverId]; if (!server) continue
          const sgGoverned = (server.securityGroupIds?.length ?? 0) > 0
          if (!isPortOpenToAny(doc, server, d.port)) continue
          const via = sgGoverned
            ? `a security group attached to ${server.label}`
            : `Server ${server.label}`
          push({
            id: `db-port-exposed:${server.id}`, ruleId: 'db-port-exposed', family: 'network', severity: 'critical',
            title: 'Database port exposed to the internet',
            why: `${via} allows db port ${d.port} from any source; the database is reachable from the internet.`,
            fix: sgGoverned
              ? `Restrict the security group rule for port ${d.port} to an internal/CIDR source or remove it (Network panel → security groups).`
              : `Restrict the firewall rule for port ${d.port} to an internal/CIDR source or remove it (Server view → firewall).`,
            affected: [server.id],
          })
        }
      }
    }

    // (b) a blueprint that is a db-dependency target AND declares a public-visibility port.
    // Placement-gated (audit ISSUE-068): a never-deployed blueprint is a design sketch, not a
    // live exposure — sub-rule (a) already walks placed instances, and (b) must match that bar
    // instead of flagging "critical" on something with zero compiled instances.
    const placedBlueprints = new Set<string>()
    for (const inst of Object.values(compiled.instances)) placedBlueprints.add(inst.blueprintId)
    const dbTargets = new Set<string>()
    for (const bp of Object.values(doc.blueprints))
      for (const d of bp.dependencies)
        if (d.protocol === 'db' && d.target.kind === 'blueprint') dbTargets.add(d.target.blueprintId)
    for (const bpId of dbTargets) {
      const bp = doc.blueprints[bpId]
      if (!bp || !placedBlueprints.has(bpId) || !bp.ports.some(p => p.visibility === 'public')) continue
      push({
        id: `db-port-exposed:${bp.id}`, ruleId: 'db-port-exposed', family: 'network', severity: 'critical',
        title: 'Database blueprint has a public port',
        why: `${bp.name} is used as a database dependency but declares a public-visibility port; its data plane is internet-facing.`,
        fix: `Change ${bp.name}'s port visibility to internal (Blueprints panel).`,
        affected: [bp.id],
      })
    }
    return out
  },
}

const entryUnreachable: AnalysisRule = {
  id: 'entry-unreachable', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const bp of Object.values(doc.blueprints)) {
      const publicPorts = bp.ports.filter(p => p.visibility === 'public')
      if (publicPorts.length === 0) continue
      const serverIds = new Set<string>()
      for (const inst of Object.values(compiled.instances)) if (inst.blueprintId === bp.id) serverIds.add(inst.serverId)
      if (serverIds.size === 0) continue // not placed — not a live front door
      const unreachable = publicPorts.find(p => ![...serverIds].some(sid => {
        const hostServer = doc.servers[sid]
        return hostServer && isPortOpenToAny(doc, hostServer, p.port)
      }))
      if (!unreachable) continue
      const names = [...serverIds].map(sid => doc.servers[sid]?.label ?? sid).join(', ')
      out.push({
        id: `entry-unreachable:${bp.id}`, ruleId: 'entry-unreachable', family: 'network', severity: 'warning',
        title: 'Entry point unreachable from the internet',
        why: `${bp.name} exposes public port ${unreachable.port} but none of its hosting servers (${names}) allow that port from the internet; the front door is firewalled shut.`,
        fix: `Add an allow rule for port ${unreachable.port} from source 'any' on a hosting server's firewall (Server view → firewall).`,
        affected: [bp.id, ...serverIds],
      })
    }
    return out
  },
}

// L7 load balancer: a listener rule pointing at a service with no instance in the LB's region.
// The compiled rule is kept for accurate first-match, but its target group is empty, so any
// traffic the rule catches is dropped (AWS ALB "target group with no healthy targets").
const lbListenerTargetAbsent: AnalysisRule = {
  id: 'lb-listener-target-absent', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    const presentByRegion = new Map<string, Set<string>>()
    for (const inst of Object.values(compiled.instances)) {
      let set = presentByRegion.get(inst.regionId)
      if (!set) { set = new Set(); presentByRegion.set(inst.regionId, set) }
      set.add(inst.blueprintId)
    }
    for (const lb of Object.values(doc.loadBalancers)) {
      if (lb.mode !== 'l7') continue
      const present = presentByRegion.get(lb.regionId) ?? new Set<string>()
      const regionName = doc.regions[lb.regionId]?.catalogId ?? lb.regionId
      for (const rule of lb.listenerRules) {
        if (present.has(rule.targetBlueprintId)) continue
        const bpName = doc.blueprints[rule.targetBlueprintId]?.name ?? '(deleted service)'
        out.push({
          id: `lb-listener-target-absent:${lb.id}:${rule.id}`,
          ruleId: 'lb-listener-target-absent', family: 'network', severity: 'warning',
          title: 'Listener rule targets an absent service',
          why: `The ${regionName} load balancer routes ${rule.pathPattern} to ${bpName}, which has no instance in that region — matching traffic is dropped.`,
          fix: `Place ${bpName} in ${regionName}, or repoint the rule to a service present there (Region config → load balancer).`,
          affected: [lb.regionId, rule.targetBlueprintId].filter(Boolean),
        })
      }
    }
    return out
  },
}

// A population's request-mix class that reaches an L7 region but matches NO listener rule and the
// LB has no default action — the traffic has nowhere to go and is dropped. (An unmatched route
// with a default action lands there instead and is fine; a matched-but-absent target is the rule
// above.) The population's steady-state region is its first routing choice.
const lbRouteDropped: AnalysisRule = {
  id: 'lb-route-dropped', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const pop of Object.values(doc.populations)) {
      if (!pop.requestMix || pop.requestMix.length === 0) continue
      const regionId = compiled.routing.populationRegionOrder[pop.id]?.[0]
      if (!regionId) continue
      const lb = compiled.routing.lbRouting[regionId]
      if (!lb || lb.mode !== 'l7') continue
      if (lb.defaultTargetBlueprintIds.length > 0) continue   // an unmatched class still hits the default action
      const regionName = doc.regions[regionId]?.catalogId ?? regionId
      for (const entry of pop.requestMix) {
        if (entry.weight <= 0) continue
        const route = getRoute(doc.packets, entry.routeId)
        const path = route?.path
        if (path != null && lb.rules.some(r => routeMatchesPattern(path, r.pathPattern))) continue
        const label = route ? `${route.method} ${route.path}` : `an unknown route (${entry.routeId})`
        out.push({
          id: `lb-route-dropped:${pop.id}:${entry.routeId}`,
          ruleId: 'lb-route-dropped', family: 'network', severity: 'warning',
          title: 'Request-mix route is dropped',
          why: `${pop.label} sends ${label} to ${regionName}, but its L7 load balancer has no matching listener rule and no default action — this traffic is dropped.`,
          fix: `Add a listener rule for this path or set a default target on the ${regionName} load balancer (Region config → load balancer).`,
          affected: [pop.id, regionId],
        })
      }
    }
    return out
  },
}

// A compiled path blocked because its source subnet's route table has no egress route (Task 6's
// resolveRoute returning null). Distinct from firewall-deny: nothing in the world is denying the
// traffic, there is simply no route out of the subnet at all.
const noEgressRoute: AnalysisRule = {
  id: 'no-egress-route', family: 'network',
  run: ({ compiled }) => {
    const out: AnalysisFinding[] = []
    for (const path of compiled.paths) {
      if (path.verdict !== 'blocked' || path.blockReason?.kind !== 'no-egress-route') continue
      out.push({
        id: `no-egress-route:${path.id}`,
        ruleId: 'no-egress-route', family: 'network', severity: 'warning',
        title: 'Subnet has no egress route',
        why: path.blockReason.detail,
        fix: 'Add a route to an internet gateway or NAT gateway in this subnet\'s route table.',
        affected: [path.fromInstanceId],
      })
    }
    return out
  },
}

// A security group rule's `source` names another group's id, and that group lives in a
// different VPC. Compile-side evaluateSecurityGroups (src/lib/world/network.ts) never reads
// `rule.source` at all -- it matches purely on port+protocol -- so this is analysis-only
// semantics, exactly mirroring how FirewallRule.source is likewise unenforced at compile time
// and only interpreted by db-port-exposed/entry-unreachable's isInternetSource() above. There is
// no VPC peering entity in this feature's scope (FEAT-014), so any cross-VPC reference is
// unconditionally treated as unpeered.
const unpeeredSecurityGroupReference: AnalysisRule = {
  id: 'unpeered-security-group-reference', family: 'network',
  run: ({ doc }) => {
    const out: AnalysisFinding[] = []
    for (const group of Object.values(doc.securityGroups)) {
      for (const rule of group.rules) {
        const referenced = doc.securityGroups[rule.source]
        if (!referenced || referenced.id === group.id || referenced.vpcId === group.vpcId) continue
        out.push({
          id: `unpeered-security-group-reference:${group.id}:${referenced.id}`,
          ruleId: 'unpeered-security-group-reference', family: 'network', severity: 'warning',
          title: 'Security group references a group in an unpeered VPC',
          why: `${group.label} allows traffic from ${referenced.label}, which lives in a different VPC with no peering configured.`,
          fix: 'Reference a group in the same VPC, or use a CIDR source instead.',
          affected: [group.id, referenced.id],
        })
      }
    }
    return out
  },
}

// More than one AZ's private subnets all route their egress through the SAME NAT gateway: that
// gateway is a single point of failure across availability zones (an AZ outage taking down the
// NAT gateway's own AZ breaks egress for every other AZ sharing it too).
const natGatewaySpof: AnalysisRule = {
  id: 'nat-gateway-spof', family: 'network',
  run: ({ doc }) => {
    const out: AnalysisFinding[] = []
    const azsByNatGateway = new Map<string, Set<string>>()
    for (const subnet of Object.values(doc.subnets)) {
      if (subnet.kind !== 'private') continue
      const rt = doc.routeTables[subnet.routeTableId]
      const natRoute = rt?.routes.find(r => r.target.kind === 'natGateway')
      if (!natRoute || natRoute.target.kind !== 'natGateway') continue
      const set = azsByNatGateway.get(natRoute.target.id) ?? new Set<string>()
      set.add(subnet.azId)
      azsByNatGateway.set(natRoute.target.id, set)
    }
    for (const [natId, azSet] of azsByNatGateway) {
      if (azSet.size <= 1) continue
      const natLabel = doc.natGateways[natId]?.label ?? natId
      out.push({
        id: `nat-gateway-spof:${natId}`,
        ruleId: 'nat-gateway-spof', family: 'network', severity: 'warning',
        title: 'NAT gateway is a single point of failure across availability zones',
        why: `${azSet.size} availability zones' private subnets all route their egress through the same NAT gateway (${natLabel}).`,
        fix: 'Provision one NAT gateway per availability zone.',
        affected: [natId],
      })
    }
    return out
  },
}

export const networkRules: AnalysisRule[] = [
  blockedDependencyPath, dbPortExposed, entryUnreachable, lbListenerTargetAbsent, lbRouteDropped,
  noEgressRoute, unpeeredSecurityGroupReference, natGatewaySpof,
]
