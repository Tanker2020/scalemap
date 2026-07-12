// src/app/world/dock/RegionConfigTab.tsx
// Polish 4 T2 (spec D4): region scope's Config tab body — replaces T1's generic
// "coming soon" placeholder for region scope only (az/server placeholders stay for T3/T4). This
// region's AZ rows (health dot, label, server count, live rps; row click -> goAz) plus a "+ az"
// button that reuses TopologyPanel's EXACT `addAz` dispatch and auto-suffixed label convention
// byte-for-byte (relocated-dispatch contract) — no parallel mutation path.
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import { useSimulationStore } from '../../store/simulation.store'
import { SectionHeader, EdgeRow } from '../ui/kit'
import { smallBtn } from '../panels/panelStyles'

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
    </div>
  )
}
