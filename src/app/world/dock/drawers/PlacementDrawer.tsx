// src/app/world/dock/drawers/PlacementDrawer.tsx
// Polish 4 T4 (spec D6): the PLACEMENT drawer body — InspectorV2's rack `<select>` relocated
// BYTE-FOR-BYTE (its `FREE_POOL_VALUE`, per-rack `<option>`s, `canAssign` disabling,
// `assignServerToRack` dispatch — the exact lines InspectorV2.tsx carried at ~94-119, minus the
// surrounding card chrome InspectorV2 owned and this drawer's parent (ServerFaceplate) now owns
// instead). InspectorV2 itself retires this pane this same task (spec D6's "InspectorV2 retires
// its selected-server pane").
import { type ReactElement } from 'react'
import { useWorldStore } from '../../../store/world.store'
import { canAssign, rackUsedU } from '../../../../lib/world/rackModel'
import type { Server, WorldDoc } from '../../../../lib/world/types'

const FREE_POOL_VALUE = '__free_pool__'

export function placementPv(server: Server, doc: WorldDoc): string {
  if (!server.rack) return 'free pool'
  const rack = doc.racks[server.rack.rackId]
  return `${rack?.label ?? server.rack.rackId} · slot ${server.rack.unit}`
}

export interface PlacementDrawerProps {
  server: Server
  doc: WorldDoc
  running: boolean
}

export function PlacementDrawer({ server, doc, running }: PlacementDrawerProps): ReactElement {
  const azRacks = Object.values(doc.racks).filter(r => r.azId === server.azId)

  return (
    <div data-testid="placement-drawer-body">
      <label style={{ display: 'block', fontSize: 10, color: 'var(--color-text-secondary)' }}>
        rack
        <select
          aria-label="rack"
          disabled={running}
          title={running ? 'stop the simulation to edit' : undefined}
          value={server.rack?.rackId ?? FREE_POOL_VALUE}
          onChange={e => {
            const v = e.target.value
            useWorldStore.getState().assignServerToRack(server.id, v === FREE_POOL_VALUE ? null : v)
          }}
          style={{
            display: 'block', width: '100%', marginTop: 3, background: 'var(--color-node-base)',
            border: '1px solid var(--color-node-border)', borderRadius: 4, padding: '4px 6px',
            font: '11px var(--font-mono)', color: 'var(--color-text-primary)',
          }}
        >
          <option value={FREE_POOL_VALUE}>free pool</option>
          {azRacks.map(rack => {
            const disabled = rack.id !== server.rack?.rackId && !canAssign(doc, server.id, rack.id)
            return (
              <option key={rack.id} value={rack.id} disabled={disabled}>
                {rack.label} · {rackUsedU(doc, rack.id)}/{rack.capacityU} U
              </option>
            )
          })}
        </select>
      </label>
    </div>
  )
}
