// src/app/world/dock/RegionConfigTab.tsx
// Polish 4 T2 (spec D4): region scope's Config tab body — replaces T1's generic
// "coming soon" placeholder for region scope only (az/server placeholders stay for T3/T4). This
// region's AZ rows (health dot, label, server count, live rps; row click -> goAz) plus a "+ az"
// button that reuses TopologyPanel's EXACT `addAz` dispatch and auto-suffixed label convention
// byte-for-byte (relocated-dispatch contract) — no parallel mutation path.
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { SectionHeader, EdgeRow, Segmented, Explainer } from '../ui/kit'
import { smallBtn, dangerBtn, field, row } from '../panels/panelStyles'
import { nextWorldId } from '../../../lib/world/factories'
import { listRoutes } from '../../../lib/nodeConfig'
import type { AvailabilityZone, LbAlgorithm, LbMode, LoadBalancer } from '../../../lib/world/types'

export interface RegionConfigTabProps { regionId: string }

export function RegionConfigTab({ regionId }: RegionConfigTabProps) {
  const doc = useWorldStore(s => s.doc)
  const store = useWorldStore.getState()
  const goAz = useNavStore(s => s.goAz)
  const running = useSimulationStore(s => s.running)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const region = doc.regions[regionId]
  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)

  // Byte-identical suffix convention to TopologyPanel.tsx's `nextAzLabel` (catalogId + a, b, c…).
  const nextAzLabel = `${region?.catalogId ?? regionId}${String.fromCharCode(97 + azs.length)}`

  return (
    <div data-testid="region-config-tab">
      <SectionHeader label="▸ AVAILABILITY ZONES" />
      {azs.length === 0 && (
        <div style={{ color: 'var(--color-text-muted)', padding: '4px 2px 10px' }}>
          No AZs yet in this region.
        </div>
      )}
      {azs.map(az => {
        const serverCount = Object.values(doc.servers).filter(sv => sv.azId === az.id).length
        const metrics = displayBatch?.azs[az.id]
        return (
          <EdgeRow
            key={az.id}
            status={metrics?.health ?? null}
            // No ripple here (T2 review fix): spec D3's motion law gives the dock exactly ONE
            // ambient stroke — the atlas arc mounted above the tab bar at region scope — and
            // every other dock element is hover-reactive only. `kit-ripple` animates
            // continuously (not hover-gated), so passing `running` here would add a second,
            // per-row ambient motion source alongside the marching atlas. Static color dot only.
            onClick={() => goAz(regionId, az.id)}
            // EdgeRow's `trailing` slot, unlike the rps figure below — this needs its OWN click
            // isolated from the row's goAz navigation (stopPropagation), so it can't share the
            // row's onClick-bubbling `children` block. Reuses TopologyPanel's exact `removeAz`
            // dispatch byte-for-byte (relocated-dispatch contract, same convention as "+ az"
            // above) — no parallel mutation path, no confirmation dialog (matches every other
            // remove* action in the app).
            trailing={
              <button
                className="kit-press" style={dangerBtn} disabled={running}
                title={running ? 'stop the simulation to edit' : undefined}
                aria-label={`remove ${az.label}`}
                onClick={e => { e.stopPropagation(); store.removeAz(az.id) }}
              >
                ×
              </button>
            }
          >
            {/* One block (not EdgeRow's separate `trailing` slot) so the rps figure — right-
                aligned via `marginLeft: auto` inside this already flex:1 children area — stays
                inside the SAME element the test/testid reads, and a click anywhere in the row
                still bubbles up to EdgeRow's own onClick-bearing container. */}
            <div data-testid="region-config-az-row" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span>{az.label}</span>
              <span style={{ fontSize: 9.5, color: 'var(--color-text-muted)' }}>
                {serverCount} server{serverCount === 1 ? '' : 's'}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--kit-accent)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                {metrics ? `${Math.round(metrics.rps)} rps` : '—'}
              </span>
            </div>
          </EdgeRow>
        )
      })}
      <button
        className="kit-press" style={{ ...smallBtn, marginTop: 6 }} disabled={running}
        title={running ? 'stop the simulation to edit' : undefined}
        onClick={() => store.addAz(regionId, nextAzLabel)}
      >
        + az
      </button>

      {/* A regional LB only makes a real decision once there are ≥2 AZs to distribute across —
          crossZone is a mathematical no-op with 0-1 AZs (perAz = rps / healthyAzs.length
          degenerates to rps / 1 either way). Hide the config until it's meaningful; explain why
          at exactly 1 AZ so the section's disappearance reads as expected, not broken. */}
      {azs.length >= 2 ? (
        <LoadBalancerSection regionId={regionId} running={running} azs={azs} />
      ) : azs.length === 1 ? (
        <div style={{ color: 'var(--color-text-muted)', padding: '10px 2px 4px', fontSize: 10.5 }}>
          Add a second AZ to configure this region's load balancer.
        </div>
      ) : null}
    </div>
  )
}

// The region's regional load balancer (the tier "between the AZs"). `mode` picks the device: NLB
// (L4, connection routing) or ALB (L7, path routing via listener rules). Cross-zone off serves
// each AZ locally; on spreads across every AZ. Reads the authored LB if present, else shows the
// synthesized default (L4, cross-zone off); the first edit creates the LB via the store's
// addLoadBalancer + patch dance.
function LoadBalancerSection({ regionId, running, azs }: { regionId: string; running: boolean; azs: AvailabilityZone[] }) {
  const doc = useWorldStore(s => s.doc)
  const addLoadBalancer = useWorldStore(s => s.addLoadBalancer)
  const updateLoadBalancer = useWorldStore(s => s.updateLoadBalancer)
  const lb = Object.values(doc.loadBalancers).find(l => l.regionId === regionId)
  const mode: LbMode = lb?.mode ?? 'l4'
  const crossZone = lb?.crossZone ?? false
  const algorithm: LbAlgorithm = lb?.algorithm ?? 'round-robin'
  const azWeights = lb?.azWeights ?? {}

  const patch = (p: Parameters<typeof updateLoadBalancer>[1]) =>
    updateLoadBalancer(lb?.id ?? addLoadBalancer(regionId), p)

  const rowLabel = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 } as const

  return (
    <div>
      <SectionHeader label="▸ LOAD BALANCER" />
      <Explainer>
        {mode === 'l7'
          ? 'ALB · L7 — routes by request path to services via the listener rules below.'
          : 'NLB · L4 — connection routing; all inbound traffic hits the default target group.'}
        {crossZone ? ' Cross-zone on: spreads across every AZ.' : ' Cross-zone off: each AZ serves its own share.'}
      </Explainer>
      <fieldset disabled={running} style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 8, marginTop: 8 }}>
        <label style={rowLabel}>
          <span>type</span>
          <Segmented<LbMode>
            ariaLabel="lb-mode"
            value={mode}
            onChange={m => patch({ mode: m })}
            options={[{ value: 'l4', label: 'NLB · L4' }, { value: 'l7', label: 'ALB · L7' }]}
          />
        </label>
        <label style={rowLabel}>
          <span>cross-zone</span>
          <Segmented<'off' | 'on'>
            ariaLabel="cross-zone"
            value={crossZone ? 'on' : 'off'}
            onChange={v => patch({ crossZone: v === 'on' })}
            options={[{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }]}
          />
        </label>
        <label style={rowLabel}>
          <span>algorithm</span>
          <Segmented<LbAlgorithm>
            ariaLabel="lb-algorithm"
            value={algorithm}
            onChange={a => patch({ algorithm: a })}
            options={[{ value: 'round-robin', label: 'round robin' }, { value: 'weighted', label: 'weighted' }]}
          />
        </label>
        {algorithm === 'weighted' && (
          <div style={{ display: 'grid', gap: 4 }}>
            <Explainer>Relative weight per AZ — a blank or 0 weight falls back to an equal split.</Explainer>
            {azs.map(az => (
              <label key={az.id} style={rowLabel}>
                <span>{az.label}</span>
                <input
                  type="number" min={0} step={1} style={{ ...field, width: 64, marginBottom: 0 }}
                  aria-label={`az-weight-${az.id}`}
                  value={azWeights[az.id] ?? 1}
                  onChange={e => patch({ azWeights: { ...azWeights, [az.id]: Math.max(0, Number(e.target.value) || 0) } })}
                />
              </label>
            ))}
          </div>
        )}
        {mode === 'l7' && <ListenerRulesEditor lb={lb} patch={patch} />}
      </fieldset>
    </div>
  )
}

// L7 listener rules: an ordered, first-match list mapping a path pattern to a target service, plus
// the default action (the "otherwise" target). Only rendered in L7 mode. `lb` is defined here
// because switching to L7 already created it via patch({ mode: 'l7' }); the ?? guards keep the
// component pure if it ever renders a tick early.
function ListenerRulesEditor({ lb, patch }: {
  lb: LoadBalancer | undefined
  patch: (p: Partial<LoadBalancer>) => void
}) {
  const doc = useWorldStore(s => s.doc)
  const blueprints = Object.values(doc.blueprints)
  const routes = listRoutes(doc.packets)
  const rules = lb?.listenerRules ?? []
  const defaultTarget = lb?.defaultTargetBlueprintId ?? ''

  const addRule = () => patch({
    listenerRules: [...rules, { id: nextWorldId('lr'), pathPattern: '/*', targetBlueprintId: blueprints[0]?.id ?? '' }],
  })
  const updateRule = (i: number, p: Partial<{ pathPattern: string; targetBlueprintId: string }>) =>
    patch({ listenerRules: rules.map((r, j) => j === i ? { ...r, ...p } : r) })
  const removeRule = (i: number) => patch({ listenerRules: rules.filter((_, j) => j !== i) })

  return (
    <div style={{ marginTop: 4 }}>
      <SectionHeader label="▸ LISTENER RULES" />
      <Explainer>First match wins; unmatched requests use the default action.</Explainer>
      {routes.length > 0 && (
        <div style={{ fontSize: 9.5, color: 'var(--color-text-muted)', margin: '4px 0' }}>
          route paths: {routes.map(r => r.path).join('  ·  ')}
        </div>
      )}
      {rules.map((r, i) => (
        <div key={r.id} style={row}>
          <input
            style={{ ...field, flex: 1, marginBottom: 0 }} aria-label={`rule-pattern-${i}`} placeholder="/api/*"
            value={r.pathPattern} onChange={e => updateRule(i, { pathPattern: e.target.value })}
          />
          <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>→</span>
          <select
            style={{ ...field, width: 96, marginBottom: 0 }} aria-label={`rule-target-${i}`}
            value={r.targetBlueprintId} onChange={e => updateRule(i, { targetBlueprintId: e.target.value })}
          >
            {blueprints.length === 0 && <option value="">(no services)</option>}
            {blueprints.map(bp => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
          </select>
          <button className="kit-press" style={dangerBtn} aria-label={`remove-rule-${i}`} onClick={() => removeRule(i)}>×</button>
        </div>
      ))}
      <button className="kit-press" style={{ ...smallBtn, marginTop: 2 }} disabled={blueprints.length === 0} onClick={addRule}>
        + rule
      </button>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11, marginTop: 8 }}>
        <span>default action</span>
        <select
          style={{ ...field, width: 128, marginBottom: 0 }} aria-label="lb-default-target"
          value={defaultTarget} onChange={e => patch({ defaultTargetBlueprintId: e.target.value || null })}
        >
          <option value="">entry services</option>
          {blueprints.map(bp => <option key={bp.id} value={bp.id}>{bp.name}</option>)}
        </select>
      </label>
    </div>
  )
}
