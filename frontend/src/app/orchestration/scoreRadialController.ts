import {
  SCORE_RADIAL_BLOCKED_FLASH_MS,
  SCORE_RADIAL_FADE_IN_RATE,
  SCORE_RADIAL_FADE_OUT_RATE,
  SCORE_RADIAL_INTERVAL_SMOOTH_RATE,
  SCORE_RADIAL_MIN_CAP_RESERVE,
} from '@app/core/constants'
import type { ScoreRadialVisualState } from '@app/core/scoreRadial'
import { clamp } from '@game/math'
import type { PlayerSnapshot } from '@game/types'

const SCORE_RADIAL_DEPLETION_EPS = 0.05

export type ScoreRadialViewState = {
  active: boolean
  blocked: boolean
  opacity: number
  score: number | null
  intervalPct: number | null
}

export function updateScoreRadialController(
  state: ScoreRadialVisualState,
  player: PlayerSnapshot | null,
  nowMs: number,
  boostInput: boolean,
  boostActive: boolean,
): ScoreRadialViewState {
  const deltaSeconds =
    state.lastFrameMs > 0 ? Math.min(0.1, Math.max(0, (nowMs - state.lastFrameMs) / 1000)) : 0
  state.lastFrameMs = nowMs

  let intervalPct: number | null = null
  let displayScore: number | null = null
  let blocked = false

  if (player) {
    const scoreFraction = clamp(player.scoreFraction, 0, 0.999_999)
    const currentReserve = Math.max(0, player.score + scoreFraction)

    if (player.alive) {
      if (!state.lastAlive || state.spawnReserve === null) {
        state.spawnReserve = currentReserve
        state.spawnScore = Math.max(0, Math.floor(player.score))
      }
    } else {
      state.spawnReserve = null
      state.spawnScore = null
      state.blockedVisualHold = false
    }

    const spawnScore = Math.max(0, Math.floor(state.spawnScore ?? player.score))
    const minBoostStartScore = spawnScore + 1
    const scoreBlockedByThreshold = player.alive && !player.isBoosting && player.score < minBoostStartScore
    const spawnReserveFloor = state.spawnReserve ?? currentReserve
    const reserveAboveFloor = Math.max(0, currentReserve - spawnReserveFloor)
    const depleted = reserveAboveFloor <= SCORE_RADIAL_DEPLETION_EPS

    if (state.lastBoosting && !boostActive && player.alive && boostInput) {
      if (scoreBlockedByThreshold || depleted) {
        state.blockedFlashUntilMs = nowMs + SCORE_RADIAL_BLOCKED_FLASH_MS
      }
    }

    if (boostActive) {
      state.blockedFlashUntilMs = 0
      if (!state.lastBoosting || state.capReserve === null) {
        state.capReserve = Math.max(currentReserve, SCORE_RADIAL_MIN_CAP_RESERVE)
      } else if (currentReserve > state.capReserve) {
        state.capReserve = currentReserve
      }

      const capReserve = Math.max(state.capReserve ?? SCORE_RADIAL_MIN_CAP_RESERVE, SCORE_RADIAL_MIN_CAP_RESERVE)
      const spawnReserve = clamp(state.spawnReserve ?? currentReserve, 0, capReserve)
      const spendableReserve = Math.max(capReserve - spawnReserve, SCORE_RADIAL_MIN_CAP_RESERVE)
      const spendableCurrent = Math.max(0, currentReserve - spawnReserve)
      const targetInterval01 = clamp(spendableCurrent / spendableReserve, 0, 1)

      if (!state.lastBoosting || state.displayInterval01 === null) {
        state.displayInterval01 = targetInterval01
      } else {
        const smoothAlpha = 1 - Math.exp(-SCORE_RADIAL_INTERVAL_SMOOTH_RATE * deltaSeconds)
        state.displayInterval01 += (targetInterval01 - state.displayInterval01) * smoothAlpha
      }

      const interval01 = clamp(state.displayInterval01 ?? targetInterval01, 0, 1)
      intervalPct = interval01 * 100
      displayScore = player.score
      state.lastIntervalPct = intervalPct
      state.lastDisplayScore = displayScore
    } else {
      state.capReserve = null
      state.displayInterval01 = null
      intervalPct = state.lastIntervalPct
      displayScore = player.score
      state.lastDisplayScore = displayScore
      blocked =
        (scoreBlockedByThreshold && boostInput) ||
        (boostInput && nowMs < state.blockedFlashUntilMs)
    }

    state.lastBoosting = boostActive
    state.lastAlive = player.alive
  } else {
    state.capReserve = null
    state.spawnReserve = null
    state.spawnScore = null
    state.displayInterval01 = null
    state.blockedFlashUntilMs = 0
    state.blockedVisualHold = false
    intervalPct = state.lastIntervalPct
    displayScore = state.lastDisplayScore
    state.lastBoosting = false
    state.lastAlive = false
  }

  if (blocked) {
    state.blockedVisualHold = true
  } else if (boostActive) {
    state.blockedVisualHold = false
  }

  const visibleTarget = boostActive || blocked
  const renderBlocked =
    blocked ||
    (!boostActive && state.blockedVisualHold && state.opacity > 0.001)
  const targetOpacity = visibleTarget ? 1 : 0
  const rate = targetOpacity >= state.opacity ? SCORE_RADIAL_FADE_IN_RATE : SCORE_RADIAL_FADE_OUT_RATE
  const alpha = 1 - Math.exp(-rate * deltaSeconds)
  state.opacity += (targetOpacity - state.opacity) * alpha
  if (Math.abs(targetOpacity - state.opacity) < 1e-4) {
    state.opacity = targetOpacity
  }
  if (!visibleTarget && state.opacity <= 0.001) {
    state.blockedVisualHold = false
  }

  return {
    active: state.opacity > 0.001,
    blocked: renderBlocked,
    opacity: state.opacity,
    score: displayScore,
    intervalPct,
  }
}
