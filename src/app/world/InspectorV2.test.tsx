// @vitest-environment jsdom
// Polish 4 T4 (spec D6): InspectorV2 retired its selected-server pane — the dock's faceplate
// (`dock/ServerFaceplate.test.tsx`) and PLACEMENT drawer (`dock/drawers/PlacementDrawer.test.tsx`)
// now own those assertions (rack selector / price / enter / kill), migrated there verbatim. This
// file keeps only what InspectorV2 itself still does: render nothing with no traced requests.
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { InspectorV2 } from './InspectorV2'
import { useWorldStore } from '../store/world.store'
import { useSimulationStore } from '../store/simulation.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.getState().resetSession()
})

function seedAz() {
  const regionId = useWorldStore.getState().addRegion('us-east-1')
  const azId = useWorldStore.getState().addAz(regionId, 'us-east-1a')
  return { regionId, azId }
}

describe('InspectorV2 — traces-only render (Polish 4 T4)', () => {
  it('renders nothing with no traced requests', () => {
    const { azId } = seedAz()
    const { container } = render(<InspectorV2 azId={azId} />)
    expect(container.firstChild).toBeNull()
  })
})
