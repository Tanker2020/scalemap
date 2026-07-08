import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { panel, smallBtn } from './panelStyles'

// Filled in Task 12:
function BlueprintPanel() { return null }
function PlacementPanel() { return null }

type Tab = 'topology' | 'blueprints' | 'placements'

export function WorldPanel() {
  const [tab, setTab] = useState<Tab>('topology')
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', border: '1px solid var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'topology' && <TopologyPanel />}
      {tab === 'blueprints' && <BlueprintPanel />}
      {tab === 'placements' && <PlacementPanel />}
    </aside>
  )
}
