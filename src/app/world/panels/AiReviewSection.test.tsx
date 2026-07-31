// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AiReviewSection } from './AiReviewSection'
import { useWorldStore } from '../../store/world.store'
import { useNavStore } from '../../store/nav.store'
import * as tauri from '../../../lib/tauri'
import * as llmReview from '../../../lib/llmReview'
import { createRegion } from '../../../lib/world/factories'

vi.mock('../../../lib/tauri', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return { ...actual, loadLlmSettings: vi.fn() }
})
vi.mock('../../../lib/llmReview', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/llmReview')>()
  return { ...actual, buildReviewContext: vi.fn(() => '{}'), requestReview: vi.fn() }
})

const mockLoad = tauri.loadLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockRequestReview = llmReview.requestReview as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
  mockLoad.mockReset()
  mockRequestReview.mockReset()
})

describe('AiReviewSection', () => {
  it('unconfigured state links to settings', async () => {
    mockLoad.mockResolvedValue({ baseUrl: '', apiKey: '', model: '' })
    const openSettings = vi.fn()
    render(<AiReviewSection openSettings={openSettings} />)
    await waitFor(() => expect(screen.getByText(/Open Settings/i)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Open Settings/i))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('review renders cards on success', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValue([{
      title: 'Consider a read replica', severity: 'warning', confidence: 0.8, affected: [],
      reasoning: 'single writer under sustained load', recommendation: 'add a replica',
      estimated_effort: 'medium',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('Consider a read replica')).toBeInTheDocument())
    expect(screen.getByText('80%')).toBeInTheDocument()
  })

  it('in-flight disables the button', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    let resolveReview: (v: unknown) => void = () => {}
    mockRequestReview.mockReturnValue(new Promise(res => { resolveReview = res }))
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('reviewing…')).toBeInTheDocument())
    expect(screen.getByText('reviewing…').closest('button')).toBeDisabled()
    resolveReview([])
  })

  it('error keeps prior cards and shows message', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValueOnce([{
      title: 'first issue', severity: 'info', confidence: 0.5, affected: [],
      reasoning: 'r', recommendation: 'x', estimated_effort: 'low',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('first issue')).toBeInTheDocument())

    mockRequestReview.mockRejectedValueOnce(new Error('malformed review response'))
    fireEvent.click(screen.getByText('Review architecture'))
    await waitFor(() => expect(screen.getByText('malformed review response')).toBeInTheDocument())
    expect(screen.getByText('first issue')).toBeInTheDocument() // prior card retained
  })

  it('card affected chip navigates to a server', async () => {
    const region = createRegion('us-east-1')
    useWorldStore.setState(s => ({ doc: { ...s.doc, regions: { ...s.doc.regions, [region.id]: region } } }))
    mockLoad.mockResolvedValue({ baseUrl: 'http://localhost:4141/v1', apiKey: '', model: 'x' })
    mockRequestReview.mockResolvedValue([{
      title: 'region risk', severity: 'warning', confidence: 0.6, affected: [region.id],
      reasoning: 'r', recommendation: 'x', estimated_effort: 'low',
    }])
    render(<AiReviewSection openSettings={() => {}} />)
    await waitFor(() => expect(screen.getByText('Review architecture')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Review architecture'))
    // entityLabel resolves a region id to its catalogId ('us-east-1'), not the raw generated id
    await waitFor(() => expect(screen.getByText(region.catalogId)).toBeInTheDocument())
    fireEvent.click(screen.getByText(region.catalogId))
    expect(useNavStore.getState().level).toBe('region')
    expect(useNavStore.getState().regionId).toBe(region.id)
  })
})
