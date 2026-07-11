// Region command overlay content (Polish 2 D3). Plain DOM inside the pin's <Html> — reads
// stores directly like the panels do. EVERY control reuses an existing dispatch byte-for-byte
// (Global Constraints: relocated-dispatch contract).
import type { ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { useFileStore } from '../../../store/file.store'
import { useNavStore } from '../../../store/nav.store'
import { useSimulationStore } from '../../../store/simulation.store'
import { WORLD_REGIONS } from '../../../../lib/regionConfig'
import type { RegionId } from '../../../../lib/world/types'
import { SceneOverlay, ovlActPrimary, ovlActDanger } from '../SceneOverlay'
import { Segmented, SpecBar, ChipValue } from '../kit'
import { useRollingNumber } from '../motion'

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

// 'us-east-1 · N. Virginia' — metro from the WORLD_REGIONS label's parens (same extraction
// TopologyPanel's regionSectLabel does, without the uppercase treatment).
function regionTitle(catalogId: string): string {
  const label = WORLD_REGIONS.find(w => w.id === catalogId)?.label ?? catalogId
  const metro = label.match(/\(([^)]+)\)/)?.[1]
  return metro ? `${catalogId} · ${metro}` : catalogId
}

export function RegionOverlay({ regionId, onClose }: { regionId: RegionId; onClose: () => void }): ReactElement | null {
  const doc = useWorldStore(s => s.doc)
  const displayBatch = useSimulationStore(s => s.scrubBatch ?? s.latestBatch)
  const running = useSimulationStore(s => s.running)
  const isDown = useSimulationStore(s => s.healthOverrides[regionId] ?? false)
  const setOutage = useSimulationStore(s => s.setOutage)
  const goRegion = useNavStore(s => s.goRegion)

  const region = doc.regions[regionId]
  const metrics = displayBatch?.regions[regionId]
  const rolledRps = useRollingNumber(metrics?.rps ?? 0)
  if (!region) return null

  const azs = Object.values(doc.azs).filter(a => a.regionId === regionId)
  const servers = Object.values(doc.servers).filter(sv => azs.some(a => a.id === sv.azId))
  const hourly = servers.reduce((sum, sv) => sum + sv.hourlyUsd, 0)
  const capacity = metrics
    ? mean(servers.map(sv => mean(displayBatch?.servers[sv.id]?.coreUtilization ?? [])))
    : null

  return (
    <SceneOverlay
      title={regionTitle(region.catalogId)}
      health={metrics?.health ?? null}
      subtitle="region"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="kit-press" style={ovlActPrimary}
            title="Keyboard path — the pointer gesture is hold-the-pin"
            onClick={() => goRegion(regionId)}>
            enter ⏎
          </button>
          <button type="button" className="kit-press" style={ovlActDanger}
            disabled={!running}
            title={running ? 'Chaos: simulate a full region outage' : 'start the simulation to break things'}
            onClick={() => setOutage('region', regionId, !isDown)}>
            {isDown ? 'restore' : '⚡ kill'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 6, padding: '10px 13px 2px', flexWrap: 'wrap' }}>
        <ChipValue>{azs.length} AZ{azs.length === 1 ? '' : 's'}</ChipValue>
        <ChipValue>{servers.length} server{servers.length === 1 ? '' : 's'}</ChipValue>
        <ChipValue>{metrics ? `~${Math.round(rolledRps)} rps in` : '~— rps in'}</ChipValue>
        <ChipValue>{metrics ? `p50 ${Math.round(metrics.p50Ms)} ms` : 'p50 — ms'}</ChipValue>
        <ChipValue>${hourly.toFixed(2)}/hr</ChipValue>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 13px', fontSize: 11 }}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 10, width: 64, flexShrink: 0 }}>role</span>
        <Segmented<'active' | 'passive'>
          ariaLabel="region-role"
          value={region.role}
          onChange={v => {
            // Role toggle writes via setState directly — deliberately no history push for a
            // two-value toggle (see plan Task 11 note). History bypass is deliberate;
            // dirty-marking is still required. [TopologyPanel.tsx:88-95, copied verbatim]
            useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: { ...region, role: v } } } }))
            useFileStore.getState().setDirty(true)
          }}
          options={[{ value: 'active', label: 'active' }, { value: 'passive', label: 'passive' }]}
        />
      </div>
      <div style={{ padding: '0 13px' }}>
        <SpecBar
          label="capacity"
          fraction={capacity ?? 0}
          color="var(--color-accent)"
          value={capacity === null ? '—' : `${Math.round(capacity * 100)}%`}
        />
      </div>
    </SceneOverlay>
  )
}
