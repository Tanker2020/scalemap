import { describe, it, expect, beforeEach } from 'vitest'
import { useNavStore } from './nav.store'

beforeEach(() => useNavStore.getState().goGlobe())

describe('nav.store', () => {
  it('descends globe → region → az → server carrying full lineage', () => {
    useNavStore.getState().goServer('r1', 'az1', 'srv1')
    expect(useNavStore.getState()).toMatchObject({ level: 'server', regionId: 'r1', azId: 'az1', serverId: 'srv1' })
  })

  it('up() climbs one level at a time and clears the abandoned focus', () => {
    useNavStore.getState().goServer('r1', 'az1', 'srv1')
    useNavStore.getState().up()
    expect(useNavStore.getState()).toMatchObject({ level: 'az', azId: 'az1', serverId: null })
    useNavStore.getState().up()
    expect(useNavStore.getState()).toMatchObject({ level: 'region', regionId: 'r1', azId: null })
    useNavStore.getState().up()
    expect(useNavStore.getState()).toMatchObject({ level: 'globe', regionId: null })
    useNavStore.getState().up() // no-op at the top
    expect(useNavStore.getState().level).toBe('globe')
  })

  it('goRegion resets deeper focus', () => {
    useNavStore.getState().goServer('r1', 'az1', 'srv1')
    useNavStore.getState().goRegion('r2')
    expect(useNavStore.getState()).toMatchObject({ level: 'region', regionId: 'r2', azId: null, serverId: null })
  })
})
