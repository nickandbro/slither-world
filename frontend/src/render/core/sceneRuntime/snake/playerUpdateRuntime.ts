import * as THREE from 'three'
import type { PlayerSnapshot } from '../../../../game/types'
import { sampleLakes, type Lake } from '../environment/lakes'
import { buildDigestionVisuals } from './digestion'
import type { SnakeTubeCache } from './geometry'
import { createGroundingInfo, finalizeGroundingInfo, type SnakeGroundingInfo } from './grounding'
import { clamp, smoothstep } from '../utils/math'
import type { DeathState, SnakeVisual } from '../runtimeTypes'
import type { TailFrameState } from './tailShape'
import {
  hideBoostBodyGlow,
  hideIntakeCone,
  hideNameplate,
  updateNameplateText,
  updateSnakeMaterial,
} from './visual'

const TAIL_CONTACT_NORMAL_SMOOTH_RATE = 9
const TAIL_CONTACT_NORMAL_MIN_ALPHA = 0.07
const TAIL_CONTACT_NORMAL_MAX_ALPHA = 0.28
const HEAD_FORWARD_DEADBAND_RAD = (Math.PI * 0.45) / 180
const HEAD_FORWARD_MIN_STEP_RAD = (Math.PI * 0.2) / 180
const HEAD_FORWARD_MAX_TURN_RAD_PER_SEC_LOCAL = (Math.PI * 900) / 180
const HEAD_FORWARD_MAX_TURN_RAD_PER_SEC_REMOTE = (Math.PI * 720) / 180

type TailCommitContinuityState = {
  carryDistance: number
  lastSnakeLen: number
  lastTailEndLen: number
}

type SnakePlayerRuntimeConstants = {
  deathFadeDuration: number
  deathStartOpacity: number
  deathVisibilityCutoff: number
  digestionTravelEase: number
  snakeGirthScaleMin: number
  snakeGirthScaleMax: number
  digestionBulgeGirthMinScale: number
  digestionBulgeGirthCurve: number
  digestionBulgeRadiusCurve: number
  snakeRadius: number
  snakeLiftFactor: number
  headRadius: number
  tailDirMinRatio: number
  tailExtensionEaseGrowRate: number
  tailExtensionEaseShrinkRate: number
  tailExtensionMaxStepPerSec: number
  tailExtensionBaseLenEaseRate: number
  tailExtensionBaseLenMinFactor: number
  tailExtensionBaseLenMaxFactor: number
  tailCommitCarryDecayRate: number
  tailCommitMinPrevExtRatio: number
  tailCommitMaxNextExtRatio: number
  tailCommitMinDrop: number
  tailCommitMaxExtraFactor: number
  digestionStartNodeIndex: number
  snakeSelfOverlapGlowEnabled: boolean
  snakeSelfOverlapMinPoints: number
  snakeSelfOverlapGlowVisibilityThreshold: number
  snakeSelfOverlapGlowOpacity: number
  lakeWaterMaskThreshold: number
  tongueMouthForward: number
  tongueMouthOut: number
  nameplateFadeNearDistance: number
  nameplateFadeFarDistance: number
  nameplateWorldWidth: number
  nameplateWorldAspect: number
  nameplateWorldOffset: number
}

type SnakePlayerRuntimeDeps = {
  constants: SnakePlayerRuntimeConstants
  camera: THREE.PerspectiveCamera
  getLakes: () => Lake[]
  getSnakeCenterlineRadius: (normal: THREE.Vector3, radiusOffset: number, snakeRadius: number) => number
  getSnakeSkinTexture: (
    primaryColor: string,
    skinColors?: string[] | null,
  ) => { key: string; texture: THREE.CanvasTexture; primary: string; slots: string[] }
  createSnakeVisual: (primaryColor: string, skinKey: string, skinTexture: THREE.CanvasTexture) => SnakeVisual
  snakes: Map<string, SnakeVisual>
  snakesGroup: THREE.Group
  deathStates: Map<string, DeathState>
  lastAliveStates: Map<string, boolean>
  lastSnakeStarts: Map<string, number>
  tailFrameStates: Map<string, TailFrameState>
  tailExtensionVisualRatios: Map<string, number>
  tailExtensionBaseLengths: Map<string, number>
  tailCommitContinuityStates: Map<string, TailCommitContinuityState>
  lastTailDirections: Map<string, THREE.Vector3>
  lastTailContactNormals: Map<string, THREE.Vector3>
  lastHeadPositions: Map<string, THREE.Vector3>
  lastForwardDirections: Map<string, THREE.Vector3>
  pelletMouthTargets: Map<string, THREE.Vector3>
  resetSnakeTransientState: (id: string) => void
  setLocalGroundingInfo: (value: SnakeGroundingInfo | null) => void
  buildSnakeCurvePoints: (
    nodes: PlayerSnapshot['snake'],
    radiusOffset: number,
    radius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => THREE.Vector3[]
  applySnakeContactLift: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    centerlineRadius: number,
    snakeRadius: number,
    groundingInfo: SnakeGroundingInfo | null,
  ) => number
  ensureSnakeTubeCache: (
    playerId: string,
    geometry: THREE.BufferGeometry,
    tubularSegments: number,
  ) => SnakeTubeCache
  snakeTubeCurve: THREE.CatmullRomCurve3
  updateSnakeTubeGeometry: (cache: SnakeTubeCache, curve: THREE.CatmullRomCurve3, radius: number) => void
  applySnakeSkinUVs: (
    geometry: THREE.BufferGeometry,
    headStartOffset: number,
    snakeTotalLen: number,
  ) => void
  computeDigestionStartOffset: (
    curvePoints: THREE.Vector3[],
    digestionStartNodeIndex: number,
    sourceNodeCount?: number,
  ) => number
  applyDigestionBulges: (
    geometry: THREE.BufferGeometry,
    digestionVisuals: ReturnType<typeof buildDigestionVisuals>,
    digestionStartOffset: number,
    digestionBulgeScale: number,
    sourceNodeCount?: number,
  ) => void
  computeSnakeSelfOverlapPointIntensities: (
    curvePoints: THREE.Vector3[],
    radius: number,
  ) => { intensities: Float32Array; maxIntensity: number }
  applySnakeSelfOverlapColors: (
    geometry: THREE.BufferGeometry,
    pointIntensities: Float32Array,
    pointCount: number,
  ) => void
  computeTailExtendDirection: (
    curvePoints: THREE.Vector3[],
    tailDirMinLen: number,
    lastTailDirection: THREE.Vector3 | null,
    tailFrameState: TailFrameState | null,
  ) => THREE.Vector3 | null
  computeExtendedTailPoint: (
    curvePoints: THREE.Vector3[],
    extensionDistance: number,
    extensionDir: THREE.Vector3 | null,
  ) => THREE.Vector3 | null
  projectToTangentPlane: (vector: THREE.Vector3, normal: THREE.Vector3) => THREE.Vector3 | null
  transportDirectionOnSphere: (
    direction: THREE.Vector3,
    fromNormal: THREE.Vector3,
    toNormal: THREE.Vector3,
  ) => THREE.Vector3 | null
  buildTangentBasis: (
    normal: THREE.Vector3,
    tangent: THREE.Vector3,
    bitangent: THREE.Vector3,
  ) => void
  storeTailFrameStateForPlayer: (
    playerId: string,
    tailNormal: THREE.Vector3,
    tailDirection: THREE.Vector3,
  ) => void
  updateSnakeTailCap: (
    playerId: string,
    visual: SnakeVisual,
    tubeGeometry: THREE.BufferGeometry,
    tailDirection: THREE.Vector3,
  ) => void
  updateBoostBodyGlow: (args: {
    visual: SnakeVisual
    player: PlayerSnapshot
    snakeLengthUnits: number
    curvePoints: THREE.Vector3[] | null
    snakeRadius: number
    snakeOpacity: number
    deltaSeconds: number
  }) => void
  updateIntakeCone: (args: {
    visual: SnakeVisual
    activeByLock: boolean
    headPosition: THREE.Vector3
    mouthPosition: THREE.Vector3
    headNormal: THREE.Vector3
    forward: THREE.Vector3
    right: THREE.Vector3
    headRadius: number
    snakeOpacity: number
    deltaSeconds: number
    nowMs: number
  }) => void
}

export const createSnakePlayerRuntime = (deps: SnakePlayerRuntimeDeps) => {
  const {
    constants,
    camera,
    getLakes,
    getSnakeCenterlineRadius,
    getSnakeSkinTexture,
    createSnakeVisual,
    snakes,
    snakesGroup,
    deathStates,
    lastAliveStates,
    lastSnakeStarts,
    tailFrameStates,
    tailExtensionVisualRatios,
    tailExtensionBaseLengths,
    tailCommitContinuityStates,
    lastTailDirections,
    lastTailContactNormals,
    lastHeadPositions,
    lastForwardDirections,
    pelletMouthTargets,
    resetSnakeTransientState,
    setLocalGroundingInfo,
    buildSnakeCurvePoints,
    applySnakeContactLift,
    ensureSnakeTubeCache,
    snakeTubeCurve,
    updateSnakeTubeGeometry,
    applySnakeSkinUVs,
    computeDigestionStartOffset,
    applyDigestionBulges,
    computeSnakeSelfOverlapPointIntensities,
    applySnakeSelfOverlapColors,
    computeTailExtendDirection,
    computeExtendedTailPoint,
    projectToTangentPlane,
    transportDirectionOnSphere,
    buildTangentBasis,
    storeTailFrameStateForPlayer,
    updateSnakeTailCap,
    updateBoostBodyGlow,
    updateIntakeCone,
  } = deps

  const tempVector = new THREE.Vector3()
  const tempVectorB = new THREE.Vector3()
  const tempVectorF = new THREE.Vector3()
  const tempVectorG = new THREE.Vector3()
  const tempVectorH = new THREE.Vector3()
  const snakeContactTangentTemp = new THREE.Vector3()
  const snakeContactBitangentTemp = new THREE.Vector3()
  const snakeContactNormalTemp = new THREE.Vector3()
  const snakeContactFallbackTemp = new THREE.Vector3()
  const lakeSampleTemp = new THREE.Vector3()
  const headForwardSlerpTemp = new THREE.Vector3()
  const headForwardAxisTemp = new THREE.Vector3()
  const headForwardRotateQuatTemp = new THREE.Quaternion()

  const smoothTailExtensionRatio = (
    playerId: string,
    target: number,
    deltaSeconds: number,
  ): number => {
    const targetClamped = clamp(target, 0, 0.999_999)
    const previous = tailExtensionVisualRatios.get(playerId)
    if (previous === undefined || !Number.isFinite(previous)) {
      tailExtensionVisualRatios.set(playerId, targetClamped)
      return targetClamped
    }

    const dt = clamp(deltaSeconds, 0, 0.1)
    const rate =
      targetClamped >= previous
        ? constants.tailExtensionEaseGrowRate
        : constants.tailExtensionEaseShrinkRate
    const alpha = clamp(1 - Math.exp(-Math.max(0, rate) * dt), 0, 1)
    let next = previous + (targetClamped - previous) * alpha

    const maxStep = Math.max(0, constants.tailExtensionMaxStepPerSec) * dt
    if (maxStep > 1e-6) {
      next = clamp(next, previous - maxStep, previous + maxStep)
    }
    if (Math.abs(next - targetClamped) < 1e-4) {
      next = targetClamped
    }

    const clampedNext = clamp(next, 0, 0.999_999)
    tailExtensionVisualRatios.set(playerId, clampedNext)
    return clampedNext
  }

  const smoothTailExtensionBaseLength = (
    playerId: string,
    measured: number,
    deltaSeconds: number,
  ): number => {
    if (!Number.isFinite(measured) || measured <= 1e-6) {
      const previous = tailExtensionBaseLengths.get(playerId)
      return previous && Number.isFinite(previous) ? previous : 0
    }

    const previous = tailExtensionBaseLengths.get(playerId)
    if (previous === undefined || !Number.isFinite(previous) || previous <= 1e-6) {
      tailExtensionBaseLengths.set(playerId, measured)
      return measured
    }

    const dt = clamp(deltaSeconds, 0, 0.1)
    const minFactor = Math.max(0, constants.tailExtensionBaseLenMinFactor)
    const maxFactor = Math.max(minFactor, constants.tailExtensionBaseLenMaxFactor)
    const clampedTarget = clamp(measured, previous * minFactor, previous * maxFactor)
    const alpha = clamp(
      1 - Math.exp(-Math.max(0, constants.tailExtensionBaseLenEaseRate) * dt),
      0,
      1,
    )
    let next = previous + (clampedTarget - previous) * alpha
    if (!Number.isFinite(next) || next <= 1e-6) {
      next = clampedTarget
    }
    tailExtensionBaseLengths.set(playerId, next)
    return next
  }

  const updateSnake = (
    player: PlayerSnapshot,
    isLocal: boolean,
    deltaSeconds: number,
    nowMs: number,
  ) => {
    const skin = getSnakeSkinTexture(player.color, player.skinColors)
    let visual = snakes.get(player.id)
    if (!visual) {
      visual = createSnakeVisual(skin.primary, skin.key, skin.texture)
      snakes.set(player.id, visual)
      snakesGroup.add(visual.group)
    } else if (visual.skinKey !== skin.key) {
      visual.skinKey = skin.key
      visual.tube.material.map = skin.texture
      visual.tube.material.emissiveMap = skin.texture
      visual.tube.material.needsUpdate = true
    }

    if (visual.color !== skin.primary) {
      visual.color = skin.primary
      visual.selfOverlapGlowMaterial.color.set(skin.primary)
    }
    const groundingInfo = isLocal ? createGroundingInfo() : null

    const wasAlive = lastAliveStates.get(player.id)
    if (wasAlive === undefined || wasAlive !== player.alive) {
      if (!player.alive) {
        deathStates.set(player.id, { start: performance.now() })
      } else {
        deathStates.delete(player.id)
        resetSnakeTransientState(player.id)
      }
      lastAliveStates.set(player.id, player.alive)
    }

    let opacity = 1
    if (!player.alive) {
      const deathState = deathStates.get(player.id)
      const start = deathState?.start ?? performance.now()
      const elapsed = (performance.now() - start) / 1000
      const t = clamp(elapsed / constants.deathFadeDuration, 0, 1)
      opacity = constants.deathStartOpacity * (1 - t)
    }

    visual.group.visible = opacity > constants.deathVisibilityCutoff

    updateSnakeMaterial(visual.tube.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.head.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.tail.material, visual.color, isLocal, opacity)
    updateSnakeMaterial(visual.eyeLeft.material, '#ffffff', false, opacity, 0)
    updateSnakeMaterial(visual.eyeRight.material, '#ffffff', false, opacity, 0)
    updateSnakeMaterial(visual.pupilLeft.material, '#1b1b1b', false, opacity, 0)
    updateSnakeMaterial(visual.pupilRight.material, '#1b1b1b', false, opacity, 0)
    if (isLocal) {
      hideNameplate(visual)
    }

    const previousSnakeStart = lastSnakeStarts.get(player.id)
    if (previousSnakeStart !== undefined && previousSnakeStart !== player.snakeStart) {
      resetSnakeTransientState(player.id)
    }
    lastSnakeStarts.set(player.id, player.snakeStart)

    if (player.snakeDetail === 'stub') {
      if (isLocal) {
        setLocalGroundingInfo(null)
      }
      tailExtensionVisualRatios.delete(player.id)
      tailExtensionBaseLengths.delete(player.id)
      resetSnakeTransientState(player.id)
      pelletMouthTargets.delete(player.id)
      lastTailContactNormals.delete(player.id)
      visual.tube.visible = false
      visual.selfOverlapGlow.visible = false
      visual.tail.visible = false
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.bowl.visible = false
      hideBoostBodyGlow(visual)
      hideIntakeCone(visual)
      hideNameplate(visual)
      return
    }

    const nodes = player.snake
    const lastTailDirection = lastTailDirections.get(player.id) ?? null
    const tailFrameState = tailFrameStates.get(player.id) ?? null
    const digestionVisuals = buildDigestionVisuals(player.digestions, constants.digestionTravelEase)
    const girthScale = clamp(player.girthScale, constants.snakeGirthScaleMin, constants.snakeGirthScaleMax)
    const girthT = clamp(
      (girthScale - constants.snakeGirthScaleMin) /
        Math.max(1e-6, constants.snakeGirthScaleMax - constants.snakeGirthScaleMin),
      0,
      1,
    )
    const girthNonLinearScale = THREE.MathUtils.lerp(
      1,
      constants.digestionBulgeGirthMinScale,
      Math.pow(girthT, constants.digestionBulgeGirthCurve),
    )
    const radiusCompScale = Math.pow(1 / Math.max(girthScale, 1), constants.digestionBulgeRadiusCurve)
    const digestionBulgeScale = girthNonLinearScale * radiusCompScale
    const bodyScale = girthScale * (isLocal ? 1.1 : 1)
    const radius = constants.snakeRadius * bodyScale
    const radiusOffset = radius * constants.snakeLiftFactor
    const headScale = radius / constants.snakeRadius
    const headRadius = constants.headRadius * headScale
    let headCurvePoint: THREE.Vector3 | null = null
    let secondCurvePoint: THREE.Vector3 | null = null
    let tailCurveTail: THREE.Vector3 | null = null
    let tailCurvePrev: THREE.Vector3 | null = null
    let tailExtensionDirection: THREE.Vector3 | null = null
    let tailDirMinLen = 0
    let extensionRatio = 0
    let tailCommitCarryDistance = 0
    let boostBodyGlowCurvePoints: THREE.Vector3[] | null = null
    if (nodes.length < 2) {
      visual.tube.visible = false
      visual.selfOverlapGlow.visible = false
      visual.tail.visible = false
      tailExtensionVisualRatios.delete(player.id)
      tailExtensionBaseLengths.delete(player.id)
      tailCommitContinuityStates.delete(player.id)
      lastTailDirections.delete(player.id)
      lastTailContactNormals.delete(player.id)
      tailFrameStates.delete(player.id)
    } else {
      visual.tube.visible = true
      visual.tail.visible = true
      const curvePoints = buildSnakeCurvePoints(nodes, radiusOffset, radius, groundingInfo)
      boostBodyGlowCurvePoints = curvePoints
      headCurvePoint = curvePoints[0]?.clone() ?? null
      secondCurvePoint = curvePoints[1]?.clone() ?? null
      let tailBasisPrev: THREE.Vector3 | null = null
      let tailBasisTail: THREE.Vector3 | null = null
      let tailSegmentLength = 0
      if (curvePoints.length >= 3) {
        tailBasisPrev = curvePoints[curvePoints.length - 3]
        tailBasisTail = curvePoints[curvePoints.length - 2]
        if (tailBasisPrev.distanceToSquared(tailBasisTail) < 1e-6) {
          tailBasisPrev = null
          tailBasisTail = null
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        tailSegmentLength = tailPos.distanceTo(prevPos)
      }
      const referenceLength =
        tailBasisPrev && tailBasisTail
          ? tailBasisTail.distanceTo(tailBasisPrev)
          : tailSegmentLength
      tailDirMinLen = Number.isFinite(referenceLength)
        ? Math.max(0, referenceLength * constants.tailDirMinRatio)
        : 0
      const hasAuthoritativeTailWindow =
        player.snakeStart + nodes.length === player.snakeTotalLen
      const continuityState = tailCommitContinuityStates.get(player.id)
      const previousSnakeLen =
        continuityState && Number.isFinite(continuityState.lastSnakeLen)
          ? continuityState.lastSnakeLen
          : nodes.length
      const previousTailEndLen =
        continuityState && Number.isFinite(continuityState.lastTailEndLen)
          ? continuityState.lastTailEndLen
          : 0
      const previousCarryDistance =
        continuityState && Number.isFinite(continuityState.carryDistance)
          ? Math.max(0, continuityState.carryDistance)
          : 0
      const targetExtensionRatio = hasAuthoritativeTailWindow
        ? clamp(player.tailExtension, 0, 0.999_999)
        : 0
      const previousVisualRatioRaw = tailExtensionVisualRatios.get(player.id)
      const previousVisualRatio =
        previousVisualRatioRaw !== undefined && Number.isFinite(previousVisualRatioRaw)
          ? clamp(previousVisualRatioRaw, 0, 0.999_999)
          : targetExtensionRatio
      extensionRatio = hasAuthoritativeTailWindow
        ? smoothTailExtensionRatio(player.id, targetExtensionRatio, deltaSeconds)
        : 0
      if (!hasAuthoritativeTailWindow) {
        tailExtensionVisualRatios.delete(player.id)
        tailExtensionBaseLengths.delete(player.id)
      }
      const measuredExtensionBaseLength =
        Number.isFinite(referenceLength) && referenceLength > 1e-6
          ? referenceLength
          : tailSegmentLength
      const extensionBaseLength = smoothTailExtensionBaseLength(
        player.id,
        measuredExtensionBaseLength,
        deltaSeconds,
      )
      const extensionDistance = Math.max(0, extensionBaseLength * extensionRatio)
      const dt = clamp(deltaSeconds, 0, 0.1)
      tailCommitCarryDistance = previousCarryDistance
      if (dt > 0 && tailCommitCarryDistance > 1e-6) {
        const decay = Math.exp(-Math.max(0, constants.tailCommitCarryDecayRate) * dt)
        tailCommitCarryDistance = Math.max(0, tailCommitCarryDistance * decay)
      }
      if (player.alive && hasAuthoritativeTailWindow) {
        const grewByNodes = nodes.length - previousSnakeLen
        const carryCap = Math.max(
          Math.max(0, constants.tailCommitMinDrop),
          extensionBaseLength * Math.max(0, constants.tailCommitMaxExtraFactor),
        )
        if (
          grewByNodes > 0 &&
          previousVisualRatio >= constants.tailCommitMinPrevExtRatio &&
          targetExtensionRatio <= constants.tailCommitMaxNextExtRatio
        ) {
          const projectedTailEndLen = Math.max(0, extensionBaseLength + extensionDistance)
          const drop = previousTailEndLen - projectedTailEndLen
          if (drop >= constants.tailCommitMinDrop) {
            tailCommitCarryDistance = clamp(
              tailCommitCarryDistance + drop,
              0,
              carryCap,
            )
          }
        } else if (tailCommitCarryDistance > carryCap) {
          tailCommitCarryDistance = carryCap
        }
      } else {
        tailCommitCarryDistance = 0
      }
      const extensionDistanceWithCarry = extensionDistance + tailCommitCarryDistance
      tailExtensionDirection = computeTailExtendDirection(
        curvePoints,
        tailDirMinLen,
        lastTailDirection,
        tailFrameState,
      )
      if (extensionDistanceWithCarry > 0) {
        let extensionDir = tailExtensionDirection
        if (curvePoints.length >= 2) {
          const tailPos = curvePoints[curvePoints.length - 1]
          const prevPos = curvePoints[curvePoints.length - 2]
          snakeContactNormalTemp.copy(tailPos).normalize()
          snakeContactTangentTemp.copy(tailPos).sub(prevPos)
          snakeContactTangentTemp.addScaledVector(
            snakeContactNormalTemp,
            -snakeContactTangentTemp.dot(snakeContactNormalTemp),
          )
          const rawDir =
            snakeContactTangentTemp.lengthSq() > 1e-8
              ? snakeContactTangentTemp.normalize()
              : null
          if (rawDir && tailExtensionDirection) {
            const w = clamp((extensionRatio - 0.6) / 0.3, 0, 1)
            if (w >= 0.999_999) {
              extensionDir = rawDir
            } else if (w > 1e-6) {
              extensionDir = tailExtensionDirection
                .clone()
                .multiplyScalar(1 - w)
                .addScaledVector(rawDir, w)
              if (extensionDir.lengthSq() > 1e-8) {
                extensionDir.normalize()
              } else {
                extensionDir = rawDir
              }
            }
          } else if (rawDir) {
            extensionDir = rawDir
          }
        }
        const extendedTail = computeExtendedTailPoint(
          curvePoints,
          extensionDistanceWithCarry,
          extensionDir,
        )
        if (extendedTail) {
          curvePoints[curvePoints.length - 1] = extendedTail
        }
      }
      if (curvePoints.length >= 2) {
        const tailPos = curvePoints[curvePoints.length - 1]
        const prevPos = curvePoints[curvePoints.length - 2]
        snakeContactNormalTemp.copy(tailPos).normalize()
        snakeContactTangentTemp.copy(tailPos).sub(prevPos)
        snakeContactTangentTemp.addScaledVector(
          snakeContactNormalTemp,
          -snakeContactTangentTemp.dot(snakeContactNormalTemp),
        )
        if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
          buildTangentBasis(
            snakeContactNormalTemp,
            snakeContactTangentTemp,
            snakeContactBitangentTemp,
          )
        } else {
          snakeContactTangentTemp.normalize()
        }
        const tailRadius = tailPos.length()
        const tailLift = applySnakeContactLift(
          snakeContactNormalTemp,
          snakeContactTangentTemp,
          tailRadius,
          radius,
          groundingInfo,
        )
        if (tailLift > 0) {
          tailPos.addScaledVector(snakeContactNormalTemp, tailLift)
          tailSegmentLength = tailPos.distanceTo(prevPos)
        }
      }
      if (curvePoints.length >= 2) {
        tailCurvePrev = curvePoints[curvePoints.length - 2]
        tailCurveTail = curvePoints[curvePoints.length - 1]
      }
      const tubeGeometry = visual.tube.geometry
      if (!(tubeGeometry instanceof THREE.BufferGeometry)) {
        visual.tube.geometry = new THREE.BufferGeometry()
      }
      const resolvedTubeGeometry =
        (visual.tube.geometry as THREE.BufferGeometry) ?? new THREE.BufferGeometry()
      const tubularSegments = Math.max(8, curvePoints.length * 4)
      const tubeCache = ensureSnakeTubeCache(player.id, resolvedTubeGeometry, tubularSegments)
      snakeTubeCurve.points = curvePoints
      updateSnakeTubeGeometry(tubeCache, snakeTubeCurve, radius)
      applySnakeSkinUVs(resolvedTubeGeometry, player.snakeStart, nodes.length + extensionRatio)
      const digestionStartOffset = computeDigestionStartOffset(
        curvePoints,
        constants.digestionStartNodeIndex,
        nodes.length,
      )
      if (digestionVisuals.length) {
        applyDigestionBulges(
          resolvedTubeGeometry,
          digestionVisuals,
          digestionStartOffset,
          digestionBulgeScale,
          nodes.length,
        )
      }
      let overlapMax = 0
      if (
        constants.snakeSelfOverlapGlowEnabled &&
        curvePoints.length >= constants.snakeSelfOverlapMinPoints
      ) {
        const overlap = computeSnakeSelfOverlapPointIntensities(curvePoints, radius)
        overlapMax = overlap.maxIntensity
        if (overlapMax > constants.snakeSelfOverlapGlowVisibilityThreshold) {
          applySnakeSelfOverlapColors(
            resolvedTubeGeometry,
            overlap.intensities,
            curvePoints.length,
          )
        }
      }

      visual.selfOverlapGlowMaterial.opacity =
        opacity * constants.snakeSelfOverlapGlowOpacity
      visual.selfOverlapGlowMaterial.color.set(visual.color)
      visual.selfOverlapGlow.visible =
        visual.group.visible &&
        overlapMax > constants.snakeSelfOverlapGlowVisibilityThreshold
    }

    const snakeLengthUnits = Math.max(
      0,
      Math.max(player.snakeTotalLen, player.snakeStart + nodes.length + extensionRatio),
    )
    updateBoostBodyGlow({
      visual,
      player,
      snakeLengthUnits,
      curvePoints: boostBodyGlowCurvePoints,
      snakeRadius: radius,
      snakeOpacity: opacity,
      deltaSeconds,
    })

    if (nodes.length === 0) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.bowl.visible = false
      hideBoostBodyGlow(visual)
      hideIntakeCone(visual)
      hideNameplate(visual)
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      lastTailDirections.delete(player.id)
      lastTailContactNormals.delete(player.id)
      tailFrameStates.delete(player.id)
      tailExtensionVisualRatios.delete(player.id)
      tailExtensionBaseLengths.delete(player.id)
      tailCommitContinuityStates.delete(player.id)
      pelletMouthTargets.delete(player.id)
      lastSnakeStarts.delete(player.id)
      if (isLocal) {
        setLocalGroundingInfo(finalizeGroundingInfo(groundingInfo))
      }
      return
    }

    const hasHead = player.snakeStart === 0

    if (!hasHead) {
      visual.head.visible = false
      visual.eyeLeft.visible = false
      visual.eyeRight.visible = false
      visual.pupilLeft.visible = false
      visual.pupilRight.visible = false
      visual.bowl.visible = false
      hideIntakeCone(visual)
      hideNameplate(visual)
      lastHeadPositions.delete(player.id)
      lastForwardDirections.delete(player.id)
      pelletMouthTargets.delete(player.id)
    } else {
      visual.head.visible = true
      visual.eyeLeft.visible = true
      visual.eyeRight.visible = true
      visual.pupilLeft.visible = true
      visual.pupilRight.visible = true

      const headPoint = nodes[0]
      const headNormal = tempVector.set(headPoint.x, headPoint.y, headPoint.z).normalize()
      snakeContactTangentTemp.set(0, 0, 0)
      if (headCurvePoint && secondCurvePoint) {
        snakeContactTangentTemp.copy(headCurvePoint).sub(secondCurvePoint)
      } else if (nodes.length > 1) {
        const nextPoint = nodes[1]
        snakeContactFallbackTemp.set(nextPoint.x, nextPoint.y, nextPoint.z).normalize()
        snakeContactTangentTemp.copy(headNormal).sub(snakeContactFallbackTemp)
      }
      snakeContactTangentTemp.addScaledVector(
        headNormal,
        -snakeContactTangentTemp.dot(headNormal),
      )
      if (snakeContactTangentTemp.lengthSq() <= 1e-8) {
        buildTangentBasis(headNormal, snakeContactTangentTemp, snakeContactBitangentTemp)
      } else {
        snakeContactTangentTemp.normalize()
      }
      const headCenterlineRadius = getSnakeCenterlineRadius(headNormal, radiusOffset, radius)
      const headLift = applySnakeContactLift(
        headNormal,
        snakeContactTangentTemp,
        headCenterlineRadius,
        headRadius,
        groundingInfo,
      )
      const headPosition = headNormal.clone().multiplyScalar(headCenterlineRadius + headLift)
      visual.head.scale.setScalar(headScale)
      visual.bowl.scale.setScalar(headScale)
      visual.head.position.copy(headPosition)
      visual.bowl.position.copy(headPosition)

      let underwater = false
      const lakes = getLakes()
      if (lakes.length > 0) {
        const sample = sampleLakes(headNormal, lakes, lakeSampleTemp)
        underwater = !!sample.lake && sample.boundary > constants.lakeWaterMaskThreshold
      }
      const crackAmount = underwater ? clamp((0.35 - player.oxygen) / 0.35, 0, 1) : 0
      visual.bowlCrackUniform.value = crackAmount
      if (deps.constants) {
        // Keep previous backend-specific crack look unchanged.
      }
      if ((visual.bowlMaterial as THREE.Material).type === 'MeshPhysicalMaterial') {
        if (player.oxygen >= 0) {
          visual.bowlMaterial.color.set('#cfefff')
          visual.bowlMaterial.emissive.set(0x000000)
          visual.bowlMaterial.emissiveIntensity = 0
          visual.bowlMaterial.opacity = 0.45 * opacity
          if (!deps.constants) {
            // no-op; keeps block symmetric after extraction
          }
        }
      }
      visual.bowl.visible = underwater && visual.group.visible

      const lastForward = lastForwardDirections.get(player.id) ?? null
      const targetForward = tempVectorB
      if (nodes.length > 1) {
        const nextPoint =
          secondCurvePoint ??
          (() => {
            const nextNode = nodes[1]
            const nextNormal = new THREE.Vector3(nextNode.x, nextNode.y, nextNode.z).normalize()
            const nextRadius = getSnakeCenterlineRadius(nextNormal, radiusOffset, radius)
            return nextNormal.multiplyScalar(nextRadius)
          })()
        targetForward.copy(headPosition).sub(nextPoint)
      } else {
        targetForward.crossVectors(headNormal, new THREE.Vector3(0, 1, 0))
      }
      targetForward.addScaledVector(headNormal, -targetForward.dot(headNormal))
      if (targetForward.lengthSq() < 1e-8) {
        if (lastForward && lastForward.lengthSq() > 1e-8) {
          targetForward.copy(lastForward)
          targetForward.addScaledVector(headNormal, -targetForward.dot(headNormal))
        } else {
          targetForward.crossVectors(headNormal, new THREE.Vector3(1, 0, 0))
        }
      }
      if (targetForward.lengthSq() < 1e-8) {
        buildTangentBasis(headNormal, targetForward, headForwardAxisTemp)
      } else {
        targetForward.normalize()
      }

      let forward = lastForward
      if (!forward) {
        forward = targetForward.clone()
        lastForwardDirections.set(player.id, forward)
      } else {
        forward.addScaledVector(headNormal, -forward.dot(headNormal))
        if (forward.lengthSq() <= 1e-8) {
          forward.copy(targetForward)
        } else {
          forward.normalize()
        }

        const dotForward = clamp(forward.dot(targetForward), -1, 1)
        const turnAngle = Math.acos(dotForward)
        if (Number.isFinite(turnAngle) && turnAngle > HEAD_FORWARD_DEADBAND_RAD) {
          const dt = clamp(deltaSeconds, 0, 0.1)
          const maxTurnRate = isLocal
            ? HEAD_FORWARD_MAX_TURN_RAD_PER_SEC_LOCAL
            : HEAD_FORWARD_MAX_TURN_RAD_PER_SEC_REMOTE
          const maxStep = Math.max(HEAD_FORWARD_MIN_STEP_RAD, maxTurnRate * dt)
          const step = Math.min(turnAngle, maxStep)
          if (step >= turnAngle - 1e-5) {
            forward.copy(targetForward)
          } else {
            headForwardAxisTemp.crossVectors(forward, targetForward)
            const axisDot = headForwardAxisTemp.dot(headNormal)
            const signedStep = axisDot >= 0 ? step : -step
            headForwardRotateQuatTemp.setFromAxisAngle(headNormal, signedStep)
            headForwardSlerpTemp.copy(forward).applyQuaternion(headForwardRotateQuatTemp)
            headForwardSlerpTemp.addScaledVector(
              headNormal,
              -headForwardSlerpTemp.dot(headNormal),
            )
            if (headForwardSlerpTemp.lengthSq() > 1e-8) {
              forward.copy(headForwardSlerpTemp.normalize())
            } else {
              forward.copy(targetForward)
            }
          }
        }
      }

      const cachedHead = lastHeadPositions.get(player.id)
      if (cachedHead) {
        cachedHead.copy(headPosition)
      } else {
        lastHeadPositions.set(player.id, headPosition.clone())
      }

      const right = new THREE.Vector3().crossVectors(forward, headNormal)
      if (right.lengthSq() < 0.00001) {
        right.set(1, 0, 0)
      }
      right.normalize()
      if (player.alive && visual.group.visible) {
        const mouthTarget = pelletMouthTargets.get(player.id) ?? new THREE.Vector3()
        mouthTarget
          .copy(headPosition)
          .addScaledVector(forward, constants.tongueMouthForward * headScale)
          .addScaledVector(headNormal, constants.tongueMouthOut * headScale)
        pelletMouthTargets.set(player.id, mouthTarget)
        visual.intakeConeHoldUntilMs = 0
        updateIntakeCone({
          visual,
          activeByLock: false,
          headPosition,
          mouthPosition: mouthTarget,
          headNormal,
          forward,
          right,
          headRadius,
          snakeOpacity: opacity,
          deltaSeconds,
          nowMs,
        })
      } else {
        pelletMouthTargets.delete(player.id)
        hideIntakeCone(visual)
      }
      if (
        !isLocal &&
        player.alive &&
        visual.group.visible &&
        visual.nameplateTexture &&
        visual.nameplateCanvas &&
        visual.nameplateCtx
      ) {
        updateNameplateText(visual, player.name)
        const distanceToCamera = camera.position.distanceTo(headPosition)
        const distanceFade =
          1 -
          smoothstep(
            constants.nameplateFadeNearDistance,
            constants.nameplateFadeFarDistance,
            distanceToCamera,
          )
        const nameplateOpacity = clamp(opacity * distanceFade, 0, 1)
        if (nameplateOpacity > constants.deathVisibilityCutoff) {
          const scale = headScale
          const nameplateWidth = constants.nameplateWorldWidth * scale
          visual.nameplate.position
            .copy(headPosition)
            .addScaledVector(headNormal, constants.nameplateWorldOffset * scale)
          visual.nameplate.quaternion.copy(camera.quaternion)
          visual.nameplate.scale.set(
            nameplateWidth,
            nameplateWidth / constants.nameplateWorldAspect,
            1,
          )
          visual.nameplateMaterial.opacity = nameplateOpacity
          visual.nameplate.visible = true
        } else {
          hideNameplate(visual)
        }
      } else {
        hideNameplate(visual)
      }

      visual.eyeLeft.scale.setScalar(headScale)
      visual.eyeRight.scale.setScalar(headScale)
      visual.pupilLeft.scale.setScalar(headScale)
      visual.pupilRight.scale.setScalar(headScale)

      const eyeOut = headRadius * 0.16
      const eyeForward = headRadius * 0.28
      const eyeSpacing = headRadius * 0.52

      const leftEyePosition = headPosition
        .clone()
        .addScaledVector(headNormal, eyeOut)
        .addScaledVector(forward, eyeForward)
        .addScaledVector(right, -eyeSpacing)
      const rightEyePosition = headPosition
        .clone()
        .addScaledVector(headNormal, eyeOut)
        .addScaledVector(forward, eyeForward)
        .addScaledVector(right, eyeSpacing)

      visual.eyeLeft.position.copy(leftEyePosition)
      visual.eyeRight.position.copy(rightEyePosition)

      const clampedYaw = 0
      const pupilSurfaceDistance = 0.62 * constants.snakeRadius * headScale - (0.62 * constants.snakeRadius * 0.4 * headScale * 0.6)

      const updatePupil = (
        eyePosition: THREE.Vector3,
        eyeNormal: THREE.Vector3,
        output: THREE.Vector3,
      ) => {
        tempVectorH.copy(right)
        tempVectorH.addScaledVector(eyeNormal, -tempVectorH.dot(eyeNormal))
        if (tempVectorH.lengthSq() > 1e-6) {
          tempVectorH.normalize()
        } else {
          tempVectorH.copy(right)
        }

        const yawCos = Math.cos(clampedYaw)
        const yawSin = Math.sin(clampedYaw)
        output
          .copy(eyePosition)
          .addScaledVector(eyeNormal, pupilSurfaceDistance * yawCos)
          .addScaledVector(tempVectorH, pupilSurfaceDistance * yawSin)
      }

      tempVectorF.copy(leftEyePosition).sub(headPosition).normalize()
      updatePupil(leftEyePosition, tempVectorF, visual.pupilLeft.position)
      tempVectorG.copy(rightEyePosition).sub(headPosition).normalize()
      updatePupil(rightEyePosition, tempVectorG, visual.pupilRight.position)
    }

    if (nodes.length > 1) {
      const tailPos =
        tailCurveTail ??
        (() => {
          const tailNode = nodes[nodes.length - 1]
          const tailNormalFallback = new THREE.Vector3(
            tailNode.x,
            tailNode.y,
            tailNode.z,
          ).normalize()
          const tailRadius = getSnakeCenterlineRadius(tailNormalFallback, radiusOffset, radius)
          return tailNormalFallback.multiplyScalar(tailRadius)
        })()
      const prevPos =
        tailCurvePrev ??
        (() => {
          const prevNode = nodes[nodes.length - 2]
          const prevNormalFallback = new THREE.Vector3(
            prevNode.x,
            prevNode.y,
            prevNode.z,
          ).normalize()
          const prevRadius = getSnakeCenterlineRadius(prevNormalFallback, radiusOffset, radius)
          return prevNormalFallback.multiplyScalar(prevRadius)
        })()
      const tailNormal = tailPos.clone().normalize()
      const contactNormal = lastTailContactNormals.get(player.id)
      if (contactNormal) {
        const dt = clamp(deltaSeconds, 0, 0.1)
        const alpha = clamp(
          1 - Math.exp(-TAIL_CONTACT_NORMAL_SMOOTH_RATE * dt),
          TAIL_CONTACT_NORMAL_MIN_ALPHA,
          TAIL_CONTACT_NORMAL_MAX_ALPHA,
        )
        const normalDot = contactNormal.dot(tailNormal)
        if (!Number.isFinite(normalDot) || normalDot < -0.2) {
          contactNormal.copy(tailNormal)
        } else {
          contactNormal.lerp(tailNormal, alpha).normalize()
        }
      } else {
        lastTailContactNormals.set(player.id, tailNormal.clone())
      }
      const tailSegmentLength = tailPos.distanceTo(prevPos)
      tailCommitContinuityStates.set(player.id, {
        carryDistance: tailCommitCarryDistance,
        lastSnakeLen: nodes.length,
        lastTailEndLen: tailSegmentLength,
      })
      let tailDir = projectToTangentPlane(tailPos.clone().sub(prevPos), tailNormal)
      if (!tailDir || (tailDirMinLen > 0 && tailSegmentLength < tailDirMinLen)) {
        tailDir =
          (tailExtensionDirection &&
            projectToTangentPlane(tailExtensionDirection, tailNormal)) ??
          (tailFrameState
            ? transportDirectionOnSphere(
                tailFrameState.tangent,
                tailFrameState.normal,
                tailNormal,
              )
            : null) ??
          (lastTailDirection ? projectToTangentPlane(lastTailDirection, tailNormal) : null)
      }
      if (!tailDir) {
        tailDir = tailNormal.clone().cross(new THREE.Vector3(0, 1, 0))
        if (tailDir.lengthSq() < 1e-6) {
          tailDir.crossVectors(tailNormal, new THREE.Vector3(1, 0, 0))
        }
      }
      tailDir.normalize()
      if (lastTailDirection) {
        lastTailDirection.copy(tailDir)
      } else {
        lastTailDirections.set(player.id, tailDir.clone())
      }
      storeTailFrameStateForPlayer(player.id, tailNormal, tailDir)
      const tubeGeometry = visual.tube.geometry
      if (tubeGeometry instanceof THREE.BufferGeometry) {
        updateSnakeTailCap(player.id, visual, tubeGeometry, tailDir)
      }
      visual.tail.position.set(0, 0, 0)
      visual.tail.quaternion.identity()
      visual.tail.scale.setScalar(1)
    } else {
      tailCommitContinuityStates.delete(player.id)
    }

    if (isLocal) {
      setLocalGroundingInfo(finalizeGroundingInfo(groundingInfo))
    }
  }

  return { updateSnake }
}
