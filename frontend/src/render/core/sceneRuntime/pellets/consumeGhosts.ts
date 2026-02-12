import * as THREE from 'three'
import { clamp, lerp } from '../utils/math'
import { pelletSeedUnit, type PelletVisualState } from './motion'

export type PelletConsumeGhost = {
  pelletId: number
  startPosition: THREE.Vector3
  targetPosition: THREE.Vector3
  position: THREE.Vector3
  normal: THREE.Vector3
  startRadius: number
  startSize: number
  size: number
  colorIndex: number
  age: number
  duration: number
  targetPlayerId: string | null
  wobblePhase: number
  wobbleSpeed: number
  wobbleScale: number
}

export type CreateConsumeGhostHelpersParams = {
  pelletConsumeGhosts: PelletConsumeGhost[]
  resolveConsumeGhostTarget: (
    targetPlayerId: string | null,
    consumeBlend: number,
    out: THREE.Vector3,
  ) => boolean
  getPelletSurfacePositionFromNormal: (
    id: number,
    normal: THREE.Vector3,
    size: number,
    out: THREE.Vector3,
  ) => THREE.Vector3
  resolvePelletRenderSize: (state: PelletVisualState) => number
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  pelletConsumeGhostDurationSecs: number
  pelletConsumeGhostWobbleSpeedMin: number
  pelletConsumeGhostWobbleSpeedMax: number
  pelletConsumeGhostWobbleDistance: number
}

export type ConsumeGhostHelpers = {
  spawnPelletConsumeGhost: (
    pelletId: number,
    state: PelletVisualState,
    lockedTargetPlayerId: string | null,
  ) => void
  updatePelletConsumeGhost: (ghost: PelletConsumeGhost, deltaSeconds: number) => boolean
}

export const createPelletConsumeGhostHelpers = ({
  pelletConsumeGhosts,
  resolveConsumeGhostTarget,
  getPelletSurfacePositionFromNormal,
  resolvePelletRenderSize,
  buildTangentBasis,
  pelletConsumeGhostDurationSecs,
  pelletConsumeGhostWobbleSpeedMin,
  pelletConsumeGhostWobbleSpeedMax,
  pelletConsumeGhostWobbleDistance,
}: CreateConsumeGhostHelpersParams): ConsumeGhostHelpers => {
  const tempA = new THREE.Vector3()
  const tempB = new THREE.Vector3()
  const wobbleTangent = new THREE.Vector3()
  const wobbleBitangent = new THREE.Vector3()

  const spawnPelletConsumeGhost = (
    pelletId: number,
    state: PelletVisualState,
    lockedTargetPlayerId: string | null,
  ) => {
    const startSize = resolvePelletRenderSize(state)
    if (startSize <= 0.02) return
    getPelletSurfacePositionFromNormal(
      pelletId,
      state.renderNormal,
      startSize,
      tempA,
    )
    const startRadius = tempA.length()
    const targetPlayerId = lockedTargetPlayerId
    if (!targetPlayerId || targetPlayerId.length <= 0) return
    if (!resolveConsumeGhostTarget(targetPlayerId, 0, tempB)) return
    const normal = tempA.clone().normalize()
    const existingGhost = pelletConsumeGhosts.find((ghost) => ghost.pelletId === pelletId) ?? null
    if (existingGhost && existingGhost.age < existingGhost.duration) {
      return
    }
    const wobbleSpeed = lerp(
      pelletConsumeGhostWobbleSpeedMin,
      pelletConsumeGhostWobbleSpeedMax,
      pelletSeedUnit(pelletId, 0x16f11fe8),
    )
    const wobbleScale = lerp(0.72, 1.16, pelletSeedUnit(pelletId, 0x51f15e53))
    const wobblePhase = pelletSeedUnit(pelletId, 0x9e3779b1) * Math.PI * 2
    if (existingGhost) {
      existingGhost.startPosition.copy(tempA)
      existingGhost.targetPosition.copy(tempB)
      existingGhost.position.copy(tempA)
      existingGhost.normal.copy(normal)
      existingGhost.startRadius = startRadius
      existingGhost.startSize = startSize
      existingGhost.size = startSize
      existingGhost.colorIndex = state.colorIndex
      existingGhost.age = 0
      existingGhost.duration = pelletConsumeGhostDurationSecs
      existingGhost.targetPlayerId = targetPlayerId
      existingGhost.wobblePhase = wobblePhase
      existingGhost.wobbleSpeed = wobbleSpeed
      existingGhost.wobbleScale = wobbleScale
      return
    }
    pelletConsumeGhosts.push({
      pelletId,
      startPosition: tempA.clone(),
      targetPosition: tempB.clone(),
      position: tempA.clone(),
      normal,
      startRadius,
      startSize,
      size: startSize,
      colorIndex: state.colorIndex,
      age: 0,
      duration: pelletConsumeGhostDurationSecs,
      targetPlayerId,
      wobblePhase,
      wobbleSpeed,
      wobbleScale,
    })
    if (pelletConsumeGhosts.length > 1024) {
      pelletConsumeGhosts.splice(0, pelletConsumeGhosts.length - 1024)
    }
  }

  const updatePelletConsumeGhost = (ghost: PelletConsumeGhost, deltaSeconds: number) => {
    ghost.age += Math.max(0, deltaSeconds)
    const t = clamp(ghost.age / Math.max(1e-4, ghost.duration), 0, 1)
    if (t >= 1) {
      return false
    }
    const consumeBlend = t * t
    if (resolveConsumeGhostTarget(ghost.targetPlayerId, consumeBlend, tempA)) {
      ghost.targetPosition.copy(tempA)
    }
    const targetRadius = Math.max(1e-6, ghost.targetPosition.length())
    const renderRadius = lerp(ghost.startRadius, targetRadius, consumeBlend)
    ghost.position.copy(ghost.startPosition).lerp(ghost.targetPosition, consumeBlend)
    if (ghost.position.lengthSq() <= 1e-8) {
      ghost.position.copy(ghost.targetPosition)
    }
    if (ghost.position.lengthSq() > 1e-8) {
      ghost.position.normalize().multiplyScalar(renderRadius)
      ghost.normal.copy(ghost.position).normalize()
    }
    const wobbleStrength = pelletConsumeGhostWobbleDistance * ghost.wobbleScale * (1 - t)
    if (wobbleStrength > 1e-6 && ghost.normal.lengthSq() > 1e-8) {
      buildTangentBasis(ghost.normal, wobbleTangent, wobbleBitangent)
      const wobbleAngle = ghost.wobblePhase + ghost.age * ghost.wobbleSpeed
      ghost.position
        .addScaledVector(wobbleTangent, Math.cos(wobbleAngle) * wobbleStrength)
        .addScaledVector(wobbleBitangent, Math.sin(wobbleAngle) * wobbleStrength)
      if (ghost.position.lengthSq() > 1e-8) {
        ghost.position.normalize().multiplyScalar(renderRadius)
        ghost.normal.copy(ghost.position).normalize()
      }
    }
    ghost.size = Math.max(0.01, ghost.startSize * Math.max(0, 1 - t * consumeBlend))
    return true
  }

  return {
    spawnPelletConsumeGhost,
    updatePelletConsumeGhost,
  }
}
