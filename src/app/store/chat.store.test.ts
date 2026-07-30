import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from './chat.store'

beforeEach(() => {
  useChatStore.setState({ turns: [], draft: '', selected: [], requestGen: 0, inFlightTurnId: null })
})

describe('chat.store', () => {
  it('toggleAttachment adds and removes without duplicates', () => {
    useChatStore.getState().toggleAttachment({ kind: 'events' })
    expect(useChatStore.getState().selected).toEqual([{ kind: 'events' }])
    useChatStore.getState().toggleAttachment({ kind: 'events' })
    expect(useChatStore.getState().selected).toEqual([])
  })

  it('beginTurn appends a pending turn and bumps nothing else', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 100, false)
    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('pending')
    expect(useChatStore.getState().inFlightTurnId).toBe(turnId)
    expect(gen).toBe(useChatStore.getState().requestGen)
  })

  it('resolveTurn marks the turn done when gen matches current', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().resolveTurn(turnId, gen, 'the answer')
    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('done')
    expect(turn?.answer).toBe('the answer')
    expect(useChatStore.getState().inFlightTurnId).toBeNull()
  })

  it('resolveTurn is a no-op after abandonInFlight bumped the generation', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().abandonInFlight()
    useChatStore.getState().resolveTurn(turnId, gen, 'late answer')
    const turn = useChatStore.getState().turns.find(t => t.id === turnId)
    expect(turn?.status).toBe('pending') // untouched — the stale resolve was dropped
  })

  it('overlapping turns do not cross-write each other', () => {
    const first = useChatStore.getState().beginTurn('q1', [], 0, false)
    useChatStore.getState().abandonInFlight()
    const second = useChatStore.getState().beginTurn('q2', [], 0, false)
    useChatStore.getState().resolveTurn(second.turnId, second.gen, 'answer2')
    useChatStore.getState().resolveTurn(first.turnId, first.gen, 'stale answer1')
    const turns = useChatStore.getState().turns
    expect(turns.find(t => t.id === second.turnId)?.answer).toBe('answer2')
    expect(turns.find(t => t.id === first.turnId)?.status).toBe('pending')
  })

  it('failTurn marks the turn error when gen matches', () => {
    const { turnId, gen } = useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().failTurn(turnId, gen, 'boom')
    expect(useChatStore.getState().turns.find(t => t.id === turnId)?.status).toBe('error')
  })

  it('clearTranscript empties turns but keeps draft', () => {
    useChatStore.getState().setDraft('hello')
    useChatStore.getState().beginTurn('q', [], 0, false)
    useChatStore.getState().clearTranscript()
    expect(useChatStore.getState().turns).toEqual([])
    expect(useChatStore.getState().draft).toBe('hello')
  })
})
