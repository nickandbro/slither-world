import { clamp, normalize } from '@game/math'
import type { Point } from '@game/types'

export const TAIL_EVENT_LOG_LIMIT = 900
export const TAIL_RENDER_SAMPLE_INTERVAL_MS = 140

const pointDistance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

export const computeTailEndMetrics = (snake: Point[], tailExtension: number) => {
  if (snake.length < 2) return null
  const tail = normalize(snake[snake.length - 1])
  const prev = normalize(snake[snake.length - 2])
  const segLen = pointDistance(tail, prev)
  let refLen = segLen
  if (!(refLen > 1e-6) && snake.length >= 3) {
    const prevPrev = normalize(snake[snake.length - 3])
    refLen = pointDistance(prev, prevPrev)
  }
  if (!Number.isFinite(refLen) || refLen <= 0) {
    refLen = 0
  }
  const extRatio = clamp(tailExtension, 0, 0.999_999)
  const extDist = Math.max(0, refLen) * extRatio
  return {
    segLen,
    refLen,
    extRatio,
    extDist,
    endLen: segLen + extDist,
  }
}

export const digestionMaxProgress = (digestions: Array<{ progress: number }>): number => {
  let max = 0
  for (const digestion of digestions) {
    const progress = digestion.progress
    if (Number.isFinite(progress)) max = Math.max(max, progress)
  }
  return max
}
