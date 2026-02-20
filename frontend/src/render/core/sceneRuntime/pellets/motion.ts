import * as THREE from 'three'
import type { PelletSnapshot } from '../../../../game/types'
import { clamp, smoothUnitVector, smoothValue } from '../utils/math'

export type PelletMotionState = {
  gfrOffset: number
  gr: number
  wsp: number
}

export type PelletVisualState = {
  renderNormal: THREE.Vector3
  targetNormal: THREE.Vector3
  lastServerNormal: THREE.Vector3
  velocity: THREE.Vector3
  renderSize: number
  targetSize: number
  lastServerAt: number
  color: string
  colorR: number
  colorG: number
  colorB: number
}

export type CreatePelletMotionHelpersParams = {
  pelletMotionStates: Map<number, PelletMotionState>
  pelletVisualStates: Map<number, PelletVisualState>
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  pelletSizeMin: number
  pelletSizeMax: number
  pelletWobbleWspRange: number
  pelletWobbleGfrRate: number
  pelletWobbleDistance: number
  pelletPredictionMaxHorizonSecs: number
  pelletCorrectionRate: number
  pelletSnapDotThreshold: number
  pelletPosSmoothRate: number
  pelletSizeSmoothRate: number
}

export type PelletMotionHelpers = {
  reconcilePelletVisualState: (
    pellet: PelletSnapshot,
    timeSeconds: number,
    deltaSeconds: number,
  ) => PelletVisualState
  resolvePelletRenderSize: (state: PelletVisualState) => number
  applyPelletWobble: (pellet: PelletSnapshot, out: THREE.Vector3, timeSeconds: number) => void
}

export const pelletSeedUnit = (id: number, salt: number) => {
  let x = (id ^ salt) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  x ^= x >>> 16
  return (x >>> 0) / 0xffff_ffff
}

export const createPelletMotionHelpers = ({
  pelletMotionStates,
  pelletVisualStates,
  buildTangentBasis,
  pelletSizeMin,
  pelletSizeMax,
  pelletWobbleWspRange,
  pelletWobbleGfrRate,
  pelletWobbleDistance,
  pelletPredictionMaxHorizonSecs,
  pelletCorrectionRate,
  pelletSnapDotThreshold,
  pelletPosSmoothRate,
  pelletSizeSmoothRate,
}: CreatePelletMotionHelpersParams): PelletMotionHelpers => {
  const tempA = new THREE.Vector3()
  const tempB = new THREE.Vector3()
  const wobbleTangent = new THREE.Vector3()
  const wobbleBitangent = new THREE.Vector3()
  const parsedColorTemp = new THREE.Color()
  const pelletColorIntensity = 0.84

  const parsePelletColor = (color: string): [number, number, number] => {
    if (typeof color !== 'string') {
      return [1, 1, 1]
    }
    try {
      parsedColorTemp.set(color)
    } catch {
      return [1, 1, 1]
    }
    if (
      !Number.isFinite(parsedColorTemp.r) ||
      !Number.isFinite(parsedColorTemp.g) ||
      !Number.isFinite(parsedColorTemp.b)
    ) {
      return [1, 1, 1]
    }
    return [
      clamp(parsedColorTemp.r * pelletColorIntensity, 0, 1),
      clamp(parsedColorTemp.g * pelletColorIntensity, 0, 1),
      clamp(parsedColorTemp.b * pelletColorIntensity, 0, 1),
    ]
  }

  const getPelletMotionState = (pellet: PelletSnapshot) => {
    let state = pelletMotionStates.get(pellet.id)
    if (state) return state
    const size = Number.isFinite(pellet.size) ? pellet.size : 1
    const clampedSize = clamp(size, pelletSizeMin, pelletSizeMax)
    state = {
      // Mirror slither's per-food random phase, speed, and wobble frequency.
      gfrOffset: pelletSeedUnit(pellet.id, 0x9e3779b1) * 64,
      gr: 0.65 + 0.1 * clampedSize,
      wsp: (pelletSeedUnit(pellet.id, 0x85ebca77) * 2 - 1) * pelletWobbleWspRange,
    }
    pelletMotionStates.set(pellet.id, state)
    return state
  }

  const reconcilePelletVisualState = (
    pellet: PelletSnapshot,
    timeSeconds: number,
    deltaSeconds: number,
  ) => {
    const safeSize = clamp(
      Number.isFinite(pellet.size) ? pellet.size : 1,
      pelletSizeMin,
      pelletSizeMax,
    )
    tempA.set(pellet.x, pellet.y, pellet.z)
    if (tempA.lengthSq() <= 1e-8) {
      tempA.set(0, 0, 1)
    } else {
      tempA.normalize()
    }

    const [colorR, colorG, colorB] = parsePelletColor(pellet.color)
    let state = pelletVisualStates.get(pellet.id)
    if (!state) {
      state = {
        renderNormal: tempA.clone(),
        targetNormal: tempA.clone(),
        lastServerNormal: tempA.clone(),
        velocity: new THREE.Vector3(),
        renderSize: safeSize,
        targetSize: safeSize,
        lastServerAt: timeSeconds,
        color: pellet.color,
        colorR,
        colorG,
        colorB,
      }
      pelletVisualStates.set(pellet.id, state)
      return state
    }

    const serverDot = clamp(state.lastServerNormal.dot(tempA), -1, 1)
    const positionChanged = serverDot < 0.999_999
    if (positionChanged) {
      const dt = clamp(timeSeconds - state.lastServerAt, 1 / 120, 0.35)
      tempB.copy(tempA).sub(state.lastServerNormal).multiplyScalar(1 / dt)
      tempB.addScaledVector(tempA, -tempB.dot(tempA))
      if (!Number.isFinite(tempB.lengthSq())) {
        tempB.set(0, 0, 0)
      }
      if (state.renderNormal.dot(tempA) < pelletSnapDotThreshold) {
        state.renderNormal.copy(tempA)
        state.velocity.set(0, 0, 0)
      } else {
        state.velocity.lerp(tempB, 0.65)
      }
      state.targetNormal.copy(tempA)
      state.lastServerNormal.copy(tempA)
      state.lastServerAt = timeSeconds
    }

    state.targetSize = safeSize
    state.color = pellet.color
    state.colorR = colorR
    state.colorG = colorG
    state.colorB = colorB
    state.velocity.multiplyScalar(Math.exp(-4 * Math.max(0, deltaSeconds)))
    const horizon = clamp(
      timeSeconds - state.lastServerAt,
      0,
      pelletPredictionMaxHorizonSecs,
    )
    tempB.copy(state.targetNormal).addScaledVector(state.velocity, horizon)
    if (tempB.lengthSq() <= 1e-10) {
      tempB.copy(state.targetNormal)
    } else {
      tempB.normalize()
    }
    const correctionAlpha = 1 - Math.exp(-pelletCorrectionRate * Math.max(0, deltaSeconds))
    tempB.lerp(state.targetNormal, correctionAlpha)
    if (tempB.lengthSq() <= 1e-10) {
      tempB.copy(state.targetNormal)
    } else {
      tempB.normalize()
    }
    smoothUnitVector(
      state.renderNormal,
      tempB,
      deltaSeconds,
      pelletPosSmoothRate,
    )
    state.renderSize = smoothValue(
      state.renderSize,
      state.targetSize,
      deltaSeconds,
      pelletSizeSmoothRate,
      pelletSizeSmoothRate,
    )
    return state
  }

  const resolvePelletRenderSize = (state: PelletVisualState) => {
    return clamp(state.renderSize, pelletSizeMin, pelletSizeMax)
  }

  const applyPelletWobble = (pellet: PelletSnapshot, out: THREE.Vector3, timeSeconds: number) => {
    if (!Number.isFinite(timeSeconds)) return
    const state = getPelletMotionState(pellet)
    const gfr = state.gfrOffset + timeSeconds * pelletWobbleGfrRate * state.gr
    const wobbleAngle = state.wsp * gfr
    const baseRadius = out.length()
    if (!Number.isFinite(baseRadius) || baseRadius <= 1e-8) return
    tempA.copy(out).multiplyScalar(1 / baseRadius)
    buildTangentBasis(tempA, wobbleTangent, wobbleBitangent)
    out
      .addScaledVector(wobbleTangent, Math.cos(wobbleAngle) * pelletWobbleDistance)
      .addScaledVector(wobbleBitangent, Math.sin(wobbleAngle) * pelletWobbleDistance)
      .normalize()
      .multiplyScalar(baseRadius)
  }

  return {
    reconcilePelletVisualState,
    resolvePelletRenderSize,
    applyPelletWobble,
  }
}
