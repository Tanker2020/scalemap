import { useState, useMemo } from 'react'
import { LayoutGrid } from 'lucide-react'
import { NODE_CONFIG, PALETTE_CATEGORIES, type NodeType } from '../../lib/nodeConfig'
import { CATEGORY_COLORS } from '../../lib/theme'
import styles from './NodePalette.module.css'

export function NodePalette() {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return PALETTE_CATEGORIES
    const q = search.toLowerCase()
    return PALETTE_CATEGORIES.map(cat => ({
      ...cat,
      types: cat.types.filter(t => NODE_CONFIG[t].label.toLowerCase().includes(q)),
    })).filter(cat => cat.types.length > 0)
  }, [search])

  const handleDragStart = (e: React.DragEvent, nodeType: NodeType) => {
    e.dataTransfer.setData('nodeType', nodeType)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <LayoutGrid size={12} />
        Node Palette
      </div>

      <div className={styles.searchWrap}>
        <input
          className={styles.searchInput}
          placeholder="Search nodes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className={styles.scroll}>
        {filtered.map(cat => (
          <div key={cat.category}>
            <div className={styles.categoryLabel}>{cat.label}</div>
            {cat.types.map(nodeType => {
              const config = NODE_CONFIG[nodeType]
              const colors = CATEGORY_COLORS[config.category]
              const Icon = config.icon
              return (
                <div
                  key={nodeType}
                  className={styles.item}
                  draggable
                  onDragStart={e => handleDragStart(e, nodeType)}
                  title={`Drag to add ${config.label}`}
                >
                  <div
                    className={styles.itemIcon}
                    style={{ background: colors.bg, border: `1px solid ${colors.border}`, color: colors.accent }}
                  >
                    <Icon size={12} strokeWidth={1.5} />
                  </div>
                  <span className={styles.itemLabel}>{config.label}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </aside>
  )
}
