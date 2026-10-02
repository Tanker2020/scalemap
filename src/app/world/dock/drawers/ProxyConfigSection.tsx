// src/app/world/dock/drawers/ProxyConfigSection.tsx
// The routing table of a self-hosted reverse proxy (BlueprintKind 'proxy'), rendered inside
// EditServiceForm. A proxy's upstreams ARE its dependency edges — authored in the Connections
// graph, never here — so this section only decides how traffic is divided among them:
//   L4 — a relative weight per upstream (one-of split; 0 drains an upstream).
//   L7 — ordered path rules → upstream, plus a default upstream (or "none", a 503).
// Plus zone-aware routing (prefer same-AZ upstream instances). Every write is one updateBlueprint
// (mutate()-wrapped: undo + dirty); the whole section is edit-locked while the simulation runs.
// What the engine does with these numbers lives in worldEngine/proxyRouting.ts.
import { type CSSProperties, type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { defaultProxyConfig, nextWorldId } from '../../../../lib/world/factories'
import { isEventDependency } from '../../../../lib/world/proxyFindings'
import { proxyDependencyFractions } from '../../../../lib/worldEngine/proxyRouting'
import { listRoutes } from '../../../../lib/nodeConfig'
import type { ProxyConfig, ProxyRule } from '../../../../lib/world/types'

const field: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4,
  padding: '3px 6px', color: 'var(--color-text-primary)', width: '100%', minWidth: 0,
}
const smallBtn: CSSProperties = {
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '2px 6px',
  color: 'var(--color-text-secondary)', cursor: 'pointer', flex: '0 0 auto',
}
const rowLabel: CSSProperties = { color: 'var(--color-text-muted)', display: 'block', marginBottom: 2 }
const rowGap: CSSProperties = { marginBottom: 7 }
const muted: CSSProperties = { color: 'var(--color-text-muted)' }

export interface ProxyConfigSectionProps {
  blueprintId: string
  running: boolean
}

export function ProxyConfigSection({ blueprintId, running }: ProxyConfigSectionProps): ReactElement | null {
  const bp = useWorldStore(s => s.doc.blueprints[blueprintId])
  const blueprints = useWorldStore(s => s.doc.blueprints)
  const managed = useWorldStore(s => s.doc.managedServices)
  const packets = useWorldStore(s => s.doc.packets)
  if (!bp || bp.kind !== 'proxy') return null

  const cfg = bp.proxyConfig ?? defaultProxyConfig()
  const set = (patch: Partial<ProxyConfig>): void =>
    useWorldStore.getState().updateBlueprint(blueprintId, { proxyConfig: { ...cfg, ...patch } })

  const upstreams = bp.dependencies.filter(d => !isEventDependency(packets, d))
  const labelOf = (depId: string): string => {
    const d = bp.dependencies.find(x => x.id === depId)
    if (!d) return '(disconnected)'
    const name = d.target.kind === 'blueprint'
      ? blueprints[d.target.blueprintId]?.name
      : managed[d.target.managedServiceId]?.label
    return `${name ?? '?'} :${d.port}`
  }
  const routePaths = listRoutes(packets).map(r => r.path)

  const setRule = (i: number, patch: Partial<ProxyRule>): void =>
    set({ listenerRules: cfg.listenerRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const moveRule = (i: number, delta: number): void => {
    const j = i + delta
    if (j < 0 || j >= cfg.listenerRules.length) return
    const rules = [...cfg.listenerRules]
    ;[rules[i], rules[j]] = [rules[j], rules[i]]
    set({ listenerRules: rules })
  }

  // L4 readout: the same function the engine uses, so the percentages can't disagree with it.
  const l4Shares = cfg.mode === 'l4' ? proxyDependencyFractions(cfg, upstreams.map(u => u.id), undefined).byDep : {}

  return (
    <div style={{ ...rowGap, borderTop: '1px solid var(--color-node-border)', paddingTop: 6 }} data-testid="proxy-config">
      <span style={{ ...rowLabel, letterSpacing: '0.08em' }}>PROXY ROUTING</span>

      {upstreams.length === 0 ? (
        <div style={{ ...muted, ...rowGap }}>
          no upstreams yet — connect this proxy to the services it fronts in the Connections graph
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', ...rowGap }}>
        <label style={{ flex: 1 }}>
          <span style={rowLabel}>mode</span>
          <select aria-label="proxy mode" style={field} value={cfg.mode} disabled={running}
            onChange={e => set({ mode: e.target.value as ProxyConfig['mode'] })}>
            <option value="l4">L4 — split by weight</option>
            <option value="l7">L7 — route by path</option>
          </select>
        </label>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...muted, ...rowGap }}>
        <input type="checkbox" aria-label="prefer same-AZ upstreams" checked={cfg.preferLocalAz} disabled={running}
          onChange={e => set({ preferLocalAz: e.target.checked })} />
        prefer same-AZ upstreams (cross AZs only when none is healthy)
      </label>

      {cfg.mode === 'l4' && upstreams.map(u => (
        <div key={u.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ flex: 1, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{labelOf(u.id)}</span>
          <input aria-label={`weight ${labelOf(u.id)}`} type="number" min={0} step={1} style={{ ...field, flex: '0 0 56px', width: 56 }}
            value={cfg.upstreamWeights?.[u.id] ?? 1} disabled={running}
            onChange={e => set({ upstreamWeights: { ...cfg.upstreamWeights, [u.id]: Math.max(0, Number(e.target.value) || 0) } })} />
          <span style={{ ...muted, flex: '0 0 36px', textAlign: 'right' }}>{Math.round((l4Shares[u.id] ?? 0) * 100)}%</span>
        </div>
      ))}

      {cfg.mode === 'l7' && (
        <>
          <span style={rowLabel}>rules — first match wins; applies to traffic straight from the regional LB</span>
          <datalist id={`proxy-routes-${bp.id}`}>
            {routePaths.map(p => <option key={p} value={p} />)}
          </datalist>
          {cfg.listenerRules.map((r, i) => (
            <div key={r.id} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
              <input aria-label={`rule ${i + 1} path`} style={{ ...field, flex: 1 }} value={r.pathPattern} disabled={running}
                list={`proxy-routes-${bp.id}`} placeholder="/api/*"
                onChange={e => setRule(i, { pathPattern: e.target.value })} />
              <select aria-label={`rule ${i + 1} upstream`} style={{ ...field, flex: 1 }} value={r.dependencyId} disabled={running}
                onChange={e => setRule(i, { dependencyId: e.target.value })}>
                {!upstreams.some(u => u.id === r.dependencyId) && <option value={r.dependencyId}>(disconnected)</option>}
                {upstreams.map(u => <option key={u.id} value={u.id}>{labelOf(u.id)}</option>)}
              </select>
              <button type="button" className="kit-press" style={smallBtn} aria-label={`move rule ${i + 1} up`}
                disabled={running || i === 0} onClick={() => moveRule(i, -1)}>↑</button>
              <button type="button" className="kit-press" style={smallBtn} aria-label={`move rule ${i + 1} down`}
                disabled={running || i === cfg.listenerRules.length - 1} onClick={() => moveRule(i, 1)}>↓</button>
              <button type="button" className="kit-press" style={smallBtn} aria-label={`remove rule ${i + 1}`}
                disabled={running} onClick={() => set({ listenerRules: cfg.listenerRules.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="kit-press" style={{ ...smallBtn, ...rowGap }} aria-label="add rule"
            disabled={running || upstreams.length === 0}
            onClick={() => set({ listenerRules: [...cfg.listenerRules, { id: nextWorldId('prule'), pathPattern: '/*', dependencyId: upstreams[0].id }] })}>
            + rule
          </button>
          <label style={{ display: 'block', ...rowGap }}>
            <span style={rowLabel}>default upstream — unmatched paths and traffic from other services</span>
            <select aria-label="default upstream" style={field} value={cfg.defaultDependencyId ?? ''} disabled={running}
              onChange={e => set({ defaultDependencyId: e.target.value || null })}>
              <option value="">none — respond 503</option>
              {upstreams.map(u => <option key={u.id} value={u.id}>{labelOf(u.id)}</option>)}
            </select>
          </label>
        </>
      )}
    </div>
  )
}
