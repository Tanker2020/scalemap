import { describe, it, expect, vi } from 'vitest'
import { sendChatTurn } from './sendChatTurn'
import { useChatStore } from '../../store/chat.store'
import type { LlmSettings } from '../../../lib/tauri'
import type { ChatContextInput } from '../../../lib/aiChat/context'

const settings: LlmSettings = { baseUrl: 'http://x', apiKey: 'k', model: 'm' }
const contextInput: ChatContextInput = {
  doc: { routing: {}, regions: {}, azs: {}, servers: {}, blueprints: {}, placements: {}, managedServices: {}, populations: {} } as never,
  compiled: { instances: {}, paths: [], findings: [], routing: {} } as never,
  findings: [], compileFindings: [], latestBatch: null, events: [], replayFrames: [],
}

describe('sendChatTurn', () => {
  it('resolves the turn with the assistant answer on success', async () => {
    useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
    const chat = vi.fn().mockResolvedValue(JSON.stringify({ choices: [{ message: { content: 'the answer' } }] }))
    await sendChatTurn(settings, 'why?', [], contextInput, chat)
    const turn = useChatStore.getState().turns[0]
    expect(turn.status).toBe('done')
    expect(turn.answer).toBe('the answer')
  })

  it('fails the turn with the error message on rejection', async () => {
    useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
    const chat = vi.fn().mockRejectedValue(new Error('network down'))
    await sendChatTurn(settings, 'why?', [], contextInput, chat)
    const turn = useChatStore.getState().turns[0]
    expect(turn.status).toBe('error')
    expect(turn.error).toBe('network down')
  })
})
