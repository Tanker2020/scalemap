// src/app/world/az/NodePalette.tsx
// The AZ's typed node palette: what you can drop into this availability zone.
//
// One component, two call sites (the floor toolbar and the dock's AzConfigTab). Before this
// existed both sites hardcoded `addServer(azId, getPreset('vps-medium')!)` and were kept in sync
// only by a comment asking the next editor to mirror "the EXACT dispatch" — this makes that
// coupling structural instead of aspirational.
//
// Compute entries add an EMPTY host (you fill it with services). Data entries add a preconfigured
// DB appliance — box + owned blueprint + primary placement — in one undo step via addDbServer.
import type { CSSProperties, ReactElement } from 'react'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { getPreset } from '../../../lib/world/instanceCatalog'
import { isDbServerKind } from '../../../lib/world/types'
import { nodePaletteEntries, nextApplianceName, type PaletteGroup } from './paletteEntries'

const GROUP_LABEL: Record<PaletteGroup, string> = {
  compute: 'COMPUTE — empty hosts you fill with services',
  data: 'DATA — arrives preconfigured as a database',
}

const railStyle: CSSProperties = {
  font: '9px var(--font-mono)', color: 'var(--color-text-muted)',
  letterSpacing: '0.08em', padding: '8px 0 4px',
}

const entryStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
  font: '10px var(--font-mono)', background: 'var(--color-node-base)',
  border: '1px solid var(--color-node-border)', borderRadius: 5,
  padding: '5px 8px', marginBottom: 4,
  color: 'var(--color-text-secondary)', cursor: 'pointer', textAlign: 'left',
}

const entryLockedStyle: CSSProperties = { ...entryStyle, opacity: 0.35, cursor: 'default' }

export interface NodePaletteProps {
  azId: string
}

export function NodePalette({ azId }: NodePaletteProps): ReactElement {
  const running = useSimulationStore(s => s.running)
  const entries = nodePaletteEntries()

  // Read the doc lazily inside the handler (not as a subscription): the palette's own render
  // doesn't depend on doc contents, and subscribing here would re-render the whole palette on
  // every unrelated world edit.
  const add = (presetId: string): void => {
    if (running) return   // self-guard; the native disabled attribute is belt-and-braces
    const preset = getPreset(presetId)
    if (!preset) return
    const store = useWorldStore.getState()
    if (isDbServerKind(preset.kind)) {
      store.addDbServer(azId, preset, nextApplianceName(store.doc, preset.kind))
    } else {
      store.addServer(azId, preset)
    }
  }

  return (
    <div>
      {(Object.keys(GROUP_LABEL) as PaletteGroup[]).map(group => (
        <div key={group}>
          <div style={railStyle}>{GROUP_LABEL[group]}</div>
          {entries.filter(e => e.group === group).map(entry => (
            <button
              key={entry.presetId}
              type="button"
              className="kit-press"
              style={running ? entryLockedStyle : entryStyle}
              disabled={running}
              title={running ? 'stop the simulation to edit' : undefined}
              onClick={() => add(entry.presetId)}
            >
              <span style={{ color: 'var(--color-text-primary)' }}>{entry.label}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted)' }}>{entry.detail}</span>
              <span style={{ color: 'var(--color-price)', fontVariantNumeric: 'tabular-nums' }}>
                ${entry.hourlyUsd}/hr
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
