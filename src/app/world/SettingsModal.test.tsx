// src/app/world/SettingsModal.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsModal } from './SettingsModal'
import { useUiStore } from '../store/ui.store'
import { useNavStore } from '../store/nav.store'
import * as tauri from '../../lib/tauri'
import * as llmReview from '../../lib/llmReview'

// loadLlmSettings/saveLlmSettings live in ../../lib/tauri (Task 5); pingLlm lives in
// ../../lib/llmReview (Task 6) — the two mocks below mirror that real module split rather than
// the single-module mock the task brief sketched, which predates Task 6 landing pingLlm in its
// own file (verified: pingLlm has no export from src/lib/tauri.ts — see llmReview.ts:138).
vi.mock('../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../lib/tauri')>('../../lib/tauri')
  return { ...actual, loadLlmSettings: vi.fn(), saveLlmSettings: vi.fn() }
})
vi.mock('../../lib/llmReview', async () => {
  const actual = await vi.importActual<typeof import('../../lib/llmReview')>('../../lib/llmReview')
  return { ...actual, pingLlm: vi.fn() }
})

const mockLoad = tauri.loadLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockSave = tauri.saveLlmSettings as unknown as ReturnType<typeof vi.fn>
const mockPing = llmReview.pingLlm as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockLoad.mockReset().mockResolvedValue({ baseUrl: '', apiKey: '', model: '' })
  mockSave.mockReset().mockResolvedValue(undefined)
  mockPing.mockReset().mockResolvedValue(undefined)
  useUiStore.setState({ themeMode: 'dark' })
  useNavStore.setState({ level: 'globe', regionId: null, azId: null, serverId: null })
})

describe('SettingsModal', () => {
  it('returns null when closed', () => {
    const { container } = render(<SettingsModal open={false} onClose={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('theme toggle reflects and sets themeMode', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    expect(screen.getByText('dark')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByText('light'))
    expect(useUiStore.getState().themeMode).toBe('light')
    expect(screen.getByText('light')).toHaveAttribute('aria-pressed', 'true')
  })

  it('esc closes without changing nav level', async () => {
    // Mirrors WorldShell's real bubble-phase Escape handler verbatim (see this task's grounding
    // quote) — bail if defaultPrevented, else nav.up(). Registered on window BEFORE the modal
    // mounts, so a bubble-phase listener here would fire FIRST if registration order (not
    // capture-vs-bubble) were what determined the outcome — same proof technique as
    // ServerView.interaction.test.tsx.
    const worldShellLikeHandler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') useNavStore.getState().up()
    }
    window.addEventListener('keydown', worldShellLikeHandler)
    const onClose = vi.fn()
    try {
      render(<SettingsModal open={true} onClose={onClose} />)
      await waitFor(() => expect(mockLoad).toHaveBeenCalled())
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(useNavStore.getState().level).toBe('globe')
    } finally {
      window.removeEventListener('keydown', worldShellLikeHandler)
    }
  })

  it('saved key renders masked and is not echoed into the input value', async () => {
    mockLoad.mockResolvedValue({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-abcdefgh1234', model: 'gpt-4o-mini' })
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('apiKey')).toHaveAttribute('placeholder', '•••• 1234'))
    expect(screen.getByLabelText('apiKey')).toHaveValue('')
  })

  it('save dispatches saveLlmSettings with typed values', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('baseUrl'), { target: { value: 'http://localhost:4141/v1' } })
    fireEvent.change(screen.getByLabelText('apiKey'), { target: { value: 'sk-new-key-999' } })
    fireEvent.change(screen.getByLabelText('model'), { target: { value: 'gpt-4o-mini' } })
    fireEvent.click(screen.getByText('Save'))

    expect(mockSave).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4141/v1', apiKey: 'sk-new-key-999', model: 'gpt-4o-mini' })
  })

  it('test connection surfaces ping success and failure', async () => {
    render(<SettingsModal open={true} onClose={() => {}} />)
    await waitFor(() => expect(mockLoad).toHaveBeenCalled())

    mockPing.mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(screen.getByText('ok')).toBeInTheDocument())

    mockPing.mockRejectedValueOnce(new Error('connection refused'))
    fireEvent.click(screen.getByText('Test connection'))
    await waitFor(() => expect(screen.getByText('connection refused')).toBeInTheDocument())
  })
})
