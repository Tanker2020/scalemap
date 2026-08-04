import type { CacheConfig } from '../world/types'

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/** 0 (cold, just restarted) -> 1 (fully warm) over warmupSec. undefined warmSinceMs = already warm. */
function warmth(cfg: CacheConfig, warmSinceMs: number | undefined, simMs: number): number {
  if (warmSinceMs === undefined) return 1
  if (cfg.warmupSec <= 0) return 1
  return clamp01((simMs - warmSinceMs) / (cfg.warmupSec * 1000))
}

export function effectiveHitRatio(
  cfg: CacheConfig,
  warmSinceMs: number | undefined,
  simMs: number,
): number {
  return cfg.hitRatio * warmth(cfg, warmSinceMs, simMs)
}

export function effectiveMissFraction(
  cfg: CacheConfig,
  warmSinceMs: number | undefined,
  simMs: number,
  stepSec: number,
): number {
  const hit = effectiveHitRatio(cfg, warmSinceMs, simMs)
  const ttlFloor = cfg.ttlSec > 0 ? stepSec / cfg.ttlSec : 0
  return Math.max(1 - hit, ttlFloor)
}
