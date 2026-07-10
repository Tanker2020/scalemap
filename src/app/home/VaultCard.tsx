// One card in the home screen's examples vault (Polish 1 Task 6). Pure presentation over a
// `VaultEntry` (src/lib/vault/exampleWorlds.ts) — no store reads; the open sequence lives in
// HomeScreen's `openExample`, passed in as `onOpen`.
import type { CSSProperties, ReactElement } from 'react'
import type { VaultEntry } from '../../lib/vault/exampleWorlds'
import styles from './HomeScreen.module.css'

// Decorative glyph-art strokes that sit outside the token system on purpose — the same stance
// already taken for the globe/board scene hexes (module-boundaries.md): these teal/violet
// accents exist only inside this SVG art, never as UI chrome, so they don't need a `--color-*`
// token or a light/dark variant.
const GLYPH_TEAL = '#2DD4BF'
const GLYPH_VIOLET = '#A78BFA'

// Transcribed 1:1 from docs/superpowers/specs/mockups/panels-hybrid-v1.html's four
// `<svg class="vg" viewBox="0 0 200 64">` blocks. Stroke mapping: #4A9EFF -> accent,
// #EF4444 -> danger, #2A2E38 -> node-border, #F59E0B -> warning; teal/violet stay as the
// named constants above.
const GLYPHS: Record<VaultEntry['id'], ReactElement> = {
  'three-tier': (
    <svg className={styles.vg} viewBox="0 0 200 64" aria-hidden="true">
      <g fill="none" strokeWidth={1.5}>
        <circle cx={20} cy={32} r={6} stroke={GLYPH_TEAL} />
        <rect x={58} y={10} width={30} height={16} rx={3} stroke="var(--color-accent)" />
        <rect x={58} y={38} width={30} height={16} rx={3} stroke="var(--color-accent)" />
        <rect x={130} y={24} width={34} height={16} rx={3} stroke={GLYPH_VIOLET} />
        <path d="M26,32 L58,18 M26,32 L58,46 M88,18 L130,32 M88,46 L130,32" stroke="var(--color-node-border)" />
      </g>
    </svg>
  ),
  'multi-region-failover': (
    <svg className={styles.vg} viewBox="0 0 200 64" aria-hidden="true">
      <g fill="none" strokeWidth={1.5}>
        <circle cx={50} cy={22} r={9} stroke="var(--color-accent)" />
        <circle cx={150} cy={22} r={9} stroke="var(--color-accent)" />
        <circle cx={100} cy={52} r={5} stroke={GLYPH_TEAL} />
        <path d="M100,48 Q75,30 58,26" stroke={GLYPH_TEAL} strokeDasharray="4 3" />
        <path d="M100,48 Q125,30 142,26" stroke="var(--color-danger)" strokeDasharray="3 4" />
      </g>
    </svg>
  ),
  'event-driven': (
    <svg className={styles.vg} viewBox="0 0 200 64" aria-hidden="true">
      <g fill="none" strokeWidth={1.5}>
        <rect x={20} y={24} width={28} height={16} rx={3} stroke="var(--color-accent)" />
        <rect x={84} y={24} width={32} height={16} rx={8} stroke={GLYPH_VIOLET} strokeDasharray="4 3" />
        <rect x={152} y={10} width={28} height={14} rx={3} stroke={GLYPH_TEAL} />
        <rect x={152} y={40} width={28} height={14} rx={3} stroke={GLYPH_TEAL} />
        <path d="M48,32 L84,32 M116,32 L152,17 M116,32 L152,47" stroke="var(--color-node-border)" />
      </g>
    </svg>
  ),
  'broken-teaching': (
    <svg className={styles.vg} viewBox="0 0 200 64" aria-hidden="true">
      <g fill="none" strokeWidth={1.5}>
        <rect x={30} y={24} width={30} height={16} rx={3} stroke="var(--color-danger)" />
        <rect x={120} y={24} width={34} height={16} rx={3} stroke="var(--color-danger)" strokeDasharray="4 3" />
        <path d="M60,32 L120,32" stroke="var(--color-danger)" strokeDasharray="3 4" />
        <text x={88} y={24} fill="var(--color-danger)" fontSize={11}>✕</text>
        <text x={163} y={56} fill="var(--color-warning)" fontSize={9}>⚠ ⚠ ⚠</text>
      </g>
    </svg>
  ),
}

const DIFFICULTY_STYLE: Record<VaultEntry['difficulty'], CSSProperties> = {
  beginner: {
    color: 'var(--color-success-text)',
    borderColor: 'color-mix(in srgb, var(--color-success) 27%, transparent)',
  },
  intermediate: {
    color: 'var(--color-warning)',
    borderColor: 'color-mix(in srgb, var(--color-warning) 27%, transparent)',
  },
  teaching: {
    color: 'var(--color-danger)',
    borderColor: 'color-mix(in srgb, var(--color-danger) 27%, transparent)',
  },
}

export interface VaultCardProps {
  entry: VaultEntry
  onOpen: (entry: VaultEntry) => void
}

export function VaultCard({ entry, onOpen }: VaultCardProps) {
  return (
    <button
      type="button"
      className={styles.vcard}
      data-teaching={entry.difficulty === 'teaching' || undefined}
      onClick={() => onOpen(entry)}
    >
      {GLYPHS[entry.id]}
      <div className={styles.vn}>{entry.name}</div>
      <div className={styles.vd}>{entry.blurb}</div>
      <div className={styles.vm}>
        {entry.tags.map(tag => (
          <span key={tag} className={styles.vpill}>{tag}</span>
        ))}
        <span className={styles.vpill} style={DIFFICULTY_STYLE[entry.difficulty]}>{entry.difficulty}</span>
      </div>
    </button>
  )
}
