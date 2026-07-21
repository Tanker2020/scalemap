// Shared v3 file flows for HomeScreen and WorldShell.
import { saveDiagram, loadDiagram, openFileDialog, saveFileDialog } from '../../lib/tauri'
import { serializeWorld, deserializeWorld } from '../../lib/serializer'
import { useWorldStore } from '../store/world.store'
import { useFileStore } from '../store/file.store'
import { useNavStore } from '../store/nav.store'

export async function openWorldFromPath(path: string): Promise<void> {
  const raw = await loadDiagram(path)
  const file = deserializeWorld(raw)   // throws on v1/invalid — caller shows the message
  useWorldStore.getState().replaceWorld(file.world)
  useFileStore.getState().setCreatedIso(file.meta.created)
  const vs = file.viewState
  const nav = useNavStore.getState()
  if (vs?.level === 'server' && vs.regionId && vs.azId && vs.serverId) nav.goServer(vs.regionId, vs.azId, vs.serverId)
  else if (vs?.level === 'az' && vs.regionId && vs.azId) nav.goAz(vs.regionId, vs.azId)
  else if (vs?.level === 'region' && vs.regionId) nav.goRegion(vs.regionId)
  else nav.goGlobe()
  useFileStore.getState().markSaved(path)
}

export async function openWorldViaDialog(): Promise<string | null> {
  const path = await openFileDialog()
  if (!path) return null
  await openWorldFromPath(path)
  return path
}

export async function saveWorld(opts: { forceDialog?: boolean } = {}): Promise<void> {
  let path = opts.forceDialog ? null : useFileStore.getState().filePath
  if (!path) path = await saveFileDialog()
  if (!path) return
  const nav = useNavStore.getState()
  const created = useFileStore.getState().createdIso ?? new Date().toISOString()
  const name = (path.split('/').pop() ?? 'world').replace('.scalemap', '')
  const json = serializeWorld(useWorldStore.getState().doc, name, created, undefined, {
    level: nav.level,
    regionId: nav.regionId ?? undefined,
    azId: nav.azId ?? undefined,
    serverId: nav.serverId ?? undefined,
  })
  await saveDiagram(path, json)
  useFileStore.getState().setCreatedIso(created)
  useFileStore.getState().markSaved(path)
}
