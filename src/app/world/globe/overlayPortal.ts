// Portal target for in-scene overlay <Html> mounts (Polish 2 T3 fix): the canvas wrapper is
// aria-hidden (decorative — GlobeView renders the a11y region list instead), so interactive
// overlay DOM must portal OUTSIDE it to stay in the accessibility tree. GlobeView provides
// the target; pins/markers consume. Context flows through GlobeScene without touching it.
import { createContext, type RefObject } from 'react'

export const OverlayPortalContext = createContext<RefObject<HTMLDivElement> | null>(null)
