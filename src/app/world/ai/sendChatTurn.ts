import { useChatStore } from '../../store/chat.store'
import { requestAssistantTurn } from '../../../lib/aiChat'
import { estimateTokens, buildChatDigest, buildContextBlock, type Attachment, type ChatContextInput } from '../../../lib/aiChat/context'
import type { LlmSettings } from '../../../lib/tauri'
import { llmChat } from '../../../lib/tauri'

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
