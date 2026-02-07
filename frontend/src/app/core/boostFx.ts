import { clamp } from '../../game/math'
import {
  BOOST_EFFECT_ACTIVE_CLASS_THRESHOLD,
  BOOST_EFFECT_FADE_IN_RATE,
  BOOST_EFFECT_FADE_OUT_RATE,
  BOOST_EFFECT_PULSE_SPEED,
} from './constants'

export type BoostFxState = {
  intensity: number
  pulse: number
  lastFrameMs: number
  activeClassApplied: boolean
}

export const createInitialBoostFxState = (): BoostFxState => ({
  intensity: 0,
  pulse: 0,
  lastFrameMs: 0,
  activeClassApplied: false,
})

export const resetBoostFx = (element: HTMLDivElement | null, state: BoostFxState) => {
  state.intensity = 0
  state.pulse = 0
  state.lastFrameMs = 0
  state.activeClassApplied = false
  if (!element) return
  element.classList.remove('boost-fx--active')
  element.style.setProperty('--boost-intensity', '0')
  element.style.setProperty('--boost-pulse', '0')
  element.style.setProperty('--boost-edge-opacity', '0')
  element.style.setProperty('--boost-phase', '0')
}

export const updateBoostFx = (
  element: HTMLDivElement | null,
  state: BoostFxState,
  boostActive: boolean,
) => {
  if (!element) return
  const now = performance.now()
  const deltaSeconds =
    state.lastFrameMs > 0 ? Math.min(0.1, Math.max(0, (now - state.lastFrameMs) / 1000)) : 0
  state.lastFrameMs = now

  const target = boostActive ? 1 : 0
  const rate = target >= state.intensity ? BOOST_EFFECT_FADE_IN_RATE : BOOST_EFFECT_FADE_OUT_RATE
  const alpha = 1 - Math.exp(-rate * deltaSeconds)
  state.intensity += (target - state.intensity) * alpha
  if (Math.abs(target - state.intensity) < 1e-4) {
    state.intensity = target
  }

  if (boostActive) {
    state.pulse = (state.pulse + deltaSeconds * BOOST_EFFECT_PULSE_SPEED) % (Math.PI * 2)
  }
  const pulseAmount = state.intensity * (Math.sin(state.pulse) * 0.5 + 0.5)
  const phaseTurn = state.pulse / (Math.PI * 2)
  const edgeOpacity = clamp(0.1 + state.intensity * 0.45 + pulseAmount * 0.18, 0, 1)

  element.style.setProperty('--boost-intensity', state.intensity.toFixed(4))
  element.style.setProperty('--boost-pulse', pulseAmount.toFixed(4))
  element.style.setProperty('--boost-edge-opacity', edgeOpacity.toFixed(4))
  element.style.setProperty('--boost-phase', phaseTurn.toFixed(4))

  const shouldApplyActive = state.intensity > BOOST_EFFECT_ACTIVE_CLASS_THRESHOLD
  if (shouldApplyActive !== state.activeClassApplied) {
    element.classList.toggle('boost-fx--active', shouldApplyActive)
    state.activeClassApplied = shouldApplyActive
  }
}
