import { useCallback } from 'react'
import { useCanvasStore } from '../store/canvas.store'
import { useFileStore } from '../store/file.store'
import { saveDiagram, saveFileDialog } from '../../lib/tauri'
import { serialize } from '../../lib/serializer'

export function useSaveDiagram() {
  const { nodes, edges, viewport } = useCanvasStore()
  const { filePath, fileName, markSaved } = useFileStore()

  return useCallback(async () => {
    let path = filePath
    if (!path) {
      path = await saveFileDialog()
      if (!path) return
    }
    const data = serialize(nodes, edges, viewport, fileName ?? 'Untitled', new Date().toISOString())
    await saveDiagram(path, data)
    markSaved(path)
  }, [nodes, edges, viewport, filePath, fileName, markSaved])
}
