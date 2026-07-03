import { useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { NODE_CONFIG, PALETTE_CATEGORIES, type NodeType } from '../../lib/nodeConfig'
import { CATEGORY_COLORS } from '../../lib/theme'
import { useUiStore } from '../store/ui.store'
import { useSimulationStore } from '../store/simulation.store'
import styles from './NodePalette.module.css'

// Grace period between the pointer leaving the rail/flyout and the flyout actually closing —
// long enough to cross the small gap between the two without a flicker, short enough that it
// doesn't feel sticky once the user has genuinely moved on.
const CLOSE_DELAY_MS = 150

export function NodePalette() {
  const [search, setSearch] = useState('')
  const [pinned, setPinned] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const themeMode = useUiStore(s => s.themeMode)
  const running = useSimulationStore(s => s.running)
  const reduceMotion = useReducedMotion()
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // You can't add nodes mid-run (editing is already locked elsewhere), so the flyout has
  // nothing useful to do while running — force it closed; the rail's data-disabled styling
  // communicates that hovering/clicking won't do anything right now.
  useEffect(() => {
    if (running) { setPinned(false); setHoverOpen(false) }
  }, [running])

  const open = !running && (pinned || hoverOpen)

  const filtered = useMemo(() => {
    if (!search.trim()) return PALETTE_CATEGORIES
    const q = search.toLowerCase()
    return PALETTE_CATEGORIES.map(cat => ({
      ...cat,
      types: cat.types.filter(t => NODE_CONFIG[t].label.toLowerCase().includes(q)),
    })).filter(cat => cat.types.length > 0)
  }, [search])

  const clearCloseTimer = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const scheduleClose = () => {
    clearCloseTimer()
    closeTimer.current = setTimeout(() => setHoverOpen(false), CLOSE_DELAY_MS)
  }
  const handleRailEnter = (category?: string) => {
    if (running) return
    clearCloseTimer()
    setHoverOpen(true)
    if (category) {
      // Wait a frame so the flyout has actually mounted before scrolling inside it.
      requestAnimationFrame(() => categoryRefs.current[category]?.scrollIntoView({ block: 'start' }))
    }
  }
  const handleRailClick = (category: string) => {
    if (running) return
    setPinned(p => !p)
    handleRailEnter(category)
  }

  const handleDragStart = (e: React.DragEvent, nodeType: NodeType) => {
    e.dataTransfer.setData('nodeType', nodeType)
    e.dataTransfer.effectAllowed = 'copy'
  }
  // Mirrors a typical picker: once a node has actually been dragged out, the flyout has done
  // its job. onDragEnd fires whether or not the drop landed somewhere valid — an acceptable
  // simplification (closes on both a successful and a cancelled drag).
  const handleDragEnd = () => { setPinned(false); setHoverOpen(false) }

  return (
    <div className={styles.wrap} onMouseLeave={scheduleClose}>
      <div className={styles.rail} data-disabled={running}>
        {PALETTE_CATEGORIES.map(cat => {
          const colors = CATEGORY_COLORS[cat.category]
          const accentColor = themeMode === 'light' ? colors.foreground.light : colors.accent
          const Icon = NODE_CONFIG[cat.types[0]].icon
          return (
            <button
              key={cat.category}
              type="button"
              className={styles.railIcon}
              style={{ '--rail-accent': accentColor } as React.CSSProperties}
              onMouseEnter={() => handleRailEnter(cat.category)}
              onClick={() => handleRailClick(cat.category)}
              title={cat.label}
            >
              <Icon size={15} strokeWidth={1.5} />
            </button>
          )
        })}
      </div>

      <AnimatePresence>
        {open && (
          <motion.aside
            className={styles.flyout}
            onMouseEnter={clearCloseTimer}
            onMouseLeave={scheduleClose}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
            transition={{ duration: reduceMotion ? 0 : 0.14, ease: 'easeOut' }}
          >
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
                <div key={cat.category} ref={el => { categoryRefs.current[cat.category] = el }}>
                  <div className={styles.categoryLabel}>{cat.label}</div>
                  {cat.types.map(nodeType => {
                    const config = NODE_CONFIG[nodeType]
                    const colors = CATEGORY_COLORS[config.category]
                    const accentColor = themeMode === 'light' ? colors.foreground.light : colors.accent
                    const chipBg     = themeMode === 'light' ? `color-mix(in srgb, ${accentColor} 12%, var(--color-node-base))` : colors.bg
                    const chipBorder = themeMode === 'light' ? `color-mix(in srgb, ${accentColor} 35%, transparent)` : colors.border
                    const Icon = config.icon
                    return (
                      <div
                        key={nodeType}
                        className={styles.item}
                        draggable
                        onDragStart={e => handleDragStart(e, nodeType)}
                        onDragEnd={handleDragEnd}
                        title={`Drag to add ${config.label}`}
                      >
                        <div
                          className={styles.itemIcon}
                          style={{ background: chipBg, border: `1px solid ${chipBorder}`, color: accentColor }}
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
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  )
}
