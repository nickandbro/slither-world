import { clamp, lerpPoint, normalize } from '../math'
import type { Point } from '../types'

const SOFT_ERROR_MIN_DEG = 1.5
const HARD_ERROR_MIN_DEG = 6
const SOFT_DURATION_MIN_MS = 60
const SOFT_DURATION_MAX_MS = 120

export type ReconcileKind = 'none' | 'soft' | 'hard'

export type ReconcileDecision = {
  kind: ReconcileKind
  magnitudeDeg: number
  durationMs: number
}

export function decideReconcile(errorDeg: number, forceHard = false): ReconcileDecision {
  const magnitude = Number.isFinite(errorDeg) ? Math.max(0, errorDeg) : 0
  if (forceHard || magnitude > HARD_ERROR_MIN_DEG) {
    return { kind: 'hard', magnitudeDeg: magnitude, durationMs: 120 }
  }
  if (magnitude >= SOFT_ERROR_MIN_DEG) {
    const t = clamp((magnitude - SOFT_ERROR_MIN_DEG) / (HARD_ERROR_MIN_DEG - SOFT_ERROR_MIN_DEG), 0, 1)
    const durationMs = SOFT_DURATION_MIN_MS + (SOFT_DURATION_MAX_MS - SOFT_DURATION_MIN_MS) * t
    return { kind: 'soft', magnitudeDeg: magnitude, durationMs }
  }
  return { kind: 'none', magnitudeDeg: magnitude, durationMs: 0 }
}

export function blendPredictedSnake(
  fromSnake: Point[] | null,
  targetSnake: Point[],
  alpha: number,
): Point[] {
  if (!fromSnake || fromSnake.length === 0 || alpha >= 0.999) {
    return targetSnake.map((node) => normalize({ ...node }))
  }
  const clampedAlpha = clamp(alpha, 0, 1)
  const blended: Point[] = []
  const targetLen = targetSnake.length
  const fromLen = fromSnake.length
  const tailIndex = Math.max(1, targetLen - 1)
  for (let index = 0; index < targetLen; index += 1) {
    const target = targetSnake[index]!
    const from = index < fromLen ? fromSnake[index]! : target
    const tailBias = (index / tailIndex) ** 2
    const nodeAlpha = clamp(clampedAlpha + (1 - clampedAlpha) * tailBias, 0, 1)
    blended.push(normalize(lerpPoint(from, target, nodeAlpha)))
  }
  return blended
}

export function computeP95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1))
  return sorted[index] ?? 0
}
