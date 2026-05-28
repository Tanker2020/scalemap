import { useState } from 'react'
import { NodeResizer, type NodeProps } from '@xyflow/react'
import type { NodeData, NodeType } from '../../../lib/nodeConfig'
import { NODE_CONFIG } from '../../../lib/nodeConfig'
import { CATEGORY_COLORS } from '../../../lib/theme'
import { useCanvasStore } from '../../store/canvas.store'
import styles from './GroupNode.module.css'

export function GroupNode({ id, type, data, selected }: NodeProps) {
  const nodeData = data as NodeData
  const nodeType = type as NodeType
  const config = NODE_CONFIG[nodeType]
  if (!config) return null

  const colors = CATEGORY_COLORS[config.category]
  const [collapsed, setCollapsed] = useState(false)
  const updateNodeData = useCanvasStore(s => s.updateNodeData)
  const childCount = useCanvasStore(s => s.nodes.filter(n => n.parentId === id).length)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(nodeData.label)

  const commitEdit = () => {
    setEditing(false)
    if (editValue.trim()) updateNodeData(id, { label: editValue.trim() })
    else setEditValue(nodeData.label)
  }

  return (
    <div
      className={`${styles.group} ${selected ? styles.selected : ''} ${collapsed ? styles.collapsed : ''}`}
      style={{ '--accent': colors.accent } as React.CSSProperties}
    >
      {!collapsed && (
        <NodeResizer
          minWidth={200}
          minHeight={120}
          isVisible={selected}
          handleStyle={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: colors.accent,
            border: `2px solid #0D0F12`,
            opacity: 0.85,
          }}
          lineStyle={{
            borderWidth: 1.5,
            borderColor: `${colors.accent}55`,
            borderStyle: 'solid',
          }}
        />
      )}

      <div className={styles.header}>
        <div className={styles.typeBadge} style={{ color: colors.accent, borderColor: `${colors.accent}44` }}>
          {config.label}
        </div>
        {editing ? (
          <input
            className={styles.labelInput}
            value={editValue}
            autoFocus
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') { setEditing(false); setEditValue(nodeData.label) }
            }}
          />
        ) : (
          <span className={styles.label} onDoubleClick={() => setEditing(true)}>
            {nodeData.label}
          </span>
        )}
        {childCount > 0 && (
          <span className={styles.childCount}>{childCount}</span>
        )}
        <button
          className={styles.collapseBtn}
          onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▶' : '▼'}
        </button>
      </div>

      {!collapsed && childCount === 0 && (
        <div className={styles.emptyHint}>Drop nodes here to group them</div>
      )}
    </div>
  )
}
