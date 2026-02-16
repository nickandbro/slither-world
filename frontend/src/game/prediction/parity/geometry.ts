import type { Point } from '@game/types'
import { cross, normalize } from '@game/math'

const TAU = Math.PI * 2

export function tangentBasis(normal: Point): { tangent: Point; bitangent: Point } {
  const up = Math.abs(normal.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
  const tangent = normalize(cross(up, normal))
  const bitangent = normalize(cross(normal, tangent))
  return { tangent, bitangent }
}

export function sampleOutlineRadius(outline: number[], theta: number): number {
  if (outline.length === 0) return 0
  const normalized = Math.max(0, Math.min(1, theta / TAU))
  const idx = normalized * outline.length
  const floorIdx = Math.floor(idx)
  const i0 = floorIdx % outline.length
  const i1 = (i0 + 1) % outline.length
  const t = idx - floorIdx
  const a = outline[i0] ?? 0
  const b = outline[i1] ?? a
  return a * (1 - t) + b * t
}
