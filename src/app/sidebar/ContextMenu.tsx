import { useEffect, useRef } from 'react'
import { useCanvasStore } from '../store/canvas.store'
import { useUiStore } from '../store/ui.store'
import styles from './ContextMenu.module.css'

interface Props {
  x: number
  y: number
  targetId: string
  targetType: 'node' | 'edge'
  onClose: () => void
}

export function ContextMenu({ x, y, targetId, targetType, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const { removeNodes, duplicateNode, removeEdges } = useCanvasStore()
  const { setSelectedNode } = useUiStore()

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', keyHandler) }
  }, [onClose])

  const action = (fn: () => void) => { fn(); onClose() }

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: x, top: y }}
    >
      {targetType === 'node' && (
        <>
          <button className={styles.item} onClick={() => action(() => { duplicateNode(targetId); setSelectedNode(targetId) })}>
            Duplicate
          </button>
          <div className={styles.sep} />
          <button className={`${styles.item} ${styles.danger}`} onClick={() => action(() => removeNodes([targetId]))}>
            Delete
          </button>
        </>
      )}
      {targetType === 'edge' && (
        <>
          <button className={`${styles.item} ${styles.danger}`} onClick={() => action(() => removeEdges([targetId]))}>
            Delete edge
          </button>
        </>
      )}
    </div>
  )
}
