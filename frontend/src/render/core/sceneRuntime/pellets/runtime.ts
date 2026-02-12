import * as THREE from 'three'
import type { PelletSnapshot } from '../../../../game/types'
import type { PelletMotionState, PelletVisualState } from './motion'
import type { PelletGroundCacheEntry } from './surface'
import type { PelletConsumeGhost } from './consumeGhosts'
import type { PelletSpriteBucket } from './buckets'
import { isDirectionNearSide } from '../environment/culling'
import {
  PELLET_CONSUME_GHOST_OPACITY_FADE_START,
  PELLET_CORE_OPACITY_BASE,
  PELLET_CORE_OPACITY_RANGE,
  PELLET_CORE_SIZE_RANGE,
  PELLET_GLOW_HORIZON_MARGIN,
  PELLET_GLOW_OPACITY_BASE,
  PELLET_GLOW_OPACITY_RANGE,
  PELLET_GLOW_PHASE_STEP,
  PELLET_GLOW_PULSE_SPEED,
  PELLET_GLOW_SIZE_RANGE,
  PELLET_INNER_GLOW_OPACITY_BASE,
  PELLET_INNER_GLOW_OPACITY_RANGE,
  PELLET_INNER_GLOW_SIZE_RANGE,
  PELLET_SHADOW_OPACITY_BASE,
  PELLET_SHADOW_OPACITY_RANGE,
  PELLET_WOBBLE_DISABLE_VISIBLE_THRESHOLD,
} from '../constants'
import { clamp, smoothstep } from '../utils/math'

type CreatePelletRuntimeUpdaterOptions = {
  reconcilePelletVisualState: (
    pellet: PelletSnapshot,
    timeSeconds: number,
    deltaSeconds: number,
  ) => PelletVisualState
  pelletIdsSeen: Set<number>
  pelletVisualStates: Map<number, PelletVisualState>
  pelletConsumeTargetByPelletId: Map<number, string>
  spawnPelletConsumeGhost: (
    pelletId: number,
    state: PelletVisualState,
    consumeTargetPlayerId: string | null,
  ) => void
  pelletConsumeGhosts: PelletConsumeGhost[]
  updatePelletConsumeGhost: (ghost: PelletConsumeGhost, deltaSeconds: number) => boolean
  pelletBucketCounts: number[]
  pelletBucketOffsets: number[]
  pelletBucketPositionArrays: Array<Float32Array | null>
  pelletBucketOpacityArrays: Array<Float32Array | null>
  pelletBuckets: Array<PelletSpriteBucket | null>
  pelletBucketIndex: (colorIndex: number, size: number) => number
  ensurePelletBucketCapacity: (bucketIndex: number, requiredCount: number) => PelletSpriteBucket
  resolvePelletRenderSize: (state: PelletVisualState) => number
  tempVector: THREE.Vector3
  getPelletSurfacePositionFromNormal: (
    pelletId: number,
    normal: THREE.Vector3,
    size: number,
    out: THREE.Vector3,
  ) => THREE.Vector3
  applyPelletWobble: (
    pellet: PelletSnapshot,
    out: THREE.Vector3,
    timeSeconds: number,
  ) => void
  pelletGroundCache: Map<number, PelletGroundCacheEntry>
  pelletMotionStates: Map<number, PelletMotionState>
}

type PelletRuntimeUpdater = {
  updatePellets: (
    pellets: PelletSnapshot[],
    timeSeconds: number,
    deltaSeconds: number,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => void
  updatePelletGlow: (timeSeconds: number) => void
}

export const createPelletRuntimeUpdater = (
  options: CreatePelletRuntimeUpdaterOptions,
): PelletRuntimeUpdater => {
  const {
    reconcilePelletVisualState,
    pelletIdsSeen,
    pelletVisualStates,
    pelletConsumeTargetByPelletId,
    spawnPelletConsumeGhost,
    pelletConsumeGhosts,
    updatePelletConsumeGhost,
    pelletBucketCounts,
    pelletBucketOffsets,
    pelletBucketPositionArrays,
    pelletBucketOpacityArrays,
    pelletBuckets,
    pelletBucketIndex,
    ensurePelletBucketCapacity,
    resolvePelletRenderSize,
    tempVector,
    getPelletSurfacePositionFromNormal,
    applyPelletWobble,
    pelletGroundCache,
    pelletMotionStates,
  } = options

  const updatePellets = (
    pellets: PelletSnapshot[],
    timeSeconds: number,
    deltaSeconds: number,
    cameraLocalDir: THREE.Vector3,
    viewAngle: number,
  ) => {
    const safeDeltaSeconds = Math.max(0, deltaSeconds)
    pelletIdsSeen.clear()
    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      pelletIdsSeen.add(pellet.id)
      reconcilePelletVisualState(pellet, timeSeconds, safeDeltaSeconds)
    }

    for (const [id, state] of pelletVisualStates) {
      if (!pelletIdsSeen.has(id)) {
        const consumeTarget = pelletConsumeTargetByPelletId.get(id) ?? null
        spawnPelletConsumeGhost(id, state, consumeTarget)
        pelletConsumeTargetByPelletId.delete(id)
        pelletVisualStates.delete(id)
      }
    }

    for (let i = pelletConsumeGhosts.length - 1; i >= 0; i -= 1) {
      const ghost = pelletConsumeGhosts[i]!
      if (pelletIdsSeen.has(ghost.pelletId) || !updatePelletConsumeGhost(ghost, safeDeltaSeconds)) {
        pelletConsumeGhosts.splice(i, 1)
      }
    }

    const pelletBucketCount = pelletBucketCounts.length
    for (let i = 0; i < pelletBucketCount; i += 1) {
      pelletBucketCounts[i] = 0
      pelletBucketOffsets[i] = 0
      pelletBucketPositionArrays[i] = null
      pelletBucketOpacityArrays[i] = null
    }

    // Keep large glow sprites stable near the horizon while culling the far hemisphere.
    const visibleLimit = Math.min(Math.PI - 1e-4, viewAngle + PELLET_GLOW_HORIZON_MARGIN)
    const minDirectionDot = Math.cos(visibleLimit)
    let visibleCount = 0

    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      const state = pelletVisualStates.get(pellet.id)
      if (!state) continue
      if (
        !isDirectionNearSide(
          state.renderNormal.x,
          state.renderNormal.y,
          state.renderNormal.z,
          cameraLocalDir,
          minDirectionDot,
        )
      ) {
        continue
      }
      const renderPelletSize = resolvePelletRenderSize(state)
      const bucketIndex = pelletBucketIndex(state.colorIndex, renderPelletSize)
      pelletBucketCounts[bucketIndex] += 1
      visibleCount += 1
    }
    for (let i = 0; i < pelletConsumeGhosts.length; i += 1) {
      const ghost = pelletConsumeGhosts[i]!
      if (
        !isDirectionNearSide(
          ghost.normal.x,
          ghost.normal.y,
          ghost.normal.z,
          cameraLocalDir,
          minDirectionDot,
        )
      ) {
        continue
      }
      const bucketIndex = pelletBucketIndex(ghost.colorIndex, ghost.size)
      pelletBucketCounts[bucketIndex] += 1
      visibleCount += 1
    }

    for (let bucketIndex = 0; bucketIndex < pelletBucketCount; bucketIndex += 1) {
      const required = pelletBucketCounts[bucketIndex]
      const bucket = pelletBuckets[bucketIndex]
      if (required <= 0) {
        if (bucket) {
          if (bucket.kind === 'points') {
            bucket.shadowPoints.visible = false
            bucket.corePoints.visible = false
            bucket.innerGlowPoints.visible = false
            bucket.glowPoints.visible = false
            bucket.corePoints.geometry.setDrawRange(0, 0)
          } else {
            bucket.shadowSprite.visible = false
            bucket.coreSprite.visible = false
            bucket.innerGlowSprite.visible = false
            bucket.glowSprite.visible = false
            bucket.shadowSprite.count = 0
            bucket.coreSprite.count = 0
            bucket.innerGlowSprite.count = 0
            bucket.glowSprite.count = 0
          }
        }
        continue
      }
      const nextBucket = ensurePelletBucketCapacity(bucketIndex, required)
      if (nextBucket.kind === 'points') {
        nextBucket.shadowPoints.visible = true
        nextBucket.corePoints.visible = true
        nextBucket.innerGlowPoints.visible = true
        nextBucket.glowPoints.visible = true
        nextBucket.corePoints.geometry.setDrawRange(0, required)
      } else {
        nextBucket.shadowSprite.visible = true
        nextBucket.coreSprite.visible = true
        nextBucket.innerGlowSprite.visible = true
        nextBucket.glowSprite.visible = true
        nextBucket.shadowSprite.count = required
        nextBucket.coreSprite.count = required
        nextBucket.innerGlowSprite.count = required
        nextBucket.glowSprite.count = required
      }
      pelletBucketPositionArrays[bucketIndex] = nextBucket.positionAttribute.array as Float32Array
      pelletBucketOpacityArrays[bucketIndex] = nextBucket.opacityAttribute.array as Float32Array
    }
    for (let i = 0; i < pellets.length; i += 1) {
      const pellet = pellets[i]
      const state = pelletVisualStates.get(pellet.id)
      if (!state) continue
      if (
        !isDirectionNearSide(
          state.renderNormal.x,
          state.renderNormal.y,
          state.renderNormal.z,
          cameraLocalDir,
          minDirectionDot,
        )
      ) {
        continue
      }
      const renderPelletSize = resolvePelletRenderSize(state)
      const bucketIndex = pelletBucketIndex(state.colorIndex, renderPelletSize)
      const positions = pelletBucketPositionArrays[bucketIndex]
      const opacities = pelletBucketOpacityArrays[bucketIndex]
      if (!positions || !opacities) continue

      getPelletSurfacePositionFromNormal(
        pellet.id,
        state.renderNormal,
        state.renderSize,
        tempVector,
      )
      if (visibleCount <= PELLET_WOBBLE_DISABLE_VISIBLE_THRESHOLD) {
        applyPelletWobble(pellet, tempVector, timeSeconds)
      }

      const itemIndex = pelletBucketOffsets[bucketIndex]
      pelletBucketOffsets[bucketIndex] += 1
      const pOffset = itemIndex * 3
      positions[pOffset] = tempVector.x
      positions[pOffset + 1] = tempVector.y
      positions[pOffset + 2] = tempVector.z
      opacities[itemIndex] = 1
    }
    for (let i = 0; i < pelletConsumeGhosts.length; i += 1) {
      const ghost = pelletConsumeGhosts[i]!
      if (
        !isDirectionNearSide(
          ghost.normal.x,
          ghost.normal.y,
          ghost.normal.z,
          cameraLocalDir,
          minDirectionDot,
        )
      ) {
        continue
      }
      const bucketIndex = pelletBucketIndex(ghost.colorIndex, ghost.size)
      const positions = pelletBucketPositionArrays[bucketIndex]
      const opacities = pelletBucketOpacityArrays[bucketIndex]
      if (!positions || !opacities) continue
      tempVector.copy(ghost.position)
      const itemIndex = pelletBucketOffsets[bucketIndex]
      pelletBucketOffsets[bucketIndex] += 1
      const pOffset = itemIndex * 3
      positions[pOffset] = tempVector.x
      positions[pOffset + 1] = tempVector.y
      positions[pOffset + 2] = tempVector.z
      const ageT = clamp(ghost.age / Math.max(1e-4, ghost.duration), 0, 1)
      opacities[itemIndex] = clamp(
        1 - smoothstep(PELLET_CONSUME_GHOST_OPACITY_FADE_START, 1, ageT),
        0,
        1,
      )
    }

    for (let bucketIndex = 0; bucketIndex < pelletBucketCount; bucketIndex += 1) {
      if (pelletBucketCounts[bucketIndex] <= 0) continue
      const bucket = pelletBuckets[bucketIndex]
      if (!bucket) continue
      bucket.positionAttribute.needsUpdate = true
      bucket.opacityAttribute.needsUpdate = true
    }

    for (const id of pelletGroundCache.keys()) {
      if (!pelletIdsSeen.has(id)) {
        pelletGroundCache.delete(id)
      }
    }
    for (const id of pelletMotionStates.keys()) {
      if (!pelletIdsSeen.has(id)) {
        pelletMotionStates.delete(id)
      }
    }
  }

  const updatePelletGlow = (timeSeconds: number) => {
    const pelletBucketCount = pelletBuckets.length
    for (let bucketIndex = 0; bucketIndex < pelletBucketCount; bucketIndex += 1) {
      const bucket = pelletBuckets[bucketIndex]
      if (!bucket) continue
      const phase =
        timeSeconds * PELLET_GLOW_PULSE_SPEED +
        bucket.colorBucketIndex * PELLET_GLOW_PHASE_STEP +
        bucket.sizeTierIndex * 0.91
      const pulse = 0.5 + 0.5 * Math.cos(phase)
      const centered = (pulse - 0.5) * 2
      const shadowPulse = 0.5 + 0.5 * Math.cos(phase * 0.6 + 1.1)
      bucket.shadowMaterial.opacity = clamp(
        PELLET_SHADOW_OPACITY_BASE + shadowPulse * PELLET_SHADOW_OPACITY_RANGE,
        0.86,
        0.94,
      )
      bucket.shadowMaterial.size = bucket.baseShadowSize
      bucket.coreMaterial.opacity = clamp(
        PELLET_CORE_OPACITY_BASE + pulse * PELLET_CORE_OPACITY_RANGE,
        0.5,
        1,
      )
      bucket.coreMaterial.size = bucket.baseCoreSize * (1 + centered * PELLET_CORE_SIZE_RANGE)
      bucket.innerGlowMaterial.opacity = clamp(
        PELLET_INNER_GLOW_OPACITY_BASE + pulse * PELLET_INNER_GLOW_OPACITY_RANGE,
        0.012,
        0.11,
      )
      bucket.innerGlowMaterial.size =
        bucket.baseInnerGlowSize * (1 + centered * PELLET_INNER_GLOW_SIZE_RANGE)
      bucket.glowMaterial.opacity = clamp(
        PELLET_GLOW_OPACITY_BASE + pulse * PELLET_GLOW_OPACITY_RANGE,
        0.008,
        0.058,
      )
      bucket.glowMaterial.size = bucket.baseGlowSize * (1 + centered * PELLET_GLOW_SIZE_RANGE)
    }
  }

  return {
    updatePellets,
    updatePelletGlow,
  }
}
