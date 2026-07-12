// src/app/world/region/timelineStyles.ts
// Injected-stylesheet-once idiom (`ui/kit.tsx`'s pattern, self-contained per `region/`'s own
// boundary rule per r3Styles.ts's header comment — imports only `lib/theme`, no `ui/kit.tsx`
// reach-in). Two small pieces TimelineV2.tsx needs that plain inline styles can't express:
// theme-aware teal/violet marker tints (CATEGORY_COLORS' network/messaging accents — the same
// swap-on-light-theme idiom r3Styles.ts/azFloorStyles.ts already use for these exact tokens)
// and the ONE permitted hover transition (D8 guarantee 5: marker hover-scale is the timeline's
// only motion). No keyframes, no infinite animation — this file adds zero ambient motion.
import { CATEGORY_COLORS } from '../../../lib/theme'

const TIMELINE_STYLE_ID = 'scalemap-timeline-styles'

if (typeof document !== 'undefined' && !document.getElementById(TIMELINE_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = TIMELINE_STYLE_ID
  style.textContent = `
:root {
  --tl-teal: ${CATEGORY_COLORS.network.accent};
  --tl-violet: ${CATEGORY_COLORS.messaging.accent};
}
:root[data-theme="light"] {
  --tl-teal: ${CATEGORY_COLORS.network.foreground.light};
  --tl-violet: ${CATEGORY_COLORS.messaging.foreground.light};
}
/* Marker hover-scale — the strip's ONLY transition (D8 guarantee 5). The app's blanket
   prefers-reduced-motion rule (src/index.css) already collapses transition-duration to
   0.01ms under reduced motion, the same precedent .region-timeline-flash documents there —
   no separate media query needed here. */
.tl-marker { transform: translate(-50%, -50%); transition: transform 0.12s ease; }
.tl-marker:hover { transform: translate(-50%, -50%) scale(1.35); }
.tl-marker .tl-tip { opacity: 0; pointer-events: none; transition: opacity 0.13s ease; }
.tl-marker:hover .tl-tip { opacity: 1; }
`
  document.head.appendChild(style)
}
