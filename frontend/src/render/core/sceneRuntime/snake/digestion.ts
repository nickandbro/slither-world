import type { DigestionSnapshot } from '../../../../game/types'
import { clamp } from '../utils/math'

export type DigestionVisual = {
  t: number
  strength: number
}

export const clampDigestionProgress = (value: number): number => clamp(value, 0, 1)

export const buildDigestionVisuals = (
  digestions: DigestionSnapshot[],
  travelEase: number,
): DigestionVisual[] => {
  const visuals: DigestionVisual[] = []
  for (const digestion of digestions) {
    const progress = clamp(digestion.progress, 0, 2)
    const travelT = clamp(progress, 0, 1)
    const dissolve = progress > 1 ? 1 - clamp(progress - 1, 0, 1) : 1
    const travelBiased = Math.pow(travelT, travelEase)
    const strength = clamp(digestion.strength, 0, 1) * dissolve
    if (strength <= 1e-4) continue
    visuals.push({ t: travelBiased, strength })
  }
  return visuals
}
