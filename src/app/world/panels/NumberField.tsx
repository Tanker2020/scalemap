// src/app/world/panels/NumberField.tsx
// The dock's bare numeric input: a local text buffer that commits on blur/Enter, clamps to
// [min,max], and reverts to the last valid value on non-numeric input.
//
// Same "Number.isFinite, clamp, keep last valid" convention as
// src/app/world/server/inspectorForms.tsx's NumberField — generalized with explicit min/max
// bounds, since that file's version only ever floor-clamps to `>=0` and lat/lon need a symmetric
// range. On a successful commit the buffer is reset to the CLAMPED value, so an out-of-range
// entry (e.g. lat 999) visibly snaps to 90 rather than leaving "999" displayed while the store
// silently holds 90.
//
// Lifted out of TrafficPanel.tsx when PacketMixEditor needed the same control; kit.tsx's
// DerivedField is the richer sibling (label chrome, slider mode, derived-consequence caption) —
// this is the unadorned one that fits inside a dense mix row.
import { useState } from 'react'
import { field } from './panelStyles'

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

export function NumberField({ label, value, min, max, onCommit }: {
  label: string; value: number; min: number; max: number; onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  return (
    <input
      aria-label={label} style={{ ...field, width: 56, marginBottom: 0 }} value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        const n = Number(text)
        if (Number.isFinite(n)) { const c = clamp(n, min, max); onCommit(c); setText(String(c)) }
        else setText(String(value))
      }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}
