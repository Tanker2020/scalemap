// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HomeScreen } from './HomeScreen'
import { useWorldStore } from '../store/world.store'
import { useFileStore } from '../store/file.store'
import { useNavStore } from '../store/nav.store'
import { useUiStore } from '../store/ui.store'

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useFileStore.setState({ showHome: true, filePath: 'old.scalemap', dirty: true, createdIso: 'x' })
  useUiStore.setState({ pendingPanelTab: null })
})

describe('HomeScreen vault', () => {
  it('renders all four cards with difficulty pills', () => {
    render(<HomeScreen />)
    expect(screen.getByText('Start from an example')).toBeInTheDocument()
    expect(screen.getByText('Classic three-tier')).toBeInTheDocument()
    expect(screen.getByText('Multi-region failover')).toBeInTheDocument()
    expect(screen.getByText('Event-driven microservices')).toBeInTheDocument()
    expect(screen.getByText('Everything wrong at once')).toBeInTheDocument()
    expect(screen.getByText('teaching')).toBeInTheDocument()
  })

  it('opening an example loads the world, resets file state, and dismisses home', () => {
    render(<HomeScreen />)
    fireEvent.click(screen.getByText('Classic three-tier'))
    const s = useWorldStore.getState()
    expect(Object.keys(s.doc.servers)).toHaveLength(6)
    expect(s.history).toHaveLength(0)
    const f = useFileStore.getState()
    expect(f.showHome).toBe(false)
    expect(f.filePath).toBeNull()
    expect(f.dirty).toBe(false)
    expect(f.createdIso).toBeNull()
    expect(useNavStore.getState().level).toBe('globe')
    expect(useUiStore.getState().pendingPanelTab).toBeNull()   // only the teaching card queues a tab
  })

  it('the teaching card queues the analysis tab', () => {
    render(<HomeScreen />)
    fireEvent.click(screen.getByText('Everything wrong at once'))
    expect(useUiStore.getState().pendingPanelTab).toBe('analysis')
  })
})
