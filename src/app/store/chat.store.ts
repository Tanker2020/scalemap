import { create } from 'zustand'
import type { Attachment } from '../../lib/aiChat/context'

export interface ChatTurn {
  id: string
  askedAt: number
  question: string
  attachments: Attachment[]
  contextTokens: number
  worldChangedSincePrev: boolean
  status: 'pending' | 'done' | 'error'
  answer: string
  error: string
}

interface ChatStore {
  turns: ChatTurn[]
  draft: string
  selected: Attachment[]
  requestGen: number
  inFlightTurnId: string | null
  setDraft: (d: string) => void
  toggleAttachment: (a: Attachment) => void
  clearAttachments: () => void
  clearTranscript: () => void
  beginTurn: (question: string, attachments: Attachment[], contextTokens: number, worldChangedSincePrev: boolean) => { turnId: string; gen: number }
  resolveTurn: (turnId: string, gen: number, answer: string) => void
  failTurn: (turnId: string, gen: number, message: string) => void
  abandonInFlight: () => void
}

function attachmentKeyLocal(a: Attachment): string {
  if (a.kind === 'entity') return `entity:${a.id}`
  if (a.kind === 'traces') return `traces:${JSON.stringify(a.scope)}`
  return a.kind
}

let nextTurnId = 0

export const useChatStore = create<ChatStore>((set, get) => ({
  turns: [],
  draft: '',
  selected: [],
  requestGen: 0,
  inFlightTurnId: null,

  setDraft: (d) => set({ draft: d }),

  toggleAttachment: (a) => set(state => {
    const key = attachmentKeyLocal(a)
    const exists = state.selected.some(s => attachmentKeyLocal(s) === key)
    return { selected: exists ? state.selected.filter(s => attachmentKeyLocal(s) !== key) : [...state.selected, a] }
  }),

  clearAttachments: () => set({ selected: [] }),

  clearTranscript: () => set({ turns: [] }),

  beginTurn: (question, attachments, contextTokens, worldChangedSincePrev) => {
    const turnId = `turn-${nextTurnId++}`
    const gen = get().requestGen
    const turn: ChatTurn = {
      id: turnId, askedAt: Date.now(), question, attachments, contextTokens,
      worldChangedSincePrev, status: 'pending', answer: '', error: '',
    }
    set(state => ({ turns: [...state.turns, turn], inFlightTurnId: turnId }))
    return { turnId, gen }
  },

  resolveTurn: (turnId, gen, answer) => {
    if (gen !== get().requestGen) return
    set(state => ({
      turns: state.turns.map(t => t.id === turnId ? { ...t, status: 'done', answer } : t),
      inFlightTurnId: state.inFlightTurnId === turnId ? null : state.inFlightTurnId,
    }))
  },

  failTurn: (turnId, gen, message) => {
    if (gen !== get().requestGen) return
    set(state => ({
      turns: state.turns.map(t => t.id === turnId ? { ...t, status: 'error', error: message } : t),
      inFlightTurnId: state.inFlightTurnId === turnId ? null : state.inFlightTurnId,
    }))
  },

  abandonInFlight: () => set(state => ({ requestGen: state.requestGen + 1, inFlightTurnId: null })),
}))
