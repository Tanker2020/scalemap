import { useState } from 'react'
import { TopologyPanel } from './TopologyPanel'
import { BlueprintPanel } from './BlueprintPanel'
import { PlacementPanel } from './PlacementPanel'
import { useCompiledWorld } from '../useCompiledWorld'
import { EventsTab } from '../EventsTab'
import { panel, smallBtn, sectionLabel } from './panelStyles'

type Tab = 'topology' | 'blueprints' | 'placements' | 'findings' | 'events'

export function WorldPanel({ running }: { running: boolean }) {
  const [tab, setTab] = useState<Tab>('topology')
  const { findings } = useCompiledWorld()
  const tabs: { id: Tab; label: string }[] = [
    { id: 'topology', label: 'Topology' },
    { id: 'blueprints', label: 'Blueprints' },
    { id: 'placements', label: 'Placements' },
    { id: 'findings', label: `Findings (${findings.length})` },
    { id: 'events', label: 'Events' },
  ]
  return (
    <aside style={panel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id}
            style={{ ...smallBtn, ...(tab === t.id ? { color: 'var(--color-text-primary)', border: '1px solid var(--color-text-muted)' } : {}) }}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {/* Native fieldset-disabled cascades into every descendant button/input/select with zero
          changes to TopologyPanel/BlueprintPanel/PlacementPanel. Findings/Events have no form
          controls, so wrapping them here too is a harmless no-op — kept uniform on purpose. */}
      <fieldset disabled={running} style={{ border: 'none', margin: 0, padding: 0 }}>
        {tab === 'topology' && <TopologyPanel />}
        {tab === 'blueprints' && <BlueprintPanel />}
        {tab === 'placements' && <PlacementPanel />}
        {tab === 'findings' && (
          <div>
            <div style={sectionLabel}>Findings</div>
            {findings.length === 0 && (
              <div style={{ color: 'var(--color-text-muted)' }}>No findings — the compiled world is clean.</div>
            )}
            {findings.map(f => (
              <div key={f.id} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    padding: '1px 6px', borderRadius: 3, font: '10px var(--font-mono)',
                    color: '#fff',
                    background: f.severity === 'error' ? 'var(--color-danger)' : 'var(--color-warning)',
                  }}>{f.severity}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{f.kind}</span>
                </div>
                <div style={{ marginTop: 2 }}>{f.message}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'events' && <EventsTab />}
      </fieldset>
    </aside>
  )
}
