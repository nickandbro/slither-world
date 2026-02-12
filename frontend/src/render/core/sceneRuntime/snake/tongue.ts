import * as THREE from 'three'
import type { PelletSnapshot } from '../../../../game/types'
import { clamp, smoothValue } from '../utils/math'

export type TongueState = {
  length: number
  mode: 'idle' | 'extend' | 'retract'
  targetPosition: THREE.Vector3 | null
  carrying: boolean
}

export type TonguePelletOverride = {
  id: number
  position: THREE.Vector3
}

export type TongueVisual = {
  tongue: THREE.Group
  tongueBase: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongueForkLeft: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  tongueForkRight: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
}

type TongueConstants = {
  mouthForward: number
  mouthOut: number
  pelletMatch: number
  nearRange: number
  maxRange: number
  maxLength: number
  grabEps: number
  hideThreshold: number
  forkLength: number
  angleLimit: number
  extendRate: number
  retractRate: number
}

type CreateTongueControllerParams = {
  enabled: boolean
  tongueStates: Map<string, TongueState>
  getPelletSurfacePosition: (
    pellet: PelletSnapshot,
    out: THREE.Vector3,
  ) => THREE.Vector3
  constants: TongueConstants
}

export const createTongueController = ({
  enabled,
  tongueStates,
  getPelletSurfacePosition,
  constants,
}: CreateTongueControllerParams) => {
  const {
    mouthForward,
    mouthOut,
    pelletMatch,
    nearRange,
    maxRange,
    maxLength,
    grabEps,
    hideThreshold,
    forkLength,
    angleLimit,
    extendRate,
    retractRate,
  } = constants

  const mouthPosition = new THREE.Vector3()
  const pelletPosition = new THREE.Vector3()
  const directionToTarget = new THREE.Vector3()
  const tangentDirection = new THREE.Vector3()
  const tongueQuat = new THREE.Quaternion()
  const tongueUp = new THREE.Vector3(0, 1, 0)

  const updateTongue = (
    playerId: string,
    visual: TongueVisual,
    headPosition: THREE.Vector3,
    headNormal: THREE.Vector3,
    forward: THREE.Vector3,
    headScale: number,
    pellets: PelletSnapshot[] | null,
    deltaSeconds: number,
  ): TonguePelletOverride | null => {
    if (!enabled) {
      visual.tongue.visible = false
      tongueStates.delete(playerId)
      return null
    }

    let state = tongueStates.get(playerId)
    if (!state) {
      state = { length: 0, mode: 'idle', targetPosition: null, carrying: false }
      tongueStates.set(playerId, state)
    }

    mouthPosition
      .copy(headPosition)
      .addScaledVector(forward, mouthForward * headScale)
      .addScaledVector(headNormal, mouthOut * headScale)
    const tongueMatchDistance = pelletMatch * headScale
    const tongueNearRange = nearRange * headScale
    const tongueMaxRange = maxRange * headScale
    const tongueMaxLength = maxLength * headScale
    const tongueGrabEps = grabEps * headScale
    const tongueHideThreshold = hideThreshold * headScale
    const tongueForkLengthMax = forkLength * headScale

    let desiredLength = 0
    let candidatePosition: THREE.Vector3 | null = null
    let candidateDistance = Infinity
    let hasCandidate = false
    let matchedPelletId: number | null = null
    let matchedPosition: THREE.Vector3 | null = null

    if (!pellets || pellets.length === 0) {
      if (state.mode !== 'idle') {
        state.mode = 'retract'
        state.carrying = false
        state.targetPosition = null
      }
    } else {
      if (state.targetPosition) {
        let bestDistanceSq = Infinity
        let bestPelletId: number | null = null
        let bestPosition: THREE.Vector3 | null = null
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          getPelletSurfacePosition(pellet, pelletPosition)
          const distSq = pelletPosition.distanceToSquared(state.targetPosition)
          if (distSq < bestDistanceSq) {
            bestDistanceSq = distSq
            bestPelletId = pellet.id
            bestPosition = pelletPosition.clone()
          }
        }
        const matchThresholdSq = tongueMatchDistance * tongueMatchDistance
        if (bestPelletId !== null && bestPosition && bestDistanceSq <= matchThresholdSq) {
          matchedPelletId = bestPelletId
          matchedPosition = bestPosition
          state.targetPosition.copy(bestPosition)
        } else if (state.mode === 'retract') {
          state.carrying = false
          state.targetPosition = null
        } else if (state.mode === 'extend') {
          state.mode = 'retract'
          state.carrying = false
          state.targetPosition = null
        }
      }

      if (state.mode === 'extend' && state.targetPosition) {
        directionToTarget.copy(state.targetPosition).sub(mouthPosition)
        const distance = directionToTarget.length()
        tangentDirection
          .copy(directionToTarget)
          .addScaledVector(headNormal, -directionToTarget.dot(headNormal))
        const tangentLen = tangentDirection.length()
        if (tangentLen > 1e-6) {
          tangentDirection.multiplyScalar(1 / tangentLen)
        }
        const angle = tangentLen > 1e-6 ? Math.acos(clamp(forward.dot(tangentDirection), -1, 1)) : Math.PI
        if (distance <= tongueNearRange && angle <= angleLimit) {
          candidatePosition = state.targetPosition
          candidateDistance = distance
          desiredLength = Math.min(distance, tongueMaxLength)
          hasCandidate = true
        } else {
          state.mode = 'retract'
          state.carrying = false
          state.targetPosition = null
        }
      }

      if (!hasCandidate && state.mode === 'idle') {
        for (let i = 0; i < pellets.length; i += 1) {
          const pellet = pellets[i]
          getPelletSurfacePosition(pellet, pelletPosition)
          directionToTarget.copy(pelletPosition).sub(mouthPosition)
          const distance = directionToTarget.length()
          tangentDirection
            .copy(directionToTarget)
            .addScaledVector(headNormal, -directionToTarget.dot(headNormal))
          const tangentLen = tangentDirection.length()
          if (tangentLen < 1e-6) continue
          tangentDirection.multiplyScalar(1 / tangentLen)
          const angle = Math.acos(clamp(forward.dot(tangentDirection), -1, 1))
          if (angle > angleLimit) continue
          if (distance > tongueMaxRange) continue
          if (distance > tongueNearRange) continue
          if (distance < candidateDistance) {
            candidateDistance = distance
            candidatePosition = pelletPosition.clone()
          }
        }
      }

      if (candidatePosition) {
        desiredLength = Math.min(candidateDistance, tongueMaxLength)
        state.targetPosition = candidatePosition
        state.mode = 'extend'
        state.carrying = false
        hasCandidate = true
      } else if (state.mode === 'extend') {
        state.mode = 'retract'
        state.carrying = false
      }
    }

    const targetLength = state.mode === 'extend' && hasCandidate ? desiredLength : 0
    state.length = smoothValue(state.length, targetLength, deltaSeconds, extendRate, retractRate)

    if (state.mode === 'extend' && hasCandidate && state.length >= desiredLength - tongueGrabEps) {
      state.mode = 'retract'
      state.carrying = matchedPelletId !== null && matchedPosition !== null
      if (!state.carrying) {
        state.targetPosition = null
      }
    }

    if (state.mode === 'retract' && state.length <= tongueHideThreshold) {
      if (!state.carrying) {
        state.mode = 'idle'
        state.targetPosition = null
        state.carrying = false
      }
    }

    let override: TonguePelletOverride | null = null
    let targetPosition = state.targetPosition

    if (state.mode === 'retract' && state.carrying && targetPosition && pellets && pellets.length > 0) {
      if (matchedPelletId !== null && matchedPosition) {
        if (state.targetPosition) {
          state.targetPosition.copy(matchedPosition)
        } else {
          state.targetPosition = matchedPosition
        }
        targetPosition = state.targetPosition
        directionToTarget.copy(targetPosition).sub(mouthPosition)
        if (directionToTarget.lengthSq() > 1e-6) {
          directionToTarget.normalize()
        } else {
          directionToTarget.copy(forward)
        }
        const grabbedPos = mouthPosition.clone().addScaledVector(directionToTarget, state.length)
        override = { id: matchedPelletId, position: grabbedPos }
      } else {
        state.carrying = false
        state.targetPosition = null
      }
    }

    const isVisible = state.length > tongueHideThreshold
    visual.tongue.visible = isVisible
    if (!isVisible) {
      return override
    }

    let tongueDir = forward
    if (targetPosition) {
      directionToTarget.copy(targetPosition).sub(mouthPosition)
      if (directionToTarget.lengthSq() > 1e-6) {
        directionToTarget.normalize()
        tongueDir = directionToTarget
      }
    }

    visual.tongue.position.copy(mouthPosition)
    tongueQuat.setFromUnitVectors(tongueUp, tongueDir)
    visual.tongue.quaternion.copy(tongueQuat)

    const tongueLength = Math.max(state.length, 0.001)
    visual.tongueBase.scale.set(headScale, tongueLength, headScale)
    const forkLengthClamped = Math.min(tongueForkLengthMax, tongueLength * 0.6)
    visual.tongueForkLeft.scale.set(headScale, forkLengthClamped, headScale)
    visual.tongueForkRight.scale.set(headScale, forkLengthClamped, headScale)
    visual.tongueForkLeft.position.set(0, tongueLength, 0)
    visual.tongueForkRight.position.set(0, tongueLength, 0)

    return override
  }

  return {
    updateTongue,
  }
}
