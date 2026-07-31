import { create } from 'zustand'
import { attachmentKey, type Attachment } from '../../lib/aiChat/context'

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

export interface WindowRect { x: number; y: number; width: number; height: number }

interface ChatStore {
  turns: ChatTurn[]
  draft: string
  selected: Attachment[]
  requestGen: number
  inFlightTurnId: string | null
  windowRect: WindowRect | null
  setDraft: (d: string) => void
  toggleAttachment: (a: Attachment) => void
  clearAttachments: () => void
  clearTranscript: () => void
  setWindowRect: (rect: WindowRect) => void
  beginTurn: (question: string, attachments: Attachment[], contextTokens: number, worldChangedSincePrev: boolean) => { turnId: string; gen: number }
  resolveTurn: (turnId: string, gen: number, answer: string) => void
  failTurn: (turnId: string, gen: number, message: string) => void
  abandonInFlight: () => void
}

let nextTurnId = 0

export const useChatStore = create<ChatStore>((set, get) => ({
  turns: [],
  draft: '',
  selected: [],
  requestGen: 0,
  inFlightTurnId: null,
  windowRect: null,

  setDraft: (d) => set({ draft: d }),

  setWindowRect: (rect) => set({ windowRect: rect }),

  toggleAttachment: (a) => set(state => {
    const key = attachmentKey(a)
    const exists = state.selected.some(s => attachmentKey(s) === key)
    return { selected: exists ? state.selected.filter(s => attachmentKey(s) !== key) : [...state.selected, a] }
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

  // The store itself stays synchronous (no async actions, matching every other store in this
  // app) — the actual LLM request happens outside it, in sendChatTurn.ts. `gen` is the
  // requestGen captured at beginTurn() time; comparing it against the CURRENT requestGen here
  // mirrors simulation.store.ts's `eventGen` idiom (bumped on stop()/start()/resetSession() to
  // orphan a stale event-buffer flush) — abandonInFlight() bumps requestGen so a late resolve/
  // fail from an abandoned turn is dropped instead of overwriting a newer turn's state.
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
