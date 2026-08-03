// @vitest-environment jsdom
// FEAT-002 Task 14: component test for the partition-authoring surface. Covers the edit-lock
// INVERSE (enabled only while running, per ChaosControl's CHAOS_LOCKED_TITLE convention),
// authoring a partition via setPartition, and healing one via healPartition(index).
//
// FIX ROUND: every interactive control is a `role="button"/"checkbox"/"option"` div (a
// Pressable), never a native form control — see PartitionsSection.tsx's file banner for why
// (a native control nested in WorldPanel.tsx's ambient disabled fieldset can never be
// re-enabled by its own `disabled` prop). These tests click/query via aria-disabled and testid
// rather than `.toBeDisabled()`/`fireEvent.change`, matching the actual DOM shape.
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PartitionsSection } from './PartitionsSection'
import { useWorldStore } from '../../store/world.store'
import { useSimulationStore } from '../../store/simulation.store'
import { CHAOS_LOCKED_TITLE } from '../dock/ChaosControl'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useSimulationStore.getState().resetSession()
})

// Opens the endpoint id popup and picks the given entity id — mirrors a real user's
// click-toggle-then-click-option flow through the Pressable-based picker.
function pickEndpoint(prefix: 'partition-from' | 'partition-to', id: string) {
  fireEvent.click(screen.getByTestId(`${prefix}-id`))
  fireEvent.click(screen.getByTestId(`${prefix}-option-${id}`))
}

describe('PartitionsSection', () => {
  it('form is disabled when not running, with the standardized chaos tooltip', () => {
    render(<PartitionsSection />)
    const addBtn = screen.getByTestId('partition-add')
    expect(addBtn).toHaveAttribute('aria-disabled', 'true')
    expect(addBtn).toHaveAttribute('title', CHAOS_LOCKED_TITLE)
    const idPicker = screen.getByTestId('partition-from-id')
    expect(idPicker).toHaveAttribute('aria-disabled', 'true')
    expect(idPicker).toHaveAttribute('title', CHAOS_LOCKED_TITLE)
    const scopeBtn = screen.getByTestId('partition-from-scope-region')
    expect(scopeBtn).toHaveAttribute('aria-disabled', 'true')

    // Locked controls must not respond to a click even if one somehow fires (no native
    // `disabled` attribute to rely on browser-level suppression for a role="button" div).
    fireEvent.click(idPicker)
    expect(screen.queryByTestId('partition-from-id-menu')).toBeNull()
  })

  it('Add partition calls setPartition with the authored fault', () => {
    const regionA = useWorldStore.getState().addRegion('us-east-1')
    const regionB = useWorldStore.getState().addRegion('eu-west-1')
    useSimulationStore.setState({ running: true })
    render(<PartitionsSection />)

    pickEndpoint('partition-from', regionA)
    pickEndpoint('partition-to', regionB)
    fireEvent.click(screen.getByTestId('partition-add'))

    // Audit final-review I3: addPartition now auto-assigns a stable `id` (faults.ts's run-scoped
    // counter) in place on the fault object — asserted separately from the rest of the shape below
    // since its exact value is an implementation detail, not part of what this test is verifying.
    const partitions = useSimulationStore.getState().partitions
    expect(partitions).toHaveLength(1)
    expect(partitions[0].id).toBeTruthy()
    expect(partitions[0]).toMatchObject(
      { from: { kind: 'region', id: regionA }, to: { kind: 'region', id: regionB }, mode: 'drop', symmetric: true },
    )
  })

  it('Heal calls healPartition with the correct id (audit final-review I3 — was index-based)', () => {
    const regionA = useWorldStore.getState().addRegion('us-east-1')
    const regionB = useWorldStore.getState().addRegion('eu-west-1')
    useSimulationStore.setState({ running: true })
    useSimulationStore.getState().setPartition({
      from: { kind: 'region', id: regionA }, to: { kind: 'region', id: regionB }, mode: 'drop', symmetric: true,
    })
    render(<PartitionsSection />)

    expect(screen.getAllByTestId('partition-row')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('heal-partition-0'))
    expect(useSimulationStore.getState().partitions).toEqual([])
  })

  it('the add button stays aria-disabled until both endpoints are chosen', () => {
    useWorldStore.getState().addRegion('us-east-1')
    useSimulationStore.setState({ running: true })
    render(<PartitionsSection />)
    expect(screen.getByTestId('partition-add')).toHaveAttribute('aria-disabled', 'true')
  })

  it('every control stays a non-native role element (never a real <select>/<input>/<button disabled>) so an ambient ancestor <fieldset disabled> cannot force it off', () => {
    useWorldStore.getState().addRegion('us-east-1')
    useSimulationStore.setState({ running: true })
    // Render nested inside a disabled fieldset — reproduces WorldPanel.tsx's ambient
    // `<fieldset disabled={running && tab !== 'events'}>` wrapper around the real Config tab.
    render(
      <fieldset disabled>
        <PartitionsSection />
      </fieldset>,
    )
    const idPicker = screen.getByTestId('partition-from-id')
    const scopeBtn = screen.getByTestId('partition-from-scope-region')
    const modeBtn = screen.getByTestId('partition-mode-drop')
    // None of these are real form controls, so the native fieldset-disabled cascade (which
    // only touches <button>/<select>/<input>/<textarea>/<fieldset>) does not reach them —
    // aria-disabled reflects ONLY this component's own `running` prop (the add button ALSO
    // factors in endpoint validity, which isn't set up here, so it's excluded from this check).
    expect(idPicker.tagName).not.toBe('SELECT')
    expect(idPicker).toHaveAttribute('aria-disabled', 'false')
    expect(scopeBtn).toHaveAttribute('aria-disabled', 'false')
    expect(modeBtn).toHaveAttribute('aria-disabled', 'false')
    // And it's genuinely interactive: opening the id popup actually works while nested here.
    fireEvent.click(idPicker)
    expect(screen.getByTestId('partition-from-id-menu')).toBeInTheDocument()
  })
})
