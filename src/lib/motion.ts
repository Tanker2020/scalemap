import type { Transition, Variants } from 'framer-motion'
import { MOTION } from './theme'

// CSS-driven (not framer-motion) breathing glow — used via a <style> tag or CSS Module
// keyframe reference in Task 6. Kept CSS-native (not JS-animated) so it automatically respects
// the prefers-reduced-motion block already in index.css, with zero extra reduced-motion logic.
export function breatheKeyframes(color: string): string {
  return `
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 8px ${color}66; }
      50% { box-shadow: 0 0 16px ${color}B3; }
    }
  `
}

export const panelTransition: Transition = {
  duration: MOTION.panelDurationMs / 1000,
  ease: 'easeOut',
}

export const hoverLiftVariants: Variants = {
  rest: { y: 0 },
  hover: { y: -1 },
}
