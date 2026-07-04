# Parallel Edge Overlap — Bug Spec & Fix Plan

> **Severity:** UI / Usability  
> **Component:** Canvas → Edge rendering  
> **Reported:** 2026-07-03  

---

## Summary

When a user creates two or more connections between the same pair of nodes (e.g. a **request** edge *and* an **event** edge between Node A → Node B), the edges render directly on top of each other. This makes it impossible to:

- **See** that multiple edges exist between the pair.
- **Select** the edge you want (clicking picks whichever one is rendered last / on top).
- **Differentiate** edge types visually — their distinct colors, dash patterns, and arrowheads are fully occluded.

This is a core interaction in ScaleMap: a service might have both a synchronous request path *and* an asynchronous event channel to the same downstream service, and the user must be able to model (and later inspect during simulation) both independently.

---

## Reproduction Steps

1. Open the ScaleMap canvas.
2. Drag two nodes onto the canvas (e.g. two `apiGateway` nodes, or any two node types).
3. Draw a connection from Node A → Node B.  
4. Draw a **second** connection from Node A → Node B.
5. Optionally, change one edge's type to `event` via the sidebar Properties panel.
6. **Observe:** Both edges render as a single line. Only the topmost edge is clickable. There is no visual indication that two edges exist.

**Expected:** The two edges should be visually separated — fanned apart in a bow shape — so both are visible and independently selectable.

---

## Affected Files

| File | Role |
|---|---|
| [`BaseEdge.tsx`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/BaseEdge.tsx) | Edge rendering component; contains the `bowedPath` / `PARALLEL_GAP` fanout logic (lines 72–175) |
| [`edges.module.css`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/edges.module.css) | Edge styles |
| [`canvas.store.ts`](file:///C:/Users/rishi/Desktop/scalemap/src/app/store/canvas.store.ts) | `onConnect` handler that creates new edges (line 115–128) |
| [`Canvas.tsx`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/Canvas.tsx) | Edge type registration map (lines 65–70) |

---

## Root Cause Analysis

There **is** an existing fanout mechanism in [`BaseEdge.tsx`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/BaseEdge.tsx) designed to handle this case. The relevant code (lines 158–175):

```tsx
// Fan parallel edges apart
const allEdges = useCanvasStore(s => s.edges)
const siblings = allEdges.filter(e =>
  (e.source === source && e.target === target) || (e.source === target && e.target === source),
)
const n = siblings.length
const idx = Math.max(0, siblings.findIndex(e => e.id === id))
const offset = n > 1 ? (idx - (n - 1) / 2) * PARALLEL_GAP : 0

const [straightPath, straightLabelX, straightLabelY] = getBezierPath({ ... })
const [edgePath, labelX, labelY] = offset === 0
  ? [straightPath, straightLabelX, straightLabelY]
  : bowedPath(sourceX, sourceY, targetX, targetY, offset)
```

The `bowedPath` helper (lines 77–86) displaces the curve's control points perpendicular to the source→target straight line by `offset` pixels, and `PARALLEL_GAP = 22` px is the spacing between sibling edges.

### Why the fanout may not be working

The logic itself appears structurally correct — it finds sibling edges, computes an index-based perpendicular offset, and uses a custom cubic bézier. Possible failure modes to investigate:

1. **React Flow re-render suppression.** Each `ScalemapEdge` component subscribes to the entire `edges` array via `useCanvasStore(s => s.edges)`. If Zustand's shallow-equality check is not triggering a re-render for sibling edges when a *new* edge is added (because only the newly-added edge component mounts, and existing sibling components don't re-render), then the existing first edge never recalculates its offset — it computed `n = 1, offset = 0` on its initial render and stays that way. **This is the most likely cause.**

2. **Floating-edge endpoint convergence.** The `getFloatingEdgeParams` function computes a single intersection point per node pair based on the node rectangles' geometry. For two edges connecting the same pair of nodes, the computed `(sourceX, sourceY)` and `(targetX, targetY)` are identical. The `bowedPath` correctly handles this (bowing is purely a control-point offset, not an endpoint offset), so this is not the root cause — but it does mean both edges share the same start/end pixel, which makes the overlap look worse for very short edges.

3. **Edge ordering instability.** The `siblings.findIndex(e => e.id === id)` relies on the `edges` array having a stable order. If the array gets sorted or reordered between renders (e.g. by React Flow internals or by undo/redo), two sibling edges could temporarily receive the same index, both computing `offset = 0`.

---

## Proposed Fix

### Option A — Force sibling re-render on edge-count change (Recommended)

The core issue (#1 above) is that existing edge components don't re-render when a new sibling edge is added. Fix this by making the Zustand selector more specific, or by keying on the sibling count:

```tsx
// Instead of subscribing to the full edges array:
const allEdges = useCanvasStore(s => s.edges)

// Subscribe to a derived value that changes when the sibling set changes:
const siblingInfo = useCanvasStore(s => {
  const siblings = s.edges.filter(e =>
    (e.source === source && e.target === target) || (e.source === target && e.target === source),
  )
  const idx = Math.max(0, siblings.findIndex(e => e.id === id))
  return { n: siblings.length, idx }
}, shallow)
const { n, idx } = siblingInfo
const offset = n > 1 ? (idx - (n - 1) / 2) * PARALLEL_GAP : 0
```

Using `shallow` equality on `{ n, idx }` ensures the component re-renders when either the count of siblings changes or this edge's position within the sibling set changes — but *not* on unrelated edge updates.

### Option B — Offset endpoints (not just control points)

Even with Option A, both edges share the same start and end pixel (since `getFloatingEdgeParams` returns the same intersection for the same node pair). For additional visual clarity, offset the *endpoints* slightly along the node's edge perpendicular:

```tsx
// After computing the floating params, nudge sourceX/Y and targetX/Y
// perpendicular to the node edge by (offset * 0.3) pixels
```

This would make the two edges visually separate at the nodes, not just in the middle of the curve.

### Option C — Edge-type badges on the midpoint label

Regardless of the geometry fix, adding a small edge-type badge (e.g. a colored pill with "REQ" / "EVT" / "STR") at each edge's midpoint would improve differentiation even for users who might not notice the subtle bow. The `EdgeLabelRenderer` already supports this — just render the badge when `edgeData?.label` is empty as well, using the `edgeType` value.

---

## Recommended Implementation Order

| Step | Change | Files |
|---|---|---|
| 1 | Replace the `useCanvasStore(s => s.edges)` selector with a derived `{ n, idx }` selector using `shallow` equality, ensuring sibling edges re-render when the sibling set changes. | [`BaseEdge.tsx`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/BaseEdge.tsx) |
| 2 | Add a small perpendicular endpoint offset so edges separate at the node boundary, not just in the curve middle. | [`BaseEdge.tsx`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/BaseEdge.tsx) |
| 3 | Always render an edge-type badge at the midpoint (even when `label` is empty) showing the edge type via a small colored indicator. | [`BaseEdge.tsx`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/BaseEdge.tsx), [`edges.module.css`](file:///C:/Users/rishi/Desktop/scalemap/src/app/canvas/edges/edges.module.css) |
| 4 | Verify `onConnect` doesn't deduplicate edges between the same node pair (confirmed: it already uses `nextId('edge')` for unique IDs — no change needed). | [`canvas.store.ts`](file:///C:/Users/rishi/Desktop/scalemap/src/app/store/canvas.store.ts) |

---

## Acceptance Criteria

- [ ] Two edges between the same node pair are visually separated by a visible bow/offset.
- [ ] Each edge is independently selectable (clicking one does not select the other).
- [ ] The edge type (request / event / stream / dependency) is distinguishable via color, dash pattern, and/or a midpoint badge.
- [ ] Adding a 3rd or 4th parallel edge continues to fan correctly (no overlap at any count).
- [ ] Bi-directional edges (A→B and B→A) are also fanned apart and distinguishable.
- [ ] No regressions: single edges between a pair render as a normal straight/bezier curve (no unnecessary bow).
- [ ] `npm run build` passes.

---

## Visual Reference

```
  CURRENT (Broken)                  EXPECTED (Fixed)

  ┌─────┐          ┌─────┐         ┌─────┐          ┌─────┐
  │  A  │──────────│  B  │         │  A  │─────⌒────│  B  │
  └─────┘          └─────┘         │     │─────⌣────│     │
                                   └─────┘          └─────┘
  Both edges overlap into a         Edges bow apart, each
  single line — only one is         independently visible
  visible or selectable             and selectable
```
