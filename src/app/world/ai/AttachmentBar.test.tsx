// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AttachmentBar } from './AttachmentBar'
import { useChatStore } from '../../store/chat.store'
import { useUiStore } from '../../store/ui.store'
import type { ChatContextInput } from '../../../lib/aiChat/context'

function baseContextInput(): ChatContextInput {
  return {
    doc: {
      routing: { policy: 'latency', dnsTtlSec: 30, healthCheckIntervalMs: 10000, healthCheckFailureThreshold: 3 },
      regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {}, populations: {},
    } as never,
    compiled: { instances: {}, paths: [], findings: [], routing: {} } as never,
    findings: [], compileFindings: [], latestBatch: null, events: [], replayFrames: [],
  }
}

beforeEach(() => {
  useChatStore.setState({ selected: [] })
  useUiStore.setState({ selectedServerId: null } as never)
})

describe('AttachmentBar', () => {
  it('renders the token-cost disclosure caption', () => {
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    expect(screen.getByText(/sent to the model with every message/i)).toBeTruthy()
  })

  it('renders each attachment as a real, unchecked checkbox input by default', () => {
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.length).toBe(4) // events, replay, findings, topology (no selected server, so no entity chip)
    expect(boxes.every(b => b.checked === false)).toBe(true)
  })

  it('clicking a checkbox label toggles the store selection', () => {
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    const eventsBox = screen.getAllByRole('checkbox')[0] as HTMLInputElement
    fireEvent.click(eventsBox)
    expect(useChatStore.getState().selected).toEqual([{ kind: 'events' }])
    fireEvent.click(eventsBox)
    expect(useChatStore.getState().selected).toEqual([])
  })

  it('reflects store selection as checked', () => {
    useChatStore.setState({ selected: [{ kind: 'replay' }] })
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    const replayBox = boxes.find(b => b.id.includes('replay'))!
    expect(replayBox.checked).toBe(true)
  })

  it('shows an entity checkbox when a server is selected', () => {
    useUiStore.setState({ selectedServerId: 'srv-1' } as never)
    render(<AttachmentBar contextInput={baseContextInput()} running={false} />)
    expect(screen.getAllByRole('checkbox').length).toBe(5)
  })
})
