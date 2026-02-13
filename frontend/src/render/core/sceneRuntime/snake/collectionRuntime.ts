import * as THREE from 'three'
import type { PlayerSnapshot } from '../../../../game/types'
import type { DeathState, SnakeVisual } from '../runtimeTypes'
import type { SnakeTubeCache } from './geometry'
import type { SnakeGroundingInfo } from './grounding'

type CreateSnakeCollectionRuntimeOptions = {
  snakesGroup: THREE.Group
  tailGeometry: THREE.BufferGeometry
  resetSnakeTransientState: (id: string) => void
  pelletMouthTargets: Map<string, THREE.Vector3>
  deathStates: Map<string, DeathState>
  lastAliveStates: Map<string, boolean>
  lastSnakeStarts: Map<string, number>
  snakeTubeCaches: Map<string, SnakeTubeCache>
  snakes: Map<string, SnakeVisual>
  lastHeadPositions: Map<string, THREE.Vector3>
  lastForwardDirections: Map<string, THREE.Vector3>
  lastTailContactNormals: Map<string, THREE.Vector3>
  setLocalGroundingInfo: (value: SnakeGroundingInfo | null) => void
  updateSnake: (
    player: PlayerSnapshot,
    isLocal: boolean,
    deltaSeconds: number,
    nowMs: number,
  ) => void
  updateBoostTrailForPlayer: (
    player: PlayerSnapshot,
    tailContactNormal: THREE.Vector3 | null,
    nowMs: number,
  ) => void
  updateInactiveBoostTrails: (activeIds: Set<string>, nowMs: number) => void
}

type SnakeCollectionRuntime = {
  removeSnake: (visual: SnakeVisual, id: string) => void
  updateSnakes: (
    players: PlayerSnapshot[],
    localPlayerId: string | null,
    deltaSeconds: number,
    nowMs: number,
  ) => void
}

export const createSnakeCollectionRuntime = (
  options: CreateSnakeCollectionRuntimeOptions,
): SnakeCollectionRuntime => {
  const {
    snakesGroup,
    tailGeometry,
    resetSnakeTransientState,
    pelletMouthTargets,
    deathStates,
    lastAliveStates,
    lastSnakeStarts,
    snakeTubeCaches,
    snakes,
    lastHeadPositions,
    lastForwardDirections,
    lastTailContactNormals,
    setLocalGroundingInfo,
    updateSnake,
    updateBoostTrailForPlayer,
    updateInactiveBoostTrails,
  } = options

  const removeSnake = (visual: SnakeVisual, id: string) => {
    snakesGroup.remove(visual.group)
    const tubeGeometry = visual.tube.geometry
    const glowGeometry = visual.selfOverlapGlow.geometry
    tubeGeometry.dispose()
    if (glowGeometry !== tubeGeometry) {
      glowGeometry.dispose()
    }
    if (visual.tail.geometry !== tailGeometry) {
      visual.tail.geometry.dispose()
    }
    visual.tube.material.dispose()
    visual.selfOverlapGlowMaterial.dispose()
    visual.head.material.dispose()
    visual.eyeLeft.material.dispose()
    visual.eyeRight.material.dispose()
    visual.pupilLeft.material.dispose()
    visual.pupilRight.material.dispose()
    visual.boostDraftMaterial.dispose()
    for (const sprite of visual.boostBodyGlowSprites) {
      sprite.material.dispose()
    }
    visual.boostBodyGlowSprites.length = 0
    visual.intakeConeMaterial.dispose()
    visual.nameplateMaterial.dispose()
    visual.nameplateTexture?.dispose()
    visual.bowlMaterial.dispose()
    resetSnakeTransientState(id)
    pelletMouthTargets.delete(id)
    deathStates.delete(id)
    lastAliveStates.delete(id)
    lastSnakeStarts.delete(id)
    snakeTubeCaches.delete(id)
  }

  const updateSnakes = (
    players: PlayerSnapshot[],
    localPlayerId: string | null,
    deltaSeconds: number,
    nowMs: number,
  ) => {
    const activeIds = new Set<string>()
    setLocalGroundingInfo(null)
    for (const player of players) {
      activeIds.add(player.id)
      updateSnake(
        player,
        player.id === localPlayerId,
        deltaSeconds,
        nowMs,
      )
      const tailContactNormal = lastTailContactNormals.get(player.id) ?? null
      updateBoostTrailForPlayer(player, tailContactNormal, nowMs)
    }

    for (const [id, visual] of snakes) {
      if (!activeIds.has(id)) {
        removeSnake(visual, id)
        snakes.delete(id)
        lastHeadPositions.delete(id)
        lastForwardDirections.delete(id)
      }
    }
    updateInactiveBoostTrails(activeIds, nowMs)
  }

  return {
    removeSnake,
    updateSnakes,
  }
}
