// Plain-words rendering of a firewall rule (Polish 2 D7). Pure — the InspectorRail renders
// the pieces with tint/bold spans; this string form is the single copy source both use.
import type { FirewallRule } from '../../../lib/world/types'

export const PORT_SERVICE_WORDS: Record<number, string> = {
  443: 'https', 80: 'http', 5432: 'postgres', 6379: 'redis', 22: 'ssh',
}

export function ruleSourceWords(source: FirewallRule['source']): string {
  return source === 'any' ? 'anyone' : source === 'internal' ? 'internal traffic' : source
}

export function rulePortPhrase(rule: FirewallRule): string {
  if (rule.port === 'any') return 'any port'
  const svc = PORT_SERVICE_WORDS[rule.port]
  return `${svc ? `${svc} ` : ''}:${rule.port}`
}

// Protocol appended only for udp — tcp is the default voice, and 'any' on the factory
// default rule (`allow any any internal`) would read "…any port any" (plan decision 11).
export function ruleSentence(rule: FirewallRule): string {
  const proto = rule.protocol === 'udp' ? ' udp' : ''
  return rule.action === 'allow'
    ? `Let ${ruleSourceWords(rule.source)} reach ${rulePortPhrase(rule)}${proto}`
    : `Block ${ruleSourceWords(rule.source)} reaching ${rulePortPhrase(rule)}${proto}`
}
