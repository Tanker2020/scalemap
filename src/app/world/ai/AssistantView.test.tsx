// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AssistantView } from './AssistantView'
import { useChatStore } from '../../store/chat.store'
import { useNavStore } from '../../store/nav.store'
import { useWorldStore } from '../../store/world.store'

// loadLlmSettings/LlmSettings live in lib/tauri.ts (not lib/llmReview.ts, despite the task brief's
// assumption — llmReview.ts only re-exports the LlmSettings TYPE via `pingLlm`'s signature, it
// does not define or re-export loadLlmSettings itself). Mock the real module.
vi.mock('../../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return { ...actual, loadLlmSettings: vi.fn().mockResolvedValue({ baseUrl: '', apiKey: '', model: '' }) }
})

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
})

describe('AssistantView', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<AssistantView open={false} onClose={() => {}} openSettings={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('Escape closes without triggering nav.up()', () => {
    const onClose = vi.fn()
    useNavStore.setState({ level: 'server' } as never)
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(useNavStore.getState().level).toBe('server')
  })

  it('Enter sends, Shift+Enter does not', () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const textarea = screen.getByPlaceholderText(/Ask about/i)
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(useChatStore.getState().turns).toHaveLength(0)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    expect(useChatStore.getState().turns.length).toBeGreaterThan(0)
  })
})
