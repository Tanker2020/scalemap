import { useCallback } from 'react'
import { useCanvasStore } from '../store/canvas.store'
import { useFileStore } from '../store/file.store'
import { saveDiagram, saveFileDialog } from '../../lib/tauri'
import { serialize } from '../../lib/serializer'

export function useSaveDiagram() {
  const { nodes, edges, viewport, packetMode, packetTemplates, nextTemplateId } = useCanvasStore()
  const { filePath, fileName, markSaved } = useFileStore()

  return useCallback(async () => {
    let path = filePath
    if (!path) {
      path = await saveFileDialog()
      if (!path) return
    }
    const data = serialize(nodes, edges, viewport, fileName ?? 'Untitled', new Date().toISOString(), {
      mode: packetMode, templates: packetTemplates, nextId: nextTemplateId,
    })
    await saveDiagram(path, data)
    markSaved(path)
  }, [nodes, edges, viewport, packetMode, packetTemplates, nextTemplateId, filePath, fileName, markSaved])
}
