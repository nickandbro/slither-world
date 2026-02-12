import { DEFAULT_NET_TUNING, type NetTuningOverrides } from '@app/core/constants'

export const SEQ_HALF_RANGE = 0x8000_0000

export const isSeqNewer = (next: number, current: number): boolean => {
  const delta = (next - current) >>> 0
  return delta !== 0 && delta < SEQ_HALF_RANGE
}

export const seqGapSize = (next: number, current: number): number => {
  const delta = (next - current) >>> 0
  if (delta < SEQ_HALF_RANGE) return delta
  return 0
}

export function normalizeNetTuningOverrides(
  incoming: NetTuningOverrides | null | undefined,
): NetTuningOverrides {
  const normalized: NetTuningOverrides = {}
  if (!incoming || typeof incoming !== 'object') return normalized

  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    if (!(rawKey in DEFAULT_NET_TUNING)) continue
    if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) continue
    const key = rawKey as keyof typeof DEFAULT_NET_TUNING
    normalized[key] = rawValue
  }
  return normalized
}
