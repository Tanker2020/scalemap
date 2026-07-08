// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BlueprintPanel } from './BlueprintPanel'
import { useWorldStore } from '../../store/world.store'

beforeEach(() => useWorldStore.getState().newWorld())

describe('BlueprintPanel', () => {
  it('adds a blueprint by name', () => {
    render(<BlueprintPanel />)
    fireEvent.change(screen.getByPlaceholderText('new blueprint name'), { target: { value: 'api' } })
    fireEvent.click(screen.getByText('+ Blueprint'))
    expect(Object.values(useWorldStore.getState().doc.blueprints)[0].name).toBe('api')
  })

  it('adds a dependency between two blueprints', () => {
    const apiId = useWorldStore.getState().addBlueprint('api')
    useWorldStore.getState().addBlueprint('pg')
    render(<BlueprintPanel />)
    fireEvent.click(screen.getAllByText('▸ deps')[0])         // expand api's dependency editor
    fireEvent.click(screen.getByText('+ Dependency'))
    const api = useWorldStore.getState().doc.blueprints[apiId]
    expect(api.dependencies).toHaveLength(1)
    expect(api.dependencies[0].target.kind).toBe('blueprint')
  })
})
