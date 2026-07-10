// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorldPanel } from './WorldPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

describe('WorldPanel findings tab', () => {
  it('shows the stateful-without-volume finding for a stateful blueprint with no volume', () => {
    const bpId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().updateBlueprint(bpId, { stateful: true, volumeName: null })

    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/Findings \(\d+\)/))

    expect(screen.getByText(/is stateful but has no volume configured/)).toBeInTheDocument()
  })

  it('shows the empty state when there are no findings', () => {
    render(<WorldPanel running={false} placeMode={false} onTogglePlaceMode={() => {}} selectedPopulationId={null} />)
    fireEvent.click(screen.getByText(/Findings \(0\)/))
    expect(screen.getByText('No findings — the compiled world is clean.')).toBeInTheDocument()
  })
})
