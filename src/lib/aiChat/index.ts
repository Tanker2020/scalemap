import { chatComplete, type ChatMessage } from '../llmClient'
import type { LlmSettings } from '../tauri'
import type { llmChat } from '../tauri'
import { ASSISTANT_SYSTEM_PROMPT } from './prompt'
import { buildChatDigest, buildContextBlock, type Attachment, type ChatContextInput } from './context'

export const HISTORY_TURN_CAP = 12

export interface AssistantTurnRequest {
  question: string
  attachments: Attachment[]
  history: { role: 'user' | 'assistant'; content: string }[]
  contextInput: ChatContextInput
}

export async function requestAssistantTurn(
  settings: LlmSettings, req: AssistantTurnRequest, chat: typeof llmChat,
): Promise<string> {
  const digest = buildChatDigest(req.contextInput)
  const attachmentBlock = buildContextBlock(req.attachments, req.contextInput)
  const contextContent = attachmentBlock ? `${digest}\n\n${attachmentBlock}` : digest

  const cappedHistory = req.history.slice(-HISTORY_TURN_CAP * 2)

  const messages: ChatMessage[] = [
    { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
    { role: 'system', content: contextContent },
    ...cappedHistory,
    { role: 'user', content: req.question },
  ]

  return chatComplete(settings, messages, { temperature: 0.2 }, chat)
}
