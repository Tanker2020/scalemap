import { create } from 'zustand'

export type WorldLevel = 'globe' | 'region' | 'az' | 'server'

interface NavStore {
  level: WorldLevel
  regionId: string | null
  azId: string | null
  serverId: string | null
  goGlobe: () => void
  goRegion: (regionId: string) => void
  goAz: (regionId: string, azId: string) => void
  goServer: (regionId: string, azId: string, serverId: string) => void
  up: () => void
}

export const useNavStore = create<NavStore>((set, get) => ({
  level: 'globe',
  regionId: null,
  azId: null,
  serverId: null,

  goGlobe: () => set({ level: 'globe', regionId: null, azId: null, serverId: null }),
  goRegion: (regionId) => set({ level: 'region', regionId, azId: null, serverId: null }),
  goAz: (regionId, azId) => set({ level: 'az', regionId, azId, serverId: null }),
  goServer: (regionId, azId, serverId) => set({ level: 'server', regionId, azId, serverId }),

  up: () => {
    const { level, regionId, azId } = get()
    if (level === 'server' && regionId && azId) return get().goAz(regionId, azId)
    if (level === 'az' && regionId) return get().goRegion(regionId)
    if (level === 'region') return get().goGlobe()
  },
}))
