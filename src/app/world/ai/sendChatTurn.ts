import { useChatStore } from '../../store/chat.store'
import { requestAssistantTurn } from '../../../lib/aiChat'
import { estimateTokens, buildChatDigest, buildContextBlock, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
import type { LlmSettings } from '../../../lib/tauri'
import { llmChat } from '../../../lib/tauri'

// chat.store.ts stays synchronous by design (no store in this app has async actions), so the
// actual await'ed LLM round-trip lives here instead. The turnId/gen captured from beginTurn()
// are passed straight through to resolveTurn/failTurn — that gen check is the same
// generation-counter idiom simulation.store.ts uses for its `eventGen` (orphaning a stale
// event-buffer flush after stop()/start()/resetSession()): if abandonInFlight() bumped
// requestGen while this request was in flight, the resolve/fail below becomes a silent no-op.
export async function sendChatTurn(
  settings: LlmSettings,
  question: string,
  attachments: Attachment[],
  contextInput: ChatContextInput,
  chat: typeof llmChat = llmChat,
): Promise<void> {
  const store = useChatStore.getState()
  const contextTokens = estimateTokens(buildChatDigest(contextInput) + buildContextBlock(attachments, contextInput))
  const history = store.turns
    .filter(t => t.status === 'done')
    .flatMap(t => [{ role: 'user' as const, content: t.question }, { role: 'assistant' as const, content: t.answer }])

  const { turnId, gen } = store.beginTurn(question, attachments, contextTokens, false)
  try {
    const answer = await requestAssistantTurn(settings, { question, attachments, history, contextInput }, chat)
    useChatStore.getState().resolveTurn(turnId, gen, answer)
  } catch (err) {
    useChatStore.getState().failTurn(turnId, gen, err instanceof Error ? err.message : String(err))
  }
}
