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

export type PredictionBlendContext = {
  baseAlpha: number
  headResponseBoost: number
  tailDamping: number
  microDeadbandDeg: number
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
  context?: Partial<PredictionBlendContext>,
): Point[] {
  if (!fromSnake || fromSnake.length === 0) {
    return targetSnake.map((node) => normalize({ ...node }))
  }
  const baseAlpha = clamp(context?.baseAlpha ?? alpha, 0, 1)
  const headResponseBoost = clamp(context?.headResponseBoost ?? 0, -1, 1)
  const tailDamping = clamp(context?.tailDamping ?? 0, -1, 1)
  const microDeadbandDeg = Math.max(0, context?.microDeadbandDeg ?? 0)
  if (
    baseAlpha >= 0.999 &&
    Math.abs(headResponseBoost) <= 1e-6 &&
    Math.abs(tailDamping) <= 1e-6 &&
    microDeadbandDeg <= 1e-6
  ) {
    return targetSnake.map((node) => normalize({ ...node }))
  }
  const blended: Point[] = []
  const targetLen = targetSnake.length
  const fromLen = fromSnake.length
  const tailIndex = Math.max(1, targetLen - 1)
  for (let index = 0; index < targetLen; index += 1) {
    const target = targetSnake[index]!
    const from = index < fromLen ? fromSnake[index]! : target
    const fromNorm = normalize(from)
    const targetNorm = normalize(target)
    const progress = index / tailIndex
    const dotValue = clamp(
      fromNorm.x * targetNorm.x + fromNorm.y * targetNorm.y + fromNorm.z * targetNorm.z,
      -1,
      1,
    )
    const deltaDeg = Math.acos(dotValue) * (180 / Math.PI)
    if (Number.isFinite(deltaDeg) && deltaDeg < microDeadbandDeg) {
      blended.push(normalize({ ...from }))
      continue
    }
    const nodeAlpha = clamp(
      baseAlpha + headResponseBoost * (1 - progress) - tailDamping * progress * progress,
      0.18,
      0.96,
    )
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
