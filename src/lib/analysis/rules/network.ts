// Network/security analysis rules (Phase 6 D2). Pure. Replicates a SOURCE-aware first-match firewall
// loop because src/lib/world/network.ts's evaluateFirewall ignores `source` (Phase-1 all-internal).
import type { AnalysisFinding, AnalysisRule } from '../types'
import type { FirewallRule } from '../../world/types'

// First rule (array order) that matches the port+tcp; null = default deny. Source-aware callers read
// match.action + match.source themselves.
function firewallFirstMatch(rules: FirewallRule[], port: number): FirewallRule | null {
  for (const r of rules) {
    const portOk = r.port === 'any' || r.port === port
    const protoOk = r.protocol === 'any' || r.protocol === 'tcp'
    if (portOk && protoOk) return r
  }
  return null
}
const openToAny = (rules: FirewallRule[], port: number): FirewallRule | null => {
  const m = firewallFirstMatch(rules, port)
  return m && m.action === 'allow' && m.source === 'any' ? m : null
}

const blockedDependencyPath: AnalysisRule = {
  id: 'blocked-dependency-path', family: 'network',
  run: ({ doc, compiled }) => {
    const out: AnalysisFinding[] = []
    for (const path of compiled.paths) {
      if (path.verdict !== 'blocked' || !path.blockReason || path.to.kind !== 'instance') continue
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

    // (a) db-protocol dependency whose target instance's server firewall allows the port from 'any'.
    for (const bp of Object.values(doc.blueprints)) {
      for (const d of bp.dependencies) {
        if (d.protocol !== 'db' || d.target.kind !== 'blueprint') continue
        const targetBpId = d.target.blueprintId
        for (const inst of Object.values(compiled.instances)) {
          if (inst.blueprintId !== targetBpId) continue
          const server = doc.servers[inst.serverId]; if (!server) continue
          const open = openToAny(server.firewall, d.port)
          if (!open) continue
          push({
            id: `db-port-exposed:${server.id}`, ruleId: 'db-port-exposed', family: 'network', severity: 'critical',
            title: 'Database port exposed to the internet',
            why: `Server ${server.label} allows db port ${d.port} from any source (rule ${open.id}); the database is reachable from the internet.`,
            fix: `Restrict rule ${open.id} to an internal/CIDR source or remove it (Server view → firewall).`,
            affected: [server.id, open.id],
          })
        }
      }
    }

    // (b) a blueprint that is a db-dependency target AND declares a public-visibility port.
    const dbTargets = new Set<string>()
    for (const bp of Object.values(doc.blueprints))
      for (const d of bp.dependencies)
        if (d.protocol === 'db' && d.target.kind === 'blueprint') dbTargets.add(d.target.blueprintId)
    for (const bpId of dbTargets) {
      const bp = doc.blueprints[bpId]
      if (!bp || !bp.ports.some(p => p.visibility === 'public')) continue
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
      const unreachable = publicPorts.find(p => ![...serverIds].some(sid => openToAny(doc.servers[sid]?.firewall ?? [], p.port)))
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

export const networkRules: AnalysisRule[] = [blockedDependencyPath, dbPortExposed, entryUnreachable]
