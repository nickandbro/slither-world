import { clamp } from '@game/math'

export type AdaptiveQualityState = {
  enabled: boolean
  minDpr: number
  maxDprCap: number
  currentDpr: number
  ewmaFrameMs: number
  lastAdjustAtMs: number
}

export function updateAdaptiveQuality(
  state: AdaptiveQualityState,
  frameDeltaSeconds: number,
  nowMs: number,
  updateConfig: () => void,
): void {
  if (!state.enabled) return

  const frameMs = clamp(frameDeltaSeconds * 1000, 0, 100)
  const alpha = 0.08
  state.ewmaFrameMs = state.ewmaFrameMs * (1 - alpha) + frameMs * alpha

  const adjustIntervalMs = 250
  if (state.lastAdjustAtMs <= 0) {
    state.lastAdjustAtMs = nowMs
  }
  if (nowMs - state.lastAdjustAtMs < adjustIntervalMs) return

  state.lastAdjustAtMs = nowMs
  const baseMaxDpr = Math.min(window.devicePixelRatio || 1, 2)
  const maxDpr = Math.min(baseMaxDpr, state.maxDprCap)
  const minDpr = state.minDpr
  if (!Number.isFinite(state.currentDpr) || state.currentDpr <= 0) {
    state.currentDpr = maxDpr
  }

  let nextDpr = state.currentDpr
  const step = 0.05
  if (state.ewmaFrameMs > 18 && state.currentDpr > minDpr + 1e-3) {
    nextDpr = Math.max(minDpr, state.currentDpr - step)
  } else if (state.ewmaFrameMs < 14 && state.currentDpr < maxDpr - 1e-3) {
    nextDpr = Math.min(maxDpr, state.currentDpr + step)
  }
  nextDpr = Math.round(nextDpr * 100) / 100
  if (Math.abs(nextDpr - state.currentDpr) > 1e-6) {
    state.currentDpr = nextDpr
    updateConfig()
  }
}
