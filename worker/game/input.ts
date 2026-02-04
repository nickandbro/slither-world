import type { Point } from './types'
import { length, normalize } from './math'

export function parseAxis(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null
  const axis = value as { x?: unknown; y?: unknown; z?: unknown }
  const x = typeof axis.x === 'number' ? axis.x : NaN
  const y = typeof axis.y === 'number' ? axis.y : NaN
  const z = typeof axis.z === 'number' ? axis.z : NaN
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  const normalized = normalize({ x, y, z })
  if (length(normalized) === 0) return null
  return normalized
}
