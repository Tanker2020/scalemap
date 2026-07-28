// src/app/world/panels/RoutesPanel.tsx
// Route catalog authoring (Phase 2 L7 route system) — world scope. A "route" is a named request
// class (method + path) that client populations emit via their request mix (Traffic tab) and a
// regional L7 load balancer's listener rules match on (Region config). Backed by the revived
// packet registry (doc.packets, an HttpTemplate per route); every edit routes through the
// world.store addRoute/updateRoute/removeRoute mutate() actions (undo/dirty for free).
// Presentation only, all dispatch is store actions.
import { useState, type CSSProperties } from 'react'
import { useWorldStore } from '../../store/world.store'
import { listRoutes, routeIdOf } from '../../../lib/nodeConfig'
import type { HttpTemplate, ConnectionType } from '../../../lib/nodeConfig'
import { SectionHeader, Explainer } from '../ui/kit'
import { field, smallBtn, dangerBtn, row } from './panelStyles'

const METHODS: HttpTemplate['method'][] = ['GET', 'POST', 'PUT', 'DELETE']
const CONNECTIONS: ConnectionType[] = ['keep-alive', 'short-lived', 'streaming']

// Parse a KB numeric-input value; blank/NaN/negative ⇒ undefined so the route/helper falls back.
const parseKb = (v: string): number | undefined => {
  const n = Number(v)
  return v.trim() === '' || Number.isNaN(n) || n < 0 ? undefined : n
}

const sizeField: CSSProperties = { ...field, width: 64, marginBottom: 0 }
const miniLabel: CSSProperties = { fontSize: 9.5, color: 'var(--color-text-muted)', flexShrink: 0 }

export function RoutesPanel() {
  const doc = useWorldStore(s => s.doc)
  const addRoute = useWorldStore(s => s.addRoute)
  const routes = listRoutes(doc.packets)
  const [name, setName] = useState('')
  const [path, setPath] = useState('/')
  const [method, setMethod] = useState<HttpTemplate['method']>('GET')
  const [reqSize, setReqSize] = useState('1')
  const [respSize, setRespSize] = useState('4')
  const [connection, setConnection] = useState<ConnectionType>('keep-alive')
  const [variance, setVariance] = useState('0')

  const submit = () => {
    if (!name.trim() || !path.trim()) return
    addRoute({
      name: name.trim(), method, path: path.trim(),
      sizeKb: parseKb(reqSize), responseSizeKb: parseKb(respSize), connectionType: connection,
      sizeVariance: parseKb(variance),
    })
    setName(''); setPath('/'); setReqSize('1'); setRespSize('4'); setConnection('keep-alive'); setVariance('0')
  }

  return (
    <div>
      <SectionHeader label="▸ ROUTES" />
      <Explainer>
        A route is a request class (method + path). Populations emit a weighted mix of routes in
        the Traffic tab; a region's L7 load balancer maps route paths to services via its listener
        rules. With no routes, every population sends a single default class. Request/response sizes
        (KB) drive the simulated egress byte rate — the response size sets the client-facing
        internet-egress cost.
      </Explainer>
      {routes.length === 0 && <div style={{ color: 'var(--color-text-muted)', margin: '6px 0' }}>no routes yet</div>}
      {routes.map(route => <RouteCard key={route.id} route={route} />)}

      <SectionHeader label="▸ NEW ROUTE" />
      <div style={row}>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} placeholder="name (e.g. api)" aria-label="new-route-name"
          value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
      </div>
      <div style={row}>
        <select style={{ ...field, width: 76, marginBottom: 0 }} aria-label="new-route-method" value={method}
          onChange={e => setMethod(e.target.value as HttpTemplate['method'])}>
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} placeholder="/api/users" aria-label="new-route-path"
          value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
      </div>
      <div style={row}>
        <span style={miniLabel}>req</span>
        <input style={sizeField} type="number" min={0} aria-label="new-route-req-size" title="request size (KB)"
          value={reqSize} onChange={e => setReqSize(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <span style={miniLabel}>resp KB</span>
        <input style={sizeField} type="number" min={0} aria-label="new-route-resp-size" title="response size (KB) — drives egress cost"
          value={respSize} onChange={e => setRespSize(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <span style={miniLabel}>σ</span>
        <input style={sizeField} type="number" min={0} step={0.1} aria-label="new-route-variance" title="NIC-burst size variance (sigma) — log-normal jitter driving p99 tails; 0 = none"
          value={variance} onChange={e => setVariance(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label="new-route-connection" value={connection}
          onChange={e => setConnection(e.target.value as ConnectionType)}>
          {CONNECTIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="kit-press" style={smallBtn} disabled={!name.trim() || !path.trim()} onClick={submit}>+ Route</button>
      </div>
    </div>
  )
}

function RouteCard({ route }: { route: HttpTemplate }) {
  const doc = useWorldStore(s => s.doc)
  const updateRoute = useWorldStore(s => s.updateRoute)
  const removeRoute = useWorldStore(s => s.removeRoute)
  const id = routeIdOf(route)
  const usage = Object.values(doc.populations).filter(p => p.requestMix?.some(e => e.routeId === id)).length

  return (
    <div style={{ background: 'var(--color-node-base)', border: '1px solid var(--color-node-border)', borderRadius: 8, padding: 10, marginTop: 8 }}>
      <div style={row}>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} aria-label={`route-name-${id}`}
          value={route.name} onChange={e => updateRoute(id, { name: e.target.value })} />
        <span style={{ fontSize: 9.5, color: 'var(--color-text-muted)', flexShrink: 0 }} title="populations using this route">
          {usage > 0 ? `${usage} pop${usage === 1 ? '' : 's'}` : 'unused'}
        </span>
        <button className="kit-press" style={dangerBtn} aria-label={`remove-route-${id}`} onClick={() => removeRoute(id)}>×</button>
      </div>
      <div style={{ ...row, marginTop: 4, marginBottom: 0 }}>
        <select style={{ ...field, width: 76, marginBottom: 0 }} aria-label={`route-method-${id}`} value={route.method}
          onChange={e => updateRoute(id, { method: e.target.value as HttpTemplate['method'] })}>
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input style={{ ...field, flex: 1, marginBottom: 0 }} aria-label={`route-path-${id}`}
          value={route.path} onChange={e => updateRoute(id, { path: e.target.value })} />
      </div>
      <div style={{ ...row, marginTop: 4, marginBottom: 0 }}>
        <span style={miniLabel}>req</span>
        <input style={sizeField} type="number" min={0} aria-label={`route-req-size-${id}`} title="request size (KB)"
          value={route.sizeKb ?? ''} onChange={e => updateRoute(id, { sizeKb: parseKb(e.target.value) })} />
        <span style={miniLabel}>resp KB</span>
        <input style={sizeField} type="number" min={0} aria-label={`route-resp-size-${id}`} title="response size (KB) — drives egress cost"
          value={route.responseSizeKb ?? ''} onChange={e => updateRoute(id, { responseSizeKb: parseKb(e.target.value) })} />
        <span style={miniLabel}>σ</span>
        <input style={sizeField} type="number" min={0} step={0.1} aria-label={`route-variance-${id}`} title="NIC-burst size variance (sigma) — log-normal jitter driving p99 tails; 0 = none"
          value={route.sizeVariance ?? 0} onChange={e => updateRoute(id, { sizeVariance: parseKb(e.target.value) })} />
        <select style={{ ...field, flex: 1, marginBottom: 0 }} aria-label={`route-connection-${id}`} value={route.connectionType ?? 'keep-alive'}
          onChange={e => updateRoute(id, { connectionType: e.target.value as ConnectionType })}>
          {CONNECTIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
    </div>
  )
}
