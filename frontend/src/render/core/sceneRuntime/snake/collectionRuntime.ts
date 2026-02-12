import * as THREE from 'three'
import type { PelletSnapshot, PlayerSnapshot } from '../../../../game/types'
import type { PelletOverride } from '../pellets/runtime'
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
    pellets: PelletSnapshot[] | null,
    nowMs: number,
  ) => PelletOverride | null
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
    pellets: PelletSnapshot[] | null,
    nowMs: number,
  ) => PelletOverride | null
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
    visual.tongueBase.material.dispose()
    visual.tongueForkLeft.material.dispose()
    visual.tongueForkRight.material.dispose()
    visual.boostDraftMaterial.dispose()
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
    pellets: PelletSnapshot[] | null,
    nowMs: number,
  ): PelletOverride | null => {
    const activeIds = new Set<string>()
    setLocalGroundingInfo(null)
    let pelletOverride: PelletOverride | null = null
    for (const player of players) {
      activeIds.add(player.id)
      const override = updateSnake(
        player,
        player.id === localPlayerId,
        deltaSeconds,
        pellets,
        nowMs,
      )
      if (override) {
        pelletOverride = override
      }
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

    return pelletOverride
  }

  return {
    removeSnake,
    updateSnakes,
  }
}
