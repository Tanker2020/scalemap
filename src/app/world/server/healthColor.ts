// src/app/world/server/healthColor.ts
// Shared health→color mapping (was duplicated identically in HardwarePlatform.tsx and
// ServiceChip.tsx — hoisted here so the two dot/ring renderers can't drift apart).
import type { HealthState } from '../../../lib/worldEngine/types'

export const HEALTH_COLOR: Record<HealthState, string> = {
  healthy: 'var(--color-success)', degraded: 'var(--color-warning)', down: 'var(--color-danger)',
}
