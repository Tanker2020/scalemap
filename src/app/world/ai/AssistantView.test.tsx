// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AssistantView } from './AssistantView'
import { useChatStore } from '../../store/chat.store'
import { useNavStore } from '../../store/nav.store'
import { useWorldStore } from '../../store/world.store'
import { requestAssistantTurn } from '../../../lib/aiChat'

// loadLlmSettings/LlmSettings live in lib/tauri.ts (not lib/llmReview.ts, despite the task brief's
// assumption — llmReview.ts only re-exports the LlmSettings TYPE via `pingLlm`'s signature, it
// does not define or re-export loadLlmSettings itself). Mock the real module.
vi.mock('../../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tauri')>()
  return { ...actual, loadLlmSettings: vi.fn().mockResolvedValue({ baseUrl: '', apiKey: '', model: '' }) }
})

// requestAssistantTurn is the actual LLM round-trip (sendChatTurn.ts's only await) — mocked here
// so the zombie-resolve test below can control exactly when the "response" arrives, without a
// real async LLM call.
vi.mock('../../../lib/aiChat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/aiChat')>()
  return { ...actual, requestAssistantTurn: vi.fn() }
})

beforeEach(() => {
  useWorldStore.getState().newWorld()
  useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null, windowRect: null })
  // Default: resolves immediately with a canned answer. Individual tests below override this
  // with their own controllable promise to simulate a still-pending turn.
  vi.mocked(requestAssistantTurn).mockReset().mockResolvedValue('mock answer')
})

describe('AssistantView', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<AssistantView open={false} onClose={() => {}} openSettings={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('Escape closes when the assistant surface has focus, without triggering nav.up()', () => {
    const onClose = vi.fn()
    useNavStore.setState({ level: 'server' } as never)
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    // The assistant is non-modal now (no backdrop), so its Escape handler only fires — and
    // consumes the event — when focus is actually inside the assistant surface. Focus the
    // composer textarea to represent "the user is interacting with the assistant."
    const textarea = screen.getByPlaceholderText(/Ask about/i)
    textarea.focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(useNavStore.getState().level).toBe('server')
  })

  it('Escape does NOT close the assistant (and does not stop propagation) when focus is outside it', () => {
    const onClose = vi.fn()
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    // Focus stays on document.body (nothing inside the assistant is focused) — mirrors a user
    // who has clicked into the globe/region/server view behind the non-modal window while it
    // stays open, and is now pressing Escape to act on THAT view, not the assistant.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Enter sends, Shift+Enter does not', async () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const textarea = screen.getByPlaceholderText(/Ask about/i)
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(useChatStore.getState().turns).toHaveLength(0)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    // send() is async (it awaits a fresh loadLlmSettings() call before beginTurn) — assert once
    // the turn has actually landed instead of assuming synchronous completion.
    await waitFor(() => expect(useChatStore.getState().turns.length).toBeGreaterThan(0))
  })

  it('closing the overlay while a turn is pending abandons it — a late resolve does not land', async () => {
    let resolveTurn: (answer: string) => void = () => {}
    vi.mocked(requestAssistantTurn).mockImplementation(
      () => new Promise<string>(res => { resolveTurn = res }),
    )

    const onClose = vi.fn()
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    const textarea = screen.getByPlaceholderText(/Ask about/i)
    textarea.focus() // Escape below must land inside the (now non-modal) assistant surface.
    fireEvent.change(textarea, { target: { value: 'what happened' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    // The turn is now pending — wait for beginTurn() to have run.
    await waitFor(() => expect(useChatStore.getState().inFlightTurnId).not.toBeNull())
    const turnId = useChatStore.getState().inFlightTurnId!

    // Close the overlay (mirrors Escape) while the request is still in flight.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(useChatStore.getState().inFlightTurnId).toBeNull()

    // The "response" arrives after the overlay has already been closed/abandoned.
    resolveTurn('late answer that should be dropped')
    await Promise.resolve()
    await Promise.resolve()

    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('pending')
    expect(turn?.answer).toBe('')
  })

  it('sending a new question while one is in flight abandons the old one instead of racing it', async () => {
    const resolvers: ((answer: string) => void)[] = []
    vi.mocked(requestAssistantTurn).mockImplementation(
      () => new Promise<string>(res => { resolvers.push(res) }),
    )

    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const textarea = screen.getByPlaceholderText(/Ask about/i)

    fireEvent.change(textarea, { target: { value: 'first question' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    await waitFor(() => expect(useChatStore.getState().turns.length).toBe(1))
    const firstTurnId = useChatStore.getState().turns[0].id

    fireEvent.change(textarea, { target: { value: 'second question' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })
    await waitFor(() => expect(useChatStore.getState().turns.length).toBe(2))
    const secondTurnId = useChatStore.getState().turns[1].id

    // Resolve BOTH pending requests (first was superseded, second is live) and confirm only the
    // second turn's answer actually lands.
    resolvers[0]?.('stale first answer')
    resolvers[1]?.('second answer')
    await Promise.resolve()
    await Promise.resolve()

    const turns = useChatStore.getState().turns
    expect(turns.find(t => t.id === firstTurnId)?.status).toBe('pending')
    expect(turns.find(t => t.id === secondTurnId)?.answer).toBe('second answer')
  })

  it('dragging the header moves the window by the drag delta', async () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const header = screen.getByText('AI Assistant').closest('div') as HTMLElement
    // windowRect starts null (beforeEach), so the rendered position comes from the computed
    // default — read it off the DOM rather than the store so this test doesn't depend on
    // jsdom's exact viewport dimensions or assume windowRect is already set.
    const surface = header.parentElement as HTMLElement
    const startLeft = parseFloat(surface.style.left)
    const startTop = parseFloat(surface.style.top)

    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 150, clientY: 130 })
    fireEvent.pointerUp(window)

    const rect = useChatStore.getState().windowRect
    expect(rect).not.toBeNull()
    expect(rect!.x).toBe(startLeft + 50)
    expect(rect!.y).toBe(startTop + 30)
  })

  it('clicking a header button does not start a drag', () => {
    const onClose = vi.fn()
    render(<AssistantView open={true} onClose={onClose} openSettings={() => {}} />)
    const closeBtn = screen.getByText('close')
    fireEvent.pointerDown(closeBtn, { clientX: 200, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300 })
    fireEvent.pointerUp(window)
    // windowRect should still be unset (or unchanged) — the drag never engaged for a button target.
    expect(useChatStore.getState().windowRect).toBeNull()
  })

  it('resizing from the corner handle updates stored width/height and respects the minimum size', async () => {
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const handle = screen.getByRole('button', { name: 'resize' })
    fireEvent.pointerDown(handle, { clientX: 500, clientY: 500 })
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 }) // drag far up-left — should clamp to the floor
    fireEvent.pointerUp(window)
    const rect = useChatStore.getState().windowRect!
    expect(rect.width).toBe(380)
    expect(rect.height).toBe(320)
  })

  it('position/size survive a close-then-reopen cycle within the same session', async () => {
    const { rerender } = render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const header = screen.getByText('AI Assistant').closest('div') as HTMLElement
    fireEvent.pointerDown(header, { clientX: 0, clientY: 0 })
    fireEvent.pointerMove(window, { clientX: 20, clientY: 20 })
    fireEvent.pointerUp(window)
    const rectAfterDrag = useChatStore.getState().windowRect

    rerender(<AssistantView open={false} onClose={() => {}} openSettings={() => {}} />)
    rerender(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)

    expect(useChatStore.getState().windowRect).toEqual(rectAfterDrag)
  })

  it('unmounting mid-drag removes the window listeners instead of leaking a late pointerup into the store', () => {
    const { unmount } = render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const header = screen.getByText('AI Assistant').closest('div') as HTMLElement

    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 150, clientY: 130 })
    // Unmount while the drag is still in progress — the component (and thus onClose) is gone
    // before pointerup ever fires, mirroring WorldShell unmounting mid-drag.
    unmount()

    // A pointerup that arrives after unmount must NOT write a stale windowRect: the cleanup
    // effect should have already removed the window-level listeners.
    fireEvent.pointerUp(window)
    expect(useChatStore.getState().windowRect).toBeNull()
  })

  it('re-clamps an out-of-viewport stored windowRect on render, instead of stranding the window', () => {
    // jsdom's default viewport is 1024x768 — a rect stored while the app window was much larger
    // (or before an OS-level resize/undock shrank it) can now sit entirely outside the current
    // viewport, with no "reset position" affordance anywhere in the UI to recover it.
    useChatStore.getState().setWindowRect({ x: 5000, y: 5000, width: 720, height: 600 })
    render(<AssistantView open={true} onClose={() => {}} openSettings={() => {}} />)
    const header = screen.getByText('AI Assistant').closest('div') as HTMLElement
    const surface = header.parentElement as HTMLElement
    const left = parseFloat(surface.style.left)
    const top = parseFloat(surface.style.top)
    expect(left).not.toBe(5000)
    expect(top).not.toBe(5000)
    expect(left).toBeLessThanOrEqual(window.innerWidth)
    expect(top).toBeLessThanOrEqual(window.innerHeight)
  })
})
