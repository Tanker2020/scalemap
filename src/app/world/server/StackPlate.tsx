// src/app/world/server/StackPlate.tsx
// Raised docker-stack plate (dashed purple). Container chips are rendered by ServerBoard on top;
// the plate owns the header + volume cylinders.
import type { CSSProperties, ReactElement } from 'react'
import type { StackLayout } from './boardLayout'
import type { BoardSelection } from './selection'

const PURPLE = '#A78BFA'

export interface StackPlateProps {
  stack: StackLayout
  selection?: BoardSelection | null
  dimmed?: boolean
  onSelect?: (s: BoardSelection) => void
}

export function StackPlate({ stack, dimmed, onSelect }: StackPlateProps): ReactElement {
  const style: CSSProperties = {
    position: 'absolute', left: stack.box.x, top: stack.box.y, width: stack.box.w, height: stack.box.h,
    background: 'linear-gradient(160deg,#1A1430 0%,#120E22 100%)', border: `1px dashed ${PURPLE}88`,
    borderRadius: 10, boxShadow: '0 8px 24px #00000066, 0 0 18px #A78BFA22', padding: 6,
    opacity: dimmed ? 0.45 : 1, cursor: 'pointer', font: '7px var(--font-mono)',
  }
  return (
    <div data-stack={stack.stackName} style={style} onClick={() => onSelect?.({ kind: 'stack', stackName: stack.stackName })}>
      <div style={{ color: '#C4B5FD', textShadow: `0 0 6px ${PURPLE}` }}>▣ stack: {stack.stackName} · {stack.networkLabel}</div>
      <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width={stack.box.w} height={stack.box.h}>
        {stack.volumes.map(v => {
          const lx = v.box.x - stack.box.x, ty = v.box.y - stack.box.y
          return (
            <g key={v.volumeName} style={{ pointerEvents: 'auto', cursor: 'pointer' }}
              onClick={e => { e.stopPropagation(); onSelect?.({ kind: 'volume', stackName: stack.stackName, volumeName: v.volumeName }) }}>
              <ellipse cx={lx + v.box.w / 2} cy={ty + 4} rx={v.box.w / 2} ry={4} fill="#F5A62388" stroke="#F5A623" />
              <rect x={lx} y={ty + 4} width={v.box.w} height={v.box.h - 8} fill="#F5A62333" stroke="#F5A623" strokeWidth={0.5} />
              <ellipse cx={lx + v.box.w / 2} cy={ty + v.box.h - 4} rx={v.box.w / 2} ry={4} fill="#F5A623AA" stroke="#F5A623" />
              <text x={lx + v.box.w / 2} y={ty + v.box.h + 6} fill="var(--color-text-muted)" fontSize={5.5} textAnchor="middle">{v.volumeName}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
